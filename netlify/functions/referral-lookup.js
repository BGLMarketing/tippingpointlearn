const crypto = require('crypto');
const { supabase } = require('./utils/supabaseClient');
const { sendReferralOtpEmail } = require('./utils/brevo');

// Public endpoint, merged from request-referral-otp.js +
// referral-lookup.js to stay under Vercel Hobby's serverless function
// cap — adding request-referral-otp.js as a 10th function broke every
// deployment (the build completes but fails during "Deploying
// outputs", the same symptom hit earlier this session at 11
// functions; Vercel's actual internal count doesn't reliably match
// the literal file count, so merging is the safe fix rather than
// trying to find the exact number that's actually safe).
//
// Dispatches on whether `otp` is present in the body — no explicit
// `action` field needed, since the two calls already have naturally
// different shapes: {code} to request a code, {code, otp} to verify
// one and get the lookup results.
//
// Step 1 (no otp): given a referral code, emails a 6-digit one-time
// code to the email on file for it (never a self-claimed one — that's
// what makes the gate meaningful). Step 2 (with otp): verifies it
// (unexpired, unused, hash match, capped at 5 attempts, single-use)
// then returns the same safe subset of fields as before — never
// email, banking details, personal_info, or commission figures
// (commission is admin-only, shown in /admin, not here). One code
// covers both BGL account opening and Dangote IPO subscriptions.

const OTP_TTL_MINUTES = 10;
const OTP_COOLDOWN_SECONDS = 60;
const MAX_OTP_ATTEMPTS = 5;

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
  const otp = (body.otp || '').trim();

  if (!code) {
    return jsonResponse(400, { error: 'Please provide a referral code.' });
  }

  if (!otp) return requestOtp(code);
  return verifyOtpAndLookup(code, otp);
};

async function requestOtp(code) {
  try {
    const { data: codeRow, error: codeErr } = await supabase
      .from('referral_codes')
      .select('code, agent_name, email')
      .eq('code', code)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!codeRow) {
      return jsonResponse(404, { error: "We couldn't find that referral code." });
    }
    if (!codeRow.email) {
      return jsonResponse(403, { error: 'This code has no email on file yet — contact BGL to enable lookup for it.' });
    }
    console.log('[DIAG referral-otp] code row found, email:', codeRow.email);

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
    console.log('[DIAG referral-otp] recent row:', JSON.stringify(recent));

    const withinCooldown = recent &&
      (Date.now() - new Date(recent.created_at).getTime()) / 1000 < OTP_COOLDOWN_SECONDS;
    console.log('[DIAG referral-otp] withinCooldown:', withinCooldown);

    if (!withinCooldown) {
      const generatedOtp = generateOtp();
      const { error: insertErr } = await supabase.from('referral_otp_codes').insert({
        code,
        otp_hash: hashOtp(generatedOtp),
        expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString()
      });
      if (insertErr) throw insertErr;
      console.log('[DIAG referral-otp] OTP row inserted, about to call sendReferralOtpEmail for', codeRow.email);

      // OTP delivery IS the point of this step — unlike an internal
      // alert, a failure here must be surfaced, not swallowed, since
      // the person genuinely won't be able to proceed without it.
      await sendReferralOtpEmail({ email: codeRow.email, agentName: codeRow.agent_name, otp: generatedOtp });
      console.log('[DIAG referral-otp] sendReferralOtpEmail completed without throwing');
    } else {
      console.log('[DIAG referral-otp] SKIPPED sending — within cooldown window');
    }

    return jsonResponse(200, { ok: true, maskedEmail: maskEmail(codeRow.email) });
  } catch (err) {
    console.error('referral-lookup (request-otp) error:', err);
    return jsonResponse(500, { error: 'Something went wrong sending your verification code. Please try again.' });
  }
}

async function verifyOtpAndLookup(code, otp) {
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
      return jsonResponse(400, { error: 'No verification code is pending for this referral code. Please request a new one.' });
    }
    if (new Date(otpRow.expires_at) < new Date()) {
      return jsonResponse(400, { error: 'That verification code has expired. Please request a new one.' });
    }
    if (otpRow.attempts >= MAX_OTP_ATTEMPTS) {
      return jsonResponse(429, { error: 'Too many incorrect attempts. Please request a new verification code.' });
    }
    if (hashOtp(otp) !== otpRow.otp_hash) {
      await supabase.from('referral_otp_codes').update({ attempts: otpRow.attempts + 1 }).eq('id', otpRow.id);
      return jsonResponse(400, { error: 'Incorrect verification code. Please try again.' });
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
    console.error('referral-lookup (verify) error:', err);
    return jsonResponse(500, { error: 'Something went wrong. Please try again.' });
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
