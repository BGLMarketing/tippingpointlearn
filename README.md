# Tipping Point — Marketing Site

Static site for Tipping Point (BGL Securities' digital investment platform), currently hosted on Netlify.

## Structure

```
/                 → main landing page (waitlist, brand overview)
/faq              → general FAQ
/waitlist         → standalone waitlist form (shareable link, e.g. for ads/social bio)
/dangote-ipo      → Dangote Refinery IPO campaign page (FAQ, 3-channel steps, waitlist)
/dangote-ipo/subscribe → IPO subscription wizard — see "Dangote IPO subscription" below
/learn            → Learn hub (placeholder — see "Learn page" below)
/open-account     → BGL account opening wizard (Individual/Joint/Corporate) — see
                    "Account opening" below
/track-application → Public status lookup for a submitted application
                    (reference + email) — see "Account opening" below
/referral-status  → OTP-gated lookup for a referral code (agent view
                    of accounts opened + IPO subscribers) — see
                    "Referral codes" below
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
  Every Supabase Auth user on this project gets full admin access to
  every tab (articles, account applications, referral codes, and the
  Dangote IPO) — there's no separate role distinction, so only add
  people who should genuinely have that.
- **Password reset**: `/admin` has a "Forgot your password?" link, using
  Supabase Auth's built-in recovery flow (`resetPasswordForEmail` /
  `updateUser`) — no separate page or custom token handling needed. An
  admin who thinks their password is compromised can reset it
  themselves without anyone touching the Supabase dashboard.
- **Database schema**: see the `articles` table definition and RLS policies
  used to set this up (title, slug, excerpt, content, status, timestamps).
  If the project is ever rebuilt, re-run that same SQL against a fresh
  Supabase project and update `supabase-config.js` with its new URL/key.

## Account opening

`/open-account` is a multi-step wizard for opening a BGL Securities
brokerage account — Individual, Joint, Corporate, or Minor — built
from BGL's actual KYC and CSCS Direct Settlement paper forms. It
reuses the site's shared brand CSS (`:root` variables, fonts,
`.btn`/`.field`/`.modal` classes) and includes the same nav, footer,
and waitlist modal as every other page, so it's a normal Netlify-served
page like `/faq` or `/waitlist`.

- **Assets**: `assets/BGL_Logo.png` (shown as a small badge under the
  page's eyebrow, since this flow is BGL-branded specifically) and
  `assets/Risk_Disclosure_Statement.pdf` (linked from the Risk
  Disclosure consent checkbox on the Disclosures step). Both are
  referenced with root-relative paths (`/assets/...`), so they resolve
  correctly regardless of the page's folder depth.
- **Document uploads**: each file is uploaded **directly from the
  browser to Supabase Storage** as soon as it's selected, not sent
  through a Netlify Function. The flow: the browser asks
  `netlify/functions/upload-url.js` for a short-lived signed
  upload URL (that function's own request/response is tiny — no file
  bytes touch it), then uses the Supabase JS client
  (`uploadToSignedUrl`) to upload the file straight to the private
  `application-documents` bucket. The signed token is the only
  authorization needed for that one upload — the browser's own anon-key
  session has no storage write access on its own. This avoids Netlify
  Functions' own request-size ceiling (~6MB) entirely, which an earlier
  version hit once base64 encoding was factored in (a 502 with no
  usable error body). Per-file cap is 5MB, 25MB combined per
  application — now just a sane UX/cost limit, not a hard platform
  constraint.
- **Duplicate-account check**: the primary applicant's email
  (individual/joint) and the company email (corporate) are checked
  against existing BGL customers as soon as the field loses focus —
  if a match is found, a warning appears ("This email already has a
  BGL account. Please contact clientservices@bglgroup.ng.") and that
  step can't be continued past until the email is changed. Checked
  against two sources: `existing_bgl_customers` (accounts opened
  outside this system, imported via `supabase/import_existing_customers.sql`
  — run `supabase/migration_existing_customers.sql` first to create
  the table) and any application already at `status = 'opened'` in
  this system itself (a pending/in-review application doesn't count
  as "having an account" yet, so those are deliberately not matched).
  Not every email field in the wizard triggers this — a joint
  partner or corporate signatory can legitimately already have their
  own separate personal account, so only the actual account-holder
  identity's email is checked. Implemented as a `{checkEmail: '...'}`
  dispatch on `submit-application.js` rather than a new endpoint, to
  stay under Vercel Hobby's serverless function cap (already broke
  production twice this session at just 10-11 functions). The check
  "fails open" on any error, both server- and client-side — a broken
  lookup should never block a legitimate applicant from submitting,
  worst case a genuine duplicate slips through and gets caught by
  admin during review instead of at the form.
- **Minor account type** — built from BGL's separate Minors KYC form
  (a genuinely different document, not a variant of the adult one).
  Four extra wizard steps beyond the type selection: the minor's own
  (much shorter) details, the guardian's details, the guardian's
  employment/financial position, and a next of kin for the guardian
  — then banking & settlement (CSCS Direct Settlement or In-House,
  plus CSCS/CH numbers and a preferred-contact-method checklist,
  rather than the adult flow's account-type/source-of-funds
  questions), a declaration + indemnity + risk-disclosure step, and
  documents (minor's passport photo + birth certificate; guardian's
  passport photo, valid ID, proof of address, and signature). No PEP
  step — the source form doesn't ask for one, for either the minor or
  the guardian.
  Two new `applicants` roles store this: `minor` (personal details
  only — no PEP, no indemnity/risk-disclosure acceptance, since a
  minor doesn't sign anything) and `guardian` (personal details with
  employment/income folded into the same `personal_info` JSONB, plus
  the *real* indemnity/risk-disclosure acceptance, since the guardian
  is who signs). Next of kin doesn't fit the `applicants` shape at all
  (doesn't sign anything, isn't part of the review pipeline), so it's
  a `next_of_kin_info` JSONB column directly on
  `account_opening_applications` instead. `resolveApplicantIdentity()`
  in `submit-application.js` sets `applicant_name` to the *minor's*
  name (it's their account) but `applicant_email` to the *guardian's*
  email (the minor has none — the guardian is who all communication
  actually goes to). Run `supabase/migration_minor_account_type.sql`
  once (after `schema.sql`) to allow `'minor'` as an `account_type`
  and `'minor'`/`'guardian'` as `applicant_role` values, and add the
  `next_of_kin_info` column.
- **Referral attribution — matches code or name**: `referred_by` is
  free text an applicant typed on the wizard, and not every applicant
  types the actual code — some type the referrer's name instead. Both
  the public `/referral-status` lookup (`referral-lookup.js`) and
  admin's per-code commission calculation now match on **either** the
  code or the referral code's `agent_name` (case-insensitive, via two
  separate queries merged and deduplicated by reference — not a single
  combined `.or()` filter, which is fragile against special characters
  a name could contain). Admin can also directly edit a specific
  application's `referred_by` value from its detail view ("Edit" next
  to the field) for anything that doesn't cleanly match either — a
  reason of at least 10 characters is required and both the old and
  new values are logged to `application_status_history`, same as
  every other change to an application.
- **Submission**: once all documents are uploaded, the form posts small
  JSON (form field values + the list of already-uploaded document
  paths — no file bytes) to `/.netlify/functions/submit-application`.
  That function writes everything to Supabase (schema in
  `supabase/schema.sql`) and sends branded Brevo emails (internal alert
  + applicant confirmation). A genuine failure shows the applicant a
  plain "couldn't submit, contact clientservices@bglafrica.com" message
  — it never silently shows a fake success.
  - **Requires a Git-connected deploy, not drag-and-drop.** Netlify's
    manual drag-and-drop deploy only publishes static files — it does
    not deploy functions. This site must be deployed via a Git-connected
    Netlify site (or the Netlify CLI) for the functions to run.
  - **Brevo's IP-restriction setting must stay OFF, permanently.**
    Brevo has an optional account-level "Authorize IP addresses only"
    security feature (Settings → Security → Authorised IPs). If it's
    ever turned back on, it will silently block every email send from
    these functions — serverless infrastructure like Vercel/Netlify
    runs from a rotating outbound IP pool, not a single fixed address,
    so allowlisting individual IPs is not a durable fix and will cause
    intermittent failures that are very hard to diagnose (this exact
    thing already happened once: every submission and status-change
    email silently vanished for a period with zero visible errors,
    since `submit-application` and `update-status` both
    intentionally treat email failures as non-fatal — logged, not
    thrown — so a flaky send never blocks a real submission or status
    change, but also never surfaces on its own). The `BREVO_API_KEY`
    itself is the real security boundary here, not IP restriction.
    `sendEmail()` in `utils/brevo.js` also now throws instead of
    silently no-op'ing if `BREVO_API_KEY` is missing, which was a
    second, independent way the same class of silent failure could
    happen.
  - **Environment variables** (set in Netlify → Site settings →
    Environment variables, and the equivalent in Vercel → Project
    Settings): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
    `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`,
    `LOGO_URL`, `SITE_URL`. See `netlify/functions/utils/brevo.js` (and
    its identical copy at `lib/brevo.js`, used by the Vercel functions
    under `api/`) for how these are used.
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
    to move an application through the review pipeline:
    `submitted → under_review_client_service → under_review_compliance
    → account_opening_in_progress → opened`. Every stage requires an
    explicit **Approve** or **Reject** click from the admin role that
    owns it — simply opening/viewing an application never changes its
    status. `under_review_client_service` and `under_review_compliance`
    are both displayed to admin and to the applicant (on
    `/track-application`) as one continuous "Under Compliance review"
    stage, even though internally it's two statuses: a Compliance-role
    admin approves twice in a row to walk an application from
    `under_review_client_service` through `under_review_compliance` to
    `account_opening_in_progress`. **Rejecting** is available at
    `submitted`, `under_review_client_service`,
    `under_review_compliance`, and `account_opening_in_progress`, and
    is terminal: a rejected applicant would need to submit a fresh
    application, there's no resubmit/edit flow.
    Every transition is gated by an **admin role** — Client Service
    owns `submitted`, Compliance owns both `under_review_*` statuses,
    and Account Opening owns `account_opening_in_progress` (marking
    **opened**, which requires a CHN and CSCS Account Number, or
    **rejecting**, which requires a reason of at least 10 characters).
    Roles are assigned per admin email under the "Manage admins" tab
    and enforced
    server-side in `update-status.js` (both the Vercel and Netlify
    copies) via `APPLICATION_TRANSITION_RULES` — the admin UI hiding
    buttons the caller's role doesn't cover is a convenience, not the
    security boundary; a direct API call attempting to skip a stage or
    act outside the caller's role is rejected there regardless of what
    the UI shows. Run `supabase/migration_admin_roles.sql` once (after
    `schema.sql`) to create the `admin_roles` table this depends on —
    until an admin has a role assigned there, they can view everything
    but can't act on any status transition.
    Only the `under_review_client_service` transition emails the
    applicant ("your application is under review") — the later moves
    to `under_review_compliance` and `account_opening_in_progress` are
    silent internal handoffs, since from the applicant's side nothing
    has visibly changed yet; `opened` and `rejected` both email the
    outcome. Run `supabase/migration_two_stage_review.sql` then
    `supabase/migration_account_opening_in_progress.sql` once (after
    `schema.sql`) to update the status column's allowed values — the
    old single `under_review` status is kept valid for any
    pre-migration rows still sitting in it (they remain actionable
    from the admin UI, moving straight to opened/rejected, gated to the
    Account Opening role) but nothing new is ever written with that
    value. Run `supabase/backfill_legacy_under_review_status.sql` to
    move any existing `under_review` applications into the new
    pipeline's first stage (`under_review_client_service`) rather than
    leaving them on the legacy one-step fallback indefinitely — safe to
    re-run, and logs the move in each application's status history.
    A `needs_update` status is reachable from every stage that can
    reject (`submitted`, both `under_review_*` statuses, and
    `account_opening_in_progress`), gated to that same stage's role —
    it's a softer alternative to rejecting outright, for something
    specific and fixable rather than a hard no. Setting it requires a
    note (min. 10 characters) explaining what needs to change, and
    generates a single-use `resume_token` emailed to the applicant
    (`sendApplicantNeedsUpdateEmail`) as a link to
    `/open-account?resume=<reference>&token=<token>`. That link
    fetches the applicant's existing answers (`{resumeLookup: true}`
    on `submit-application.js`, reversing `buildApplicantRow()` back
    into the wizard's `state` shape) and drops them straight on the
    Review step, admin's note shown at the top — the applicant fixes
    whatever's wrong via that step's existing per-section "Edit" links
    and resubmits. Resubmitting (`{resume: {reference, token}}` in the
    normal submit payload) updates the SAME application row in place —
    same id, same reference, no duplicate record — clears the token and
    needs_update fields, and returns it to `submitted`, restarting the
    review pipeline from the top. A used or stale token matches nothing
    (`resolveResumeTarget()` requires `status = 'needs_update'` AND an
    exact token match), so a link can't be replayed after its
    application has already moved on. The resume token is deliberately
    never exposed via `/track-application` (a much weaker reference +
    email check) — only the note is; the actual link only ever travels
    through the email. Admin also sees the note and, as a fallback if
    the email didn't land, the resume link itself in the application's
    detail view (every admin already has full read access to every
    other field there regardless of role, so this isn't a new class of
    exposure). Run `supabase/migration_needs_update_status.sql` once
    (after `schema.sql` and `migration_admin_roles.sql`) to add the
    status value and the `needs_update_note` / `needs_update_at` /
    `needs_update_by` / `resume_token` / `resume_token_created_at`
    columns this depends on.
    The admin page never writes these tables
    directly — only that function does, using the service role key, so
    the emails and audit trail can't be bypassed by calling Supabase
    straight from the browser. Run `supabase/admin_policies.sql` once
    (after `schema.sql`) to grant the authenticated admin session
    read-only access to these tables and to the document storage bucket.
  - **Completion screen**: after submitting, the applicant sees a
    reference number and a note that account opening typically takes
    between 24 and 48 hours.
  - **Full data visibility**: the detail view shows every field the
    wizard actually collects — including ones added after the initial
    build (gender, DOB, mother's maiden name, nationality, state of
    origin/LGA, BVN, NIN, Tax ID, and full PEP declarations with their
    conditional follow-up fields) — rather than a partial subset. The
    PEP yes/no questions specifically had a real bug fixed alongside
    this: their radio inputs were missing the `data-field-radio`
    attribute the wizard's collection logic depends on, so the answer
    was never actually being saved for any submission until fixed —
    a data-capture bug, not just a missing display. The overview's
    "Referred by" row is paired with the *referrer's* email (looked
    up from `referral_codes`), not the applicant's own email — the
    applicant's email is already shown in their own detail section
    below, so repeating it there was redundant, and knowing who a
    referral code belongs to is more useful at a glance.
  - **Resending a notification**: every application in the detail view
    has a "Resend notification email" action (`resend-notification.js`),
    which re-sends whatever email matches the application's *current*
    stored status (confirmation / under review / opened / rejected) —
    using the CHN, CSCS Account Number, or rejection reason already on
    file, not new input. Useful for backfilling applicants who were
    updated before a fix to an email's content, or whose original send
    failed silently.
- **Tracking**: `/track-application` is a public page (no login) where
  an applicant enters their application reference and the email they
  applied with to see a simple status tracker (Submitted → Under review
  → Opened/Rejected, with the CHN or rejection reason shown once
  available). It's linked from the `/open-account` success screen and
  from every status-change email. It's backed by its own function,
  `netlify/functions/track-application.js`, rather than reading
  Supabase directly from the browser — both the reference **and** the
  email must match together, and a mismatch on either returns the same
  generic "not found" response, so the endpoint can't be used to
  enumerate applications or confirm whether a given reference exists.
  It only ever returns status fields, never the full applicant record.
- **Mobile reliability**: the wizard persists its full state (all
  entered fields, current step, and uploaded document metadata) to
  `sessionStorage` after every change. This matters specifically for
  mobile: opening the camera or file picker to attach a document often
  causes the OS to reclaim the browser tab's memory, which silently
  reloads the page and would otherwise wipe all in-progress form data.
  With persistence in place, a reload like that is invisible — the
  applicant lands right back where they left off. State clears once
  the application is actually submitted, or when starting a new one.
- **Document uploads are actually required**: every document field is
  validated the same way required text fields are — attempting to
  continue past the Documents step (or reach Review & Submit) without
  a required file attached is blocked with a visible error, and the
  missing upload field is outlined. This wasn't enforced in an earlier
  version, which allowed a submission to go through with zero
  attachments if the applicant simply skipped the upload buttons.
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

## Referral codes

One `referral_codes` table now covers both `/open-account` and the
Dangote IPO subscription wizard — a single code tracks an agent's BGL
account referrals and their IPO subscription referrals together.

- **Admin-issued codes**: admin creates a code per agent/relationship
  manager from the "Referral codes" tab in `/admin` (agent name,
  email, and either a custom code or an auto-generated one, e.g.
  `RM-4X7QK2`). Applicants enter that code in the account-opening
  wizard's existing "Referred by / Relationship Manager" field, or the
  IPO wizard's "Referred by" field on the Participation step — no
  change to either field itself, both are still free text, so a typo
  or a code that was never actually issued just won't match anything.
  Matching is case-insensitive: codes are always stored uppercase, and
  lookups match the applicant's typed value case-insensitively too.
  Admin manages the `referral_codes` table directly from the browser
  (same as the Learn articles table) rather than through a function,
  since creating/deleting a code has no side effects like emails to
  trigger. Each code's "Copy links" button in the table copies a
  ready-to-paste block (the code plus both pre-filled links, account-
  opening and IPO subscribe) to the clipboard in one click. Run
  `supabase/referral_codes.sql` once to set up the table, then
  `supabase/migration_ipo_referral.sql` to add the matching
  `referred_by` column to `ipo_subscriptions`, then
  `supabase/migration_referral_otp.sql` for the email column and OTP
  table described below.
- **Self-service referral codes**: `/open-account`'s entry screen has
  two links — "Check your referrals" (straight to `/referral-status`)
  and "Refer someone to BGL", which opens a modal where anyone (not
  just admin-designated agents) can enter their name, email, and a
  preferred code to get their own code and both shareable links
  (`/open-account?ref=<code>` and `/dangote-ipo/subscribe?ref=<code>`).
  Backed by the public `create-referral-code.js` — validates the code
  is 3-20 characters of letters/numbers/hyphens, rejects a code that's
  already taken (case-insensitively) rather than silently generating a
  different one, since the applicant explicitly chose that code.
  Self-service codes land in the same `referral_codes` table as
  admin-created ones (distinguished only by `created_by =
  'self-service'`) and work identically everywhere. Visiting
  `/open-account?ref=<code>` or `/dangote-ipo/subscribe?ref=<code>`
  pre-fills the referral field automatically (reading the `ref` query
  param on load), taking priority even over a resumed in-progress
  session, since clicking a shared link is a clear, explicit signal.
- **Public stats — `/referral-status`, OTP-gated**: knowing the code
  alone is no longer enough — an agent requests a 6-digit verification
  code (`request-referral-otp.js`), which is emailed to whatever
  address is on file for that code (never a self-claimed one, which is
  what makes the gate meaningful), then enters it to complete the
  lookup (`referral-lookup.js`, now requiring `{code, otp}` instead of
  just `{code}`). OTPs are sha-256 hashed before storage (never kept in
  plain text), expire after 10 minutes, allow at most 5 incorrect
  attempts before requiring a fresh one, and are single-use. A 60-second
  cooldown prevents re-sending if a still-valid OTP was just requested.
  **Codes with no email on file are blocked from lookup entirely** —
  every code that existed before this feature shipped has no email yet
  and needs one added from `/admin`'s "Add email" action before anyone
  can check it. Once verified, the agent sees two counts — **BGL
  accounts opened** (only applications that reached `opened` status,
  not every application referred) and **Dangote IPO subscribers**
  (every IPO subscription referred, at any status) — plus the
  underlying lists of each, matched by **either the code or the
  agent's own name** (some applicants type the referrer's name instead
  of their code — see "Referral attribution" above in Account opening).
  Only a safe subset of fields is ever returned per record (reference,
  name, type, status — never email, banking details, documents, or
  **commission figures**, which are admin-only).
- **Commission — admin only**: the "Referral codes" tab in `/admin`
  additionally shows, per code, **accounts opened**, **IPO
  subscribers**, and **commission owed** — 0.25% of the total amount
  payable across that code's IPO subscriptions that have reached
  `payment_confirmed` or later (`payment_confirmed`,
  `pending_execution`, `executed`, `allotted` all count; each of
  those statuses implies payment was verified at `payment_confirmed`
  and never gets un-verified moving forward — `payment_pending` and
  `payment_unconfirmed` don't count, since there's no confirmed
  payment yet). A footer row totals the commission owed across every
  code. This is computed client-side in the admin page from the same
  RLS-permitted authenticated reads already used elsewhere in
  `/admin` — no new backend endpoint, and no commission ledger table;
  if an audit trail of individual commission events becomes necessary
  later, that's the natural next step, but wasn't needed for this
  version.

## Dangote IPO subscription

`/dangote-ipo` is the public campaign page (offer terms, FAQ, waitlist).
The offer opened 14 September 2026, and the page links to
`/dangote-ipo/subscribe`, a multi-step wizard for actually subscribing
to units — Individual, Corporate, or Joint — built from BGL's official
Investor Application Form for the offer. It reuses the exact same
mechanics as `/open-account`: shared brand CSS/nav/footer, session
persistence to `sessionStorage` across accidental mobile reloads,
documents uploaded directly to Supabase Storage via signed URLs, and
required-field/required-document validation that only enforces
currently-visible fields. A second button, "Less than 50,000 units?
Subscribe here", sits alongside the main "Subscribe to the IPO" button
(same visibility toggle) and links out to `publicoffers.bglafrica.com`
for subscribers below BGL's own minimum.

- **Offer terms**: ₦525 per unit, 50,000-unit minimum, then
  multiples of 10 above that — enforced both client-side (live Naira
  calculation as units are entered) and server-side in
  `submit-ipo-subscription.js`. If the terms change for a future offer,
  update both the wizard's participation step and that server-side
  check together, plus the hero/FAQ copy on `/dangote-ipo` itself.
- **Fields collected**: investor type; participation (units + computed
  amount payable + optional "Referred by"); investor or corporate
  identity details; joint applicant details (joint only); CSCS/
  stockbroker info (CHN, stockbroker name, member code, defaulting to
  "BGL"); Naira banking details (bank, account number, BVN); and three
  required documents — signature, valid ID, payment evidence.
- **Document uploads**: same signed-URL pattern as account opening,
  but into a separate private bucket, `ipo-documents`, via
  `upload-url.js` (passing `domain: 'ipo'`) — kept separate from
  `application-documents` since these are a different document set
  tied to a different table.
- **Submission**: `submit-ipo-subscription.js` validates the unit-count
  rule again server-side (never trust the client-computed amount),
  writes the subscription to `ipo_subscriptions` starting at status
  `payment_pending` (schema in `supabase/ipo_subscriptions.sql`), logs
  the initial row to `ipo_subscription_status_history`, and sends a
  Brevo confirmation email to the applicant plus an internal alert —
  same non-fatal-email-failure pattern as account opening, so a flaky
  send never blocks a real submission.
  - **Supabase setup**: run `supabase/ipo_subscriptions.sql` once
    against the same Supabase project as the rest of the site (adds
    `ipo_subscriptions`, `ipo_subscription_documents`,
    `ipo_subscription_status_history`, `ipo_notify_signups`, and their
    RLS policies), then `supabase/migration_ipo_referral.sql`,
    `supabase/migration_ipo_payment_account.sql`, and
    `supabase/migration_ipo_payment_account_multicurrency.sql`, and
    create a private Storage bucket named `ipo-documents`.
- **Status pipeline**: `payment_pending` → `payment_confirmed` or
  `payment_unconfirmed` (applicant emailed either way) →
  `pending_execution` → `executed` → `allotted`. Enforced in
  `update-status.js` (passing `domain: 'ipo'`), admin-only (same
  Supabase Auth bearer-token check as the account-applications side of
  that same file). Marking
  **payment_unconfirmed** requires a note of at least 5 characters
  (emailed to the applicant so they know what to fix); marking
  **allotted** requires a final units-allotted number. `pending_execution`
  intentionally sends no email — a quiet intermediate step between
  payment confirmation and execution.
- **Admin review**: `/admin` has a "Dangote IPO" tab — a "Payment
  account" form at the top (bank name, account name, and separate
  NGN/USD/GBP account numbers, shown publicly on the wizard's
  Participation step and success screen — see "Payment account"
  below), a list of subscriptions (filterable by status, searchable by
  name/email/reference, showing units and amount payable, exportable
  to CSV), a detail view (investor/corporate/joint-applicant info —
  including state/LGA of origin — CSCS & banking details, uploaded
  documents via short-lived signed URLs, and full status history), and
  the status-change actions described above. Same pattern as the
  "Account applications" tab: the admin page never writes
  `ipo_subscriptions` directly, only `update-status.js` does, using
  the service role key.
  - **No resend-notification action yet** for IPO subscriptions —
    unlike account applications, there's no
    `resend-ipo-notification.js` endpoint. If that's needed later,
    build it the same way `resend-notification.js` works: re-send
    whatever email matches the subscription's *current* stored status,
    not new input.
- **Notify-me opt-in**: both `/dangote-ipo` and `/dangote-ipo/subscribe`
  have a "Get email updates on the offer" link opening a lightweight
  modal (name + email + optional phone) for visitors not ready to
  subscribe yet. Backed by the public `ipo-notify-signup.js`, writing
  to `ipo_notify_signups` — a separate table from the site's general
  waitlist, since these are specifically people who want IPO updates.
- **Offer-open gating**: the offer opened 14 September 2026, 00:00
  WAT. `IPO_OFFER_OPENS_AT` (same constant, duplicated in
  `/dangote-ipo`, `/dangote-ipo/subscribe`, and both copies of
  `submit-ipo-subscription.js`) hides the "Subscribe" button and
  blocks the wizard before that moment, showing "Get notified"
  instead — self-updating on the day itself, no redeploy needed. The
  frontend checks are a UI convenience only; `submit-ipo-subscription.js`
  rejects submissions with a 403 before the opening moment regardless
  of what the frontend shows, since that's what actually matters for
  a subscription involving real money. If the date ever changes,
  update all four copies of the constant together.
- **Payment account (admin-managed, multi-currency)**: the bank
  details subscribers should pay into live in the single-row
  `ipo_payment_account` table (`supabase/migration_ipo_payment_account.sql`,
  then `supabase/migration_ipo_payment_account_multicurrency.sql`),
  editable from a form at the top of the "Dangote IPO" tab in
  `/admin` — admin writes it directly from the browser via the
  authenticated Supabase client, same pattern as Learn articles and
  referral codes, since there's no side effect like an email to
  trigger. Bank name and account name are shared fields (BGL's real
  accounts all sit at the same bank under the same account name);
  only the account number differs per currency — `account_number`
  (NGN), `account_number_usd`, `account_number_gbp`. Shown in two
  places, both via the **public anon key** (no login needed) since
  bank account numbers for receiving payment are meant to be shared
  publicly, same as a business posting them for bank transfers: the
  Participation step (where units are entered — reads on render via
  `renderPaymentDetails('participationPaymentDetails')`, letting
  someone see where to pay before they even decide how many units
  to buy) and the success screen after submission (unchanged trigger,
  now showing all three currencies via the same shared function).
  If none of the three account numbers are filled in yet, both
  places fall back to pointing people at the IPO helpline instead of
  showing a blank card.

## Deploying

This repo deploys to Netlify — publish directory is the repo root, no
build command needed (see `netlify.toml`). Folder-based pages (`/waitlist`,
`/dangote-ipo`, `/learn`, `/open-account`) rely on their `index.html` files
for clean URLs, so keep that structure intact.

As of the account opening feature, this site must be deployed via a
**Git-connected Netlify site** (Netlify → Site settings → Build & deploy →
Link to a Git repository), not the manual drag-and-drop dropzone — the
functions under `netlify/functions/` only deploy through a Git-connected
build (or the Netlify CLI), never through drag-and-drop. Once connected,
every `git push` to `main` deploys automatically.

### Testing risky changes on a staging branch first

`main` deploys straight to the live, real-money site, so anything that
touches money or a live pipeline (the IPO subscription flow,
commission math, status transitions) should go through a staging
branch first rather than landing on `main` directly:

```
git checkout -b staging/<short-description>
# ... build and commit the change ...
git push origin staging/<short-description>
```

Both Netlify and Vercel automatically build a **preview deployment**
for any pushed branch (Netlify: Site settings → Build & deploy →
Deploy contexts; Vercel does this by default) — that preview URL
behaves exactly like production (same functions, same Supabase
project, since there's no separate staging database) except it's not
the domain anyone else is using. Test the change there; only merge
the branch into `main` once it looks right. This doesn't isolate test
data — a submission made on a preview URL still lands in the same
production tables as a real one — but it does mean a half-finished or
broken change is never live on `tippingpoint.bglafrica.com` while it's
being built.

### Runs on Netlify or Vercel, without code changes

This repo supports **both** platforms simultaneously:

- **Netlify**: functions live in `netlify/functions/`, configured via
  `netlify.toml`.
- **Vercel**: the same functions are duplicated (in Vercel's own
  `(req, res)` handler format, since Netlify and Vercel use different
  function signatures) under `api/`, which Vercel auto-detects with no
  config needed beyond `vercel.json` (which handles the `/learn/:slug`
  and `/interest/:slug` clean-URL rewrites — folder-based clean URLs
  like `/open-account` work automatically on Vercel too). Vercel's
  shared helpers live in a top-level `lib/` directory — sibling to
  `api/`, not nested inside it — not `api/utils/` the way Netlify's
  do; see "Vercel Hobby's 12-function limit" below for why.

**Watch `cleanUrls` + rewrite destinations together**: this
`vercel.json` sets `"cleanUrls": true`, which strips `.html` from
every static file's URL at build time — a rewrite destination still
written as `/interest/index.html` or `/learn/article.html` silently
404s, because that exact path no longer exists under that name by the
time the rewrite runs at the edge. Destinations here are written
without the extension (`/interest/index`, `/learn/article`) for
exactly this reason — confirmed against Vercel's own docs ("If
cleanUrls is set to true... do not include the file extension in the
source or destination path") after this broke the interest-form page
in production.

The frontend always calls the platform-neutral path `/api/<function-name>`
— never `/.netlify/functions/...` directly. On Vercel this resolves
natively. On Netlify, `_redirects` rewrites `/api/*` to the matching
function under `/.netlify/functions/*`. This means the same frontend
code works unmodified on whichever platform is actually live — useful
if you ever need to switch (e.g. Netlify's free-tier credits running
out), since no HTML/JS needs to change, only where the site is deployed
and its DNS target.

**If you add or change a function**, update it in both places:
`netlify/functions/<name>.js` (Netlify's `exports.handler = async (event) => {...}`
style) and `api/<name>.js` (Vercel's `module.exports = async (req, res) => {...}`
style). The shared helpers are plain Node (no platform-specific code)
and should stay identical in content between platforms — but they
live in *different places* on each: `netlify/functions/utils/` for
Netlify, `lib/` (top-level, not nested under `api/`) for Vercel. Don't
put a new Vercel helper file under `api/utils/` — it will silently
count toward Vercel's 12-function cap even though it isn't a real
endpoint; see below.

To deploy on Vercel instead of Netlify: create a Vercel account, import
this GitHub repo as a new project, set the same environment variables
listed above (Vercel → Project Settings → Environment Variables), deploy,
verify on the `*.vercel.app` preview URL, then point `tippingpoint.bglafrica.com`'s
DNS at Vercel (Vercel's domain settings will show the exact records to add).

### Vercel Hobby's 12-function limit

Vercel's free (Hobby) plan caps a deployment at **12 Serverless
Functions**, counted from **every file directly under `api/`,
including subfolders — this counts files under `api/utils/` too**,
despite them being imported helpers rather than their own endpoints.
That assumption cost real time to track down: the deployment kept
failing with "No more than 12 Serverless Functions" even when the
literal endpoint count looked comfortably under the cap, because
`api/utils/brevo.js`, `supabaseClient.js`, and `ipoEmail.js` were each
silently adding to Vercel's real count. Confirmed against Vercel's own
team guidance (a GitHub discussion response: "we recommend using a
directory outside of `/api` for any files that should not be created
as Serverless Functions") — the fix was moving all three to a
top-level `lib/` directory, sibling to `api/`, not nested inside it.
This repo currently sits at **10** real endpoint files under `api/`
— comfortably under, but worth knowing before adding new ones, and
worth remembering that a shared helper file belongs in `lib/`, never
back under `api/`, regardless of how it's named or nested.

Two originally-separate endpoint pairs were merged into one file each
specifically to stay under this cap:

- `upload-url.js` — merged from the account-opening and Dangote IPO
  upload-URL functions (`create-upload-url.js` + `ipo-create-upload-url.js`).
  Takes a `domain: 'account' | 'ipo'` field in the request body to pick
  the right storage bucket and required fields.
- `update-status.js` — merged from the account-opening and Dangote IPO
  status-update functions (`update-application-status.js` +
  `update-ipo-status.js`). Takes a `domain: 'account' | 'ipo'` field;
  internally it's still two fully separate handler functions
  (`handleApplicationStatus` / `handleIpoStatus`) sharing only the
  admin-auth check — merging the *file* was what mattered for the
  function count, not merging the logic.
- `referral-lookup.js` — merged from `referral-lookup.js` and
  `request-referral-otp.js`, since adding the OTP endpoint as a 10th
  function broke every deployment even before the `api/utils/`
  discovery above (the build completed but failed during "Deploying
  outputs" — Vercel's actual internal count doesn't reliably match
  the literal file count on its own, so merging is the safe fix
  rather than trying to find the exact number that's actually safe).
  Dispatches on whether `otp` is present in the request body — `{code}`
  to request a code, `{code, otp}` to verify one and get the lookup
  results — rather than an explicit `action` field, since the two
  calls already have naturally different shapes.

**If a future feature needs a genuinely new endpoint**, either extend
one of these two dispatcher files with another `domain` value if it's
a natural fit (another upload flow, another status pipeline), or add a
new file if it's not — just keep an eye on the count staying under 12
if this project is still on Vercel Hobby. `find api -type f -not -path
"*/utils/*" | wc -l` gives the current count. The `netlify/functions/`
copy of each file must stay in sync either way (see "Runs on Netlify
or Vercel" above) — Netlify has no equivalent function-count cap, so
this constraint is Vercel-specific.
