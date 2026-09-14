-- ============================================================
-- Dangote IPO — payment account details, multi-currency
-- ============================================================
-- Extends the existing single-account ipo_payment_account row to
-- hold three currency accounts (NGN/USD/GBP) instead of one. All
-- three share the same bank and account name in the real BGL data
-- this was built from (Providus Bank, "BGL DANGOTE IPO"), so this
-- keeps bank_name/account_name as single shared fields rather than
-- tripling every column — only the account number actually differs
-- per currency. If a future currency ever needs a different bank or
-- account name, this table would need revisiting, but there's no
-- reason to build that flexibility speculatively right now.
--
-- account_number (added in the original migration) is kept as-is and
-- now specifically means the NGN account, so nothing that already
-- reads that column needs to change — account_number_usd and
-- account_number_gbp are purely additive.
--
-- Run this once against the same Supabase project as the rest of
-- the site, after migration_ipo_payment_account.sql. Safe to re-run.

alter table ipo_payment_account
  add column if not exists account_number_usd text;

alter table ipo_payment_account
  add column if not exists account_number_gbp text;

-- Seed the real account details directly, rather than requiring a
-- trip through the admin form first — these are the actual BGL
-- Dangote IPO accounts, not placeholders.
update ipo_payment_account
set
  bank_name = 'Providus Bank',
  account_name = 'BGL DANGOTE IPO',
  account_number = '1310539776',
  account_number_usd = '1310539783',
  account_number_gbp = '1310539790',
  updated_at = now(),
  updated_by = 'system (migration seed)'
where id = (select id from ipo_payment_account order by updated_at asc limit 1);
