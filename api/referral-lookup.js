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

  if (!code) {
    return res.status(400).json({ error: 'Please provide a referral code.' });
  }

  if (!otp) return requestOtp(res, code);
  return verifyOtpAndLookup(res, code, otp);
};

async function requestOtp(res, code) {
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
      const generatedOtp = generateOtp();
      const { error: insertErr } = await supabase.from('referral_otp_codes').insert({
        code,
        otp_hash: hashOtp(generatedOtp),
        expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString()
      });
      if (insertErr) throw insertErr;

      // OTP delivery IS the point of this step — unlike an internal
      // alert, a failure here must be surfaced, not swallowed, since
      // the person genuinely won't be able to proceed without it.
      await sendReferralOtpEmail({ email: codeRow.email, agentName: codeRow.agent_name, otp: generatedOtp });
    }

    return res.status(200).json({ ok: true, maskedEmail: maskEmail(codeRow.email) });
  } catch (err) {
    console.error('referral-lookup (request-otp) error:', err);
    return res.status(500).json({ error: 'Something went wrong sending your verification code. Please try again.' });
  }
}

async function verifyOtpAndLookup(res, code, otp) {
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

    // referred_by is free text an applicant typed on a wizard — not
    // guaranteed to match the code's exact case (handled by ilike),
    // and not guaranteed to be the code at all: some applicants type
    // the referrer's name instead of their code. Matching on both
    // (case-insensitive, run as two separate queries and merged
    // rather than one combined .or() filter, since PostgREST's .or()
    // string syntax is fragile against special characters that could
    // appear in a name) means a name-only entry still gets correctly
    // attributed rather than silently falling through the cracks.
    const applications = await matchByCodeOrName(
      'account_opening_applications',
      'application_reference, applicant_name, account_type, status, submitted_at, opened_at, chn, referred_by',
      'submitted_at',
      code,
      codeRow.agent_name
    );

    const subscriptions = await matchByCodeOrName(
      'ipo_subscriptions',
      'subscription_reference, applicant_name, investor_type, status, submitted_at, referred_by',
      'submitted_at',
      code,
      codeRow.agent_name
    );

    const accountsOpened = applications.filter(a => a.status === 'opened').length;

    return res.status(200).json({
      agentName: codeRow.agent_name,
      code: codeRow.code,
      accountsOpened,
      ipoSubscribers: subscriptions.length,
      applications: applications.map(a => ({
        reference: a.application_reference,
        applicantName: a.applicant_name,
        accountType: a.account_type,
        status: a.status,
        submittedAt: a.submitted_at,
        openedAt: a.opened_at,
        chn: a.chn
      })),
      subscriptions: subscriptions.map(s => ({
        reference: s.subscription_reference,
        applicantName: s.applicant_name,
        investorType: s.investor_type,
        status: s.status,
        submittedAt: s.submitted_at
      }))
    });
  } catch (err) {
    console.error('referral-lookup (verify) error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// Matches rows whose referred_by is either the code itself or the
// referrer's own agent_name (case-insensitive either way), merged and
// deduplicated by reference column, newest first. Two queries rather
// than a single combined filter — safer against special characters
// in a name (commas, parentheses) that could otherwise break
// PostgREST's .or() filter string syntax.
async function matchByCodeOrName(table, selectCols, dateCol, code, agentName) {
  const refCol = table === 'account_opening_applications' ? 'application_reference' : 'subscription_reference';

  const queries = [
    supabase.from(table).select(selectCols).ilike('referred_by', code)
  ];
  if (agentName && agentName.trim()) {
    queries.push(supabase.from(table).select(selectCols).ilike('referred_by', agentName.trim()));
  }

  const results = await Promise.all(queries);
  for (const r of results) if (r.error) throw r.error;

  const seen = new Set();
  const merged = [];
  for (const r of results) {
    for (const row of (r.data || [])) {
      if (seen.has(row[refCol])) continue;
      seen.add(row[refCol]);
      merged.push(row);
    }
  }
  merged.sort((a, b) => new Date(b[dateCol]) - new Date(a[dateCol]));
  return merged;
}
