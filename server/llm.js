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
// Groq — a second, independent free-tier provider (console.groq.com, no
// card required). OpenRouter's ":free" models share ONE account-wide
// "requests per day" cap across every free model, so a busy day can burn
// through the whole quota and every subsequent free-tier call fails with
// the same "Rate limit exceeded: free-models-per-day" error until it
// resets — discovered live when this happened mid-testing. Groq has its
// own separate quota, so when it's configured it's used as an automatic
// fallback the moment OpenRouter's free tier is unavailable (see
// callFreeProviderWithRetry below), not a provider you pick explicitly.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
// Gemini — a THIRD independent free-tier provider (Google AI Studio,
// aistudio.google.com/apikey, free, no card required), reached through
// Google's own OpenAI-compatibility endpoint. Same reasoning as GROQ_KEY
// above: another provider's free-tier quota is completely independent of
// OpenRouter's and Groq's, so it's one more fallback before BrixOS has to
// give up entirely. Also purely automatic — never picked explicitly.
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const PROVIDER = ANTHROPIC_KEY ? 'anthropic' : ((OPENROUTER_KEY || GROQ_KEY || GEMINI_KEY) ? 'openrouter' : null);

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

// Pure "biggest context window" was the only ranking signal before this —
// a cheap proxy for "more capable", but not for "fast and reliable for a
// quick chat reply", which is what actually matters for the console and
// for interpreting a change request. These are model families that have
// been consistently fast and good at instruction-/tool-following on
// OpenRouter's free tier; anything matching one is tried before the rest
// of the pool, ranked by how early it matches. Anything not on this list
// still gets used (ranked below all of these, by context length as
// before) — this is a preference order, not an allow-list.
const PREFERRED_MODEL_PATTERNS = [
  /gemini-2\.0-flash/i,
  /gemini-1\.5-flash/i,
  /llama-3\.3-70b/i,
  /llama-3\.1-(70|8)b/i,
  /qwen-2\.5-(72|32)b/i,
  /mistral-small/i,
  /mixtral-8x7b/i,
  /phi-3/i
];

function preferenceRank(modelId) {
  for (let i = 0; i < PREFERRED_MODEL_PATTERNS.length; i++) {
    if (PREFERRED_MODEL_PATTERNS[i].test(modelId)) return i;
  }
  return PREFERRED_MODEL_PATTERNS.length;
}

async function fetchOpenRouterModelList() {
  // See the matching comment in callOpenRouter: the abort has to stay
  // armed through the body read too, not just until fetch() resolves.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let data;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: OPENROUTER_KEY ? { Authorization: `Bearer ${OPENROUTER_KEY}` } : {},
      signal: controller.signal
    });
    if (!res.ok) throw new Error('OPENROUTER_MODELS_FETCH_FAILED_' + res.status);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchSortedFreeModelPool() {
  const models = await fetchOpenRouterModelList();
  const free = models.filter(isFreeModel);
  if (!free.length) throw new Error('NO_FREE_MODEL_AVAILABLE');
  const freeWithTools = free.filter(supportsTools);
  const pool = freeWithTools.length ? freeWithTools : free;
  // Known-fast/reliable model families first (see PREFERRED_MODEL_PATTERNS),
  // then bigger context window as a cheap proxy for "more capable" among
  // whatever's left — better than ranking purely by context length, which
  // can just as easily surface something huge, slow, and flaky.
  pool.sort((a, b) => {
    const rankDiff = preferenceRank(a.id) - preferenceRank(b.id);
    if (rankDiff !== 0) return rankDiff;
    return (b.context_length || 0) - (a.context_length || 0);
  });
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
// about to be used instead of only finding out on the first request. Only
// meaningful when OpenRouter itself is actually configured — a Groq-only
// setup has nothing to resolve here (Groq's candidate list is fixed; see
// the startup log for it further down, once GROQ_MODEL_CANDIDATES exists).
if (OPENROUTER_KEY) {
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

// Free-tier models can be slow, rate-limited, or just hang — without a
// timeout, a single unresponsive model would leave a request stuck
// forever instead of failing over to the next candidate (discovered live:
// a request sat waiting on one free model for minutes with no error).
const OPENROUTER_TIMEOUT_MS = 25000;

async function callOpenRouter({ model, system, messages, tools, forceToolName, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }].concat(messages) : messages
  };
  if (tools) body.tools = toOpenAiTools(tools);
  if (forceToolName) body.tool_choice = { type: 'function', function: { name: forceToolName } };

  // The abort must stay armed through BOTH the fetch() call and the body
  // read that follows — clearing it as soon as fetch() resolves (headers
  // received) left a real gap: a response that stalls while streaming its
  // body would hang res.json() forever with no timeout protecting it,
  // exactly what happened in production (a request sat stuck for minutes
  // even with a timeout that only covered the first half of the call).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
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
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      throw new Error('OPENROUTER_ERROR: ' + msg);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`OPENROUTER_ERROR: timed out after ${OPENROUTER_TIMEOUT_MS / 1000}s`);
    if (err.message && err.message.startsWith('OPENROUTER_ERROR:')) throw err;
    throw new Error('OPENROUTER_ERROR: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
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
// Groq — second free-tier provider, used only as a fallback (see the
// comment on GROQ_KEY above). Groq's API is OpenAI-compatible, same
// request/response shape as OpenRouter's, so it slots into the exact same
// data.choices[0].message parsing every caller already does.
// ---------------------------------------------------------------------------

const GROQ_TIMEOUT_MS = 25000;
// Verified live against Groq's own /v1/models endpoint with a real account
// key (Sept 2026): the plain "llama-3.3-70b-versatile" / "llama-3.1-8b-instant"
// ids have been retired from this account's available models (Groq's lineup
// has shifted to OpenAI's open-weight models + Qwen + their own "compound"
// agents) — confirmed via a real tool-calling request against both ids below.
const GROQ_MODEL_CANDIDATES = process.env.GROQ_MODEL
  ? [process.env.GROQ_MODEL]
  : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const badGroqModels = new Set();

if (GROQ_KEY) {
  console.log(`[BrixOS] Groq configured as a free-tier fallback (candidates: ${GROQ_MODEL_CANDIDATES.join(', ')}).`);
}

function markGroqModelBad(model, reason) {
  if (process.env.GROQ_MODEL) return; // never route around a manual pin
  badGroqModels.add(model);
  console.warn(`[BrixOS] Groq: model "${model}" failed (${reason}) — trying the next candidate.`);
}

async function callGroq({ model, system, messages, tools, forceToolName, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }].concat(messages) : messages
  };
  if (tools) body.tools = toOpenAiTools(tools);
  if (forceToolName) body.tool_choice = { type: 'function', function: { name: forceToolName } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      throw new Error('GROQ_ERROR: ' + msg);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`GROQ_ERROR: timed out after ${GROQ_TIMEOUT_MS / 1000}s`);
    if (err.message && err.message.startsWith('GROQ_ERROR:')) throw err;
    throw new Error('GROQ_ERROR: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function callGroqWithRetry(args) {
  const candidates = GROQ_MODEL_CANDIDATES.filter((m) => !badGroqModels.has(m));
  const tryList = candidates.length ? candidates : GROQ_MODEL_CANDIDATES; // all blacklisted? try anyway, last resort
  let lastErr;
  for (const model of tryList) {
    try {
      const data = await callGroq({ ...args, model });
      return { data, model };
    } catch (err) {
      lastErr = err;
      markGroqModelBad(model, err.message);
    }
  }
  throw lastErr;
}

function groqConfigured() {
  return Boolean(GROQ_KEY);
}

// ---------------------------------------------------------------------------
// Gemini — third free-tier provider, used only as a fallback (see the
// comment on GEMINI_KEY above). Reached through Google's own
// OpenAI-compatibility endpoint (https://ai.google.dev/gemini-api/docs/openai),
// which accepts the same request shape and tool-calling format as
// OpenRouter/Groq, so it slots into the exact same data.choices[0].message
// parsing every caller already uses.
// ---------------------------------------------------------------------------

const GEMINI_TIMEOUT_MS = 25000;
// Best-effort defaults as of this writing — override with GEMINI_MODEL if
// Verified live against Gemini's own OpenAI-compat endpoint with a real
// account key (Sept 2026): "gemini-2.5-flash"/"gemini-2.5-flash-lite" now
// 404 with "no longer available to new users" — Google's error body itself
// names the replacements. "gemini-flash-lite-latest" is one of Google's own
// rolling aliases (always points at their current lite model, so it won't
// go stale the way a dated id eventually will); "gemini-3.5-flash-lite" is
// confirmed working as a pinned fallback if the alias ever misbehaves.
const GEMINI_MODEL_CANDIDATES = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite'];
const badGeminiModels = new Set();

if (GEMINI_KEY) {
  console.log(`[BrixOS] Gemini configured as a free-tier fallback (candidates: ${GEMINI_MODEL_CANDIDATES.join(', ')}).`);
}

function markGeminiModelBad(model, reason) {
  if (process.env.GEMINI_MODEL) return; // never route around a manual pin
  badGeminiModels.add(model);
  console.warn(`[BrixOS] Gemini: model "${model}" failed (${reason}) — trying the next candidate.`);
}

async function callGemini({ model, system, messages, tools, forceToolName, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }].concat(messages) : messages
  };
  if (tools) body.tools = toOpenAiTools(tools);
  if (forceToolName) body.tool_choice = { type: 'function', function: { name: forceToolName } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GEMINI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      throw new Error('GEMINI_ERROR: ' + msg);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`GEMINI_ERROR: timed out after ${GEMINI_TIMEOUT_MS / 1000}s`);
    if (err.message && err.message.startsWith('GEMINI_ERROR:')) throw err;
    throw new Error('GEMINI_ERROR: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiWithRetry(args) {
  const candidates = GEMINI_MODEL_CANDIDATES.filter((m) => !badGeminiModels.has(m));
  const tryList = candidates.length ? candidates : GEMINI_MODEL_CANDIDATES;
  let lastErr;
  for (const model of tryList) {
    try {
      const data = await callGemini({ ...args, model });
      return { data, model };
    } catch (err) {
      lastErr = err;
      markGeminiModelBad(model, err.message);
    }
  }
  throw lastErr;
}

function geminiConfigured() {
  return Boolean(GEMINI_KEY);
}

// The single entry point every free-tier caller (openRouterComplete,
// runToolLoop's 'openrouter' branch) should use instead of calling
// callOpenRouterWithRetry directly: try OpenRouter first (unchanged
// behavior for everyone who only has that key), then Groq, then Gemini —
// each only reached if the previous one is either not configured or just
// failed outright (e.g. an account-wide free-tier daily cap is exhausted).
// Silent no-op for any provider that isn't configured, so nothing changes
// for anyone who hasn't set the corresponding key.
async function callFreeProviderWithRetry(args) {
  if (OPENROUTER_KEY) {
    try {
      return await callOpenRouterWithRetry(args);
    } catch (err) {
      if (!GROQ_KEY && !GEMINI_KEY) throw err;
      console.warn(`[BrixOS] OpenRouter free tier unavailable (${err.message}) — falling back to the next free provider.`);
    }
  }
  if (GROQ_KEY) {
    try {
      return await callGroqWithRetry(args);
    } catch (err) {
      if (!GEMINI_KEY) throw err;
      console.warn(`[BrixOS] Groq unavailable (${err.message}) — falling back to Gemini.`);
    }
  }
  if (GEMINI_KEY) return callGeminiWithRetry(args);
  throw new Error('NOT_CONFIGURED');
}

// A dud (empty) reply's model id may have come from any of the three
// providers — blacklist it wherever it actually belongs rather than
// assuming OpenRouter. None of the three providers' model id formats
// collide (OpenRouter's are "vendor/model[:free]"; Groq's and Gemini's are
// bare names, and their model families don't share names), so checking the
// candidate lists is unambiguous.
function markFreeModelBad(model, reason) {
  if (GROQ_MODEL_CANDIDATES.includes(model)) {
    markGroqModelBad(model, reason);
  } else if (GEMINI_MODEL_CANDIDATES.includes(model)) {
    markGeminiModelBad(model, reason);
  } else {
    markOpenRouterModelBad(model, reason);
  }
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

// Single-turn call helpers, one per real provider — factored out so both the
// provider-agnostic chatOnce() below (used by the existing Planner/Builder/
// chat pipeline, which follows whichever ONE provider is "configured") and
// the orchestrator's direct, per-stage provider picks (server/orchestrator.js
// — which may want Claude for reasoning and OpenRouter for generation in the
// very same run) share one implementation instead of two copies drifting
// apart. Neither helper reads the module-level PROVIDER constant — each
// throws NOT_CONFIGURED on its own if its own key is missing, regardless of
// which provider (if any) is the "default" one.
async function anthropicComplete({ role, system, userText, tools, forceToolName, maxTokens }) {
  const anthropic = getAnthropic();
  if (!anthropic) throw new Error('NOT_CONFIGURED');
  const model = (role && ANTHROPIC_MODELS[role]) || ANTHROPIC_DEFAULT_MODEL;
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

async function openRouterComplete({ system, userText, tools, forceToolName, maxTokens }) {
  if (!OPENROUTER_KEY && !GROQ_KEY && !GEMINI_KEY) throw new Error('NOT_CONFIGURED');
  const messages = [{ role: 'user', content: userText }];

  // Same dud-reply problem runToolLoop() guards against (see
  // EMPTY_REPLY_RETRIES above): a free model can return 200 OK with no tool
  // call AND no text. Single-turn callers (server/orchestrator.js's direct
  // planning/generation calls, via callOpenRouterDirect) used to have no
  // guard for this at all — a dud plan/page response silently fell through
  // to the caller's local-template fallback instead of trying another
  // model, which is why the Orchestrator's real AI pipeline could quietly
  // degrade to the plain local site even with OpenRouter fully configured
  // and working (proven working elsewhere, e.g. plain chat replies).
  let data, model, msg, toolCall;
  let emptyAttempts = 0;
  for (;;) {
    ({ data, model } = await callFreeProviderWithRetry({ system, messages, tools, forceToolName, maxTokens }));
    msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    toolCall = (msg.tool_calls || [])[0];
    const content = (msg.content || '').trim();
    const hasUsableOutput = forceToolName ? Boolean(toolCall) : Boolean(toolCall || content);
    if (hasUsableOutput) break;
    emptyAttempts++;
    if (emptyAttempts > EMPTY_REPLY_RETRIES) break;
    markFreeModelBad(model, 'empty reply (no text, no tool call)');
  }

  return { text: (msg.content || '').trim(), toolInput: toolCall ? safeParseJson(toolCall.function.arguments) : null, model };
}

// Single-turn call, with an optional forced tool call (used by the Planner
// to guarantee structured JSON output). Returns { text, toolInput, model }.
// Follows the module's single "configured" PROVIDER (Anthropic if its key is
// set, else OpenRouter) — this is the existing behavior generate.js/chat.js
// have always relied on. Left untouched so nothing that already works
// changes; see claudeConfigured/openRouterConfigured/callClaudeDirect/
// callOpenRouterDirect below for the orchestrator's independent, per-stage
// provider selection.
async function chatOnce({ role, system, userText, tools, forceToolName, maxTokens }) {
  if (PROVIDER === 'anthropic') return anthropicComplete({ role, system, userText, tools, forceToolName, maxTokens });
  if (PROVIDER === 'openrouter') return openRouterComplete({ system, userText, tools, forceToolName, maxTokens });
  throw new Error('NOT_CONFIGURED');
}

// ---------------------------------------------------------------------------
// Direct, per-stage provider access for the BrixOS Orchestrator
// (server/orchestrator.js). Unlike chatOnce()/runToolLoop() above, these
// don't defer to the single module-level PROVIDER pick — the orchestrator
// deliberately wants Claude for reasoning (planning, studying, review) and
// an OpenRouter/open-source model for generation work in the SAME run, so it
// needs to reach either provider on demand, independent of which one (if
// either) generate.js/chat.js would default to. Each throws NOT_CONFIGURED
// (not a silent fallback) when its own API key isn't set, so callers can
// decide what to do next themselves (try the other provider, fall back to a
// local template, or surface the gap to the user).
// ---------------------------------------------------------------------------

function claudeConfigured() {
  return Boolean(ANTHROPIC_KEY);
}

function openRouterConfigured() {
  // Labeled "openRouter" for backward compatibility (this is what every
  // caller checks to decide whether the free/cheap tier is usable at all),
  // but true whenever ANY of the three free providers is configured — Groq
  // and Gemini are automatic fallbacks inside the same call path, not
  // separately-picked providers, so callers never need to know which one
  // actually ran.
  return Boolean(OPENROUTER_KEY || GROQ_KEY || GEMINI_KEY);
}

async function callClaudeDirect(args) {
  return anthropicComplete(args);
}

async function callOpenRouterDirect(args) {
  return openRouterComplete(args);
}

// A model that produces neither a tool call nor any text is a dud
// response, not a "the user said something confusing" response — free
// OpenRouter models occasionally do this. Rather than show the user a
// dead-end apology on the first empty reply, this is retried a couple of
// times (blacklisting the model that produced the dud each time, same as
// a hard error would) before giving up and returning the friendlier
// last-resort text below.
const EMPTY_REPLY_RETRIES = 2;

// A last resort only — every effort above is made to avoid ever reaching
// this (retrying empty replies across multiple candidate models first).
// Kept in-character rather than a bare apology, per BrixOS's own voice.
const LAST_RESORT_REPLY = "Let's try that again — tell me your business name or drop a link and I'll take a look right now.";

// Multi-turn agentic loop (used by chat.js). Tool execution is delegated
// back to the caller via onToolCall(name, input) => resultText, so this
// file stays completely unaware of what save_profile_field/generate_site
// actually do — it only knows how to shuttle a tool call and its result
// back and forth with whichever provider is active.
//
// `system` may be a string or a () => string — pass a function when the
// prompt needs to reflect state a tool call in an earlier turn just
// changed (e.g. profile/score after saving a field).
//
// `provider` optionally overrides the module's single auto-detected
// PROVIDER — used by server/chat.js (via server/providerPolicy.js) to run
// this same loop against Claude specifically, once an account has approved
// paid usage, while everyone else still gets the free OpenRouter path.
// Defaults to the module-level PROVIDER for every existing caller.
async function runToolLoop({ role, system, message, history, tools, maxTurns, onToolCall, provider }) {
  // server/providerPolicy.js names the Anthropic path 'claude' (matching how
  // the Orchestrator labels/displays it); this module's own PROVIDER constant
  // has always used 'anthropic'. Normalize here rather than making every
  // caller know both spellings.
  const normalizedProvider = provider === 'claude' ? 'anthropic' : provider;
  const useProvider = normalizedProvider || PROVIDER;
  const historyMessages = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));

  if (useProvider === 'anthropic') {
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
        if (text) return { text, model };
        // Claude is reliable enough that this essentially never happens —
        // but if it ever does, don't loop forever on a fixed model; just
        // hand back the friendly last-resort text.
        return { text: LAST_RESORT_REPLY, model };
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

  if (useProvider === 'openrouter') {
    const messages = historyMessages.concat([{ role: 'user', content: message }]);
    let lastModel = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      let data, model, toolCalls, msg;
      let emptyAttempts = 0;

      // Inner retry: a dud (no tool call, no text) reply doesn't consume a
      // whole conversational turn — it just tries the next free-model
      // candidate a couple more times before this turn gives up.
      for (;;) {
        ({ data, model } = await callFreeProviderWithRetry({
          system: typeof system === 'function' ? system() : system,
          messages,
          tools,
          maxTokens: 600
        }));
        lastModel = model;
        msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
        toolCalls = msg.tool_calls || [];
        const content = (msg.content || '').trim();
        if (toolCalls.length || content) break;
        emptyAttempts++;
        if (emptyAttempts > EMPTY_REPLY_RETRIES) break;
        markFreeModelBad(model, 'empty reply (no text, no tool call)');
      }

      if (!toolCalls.length) {
        return { text: (msg.content || '').trim() || LAST_RESORT_REPLY, model };
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

module.exports = {
  isConfigured, providerName, chatOnce, runToolLoop,
  // orchestrator-facing direct provider access (see the comment above)
  claudeConfigured, openRouterConfigured, groqConfigured, geminiConfigured, callClaudeDirect, callOpenRouterDirect
};
