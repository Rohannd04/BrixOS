// ---------------------------------------------------------------------------
// BrixOS chat — the console at the top of the page talks to a real Claude
// agent (not a canned script). This is the third agent in the system,
// separate from the Planner and Builder:
//
//   - Planner / Builder (generate.js) only run when you explicitly hit
//     "Generate my site" — they're a one-shot pipeline over your saved
//     profile.
//   - Chat is conversational and ongoing. It can *do* two things via tool
//     calls, both of which are the same actions the rest of the UI already
//     exposes, just reachable by typing instead of clicking:
//       - save_profile_field  — the same format-only validation as the "+"
//         menu (server/validate.js), so "my instagram is instagram.com/x"
//         gets saved the same way pasting it in the popover would.
//       - generate_site        — runs the exact same Planner -> Builder
//         pipeline as the button, so "build my site" from the chat lands
//         in the same place: profile.generatedSite, shown in the preview
//         panel.
//
// Tool execution happens in a short loop (max 4 model turns) so the agent
// can call a tool, see the result, and then say something about it in the
// same reply — the way ChatGPT/Claude's own tool-use turns work.
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
const { readDB, writeDB, getProfile } = require('./db');
const { computeScores } = require('./score');
const { validateField, EDITABLE_FIELDS } = require('./validate');
const { isConfigured, planSite, buildSite, PLANNER_MODEL, BUILDER_MODEL } = require('./generate');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CHAT_MODEL = process.env.BRIXOS_CHAT_MODEL || process.env.BRIXOS_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOOL_TURNS = 4;

let client = null;
function getClient() {
  if (!API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

const SAVE_FIELD_TOOL = {
  name: 'save_profile_field',
  description:
    'Save one field to the signed-in user\'s BrixOS profile — the same fields the "+" menu on the page collects. ' +
    'Call this whenever the user tells you a piece of business info in plain conversation (their business name, ' +
    'a link, an email) rather than making them click through the menu themselves.',
  input_schema: {
    type: 'object',
    required: ['field', 'value'],
    properties: {
      field: { type: 'string', enum: EDITABLE_FIELDS, description: 'Which profile field to save.' },
      value: { type: 'string', description: 'The raw value as the user gave it (a full link, name, or email).' }
    }
  }
};

const GENERATE_TOOL = {
  name: 'generate_site',
  description:
    'Run the BrixOS Planner -> Builder pipeline against the user\'s current saved profile and produce a rebuilt ' +
    'homepage. Call this when the user asks you to build, generate, rebuild, or redesign their website. It uses ' +
    'whatever is already saved on their profile — it does not need any input.',
  input_schema: { type: 'object', properties: {} }
};

function systemPrompt(profile, score) {
  const have = EDITABLE_FIELDS.filter((f) => profile[f]);
  const missing = EDITABLE_FIELDS.filter((f) => !profile[f]);
  return (
    "You are the BrixOS assistant — the conversational front door of a tool that scores a small retail " +
    "business's digital presence and can rebuild its homepage. Talk like a sharp, friendly consultant: short " +
    "replies, plain language, no corporate filler.\n\n" +
    'What you can actually do (use the tools — don\'t just say you will):\n' +
    '- If the user mentions their business name, a website/Instagram/Facebook/social/map link, or an email, ' +
    'call save_profile_field to store it.\n' +
    '- If the user asks you to build/generate/rebuild/redesign their site, call generate_site. It runs off ' +
    'whatever is already saved — if hardly anything is saved yet, still go ahead (it does its best), but you ' +
    'can also suggest they share more first.\n' +
    '- After a tool call, tell the user plainly what happened, in one or two sentences.\n\n' +
    'Current profile — have: ' + (have.length ? have.join(', ') : 'nothing yet') +
    ' | still missing: ' + (missing.length ? missing.join(', ') : 'nothing') +
    ' | presence score: ' + (score.selectedCount ? score.overall + '/100' : 'not yet scored') + '.\n' +
    'Keep replies short — a few sentences at most, this is a chat bubble, not an essay.'
  );
}

async function sendMessage(message, history, userId) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('NOT_CONFIGURED');

  const db = readDB();
  let profile = getProfile(db, userId);
  let score = computeScores(profile);
  let generated = false;

  // client-supplied history is already {role, content: string} pairs — fine
  // as-is for the first turn; tool-use turns we append below use Anthropic's
  // richer content-block shape.
  const messages = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }))
    .concat([{ role: 'user', content: message }]);

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const resp = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 600,
      system: systemPrompt(profile, score),
      tools: [SAVE_FIELD_TOOL, GENERATE_TOOL],
      messages
    });

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    if (!toolUses.length) {
      const text = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text || "Sorry, I didn't catch that — try again?", profile, score, generated };
    }

    messages.push({ role: 'assistant', content: resp.content });

    const toolResults = [];
    for (const call of toolUses) {
      if (call.name === 'save_profile_field') {
        const { field, value } = call.input || {};
        const check = EDITABLE_FIELDS.includes(field) ? validateField(field, value) : { ok: false, message: 'Unknown field.' };
        if (check.ok) {
          profile[field] = check.value;
          writeDB(db);
          score = computeScores(profile);
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Saved ${field}.` });
        } else {
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Rejected: ${check.message}`, is_error: true });
        }
      } else if (call.name === 'generate_site') {
        try {
          const plan = await planSite(profile, score);
          const html = await buildSite(plan, profile);
          profile.generatedSite = {
            plan,
            html,
            generatedAt: new Date().toISOString(),
            plannerModel: PLANNER_MODEL,
            builderModel: BUILDER_MODEL
          };
          writeDB(db);
          generated = true;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Generated "${plan.siteName}" — now showing in the preview panel.`
          });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Generation failed: ${err.message}`, is_error: true });
        }
      } else {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Unknown tool.', is_error: true });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: "That took a few too many steps — try asking me one thing at a time?", profile, score, generated };
}

module.exports = { sendMessage, isConfigured, CHAT_MODEL };
