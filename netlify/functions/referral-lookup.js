const { supabase } = require('./utils/supabaseClient');

// Public endpoint — no login required. A referral code is admin-issued
// and not guessable (unlike a name or email), so a single matching
// code is treated as sufficient access to see who used it. Only a
// safe subset of fields is returned per application/subscription —
// never email, banking details, personal_info, or commission figures
// (commission is admin-only, shown in /admin, not here).
//
// One code now covers both BGL account opening and Dangote IPO
// subscriptions — this endpoint reports both.

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

  const code = (body.code || '').trim().toUpperCase();
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

    // referred_by is free text an applicant typed on a wizard, not
    // guaranteed to match the stored (always-uppercase) code's exact
    // case — match case-insensitively.
    const { data: applications, error: appsErr } = await supabase
      .from('account_opening_applications')
      .select('application_reference, applicant_name, account_type, status, submitted_at, opened_at, chn')
      .ilike('referred_by', code)
      .order('submitted_at', { ascending: false });
    if (appsErr) throw appsErr;

    const { data: subscriptions, error: subsErr } = await supabase
      .from('ipo_subscriptions')
      .select('subscription_reference, applicant_name, investor_type, status, submitted_at')
      .ilike('referred_by', code)
      .order('submitted_at', { ascending: false });
    if (subsErr) throw subsErr;

    const accountsOpened = (applications || []).filter(a => a.status === 'opened').length;

    return jsonResponse(200, {
      agentName: codeRow.agent_name,
      code: codeRow.code,
      accountsOpened,
      ipoSubscribers: (subscriptions || []).length,
      applications: (applications || []).map(a => ({
        reference: a.application_reference,
        applicantName: a.applicant_name,
        accountType: a.account_type,
        status: a.status,
        submittedAt: a.submitted_at,
        openedAt: a.opened_at,
        chn: a.chn
      })),
      subscriptions: (subscriptions || []).map(s => ({
        reference: s.subscription_reference,
        applicantName: s.applicant_name,
        investorType: s.investor_type,
        status: s.status,
        submittedAt: s.submitted_at
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
