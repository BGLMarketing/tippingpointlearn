-- ============================================================
-- Application type (new / reactivation) + existing-customer match
-- ============================================================
-- Some applicants filling out /open-account already have a BGL
-- account on file (in particular, dormant customers are expected to
-- go through this exact form to reactivate) -- previously this
-- either hard-blocked submission entirely (the email-match check in
-- submit-application.js just told them to "contact clientservices"),
-- or, if their email didn't match what's on file, let the submission
-- through with zero indication to admin that this wasn't a brand
-- new customer, risking a duplicate account being opened instead of
-- the existing one being reactivated.
--
-- Two independent signals fix this:
--
-- 1. application_type is the applicant's own explicit declaration --
--    a required "New account / Reactivating an existing account"
--    question asked upfront, on the very first step, regardless of
--    whether their email happens to match anything on file (someone
--    using a new email still knows they're reactivating).
--
-- 2. existing_customer_id is a SYSTEM-DETECTED match against
--    existing_bgl_customers, set automatically server-side from the
--    applicant's resolved email at submission time (never trusted
--    from the client) -- a secondary signal for admin regardless of
--    what application_type says, e.g. to catch someone who picked
--    "New" by mistake, or to pull up the existing CHN/CSCS to reuse.
--
-- Run this once against the same Supabase project as the rest of
-- the site, after schema.sql and migration_existing_customers.sql.
-- Safe to re-run.

alter table account_opening_applications
  add column if not exists application_type text not null default 'new',
  add column if not exists existing_customer_id uuid references existing_bgl_customers(id);

alter table account_opening_applications
  drop constraint if exists account_opening_applications_application_type_check;

alter table account_opening_applications
  add constraint account_opening_applications_application_type_check
  check (application_type in ('new', 'reactivation'));

create index if not exists idx_applications_existing_customer
  on account_opening_applications(existing_customer_id);
