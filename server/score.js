// ---------------------------------------------------------------------------
// BrixOS Presence Score — shared scoring model
//
// Official 7-dimension model with default weights (must total 100):
//   Business/profile completeness  15%
//   Trust and credibility          15%
//   UX and conversion              20%
//   Technical quality              15%
//   SEO                            15%
//   AEO/GEO readiness              10%
//   Content and freshness          10%
//
// This is the single source of truth for the score calculation. The frontend
// mirrors the same numbers only for optimistic UI updates — the server's
// result (from /api/profile) is always what gets persisted and displayed.
// ---------------------------------------------------------------------------

const WEIGHTS = {
  completeness: 15,
  trust: 15,
  ux: 20,
  technical: 15,
  seo: 15,
  aeogeo: 10,
  content: 10
};

const DIMENSIONS = Object.keys(WEIGHTS);

// every field/attachment the "+" menu can populate
const ATTACHMENTS = [
  'business', 'website', 'instagram', 'facebook',
  'social', 'map', 'gmail', 'photos', 'files'
];

// how much each attachment contributes toward each dimension (sums to 100 per dimension)
const CONTRIB = {
  trust: { photos: 16, map: 18, instagram: 10, facebook: 14, social: 14, files: 18, gmail: 10 },
  ux: { website: 45, photos: 30, map: 25 },
  technical: { website: 70, photos: 30 },
  seo: { business: 25, website: 35, map: 25, facebook: 15 },
  aeogeo: { business: 10, website: 15, instagram: 25, facebook: 25, social: 25 },
  content: { photos: 22, instagram: 18, facebook: 18, social: 14, files: 18, gmail: 10 }
};

function presentAttachments(profile) {
  const present = {};
  present.business = Boolean(profile.business && profile.business.trim());
  present.website = Boolean(profile.website);
  present.instagram = Boolean(profile.instagram);
  present.facebook = Boolean(profile.facebook);
  present.social = Boolean(profile.social);
  present.map = Boolean(profile.map);
  present.gmail = Boolean(profile.gmail);
  present.photos = Boolean(profile.photos && profile.photos.length);
  present.files = Boolean(profile.files && profile.files.length);
  return present;
}

function scoreLabel(v) {
  if (v >= 85) return 'excellent presence';
  if (v >= 65) return 'solid presence';
  if (v >= 40) return 'needs work';
  return 'weak presence';
}

// When a real site audit (server/audit.js) is available, the website's
// contribution to a dimension is computed from what was actually found on
// the page instead of a flat "website is present" number — same point
// ceiling as the old static CONTRIB table entry, so scores stay comparable,
// but now it reflects the truth of that one page instead of just its
// presence. Returns null (meaning: fall back to the static table value)
// when there's no usable audit yet.
function auditContribution(dim, audit) {
  if (!audit || !audit.ok) return null;
  switch (dim) {
    case 'technical': {
      let pts = 0;
      if (audit.hasHttps) pts += 25;
      if (audit.responseMs <= 2000) pts += 25;
      else if (audit.responseMs <= 4000) pts += 12;
      if (audit.hasViewport) pts += 20;
      return Math.min(70, pts);
    }
    case 'seo': {
      let pts = 0;
      if (audit.hasTitle) pts += 10;
      if (audit.hasDescription) pts += 10;
      if (audit.hasH1) pts += 8;
      if (audit.wordCount >= 150) pts += 7;
      return Math.min(35, pts);
    }
    case 'ux': {
      let pts = 0;
      if (audit.hasViewport) pts += 20;
      if (audit.hasH1) pts += 10;
      if (audit.responseMs <= 3000) pts += 15;
      return Math.min(45, pts);
    }
    case 'aeogeo': {
      let pts = 0;
      if (audit.hasStructuredData) pts += 10;
      if (audit.ogTagCount > 0) pts += 5;
      return Math.min(15, pts);
    }
    case 'content': {
      // not in the static CONTRIB.content table at all today — this is
      // pure upside once a real audit exists, so no flat number to replace.
      if (audit.wordCount >= 300) return 20;
      if (audit.wordCount >= 150) return 10;
      if (audit.wordCount >= 50) return 4;
      return 0;
    }
    default:
      return null;
  }
}

function computeScores(profile) {
  const present = presentAttachments(profile);
  const selectedCount = ATTACHMENTS.reduce((n, id) => n + (present[id] ? 1 : 0), 0);
  const audit = profile && profile.siteAudit;

  const scores = {};
  scores.completeness = Math.round((selectedCount / ATTACHMENTS.length) * 100);

  Object.keys(CONTRIB).forEach((dim) => {
    const table = CONTRIB[dim];
    let sum = 0;
    Object.keys(table).forEach((att) => {
      if (!present[att]) return;
      if (att === 'website') {
        const dynamic = auditContribution(dim, audit);
        sum += dynamic !== null ? dynamic : table[att];
      } else {
        sum += table[att];
      }
    });
    // 'content' has no static website entry — audit-derived content quality
    // is pure upside, added only once a real audit exists.
    if (dim === 'content' && present.website && !('website' in table)) {
      const dynamic = auditContribution(dim, audit);
      if (dynamic !== null) sum += dynamic;
    }
    scores[dim] = Math.min(100, sum);
  });

  let weighted = 0;
  DIMENSIONS.forEach((d) => {
    weighted += scores[d] * (WEIGHTS[d] / 100);
  });
  scores.overall = Math.round(weighted);
  scores.selectedCount = selectedCount;
  scores.total = ATTACHMENTS.length;
  scores.label = selectedCount === 0 ? null : scoreLabel(scores.overall);

  return scores;
}

module.exports = { WEIGHTS, DIMENSIONS, ATTACHMENTS, CONTRIB, computeScores, scoreLabel };
