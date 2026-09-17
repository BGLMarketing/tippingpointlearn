// api/interest-forms/[slug].js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
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
    const { full_name, email, phone, membership_id, interest_band, consent } = req.body;

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

    try {
      await sendBrevoEmail({
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
      console.error('Brevo send failed:', emailError);
    }

    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

async function sendBrevoEmail({ to, name, productName, offerUrl, referralCode }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: [{ email: to, name }],
      templateId: process.env.BREVO_INTEREST_TEMPLATE_ID,
      params: { name, productName, offerUrl, referralCode }
    })
  });

  if (!response.ok) throw new Error(`Brevo error: ${response.status}`);
}
