const { supabase } = require('../../lib/supabaseClient');

// GET  /api/interest-forms/:slug — looks up the form by slug, for the
//      public page to render (product name) before showing the form.
// POST /api/interest-forms/:slug — the actual submission.
//
// Converted from the original draft's import/export-default (ES
// module) syntax to this project's module.exports convention — every
// other function here uses it, and having exactly one file written
// differently is a real maintainability risk even though it does
// actually run correctly on Vercel either way.

module.exports = async (req, res) => {
  const { slug } = req.query;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('interest_forms')
      .select('slug, product_name, status')
      .eq('slug', slug)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Form not found' });
    if (data.status !== 'active') return res.status(410).json({ error: 'This form is no longer accepting submissions' });

    return res.status(200).json({ product_name: data.product_name });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (err) {
      return res.status(400).json({ error: 'Malformed request body.' });
    }
    const { full_name, email, phone, membership_id, interest_band, consent } = body;

    if (!full_name || !email || !phone || !consent) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data: form, error: formError } = await supabase
      .from('interest_forms')
      .select('id, referral_code, product_name, offer_url, status')
      .eq('slug', slug)
      .single();

    if (formError || !form) return res.status(404).json({ error: 'Form not found' });
    if (form.status !== 'active') return res.status(410).json({ error: 'This form is no longer accepting submissions' });

    const { data: submission, error: insertError } = await supabase
      .from('referral_interest')
      .insert({
        form_id: form.id,
        full_name,
        email,
        phone,
        membership_id: membership_id || null,
        interest_band: interest_band || null,
        consent
      })
      .select()
      .single();

    if (insertError) return res.status(500).json({ error: 'Could not save submission' });

    // Never let a flaky email send fail a submission that's already
    // safely recorded — same reasoning as every other submit endpoint
    // in this project.
    try {
      await sendInterestFormEmail({
        to: email,
        name: full_name,
        productName: form.product_name,
        offerUrl: form.offer_url,
        referralCode: form.referral_code
      });

      await supabase
        .from('referral_interest')
        .update({ email_sent: true })
        .eq('id', submission.id);
    } catch (emailError) {
      console.error('Interest-form confirmation email failed:', emailError);
    }

    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
};

// Deliberately a template-based Brevo send (BREVO_INTEREST_TEMPLATE_ID
// + params), not the shared sendEmail() helper in ./utils/brevo.js —
// that helper only sends raw htmlContent, not a Brevo template, so
// it's not a fit here. Kept local to this file rather than added to
// the shared utility, since nothing else in the project needs a
// template-based send yet.
async function sendInterestFormEmail({ to, name, productName, offerUrl, referralCode }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY not set — interest-form confirmation not sent to', to);
    return;
  }

  // Brevo's templateId is numeric — env vars are always strings, and
  // sending it as a string is a real candidate for why Brevo might
  // silently accept the request without it becoming a genuine
  // tracked send. Converting explicitly and failing loudly if it
  // doesn't parse, rather than sending a malformed value and finding
  // out from a missing email days later.
  const templateId = Number(process.env.BREVO_INTEREST_TEMPLATE_ID);
  if (!process.env.BREVO_INTEREST_TEMPLATE_ID || Number.isNaN(templateId)) {
    throw new Error(`BREVO_INTEREST_TEMPLATE_ID is not a valid number: ${JSON.stringify(process.env.BREVO_INTEREST_TEMPLATE_ID)}`);
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: [{ email: to, name }],
      templateId,
      params: { name, productName, offerUrl, referralCode }
    })
  });

  // Previously only checked response.ok (the HTTP status) and never
  // looked at the body — meaning a genuine send returns
  // { messageId: "..." } we never logged, and a same-shaped-but-wrong
  // response would have passed the .ok check without ever revealing
  // what Brevo actually did with the request. Reading and logging
  // the body either way is what makes this diagnosable at all.
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Brevo error ${response.status}: ${JSON.stringify(body)}`);
  }
  console.log('Interest-form confirmation sent via Brevo:', JSON.stringify(body));
  return body;
}
