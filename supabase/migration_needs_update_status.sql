-- ============================================================
-- 'needs_update' status + resubmission support
-- ============================================================
-- Lets admin ask an applicant to fix something specific without
-- rejecting the whole application outright. Setting an application to
-- needs_update (from any review stage) generates a one-time resume
-- token and emails the applicant a link back into the SAME wizard,
-- pre-filled with their existing answers, with admin's note shown at
-- the top. Resubmitting updates the existing application row in
-- place (same id and reference) and returns it to 'submitted' --
-- there is no second, duplicate application created.
--
-- Run this once against the same Supabase project as the rest of
-- the site, after schema.sql and migration_admin_roles.sql. Safe to
-- re-run.

alter table account_opening_applications
  drop constraint if exists account_opening_applications_status_check;

alter table account_opening_applications
  add constraint account_opening_applications_status_check
  check (status in (
    'submitted',
    'under_review',              -- legacy, pre-two-stage-pipeline only
    'under_review_client_service',
    'under_review_compliance',
    'account_opening_in_progress',
    'needs_update',
    'opened',
    'rejected'
  ));

alter table account_opening_applications
  add column if not exists needs_update_note text,
  add column if not exists needs_update_at timestamptz,
  add column if not exists needs_update_by text,
  -- Unique so a token can never accidentally match more than one
  -- application. Cleared back to null the moment it's consumed by a
  -- resubmission (or superseded by a later needs_update request), so
  -- a stale or reused link simply matches nothing.
  add column if not exists resume_token text unique,
  add column if not exists resume_token_created_at timestamptz,
  -- Counts every time this application has EVER been sent to
  -- needs_update, across its whole life -- never reset on
  -- resubmission (that would make the cap meaningless). Enforced in
  -- update-status.js: once this reaches 2, "Request update" is no
  -- longer offered for this application -- only Approve or Reject.
  add column if not exists needs_update_count integer not null default 0;
