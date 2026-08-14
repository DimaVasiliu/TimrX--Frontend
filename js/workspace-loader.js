/* ==========================================================================
   WORKSPACE LOADER — milestone-driven boot progress
   --------------------------------------------------------------------------
   Stripped 2026-08-14. One job now: report the boot that is actually
   happening, then hand over.

     milestones   document interactive .......... 24%
                  fonts ready ................... 44%
                  (brain milestone removed 2026-08-11) . 68%   (immediate)
                  window load (assets) .......... 100%
     display      eased toward the live target with a gentle trickle, so the
                  bar keeps breathing between milestones and never lies at 94.
     handoff      at 100%: body.ws-intro-go releases the chrome arrival
                  animations (gated in workspace-loader.css) and the veil
                  crossfades out.

   Failsafes: every milestone has a timeout; a hard cap guarantees the loader
   can never trap the page.

   GONE, and what went with it: the impact anchor, the polar tessellation, the
   crack network, the crush zone, the spall, arm()/detonate()/buildGlass() and
   the seeded RNG they shared — ~400 lines. The X no longer falls, so nothing
   has to wait for it to land, which is why MIN_SHOWTIME_MS is 1500 rather than
   2800: it exists only to stop the veil strobing on a warm cache, not to
   protect an animation. The pacing lever is the speed limit in frame(), not
   this.

   The orbit grid (js/workspace-loader-grid.js) is not referenced here. It
   reads --loader-progress off this element and nothing else, so it can be
   deleted without touching this file, and this file can change pacing without
   touching it.
   ========================================================================== */
(function () {
  'use strict';

  var loader = document.getElementById('workspaceLoader');
  if (!loader) return;

  document.body.classList.add('has-ws-loader');

  var bar = loader.querySelector('[data-loader-bar]');
  var percentEl = loader.querySelector('[data-loader-percent]');
  var statusEl = loader.querySelector('[data-loader-status]');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var HARD_CAP_MS = 8000;          /* nothing holds the page hostage */
  var MIN_SHOWTIME_MS = reduceMotion ? 0 : 1500;

  var started = performance.now();
  var target = 6;
  var shown = 0;
  var exited = false;

  var debug = { target: 0, shown: 0, exited: false, loadFired: false, frames: 0 };
  window.__wsLoaderDebug = debug;

  /* ==========================================================================
     PROGRESS
     ========================================================================== */
  var STAGES = [
    { at: 0,   label: 'Waking the workspace' },
    { at: 16,  label: 'Loading engines' },
    { at: 36,  label: 'Calibrating 3D viewer' },
    { at: 56,  label: 'Syncing your assets' },
    { at: 76,  label: 'Sharpening pixels' },
    { at: 92,  label: 'Final polish' },
    { at: 100, label: 'Ready — create something' }
  ];
  var stageIndex = -1;

  function setStatus(progress) {
    if (!statusEl) return;
    var next = -1;
    for (var i = 0; i < STAGES.length; i++) {
      if (progress >= STAGES[i].at) next = i;
    }
    if (next === stageIndex) return;
    stageIndex = next;
    var label = STAGES[Math.max(0, next)].label;
    statusEl.classList.add('is-swapping');
    window.setTimeout(function () {
      statusEl.textContent = label;
      statusEl.classList.remove('is-swapping');
    }, 150);
    /* One polite announcement per stage, not per frame. */
    loader.setAttribute('aria-label', 'Preparing TimrX workspace — ' + label);
  }

  function paint(value) {
    var progress = Math.max(0, Math.min(100, value));
    /* the orbit grid reads this, and nothing else */
    loader.style.setProperty('--loader-progress', progress + '%');
    if (bar) bar.style.width = progress + '%';
    if (percentEl) percentEl.textContent = String(Math.round(progress)).padStart(2, '0');
    setStatus(progress);
  }

  function reach(value) {
    if (value > target) target = value;
  }

  /* ----- display loop: ease toward target, trickle while waiting -------- */
  function frame() {
    if (exited) return;
    debug.target = target; debug.shown = shown; debug.frames++;
    var prev = shown;
    var gap = target - shown;
    shown += gap * 0.021;                       /* ease toward the milestone */
    if (gap < 6 && target < 100) {
      shown += 0.006;                           /* trickle: alive, honest-ish */
      shown = Math.min(shown, target + 4, 99);  /* never claim what we lack */
    }
    if (target >= 100) shown = Math.min(100, shown + 0.36);
    /* Speed limit, and the single number that sets how long a warm boot is
       visible. Nothing else here is binding on a fast connection: the
       milestones all land inside the first few hundred ms, so the climb from
       0 to 100 is 100/LIMIT frames whatever the network did.
         0.72 -> ~2.3s   0.44 -> ~3.8s
       At 0.44 the six stage captions each get about 600ms, which is roughly
       the floor for reading three words, and the statement's ink has time to
       print rather than flash. */
    if (shown - prev > 0.44) shown = prev + 0.44;
    paint(shown);
    if (shown >= 100 && target >= 100) { exit(); return; }
    requestAnimationFrame(frame);
  }

  /* ==========================================================================
     THE HANDOFF
     ========================================================================== */
  function exit() {
    if (exited) return;
    var elapsed = performance.now() - started;
    if (elapsed < MIN_SHOWTIME_MS) {
      window.setTimeout(exit, MIN_SHOWTIME_MS - elapsed);
      return;
    }
    exited = true;
    debug.exited = true;
    paint(100);

    /* 1. release the chrome arrival choreography (workspace-loader.css gate) */
    document.body.classList.add('ws-intro-go');

    /* 2. let go of the veil — a straight crossfade now that there is no
          surface to come apart */
    window.setTimeout(function () {
      loader.classList.add('is-exiting');
    }, reduceMotion ? 40 : 120);

    /* 3. the workspace is legible before the veil has finished clearing —
          anything that wants to present itself over a settled workspace
          (inspire.js and its auto-open) waits on this rather than a guess. */
    window.setTimeout(function () {
      try {
        document.dispatchEvent(new CustomEvent('timrx:workspace-revealed'));
      } catch (err) { /* decorative — never fatal */ }
      document.body.classList.add('ws-revealed');
    }, reduceMotion ? 320 : 900);

    /* 4. and only then take the node out */
    window.setTimeout(function () {
      loader.hidden = true;
      loader.setAttribute('aria-hidden', 'true');
    }, reduceMotion ? 340 : 1150);
  }

  /* ----- milestones ------------------------------------------------------ */

  if (document.readyState !== 'loading') reach(24);
  else document.addEventListener('DOMContentLoaded', function () { reach(24); }, { once: true });

  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () { reach(44); });
    window.setTimeout(function () { reach(44); }, 2500);
  } else {
    reach(44);
  }

  /* brain milestone removed with the neural background — reach it directly */
  reach(68);

  if (document.readyState === 'complete') { debug.loadFired = true; reach(100); }
  else window.addEventListener('load', function () { debug.loadFired = true; reach(100); }, { once: true });

  /* hard cap — the workspace must open no matter what failed to load */
  window.setTimeout(function () { reach(100); target = 100; }, HARD_CAP_MS);

  paint(0);
  requestAnimationFrame(frame);
})();
