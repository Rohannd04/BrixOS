// ---------------------------------------------------------------------------
// Format-only validation.
//
// This deliberately checks SHAPE only ("does this look like an Instagram
// profile link?") — never reachability or existence ("does this account
// actually exist?"). That's a product decision from BrixOS: verifying that a
// link genuinely resolves to a real, matching business is the job of the
// BrixOS analysis engine (the scan step), not the intake form. The intake
// form's only responsibility is to reject obviously malformed input before
// it's stored.
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\/[^\s]+\.[^\s]{2,}[^\s]*$/i;
const INSTAGRAM_RE = /^https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9_.]{1,30}\/?$/i;
const FACEBOOK_RE = /^https?:\/\/(www\.)?(facebook\.com|fb\.com|fb\.me)\/[a-zA-Z0-9_.\-]{1,80}\/?$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const GMAIL_RE = /^[^\s@]+@gmail\.com$/i;

const VALIDATORS = {
  business: (v) => {
    const value = String(v || '').trim();
    if (value.length < 2) return { ok: false, message: 'Business name needs to be at least 2 characters.' };
    if (value.length > 120) return { ok: false, message: 'Business name is too long.' };
    return { ok: true, value };
  },
  website: (v) => {
    const value = String(v || '').trim();
    if (!URL_RE.test(value)) return { ok: false, message: 'Enter a full link, e.g. https://yourstore.com' };
    return { ok: true, value };
  },
  instagram: (v) => {
    const value = String(v || '').trim();
    if (!INSTAGRAM_RE.test(value)) return { ok: false, message: 'Paste your Instagram profile link, e.g. https://instagram.com/yourstore' };
    return { ok: true, value };
  },
  facebook: (v) => {
    const value = String(v || '').trim();
    if (!FACEBOOK_RE.test(value)) return { ok: false, message: 'Paste your Facebook page link, e.g. https://facebook.com/yourstore' };
    return { ok: true, value };
  },
  social: (v) => {
    const value = String(v || '').trim();
    if (!URL_RE.test(value)) return { ok: false, message: 'Paste a full profile link, e.g. https://tiktok.com/@yourstore' };
    return { ok: true, value };
  },
  map: (v) => {
    const value = String(v || '').trim();
    if (!URL_RE.test(value)) return { ok: false, message: 'Paste your Google Maps / location link.' };
    return { ok: true, value };
  },
  gmail: (v) => {
    const value = String(v || '').trim().toLowerCase();
    if (!EMAIL_RE.test(value)) return { ok: false, message: 'That doesn’t look like a valid email address.' };
    if (!GMAIL_RE.test(value)) return { ok: false, message: 'Please use a @gmail.com address for this field.' };
    return { ok: true, value };
  }
};

const EDITABLE_FIELDS = Object.keys(VALIDATORS);

function validateField(field, value) {
  const validator = VALIDATORS[field];
  if (!validator) return { ok: false, message: 'Unknown field.' };
  return validator(value);
}

function validateEmail(v) {
  const value = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(value)) return { ok: false, message: 'Enter a valid email address.' };
  return { ok: true, value };
}

function validatePassword(v) {
  const value = String(v || '');
  if (value.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  return { ok: true, value };
}

function validateName(v) {
  const value = String(v || '').trim();
  if (value.length < 1) return { ok: false, message: 'Enter your name.' };
  if (value.length > 80) return { ok: false, message: 'Name is too long.' };
  return { ok: true, value };
}

module.exports = { validateField, EDITABLE_FIELDS, validateEmail, validatePassword, validateName };
