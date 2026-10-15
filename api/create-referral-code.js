const { supabase } = require('../lib/supabaseClient');

const SITE_URL = process.env.SITE_URL || 'https://tippingpoint.bglafrica.com';

// Public endpoint — lets any visitor create their own referral code
// and get a shareable link, without needing admin approval. Distinct
// from the admin-created codes (for official agents/RMs) only by
// created_by — both live in the same table and both work identically
// on /referral-status and as a "Referred by" value.

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

  // Agent onboarding applications share this endpoint rather than
  // getting their own file, to stay under Vercel Hobby's serverless
  // function cap (see README).
  if (body.action === 'apply') return handleAgentApplication(res, body);

  const name = (body.name || '').trim();
  let code = (body.code || '').trim().toUpperCase();
  const email = (body.email || '').trim();

  if (!name || !code || !email) {
    return res.status(400).json({ error: 'Please provide your name, email, and a preferred code.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) {
    return res.status(400).json({ error: 'Codes can only use letters, numbers, and hyphens, and must be 3-20 characters.' });
  }

  try {
    const { data: existing, error: checkErr } = await supabase
      .from('referral_codes')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (checkErr) throw checkErr;
    if (existing) {
      return res.status(409).json({ error: 'That code is already taken — please choose another.' });
    }

    const { error: insertErr } = await supabase.from('referral_codes').insert({
      agent_name: name,
      code,
      email,
      created_by: 'self-service'
    });
    if (insertErr) throw insertErr;

    return res.status(200).json({
      code,
      shareUrl: `${SITE_URL}/open-account?ref=${encodeURIComponent(code)}`,
      ipoShareUrl: `${SITE_URL}/dangote-ipo/subscribe?ref=${encodeURIComponent(code)}`
    });
  } catch (err) {
    console.error('create-referral-code error:', err);
    return res.status(500).json({ error: 'Could not create that code. Please try again.' });
  }
};

// ---- Agent onboarding application (public) ----
// Records an application to become a referral agent. No code is
// created here: an admin reviews it, sets the commission (default
// 0.25%) and issues the code from the admin dashboard. BVN and bank
// details are deliberately NOT collected at this stage.
const FIELD_MAX = 300;

function clean(v, max = FIELD_MAX) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

async function handleAgentApplication(res, body) {
  const {
    sendAgentApplicationReceivedEmail,
    sendInternalNewAgentApplicationAlert
  } = require('../lib/brevo');
  const { getAdminEmails } = require('../lib/supabaseClient');

  // Honeypot: real people never fill this hidden field.
  if (clean(body.website)) return res.status(200).json({ success: true });

  const full_name = clean(body.full_name, 120);
  const email = clean(body.email, 160).toLowerCase();
  const phone = clean(body.phone, 30);
  const consent = body.consent === true;

  if (!full_name || !email || !phone) {
    return res.status(400).json({ error: 'Please fill in your name, email and phone number.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!/^[+\d][\d\s-]{6,}$/.test(phone)) {
    return res.status(400).json({ error: 'Please provide a valid phone number.' });
  }
  if (!consent) {
    return res.status(400).json({ error: 'Please agree to be contacted about your application.' });
  }

  const { data: existing, error: checkErr } = await supabase
    .from('agent_applications')
    .select('id, status')
    .ilike('email', email)
    .neq('status', 'rejected')
    .maybeSingle();
  if (checkErr) {
    console.error('agent apply duplicate check failed:', checkErr);
  } else if (existing) {
    const msg = existing.status === 'approved'
      ? 'You are already an approved agent. Check your email for your referral code.'
      : "We already have an application from this email. We'll be in touch once it has been reviewed.";
    return res.status(409).json({ error: msg });
  }

  const { data: row, error: insertErr } = await supabase
    .from('agent_applications')
    .insert({
      full_name,
      email,
      phone,
      state: clean(body.state, 60) || null,
      occupation: clean(body.occupation, 120) || null,
      network_description: clean(body.network_description, 600) || null,
      expected_referrals: clean(body.expected_referrals, 40) || null,
      heard_about: clean(body.heard_about, 120) || null,
      consent
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('agent apply insert failed:', insertErr);
    return res.status(500).json({ error: 'Could not save your application. Please try again.' });
  }

  // A failed email never fails an application that is already saved.
  try {
    await sendAgentApplicationReceivedEmail({ email, name: full_name });
    await supabase.from('agent_applications').update({ confirmation_email_sent: true }).eq('id', row.id);
  } catch (err) {
    console.error('agent application confirmation email failed:', err);
  }
  try {
    const admins = await getAdminEmails();
    if (admins.length) {
      await sendInternalNewAgentApplicationAlert({ to: admins, name: full_name, email, phone, state: clean(body.state, 60) });
    }
  } catch (err) {
    console.error('agent application admin alert failed:', err);
  }

  return res.status(200).json({ success: true });
}
