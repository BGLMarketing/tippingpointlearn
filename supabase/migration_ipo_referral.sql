-- ============================================================
-- Dangote IPO subscriptions — referral tracking
-- ============================================================
-- Adds the same free-text "Referred by" field the account-opening
-- wizard already has, reusing the existing referral_codes table
-- (no new codes table — one code now tracks both BGL account opens
-- and Dangote IPO subscriptions for the same referrer).
--
-- Run this once against the same Supabase project as the rest of
-- the site, after ipo_subscriptions.sql. Safe to re-run.

alter table ipo_subscriptions
  add column if not exists referred_by text;

create index if not exists idx_ipo_subs_referred_by
  on ipo_subscriptions (lower(referred_by));
