// ---------------------------------------------------------------------------
// BrixOS chat — the console at the top of the page talks to a real AI agent
// (not a canned script). This is the conversational front door of the app,
// separate from the Orchestrator's own internal reasoning/generation calls:
//
//   - The Orchestrator (server/orchestrator.js) only runs when you explicitly
//     hit "Generate my site" or ask chat to build/change one — it's the real
//     multi-page pipeline: understand -> plan -> generate -> validate -> fix
//     -> preview.
//   - Chat is conversational and ongoing. It can *do* three things via tool
//     calls, all reachable by typing instead of clicking:
//       - save_profile_field — the same format-only validation as the "+"
//         menu (server/validate.js), so "my instagram is instagram.com/x"
//         gets saved the same way pasting it in the popover would.
//       - generate_site        — starts a real BrixOS Orchestrator run (the
//         SAME pipeline the button uses: multi-page, validated, auto-fixed)
//         in the background and hands the frontend a job id to watch, so
//         "build my site" from chat lands in the exact same place as the
//         button — profile.generatedProject / generatedSite, shown live in
//         the preview panel with the same progress states.
//       - modify_site          — starts a scoped Orchestrator modification
//         job ("make the hero more premium") against an already-generated
//         project, same background-job/progress-polling pattern.
//
// Provider policy (server/providerPolicy.js, shared with the Orchestrator so
// the whole app enforces ONE rule): Claude reasons about the conversation
// once — and only once — this account has explicitly approved paid Claude
// usage; free OpenRouter models handle it otherwise, needing no approval.
// Actual site *generation* always happens inside the Orchestrator, which
// picks its own providers per stage the same way.
//
// Persona: BrixOS never identifies itself as Claude, OpenRouter, or any
// specific underlying model/vendor — it's always just "the BrixOS
// assistant" to the person using it.
//
// Tool execution happens in a short loop (max 4 model turns) so the agent
// can call a tool, see the result, and then say something about it in the
// same reply — the way ChatGPT/Claude's own tool-use turns work.
// ---------------------------------------------------------------------------

const llm = require('./llm');
const { readDB, writeDB, getProfile } = require('./db');
const { computeScores } = require('./score');
const { validateField, EDITABLE_FIELDS } = require('./validate');
const { isConfigured, planSiteLocal, buildSiteLocal } = require('./generate');
const { auditWebsite, auditImprovements, auditSummaryLine } = require('./audit');
const places = require('./places');
const { pickReasoningProvider, needsClaudeDecision } = require('./providerPolicy');
const orchestrator = require('./orchestrator');

const MAX_TOOL_TURNS = 4;

// ---------------------------------------------------------------------------
// pending map-link confirmation — deterministic, checked BEFORE any AI
// reasoning so it works identically whether or not a model provider is
// configured (the "work properly in all conditions" requirement). A
// yes/no reply resolves it via places.applyPendingPlace(); anything else
// that doesn't look like a fresh link re-asks rather than silently
// dropping the pending match or letting an unrelated message steamroll it.
// ---------------------------------------------------------------------------

const AFFIRM_RE = /^\s*(y|yes|yeah|yep|yup|sure|correct|right|that'?s\s+(?:it|right|correct|mine))\b/i;
const DENY_RE = /^\s*(n|no|nope|nah|wrong|incorrect|not\s+(?:it|right|correct|mine))\b/i;
const LOOKS_LIKE_LINK_RE = /https?:\/\/|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page/i;

// Returns a reply string the moment there's a pending confirmation to deal
// with (resolved either way, or re-asked), or null when there's nothing
// pending / the message looks like a fresh link the normal flow should
// handle instead. Mutates `profile` in place when it resolves; caller still
// does writeDB(db).
function tryResolvePendingPlace(profile, message) {
  const pending = profile.pendingPlace;
  if (!pending) return null;

  if (AFFIRM_RE.test(message)) {
    const result = places.applyPendingPlace(profile, true);
    return 'Great — applied it. Pulled the real Google Business Profile — ' + places.placeSummaryLine(result.place) +
      (result.photosAdded ? `, and added ${result.photosAdded} real photo${result.photosAdded > 1 ? 's' : ''} from the listing.` : '.') +
      ' Say "build my site" whenever you\'re ready.';
  }
  if (DENY_RE.test(message)) {
    places.applyPendingPlace(profile, false);
    return "No problem — I won't use that listing. Feel free to paste the correct map link whenever you have it.";
  }
  if (LOOKS_LIKE_LINK_RE.test(message)) return null; // let a freshly-pasted link replace the pending match instead

  return `Before anything else — is this your business? ${places.placeSummaryLine(pending.place)} Reply yes or no.`;
}

const SAVE_FIELD_TOOL = {
  name: 'save_profile_field',
  description:
    'Save one field to the signed-in user\'s BrixOS profile — the same fields the "+" menu on the page collects. ' +
    'Call this whenever the user tells you a piece of business info in plain conversation (their business name, ' +
    'a link, an email) rather than making them click through the menu themselves. Saving a "map" field (a Google ' +
    'Maps / location link) fetches the real Google Business Profile behind it — name, category, address, phone, ' +
    'hours, rating, and photos — when it resolves successfully, but only STAGES it; it is not applied until the ' +
    'user confirms it\'s really their business (report that a match was found and ask them to confirm, don\'t ' +
    'claim it\'s already saved).',
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
    'Start a full BrixOS Orchestrator run: a real multi-page website (home + about + contact, etc.) built from ' +
    'the user\'s current saved profile, then automatically checked for errors and fixed before it\'s shown. Call ' +
    'this when the user asks you to build, generate, rebuild, or redesign their website FROM SCRATCH, or when no ' +
    'site has been generated yet. It runs in the background — tell the user it\'s underway and to watch the ' +
    'preview panel, don\'t claim it\'s already done.'
  ,
  input_schema: { type: 'object', properties: {} }
};

const MODIFY_TOOL = {
  name: 'modify_site',
  description:
    'Request a scoped change to the ALREADY-GENERATED site — e.g. "make the hero more premium", "add a ' +
    'testimonials section", "change the colors to blue". Only the affected page is touched and regenerated; ' +
    'everything else stays as-is. Only call this if a site has already been generated — if generatedProject ' +
    'isn\'t present yet, call generate_site instead (or tell the user to generate a site first). Runs in the ' +
    'background like generate_site.',
  input_schema: {
    type: 'object',
    required: ['instruction'],
    properties: {
      instruction: { type: 'string', description: 'The user\'s change request, in their own words.' }
    }
  }
};

function systemPrompt(profile, score) {
  const have = EDITABLE_FIELDS.filter((f) => profile[f]);
  const missing = EDITABLE_FIELDS.filter((f) => !profile[f]);
  const audit = profile.siteAudit;
  const hasProject = Boolean(profile.generatedProject);
  return (
    'You are the BrixOS assistant — the conversational front door of a tool that scores a small retail ' +
    "business's digital presence and can rebuild its website. You are BrixOS, full stop — never say you are " +
    'Claude, GPT, an OpenRouter model, or name any underlying AI vendor, even if asked directly; just say you\'re ' +
    "BrixOS's AI. Talk like a sharp, friendly consultant: short replies, plain language, no corporate filler, " +
    "and no dead-end \"sorry, I didn't understand\" replies — there is always something useful to say (ask a " +
    'concrete follow-up, or just answer normally if it was small talk).\n\n' +
    'What you can actually do (use the tools — don\'t just say you will):\n' +
    '- If the user mentions their business name, a website/Instagram/Facebook/social/map link, or an email, ' +
    'call save_profile_field to store it. Saving a website triggers a real, live audit of that page — the tool ' +
    'result will hand you the actual findings; report the specific ones, not generic advice. Saving a map link ' +
    'similarly pulls the real Google Business Profile (category, address, phone, hours, rating, photos) when a ' +
    'Places API key is configured — report those specifics too, and never claim to have fetched a listing if the ' +
    'tool result says it couldn\'t.\n' +
    '- If the user asks you to build/generate/rebuild/redesign their site, call generate_site. It runs off ' +
    'whatever is already saved — if hardly anything is saved yet, still go ahead (it does its best), but you ' +
    'can also suggest they share more first. It runs in the background — say so, don\'t claim it\'s instant.\n' +
    (hasProject
      ? '- A site has already been generated. If the user asks for a specific change to it ("make the hero more ' +
        'premium", "add testimonials", "change the colors"), call modify_site with their instruction instead of ' +
        'regenerating everything. Only use generate_site again if they clearly want a full rebuild.\n'
      : '') +
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
    ' | site generated yet: ' + (hasProject ? 'yes' : 'no') +
    (audit ? '\nMost recent website audit — ' + auditSummaryLine(audit) : '') + '.\n' +
    'Keep replies short — a few sentences at most, this is a chat bubble, not an essay.'
  );
}

async function sendMessage(message, history, userId) {
  if (!llm.isConfigured()) throw new Error('NOT_CONFIGURED');

  const db = readDB();
  let profile = getProfile(db, userId);

  // A map-link match staged from an earlier turn always gets handled first,
  // deterministically — even before the Claude-approval gate below, since
  // resolving it needs no AI reasoning at all.
  if (profile.pendingPlace) {
    const pendingReply = tryResolvePendingPlace(profile, message);
    if (pendingReply) {
      writeDB(db);
      return { reply: pendingReply, profile, score: computeScores(profile), generated: false, orchestratorJobId: null, aiSource: 'local' };
    }
  }

  // The paid-Claude-usage approval gate applies to chat too, exactly as it
  // does to the Orchestrator (server/providerPolicy.js) — BrixOS must ask
  // before ever spending this account's paid Claude credits, even for a
  // conversational reply. Site *generation* itself is unaffected: the
  // Orchestrator jobs started below make their own provider decisions the
  // moment they run, independent of chat's own reasoning provider.
  if (needsClaudeDecision(profile)) {
    return {
      needsClaudeApproval: true,
      reply: 'Claude API usage may incur charges for this operation. Do you want to continue with Claude API, or have BrixOS use its free model pipeline instead?',
      profile,
      score: computeScores(profile),
      generated: false,
      aiSource: 'pending'
    };
  }

  let score = computeScores(profile);
  let orchestratorJobId = null;

  // Executes one tool call and returns the plain-text result the model
  // sees — provider-agnostic, llm.runToolLoop() handles the actual message
  // threading for whichever of Anthropic/OpenRouter is running this turn.
  async function onToolCall(name, input) {
    if (name === 'save_profile_field') {
      const { field, value } = input || {};
      const check = EDITABLE_FIELDS.includes(field) ? validateField(field, value) : { ok: false, message: 'Unknown field.' };
      if (!check.ok) return `Rejected: ${check.message}`;

      const websiteChanged = field === 'website' && profile.website !== check.value;
      const mapChanged = field === 'map' && profile.map !== check.value;
      profile[field] = check.value;
      writeDB(db);

      let resultText = `Saved ${field}.`;
      if (websiteChanged) {
        // Websites are the one field BrixOS can actually go verify — fetch
        // and inspect it now, and hand the findings back as tool grounding
        // so the model's own reply can cite real specifics instead of
        // generic advice.
        const audit = await auditWebsite(check.value);
        profile.siteAudit = audit;
        writeDB(db);
        resultText += ` Live audit of that site — ${auditSummaryLine(audit)}. ` +
          'Mention the specific issues found (not a generic list) and what to fix first.';
      }

      if (mapChanged && places.configured()) {
        // A map link is the other field BrixOS can go verify for real — via
        // the Google Places API (server/places.js) rather than scraping the
        // map page itself (it's client-rendered, so a plain fetch would see
        // nothing). Fetches the real Google Business Profile: category,
        // address, phone, hours, rating, and photos — but only STAGES the
        // match on profile.pendingPlace rather than applying it; it's
        // applied (or discarded) once the user answers the confirmation
        // question, via tryResolvePendingPlace() at the top of this
        // function on their next message.
        const placeResult = await places.enrichFromMapsLink(check.value);
        if (placeResult.ok) {
          profile.pendingPlace = { place: placeResult.place, photos: placeResult.photos, mapValue: check.value, savedAt: new Date().toISOString() };
          writeDB(db);
          resultText += ` Found a possible Google Business Profile match — ${places.placeSummaryLine(placeResult.place)}` +
            (placeResult.photos.length ? ` (with ${placeResult.photos.length} photo(s) available)` : '') +
            '. Ask the user to confirm this is really their business (yes/no) before treating it as saved — do NOT say it\'s already applied.';
        } else {
          resultText += ` Tried to pull the Google Business Profile from that link but couldn't (${placeResult.reason}) — continue with what's already known, don't claim to have fetched anything.`;
        }
      }

      score = computeScores(profile);
      return resultText;
    }

    if (name === 'generate_site') {
      const job = orchestrator.startGeneration(userId);
      orchestratorJobId = job.id;
      return 'Started a full BrixOS Orchestrator run (multi-page, auto-validated). Tell the user it\'s building now and to watch the preview panel — it is NOT done yet.';
    }

    if (name === 'modify_site') {
      const { instruction } = input || {};
      if (!profile.generatedProject) {
        return 'No site has been generated yet — tell the user to generate one first, or call generate_site instead if that\'s what they want.';
      }
      const job = orchestrator.startModification(userId, String(instruction || '').slice(0, 1000));
      orchestratorJobId = job.id;
      return 'Started an Orchestrator update for that change. Tell the user it\'s applying now and to watch the preview panel.';
    }

    return 'Unknown tool.';
  }

  const reasoning = pickReasoningProvider(profile);
  const { text } = await llm.runToolLoop({
    role: 'chat',
    provider: reasoning ? reasoning.provider : undefined,
    system: () => systemPrompt(profile, score),
    message,
    history,
    tools: [SAVE_FIELD_TOOL, GENERATE_TOOL, MODIFY_TOOL],
    maxTurns: MAX_TOOL_TURNS,
    onToolCall
  });

  return { reply: text, profile, score, generated: false, orchestratorJobId, aiSource: 'model' };
}

// ---------------------------------------------------------------------------
// local fallback — no API key needed
//
// When neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set, the console
// still has to actually do something when you hit Enter, instead of the
// whole feature just erroring. This is a lightweight, rule-based stand-in
// for the same things the real agent can do:
//   - it recognizes a business name / website / Instagram / Facebook /
//     map link / gmail address dropped in plain text and saves it, the
//     same as save_profile_field
//   - it recognizes "build/generate/rebuild my site" and "change/update the
//     X" and starts the SAME real BrixOS Orchestrator job the button and the
//     real chat agent use (server/orchestrator.js runs its own local,
//     no-API-key page templates when no provider is configured — so this
//     still produces a real, validated, multi-page site, not a stub)
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

const BUILD_RE = /\b(generate|build|rebuild|redesign|recreate|create)\b[^.!?]*\b(site|website|homepage|page)\b/i;
const MODIFY_RE = /\b(change|update|modify|edit|adjust|tweak|swap|replace|remove|add)\b/i;
const GREETING_RE = /^\s*(hi+|hello+|hey+|yo+|sup|good\s?(morning|afternoon|evening))\b/i;

function detectIntentLocal(message, hasProject) {
  const m = message.trim();
  if (hasProject && MODIFY_RE.test(m) && !BUILD_RE.test(m)) return 'modify';
  if (BUILD_RE.test(m)) return 'generate';
  if (GREETING_RE.test(m)) return 'greeting';
  return 'none';
}

async function sendMessageLocal(message, history, userId) {
  const db = readDB();
  let profile = getProfile(db, userId);
  let score = computeScores(profile);
  let orchestratorJobId = null;

  // Same deterministic, AI-free confirmation intercept as sendMessage()
  // above — handled first since it needs no reasoning at all.
  if (profile.pendingPlace) {
    const pendingReply = tryResolvePendingPlace(profile, message);
    if (pendingReply) {
      writeDB(db);
      return { reply: pendingReply, profile, score: computeScores(profile), generated: false, orchestratorJobId: null, aiSource: 'local' };
    }
  }

  const savedFields = [];
  let websiteAudit = null;

  const found = extractFieldsLocal(message);
  let placeResult = null;
  for (const field of Object.keys(found)) {
    if (!EDITABLE_FIELDS.includes(field)) continue;
    const check = validateField(field, found[field]);
    if (check.ok) {
      if (field === 'website' && profile.website !== check.value) {
        websiteAudit = await auditWebsite(check.value);
        profile.siteAudit = websiteAudit;
      }
      if (field === 'map' && profile.map !== check.value && places.configured()) {
        // Stage only — never apply directly. See tryResolvePendingPlace()
        // above for how the user's next yes/no reply resolves this.
        placeResult = await places.enrichFromMapsLink(check.value);
        if (placeResult.ok) {
          profile.pendingPlace = { place: placeResult.place, photos: placeResult.photos, mapValue: check.value, savedAt: new Date().toISOString() };
        }
      }
      profile[field] = check.value;
      savedFields.push(field);
    }
  }
  if (savedFields.length) {
    writeDB(db);
    score = computeScores(profile);
  }

  const intent = detectIntentLocal(message, Boolean(profile.generatedProject));
  const have = EDITABLE_FIELDS.filter((f) => profile[f]);
  const missing = EDITABLE_FIELDS.filter((f) => !profile[f]);
  let reply;

  if (intent === 'generate') {
    const job = orchestrator.startGeneration(userId);
    orchestratorJobId = job.id;
    reply = "Building your site now — a real multi-page site, checked for errors automatically. Watch the preview panel." +
      (missing.length ? ` Add ${missing.slice(0, 2).join(' and ')} when you can and I'll fold them in next time.` : '');
  } else if (intent === 'modify') {
    const job = orchestrator.startModification(userId, message.slice(0, 1000));
    orchestratorJobId = job.id;
    reply = "Got it — applying that change now. Watch the preview panel.";
  } else if (savedFields.length && websiteAudit) {
    // A website is the one thing BrixOS can actually go study, not just format-check
    // — so this is the one reply that leads with a real score and concrete findings,
    // instead of just acknowledging the save and asking for more.
    const improvements = auditImprovements(websiteAudit);
    reply = `Studied your site — presence score is ${score.overall}/100 right now. ` +
      (improvements.length ? "Here's what I'd fix first: " + improvements.slice(0, 3).join(' ') : '') +
      (placeResult && placeResult.ok ? ` Also pulled your Google listing — ${places.placeSummaryLine(placeResult.place)}.` : '') +
      (missing.length ? ` Adding ${missing.slice(0, 2).join(' and ')} would round out the rest of your profile.` : '');
  } else if (savedFields.length && placeResult && placeResult.ok) {
    // Same idea as the website-audit branch above, but for a map link — a
    // real, verified Google Business Profile match was found, but it's only
    // STAGED (profile.pendingPlace) until the user confirms it's really
    // their business, so ask instead of asserting it's already applied.
    reply = `Found a Google listing that might be yours — ${places.placeSummaryLine(placeResult.place)}` +
      (placeResult.photos.length ? ` (${placeResult.photos.length} photo${placeResult.photos.length > 1 ? 's' : ''} available).` : '.') +
      ' Is this your business? Reply yes or no and I\'ll take it from there.';
  } else if (savedFields.length && placeResult && !placeResult.ok) {
    reply = `Saved your map link, but couldn't pull the listing details (${placeResult.reason}). Presence score is ${score.overall}/100 from what's saved.` +
      (missing.length ? ` Adding ${missing.slice(0, 3).join(', ')} would improve it further.` : '');
  } else if (savedFields.length) {
    reply = `Got it — saved your ${savedFields.join(' and ')}. Presence score is ${score.overall}/100 so far.` +
      (missing.length
        ? ` Adding ${missing.slice(0, 3).join(', ')} would improve it further — or say "build my site" whenever you're ready.`
        : ' That\'s everything I need — say "build my site" and I\'ll generate it.');
  } else if (intent === 'greeting') {
    reply = 'Hey! Tell me your business name, or drop a website / Instagram / Facebook / map link, and I\'ll study it and score your presence right away. ' +
      'Once you\'ve shared a bit, just say "build my site" and I\'ll generate one for you.';
  } else if (have.length) {
    reply = `Presence score is ${score.overall}/100 from what you've shared (${have.join(', ')}).` +
      (missing.length ? ` Adding ${missing.slice(0, 3).join(', ')} would improve it further.` : '') +
      ' Share a link, or say "build my site" whenever you\'re ready.';
  } else {
    reply = 'Tell me your business name, a website, Instagram, Facebook, or map link and I\'ll study it and score your presence right away — ' +
      'or say "build my site" once you have.';
  }

  return { reply, profile, score, generated: false, orchestratorJobId, aiSource: 'local' };
}

module.exports = { sendMessage, sendMessageLocal, isConfigured };
