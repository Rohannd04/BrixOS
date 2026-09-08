// ---------------------------------------------------------------------------
// BrixOS uploaded-document analysis.
//
// The "Files" upload (server/index.js, kind: 'files') used to just store
// filename/URL metadata — nobody ever actually read what was in a PDF/Word
// doc a business owner attached. This module extracts the real text from a
// just-uploaded document (PDF, Word .docx, or plain text/CSV) and — same
// dependency-free, explainable philosophy as server/audit.js's live website
// audit — runs a fast, deterministic, no-API-key check for the concrete
// things a small retail business's site/profile should cover, so BrixOS can
// tell the user specifically what's missing right after they upload,
// instead of only counting "a file exists" the way score.js's flat
// files-present points already did before this existed.
//
// Kept fully synchronous/heuristic on purpose (no model call): this is
// meant to be instant on upload, needs no AI provider configured at all,
// and never spends anyone's paid API credits — matching how the app's other
// "real, dependency-free analysis" (server/audit.js) already works.
// ---------------------------------------------------------------------------

const fs = require('fs');

const MAX_TEXT_CHARS = 20000; // plenty for analysis; keeps memory/JSON size sane
const MAX_BRIEF_EXCERPT_CHARS = 800; // how much of a doc's text gets echoed into AI prompts (profileBrief)

const SUPPORTED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/csv'
]);

function canExtract(mimetype) {
  return SUPPORTED_MIMES.has(mimetype);
}

// Returns { ok, text, reason }. Never throws — a corrupt/unreadable file is
// itself a signal to report, not a crash (same rule server/audit.js follows
// for an unreachable website).
async function extractText(absPath, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(absPath);
      const data = await pdfParse(buf);
      return { ok: true, text: String(data.text || '').slice(0, MAX_TEXT_CHARS) };
    }
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: absPath });
      return { ok: true, text: String(result.value || '').slice(0, MAX_TEXT_CHARS) };
    }
    if (mimetype === 'text/plain' || mimetype === 'text/csv') {
      const text = fs.readFileSync(absPath, 'utf8');
      return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) };
    }
    return { ok: false, text: '', reason: 'Unsupported file type for text analysis.' };
  } catch (err) {
    return { ok: false, text: '', reason: 'Could not read this file (' + err.message + ').' };
  }
}

// Deterministic, explainable checks — the same spirit as
// server/audit.js#auditWebsite: look for concrete signals a real customer
// (or a search/answer engine) would care about, rather than judging writing
// quality, which needs real understanding, not regexes.
function analyzeDocumentText(text) {
  const words = (text.match(/\S+/g) || []).length;
  const lower = text.toLowerCase();

  const hasHours = /\b(hours|open\s|opening hours|mon(day)?[\s-]|tue(sday)?[\s-]|wed(nesday)?[\s-]|thu(rsday)?[\s-]|fri(day)?[\s-]|sat(urday)?[\s-]|sun(day)?[\s-])\b/.test(lower);
  const hasContact = /\bphone\b|\bcall\b|\bcontact\b|\btel\b/.test(lower) || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) || /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(text);
  const hasAddress = /\b(street|st\.?|ave\.?|avenue|road|rd\.?|suite|ste\.?|blvd|boulevard|drive|dr\.?|lane|ln\.?|way|zip\s?code|located at|location)\b/.test(lower) ||
    /\b\d{1,5}\s+[a-z0-9.\s]{2,30}(street|st|ave|avenue|road|rd|blvd|drive|dr|lane|ln|way)\b/i.test(text) ||
    /\b\d{5}(-\d{4})?\b/.test(text);
  const hasAbout = /\b(mission|our story|about us|founded|established|we believe|we’re|we are a|our brand)\b/.test(lower);
  const hasPricing = /\$\s?\d|\bprice[s]?\b|\bmenu\b|\bpricing\b|\bstarting at\b/.test(lower);
  const hasTestimonials = /\breview[s]?\b|\btestimonial[s]?\b|customers?\s+say|5[\s-]?star/.test(lower);
  const hasSocialMention = /\binstagram\b|\bfacebook\b|\btiktok\b|\bfollow us\b/.test(lower);

  const improvements = [];
  if (!hasHours) improvements.push('Add your business hours so customers know when you\'re open.');
  if (!hasContact) improvements.push('Include a direct contact method (phone or email).');
  if (!hasAddress) improvements.push('Add a clear address or service area.');
  if (!hasAbout) improvements.push('Add a short "about us" story — customers trust businesses with a real story.');
  if (!hasPricing) improvements.push('Include pricing or a menu so customers know what to expect.');
  if (!hasTestimonials) improvements.push('Add a customer review or testimonial for trust and credibility.');
  if (!hasSocialMention) improvements.push('Mention your social profiles so people can follow you elsewhere.');

  return {
    wordCount: words,
    hasHours, hasContact, hasAddress, hasAbout, hasPricing, hasTestimonials, hasSocialMention,
    improvements
  };
}

// One entry point: extract + analyze in one call, always returning a
// well-formed result even on failure (mirrors auditWebsite's {ok, reason}
// shape for a consistent "real, or explicitly unavailable" contract
// throughout the app).
async function analyzeUploadedFile(absPath, mimetype, originalname) {
  if (!canExtract(mimetype)) {
    return { ok: false, filename: originalname, reason: 'That file type isn\'t analyzed for content yet — it\'s still attached to your profile.' };
  }
  const extracted = await extractText(absPath, mimetype);
  if (!extracted.ok || !extracted.text.trim()) {
    return { ok: false, filename: originalname, reason: extracted.reason || 'Could not find any readable text in this file.' };
  }
  const analysis = analyzeDocumentText(extracted.text);
  return Object.assign({ ok: true, filename: originalname, textExcerpt: extracted.text.slice(0, MAX_BRIEF_EXCERPT_CHARS) }, analysis);
}

// A short, plain-language summary line — same role as
// server/audit.js#auditSummaryLine, used as tool-result grounding for chat
// and as a one-liner in the UI.
function fileInsightSummaryLine(insight) {
  if (!insight.ok) return `Couldn't read "${insight.filename}" — ${insight.reason}`;
  const found = [];
  if (insight.hasHours) found.push('hours');
  if (insight.hasContact) found.push('contact info');
  if (insight.hasAddress) found.push('address');
  if (insight.hasAbout) found.push('an about/story section');
  if (insight.hasPricing) found.push('pricing');
  if (insight.hasTestimonials) found.push('testimonials');
  return `"${insight.filename}" (${insight.wordCount} words) — found ` +
    (found.length ? found.join(', ') : 'no concrete business details yet') + '.';
}

module.exports = { canExtract, extractText, analyzeDocumentText, analyzeUploadedFile, fileInsightSummaryLine, MAX_BRIEF_EXCERPT_CHARS };
