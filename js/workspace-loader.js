/* ==========================================================================
   WORKSPACE LOADER — milestone-driven boot progress + intro handoff
   --------------------------------------------------------------------------
   The old loader animated a clock: 8% → 94% over 2.1s no matter what the
   page was doing, then faded out over a scene that was already running.

   This one reports the boot that is actually happening, then conducts the
   handoff:

     milestones   document interactive .......... 24%
                  fonts ready ................... 44%
                  (brain milestone removed 2026-08-11) . 68%   (immediate)
                  window load (assets) .......... 100%
     display      eased toward the live target with a gentle trickle, so the
                  bar keeps breathing between milestones and never lies at 94.
     handoff      at 100%: body.ws-intro-go releases the chrome arrival
                  animations (gated in workspace-loader.css), the neural
                  background gets wake() for its birth ramp, and the veil
                  opens from the centre.

   Failsafes: every milestone has a timeout; a hard cap guarantees the loader
   can never trap the page. Reduced motion skips the choreography.
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
  var MIN_SHOWTIME_MS = reduceMotion ? 0 : 2800;  /* let the mark + stages breathe */

  var started = performance.now();
  var target = 6;
  var shown = 0;
  var done = false;
  var exited = false;

  var debug = { target: 0, shown: 0, exited: false, loadFired: false, frames: 0 };
  window.__wsLoaderDebug = debug;

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
    loader.style.setProperty('--loader-progress', progress + '%');
    if (bar) bar.style.width = progress + '%';
    if (percentEl) percentEl.textContent = String(Math.round(progress)).padStart(2, '0') + '%';
    setStatus(progress);
  }

  function reach(value) {
    if (value > target) target = value;
    maybeFinish();
  }

  /* ----- display loop: ease toward target, trickle while waiting -------- */
  function frame() {
    if (exited) return;
    debug.target = target; debug.shown = shown; debug.frames++;
    var prev = shown;
    var gap = target - shown;
    shown += gap * 0.05;                        /* ease toward the milestone */
    if (gap < 6 && target < 100) {
      shown += 0.014;                           /* trickle: alive, honest-ish */
      shown = Math.min(shown, target + 4, 99);  /* never claim what we lack */
    }
    if (target >= 100) shown = Math.min(100, shown + 0.9);
    /* speed limit: even on an instant boot the bar crosses the stages at a
       readable pace instead of teleporting past the narration */
    if (shown - prev > 1.05) shown = prev + 1.05;
    paint(shown);
    if (shown >= 100 && target >= 100) { exit(); return; }
    requestAnimationFrame(frame);
  }

  function maybeFinish() { /* exit is driven from frame() when shown hits 100 */ }

  /* ----- the handoff ---------------------------------------------------- */
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

    /* 2. wake the neural background — its birth ramp runs while the veil
          opens, so the reveal and the scene are one movement */
    try {
      /* neural background removed 2026-08-11 — nothing to wake */
    } catch (err) { /* decorative — never fatal */ }

    /* 3. open the veil */
    window.setTimeout(function () {
      loader.classList.add('is-exiting');
    }, reduceMotion ? 40 : 200);

    window.setTimeout(function () {
      loader.hidden = true;
      loader.setAttribute('aria-hidden', 'true');

      /* The veil is gone and the neural background's birth ramp (2.1s from the
         wake above) has run alongside it. Anything that wants to present
         itself over a settled workspace — inspire.js and its auto-open — waits
         on this instead of guessing with a timer. */
      try {
        document.dispatchEvent(new CustomEvent('timrx:workspace-revealed'));
      } catch (err) { /* decorative — never fatal */ }
      document.body.classList.add('ws-revealed');
    }, reduceMotion ? 320 : 1300);
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
