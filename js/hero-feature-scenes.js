/* ==========================================================================
   HERO-FEATURE-SCENES.JS — live canvas scenes for the three capability
   cards on the homepage (print prep · remesh & texture · export & convert).

   Markup contract (index.html):
     <span class="hero-card-media hero-scene" data-scene="printprep|remesh|export">
       <canvas class="fxc-stage"></canvas>
       <span class="fxc-hud"> <span class="hud-chip" data-hud="…">…</span> … </span>
     </span>

   Tiny shared 3D engine — vertices, painter's-algorithm faces, DPR aware.
   No dependencies; pauses via IntersectionObserver when the card leaves the
   viewport; renders one static composed frame under prefers-reduced-motion.
   Styles live in homepage-responsive.css (.hero-scene / .fxc-* / .hud-chip).
   ========================================================================== */
(function () {
  'use strict';
  var TEAL = [102, 211, 198], SAND = [243, 232, 188], RED = [245, 79, 27], BLUE = [30, 34, 61], MAGENTA = [90, 33, 50];
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(t) { return Math.max(0, Math.min(1, t)); }
  function ease(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function mixColor(a, b, t) {
    t = clamp01(t);
    return [
      Math.round(lerp(a[0], b[0], t)),
      Math.round(lerp(a[1], b[1], t)),
      Math.round(lerp(a[2], b[2], t))
    ];
  }

  function rot(v, ax, ay) {
    var x = v[0], y = v[1], z = v[2];
    var ca = Math.cos(ay), sa = Math.sin(ay);
    var t = x * ca - z * sa; z = x * sa + z * ca; x = t;
    var cb = Math.cos(ax), sb = Math.sin(ax);
    t = y * cb - z * sb; z = y * sb + z * cb; y = t;
    return [x, y, z];
  }
  function proj(v, w, h, scale, dist) {
    var d = dist / (dist + v[2]);
    return [w / 2 + v[0] * scale * d, h / 2 + v[1] * scale * d, d];
  }

  /* deterministic pseudo-random (stable frames, no Math.random drift) */
  function prand(i) { var x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  function makeScene(card, draw) {
    var canvas = card.querySelector('.fxc-stage');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var running = false, raf = null, t0 = performance.now();
    function resize() {
      var r = canvas.getBoundingClientRect();
      canvas.width = Math.max(2, r.width * devicePixelRatio);
      canvas.height = Math.max(2, r.height * devicePixelRatio);
    }
    function frame(now) {
      if (!running) return;
      draw(ctx, canvas.width, canvas.height, (now - t0) / 1000, card);
      raf = requestAnimationFrame(frame);
    }
    resize();
    addEventListener('resize', function () {
      resize();
      if (reduceMotion) draw(ctx, canvas.width, canvas.height, 4.2, card);
    });
    if (reduceMotion) { draw(ctx, canvas.width, canvas.height, 4.2, card); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !running) { resize(); running = true; raf = requestAnimationFrame(frame); }
        else if (!e.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
      });
    }, { threshold: 0.05 }).observe(card);
  }

  /* ------------------------------------------------------------------------
     SCENE 1 — PRINT PREP: a model is sliced layer by layer; the scan finds
     open edges (red), stitches them (teal flash), and the score climbs.
     Geometry: low-poly chess-pawn (solid of revolution, 10 segments).
     ------------------------------------------------------------------------ */
  function buildPawn() {
    var profile = [ /* [radius, y] bottom→top, y in -1..1 (y up) */
      [0.62, -1.0], [0.66, -0.86], [0.40, -0.72], [0.28, -0.42],
      [0.22, -0.05], [0.30, 0.18], [0.14, 0.34], [0.30, 0.55],
      [0.36, 0.72], [0.22, 0.9], [0.0, 1.0]
    ];
    var SEG = 10, verts = [], quads = [];
    for (var i = 0; i < profile.length; i++)
      for (var s = 0; s < SEG; s++) {
        var a = s / SEG * Math.PI * 2;
        verts.push([Math.cos(a) * profile[i][0], -profile[i][1], Math.sin(a) * profile[i][0]]);
      }
    for (var r = 0; r < profile.length - 1; r++)
      for (var s2 = 0; s2 < SEG; s2++) {
        var a0 = r * SEG + s2, a1 = r * SEG + (s2 + 1) % SEG;
        quads.push([a0, a1, a1 + SEG, a0 + SEG]);
      }
    return { verts: verts, quads: quads, rows: profile.length };
  }
  var pawn = buildPawn();

  function drawPrintPrep(ctx, w, h, t, card) {
    ctx.clearRect(0, 0, w, h);
    var scale = Math.min(w, h) * 0.30, dist = 4.2;
    var CYCLE = 9, tc = t % CYCLE;
    /* phases: 0-5.5 slice up · 5.5-6.5 repair pulse · 6.5-9 hold + score */
    var sliceY = ease(tc / 5.5);                      /* 0 bottom → 1 top */
    var repairing = tc > 5.5 && tc < 6.5;
    var done = tc >= 6.5;
    var cut = lerp(1.15, -1.15, sliceY);              /* model coords, y down */
    var chroma = 0.5 + 0.5 * Math.sin(t * 1.2);
    var faceA = mixColor(TEAL, SAND, chroma * 0.55);
    var faceB = mixColor(SAND, RED, 0.28 + 0.28 * Math.sin(t * 1.7));
    var laserColor = repairing ? SAND : mixColor(TEAL, RED, 0.35 + 0.35 * Math.sin(t * 1.4));

    var rv = pawn.verts.map(function (v) { return rot(v, -0.42, t * 0.5); });
    var pv = rv.map(function (v) { return proj(v, w, h, scale, dist); });

    /* faces sorted back→front */
    var faces = pawn.quads.map(function (q, qi) {
      var z = (rv[q[0]][2] + rv[q[1]][2] + rv[q[2]][2] + rv[q[3]][2]) / 4;
      var my = (pawn.verts[q[0]][1] + pawn.verts[q[2]][1]) / 2;  /* unrotated height */
      return { q: q, z: z, my: my, i: qi };
    }).sort(function (a, b) { return b.z - a.z; });

    faces.forEach(function (f) {
      var q = f.q, printed = f.my > cut;               /* below the slice plane = printed */
      ctx.beginPath();
      ctx.moveTo(pv[q[0]][0], pv[q[0]][1]);
      for (var k = 1; k < 4; k++) ctx.lineTo(pv[q[k]][0], pv[q[k]][1]);
      ctx.closePath();
      if (printed || done) {
        var lum = 0.5 + 0.5 * clamp01((rv[q[0]][2] + 1.4) / 2.4);
        var glow = done && tc < 7.2 ? ease((tc - 6.5) / 0.7) * 0.25 : 0;
        var faceColor = mixColor(faceA, faceB, 0.5 + 0.5 * Math.sin(t * 1.4 + f.i * 0.23));
        ctx.fillStyle = rgba(faceColor, 0.11 + 0.18 * lum + glow);
        ctx.fill();
        ctx.strokeStyle = rgba(faceColor, 0.48 + 0.16 * Math.sin(t * 2 + f.i));
        ctx.lineWidth = 1 * devicePixelRatio;
        ctx.stroke();
      } else {
        /* unprinted: ghost wireframe; a few faces are "open edges" that flash red */
        var bad = prand(f.i) > 0.85 && !done;
        ctx.strokeStyle = bad && Math.sin(t * 9 + f.i) > 0.2
          ? rgba(RED, 0.72) : rgba(mixColor(BLUE, TEAL, 0.45 + 0.25 * Math.sin(t + f.i)), 0.16);
        ctx.lineWidth = 1 * devicePixelRatio;
        ctx.stroke();
      }
    });

    /* slicing laser */
    if (!done) {
      var ly = proj(rot([0, cut, 0], -0.42, 0), w, h, scale, dist)[1];
      var grad = ctx.createLinearGradient(w * 0.12, 0, w * 0.88, 0);
      grad.addColorStop(0, rgba(laserColor, 0));
      grad.addColorStop(0.5, rgba(laserColor, repairing ? 0.95 : 0.82));
      grad.addColorStop(1, rgba(laserColor, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(w * 0.12, ly - 1.2 * devicePixelRatio, w * 0.76, 2.4 * devicePixelRatio);
      /* sparks on the plane */
      for (var s = 0; s < 7; s++) {
        var sx = w * (0.25 + 0.5 * prand(s + Math.floor(t * 6)));
        ctx.fillStyle = rgba(mixColor(laserColor, SAND, prand(s + Math.floor(t * 5))), 0.7 * prand(s * 3 + Math.floor(t * 10)));
        ctx.fillRect(sx, ly - 3 * devicePixelRatio, 2 * devicePixelRatio, 2 * devicePixelRatio);
      }
    }

    /* build plate */
    var by = proj(rot([0, 1.18, 0], -0.42, 0), w, h, scale, dist)[1];
    ctx.strokeStyle = rgba(mixColor(BLUE, TEAL, 0.35 + 0.25 * Math.sin(t)), 0.16);
    ctx.lineWidth = 1 * devicePixelRatio;
    for (var g = -3; g <= 3; g++) {
      ctx.beginPath();
      ctx.moveTo(w / 2 + g * scale * 0.32 - scale * 0.5, by + scale * 0.34);
      ctx.lineTo(w / 2 + g * scale * 0.32 + scale * 0.5, by + scale * 0.14);
      ctx.stroke();
    }

    /* HUD */
    var layerChip = card.querySelector('[data-hud="layer"] b');
    var stateChip = card.querySelector('[data-hud="state"]');
    var scoreChip = card.querySelector('[data-hud="score"]');
    if (layerChip) layerChip.textContent = String(Math.round(sliceY * 184)).padStart(3, '0');
    if (stateChip) {
      stateChip.textContent = done ? 'Watertight ✓' : repairing ? 'Repairing edges' : 'Slicing';
      stateChip.classList.toggle('ok', done);
      stateChip.classList.toggle('warn', repairing);
    }
    if (scoreChip) {
      var sc = done ? Math.round(lerp(62, 96, ease((tc - 6.5) / 1.4))) : '—';
      scoreChip.innerHTML = 'Score <b>' + sc + '</b>';
      scoreChip.classList.toggle('ok', done && tc > 7.9);
    }
  }

  /* ------------------------------------------------------------------------
     SCENE 2 — REMESH & TEXTURE: a torus cycles chaos → clean quads →
     painted surface. Vertices jitter in "raw scan", snap to the lattice on
     remesh, then a light sweep shades the faces.
     ------------------------------------------------------------------------ */
  function buildTorus(R, r, N, M) {
    var verts = [], quads = [];
    for (var i = 0; i < N; i++) {
      var a = i / N * Math.PI * 2;
      for (var j = 0; j < M; j++) {
        var b = j / M * Math.PI * 2;
        verts.push([
          (R + r * Math.cos(b)) * Math.cos(a),
          r * Math.sin(b),
          (R + r * Math.cos(b)) * Math.sin(a)
        ]);
      }
    }
    for (var i2 = 0; i2 < N; i2++)
      for (var j2 = 0; j2 < M; j2++) {
        var a0 = i2 * M + j2, a1 = i2 * M + (j2 + 1) % M;
        var b0 = ((i2 + 1) % N) * M + j2, b1 = ((i2 + 1) % N) * M + (j2 + 1) % M;
        quads.push([a0, a1, b1, b0]);
      }
    return { verts: verts, quads: quads };
  }
  var torus = buildTorus(0.86, 0.4, 26, 12);

  function drawRemesh(ctx, w, h, t, card) {
    ctx.clearRect(0, 0, w, h);
    var scale = Math.min(w, h) * 0.30, dist = 4.4;
    var CYCLE = 10, tc = t % CYCLE;
    /* 0-3 raw jitter · 3-4.5 snap clean · 4.5-7 texture sweep · 7-10 hold, dissolve at end */
    var snap = ease((tc - 3) / 1.5);
    var paint = ease((tc - 4.5) / 2.5);
    var dissolve = ease((tc - 9.2) / 0.8);
    var jitterAmp = (1 - snap) * 0.09 * (1 - dissolve) + dissolve * 0.09;
    var sweepColor = mixColor(SAND, RED, 0.35 + 0.35 * Math.sin(t * 1.35));
    var cleanColor = mixColor(TEAL, SAND, 0.25 + 0.25 * Math.sin(t * 0.9));

    var rv = torus.verts.map(function (v, i) {
      var j = jitterAmp;
      var vv = [
        v[0] + (prand(i) - 0.5) * j * (1 + Math.sin(t * 3 + i)),
        v[1] + (prand(i + 99) - 0.5) * j * (1 + Math.cos(t * 2.6 + i)),
        v[2] + (prand(i + 177) - 0.5) * j
      ];
      return rot(vv, 0.5 + Math.sin(t * 0.3) * 0.12, t * 0.45);
    });
    var pv = rv.map(function (v) { return proj(v, w, h, scale, dist); });

    var faces = torus.quads.map(function (q, qi) {
      return { q: q, z: (rv[q[0]][2] + rv[q[2]][2]) / 2, i: qi };
    }).sort(function (a, b) { return b.z - a.z; });

    faces.forEach(function (f) {
      var q = f.q;
      ctx.beginPath();
      ctx.moveTo(pv[q[0]][0], pv[q[0]][1]);
      for (var k = 1; k < 4; k++) ctx.lineTo(pv[q[k]][0], pv[q[k]][1]);
      ctx.closePath();
      /* texture: sweep left→right across the projected surface */
      var cx = (pv[q[0]][0] + pv[q[2]][0]) / 2 / w;
      var painted = paint > 0 && cx < paint * 1.15 - 0.05;
      if (painted) {
        var lum = 0.45 + 0.55 * clamp01((rv[q[0]][2] + 1.5) / 2.6);
        var warm = 0.5 + 0.5 * Math.sin(f.i * 0.7);
        var paintColor = mixColor(TEAL, sweepColor, warm * 0.7);
        ctx.fillStyle = rgba(paintColor, 0.14 + 0.32 * lum);
        ctx.fill();
      }
      var lineColor = mixColor(cleanColor, SAND, 0.18 + 0.18 * Math.sin(t * 1.8 + f.i));
      var lineA = snap > 0.5
        ? rgba(lineColor, 0.22 + 0.38 * snap * (1 - dissolve))
        : rgba(mixColor(MAGENTA, RED, 0.35 + 0.35 * Math.sin(f.i + t * 2)), 0.12 + 0.13 * Math.abs(Math.sin(f.i + t * 2)));
      ctx.strokeStyle = lineA;
      ctx.lineWidth = (snap > 0.5 ? 1 : 0.7) * devicePixelRatio;
      ctx.stroke();
    });

    for (var n = 0; n < 9; n++) {
      var p = pv[Math.floor(prand(n + Math.floor(t * 2)) * pv.length) % pv.length];
      ctx.fillStyle = rgba(mixColor(TEAL, SAND, prand(n)), 0.35 + 0.25 * Math.sin(t * 2 + n));
      ctx.beginPath();
      ctx.arc(p[0], p[1], (1.4 + prand(n) * 1.8) * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }

    /* sweep beam while painting */
    if (paint > 0 && paint < 1) {
      var bx = w * (paint * 1.15 - 0.05);
      var grad = ctx.createLinearGradient(bx - 30 * devicePixelRatio, 0, bx + 4, 0);
      grad.addColorStop(0, rgba(sweepColor, 0));
      grad.addColorStop(1, rgba(sweepColor, 0.65));
      ctx.fillStyle = grad;
      ctx.fillRect(bx - 30 * devicePixelRatio, h * 0.1, 30 * devicePixelRatio, h * 0.8);
    }

    var mode = card.querySelector('[data-hud="mode"]');
    var polys = card.querySelector('[data-hud="polys"]');
    if (mode) {
      mode.textContent = tc < 3 ? 'Raw scan' : tc < 4.5 ? 'Remeshing' : tc < 7 ? 'Texturing' : 'Print-ready';
      mode.classList.toggle('ok', tc >= 7 && tc < 9.2);
    }
    if (polys) polys.innerHTML = tc < 3
      ? '<b>212k</b> tris'
      : '<b>' + Math.round(lerp(212, 18, ease((tc - 3) / 1.5))) + 'k</b> ' + (snap > 0.6 ? 'quads' : 'tris');
  }

  /* ------------------------------------------------------------------------
     SCENE 3 — EXPORT & CONVERT: format chips ride bezier rails into a
     rotating wire-cube core; the core flashes and fires the converted chip
     out with a comet trail.
     ------------------------------------------------------------------------ */
  var CUBE_V = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  var CUBE_E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  var FORMATS = ['STL','OBJ','GLTF','USDZ','3MF','FBX'];
  var OUT = 'GLB';

  function bez(p0, p1, p2, t) {
    var a = 1 - t;
    return [a*a*p0[0] + 2*a*t*p1[0] + t*t*p2[0], a*a*p0[1] + 2*a*t*p1[1] + t*t*p2[1]];
  }
  function chipDraw(ctx, x, y, label, col, alpha, dpr) {
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.font = '700 ' + 10 * dpr + 'px Inter, sans-serif';
    var tw = ctx.measureText(label).width, px = 9 * dpr, ph = 10 * dpr;
    ctx.fillStyle = 'rgba(12,16,17,0.92)';
    ctx.strokeStyle = rgba(col, 0.55);
    ctx.lineWidth = 1 * dpr;
    var rx = x - tw / 2 - px, ry = y - ph, rw = tw + px * 2, rh = ph * 2, rr = rh / 2;
    ctx.beginPath();
    ctx.moveTo(rx + rr, ry); ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr);
    ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr); ctx.arcTo(rx, ry + rh, rx, ry, rr);
    ctx.arcTo(rx, ry, rx + rw, ry, rr); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = rgba(col, 0.95);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5 * dpr);
    ctx.restore();
  }

  function drawExport(ctx, w, h, t, card) {
    ctx.clearRect(0, 0, w, h);
    var dpr = devicePixelRatio;
    var cx = w * 0.46, cy = h * 0.48, scale = Math.min(w, h) * 0.11, dist = 5;
    var STAG = 1.4;                                   /* seconds between chips */
    var coreColor = mixColor(TEAL, SAND, 0.35 + 0.35 * Math.sin(t * 1.1));
    var chipColor = mixColor(SAND, RED, 0.35 + 0.35 * Math.sin(t * 0.9));
    var outColor = mixColor(TEAL, RED, 0.25 + 0.25 * Math.sin(t * 1.4));

    /* core cube */
    var pulse = 0;
    FORMATS.forEach(function (_, i) {
      var arrive = ((t - i * STAG) % (FORMATS.length * STAG) + FORMATS.length * STAG) % (FORMATS.length * STAG);
      if (arrive > 2.0 && arrive < 2.35) pulse = Math.max(pulse, 1 - Math.abs(arrive - 2.15) / 0.2);
    });
    var cv = CUBE_V.map(function (v) { return rot(v.map(function(n){return n*(1+pulse*0.12);}), 0.5, t * 0.8); });
    var cp = cv.map(function (v) { return [cx + v[0] * scale * (dist/(dist+v[2])), cy + v[1] * scale * (dist/(dist+v[2])), dist/(dist+v[2])]; });
    /* halo */
    var halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 3);
    halo.addColorStop(0, rgba(coreColor, 0.12 + pulse * 0.28));
    halo.addColorStop(1, rgba(coreColor, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(cx - scale * 3, cy - scale * 3, scale * 6, scale * 6);
    ctx.strokeStyle = rgba(mixColor(RED, SAND, 0.45 + 0.45 * pulse), 0.18 + pulse * 0.22);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, scale * (2.15 + pulse * 0.12), scale * (0.7 + pulse * 0.06), Math.sin(t * 0.5) * 0.35, 0, Math.PI * 2);
    ctx.stroke();
    CUBE_E.forEach(function (e) {
      ctx.strokeStyle = rgba(mixColor(coreColor, SAND, (e[0] + e[1]) / 14), 0.38 + 0.45 * Math.min(cp[e[0]][2], cp[e[1]][2]) + pulse * 0.3);
      ctx.lineWidth = 1.3 * dpr;
      ctx.beginPath(); ctx.moveTo(cp[e[0]][0], cp[e[0]][1]); ctx.lineTo(cp[e[1]][0], cp[e[1]][1]); ctx.stroke();
    });

    /* inbound chips on bezier rails (left side), outbound GLB (right) */
    var latest = '';
    FORMATS.forEach(function (label, i) {
      var cyc = FORMATS.length * STAG;
      var lt = ((t - i * STAG) % cyc + cyc) % cyc;     /* 0..cyc for this chip */
      var p0 = [w * (0.06 + 0.06 * prand(i)), h * (0.16 + 0.66 * prand(i * 7 + 2))];
      var p1 = [w * 0.3, h * (0.5 + (prand(i * 3) - 0.5) * 0.5)];
      var p2 = [cx, cy];
      if (lt < 2.0) {                                  /* travelling in */
        var tt = ease(lt / 2.0);
        var pos = bez(p0, p1, p2, tt);
        /* rail */
        ctx.strokeStyle = rgba(mixColor(BLUE, chipColor, 0.45), 0.13);
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]);
        ctx.quadraticCurveTo(p1[0], p1[1], p2[0], p2[1]); ctx.stroke();
        /* trail */
        for (var k = 1; k <= 5; k++) {
          var tp = bez(p0, p1, p2, clamp01(tt - k * 0.03));
          ctx.fillStyle = rgba(chipColor, 0.28 * (1 - k / 6));
          ctx.beginPath(); ctx.arc(tp[0], tp[1], (3 - k * 0.4) * dpr, 0, 7); ctx.fill();
        }
        chipDraw(ctx, pos[0], pos[1], label, mixColor(chipColor, SAND, prand(i)), Math.min(1, tt * 4) * (1 - Math.max(0, tt - 0.92) * 12), dpr);
      } else if (lt < 2.35) {
        latest = label;                                /* absorbed — core pulses */
      } else if (lt < 4.2) {                           /* converted chip exits right */
        var ot = ease((lt - 2.35) / 1.85);
        var q0 = [cx, cy], q1 = [w * 0.72, cy - h * 0.08], q2 = [w * 0.97, h * (0.3 + 0.4 * prand(i * 5))];
        var opos = bez(q0, q1, q2, ot);
        for (var k2 = 1; k2 <= 6; k2++) {
          var tp2 = bez(q0, q1, q2, clamp01(ot - k2 * 0.035));
          ctx.fillStyle = rgba(outColor, 0.33 * (1 - k2 / 7));
          ctx.beginPath(); ctx.arc(tp2[0], tp2[1], (3.4 - k2 * 0.4) * dpr, 0, 7); ctx.fill();
        }
        chipDraw(ctx, opos[0], opos[1], OUT, outColor, 1 - Math.max(0, ot - 0.8) * 5, dpr);
        latest = label;
      }
    });

    var job = card.querySelector('[data-hud="job"]');
    var out = card.querySelector('[data-hud="out"]');
    if (job && latest) job.textContent = latest + ' → ' + OUT;
    if (out) out.innerHTML = '→ <b>' + OUT + '</b>';
  }

  /* boot */
  function boot() {
    document.querySelectorAll('.hero-scene[data-scene]').forEach(function (card) {
      var scene = card.getAttribute('data-scene');
      if (scene === 'printprep') makeScene(card, drawPrintPrep);
      else if (scene === 'remesh') makeScene(card, drawRemesh);
      else if (scene === 'export') makeScene(card, drawExport);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
