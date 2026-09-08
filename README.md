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
  generate.js  The one-shot Planner -> Builder pipeline (see below) — also
               the Orchestrator's local, no-API-key fallback templates
  chat.js      The console's chat agent (see below)
  llm.js       Model provider abstraction (Anthropic / OpenRouter) shared
               by generate.js, chat.js, and the Orchestrator
  orchestrator.js         The BrixOS Orchestrator — the real, multi-page,
                          validate/fix/iterate pipeline (see below)
  orchestratorValidate.js Structural validation for a generated page
  orchestratorRoutes.js   /api/orchestrator/* routes
  zipBuilder.js           Dependency-free ZIP writer, used by ZIP export
  audit.js     Live website audit (server/audit.js's own header has details)
public/
  index.html   Markup
  styles.css   All styling
  app.js       All client-side behavior — auth, the "+" menu, uploads,
               the live score card, the generated-site preview, chat
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

This one-shot `/api/generate` endpoint still exists exactly as described
above (nothing about it changed) — it's what the Orchestrator below now
uses under the hood as its local, no-API-key fallback template.

## The BrixOS Orchestrator — the real, multi-page pipeline behind the button

Clicking **"Generate my site"** actually runs `server/orchestrator.js`, a
central controller that turns a business profile into a real, validated,
multi-page website:

```
UNDERSTAND -> RESEARCH -> PLAN -> ARCHITECT -> GENERATE -> VALIDATE
  -> FIX (iterate, capped) -> PREVIEW
```

- **UNDERSTAND / RESEARCH ("Studying…")** — pulls together everything on
  file for the business, plus a live audit of its existing website if it
  has one (`server/audit.js`), and explicitly lists what's *missing* rather
  than letting a later stage invent it.
- **PLAN ("Creating your website architecture…")** — decides the site's
  full page list (home, about, contact, ...), each page's sections and
  copy direction, a design system (accent color, tone), and SEO/AEO/GEO
  strategy — forced through a tool call, so it's always structured, valid
  JSON, never scraped out of prose.
- **ARCHITECT ("Breaking the site into pages…")** — turns that plan into a
  concrete generation task per page.
- **GENERATE ("Generating your pages…")** — writes each page's actual HTML.
  Independent pages generate concurrently (`ORCHESTRATOR_CONCURRENCY`,
  default 3) rather than one at a time.
- **VALIDATE ("Checking your site for issues…")** — a real, dependency-free
  structural check per page (`server/orchestratorValidate.js`): a
  `<!doctype html>`, a non-empty `<title>`, a mobile viewport tag,
  balanced `<html>`/`<head>`/`<body>`/`<script>`/`<style>` tags, no
  leftover `{{ template }}` placeholders, and that the sections the plan
  actually asked for showed up on the page — plus a cross-page check that
  every nav link actually points at a page that exists.
- **FIX ("Fixing issues it found…")** — a page that fails validation gets
  sent back to the generation step with the specific errors, up to
  `MAX_GENERATION_ITERATIONS` times (default 3), before BrixOS gives up and
  shows its best attempt rather than looping forever.
- **PREVIEW** — the finished project is saved to your profile as
  `generatedProject` (every page's HTML, plus the plan) and its home page
  feeds the same `generatedSite` / preview `<iframe>` the simpler pipeline
  above already used — nothing about the preview panel itself changed.

Because a full run can take a little while, `POST /api/orchestrator/generate`
returns immediately with a job id and does the work in the background;
the page polls `GET /api/orchestrator/jobs/:id` every ~1.2s and shows the
current stage ("Studying your business…", "Fixing issues it found…", ...)
above the preview panel until it's done.

### Two providers, two different jobs

- **Claude is the reasoning engine** — understanding the request, studying
  the business, planning the architecture, and interpreting follow-up
  change requests. **It is never called unless you've explicitly approved
  paid Claude usage for your account.** The first time BrixOS would need
  it, generation pauses and asks: *"Claude API usage may incur charges for
  this operation. Do you want to continue with Claude API?"* — your answer
  (`POST /api/orchestrator/claude-approval` or the same prompt mid-job) is
  remembered on your account (`profile.claudeApprovalGranted`) so you're
  only asked once. Say no and BrixOS falls back to OpenRouter/local
  instead of failing outright. If `ANTHROPIC_API_KEY` isn't set at all,
  there's nothing paid to ask about and this never comes up.
- **OpenRouter is the generation worker** — turning an approved plan into
  actual page HTML, using the same free-tier auto-selection described
  below. No approval needed; BrixOS only ever asks it for free models.
- Neither configured (or Claude declined with no OpenRouter key)? Every
  stage falls back to the same deterministic, local, no-API-key templates
  the rest of BrixOS already uses — you still get a real multi-page site,
  just from templates instead of a model.

This is a genuinely pluggable provider setup
(`server/llm.js`'s `callClaudeDirect`/`callOpenRouterDirect`, independent of
which single provider `chatOnce`/`runToolLoop` use for the older Planner/
Builder/chat pipeline) — adding a third provider later means writing one
more `call*Direct`-shaped function, not restructuring the orchestrator.

### Making a change afterward

Once a site exists, `POST /api/orchestrator/modify` with `{ "instruction":
"..." }` (e.g. *"make the hero more premium"*, *"add a testimonials
section"*) figures out which existing page that applies to, regenerates
**only that page**, validates/fixes it the same way, and leaves every other
page untouched — it never rebuilds the whole site for a one-line request.

### Exporting the result

`GET /api/orchestrator/export` ("Download ZIP" in the UI) packages every
generated page into a real `.zip` (`server/zipBuilder.js` — a small,
dependency-free ZIP writer using Node's built-in `zlib` for compression, not
a new npm package) that opens in any unzip tool. This is the fallback/output
option for when you want the actual files rather than just the in-app
preview — useful today since BrixOS doesn't host the generated site anywhere
itself yet (see "What's real vs. what's a placeholder" below).

## Chat — a third agent, at the console

The console at the top of the page (type + Enter, or click one of the
example chips) is a real chat with a Claude agent, not a script — it calls
`POST /api/chat` (`server/chat.js`), which is a genuine back-and-forth with
the Anthropic API, same as talking to Claude or ChatGPT directly. It shares
`ANTHROPIC_API_KEY` with the generation pipeline, so nothing extra to
configure once that's set — and no new dependency either, it reuses the
`@anthropic-ai/sdk` package the Planner/Builder pipeline already added.

It's a third agent, separate from Planner/Builder, and it can *act*, not
just talk — it has two tools:

- `save_profile_field` — the same format-only checks as the "+" menu
  (`server/validate.js`). Tell it "my instagram is instagram.com/yourstore"
  in plain conversation and it saves it exactly like pasting it in the
  popover would.
- `generate_site` — runs the same Planner → Builder pipeline as the button.
  Ask it to "build my site" and it does, using whatever's already on your
  profile — the result shows up in the preview panel exactly like clicking
  the button.

Replies stream into the chat log as bubbles and type themselves out — the
typing effect is a client-side reveal of the finished reply (real
token-by-token streaming through a tool-calling loop is a lot more moving
parts for a prototype; this gets the same feel with far less to break).
Chat history is kept in the browser only, for the current page load — it's
not saved to your profile, so it starts fresh on reload (the profile fields
and generated site it produces along the way *are* saved, as always).

## What's real vs. what's a placeholder

**Real:** accounts (bcrypt-hashed passwords, sessions), the presence score
(calculated server-side from your actual profile, using the 7-dimension
weighted model your team specified), photo/file uploads (image-only for
Photos, a slightly wider allow-list for Files), and every link/text field —
all persisted to `data/db.json` and reloaded on refresh or next login.

Also real: the **"Generate my site"** button runs the actual BrixOS
Orchestrator (`server/orchestrator.js`) — a real multi-page plan, real
per-page generation, real structural validation with an actual fix/retry
loop, and a real ZIP export (`server/zipBuilder.js`) you can open in any
unzip tool. With neither `ANTHROPIC_API_KEY` nor `OPENROUTER_API_KEY` set,
every stage runs on deterministic local templates instead of a model call —
still a real, validated, multi-page result, just not model-written copy.
Set either key (see above) to get real model-written plans and pages; set
`ANTHROPIC_API_KEY` specifically and you'll be asked, once, whether BrixOS
may spend paid Claude credits on your account's runs before it ever does.

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
