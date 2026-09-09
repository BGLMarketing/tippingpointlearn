-- ============================================================
-- Account opening — two-stage review pipeline
-- ============================================================
-- Replaces the single 'under_review' status with two sequential
-- stages: under_review_client_service, then under_review_compliance.
-- Admin approves at each stage before an application can progress;
-- rejecting at any point is terminal (the applicant would need to
-- submit a fresh application — there's no resubmit/edit flow).
--
-- Run this once against the same Supabase project as the rest of
-- the site, after schema.sql. Safe to re-run.
--
-- 'under_review' (the old single status) is kept in the allowed set
-- rather than removed, so any existing row already sitting in that
-- status doesn't violate the constraint — it's legacy-only, nothing
-- new will be written with that value. If you have applications
-- currently at 'under_review', manually move them to
-- 'under_review_client_service' or 'under_review_compliance' from
-- /admin (whichever stage they're actually at) once this is applied.

alter table account_opening_applications
  drop constraint if exists account_opening_applications_status_check;

alter table account_opening_applications
  add constraint account_opening_applications_status_check
  check (status in (
    'submitted',
    'under_review',              -- legacy, pre-migration only
    'under_review_client_service',
    'under_review_compliance',
    'opened',
    'rejected'
  ));
