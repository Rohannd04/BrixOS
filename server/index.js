require('dotenv').config({ quiet: true }); // suppress dotenv's console banner

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const { readDB, writeDB, getProfile } = require('./db');
const { computeScores } = require('./score');
const { validateField, EDITABLE_FIELDS, validateEmail, validatePassword, validateName } = require('./validate');
const generate = require('./generate');
const chat = require('./chat');
const llm = require('./llm');
const { auditWebsite, auditImprovements } = require('./audit');
const places = require('./places');
const { analyzeUploadedFile } = require('./fileAnalysis');
const { buildOrchestratorRouter } = require('./orchestratorRoutes');

const PORT = process.env.PORT || 3000;
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || 'brixos-dev-secret-change-me';

// Turns a caught provider error into a short, safe-to-show suffix for an
// API error response. Never includes the API key (nothing we throw ever
// puts it in err.message) — just whatever OpenRouter/Anthropic actually
// said, so a failure is diagnosable from the browser instead of needing
// the server's own terminal output.
function errDetail(err) {
  const raw = String((err && err.message) || '').replace(/^OPENROUTER_ERROR:\s*/, '');
  if (!raw) return '';
  return ' (' + raw.slice(0, 220) + ')';
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(
  session({
    name: 'brixos.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  })
);

// gentle brute-force guard on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' }
});

app.use('/uploads', express.static(UPLOADS_ROOT));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

function profilePayload(profile) {
  return { profile, score: computeScores(profile) };
}

// multer storage: images only for /photos, a slightly wider allow-list for /files
function makeUploader(kind) {
  const dir = path.join(UPLOADS_ROOT, kind);
  fs.mkdirSync(dir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  });

  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']);
  // application/vnd...wordprocessingml.document is .docx — BrixOS reads
  // these for real content (server/fileAnalysis.js), not just storing them.
  const fileTypes = new Set([...imageTypes, 'application/pdf', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

  const allowed = kind === 'photos' ? imageTypes : fileTypes;

  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 8 },
    fileFilter: (req, file, cb) => {
      if (!allowed.has(file.mimetype)) {
        return cb(new Error(kind === 'photos' ? 'Only image files are allowed.' : 'That file type isn’t supported.'));
      }
      cb(null, true);
    }
  });
}

const uploadPhotos = makeUploader('photos');
const uploadFiles = makeUploader('files');

// ---------------------------------------------------------------------------
// auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', authLimiter, (req, res) => {
  const { name, email, password } = req.body || {};

  const nameCheck = validateName(name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.message });

  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.message });

  const passCheck = validatePassword(password);
  if (!passCheck.ok) return res.status(400).json({ error: passCheck.message });

  const db = readDB();
  const exists = db.users.find((u) => u.email === emailCheck.value);
  if (exists) return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });

  const user = {
    id: crypto.randomUUID(),
    name: nameCheck.value,
    email: emailCheck.value,
    passwordHash: bcrypt.hashSync(passCheck.value, 10),
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  getProfile(db, user.id); // seed an empty profile
  writeDB(db);

  req.session.userId = user.id;
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return res.status(400).json({ error: 'Enter a valid email and password.' });

  const db = readDB();
  const user = db.users.find((u) => u.email === emailCheck.value);
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('brixos.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  const aiConfigured = generate.isConfigured();
  const aiProvider = llm.providerName(); // 'anthropic' | 'openrouter' | null
  if (!req.session.userId) return res.json({ user: null, aiConfigured, aiProvider });
  const db = readDB();
  const user = db.users.find((u) => u.id === req.session.userId);
  if (!user) return res.json({ user: null, aiConfigured, aiProvider });
  res.json({ user: publicUser(user), aiConfigured, aiProvider });
});

// ---------------------------------------------------------------------------
// profile routes (require auth)
// ---------------------------------------------------------------------------

app.get('/api/profile', requireAuth, (req, res) => {
  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  res.json(profilePayload(profile));
});

app.put('/api/profile/:field', requireAuth, async (req, res) => {
  const { field } = req.params;
  if (!EDITABLE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unknown field.' });

  const check = validateField(field, (req.body || {}).value);
  if (!check.ok) return res.status(400).json({ error: check.message });

  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  const changed = field === 'website' && profile.website !== check.value;
  const mapChanged = field === 'map' && profile.map !== check.value;
  profile[field] = check.value;
  writeDB(db);

  // A website link is the one field BrixOS can actually go verify, rather
  // than just format-check — so saving/changing it runs a real fetch-and-
  // inspect audit (server/audit.js) right here, synchronously, so the
  // score and a concrete improvement list come back in this same response
  // instead of leaving the user staring at "add more details".
  let improvements;
  if (changed) {
    const audit = await auditWebsite(check.value);
    profile.siteAudit = audit;
    writeDB(db);
    improvements = auditImprovements(audit);
  }

  // A map/location link is the other field BrixOS can actually go verify —
  // when a Google Places API key is configured (server/places.js), saving
  // or changing it fetches the real Google Business Profile: name,
  // category, address, phone, hours, rating, and photos, synchronously,
  // the same pattern as the website audit above. It is NOT applied to the
  // profile yet, though — it's staged on profile.pendingPlace so the
  // frontend can ask "is this your business?" first; POST
  // /api/profile/place/confirm (below) is what actually applies or
  // discards it once the user answers.
  let placeResult;
  if (mapChanged && places.configured()) {
    placeResult = await places.enrichFromMapsLink(check.value);
    if (placeResult.ok) {
      profile.pendingPlace = { place: placeResult.place, photos: placeResult.photos, mapValue: check.value, savedAt: new Date().toISOString() };
      writeDB(db);
    }
  }

  res.json(Object.assign(
    profilePayload(profile),
    improvements ? { improvements } : {},
    placeResult && placeResult.ok
      ? { placeConfirmation: { summary: places.placeSummaryLine(placeResult.place), photosFound: placeResult.photos.length, pending: true } }
      : {},
    placeResult && !placeResult.ok ? { placeError: placeResult.reason } : {}
  ));
});

// Applies or discards a Google Business Profile match staged on
// profile.pendingPlace (see the map-link handling above and in
// server/chat.js) — the explicit "yes, that's my business" / "no" step
// requested for BrixOS's map-link flow. Body: { confirm: boolean }.
app.post('/api/profile/place/confirm', requireAuth, (req, res) => {
  const confirm = Boolean((req.body || {}).confirm);
  const db = readDB();
  const profile = getProfile(db, req.session.userId);

  if (!profile.pendingPlace) return res.status(400).json({ error: 'No pending business match to confirm.' });

  const result = places.applyPendingPlace(profile, confirm);
  writeDB(db);

  res.json(Object.assign(
    profilePayload(profile),
    result.applied ? { placeInfo: result.place, photosAdded: result.photosAdded } : {}
  ));
});

app.delete('/api/profile/:field', requireAuth, (req, res) => {
  const { field } = req.params;
  if (!EDITABLE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unknown field.' });

  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  profile[field] = '';
  if (field === 'website') profile.siteAudit = null;
  writeDB(db);

  res.json(profilePayload(profile));
});

function handleUpload(kind, uploader) {
  return (req, res) => {
    uploader.array(kind, 8)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received.' });

      const db = readDB();
      const profile = getProfile(db, req.session.userId);
      const added = req.files.map((f) => ({
        id: crypto.randomUUID(),
        filename: f.originalname,
        url: `/uploads/${kind}/${path.basename(f.path)}`,
        mimetype: f.mimetype,
        uploadedAt: new Date().toISOString()
      }));
      profile[kind] = [...profile[kind], ...added];

      // "Files" (not photos) are the one upload kind BrixOS can actually go
      // read, the same way saving a website triggers a real live audit
      // instead of just a format check (server/fileAnalysis.js). Runs
      // inline, synchronously, so a real score/improvements list comes back
      // in this same response — no API key, no extra latency worth
      // mentioning, same as the rest of BrixOS's dependency-free analysis.
      let improvements;
      if (kind === 'files') {
        const insights = await Promise.all(
          req.files.map((f, i) => analyzeUploadedFile(f.path, f.mimetype, f.originalname).then((insight) => Object.assign({ id: added[i].id }, insight)))
        );
        profile.fileInsights = [...(profile.fileInsights || []), ...insights];
        const readable = insights.filter((i) => i.ok);
        if (readable.length) {
          const combined = [];
          readable.forEach((i) => combined.push(...i.improvements));
          improvements = [...new Set(combined)].slice(0, 4);
        }
      }

      writeDB(db);
      res.status(201).json(Object.assign(profilePayload(profile), improvements ? { improvements } : {}));
    });
  };
}

app.post('/api/profile/photos', requireAuth, handleUpload('photos', uploadPhotos));
app.post('/api/profile/files', requireAuth, handleUpload('files', uploadFiles));

function handleDeleteUpload(kind) {
  return (req, res) => {
    const db = readDB();
    const profile = getProfile(db, req.session.userId);
    const item = profile[kind].find((f) => f.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found.' });

    const diskPath = path.join(UPLOADS_ROOT, kind, path.basename(item.url));
    fs.unlink(diskPath, () => {}); // best-effort cleanup, don't fail the request on it

    profile[kind] = profile[kind].filter((f) => f.id !== req.params.id);
    if (kind === 'files' && Array.isArray(profile.fileInsights)) {
      profile.fileInsights = profile.fileInsights.filter((i) => i.id !== req.params.id);
    }
    writeDB(db);

    res.json(profilePayload(profile));
  };
}

app.delete('/api/profile/photos/:id', requireAuth, handleDeleteUpload('photos'));
app.delete('/api/profile/files/:id', requireAuth, handleDeleteUpload('files'));

// ---------------------------------------------------------------------------
// site generation (Planner -> Builder agent pipeline, see server/generate.js)
// ---------------------------------------------------------------------------

// generation calls a paid external API and can take a while — keep it modest
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many generation requests this hour. Try again later.' }
});

app.post('/api/generate', requireAuth, generateLimiter, async (req, res) => {
  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  const score = computeScores(profile);

  // No real model provider configured (ANTHROPIC_API_KEY or OPENROUTER_API_KEY) —
  // fall back to the local, template-based
  // Planner/Builder (server/generate.js) instead of erroring out, so the
  // "Generate my site" button always produces something in the preview
  // panel. The moment a real key is added, this branch stops being taken.
  if (!generate.isConfigured()) {
    try {
      const plan = generate.planSiteLocal(profile, score);
      const html = generate.buildSiteLocal(plan, profile);
      profile.generatedSite = {
        plan,
        html,
        generatedAt: new Date().toISOString(),
        plannerModel: 'local-template',
        builderModel: 'local-template'
      };
      writeDB(db);
      return res.json(Object.assign(profilePayload(profile), { aiSource: 'local' }));
    } catch (err) {
      console.error('local generation failed:', err);
      return res.status(500).json({ error: 'Generation failed — try again in a moment.' });
    }
  }

  try {
    const { plan, model: plannerModel } = await generate.planSite(profile, score);
    const { html, model: builderModel } = await generate.buildSite(plan, profile);

    profile.generatedSite = {
      plan,
      html,
      generatedAt: new Date().toISOString(),
      plannerModel,
      builderModel
    };
    writeDB(db);

    res.json(Object.assign(profilePayload(profile), { aiSource: 'model' }));
  } catch (err) {
    console.error('generation failed:', err);
    if (err.message === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Site generation isn’t configured yet — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in your .env file.' });
    }
    res.status(502).json({ error: 'Generation failed — the AI service returned an error.' + errDetail(err) + ' Try again in a moment.' });
  }
});

// ---------------------------------------------------------------------------
// chat — the console at the top talks to a real Claude agent (see server/chat.js)
// ---------------------------------------------------------------------------

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Slow down a little and try again.' }
});

app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  const message = String((req.body || {}).message || '').trim();
  if (!message) return res.status(400).json({ error: 'Say something first.' });
  if (message.length > 2000) return res.status(400).json({ error: 'That message is a bit long — try trimming it.' });

  const history = Array.isArray((req.body || {}).history) ? req.body.history.slice(-12) : [];

  // No real model provider configured (ANTHROPIC_API_KEY or OPENROUTER_API_KEY) —
  // fall back to the rule-based local agent
  // (server/chat.js:sendMessageLocal) instead of erroring out, so typing
  // and hitting Enter always does something real. The moment a real key
  // is added, this branch stops being taken.
  if (!chat.isConfigured()) {
    try {
      const result = await chat.sendMessageLocal(message, history, req.session.userId);
      return res.json(result);
    } catch (err) {
      console.error('local chat failed:', err);
      return res.status(500).json({ error: 'Chat failed — try again in a moment.' });
    }
  }

  try {
    const result = await chat.sendMessage(message, history, req.session.userId);
    res.json(result);
  } catch (err) {
    console.error('chat failed:', err);
    if (err.message === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Chat isn’t configured yet — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in your .env file.' });
    }
    res.status(502).json({ error: 'Chat failed — the AI service returned an error.' + errDetail(err) + ' Try again in a moment.' });
  }
});

// ---------------------------------------------------------------------------
// BrixOS Orchestrator — UNDERSTAND -> RESEARCH -> PLAN -> ARCHITECT ->
// GENERATE -> VALIDATE -> FIX -> PREVIEW, plus ZIP export and the paid-
// Claude-usage approval gate. See server/orchestrator.js and
// server/orchestratorRoutes.js. Mounted as its own router so none of the
// existing routes above (auth, profile, uploads, /api/generate, /api/chat)
// had to change for this to exist.
// ---------------------------------------------------------------------------

app.use('/api/orchestrator', buildOrchestratorRouter({ requireAuth }));

// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`BrixOS Presence Engine running at http://localhost:${PORT}`);
});

module.exports = app;
