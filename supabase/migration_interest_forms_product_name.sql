-- ============================================================
-- interest_forms — standardize product_name
-- ============================================================
-- Both existing rows (slugs KENAKO-dango and NIDCOM) were meant for
-- the same underlying product, but had inconsistent product_name
-- values ('Dangote Refinery IPO' vs 'DANGOTE'). Standardizes both to
-- the same name.
--
-- Already applied directly against the live Supabase project via the
-- SQL editor; committed here for the record, matching how this
-- project tracks other applied migrations. Safe to re-run.

update interest_forms
set product_name = 'Dangote Refinery IPO';
