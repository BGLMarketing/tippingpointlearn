const { supabase } = require('./utils/supabaseClient');

// Public endpoint — no login required, since this is for applicants
// checking their own status. To avoid leaking whether a given reference
// exists at all, both the reference AND the email must match together;
// a mismatch on either returns the same generic "not found" response.
// Only the fields needed to render a status tracker are returned — never
// the full applicant/personal_info record.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  const reference = (body.reference || '').trim();
  const email = (body.email || '').trim().toLowerCase();

  if (!reference || !email) {
    return jsonResponse(400, { error: 'Please provide both an application reference and an email address.' });
  }

  try {
    const { data, error } = await supabase
      .from('account_opening_applications')
      .select('application_reference, status, submitted_at, opened_at, chn, rejected_at, rejection_reason, applicant_email')
      .eq('application_reference', reference)
      .maybeSingle();

    if (error) throw error;

    // Case-insensitive email match, checked in code rather than in the
    // query, so a wrong email gives the exact same response as a wrong
    // reference (no hint about which part was incorrect).
    if (!data || (data.applicant_email || '').toLowerCase() !== email) {
      return jsonResponse(404, { error: "We couldn't find an application matching that reference and email." });
    }

    return jsonResponse(200, {
      applicationReference: data.application_reference,
      status: data.status,
      submittedAt: data.submitted_at,
      openedAt: data.opened_at,
      chn: data.chn,
      rejectedAt: data.rejected_at,
      rejectionReason: data.rejection_reason
    });
  } catch (err) {
    console.error('track-application error:', err);
    return jsonResponse(500, { error: 'Something went wrong. Please try again.' });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
