-- ============================================================
-- Account opening — add 'account_opening_in_progress' stage
-- ============================================================
-- Splits what used to be a single "compliance approves -> opened"
-- step into two: compliance approval now moves an application to
-- account_opening_in_progress (a holding status meaning "cleared,
-- account opening is underway"), and a separate action collects the
-- CHN + CSCS Account Number and marks it opened. This gives a clear
-- point in the pipeline for "compliance is done, ops is now doing
-- the actual account-opening work" rather than conflating final
-- compliance sign-off with the mechanical step of typing in a CHN.
--
-- Run this once against the same Supabase project as the rest of
-- the site, after migration_two_stage_review.sql. Safe to re-run.

alter table account_opening_applications
  drop constraint if exists account_opening_applications_status_check;

alter table account_opening_applications
  add constraint account_opening_applications_status_check
  check (status in (
    'submitted',
    'under_review',              -- legacy, pre-migration only
    'under_review_client_service',
    'under_review_compliance',
    'account_opening_in_progress',
    'opened',
    'rejected'
  ));
