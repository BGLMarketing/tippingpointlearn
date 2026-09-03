const { supabase } = require('./utils/supabaseClient');
const {
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
} = require('./utils/brevo');

const VALID_TRANSITIONS = ['under_review', 'opened', 'rejected'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // ---- Authenticate the caller as a logged-in admin ----
  // The admin dashboard sends the Supabase Auth access token it already
  // holds from signing in (the same session used to read the Learn
  // articles table). Verifying it here — server-side, with the service
  // role client — means only a real logged-in admin can trigger a status
  // change, an email, and an audit trail entry.
  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader && authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return jsonResponse(401, { error: 'Missing authorization token.' });
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return jsonResponse(401, { error: 'Invalid or expired session. Please sign in again.' });
  }
  const adminEmail = userData.user.email;

  // ---- Parse + validate the request ----
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  const { applicationId, newStatus, chn, cscAccountNumber, adminNote, rejectionReason } = body;

  if (!applicationId || !VALID_TRANSITIONS.includes(newStatus)) {
    return jsonResponse(400, {
      error: `applicationId and a valid newStatus (${VALID_TRANSITIONS.join(', ')}) are required.`
    });
  }
  if (newStatus === 'opened' && (!chn || !cscAccountNumber)) {
    return jsonResponse(400, { error: 'CHN and CSCS Account Number are both required to mark an application as opened.' });
  }
  if (newStatus === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 10)) {
    return jsonResponse(400, { error: 'A rejection reason of at least 10 characters is required.' });
  }

  try {
    const { data: appRow, error: fetchErr } = await supabase
      .from('account_opening_applications')
      .select('*')
      .eq('id', applicationId)
      .single();
    if (fetchErr || !appRow) {
      return jsonResponse(404, { error: 'Application not found.' });
    }

    // ---- Build the update payload for this transition ----
    const update = { status: newStatus };
    if (newStatus === 'under_review') {
      update.review_started_at = new Date().toISOString();
      update.reviewed_by = adminEmail;
    } else if (newStatus === 'opened') {
      update.opened_at = new Date().toISOString();
      update.opened_by = adminEmail;
      update.chn = chn;
      update.csc_account_number = cscAccountNumber;
      if (adminNote) update.admin_note = adminNote;
    } else if (newStatus === 'rejected') {
      update.rejected_at = new Date().toISOString();
      update.rejected_by = adminEmail;
      update.rejection_reason = rejectionReason;
    }

    const { error: updateErr } = await supabase
      .from('account_opening_applications')
      .update(update)
      .eq('id', applicationId);
    if (updateErr) throw updateErr;

    // ---- Audit trail ----
    await supabase.from('application_status_history').insert({
      application_id: applicationId,
      status: newStatus,
      changed_by: adminEmail,
      reason: newStatus === 'rejected' ? rejectionReason : (adminNote || null)
    });

    // ---- Notify the applicant (best-effort — doesn't fail the request) ----
    if (appRow.applicant_email) {
      try {
        if (newStatus === 'under_review') {
          await sendApplicantUnderReviewEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference
          });
        } else if (newStatus === 'opened') {
          await sendApplicantOpenedEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference,
            chn
          });
        } else if (newStatus === 'rejected') {
          await sendApplicantRejectedEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference,
            reason: rejectionReason
          });
        }
      } catch (emailErr) {
        console.error('Status-change notification email failed:', emailErr);
      }
    }

    return jsonResponse(200, { ok: true, status: newStatus });
  } catch (err) {
    console.error('update-application-status error:', err);
    return jsonResponse(500, { error: 'Something went wrong updating the application. Please try again.' });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
