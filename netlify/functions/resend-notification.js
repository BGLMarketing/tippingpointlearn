const { supabase } = require('./utils/supabaseClient');
const {
  sendApplicantConfirmationEmail,
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
} = require('./utils/email');

// Re-sends the notification email matching an application's CURRENT
// stored status — used to backfill applicants who were updated before
// a fix to the email content (e.g. the CSCS Account Number that was
// missing from the "opened" email), or whose original send failed.
// Admin-only, same auth check as update-application-status.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader && authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return jsonResponse(401, { error: 'Missing authorization token.' });
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return jsonResponse(401, { error: 'Invalid or expired session. Please sign in again.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  const { applicationId } = body;
  if (!applicationId) {
    return jsonResponse(400, { error: 'applicationId is required.' });
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
    if (!appRow.applicant_email) {
      return jsonResponse(400, { error: 'This application has no applicant email on file.' });
    }

    const common = {
      applicantEmail: appRow.applicant_email,
      applicantName: appRow.applicant_name,
      applicationReference: appRow.application_reference
    };

    switch (appRow.status) {
      case 'submitted':
        await sendApplicantConfirmationEmail(common);
        break;
      case 'under_review':
        await sendApplicantUnderReviewEmail(common);
        break;
      case 'opened':
        if (!appRow.chn || !appRow.csc_account_number) {
          return jsonResponse(400, { error: 'This application is marked opened but is missing a CHN or CSCS Account Number — fix that first.' });
        }
        await sendApplicantOpenedEmail({ ...common, chn: appRow.chn, cscAccountNumber: appRow.csc_account_number });
        break;
      case 'rejected':
        if (!appRow.rejection_reason) {
          return jsonResponse(400, { error: 'This application is marked rejected but has no rejection reason on file.' });
        }
        await sendApplicantRejectedEmail({ ...common, reason: appRow.rejection_reason });
        break;
      default:
        return jsonResponse(400, { error: `Unrecognized status: ${appRow.status}` });
    }

    return jsonResponse(200, { ok: true, status: appRow.status, sentTo: appRow.applicant_email });
  } catch (err) {
    console.error('resend-notification error:', err);
    return jsonResponse(500, { error: 'Could not resend the notification: ' + (err.message || 'Unknown error') });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
