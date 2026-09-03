const { supabase } = require('./utils/supabaseClient');
const {
  sendInternalNewSubmissionAlert,
  sendApplicantConfirmationEmail
} = require('./utils/brevo');

// Documents are uploaded DIRECTLY from the browser to Supabase Storage
// beforehand (see create-upload-url.js), so this function only ever
// receives small JSON — accountType, form data, and a list of
// {person, docKey, path, fileName, fileType, fileSize} for documents
// that are already sitting in storage. There's no multipart parsing
// and no file bytes passing through this function at all, which is
// also why it's fast and comfortably inside Netlify's function limits.

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

  const { accountType, data, documents } = body;

  if (!['individual', 'joint', 'corporate'].includes(accountType)) {
    return jsonResponse(400, { error: 'A valid accountType is required.' });
  }

  const docs = Array.isArray(documents) ? documents : [];

  try {
    const applicationReference = await generateUniqueReference();
    const { applicantName, applicantEmail } = resolveApplicantIdentity(accountType, data || {});

    // 1. Create the application record
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

    // 2-5. Everything below only depends on applicationId, not on each
    // other, so it all runs concurrently rather than as sequential
    // round trips.
    const tasks = [];

    // 2. Per-person applicant rows
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

    // 3. Corporate profile
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

    // 4. Document records — files are already uploaded to storage by
    // this point (via create-upload-url.js + the browser's direct
    // upload), so this is just recording where each one landed.
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

    // 5. Status history — initial "submitted" entry
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
    if (!data) return candidate; // no collision
  }
  return `BGL-${datePart}-${Date.now().toString().slice(-6)}`;
}
