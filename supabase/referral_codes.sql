-- ============================================================
-- Referral codes
-- ============================================================
-- Admin creates a code per agent/relationship manager. Applicants
-- enter that code in the "Referred by" field on the account opening
-- wizard (same free-text field as before — this table doesn't change
-- that field, it just gives admin a managed list of codes to hand out
-- and a way to look up who used each one).

create table if not exists referral_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  agent_name   text not null,
  created_at   timestamptz not null default now(),
  created_by   text
);

create index if not exists idx_referral_codes_code on referral_codes(code);

alter table referral_codes enable row level security;

-- Admin manages this directly from the browser (create/list/delete),
-- the same way the Learn articles table already works — no side
-- effects like emails happen here, so a dedicated function isn't
-- needed the way it is for application status changes.
drop policy if exists "Authenticated can manage referral codes" on referral_codes;
create policy "Authenticated can manage referral codes"
  on referral_codes for all
  to authenticated
  using (true)
  with check (true);

-- No public policy — the public referral-lookup function uses the
-- service role key (bypasses RLS) to verify a code and pull matching
-- applications, so anonymous visitors can never query this table (or
-- account_opening_applications) directly.
