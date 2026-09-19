// One-off audit script — NOT a Netlify/Vercel function (lives outside
// netlify/functions and api/ on purpose so it isn't picked up as one).
//
// Finds applications hit by the payload bug fixed in
// open-account/index.html (submitApplication() never sent
// state.minor/guardian/nextOfKin to the server), so the admin team
// knows exactly which past submissions need manual follow-up: either
// hand-transcribing the applicant/guardian name from the uploaded
// documents already attached to the application, or asking the
// applicant to resubmit.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-empty-minor-applications.js
//
// Uses the service role key (same as the backend functions) since this
// needs to read across all applications, not just what a logged-in
// admin's RLS policy would allow.

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function isEmptyPersonalInfo(info) {
  if (!info || typeof info !== 'object') return true;
  // A row is "empty" if every value on it is blank — a real submission
  // always has at least a surname/name, dob, etc.
  return Object.values(info).every((v) => v === '' || v === null || v === undefined || v === false);
}

async function main() {
  const { data: minorApps, error: minorErr } = await supabase
    .from('account_opening_applications')
    .select('id, application_reference, status, submitted_at, applicant_name, applicant_email, next_of_kin_info')
    .eq('account_type', 'minor')
    .order('submitted_at', { ascending: true });
  if (minorErr) throw minorErr;

  const affectedMinor = [];
  for (const app of minorApps || []) {
    const { data: applicants, error: applicantsErr } = await supabase
      .from('applicants')
      .select('applicant_role, personal_info')
      .eq('application_id', app.id)
      .in('applicant_role', ['minor', 'guardian']);
    if (applicantsErr) throw applicantsErr;

    const minorRow = (applicants || []).find((a) => a.applicant_role === 'minor');
    const guardianRow = (applicants || []).find((a) => a.applicant_role === 'guardian');
    const minorEmpty = isEmptyPersonalInfo(minorRow?.personal_info);
    const guardianEmpty = isEmptyPersonalInfo(guardianRow?.personal_info);

    if (minorEmpty || guardianEmpty || !app.applicant_name) {
      affectedMinor.push({
        reference: app.application_reference,
        id: app.id,
        status: app.status,
        submitted_at: app.submitted_at,
        applicant_name: app.applicant_name || '(blank)',
        applicant_email: app.applicant_email || '(blank)',
        minor_row_empty: minorEmpty,
        guardian_row_empty: guardianEmpty
      });
    }
  }

  console.log(`\n=== Minor accounts with blank applicant data (${affectedMinor.length} of ${minorApps.length}) ===`);
  console.table(affectedMinor);

  // Same root cause, broader blast radius: next_of_kin_info was never
  // sent for ANY account type until this fix, so it's worth flagging
  // too even though it wasn't what was reported.
  const { data: allApps, error: allErr } = await supabase
    .from('account_opening_applications')
    .select('id, application_reference, account_type, status, submitted_at, next_of_kin_info')
    .order('submitted_at', { ascending: true });
  if (allErr) throw allErr;

  const missingNextOfKin = (allApps || [])
    .filter((a) => !a.next_of_kin_info || Object.keys(a.next_of_kin_info).length === 0)
    .map((a) => ({
      reference: a.application_reference,
      id: a.id,
      account_type: a.account_type,
      status: a.status,
      submitted_at: a.submitted_at
    }));

  console.log(`\n=== All applications missing next-of-kin data (${missingNextOfKin.length} of ${allApps.length}) ===`);
  console.table(missingNextOfKin);
}

main().catch((err) => {
  console.error('Audit script failed:', err);
  process.exit(1);
});
