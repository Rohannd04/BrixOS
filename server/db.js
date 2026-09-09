// ---------------------------------------------------------------------------
// BrixOS data store — a plain JSON file on disk.
//
// This is intentionally dependency-free (no native bindings to compile, no
// database server to install) so the app runs anywhere Node runs. It is
// fine for local use and small teams; swap `readDB`/`writeDB` for a real
// database client (Postgres, Mongo, etc.) later without touching the routes
// — every route only calls the functions exported from here.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function emptyDB() {
  return { users: [], profiles: {} };
}

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    writeDB(emptyDB());
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    // corrupt file — back it up rather than silently losing data
    fs.copyFileSync(DB_PATH, DB_PATH + `.corrupt.${Date.now()}`);
    const fresh = emptyDB();
    writeDB(fresh);
    return fresh;
  }
}

function writeDB(db) {
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH); // atomic on the same filesystem
}

function emptyProfile() {
  return {
    business: '',
    website: '',
    instagram: '',
    facebook: '',
    social: '',
    map: '',
    gmail: '',
    photos: [],
    files: [],
    // Real, extracted-text analysis of each uploaded "Files" document (PDF/
    // Word/text) — see server/fileAnalysis.js. One entry per file in
    // `files` above (matched by id): { id, ok, filename, wordCount,
    // hasHours, hasContact, hasAddress, hasAbout, hasPricing,
    // hasTestimonials, hasSocialMention, improvements, textExcerpt } or,
    // for an unreadable/unsupported file, { id, ok: false, filename, reason }.
    fileInsights: [],
    generatedSite: null, // { plan, html, generatedAt, plannerModel, builderModel } — set by POST /api/generate
    siteAudit: null, // real fetched-page analysis for `website` — set whenever it's saved/changed, see server/audit.js
    // Real, fetched Google Business Profile data for `map` — set whenever it's
    // saved/changed and GOOGLE_PLACES_API_KEY is configured, see server/places.js.
    // { name, formattedAddress, category, types, primaryType, phone, website,
    //   rating, userRatingCount, openNow, weekdayDescriptions, fetchedAt }
    placeInfo: null,

    // A Google Business Profile match found for a just-pasted map link,
    // staged here WITHOUT being applied yet — set by the map-link handlers
    // in server/index.js and server/chat.js the moment places.js resolves a
    // match, cleared the moment the user confirms or declines it (see
    // POST /api/profile/place/confirm and the yes/no chat intercept in
    // server/chat.js). This exists so BrixOS always asks "is this your
    // business?" before treating a Places match as accepted, instead of
    // silently overwriting profile.business/profile.placeInfo/profile.photos
    // the instant a link resolves. Shape: { place, photos, mapValue, savedAt }
    // — `place`/`photos` are exactly what places.enrichFromMapsLink()
    // returned; `mapValue` is the map link this match was found for.
    pendingPlace: null,

    // BrixOS Orchestrator (server/orchestrator.js) state — separate from the
    // simpler one-shot generatedSite above:
    //   generatedProject  — the full multi-page site the Orchestrator last
    //                        produced: { plan, pages: {slug: html}, generatedAt,
    //                        reasoningProvider, generationProvider }. This is
    //                        what "Download ZIP" packages up.
    //   claudeApprovalGranted — a tri-state: null = not yet decided (BrixOS
    //                        will ask before its first paid Claude call),
    //                        true = this user has explicitly approved BrixOS
    //                        spending paid Claude API credits on their
    //                        behalf, false = they explicitly declined (so
    //                        BrixOS won't ask again until they change it —
    //                        see the approval gate in server/orchestrator.js).
    //                        Even with ANTHROPIC_API_KEY configured
    //                        server-side, Claude is never called for this
    //                        user until this is true.
    generatedProject: null,
    claudeApprovalGranted: null
  };
}

function getProfile(db, userId) {
  if (!db.profiles[userId]) {
    db.profiles[userId] = emptyProfile();
  }
  // Backfill any fields added to the profile shape after this profile was
  // first created (e.g. generatedProject/claudeApprovalGranted, added for
  // the BrixOS Orchestrator) — existing accounts' db.json entries predate
  // them and would otherwise be missing the keys entirely.
  const profile = db.profiles[userId];
  const defaults = emptyProfile();
  Object.keys(defaults).forEach((key) => {
    if (!(key in profile)) profile[key] = defaults[key];
  });
  return profile;
}

module.exports = { readDB, writeDB, emptyProfile, getProfile, DB_PATH };
