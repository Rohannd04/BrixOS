// ---------------------------------------------------------------------------
// BrixOS Places — turns a pasted Google Maps / location link into real,
// structured business data (name, category, address, phone, hours, rating,
// photos) via the Places API (New), instead of the link just sitting there
// as a raw URL (see server/chat.js's old extractFieldsLocal(), which only
// ever pattern-matched the URL SHAPE to recognize "this looks like a map
// link" — it never fetched anything from it).
//
// Why this can't be a plain fetch-and-scrape like server/audit.js does for
// regular websites: Google Maps pages are rendered client-side by
// JavaScript, so a plain HTTP GET returns an near-empty HTML shell with no
// business data in the raw source. The real path is Google's Places API,
// which needs a Google Cloud API key (GOOGLE_PLACES_API_KEY below) — see
// configured().
//
// Flow:
//   1. resolveMapsUrl()      — follow short links (maps.app.goo.gl,
//                              goo.gl/maps, g.page) to their real,
//                              long-form google.com/maps/place/... URL.
//                              Needs no API key, just a plain fetch.
//   2. extractHintsFromUrl() — pull a business-name hint and/or lat/lng out
//                              of that URL's own path (Maps embeds both in
//                              the URL itself, e.g. .../place/My+Shop/@lat,
//                              lng,17z/...).
//   3. searchPlace()         — Places API Text Search (searchText) using
//                              that hint (+ location bias when we have
//                              coordinates) to find the actual Place.
//   4. categoryFromTypes()   — map Google's place `types` taxonomy onto a
//                              short, human category phrase — this is what
//                              "identify business type" means in practice:
//                              feeding real category words into the same
//                              copy/palette pipeline profile.business
//                              already feeds (see siteTemplate.js's
//                              PALETTE_KEYWORDS and generate.js's
//                              profileBrief()), not a separate system.
//   5. fetchPhotos()         — pull the Place's real photos down into
//                              uploads/photos/, in the EXACT { id, filename,
//                              url, mimetype, uploadedAt } shape the normal
//                              photo-upload route already produces, so
//                              collectPhotoDataUris() in siteTemplate.js
//                              picks them up completely unchanged.
//
// enrichFromMapsLink() is the one function callers need — it runs all of
// the above and returns a plain result object, never throwing and never
// touching the profile itself (same division of responsibility as
// auditWebsite(): this module only fetches and normalizes, the route/chat
// handlers that call it decide what to do with the profile).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 8000;
const PLACES_BASE = 'https://places.googleapis.com/v1';
const MAX_PHOTOS = 5;
const PHOTOS_DIR = path.join(__dirname, '..', 'uploads', 'photos');

const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

function configured() {
  return Boolean(PLACES_API_KEY);
}

// ---------------------------------------------------------------------------
// step 1-2: resolve the link and pull hints straight out of the URL
// ---------------------------------------------------------------------------

async function resolveMapsUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrixOSPlaces/1.0; +https://brixos.site)' }
    });
    return res.url || url;
  } catch (err) {
    return url; // couldn't resolve (short link expired, network hiccup) — fall back to the original link
  } finally {
    clearTimeout(timer);
  }
}

function extractHintsFromUrl(url) {
  const hints = { nameHint: '', lat: null, lng: null };
  if (!url) return hints;
  const placeMatch = url.match(/\/maps\/place\/([^/@]+)/i);
  if (placeMatch) {
    try {
      hints.nameHint = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
    } catch (err) {
      hints.nameHint = placeMatch[1].replace(/\+/g, ' ').trim();
    }
  }
  const atMatch = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (atMatch) {
    hints.lat = parseFloat(atMatch[1]);
    hints.lng = parseFloat(atMatch[2]);
  }
  return hints;
}

// ---------------------------------------------------------------------------
// step 3: Places API (New) — Text Search
// ---------------------------------------------------------------------------

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.types', 'places.primaryType', 'places.rating', 'places.userRatingCount',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.websiteUri',
  'places.currentOpeningHours', 'places.regularOpeningHours', 'places.photos'
].join(',');

async function searchPlace(hints, rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const body = { textQuery: hints.nameHint || rawUrl, pageSize: 1 };
    if (hints.lat != null && hints.lng != null) {
      body.locationBias = { circle: { center: { latitude: hints.lat, longitude: hints.lng }, radius: 500.0 } };
    }
    const res = await fetch(`${PLACES_BASE}/places:searchText`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, reason: (json && json.error && json.error.message) || `Places API returned HTTP ${res.status}` };
    }
    const place = json && Array.isArray(json.places) ? json.places[0] : null;
    if (!place) return { ok: false, reason: 'No matching Google Business Profile found for that link.' };
    return { ok: true, place };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'Places API request timed out.' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// step 4: business-type identification — Google's `types`/`primaryType`
// taxonomy mapped onto the short category phrases BrixOS's own copy and
// palette-selection logic already understands (see siteTemplate.js
// PALETTE_KEYWORDS) rather than inventing a second, parallel taxonomy.
// ---------------------------------------------------------------------------

const TYPE_TO_CATEGORY = [
  [['bakery'], 'bakery'],
  [['cafe', 'coffee_shop'], 'cafe'],
  [['restaurant', 'meal_takeaway', 'meal_delivery', 'diner'], 'restaurant'],
  [['clothing_store'], 'clothing boutique'],
  [['jewelry_store'], 'jewelry store'],
  [['florist'], 'florist'],
  [['furniture_store', 'home_goods_store'], 'furniture store'],
  [['hair_care', 'hair_salon', 'barber_shop'], 'hair salon'],
  [['beauty_salon', 'nail_salon'], 'beauty salon'],
  [['spa'], 'spa'],
  [['gym', 'fitness_center'], 'gym'],
  [['lodging'], 'lodging / PG / hostel'],
  [['car_repair'], 'auto repair shop'],
  [['lawyer'], 'law firm'],
  [['accounting'], 'accounting firm'],
  [['real_estate_agency'], 'real estate agency'],
  [['grocery_or_supermarket', 'grocery_store', 'supermarket'], 'grocery store'],
  [['pet_store'], 'pet store'],
  [['book_store'], 'bookstore'],
  [['electronics_store'], 'electronics store'],
  [['shoe_store'], 'shoe store'],
  [['bar', 'night_club'], 'bar'],
  [['tattoo_parlor', 'tattoo_studio'], 'tattoo studio']
];

function categoryFromTypes(types, primaryType) {
  const all = [primaryType].concat(Array.isArray(types) ? types : []).filter(Boolean);
  for (const [keys, label] of TYPE_TO_CATEGORY) {
    if (all.some((t) => keys.includes(t))) return label;
  }
  if (primaryType) return primaryType.replace(/_/g, ' ');
  if (types && types[0]) return types[0].replace(/_/g, ' ');
  return '';
}

// ---------------------------------------------------------------------------
// step 5: photos — downloaded into uploads/photos/ in the exact shape the
// normal upload route produces (see server/index.js handleUpload()), so
// siteTemplate.js's collectPhotoDataUris() needs zero changes to use them.
// ---------------------------------------------------------------------------

async function fetchPhotos(place) {
  const photos = Array.isArray(place.photos) ? place.photos.slice(0, MAX_PHOTOS) : [];
  if (!photos.length) return [];
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });

  const saved = [];
  for (const photo of photos) {
    if (!photo || !photo.name) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${PLACES_BASE}/${photo.name}/media?maxWidthPx=1200&key=${PLACES_API_KEY}`,
        { redirect: 'follow', signal: controller.signal }
      );
      if (!res.ok) continue;
      const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      const ext = contentType === 'image/png' ? '.png' : contentType === 'image/webp' ? '.webp' : '.jpg';
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(PHOTOS_DIR, filename), buf);
      saved.push({
        id: crypto.randomUUID(),
        filename: 'Google Business Profile photo',
        url: `/uploads/photos/${filename}`,
        mimetype: contentType,
        uploadedAt: new Date().toISOString(),
        source: 'google_places'
      });
    } catch (err) {
      // skip this one photo, keep the rest — a partial photo set beats none
    } finally {
      clearTimeout(timer);
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// top-level entry point
// ---------------------------------------------------------------------------

async function enrichFromMapsLink(mapUrl) {
  if (!configured()) return { ok: false, reason: 'GOOGLE_PLACES_API_KEY is not configured on the server.' };

  const finalUrl = await resolveMapsUrl(mapUrl);
  let hints = extractHintsFromUrl(finalUrl);
  if (!hints.nameHint) {
    const originalHints = extractHintsFromUrl(mapUrl);
    if (originalHints.nameHint) hints = originalHints;
  }

  const search = await searchPlace(hints, mapUrl);
  if (!search.ok) return search;

  const place = search.place;
  const category = categoryFromTypes(place.types, place.primaryType);
  const photos = await fetchPhotos(place);
  const hours = place.regularOpeningHours || place.currentOpeningHours;

  return {
    ok: true,
    place: {
      name: (place.displayName && place.displayName.text) || '',
      formattedAddress: place.formattedAddress || '',
      category,
      types: Array.isArray(place.types) ? place.types : [],
      primaryType: place.primaryType || '',
      phone: place.nationalPhoneNumber || place.internationalPhoneNumber || '',
      website: place.websiteUri || '',
      rating: typeof place.rating === 'number' ? place.rating : null,
      userRatingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
      openNow: place.currentOpeningHours && typeof place.currentOpeningHours.openNow === 'boolean' ? place.currentOpeningHours.openNow : null,
      weekdayDescriptions: (hours && hours.weekdayDescriptions) || [],
      fetchedAt: new Date().toISOString()
    },
    photos
  };
}

// ---------------------------------------------------------------------------
// pendingPlace apply/discard — enrichFromMapsLink() above only fetches and
// normalizes, it never touches the profile itself; callers (server/index.js,
// server/chat.js) stage its result on profile.pendingPlace instead of
// applying it immediately, so BrixOS always asks "is this your business?"
// first. This is the one function that actually merges (or discards) that
// staged match into the profile once the user has answered — shared here so
// every call site (the PUT /api/profile/:field route, the real chat agent's
// tool call, and the local no-API-key chat fallback) applies/discards it
// identically. Mutates `profile` in place; the caller is still responsible
// for writeDB(db).
// ---------------------------------------------------------------------------

function applyPendingPlace(profile, confirm) {
  const pending = profile.pendingPlace;
  if (!pending) return { applied: false, reason: 'NO_PENDING' };
  profile.pendingPlace = null;
  if (!confirm) return { applied: false, declined: true };

  profile.placeInfo = pending.place;
  if (!profile.business && pending.place && pending.place.name) profile.business = pending.place.name;
  if (pending.photos && pending.photos.length) profile.photos = profile.photos.concat(pending.photos);
  return { applied: true, place: pending.place, photosAdded: (pending.photos || []).length };
}

function placeSummaryLine(place) {
  if (!place) return '';
  const bits = [];
  if (place.category) bits.push(place.category);
  if (typeof place.rating === 'number') bits.push(`${place.rating}★ (${place.userRatingCount || 0} review${place.userRatingCount === 1 ? '' : 's'})`);
  if (place.openNow === true) bits.push('open now');
  else if (place.openNow === false) bits.push('currently closed');
  if (place.formattedAddress) bits.push(place.formattedAddress);
  return bits.join(' · ') || (place.name || 'Found a listing, but with limited details.');
}

module.exports = {
  configured,
  enrichFromMapsLink,
  placeSummaryLine,
  applyPendingPlace,
  // exported for tests / debugging only
  extractHintsFromUrl,
  categoryFromTypes
};
