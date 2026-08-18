/* =============================================================================
   GENERATION PROGRESS — floating reactor card + minimisable orb
   -----------------------------------------------------------------------------
   What happens between pressing Generate and the result arriving.

   Appears the moment a job starts: a glass card (bottom-right, above the dock)
   with an animated "reactor" core — a teal progress ring around two
   counter-rotating orbit arcs and a breathing center — plus stage narration,
   elapsed time, and a cancel action per job. The minimise button collapses it
   to a small orb showing aggregate progress; clicking the orb reopens the card.
   A new generation always re-opens the card ("appear right away").

   Reads the same source of truth everything else does:
     State.getActiveJobs()    → live job ids          (localStorage)
     State.getPendingMeta()   → prompt, stage, progress per id
     State.onActiveJobsChange → subscription for add/remove
   It owns no job state. If a job is removed elsewhere, the row leaves.

   Cancel calls POST /api/jobs/:id/cancel (queued jobs; an in-flight job
   completes or refunds on its own — the button says so via toast).
   Styling: 3dprint-modules/css/gen-progress.css. Old .gen-track styles in
   nav.css are no longer referenced by markup.
   ========================================================================== */
(function () {
  'use strict';

  var POLL_MS = 900;
  var RING_R = 19;                          // SVG ring radius
  var RING_C = 2 * Math.PI * RING_R;        // circumference for dashoffset
  var host, cardEl, listEl, headCoreEl, headCountEl, orbEl, orbRingEl, orbBadgeEl, live;
  var pollId = null, lastSig = null;
  var minimised = false;                    // per-session; a new job re-expands
  var minimising = false;                   // true while the fly-down runs
  var knownIds = Object.create(null);
  var transientJobs = Object.create(null);  // optimistic "starting" rows before the API returns an id
  var seen = Object.create(null);           // id -> last announced bucket
  var cancelling = Object.create(null);     // id -> true while cancel in flight
  var baseTitle = document.title;
  var stateSubscribed = false;
  var TRANSIENT_TTL = 18000;

  var ICONS = {
    model:   'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    image:   'M4 16l4.6-4.6a2 2 0 012.8 0L16 16M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
    video:   'M15 10l4.6-2.3A1 1 0 0121 8.6v6.8a1 1 0 01-1.4.9L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
    remesh:  'M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z',
    texture: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4z',
    rig:     'M12 2a4 4 0 014 4v1h2v4h-1v5l1 4H6l1-4v-5H6V7h2V6a4 4 0 014-4z',
    animate: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM10 9l5 3-5 3z'
  };

  var STAGE_LABEL = {
    queued:     'Queued',
    pending:    'Queued',
    starting:   'Starting',
    processing: 'Generating',
    preview:    'Building preview',
    refine:     'Refining',
    texture:    'Texturing',
    remesh:     'Rebuilding topology',
    rig:        'Rigging',
    animate:    'Animating',
    uploading:  'Uploading',
    succeeded:  'Complete',
    completed:  'Complete',
    failed:     'Failed'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  function stateMethod(name) {
    if (window.TimrXState && typeof window.TimrXState[name] === 'function') {
      return window.TimrXState[name].bind(window.TimrXState);
    }
    if (typeof window[name] === 'function') return window[name].bind(window);
    return null;
  }

  function normaliseKind(type) {
    var t = String(type || '').toLowerCase();
    if (t.indexOf('image') !== -1) return 'image';
    if (t.indexOf('video') !== -1 || t.indexOf('seedance') !== -1 || t.indexOf('veo') !== -1) return 'video';
    if (t.indexOf('texture') !== -1) return 'texture';
    if (t.indexOf('remesh') !== -1 || t.indexOf('topology') !== -1) return 'remesh';
    if (t.indexOf('rig') !== -1) return 'rig';
    if (t.indexOf('anim') !== -1 || t.indexOf('evolve') !== -1) return 'animate';
    return 'model';
  }

  function currentPromptForKind(kind, detail) {
    if (detail && detail.prompt) return detail.prompt;
    var ids = kind === 'video'
      ? ['videoMotion', 'videoPrompt', 'modelPrompt']
      : kind === 'image'
        ? ['imagePrompt', 'modelPrompt']
        : ['modelPrompt', 'imagePrompt', 'texturePrompt', 'videoMotion'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      var value = el && String(el.value || '').trim();
      if (value) return value;
    }
    return '';
  }

  function addTransientJob(detail) {
    var kind = normaliseKind(detail && detail.type);
    var prompt = currentPromptForKind(kind, detail);
    if (!prompt) return;
    var id = 'starting-' + kind + '-' + Date.now();
    transientJobs[id] = {
      id: id,
      pct: null,
      stage: 'starting',
      label: 'Starting',
      kind: kind,
      prompt: prompt,
      started: Date.now(),
      transient: true,
      expires: Date.now() + TRANSIENT_TTL
    };
    minimised = false;
    lastSig = null;
    render();
  }

  function readJobs() {
    var ids = [];
    var getActiveJobs = stateMethod('getActiveJobs');
    var getPendingMeta = stateMethod('getPendingMeta');
    try { ids = (getActiveJobs && getActiveJobs()) || []; } catch (e) { ids = []; }
    var meta = {};
    try { meta = (getPendingMeta && getPendingMeta()) || {}; } catch (e) { meta = {}; }

    var jobs = ids.map(function (id) {
      var m = meta[id] || {};
      var pct = typeof m.progress === 'number' ? m.progress
              : typeof m.progress_pct === 'number' ? m.progress_pct : null;
      var stage = String(m.stage || m.status || m.type || 'processing').toLowerCase();
      return {
        id: id,
        pct: pct,
        stage: stage,
        label: STAGE_LABEL[stage] || 'Generating',
        kind: String(m.type || m.kind || m.stage || 'model').toLowerCase(),
        prompt: m.prompt || m.title || 'Untitled generation',
        started: m.started_at || m.startedAt || m.created_at || null
      };
    });

    var now = Date.now();
    if (jobs.length) {
      transientJobs = Object.create(null);
      return jobs;
    }

    Object.keys(transientJobs).forEach(function (id) {
      if (transientJobs[id].expires < now) delete transientJobs[id];
    });
    return Object.keys(transientJobs).map(function (id) { return transientJobs[id]; });
  }

  function elapsed(ts) {
    if (!ts) return '';
    var t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!t || isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function kindIcon(kind) {
    var d = ICONS[kind] || ICONS.model;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  /* The reactor core: progress ring + two counter-rotating orbit arcs + pulse.
     Indeterminate (pct == null) hides the ring and lets the orbits carry it. */
  function coreSVG(cls) {
    return (
      '<svg class="' + cls + '" viewBox="0 0 48 48" aria-hidden="true">' +
      '  <circle class="gp-core__track" cx="24" cy="24" r="' + RING_R + '"/>' +
      '  <circle class="gp-core__ring" cx="24" cy="24" r="' + RING_R + '" ' +
      '          stroke-dasharray="' + RING_C.toFixed(1) + '" stroke-dashoffset="' + RING_C.toFixed(1) + '"/>' +
      '  <g class="gp-core__orbit gp-core__orbit--a"><circle cx="24" cy="24" r="13"/></g>' +
      '  <g class="gp-core__orbit gp-core__orbit--b"><circle cx="24" cy="24" r="8.5"/></g>' +
      '  <circle class="gp-core__dot" cx="24" cy="24" r="2.6"/>' +
      '</svg>'
    );
  }

  function setRing(svg, pct) {
    if (!svg) return;
    var ring = svg.querySelector('.gp-core__ring');
    if (!ring) return;
    if (pct == null) {
      svg.classList.add('is-indeterminate');
      ring.style.strokeDashoffset = RING_C;
    } else {
      svg.classList.remove('is-indeterminate');
      var clamped = Math.max(0, Math.min(100, pct));
      ring.style.strokeDashoffset = (RING_C * (1 - clamped / 100)).toFixed(1);
    }
  }

  function rowHTML(j) {
    return (
      '<div class="gp__row" data-job="' + esc(j.id) + '">' +
      '  <span class="gp__row-icon">' + kindIcon(j.kind) + '</span>' +
      '  <span class="gp__row-info">' +
      '    <span class="gp__row-stage"><b data-role="stage">' + esc(j.label) + '</b>' +
      '      <i class="gp__row-meta"><span data-role="pct">' + (j.pct != null ? Math.round(j.pct) + '%' : '') + '</span>' +
      '      <span data-role="elapsed">' + esc(elapsed(j.started)) + '</span></i></span>' +
      '    <span class="gp__row-prompt">' + esc(j.prompt) + '</span>' +
      '    <span class="gp__row-bar"><span data-role="bar" style="width:' + (j.pct != null ? Math.max(2, Math.round(j.pct)) : 12) + '%"' +
             (j.pct == null ? ' class="is-indeterminate"' : '') + '></span></span>' +
      '  </span>' +
      (j.transient
        ? '  <span class="gp__cancel gp__cancel--ghost" aria-hidden="true"></span>'
        : '  <button type="button" class="gp__cancel" data-cancel="' + esc(j.id) + '" title="Cancel this generation" aria-label="Cancel generation">' +
          '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
          '  </button>') +
      '</div>'
    );
  }

  function aggregatePct(jobs) {
    var withPct = jobs.filter(function (j) { return j.pct != null; });
    if (!withPct.length) return null;
    return Math.round(withPct.reduce(function (a, j) { return a + j.pct; }, 0) / withPct.length);
  }

  function announce(jobs) {
    if (!live) return;
    var msgs = [];
    jobs.forEach(function (j) {
      var bucket = j.pct == null ? j.stage : j.stage + ':' + Math.floor(j.pct / 25);
      if (seen[j.id] === bucket) return;
      seen[j.id] = bucket;
      msgs.push(j.label + (j.pct != null ? ', ' + Math.round(j.pct) + ' percent' : '') + ': ' + j.prompt.slice(0, 60));
    });
    if (msgs.length) live.textContent = msgs.join('. ');
  }

  function syncTitle(jobs) {
    if (!jobs.length) { document.title = baseTitle; return; }
    var agg = aggregatePct(jobs);
    document.title = (agg != null ? '(' + agg + '%) ' : '(…) ') + baseTitle;
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.className = 'gp';
    host.id = 'genProgress';
    host.hidden = true;
    host.innerHTML =
      '<section class="gp__card" role="status" aria-label="Active generations">' +
      '  <header class="gp__head">' +
      '    <span class="gp__head-core">' + coreSVG('gp-core gp-core--head') + '<b class="gp__head-pct"></b></span>' +
      '    <span class="gp__head-title">Generating<i class="gp__head-count"></i></span>' +
      '    <button type="button" class="gp__minimise" title="Minimise" aria-label="Minimise progress panel">' +
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>' +
      '    </button>' +
      '  </header>' +
      '  <div class="gp__list"></div>' +
      '</section>' +
      '<button type="button" class="gp__orb" aria-label="Show generation progress" hidden>' +
        coreSVG('gp-core gp-core--orb') +
      '  <b class="gp__orb-badge" hidden></b>' +
      '</button>';

    live = document.createElement('p');
    live.className = 'visually-hidden';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    host.appendChild(live);
    document.body.appendChild(host);

    cardEl = host.querySelector('.gp__card');
    listEl = host.querySelector('.gp__list');
    headCoreEl = host.querySelector('.gp-core--head');
    headCountEl = host.querySelector('.gp__head-count');
    orbEl = host.querySelector('.gp__orb');
    orbRingEl = host.querySelector('.gp-core--orb');
    orbBadgeEl = host.querySelector('.gp__orb-badge');

    host.querySelector('.gp__minimise').addEventListener('click', function () {
      if (minimising) return;
      var reduceMotion = false;
      try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
      if (reduceMotion) { minimised = true; applyMinimised(); return; }
      // Two-phase choreography (gen-progress.css): the card flies down toward
      // the orb's dock, then the orb bounces in with sonar pings — the user's
      // eye follows the motion and learns where the progress now lives.
      minimising = true;
      host.classList.add('gp--minimising');
      setTimeout(function () {
        host.classList.remove('gp--minimising');
        minimising = false;
        minimised = true;
        applyMinimised();
        orbEl.classList.remove('is-arriving');
        void orbEl.offsetWidth; // restart the arrival animation
        orbEl.classList.add('is-arriving');
        setTimeout(function () { orbEl.classList.remove('is-arriving'); }, 2200);
      }, 360);
    });
    orbEl.addEventListener('click', function () {
      minimised = false;
      applyMinimised();
    });
    listEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-cancel]');
      if (btn) cancelJob(btn.getAttribute('data-cancel'), btn);
    });
  }

  function applyMinimised() {
    if (!cardEl) return;
    cardEl.hidden = minimised;
    orbEl.hidden = !minimised;
    // gen-progress.css: expanded card sits centred above modals; the
    // minimised orb docks top-right via this class.
    if (host) host.classList.toggle('gp--min', minimised);
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
    else console.log('[GenProgress]', msg);
  }

  function cancelJob(id, btn) {
    if (!id || cancelling[id]) return;
    if (String(id).indexOf('starting-') === 0) return;
    var api = window.TimrXApi;
    if (!api || !api.apiPost) { toast('Cancel is unavailable right now.'); return; }
    cancelling[id] = true;
    if (btn) btn.classList.add('is-busy');
    function done() {
      delete cancelling[id];
      if (btn) btn.classList.remove('is-busy');
    }
    api.apiPost('/api/jobs/' + encodeURIComponent(id) + '/cancel', { reason: 'user_cancelled' })
      .then(function (res) {
        done();
        if (res && res.ok) {
          toast('Generation cancelled — credits refunded.');
          var removeActiveJob = stateMethod('removeActiveJob');
          try { removeActiveJob && removeActiveJob(id); } catch (e) {}
          lastSig = null; render();
        } else {
          var code = res && res.data && res.data.error && res.data.error.code;
          if (code === 'NOT_CANCELLABLE') {
            toast('Already processing — it will finish, or your credits refund automatically if it fails.');
          } else {
            toast('Could not cancel: ' + ((res && res.error) || 'unknown error'));
          }
        }
      })
      .catch(function () { done(); toast('Could not cancel — network error.'); });
  }

  function render() {
    ensureHost();
    var jobs = readJobs();
    var sig = jobs.map(function (j) { return j.id + ':' + j.pct + ':' + j.stage; }).join('|');

    // New job? Always pop the card open — "appear right away when they hit generate."
    var hasNew = false;
    jobs.forEach(function (j) { if (!knownIds[j.id]) { knownIds[j.id] = true; hasNew = true; } });
    Object.keys(knownIds).forEach(function (id) {
      if (!jobs.some(function (j) { return j.id === id; })) delete knownIds[id];
    });
    if (hasNew) minimised = false;

    var active = jobs.length > 0;
    host.hidden = !active;
    document.body.classList.toggle('ws-generating', active);
    if (!active) {
      lastSig = sig;
      syncTitle(jobs);
      return;
    }
    applyMinimised();

    // Aggregate ring + counters (cheap; every tick)
    var agg = aggregatePct(jobs);
    setRing(headCoreEl, agg);
    setRing(orbRingEl, agg);
    var headPct = host.querySelector('.gp__head-pct');
    if (headPct) headPct.textContent = agg != null ? agg + '%' : '';
    headCountEl.textContent = jobs.length > 1 ? ' ' + jobs.length : '';
    orbBadgeEl.hidden = jobs.length < 2;
    orbBadgeEl.textContent = jobs.length;

    if (sig === lastSig) {
      // refresh elapsed labels without a full re-render
      jobs.forEach(function (j) {
        var el = listEl.querySelector('[data-job="' + CSS.escape(j.id) + '"] [data-role="elapsed"]');
        if (el) el.textContent = elapsed(j.started);
      });
      return;
    }
    lastSig = sig;

    listEl.innerHTML = jobs.map(rowHTML).join('');
    announce(jobs);
    syncTitle(jobs);

    Object.keys(seen).forEach(function (id) {
      if (!jobs.some(function (j) { return j.id === id; })) delete seen[id];
    });
  }

  function start() {
    if (pollId) return;
    pollId = setInterval(function () {
      subscribeState();
      render();
    }, POLL_MS);
    render();
  }

  function subscribeState() {
    if (stateSubscribed) return;
    var onActiveJobsChange = stateMethod('onActiveJobsChange');
    if (!onActiveJobsChange) return;
    try {
      onActiveJobsChange(function () { lastSig = null; render(); });
      stateSubscribed = true;
    } catch (e) {}
  }

  function boot() {
    ensureHost();
    start();
    subscribeState();
    window.addEventListener('generation:start', function (e) { addTransientJob((e && e.detail) || {}); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { lastSig = null; render(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.TimrXGenerationTracker = { refresh: function () { lastSig = null; render(); } };
})();
