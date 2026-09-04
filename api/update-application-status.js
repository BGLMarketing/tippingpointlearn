const { supabase } = require('./utils/supabaseClient');
const {
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
} = require('./utils/brevo');

const VALID_TRANSITIONS = ['under_review', 'opened', 'rejected'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = authHeader && authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token.' });
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
  const adminEmail = userData.user.email;

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  const { applicationId, newStatus, chn, cscAccountNumber, adminNote, rejectionReason } = body;

  if (!applicationId || !VALID_TRANSITIONS.includes(newStatus)) {
    return res.status(400).json({
      error: `applicationId and a valid newStatus (${VALID_TRANSITIONS.join(', ')}) are required.`
    });
  }
  if (newStatus === 'opened' && (!chn || !cscAccountNumber)) {
    return res.status(400).json({ error: 'CHN and CSCS Account Number are both required to mark an application as opened.' });
  }
  if (newStatus === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 10)) {
    return res.status(400).json({ error: 'A rejection reason of at least 10 characters is required.' });
  }

  try {
    const { data: appRow, error: fetchErr } = await supabase
      .from('account_opening_applications')
      .select('*')
      .eq('id', applicationId)
      .single();
    if (fetchErr || !appRow) {
      return res.status(404).json({ error: 'Application not found.' });
    }

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

    await supabase.from('application_status_history').insert({
      application_id: applicationId,
      status: newStatus,
      changed_by: adminEmail,
      reason: newStatus === 'rejected' ? rejectionReason : (adminNote || null)
    });

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

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (err) {
    console.error('update-application-status error:', err);
    return res.status(500).json({ error: 'Something went wrong updating the application. Please try again.' });
  }
};
