const { supabase } = require('./utils/supabaseClient');

// Public endpoint — both reference AND email must match together;
// a mismatch on either returns the same generic "not found" response,
// and only status fields are ever returned, never the full applicant
// record.

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

  const reference = (body.reference || '').trim();
  const email = (body.email || '').trim().toLowerCase();

  if (!reference || !email) {
    return res.status(400).json({ error: 'Please provide both an application reference and an email address.' });
  }

  try {
    const { data, error } = await supabase
      .from('account_opening_applications')
      .select('application_reference, status, submitted_at, opened_at, chn, rejected_at, rejection_reason, applicant_email')
      .eq('application_reference', reference)
      .maybeSingle();

    if (error) throw error;

    if (!data || (data.applicant_email || '').toLowerCase() !== email) {
      return res.status(404).json({ error: "We couldn't find an application matching that reference and email." });
    }

    return res.status(200).json({
      applicationReference: data.application_reference,
      status: data.status,
      submittedAt: data.submitted_at,
      openedAt: data.opened_at,
      chn: data.chn,
      rejectedAt: data.rejected_at,
      rejectionReason: data.rejection_reason
    });
  } catch (err) {
    console.error('track-application error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
