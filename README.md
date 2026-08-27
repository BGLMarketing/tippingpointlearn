# Tipping Point — Marketing Site

Static site for Tipping Point (BGL Securities' digital investment platform), currently hosted on Netlify.

## Structure

```
/                 → main landing page (waitlist, brand overview)
/faq              → general FAQ
/waitlist         → standalone waitlist form (shareable link, e.g. for ads/social bio)
/dangote-ipo      → Dangote Refinery IPO campaign page (FAQ, 3-channel steps, waitlist)
/learn            → Learn hub (placeholder — see "Learn page" below)
```

Each page is a self-contained `index.html` (or `<name>.html` at root, which Netlify
serves at a clean `/<name>` URL automatically). Shared brand CSS, the waitlist
modal, footer, and chat widget are duplicated inline in each file rather than
imported, since there's no build step yet — see "Possible next steps" if that
becomes painful to maintain.

## Integrations

- **Waitlist form**: embeds BGL Securities' real Brevo signup form directly
  (not a custom form posting to Brevo's API), so field names and submission
  logic are guaranteed correct — see the `<!-- Begin Brevo Form -->` block in
  any page.
- **Brevo Conversations**: live chat widget, loaded near the end of `<body>`.
- **Analytics**: Google tag (gtag.js) and Google Tag Manager are both installed
  on every page, in `<head>`.

## Learn page & admin

`/learn` lists published articles, pulled live from a Supabase database.
`/admin` is a password-protected dashboard (Supabase Auth) where a signed-in
admin can create, edit, and delete articles, and set each one's status to
`draft`, `published`, or `unpublished`. Only `published` articles are visible
on `/learn` or `/learn/article.html` — enforced by Postgres Row Level Security
on the `articles` table, not just by the frontend hiding them.

- **Config**: `assets/js/supabase-config.js` holds the Supabase project URL
  and anon/public key. The anon key is meant to be public-facing; real access
  control lives in the database's RLS policies, not in keeping this key
  secret.
- **Content format**: articles are written in Markdown in the admin's content
  field, rendered client-side via `marked.js` on `/learn/article.html`.
- **Clean article URLs**: `/learn/<slug>` (e.g. `/learn/what-is-an-ipo`) is
  served via the rewrite rule in `_redirects` at the repo root, which points
  it at `/learn/article.html` while keeping the clean URL in the address bar.
  The page reads the slug from the URL path itself. This only works once
  Netlify picks up the `_redirects` file, which it does automatically as
  long as it's in the published root.
- **Adding an admin user**: create them directly in the Supabase dashboard
  under Authentication → Users — there's no self-serve signup on `/admin`.
- **Database schema**: see the `articles` table definition and RLS policies
  used to set this up (title, slug, excerpt, content, status, timestamps).
  If the project is ever rebuilt, re-run that same SQL against a fresh
  Supabase project and update `supabase-config.js` with its new URL/key.

## Deploying

This repo deploys to Netlify as a static site — no build command needed,
publish directory is the repo root. Folder-based pages (`/waitlist`,
`/dangote-ipo`, `/learn`) rely on their `index.html` files for clean URLs, so
keep that structure intact.
