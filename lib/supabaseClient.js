const { createClient } = require('@supabase/supabase-js');

// Uses the SERVICE ROLE key — this file must only ever run in a
// Netlify Function (server-side), never be bundled into the browser.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Every Supabase Auth user on this project is an admin (see the
// README's "Learn page & admin" section — there's no separate role
// distinction), so "all admins" is simply every Auth user's email.
// Used to notify the whole admin team on new submissions rather than
// a hand-maintained static list that silently goes stale as people
// join or leave. Falls back to an empty array on failure — callers
// should have their own hardcoded fallback list so a Supabase Auth
// hiccup never means nobody gets notified.
async function getAdminEmails(){
  try{
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
    if(error) throw error;
    return (data.users || []).map(u => u.email).filter(Boolean);
  } catch(err){
    console.error('getAdminEmails failed:', err);
    return [];
  }
}

module.exports = { supabase, getAdminEmails };
