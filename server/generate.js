// ---------------------------------------------------------------------------
// BrixOS site generation pipeline — two agents, one job each.
//
//   1. Planner — reads the business's raw profile (whatever links, name and
//      uploads it has, however sparse) and decides what the rebuilt site
//      should say: sections, copy direction, SEO/AEO metadata. Its only job
//      is judgment. Output is a small structured JSON plan, produced by
//      forcing a tool call so it's always valid, parseable JSON.
//
//   2. Builder — takes that plan (never the raw profile directly) and
//      writes the actual single-file HTML/CSS/JS site. Its only job is
//      code, not business judgment.
//
// They're kept as two separate model calls on purpose:
//   - Each prompt stays focused — a prompt asking a model to both figure out
//     what a business needs AND hand-write clean HTML tends to do a worse
//     job at both than two focused prompts.
//   - The plan is a reusable, inspectable artifact — it's cheap to show the
//     user "here's what BrixOS is about to build" or to regenerate just the
//     HTML from an edited plan later, without re-running the judgment step.
//   - Either stage can be swapped for a different/cheaper/newer model
//     independently, since a "plan a website" call and a "write 8000 tokens
//     of HTML" call have very different cost/quality tradeoffs.
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Every model below is overridable via env var — see .env.example. Anthropic
// ships new model versions over time; if a request ever fails with a
// "model not found"-style error, check
// https://docs.claude.com/en/docs/about-claude/models for the current
// identifier and set BRIXOS_PLANNER_MODEL / BRIXOS_BUILDER_MODEL (or
// BRIXOS_MODEL to set both at once) in your .env file — no code change needed.
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const PLANNER_MODEL = process.env.BRIXOS_PLANNER_MODEL || process.env.BRIXOS_MODEL || DEFAULT_MODEL;
const BUILDER_MODEL = process.env.BRIXOS_BUILDER_MODEL || process.env.BRIXOS_MODEL || DEFAULT_MODEL;

let client = null;
function getClient() {
  if (!API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

function isConfigured() {
  return Boolean(API_KEY);
}

// ---------------------------------------------------------------------------
// stage 1 — Planner
// ---------------------------------------------------------------------------

const PLAN_TOOL = {
  name: 'submit_site_plan',
  description: "Submit the structured plan for this business's rebuilt website.",
  input_schema: {
    type: 'object',
    required: ['siteName', 'tagline', 'tone', 'accentColor', 'nav', 'sections', 'seo'],
    properties: {
      siteName: { type: 'string' },
      tagline: { type: 'string', description: 'One short line under the business name.' },
      tone: { type: 'string', description: 'e.g. "warm and handcrafted", "sleek and minimal"' },
      accentColor: { type: 'string', description: 'A single hex color that fits the business, e.g. #7c5cff' },
      nav: { type: 'array', items: { type: 'string' }, description: '3-5 nav labels' },
      sections: {
        type: 'array',
        description: '4-7 homepage sections in the order they should appear',
        items: {
          type: 'object',
          required: ['type', 'headline', 'body'],
          properties: {
            type: { type: 'string', description: 'hero | about | products | gallery | testimonial | contact | cta' },
            headline: { type: 'string' },
            body: { type: 'string' },
            cta: { type: 'string', description: 'Optional button label for this section' }
          }
        }
      },
      seo: {
        type: 'object',
        required: ['title', 'description', 'keywords'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } }
        }
      },
      aeoFaq: {
        type: 'array',
        description: '2-4 short Q&A pairs, phrased the way a shopper would ask an AI assistant',
        items: {
          type: 'object',
          required: ['q', 'a'],
          properties: { q: { type: 'string' }, a: { type: 'string' } }
        }
      }
    }
  }
};

function profileBrief(profile) {
  const lines = [];
  lines.push('Business name: ' + (profile.business || '(not given — infer something plausible, or use "This business")'));
  if (profile.website) lines.push('Existing website: ' + profile.website);
  if (profile.instagram) lines.push('Instagram: ' + profile.instagram);
  if (profile.facebook) lines.push('Facebook: ' + profile.facebook);
  if (profile.social) lines.push('Other social: ' + profile.social);
  if (profile.map) lines.push('Map / location link: ' + profile.map);
  if (profile.gmail) lines.push('Contact email: ' + profile.gmail);
  lines.push('Photos uploaded: ' + (profile.photos ? profile.photos.length : 0));
  lines.push('Files uploaded: ' + (profile.files ? profile.files.length : 0));

  // A real, live audit of the existing website (see server/audit.js) — if
  // present, use this to fix specific, real gaps in the rebuild rather than
  // guessing generically at what the old site might be missing.
  const audit = profile.siteAudit;
  if (audit) {
    if (audit.ok) {
      lines.push(
        'Live audit of the existing website — HTTPS: ' + (audit.hasHttps ? 'yes' : 'no') +
        ', title: ' + (audit.hasTitle ? audit.title : 'missing') +
        ', meta description: ' + (audit.hasDescription ? 'present' : 'missing') +
        ', mobile viewport: ' + (audit.hasViewport ? 'yes' : 'no') +
        ', H1 headline: ' + (audit.hasH1 ? 'yes' : 'no') +
        ', structured data: ' + (audit.hasStructuredData ? 'yes' : 'no') +
        ', approx word count: ' + audit.wordCount +
        ', response time: ' + (audit.responseMs / 1000).toFixed(1) + 's.' +
        ' Fix whichever of these are weak in the rebuild — do not just repeat the same gaps.'
      );
    } else {
      lines.push('Note: BrixOS could not reach the existing website to audit it (' + audit.reason + ') — treat it as unverified.');
    }
  }

  return lines.join('\n');
}

async function planSite(profile, score) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('NOT_CONFIGURED');

  const msg = await anthropic.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 1500,
    system:
      "You are the BrixOS Planner agent. Given a small retail business's profile — whatever links and " +
      "details it has, however sparse — you decide what its rebuilt website should say and contain. You " +
      'never write code; you only decide structure, copy direction, and SEO/AEO metadata. Always call ' +
      'submit_site_plan exactly once with your plan. Be concrete and specific to the business — avoid ' +
      'generic filler a plan for any random shop could also use.',
    tools: [PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'submit_site_plan' },
    messages: [
      {
        role: 'user',
        content:
          'Here is everything currently on file for this business:\n\n' +
          profileBrief(profile) +
          '\n\nCurrent BrixOS presence score: ' + (score ? score.overall + '/100' : 'not yet scored') +
          '\n\nPlan its rebuilt homepage.'
      }
    ]
  });

  const toolUse = msg.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('PLANNER_NO_OUTPUT');
  return toolUse.input;
}

// ---------------------------------------------------------------------------
// stage 2 — Builder
// ---------------------------------------------------------------------------

async function buildSite(plan, profile) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('NOT_CONFIGURED');

  const msg = await anthropic.messages.create({
    model: BUILDER_MODEL,
    max_tokens: 8000,
    system:
      'You are the BrixOS Builder agent. You receive a structured site plan and turn it into a single, ' +
      "complete, self-contained HTML file for a small retail business's homepage — production-quality, " +
      'mobile-first, and accessible.\n' +
      'Rules:\n' +
      '- Output ONLY the raw HTML file, starting with <!doctype html> and nothing before or after it — ' +
      'no markdown code fences, no commentary.\n' +
      '- Inline all CSS in a <style> tag and all JS in a <script> tag — no external stylesheets or scripts ' +
      'except Google Fonts.\n' +
      '- Do not invent fake customer reviews, fake awards, or fake press mentions. Use only real details ' +
      'given in the plan; where a specific asset (like a photo) is not available, use a tasteful CSS-drawn ' +
      'placeholder instead of a broken <img> tag.\n' +
      '- Include semantic HTML, a viewport meta tag, and on-page SEO (title, meta description) from the ' +
      'given seo fields.',
    messages: [
      {
        role: 'user',
        content:
          'Site plan (JSON):\n' + JSON.stringify(plan, null, 2) +
          '\n\nContact/link details to weave in where relevant:\n' + profileBrief(profile) +
          '\n\nWrite the complete HTML file now.'
      }
    ]
  });

  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('BUILDER_NO_OUTPUT');

  let html = textBlock.text.trim();
  // defensive: strip accidental markdown fences if the model adds them anyway
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return html;
}

// ---------------------------------------------------------------------------
// local fallback — no API key needed
//
// When ANTHROPIC_API_KEY isn't set, the routes below call these instead of
// erroring out. Same output shapes as the real Planner/Builder (a `plan`
// object, a complete self-contained HTML string) so everything downstream —
// the DB, the preview iframe, the chat agent — treats it identically. The
// only difference is the plan/site come from templates instead of a model
// call, so this is instant, free, and works completely offline.
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function planSiteLocal(profile, score) {
  const siteName = String(profile.business || '').trim() || 'Your Business';
  const tagline = profile.website
    ? 'Everything customers liked about your site — sharper, faster, and easier to shop.'
    : 'Quality and service worth showing off — built for the customers walking by today.';

  const sections = [
    { type: 'hero', headline: `Welcome to ${siteName}`, body: tagline, cta: 'Get in touch' },
    {
      type: 'about',
      headline: 'Our Story',
      body: `${siteName} is a local favorite built on quality and service — this section is where that story gets told.`
    },
    {
      type: 'products',
      headline: 'What We Offer',
      body: 'A closer look at the products and services customers come back for.'
    },
    profile.map
      ? { type: 'contact', headline: 'Visit Us', body: 'Find us in person or reach out online — we’d love to hear from you.', cta: 'Get directions' }
      : { type: 'contact', headline: 'Get In Touch', body: 'Reach out any time, however’s easiest for you.', cta: 'Contact us' }
  ];

  return {
    siteName,
    tagline,
    tone: 'warm and approachable',
    accentColor: '#B5622E',
    nav: ['Home', 'About', 'Shop', 'Contact'],
    sections,
    seo: {
      title: `${siteName} — Official Site`,
      description: tagline,
      keywords: [siteName.toLowerCase(), 'local business', 'shop near me']
    },
    aeoFaq: [
      { q: `What does ${siteName} sell?`, a: 'A curated selection built around what local customers ask for most.' },
      { q: `Where is ${siteName} located?`, a: profile.map ? 'See the map link on this page for directions.' : 'Contact the business directly for location details.' }
    ]
  };
}

function buildSiteLocal(plan, profile) {
  const accent = plan.accentColor || '#B5622E';
  const hero = plan.sections.find((s) => s.type === 'hero') || plan.sections[0];
  const about = plan.sections.find((s) => s.type === 'about');
  const products = plan.sections.find((s) => s.type === 'products');
  const contact = plan.sections.find((s) => s.type === 'contact') || plan.sections[plan.sections.length - 1];

  const links = [];
  if (profile.website) links.push(`<a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">Website</a>`);
  if (profile.instagram) links.push(`<a href="${escapeHtml(profile.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (profile.facebook) links.push(`<a href="${escapeHtml(profile.facebook)}" target="_blank" rel="noopener">Facebook</a>`);
  if (profile.map) links.push(`<a href="${escapeHtml(profile.map)}" target="_blank" rel="noopener">Map</a>`);
  if (profile.gmail) links.push(`<a href="mailto:${escapeHtml(profile.gmail)}">Email</a>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(plan.seo.title)}</title>
<meta name="description" content="${escapeHtml(plan.seo.description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root { --accent: ${accent}; --bg: #F7F1E6; --panel: #fff; --text: #1E1912; --text-muted: #67594A; --border: rgba(33,27,20,.1); }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'IBM Plex Sans', system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 20px 6vw; display: flex; justify-content: space-between; align-items: center; }
  .brand { font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 700; font-size: 20px; }
  nav a { color: var(--text); text-decoration: none; margin-left: 22px; font-size: 14px; }
  .hero { padding: 64px 6vw 56px; text-align: center; }
  .hero h1 { font-family: 'Space Grotesk', system-ui, sans-serif; font-size: clamp(28px, 5vw, 48px); margin: 0 0 16px; }
  .hero p { color: var(--text-muted); max-width: 560px; margin: 0 auto 28px; font-size: 17px; }
  .btn { display: inline-block; background: var(--text); color: var(--bg); padding: 14px 28px; border-radius: 999px; text-decoration: none; font-weight: 600; }
  section { padding: 48px 6vw; max-width: 960px; margin: 0 auto; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; margin-top: 24px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
  .card .thumb { height: 100px; border-radius: 10px; background: linear-gradient(135deg, rgba(181,98,46,.18), rgba(181,98,46,.06)); margin-bottom: 14px; }
  h2 { font-family: 'Space Grotesk', system-ui, sans-serif; font-size: 28px; margin-top: 0; }
  footer { padding: 32px 6vw; border-top: 1px solid var(--border); text-align: center; color: var(--text-muted); font-size: 14px; }
  footer a { color: var(--accent); margin: 0 8px; text-decoration: none; }
</style>
</head>
<body>
  <header>
    <div class="brand">${escapeHtml(plan.siteName)}</div>
    <nav>${(plan.nav || []).map((n) => `<a href="#">${escapeHtml(n)}</a>`).join('')}</nav>
  </header>
  <div class="hero">
    <h1>${escapeHtml(hero.headline)}</h1>
    <p>${escapeHtml(hero.body)}</p>
    <a class="btn" href="#contact">${escapeHtml(hero.cta || 'Get in touch')}</a>
  </div>
  ${about ? `<section><h2>${escapeHtml(about.headline)}</h2><p>${escapeHtml(about.body)}</p></section>` : ''}
  ${products ? `<section><h2>${escapeHtml(products.headline)}</h2><p>${escapeHtml(products.body)}</p>
    <div class="card-grid">
      <div class="card"><div class="thumb"></div><strong>Best seller</strong><p style="color:var(--text-muted);font-size:14px;">A favorite customers keep coming back for.</p></div>
      <div class="card"><div class="thumb"></div><strong>New arrival</strong><p style="color:var(--text-muted);font-size:14px;">Fresh in and ready to shop.</p></div>
      <div class="card"><div class="thumb"></div><strong>Local pick</strong><p style="color:var(--text-muted);font-size:14px;">A neighborhood favorite, made right here.</p></div>
    </div>
  </section>` : ''}
  <section id="contact">
    <h2>${escapeHtml(contact.headline)}</h2>
    <p>${escapeHtml(contact.body)}</p>
    ${links.length ? `<p>${links.join(' &middot; ')}</p>` : ''}
  </section>
  <footer>${escapeHtml(plan.siteName)} &middot; Built with BrixOS</footer>
</body>
</html>`;
}

module.exports = {
  isConfigured, planSite, buildSite, PLANNER_MODEL, BUILDER_MODEL,
  planSiteLocal, buildSiteLocal
};
