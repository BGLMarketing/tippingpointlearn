const crypto = require('crypto');
const { supabase } = require('./utils/supabaseClient');
const { sendReferralOtpEmail } = require('./utils/brevo');

// Public endpoint — step 1 of the OTP-gated /referral-status flow.
// Given a referral code, emails a 6-digit one-time code to the email
// on file for it (not the caller's own claimed email — this is what
// makes the gate meaningful: only someone with access to that inbox
// can complete verification, regardless of who's typing the code).

const OTP_TTL_MINUTES = 10;
const OTP_COOLDOWN_SECONDS = 60;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}
function maskEmail(email) {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'*'.repeat(Math.max(1, user.length - visible.length))}@${domain}`;
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
  if (!code) {
    return res.status(400).json({ error: 'Please provide a referral code.' });
  }

  try {
    const { data: codeRow, error: codeErr } = await supabase
      .from('referral_codes')
      .select('code, agent_name, email')
      .eq('code', code)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!codeRow) {
      return res.status(404).json({ error: "We couldn't find that referral code." });
    }
    if (!codeRow.email) {
      return res.status(403).json({ error: 'This code has no email on file yet — contact BGL to enable lookup for it.' });
    }

    // Cooldown: if a still-pending OTP was requested very recently for
    // this code, don't send another — avoids spam-emailing the
    // recipient if this endpoint gets hit repeatedly. Responds as if
    // it succeeded either way, so this never leaks whether a request
    // is being rate-limited vs freshly sent.
    const { data: recent, error: recentErr } = await supabase
      .from('referral_otp_codes')
      .select('created_at')
      .eq('code', code)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentErr) throw recentErr;

    const withinCooldown = recent &&
      (Date.now() - new Date(recent.created_at).getTime()) / 1000 < OTP_COOLDOWN_SECONDS;

    if (!withinCooldown) {
      const otp = generateOtp();
      const { error: insertErr } = await supabase.from('referral_otp_codes').insert({
        code,
        otp_hash: hashOtp(otp),
        expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString()
      });
      if (insertErr) throw insertErr;

      // OTP delivery IS the point of this endpoint — unlike an
      // internal alert, a failure here must be surfaced, not
      // swallowed, since the person genuinely won't be able to
      // proceed without it.
      await sendReferralOtpEmail({ email: codeRow.email, agentName: codeRow.agent_name, otp });
    }

    return res.status(200).json({ ok: true, maskedEmail: maskEmail(codeRow.email) });
  } catch (err) {
    console.error('request-referral-otp error:', err);
    return res.status(500).json({ error: 'Something went wrong sending your verification code. Please try again.' });
  }
};
