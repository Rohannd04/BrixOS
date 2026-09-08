// ---------------------------------------------------------------------------
// BrixOS model provider — a thin abstraction so generate.js/chat.js don't
// care whether they're talking to Anthropic directly or to OpenRouter.
//
// Two real providers, picked automatically from whichever key is set
// (Anthropic takes priority if both are present, since it's the native,
// best-tested path):
//   - ANTHROPIC_API_KEY  — calls api.anthropic.com directly via
//     @anthropic-ai/sdk, exactly as this app always has.
//   - OPENROUTER_API_KEY — calls openrouter.ai's OpenAI-compatible REST
//     API via plain fetch (no new dependency). OpenRouter fronts many
//     providers' models, including several with a genuinely free tier —
//     handy when someone doesn't have (or doesn't want to pay for) a
//     direct Anthropic key yet.
//
// If neither is set, isConfigured() is false and callers fall back to the
// local, no-API-key logic that already lives in generate.js/chat.js.
//
// Model selection:
//   - Anthropic: same as before — BRIXOS_PLANNER_MODEL / BUILDER_MODEL /
//     CHAT_MODEL (or BRIXOS_MODEL for all three), defaulting to
//     claude-sonnet-4-5-20250929.
//   - OpenRouter: OPENROUTER_MODEL pins an exact model id if set. If not,
//     BrixOS asks OpenRouter's own public model list (no auth required)
//     for whichever free-tier model looks most capable and supports tool
//     calling, and uses that — because OpenRouter's free-model lineup
//     changes over time, hardcoding one here would eventually break.
//     Resolved once per hour and cached; logged at startup so it's always
//     obvious which model actually ran.
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const PROVIDER = ANTHROPIC_KEY ? 'anthropic' : (OPENROUTER_KEY ? 'openrouter' : null);

const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_MODELS = {
  planner: process.env.BRIXOS_PLANNER_MODEL || process.env.BRIXOS_MODEL || ANTHROPIC_DEFAULT_MODEL,
  builder: process.env.BRIXOS_BUILDER_MODEL || process.env.BRIXOS_MODEL || ANTHROPIC_DEFAULT_MODEL,
  chat: process.env.BRIXOS_CHAT_MODEL || process.env.BRIXOS_MODEL || ANTHROPIC_DEFAULT_MODEL
};

// Only used if a live OpenRouter model lookup fails outright (network
// hiccup, etc.) — a best-effort guess, not a guarantee. The live lookup
// above is always tried first.
const OPENROUTER_FALLBACK_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

let AnthropicSDK = null;
let anthropicClient = null;
function getAnthropic() {
  if (!ANTHROPIC_KEY) return null;
  if (!anthropicClient) {
    AnthropicSDK = AnthropicSDK || require('@anthropic-ai/sdk');
    anthropicClient = new AnthropicSDK({ apiKey: ANTHROPIC_KEY });
  }
  return anthropicClient;
}

function isConfigured() {
  return PROVIDER !== null;
}

function providerName() {
  return PROVIDER;
}

// ---------------------------------------------------------------------------
// OpenRouter model auto-detection
// ---------------------------------------------------------------------------

const MODEL_CACHE_MS = 60 * 60 * 1000; // re-check hourly — free-tier lineups change
let cachedPool = null; // sorted array of candidate model ids
let cachedAt = 0;

// Some free models pass every filter below (free, tool-capable per their
// listing) but still reject real requests — e.g. OpenRouter restricts a
// few free models to "agentic harness" clients only, which isn't visible
// anywhere in the /models metadata, only by actually trying to call them.
// Anything that fails a real call gets blacklisted for the rest of this
// process so the next request skips straight past it.
const badModels = new Set();

function isFreeModel(m) {
  const p = m.pricing || {};
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

function supportsTools(m) {
  return Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools');
}

async function fetchOpenRouterModelList() {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: OPENROUTER_KEY ? { Authorization: `Bearer ${OPENROUTER_KEY}` } : {}
  });
  if (!res.ok) throw new Error('OPENROUTER_MODELS_FETCH_FAILED_' + res.status);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchSortedFreeModelPool() {
  const models = await fetchOpenRouterModelList();
  const free = models.filter(isFreeModel);
  if (!free.length) throw new Error('NO_FREE_MODEL_AVAILABLE');
  const freeWithTools = free.filter(supportsTools);
  const pool = freeWithTools.length ? freeWithTools : free;
  // Bigger context window is a rough, cheap proxy for "more capable" when
  // there's no other signal to rank free models by.
  pool.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  return pool.map((m) => m.id);
}

async function getModelPool() {
  const now = Date.now();
  if (cachedPool && (now - cachedAt) < MODEL_CACHE_MS) return cachedPool;
  cachedPool = await fetchSortedFreeModelPool();
  cachedAt = now;
  return cachedPool;
}

// Returns the best candidate to try next: the top-ranked free model that
// hasn't already failed this session, falling back to the hardcoded
// last-resort constant, and only throwing if every option is exhausted.
// A manually pinned OPENROUTER_MODEL always wins and is never blacklisted
// — if that one is wrong, that's the user's call to fix, not ours to
// route around.
async function getOpenRouterModel() {
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;

  try {
    const pool = await getModelPool();
    const candidate = pool.find((id) => !badModels.has(id));
    if (candidate) {
      console.log(`[BrixOS] OpenRouter: using free model "${candidate}"`);
      return candidate;
    }
  } catch (err) {
    console.warn(`[BrixOS] OpenRouter: live model lookup failed (${err.message}).`);
  }

  if (!badModels.has(OPENROUTER_FALLBACK_MODEL)) {
    console.warn(`[BrixOS] OpenRouter: falling back to "${OPENROUTER_FALLBACK_MODEL}". Set OPENROUTER_MODEL in .env to pin one yourself.`);
    return OPENROUTER_FALLBACK_MODEL;
  }

  throw new Error('NO_WORKING_OPENROUTER_MODEL');
}

function markOpenRouterModelBad(model, reason) {
  if (process.env.OPENROUTER_MODEL) return; // never route around a manual pin
  badModels.add(model);
  console.warn(`[BrixOS] OpenRouter: model "${model}" failed (${reason}) — trying the next candidate.`);
}

// Resolve the model once at startup, purely so the console shows what's
// about to be used instead of only finding out on the first request.
if (PROVIDER === 'openrouter') {
  getOpenRouterModel().catch(() => {});
}

function toOpenAiTools(tools) {
  if (!tools) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

function safeParseJson(s) {
  try { return JSON.parse(s || '{}'); } catch (err) { return {}; }
}

async function callOpenRouter({ model, system, messages, tools, forceToolName, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }].concat(messages) : messages
  };
  if (tools) body.tools = toOpenAiTools(tools);
  if (forceToolName) body.tool_choice = { type: 'function', function: { name: forceToolName } };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      // OpenRouter asks for these on every request — cosmetic (shows up in
      // their own dashboard), not functionally required, but good practice.
      'HTTP-Referer': 'https://brixos.local',
      'X-Title': 'BrixOS Presence Engine'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    throw new Error('OPENROUTER_ERROR: ' + msg);
  }
  return data;
}

// Wraps callOpenRouter with fallback across candidates: some free models
// pass every filter but still reject real requests for reasons invisible
// in their listing (see badModels above) — this tries the next-best
// candidate instead of failing the whole request outright. A manually
// pinned OPENROUTER_MODEL is tried exactly once, since routing around an
// explicit pin would be surprising.
async function callOpenRouterWithRetry(args) {
  const maxAttempts = process.env.OPENROUTER_MODEL ? 1 : 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const model = await getOpenRouterModel();
    try {
      const data = await callOpenRouter({ ...args, model });
      return { data, model };
    } catch (err) {
      lastErr = err;
      markOpenRouterModelBad(model, err.message);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

// Single-turn call, with an optional forced tool call (used by the Planner
// to guarantee structured JSON output). Returns { text, toolInput, model }.
async function chatOnce({ role, system, userText, tools, forceToolName, maxTokens }) {
  if (PROVIDER === 'anthropic') {
    const anthropic = getAnthropic();
    if (!anthropic) throw new Error('NOT_CONFIGURED');
    const model = ANTHROPIC_MODELS[role] || ANTHROPIC_DEFAULT_MODEL;
    const resp = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools,
      tool_choice: forceToolName ? { type: 'tool', name: forceToolName } : undefined,
      messages: [{ role: 'user', content: userText }]
    });
    const toolUse = resp.content.find((b) => b.type === 'tool_use');
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, toolInput: toolUse ? toolUse.input : null, model };
  }

  if (PROVIDER === 'openrouter') {
    const { data, model } = await callOpenRouterWithRetry({ system, messages: [{ role: 'user', content: userText }], tools, forceToolName, maxTokens });
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const toolCall = (msg.tool_calls || [])[0];
    return { text: (msg.content || '').trim(), toolInput: toolCall ? safeParseJson(toolCall.function.arguments) : null, model };
  }

  throw new Error('NOT_CONFIGURED');
}

// Multi-turn agentic loop (used by chat.js). Tool execution is delegated
// back to the caller via onToolCall(name, input) => resultText, so this
// file stays completely unaware of what save_profile_field/generate_site
// actually do — it only knows how to shuttle a tool call and its result
// back and forth with whichever provider is active.
//
// `system` may be a string or a () => string — pass a function when the
// prompt needs to reflect state a tool call in an earlier turn just
// changed (e.g. profile/score after saving a field).
async function runToolLoop({ role, system, message, history, tools, maxTurns, onToolCall }) {
  const historyMessages = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));

  if (PROVIDER === 'anthropic') {
    const anthropic = getAnthropic();
    if (!anthropic) throw new Error('NOT_CONFIGURED');
    const model = ANTHROPIC_MODELS[role] || ANTHROPIC_DEFAULT_MODEL;
    const messages = historyMessages.concat([{ role: 'user', content: message }]);

    for (let turn = 0; turn < maxTurns; turn++) {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 600,
        system: typeof system === 'function' ? system() : system,
        tools,
        messages
      });
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) {
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { text: text || "Sorry, I didn't catch that — try again?", model };
      }
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = [];
      for (const call of toolUses) {
        const resultText = await onToolCall(call.name, call.input || {});
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: resultText });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    return { text: "That took a few too many steps — try asking me one thing at a time?", model };
  }

  if (PROVIDER === 'openrouter') {
    const messages = historyMessages.concat([{ role: 'user', content: message }]);
    let lastModel = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      const { data, model } = await callOpenRouterWithRetry({
        system: typeof system === 'function' ? system() : system,
        messages,
        tools,
        maxTokens: 600
      });
      lastModel = model;
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) {
        return { text: (msg.content || '').trim() || "Sorry, I didn't catch that — try again?", model };
      }
      messages.push(msg);
      for (const tc of toolCalls) {
        const input = safeParseJson(tc.function && tc.function.arguments);
        const resultText = await onToolCall(tc.function.name, input);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
      }
    }
    return { text: "That took a few too many steps — try asking me one thing at a time?", model: lastModel };
  }

  throw new Error('NOT_CONFIGURED');
}

module.exports = { isConfigured, providerName, chatOnce, runToolLoop };
