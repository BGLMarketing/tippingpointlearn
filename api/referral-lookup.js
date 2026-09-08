const { supabase } = require('./utils/supabaseClient');

// Public endpoint — no login required. A referral code is admin-issued
// and not guessable (unlike a name or email), so a single matching
// code is treated as sufficient access to see who used it. Only a
// safe subset of fields is returned per application — never email,
// banking details, or personal_info.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  const code = (body.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: 'Please provide a referral code.' });
  }

  try {
    const { data: codeRow, error: codeErr } = await supabase
      .from('referral_codes')
      .select('code, agent_name')
      .eq('code', code)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!codeRow) {
      return res.status(404).json({ error: "We couldn't find that referral code." });
    }

    // referred_by is free text an applicant typed on the wizard, not
    // guaranteed to match the stored (always-uppercase) code's exact
    // case — match case-insensitively.
    const { data: applications, error: appsErr } = await supabase
      .from('account_opening_applications')
      .select('application_reference, applicant_name, account_type, status, submitted_at, opened_at, chn')
      .ilike('referred_by', code)
      .order('submitted_at', { ascending: false });

    if (appsErr) throw appsErr;

    return res.status(200).json({
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
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
