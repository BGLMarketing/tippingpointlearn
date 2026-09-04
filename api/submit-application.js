const { supabase } = require('./utils/supabaseClient');
const {
  sendInternalNewSubmissionAlert,
  sendApplicantConfirmationEmail
} = require('./utils/brevo');

// Documents are uploaded DIRECTLY from the browser to Supabase Storage
// beforehand (see create-upload-url.js), so this function only ever
// receives small JSON — accountType, form data, and a list of
// {person, docKey, path, fileName, fileType, fileSize} for documents
// that are already sitting in storage.

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

  const { accountType, data, documents } = body;

  if (!['individual', 'joint', 'corporate'].includes(accountType)) {
    return res.status(400).json({ error: 'A valid accountType is required.' });
  }

  const docs = Array.isArray(documents) ? documents : [];

  try {
    const applicationReference = await generateUniqueReference();
    const { applicantName, applicantEmail } = resolveApplicantIdentity(accountType, data || {});

    const { data: appRow, error: appErr } = await supabase
      .from('account_opening_applications')
      .insert({
        application_reference: applicationReference,
        account_type: accountType,
        status: 'submitted',
        referred_by: data?.account?.referredBy || null,
        banking_details: data?.banking || {},
        applicant_name: applicantName,
        applicant_email: applicantEmail
      })
      .select()
      .single();
    if (appErr) throw appErr;

    const applicationId = appRow.id;
    const tasks = [];

    const applicantRows = [];
    if (accountType === 'individual' || accountType === 'joint') {
      applicantRows.push(buildApplicantRow(applicationId, 'primary', data?.primary));
    }
    if (accountType === 'joint') {
      applicantRows.push(buildApplicantRow(applicationId, 'joint_partner', data?.jointPartner));
    }
    if (accountType === 'corporate') {
      applicantRows.push(buildApplicantRow(applicationId, 'signatory_1', data?.signatory1));
      applicantRows.push(buildApplicantRow(applicationId, 'signatory_2', data?.signatory2));
    }
    if (applicantRows.length) {
      tasks.push(
        supabase.from('applicants').insert(applicantRows).then(({ error }) => {
          if (error) throw error;
        })
      );
    }

    if (accountType === 'corporate') {
      tasks.push(
        supabase.from('corporate_profiles').insert({
          application_id: applicationId,
          company_info: data?.company || {}
        }).then(({ error }) => {
          if (error) throw error;
        })
      );
    }

    if (docs.length) {
      const documentRows = docs.map((d) => ({
        application_id: applicationId,
        applicant_role: d.person,
        document_type: d.docKey,
        file_name: d.fileName,
        storage_path: d.path,
        file_type: d.fileType || null,
        file_size: d.fileSize || null
      }));
      tasks.push(
        supabase.from('application_documents').insert(documentRows).then(({ error }) => {
          if (error) throw error;
        })
      );
    }

    tasks.push(
      supabase.from('application_status_history').insert({
        application_id: applicationId,
        status: 'submitted',
        changed_by: 'system'
      }).then(({ error }) => {
        if (error) throw error;
      })
    );

    await Promise.all(tasks);

    await Promise.allSettled([
      sendInternalNewSubmissionAlert({
        applicationReference,
        accountType,
        applicantName,
        applicantEmail,
        applicationId,
        fileCount: docs.length
      }),
      applicantEmail
        ? sendApplicantConfirmationEmail({ applicantEmail, applicantName, applicationReference })
        : Promise.resolve()
    ]).then((results) => {
      results.forEach((r) => {
        if (r.status === 'rejected') console.error('Notification email failed:', r.reason);
      });
    });

    return res.status(200).json({ applicationReference, applicationId });
  } catch (err) {
    console.error('submit-application error:', err);
    return res.status(500).json({
      error: 'Something went wrong while submitting your application. Please try again.'
    });
  }
};

function buildApplicantRow(applicationId, role, personData) {
  const p = personData || {};
  const {
    pep, pepRole, pepRelated, pepRelation,
    indemnityAccepted,
    riskDisclosureAccepted, riskDisclosureAcceptedAt,
    ...personalInfo
  } = p;
  return {
    application_id: applicationId,
    applicant_role: role,
    personal_info: personalInfo,
    pep_info: { pep, pepRole, pepRelated, pepRelation },
    indemnity_accepted: !!indemnityAccepted,
    indemnity_accepted_at: indemnityAccepted ? new Date().toISOString() : null,
    risk_disclosure_accepted: !!riskDisclosureAccepted,
    risk_disclosure_accepted_at: riskDisclosureAccepted ? (riskDisclosureAcceptedAt || new Date().toISOString()) : null
  };
}

function resolveApplicantIdentity(accountType, data) {
  if (accountType === 'corporate') {
    const company = data.company || {};
    const sig1 = data.signatory1 || {};
    return {
      applicantName: company.companyName || null,
      applicantEmail: company.email || sig1.email || null
    };
  }
  const primary = data.primary || {};
  const name = [primary.title, primary.surname, primary.otherNames].filter(Boolean).join(' ');
  return {
    applicantName: name || null,
    applicantEmail: primary.email || null
  };
}

async function generateUniqueReference() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `BGL-${datePart}-${suffix}`;

    const { data, error } = await supabase
      .from('account_opening_applications')
      .select('id')
      .eq('application_reference', candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }
  return `BGL-${datePart}-${Date.now().toString().slice(-6)}`;
}
