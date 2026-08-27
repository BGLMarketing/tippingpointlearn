// Public Supabase project config for Tipping Point's Learn hub.
// The anon key below is designed to be public-facing — real access
// control is enforced by Postgres Row Level Security policies on the
// `articles` table (public read of published rows only; writes require
// an authenticated admin session), not by keeping this key secret.
const SUPABASE_URL = "https://bzedpbwlkggygpgyaqfd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6ZWRwYndsa2dneWdwZ3lhcWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MzAzODgsImV4cCI6MjEwMzQwNjM4OH0.0Bwk12yyW7dZ_UMCKDm9Ginv_nNb19WHbeFWrvYzvvs";
