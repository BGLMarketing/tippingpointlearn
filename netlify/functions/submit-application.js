const { supabase } = require('./utils/supabaseClient');
const { parseMultipart } = require('./utils/multipart');
const {
  sendInternalNewSubmissionAlert,
  sendApplicantConfirmationEmail
} = require('./utils/brevo');

const STORAGE_BUCKET = 'application-documents';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let fields, files;
  try {
    ({ fields, files } = await parseMultipart(event));
  } catch (err) {
    console.error('Multipart parse error:', err);
    return jsonResponse(400, { error: 'Could not read the submitted form data.' });
  }

  const accountType = fields.accountType;
  if (!['individual', 'joint', 'corporate'].includes(accountType)) {
    return jsonResponse(400, { error: 'A valid accountType is required.' });
  }

  let data;
  try {
    data = JSON.parse(fields.data || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed application data.' });
  }

  try {
    const applicationReference = await generateUniqueReference();
    const { applicantName, applicantEmail } = resolveApplicantIdentity(accountType, data);

    // 1. Create the application record
    const { data: appRow, error: appErr } = await supabase
      .from('account_opening_applications')
      .insert({
        application_reference: applicationReference,
        account_type: accountType,
        status: 'submitted',
        referred_by: data.account?.referredBy || null,
        banking_details: data.banking || {},
        applicant_name: applicantName,
        applicant_email: applicantEmail
      })
      .select()
      .single();
    if (appErr) throw appErr;

    const applicationId = appRow.id;

    // 2. Insert per-person applicant rows
    const applicantRows = [];
    if (accountType === 'individual' || accountType === 'joint') {
      applicantRows.push(buildApplicantRow(applicationId, 'primary', data.primary));
    }
    if (accountType === 'joint') {
      applicantRows.push(buildApplicantRow(applicationId, 'joint_partner', data.jointPartner));
    }
    if (accountType === 'corporate') {
      applicantRows.push(buildApplicantRow(applicationId, 'signatory_1', data.signatory1));
      applicantRows.push(buildApplicantRow(applicationId, 'signatory_2', data.signatory2));
    }
    if (applicantRows.length) {
      const { error: applErr } = await supabase.from('applicants').insert(applicantRows);
      if (applErr) throw applErr;
    }

    // 3. Corporate profile
    if (accountType === 'corporate') {
      const { error: corpErr } = await supabase.from('corporate_profiles').insert({
        application_id: applicationId,
        company_info: data.company || {}
      });
      if (corpErr) throw corpErr;
    }

    // 4. Upload documents to storage + record them
    for (const file of files) {
      const storagePath = `${applicationId}/${file.person}_${file.docKey}_${Date.now()}_${sanitizeFilename(file.filename)}`;

      const { error: uploadErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, file.content, {
          contentType: file.mimeType,
          upsert: false
        });
      if (uploadErr) throw uploadErr;

      const { error: docErr } = await supabase.from('application_documents').insert({
        application_id: applicationId,
        applicant_role: file.person,
        document_type: file.docKey,
        file_name: file.filename,
        storage_path: storagePath,
        file_type: file.mimeType,
        file_size: file.content.length
      });
      if (docErr) throw docErr;
    }

    // 5. Status history — initial "submitted" entry
    await supabase.from('application_status_history').insert({
      application_id: applicationId,
      status: 'submitted',
      changed_by: 'system'
    });

    // 6. Notifications — internal alert + applicant confirmation.
    // Emails should not block a successful submission from returning,
    // so failures here are logged rather than thrown.
    await Promise.allSettled([
      sendInternalNewSubmissionAlert({
        applicationReference,
        accountType,
        applicantName,
        applicantEmail,
        applicationId,
        fileCount: files.length
      }),
      applicantEmail
        ? sendApplicantConfirmationEmail({ applicantEmail, applicantName, applicationReference })
        : Promise.resolve()
    ]).then((results) => {
      results.forEach((r) => {
        if (r.status === 'rejected') console.error('Notification email failed:', r.reason);
      });
    });

    return jsonResponse(200, { applicationReference, applicationId });
  } catch (err) {
    console.error('submit-application error:', err);
    return jsonResponse(500, {
      error: 'Something went wrong while submitting your application. Please try again.'
    });
  }
};

/* ============================================================
   Helpers
   ============================================================ */

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

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
    // Risk disclosure timestamp is trusted from the client, since it
    // records the exact moment the applicant checked the box — not
    // the (later) moment the whole application was submitted.
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

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
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
    if (!data) return candidate; // no collision
  }
  // Extremely unlikely fallback if 5 random attempts all collided
  return `BGL-${datePart}-${Date.now().toString().slice(-6)}`;
}
