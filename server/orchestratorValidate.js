// ---------------------------------------------------------------------------
// BrixOS Orchestrator — VALIDATE stage.
//
// Structural, explainable checks on a generated page's HTML — deliberately
// regex/string-based rather than a full HTML parser or headless browser (no
// new dependency to install), matching the style server/audit.js already
// uses for the live-website audit. Every check here is something a person
// could verify themselves by viewing source.
//
// Returns { ok, errors, warnings } — `errors` are things worth sending back
// to the generation worker for a fix (server/orchestrator.js's FIX stage);
// `warnings` are surfaced to the user but don't block PREVIEW/export on
// their own.
// ---------------------------------------------------------------------------

// Void elements never need (and must not have) a matching close tag — they
// are excluded from the open/close balance check below.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Tags whose imbalance is fatal enough to actively break rendering (an
// unclosed <script> or <style> can swallow the rest of the page) — these
// become hard errors. Everything else that's imbalanced is a soft warning;
// real browsers recover from a stray unclosed <div> just fine.
const CRITICAL_TAGS = ['html', 'head', 'body', 'script', 'style'];
const SOFT_TAGS = ['div', 'section', 'header', 'footer', 'nav', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'form', 'a', 'p', 'button'];

function countTag(html, tag) {
  const openRe = new RegExp('<' + tag + '(?:\\s[^>]*)?>', 'gi');
  const closeRe = new RegExp('<\\/' + tag + '\\s*>', 'gi');
  const opens = (html.match(openRe) || []).length;
  const closes = (html.match(closeRe) || []).length;
  return { opens, closes };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Loosely checks whether a section's headline made it into the page at all
// — the Builder is free to polish/reword body copy, but a headline that's
// completely absent usually means that section got dropped, not reworded.
function headlinePresent(html, headline) {
  const norm = normalize(headline);
  if (!norm) return true; // nothing to check
  const htmlNorm = normalize(html);
  if (htmlNorm.includes(norm)) return true;
  // fall back to a looser check: most of the significant words showed up
  // somewhere, even if not contiguous (the model may have reworded it)
  const words = norm.split(' ').filter((w) => w.length > 3);
  if (!words.length) return true;
  const hitCount = words.filter((w) => htmlNorm.includes(w)).length;
  return hitCount / words.length >= 0.5;
}

// html: the generated page's full HTML string
// page: { slug, title, sections: [{headline, ...}] } — the plan's spec for
// this one page, used to check content coverage.
function validatePage(html, page) {
  const errors = [];
  const warnings = [];
  const src = String(html || '');

  if (!src.trim()) {
    errors.push('Generated page is empty.');
    return { ok: false, errors, warnings };
  }

  if (!/^\s*<!doctype html>/i.test(src)) {
    errors.push('Missing <!doctype html> at the start of the file.');
  }

  if (!/<title[^>]*>[^<]+<\/title>/i.test(src)) {
    errors.push('Missing a non-empty <title> tag.');
  }

  if (!/<meta[^>]+name=["']viewport["']/i.test(src)) {
    errors.push('Missing a mobile viewport <meta> tag.');
  }

  if (!/<h1\b/i.test(src)) {
    warnings.push('No <h1> headline found on the page.');
  }

  if (/\{\{\s*[\w.]+\s*\}\}/.test(src)) {
    errors.push('Leftover unresolved template placeholder(s) like {{ ... }} found in the output.');
  }

  if (/\bTODO\b|\bFIXME\b|\bLOREM IPSUM\b/i.test(src)) {
    warnings.push('Placeholder text (TODO/FIXME/lorem ipsum) found — looks unfinished.');
  }

  CRITICAL_TAGS.forEach((tag) => {
    const { opens, closes } = countTag(src, tag);
    if (opens !== closes) {
      errors.push(`Unbalanced <${tag}> — ${opens} opening tag(s) vs ${closes} closing tag(s).`);
    }
  });

  SOFT_TAGS.forEach((tag) => {
    const { opens, closes } = countTag(src, tag);
    if (opens !== closes) {
      warnings.push(`Possibly unbalanced <${tag}> — ${opens} opening tag(s) vs ${closes} closing tag(s).`);
    }
  });

  const sections = (page && Array.isArray(page.sections)) ? page.sections : [];
  if (sections.length) {
    const missing = sections.filter((s) => s && s.headline && !headlinePresent(src, s.headline));
    const coverage = (sections.length - missing.length) / sections.length;
    if (coverage < 0.5) {
      errors.push(
        `Only ${sections.length - missing.length}/${sections.length} planned section(s) actually appear on the page ` +
        `(missing: ${missing.map((s) => `"${s.headline}"`).join(', ')}).`
      );
    } else if (missing.length) {
      warnings.push(`${missing.length} planned section(s) don't clearly appear on the page: ${missing.map((s) => `"${s.headline}"`).join(', ')}.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// pages: { [slug]: html } — every generated page in the project
// plan: the orchestrator plan (pages[], navigation[], ...)
// Cross-page checks: do internal nav links actually point at pages that
// exist? A dangling link ("About" pointing at about.html when that page
// failed to generate) is exactly the kind of thing a single-page validator
// can't see.
function validateProject(pages, plan) {
  const warnings = [];
  const slugs = new Set(Object.keys(pages || {}));

  Object.keys(pages || {}).forEach((slug) => {
    const html = pages[slug];
    const hrefs = (html.match(/href=["']([a-zA-Z0-9_\-]+\.html)["']/g) || [])
      .map((m) => m.match(/href=["']([^"']+)["']/)[1].replace(/\.html$/, ''));
    hrefs.forEach((target) => {
      if (target && !slugs.has(target)) {
        warnings.push(`Page "${slug}" links to "${target}.html", which wasn't generated.`);
      }
    });
  });

  return { ok: true, errors: [], warnings };
}

module.exports = { validatePage, validateProject };
