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

## How it's put together

```
server/
  index.js     Express app — every /api/* route
  db.js        JSON-file persistence (swap this for Postgres/Mongo later
               without touching the routes)
  score.js     The presence score model — single source of truth,
               mirrored (read-only) in public/app.js for the signed-out demo
  validate.js  Format-only validation for every profile field
public/
  index.html   Markup
  styles.css   All styling
  app.js       All client-side behavior — auth, the "+" menu, uploads,
               the live score card
uploads/       Where uploaded photos/files actually land
data/          Where db.json lives
```

## What's real vs. what's a placeholder

**Real:** accounts (bcrypt-hashed passwords, sessions), the presence score
(calculated server-side from your actual profile, using the 7-dimension
weighted model your team specified), photo/file uploads (image-only for
Photos, a slightly wider allow-list for Files), and every link/text field —
all persisted to `data/db.json` and reloaded on refresh or next login.

**Placeholder, by design:** BrixOS does **not** verify that a pasted
Instagram/Facebook/website link actually resolves to a real, matching
business — it only checks that the link is *shaped* like one. Verifying the
link is real is the BrixOS analysis engine's job (the "Scan" stage), not the
intake form's. The "Generated preview" panel and the Scan/Analyze/Generate
pipeline are illustrative — there's no real crawler behind them yet.

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
