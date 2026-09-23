const { supabase } = require('../lib/supabaseClient');
const {
  sendInternalNewSubmissionAlert,
  sendApplicantConfirmationEmail
} = require('../lib/brevo');

// Documents are uploaded DIRECTLY from the browser to Supabase Storage
// beforehand (see upload-url.js), so this function only ever
// receives small JSON — accountType, form data, and a list of
// {person, docKey, path, fileName, fileType, fileSize} for documents
// that are already sitting in storage.

// Guards checkExistingCustomer below. % and _ are excluded explicitly
// because they are ilike wildcards, not because they are invalid in an
// email address.
const EMAIL_PATTERN = /^[^\s@%_]+@[^\s@%_]+\.[^\s@%_]+$/;

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

  // Lightweight duplicate-email check, dispatched from this same
  // endpoint rather than a new one — Vercel Hobby's serverless
  // function cap has already broken this project's deployment twice
  // this session at just 10-11 functions. {checkEmail: '...'} with no
  // accountType is treated as "just check this", not a submission.
  if (body.checkEmail && !body.accountType) {
    return checkExistingCustomer(res, body.checkEmail);
  }

  // Prefill lookup for the "update and resubmit" flow — an applicant
  // who clicked the resume link admin emailed them (see
  // sendApplicantNeedsUpdateEmail in brevo.js) after being asked for
  // needs_update. {resumeLookup: true} with no accountType is treated
  // as "fetch my existing answers to prefill the wizard", not a
  // submission. Kept on this same endpoint for the same Vercel
  // function-cap reason as checkExistingCustomer above.
  if (body.resumeLookup) {
    return handleResumeLookup(res, body);
  }

  const { accountType, data, documents } = body;

  if (!['individual', 'joint', 'corporate', 'minor'].includes(accountType)) {
    return res.status(400).json({ error: 'A valid accountType is required.' });
  }

  const docs = Array.isArray(documents) ? documents : [];

  try {
    // A resubmission carries {resume: {reference, token}} pointing at
    // the SAME application row created when it was first submitted —
    // re-validated here independently of handleResumeLookup(), since
    // that's just what populated the form the applicant is now
    // posting back. Never trust the client's own applicationId/
    // accountType for this: both are re-derived from the row the
    // token actually unlocks.
    const resumeTarget = body.resume && body.resume.reference && body.resume.token
      ? await resolveResumeTarget(body.resume.reference, body.resume.token)
      : null;
    if (body.resume && !resumeTarget) {
      return res.status(410).json({ error: 'This update link is invalid or has already been used. Please contact clientservices@bglafrica.com.' });
    }

    const isResubmission = !!resumeTarget;
    const applicationId = isResubmission ? resumeTarget.id : null;
    const applicationReference = isResubmission ? resumeTarget.application_reference : await generateUniqueReference();
    const { applicantName, applicantEmail } = resolveApplicantIdentity(accountType, data || {});

    // existing_customer_id is recomputed server-side from the
    // applicant's own resolved email, never trusted from the client --
    // a SYSTEM-DETECTED match against BGL's imported customer list,
    // independent of what the applicant declared below. application_type
    // is the applicant's own explicit, required declaration (asked
    // upfront on the wizard's first step, regardless of whether their
    // email happens to match anything on file) -- together these catch
    // both "the system recognizes this email" and "the applicant knows
    // they're reactivating even from a new email", so admin can
    // reactivate the existing account instead of unknowingly opening a
    // duplicate one.
    const existingCustomerId = await findExistingCustomerId(applicantEmail);
    const applicationType = data?.account?.applicationType === 'reactivation' ? 'reactivation' : 'new';

    const applicationFields = {
      account_type: accountType,
      status: 'submitted',
      referred_by: data?.account?.referredBy || null,
      banking_details: data?.banking || {},
      next_of_kin_info: data?.nextOfKin || {},
      applicant_name: applicantName,
      applicant_email: applicantEmail,
      existing_customer_id: existingCustomerId,
      application_type: applicationType
    };

    let appRow;
    if (isResubmission) {
      // Clears the needs_update fields and one-time token as part of
      // the same update that puts it back in front of Client Service —
      // a used link must never work twice.
      const { data: updated, error: updateErr } = await supabase
        .from('account_opening_applications')
        .update({
          ...applicationFields,
          needs_update_note: null,
          needs_update_at: null,
          needs_update_by: null,
          resume_token: null,
          resume_token_created_at: null
        })
        .eq('id', applicationId)
        .select()
        .single();
      if (updateErr) throw updateErr;
      appRow = updated;

      // Full replace rather than a diff/merge — the wizard always
      // sends its complete current state (existing answers the
      // applicant didn't touch, plus whatever they changed), so the
      // old rows for this application are simply superseded, same as
      // how a fresh submission has never needed to merge with anything.
      const { error: delApplicantsErr } = await supabase.from('applicants').delete().eq('application_id', applicationId);
      if (delApplicantsErr) throw delApplicantsErr;
      const { error: delDocsErr } = await supabase.from('application_documents').delete().eq('application_id', applicationId);
      if (delDocsErr) throw delDocsErr;
      if (accountType === 'corporate') {
        const { error: delCorpErr } = await supabase.from('corporate_profiles').delete().eq('application_id', applicationId);
        if (delCorpErr) throw delCorpErr;
      }
    } else {
      const { data: inserted, error: appErr } = await supabase
        .from('account_opening_applications')
        .insert({ application_reference: applicationReference, ...applicationFields })
        .select()
        .single();
      if (appErr) throw appErr;
      appRow = inserted;
    }

    const realApplicationId = appRow.id;
    const tasks = [];

    const applicantRows = [];
    if (accountType === 'individual' || accountType === 'joint') {
      applicantRows.push(buildApplicantRow(realApplicationId, 'primary', data?.primary));
    }
    if (accountType === 'joint') {
      applicantRows.push(buildApplicantRow(realApplicationId, 'joint_partner', data?.jointPartner));
    }
    if (accountType === 'corporate') {
      applicantRows.push(buildApplicantRow(realApplicationId, 'signatory_1', data?.signatory1));
      // Signatory 2 is optional — some corporate accounts only need
      // one authorised signatory. Only create a database record for
      // them if the applicant actually said "Yes" to having one,
      // rather than inserting an empty phantom row every time.
      if (data?.signatory2 && data.signatory2.hasSecondSignatory === 'Yes') {
        applicantRows.push(buildApplicantRow(realApplicationId, 'signatory_2', data.signatory2));
      }
    }
    if (accountType === 'minor') {
      // The minor's own row has no PEP/indemnity/risk-disclosure
      // acceptance — buildApplicantRow() still works fine for them,
      // since those fields are just absent from data.minor and end
      // up correctly false/empty rather than needing special-casing.
      // The guardian's row is where the real indemnity/risk-
      // disclosure acceptance lives (they're the one signing), plus
      // their employment/financial fields folded into personal_info.
      applicantRows.push(buildApplicantRow(realApplicationId, 'minor', data?.minor));
      applicantRows.push(buildApplicantRow(realApplicationId, 'guardian', data?.guardian));
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
          application_id: realApplicationId,
          company_info: data?.company || {}
        }).then(({ error }) => {
          if (error) throw error;
        })
      );
    }

    if (docs.length) {
      const documentRows = docs.map((d) => ({
        application_id: realApplicationId,
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
        application_id: realApplicationId,
        status: 'submitted',
        changed_by: 'system',
        reason: isResubmission ? 'Resubmitted by applicant after an update was requested.' : null
      }).then(({ error }) => {
        if (error) console.error('application_status_history insert failed:', error);
      })
    );

    await Promise.all(tasks);

    await Promise.allSettled([
      sendInternalNewSubmissionAlert({
        applicationReference,
        accountType,
        applicantName,
        applicantEmail,
        applicationId: realApplicationId,
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

    return res.status(200).json({ applicationReference, applicationId: realApplicationId });
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

// Reverses buildApplicantRow() above, for handleResumeLookup() —
// reconstructs the wizard's per-person state shape from a stored
// applicants row exactly the way it was originally collected.
function applicantRowToState(row) {
  if (!row) return {};
  const info = row.personal_info || {};
  const pep = row.pep_info || {};
  return {
    ...info,
    pep: pep.pep,
    pepRole: pep.pepRole,
    pepRelated: pep.pepRelated,
    pepRelation: pep.pepRelation,
    indemnityAccepted: !!row.indemnity_accepted,
    riskDisclosureAccepted: !!row.risk_disclosure_accepted,
    riskDisclosureAcceptedAt: row.risk_disclosure_accepted_at || undefined
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
  if (accountType === 'minor') {
    const minor = data.minor || {};
    const guardian = data.guardian || {};
    const name = [minor.title, minor.surname, minor.otherNames].filter(Boolean).join(' ');
    return {
      applicantName: name || null,
      // The minor has no email of their own — the guardian is who we
      // actually communicate with (confirmation, status updates).
      applicantEmail: guardian.email || null
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

// Looks up an application by reference and validates the resume token
// against it — used both to serve the prefill data (handleResumeLookup)
// and, independently, to authorize an actual resubmission. A token only
// ever matches while the application is still sitting at needs_update;
// once resubmitted the token is cleared, so a stale/reused link fails
// this the same way a wrong one would.
async function resolveResumeTarget(reference, token) {
  if (!reference || !token) return null;
  const { data, error } = await supabase
    .from('account_opening_applications')
    .select('*')
    .eq('application_reference', reference)
    .eq('status', 'needs_update')
    .maybeSingle();
  if (error) {
    console.error('resolveResumeTarget lookup failed:', error);
    return null;
  }
  if (!data || !data.resume_token || data.resume_token !== token) return null;
  return data;
}

async function handleResumeLookup(res, body) {
  const reference = (body.reference || '').trim();
  const token = (body.token || '').trim();

  try {
    const appRow = await resolveResumeTarget(reference, token);
    if (!appRow) {
      return res.status(410).json({ error: 'This update link is invalid or has already been used. Please contact clientservices@bglafrica.com.' });
    }

    const [{ data: applicants }, { data: corp }, { data: docs }] = await Promise.all([
      supabase.from('applicants').select('*').eq('application_id', appRow.id),
      supabase.from('corporate_profiles').select('*').eq('application_id', appRow.id).maybeSingle(),
      supabase.from('application_documents').select('*').eq('application_id', appRow.id)
    ]);

    const byRole = {};
    (applicants || []).forEach((a) => { byRole[a.applicant_role] = a; });

    const state = {
      primary: applicantRowToState(byRole.primary),
      jointPartner: applicantRowToState(byRole.joint_partner),
      signatory1: applicantRowToState(byRole.signatory_1),
      signatory2: byRole.signatory_2
        ? applicantRowToState(byRole.signatory_2)
        : { hasSecondSignatory: 'No' },
      minor: applicantRowToState(byRole.minor),
      guardian: applicantRowToState(byRole.guardian),
      company: (corp && corp.company_info) || {},
      banking: appRow.banking_details || {},
      nextOfKin: appRow.next_of_kin_info || {},
      account: { referredBy: appRow.referred_by || '' },
      files: {}
    };
    (docs || []).forEach((d) => {
      if (!state.files[d.applicant_role]) state.files[d.applicant_role] = {};
      state.files[d.applicant_role][d.document_type] = {
        path: d.storage_path,
        fileName: d.file_name,
        fileType: d.file_type,
        fileSize: d.file_size
      };
    });

    return res.status(200).json({
      applicationId: appRow.id,
      applicationReference: appRow.application_reference,
      accountType: appRow.account_type,
      needsUpdateNote: appRow.needs_update_note || '',
      state
    });
  } catch (err) {
    console.error('handleResumeLookup error:', err);
    return res.status(500).json({ error: 'Something went wrong loading your application. Please try again.' });
  }
}

// Used at actual submission time to link an application to BGL's
// imported customer list (see checkExistingCustomer below for the
// live-typing version of this same lookup, used only for the
// wizard's non-blocking "you may already have an account" prompt).
// Deliberately email-only for now, same limitation as that check —
// a dormant customer using a different email than what's on file
// won't be caught. Fails open (returns null) rather than blocking a
// real submission over a lookup hiccup.
async function findExistingCustomerId(email) {
  const trimmed = (email || '').trim();
  if (!trimmed || trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) return null;
  try {
    const { data, error } = await supabase
      .from('existing_bgl_customers')
      .select('id')
      .ilike('email', trimmed)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? data.id : null;
  } catch (err) {
    console.error('findExistingCustomerId failed:', err);
    return null;
  }
}

async function checkExistingCustomer(res, email) {
  const trimmed = (email || '').trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'Please provide an email to check.' });
  }

  // ilike() treats its argument as a PATTERN, not a literal string.
  // Unguarded, { checkEmail: "%john%" } asks "does ANY customer have
  // john anywhere in their address" rather than "is this address a
  // customer" — turning an unauthenticated endpoint into a yes/no
  // oracle for whether a given person banks with BGL. Rejecting the
  // wildcard characters before the query is what closes that.
  //
  // Deliberately NOT switched to .eq() — stored emails may be mixed
  // case, and eq is case-sensitive, so that swap would start reporting
  // genuine existing customers as new.
  if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  try {
    // Two sources of "already has a BGL account": the imported list
    // of customers opened outside this system, and anyone who's
    // already completed the wizard here (status = 'opened' — a
    // pending/in-review application doesn't count as "having an
    // account" yet, so this deliberately doesn't match those).
    const [{ data: existingCustomer }, { data: openedApplication }] = await Promise.all([
      supabase.from('existing_bgl_customers').select('id').ilike('email', trimmed).limit(1).maybeSingle(),
      supabase.from('account_opening_applications').select('id').ilike('applicant_email', trimmed).eq('status', 'opened').limit(1).maybeSingle()
    ]);

    return res.status(200).json({ exists: !!(existingCustomer || openedApplication) });
  } catch (err) {
    console.error('check-existing-customer error:', err);
    // Fail open — if this lookup itself breaks, don't block a
    // legitimate new applicant from submitting because of it. Worst
    // case a genuine duplicate slips through and gets caught by
    // admin during review instead of at the form.
    return res.status(200).json({ exists: false });
  }
}
