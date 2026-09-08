// ---------------------------------------------------------------------------
// BrixOS site template — the hand-crafted visual layer every generated page
// now renders through.
//
// Why this exists: the Orchestrator used to ask a free OpenRouter model to
// hand-write each page's full HTML/CSS from scratch (see the old
// ORCHESTRATOR_BUILDER_SYSTEM prompt). Free models are fine at filling in
// copy but inconsistent at inventing a whole design system, so the result
// varied wildly and — whenever a page's generation call failed or returned
// nothing usable — silently fell back to a very plain, generic local
// template. That's what "it is generating like this, i dont want like
// this" was pointing at.
//
// This module inverts that: BrixOS owns one small library of hand-crafted,
// production-quality page designs (a header/hero/numbered-section/footer
// system modeled on real professional small-business sites), and an
// AI reasoning call (when available) only ever supplies CONTENT — headline/
// body copy, section order, SEO metadata — never markup or CSS. The
// business's own category picks one of a few curated palettes/vibes
// (adaptive per business type, not one-size-fits-all), and any photos the
// business uploaded get woven into the hero/gallery the same way a
// real hand-built site would use them, with tasteful CSS-only visuals as
// the fallback when there are none. The output is deterministic HTML, so it
// always passes structural validation and never depends on a model's raw
// design taste — only its judgment about what the business needs said.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------------------
// preview-safe internal navigation (moved here from orchestrator.js — this
// module now owns every full-page HTML string that gets produced, model-
// authored copy or not)
// ---------------------------------------------------------------------------

const PREVIEW_SAFE_NAV_SCRIPT = `<script>
(function(){
  if (window.self === window.top) return;
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^[a-zA-Z0-9_-]+\\.html(#.*)?$/.test(href)) { e.preventDefault(); }
  }, true);
})();
</` + `script>`;

function injectPreviewSafeNavScript(html) {
  if (!html) return html;
  if (html.includes(PREVIEW_SAFE_NAV_SCRIPT)) return html;
  const closeBodyMatch = html.match(/<\/body\s*>/i);
  if (closeBodyMatch) {
    const idx = html.lastIndexOf(closeBodyMatch[0]);
    return html.slice(0, idx) + PREVIEW_SAFE_NAV_SCRIPT + '\n' + html.slice(idx);
  }
  return html + PREVIEW_SAFE_NAV_SCRIPT;
}

// ---------------------------------------------------------------------------
// palettes — a small curated library, picked by business category, never by
// the model. Each is a complete, hand-tuned visual identity: two content
// backgrounds (a light band and a dark/contrast band, like a real designed
// site alternates), a heading font, a body font, and an italic accent font
// for eyebrow labels/pull-quotes.
// ---------------------------------------------------------------------------

const PALETTES = {
  'bold-dark': {
    id: 'bold-dark',
    label: 'Bold & bold-dark',
    bg: '#F7F1E6', panel: '#FFFFFF', text: '#211712', muted: '#6B5C4E', border: 'rgba(33,23,18,.12)',
    band: '#5C1220', bandText: '#F7EEE2', bandMuted: '#D8B9AE',
    accent: '#E23B33', accent2: '#E9B949', accentText: '#FFFFFF',
    headingFont: 'Archivo', bodyFont: 'Inter', accentFont: 'Fraunces',
    googleFonts: 'family=Archivo:wght@600;800&family=Inter:wght@400;500;600&family=Fraunces:ital,wght@1,500;1,600'
  },
  'soft-pastel': {
    id: 'soft-pastel',
    label: 'Soft & calm',
    bg: '#FBF3F6', panel: '#FFFFFF', text: '#3A2A33', muted: '#8A7480', border: 'rgba(58,42,51,.12)',
    band: '#4A3B4E', bandText: '#F6EEF3', bandMuted: '#CBB9C8',
    accent: '#C7739A', accent2: '#8FA998', accentText: '#FFFFFF',
    headingFont: 'Poppins', bodyFont: 'Inter', accentFont: 'Playfair Display',
    googleFonts: 'family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600&family=Playfair+Display:ital,wght@1,500;1,600'
  },
  'modern-blue': {
    id: 'modern-blue',
    label: 'Modern & corporate',
    bg: '#F3F5F8', panel: '#FFFFFF', text: '#131C2B', muted: '#5B6B82', border: 'rgba(19,28,43,.12)',
    band: '#0F2340', bandText: '#EEF3FA', bandMuted: '#AFC0D8',
    accent: '#2D6CDF', accent2: '#7FA6E0', accentText: '#FFFFFF',
    headingFont: 'Archivo', bodyFont: 'Inter', accentFont: 'Newsreader',
    googleFonts: 'family=Archivo:wght@600;800&family=Inter:wght@400;500;600&family=Newsreader:ital,wght@1,500;1,600'
  },
  'fresh-green': {
    id: 'fresh-green',
    label: 'Fresh & natural',
    bg: '#F5F7EF', panel: '#FFFFFF', text: '#1B2A1D', muted: '#5D6E58', border: 'rgba(27,42,29,.12)',
    band: '#16331F', bandText: '#F0F5EC', bandMuted: '#BFD1B9',
    accent: '#3F7D4A', accent2: '#C9A227', accentText: '#FFFFFF',
    headingFont: 'Fraunces', bodyFont: 'IBM Plex Sans', accentFont: 'Fraunces',
    googleFonts: 'family=Fraunces:ital,wght@0,600;1,500&family=IBM+Plex+Sans:wght@400;500;600'
  },
  'warm-earthy': {
    id: 'warm-earthy',
    label: 'Warm & handcrafted',
    bg: '#F7F1E6', panel: '#FFFFFF', text: '#1E1912', muted: '#67594A', border: 'rgba(33,27,20,.12)',
    band: '#2B2118', bandText: '#F5ECDE', bandMuted: '#C9B7A0',
    accent: '#B5622E', accent2: '#E8A33D', accentText: '#FFFFFF',
    headingFont: 'Fraunces', bodyFont: 'IBM Plex Sans', accentFont: 'Fraunces',
    googleFonts: 'family=Fraunces:ital,wght@0,600;1,500&family=IBM+Plex+Sans:wght@400;500;600'
  }
};

const PALETTE_KEYWORDS = [
  ['bold-dark', ['pg for', ' pg ', 'hostel', 'gym', 'fitness', 'crossfit', 'martial arts', 'boxing', 'mma', 'security', 'garage', 'auto repair', 'automotive', 'mechanic', 'coaching', 'academy', 'bootcamp', 'nightclub', ' bar ', 'pub', 'barber', 'tattoo']],
  ['soft-pastel', ['salon', 'spa', 'beauty', 'wellness', 'yoga', 'skincare', 'nails', 'massage', 'cosmetic', 'esthetic', 'pilates']],
  ['modern-blue', ['consulting', 'agency', ' law ', 'legal', 'attorney', 'finance', 'financial', 'accounting', 'real estate', 'realty', 'insurance', 'software', 'startup', 'marketing agency', 'it services']],
  ['fresh-green', ['grocery', 'organic', 'farm', 'landscap', 'garden', 'eco-', 'sustainab', 'health food', 'nutrition', 'nursery']],
  ['warm-earthy', ['bakery', 'cafe', 'coffee', 'pottery', 'ceramic', 'boutique', 'florist', 'restaurant', 'diner', 'kitchen', 'catering', 'craft', 'handmade', 'artisan', 'decor', 'furniture', 'tailor', 'jewelry']]
];

function pickPalette(profile, plan) {
  const text = [
    profile && profile.business,
    plan && plan.project_type,
    plan && plan.business_understanding,
    plan && plan.design_system && plan.design_system.tone
  ].filter(Boolean).join(' ').toLowerCase();
  const padded = ' ' + text + ' ';

  for (const [id, keywords] of PALETTE_KEYWORDS) {
    if (keywords.some((k) => padded.includes(k))) return PALETTES[id];
  }
  return PALETTES['warm-earthy'];
}

// ---------------------------------------------------------------------------
// photos — embedded as base64 data URIs so the generated page stays a real,
// portable, self-contained file (works identically in the sandboxed
// preview, the "open in new tab" blob page, and a downloaded ZIP opened
// offline — none of which can reach a relative /uploads/... URL the way the
// live embedded preview iframe currently can).
// ---------------------------------------------------------------------------

const MAX_PHOTO_BYTES = 1.8 * 1024 * 1024; // skip embedding anything larger, to keep the page itself light
const MAX_PHOTOS_USED = 6;

function photoDataUri(photo) {
  try {
    if (!photo || !photo.url) return null;
    const rel = String(photo.url).replace(/^\/uploads\//, '');
    const abs = path.join(UPLOADS_ROOT, rel);
    if (!abs.startsWith(UPLOADS_ROOT)) return null; // defensive: never read outside uploads/
    const stat = fs.statSync(abs);
    if (stat.size > MAX_PHOTO_BYTES) return null;
    const buf = fs.readFileSync(abs);
    const mime = photo.mimetype || 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    return null; // missing/unreadable file — just skip it, never fail generation over a photo
  }
}

function collectPhotoDataUris(profile) {
  const photos = Array.isArray(profile && profile.photos) ? profile.photos : [];
  const out = [];
  for (const p of photos) {
    if (out.length >= MAX_PHOTOS_USED) break;
    const uri = photoDataUri(p);
    if (uri) out.push(uri);
  }
  return out;
}

// ---------------------------------------------------------------------------
// small content helpers
// ---------------------------------------------------------------------------

function numberLabel(n) {
  return String(n).padStart(2, '0');
}

function initialsOf(name) {
  const words = String(name || 'B').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'B';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Splits body copy into a slightly larger "lede" (first sentence) and the
// remaining sentences as regular muted paragraph text — a cheap, safe way to
// get the same visual hierarchy a hand-written page has, without any
// fragile parsing of AI-authored text.
function splitLede(body) {
  const text = String(body || '').trim();
  const match = text.match(/^(.+?[.!?])(\s+(.*))?$/s);
  if (!match) return { lede: text, rest: '' };
  return { lede: match[1], rest: (match[3] || '').trim() };
}

function toneEyebrow(plan) {
  const source = (plan.design_system && plan.design_system.tone) || plan.project_type || '';
  const words = String(source)
    .split(/[^a-zA-Z]+/)
    .filter((w) => w && w.length > 2 && !['and', 'the', 'for', 'with'].includes(w.toLowerCase()));
  if (!words.length) return 'BRIXOS PRESENCE ENGINE';
  return words.slice(0, 3).map((w) => w.toUpperCase()).join(' · ');
}

// A short highlight strip (like a real site's amenities/feature ticker) —
// built from the plan's own SEO keywords, which are already short, real,
// business-specific phrases rather than anything invented here.
function keywordStrip(plan) {
  const kws = (plan.seo_strategy && Array.isArray(plan.seo_strategy.keywords)) ? plan.seo_strategy.keywords : [];
  const clean = kws.map((k) => String(k || '').trim()).filter((k) => k && k.length <= 32).slice(0, 5);
  return clean.map((k) => k.toUpperCase());
}

function contactLinks(profile) {
  const links = [];
  if (profile.map) links.push({ label: 'Get directions', href: profile.map });
  if (profile.gmail) links.push({ label: profile.gmail, href: 'mailto:' + profile.gmail });
  if (profile.website) links.push({ label: 'Website', href: profile.website });
  if (profile.instagram) links.push({ label: 'Instagram', href: profile.instagram });
  if (profile.facebook) links.push({ label: 'Facebook', href: profile.facebook });
  return links;
}

// ---------------------------------------------------------------------------
// section renderers
// ---------------------------------------------------------------------------

function renderHero(section, plan, profile, palette, heroPhoto) {
  const eyebrow = toneEyebrow(plan);
  const strip = keywordStrip(plan);
  const links = contactLinks(profile).slice(0, 1);

  const visual = heroPhoto
    ? `<div class="bx-hero-photo"><img src="${heroPhoto}" alt="${escapeHtml(plan.business_understanding ? '' : '')}${escapeHtml((profile && profile.business) || 'Business photo')}" loading="eager"></div>`
    : `<div class="bx-hero-art" aria-hidden="true"><span class="bx-blob bx-blob-a"></span><span class="bx-blob bx-blob-b"></span><span class="bx-blob bx-blob-c"></span></div>`;

  return `
  <section class="bx-hero">
    <div class="bx-hero-inner">
      <p class="bx-eyebrow bx-eyebrow-on-band">${escapeHtml(eyebrow)}</p>
      <h1>${escapeHtml(section.headline)}</h1>
      <p class="bx-hero-sub">${escapeHtml(section.body)}</p>
      <div class="bx-hero-actions">
        <a class="bx-btn bx-btn-primary" href="contact.html">${escapeHtml(section.cta || 'Get in touch')} <span aria-hidden="true">&#8599;</span></a>
        ${links.map((l) => `<a class="bx-quiet-link bx-quiet-link-on-band" href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join('')}
      </div>
    </div>
    ${visual}
    ${strip.length ? `<div class="bx-strip"><div class="bx-strip-track">${strip.map((s) => `<span>${escapeHtml(s)}</span><span class="bx-strip-dot" aria-hidden="true">&#10022;</span>`).join('')}</div></div>` : ''}
  </section>`;
}

function renderPageHeader(section, plan, profile, extraPhotos) {
  const extra = renderExtraForType(section.type, plan, profile, extraPhotos);
  return `
  <section class="bx-pageheader">
    <p class="bx-eyebrow bx-eyebrow-on-band">${escapeHtml(section.type || 'overview').toUpperCase()}</p>
    <h1>${escapeHtml(section.headline)}</h1>
    ${section.body ? `<p class="bx-pageheader-sub">${escapeHtml(section.body)}</p>` : ''}
    ${extra ? `<div class="bx-pageheader-extra">${extra}</div>` : ''}
  </section>`;
}

function renderGallery(photos, businessName) {
  if (!photos.length) {
    // No real photos to show — a tasteful CSS-only placeholder grid rather
    // than either an empty section or an invented stock photo.
    return `
    <div class="bx-gallery bx-gallery-placeholder" aria-hidden="true">
      ${[0, 1, 2].map((i) => `<div class="bx-gallery-item bx-gallery-tile bx-gallery-tile-${i}"></div>`).join('')}
    </div>`;
  }
  return `
    <div class="bx-gallery">
      ${photos.map((src, i) => `<div class="bx-gallery-item"><img src="${src}" alt="${escapeHtml(businessName)} photo ${i + 1}" loading="lazy"></div>`).join('')}
    </div>`;
}

function renderFaq(faq) {
  if (!faq || !faq.length) return '';
  return `
    <div class="bx-faq">
      ${faq.slice(0, 6).map((f) => `
      <div class="bx-faq-item">
        <p class="bx-faq-q">${escapeHtml(f.q)}</p>
        <p class="bx-faq-a">${escapeHtml(f.a)}</p>
      </div>`).join('')}
    </div>`;
}

function renderContactDetails(profile) {
  const links = contactLinks(profile);
  if (!links.length) return '';
  return `
    <div class="bx-contact-links">
      ${links.map((l) => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join('')}
    </div>`;
}

// Type-specific extra content, shared between renderBand and
// renderPageHeader — a section carrying real functional content (contact
// links, an FAQ list, a photo gallery) needs to show it wherever that
// section lands on the page, including when it happens to be a page's only
// (and therefore header-rendered) section. A Contact page with nothing but
// a headline and no actual contact links would be a real functional gap,
// not just a cosmetic one.
function renderExtraForType(type, plan, profile, extraPhotos) {
  if (type === 'gallery') return renderGallery(extraPhotos, profile.business || 'Business');
  if (type === 'faq') return renderFaq((plan.aeo_geo_strategy && plan.aeo_geo_strategy.faq) || []);
  if (type === 'contact') return renderContactDetails(profile);
  return '';
}

// A standard alternating-band content section — the workhorse of every page
// after its header. `index` drives both the numbered eyebrow and the
// light/dark alternation.
function renderBand(section, index, isDark, plan, profile, extraPhotos) {
  const { lede, rest } = splitLede(section.body);
  const num = numberLabel(index);
  const typeLabel = String(section.type || 'more').toUpperCase();
  const extra = renderExtraForType(section.type, plan, profile, extraPhotos);

  return `
  <section class="bx-band ${isDark ? 'bx-band-dark' : 'bx-band-light'}">
    <div class="bx-band-inner">
      <p class="bx-eyebrow ${isDark ? 'bx-eyebrow-on-band' : ''}">${num} / ${escapeHtml(typeLabel)}</p>
      <h2>${escapeHtml(section.headline)}</h2>
      <p class="bx-lede">${escapeHtml(lede)}</p>
      ${rest ? `<p class="bx-body">${escapeHtml(rest)}</p>` : ''}
      ${section.cta ? `<a class="bx-arrow-link" href="contact.html">${escapeHtml(section.cta)} <span aria-hidden="true">&#8594;</span></a>` : ''}
      ${extra}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// full page
// ---------------------------------------------------------------------------

function css(palette) {
  return `
  :root {
    --bg: ${palette.bg}; --panel: ${palette.panel}; --text: ${palette.text}; --muted: ${palette.muted}; --border: ${palette.border};
    --band: ${palette.band}; --band-text: ${palette.bandText}; --band-muted: ${palette.bandMuted};
    --accent: ${palette.accent}; --accent-2: ${palette.accent2}; --accent-text: ${palette.accentText};
    --font-heading: '${palette.headingFont}', system-ui, sans-serif;
    --font-body: '${palette.bodyFont}', system-ui, sans-serif;
    --font-accent: '${palette.accentFont}', Georgia, serif;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-body); line-height: 1.6; }
  img { max-width: 100%; display: block; }
  a { color: inherit; }
  .bx-eyebrow { font-family: var(--font-accent); font-style: italic; letter-spacing: .04em; font-size: 14px; color: var(--accent); margin: 0 0 14px; }
  .bx-eyebrow-on-band { color: var(--accent-2); }

  header.bx-header { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 6vw; background: rgba(247,241,230,.001); backdrop-filter: blur(6px); background: color-mix(in srgb, var(--bg) 88%, transparent); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .bx-brand { display: flex; align-items: center; gap: 12px; font-family: var(--font-heading); font-weight: 700; }
  .bx-brand-mark { width: 38px; height: 38px; border: 2px solid var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; color: var(--accent); flex: none; }
  .bx-brand-name { font-size: 18px; }
  nav.bx-nav { display: flex; gap: 22px; flex-wrap: wrap; }
  nav.bx-nav a { text-decoration: none; font-size: 14px; font-weight: 600; color: var(--text); opacity: .8; }
  nav.bx-nav a:hover { opacity: 1; }

  .bx-hero { position: relative; padding: 56px 6vw 0; overflow: hidden; background: var(--band); color: var(--band-text); }
  .bx-hero-inner { max-width: 760px; margin: 0 auto; text-align: center; padding-bottom: 40px; }
  .bx-hero h1 { font-family: var(--font-heading); font-weight: 800; font-size: clamp(34px, 6vw, 58px); line-height: 1.05; margin: 0 0 20px; color: var(--band-text); }
  .bx-hero-sub { color: var(--band-muted); font-size: 18px; max-width: 560px; margin: 0 auto 30px; }
  .bx-hero-actions { display: flex; align-items: center; justify-content: center; gap: 22px; flex-wrap: wrap; }
  .bx-btn { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; font-weight: 700; padding: 14px 26px; border-radius: 999px; font-size: 15px; }
  .bx-btn-primary { background: var(--accent); color: var(--accent-text); }
  .bx-quiet-link { text-decoration: underline; font-size: 14px; color: var(--muted); }
  .bx-quiet-link-on-band { color: var(--band-muted); }
  .bx-hero-photo { max-width: 980px; margin: 0 auto; border-radius: 20px; overflow: hidden; aspect-ratio: 16/8; }
  .bx-hero-photo img { width: 100%; height: 100%; object-fit: cover; }
  .bx-hero-art { max-width: 980px; margin: 0 auto; border-radius: 20px; height: 220px; position: relative; overflow: hidden; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); }
  .bx-blob { position: absolute; border-radius: 50%; filter: blur(2px); opacity: .6; }
  .bx-blob-a { width: 220px; height: 220px; background: var(--accent); left: -60px; top: -60px; }
  .bx-blob-b { width: 180px; height: 180px; background: var(--accent-2); right: -40px; top: 20px; }
  .bx-blob-c { width: 140px; height: 140px; background: rgba(255,255,255,.4); right: 30%; bottom: -70px; opacity: .25; }
  .bx-strip { margin-top: 34px; background: var(--accent); color: var(--accent-text); overflow: hidden; }
  .bx-strip-track { display: flex; gap: 28px; padding: 12px 6vw; flex-wrap: wrap; justify-content: center; font-size: 13px; font-weight: 600; letter-spacing: .04em; }
  .bx-strip-dot:last-child { display: none; }
  .bx-strip span:last-child.bx-strip-dot { display: none; }

  .bx-pageheader { background: var(--band); color: var(--band-text); padding: 64px 6vw 56px; text-align: center; }
  .bx-pageheader h1 { font-family: var(--font-heading); font-weight: 800; font-size: clamp(30px, 5vw, 46px); margin: 0 0 12px; }
  .bx-pageheader-sub { color: var(--band-muted); max-width: 560px; margin: 0 auto; }
  .bx-pageheader-extra { margin-top: 28px; max-width: 640px; margin-left: auto; margin-right: auto; text-align: left; }
  .bx-pageheader-extra .bx-contact-links { justify-content: center; }
  .bx-pageheader-extra .bx-contact-links a { border-color: rgba(255,255,255,.3); color: var(--band-text); }
  .bx-pageheader-extra .bx-faq-item { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.16); }
  .bx-pageheader-extra .bx-faq-q { color: var(--band-text); }
  .bx-pageheader-extra .bx-faq-a { color: var(--band-muted); }

  .bx-band { padding: 64px 6vw; }
  .bx-band-light { background: var(--bg); }
  .bx-band-dark { background: var(--band); color: var(--band-text); }
  .bx-band-dark .bx-lede { color: var(--band-text); }
  .bx-band-dark .bx-body { color: var(--band-muted); }
  .bx-band-inner { max-width: 760px; margin: 0 auto; }
  .bx-band h2 { font-family: var(--font-heading); font-weight: 700; font-size: clamp(24px, 4vw, 36px); margin: 0 0 18px; }
  .bx-lede { font-size: 18px; font-weight: 500; margin: 0 0 10px; }
  .bx-body { color: var(--muted); margin: 0 0 10px; }
  .bx-arrow-link { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; text-decoration: none; font-weight: 700; color: var(--accent); }
  .bx-band-dark .bx-arrow-link { color: var(--accent-2); }

  .bx-gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 24px; }
  .bx-gallery-item { border-radius: 14px; overflow: hidden; aspect-ratio: 4/3; }
  .bx-gallery-item img { width: 100%; height: 100%; object-fit: cover; }
  .bx-gallery-tile { background: linear-gradient(135deg, var(--accent), var(--accent-2)); opacity: .22; }
  .bx-gallery-tile-1 { opacity: .32; background: linear-gradient(135deg, var(--accent-2), var(--accent)); }
  .bx-gallery-tile-2 { opacity: .16; }

  .bx-faq { margin-top: 20px; display: grid; gap: 18px; }
  .bx-faq-item { padding: 18px 20px; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; }
  .bx-band-dark .bx-faq-item { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); }
  .bx-faq-q { font-weight: 700; margin: 0 0 6px; }
  .bx-faq-a { color: var(--muted); margin: 0; }
  .bx-band-dark .bx-faq-a { color: var(--band-muted); }

  .bx-contact-links { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 14px 22px; }
  .bx-contact-links a { text-decoration: none; font-weight: 600; padding: 10px 18px; border-radius: 999px; border: 1px solid var(--border); }
  .bx-band-dark .bx-contact-links a { border-color: rgba(255,255,255,.25); }

  footer.bx-footer { padding: 40px 6vw; border-top: 1px solid var(--border); text-align: center; color: var(--muted); font-size: 14px; }
  footer.bx-footer nav { display: flex; justify-content: center; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; }
  footer.bx-footer nav a { text-decoration: none; color: var(--text); font-weight: 600; font-size: 13px; }

  @media (max-width: 640px) {
    header.bx-header { padding: 14px 5vw; }
    .bx-hero { padding-top: 40px; }
    .bx-band, .bx-pageheader { padding-left: 5vw; padding-right: 5vw; }
  }
  `;
}

function renderSitePage({ task, plan, profile, allTasks, palette, homeSlug, photos }) {
  const businessName = (profile && profile.business) || (plan.pages && plan.pages[0] && plan.pages[0].title) || 'Your Business';
  const navHtml = allTasks.map((t) => `<a href="${t.slug}.html">${escapeHtml(t.navLabel)}</a>`).join('');
  const isHome = task.slug === homeSlug;
  const sections = Array.isArray(task.sections) ? task.sections.filter(Boolean) : [];

  const heroPhoto = photos && photos[0];
  const galleryPhotos = photos ? photos.slice(1) : [];

  let bodyHtml = '';
  let bandIndex = 1;
  sections.forEach((section, i) => {
    if (i === 0 && isHome && section.type === 'hero') {
      bodyHtml += renderHero(section, plan, profile, palette, heroPhoto);
    } else if (i === 0) {
      bodyHtml += renderPageHeader(section, plan, profile, galleryPhotos);
    } else {
      const isDark = bandIndex % 2 === 0;
      bodyHtml += renderBand(section, bandIndex, isDark, plan, profile, galleryPhotos);
      bandIndex++;
    }
  });

  const seoTitle = (plan.seo_strategy && plan.seo_strategy.title) || task.title || businessName;
  const seoDescription = (plan.seo_strategy && plan.seo_strategy.description) || '';
  const initials = initialsOf(businessName);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(task.title || seoTitle)}</title>
<meta name="description" content="${escapeHtml(seoDescription)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${palette.googleFonts}&display=swap">
<style>${css(palette)}</style>
</head>
<body>
  <header class="bx-header">
    <div class="bx-brand">
      <span class="bx-brand-mark">${escapeHtml(initials)}</span>
      <span class="bx-brand-name">${escapeHtml(businessName)}</span>
    </div>
    <nav class="bx-nav">${navHtml}</nav>
  </header>
  ${bodyHtml}
  <footer class="bx-footer">
    <nav>${navHtml}</nav>
    ${renderContactDetails(profile)}
    <p>${escapeHtml(businessName)} &middot; Built with BrixOS</p>
  </footer>
</body>
</html>`;

  return injectPreviewSafeNavScript(html);
}

module.exports = {
  PALETTES,
  pickPalette,
  collectPhotoDataUris,
  renderSitePage,
  PREVIEW_SAFE_NAV_SCRIPT,
  injectPreviewSafeNavScript,
  escapeHtml
};
