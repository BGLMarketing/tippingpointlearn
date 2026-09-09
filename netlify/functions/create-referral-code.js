const { supabase } = require('./utils/supabaseClient');

const SITE_URL = process.env.SITE_URL || 'https://tippingpoint.bglafrica.com';

// Public endpoint — lets any visitor create their own referral code
// and get a shareable link, without needing admin approval. Distinct
// from the admin-created codes (for official agents/RMs) only by
// created_by — both live in the same table and both work identically
// on /referral-status and as a "Referred by" value.

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

  const name = (body.name || '').trim();
  let code = (body.code || '').trim().toUpperCase();
  const email = (body.email || '').trim();

  if (!name || !code || !email) {
    return jsonResponse(400, { error: 'Please provide your name, email, and a preferred code.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'Please provide a valid email address.' });
  }
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) {
    return jsonResponse(400, { error: 'Codes can only use letters, numbers, and hyphens, and must be 3-20 characters.' });
  }

  try {
    const { data: existing, error: checkErr } = await supabase
      .from('referral_codes')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (checkErr) throw checkErr;
    if (existing) {
      return jsonResponse(409, { error: 'That code is already taken — please choose another.' });
    }

    const { error: insertErr } = await supabase.from('referral_codes').insert({
      agent_name: name,
      code,
      email,
      created_by: 'self-service'
    });
    if (insertErr) throw insertErr;

    return jsonResponse(200, {
      code,
      shareUrl: `${SITE_URL}/open-account?ref=${encodeURIComponent(code)}`,
      ipoShareUrl: `${SITE_URL}/dangote-ipo/subscribe?ref=${encodeURIComponent(code)}`
    });
  } catch (err) {
    console.error('create-referral-code error:', err);
    return jsonResponse(500, { error: 'Could not create that code. Please try again.' });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
