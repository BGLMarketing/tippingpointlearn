const { supabase } = require('./utils/supabaseClient');
const {
  sendApplicantConfirmationEmail,
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
} = require('./utils/brevo');

// Re-sends the notification email matching an application's CURRENT
// stored status — used to backfill applicants who were updated before
// a fix to the email content (e.g. the CSCS Account Number that was
// missing from the "opened" email), or whose original send failed.
// Admin-only, same auth check as update-application-status.

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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  const { applicationId } = body;
  if (!applicationId) {
    return res.status(400).json({ error: 'applicationId is required.' });
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
    if (!appRow.applicant_email) {
      return res.status(400).json({ error: 'This application has no applicant email on file.' });
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
          return res.status(400).json({ error: 'This application is marked opened but is missing a CHN or CSCS Account Number — fix that first.' });
        }
        await sendApplicantOpenedEmail({ ...common, chn: appRow.chn, cscAccountNumber: appRow.csc_account_number });
        break;
      case 'rejected':
        if (!appRow.rejection_reason) {
          return res.status(400).json({ error: 'This application is marked rejected but has no rejection reason on file.' });
        }
        await sendApplicantRejectedEmail({ ...common, reason: appRow.rejection_reason });
        break;
      default:
        return res.status(400).json({ error: `Unrecognized status: ${appRow.status}` });
    }

    return res.status(200).json({ ok: true, status: appRow.status, sentTo: appRow.applicant_email });
  } catch (err) {
    console.error('resend-notification error:', err);
    return res.status(500).json({ error: 'Could not resend the notification. Please try again.' });
  }
};
