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
const { isConfigured, planSite, buildSite, planSiteLocal, buildSiteLocal, PLANNER_MODEL, BUILDER_MODEL } = require('./generate');
const { auditWebsite, auditImprovements, auditSummaryLine } = require('./audit');

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
  const audit = profile.siteAudit;
  return (
    "You are the BrixOS assistant — the conversational front door of a tool that scores a small retail " +
    "business's digital presence and can rebuild its homepage. Talk like a sharp, friendly consultant: short " +
    "replies, plain language, no corporate filler.\n\n" +
    'What you can actually do (use the tools — don\'t just say you will):\n' +
    '- If the user mentions their business name, a website/Instagram/Facebook/social/map link, or an email, ' +
    'call save_profile_field to store it. Saving a website triggers a real, live audit of that page — the tool ' +
    'result will hand you the actual findings; report the specific ones, not generic advice.\n' +
    '- If the user asks you to build/generate/rebuild/redesign their site, call generate_site. It runs off ' +
    'whatever is already saved — if hardly anything is saved yet, still go ahead (it does its best), but you ' +
    'can also suggest they share more first.\n' +
    '- After a tool call, tell the user plainly what happened, in one or two sentences.\n\n' +
    'IMPORTANT — never stall on "I need more information". Even a single detail (just a website, just an ' +
    'Instagram link, whatever they gave you) is enough to give a real score and concrete next steps right now. ' +
    'Score and analyze whatever has been shared and tell them specifically what to fix — then, separately, you ' +
    'can mention that adding more (links, photos) would sharpen the picture further. Missing fields are ' +
    'themselves worth naming as improvements ("add an Instagram link", "add your Google Maps listing"), not a ' +
    'reason to withhold an answer.\n\n' +
    'Current profile — have: ' + (have.length ? have.join(', ') : 'nothing yet') +
    ' | still missing: ' + (missing.length ? missing.join(', ') : 'nothing') +
    ' | presence score: ' + (score.selectedCount ? score.overall + '/100' : 'not yet scored') +
    (audit ? '\nMost recent website audit — ' + auditSummaryLine(audit) : '') + '.\n' +
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
      return { reply: text || "Sorry, I didn't catch that — try again?", profile, score, generated, aiSource: 'model' };
    }

    messages.push({ role: 'assistant', content: resp.content });

    const toolResults = [];
    for (const call of toolUses) {
      if (call.name === 'save_profile_field') {
        const { field, value } = call.input || {};
        const check = EDITABLE_FIELDS.includes(field) ? validateField(field, value) : { ok: false, message: 'Unknown field.' };
        if (check.ok) {
          const websiteChanged = field === 'website' && profile.website !== check.value;
          profile[field] = check.value;
          writeDB(db);

          let resultText = `Saved ${field}.`;
          if (websiteChanged) {
            // Websites are the one field BrixOS can actually go verify —
            // fetch and inspect it now, and hand the findings back as tool
            // grounding so the model's own reply can cite real specifics
            // instead of generic advice.
            const audit = await auditWebsite(check.value);
            profile.siteAudit = audit;
            writeDB(db);
            resultText += ` Live audit of that site — ${auditSummaryLine(audit)}. ` +
              'Mention the specific issues found (not a generic list) and what to fix first.';
          }

          score = computeScores(profile);
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: resultText });
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

  return { reply: "That took a few too many steps — try asking me one thing at a time?", profile, score, generated, aiSource: 'model' };
}

// ---------------------------------------------------------------------------
// local fallback — no API key needed
//
// When ANTHROPIC_API_KEY isn't set, the console still has to actually do
// something when you hit Enter, instead of the whole feature just erroring.
// This is a lightweight, rule-based stand-in for the same two things the
// real agent can do:
//   - it recognizes a business name / website / Instagram / Facebook /
//     map link / gmail address dropped in plain text and saves it, the
//     same as save_profile_field
//   - it recognizes "build/generate/rebuild my site" and runs the local
//     (also-no-API-key) Planner/Builder templates from generate.js
// It's obviously not a real conversation — no free-form understanding —
// but typing and hitting Enter always does something real to your saved
// profile and the preview panel, instead of a dead end.
// ---------------------------------------------------------------------------

function extractFieldsLocal(message) {
  const found = {};
  let working = ' ' + message + ' ';

  const emailMatch = working.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    const email = emailMatch[0].toLowerCase();
    if (/@gmail\.com$/i.test(email)) found.gmail = email;
    // strip it out so its domain isn't also picked up as a website link below
    working = working.replace(emailMatch[0], ' ');
  }

  const urlMatches = working.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/[^\s,'"]*)?/gi) || [];
  for (const rawMatch of urlMatches) {
    const raw = rawMatch.replace(/[),.!?]+$/, '');
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    const lower = withProtocol.toLowerCase();
    if (lower.includes('instagram.com')) { if (!found.instagram) found.instagram = withProtocol; }
    else if (lower.includes('facebook.com') || lower.includes('fb.com') || lower.includes('fb.me')) { if (!found.facebook) found.facebook = withProtocol; }
    else if (lower.includes('maps.google') || lower.includes('goo.gl/maps') || lower.includes('g.page') || lower.includes('maps.app.goo.gl')) { if (!found.map) found.map = withProtocol; }
    else if (lower.includes('tiktok.com') || lower.includes('twitter.com') || lower.includes('x.com') || lower.includes('linkedin.com') || lower.includes('yelp.com')) { if (!found.social) found.social = withProtocol; }
    else if (!found.website) found.website = withProtocol;
  }

  const nameMatch = message.match(/\b(?:my business(?: name)? is|business(?: name)? is|we'?re called|store(?: name)? is|shop(?: name)? is)\s+([A-Za-z][\w&'.\- ]{1,40}?)(?:[.,!]|\s+(?:and|,)|$)/i);
  if (nameMatch) found.business = nameMatch[1].trim();

  return found;
}

function detectIntentLocal(message) {
  const m = message.toLowerCase();
  if (/\b(generate|build|rebuild|redesign|create)\b[^.!?]*\b(site|website|homepage|page)\b/.test(m)) return 'generate';
  if (/^\s*(hi+|hello+|hey+|yo+|sup|good\s?(morning|afternoon|evening))\b/.test(m)) return 'greeting';
  return 'none';
}

async function sendMessageLocal(message, history, userId) {
  const db = readDB();
  let profile = getProfile(db, userId);
  let score = computeScores(profile);
  let generated = false;
  const savedFields = [];
  let websiteAudit = null;

  const found = extractFieldsLocal(message);
  for (const field of Object.keys(found)) {
    if (!EDITABLE_FIELDS.includes(field)) continue;
    const check = validateField(field, found[field]);
    if (check.ok) {
      if (field === 'website' && profile.website !== check.value) {
        websiteAudit = await auditWebsite(check.value);
        profile.siteAudit = websiteAudit;
      }
      profile[field] = check.value;
      savedFields.push(field);
    }
  }
  if (savedFields.length) {
    writeDB(db);
    score = computeScores(profile);
  }

  const intent = detectIntentLocal(message);
  const have = EDITABLE_FIELDS.filter((f) => profile[f]);
  const missing = EDITABLE_FIELDS.filter((f) => !profile[f]);
  let reply;

  if (intent === 'generate') {
    try {
      const plan = planSiteLocal(profile, score);
      const html = buildSiteLocal(plan, profile);
      profile.generatedSite = {
        plan,
        html,
        generatedAt: new Date().toISOString(),
        plannerModel: 'local-template',
        builderModel: 'local-template'
      };
      writeDB(db);
      generated = true;
      reply = `Done — built "${plan.siteName}" from what's on your profile so far. Check the preview panel.` +
        (missing.length ? ` Add ${missing.slice(0, 2).join(' and ')} when you can and I'll fold them in next time.` : '');
    } catch (err) {
      reply = 'Something went wrong building that just now — try again in a moment.';
    }
  } else if (savedFields.length && websiteAudit) {
    // A website is the one thing BrixOS can actually go study, not just format-check
    // — so this is the one reply that leads with a real score and concrete findings,
    // instead of just acknowledging the save and asking for more.
    const improvements = auditImprovements(websiteAudit);
    reply = `Studied your site — presence score is ${score.overall}/100 right now. ` +
      (improvements.length ? "Here's what I'd fix first: " + improvements.slice(0, 3).join(' ') : '') +
      (missing.length ? ` Adding ${missing.slice(0, 2).join(' and ')} would round out the rest of your profile.` : '');
  } else if (savedFields.length) {
    reply = `Got it — saved your ${savedFields.join(' and ')}. Presence score is ${score.overall}/100 so far.` +
      (missing.length
        ? ` Adding ${missing.slice(0, 3).join(', ')} would improve it further — or say "build my site" whenever you're ready.`
        : ' That\'s everything I need — say "build my site" and I\'ll generate it.');
  } else if (intent === 'greeting') {
    reply = 'Hey! Tell me your business name, or drop a website / Instagram / Facebook / map link, and I\'ll study it and score your presence right away. ' +
      'Once you\'ve shared a bit, just say "build my site" and I\'ll generate a homepage for you.';
  } else if (have.length) {
    reply = `Presence score is ${score.overall}/100 from what you've shared (${have.join(', ')}).` +
      (missing.length ? ` Adding ${missing.slice(0, 3).join(', ')} would improve it further.` : '') +
      ' Share a link, or say "build my site" whenever you\'re ready.';
  } else {
    reply = 'I didn\'t catch a business detail there — try sharing your business name, a website, Instagram, Facebook, or map link, ' +
      'or ask me to "build my site" once you have.';
  }

  return { reply, profile, score, generated, aiSource: 'local' };
}

module.exports = { sendMessage, sendMessageLocal, isConfigured, CHAT_MODEL };
