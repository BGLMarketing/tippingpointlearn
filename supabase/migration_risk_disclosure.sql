-- ============================================================
-- Migration: add Risk Disclosure Statement consent tracking
-- to the applicants table.
--
-- Run this ONLY if you already executed the original
-- supabase/schema.sql against your database. If you haven't
-- deployed the schema yet, skip this file — the columns are
-- already included in the main schema.sql.
-- ============================================================

alter table applicants
  add column if not exists risk_disclosure_accepted boolean not null default false;

alter table applicants
  add column if not exists risk_disclosure_accepted_at timestamptz;

comment on column applicants.risk_disclosure_accepted is
  'Whether this applicant checked the Risk Disclosure Statement consent box.';

comment on column applicants.risk_disclosure_accepted_at is
  'Timestamp captured client-side, at the exact moment the applicant checked the box — not the later application submission time.';
