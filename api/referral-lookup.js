const crypto = require('crypto');
const { supabase } = require('./utils/supabaseClient');

// Public endpoint — step 2 of the OTP-gated /referral-status flow.
// Knowing the referral code alone is no longer sufficient (it never
// truly was "not guessable" — short codes, reused across channels);
// now requires a valid, unexpired, unused OTP for that code, sent to
// the email on file via request-referral-otp.js. Only a safe subset
// of fields is returned per application/subscription — never email,
// banking details, personal_info, or commission figures (commission
// is admin-only, shown in /admin, not here).
//
// One code now covers both BGL account opening and Dangote IPO
// subscriptions — this endpoint reports both.

const MAX_OTP_ATTEMPTS = 5;

function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

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
  const otp = (body.otp || '').trim();
  if (!code || !otp) {
    return res.status(400).json({ error: 'Please provide your referral code and verification code.' });
  }

  try {
    // ---- Verify the OTP first — nothing below runs without it ----
    const { data: otpRow, error: otpErr } = await supabase
      .from('referral_otp_codes')
      .select('*')
      .eq('code', code)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (otpErr) throw otpErr;

    if (!otpRow) {
      return res.status(400).json({ error: 'No verification code is pending for this referral code. Please request a new one.' });
    }
    if (new Date(otpRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'That verification code has expired. Please request a new one.' });
    }
    if (otpRow.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new verification code.' });
    }
    if (hashOtp(otp) !== otpRow.otp_hash) {
      await supabase.from('referral_otp_codes').update({ attempts: otpRow.attempts + 1 }).eq('id', otpRow.id);
      return res.status(400).json({ error: 'Incorrect verification code. Please try again.' });
    }

    // Single-use — mark it spent so it can't be replayed for another
    // lookup even if it leaked somewhere before expiry.
    await supabase.from('referral_otp_codes').update({ used_at: new Date().toISOString() }).eq('id', otpRow.id);

    // ---- OTP verified — proceed with the actual lookup ----
    const { data: codeRow, error: codeErr } = await supabase
      .from('referral_codes')
      .select('code, agent_name')
      .eq('code', code)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!codeRow) {
      return res.status(404).json({ error: "We couldn't find that referral code." });
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

    return res.status(200).json({
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
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
