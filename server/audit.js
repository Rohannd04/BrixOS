// ---------------------------------------------------------------------------
// BrixOS site audit — the real "Scan" stage.
//
// Given a business's website URL, fetches the live page and inspects it for
// concrete, checkable signals: is it served over HTTPS, does it have a page
// title and meta description, is it mobile-friendly (a viewport tag), how
// much actual text content is on the page, does it carry structured data
// (JSON-LD) or Open Graph tags the way AI answer engines read, how many
// images are missing alt text, how long it took to respond.
//
// Deliberately regex/string-based, not a full HTML parser or headless
// browser — no new dependency to install, and every check is a simple,
// explainable yes/no a person could verify themselves by viewing source.
// It never throws: a fetch failure (unreachable site, timeout, DNS
// failure, HTTP error) is itself a signal, not a crash — every path
// returns a result object with `ok` set.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrixOSAudit/1.0; +https://brixos.site)' }
    });
    const elapsedMs = Date.now() - started;
    const html = await res.text();
    return { html, finalUrl: res.url || url, status: res.status, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

function extractTag(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : '';
}

function auditFromHtml(html, meta) {
  const title = extractTag(html, /<title[^>]*>([^<]*)<\/title>/i);
  const description =
    extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    extractTag(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasHttps = /^https:/i.test(meta.finalUrl);
  const ogTagCount = (html.match(/<meta[^>]+property=["']og:/gi) || []).length;
  const hasStructuredData = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const imagesMissingAlt = imgTags.filter((tag) => !/\balt\s*=/i.test(tag)).length;
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;
  const hasFavicon = /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(html);
  const hasH1 = /<h1\b/i.test(html);

  return {
    ok: true,
    finalUrl: meta.finalUrl,
    status: meta.status,
    responseMs: meta.elapsedMs,
    title,
    description,
    hasTitle: Boolean(title),
    hasDescription: Boolean(description),
    hasViewport: viewport,
    hasHttps,
    ogTagCount,
    hasStructuredData,
    hasFavicon,
    hasH1,
    imageCount: imgTags.length,
    imagesMissingAlt,
    wordCount,
    checkedAt: new Date().toISOString()
  };
}

async function auditWebsite(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return { ok: false, reason: 'NO_URL', checkedAt: new Date().toISOString() };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const { html, finalUrl, status, elapsedMs } = await fetchHtml(url);
    if (status >= 400) {
      return { ok: false, reason: 'HTTP_' + status, finalUrl, status, checkedAt: new Date().toISOString() };
    }
    return auditFromHtml(html, { finalUrl, status, elapsedMs });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE';
    return { ok: false, reason, error: err.message, checkedAt: new Date().toISOString() };
  }
}

// Turns audit signals into plain-language, prioritized recommendations.
// Used directly by the local (no-API-key) chat fallback, and handed to the
// real chat/Planner agents as grounding so their own reply/plan reflects
// what was actually found instead of generic advice.
function auditImprovements(audit) {
  if (!audit) return [];

  if (!audit.ok) {
    switch (audit.reason) {
      case 'TIMEOUT':
        return ['Your website took too long to respond — a slow first load is one of the fastest ways to lose a mobile visitor.'];
      case 'UNREACHABLE':
        return ['BrixOS could not reach that website right now — double check the link is correct and the site is live.'];
      case 'NO_URL':
        return [];
      default:
        return audit.reason && audit.reason.startsWith('HTTP_')
          ? [`That link returned an error (${audit.reason.replace('HTTP_', 'HTTP ')}) — make sure it points at a live page, not a broken or moved one.`]
          : ['BrixOS could not analyze that link — double check it is a full, working URL.'];
    }
  }

  const out = [];
  if (!audit.hasHttps) out.push('Serve your site over HTTPS — browsers flag non-secure sites, which costs both trust and search ranking.');
  if (!audit.hasTitle) out.push('Add a page title — right now search engines and browser tabs have nothing to show.');
  if (!audit.hasDescription) out.push('Add a meta description — that\'s the snippet shown under your link in search results, and yours is missing.');
  if (!audit.hasViewport) out.push('Add a mobile viewport tag — without one, your site likely looks zoomed-out and hard to use on a phone.');
  if (!audit.hasH1) out.push('Add a clear H1 headline — it helps visitors and search engines understand the page at a glance.');
  if (audit.wordCount < 150) out.push(`Add more real page content — thin pages (yours has about ${audit.wordCount} words) rank and convert worse.`);
  if (audit.imageCount > 0 && audit.imagesMissingAlt > 0) {
    out.push(`Add alt text to ${audit.imagesMissingAlt} image${audit.imagesMissingAlt === 1 ? '' : 's'} missing it — helps accessibility, SEO, and lets AI assistants describe your photos.`);
  }
  if (!audit.hasStructuredData) out.push('Add structured data (schema.org JSON-LD) — this is what lets AI assistants and Google\'s AI Overviews quote your business accurately.');
  if (!audit.hasFavicon) out.push('Add a favicon — a small detail, but a missing one reads as an unfinished or abandoned site.');
  if (audit.responseMs > 3000) out.push(`Speed up your homepage — it took ${(audit.responseMs / 1000).toFixed(1)}s to respond, well past what most visitors will wait for.`);

  if (!out.length) out.push('Your site covers the basics well — HTTPS, a title, a description, and mobile support are all in place.');
  return out;
}

// One-line human summary, used as tool-result grounding for the real chat
// agent (so its own natural-language reply can reference real findings).
function auditSummaryLine(audit) {
  if (!audit) return '';
  if (!audit.ok) return `Audit could not complete (${audit.reason}).`;
  return (
    `HTTPS: ${audit.hasHttps ? 'yes' : 'no'} · title: ${audit.hasTitle ? 'yes' : 'no'} · ` +
    `meta description: ${audit.hasDescription ? 'yes' : 'no'} · mobile viewport: ${audit.hasViewport ? 'yes' : 'no'} · ` +
    `H1: ${audit.hasH1 ? 'yes' : 'no'} · structured data: ${audit.hasStructuredData ? 'yes' : 'no'} · ` +
    `~${audit.wordCount} words · ${audit.imagesMissingAlt} image(s) missing alt text · ` +
    `responded in ${(audit.responseMs / 1000).toFixed(1)}s`
  );
}

module.exports = { auditWebsite, auditImprovements, auditSummaryLine };
