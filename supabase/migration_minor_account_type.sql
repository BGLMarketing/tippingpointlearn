-- ============================================================
-- Minor account type
-- ============================================================
-- Adds 'minor' as a valid account_type, and 'minor' + 'guardian' as
-- valid applicant_role values on the applicants table. Also adds a
-- next_of_kin_info column, since a minor account's guardian must
-- name a next of kin (Section D of BGL's Minors KYC form) — a
-- concept that doesn't exist on individual/joint/corporate
-- applications, so it doesn't belong as another applicants row (a
-- next of kin doesn't sign anything or appear in the review
-- pipeline the way an applicant does).
--
-- The minor's own applicants row holds just their personal details
-- (no PEP, no indemnity/risk-disclosure acceptance — the Minors KYC
-- form doesn't ask a minor to declare either, only the guardian).
-- The guardian's applicants row holds their personal details AND
-- employment/financial position (Section C of the form) folded into
-- the same personal_info JSONB, plus the real indemnity/risk-
-- disclosure acceptance, since the guardian is the one signing.
--
-- Run this once against the same Supabase project as the rest of
-- the site, after schema.sql. Safe to re-run.

alter table account_opening_applications
  drop constraint if exists account_opening_applications_account_type_check;

alter table account_opening_applications
  add constraint account_opening_applications_account_type_check
  check (account_type in ('individual', 'joint', 'corporate', 'minor'));

alter table applicants
  drop constraint if exists applicants_applicant_role_check;

alter table applicants
  add constraint applicants_applicant_role_check
  check (applicant_role in ('primary', 'joint_partner', 'signatory_1', 'signatory_2', 'minor', 'guardian'));

alter table account_opening_applications
  add column if not exists next_of_kin_info jsonb not null default '{}'::jsonb;
