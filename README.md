# BrixOS — Presence Engine

A local, full-stack build of the BrixOS concept: an AI presence scanner that
scores a retail business's digital footprint and previews an improved,
BrixOS-generated storefront.

This is a real app, not a mockup — accounts, uploaded photos/files, and every
profile field are written to disk and reloaded on your next visit.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

- `npm run dev` restarts the server automatically when you edit files under `server/`.
- Data lives in `data/db.json` (created on first run). Uploaded photos and
  files are saved under `uploads/photos/` and `uploads/files/`.
- Delete `data/db.json` at any time to reset all accounts and profiles.
- To turn on **"Generate my site"** (see below), copy `.env.example` to
  `.env`, add your own `ANTHROPIC_API_KEY`, and restart the server. The app
  runs fine without it — that one button just stays disabled-by-error until
  a key is set.

## How it's put together

```
server/
  index.js     Express app — every /api/* route
  db.js        JSON-file persistence (swap this for Postgres/Mongo later
               without touching the routes)
  score.js     The presence score model — single source of truth,
               mirrored (read-only) in public/app.js for the signed-out demo
  validate.js  Format-only validation for every profile field
  generate.js  The site-generation agent pipeline (see below)
public/
  index.html   Markup
  styles.css   All styling
  app.js       All client-side behavior — auth, the "+" menu, uploads,
               the live score card, the generated-site preview
uploads/       Where uploaded photos/files actually land
data/          Where db.json lives
```

## Site generation — the Planner → Builder pipeline

Clicking **"Generate my site"** calls `POST /api/generate`, which runs two
separate Claude calls in `server/generate.js`:

1. **Planner** — reads your saved profile (business name, links, upload
   counts, current score) and decides *what the site should say*: section
   order, copy direction, tone, an accent color, and SEO/AEO metadata. It
   never writes code — its output is a small structured plan (forced
   through a tool call, so it's always valid JSON, not something scraped
   out of prose).
2. **Builder** — takes that plan (not your raw profile) and writes one
   complete, self-contained HTML file for the rebuilt homepage.

They're two calls on purpose, not one: a single prompt asked to both judge
what a small business needs *and* hand-write clean HTML tends to do a worse
job at each than two focused prompts do. It also means the plan is a small,
inspectable, reusable thing — worth showing on its own or reusing later —
rather than being buried inside a page of markup.

The result (`plan` + `html`) is saved on your profile as `generatedSite` and
reloads with the rest of your account. The preview panel drops the returned
HTML into a sandboxed `<iframe>` (`sandbox="allow-scripts"`, no
`allow-same-origin`) so a generated page can still run its own small
interactive touches without being able to read your BrixOS session or
cookies.

Both model calls default to `claude-sonnet-4-5-20250929` and are
independently overridable via `BRIXOS_PLANNER_MODEL` / `BRIXOS_BUILDER_MODEL`
(or `BRIXOS_MODEL` for both) in `.env` — see `.env.example`. If a request
ever fails with a "model not found" error, that's the one line to update;
check https://docs.claude.com/en/docs/about-claude/models for the current
identifier.

## What's real vs. what's a placeholder

**Real:** accounts (bcrypt-hashed passwords, sessions), the presence score
(calculated server-side from your actual profile, using the 7-dimension
weighted model your team specified), photo/file uploads (image-only for
Photos, a slightly wider allow-list for Files), and every link/text field —
all persisted to `data/db.json` and reloaded on refresh or next login.

Also real, once you set `ANTHROPIC_API_KEY` (see above): the **"Generate my
site"** button runs a real two-agent pipeline (`server/generate.js`) and the
"Generated preview" panel renders the actual HTML it produces.

**Placeholder, by design:** BrixOS does **not** verify that a pasted
Instagram/Facebook/website link actually resolves to a real, matching
business — it only checks that the link is *shaped* like one. Verifying the
link is real is the BrixOS analysis engine's job (the "Scan" stage), not the
intake form's. The "Scan" and "Analyze" stages in the three-step pipeline
graphic are still illustrative — BrixOS doesn't crawl your existing site or
listings yet, it works from what you type into the "+" menu. There's also no
real hosting yet — "Generate" builds the page, it doesn't deploy it anywhere.

**Signed out:** the page shows a self-contained demo ("Aurora Boutique")
so the page is never empty — nothing you do while signed out is saved.
Sign in (or create an account) to switch to your real, persisted profile.

## Security notes for anything beyond local use

This is built for local use and small teams, not as a production-hardened
public deployment. Before exposing it beyond your own machine:

- Set a real `SESSION_SECRET` environment variable (a long random string) —
  the code ships with an obvious placeholder default.
- Put it behind HTTPS and set `cookie.secure: true` in `server/index.js`.
- Swap the JSON-file store in `server/db.js` for a real database — a plain
  file has no concurrent-write protection.
- The session store is in-memory (`express-session`'s default), which means
  everyone gets logged out on every server restart — swap in a persistent
  session store for anything longer-lived.
