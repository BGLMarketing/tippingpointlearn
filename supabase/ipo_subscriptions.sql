-- ============================================================
-- Dangote Refinery IPO — subscriptions + notify-me signups
-- ============================================================

-- ------------------------------------------------------------
-- ipo_subscriptions
-- One row per submitted IPO subscription (Individual/Corporate/Joint).
-- ------------------------------------------------------------
create table if not exists ipo_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  subscription_reference  text unique not null,
  investor_type           text not null check (investor_type in ('individual','corporate','joint')),

  -- submitted -> payment_pending is the practical starting point;
  -- from there: payment_confirmed or payment_unconfirmed (applicant
  -- notified either way) -> pending_execution -> executed -> allotted.
  status                  text not null default 'payment_pending'
                            check (status in (
                              'payment_pending','payment_confirmed','payment_unconfirmed',
                              'pending_execution','executed','allotted'
                            )),

  applicant_name          text,
  applicant_email         text,
  applicant_phone         text,

  number_of_units         integer,
  amount_payable          numeric,

  investor_info           jsonb not null default '{}'::jsonb,  -- personal/corporate identity fields from the form
  corporate_info          jsonb not null default '{}'::jsonb,  -- RC number, contact person, 2nd BVN (corporate only)
  joint_applicant_info    jsonb not null default '{}'::jsonb,  -- joint applicant's details (joint only)
  cscs_info                jsonb not null default '{}'::jsonb,  -- CHN, CSCS number, stockbroker, member code
  banking_info            jsonb not null default '{}'::jsonb,  -- bank name, account number, branch, BVN(s)

  submitted_at            timestamptz not null default now(),
  status_changed_at       timestamptz,
  status_changed_by       text,
  admin_note              text,
  units_allotted          integer,

  created_at              timestamptz not null default now()
);

create index if not exists idx_ipo_subs_status on ipo_subscriptions(status);
create index if not exists idx_ipo_subs_reference on ipo_subscriptions(subscription_reference);
create index if not exists idx_ipo_subs_email on ipo_subscriptions(applicant_email);

-- ------------------------------------------------------------
-- ipo_subscription_documents
-- Signature, valid ID, and payment evidence uploads.
-- ------------------------------------------------------------
create table if not exists ipo_subscription_documents (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references ipo_subscriptions(id) on delete cascade,
  document_type   text not null,   -- 'signature' | 'validId' | 'paymentEvidence'
  file_name       text not null,
  storage_path    text not null,
  file_type       text,
  file_size       int,
  uploaded_at     timestamptz not null default now()
);

create index if not exists idx_ipo_docs_subscription on ipo_subscription_documents(subscription_id);

-- ------------------------------------------------------------
-- ipo_subscription_status_history
-- Audit trail of every status change.
-- ------------------------------------------------------------
create table if not exists ipo_subscription_status_history (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references ipo_subscriptions(id) on delete cascade,
  status          text not null,
  changed_by      text not null,
  changed_at      timestamptz not null default now(),
  note            text
);

create index if not exists idx_ipo_status_history_subscription on ipo_subscription_status_history(subscription_id);

-- ------------------------------------------------------------
-- ipo_notify_signups
-- Simple opt-in: "get automatic notifications from BGL Securities"
-- about the Dangote IPO, for visitors who aren't subscribing yet.
-- ------------------------------------------------------------
create table if not exists ipo_notify_signups (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  email      text not null,
  phone      text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_ipo_notify_email on ipo_notify_signups(lower(email));

-- ------------------------------------------------------------
-- Row Level Security
-- Same model as the account opening feature: writes go through
-- Netlify/Vercel functions using the service role key (bypasses RLS),
-- never directly from the browser. Admin gets read-only access via
-- an authenticated session, same as account_opening_applications.
-- ------------------------------------------------------------
alter table ipo_subscriptions enable row level security;
alter table ipo_subscription_documents enable row level security;
alter table ipo_subscription_status_history enable row level security;
alter table ipo_notify_signups enable row level security;

drop policy if exists "Authenticated can read ipo subscriptions" on ipo_subscriptions;
create policy "Authenticated can read ipo subscriptions"
  on ipo_subscriptions for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can read ipo documents" on ipo_subscription_documents;
create policy "Authenticated can read ipo documents"
  on ipo_subscription_documents for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can read ipo status history" on ipo_subscription_status_history;
create policy "Authenticated can read ipo status history"
  on ipo_subscription_status_history for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can read ipo notify signups" on ipo_notify_signups;
create policy "Authenticated can read ipo notify signups"
  on ipo_notify_signups for select
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- Storage bucket (create via the Supabase dashboard, not this SQL file):
--   Name: ipo-documents
--   Public: OFF
-- Signature/ID/payment-evidence uploads go here, using the same
-- signed-upload-URL pattern as the account opening feature's
-- application-documents bucket.
-- ------------------------------------------------------------
drop policy if exists "Authenticated can read ipo documents storage" on storage.objects;
create policy "Authenticated can read ipo documents storage"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'ipo-documents');
