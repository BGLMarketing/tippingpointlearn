const { supabase } = require('./utils/supabaseClient');

// Public endpoint — no login required. A referral code is admin-issued
// and not guessable (unlike a name or email), so a single matching
// code is treated as sufficient access to see who used it. Only a
// safe subset of fields is returned per application — never email,
// banking details, or personal_info.

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

  const code = (body.code || '').trim();
  if (!code) {
    return jsonResponse(400, { error: 'Please provide a referral code.' });
  }

  try {
    const { data: codeRow, error: codeErr } = await supabase
      .from('referral_codes')
      .select('code, agent_name')
      .eq('code', code)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!codeRow) {
      return jsonResponse(404, { error: "We couldn't find that referral code." });
    }

    const { data: applications, error: appsErr } = await supabase
      .from('account_opening_applications')
      .select('application_reference, applicant_name, account_type, status, submitted_at, opened_at, chn')
      .eq('referred_by', code)
      .order('submitted_at', { ascending: false });

    if (appsErr) throw appsErr;

    return jsonResponse(200, {
      agentName: codeRow.agent_name,
      code: codeRow.code,
      count: (applications || []).length,
      applications: (applications || []).map(a => ({
        reference: a.application_reference,
        applicantName: a.applicant_name,
        accountType: a.account_type,
        status: a.status,
        submittedAt: a.submitted_at,
        openedAt: a.opened_at,
        chn: a.chn
      }))
    });
  } catch (err) {
    console.error('referral-lookup error:', err);
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
