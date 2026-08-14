/* ==========================================================================
   WORKSPACE LOADER — THE CLUSTER
   --------------------------------------------------------------------------
   Builds the six circles and the figurines between them, then does exactly
   two things for the rest of the boot: reveal each one as progress reaches it,
   and attach media once it has decoded. All motion is CSS.

   Deliberately decoupled from workspace-loader.js. It does not import it, is
   not imported by it, and touches none of its state. The only contract is the
   custom property the loader already publishes:

       loader.style.setProperty('--loader-progress', progress + '%')

   Read that and the cluster inherits the milestone easing, the trickle and
   the exit timing for free, with no chance of desynchronising from the number
   in the corner. Either file can be deleted without touching the other.

   This is decoration on a boot screen: if it throws, the workspace must still
   open. The build is wrapped and the failure mode is "no cluster", never
   "no workspace".

   MEDIA POLICY
   --------------------------------------------------------------------------
   The loader may never wait on a byte. Circles paint as geometry on the first
   frame. Everything else is requested at idle, at low fetch priority, and is
   only attached once decoded — so a slow asset can cause a missing circle,
   never a stalled frame or a layout shift. Skipped entirely on Save-Data and
   on 2G, where the whole cluster degrades to the three geometric circles.

   The clip is muted, inline and loops; autoplay is allowed to fail (some
   engines refuse it regardless of `muted`) and when it does the poster stays
   up and nothing else changes.
   ========================================================================== */
(function () {
  'use strict';

  var loader = document.getElementById('workspaceLoader');
  if (!loader) return;

  var host = loader.querySelector('.workspace-loader__scene') || loader;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var BASE = loader.getAttribute('data-grid-base') || 'img/';

  /* ==========================================================================
     THE COMPOSITION
     --------------------------------------------------------------------------
     Hand-placed, not generated. A ring of six at even angles is the thing this
     was rebuilt to stop being: the eye finds the circle instantly and then has
     nothing left to do. These sit at deliberately uneven distances with two
     near-overlaps, so the cluster has a foreground and a middle ground.

     x / y / s are percentages of the square host. dur / dly / dx / dy / rot
     drive the float — every duration a different prime-ish value so no two
     elements ever come back into phase on screen.

     `at` is the progress percentage that reveals it. The three geometric
     circles come first because they cost nothing and the corner should not be
     empty at 4%; the work arrives as the boot actually gets somewhere.
     ========================================================================== */
  var ITEMS = [
    /* --- geometry: free, instant, always present ----------------------- */
    { kind: 'rings',  x: 30, y: 12, s: 30, at: 4,
      dur: 13.1, dly: 0,   dx: 2.5,  dy: -3.5, rot: 2 },
    { kind: 'dashes', x: 4,  y: 50, s: 22, at: 10,
      dur: 11.2, dly: 0.7, dx: -3,   dy: 3,    rot: -3 },
    { kind: 'orb',    x: 58, y: 62, s: 26, at: 16,
      dur: 12.4, dly: 1.4, dx: 3.5,  dy: 2.5,  rot: 0 },

    /* --- the work ------------------------------------------------------ */
    { kind: 'model',  x: 2,  y: 6,  s: 34, at: 26, src: 'loader/model-turntable.webp',
      dur: 10.6, dly: 0.3, dx: 3,    dy: -4,   rot: 0 },
    { kind: 'video',  x: 54, y: 0,  s: 30, at: 44,
      /* webm first: Chromium builds without proprietary codecs (Linux
         Chromium, Electron) and Firefox take it; Safari falls through to the
         h264. Only one is ever downloaded. */
      src: ['loader/loop-360.webm', 'loader/loop-360.mp4'],
      poster: 'loader/loop-poster.webp',
      dur: 9.4,  dly: 1.1, dx: -2.5, dy: 4,    rot: 0 },
    { kind: 'image',  x: 22, y: 58, s: 32, at: 60, src: 'stl-previews/dioramas.webp',
      dur: 8.3,  dly: 0.5, dx: 4,    dy: -2.5, rot: 0 },

    /* --- figurines between them ---------------------------------------- */
    { kind: 'chip', x: 46, y: 40, s: 13, at: 34, src: 'stl-previews/miniatures.webp',
      dur: 7.4,  dly: 0.2, dx: -5, dy: 5,  rot: 0 },
    { kind: 'chip', x: 84, y: 34, s: 11, at: 52, src: 'stl-previews/chibi.webp',
      dur: 9.9,  dly: 0.9, dx: 6,  dy: -4, rot: 0 },
    { kind: 'chip', x: 12, y: 36, s: 10, at: 68, src: 'stl-previews/busts.webp',
      dur: 8.8,  dly: 1.6, dx: -4, dy: -6, rot: 0 },
    { kind: 'chip', x: 62, y: 88, s: 12, at: 78, src: 'stl-previews/vehicles.webp',
      dur: 11.7, dly: 0.4, dx: 5,  dy: 3,  rot: 0 },
    { kind: 'chip', x: 36, y: 92, s: 9,  at: 88, src: 'stl-previews/sculptures.webp',
      dur: 10.2, dly: 1.2, dx: -3, dy: 6,  rot: 0 }
  ];

  var built = [];
  var lastOn = -1;
  var running = true;

  /* ==========================================================================
     BUILD — geometry only. Not one byte is requested on this path.
     ========================================================================== */
  try {
    var root = document.createElement('div');
    root.className = 'wsl-orbit';
    root.setAttribute('aria-hidden', 'true');   /* the meter already narrates */

    var frag = document.createDocumentFragment();
    ITEMS.forEach(function (spec) {
      var item = document.createElement('div');
      item.className = 'wsl-orbit__item wsl-orbit--' + spec.kind +
        (spec.kind === 'image' || spec.kind === 'video' ? ' wsl-orbit--media' : '');
      var s = item.style;
      s.setProperty('--x', spec.x + '%');
      s.setProperty('--y', spec.y + '%');
      s.setProperty('--s', spec.s + '%');
      s.setProperty('--dur', spec.dur + 's');
      s.setProperty('--dly', spec.dly + 's');
      s.setProperty('--dx', spec.dx + '%');
      s.setProperty('--dy', spec.dy + '%');
      s.setProperty('--rot', (spec.rot || 0) + 'deg');

      var skin = document.createElement('div');
      skin.className = 'wsl-orbit__skin';

      if (spec.kind === 'rings') {
        for (var r = 0; r < 3; r++) {
          var ring = document.createElement('i');
          ring.className = 'wsl-orbit__ring';
          skin.appendChild(ring);
        }
      } else if (spec.kind === 'dashes') {
        var d = document.createElement('i');
        d.className = 'wsl-orbit__dashes';
        skin.appendChild(d);
      } else if (spec.kind === 'model') {
        var t = document.createElement('i');
        t.className = 'wsl-orbit__turntable';
        skin.appendChild(t);
        spec.turntable = t;
      }

      item.appendChild(skin);
      frag.appendChild(item);
      built.push({ spec: spec, el: item, skin: skin });
    });
    root.appendChild(frag);
    host.appendChild(root);
  } catch (err) {
    return;                                     /* no cluster, no harm */
  }

  /* ==========================================================================
     MEDIA
     ========================================================================== */
  function conservative() {
    var c = navigator.connection || navigator.mozConnection || {};
    if (c.saveData) return true;
    return /(^|-)(slow-)?2g$/.test(c.effectiveType || '');
  }

  function attachImage(entry, src, onto) {
    var img = new Image();
    img.alt = '';
    img.decoding = 'async';
    if ('fetchPriority' in img) img.fetchPriority = 'low';   /* never outrank the bundle */
    img.src = BASE + src;

    var done = function () {
      if (!running || loader.classList.contains('is-exiting')) return;
      if (onto) {
        /* the turntable is a background, so the decoded sheet only has to be
           handed to CSS — the element is already in the tree */
        onto.style.backgroundImage = 'url("' + BASE + src + '")';
      } else {
        entry.skin.appendChild(img);
      }
      entry.el.classList.add('has-media');
    };
    if (img.decode) img.decode().then(done).catch(function () {});
    else { img.onload = done; img.onerror = function () {}; }
  }

  function attachVideo(entry, spec) {
    var v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    if (spec.poster) v.poster = BASE + spec.poster;

    /* canplaythrough, not loadeddata: attaching a video that still has to
       fetch mid-playback gives a visible stall on the first loop */
    var ok = false;
    v.addEventListener('canplaythrough', function () {
      if (ok || !running || loader.classList.contains('is-exiting')) return;
      ok = true;
      entry.skin.appendChild(v);
      entry.el.classList.add('has-media');
      /* Autoplay may be refused whatever we do. If it is, the poster stays up
         and that is a perfectly good circle — no retry, no error path. */
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    }, { once: true });
    v.addEventListener('error', function () {}, { once: true });

    (Array.isArray(spec.src) ? spec.src : [spec.src]).forEach(function (u) {
      var srcEl = document.createElement('source');
      srcEl.src = BASE + u;
      srcEl.type = /\.webm$/.test(u) ? 'video/webm' : 'video/mp4';
      v.appendChild(srcEl);
    });
    v.load();
  }

  function hydrate() {
    if (conservative()) return;
    built.forEach(function (entry) {
      var spec = entry.spec;
      if (!spec.src) return;
      if (spec.kind === 'video') {
        if (!reduceMotion) attachVideo(entry, spec);
        else if (spec.poster) attachImage(entry, spec.poster, null);
      } else if (spec.kind === 'model') {
        attachImage(entry, spec.src, spec.turntable);
      } else {
        attachImage(entry, spec.src, null);
      }
    });
  }

  if (window.requestIdleCallback) requestIdleCallback(hydrate, { timeout: 900 });
  else window.setTimeout(hydrate, 120);

  /* ==========================================================================
     PROGRESS — read the loader's own published value
     --------------------------------------------------------------------------
     Read off the INLINE style, not getComputedStyle: no style recalc is
     forced, so this loop costs a string parse per frame and nothing else. The
     class writes are guarded on change, so a steady frame does no DOM work.
     ========================================================================== */
  function progress() {
    var n = parseFloat(loader.style.getPropertyValue('--loader-progress'));
    return isNaN(n) ? 0 : Math.max(0, Math.min(100, n));
  }

  function tick() {
    if (!running) return;
    if (loader.hidden || loader.classList.contains('is-exiting')) { running = false; return; }

    var p = progress();
    var on = 0;
    for (var i = 0; i < built.length; i++) if (p >= built[i].spec.at) on++;
    if (on !== lastOn) {
      lastOn = on;
      for (var j = 0; j < built.length; j++) {
        built[j].el.classList.toggle('is-on', p >= built[j].spec.at);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ---- diagnostics, same shape as __wsLoaderDebug ----------------------- */
  window.__wsGridDebug = {
    items: built.length,
    on: function () { return loader.querySelectorAll('.wsl-orbit__item.is-on').length; },
    media: function () { return loader.querySelectorAll('.wsl-orbit__item.has-media').length; }
  };
})();
