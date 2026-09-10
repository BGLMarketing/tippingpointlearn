const { supabase } = require('./utils/supabaseClient');
const {
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
} = require('./utils/brevo');
const {
  sendIpoPaymentConfirmedEmail,
  sendIpoPaymentUnconfirmedEmail,
  sendIpoExecutedEmail,
  sendIpoAllottedEmail
} = require('./utils/ipoEmail');

// Merged from update-application-status.js and update-ipo-status.js
// to stay under Vercel Hobby's 12-serverless-function-per-deployment
// cap. Both did the same shape of work (verify the caller is a
// logged-in admin, validate a status transition, update a row, log an
// audit-trail row, send a status-change email) against two different
// tables — this file shares just the admin auth check and otherwise
// keeps each handler's logic unchanged, dispatching on `domain`.

const APPLICATION_TRANSITIONS = ['under_review_client_service', 'under_review_compliance', 'account_opening_in_progress', 'opened', 'rejected'];
const IPO_TRANSITIONS = ['payment_confirmed', 'payment_unconfirmed', 'pending_execution', 'executed', 'allotted'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // ---- Authenticate the caller as a logged-in admin ----
  // The admin dashboard sends the Supabase Auth access token it already
  // holds from signing in. Verifying it here — server-side, with the
  // service role client — means only a real logged-in admin can trigger
  // a status change, an email, and an audit trail entry.
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  if (body.domain === 'ipo') return handleIpoStatus(adminEmail, body);
  if (body.domain === 'account') return handleApplicationStatus(adminEmail, body);
  return jsonResponse(400, { error: "domain must be 'account' or 'ipo'." });
};

async function handleApplicationStatus(adminEmail, body) {
  const { applicationId, newStatus, chn, cscAccountNumber, adminNote, rejectionReason } = body;

  if (!applicationId || !APPLICATION_TRANSITIONS.includes(newStatus)) {
    return jsonResponse(400, {
      error: `applicationId and a valid newStatus (${APPLICATION_TRANSITIONS.join(', ')}) are required.`
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

    const update = { status: newStatus };
    if (newStatus === 'under_review_client_service') {
      update.review_started_at = new Date().toISOString();
      update.reviewed_by = adminEmail;
    } else if (newStatus === 'under_review_compliance') {
      // Second review stage — reviewed_by is overwritten to whoever
      // advanced it here; review_started_at is left as the original
      // client-service review start. The full per-stage history
      // (who, when, at which status) is captured in
      // application_status_history regardless, via the insert below.
      update.reviewed_by = adminEmail;
    } else if (newStatus === 'account_opening_in_progress') {
      // Compliance has approved — this just marks the handoff to
      // account opening itself. No new fields to set; the status
      // change and the status-history row are the record of it.
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
        if (newStatus === 'under_review_client_service') {
          await sendApplicantUnderReviewEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference
          });
        } else if (newStatus === 'under_review_compliance') {
          // Intentionally no customer email — this is an internal
          // handoff between review stages, not a change the
          // applicant needs to hear about. They already know their
          // application is under review from the previous stage.
        } else if (newStatus === 'account_opening_in_progress') {
          // Same reasoning — another internal handoff (compliance
          // clearance to the account-opening step itself), not
          // something the applicant needs a separate email about.
          // They'll hear from us once it's actually opened.
        } else if (newStatus === 'opened') {
          await sendApplicantOpenedEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference,
            chn,
            cscAccountNumber
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
    console.error('update-status (account) error:', err);
    return jsonResponse(500, { error: 'Something went wrong updating the application. Please try again.' });
  }
}

async function handleIpoStatus(adminEmail, body) {
  const { subscriptionId, newStatus, note, unitsAllotted } = body;

  if (!subscriptionId || !IPO_TRANSITIONS.includes(newStatus)) {
    return jsonResponse(400, {
      error: `subscriptionId and a valid newStatus (${IPO_TRANSITIONS.join(', ')}) are required.`
    });
  }
  if (newStatus === 'payment_unconfirmed' && (!note || note.trim().length < 5)) {
    return jsonResponse(400, { error: 'A short note explaining why payment could not be confirmed is required.' });
  }
  if (newStatus === 'allotted' && !unitsAllotted) {
    return jsonResponse(400, { error: 'Units allotted is required to mark a subscription as allotted.' });
  }

  try {
    const { data: subRow, error: fetchErr } = await supabase
      .from('ipo_subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .single();
    if (fetchErr || !subRow) {
      return jsonResponse(404, { error: 'Subscription not found.' });
    }

    const update = { status: newStatus, status_changed_at: new Date().toISOString(), status_changed_by: adminEmail };
    if (note) update.admin_note = note;
    if (newStatus === 'allotted') update.units_allotted = unitsAllotted;

    const { error: updateErr } = await supabase
      .from('ipo_subscriptions')
      .update(update)
      .eq('id', subscriptionId);
    if (updateErr) throw updateErr;

    await supabase.from('ipo_subscription_status_history').insert({
      subscription_id: subscriptionId,
      status: newStatus,
      changed_by: adminEmail,
      note: note || null
    });

    if (subRow.applicant_email) {
      try {
        const common = {
          applicantEmail: subRow.applicant_email,
          applicantName: subRow.applicant_name,
          subscriptionReference: subRow.subscription_reference
        };
        if (newStatus === 'payment_confirmed') {
          await sendIpoPaymentConfirmedEmail(common);
        } else if (newStatus === 'payment_unconfirmed') {
          await sendIpoPaymentUnconfirmedEmail({ ...common, note });
        } else if (newStatus === 'executed') {
          await sendIpoExecutedEmail(common);
        } else if (newStatus === 'allotted') {
          await sendIpoAllottedEmail({ ...common, unitsAllotted });
        }
        // pending_execution intentionally sends no email — a quiet
        // intermediate step between payment confirmation and execution.
      } catch (emailErr) {
        console.error('IPO status-change notification email failed:', emailErr);
      }
    }

    return jsonResponse(200, { ok: true, status: newStatus });
  } catch (err) {
    console.error('update-status (ipo) error:', err);
    return jsonResponse(500, { error: 'Something went wrong updating the subscription. Please try again.' });
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
