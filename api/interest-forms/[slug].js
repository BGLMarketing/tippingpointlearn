// pages/api/interest-forms/[slug].js  (Vercel serverless function)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { slug } = req.query;

  const { data, error } = await supabase
    .from('interest_forms')
    .select('slug, product_name, status')
    .eq('slug', slug)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Form not found' });
  if (data.status !== 'active') return res.status(410).json({ error: 'This form is no longer accepting submissions' });

  // Only send what the public page needs — never leak referral_code or offer_url here
  return res.status(200).json({ product_name: data.product_name });
}
