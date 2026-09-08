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
    { id: 'files', kind: 'file', accept: 'image/*,.pdf,.txt,.csv,.docx', multiple: true, label: 'Files' }
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
    score: null,
    aiConfigured: true, // optimistic default until /api/auth/me says otherwise
    aiProvider: null // 'anthropic' | 'openrouter' | null, from /api/auth/me
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
  var exportZipBtn = $('exportZipBtn');
  var openPreviewBtn = $('openPreviewBtn');
  var previewBody = $('previewBody');
  var previewMeta = $('previewMeta');
  var orchestratorStatus = $('orchestratorStatus');
  var claudeApprovalOverlay = $('claudeApprovalOverlay');
  var claudeApproveBtn = $('claudeApproveBtn');
  var claudeDeclineBtn = $('claudeDeclineBtn');
  var chatLog = $('chatLog');
  var engineMode = $('engineMode');
  var previewBodyDefaultHTML = previewBody.innerHTML; // the static mock, shown until a real site is generated

  // ===========================================================================
  // workspace mode — once the user actually starts working (first chat
  // message, or "Generate my site"), the marketing hero/pipeline give way to
  // a focused two-pane layout: chat minimized to the left, live preview on
  // the right (stacked — chat on top — on narrow screens). See
  // enterWorkspaceMode() below; the CSS lives under "workspace mode" in
  // styles.css.
  // ===========================================================================
  var workspaceView = $('workspaceView');
  var workspaceLeft = $('workspaceLeft');
  var workspaceRight = $('workspaceRight');
  var previewCard = $('previewCard');
  var consoleEl = document.querySelector('.console');
  var wsScore = $('wsScore');
  var wsScoreNum = $('wsScoreNum');
  var wsScoreTitle = $('wsScoreTitle');
  var wsScoreStatus = $('wsScoreStatus');
  var wsRingFill = $('wsRingFill');
  var wsImprove = $('wsImprove');
  var wsImproveTags = $('wsImproveTags');
  var WS_RING_CIRC = 2 * Math.PI * 24;
  var DIMENSION_LABELS = {
    completeness: 'Business/profile completeness',
    trust: 'Trust and credibility',
    ux: 'UX and conversion',
    technical: 'Technical quality',
    seo: 'SEO',
    aeogeo: 'AEO/GEO readiness',
    content: 'Content and freshness'
  };
  var inWorkspace = false;

  function enterWorkspaceMode() {
    if (inWorkspace) return;
    inWorkspace = true;
    document.body.classList.add('is-workspace');
    wsScore.hidden = false;
    // move the REAL console/chat and preview card in — same elements, same
    // listeners and state, just relocated — not copies.
    workspaceLeft.appendChild(consoleEl);
    workspaceRight.appendChild(previewCard);
    workspaceView.hidden = false;
    workspaceView.classList.add('is-active');
    renderScoreUI();
  }

  // The compact score ring now sits above chat while the full 7-metric
  // breakdown lives further down the page (see #panelSection in workspace
  // mode) — make the compact card a quick jump link down to it.
  wsScore.addEventListener('click', function () {
    var target = $('panelSection');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  wsScore.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      wsScore.click();
    }
  });

  // topbar status pill: "ONLINE" once a real model provider (Anthropic or
  // OpenRouter — see server/llm.js) is configured on the server; "LOCAL MODE"
  // when the chat/generate agents are running on the rule-based fallback
  // instead. Shows which provider when it's not the default Anthropic, so
  // it's obvious at a glance which one actually answered.
  function renderEngineStatus() {
    if (!engineMode) return;
    if (!state.aiConfigured) { engineMode.textContent = 'LOCAL MODE'; return; }
    engineMode.textContent = state.aiProvider === 'openrouter' ? 'ONLINE · OPENROUTER' : 'ONLINE';
  }

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

          // Saving a website triggers a real live audit server-side — show
          // what it found right in the console, the same place chat replies
          // land, so this doesn't only happen when you type instead of click.
          if (Array.isArray(data.improvements) && data.improvements.length) {
            var text = 'Studied your site — presence score is ' + data.score.overall + '/100. ' +
              "Here's what I'd fix first: " + data.improvements.slice(0, 3).join(' ');
            appendChatBubble('assistant', text);
          }
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

        // Uploaded documents get read for real (server/fileAnalysis.js) —
        // same pattern as saving a website triggering a live audit: show
        // what was found right in the console, not just a silent save.
        if (Array.isArray(data.improvements) && data.improvements.length) {
          var text = "I read what you uploaded — here's what I'd add: " + data.improvements.slice(0, 3).join(' ');
          appendChatBubble('assistant', text);
        }
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
    } else {
      // A scan is "complete" the moment there's anything to study — even just
      // one link — so BrixOS never leaves you staring at "needs more info"
      // when you've already given it something real to analyze. The detail
      // count is still shown, just as context, not as a gate.
      scoreStatus.textContent = 'Scan complete — ' + s.label + ' (' + s.selectedCount + '/' + s.total + ' details found)';
    }

    scanBadge.textContent = 'SCANNING 214 SIGNALS ACROSS ' + (s ? s.total : 9) + ' CHANNELS';

    var name = state.profile.business || (state.authed ? state.authUser.name + "'s business" : 'Aurora Boutique');
    scanTitle.innerHTML = 'Live scan &mdash; ' + escapeHtml(name);

    // compact workspace score panel — mirrors the same gauge/status shown in
    // the full score card above, but as just the final number (see
    // enterWorkspaceMode): the full per-dimension breakdown stays in the
    // (now hidden-in-workspace) score card rather than cluttering the chat.
    if (inWorkspace) {
      wsScoreNum.textContent = s && s.selectedCount ? overall : '--';
      wsRingFill.style.strokeDasharray = WS_RING_CIRC;
      wsRingFill.style.strokeDashoffset = s && s.selectedCount ? WS_RING_CIRC * (1 - overall / 100) : WS_RING_CIRC;
      wsScoreTitle.textContent = name;
      wsScoreStatus.textContent = scoreStatus.textContent;

      var weak = (s && s.selectedCount) ? DIMENSIONS.filter(function (d) { return s[d] < 50; }).sort(function (a, b) { return s[a] - s[b]; }) : [];
      if (weak.length) {
        wsImprove.hidden = false;
        wsImproveTags.innerHTML = weak.map(function (d) {
          return '<span class="ws-tag">' + escapeHtml(DIMENSION_LABELS[d]) + '</span>';
        }).join('');
      } else {
        wsImprove.hidden = true;
        wsImproveTags.innerHTML = '';
      }
    }

    if (state.profile.website) {
      // show just the hostname, not the whole scraped URL — a real business
      // link can carry a long path and tracking query string
      // (?gad_source=...&gbraid=...) that, left in as one unbroken string,
      // was forcing this "browser address bar" mock (and the card/grid
      // around it) wider than the viewport instead of truncating in place.
      var hostname;
      try {
        hostname = new URL(/^https?:\/\//.test(state.profile.website) ? state.profile.website : 'https://' + state.profile.website).hostname;
      } catch (err) {
        hostname = state.profile.website.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
      }
      previewUrl.textContent = hostname || state.profile.website.replace(/^https?:\/\//, '');
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

  // "Download ZIP" only makes sense once the BrixOS Orchestrator has
  // produced a real multi-page project (server/orchestrator.js) — the
  // older single-file /api/generate path never sets generatedProject, so
  // the button simply stays hidden for a site built that way, which is
  // correct (there is nothing multi-file to export yet).
  function renderExportButton() {
    var hasProject = Boolean(state.profile && state.profile.generatedProject);
    exportZipBtn.hidden = !hasProject;
  }

  // "Open in new tab" — the embedded preview is a sandboxed iframe (safe,
  // but restrictive: internal links are intentionally inert there so
  // clicking one can't navigate the app itself away, see renderPreview()
  // below). This gives a real fallback / alternate way to actually see the
  // generated page working: it opens the exact generated HTML as its own
  // real, top-level page via a Blob URL — a real browser tab, not an
  // embedded frame — the same way you'd open an HTML file directly.
  var lastPreviewHtml = null;
  function renderOpenPreviewButton() {
    var site = state.profile && state.profile.generatedSite;
    lastPreviewHtml = site ? site.html : null;
    openPreviewBtn.hidden = !lastPreviewHtml;
  }

  openPreviewBtn.addEventListener('click', function () {
    if (!lastPreviewHtml) return;
    var blob = new Blob([lastPreviewHtml], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var win = window.open(url, '_blank');
    if (!win) {
      toast('Your browser blocked the new tab — allow popups for this site and try again.', true);
    }
    // give the new tab time to actually load the blob before revoking it
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  });

  function renderPreview() {
    var site = state.profile && state.profile.generatedSite;
    renderExportButton();
    renderOpenPreviewButton();

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

    enterWorkspaceMode();
    consoleInput.value = '';
    appendChatBubble('user', value);
    runChatTurn(value, chatHistory.slice(-12));
  }

  // Split out from sendChatMessage() so a chat message can be silently
  // RE-sent after the user answers the Claude-approval prompt (see
  // answerClaudeApproval below) without re-adding the user's bubble or
  // re-reading the (already-cleared) input box.
  function runChatTurn(value, historyForRequest) {
    showTyping();
    chatBusy = true;
    sendBtn.disabled = true;

    api('/api/chat', { method: 'POST', body: { message: value, history: historyForRequest } })
      .then(function (data) {
        hideTyping();

        // Chat hit BrixOS's paid-Claude-usage approval gate — same rule the
        // Orchestrator enforces (server/providerPolicy.js). Pause here,
        // ask, and — once answered — resend this exact message instead of
        // guessing or silently spending anything.
        if (data.needsClaudeApproval) {
          openClaudeApprovalModalForChat(value, historyForRequest);
          return;
        }

        chatHistory.push({ role: 'user', content: value });
        chatHistory.push({ role: 'assistant', content: data.reply });
        typewriteBubble(appendChatBubble('assistant', ''), data.reply || '…');

        state.profile = data.profile;
        state.score = data.score;
        renderPopover(); renderChips(); renderScoreUI();

        // The chat agent started a real Orchestrator job (generate_site /
        // modify_site) — light up the exact same progress UI and polling
        // the "Generate my site" button uses, so it doesn't matter which
        // entry point the user used.
        if (data.orchestratorJobId) {
          setOrchestratorBusy(true);
          showOrchestratorStatus({ status: 'QUEUED' });
          pollOrchestratorJob(data.orchestratorJobId);
        }
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
  // "Generate my site" — the BrixOS Orchestrator (server/orchestrator.js):
  // UNDERSTAND -> RESEARCH -> PLAN -> ARCHITECT -> GENERATE -> VALIDATE ->
  // FIX -> PREVIEW, run as a background job and polled here for live status.
  // Falls back to the older one-shot /api/generate only if starting a job
  // fails outright (e.g. offline), so "Generate my site" still does
  // *something* rather than a dead end.
  // ===========================================================================

  var orchestratorPollTimer = null;
  var orchestratorBusy = false;

  var ORCHESTRATOR_STAGE_LABELS = {
    QUEUED: 'Queued…',
    STUDYING: 'Studying your business…',
    PLANNING: 'Creating your website architecture…',
    ARCHITECTING: 'Breaking the site into pages…',
    GENERATING: 'Generating your pages…',
    VALIDATING: 'Checking your site for issues…',
    FIXING: 'Fixing issues it found…',
    READY: 'Your site is ready.',
    FAILED: 'Generation failed.'
  };

  function setOrchestratorBusy(busy) {
    orchestratorBusy = busy;
    generateBtn.disabled = busy;
    generateBtn.textContent = busy ? 'Generating…' : 'Generate my site';
    previewBody.classList.toggle('is-loading', busy);
  }

  function showOrchestratorStatus(job) {
    orchestratorStatus.hidden = false;
    orchestratorStatus.textContent = job.message || ORCHESTRATOR_STAGE_LABELS[job.status] || job.status;
  }

  function hideOrchestratorStatus() {
    orchestratorStatus.hidden = true;
  }

  function stopOrchestratorPolling() {
    if (orchestratorPollTimer) { clearTimeout(orchestratorPollTimer); orchestratorPollTimer = null; }
  }

  // The Claude-approval modal is shared by two different callers: an
  // Orchestrator job paused in AWAITING_APPROVAL (server/orchestrator.js),
  // and a chat message that hit the same gate before it could even start
  // reasoning (server/chat.js) — see pendingApproval below for which one is
  // currently open.
  var pendingApproval = null; // { type: 'job', jobId } | { type: 'chat', message, history }

  function openClaudeApprovalModalForJob(jobId) {
    pendingApproval = { type: 'job', jobId: jobId };
    claudeApprovalOverlay.classList.add('is-open');
  }

  function openClaudeApprovalModalForChat(message, historyForRequest) {
    pendingApproval = { type: 'chat', message: message, history: historyForRequest };
    claudeApprovalOverlay.classList.add('is-open');
  }

  function closeClaudeApprovalModal() {
    claudeApprovalOverlay.classList.remove('is-open');
  }

  function answerClaudeApproval(approve) {
    var pending = pendingApproval;
    pendingApproval = null;
    closeClaudeApprovalModal();
    if (!pending) return;

    if (pending.type === 'job') {
      api('/api/orchestrator/jobs/' + pending.jobId + '/approve', { method: 'POST', body: { approve: approve } })
        .then(function (job) { handleOrchestratorJob(job); })
        .catch(function (err) {
          setOrchestratorBusy(false);
          hideOrchestratorStatus();
          toast(err.message, true);
        });
      return;
    }

    // pending.type === 'chat' — persist the decision, then silently resend
    // the exact same message: it'll run on Claude now, or (declined) fall
    // through to the free OpenRouter path, either way without asking again.
    api('/api/orchestrator/claude-approval', { method: 'POST', body: { approve: approve } })
      .then(function () { runChatTurn(pending.message, pending.history); })
      .catch(function (err) { appendChatBubble('assistant', err.message || 'Something went wrong — try again.'); });
  }

  claudeApproveBtn.addEventListener('click', function () { answerClaudeApproval(true); });
  claudeDeclineBtn.addEventListener('click', function () { answerClaudeApproval(false); });
  // Dismissing without an explicit choice (backdrop click / Escape) is
  // treated the same as declining — BrixOS should never end up spending
  // paid Claude credits from an ambiguous dismissal, only from an explicit
  // "Continue with Claude".
  claudeApprovalOverlay.addEventListener('click', function (e) { if (e.target === claudeApprovalOverlay) answerClaudeApproval(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && claudeApprovalOverlay.classList.contains('is-open')) answerClaudeApproval(false);
  });

  function handleOrchestratorJob(job) {
    if (job.status === 'AWAITING_APPROVAL') {
      showOrchestratorStatus(job);
      openClaudeApprovalModalForJob(job.id);
      return;
    }

    if (job.status === 'READY') {
      stopOrchestratorPolling();
      setOrchestratorBusy(false);
      hideOrchestratorStatus();
      state.profile = job.profile;
      state.score = job.score;
      renderPopover(); renderChips(); renderScoreUI();
      toast('Your rebuilt site is ready — check the preview panel.');
      return;
    }

    if (job.status === 'FAILED') {
      stopOrchestratorPolling();
      setOrchestratorBusy(false);
      hideOrchestratorStatus();
      toast(job.message || 'Generation failed — try again in a moment.', true);
      return;
    }

    // still in progress — keep polling
    showOrchestratorStatus(job);
    orchestratorPollTimer = setTimeout(function () { pollOrchestratorJob(job.id); }, 1200);
  }

  function pollOrchestratorJob(jobId) {
    api('/api/orchestrator/jobs/' + jobId)
      .then(handleOrchestratorJob)
      .catch(function (err) {
        stopOrchestratorPolling();
        setOrchestratorBusy(false);
        hideOrchestratorStatus();
        toast(err.message, true);
      });
  }

  function generateSite() {
    if (!state.authed) {
      toast('Sign in so BrixOS can save the site it generates for you.', true);
      openAuthModal('login');
      return;
    }
    if (orchestratorBusy) return;

    enterWorkspaceMode();
    setOrchestratorBusy(true);
    showOrchestratorStatus({ status: 'QUEUED' });

    api('/api/orchestrator/generate', { method: 'POST' })
      .then(handleOrchestratorJob)
      .catch(function (err) {
        setOrchestratorBusy(false);
        hideOrchestratorStatus();
        toast(err.message, true);
      });
  }

  generateBtn.addEventListener('click', generateSite);

  exportZipBtn.addEventListener('click', function () {
    if (!state.authed) { toast('Sign in first.', true); return; }
    window.location.href = '/api/orchestrator/export';
  });

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
      state.aiConfigured = Boolean(data.aiConfigured);
      state.aiProvider = data.aiProvider || null;
      renderEngineStatus();
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
