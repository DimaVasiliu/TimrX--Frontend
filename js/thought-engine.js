/* ============================================================================
   TimrX Thought Engine — Neural Intelligence Edition
   Canvas-based living nervous system. Amber particles flow from stage edges
   along spline paths into the brain center. Keeps all card-spring physics.
   ============================================================================ */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  var CFG = {
    pathCount: 55,
    particleMin: 40,
    particleMax: 110,
    ringCount: 6,
    speedLo: 0.00018,
    speedHi: 0.00042,
    parallaxMax: 15,
    spawnRate: 1 / 55,   // particles per ms at 1x multiplier
  };

  var C = {
    amber: 'rgba(255,179,71,',
    gold:  'rgba(255,210,100,',
    soft:  'rgba(255,248,235,',
    blue:  'rgba(100,165,230,',
  };

  // ── Math utils ──────────────────────────────────────────────────────────────
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(lo, hi)   { return lo + Math.random() * (hi - lo); }

  function bezPt(p0, p1, p2, p3, t) {
    var u = 1 - t, u2 = u * u, t2 = t * t;
    return {
      x: u2*u*p0.x + 3*u2*t*p1.x + 3*u*t2*p2.x + t2*t*p3.x,
      y: u2*u*p0.y + 3*u2*t*p1.y + 3*u*t2*p2.y + t2*t*p3.y,
    };
  }

  // ── PathNetwork ─────────────────────────────────────────────────────────────
  function PathNetwork(w, h) {
    this.w = w; this.h = h;
    this.cx = w / 2; this.cy = h / 2;
    this.paths = [];
    this._build();
  }

  PathNetwork.prototype._edge = function () {
    var w = this.w, h = this.h, s = Math.floor(Math.random() * 4);
    if (s === 0) return { x: rand(0, w),    y: rand(-30, 0) };
    if (s === 1) return { x: rand(w, w+30), y: rand(0, h) };
    if (s === 2) return { x: rand(0, w),    y: rand(h, h+30) };
    return             { x: rand(-30, 0),   y: rand(0, h) };
  };

  PathNetwork.prototype._build = function () {
    var cx = this.cx, cy = this.cy;
    this.paths = [];
    for (var i = 0; i < CFG.pathCount; i++) {
      var p0 = this._edge();
      var p3 = { x: cx + rand(-28, 28), y: cy + rand(-28, 28) };
      var cp1 = {
        x: lerp(p0.x, cx, rand(0.2, 0.5)) + rand(-90, 90),
        y: lerp(p0.y, cy, rand(0.2, 0.5)) + rand(-90, 90),
      };
      var cp2 = {
        x: lerp(cx, p0.x, rand(0.1, 0.35)) + rand(-65, 65),
        y: lerp(cy, p0.y, rand(0.1, 0.35)) + rand(-65, 65),
      };
      this.paths.push({ p0: p0, cp1: cp1, cp2: cp2, p3: p3 });
    }
  };

  PathNetwork.prototype.resize = function (w, h) {
    this.w = w; this.h = h; this.cx = w / 2; this.cy = h / 2;
    this._build();
  };

  PathNetwork.prototype.draw = function (ctx) {
    ctx.save();
    ctx.strokeStyle = C.amber + '0.07)';
    ctx.lineWidth = 0.8;
    for (var i = 0; i < this.paths.length; i++) {
      var p = this.paths[i];
      ctx.beginPath();
      ctx.moveTo(p.p0.x, p.p0.y);
      ctx.bezierCurveTo(p.cp1.x, p.cp1.y, p.cp2.x, p.cp2.y, p.p3.x, p.p3.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  // ── Particle ─────────────────────────────────────────────────────────────────
  function Particle() {
    this.active = false;
    this.t = 0; this.speed = 0;
    this.path = null; this.alpha = 0; this.size = 2;
    this.col = C.amber;
  }

  Particle.prototype.init = function (path) {
    this.active = true;
    this.t = 0;
    this.path = path;
    this.speed = rand(CFG.speedLo, CFG.speedHi);
    this.size = rand(1.4, 3.0);
    this.alpha = 0;
    var r = Math.random();
    this.col = r < 0.65 ? C.amber : r < 0.88 ? C.gold : C.soft;
  };

  Particle.prototype.update = function (dt) {
    if (!this.active) return;
    this.t += this.speed * dt;
    if (this.t >= 1) { this.active = false; return; }
    if      (this.t < 0.15) this.alpha = this.t / 0.15;
    else if (this.t > 0.82) this.alpha = (1 - this.t) / 0.18;
    else                    this.alpha = 1;
  };

  Particle.prototype.draw = function (ctx) {
    if (!this.active || !this.path) return;
    var pt = bezPt(this.path.p0, this.path.cp1, this.path.cp2, this.path.p3, this.t);
    var a  = this.alpha * 0.82;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = this.col + a + ')';
    ctx.fill();
    if (a > 0.28) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, this.size * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = this.col + (a * 0.16) + ')';
      ctx.fill();
    }
  };

  // True once particle is close enough to trigger a brain flash
  Particle.prototype.arriving = function () {
    return this.active && this.t > 0.88;
  };

  // ── ParticlePool ─────────────────────────────────────────────────────────────
  function ParticlePool(cap) {
    this.pool = [];
    for (var i = 0; i < cap; i++) this.pool.push(new Particle());
  }

  ParticlePool.prototype.get = function () {
    for (var i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].active) return this.pool[i];
    }
    var p = new Particle();
    this.pool.push(p);
    return p;
  };

  ParticlePool.prototype.activeCount = function () {
    var n = 0;
    for (var i = 0; i < this.pool.length; i++) if (this.pool[i].active) n++;
    return n;
  };

  ParticlePool.prototype.update = function (dt) {
    for (var i = 0; i < this.pool.length; i++) this.pool[i].update(dt);
  };

  ParticlePool.prototype.draw = function (ctx) {
    for (var i = 0; i < this.pool.length; i++) this.pool[i].draw(ctx);
  };

  // ── Ring ─────────────────────────────────────────────────────────────────────
  // Six fragmented orbital rings anchored to corners/edges, NOT near center.
  var RING_ANCHORS = [
    [0.06, 0.07], [0.94, 0.07], [0.04, 0.92], [0.96, 0.93],
    [0.50, 0.03], [0.50, 0.97],
  ];

  function Ring(idx, w, h) {
    this.idx  = idx;
    this.angle = rand(0, Math.PI * 2);
    this.speed = rand(0.00018, 0.00065) * (Math.random() < 0.5 ? 1 : -1);
    this.r     = rand(36, 66);
    this.gapS  = rand(0.5, 1.4);
    this.gapL  = rand(0.4, 1.2);
    this.baseA = rand(0.16, 0.38);
    this.pulseT = 0;
    this.resize(w, h);
  }

  Ring.prototype.resize = function (w, h) {
    var a = RING_ANCHORS[this.idx % RING_ANCHORS.length];
    this.x = a[0] * w;
    this.y = a[1] * h;
  };

  Ring.prototype.update = function (dt) {
    this.angle += this.speed * dt;
    if (this.pulseT > 0) this.pulseT -= dt;
    if (Math.random() < 0.00005 * dt) this.pulseT = 700;
  };

  Ring.prototype.draw = function (ctx) {
    var a = this.baseA + (this.pulseT > 0 ? 0.28 * (this.pulseT / 700) : 0);
    var g = this.angle;
    ctx.save();
    ctx.strokeStyle = C.amber + a + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, g + this.gapS + this.gapL, g + this.gapS + Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = C.gold + (a * 0.45) + ')';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r * 0.6, g + this.gapS, g + this.gapS + 2.2);
    ctx.stroke();
    ctx.restore();
  };

  // ── BrainCore ─────────────────────────────────────────────────────────────────
  function BrainCore(cx, cy) {
    this.cx = cx; this.cy = cy;
    this.flashes = [];
    this.phase = 0;
  }

  BrainCore.prototype.flash = function () {
    this.flashes.push({ r: 18, a: 0.68, life: 1.0 });
  };

  BrainCore.prototype.update = function (dt) {
    this.phase += dt * 0.00058;
    var alive = [];
    for (var i = 0; i < this.flashes.length; i++) {
      var f = this.flashes[i];
      f.r += dt * 0.13;
      f.a *= Math.pow(0.9945, dt);
      f.life -= dt / 850;
      if (f.life > 0) alive.push(f);
    }
    this.flashes = alive;
  };

  BrainCore.prototype.draw = function (ctx) {
    var cx = this.cx, cy = this.cy;
    var amb = 0.055 + 0.038 * Math.sin(this.phase);

    // Constant ambient glow
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 95);
    g.addColorStop(0,   C.amber + amb + ')');
    g.addColorStop(0.5, C.gold  + (amb * 0.38) + ')');
    g.addColorStop(1,   C.amber + '0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 95, 0, Math.PI * 2);
    ctx.fill();

    // Arrival flashes
    for (var i = 0; i < this.flashes.length; i++) {
      var f = this.flashes[i];
      var fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, f.r);
      fg.addColorStop(0,   C.soft  + (f.a * 0.55) + ')');
      fg.addColorStop(0.4, C.amber + (f.a * 0.38) + ')');
      fg.addColorStop(1,   C.gold  + '0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(cx, cy, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // ── NeuralCanvas ─────────────────────────────────────────────────────────────
  function NeuralCanvas(stage, reduce) {
    this.stage   = stage;
    this.reduce  = reduce;
    this.w = 0; this.h = 0; this.cx = 0; this.cy = 0;

    this.mouseX = 0; this.mouseY = 0;
    this.px = 0; this.py = 0;   // smoothed parallax offsets

    this.raf = null;
    this.lastFrame = 0;
    this.destroyed = false;

    this.spawnAccum = 0;
    this.stateMul   = 1;

    this.net   = null;
    this.pool  = null;
    this.rings = [];
    this.core  = null;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'thought-engine-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    stage.insertBefore(this.canvas, stage.firstChild);
    this.ctx = this.canvas.getContext('2d');

    this._onResize = this._resize.bind(this);
    this._onMouse  = this._mouse.bind(this);

    this._resize();
    this._bind();
    this._tick = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._tick);
  }

  NeuralCanvas.prototype._bind = function () {
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.stage);
    } else {
      window.addEventListener('resize', this._onResize);
    }
    if (!this.reduce) this.stage.addEventListener('mousemove', this._onMouse);
  };

  NeuralCanvas.prototype._mouse = function (e) {
    var r = this.stage.getBoundingClientRect();
    this.mouseX = e.clientX - r.left - this.cx;
    this.mouseY = e.clientY - r.top  - this.cy;
  };

  NeuralCanvas.prototype._resize = function () {
    var r = this.stage.getBoundingClientRect();
    this.w  = r.width  || window.innerWidth;
    this.h  = r.height || window.innerHeight;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
    this.canvas.width  = this.w;
    this.canvas.height = this.h;

    if (this.net) this.net.resize(this.w, this.h);
    else          this.net = new PathNetwork(this.w, this.h);

    if (this.rings.length === 0) {
      for (var i = 0; i < CFG.ringCount; i++) this.rings.push(new Ring(i, this.w, this.h));
    } else {
      for (var j = 0; j < this.rings.length; j++) this.rings[j].resize(this.w, this.h);
    }

    if (this.core) { this.core.cx = this.cx; this.core.cy = this.cy; }
    else           { this.core = new BrainCore(this.cx, this.cy); }

    var cap = this.reduce ? CFG.particleMin : CFG.particleMax;
    if (!this.pool) this.pool = new ParticlePool(cap);
  };

  NeuralCanvas.prototype._loop = function (now) {
    if (this.destroyed) return;
    // Keep rAF alive but skip work when hidden — avoids dt spike on resume
    this.raf = requestAnimationFrame(this._tick);
    if (document.hidden) return;

    var dt = Math.min(50, Math.max(8, now - (this.lastFrame || now)));
    this.lastFrame = now;
    this._update(dt);
    this._draw();
  };

  NeuralCanvas.prototype._update = function (dt) {
    if (!this.reduce) {
      var tx = (this.mouseX / Math.max(1, this.cx)) * CFG.parallaxMax;
      var ty = (this.mouseY / Math.max(1, this.cy)) * CFG.parallaxMax;
      this.px += (tx - this.px) * 0.038;
      this.py += (ty - this.py) * 0.038;
    }

    // Spawn
    this.spawnAccum += CFG.spawnRate * this.stateMul * dt;
    var cap = this.reduce ? Math.floor(CFG.particleMin / 2) : CFG.particleMax;
    while (this.spawnAccum >= 1 && this.pool.activeCount() < cap) {
      var path = this.net.paths[Math.floor(Math.random() * this.net.paths.length)];
      this.pool.get().init(path);
      this.spawnAccum -= 1;
    }
    if (this.spawnAccum > 2) this.spawnAccum = 2;

    // Update particles; fire brain flash on arrival
    var core = this.core;
    var pl   = this.pool.pool;
    for (var i = 0; i < pl.length; i++) {
      var arriving = pl[i].arriving();
      pl[i].update(dt);
      if (arriving && !pl[i].active) core.flash();
    }

    for (var j = 0; j < this.rings.length; j++) this.rings[j].update(dt);
    this.core.update(dt);
  };

  NeuralCanvas.prototype._draw = function () {
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // Layer 1 — connective-tissue paths (gentle parallax)
    ctx.save();
    if (!this.reduce) ctx.translate(this.px * 0.28, this.py * 0.28);
    this.net.draw(ctx);
    ctx.restore();

    // Layer 2 — corner rings (no parallax, anchored to viewport)
    for (var i = 0; i < this.rings.length; i++) this.rings[i].draw(ctx);

    // Layer 3 — brain ambient glow (counter-parallax, very subtle)
    ctx.save();
    if (!this.reduce) ctx.translate(this.px * -0.12, this.py * -0.12);
    this.core.draw(ctx);
    ctx.restore();

    // Layer 4 — moving particles (stronger parallax so they feel foreground)
    ctx.save();
    if (!this.reduce) ctx.translate(this.px * 0.55, this.py * 0.55);
    this.pool.draw(ctx);
    ctx.restore();
  };

  NeuralCanvas.prototype.setState = function (state) {
    if (state === 'thinking') {
      this.stateMul = 1.4;
    } else if (state === 'done') {
      var self = this;
      this.stateMul = 2.2;
      setTimeout(function () { self.stateMul = 0.55; }, 900);
    } else {
      this.stateMul = 1;
    }
  };

  NeuralCanvas.prototype.pulse = function () {
    if (this.core) this.core.flash();
  };

  NeuralCanvas.prototype.destroy = function () {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this._ro) this._ro.disconnect();
    else window.removeEventListener('resize', this._onResize);
    this.stage.removeEventListener('mousemove', this._onMouse);
    if (this.canvas && this.canvas.parentNode) this.canvas.remove();
  };

  // ── CSS particle field (kept — decorates the .thought-engine element) ────────
  var PARTICLES = [
    [-22,-14,1.2],[18,-22,1.5],[32,10,1.3],[12,28,1.6],
    [-28,18,1.1],[-8,-36,1.4],[36,-14,1.0],[-36,26,1.2],
    [-58,-22,.9],[-44,-52,1.1],[14,-62,1.3],[52,-42,.9],
    [68,8,.8],[58,44,1.0],[22,66,1.2],[-22,64,.9],
    [-64,32,.8],[-72,-8,.7],
    [-84,-18,.6],[82,-12,.6],[-52,-74,.7],[50,-72,.7],
    [-48,78,.6],[44,76,.6],
  ];

  function makeParticles(host) {
    var wrap = document.createElement('span');
    wrap.className = 'thought-engine__particles';
    wrap.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < PARTICLES.length; i++) {
      var p   = PARTICLES[i];
      var dot = document.createElement('i');
      dot.className = 'thought-engine__particle';
      dot.style.setProperty('--particle-x',     p[0] + '%');
      dot.style.setProperty('--particle-y',     p[1] + '%');
      dot.style.setProperty('--particle-size',  p[2] + 'px');
      dot.style.setProperty('--particle-delay', (i * -0.58) + 's');
      wrap.appendChild(dot);
    }
    host.appendChild(wrap);
  }

  // ── makeEngine ───────────────────────────────────────────────────────────────
  // Builds the .thought-engine DOM without orbital rings or filaments —
  // the canvas layer handles those visuals now.
  function makeEngine(host) {
    var engine = document.createElement('div');
    engine.className  = 'thought-engine';
    engine.dataset.state = 'idle';
    engine.setAttribute('aria-hidden', 'true');
    engine.innerHTML =
      '<span class="thought-engine__axis thought-engine__axis--x"></span>' +
      '<span class="thought-engine__axis thought-engine__axis--y"></span>' +
      '<span class="thought-engine__fold"></span>' +
      '<span class="thought-engine__body">' +
        '<span class="thought-engine__core">' +
          '<img class="thought-engine__human" src="assets/thought-human-silhouette.png" alt="" aria-hidden="true">' +
          '<i></i><b></b>' +
        '</span>' +
        '<span class="thought-engine__scan"></span>' +
        '<span class="thought-engine__spark"></span>' +
      '</span>';
    host.appendChild(engine);
    makeParticles(engine);
    return engine;
  }

  // ── ThoughtEngine ─────────────────────────────────────────────────────────────
  // Wires NeuralCanvas to the DOM engine and preserves the card spring-field.
  function ThoughtEngine(stage, el) {
    this.stage  = stage;
    this.el     = el;
    this.field  = stage.querySelector('.ws-stage__field');
    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cards  = [];
    this.origin = { x: 0, y: 0 };
    this.lastFrame   = 0;
    this.raf         = null;
    this.measureTimer = null;
    this.pulseTimer  = null;
    this.destroyed   = false;
    this.pulseStrength = 0;

    this.neural = new NeuralCanvas(stage, this.reduce);
    this.observe();
    this.measure();
  }

  ThoughtEngine.prototype.observe = function () {
    var self = this;
    if (this.field && window.MutationObserver) {
      this.mutationObserver = new MutationObserver(function () {
        clearTimeout(self.measureTimer);
        self.measureTimer = setTimeout(function () { self.measure(); }, 50);
      });
      this.mutationObserver.observe(this.field, { childList: true });
    }
    if (document.body && window.MutationObserver) {
      this.bodyObserver = new MutationObserver(function () {
        if (!document.body.classList.contains('ws-viewer-open') &&
            !document.body.classList.contains('assets-modal-open')) {
          clearTimeout(self.measureTimer);
          self.measureTimer = setTimeout(function () { self.measure(); }, 80);
        }
      });
      this.bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(function () {
        clearTimeout(self.measureTimer);
        self.measureTimer = setTimeout(function () { self.measure(); }, 120);
      });
      this.resizeObserver.observe(this.stage);
    }
  };

  /* Geometry sampled after field rebuild or resize. Frame loop writes, never reads. */
  ThoughtEngine.prototype.measure = function () {
    if (this.destroyed || !this.stage) return;
    this.field = this.stage.querySelector('.ws-stage__field') || this.stage;
    var sr = this.stage.getBoundingClientRect();
    this.origin.x = sr.width  / 2;
    this.origin.y = sr.height / 2;
    var slots = this.field.querySelectorAll('.af__slot');
    var self  = this;
    this.cards = Array.prototype.map.call(slots, function (el, idx) {
      var r   = el.getBoundingClientRect();
      var par = parseFloat(getComputedStyle(el).getPropertyValue('--par')) || 0.5;
      return {
        el: el,
        cx: r.left - sr.left + r.width  / 2,
        cy: r.top  - sr.top  + r.height / 2,
        mass: 0.72 + par * 0.58,
        fallbackAngle: (idx * 2.39996) % (Math.PI * 2),
        x: 0, y: 0, z: 0, r: 0,
        vx: 0, vy: 0, vz: 0, vr: 0,
      };
    });
    if (this.cards.length) this.wake();
  };

  ThoughtEngine.prototype.step = function (now) {
    var dt = Math.min(0.032, Math.max(0.008, (now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    var settled  = true;
    var radius   = Math.max(260, Math.min(430, Math.min(this.origin.x, this.origin.y) * 0.86));
    var progress = parseFloat(this.el.style.getPropertyValue('--thought-progress')) || 0;
    var strength = 108 + progress * 24 + this.pulseStrength * 52;
    var self = this;

    this.cards = this.cards.filter(function (c) { return c.el && c.el.isConnected; });

    this.cards.forEach(function (card) {
      var dx = card.cx - self.origin.x;
      var dy = card.cy - self.origin.y;
      var d  = Math.sqrt(dx * dx + dy * dy);
      if (d < 1) { dx = Math.cos(card.fallbackAngle); dy = Math.sin(card.fallbackAngle); d = 1; }
      var fo   = Math.max(0, 1 - d / radius); fo = fo * fo;
      var push = strength * fo * card.mass;
      var tx   = dx / d * push;
      var ty   = dy / d * push * 0.78;
      var tz   = fo * (10 + progress * 12 + self.pulseStrength * 12);
      var tr   = dx / d * fo * (2.2 + progress * 2.2);
      var k    = 24;
      var damp = Math.exp(-8.2 * dt);
      card.vx = (card.vx + (tx - card.x) * k * dt) * damp;
      card.vy = (card.vy + (ty - card.y) * k * dt) * damp;
      card.vz = (card.vz + (tz - card.z) * k * dt) * damp;
      card.vr = (card.vr + (tr - card.r) * k * dt) * damp;
      card.x += card.vx * dt * 60;
      card.y += card.vy * dt * 60;
      card.z += card.vz * dt * 60;
      card.r += card.vr * dt * 60;
      if (Math.abs(card.x)  > 0.12 || Math.abs(card.y)  > 0.12 ||
          Math.abs(card.z)  > 0.12 || Math.abs(card.vx) > 0.12 ||
          Math.abs(card.vy) > 0.12 || Math.abs(card.vz) > 0.12) settled = false;
      card.el.style.setProperty('--tx', card.x.toFixed(2) + 'px');
      card.el.style.setProperty('--ty', card.y.toFixed(2) + 'px');
      card.el.style.setProperty('--tz', card.z.toFixed(2) + 'px');
      card.el.style.setProperty('--tr', card.r.toFixed(2) + 'deg');
      card.el.style.setProperty('--ts', (1 + fo * (progress + self.pulseStrength) * 0.035).toFixed(3));
    });
    return settled;
  };

  ThoughtEngine.prototype.loop = function (now) {
    if (this.destroyed) return;
    if (document.hidden || this.stage.hidden || this.stage.classList.contains('is-hidden') ||
        document.body.classList.contains('ws-viewer-open') ||
        document.body.classList.contains('assets-modal-open')) {
      this.raf = null; return;
    }
    var settled = this.step(now);
    if (settled && this.pulseStrength === 0) { this.raf = null; return; }
    var self = this;
    this.raf = requestAnimationFrame(function (t) { self.loop(t); });
  };

  ThoughtEngine.prototype.wake = function () {
    if (this.destroyed || this.raf || !this.cards.length) return;
    var self = this;
    this.raf = requestAnimationFrame(function (t) { self.loop(t); });
  };

  ThoughtEngine.prototype.setState = function (state) {
    if (!this.el) return;
    this.el.dataset.state = state || 'idle';
    if (this.neural) this.neural.setState(state || 'idle');
    this.wake();
  };

  ThoughtEngine.prototype.setProgress = function (value) {
    if (!this.el) return;
    var p = Math.max(0, Math.min(1, Number(value) || 0));
    this.el.style.setProperty('--thought-progress', p.toFixed(3));
    this.el.style.setProperty('--thought-scale',    (0.92 + p * 0.06).toFixed(3));
    this.el.style.setProperty('--core-scale',       (0.94 + p * 0.12).toFixed(3));
    this.wake();
  };

  ThoughtEngine.prototype.pulse = function () {
    if (!this.el || this.reduce) return;
    var self = this;
    clearTimeout(this.pulseTimer);
    this.el.classList.remove('is-pulsing');
    void this.el.offsetWidth;
    this.el.classList.add('is-pulsing');
    this.pulseStrength = 1;
    if (this.neural) this.neural.pulse();
    this.wake();
    this.pulseTimer = setTimeout(function () {
      self.pulseStrength = 0; self.wake();
    }, 1100);
  };

  ThoughtEngine.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this.measureTimer);
    clearTimeout(this.pulseTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.mutationObserver) this.mutationObserver.disconnect();
    if (this.bodyObserver)     this.bodyObserver.disconnect();
    if (this.resizeObserver)   this.resizeObserver.disconnect();
    if (this.neural)           this.neural.destroy();
    this.cards.forEach(function (c) {
      ['--tx','--ty','--tz','--tr','--ts'].forEach(function (n) {
        c.el.style.removeProperty(n);
      });
    });
    if (this.el && this.el.parentNode) this.el.remove();
    this.el = null;
  };

  // ── Public API ───────────────────────────────────────────────────────────────
  function mount(stage) {
    if (!stage) return null;
    var existing = stage.querySelector('.thought-engine');
    if (existing) return new ThoughtEngine(stage, existing);
    return new ThoughtEngine(stage, makeEngine(stage));
  }

  window.TimrXThoughtEngine = { mount: mount };
})();
