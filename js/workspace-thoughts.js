/* ==========================================================================
   WORKSPACE THOUGHTS — the intelligence speaks
   --------------------------------------------------------------------------
   The twelve lines below are the workspace's original voice: they used to
   type themselves at the centre of the old asset field (hero-sequence.js,
   retired with the stage rewrite). This module brings them back as neural
   transmissions in the quiet band between the header and the showcase row.

   Choreography per line:
     1. the neural brain fires a real synapse pulse (brain.trigger()) — the
        thought visibly originates from the intelligence behind the models,
     2. characters decode left→right: each one churns through glyph noise
        for a few ticks, then locks into place,
     3. a hairline draws itself under the text with a travelling glow dot,
     4. the line holds, then dissolves character by character, and the next
        transmission begins.

   It parks itself whenever another surface owns the screen (panel, palette,
   viewer, expanded views), waits for the intro handoff (body.ws-intro-go)
   before the first line, respects prefers-reduced-motion (plain crossfade,
   no churn), and stops entirely while the tab is hidden.
   ========================================================================== */
(function () {
  'use strict';

  var LINES = [
    /* the original workspace voice (hero-sequence.js, retired stage) */
    'Create anything.',
    'Turn ideas into reality.',
    'Describe. Generate. Build.',
    'Images. Models. Video.',
    'From imagination to production.',
    'Create once. Export anywhere.',
    'Imagine. Build. Share.',
    'Make the invisible visible.',
    'Think beyond the frame.',
    'Shape the next idea.',
    'Make. Refine. Repeat.',
    'One thought. Infinite forms.',
    /* platform lines — what this workspace actually does */
    'Text to 3D. Image to 3D.',
    'Remesh. Retexture. Rig. Animate.',
    'Prompt to print-ready STL.',
    'Your next asset is one sentence away.',
    'Generate. Inspect. Ship.'
  ];

  var GLYPHS = '▚▞▓▒░╱╲<>+=/#%&';
  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DECODE_STAGGER = 34;     /* ms between characters starting to churn */
  var CHURN_TICK = 46;         /* ms between glyph swaps while churning */
  var CHURN_TICKS = 5;         /* swaps before a character locks in */
  var HOLD_MS = 6400;
  var LEAVE_MS = 640;
  var GAP_MS = 900;

  var root = null;
  var lineEl = null;
  var lastIndex = -1;
  var timers = [];
  var running = false;

  function later(fn, ms) { timers.push(window.setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(window.clearTimeout); timers = []; }

  function gated() {
    var c = document.body.classList;
    return c.contains('ws-viewer-open') || c.contains('ws-panel-open') ||
           c.contains('ws-cmd-open') || c.contains('assets-modal-open') ||
           c.contains('history-expanded') || c.contains('tutorials-view') ||
           c.contains('community-view') || c.contains('docs-view');
  }

  function pulseBrain() {
    try {
      var bg = window.timrxNeuralBrainBackground;
      if (bg && bg.brain && typeof bg.brain.trigger === 'function') bg.brain.trigger();
    } catch (err) { /* decorative */ }
  }

  function build() {
    root = document.createElement('div');
    root.className = 'ws-thoughts';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<span class="ws-thoughts__eyebrow">Neural feed</span>' +
      '<span class="ws-thoughts__line" data-thoughts-line></span>' +
      '<span class="ws-thoughts__rule"><i class="ws-thoughts__spark"></i></span>';
    document.body.appendChild(root);
    lineEl = root.querySelector('[data-thoughts-line]');
  }

  function randomGlyph() {
    return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  }

  function nextLine() {
    var index = Math.floor(Math.random() * LINES.length);
    if (LINES.length > 1 && index === lastIndex) index = (index + 1) % LINES.length;
    lastIndex = index;
    return LINES[index];
  }

  function showLine(text, done) {
    lineEl.textContent = '';
    root.classList.add('is-live');
    root.classList.remove('is-leaving');
    pulseBrain();

    var spans = [];
    for (var i = 0; i < text.length; i++) {
      var span = document.createElement('span');
      span.className = 'ws-thoughts__ch';
      if (text[i] === ' ') { span.textContent = ' '; span.classList.add('is-set'); }
      spans.push(span);
      lineEl.appendChild(span);
    }

    if (REDUCE) {
      spans.forEach(function (span, k) {
        if (!span.classList.contains('is-set')) span.textContent = text[k];
        span.classList.add('is-set');
      });
      later(done, HOLD_MS);
      return;
    }

    var pending = 0;
    spans.forEach(function (span, k) {
      if (span.classList.contains('is-set')) return;
      pending++;
      later(function () {
        span.classList.add('is-churning');
        var tick = 0;
        var churn = window.setInterval(function () {
          tick++;
          if (tick >= CHURN_TICKS) {
            window.clearInterval(churn);
            span.textContent = text[k];
            span.classList.remove('is-churning');
            span.classList.add('is-set');
            pending--;
            if (pending === 0) later(leave, HOLD_MS);
            return;
          }
          span.textContent = randomGlyph();
        }, CHURN_TICK);
        timers.push(churn); /* clearTimeout on an interval id is harmless-ish; also clear explicitly */
      }, k * DECODE_STAGGER);
    });

    function leave() {
      root.classList.add('is-leaving');
      later(done, LEAVE_MS);
    }

    if (pending === 0) later(function () { root.classList.add('is-leaving'); later(done, LEAVE_MS); }, HOLD_MS);
  }

  function cycle() {
    if (!running) return;
    if (document.hidden || gated()) {
      root.classList.remove('is-live');
      later(cycle, 1600);
      return;
    }
    showLine(nextLine(), function () {
      root.classList.remove('is-live', 'is-leaving');
      later(cycle, GAP_MS);
    });
  }

  function start() {
    if (running) return;
    running = true;
    later(cycle, 1400); /* let the chrome arrival finish its stagger first */
  }

  function init() {
    if (!document.getElementById('wsStage')) return;  /* workspace page only */
    build();

    /* Begin with the intro handoff when it happens, but never depend on it:
       whichever comes first — ws-intro-go or a short grace delay — starts
       the feed. */
    var seen = false;
    var go = function () {
      if (seen) return;
      seen = true;
      try { observer.disconnect(); } catch (e) { /* not observing */ }
      start();
    };
    var observer = new MutationObserver(function () {
      if (document.body.classList.contains('ws-intro-go')) go();
    });
    if (document.body.classList.contains('ws-intro-go')) {
      go();
    } else {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      window.setTimeout(go, 5000);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimers(); root.classList.remove('is-live', 'is-leaving'); later(cycle, 800); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
