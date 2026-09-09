const { supabase } = require('./utils/supabaseClient');
const { sendIpoSubmissionReceivedEmail, sendIpoInternalAlert } = require('./utils/ipoEmail');

// Documents (signature, valid ID, payment evidence) are uploaded
// directly to Supabase Storage beforehand via upload-url.js
// — this function only receives small JSON, same pattern as
// submit-application.js for the account opening feature.

// Subscriptions open 14 September 2026, 00:00 WAT — same moment as
// the frontend gate in /dangote-ipo and /dangote-ipo/subscribe. The
// frontend hides the "Subscribe" button and blocks the wizard until
// this passes, but that's only a UI convenience — this server-side
// check is what actually stops a subscription being recorded before
// the offer is real. Keep in sync with the two frontend copies of
// this constant if the date ever changes.
const IPO_OFFER_OPENS_AT = new Date('2026-09-14T00:00:00+01:00');

// SUBSCRIPTIONS_ENABLED: hard kill switch, independent of the date
// above. /dangote-ipo/subscribe is currently a placeholder — the
// built wizard was intentionally taken off the live path, expected
// to be replaced by a separate white-labelled solution — so this
// endpoint refuses every submission outright regardless of what
// today's date is, even once IPO_OFFER_OPENS_AT passes. This is the
// real safety net (the frontend placeholder is only a UI
// convenience) — set this back to true once subscriptions should
// actually be accepted again.
const SUBSCRIPTIONS_ENABLED = false;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUBSCRIPTIONS_ENABLED) {
    return res.status(403).json({ error: 'Dangote IPO subscriptions are not currently being accepted.' });
  }

  if (new Date() < IPO_OFFER_OPENS_AT) {
    return res.status(403).json({ error: 'The Dangote Refinery IPO is not open for subscription yet. It opens 14 September 2026.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  const { investorType, data, documents } = body;

  if (!['individual', 'corporate', 'joint'].includes(investorType)) {
    return res.status(400).json({ error: 'A valid investorType is required.' });
  }

  const docs = Array.isArray(documents) ? documents : [];
  const numberOfUnits = Number(data?.participation?.numberOfUnits) || 0;
  const amountPayable = Number(data?.participation?.amountPayable) || 0;

  if (!numberOfUnits || numberOfUnits < 5000) {
    return res.status(400).json({ error: 'Minimum subscription is 5,000 units.' });
  }
  if ((numberOfUnits - 5000) % 10 !== 0) {
    return res.status(400).json({ error: 'Units above the minimum must be in multiples of 10.' });
  }

  try {
    const subscriptionReference = await generateUniqueReference();
    const { applicantName, applicantEmail, applicantPhone } = resolveApplicantIdentity(investorType, data || {});

    const { data: subRow, error: subErr } = await supabase
      .from('ipo_subscriptions')
      .insert({
        subscription_reference: subscriptionReference,
        investor_type: investorType,
        status: 'payment_pending',
        applicant_name: applicantName,
        applicant_email: applicantEmail,
        applicant_phone: applicantPhone,
        number_of_units: numberOfUnits,
        amount_payable: amountPayable,
        investor_info: data?.investor || {},
        corporate_info: data?.corporate || {},
        joint_applicant_info: data?.jointApplicant || {},
        cscs_info: data?.cscs || {},
        banking_info: data?.banking || {}
      })
      .select()
      .single();
    if (subErr) throw subErr;

    const subscriptionId = subRow.id;
    const tasks = [];

    if (docs.length) {
      const documentRows = docs.map((d) => ({
        subscription_id: subscriptionId,
        document_type: d.docKey,
        file_name: d.fileName,
        storage_path: d.path,
        file_type: d.fileType || null,
        file_size: d.fileSize || null
      }));
      tasks.push(
        supabase.from('ipo_subscription_documents').insert(documentRows).then(({ error }) => {
          if (error) throw error;
        })
      );
    }

    tasks.push(
      supabase.from('ipo_subscription_status_history').insert({
        subscription_id: subscriptionId,
        status: 'payment_pending',
        changed_by: 'system'
      }).then(({ error }) => {
        if (error) throw error;
      })
    );

    await Promise.all(tasks);

    await Promise.allSettled([
      sendIpoInternalAlert({
        subscriptionReference,
        investorType,
        applicantName,
        applicantEmail,
        subscriptionId,
        numberOfUnits,
        amountPayable
      }),
      applicantEmail
        ? sendIpoSubmissionReceivedEmail({ applicantEmail, applicantName, subscriptionReference, numberOfUnits, amountPayable })
        : Promise.resolve()
    ]).then((results) => {
      results.forEach((r) => {
        if (r.status === 'rejected') console.error('IPO notification email failed:', r.reason);
      });
    });

    return res.status(200).json({ subscriptionReference, subscriptionId });
  } catch (err) {
    console.error('submit-ipo-subscription error:', err);
    return res.status(500).json({ error: 'Something went wrong while submitting your subscription. Please try again.' });
  }
};

function resolveApplicantIdentity(investorType, data) {
  if (investorType === 'corporate') {
    const corp = data.corporate || {};
    return {
      applicantName: corp.companyName || null,
      applicantEmail: corp.email || null,
      applicantPhone: corp.phone || null
    };
  }
  const inv = data.investor || {};
  const name = [inv.title, inv.surname, inv.firstName, inv.otherNames].filter(Boolean).join(' ');
  return {
    applicantName: name || null,
    applicantEmail: inv.email || null,
    applicantPhone: inv.phone || null
  };
}

async function generateUniqueReference() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `DGT-${datePart}-${suffix}`;

    const { data, error } = await supabase
      .from('ipo_subscriptions')
      .select('id')
      .eq('subscription_reference', candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }
  return `DGT-${datePart}-${Date.now().toString().slice(-6)}`;
}
