const { supabase } = require('./utils/supabaseClient');

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

  const name = (body.name || '').trim();
  let code = (body.code || '').trim().toUpperCase();

  if (!name || !code) {
    return res.status(400).json({ error: 'Please provide your name and a preferred code.' });
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
      created_by: 'self-service'
    });
    if (insertErr) throw insertErr;

    return res.status(200).json({
      code,
      shareUrl: `${SITE_URL}/open-account?ref=${encodeURIComponent(code)}`
    });
  } catch (err) {
    console.error('create-referral-code error:', err);
    return res.status(500).json({ error: 'Could not create that code. Please try again.' });
  }
};
