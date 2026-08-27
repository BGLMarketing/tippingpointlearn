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

## Learn page — current status

`/learn` is a placeholder. The real feature (admin can create articles and set
their visibility to draft / published / unpublished) needs a decision on
architecture before it's built — a static site alone can't safely support
in-browser content editing, since any credential that lets someone publish
content would be exposed to every visitor if it lived in the page itself.
See the conversation this repo came from for the options under discussion.

## Deploying

This repo deploys to Netlify as a static site — no build command needed,
publish directory is the repo root. Folder-based pages (`/waitlist`,
`/dangote-ipo`, `/learn`) rely on their `index.html` files for clean URLs, so
keep that structure intact.
