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

module.exports = { isConfigured, planSite, buildSite, PLANNER_MODEL, BUILDER_MODEL };
