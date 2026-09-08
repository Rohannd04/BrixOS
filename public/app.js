(function () {
  'use strict';

  // ===========================================================================
  // Field definitions for the "+" menu — shape mirrors server/validate.js
  // ===========================================================================

  var ICONS = {
    photos: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M21 15l-5.5-5-5 5-2-2L3 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    business: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 9l1-5h14l1 5M4 9v10h16V9M4 9h16M9 19v-6h6v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    website: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" stroke="currentColor" stroke-width="1.3"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3.6" stroke="currentColor" stroke-width="1.5"/><circle cx="16.6" cy="7.4" r="0.9" fill="currentColor"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" stroke-width="1.5"/><path d="M13.6 8.6h-1.3c-.9 0-1.5.6-1.5 1.6v1.5h2.7l-.35 2.1h-2.35V19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    social: '<svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="12" r="2.2" stroke="currentColor" stroke-width="1.4"/><circle cx="18" cy="6" r="2.2" stroke="currentColor" stroke-width="1.4"/><circle cx="18" cy="18" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M8 11l8-4M8 13l8 4" stroke="currentColor" stroke-width="1.4"/></svg>',
    map: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 21s-6.5-5.4-6.5-10.2A6.5 6.5 0 0 1 12 4a6.5 6.5 0 0 1 6.5 6.8C18.5 15.6 12 21 12 21z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="10.5" r="2" stroke="currentColor" stroke-width="1.4"/></svg>',
    gmail: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M4 7l8 6 8-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    files: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13H7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 13.5h5M9.5 16.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
  };

  var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ARROW_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var FIELDS = [
    { id: 'photos', kind: 'file', accept: 'image/*', multiple: true, label: 'Photos' },
    { id: 'business', kind: 'text', inputType: 'text', label: 'Business name', placeholder: 'Aurora Boutique' },
    { id: 'website', kind: 'text', inputType: 'url', label: 'Website link', placeholder: 'https://yourstore.com' },
    { id: 'instagram', kind: 'text', inputType: 'url', label: 'Instagram link', placeholder: 'https://instagram.com/yourstore' },
    { id: 'facebook', kind: 'text', inputType: 'url', label: 'Facebook link', placeholder: 'https://facebook.com/yourstore' },
    { id: 'social', kind: 'text', inputType: 'url', label: 'Social media link', placeholder: 'https://tiktok.com/@yourstore' },
    { id: 'map', kind: 'text', inputType: 'url', label: 'Map / location link', placeholder: 'https://maps.google.com/...' },
    { id: 'gmail', kind: 'text', inputType: 'email', label: 'Gmail', placeholder: 'you@gmail.com' },
    { id: 'files', kind: 'file', accept: 'image/*,.pdf,.txt,.csv', multiple: true, label: 'Files' }
  ];
  var FIELD_BY_ID = {};
  FIELDS.forEach(function (f) { FIELD_BY_ID[f.id] = f; });

  // ===========================================================================
  // Scoring model mirrored from server/score.js — used only for the anonymous
  // demo preview. The moment a user is signed in, the server's numbers (from
  // /api/profile) are authoritative and these are not used.
  // ===========================================================================

  var WEIGHTS = { completeness: 15, trust: 15, ux: 20, technical: 15, seo: 15, aeogeo: 10, content: 10 };
  var DIMENSIONS = Object.keys(WEIGHTS);
  var ATTACHMENTS = ['business', 'website', 'instagram', 'facebook', 'social', 'map', 'gmail', 'photos', 'files'];
  var CONTRIB = {
    trust: { photos: 16, map: 18, instagram: 10, facebook: 14, social: 14, files: 18, gmail: 10 },
    ux: { website: 45, photos: 30, map: 25 },
    technical: { website: 70, photos: 30 },
    seo: { business: 25, website: 35, map: 25, facebook: 15 },
    aeogeo: { business: 10, website: 15, instagram: 25, facebook: 25, social: 25 },
    content: { photos: 22, instagram: 18, facebook: 18, social: 14, files: 18, gmail: 10 }
  };

  function scoreLabel(v) {
    if (v >= 85) return 'excellent presence';
    if (v >= 65) return 'solid presence';
    if (v >= 40) return 'needs work';
    return 'weak presence';
  }

  function computeLocalScores(profile) {
    var present = {};
    ATTACHMENTS.forEach(function (id) {
      var f = FIELD_BY_ID[id];
      present[id] = f.kind === 'file' ? (profile[id] && profile[id].length > 0) : Boolean(profile[id]);
    });
    var selectedCount = ATTACHMENTS.reduce(function (n, id) { return n + (present[id] ? 1 : 0); }, 0);

    var scores = {};
    scores.completeness = Math.round((selectedCount / ATTACHMENTS.length) * 100);
    Object.keys(CONTRIB).forEach(function (dim) {
      var table = CONTRIB[dim], sum = 0;
      Object.keys(table).forEach(function (att) { if (present[att]) sum += table[att]; });
      scores[dim] = sum;
    });
    var weighted = 0;
    DIMENSIONS.forEach(function (d) { weighted += scores[d] * (WEIGHTS[d] / 100); });
    scores.overall = Math.round(weighted);
    scores.selectedCount = selectedCount;
    scores.total = ATTACHMENTS.length;
    scores.label = selectedCount === 0 ? null : scoreLabel(scores.overall);
    return scores;
  }

  // ===========================================================================
  // tiny API helper
  // ===========================================================================

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var body = opts.body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'Something went wrong.');
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  // ===========================================================================
  // state
  // ===========================================================================

  var state = {
    authUser: null,
    authed: false,
    profile: null,
    score: null
  };

  function demoProfile() {
    return {
      business: 'Aurora Boutique',
      website: 'https://auroraboutique.com',
      instagram: 'https://instagram.com/aurora.boutique',
      facebook: 'https://facebook.com/auroraboutique',
      social: 'https://tiktok.com/@aurora.boutique',
      map: 'https://maps.google.com/?q=Aurora+Boutique+Austin',
      gmail: 'hello@gmail.com',
      photos: [{ id: 'demo-p1' }, { id: 'demo-p2' }],
      files: [{ id: 'demo-f1' }]
    };
  }

  function emptyProfile() {
    return { business: '', website: '', instagram: '', facebook: '', social: '', map: '', gmail: '', photos: [], files: [] };
  }

  // ===========================================================================
  // DOM refs
  // ===========================================================================

  var $ = function (id) { return document.getElementById(id); };
  var authSlot = $('authSlot');
  var plusBtn = $('plusBtn');
  var plusPopover = $('plusPopover');
  var attachRow = $('attachRow');
  var saveHint = $('saveHint');
  var consoleInput = $('consoleInput');
  var sendBtn = $('sendBtn');
  var scoreStatus = $('scoreStatus');
  var scanTitle = $('scanTitle');
  var scanBadge = $('scanBadge');
  var previewUrl = $('previewUrl');
  var heroSub = $('heroSub');
  var generateBtn = $('generateBtn');
  var previewBody = $('previewBody');
  var previewMeta = $('previewMeta');
  var chatLog = $('chatLog');
  var previewBodyDefaultHTML = previewBody.innerHTML; // the static mock, shown until a real site is generated

  var openFieldId = null; // which text-field accordion is expanded in the popover

  // ===========================================================================
  // toast
  // ===========================================================================

  var toastTimer = null;
  function toast(message, isError) {
    var el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 2600);
  }

  // ===========================================================================
  // render: auth slot (sign-in button <-> user pill)
  // ===========================================================================

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    var a = (parts[0] || '')[0] || '?';
    var b = parts.length > 1 ? (parts[1][0] || '') : '';
    return (a + b).toUpperCase();
  }

  function renderAuthSlot() {
    if (!state.authed) {
      authSlot.innerHTML =
        '<button class="signin-btn" id="signinBtn" type="button">' +
        '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8.2" r="3.4" stroke="currentColor" stroke-width="1.5"/><path d="M4.8 19.4c1.4-3.4 4-5.1 7.2-5.1s5.8 1.7 7.2 5.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        'Sign in</button>';
      $('signinBtn').addEventListener('click', function () { openAuthModal('login'); });
      return;
    }

    authSlot.innerHTML =
      '<div class="user-pill" id="userPill">' +
      '<span class="avatar">' + initials(state.authUser.name) + '</span>' +
      '<span class="uname">' + escapeHtml(state.authUser.name) + '</span>' +
      '<div class="user-menu" id="userMenu"><button type="button" id="logoutBtn">Log out</button></div>' +
      '</div>';

    var pill = $('userPill');
    var menu = $('userMenu');
    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('is-open');
    });
    document.addEventListener('click', function () { menu.classList.remove('is-open'); });
    $('logoutBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      logout();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ===========================================================================
  // render: "+" popover
  // ===========================================================================

  function fieldValuePresent(f) {
    var v = state.profile[f.id];
    return f.kind === 'file' ? Boolean(v && v.length) : Boolean(v);
  }

  function fieldHint(f) {
    if (f.kind === 'file') {
      var n = (state.profile[f.id] || []).length;
      return n ? n + ' added' : '';
    }
    var v = state.profile[f.id];
    if (!v) return '';
    return v.replace(/^https?:\/\/(www\.)?/, '');
  }

  function renderPopover() {
    var html = '<div class="popover-label">Add to your profile</div>';
    FIELDS.forEach(function (f) {
      var selected = fieldValuePresent(f);
      var hint = fieldHint(f);
      html += '<div class="popover-item' + (selected ? ' is-selected' : '') + '" data-id="' + f.id + '">';
      html += '<button class="popover-row" type="button" data-role="head" data-id="' + f.id + '">';
      html += ICONS[f.id];
      html += '<span class="plabel">' + f.label + '</span>';
      if (hint) html += '<span class="popover-hint" title="' + escapeHtml(hint) + '">' + escapeHtml(hint) + '</span>';
      html += '<span class="popover-check">' + CHECK_ICON + '</span>';
      html += '</button>';
      if (f.kind === 'text' && openFieldId === f.id) {
        html += '<div class="popover-body">';
        html += '<div class="popover-body-input">';
        html += '<input type="' + f.inputType + '" data-role="input" data-id="' + f.id + '" placeholder="' + escapeHtml(f.placeholder) + '" value="' + escapeHtml(state.profile[f.id] || '') + '">';
        html += '<button class="popover-confirm" type="button" data-role="confirm" data-id="' + f.id + '">' + ARROW_ICON + '</button>';
        html += '</div>';
        html += '<div class="popover-error mono" data-role="error" data-id="' + f.id + '"></div>';
        html += '</div>';
      }
      html += '</div>';
    });
    plusPopover.innerHTML = html;
    wirePopoverEvents();
  }

  function wirePopoverEvents() {
    Array.prototype.forEach.call(plusPopover.querySelectorAll('[data-role="head"]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-id');
        var f = FIELD_BY_ID[id];
        if (f.kind === 'file') {
          triggerFilePicker(f);
          return;
        }
        openFieldId = openFieldId === id ? null : id;
        renderPopover();
        if (openFieldId === id) {
          var input = plusPopover.querySelector('[data-role="input"][data-id="' + id + '"]');
          if (input) setTimeout(function () { input.focus(); }, 20);
        }
      });
    });

    Array.prototype.forEach.call(plusPopover.querySelectorAll('[data-role="confirm"]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        confirmTextField(btn.getAttribute('data-id'));
      });
    });

    Array.prototype.forEach.call(plusPopover.querySelectorAll('[data-role="input"]'), function (input) {
      input.addEventListener('click', function (e) { e.stopPropagation(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); confirmTextField(input.getAttribute('data-id')); }
        if (e.key === 'Escape') { openFieldId = null; renderPopover(); }
      });
    });
  }

  function showFieldError(id, message) {
    var el = plusPopover.querySelector('[data-role="error"][data-id="' + id + '"]');
    if (el) el.textContent = message || '';
  }

  function confirmTextField(id) {
    var input = plusPopover.querySelector('[data-role="input"][data-id="' + id + '"]');
    var value = input ? input.value.trim() : '';
    if (!value) return;
    showFieldError(id, '');

    if (state.authed) {
      api('/api/profile/' + id, { method: 'PUT', body: { value: value } })
        .then(function (data) {
          state.profile = data.profile;
          state.score = data.score;
          openFieldId = null;
          renderPopover();
          renderChips();
          renderScoreUI();
          toast(FIELD_BY_ID[id].label + ' saved.');
        })
        .catch(function (err) { showFieldError(id, err.message); });
    } else {
      // anonymous demo — format-check locally, mirroring the server's rules
      var check = validateLocal(id, value);
      if (!check.ok) { showFieldError(id, check.message); return; }
      state.profile[id] = check.value;
      state.score = computeLocalScores(state.profile);
      openFieldId = null;
      renderPopover();
      renderChips();
      renderScoreUI();
    }
  }

  function validateLocal(id, value) {
    var urlRe = /^https?:\/\/[^\s]+\.[^\s]{2,}[^\s]*$/i;
    if (id === 'business') return value.length >= 2 ? { ok: true, value: value } : { ok: false, message: 'Business name needs to be at least 2 characters.' };
    if (id === 'instagram') return /^https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9_.]{1,30}\/?$/i.test(value) ? { ok: true, value: value } : { ok: false, message: 'Paste your Instagram profile link, e.g. https://instagram.com/yourstore' };
    if (id === 'facebook') return /^https?:\/\/(www\.)?(facebook\.com|fb\.com|fb\.me)\/[a-zA-Z0-9_.\-]{1,80}\/?$/i.test(value) ? { ok: true, value: value } : { ok: false, message: 'Paste your Facebook page link, e.g. https://facebook.com/yourstore' };
    if (id === 'gmail') return /^[^\s@]+@gmail\.com$/i.test(value) ? { ok: true, value: value.toLowerCase() } : { ok: false, message: 'Please use a @gmail.com address for this field.' };
    if (id === 'website' || id === 'social' || id === 'map') return urlRe.test(value) ? { ok: true, value: value } : { ok: false, message: 'Enter a full link starting with https://' };
    return { ok: true, value: value };
  }

  function removeField(id) {
    var f = FIELD_BY_ID[id];
    if (f.kind === 'file') return; // files/photos are removed individually via their own chip's item id

    if (state.authed) {
      api('/api/profile/' + id, { method: 'DELETE' }).then(function (data) {
        state.profile = data.profile;
        state.score = data.score;
        renderPopover(); renderChips(); renderScoreUI();
      }).catch(function (err) { toast(err.message, true); });
    } else {
      state.profile[id] = '';
      state.score = computeLocalScores(state.profile);
      renderPopover(); renderChips(); renderScoreUI();
    }
  }

  // ---------- file pickers (Photos / Files) ----------

  var hiddenInputs = {};
  function triggerFilePicker(f) {
    var input = hiddenInputs[f.id];
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = f.accept;
      input.multiple = Boolean(f.multiple);
      input.style.display = 'none';
      input.addEventListener('change', function () { handleFilesChosen(f, input.files); input.value = ''; });
      document.body.appendChild(input);
      hiddenInputs[f.id] = input;
    }
    input.click();
  }

  function handleFilesChosen(f, fileList) {
    if (!fileList || !fileList.length) return;

    if (!state.authed) {
      // anonymous demo: just note them locally, nothing is actually stored
      var added = [];
      for (var i = 0; i < fileList.length; i++) added.push({ id: 'local-' + Date.now() + '-' + i, filename: fileList[i].name });
      state.profile[f.id] = (state.profile[f.id] || []).concat(added);
      state.score = computeLocalScores(state.profile);
      renderPopover(); renderChips(); renderScoreUI();
      toast(added.length + ' ' + f.label.toLowerCase() + ' attached to this preview.');
      return;
    }

    var formData = new FormData();
    for (var j = 0; j < fileList.length; j++) formData.append(f.id, fileList[j]);

    toast('Uploading ' + fileList.length + ' file' + (fileList.length > 1 ? 's' : '') + '…');
    api('/api/profile/' + f.id, { method: 'POST', body: formData })
      .then(function (data) {
        state.profile = data.profile;
        state.score = data.score;
        renderPopover(); renderChips(); renderScoreUI();
        toast(f.label + ' uploaded.');
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function removeUpload(kind, itemId) {
    if (state.authed) {
      api('/api/profile/' + kind + '/' + itemId, { method: 'DELETE' }).then(function (data) {
        state.profile = data.profile;
        state.score = data.score;
        renderPopover(); renderChips(); renderScoreUI();
      }).catch(function (err) { toast(err.message, true); });
    } else {
      state.profile[kind] = (state.profile[kind] || []).filter(function (it) { return it.id !== itemId; });
      state.score = computeLocalScores(state.profile);
      renderPopover(); renderChips(); renderScoreUI();
    }
  }

  // ===========================================================================
  // render: attach chips under the console input
  // ===========================================================================

  function removeAllUploads(kind) {
    var items = (state.profile[kind] || []).slice();
    if (!state.authed) {
      state.profile[kind] = [];
      state.score = computeLocalScores(state.profile);
      renderPopover(); renderChips(); renderScoreUI();
      return;
    }
    // delete sequentially so each response's profile snapshot stays consistent
    var next = function () {
      if (!items.length) { renderPopover(); renderChips(); renderScoreUI(); return; }
      var item = items.shift();
      api('/api/profile/' + kind + '/' + item.id, { method: 'DELETE' })
        .then(function (data) { state.profile = data.profile; state.score = data.score; next(); })
        .catch(function () { next(); });
    };
    next();
  }

  function renderChips() {
    var chips = [];
    FIELDS.forEach(function (f) {
      if (f.kind === 'text') {
        if (state.profile[f.id]) {
          chips.push({ label: f.label, remove: function (id) { return function () { removeField(id); }; }(f.id) });
        }
      } else {
        var items = state.profile[f.id] || [];
        if (items.length === 1) {
          chips.push({
            label: f.label + (items[0].filename ? ': ' + items[0].filename : ''),
            remove: function (kind, id) { return function () { removeUpload(kind, id); }; }(f.id, items[0].id)
          });
        } else if (items.length > 1) {
          chips.push({
            label: f.label + ' ×' + items.length,
            remove: function (kind) { return function () { removeAllUploads(kind); }; }(f.id)
          });
        }
      }
    });

    attachRow.innerHTML = '';
    chips.forEach(function (c) {
      var span = document.createElement('span');
      span.className = 'attach-chip mono';
      span.innerHTML = escapeHtml(c.label) +
        '<button type="button" aria-label="Remove ' + escapeHtml(c.label) + '"><svg viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';
      span.querySelector('button').addEventListener('click', c.remove);
      attachRow.appendChild(span);
    });

    saveHint.hidden = state.authed || chips.length === 0;
  }

  // ===========================================================================
  // render: score card
  // ===========================================================================

  var GAUGE_CIRC = 2 * Math.PI * 40;

  function renderScoreUI() {
    var s = state.score;
    DIMENSIONS.forEach(function (d) {
      var meter = $('meter-' + d);
      var val = $('val-' + d);
      var v = s ? s[d] : 0;
      if (meter) meter.style.width = v + '%';
      if (val) val.textContent = s && s.selectedCount ? v : '--';
    });

    var gaugeFill = $('gaugeFill');
    var overall = s ? s.overall : 0;
    var offset = GAUGE_CIRC * (1 - overall / 100);
    gaugeFill.style.strokeDasharray = GAUGE_CIRC;
    gaugeFill.style.strokeDashoffset = s && s.selectedCount ? offset : GAUGE_CIRC;
    $('gaugeNum').textContent = s && s.selectedCount ? overall : '--';

    if (!s || s.selectedCount === 0) {
      scoreStatus.textContent = 'Add details to run a scan';
    } else if (s.selectedCount < s.total) {
      scoreStatus.textContent = s.selectedCount + '/' + s.total + ' details added — scanning…';
    } else {
      scoreStatus.textContent = 'Scan complete — ' + s.label;
    }

    scanBadge.textContent = 'SCANNING 214 SIGNALS ACROSS ' + (s ? s.total : 9) + ' CHANNELS';

    var name = state.profile.business || (state.authed ? state.authUser.name + "'s business" : 'Aurora Boutique');
    scanTitle.innerHTML = 'Live scan &mdash; ' + escapeHtml(name);

    if (state.profile.website) {
      previewUrl.textContent = state.profile.website.replace(/^https?:\/\//, '');
    } else {
      var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'yourstore';
      previewUrl.textContent = slug + '.brixos.site';
    }

    renderPreview();
  }

  // ===========================================================================
  // render: the "Generated preview" panel — either the static mock, or the
  // real HTML the BrixOS Planner -> Builder agent pipeline produced
  // ===========================================================================

  function timeAgo(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    var mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function renderPreview() {
    var site = state.profile && state.profile.generatedSite;

    if (!site) {
      previewBody.classList.remove('is-generated');
      previewBody.innerHTML = previewBodyDefaultHTML;
      previewMeta.hidden = true;
      return;
    }

    previewBody.classList.add('is-generated');
    previewBody.innerHTML = '';
    var frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', (state.profile.business || 'Generated') + ' — BrixOS preview');
    frame.srcdoc = site.html;
    previewBody.appendChild(frame);

    previewMeta.hidden = false;
    previewMeta.textContent = 'Generated ' + timeAgo(site.generatedAt) +
      (site.plan && site.plan.siteName ? ' · plan: ' + site.plan.siteName : '');
  }

  // ===========================================================================
  // console input: a real chat with the BrixOS agent (server/chat.js) — type
  // + Enter (or hit send). Chips below just fill the input; Enter sends it.
  // ===========================================================================

  var chatHistory = []; // {role, content} pairs, client-side only — not persisted across reloads
  var chatBusy = false;

  function appendChatBubble(role, text) {
    chatLog.hidden = false;
    var row = document.createElement('div');
    row.className = 'chat-msg ' + role;
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
    return bubble;
  }

  function showTyping() {
    chatLog.hidden = false;
    var row = document.createElement('div');
    row.className = 'chat-msg assistant';
    row.id = 'chatTypingRow';
    row.innerHTML = '<div class="chat-bubble chat-typing"><span></span><span></span><span></span></div>';
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function hideTyping() {
    var row = $('chatTypingRow');
    if (row) row.remove();
  }

  // reveals the reply progressively, like ChatGPT/Claude's own chat does,
  // instead of the real (slower, trickier-to-stream-around-tool-calls) thing
  function typewriteBubble(bubble, text) {
    var i = 0;
    var step = Math.max(1, Math.round(text.length / 200));
    (function tick() {
      i += step;
      bubble.textContent = text.slice(0, i);
      chatLog.scrollTop = chatLog.scrollHeight;
      if (i < text.length) setTimeout(tick, 14);
    })();
  }

  function sendChatMessage() {
    var value = consoleInput.value.trim();
    if (!value || chatBusy) return;

    if (!state.authed) {
      toast('Sign in so BrixOS can chat with you and save what you share.', true);
      openAuthModal('login');
      return;
    }

    consoleInput.value = '';
    appendChatBubble('user', value);
    showTyping();
    chatBusy = true;
    sendBtn.disabled = true;

    api('/api/chat', { method: 'POST', body: { message: value, history: chatHistory.slice(-12) } })
      .then(function (data) {
        hideTyping();
        chatHistory.push({ role: 'user', content: value });
        chatHistory.push({ role: 'assistant', content: data.reply });
        typewriteBubble(appendChatBubble('assistant', ''), data.reply || '…');

        state.profile = data.profile;
        state.score = data.score;
        renderPopover(); renderChips(); renderScoreUI();
        if (data.generated) toast('Your rebuilt site is ready — check the preview panel.');
      })
      .catch(function (err) {
        hideTyping();
        appendChatBubble('assistant', err.message || 'Something went wrong — try again.');
      })
      .finally(function () {
        chatBusy = false;
        sendBtn.disabled = false;
      });
  }

  sendBtn.addEventListener('click', sendChatMessage);
  consoleInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
  });

  // ===========================================================================
  // "Generate my site" — calls the Planner -> Builder pipeline on the server
  // ===========================================================================

  function generateSite() {
    if (!state.authed) {
      toast('Sign in so BrixOS can save the site it generates for you.', true);
      openAuthModal('login');
      return;
    }
    if (generateBtn.disabled) return;

    var prevLabel = generateBtn.textContent;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    previewBody.classList.add('is-loading');

    api('/api/generate', { method: 'POST' })
      .then(function (data) {
        state.profile = data.profile;
        state.score = data.score;
        renderScoreUI();
        toast('Your rebuilt site is ready.');
      })
      .catch(function (err) {
        toast(err.message, true);
      })
      .finally(function () {
        generateBtn.disabled = false;
        generateBtn.textContent = prevLabel;
        previewBody.classList.remove('is-loading');
      });
  }

  generateBtn.addEventListener('click', generateSite);

  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
    chip.addEventListener('click', function () {
      var text = chip.textContent.trim();
      consoleInput.value = text;
      consoleInput.focus();
      var len = text.length;
      if (consoleInput.setSelectionRange) consoleInput.setSelectionRange(len, len);
    });
  });

  // ===========================================================================
  // Hero CTAs — "Start your free scan" / "See a sample score"
  // ===========================================================================

  var startScanBtn = $('startScanBtn');
  var sampleScoreBtn = $('sampleScoreBtn');

  if (startScanBtn) {
    startScanBtn.addEventListener('click', function () {
      consoleInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      consoleInput.focus();
    });
  }

  if (sampleScoreBtn) {
    sampleScoreBtn.addEventListener('click', function () {
      var panel = document.querySelector('.panel-section');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ===========================================================================
  // "+" popover open/close
  // ===========================================================================

  function togglePopover(show) {
    var next = typeof show === 'boolean' ? show : !plusPopover.classList.contains('is-open');
    plusPopover.classList.toggle('is-open', next);
    plusBtn.classList.toggle('is-open', next);
    plusBtn.setAttribute('aria-expanded', String(next));
    if (!next) { openFieldId = null; renderPopover(); }
  }

  plusBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePopover(); });
  document.addEventListener('click', function (e) {
    if (!plusPopover.contains(e.target) && e.target !== plusBtn) togglePopover(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') togglePopover(false); });

  // ===========================================================================
  // animated placeholder on the console input
  // ===========================================================================

  (function () {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var phrases = ['auroraboutique.com', 'Handmade ceramics shop in Austin, TX', '@aurora.boutique on Instagram'];
    if (reduce) { consoleInput.placeholder = phrases[0]; return; }

    var pi = 0, ci = 0, deleting = false;
    function tick() {
      if (document.activeElement === consoleInput && consoleInput.value) { setTimeout(tick, 400); return; }
      var full = phrases[pi];
      if (!deleting) {
        ci++;
        consoleInput.placeholder = full.slice(0, ci);
        if (ci === full.length) { setTimeout(function () { deleting = true; tick(); }, 1400); return; }
      } else {
        ci--;
        consoleInput.placeholder = full.slice(0, ci);
        if (ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; }
      }
      setTimeout(tick, deleting ? 28 : 46);
    }
    tick();
  })();

  // ===========================================================================
  // auth modal
  // ===========================================================================

  var authOverlay = $('authOverlay');
  var authForm = $('authForm');
  var authError = $('authError');
  var authSubmit = $('authSubmit');
  var nameField = $('nameField');
  var authName = $('authName');
  var authEmail = $('authEmail');
  var authPassword = $('authPassword');
  var authTitle = $('authTitle');
  var authSub = $('authSub');
  var authSwitch = $('authSwitch');
  var authSwitchLink = $('authSwitchLink');
  var forgotLink = $('forgotLink');
  var authMode = 'login';

  function openAuthModal(mode) {
    authMode = mode || 'login';
    applyAuthMode();
    authError.hidden = true;
    authForm.reset();
    authOverlay.classList.add('is-open');
    setTimeout(function () { authEmail.focus(); }, 150);
  }

  function closeAuthModal() { authOverlay.classList.remove('is-open'); }

  function applyAuthMode() {
    var isSignup = authMode === 'signup';
    nameField.hidden = !isSignup;
    authTitle.textContent = isSignup ? 'Create your account' : 'Welcome back';
    authSub.textContent = isSignup ? 'Save your business profile and score to a BrixOS account.' : "Sign in to pick up your store's scan where you left off.";
    authSubmit.textContent = isSignup ? 'Create account' : 'Sign in';
    authSwitch.innerHTML = isSignup ? 'Already have an account? <a href="#" id="authSwitchLink">Sign in</a>' : 'New to BrixOS? <a href="#" id="authSwitchLink">Create an account</a>';
    forgotLink.parentElement.hidden = isSignup;
    $('authSwitchLink').addEventListener('click', function (e) {
      e.preventDefault();
      authMode = isSignup ? 'login' : 'signup';
      applyAuthMode();
      authError.hidden = true;
    });
  }

  $('authClose').addEventListener('click', closeAuthModal);
  authOverlay.addEventListener('click', function (e) { if (e.target === authOverlay) closeAuthModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAuthModal(); });
  forgotLink.addEventListener('click', function (e) {
    e.preventDefault();
    toast('This is a local demo build — password reset isn’t wired up yet.');
  });

  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    authError.hidden = true;
    authSubmit.disabled = true;

    var payload = { email: authEmail.value.trim(), password: authPassword.value };
    var endpoint = '/api/auth/login';
    if (authMode === 'signup') {
      payload.name = authName.value.trim();
      endpoint = '/api/auth/signup';
    }

    api(endpoint, { method: 'POST', body: payload })
      .then(function (data) {
        state.authed = true;
        state.authUser = data.user;
        closeAuthModal();
        renderAuthSlot();
        return loadRealProfile();
      })
      .then(function () {
        toast('Signed in as ' + state.authUser.name + '.');
      })
      .catch(function (err) {
        authError.textContent = err.message;
        authError.hidden = false;
      })
      .finally(function () { authSubmit.disabled = false; });
  });

  function logout() {
    api('/api/auth/logout', { method: 'POST' }).then(function () {
      state.authed = false;
      state.authUser = null;
      state.profile = demoProfile();
      state.score = computeLocalScores(state.profile);
      openFieldId = null;
      heroSub.textContent = 'Drop a website, a Google listing, or an Instagram handle. BrixOS reads your business like a shopper would — then rebuilds it to convert.';
      renderAuthSlot(); renderPopover(); renderChips(); renderScoreUI();
      toast('Signed out.');
    });
  }

  // ===========================================================================
  // boot
  // ===========================================================================

  function loadRealProfile() {
    return api('/api/profile').then(function (data) {
      state.profile = data.profile;
      state.score = data.score;
      heroSub.textContent = 'Welcome back, ' + state.authUser.name + '. Everything you attach here is saved to your BrixOS account.';
      renderPopover(); renderChips(); renderScoreUI();
    });
  }

  function boot() {
    api('/api/auth/me').then(function (data) {
      if (data.user) {
        state.authed = true;
        state.authUser = data.user;
        renderAuthSlot();
        return loadRealProfile();
      }
      state.authed = false;
      state.profile = demoProfile();
      state.score = computeLocalScores(state.profile);
      renderAuthSlot(); renderPopover(); renderChips(); renderScoreUI();
    }).catch(function () {
      // backend unreachable — still show a usable local demo
      state.authed = false;
      state.profile = demoProfile();
      state.score = computeLocalScores(state.profile);
      renderAuthSlot(); renderPopover(); renderChips(); renderScoreUI();
      toast('Could not reach the BrixOS server — showing a local preview.', true);
    });
  }

  boot();
})();
