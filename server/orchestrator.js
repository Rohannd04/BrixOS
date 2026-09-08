// ---------------------------------------------------------------------------
// BrixOS Orchestrator — the central controller behind "Generate my site".
//
//   UNDERSTAND -> RESEARCH -> PLAN -> ARCHITECT -> GENERATE -> VALIDATE
//     -> FIX (iterate, capped) -> PREVIEW
//
// Provider roles (server/llm.js's direct, per-stage calls — see the comment
// there for why this is separate from the existing chatOnce()/runToolLoop()
// used by generate.js/chat.js):
//   - Claude is the REASONING engine — understanding the request, studying
//     the business, planning the site's architecture, and (during a later
//     change request) deciding what a follow-up instruction means. It is
//     NEVER called unless this user has explicitly approved paid Claude
//     usage for their account (profile.claudeApprovalGranted) — see
//     requireClaudeDecision()/AWAITING_APPROVAL below. That is a hard rule,
//     not a preference: BrixOS must not spend a user's paid API credits
//     without asking first.
//   - OpenRouter is the GENERATION worker — turning an approved plan into
//     actual page HTML. It needs no approval gate: BrixOS only ever asks it
//     for OpenRouter's free-tier models (see server/llm.js).
//   - If neither is usable for a given stage (not configured, or Claude
//     configured but not yet approved/declined), that stage falls back to a
//     deterministic, local, no-API-key implementation, reusing
//     server/generate.js's existing local Planner/Builder templates where
//     the shape matches — "Generate my site" always produces *something*,
//     exactly like the rest of BrixOS already promises.
//
// Jobs run asynchronously, tracked in an in-memory Map and polled by the
// frontend (GET /api/orchestrator/jobs/:id) — this is a single-instance
// prototype, same caveat server/db.js already states about the JSON file
// store: swap this for a real job queue/database before running more than
// one server instance. The RESULT of a finished job is persisted to
// profile.generatedProject / profile.generatedSite in data/db.json, same as
// the rest of the app, so it survives independently of the in-memory job.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const llm = require('./llm');
const { readDB, writeDB, getProfile } = require('./db');
const { computeScores } = require('./score');
const { EDITABLE_FIELDS } = require('./validate');
const { auditWebsite, auditImprovements } = require('./audit');
const { validatePage, validateProject } = require('./orchestratorValidate');
const { planSiteLocal, profileBrief } = require('./generate');

const MAX_GENERATION_ITERATIONS = Math.max(0, Number(process.env.MAX_GENERATION_ITERATIONS) || 3);
const GENERATION_CONCURRENCY = Math.max(1, Number(process.env.ORCHESTRATOR_CONCURRENCY) || 3);
const JOB_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// job store
// ---------------------------------------------------------------------------

const jobs = new Map();

function newJob(userId, mode) {
  const job = {
    id: crypto.randomUUID(),
    userId,
    mode: mode || 'generate', // 'generate' | 'modify'
    status: 'QUEUED',
    message: 'Queued…',
    log: [],
    iteration: 0,
    plan: null,
    pages: null,
    result: null,
    error: null,
    reasoningProvider: null,
    generationProvider: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  jobs.set(job.id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function logStage(job, stage, message) {
  job.log.push({ stage, message, at: new Date().toISOString() });
  updateJob(job, { status: stage, message });
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'READY' || job.status === 'FAILED') && now - new Date(job.updatedAt).getTime() > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
const sweepTimer = setInterval(sweepJobs, 15 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

// Small, client-safe view of a job — used by every route that hands job
// state back to the frontend, so a full page's HTML doesn't have to round
// -trip on every single poll (the client already gets the final HTML via
// the normal profile/preview payload once the job reaches READY).
function jobSummary(job) {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    message: job.message,
    log: job.log.slice(-30),
    iteration: job.iteration,
    error: job.error,
    reasoningProvider: job.reasoningProvider,
    generationProvider: job.generationProvider,
    profile: job.status === 'READY' && job.result ? job.result.profile : undefined,
    score: job.status === 'READY' && job.result ? job.result.score : undefined
  };
}

// ---------------------------------------------------------------------------
// provider selection
// ---------------------------------------------------------------------------

// Reasoning (understand/study/plan/interpret-change-requests): Claude if
// configured AND this account has approved paid usage, else the free
// OpenRouter path, else null (caller uses a local, deterministic fallback).
function pickReasoningProvider(profile) {
  if (llm.claudeConfigured() && profile.claudeApprovalGranted === true) {
    return { provider: 'claude', call: llm.callClaudeDirect };
  }
  if (llm.openRouterConfigured()) {
    return { provider: 'openrouter', call: llm.callOpenRouterDirect };
  }
  return null;
}

// Generation (writing actual page HTML): OpenRouter first — that's the
// point of using an open-source/free model as the "worker" — falling back
// to Claude only if OpenRouter isn't configured but Claude is approved
// (better to generate with a paid model the user already said yes to than
// not generate at all).
function pickGenerationProvider(profile) {
  if (llm.openRouterConfigured()) {
    return { provider: 'openrouter', call: llm.callOpenRouterDirect };
  }
  if (llm.claudeConfigured() && profile.claudeApprovalGranted === true) {
    return { provider: 'claude', call: llm.callClaudeDirect };
  }
  return null;
}

// Claude is configured server-side but this account has never said yes or
// no yet — BrixOS must ask before spending anything, exactly once per
// account (the decision is then remembered on the profile).
function needsClaudeDecision(profile) {
  return llm.claudeConfigured() && profile.claudeApprovalGranted === null;
}

function getClaudeStatus(userId) {
  const db = readDB();
  const profile = getProfile(db, userId);
  return { configured: llm.claudeConfigured(), approved: profile.claudeApprovalGranted };
}

function setClaudeApproval(userId, approve) {
  const db = readDB();
  const profile = getProfile(db, userId);
  profile.claudeApprovalGranted = Boolean(approve);
  writeDB(db);
  return { configured: llm.claudeConfigured(), approved: profile.claudeApprovalGranted };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function stripFences(text) {
  return String(text || '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const ORCHESTRATOR_PLAN_TOOL = {
  name: 'submit_orchestrator_plan',
  description: "Submit the structured, multi-page architecture plan for this business's rebuilt website.",
  input_schema: {
    type: 'object',
    required: ['project_type', 'business_understanding', 'pages', 'design_system', 'seo_strategy'],
    properties: {
      project_type: { type: 'string', description: 'e.g. "retail storefront", "restaurant", "service business"' },
      business_understanding: { type: 'string', description: 'What you understood about this business and what it needs.' },
      pages: {
        type: 'array',
        description: '2-5 pages. Exactly one page must use slug "index" (the homepage).',
        items: {
          type: 'object',
          required: ['slug', 'title', 'nav_label', 'sections'],
          properties: {
            slug: { type: 'string', description: 'lowercase-hyphenated, e.g. "index", "about", "contact"' },
            title: { type: 'string' },
            nav_label: { type: 'string' },
            purpose: { type: 'string' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                required: ['type', 'headline', 'body'],
                properties: {
                  type: { type: 'string', description: 'hero | about | products | gallery | testimonial | contact | faq | cta' },
                  headline: { type: 'string' },
                  body: { type: 'string' },
                  cta: { type: 'string' }
                }
              }
            }
          }
        }
      },
      design_system: {
        type: 'object',
        required: ['accentColor', 'tone'],
        properties: { accentColor: { type: 'string' }, tone: { type: 'string' }, fontPairing: { type: 'string' } }
      },
      seo_strategy: {
        type: 'object',
        required: ['title', 'description', 'keywords'],
        properties: { title: { type: 'string' }, description: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } }
      },
      aeo_geo_strategy: {
        type: 'object',
        properties: {
          faq: { type: 'array', items: { type: 'object', required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
          local_notes: { type: 'string' }
        }
      },
      responsive_requirements: { type: 'string' },
      missing_information: {
        type: 'array',
        items: { type: 'string' },
        description: 'Facts BrixOS could not verify or was not given — call these out explicitly instead of inventing them.'
      }
    }
  }
};

const MODIFY_PAGE_TOOL = {
  name: 'submit_page_update',
  description: "Decide which existing page a change request applies to, and that page's FULL updated section list.",
  input_schema: {
    type: 'object',
    required: ['slug', 'sections'],
    properties: {
      slug: { type: 'string', description: 'Which existing page slug this change applies to.' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type', 'headline', 'body'],
          properties: { type: { type: 'string' }, headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }
        }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// stage: STUDYING (understand + research)
// ---------------------------------------------------------------------------

async function stageStudy(job, profile, score) {
  logStage(job, 'STUDYING', 'Studying your business and existing online presence…');
  let audit = profile.siteAudit;
  if (profile.website && (!audit || !audit.ok)) {
    audit = await auditWebsite(profile.website);
  }
  const missing = EDITABLE_FIELDS.filter((f) => !profile[f]);
  const brief = profileBrief(Object.assign({}, profile, { siteAudit: audit })) +
    '\n\nCurrent BrixOS presence score: ' + (score && score.selectedCount ? score.overall + '/100' : 'not yet scored') +
    (missing.length ? '\n\nNot provided — do not invent these, call them out as gaps instead: ' + missing.join(', ') : '');
  return { audit, brief, missing };
}

// ---------------------------------------------------------------------------
// stage: PLANNING
// ---------------------------------------------------------------------------

function normalizePlan(raw, profile) {
  const pages = Array.isArray(raw.pages) ? raw.pages.filter((p) => p && p.slug && Array.isArray(p.sections) && p.sections.length) : [];
  if (!pages.length) return null;

  // slugs must be unique and URL-safe; exactly one page is the homepage
  const seen = new Set();
  pages.forEach((p) => {
    p.slug = String(p.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    while (seen.has(p.slug)) p.slug += '-2';
    seen.add(p.slug);
    p.nav_label = p.nav_label || p.title || p.slug;
  });
  if (!pages.some((p) => p.slug === 'index')) pages[0].slug = 'index';

  return {
    project_type: raw.project_type || 'small business website',
    business_understanding: raw.business_understanding || '',
    pages,
    navigation: pages.map((p) => p.nav_label),
    design_system: Object.assign({ accentColor: '#B5622E', tone: 'warm and approachable' }, raw.design_system || {}),
    seo_strategy: raw.seo_strategy || { title: profile.business || 'Your Business', description: '', keywords: [] },
    aeo_geo_strategy: raw.aeo_geo_strategy || { faq: [], local_notes: '' },
    responsive_requirements: raw.responsive_requirements || 'Mobile-first, single column below 640px.',
    missing_information: Array.isArray(raw.missing_information) ? raw.missing_information : []
  };
}

function localMultiPagePlan(profile, score, study) {
  const base = planSiteLocal(profile, score);
  const hero = base.sections.find((s) => s.type === 'hero');
  const about = base.sections.find((s) => s.type === 'about');
  const products = base.sections.find((s) => s.type === 'products');
  const contact = base.sections.find((s) => s.type === 'contact');

  const pages = [
    { slug: 'index', title: base.siteName, nav_label: 'Home', purpose: 'Homepage', sections: [hero, products].filter(Boolean) },
    { slug: 'about', title: 'About — ' + base.siteName, nav_label: 'About', purpose: 'About page', sections: [about].filter(Boolean) },
    { slug: 'contact', title: 'Contact — ' + base.siteName, nav_label: 'Contact', purpose: 'Contact page', sections: [contact].filter(Boolean) }
  ].filter((p) => p.sections.length);

  return {
    project_type: 'small business website',
    business_understanding: study.brief,
    pages,
    navigation: pages.map((p) => p.nav_label),
    design_system: { accentColor: base.accentColor, tone: base.tone },
    seo_strategy: base.seo,
    aeo_geo_strategy: { faq: base.aeoFaq || [], local_notes: profile.map ? 'Has a map/location link on file.' : 'No map/location link on file yet — add one to strengthen local search.' },
    responsive_requirements: 'Mobile-first, single column below 640px.',
    missing_information: study.missing || []
  };
}

async function stagePlan(job, profile, score, study, reasoning) {
  logStage(job, 'PLANNING', 'Creating your website architecture…');

  if (reasoning) {
    try {
      const { toolInput, model } = await reasoning.call({
        role: 'planner',
        system:
          'You are the BrixOS Orchestrator\'s Planning Engine. Given a small retail business\'s profile, decide the ' +
          'full multi-page architecture for its rebuilt website: which pages it needs (2-5), what each page says, ' +
          'the design system, and SEO/AEO/GEO strategy. You never write code — only structure, copy direction, and ' +
          'metadata. Be concrete and specific to this business; avoid generic filler. If a fact isn\'t given, list it ' +
          'under missing_information instead of inventing it. Always call submit_orchestrator_plan exactly once.',
        userText: 'Here is everything currently known about this business:\n\n' + study.brief + '\n\nPlan its rebuilt website now.',
        tools: [ORCHESTRATOR_PLAN_TOOL],
        forceToolName: 'submit_orchestrator_plan',
        maxTokens: 2500
      });
      const plan = toolInput && normalizePlan(toolInput, profile);
      if (plan) return { plan, model, source: reasoning.provider };
      job.log.push({ stage: 'PLANNING', message: 'Reasoning provider returned an unusable plan — using a local plan instead.', at: new Date().toISOString() });
    } catch (err) {
      job.log.push({ stage: 'PLANNING', message: `Reasoning provider failed (${err.message}) — using a local plan instead.`, at: new Date().toISOString() });
    }
  }

  return { plan: localMultiPagePlan(profile, score, study), model: 'local-template', source: 'local' };
}

// ---------------------------------------------------------------------------
// stage: ARCHITECTING
// ---------------------------------------------------------------------------

function stageArchitect(job, plan) {
  logStage(job, 'ARCHITECTING', 'Breaking the site down into pages and components…');
  return plan.pages.map((p) => ({ slug: p.slug, title: p.title, navLabel: p.nav_label, sections: p.sections }));
}

// ---------------------------------------------------------------------------
// stage: GENERATING (+ VALIDATING / FIXING per page)
// ---------------------------------------------------------------------------

function contactLinksHtml(profile) {
  const links = [];
  if (profile.website) links.push(`<a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">Website</a>`);
  if (profile.instagram) links.push(`<a href="${escapeHtml(profile.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (profile.facebook) links.push(`<a href="${escapeHtml(profile.facebook)}" target="_blank" rel="noopener">Facebook</a>`);
  if (profile.map) links.push(`<a href="${escapeHtml(profile.map)}" target="_blank" rel="noopener">Map</a>`);
  if (profile.gmail) links.push(`<a href="mailto:${escapeHtml(profile.gmail)}">Email</a>`);
  return links;
}

// Inline guard script embedded in every generated page. BrixOS's own
// preview renders a page inside a sandboxed `srcdoc` iframe (no
// allow-same-origin) so the user can see it without ever leaving the app.
// Relative links like "contact.html" inside a srcdoc document resolve
// against the OUTER embedding page's real URL though, and clicking one
// makes the iframe navigate itself to that (nonexistent, server-side) route
// — producing a raw "Cannot GET /contact.html" instead of staying inside
// the preview. This script only disarms internal .html links while the
// page is actually embedded (window.self !== window.top); once the site is
// exported as a ZIP and the files are opened directly in a browser,
// window.self === window.top and every link works exactly as a normal,
// real website's would.
const PREVIEW_SAFE_NAV_SCRIPT = `<script>
(function(){
  if (window.self === window.top) return;
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^[a-zA-Z0-9_-]+\\.html(#.*)?$/.test(href)) { e.preventDefault(); }
  }, true);
})();
</` + `script>`;

// Dependency-free, no-API-key page template — used whenever neither
// OpenRouter nor an approved Claude is available. Deliberately plain but
// real: every planned section actually renders, the nav links to every
// other real page, and it passes the same validatePage() checks a model's
// output would have to.
function renderLocalPage(task, plan, profile, allTasks) {
  const accent = (plan.design_system && plan.design_system.accentColor) || '#B5622E';
  const navHtml = allTasks.map((t) => `<a href="${t.slug}.html">${escapeHtml(t.navLabel)}</a>`).join('');
  const sectionsHtml = (task.sections || []).map((s, i) => `
    <section>
      <${i === 0 ? 'h1' : 'h2'}>${escapeHtml(s.headline)}</${i === 0 ? 'h1' : 'h2'}>
      <p>${escapeHtml(s.body)}</p>
      ${s.cta ? `<a class="btn" href="contact.html">${escapeHtml(s.cta)}</a>` : ''}
    </section>`).join('');
  const links = contactLinksHtml(profile);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(task.title)}</title>
<meta name="description" content="${escapeHtml((plan.seo_strategy && plan.seo_strategy.description) || task.title)}">
<style>
  :root { --accent: ${accent}; --bg: #F7F1E6; --panel: #fff; --text: #1E1912; --text-muted: #67594A; --border: rgba(33,27,20,.1); }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 20px 6vw; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
  .brand { font-weight: 700; font-size: 20px; }
  nav a { color: var(--text); text-decoration: none; margin-right: 18px; font-size: 14px; }
  section { padding: 40px 6vw; max-width: 880px; margin: 0 auto; }
  h1 { font-size: clamp(28px, 5vw, 44px); }
  h2 { font-size: 26px; }
  p { color: var(--text-muted); line-height: 1.6; }
  .btn { display: inline-block; background: var(--text); color: var(--bg); padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; margin-top: 10px; }
  footer { padding: 28px 6vw; border-top: 1px solid var(--border); text-align: center; color: var(--text-muted); font-size: 14px; }
</style>
</head>
<body>
  <header>
    <div class="brand">${escapeHtml(plan.pages && plan.pages[0] ? plan.pages[0].title : 'Your Business')}</div>
    <nav>${navHtml}</nav>
  </header>
  ${sectionsHtml}
  <footer>${links.length ? links.join(' &middot; ') + ' &middot; ' : ''}Built with BrixOS</footer>
  ${PREVIEW_SAFE_NAV_SCRIPT}
</body>
</html>`;
}

const ORCHESTRATOR_BUILDER_SYSTEM =
  'You are the BrixOS Orchestrator\'s Generation Worker. You receive one page of a structured, multi-page site ' +
  'plan and turn it into a single, complete, self-contained HTML file — production-quality, mobile-first, and ' +
  'accessible.\nRules:\n' +
  '- Output ONLY the raw HTML file, starting with <!doctype html> and nothing before or after it — no markdown ' +
  'code fences, no commentary.\n' +
  '- Inline all CSS in a <style> tag and all JS in a <script> tag — no external stylesheets or scripts except ' +
  'Google Fonts.\n' +
  '- Include a <nav> that links every other page in this project using the exact relative hrefs given to you ' +
  '(e.g. "about.html", "index.html").\n' +
  '- Do not invent fake customer reviews, fake awards, or fake press mentions, and do not invent business facts ' +
  'that were listed as missing — use only what is given.\n' +
  '- Include semantic HTML (a real <h1> for the first section), a viewport meta tag, and on-page SEO (title, meta ' +
  'description) from the given SEO fields.\n' +
  '- Do not add any click handlers that call preventDefault() on internal navigation links — BrixOS handles ' +
  'preview-safe navigation itself by injecting its own script into the file after you return it.';

// Deterministically ensures every generated page — model output or local
// template — carries the preview-safe-navigation guard, regardless of
// whether the model followed the system prompt. Inserted just before
// </body> (case-insensitive); appended at the end as a fallback if a
// generated file is missing a closing </body> tag.
function injectPreviewSafeNavScript(html) {
  if (!html) return html;
  if (html.includes(PREVIEW_SAFE_NAV_SCRIPT)) return html;
  const closeBodyMatch = html.match(/<\/body\s*>/i);
  if (closeBodyMatch) {
    const idx = html.lastIndexOf(closeBodyMatch[0]);
    return html.slice(0, idx) + PREVIEW_SAFE_NAV_SCRIPT + '\n' + html.slice(idx);
  }
  return html + PREVIEW_SAFE_NAV_SCRIPT;
}

async function generatePageHtml(task, plan, allTasks, profile, generation, fixNotes) {
  if (generation) {
    const navList = allTasks.map((t) => `${t.navLabel} -> ${t.slug}.html`).join(', ');
    const userText = [
      'Full project plan (JSON), for context on the whole site:',
      JSON.stringify(plan, null, 2),
      '',
      `Now write the complete HTML file for the "${task.title}" page (slug: "${task.slug}").`,
      'Site navigation — link every one of these on this page, using these exact hrefs: ' + navList,
      'Contact/link details to weave in where relevant:\n' + profileBrief(profile),
      fixNotes ? '\nThe previous attempt at this page had these problems — fix them specifically:\n' + fixNotes : ''
    ].filter(Boolean).join('\n\n');

    const { text, model } = await generation.call({
      role: 'builder',
      system: ORCHESTRATOR_BUILDER_SYSTEM,
      userText,
      maxTokens: 6000
    });
    const html = stripFences(text);
    if (html) return { html: injectPreviewSafeNavScript(html), model, source: generation.provider };
    // fall through to local template if the model returned nothing usable
  }
  return { html: renderLocalPage(task, plan, profile, allTasks), model: 'local-template', source: 'local' };
}

async function stageGenerateValidateFix(job, tasks, plan, profile, generation) {
  logStage(job, 'GENERATING', 'Generating your pages…');
  const pages = {};
  const models = {};

  await runWithConcurrency(tasks, GENERATION_CONCURRENCY, async (task) => {
    let html, model, source;
    let fixNotes = null;

    for (let attempt = 0; attempt <= MAX_GENERATION_ITERATIONS; attempt++) {
      const gen = await generatePageHtml(task, plan, tasks, profile, generation, fixNotes);
      html = gen.html; model = gen.model; source = gen.source;

      const result = validatePage(html, task);
      if (result.ok) break;

      if (attempt === MAX_GENERATION_ITERATIONS) {
        job.log.push({
          stage: 'VALIDATING',
          message: `"${task.title}" still has issues after ${attempt + 1} attempt(s), showing the best version: ${result.errors.join(' ')}`,
          at: new Date().toISOString()
        });
        break;
      }

      job.iteration = Math.max(job.iteration, attempt + 1);
      logStage(job, 'FIXING', `Fixing issues on "${task.title}" (attempt ${attempt + 2} of ${MAX_GENERATION_ITERATIONS + 1})…`);
      fixNotes = result.errors.join('\n');
    }

    pages[task.slug] = html;
    models[task.slug] = { model, source };
  });

  logStage(job, 'VALIDATING', 'Checking links between pages…');
  const projectCheck = validateProject(pages, plan);
  return { pages, models, projectWarnings: projectCheck.warnings };
}

// ---------------------------------------------------------------------------
// stage: PREVIEW (persist + hand back to the existing BrixOS UI)
// ---------------------------------------------------------------------------

function stagePreview(job, profile, db, plan, pages, models) {
  const homeSlug = plan.pages.some((p) => p.slug === 'index') ? 'index' : plan.pages[0].slug;
  const homeHtml = pages[homeSlug];
  const homePagePlan = plan.pages.find((p) => p.slug === homeSlug) || plan.pages[0];

  // Backward-compatible shape for the EXISTING single-file preview iframe
  // (public/app.js:renderPreview()) and the older /api/generate endpoint —
  // both stay completely untouched by this Orchestrator work; this just
  // feeds them the Orchestrator's home-page result in the shape they
  // already expect.
  profile.generatedSite = {
    plan: {
      siteName: homePagePlan.title || profile.business || 'Your Business',
      tagline: plan.business_understanding ? String(plan.business_understanding).slice(0, 160) : '',
      sections: homePagePlan.sections || [],
      seo: plan.seo_strategy
    },
    html: homeHtml,
    generatedAt: new Date().toISOString(),
    plannerModel: job.plannerModel || 'orchestrator',
    builderModel: job.builderModel || 'orchestrator'
  };

  profile.generatedProject = {
    plan,
    pages,
    pageModels: models,
    generatedAt: new Date().toISOString(),
    reasoningProvider: job.reasoningProvider,
    generationProvider: job.generationProvider
  };

  writeDB(db);
  return profile;
}

// ---------------------------------------------------------------------------
// top-level: full generation run
// ---------------------------------------------------------------------------

async function runJob(job) {
  try {
    const db = readDB();
    const profile = getProfile(db, job.userId);

    // Approval gate — checked ONCE, right at the top, before any reasoning
    // stage is even attempted. Asking here (rather than only once GENERATE
    // needs a provider) means the user isn't left waiting through
    // STUDYING/PLANNING only to be interrupted for a decision midway.
    if (needsClaudeDecision(profile)) {
      updateJob(job, {
        status: 'AWAITING_APPROVAL',
        message: 'Claude API usage may incur charges for this operation. Do you want to continue with Claude API?'
      });
      return;
    }

    const reasoning = pickReasoningProvider(profile);
    const generation = pickGenerationProvider(profile);
    job.reasoningProvider = reasoning ? reasoning.provider : 'local';
    job.generationProvider = generation ? generation.provider : 'local';

    const score = computeScores(profile);
    const study = await stageStudy(job, profile, score);

    const { plan, model: plannerModel } = await stagePlan(job, profile, score, study, reasoning);
    job.plannerModel = plannerModel;
    job.plan = plan;

    const tasks = stageArchitect(job, plan);
    const { pages, models, projectWarnings } = await stageGenerateValidateFix(job, tasks, plan, profile, generation);
    const builtModels = Object.values(models);
    job.builderModel = builtModels.length ? builtModels[0].model : 'local-template';

    stagePreview(job, profile, db, plan, pages, models);
    job.pages = pages;
    job.result = { profile, score: computeScores(profile) };
    if (projectWarnings.length) {
      job.log.push({ stage: 'READY', message: projectWarnings.join(' '), at: new Date().toISOString() });
    }
    updateJob(job, { status: 'READY', message: 'Your site is ready.' });
  } catch (err) {
    console.error('[BrixOS Orchestrator] job failed:', err);
    updateJob(job, { status: 'FAILED', message: 'Generation failed: ' + err.message, error: err.message });
  }
}

function startGeneration(userId) {
  const job = newJob(userId, 'generate');
  runJob(job).catch((err) => console.error('[BrixOS Orchestrator] unhandled job error:', err));
  return job;
}

// ---------------------------------------------------------------------------
// user modification loop — "change the hero", "add testimonials", etc.
// Only the affected page is understood, updated, regenerated and
// re-validated; everything else in the project is left untouched.
// ---------------------------------------------------------------------------

async function runModifyJob(job, instruction) {
  try {
    const db = readDB();
    const profile = getProfile(db, job.userId);
    const project = profile.generatedProject;
    if (!project) {
      updateJob(job, { status: 'FAILED', message: 'No generated site to modify yet — generate one first.', error: 'NO_GENERATED_SITE' });
      return;
    }

    if (needsClaudeDecision(profile)) {
      updateJob(job, {
        status: 'AWAITING_APPROVAL',
        message: 'Claude API usage may incur charges for this operation. Do you want to continue with Claude API?'
      });
      job.pendingInstruction = instruction;
      return;
    }

    const reasoning = pickReasoningProvider(profile);
    const generation = pickGenerationProvider(profile);
    job.reasoningProvider = reasoning ? reasoning.provider : 'local';
    job.generationProvider = generation ? generation.provider : 'local';

    logStage(job, 'PLANNING', 'Understanding the requested change…');
    const plan = project.plan;
    let targetSlug = plan.pages[0].slug;
    let updatedSections = null;

    if (reasoning) {
      try {
        const { toolInput } = await reasoning.call({
          role: 'planner',
          system:
            'You are the BrixOS Orchestrator handling a follow-up change request on an already-generated website. ' +
            'Decide which existing page it applies to and return that page\'s FULL, updated section list — keep ' +
            'unrelated sections as they are, only change what the user asked for. Call submit_page_update exactly once.',
          userText:
            'Existing pages: ' + plan.pages.map((p) => `${p.slug} (sections: ${p.sections.map((s) => s.headline).join(', ')})`).join(' | ') +
            '\n\nUser\'s request: ' + instruction,
          tools: [MODIFY_PAGE_TOOL],
          forceToolName: 'submit_page_update',
          maxTokens: 1200
        });
        if (toolInput && toolInput.slug && Array.isArray(toolInput.sections) && toolInput.sections.length) {
          targetSlug = plan.pages.some((p) => p.slug === toolInput.slug) ? toolInput.slug : targetSlug;
          updatedSections = toolInput.sections;
        }
      } catch (err) {
        job.log.push({ stage: 'PLANNING', message: `Reasoning provider failed on the change request (${err.message}) — applying a simple local update instead.`, at: new Date().toISOString() });
      }
    }

    if (!updatedSections) {
      // No model available to creatively reinterpret the request — rather
      // than silently dropping it or pretending to understand, add it as a
      // plain, visible note on the target page.
      const targetPage = plan.pages.find((p) => p.slug === targetSlug) || plan.pages[0];
      targetSlug = targetPage.slug;
      updatedSections = targetPage.sections.concat([{ type: 'note', headline: 'Requested update', body: instruction }]);
      job.log.push({ stage: 'PLANNING', message: 'No AI reasoning provider available — added your request as a plain note instead of rewriting the page.', at: new Date().toISOString() });
    }

    const targetPageIndex = plan.pages.findIndex((p) => p.slug === targetSlug);
    plan.pages[targetPageIndex] = Object.assign({}, plan.pages[targetPageIndex], { sections: updatedSections });

    const task = { slug: targetSlug, title: plan.pages[targetPageIndex].title, navLabel: plan.pages[targetPageIndex].nav_label, sections: updatedSections };
    const allTasks = plan.pages.map((p) => ({ slug: p.slug, navLabel: p.nav_label }));

    logStage(job, 'GENERATING', `Updating "${task.title}"…`);
    let html;
    let fixNotes = null;
    for (let attempt = 0; attempt <= MAX_GENERATION_ITERATIONS; attempt++) {
      const gen = await generatePageHtml(task, plan, allTasks, profile, generation, fixNotes);
      html = gen.html;
      const result = validatePage(html, task);
      if (result.ok || attempt === MAX_GENERATION_ITERATIONS) break;
      job.iteration = Math.max(job.iteration, attempt + 1);
      logStage(job, 'FIXING', `Fixing "${task.title}" (attempt ${attempt + 2} of ${MAX_GENERATION_ITERATIONS + 1})…`);
      fixNotes = result.errors.join('\n');
    }

    project.pages[targetSlug] = html;
    project.plan = plan;
    project.generatedAt = new Date().toISOString();
    profile.generatedProject = project;

    const homeSlug = plan.pages.some((p) => p.slug === 'index') ? 'index' : plan.pages[0].slug;
    if (targetSlug === homeSlug && profile.generatedSite) {
      profile.generatedSite = Object.assign({}, profile.generatedSite, {
        html,
        generatedAt: new Date().toISOString(),
        plan: Object.assign({}, profile.generatedSite.plan, { sections: updatedSections })
      });
    }

    writeDB(db);
    job.pages = project.pages;
    job.result = { profile, score: computeScores(profile) };
    updateJob(job, { status: 'READY', message: `Updated "${task.title}".` });
  } catch (err) {
    console.error('[BrixOS Orchestrator] modify job failed:', err);
    updateJob(job, { status: 'FAILED', message: 'Update failed: ' + err.message, error: err.message });
  }
}

function startModification(userId, instruction) {
  const job = newJob(userId, 'modify');
  runModifyJob(job, instruction).catch((err) => console.error('[BrixOS Orchestrator] unhandled modify error:', err));
  return job;
}

// Called once the user answers the paid-Claude-usage prompt for a job that
// was paused in AWAITING_APPROVAL. Persists the decision on their account
// (so they aren't asked again — see profile.claudeApprovalGranted) and
// resumes exactly the run that was waiting on it.
function resumeAfterApproval(jobId, approve) {
  const job = getJob(jobId);
  if (!job) return null;
  setClaudeApproval(job.userId, approve);
  if (job.status !== 'AWAITING_APPROVAL') return job;

  if (job.mode === 'modify') {
    runModifyJob(job, job.pendingInstruction).catch((err) => console.error('[BrixOS Orchestrator] unhandled resume error:', err));
  } else {
    runJob(job).catch((err) => console.error('[BrixOS Orchestrator] unhandled resume error:', err));
  }
  return job;
}

module.exports = {
  MAX_GENERATION_ITERATIONS,
  startGeneration,
  startModification,
  resumeAfterApproval,
  getJob,
  jobSummary,
  getClaudeStatus,
  setClaudeApproval
};
