/* =============================================================================
   GENERATION TRACKER
   -----------------------------------------------------------------------------
   What happens between pressing Generate and the result arriving.

   Before this, the only feedback was a small "N generating" pill that opened a
   modal you had to ask for. A generation takes one to two minutes; for that
   whole time the workspace said almost nothing, and the page had two aria-live
   regions in total — a screen-reader user got no queued, no progress, no
   complete, no failure.

   This reads the same source of truth everything else does:
     State.getActiveJobs()   → live job ids          (localStorage)
     State.getPendingMeta()  → prompt, stage, progress per id
     State.onActiveJobsChange → subscription for add/remove

   It owns no job state. If a job is removed elsewhere, the card leaves.
   ========================================================================== */
(function () {
  'use strict';

  var POLL_MS = 900;          // meta lives in localStorage; cheap to re-read
  var host, listEl, live, pollId = null, lastSig = null, lastCount = -1;
  var seen = Object.create(null);   // id -> last announced bucket
  var baseTitle = document.title;

  var ICONS = {
    model:   'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    image:   'M4 16l4.6-4.6a2 2 0 012.8 0L16 16M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
    video:   'M15 10l4.6-2.3A1 1 0 0121 8.6v6.8a1 1 0 01-1.4.9L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
    remesh:  'M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z',
    texture: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4z',
    rig:     'M12 2a4 4 0 014 4v1h2v4h-1v5l1 4H6l1-4v-5H6V7h2V6a4 4 0 014-4z',
    animate: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM10 9l5 3-5 3z'
  };

  /* The stages a job moves through, so the card can say where it actually is
     rather than only showing a number. */
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

  function readJobs() {
    var S = window.TimrXState || window;
    var ids = [];
    try { ids = (S.getActiveJobs && S.getActiveJobs()) || []; } catch (e) { ids = []; }
    var meta = {};
    try { meta = (S.getPendingMeta && S.getPendingMeta()) || {}; } catch (e) { meta = {}; }

    return ids.map(function (id) {
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
  }

  function elapsed(ts) {
    if (!ts) return '';
    var t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!t || isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.className = 'gen-track';
    host.id = 'genTrack';
    host.hidden = true;

    listEl = document.createElement('div');
    listEl.className = 'gen-track__list';
    host.appendChild(listEl);

    // Progress belongs in the a11y tree, not only on screen.
    live = document.createElement('p');
    live.className = 'visually-hidden';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    host.appendChild(live);

    document.body.appendChild(host);
  }

  /* A figure that walks the bar as the job advances: limbs swing, the body
     bobs, and it stands wherever the progress is. A bar that only fills says
     "something is happening"; a walker says how far along the road it is, and
     keeps moving even while a slow provider sits on the same percentage. */
  var WALKER =
    '<svg class="gen-walk" viewBox="0 0 20 23" fill="none" stroke="currentColor" ' +
    'stroke-width="2.1" stroke-linecap="round" aria-hidden="true">' +
      '<circle class="gen-walk__head" cx="10" cy="4.2" r="3.1" fill="currentColor" stroke="none"/>' +
      '<path class="gen-walk__torso" d="M10 8v7.4"/>' +
      '<path class="gen-walk__limb gen-walk__arm-a" d="M10 10.2 6.2 13.8"/>' +
      '<path class="gen-walk__limb gen-walk__arm-b" d="M10 10.2 13.8 13.2"/>' +
      '<path class="gen-walk__limb gen-walk__leg-a" d="M10 15.4 6.4 21.8"/>' +
      '<path class="gen-walk__limb gen-walk__leg-b" d="M10 15.4 13.6 21.8"/>' +
    '</svg>';

  function cardHTML(j) {
    var known = j.pct != null && j.pct > 0;
    var icon = ICONS[j.kind] || ICONS.model;
    // Keep the figure clear of both ends so it never hangs half off the track.
    var walkAt = known ? Math.min(97, Math.max(3, j.pct)) : 3;
    return '' +
      '<article class="gen-card' + (known ? '' : ' is-indeterminate') + '" data-job="' + esc(j.id) + '">' +
        '<span class="gen-card__ico" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round"><path d="' + icon + '"/></svg>' +
        '</span>' +
        '<span class="gen-card__body">' +
          '<span class="gen-card__top">' +
            '<span class="gen-card__stage">' + esc(j.label) + '</span>' +
            '<span class="gen-card__pct">' + (known ? j.pct + '%' : esc(elapsed(j.started))) + '</span>' +
          '</span>' +
          '<span class="gen-card__prompt">' + esc(j.prompt) + '</span>' +
          '<span class="gen-card__track">' +
            '<span class="gen-card__walker" style="left:' + walkAt + '%">' + WALKER + '</span>' +
            '<span class="gen-card__bar"><i style="width:' + (known ? j.pct : 100) + '%"></i></span>' +
          '</span>' +
        '</span>' +
      '</article>';
  }

  /* Announce on crossing a bucket, not on every tick — otherwise a polite
     region queues dozens of messages and lags minutes behind the UI. */
  function announce(jobs) {
    var msgs = [];
    jobs.forEach(function (j) {
      var bucket = j.pct == null ? j.label
                 : j.label + ' ' + (Math.floor(j.pct / 25) * 25);
      if (seen[j.id] !== bucket) {
        seen[j.id] = bucket;
        msgs.push(j.label + (j.pct != null ? ', ' + j.pct + ' percent' : '') +
                  ': ' + j.prompt.slice(0, 60));
      }
    });
    if (msgs.length) live.textContent = msgs.join('. ');
  }

  function syncTitle(jobs) {
    if (!jobs.length) { document.title = baseTitle; return; }
    var withPct = jobs.filter(function (j) { return j.pct != null; });
    var avg = withPct.length
      ? Math.round(withPct.reduce(function (a, j) { return a + j.pct; }, 0) / withPct.length)
      : null;
    // Visible even when the tab is in the background, which is where people
    // actually are during a two-minute wait.
    document.title = (avg != null ? '(' + avg + '%) ' : '(' + jobs.length + ') ') + baseTitle;
  }

  function render() {
    var jobs = readJobs();
    var sig = jobs.map(function (j) { return j.id + ':' + j.pct + ':' + j.stage; }).join('|');

    if (jobs.length !== lastCount) {
      host.hidden = jobs.length === 0;
      document.body.classList.toggle('ws-generating', jobs.length > 0);
      lastCount = jobs.length;
    }
    if (sig === lastSig) {
      // still refresh elapsed time on indeterminate cards
      if (jobs.some(function (j) { return j.pct == null; })) {
        jobs.forEach(function (j) {
          if (j.pct != null) return;
          var el = listEl.querySelector('[data-job="' + CSS.escape(j.id) + '"] .gen-card__pct');
          if (el) el.textContent = elapsed(j.started);
        });
      }
      return;
    }
    lastSig = sig;

    listEl.innerHTML = jobs.map(cardHTML).join('');
    announce(jobs);
    syncTitle(jobs);

    // Clear announce memory for jobs that finished.
    Object.keys(seen).forEach(function (id) {
      if (!jobs.some(function (j) { return j.id === id; })) delete seen[id];
    });
  }

  function start() {
    if (pollId) return;
    pollId = setInterval(render, POLL_MS);
    render();
  }

  function boot() {
    ensureHost();
    start();
    // React immediately to add/remove instead of waiting for the next tick.
    var S = window.TimrXState || window;
    if (S.onActiveJobsChange) {
      try { S.onActiveJobsChange(function () { lastSig = null; render(); }); } catch (e) {}
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { lastSig = null; render(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* null, not '': an empty job list produces the signature '', so forcing the
     cache to '' made the next render believe nothing had changed and skip the
     teardown — the document title stayed at "(10%) …" after the last job
     finished. null can never equal a computed signature. */
  window.TimrXGenerationTracker = { refresh: function () { lastSig = null; render(); } };
})();
