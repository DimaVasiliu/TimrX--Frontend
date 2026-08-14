/* ==========================================================================
   WORKSPACE LOADER — milestone-driven boot progress + the break
   --------------------------------------------------------------------------
   Two jobs, kept separate:

   1. PROGRESS. Report the boot that is actually happening.

        milestones   document interactive .......... 24%
                     fonts ready ................... 44%
                     (brain milestone removed 2026-08-11) . 68%   (immediate)
                     window load (assets) .......... 100%
        display      eased toward the live target with a gentle trickle, so the
                     bar keeps breathing between milestones and never lies at 94.
        handoff      at 100%: body.ws-intro-go releases the chrome arrival
                     animations (gated in workspace-loader.css) and the veil
                     comes apart.

      Failsafes: every milestone has a timeout; a hard cap guarantees the loader
      can never trap the page.

   2. THE BREAK. The veil is not a picture of a broken screen, it is a surface
      that breaks. This file tessellates it into fragments, draws the crack
      network that separates them, and hands both to CSS keyed off one class.

        buildGlass()   polar tessellation anchored on the impact point:
                       radial spokes that wander as they travel, crossed by
                       concentric rings that are deliberately discontinuous
                       (real circumferential cracks never close). Fragments
                       merge across missing ring segments, so cells grow with
                       distance the way they actually do. Every cell reads its
                       corners out of one shared vertex table, so the pieces
                       tile the viewport exactly — no seams, no overlaps.
        detonate()     fires on the `animationend` of the X's fall, NOT on a
                       timer, so the damage can never drift away from — or
                       arrive ahead of — the letter that caused it.

      Two radii, and the difference between them matters. The tessellation
      covers the WHOLE viewport, because the surface has to be able to come
      apart on the way out. The visible damage — cracks, facets, displacement —
      is confined to `crackR` around the hit: a small impact star. Drawing the
      crack network across the whole screen stops reading as an impact and
      starts reading as a spider web laid over the page.

      Skipped entirely under prefers-reduced-motion, and on failure the veil
      falls back to the old crossfade — the boot is never blocked on decoration.
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
  var MIN_SHOWTIME_MS = reduceMotion ? 0 : 2800;  /* let the mark + break breathe */

  var started = performance.now();
  var target = 6;
  var shown = 0;
  var exited = false;

  var debug = { target: 0, shown: 0, exited: false, loadFired: false, frames: 0 };
  window.__wsLoaderDebug = debug;

  /* ==========================================================================
     IMPACT ANCHOR
     --------------------------------------------------------------------------
     Everything about the break originates where the falling X hits. That point
     depends on the type size, which is a clamp() across the viewport, so it
     cannot be expressed as a fixed percentage — measure the glyph and hand the
     value to CSS. The X is parked above the viewport until it is released, so
     its own top is useless: take the vertical baseline from the wordmark, which
     is already laid out, and the horizontal position from the X's column
     (transforms do not move an inline-block's layout box, so its left/width are
     correct even mid-fall).
     ========================================================================== */
  var brandEl = loader.querySelector('.workspace-loader__brand');
  var glyphX = loader.querySelector('.workspace-loader__glyph--x');
  var impact = { x: 0, y: 0 };

  function placeImpact() {
    if (!brandEl) return;
    var ref = brandEl.getBoundingClientRect();
    if (!ref.height) return;
    var col = glyphX ? glyphX.getBoundingClientRect() : null;
    impact.y = Math.round(ref.bottom - ref.height * 0.12);
    impact.x = Math.round(col && col.width ? col.left + col.width / 2
                                           : ref.left + ref.width * 0.86);
    loader.style.setProperty('--impact-x', impact.x + 'px');
    loader.style.setProperty('--impact-y', impact.y + 'px');
  }
  placeImpact();

  /* ==========================================================================
     THE GLASS
     ========================================================================== */
  var TAU = Math.PI * 2;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var armed = false;
  var blown = false;

  /* Seeded so a bad-looking draw is reproducible from __wsLoaderDebug.seed. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function polylineLength(pts) {
    var total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return total;
  }

  function buildGlass(cx, cy) {
    var shardHost = loader.querySelector('[data-shards]');
    var svg = loader.querySelector('[data-fracture]');
    var spallHost = loader.querySelector('[data-spall]');
    var crushEl = loader.querySelector('[data-crush]');
    if (!shardHost || !svg) return false;

    var W = window.innerWidth;
    var H = window.innerHeight;
    if (W < 200 || H < 200) return false;

    var seed = (Math.random() * 0xffffffff) >>> 0;
    var rand = mulberry32(seed);
    debug.seed = seed;

    /* Fragment count is the whole cost of this effect. Phones and low-core
       machines get a coarser break rather than a dropped frame at the moment
       the entire thing is meant to land. */
    var lean = W < 760 || (navigator.hardwareConcurrency || 8) <= 4;
    var SECT = lean ? 9 : 13;
    /* Ring spacing. Growth much above ~1.6 leaves the outermost band spanning
       half the field, and those fragments are big enough to read as panes of
       smoked glass rather than as pieces of a screen. */
    var GROW = lean ? 2.0 : 1.60;

    var maxR = 0;
    [[0, 0], [W, 0], [0, H], [W, H]].forEach(function (c) {
      maxR = Math.max(maxR, Math.hypot(c[0] - cx, c[1] - cy));
    });
    /* Generous overhang: the outermost ring has to clear every corner even
       after the quake translates and rotates the whole field. */
    var fieldR = maxR * 1.14;
    var crushR = Math.max(11, Math.min(26, Math.min(W, H) * 0.021));

    /* How far the VISIBLE damage reaches. The tessellation still covers the
       whole viewport — it has to, or the surface could not come apart on exit —
       but the cracks, the facets and the displacement are all local to the hit.
       A crack network drawn across the entire screen stops reading as an impact
       and starts reading as a spider web laid over the page. */
    var crackR = Math.max(120, Math.min(250, Math.min(W, H) * 0.19));
    var localAt = function (dist) {
      return Math.max(0, Math.min(1, 1 - dist / (crackR * 1.35)));
    };

    /* ---- ring radii: geometric growth, jittered -------------------------- */
    var radii = [crushR];
    while (radii[radii.length - 1] < fieldR && radii.length < 14) {
      radii.push(radii[radii.length - 1] * (GROW + (rand() - 0.5) * 0.30));
    }
    radii[radii.length - 1] = fieldR;      /* the last ring must cover, always */
    var RINGS = radii.length;
    if (RINGS < 3) return false;

    /* ---- spokes: a base angle plus a slow wander outward ------------------
       A perfectly straight radial line is the single loudest tell that a crack
       was drawn rather than propagated. Each spoke drifts a little at every
       ring, bounded, so it meanders without ever crossing its neighbour. */
    var baseAngle = [];
    var wander = [];
    var i, k;
    for (i = 0; i < SECT; i++) {
      baseAngle.push(i * TAU / SECT + (rand() - 0.5) * (TAU / SECT) * 0.62);
      var walk = [0];
      var drift = 0;
      for (k = 1; k < RINGS; k++) {
        drift += (rand() - 0.5) * 0.055;
        drift = Math.max(-0.11, Math.min(0.11, drift));
        walk.push(drift);
      }
      wander.push(walk);
    }

    /* ---- the shared vertex table ----------------------------------------
       Every fragment reads its corners out of here, so adjacent pieces are
       guaranteed to agree on the edge between them. */
    var V = [];
    for (k = 0; k < RINGS; k++) {
      var row = [];
      for (i = 0; i < SECT; i++) {
        var r = k === RINGS - 1 ? radii[k] : radii[k] * (1 + (rand() - 0.5) * 0.17);
        var a = baseAngle[i] + wander[i][k];
        row.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      V.push(row);
    }
    var at = function (ring, sector) { return V[ring][(sector % SECT + SECT) % SECT]; };

    /* ---- which concentric cracks actually exist --------------------------
       Dense near the impact, sparse far out. Where a segment is missing the
       two fragments either side of it are one piece — which is why the cells
       get larger with distance without any extra machinery. */
    var ringSeg = [];
    for (k = 0; k < RINGS; k++) {
      var present = [];
      var p = Math.max(0.42, 0.95 - 0.09 * k);
      for (i = 0; i < SECT; i++) {
        present.push(k === 0 || k === RINGS - 1 ? true : rand() < p);
      }
      ringSeg.push(present);
    }

    /* ---- fragments -------------------------------------------------------- */
    var cells = [];
    for (i = 0; i < SECT; i++) {
      var band = 0;
      while (band <= RINGS - 2) {
        var end = band;
        while (end < RINGS - 2 && !ringSeg[end + 1][i]) end++;
        var pts = [];
        for (k = band; k <= end + 1; k++) pts.push(at(k, i));          /* out one spoke */
        for (k = end + 1; k >= band; k--) pts.push(at(k, i + 1));      /* back the next */
        cells.push(pts);
        band = end + 1;
      }
    }
    /* the crush zone: a ring of slivers right under the point of contact */
    for (i = 0; i < SECT; i++) {
      cells.push([{ x: cx, y: cy }, at(0, i), at(0, i + 1)]);
    }

    var frag = document.createDocumentFragment();
    cells.forEach(function (pts) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var sumX = 0, sumY = 0;
      pts.forEach(function (p) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        sumX += p.x; sumY += p.y;
      });
      minX = Math.floor(minX) - 1; minY = Math.floor(minY) - 1;
      maxX = Math.ceil(maxX) + 1;  maxY = Math.ceil(maxY) + 1;

      var ox = sumX / pts.length - cx;
      var oy = sumY / pts.length - cy;
      var dist = Math.hypot(ox, oy) || 1;
      var d = Math.min(1, dist / fieldR);          /* 0 at the hit, 1 at the edge */
      var nx = ox / dist, ny = oy / dist;

      var el = document.createElement('i');
      el.className = 'workspace-loader__shard';
      var s = el.style;

      /* Each fragment is only as big as its own bounding box, but its
         background is sized and offset to the viewport — so the pieces paint a
         fraction of the area a stack of full-screen layers would, and still
         line up into one uninterrupted image. */
      s.left = minX + 'px';
      s.top = minY + 'px';
      s.width = (maxX - minX) + 'px';
      s.height = (maxY - minY) + 'px';
      s.backgroundSize = W + 'px ' + H + 'px';
      s.backgroundPosition = (-minX) + 'px ' + (-minY) + 'px';
      s.clipPath = s.webkitClipPath = 'polygon(' + pts.map(function (p) {
        return (p.x - minX).toFixed(1) + 'px ' + (p.y - minY).toFixed(1) + 'px';
      }).join(',') + ')';

      /* The facet. After the break each piece sits at its own angle, so each
         one catches a different amount of light — and a mosaic of luminances
         is what separates glass from a drawing of glass.

         This has to be ADDITIVE, not a brightness filter. The veil is
         #07090a: multiplying that by 0.9..1.1 moves it by one value step and
         is invisible. A faint light wash laid over it at a per-fragment angle
         is not.

         Confined to the damaged area. Faceting the whole screen would say the
         whole screen broke, and it did not — a small crack did. The floor is
         not zero only so the pieces still have edges to catch light on when
         they finally come apart. */
      var near = localAt(dist);
      var facet = 0.10 + 0.90 * Math.pow(near, 1.3);
      s.setProperty('--sh-ang', Math.round(rand() * 360) + 'deg');
      s.setProperty('--sh-hi', ((0.004 + rand() * 0.020) * facet).toFixed(4));
      s.setProperty('--sh-lo', ((0.004 + rand() * 0.022) * facet).toFixed(4));

      /* Displacement is local too: only the pieces around the hit are actually
         knocked loose, and their residual offsets are the seams you see. */
      s.setProperty('--nx', nx.toFixed(3));
      s.setProperty('--ny', ny.toFixed(3));
      s.setProperty('--kick', (0.4 + 8 * near).toFixed(2) + 'px');
      s.setProperty('--rest', (0.05 + 2.2 * near).toFixed(2) + 'px');
      s.setProperty('--tilt', ((rand() - 0.5) * 2.8 * near).toFixed(2) + 'deg');
      s.setProperty('--hit-delay', Math.round((1 - near) * 90) + 'ms');

      /* Exit: each piece leaves along its OWN radius, far enough to clear the
         nearest edge, with gravity pulling the whole thing down as it goes.
         Staggered by distance, so the hole opens at the point the X hit and
         grows outward from there.

         Two things this cannot be, both learned the hard way:

         Not toward the viewer. At perspective 1400 a +800px translateZ scales
         a fragment 2.6x, so the near pieces balloon and the collapse occludes
         the workspace it exists to reveal.

         Not straight down. The field overhangs the viewport by 14% on every
         side so the quake can never expose an edge — which means a purely
         downward fall just drags the top overhang into frame and the screen
         stays covered the whole way. */
      s.setProperty('--fx', ((0.75 + rand() * 0.5) * maxR).toFixed(0) + 'px');
      s.setProperty('--fy', ((0.25 + rand() * 0.45) * H).toFixed(0) + 'px');
      s.setProperty('--fz', ((rand() * 220 - 70) * (1 - d * 0.5)).toFixed(0) + 'px');
      s.setProperty('--rx', (rand() * 2 - 1).toFixed(2));
      s.setProperty('--ry', (rand() * 2 - 1).toFixed(2));
      s.setProperty('--rz', (rand() * 2 - 1).toFixed(2));
      s.setProperty('--spin', (20 + rand() * 120).toFixed(0) + 'deg');
      s.setProperty('--fall-delay', Math.round(d * 320 + rand() * 80) + 'ms');

      frag.appendChild(el);
    });
    shardHost.appendChild(frag);
    shardHost.style.perspectiveOrigin = cx + 'px ' + cy + 'px';

    /* ---- the crack network ----------------------------------------------
       Same vertex table as the fragments, so the lines land exactly on the
       edges they separate. Drawn twice by the stylesheet — a dark stroke
       offset down-right under a bright one — which gives every crack a bevel
       instead of leaving it a hairline painted on the surface. */
    var PAD = 48;   /* the sheet overhangs so the quake cannot expose an edge */
    svg.setAttribute('viewBox', (-PAD) + ' ' + (-PAD) + ' ' + (W + PAD * 2) + ' ' + (H + PAD * 2));
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var gUnder = document.createElementNS(SVGNS, 'g');
    gUnder.setAttribute('class', 'workspace-loader__crack-under');
    var gLit = document.createElementNS(SVGNS, 'g');
    gLit.setAttribute('class', 'workspace-loader__crack-lit');

    /* A crack is not one line of one weight. It is widest and brightest where
       the energy went in and tapers to a hairline as it runs out of it, so
       every span is emitted as its own segment with its own width, opacity and
       arrival time. Drawing a spoke as a single path — which is what the old
       hand-authored sheet did — is exactly what made it read as a sunburst
       graphic instead of damage. */
    function addCrack(a, b, weight, delay) {
      var len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 3) return delay;
      var d = 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
              'L' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
      /* Tapered against the damage radius, not the viewport, so the star fades
         out into undamaged surface instead of stopping at a hard edge. */
      var taper = Math.pow(localAt(Math.hypot(a.x - cx, a.y - cy) + len * 0.5), 1.25);
      var width = (0.2 + 1.7 * taper) * weight;
      var opacity = (0.05 + 0.86 * taper) * weight;
      /* Cracks propagate at a roughly constant speed, so a long span takes
         longer to arrive than a short one — and the next span out cannot start
         until this one has got there. Uniform durations are what make a
         fracture look drawn all at once. The whole star is over inside ~180ms:
         it forms as the X lands, not afterwards. */
      var dur = Math.max(45, Math.min(150, len / 3.4));

      [gUnder, gLit].forEach(function (g, idx) {
        var path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('stroke-width', (width + (idx === 0 ? 0.7 : 0)).toFixed(2));
        path.setAttribute('stroke-opacity', (idx === 0 ? opacity * 0.75 : opacity).toFixed(3));
        path.style.strokeDasharray = len.toFixed(1);
        /* the keyframes retract the line by exactly its own length — a shared
           dash length would leave short cracks part-drawn on their first frame */
        path.style.setProperty('--len', len.toFixed(1));
        path.style.animationDuration = Math.round(dur) + 'ms';
        path.style.animationDelay = Math.round(delay) + 'ms';
        g.appendChild(path);
      });
      return delay + dur * 0.72;   /* the next span leaves before this one lands */
    }

    /* Every sector gets a radial, and the variety comes from how far each one
       runs — some are stubs a few pixels long, some reach the damage radius.
       Dropping whole sectors at random was the obvious way to get an uneven
       star and it is the wrong one: often enough the dropped sectors land next
       to each other and the star comes out lopsided, all arms to one side. */
    var spokeEnd = [];
    for (i = 0; i < SECT; i++) {
      var reach = crackR * (0.18 + rand() * 0.85);
      var stop = 0;
      while (stop < RINGS - 2 && radii[stop + 1] < reach) stop++;
      spokeEnd.push(stop);
    }

    for (i = 0; i < SECT; i++) {
      var t = addCrack({ x: cx, y: cy }, at(0, i), 1, 4 + rand() * 14);
      for (k = 0; k < spokeEnd[i]; k++) {
        t = addCrack(at(k, i), at(k + 1, i), 1, t);
      }
    }
    /* A couple of short concentric ties close in, and only where both radials
       either side of them actually exist. Ringing the whole star is what turned
       this into a web; two or three near the middle is what glass does. */
    for (k = 1; k < RINGS - 1; k++) {
      if (radii[k] > crackR * 0.62) break;
      for (i = 0; i < SECT; i++) {
        if (!ringSeg[k][i] || rand() < 0.45) continue;
        if (spokeEnd[i] < k || spokeEnd[(i + 1) % SECT] < k) continue;
        addCrack(at(k, i), at(k, i + 1), 0.66, 40 + k * 22 + rand() * 30);
      }
    }
    svg.appendChild(gUnder);
    svg.appendChild(gLit);

    /* ---- the crush zone ---------------------------------------------------
       Where the object actually struck, glass is not cracked, it is powdered.
       A plain white disc reads as a glow; a scatter of grit reads as damage. */
    if (crushEl) {
      var grit = [];
      for (i = 0; i < 16; i++) {
        var ga = rand() * TAU;
        var gr = Math.pow(rand(), 0.6) * 42;
        grit.push('radial-gradient(circle ' + (0.9 + rand() * 2.1).toFixed(1) + 'px at ' +
                  (50 + Math.cos(ga) * gr).toFixed(1) + '% ' +
                  (50 + Math.sin(ga) * gr).toFixed(1) + '%, ' +
                  'rgba(255,255,255,' + (0.5 + rand() * 0.45).toFixed(2) + '), transparent)');
      }
      grit.push('radial-gradient(circle, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.42) 24%, ' +
                'rgba(216,245,241,0.14) 52%, transparent 74%)');
      crushEl.style.backgroundImage = grit.join(',');
      crushEl.style.setProperty('--crush-size', Math.round(crushR * 3.4) + 'px');
    }

    /* ---- spall ------------------------------------------------------------
       Chips thrown clear of the impact. A couple of them are held back well
       past the break, because debris keeps dropping after the noise stops. */
    if (spallHost) {
      while (spallHost.firstChild) spallHost.removeChild(spallHost.firstChild);
      var chips = lean ? 10 : 18;
      var chipFrag = document.createDocumentFragment();
      for (i = 0; i < chips; i++) {
        var chip = document.createElement('i');
        var cs = chip.style;
        var ang = -Math.PI * 0.5 + (rand() - 0.5) * Math.PI * 1.45;  /* biased upward */
        var reach = 90 + rand() * 320;
        cs.setProperty('--sz', (1.6 + rand() * 3.2).toFixed(1) + 'px');
        cs.setProperty('--dx', (Math.cos(ang) * reach).toFixed(0) + 'px');
        cs.setProperty('--apex', (Math.sin(ang) * reach * 0.75).toFixed(0) + 'px');
        cs.setProperty('--dy', (120 + rand() * 0.55 * H).toFixed(0) + 'px');
        cs.setProperty('--rot', (rand() * 900 - 450).toFixed(0) + 'deg');
        cs.setProperty('--dur', (700 + rand() * 700).toFixed(0) + 'ms');
        cs.setProperty('--dly', (i > chips - 4 ? 700 + rand() * 900 : rand() * 90).toFixed(0) + 'ms');
        chipFrag.appendChild(chip);
      }
      spallHost.appendChild(chipFrag);
    }

    return true;
  }

  /* ---- arm, then detonate on the frame the X lands ----------------------- */
  function arm() {
    if (armed || reduceMotion) return;
    armed = true;
    placeImpact();                 /* re-measure now that the type has settled */
    try {
      if (buildGlass(impact.x, impact.y)) loader.classList.add('has-shatter');
    } catch (err) {
      /* decorative — a failed break must never cost anyone the workspace */
    }
  }

  function detonate() {
    if (blown) return;
    blown = true;
    if (loader.classList.contains('has-shatter')) loader.classList.add('is-broken');
  }

  if (!reduceMotion) {
    /* The wordmark's metrics move when the display face lands, and the impact
       point is measured off the wordmark — so build after the fonts resolve,
       with a cap well clear of the X's release. */
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { requestAnimationFrame(arm); });
    }
    window.setTimeout(arm, 420);

    /* The break is fired by the END OF THE FALL, not by a timer that happens to
       be set to the same number. The two are only equal when first paint is
       instant; when it is not — a slow font, a busy main thread, a restored
       background tab — a timer cracks the screen while the letter is still in
       the air. */
    if (glyphX) {
      glyphX.addEventListener('animationend', function (e) {
        if (e.animationName === 'wsLoaderXFall') detonate();
      });
    }

    /* Failsafe for the case where the fall never animated at all (no
       compositor, an engine that dropped the keyframes). It checks rather than
       assumes: while the fall is still running this reschedules itself, so it
       can never pre-empt the landing it exists to back up. */
    (function failsafe() {
      if (blown) return;
      var falling = false;
      if (glyphX && glyphX.getAnimations) {
        glyphX.getAnimations().forEach(function (a) {
          if (a.animationName === 'wsLoaderXFall' && a.playState === 'running') falling = true;
        });
      }
      if (falling) { window.setTimeout(failsafe, 180); return; }
      window.setTimeout(function () { if (!blown) detonate(); }, 1700);
    })();
  }

  window.addEventListener('resize', function () {
    if (armed) return;             /* after the field is built the geometry is fixed */
    placeImpact();
  }, { passive: true });

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
    shown += gap * 0.032;                       /* ease toward the milestone */
    if (gap < 6 && target < 100) {
      shown += 0.009;                           /* trickle: alive, honest-ish */
      shown = Math.min(shown, target + 4, 99);  /* never claim what we lack */
    }
    if (target >= 100) shown = Math.min(100, shown + 0.58);
    /* speed limit: even on an instant boot the bar crosses the stages at a
       readable pace instead of teleporting past the narration */
    if (shown - prev > 0.72) shown = prev + 0.72;
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

    var shattered = loader.classList.contains('has-shatter');

    /* 1. release the chrome arrival choreography (workspace-loader.css gate) */
    document.body.classList.add('ws-intro-go');

    /* 2. let go of the surface. With the veil tessellated this is not a
          crossfade: the veil stops painting and the fragments carry the image
          away with them, so the workspace is revealed through the gaps. */
    window.setTimeout(function () {
      loader.classList.add('is-exiting');
    }, reduceMotion ? 40 : 170);

    /* 3. the workspace is legible well before the last chip has fallen —
          anything that wants to present itself over a settled workspace
          (inspire.js and its auto-open) waits on this rather than a guess. */
    window.setTimeout(function () {
      try {
        document.dispatchEvent(new CustomEvent('timrx:workspace-revealed'));
      } catch (err) { /* decorative — never fatal */ }
      document.body.classList.add('ws-revealed');
    }, reduceMotion ? 320 : (shattered ? 1120 : 1300));

    /* 4. and only then take the node out */
    window.setTimeout(function () {
      loader.hidden = true;
      loader.setAttribute('aria-hidden', 'true');
    }, reduceMotion ? 340 : (shattered ? 1680 : 1320));
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
