/* =============================================================================
   HERO SEQUENCE — the workspace introduces itself
   -----------------------------------------------------------------------------
   A holographic line types itself in the centre of the field, and the floating
   assets are pushed aside by it as if the text had mass. When the line finishes
   the cards drift back. Every ~24s the field "thinks": a pulse leaves the
   centre and the cards lean away from it.

   How it stays at 60fps with dozens of cards:

   · ONE rAF loop for everything — typing, springs, pulse.
   · The loop writes only custom properties (--hx/--hy/--hr/--hs) on each slot.
     asset-stage.css composes those into the same transform that already
     carries the pointer parallax, so nothing here reads layout and nothing
     fights the existing field.
   · Card geometry is measured ONCE per layout change, never per frame.
   · Springs are integrated, not tweened: each card has velocity and mass, so
     motion has inertia and overshoot instead of easing between two poses.
   · The loop parks itself when the sequence is idle and every card has settled.
   ========================================================================== */
(function () {
  'use strict';

  var LINES = [
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
    'One thought. Infinite forms.'
  ];

  var CFG = {
    CHAR_MS      : 58,      // per character
    HOLD_MS      : 2600,    // keep the thought present without a long dead pause
    FORCE_RADIUS : 460,     // px — how far the text's push reaches
    FORCE_MAX    : 190,     // px — displacement at the very centre
    SPRING_K     : 0.048,   // stiffness per normalized frame
    DAMPING      : 0.89,    // 1 = frictionless
    PULSE_MS     : 18000,
    SETTLE_EPS   : 0.12     // px — below this a card counts as parked
  };

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  var stage, host, lineEl, pulseEl, particleEl, thoughtEngine;
  var cards = [];           // { el, cx, cy, x, y, vx, vy, r, vr }
  var origin = { x: 0, y: 0 };
  var force = 0;            // 0..1 — how much push the text is exerting
  var forceTarget = 0;
  var rafId = null, running = false, lastFrame = 0;
  var typeTimer = null, pulseTimer = null, releaseTimer = null, surpriseTimer = null;
  var cycleTimer = null, engineTimer = null;
  var destroyed = false, measured = false, scrollDismissed = false;
  var lastLineIndex = -1;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function compactViewport() { return window.matchMedia('(max-width: 1000px)').matches; }

  // ---------------------------------------------------------------- geometry
  /* Measured on mount and on resize only. Reading getBoundingClientRect in the
     loop would be a layout read per card per frame — the exact thing that
     turns a field like this into 20fps. */
  /* Only the centre zone is pushed.
     The stage groups its assets now: videos run in a film strip on one rail and
     images sit in a contact sheet on the other, both of them deliberate
     compositions. Shoving those aside with the text force would undo the
     organisation the grouping exists to create — so the thought engine moves
     the model field and nothing else. asset-stage.js tags every slot with
     data-af-zone; "core" is the model scatter in the middle. */
  var CORE_SLOTS = '.af__slot[data-af-zone="core"]';

  function coreSlots(scope) {
    if (!scope) return [];
    var found = scope.querySelectorAll(CORE_SLOTS);
    // Older markup (or a stage that has not rebuilt yet) has no zone tags —
    // fall back to every slot so the sequence still has something to move.
    return found.length ? found : scope.querySelectorAll('.af__slot');
  }

  function measure() {
    if (!stage) return;
    var host = $('.ws-stage__field', stage) || stage;
    var slots = coreSlots(host);
    var sr = stage.getBoundingClientRect();
    origin.x = sr.width / 2;
    origin.y = sr.height / 2;

    cards = Array.prototype.map.call(slots, function (el) {
      var r = el.getBoundingClientRect();
      return {
        el: el,
        cx: r.left - sr.left + r.width / 2,
        cy: r.top - sr.top + r.height / 2,
        x: 0, y: 0, vx: 0, vy: 0, r: 0, vr: 0,
        // Farther cards have more mass and move less, which is what sells the
        // depth: the near tier reacts, the far tier barely stirs.
        mass: 0.55 + (parseFloat(getComputedStyle(el).getPropertyValue('--par')) || 0.5) * 0.9
      };
    });
    measured = cards.length > 0;
  }

  // ------------------------------------------------------------------ physics
  function step(now) {
    var frame = Math.min(2.2, Math.max(.5, (now - (lastFrame || now)) / 16.667));
    lastFrame = now;
    var spring = 1 - Math.pow(1 - CFG.SPRING_K, frame);
    var damping = Math.pow(CFG.DAMPING, frame);
    var settled = true;

    /* The asset stage rebuilds its field asynchronously from the feed and again
       on resize, replacing every .af__slot. Cards measured before a rebuild are
       detached nodes — writing to them is silently a no-op, which is exactly
       how this first shipped: the line typed, the springs ran, and not a single
       card moved. Re-measure whenever the set we hold has gone stale. */
    if (!cards.length || !cards[0].el.isConnected ||
        cards.length !== (stage ? coreSlots(stage).length : 0)) {
      measure();
      if (!cards.length) return true;
    }

    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];

      // Vector from the text's centre to this card.
      var dx = c.cx - origin.x;
      var dy = c.cy - origin.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;

      // Falloff: full push at the centre, nothing past FORCE_RADIUS. Squared
      // so the drop-off feels magnetic rather than linear.
      var fall = Math.max(0, 1 - dist / CFG.FORCE_RADIUS);
      fall *= fall;

      var push = CFG.FORCE_MAX * fall * force * c.mass;
      var tx = (dx / dist) * push;
      var ty = (dy / dist) * push * 0.72;      // flatter vertically: the line is wide
      var tr = (dx / dist) * fall * force * 5; // lean away, a few degrees

      // Integrate toward the target rather than tweening to it — this is where
      // the inertia and the slight overshoot come from.
      c.vx = (c.vx + (tx - c.x) * spring) * damping;
      c.vy = (c.vy + (ty - c.y) * spring) * damping;
      c.vr = (c.vr + (tr - c.r) * spring) * damping;
      c.x += c.vx * frame; c.y += c.vy * frame; c.r += c.vr * frame;

      if (Math.abs(c.vx) > CFG.SETTLE_EPS || Math.abs(c.vy) > CFG.SETTLE_EPS ||
          Math.abs(c.x)  > CFG.SETTLE_EPS || Math.abs(c.y)  > CFG.SETTLE_EPS) {
        settled = false;
      }

      var st = c.el.style;
      st.setProperty('--hx', c.x.toFixed(2) + 'px');
      st.setProperty('--hy', c.y.toFixed(2) + 'px');
      st.setProperty('--hr', c.r.toFixed(2) + 'deg');
      // Pushed cards drift a touch toward the camera, so the gap reads as depth
      // rather than as a hole.
      st.setProperty('--hs', (1 + fall * force * 0.06).toFixed(3));
    }

    force += (forceTarget - force) * (1 - Math.pow(1 - .07, frame));
    if (Math.abs(forceTarget - force) > 0.004) settled = false;

    return settled;
  }

  function loop(now) {
    if (destroyed) return;
    var settled = step(now);
    if (settled && forceTarget === 0) { running = false; rafId = null; return; }
    rafId = requestAnimationFrame(loop);
  }

  function wake() {
    if (running || destroyed) return;
    running = true;
    lastFrame = 0;
    rafId = requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------- typing
  function typeLine(text, done) {
    if (stage) stage.classList.add('is-thought-focus');
    lineEl.textContent = '';
    lineEl.classList.remove('is-out', 'is-complete');
    if (particleEl) particleEl.textContent = '';
    if (thoughtEngine) {
      thoughtEngine.setState('thinking');
      thoughtEngine.setProgress(0);
    }
    var i = 0;

    (function next() {
      if (destroyed) return;
      if (i >= text.length) {
        lineEl.classList.add('is-complete');
        done && done();
        return;
      }
      var ch = text[i++];
      var span = document.createElement('span');
      span.className = 'hero-ch';
      // A space still needs to occupy width, but must not glow.
      if (ch === ' ') { span.classList.add('is-space'); span.innerHTML = '&nbsp;'; }
      else span.textContent = ch;
      // Each glyph overshoots slightly before settling — staggered by index so
      // the line lands as a wave rather than all at once.
      span.style.setProperty('--i', String(i));
      lineEl.appendChild(span);

      /* Short-lived compositor particles make the line feel projected into
         the field. They never participate in layout or the card physics. */
      if (particleEl && ch !== ' ') {
        var burst = document.createElement('i');
        var angle = Math.random() * Math.PI * 2;
        var distance = 18 + Math.random() * 54;
        burst.className = 'hero-seq__particle';
        burst.style.setProperty('--px', (Math.cos(angle) * distance).toFixed(1) + 'px');
        burst.style.setProperty('--py', (Math.sin(angle) * distance * .62).toFixed(1) + 'px');
        burst.style.setProperty('--ps', (1 + Math.random() * 2.5).toFixed(1) + 'px');
        burst.style.setProperty('--pd', Math.min(180, i * 8) + 'ms');
        particleEl.appendChild(burst);
        setTimeout(function () { if (burst.parentNode) burst.remove(); }, 1300);
      }

      // Every character adds a little more push; spaces add a small word pulse.
      var wordProgress = i / Math.max(8, text.length * 0.7);
      forceTarget = Math.min(1, wordProgress + (ch === ' ' ? .08 : 0));
      if (thoughtEngine) {
        thoughtEngine.setProgress(wordProgress);
        if (ch === ' ') thoughtEngine.pulse();
      }
      wake();

      typeTimer = setTimeout(next, CFG.CHAR_MS + (ch === ' ' ? 40 : 0));
    })();
  }

  function runSequence() {
    if (destroyed || !lineEl) return;
    clearTimeout(cycleTimer);
    var lineIndex = Math.floor(Math.random() * LINES.length);
    if (LINES.length > 1 && lineIndex === lastLineIndex) {
      lineIndex = (lineIndex + 1) % LINES.length;
    }
    lastLineIndex = lineIndex;
    var text = LINES[lineIndex];

    if (reduce.matches) {
      // No typing, no push — the line simply states itself.
      lineEl.textContent = text;
      lineEl.classList.add('is-complete');
      if (thoughtEngine) thoughtEngine.setState('idle');
      return;
    }

    typeLine(text, function () {
      releaseTimer = setTimeout(function () {
        // Cards drift back; the line dissolves.
        forceTarget = 0;
        wake();
        if (stage) stage.classList.remove('is-thought-focus');
        if (thoughtEngine) {
          thoughtEngine.setState('returning');
          thoughtEngine.setProgress(0);
          clearTimeout(engineTimer);
          engineTimer = setTimeout(function () {
            if (!destroyed && thoughtEngine) thoughtEngine.setState('idle');
          }, 1300);
        }
        if (compactViewport()) {
          // Keep a phrase present on compact screens. The next typing pass
          // replaces it directly instead of fading to an empty centre first.
          cycleTimer = setTimeout(runSequence, 80);
        } else {
          lineEl.classList.add('is-out');
          cycleTimer = setTimeout(runSequence, 2300);
        }
      }, compactViewport() ? 4200 : CFG.HOLD_MS);
    });
  }

  // -------------------------------------------------------------------- pulse
  /* "The workspace thinks." A wave leaves the centre and the cards lean out of
     its way, far more gently than the typing push. */
  function pulse() {
    if (destroyed || reduce.matches) return;
    if (thoughtEngine) {
      thoughtEngine.setState('thinking');
      thoughtEngine.pulse();
    }
    pulseEl.classList.remove('is-on');
    void pulseEl.offsetWidth;
    pulseEl.classList.add('is-on');

    forceTarget = 0.34;
    wake();
    setTimeout(function () {
      forceTarget = 0; wake();
      if (!destroyed && thoughtEngine) thoughtEngine.setState('idle');
    }, 900);
  }

  /* Rare, quiet discovery: one real asset briefly catches the projector's
     attention. It is deliberately independent of the hero text so it never
     competes with the first-run message. */
  function surprise() {
    if (destroyed || reduce.matches || !stage) return;
    var candidates = stage.querySelectorAll('.af__slot:not(.is-hero)');
    if (!candidates.length) return;
    var card = candidates[Math.floor(Math.random() * candidates.length)];
    card.classList.remove('is-awake');
    void card.offsetWidth;
    card.classList.add('is-awake');
    setTimeout(function () { if (card.isConnected) card.classList.remove('is-awake'); }, 2100);
  }

  function scheduleSurprise() {
    clearTimeout(surpriseTimer);
    if (destroyed || reduce.matches) return;
    surpriseTimer = setTimeout(function () {
      surprise();
      scheduleSurprise();
    }, 18000 + Math.random() * 12000);
  }

  // ------------------------------------------------------------------- teardown
  /* The intro sequence belongs to the untouched workspace. The persistent
     engine remains on the stage, while the sentence layer gets out of the way
     as soon as the user starts working. */
  function removeIntentListeners() {
    window.removeEventListener('pointerdown', onIntent);
    window.removeEventListener('keydown', onIntent);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('timrx:asset-stage-view', onAssetView);
  }

  function dismiss(reason) {
    if (destroyed) return;
    destroyed = true;
    scrollDismissed = reason === 'scroll';
    removeIntentListeners();
    clearTimeout(typeTimer); clearTimeout(releaseTimer); clearInterval(pulseTimer);
    clearTimeout(surpriseTimer);
    clearTimeout(cycleTimer); clearTimeout(engineTimer);
    if (stage) stage.classList.remove('is-thought-focus');
    if (rafId) cancelAnimationFrame(rafId);
    if (host) {
      host.classList.toggle('is-scroll-out', scrollDismissed);
      host.classList.add('is-gone');
    }
    if (thoughtEngine) {
      thoughtEngine.setState('idle');
      thoughtEngine.setProgress(0);
    }
    // Release every card in one pass so nothing is left displaced.
    cards.forEach(function (c) {
      var st = c.el.style;
      st.setProperty('--hx', '0px'); st.setProperty('--hy', '0px');
      st.setProperty('--hr', '0deg'); st.setProperty('--hs', '1');
    });
    setTimeout(function () { if (host && host.parentNode) host.remove(); }, 700);
  }

  // --------------------------------------------------------------------- mount
  function mount() {
    stage = $('.ws-stage');
    if (!stage) return;

    if (window.TimrXThoughtEngine && typeof window.TimrXThoughtEngine.mount === 'function') {
      thoughtEngine = window.TimrXThoughtEngine.mount(stage);
    }

    host = document.createElement('div');
    host.className = 'hero-seq';
    host.setAttribute('aria-hidden', 'true');   // decorative; the h1 already names the page
    host.innerHTML =
      '<span class="hero-seq__pulse"></span>' +
      '<span class="hero-seq__particles" aria-hidden="true"></span>' +
      '<p class="hero-seq__line"></p>';
    stage.appendChild(host);

    lineEl = $('.hero-seq__line', host);
    pulseEl = $('.hero-seq__pulse', host);
    particleEl = $('.hero-seq__particles', host);

    measure();
    if (!measured) {
      // The field builds asynchronously from the feed; wait for its first cards.
      var tries = 0;
      var poll = setInterval(function () {
        measure();
        if (measured || ++tries > 40) {
          clearInterval(poll);
          if (measured) start();
        }
      }, 150);
      return;
    }
    start();
  }

  function start() {
    setTimeout(runSequence, 900);        // let the chrome arrive first
    pulseTimer = setInterval(pulse, CFG.PULSE_MS);
    scheduleSurprise();

    var rz;
    window.addEventListener('resize', function () {
      clearTimeout(rz);
      rz = setTimeout(function () { measure(); wake(); }, 200);
    }, { passive: true });

    ['pointerdown', 'keydown'].forEach(function (ev) {
      window.addEventListener(ev, onIntent, { passive: true, once: false });
    });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('timrx:asset-stage-view', onAssetView);
  }

  function onIntent(e) {
    // Scrolling, or reaching for any real control, ends the sequence.
    if (e.type === 'keydown' && ['Shift', 'Alt', 'Control', 'Meta'].indexOf(e.key) > -1) return;
    if (e.type === 'pointerdown' && e.target.closest &&
        e.target.closest('.af__card')) return;          // browsing the field is not intent
    // A casual touch used to destroy the whole introduction on phones and
    // tablets. Only an actual interactive control should end it there; taps
    // and swipes on the ambient stage keep the thought engine alive.
    if (e.type === 'pointerdown' && compactViewport() && e.target.closest &&
        !e.target.closest('.ws-cmd-trigger,.ws-corner-launcher,.ws-prompt-guide-launcher')) return;
    dismiss();
    removeIntentListeners();
  }

  function onWheel(e) {
    if (compactViewport()) return;
    if (e && Math.abs(e.deltaY || 0) < 3) return;
    dismiss('scroll');
  }

  function onScroll() {
    if (compactViewport()) return;
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    if (y < 18) return;
    dismiss('scroll');
  }

  function onAssetView() {
    dismiss();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  window.TimrXHero = { dismiss: dismiss, pulse: pulse, replay: runSequence };
})();
