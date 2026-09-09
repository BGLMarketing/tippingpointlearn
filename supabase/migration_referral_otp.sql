-- ============================================================
-- Referral codes — email + OTP-gated lookup
-- ============================================================
-- /referral-status now requires verifying a one-time code sent to
-- the email on file for that referral code, rather than just knowing
-- the code itself. Run this once against the same Supabase project,
-- after referral_codes.sql. Safe to re-run.

alter table referral_codes
  add column if not exists email text;

-- Existing codes (every one as of this migration) have no email yet
-- and are intentionally NOT backfilled with a guess — admin adds the
-- real email per code from /admin. Until then, request-referral-otp
-- blocks lookup for that code rather than silently allowing it
-- without OTP or guessing an address to send to.

create table if not exists referral_otp_codes (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,               -- the referral code this OTP is for (uppercase, matches referral_codes.code)
  otp_hash       text not null,                -- sha-256 hex of the 6-digit OTP — never store it in plain text
  expires_at     timestamptz not null,
  attempts       int not null default 0,       -- verify attempts against this OTP; capped to prevent brute-forcing the 6-digit space
  used_at        timestamptz,                  -- set once successfully verified — an OTP is single-use
  created_at     timestamptz not null default now()
);

create index if not exists idx_referral_otp_code on referral_otp_codes (code, created_at desc);

alter table referral_otp_codes enable row level security;

-- No public policy at all — every read/write to this table happens
-- through request-referral-otp.js / referral-lookup.js using the
-- service role key (bypasses RLS). The OTP itself must never be
-- queryable by anyone, including via the anon key.
drop policy if exists "Authenticated can read OTP codes for support" on referral_otp_codes;
create policy "Authenticated can read OTP codes for support"
  on referral_otp_codes for select
  to authenticated
  using (true);
