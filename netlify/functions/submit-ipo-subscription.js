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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if (new Date() < IPO_OFFER_OPENS_AT) {
    return jsonResponse(403, { error: 'The Dangote Refinery IPO is not open for subscription yet. It opens 14 September 2026.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  const { investorType, data, documents } = body;

  if (!['individual', 'corporate', 'joint'].includes(investorType)) {
    return jsonResponse(400, { error: 'A valid investorType is required.' });
  }

  const docs = Array.isArray(documents) ? documents : [];
  const numberOfUnits = Number(data?.participation?.numberOfUnits) || 0;
  const amountPayable = Number(data?.participation?.amountPayable) || 0;
  const referredBy = (data?.participation?.referredBy || '').trim() || null;

  if (!numberOfUnits || numberOfUnits < 50000) {
    return jsonResponse(400, { error: 'Minimum subscription is 50,000 units.' });
  }
  if ((numberOfUnits - 50000) % 10 !== 0) {
    return jsonResponse(400, { error: 'Units above the minimum must be in multiples of 10.' });
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
        referred_by: referredBy,
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

    return jsonResponse(200, { subscriptionReference, subscriptionId });
  } catch (err) {
    console.error('submit-ipo-subscription error:', err);
    return jsonResponse(500, { error: 'Something went wrong while submitting your subscription. Please try again.' });
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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
