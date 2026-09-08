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
    generatedSite: null, // { plan, html, generatedAt, plannerModel, builderModel } — set by POST /api/generate
    siteAudit: null // real fetched-page analysis for `website` — set whenever it's saved/changed, see server/audit.js
  };
}

function getProfile(db, userId) {
  if (!db.profiles[userId]) {
    db.profiles[userId] = emptyProfile();
  }
  return db.profiles[userId];
}

module.exports = { readDB, writeDB, emptyProfile, getProfile, DB_PATH };
