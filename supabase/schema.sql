-- ============================================================
-- Tipping Point x BGL Securities — Account Opening
-- Supabase schema
-- ============================================================
-- Run this in the Supabase SQL editor once per project.
-- Requires the pgcrypto extension for gen_random_uuid().

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- account_opening_applications
-- One row per submitted application, individual/joint/corporate.
-- ------------------------------------------------------------
create table if not exists account_opening_applications (
  id                    uuid primary key default gen_random_uuid(),
  application_reference text unique not null,
  account_type          text not null check (account_type in ('individual','joint','corporate')),
  status                text not null default 'submitted'
                          check (status in ('submitted','under_review','opened','rejected')),

  -- convenience fields for admin list views + applicant status lookup
  applicant_name        text,
  applicant_email       text,
  referred_by           text,

  -- account-level banking / CSCS direct settlement info (see CSCS Form 001)
  banking_details       jsonb not null default '{}'::jsonb,

  submitted_at          timestamptz not null default now(),

  review_started_at     timestamptz,
  reviewed_by           text,

  opened_at             timestamptz,
  opened_by             text,
  csc_account_number    text,
  chn                   text,
  admin_note            text,

  rejected_at           timestamptz,
  rejected_by           text,
  rejection_reason      text,

  created_at            timestamptz not null default now()
);

create index if not exists idx_applications_status on account_opening_applications(status);
create index if not exists idx_applications_reference on account_opening_applications(application_reference);
create index if not exists idx_applications_email on account_opening_applications(applicant_email);

-- ------------------------------------------------------------
-- applicants
-- One row per natural person on the application: the individual
-- applicant, a joint partner, or a corporate authorised signatory.
-- ------------------------------------------------------------
create table if not exists applicants (
  id                     uuid primary key default gen_random_uuid(),
  application_id         uuid not null references account_opening_applications(id) on delete cascade,
  applicant_role         text not null check (applicant_role in ('primary','joint_partner','signatory_1','signatory_2')),

  personal_info          jsonb not null default '{}'::jsonb,  -- name, dob, address, bvn, nin, etc.
  pep_info               jsonb not null default '{}'::jsonb,  -- PEP declaration answers

  indemnity_accepted     boolean not null default false,
  indemnity_accepted_at  timestamptz,

  risk_disclosure_accepted    boolean not null default false,
  risk_disclosure_accepted_at timestamptz,  -- captured client-side, at the moment the box was checked

  created_at             timestamptz not null default now()
);

create index if not exists idx_applicants_application on applicants(application_id);

-- ------------------------------------------------------------
-- corporate_profiles
-- One row per corporate application, holding company-level info.
-- ------------------------------------------------------------
create table if not exists corporate_profiles (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null unique references account_opening_applications(id) on delete cascade,
  company_info    jsonb not null default '{}'::jsonb,  -- registered name, RC number, TIN, address, etc.
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- application_documents
-- One row per uploaded file, tied to whichever person/entity it
-- belongs to on the application.
-- ------------------------------------------------------------
create table if not exists application_documents (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references account_opening_applications(id) on delete cascade,
  applicant_role  text not null,   -- 'primary' | 'joint_partner' | 'signatory_1' | 'signatory_2' | 'company'
  document_type   text not null,   -- 'validId' | 'utilityBill' | 'passportPhoto' | 'signature' | 'cacCert' | 'moa' | 'tinDoc' | 'boardResolution' | 'companySeal' | 'other'
  file_name       text not null,
  storage_path    text not null,   -- path within the 'application-documents' storage bucket
  file_type       text,            -- mime type
  file_size       int,
  uploaded_at     timestamptz not null default now()
);

create index if not exists idx_documents_application on application_documents(application_id);

-- ------------------------------------------------------------
-- application_status_history
-- Audit trail of every status change.
-- ------------------------------------------------------------
create table if not exists application_status_history (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references account_opening_applications(id) on delete cascade,
  status          text not null,
  changed_by      text not null,   -- 'system' or an admin identifier/email
  changed_at      timestamptz not null default now(),
  reason          text             -- required for 'rejected', optional otherwise
);

create index if not exists idx_status_history_application on application_status_history(application_id);

-- ------------------------------------------------------------
-- Row Level Security
-- All writes/reads for this feature go through Netlify Functions
-- using the Supabase service role key, which bypasses RLS. RLS is
-- enabled here defensively so no anon/public key can read or write
-- these tables directly. If a browser-facing admin dashboard is
-- built later that talks to Supabase directly (rather than through
-- a function), add explicit policies scoped to authenticated admin
-- users at that point.
-- ------------------------------------------------------------
alter table account_opening_applications enable row level security;
alter table applicants enable row level security;
alter table corporate_profiles enable row level security;
alter table application_documents enable row level security;
alter table application_status_history enable row level security;

-- No policies are created, which means: no access at all via the
-- anon/public API key. Service-role access (used by the Netlify
-- Functions) always bypasses RLS regardless of policies.

-- ------------------------------------------------------------
-- Storage bucket
-- Create this via the Supabase dashboard (Storage tab) or the
-- Management API — bucket creation isn't part of this SQL file:
--   Name: application-documents
--   Public: OFF (private — documents are sensitive KYC files)
-- The Netlify Function uploads to and reads from this bucket using
-- the service role key, and the admin dashboard should request
-- short-lived signed URLs to view/download a document rather than
-- making the bucket public.
-- ------------------------------------------------------------
