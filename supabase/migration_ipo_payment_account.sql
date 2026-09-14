-- ============================================================
-- Dangote IPO — payment account details (admin-managed)
-- ============================================================
-- A single row holding the bank account subscribers should pay their
-- IPO amount into. Admin edits this directly from /admin (same
-- pattern as Learn articles and referral codes — no function needed,
-- since there's no side effect like an email to trigger). The
-- subscribe wizard reads it with the public anon key so it can show
-- the account details to a subscriber without requiring login —
-- bank account numbers for receiving payment are meant to be shared
-- publicly (the same way a business posts them for bank transfers),
-- so a public-read policy here is intentional and safe.
--
-- Run this once against the same Supabase project as the rest of
-- the site. Safe to re-run.

create table if not exists ipo_payment_account (
  id             uuid primary key default gen_random_uuid(),
  bank_name      text,
  account_name   text,
  account_number text,
  updated_at     timestamptz not null default now(),
  updated_by     text
);

alter table ipo_payment_account enable row level security;

drop policy if exists "Anyone can read the IPO payment account" on ipo_payment_account;
create policy "Anyone can read the IPO payment account"
  on ipo_payment_account for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage the IPO payment account" on ipo_payment_account;
create policy "Authenticated can manage the IPO payment account"
  on ipo_payment_account for all
  to authenticated
  using (true)
  with check (true);

-- Seed one empty row so the app always has exactly one row to
-- upsert against, rather than needing to handle a "no row yet" case
-- in both the admin form and the subscribe wizard. Admin fills in
-- the real details from /admin before the offer opens.
insert into ipo_payment_account (bank_name, account_name, account_number)
select null, null, null
where not exists (select 1 from ipo_payment_account);
