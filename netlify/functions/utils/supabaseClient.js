const { createClient } = require('@supabase/supabase-js');

// Uses the SERVICE ROLE key — this file must only ever run in a
// Netlify Function (server-side), never be bundled into the browser.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabase };
