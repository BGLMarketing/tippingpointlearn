# Tipping Point — Marketing Site

Static site for Tipping Point (BGL Securities' digital investment platform), currently hosted on Netlify.

## Structure

```
/                 → main landing page (waitlist, brand overview)
/faq              → general FAQ
/waitlist         → standalone waitlist form (shareable link, e.g. for ads/social bio)
/dangote-ipo      → Dangote Refinery IPO campaign page (FAQ, 3-channel steps, waitlist)
/learn            → Learn hub (placeholder — see "Learn page" below)
/open-account     → BGL account opening wizard (Individual/Joint/Corporate) — see
                    "Account opening" below
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

## Account opening

`/open-account` is a multi-step wizard for opening a BGL Securities
brokerage account — Individual, Joint, or Corporate — built from BGL's
actual KYC and CSCS Direct Settlement paper forms. It reuses the site's
shared brand CSS (`:root` variables, fonts, `.btn`/`.field`/`.modal`
classes) and includes the same nav, footer, and waitlist modal as every
other page, so it's a normal Netlify-served page like `/faq` or
`/waitlist`.

- **Assets**: `assets/BGL_Logo.png` (shown as a small badge under the
  page's eyebrow, since this flow is BGL-branded specifically) and
  `assets/Risk_Disclosure_Statement.pdf` (linked from the Risk
  Disclosure consent checkbox on the Disclosures step). Both are
  referenced with root-relative paths (`/assets/...`), so they resolve
  correctly regardless of the page's folder depth.
- **Submission**: the form posts to `/.netlify/functions/submit-application`
  (multipart form data — all field values as JSON plus the uploaded
  files). The function lives in `netlify/functions/submit-application.js`,
  writes to Supabase (schema in `supabase/schema.sql`), uploads documents
  to a private Supabase Storage bucket, and sends branded Brevo emails
  (internal alert + applicant confirmation). If the request fails for any
  reason (e.g. required environment variables aren't set yet), the
  frontend falls back to a mocked success screen so the flow can still be
  reviewed end-to-end.
  - **Requires a Git-connected deploy, not drag-and-drop.** Netlify's
    manual drag-and-drop deploy only publishes static files — it does
    not deploy functions. This site must be deployed via a Git-connected
    Netlify site (or the Netlify CLI) for `submit-application` to run.
  - **Environment variables** (set in Netlify → Site settings →
    Environment variables): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
    `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`,
    `LOGO_URL`, `SITE_URL`. See `netlify/functions/utils/brevo.js` for
    how these are used.
  - **Supabase setup**: run `supabase/schema.sql` once against a Supabase
    project's SQL editor, and create a private Storage bucket named
    `application-documents`. If `schema.sql` was already run before the
    Risk Disclosure consent fields existed, run
    `supabase/migration_risk_disclosure.sql` instead of re-running the
    whole schema.
  - **Admin review**: `/admin` (the same login used for Learn articles)
    has a second tab, "Account applications" — a list of submissions
    (filterable by status, searchable by name/email/reference), a detail
    view (applicant/company info, banking, uploaded documents via
    short-lived signed URLs, and full status history), and the actions
    to move an application `submitted → under_review → opened/rejected`.
    Marking an application **opened** requires a CHN and CSCS Account
    Number; **rejecting** requires a reason of at least 10 characters —
    both are enforced in `netlify/functions/update-application-status.js`,
    which also sends the applicant the matching status email and writes
    the audit trail row. The admin page never writes these tables
    directly — only that function does, using the service role key, so
    the emails and audit trail can't be bypassed by calling Supabase
    straight from the browser. Run `supabase/admin_policies.sql` once
    (after `schema.sql`) to grant the authenticated admin session
    read-only access to these tables and to the document storage bucket.
  - Still to build: a public "track your application" page for
    applicants (reference + email lookup).
- **Consent tracking**: the PEP/indemnity/risk-disclosure checkboxes on
  the Disclosures step record the exact client-side timestamp at the
  moment each box is checked (not the later submission time), and this
  timestamp is stored as given rather than overwritten with the server's
  submission time.
- **Nav entry point**: every page's nav includes an "Open BGL Account"
  link to `/open-account` (styled as a `.btn.btn-ghost`, next to "Join
  the community"). On `/open-account` itself, that same nav-cta slot
  becomes a static, non-clickable label — the same pattern used for
  "Learn" and "Dangote IPO" on their own pages.

## Deploying

This repo deploys to Netlify — publish directory is the repo root, no
build command needed (see `netlify.toml`). Folder-based pages (`/waitlist`,
`/dangote-ipo`, `/learn`, `/open-account`) rely on their `index.html` files
for clean URLs, so keep that structure intact.

As of the account opening feature, this site must be deployed via a
**Git-connected Netlify site** (Netlify → Site settings → Build & deploy →
Link to a Git repository), not the manual drag-and-drop dropzone — the
`submit-application` function under `netlify/functions/` only deploys
through a Git-connected build (or the Netlify CLI), never through
drag-and-drop. Once connected, every `git push` to `main` deploys
automatically.

