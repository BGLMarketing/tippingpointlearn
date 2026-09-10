-- ============================================================
-- Existing BGL customers (opened off this system)
-- ============================================================
-- Holds the customer list BGL already has on file from accounts
-- opened outside this platform — imported for one purpose:
-- catching a duplicate when someone tries to open a new account
-- through /open-account using an email that already has a BGL
-- account, whether opened here or elsewhere. This is reference
-- data, not "applications" — these people never went through the
-- wizard, so this intentionally doesn't reuse
-- account_opening_applications' shape (which implies a submission,
-- documents, a review pipeline, none of which apply here).
--
-- Run this once against the same Supabase project as the rest of
-- the site, after schema.sql. Safe to re-run — the table itself
-- (`create table if not exists`) and the RLS policies below are
-- idempotent; the actual customer data is inserted separately by
-- import_existing_customers.sql, which you may need to clear and
-- re-run if you ever re-import an updated list (see that file's
-- own notes).

create table if not exists existing_bgl_customers (
  id               uuid primary key default gen_random_uuid(),
  cust_id          integer,
  name             text,
  address          text,
  email            text,
  phone            text,
  chn              text,
  cscs             text,
  nationality      text,
  client_type      text,
  dob              date,
  contact_date     date,
  contact_person   text,
  account_officer  text,
  imported_at      timestamptz not null default now()
);

-- The only real access pattern is "does this email already exist" —
-- case-insensitive, since applicants will type it in any casing.
create index if not exists idx_existing_customers_email
  on existing_bgl_customers (lower(email));

alter table existing_bgl_customers enable row level security;

-- No public policy — the duplicate-email check goes through
-- submit-application.js using the service role key (bypasses RLS),
-- same reasoning as referral_otp_codes: this table should never be
-- directly queryable via the anon key, even though what it's
-- protecting (a customer list) is less sensitive than an OTP, simply
-- because there's no legitimate reason for the browser to read it
-- directly.
drop policy if exists "Authenticated can read existing customers" on existing_bgl_customers;
create policy "Authenticated can read existing customers"
  on existing_bgl_customers for select
  to authenticated
  using (true);
