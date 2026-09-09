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
const places = require('./places');
const { validatePage, validateProject } = require('./orchestratorValidate');
const { planSiteLocal, profileBrief } = require('./generate');
const {
  PALETTES,
  pickPalette,
  pickLayout,
  collectPhotoDataUris,
  renderSitePage
} = require('./siteTemplate');

// Kept only for backward compatibility with anything reading this export —
// the GENERATE stage no longer retries a model call, so it no longer
// applies, but MAX_GENERATION_ITERATIONS/ORCHESTRATOR_CONCURRENCY env vars
// are otherwise undocumented breaking changes for zero benefit.
const MAX_GENERATION_ITERATIONS = Math.max(0, Number(process.env.MAX_GENERATION_ITERATIONS) || 3);
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

// Provider selection + the paid-Claude-usage approval gate now live in
// server/providerPolicy.js, shared with server/chat.js so the whole app
// enforces exactly one policy instead of two that could drift apart.
const {
  pickReasoningProvider,
  needsClaudeDecision,
  getClaudeStatus,
  setClaudeApproval
} = require('./providerPolicy');

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
                  headline: {
                    type: 'string',
                    description: 'The EXACT heading text to display on the page, ready to publish as-is, e.g. "Comfort today. Better tomorrow." Never a description of what the heading should say, and never a label like "Headline:".'
                  },
                  body: {
                    type: 'string',
                    description: 'The EXACT paragraph text to display on the page, ready to publish as-is — one or two real, finished sentences. Never a description, summary, or restatement of the headline/cta. WRONG: "Hero headline: \'Comfort today.\' Subline: \'Better tomorrow.\' CTA: \'Book now\'." RIGHT: "Safe, all-inclusive stay so you can focus on work."'
                  },
                  cta: {
                    type: 'string',
                    description: 'The exact button label only, e.g. "Book a visit" — two to four words, never a full sentence and never a label like "CTA:".'
                  }
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
          properties: {
            type: { type: 'string', description: 'hero | about | products | gallery | testimonial | contact | faq | cta' },
            headline: {
              type: 'string',
              description: 'The EXACT heading text to display on the page, ready to publish as-is. Never a description of what the heading should say, and never a label like "Headline:".'
            },
            body: {
              type: 'string',
              description: 'The EXACT paragraph text to display on the page, ready to publish as-is — one or two real, finished sentences. Never a description, summary, or restatement of the headline/cta (e.g. never write "Headline: \'...\' Subline: \'...\' CTA: \'...\'").'
            },
            cta: {
              type: 'string',
              description: 'The exact button label only, e.g. "Book a visit" — two to four words, never a full sentence and never a label like "CTA:".'
            }
          }
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
// content safety — strip AI-authored meta-commentary about the site's OWN
// state (e.g. the "Photos Needed for Refresh" bug: a model wrote a hero
// that told the visitor it needed photos, instead of writing marketing
// copy) before any such text ever reaches a rendered page. Prompt-level
// instructions below tell the model not to do this, but a model can still
// get it wrong — this regex backstop is the actual guarantee: it runs on
// every section, from every path (initial plan AND every later "modify"
// request), and swaps in safe generic copy for just the offending field(s)
// rather than failing the whole job. Defense in depth, not a replacement
// for the prompt instructions.
// ---------------------------------------------------------------------------

const META_COMMENTARY_RE = new RegExp(
  [
    'photos?\\s+(needed|required|missing|not\\s+(?:yet\\s+)?(?:uploaded|available|provided))',
    'no\\s+(photos?|images?)\\s+(available|found|on file|yet|provided)',
    'please\\s+(upload|provide|add)\\s',
    'we\\s+need\\s+access\\s+to',
    'need\\s+access\\s+to\\s+the\\s+(saved|business)',
    'image\\s+urls?\\s+so\\s+(we|you)\\s+can',
    'complete\\s+this\\s+refresh',
    'saved\\s+business\\s+profile',
    // Narrowed to the site/page ITSELF being unfinished, not a business's own
    // "new arrivals coming soon" marketing copy — that phrase is completely
    // normal, legitimate retail copy and must not be flagged.
    '(this\\s+(page|section|site)|website|content)\\s+is\\s+(coming\\s+soon|under\\s+construction|not\\s+ready)',
    'under\\s+construction',
    'lorem\\s+ipsum',
    '\\bTBD\\b',
    'placeholder\\s+(text|copy|content|image)',
    'this\\s+section\\s+will\\s+be',
    'content\\s+coming\\s+soon'
  ].join('|'),
  'i'
);

function hasMetaCommentary(text) {
  return typeof text === 'string' && META_COMMENTARY_RE.test(text);
}

// Safe, generic-but-real fallback copy for a section whose AI-authored
// text tripped the check above — keyed by section type, personalized with
// whatever real profile facts are on hand so it never reads as a stock
// placeholder itself.
function fallbackCopyForType(type, profile) {
  const name = (profile && profile.business) || 'This business';
  const category = (profile && profile.placeInfo && profile.placeInfo.category) ||
    (profile && profile.category) || 'local business';
  switch (type) {
    case 'hero':
      return {
        headline: `${name} — Quality You Can Count On`,
        body: `${name} is a ${category} dedicated to serving customers with care and consistency, every visit.`,
        cta: 'Get in Touch'
      };
    case 'gallery':
    case 'products':
      return {
        headline: 'A Look at What We Offer',
        body: `Here's a look at what makes ${name} worth a visit.`,
        cta: 'View More'
      };
    case 'about':
      return {
        headline: `About ${name}`,
        body: `${name} is committed to delivering a great experience for every customer, every time.`,
        cta: 'Learn More'
      };
    case 'contact':
      return {
        headline: 'Get in Touch',
        body: `Reach out to ${name} — we'd love to hear from you.`,
        cta: 'Contact Us'
      };
    default:
      return {
        headline: `Discover ${name}`,
        body: `${name} is here to help — reach out to learn more about what we offer.`,
        cta: 'Contact Us'
      };
  }
}

function sanitizeSection(section, profile) {
  if (!section || typeof section !== 'object') return section;
  const badHeadline = hasMetaCommentary(section.headline);
  const badBody = hasMetaCommentary(section.body);
  const badCta = hasMetaCommentary(section.cta);
  if (!badHeadline && !badBody && !badCta) return section;
  const fallback = fallbackCopyForType(section.type, profile);
  return Object.assign({}, section, {
    headline: badHeadline ? fallback.headline : section.headline,
    body: badBody ? fallback.body : section.body,
    cta: badCta ? fallback.cta : (section.cta || fallback.cta)
  });
}

function sanitizeSections(sections, profile) {
  return Array.isArray(sections) ? sections.map((s) => sanitizeSection(s, profile)) : sections;
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
    p.sections = sanitizeSections(p.sections, profile);
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
    aeo_geo_strategy: {
      faq: base.aeoFaq || [],
      local_notes: profile.placeInfo && profile.placeInfo.formattedAddress
        ? `Verified Google Business Profile on file — ${places.placeSummaryLine(profile.placeInfo)}.`
        : profile.map ? 'Has a map/location link on file.' : 'No map/location link on file yet — add one to strengthen local search.'
    },
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
          'the design system, and SEO/AEO/GEO strategy. You never write code or design the visuals — a hand-crafted ' +
          'BrixOS template turns your plan into the actual page, so focus entirely on content and structure being ' +
          'specific, real, and worth reading. Be concrete and specific to this business; avoid generic filler a plan ' +
          'for any random shop could also use — use real specifics from what you were given (services, location, ' +
          'materials, hours, pricing) wherever possible instead of vague phrases like "quality and service". Never ' +
          'invent fake customer reviews, fake testimonials, fake awards, or fake press mentions — for a "testimonial" ' +
          'section, only use a real quote if one was actually provided (e.g. from an uploaded document); otherwise ' +
          'use a genuine trust angle instead (years in business, a guarantee, a real number) or skip that section ' +
          'type entirely. If a fact isn\'t given, list it under missing_information instead of inventing it. The ' +
          'seo_strategy.keywords array should be 3-5 short, real phrases about this specific business (e.g. ' +
          '"handmade pottery", "Austin TX", "walk-ins welcome") — they double as a highlight strip on the homepage, ' +
          'so keep each one under 25 characters and concrete. Each section\'s headline/body/cta fields must contain ' +
          'the FINAL, literal text to display on the page — never a description of what that text should say. For ' +
          'example, if a hero should announce "Furnished PG for Gents in Bangalore — 3 Meals a Day" with the sub-line ' +
          '"Safe, all-inclusive stay so you can focus on work" and a "Call to Book" button, write EXACTLY that: ' +
          'headline = "Furnished PG for Gents in Bangalore — 3 Meals a Day", body = "Safe, all-inclusive stay so you ' +
          'can focus on work.", cta = "Call to Book". Do NOT write something like headline = "Your All-Inclusive PG ' +
          'in Bangalore" with body = "Hero headline: \'Furnished PG for Gents...\'. Subline: \'Safe, all-inclusive ' +
          'stay...\'. CTA: \'Call to Book\'." — that meta-description format is wrong and must never appear. Never ' +
          'write copy that comments on the website\'s OWN state or on BrixOS\'s process — never say photos are ' +
          'needed, missing, or "coming soon"; never ask the user to upload, provide, or paste anything; never say ' +
          '"under construction" or use placeholder text like "TBD". If photos are missing, simply write copy that ' +
          'does not depend on photos being present — the template already renders a graceful placeholder graphic ' +
          'automatically, so your job is only ever to write genuine, ready-to-publish marketing copy. Always ' +
          'call submit_orchestrator_plan exactly once.',
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

// Every page's actual HTML/CSS now comes from server/siteTemplate.js's
// hand-crafted, curated template — never from asking a model to author raw
// markup. `generation` (the OpenRouter/Claude provider picked for this job)
// is intentionally unused for per-page HTML anymore; the plan's own copy
// (already written by the reasoning stage when available, or by the local
// deterministic planner otherwise) is all the content a page needs. This
// removes what used to be the single biggest source of inconsistent output
// AND unreliability: free models are fine at deciding what a business
// should say (the PLANNING stage still uses one), but inconsistent at
// hand-authoring a whole page's design from scratch — and a dud response
// there used to silently fall back to a much plainer page. A deterministic
// template can't return a dud response, and it always passes validatePage()
// by construction (real doctype/title/viewport, every planned headline
// literally present), so there's no FIX-loop left to run here.
function buildPageHtml(task, plan, profile, allTasks, palette, photos, homeSlug, layoutId) {
  return renderSitePage({ task, plan, profile, allTasks, palette, homeSlug, photos, layoutId });
}

function stageGenerateValidateFix(job, tasks, plan, profile, palette, photos, homeSlug, layoutId) {
  logStage(job, 'GENERATING', 'Generating your pages…');
  const pages = {};
  const models = {};

  tasks.forEach((task) => {
    const html = buildPageHtml(task, plan, profile, tasks, palette, photos, homeSlug, layoutId);
    const result = validatePage(html, task);
    if (!result.ok) {
      // Should be unreachable with a deterministic template — kept as a
      // visible signal rather than a silent swallow, in case a future
      // template change ever breaks validatePage()'s structural checks.
      job.log.push({
        stage: 'VALIDATING',
        message: `"${task.title}" has unexpected structural issues: ${result.errors.join(' ')}`,
        at: new Date().toISOString()
      });
    }
    pages[task.slug] = html;
    models[task.slug] = { model: `template:${palette.id}`, source: 'brixos-template' };
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
    job.reasoningProvider = reasoning ? reasoning.provider : 'local';
    job.generationProvider = 'brixos-template';

    const score = computeScores(profile);
    const study = await stageStudy(job, profile, score);

    const { plan, model: plannerModel } = await stagePlan(job, profile, score, study, reasoning);
    job.plannerModel = plannerModel;

    // Design system pick — deterministic, based on business category/tone,
    // never the model's own design taste (see server/siteTemplate.js).
    // Persisted onto the plan so a later modification job reuses the exact
    // same palette instead of re-deriving it (and potentially drifting if
    // the business_understanding wording changes on a re-plan).
    const palette = pickPalette(profile, plan);
    plan.design_system.paletteId = palette.id;
    // Structural layout variant — a second, deterministically-picked
    // template beyond the single hand-crafted layout (see
    // siteTemplate.js's pickLayout), persisted here for the same reason
    // paletteId is: so a later "modify" job never reshuffles a project's
    // structure out from under it.
    const layout = pickLayout(palette);
    plan.design_system.layoutId = layout.id;
    const photos = collectPhotoDataUris(profile);
    job.plan = plan;

    const tasks = stageArchitect(job, plan);
    const homeSlug = plan.pages.some((p) => p.slug === 'index') ? 'index' : plan.pages[0].slug;
    const { pages, models, projectWarnings } = stageGenerateValidateFix(job, tasks, plan, profile, palette, photos, homeSlug, layout.id);
    job.builderModel = `template:${palette.id}:${layout.id}`;

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
    job.reasoningProvider = reasoning ? reasoning.provider : 'local';
    job.generationProvider = 'brixos-template';

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
            'unrelated sections as they are, only change what the user asked for. Every section\'s headline/body/cta ' +
            'must be the FINAL, literal text to display on the page, ready to publish as-is — never a description ' +
            'of what that text should say (e.g. never write something like "Headline: \'...\' Subline: \'...\' CTA: ' +
            '\'...\'"). Never write copy that comments on the website\'s own state or on BrixOS\'s process — never ' +
            'say photos are needed/missing/"coming soon", never ask the user to upload or provide content, never ' +
            'say "under construction". Call submit_page_update exactly once.',
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

    updatedSections = sanitizeSections(updatedSections, profile);
    const targetPageIndex = plan.pages.findIndex((p) => p.slug === targetSlug);
    plan.pages[targetPageIndex] = Object.assign({}, plan.pages[targetPageIndex], { sections: updatedSections });

    const task = { slug: targetSlug, title: plan.pages[targetPageIndex].title, navLabel: plan.pages[targetPageIndex].nav_label, sections: updatedSections };
    const allTasks = plan.pages.map((p) => ({ slug: p.slug, navLabel: p.nav_label, title: p.title }));
    const homeSlug = plan.pages.some((p) => p.slug === 'index') ? 'index' : plan.pages[0].slug;

    // Reuse the exact palette this project was originally generated with
    // (persisted on plan.design_system.paletteId — see runJob) rather than
    // re-deriving it, so a copy tweak never accidentally reshuffles the
    // whole site's visual identity.
    const palette = PALETTES[plan.design_system && plan.design_system.paletteId] || pickPalette(profile, plan);
    const layoutId = (plan.design_system && plan.design_system.layoutId) || pickLayout(palette).id;
    const photos = collectPhotoDataUris(profile);

    logStage(job, 'GENERATING', `Updating "${task.title}"…`);
    const html = buildPageHtml(task, plan, profile, allTasks, palette, photos, homeSlug, layoutId);
    const result = validatePage(html, task);
    if (!result.ok) {
      job.log.push({ stage: 'VALIDATING', message: `"${task.title}" has unexpected structural issues: ${result.errors.join(' ')}`, at: new Date().toISOString() });
    }

    project.pages[targetSlug] = html;
    project.plan = plan;
    project.generatedAt = new Date().toISOString();
    profile.generatedProject = project;

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
