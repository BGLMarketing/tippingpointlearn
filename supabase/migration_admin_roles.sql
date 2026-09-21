-- ============================================================
-- Admin roles for the account-opening review pipeline
-- ============================================================
-- Maps each Supabase Auth admin (by email) to one stage of the
-- review pipeline: client_service, compliance, or account_opening.
-- A row with no role (or no row at all) means that admin isn't
-- authorized to act on any status transition yet.
--
-- This is enforced SERVER-SIDE in update-status.js (both the Vercel
-- and Netlify copies) -- the actual security boundary is there,
-- looking up the caller's role via the service-role client before
-- allowing a transition. The read policy below only lets the admin
-- dashboard show/hide buttons and display "my role" in the UI; it is
-- not itself a security control.
--
-- Run this once against the same Supabase project as the rest of
-- the site, after schema.sql. Safe to re-run.

create table if not exists admin_roles (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  role       text not null check (role in ('client_service', 'compliance', 'account_opening')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_admin_roles_email on admin_roles(email);

alter table admin_roles enable row level security;

-- Read-only for any logged-in admin, same pattern as
-- admin_policies.sql -- writes only ever happen through the
-- update-status function (service role key, bypasses RLS), never
-- directly from the browser.
drop policy if exists "Authenticated can read admin roles" on admin_roles;
create policy "Authenticated can read admin roles"
  on admin_roles for select
  to authenticated
  using (true);
