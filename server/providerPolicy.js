// ---------------------------------------------------------------------------
// BrixOS provider policy — ONE shared place that decides, for a given
// account, which AI provider handles "reasoning" vs. "generation" work, and
// enforces the paid-Claude-usage approval gate.
//
// Originally lived only inside server/orchestrator.js. Pulled out so
// server/chat.js can use the *exact same* rules — Claude only after explicit
// per-account approval, OpenRouter's free tier needs no approval, and a
// deterministic local fallback when neither is usable — instead of the two
// systems drifting into two different, inconsistent policies.
//
//   - Claude is the REASONING engine — conversation, understanding the
//     business, planning, and interpreting change requests. NEVER called
//     unless this account has explicitly approved paid Claude usage
//     (profile.claudeApprovalGranted === true). See needsClaudeDecision().
//   - OpenRouter is the GENERATION worker — and a perfectly good reasoning
//     fallback too — needs no approval gate since BrixOS only ever asks it
//     for OpenRouter's free-tier models.
//   - If neither is usable, callers fall back to their own local,
//     deterministic, no-API-key logic.
// ---------------------------------------------------------------------------

const llm = require('./llm');
const { readDB, writeDB, getProfile } = require('./db');

// Reasoning (understand/study/plan/interpret-change-requests/chat): Claude if
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

module.exports = {
  pickReasoningProvider,
  pickGenerationProvider,
  needsClaudeDecision,
  getClaudeStatus,
  setClaudeApproval
};
