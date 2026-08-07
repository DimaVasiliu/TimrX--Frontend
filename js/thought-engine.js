/* ============================================================================
   TimrX Thought Engine
   ----------------------------------------------------------------------------
   The engine is persistent stage chrome. It owns the visual core and a small
   spring field that gives the core physical presence among the live cards.
   ============================================================================ */
(function () {
  'use strict';

  var PARTICLES = [
    /* inner cluster */
    [-22, -14, 1.2], [18, -22, 1.5], [32, 10, 1.3], [12, 28, 1.6],
    [-28, 18, 1.1], [-8, -36, 1.4], [36, -14, 1.0], [-36, 26, 1.2],
    /* mid ring — brain-wide spread */
    [-58, -22, .9], [-44, -52, 1.1], [14, -62, 1.3], [52, -42, .9],
    [68, 8,  .8],  [58, 44,  1.0], [22, 66,  1.2], [-22, 64, .9],
    [-64, 32, .8], [-72, -8, .7],
    /* outer sparse — wider x to fill brain lobes */
    [-84, -18, .6], [82, -12, .6], [-52, -74, .7], [50, -72, .7],
    [-48, 78, .6],  [44, 76,  .6]
  ];

  function makeParticles(host) {
    var wrap = document.createElement('span');
    wrap.className = 'thought-engine__particles';
    wrap.setAttribute('aria-hidden', 'true');
    PARTICLES.forEach(function (particle, index) {
      var dot = document.createElement('i');
      dot.className = 'thought-engine__particle';
      dot.style.setProperty('--particle-x', particle[0] + '%');
      dot.style.setProperty('--particle-y', particle[1] + '%');
      dot.style.setProperty('--particle-size', particle[2] + 'px');
      dot.style.setProperty('--particle-delay', (index * -0.58) + 's');
      wrap.appendChild(dot);
    });
    host.appendChild(wrap);
  }

  function makeEngine(host) {
    var engine = document.createElement('div');
    engine.className = 'thought-engine';
    engine.dataset.state = 'idle';
    engine.setAttribute('aria-hidden', 'true');
    engine.innerHTML =
      /* 6 orbital rings — 3D brain wireframe */
      '<span class="thought-engine__orbit thought-engine__orbit--a"></span>' +
      '<span class="thought-engine__orbit thought-engine__orbit--b"></span>' +
      '<span class="thought-engine__orbit thought-engine__orbit--c"></span>' +
      '<span class="thought-engine__orbit thought-engine__orbit--d"></span>' +
      '<span class="thought-engine__orbit thought-engine__orbit--e"></span>' +
      '<span class="thought-engine__orbit thought-engine__orbit--f"></span>' +
      /* 5 filaments — neural pathway arcs */
      '<span class="thought-engine__filament thought-engine__filament--a"></span>' +
      '<span class="thought-engine__filament thought-engine__filament--b"></span>' +
      '<span class="thought-engine__filament thought-engine__filament--c"></span>' +
      '<span class="thought-engine__filament thought-engine__filament--d"></span>' +
      '<span class="thought-engine__filament thought-engine__filament--e"></span>' +
      /* 8 neuron pulses */
      '<span class="thought-engine__thought thought-engine__thought--a"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--b"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--c"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--d"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--e"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--f"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--g"></span>' +
      '<span class="thought-engine__thought thought-engine__thought--h"></span>' +
      /* dimensional axis guides */
      '<span class="thought-engine__axis thought-engine__axis--x"></span>' +
      '<span class="thought-engine__axis thought-engine__axis--y"></span>' +
      /* brain fold — interhemispheric groove */
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

  function ThoughtEngine(stage, el) {
    this.stage = stage;
    this.el = el;
    this.field = stage.querySelector('.ws-stage__field');
    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cards = [];
    this.origin = { x: 0, y: 0 };
    this.lastFrame = 0;
    this.raf = null;
    this.measureTimer = null;
    this.pulseTimer = null;
    this.destroyed = false;
    this.pulseStrength = 0;
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

  /* Geometry is sampled only after a field rebuild or resize. The frame loop
     writes transforms, never reads layout. */
  ThoughtEngine.prototype.measure = function () {
    if (this.destroyed || !this.stage) return;
    this.field = this.stage.querySelector('.ws-stage__field') || this.stage;
    var stageRect = this.stage.getBoundingClientRect();
    this.origin.x = stageRect.width / 2;
    this.origin.y = stageRect.height / 2;
    var slots = this.field.querySelectorAll('.af__slot');
    var self = this;
    this.cards = Array.prototype.map.call(slots, function (el, index) {
      var rect = el.getBoundingClientRect();
      var par = parseFloat(getComputedStyle(el).getPropertyValue('--par')) || .5;
      return {
        el: el,
        cx: rect.left - stageRect.left + rect.width / 2,
        cy: rect.top - stageRect.top + rect.height / 2,
        mass: .72 + par * .58,
        fallbackAngle: (index * 2.39996) % (Math.PI * 2),
        x: 0, y: 0, z: 0, r: 0,
        vx: 0, vy: 0, vz: 0, vr: 0
      };
    });
    if (self.cards.length) this.wake();
  };

  ThoughtEngine.prototype.step = function (now) {
    var dt = Math.min(.032, Math.max(.008, (now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    var settled = true;
    var radius = Math.max(260, Math.min(430, Math.min(this.origin.x, this.origin.y) * .86));
    var progress = parseFloat(this.el.style.getPropertyValue('--thought-progress')) || 0;
    var strength = 108 + progress * 24 + this.pulseStrength * 52;
    var self = this;

    this.cards = this.cards.filter(function (card) {
      return card.el && card.el.isConnected;
    });

    this.cards.forEach(function (card) {
      var dx = card.cx - self.origin.x;
      var dy = card.cy - self.origin.y;
      var distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 1) {
        dx = Math.cos(card.fallbackAngle);
        dy = Math.sin(card.fallbackAngle);
        distance = 1;
      }
      var falloff = Math.max(0, 1 - distance / radius);
      falloff = falloff * falloff;
      var push = strength * falloff * card.mass;
      var tx = dx / distance * push;
      var ty = dy / distance * push * .78;
      var tz = falloff * (10 + progress * 12 + this.pulseStrength * 12);
      var tr = dx / distance * falloff * (2.2 + progress * 2.2);
      var stiffness = 24;
      var damping = Math.exp(-8.2 * dt);

      card.vx = (card.vx + (tx - card.x) * stiffness * dt) * damping;
      card.vy = (card.vy + (ty - card.y) * stiffness * dt) * damping;
      card.vz = (card.vz + (tz - card.z) * stiffness * dt) * damping;
      card.vr = (card.vr + (tr - card.r) * stiffness * dt) * damping;
      card.x += card.vx * dt * 60;
      card.y += card.vy * dt * 60;
      card.z += card.vz * dt * 60;
      card.r += card.vr * dt * 60;

      if (Math.abs(card.x) > .12 || Math.abs(card.y) > .12 || Math.abs(card.z) > .12 ||
          Math.abs(card.vx) > .12 || Math.abs(card.vy) > .12 || Math.abs(card.vz) > .12) {
        settled = false;
      }
      card.el.style.setProperty('--tx', card.x.toFixed(2) + 'px');
      card.el.style.setProperty('--ty', card.y.toFixed(2) + 'px');
      card.el.style.setProperty('--tz', card.z.toFixed(2) + 'px');
      card.el.style.setProperty('--tr', card.r.toFixed(2) + 'deg');
      card.el.style.setProperty('--ts', (1 + falloff * (progress + self.pulseStrength) * .035).toFixed(3));
    }, this);

    return settled;
  };

  ThoughtEngine.prototype.loop = function (now) {
    if (this.destroyed) return;
    if (document.hidden || this.stage.hidden || this.stage.classList.contains('is-hidden') ||
        document.body.classList.contains('ws-viewer-open') || document.body.classList.contains('assets-modal-open')) {
      this.raf = null;
      return;
    }
    var settled = this.step(now);
    if (settled && this.pulseStrength === 0) {
      this.raf = null;
      return;
    }
    var self = this;
    this.raf = requestAnimationFrame(function (time) { self.loop(time); });
  };

  ThoughtEngine.prototype.wake = function () {
    if (this.destroyed || this.raf || !this.cards.length) return;
    var self = this;
    this.raf = requestAnimationFrame(function (time) { self.loop(time); });
  };

  ThoughtEngine.prototype.setState = function (state) {
    if (!this.el) return;
    this.el.dataset.state = state || 'idle';
    this.wake();
  };

  ThoughtEngine.prototype.setProgress = function (value) {
    if (!this.el) return;
    var progress = Math.max(0, Math.min(1, Number(value) || 0));
    this.el.style.setProperty('--thought-progress', progress.toFixed(3));
    this.el.style.setProperty('--thought-scale', (0.92 + progress * .06).toFixed(3));
    this.el.style.setProperty('--core-scale', (0.94 + progress * .12).toFixed(3));
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
    this.wake();
    this.pulseTimer = setTimeout(function () {
      self.pulseStrength = 0;
      self.wake();
    }, 1100);
  };

  ThoughtEngine.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this.measureTimer);
    clearTimeout(this.pulseTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.mutationObserver) this.mutationObserver.disconnect();
    if (this.bodyObserver) this.bodyObserver.disconnect();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.cards.forEach(function (card) {
      ['--tx', '--ty', '--tz', '--tr', '--ts'].forEach(function (name) {
        card.el.style.removeProperty(name);
      });
    });
    if (this.el && this.el.parentNode) this.el.remove();
    this.el = null;
  };

  function mount(stage) {
    if (!stage) return null;
    var existing = stage.querySelector('.thought-engine');
    if (existing) return new ThoughtEngine(stage, existing);
    return new ThoughtEngine(stage, makeEngine(stage));
  }

  window.TimrXThoughtEngine = { mount: mount };
})();
