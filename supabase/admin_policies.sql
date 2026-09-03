-- ============================================================
-- Admin read access for the Account Opening feature
-- ============================================================
-- The admin dashboard (/admin) signs admins in via Supabase Auth,
-- the same way the Learn articles admin already does, and reads
-- these tables directly using the anon key + an authenticated
-- session. These policies grant READ-ONLY access to that
-- authenticated role.
--
-- Status changes (submitted → under_review → opened/rejected) do
-- NOT go through a direct client update — they go through the
-- update-application-status Netlify Function, which uses the
-- service role key (bypassing RLS entirely) so that the audit
-- trail, validation rules, and Brevo emails stay server-side and
-- can't be skipped by calling Supabase directly from the browser.
-- That's why there are no insert/update/delete policies here.

create policy "Authenticated can read applications"
  on account_opening_applications for select
  to authenticated
  using (true);

create policy "Authenticated can read applicants"
  on applicants for select
  to authenticated
  using (true);

create policy "Authenticated can read corporate profiles"
  on corporate_profiles for select
  to authenticated
  using (true);

create policy "Authenticated can read application documents"
  on application_documents for select
  to authenticated
  using (true);

create policy "Authenticated can read status history"
  on application_status_history for select
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- Storage: let authenticated admins read uploaded KYC documents
-- so the dashboard can generate signed URLs for viewing/downloading
-- them. The bucket itself stays private — this only opens read
-- access to logged-in admins, not the public.
-- ------------------------------------------------------------
create policy "Authenticated can read application documents storage"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'application-documents');
