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

const PORT = process.env.PORT || 3000;
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || 'brixos-dev-secret-change-me';

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
  const fileTypes = new Set([...imageTypes, 'application/pdf', 'text/plain', 'text/csv']);

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
  if (!req.session.userId) return res.json({ user: null });
  const db = readDB();
  const user = db.users.find((u) => u.id === req.session.userId);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// profile routes (require auth)
// ---------------------------------------------------------------------------

app.get('/api/profile', requireAuth, (req, res) => {
  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  res.json(profilePayload(profile));
});

app.put('/api/profile/:field', requireAuth, (req, res) => {
  const { field } = req.params;
  if (!EDITABLE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unknown field.' });

  const check = validateField(field, (req.body || {}).value);
  if (!check.ok) return res.status(400).json({ error: check.message });

  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  profile[field] = check.value;
  writeDB(db);

  res.json(profilePayload(profile));
});

app.delete('/api/profile/:field', requireAuth, (req, res) => {
  const { field } = req.params;
  if (!EDITABLE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unknown field.' });

  const db = readDB();
  const profile = getProfile(db, req.session.userId);
  profile[field] = '';
  writeDB(db);

  res.json(profilePayload(profile));
});

function handleUpload(kind, uploader) {
  return (req, res) => {
    uploader.array(kind, 8)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received.' });

      const db = readDB();
      const profile = getProfile(db, req.session.userId);
      const added = req.files.map((f) => ({
        id: crypto.randomUUID(),
        filename: f.originalname,
        url: `/uploads/${kind}/${path.basename(f.path)}`,
        uploadedAt: new Date().toISOString()
      }));
      profile[kind] = [...profile[kind], ...added];
      writeDB(db);

      res.status(201).json(profilePayload(profile));
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
    writeDB(db);

    res.json(profilePayload(profile));
  };
}

app.delete('/api/profile/photos/:id', requireAuth, handleDeleteUpload('photos'));
app.delete('/api/profile/files/:id', requireAuth, handleDeleteUpload('files'));

// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`BrixOS Presence Engine running at http://localhost:${PORT}`);
});

module.exports = app;
