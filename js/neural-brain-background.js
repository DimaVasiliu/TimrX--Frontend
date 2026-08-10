/* ==========================================================================
   TimrX Neural Brain Background
   --------------------------------------------------------------------------
   Procedural WebGL visual system for the workspace background only. It renders
   four depth layers: distant neural tissue, converging knowledge paths, a
   broken holographic brain, and foreground knowledge particles.
   ========================================================================== */
(function () {
  'use strict';

  var DPR_MAX = 1.65;
  var TAU = Math.PI * 2;
  var COLORS = {
    amber: [1.0, 0.53, 0.18],
    gold: [1.0, 0.72, 0.32],
    soft: [1.0, 0.94, 0.78],
    glass: [0.82, 0.72, 0.54]
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t * t * (3 - 2 * t); }

  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'Shader compile failed');
    }
    return shader;
  }

  function program(gl, vert, frag) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'Program link failed');
    }
    return p;
  }

  var LINE_VERT =
    'attribute vec2 a_pos;\n' +
    'attribute float a_alpha;\n' +
    'uniform vec2 u_resolution;\n' +
    'uniform vec2 u_offset;\n' +
    'uniform float u_alpha;\n' +
    'varying float v_alpha;\n' +
    'void main(){\n' +
    '  vec2 p = a_pos + u_offset;\n' +
    '  vec2 z = p / u_resolution;\n' +
    '  vec2 clip = z * 2.0 - 1.0;\n' +
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);\n' +
    '  v_alpha = a_alpha * u_alpha;\n' +
    '}\n';

  var LINE_FRAG =
    'precision mediump float;\n' +
    'uniform vec3 u_color;\n' +
    'varying float v_alpha;\n' +
    'void main(){ gl_FragColor = vec4(u_color, v_alpha); }\n';

  var POINT_VERT =
    'attribute vec2 a_pos;\n' +
    'attribute float a_size;\n' +
    'attribute float a_alpha;\n' +
    'uniform vec2 u_resolution;\n' +
    'uniform vec2 u_offset;\n' +
    'uniform float u_dpr;\n' +
    'uniform float u_alpha;\n' +
    'varying float v_alpha;\n' +
    'void main(){\n' +
    '  vec2 p = a_pos + u_offset;\n' +
    '  vec2 z = p / u_resolution;\n' +
    '  vec2 clip = z * 2.0 - 1.0;\n' +
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);\n' +
    '  gl_PointSize = max(1.0, a_size * u_dpr);\n' +
    '  v_alpha = a_alpha * u_alpha;\n' +
    '}\n';

  var POINT_FRAG =
    'precision mediump float;\n' +
    'uniform vec3 u_color;\n' +
    'varying float v_alpha;\n' +
    'void main(){\n' +
    '  vec2 c = gl_PointCoord - vec2(0.5);\n' +
    '  float d = length(c);\n' +
    '  float core = smoothstep(0.5, 0.02, d);\n' +
    '  float halo = smoothstep(0.5, 0.18, d) * 0.22;\n' +
    '  gl_FragColor = vec4(u_color, v_alpha * (core + halo));\n' +
    '}\n';

  function NeuralRenderer(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    });
    if (!this.gl) throw new Error('WebGL unavailable');

    var gl = this.gl;
    this.lineProgram = program(gl, LINE_VERT, LINE_FRAG);
    this.pointProgram = program(gl, POINT_VERT, POINT_FRAG);
    this.lineBuffer = gl.createBuffer();
    this.pointBuffer = gl.createBuffer();
    this.dpr = 1;
    this.w = 1;
    this.h = 1;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  }

  NeuralRenderer.prototype.resize = function (w, h, dpr) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = Math.min(DPR_MAX, dpr || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  };

  NeuralRenderer.prototype.clear = function () {
    var gl = this.gl;
    gl.clearColor(0.023, 0.023, 0.023, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  NeuralRenderer.prototype.drawLines = function (data, color, offset, alpha) {
    if (!data || data.length < 6) return;
    var gl = this.gl;
    var p = this.lineProgram;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    var stride = 12;
    var pos = gl.getAttribLocation(p, 'a_pos');
    var a = gl.getAttribLocation(p, 'a_alpha');
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(a, 1, gl.FLOAT, false, stride, 8);
    gl.uniform2f(gl.getUniformLocation(p, 'u_resolution'), this.w, this.h);
    gl.uniform2f(gl.getUniformLocation(p, 'u_offset'), offset[0], offset[1]);
    gl.uniform3f(gl.getUniformLocation(p, 'u_color'), color[0], color[1], color[2]);
    gl.uniform1f(gl.getUniformLocation(p, 'u_alpha'), alpha);
    gl.drawArrays(gl.LINES, 0, data.length / 3);
  };

  NeuralRenderer.prototype.drawPoints = function (data, color, offset, alpha) {
    if (!data || data.length < 4) return;
    var gl = this.gl;
    var p = this.pointProgram;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    var stride = 16;
    var pos = gl.getAttribLocation(p, 'a_pos');
    var size = gl.getAttribLocation(p, 'a_size');
    var a = gl.getAttribLocation(p, 'a_alpha');
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(size);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(size, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribPointer(a, 1, gl.FLOAT, false, stride, 12);
    gl.uniform2f(gl.getUniformLocation(p, 'u_resolution'), this.w, this.h);
    gl.uniform2f(gl.getUniformLocation(p, 'u_offset'), offset[0], offset[1]);
    gl.uniform1f(gl.getUniformLocation(p, 'u_dpr'), this.dpr);
    gl.uniform3f(gl.getUniformLocation(p, 'u_color'), color[0], color[1], color[2]);
    gl.uniform1f(gl.getUniformLocation(p, 'u_alpha'), alpha);
    gl.drawArrays(gl.POINTS, 0, data.length / 4);
  };

  function cubic(p0, p1, p2, p3, t) {
    var u = 1 - t;
    var tt = t * t;
    var uu = u * u;
    return {
      x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
      y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y
    };
  }

  function addSegment(out, a, b, alpha) {
    out.push(a.x, a.y, alpha, b.x, b.y, alpha);
  }

  function NetworkLayer(rand) {
    this.rand = rand;
    this.paths = [];
    this.farLines = new Float32Array(0);
    this.mainLines = new Float32Array(0);
  }

  NetworkLayer.prototype.edgePoint = function (w, h, cx, cy, quality) {
    var sourceMode = this.rand();
    var padding = Math.min(w, h) * 0.06;
    var x;
    var y;

    if (sourceMode < 0.58) {
      var edge = Math.floor(this.rand() * 4);
      if (edge === 0) {
        x = this.rand() * w;
        y = padding * (0.2 + this.rand() * 1.2);
      } else if (edge === 1) {
        x = w - padding * (0.2 + this.rand() * 1.2);
        y = this.rand() * h;
      } else if (edge === 2) {
        x = this.rand() * w;
        y = h - padding * (0.2 + this.rand() * 1.2);
      } else {
        x = padding * (0.2 + this.rand() * 1.2);
        y = this.rand() * h;
      }
    } else {
      x = this.rand() * w;
      y = this.rand() * h;
      var dx = x - cx;
      var dy = y - cy;
      var clearRadius = Math.min(w, h) * (quality.compact ? 0.34 : 0.42);
      if (dx * dx + dy * dy < clearRadius * clearRadius) {
        var a = Math.atan2(dy || this.rand() - 0.5, dx || this.rand() - 0.5);
        var r = clearRadius * (1.05 + this.rand() * 0.8);
        x = cx + Math.cos(a) * r;
        y = cy + Math.sin(a) * r;
      }
    }

    return {
      x: clamp(x, 0, w),
      y: clamp(y, 0, h),
      angle: Math.atan2(y - cy, x - cx)
    };
  };

  NetworkLayer.prototype.resize = function (w, h, quality) {
    var count = quality.compact ? 132 : 320;
    var farCount = quality.compact ? 92 : 260;
    var cx = w * 0.5;
    var cy = h * (quality.compact ? 0.43 : 0.46);
    var spread = Math.min(w, h) * 0.18;
    var far = [];
    var main = [];
    this.paths = [];

    for (var i = 0; i < farCount; i++) {
      var fieldPoint = this.edgePoint(w, h, cx, cy, quality);
      var angle = fieldPoint.angle;
      var tangent = this.rand() < 0.5 ? -1 : 1;
      var a = { x: fieldPoint.x, y: fieldPoint.y };
      var b = {
        x: lerp(a.x, cx, 0.08 + this.rand() * 0.3) - Math.sin(angle) * tangent * w * (0.04 + this.rand() * 0.1),
        y: lerp(a.y, cy, 0.08 + this.rand() * 0.3) + Math.cos(angle) * tangent * h * (0.04 + this.rand() * 0.1)
      };
      addSegment(far, a, b, 0.025 + this.rand() * 0.035);
    }

    for (var j = 0; j < count; j++) {
      var p0 = this.edgePoint(w, h, cx, cy, quality);
      var p3 = {
        x: cx + (this.rand() - 0.5) * spread,
        y: cy + (this.rand() - 0.5) * spread * 0.9
      };
      var sourceAngle = p0.angle || Math.atan2(p0.y - cy, p0.x - cx);
      var turn = this.rand() < 0.5 ? -1 : 1;
      var bend = Math.min(w, h) * (0.08 + this.rand() * 0.16);
      var p1 = {
        x: lerp(p0.x, p3.x, 0.18 + this.rand() * 0.18) - Math.sin(sourceAngle) * turn * bend,
        y: lerp(p0.y, p3.y, 0.18 + this.rand() * 0.18) + Math.cos(sourceAngle) * turn * bend
      };
      var p2 = {
        x: lerp(p0.x, p3.x, 0.58 + this.rand() * 0.22) + Math.sin(sourceAngle) * turn * bend * 0.45,
        y: lerp(p0.y, p3.y, 0.58 + this.rand() * 0.22) - Math.cos(sourceAngle) * turn * bend * 0.45
      };
      var path = { p0: p0, p1: p1, p2: p2, p3: p3, split: 0.35 + this.rand() * 0.42 };
      this.paths.push(path);

      var prev = p0;
      var segs = quality.compact ? 24 : 36;
      for (var k = 1; k <= segs; k++) {
        var t = k / segs;
        var pt = cubic(p0, p1, p2, p3, t);
        addSegment(main, prev, pt, (0.028 + 0.048 * t) * (0.7 + this.rand() * 0.6));
        prev = pt;
      }

      if (j % 3 === 0) {
        var root = cubic(p0, p1, p2, p3, path.split);
        var dir = this.rand() < 0.5 ? -1 : 1;
        var branch = {
          x: root.x + dir * (44 + this.rand() * 120),
          y: root.y + (this.rand() - 0.5) * 90
        };
        addSegment(main, root, branch, 0.026 + this.rand() * 0.04);
      }
    }

    this.farLines = new Float32Array(far);
    this.mainLines = new Float32Array(main);
  };

  function BrainSystem(rand) {
    this.rand = rand;
    this.nodes = [];
    this.links = [];
    this.fragments = [];
    this.rings = [];
    this.pulses = [];
    this.cx = 0;
    this.cy = 0;
    this.radius = 160;
  }

  BrainSystem.prototype.resize = function (w, h, quality) {
    this.cx = w * 0.5;
    this.cy = h * (quality.compact ? 0.43 : 0.45);
    /* Depth: the brain sits far back in the scene. Smaller silhouette +
       dimmer light + near-zero parallax (see draw()) read as distance;
       the knowledge streams keep full parallax as the near field. */
    this.radius = clamp(Math.min(w, h) * (quality.compact ? 0.25 : 0.27), 110, 300);
    this.nodes = [];
    this.links = [];
    this.fragments = [];
    this.rings = [];
    var nodeCount = quality.compact ? 270 : 520;

    for (var i = 0; i < nodeCount; i++) {
      var side = this.rand() < 0.5 ? -1 : 1;
      var a = this.rand() * TAU;
      var rr = Math.pow(this.rand(), 0.52);
      var fissure = Math.abs(Math.cos(a)) < 0.13 && this.rand() < 0.65;
      if (fissure) continue;
      var lobeX = side * this.radius * 0.29;
      var x = this.cx + lobeX + Math.cos(a) * this.radius * (0.38 + this.rand() * 0.12) * rr;
      var y = this.cy + Math.sin(a) * this.radius * (0.50 + this.rand() * 0.13) * rr;
      y += Math.sin((x - this.cx) * 0.035) * this.radius * 0.035;
      if (y > this.cy + this.radius * 0.48 && this.rand() < 0.28) continue;
      this.nodes.push({
        x: x,
        y: y,
        ox: x - this.cx,
        oy: y - this.cy,
        size: 1.1 + this.rand() * 2.4,
        depth: 0.35 + this.rand() * 0.9,
        activity: this.rand() * 0.08,
        phase: this.rand() * TAU
      });
    }

    var maxDist = this.radius * 0.18;
    for (var n = 0; n < this.nodes.length; n++) {
      var made = 0;
      for (var m = n + 1; m < this.nodes.length && made < 4; m++) {
        var dx = this.nodes[n].x - this.nodes[m].x;
        var dy = this.nodes[n].y - this.nodes[m].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < maxDist && this.rand() > 0.54) {
          this.links.push({ a: n, b: m, alpha: 0.055 + this.rand() * 0.09, phase: this.rand() * TAU });
          made++;
        }
      }
    }

    var fragCount = quality.compact ? 34 : 68;
    for (var f = 0; f < fragCount; f++) {
      this.fragments.push({
        orbit: this.radius * (0.72 + this.rand() * 0.75),
        angle: this.rand() * TAU,
        speed: (0.000025 + this.rand() * 0.00008) * (this.rand() < 0.5 ? -1 : 1),
        size: this.radius * (0.025 + this.rand() * 0.045),
        sides: this.rand() < 0.55 ? 3 : 4,
        tilt: this.rand() * TAU,
        alpha: 0.07 + this.rand() * 0.13
      });
    }

    for (var r = 0; r < (quality.compact ? 6 : 10); r++) {
      this.rings.push({
        radius: this.radius * (0.58 + r * 0.12),
        squash: 0.48 + this.rand() * 0.2,
        angle: this.rand() * TAU,
        speed: (0.000035 + this.rand() * 0.000085) * (r % 2 ? -1 : 1),
        gap: 0.7 + this.rand() * 1.4,
        alpha: 0.05 + this.rand() * 0.07
      });
    }
  };

  BrainSystem.prototype.transform = function (node, time, breath) {
    var rot = Math.sin(time * 0.00008) * 0.035;
    var c = Math.cos(rot);
    var s = Math.sin(rot);
    var x = node.ox * c - node.oy * s;
    var y = node.ox * s + node.oy * c;
    /* Far objects drift less in absolute pixels — large excursions read as
       "close". */
    var drift = Math.sin(time * 0.00022 + node.phase) * 1.25 * node.depth;
    return {
      x: this.cx + x * breath + drift,
      y: this.cy + y * breath + Math.cos(time * 0.00018 + node.phase) * 0.9 * node.depth
    };
  };

  BrainSystem.prototype.trigger = function (x, y) {
    this.pulses.push({ x: x || this.cx, y: y || this.cy, age: 0, life: 1500 });
    for (var i = 0; i < 8; i++) {
      var node = this.nodes[Math.floor(this.rand() * this.nodes.length)];
      if (node) node.activity = 1;
    }
  };

  BrainSystem.prototype.update = function (dt, time, reduce) {
    var i;
    for (i = 0; i < this.nodes.length; i++) {
      this.nodes[i].activity *= Math.pow(0.986, dt / 16.7);
      this.nodes[i].activity = Math.max(0.025, this.nodes[i].activity);
    }
    if (!reduce) {
      for (i = this.pulses.length - 1; i >= 0; i--) {
        var p = this.pulses[i];
        p.age += dt;
        var wave = ease(clamp(p.age / p.life, 0, 1)) * this.radius * 1.3;
        for (var n = 0; n < this.nodes.length; n++) {
          var node = this.nodes[n];
          var dx = node.x - p.x;
          var dy = node.y - p.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (Math.abs(d - wave) < this.radius * 0.09) {
            node.activity = Math.max(node.activity, 0.85 * (1 - p.age / p.life));
          }
        }
        if (p.age >= p.life) this.pulses.splice(i, 1);
      }
    }
    if (!reduce && this.rand() < 0.0022) this.trigger();
  };

  BrainSystem.prototype.buildBuffers = function (time, reduce) {
    var breath = reduce ? 1 : 1 + Math.sin(time * 0.00042) * 0.018;
    var line = [];
    var points = [];
    var glow = [];
    var ringLines = [];
    var transformed = [];
    var i;

    for (i = 0; i < this.nodes.length; i++) {
      transformed[i] = this.transform(this.nodes[i], time, breath);
      var n = this.nodes[i];
      var a = (0.12 + n.activity * 0.72) * 0.9;
      points.push(transformed[i].x, transformed[i].y, (n.size + n.activity * 2.2) * 0.8, a);
      if (n.activity > 0.14) {
        glow.push(transformed[i].x, transformed[i].y, (14 + n.activity * 18) * 0.78, n.activity * 0.14);
      }
    }

    for (i = 0; i < this.links.length; i++) {
      var link = this.links[i];
      var na = this.nodes[link.a];
      var nb = this.nodes[link.b];
      var pulse = Math.max(na.activity, nb.activity);
      var alpha = link.alpha + pulse * 0.32 + (reduce ? 0 : Math.sin(time * 0.00035 + link.phase) * 0.018);
      addSegment(line, transformed[link.a], transformed[link.b], clamp(alpha, 0.02, 0.5));
    }

    for (i = 0; i < this.rings.length; i++) {
      var ring = this.rings[i];
      var start = ring.angle + (reduce ? 0 : time * ring.speed);
      var total = TAU - ring.gap;
      var segs = 44;
      var prev = null;
      for (var k = 0; k <= segs; k++) {
        var t = k / segs;
        var a0 = start + total * t;
        var rr = ring.radius;
        var p = {
          x: this.cx + Math.cos(a0) * rr,
          y: this.cy + Math.sin(a0) * rr * ring.squash
        };
        if (prev) addSegment(ringLines, prev, p, ring.alpha);
        prev = p;
      }
    }

    for (i = 0; i < this.fragments.length; i++) {
      var frag = this.fragments[i];
      var fa = frag.angle + (reduce ? 0 : time * frag.speed);
      var fx = this.cx + Math.cos(fa) * frag.orbit;
      var fy = this.cy + Math.sin(fa) * frag.orbit * 0.52;
      var local = [];
      for (var s = 0; s < frag.sides; s++) {
        var aa = frag.tilt + s / frag.sides * TAU + (reduce ? 0 : time * frag.speed * 8);
        local.push({
          x: fx + Math.cos(aa) * frag.size * (0.75 + (s % 2) * 0.28),
          y: fy + Math.sin(aa) * frag.size * (0.65 + ((s + 1) % 2) * 0.22)
        });
      }
      for (var q = 0; q < local.length; q++) {
        addSegment(ringLines, local[q], local[(q + 1) % local.length], frag.alpha);
      }
    }

    return {
      lines: new Float32Array(line),
      points: new Float32Array(points),
      glow: new Float32Array(glow),
      rings: new Float32Array(ringLines)
    };
  };

  function KnowledgeStreams(rand, network) {
    this.rand = rand;
    this.network = network;
    this.items = [];
    this.max = 0;
    this.speedBoost = 1;
  }

  KnowledgeStreams.prototype.resize = function (quality) {
    this.max = quality.compact ? 1250 : 4200;
    this.speedBoost = quality.compact ? 1.45 : 1;
    this.items = [];
    for (var i = 0; i < this.max; i++) {
      this.items.push(this.spawn(i > this.max * 0.7));
    }
  };

  KnowledgeStreams.prototype.spawn = function (quiet) {
    var path = this.network.paths[Math.floor(this.rand() * this.network.paths.length)];
    return {
      path: path,
      t: quiet ? -this.rand() : this.rand(),
      speed: 0.000035 + this.rand() * 0.00012,
      size: 1.1 + this.rand() * 2.3,
      phase: this.rand() * TAU,
      pause: this.rand() < 0.18 ? this.rand() * 700 : 0,
      alpha: 0.35 + this.rand() * 0.65
    };
  };

  KnowledgeStreams.prototype.update = function (dt, brain, reduce) {
    if (reduce) return;
    for (var i = 0; i < this.items.length; i++) {
      var p = this.items[i];
      if (p.pause > 0) {
        p.pause -= dt;
        continue;
      }
      var wobble = 1 + Math.sin(p.phase + p.t * TAU) * 0.18;
      p.t += p.speed * dt * wobble * this.speedBoost;
      if (p.t >= 1) {
        var end = cubic(p.path.p0, p.path.p1, p.path.p2, p.path.p3, 1);
        brain.trigger(end.x, end.y);
        this.items[i] = this.spawn(false);
        this.items[i].t = -this.rand() * 0.15;
      } else if (p.t > 0.35 && p.t < 0.82 && this.rand() < 0.00035) {
        p.pause = 160 + this.rand() * 520;
      }
    }
  };

  KnowledgeStreams.prototype.buffer = function () {
    var out = [];
    var glow = [];
    for (var i = 0; i < this.items.length; i++) {
      var p = this.items[i];
      if (p.t < 0 || p.t > 1) continue;
      var pos = cubic(p.path.p0, p.path.p1, p.path.p2, p.path.p3, p.t);
      var fade = p.t < 0.16 ? 0.28 + (p.t / 0.16) * 0.72 : p.t > 0.9 ? 0.38 + ((1 - p.t) / 0.1) * 0.62 : 1;
      var alpha = clamp(fade, 0, 1) * p.alpha;
      out.push(pos.x, pos.y, p.size, alpha * 0.72);
      if (alpha > 0.2) glow.push(pos.x, pos.y, p.size * 5.4, alpha * 0.075);
    }
    return { points: new Float32Array(out), glow: new Float32Array(glow) };
  };

  function NeuralBrainBackground(canvas) {
    this.canvas = canvas;
    this.stage = canvas.closest('.ws-stage') || canvas.parentNode;
    this.rand = makeRandom(880822);
    this.renderer = null;
    this.network = new NetworkLayer(this.rand);
    this.brain = new BrainSystem(this.rand);
    this.streams = new KnowledgeStreams(this.rand, this.network);
    this.raf = null;
    this.last = 0;
    this.visible = true;
    this.reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduce = this.reduceQuery.matches;
    this.mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    this.quality = { compact: false };

    /* Intro state. While the workspace loader owns the screen the scene
       idles dim ("dormant"); wake() — called by the loader at handoff —
       runs a birth ramp so the reveal and the scene are one movement.
       Pages without the loader wake instantly. */
    this.awake = false;
    this.introStart = 0;
    this.introDur = 2100;
    this.dormantLevel = 0.14;
    this.readyAnnounced = false;
    this.hasLoader = !!document.getElementById('workspaceLoader');

    this.onResize = this.resize.bind(this);
    this.onMove = this.pointer.bind(this);
    this.onVisibility = this.visibility.bind(this);
    this.onReduce = this.motionPreference.bind(this);
  }

  NeuralBrainBackground.prototype.start = function () {
    try {
      this.renderer = new NeuralRenderer(this.canvas);
    } catch (err) {
      this.stage.style.backgroundImage = 'radial-gradient(circle at 50% 45%, rgba(255,179,71,.16), transparent 22%), #060606';
      return;
    }
    this.resize();
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('pointermove', this.onMove, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.reduceQuery.addEventListener) {
      this.reduceQuery.addEventListener('change', this.onReduce);
    } else if (this.reduceQuery.addListener) {
      this.reduceQuery.addListener(this.onReduce);
    }
    if (!this.hasLoader || this.reduce) {
      this.wake();
    } else {
      /* Defensive: if the loader dies before calling wake(), the scene must
         still come to life on its own. */
      var self = this;
      window.setTimeout(function () { self.wake(); }, 9000);
    }
    this.loop(performance.now());
  };

  NeuralBrainBackground.prototype.wake = function () {
    if (this.awake) return;
    this.awake = true;
    this.introStart = performance.now();
    this.brain.trigger();
    this.last = performance.now();
    if (!this.raf && this.visible && this.renderer) this.loop(this.last);
  };

  NeuralBrainBackground.prototype.introFactor = function (now) {
    if (this.reduce) return 1;
    if (!this.awake) return this.dormantLevel;
    var t = clamp((now - this.introStart) / this.introDur, 0, 1);
    return this.dormantLevel + (1 - this.dormantLevel) * ease(t);
  };

  NeuralBrainBackground.prototype.resize = function () {
    var rect = this.stage.getBoundingClientRect();
    var w = rect.width || window.innerWidth;
    var h = rect.height || window.innerHeight;
    this.quality.compact = w < 760 || h < 620;
    this.renderer.resize(w, h, window.devicePixelRatio || 1);
    this.network.resize(w, h, this.quality);
    this.brain.resize(w, h, this.quality);
    this.streams.resize(this.quality);
    this.draw(performance.now(), 16);
  };

  NeuralBrainBackground.prototype.pointer = function (event) {
    if (this.reduce) return;
    var rect = this.stage.getBoundingClientRect();
    this.mouse.tx = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 34;
    this.mouse.ty = ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 28;
  };

  NeuralBrainBackground.prototype.visibility = function () {
    this.visible = !document.hidden;
    this.last = performance.now();
    if (this.visible && !this.raf) this.loop(this.last);
  };

  NeuralBrainBackground.prototype.motionPreference = function () {
    this.reduce = this.reduceQuery.matches;
    this.last = performance.now();
    this.draw(this.last, 16);
    if (!this.reduce && !this.raf && this.visible) this.loop(this.last);
  };

  NeuralBrainBackground.prototype.loop = function (now) {
    if (!this.renderer) return;
    this.raf = null;
    if (!this.visible) return;
    var dt = Math.min(48, Math.max(8, now - (this.last || now)));
    this.last = now;
    this.draw(now, dt);
    if (!this.reduce) {
      var self = this;
      this.raf = requestAnimationFrame(function (t) { self.loop(t); });
    }
  };

  NeuralBrainBackground.prototype.draw = function (now, dt) {
    this.mouse.x += (this.mouse.tx - this.mouse.x) * 0.035;
    this.mouse.y += (this.mouse.ty - this.mouse.y) * 0.035;
    this.brain.update(dt, now, this.reduce);
    this.streams.update(dt, this.brain, this.reduce);

    var r = this.renderer;
    var brainBuffers = this.brain.buildBuffers(now, this.reduce);
    var streamBuffers = this.streams.buffer();

    /* Birth ramp: everything scales with the intro factor; the knowledge
       streams join last (they read as "activity", which the brain earns
       only once it is visibly alive). */
    var k = this.introFactor(now);
    var kStreams = clamp((k - 0.45) / 0.55, 0, 1);

    /* Depth-graded parallax: the brain and its rings barely respond to the
       pointer (far field), the network shell moves a little (mid field), and
       the knowledge streams sweep with the cursor (near field). The contrast
       between those three rates is what sells the distance. Alphas fall off
       with depth the same way — atmospheric haze over the black. */
    r.clear();
    r.drawLines(this.network.farLines, COLORS.glass, [this.mouse.x * 0.03, this.mouse.y * 0.03], 0.5 * k);
    r.drawLines(this.network.mainLines, COLORS.amber, [this.mouse.x * 0.09, this.mouse.y * 0.09], 0.62 * k);
    r.drawLines(brainBuffers.rings, COLORS.gold, [this.mouse.x * 0.045, this.mouse.y * 0.045], 0.74 * k);
    r.drawPoints(brainBuffers.glow, COLORS.amber, [this.mouse.x * 0.04, this.mouse.y * 0.04], 0.85 * k);
    r.drawLines(brainBuffers.lines, COLORS.soft, [this.mouse.x * 0.04, this.mouse.y * 0.04], 0.72 * k);
    r.drawPoints(brainBuffers.points, COLORS.soft, [this.mouse.x * 0.04, this.mouse.y * 0.04], 0.82 * k);
    if (kStreams > 0.01) {
      r.drawPoints(streamBuffers.glow, COLORS.gold, [this.mouse.x * 0.54, this.mouse.y * 0.54], 1.0 * kStreams);
      r.drawPoints(streamBuffers.points, COLORS.amber, [this.mouse.x * 0.54, this.mouse.y * 0.54], 0.95 * kStreams);
    }

    if (!this.readyAnnounced) {
      this.readyAnnounced = true;
      try {
        document.dispatchEvent(new CustomEvent('timrx:brain-ready'));
      } catch (err) { /* decorative */ }
    }
  };

  function mount() {
    var canvas = document.getElementById('neuralBrainBg');
    if (!canvas) return;
    var background = new NeuralBrainBackground(canvas);
    window.timrxNeuralBrainBackground = background;
    background.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
