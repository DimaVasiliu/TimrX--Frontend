/* =============================================================================
   TimrX Workspace — Command Palette
   -----------------------------------------------------------------------------
   Replaces the old header nav (HOME / HUB / COMMUNITY / MY ASSETS / MENU / Blogs).

   Destination rows are authored as real <a href> anchors in 3dprint.html so the
   internal links stay in the served HTML. This file only:
     1. injects the tool + workspace-action rows above them,
     2. filters and reorders on input,
     3. runs the keyboard model (open, arrow, enter, escape, focus restore).

   Tool icons are cloned from the existing rail buttons, so the palette can never
   drift out of sync with the rail.
   ========================================================================== */
(function () {
  'use strict';

  var root   = document.getElementById('wsCmd');
  var panel  = root && root.querySelector('.ws-cmd__panel');
  var input  = document.getElementById('wsCmdInput');
  var list   = document.getElementById('wsCmdList');
  var empty  = document.getElementById('wsCmdEmpty');
  var count  = document.getElementById('wsCmdCount');
  var trigger = document.getElementById('wsCmdTrigger');

  if (!root || !panel || !input || !list) return;

  var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  var lastFocus = null;
  var items = [];      // live, in DOM order
  var active = -1;
  var idSeq = 0;

  /* ---------------------------------------------------------------------------
     Show the right modifier on the trigger chip
     ------------------------------------------------------------------------ */
  document.querySelectorAll('[data-cmd-mod]').forEach(function (el) {
    el.textContent = isMac ? '⌘' : 'Ctrl';
  });

  /* ---------------------------------------------------------------------------
     Actions — things that happen in the workspace rather than navigate away.
     `run` is called with the palette already closed.
     ------------------------------------------------------------------------ */
  /* The dock and the palette share one activation API. 3dprint-app.js owns the
     workspace state; the command palette only asks it to activate a panel. */
  function activateTool(t) {
    if (window.TimrXWorkspace && typeof window.TimrXWorkspace.activatePanel === 'function') {
      window.TimrXWorkspace.activatePanel(t.key);
      return;
    }
    if (t.group === 'mode') {
      var mode = document.querySelector('.rail-btn[data-panel="' + t.key + '"]');
      if (mode) mode.click();
      return;
    }
    var model = document.querySelector('.rail-btn[data-panel="model"]');
    if (model && !model.classList.contains('is-active')) model.click();
    var tray = document.querySelector('.model-feature-btn[data-model-panel="' + t.key + '"]');
    if (tray) tray.click();
  }

  var TOOLS = [
    { key: 'model',   group: 'mode',  icon: 'cmdi-model',   label: 'Text or image to 3D', hint: 'Model',
      kw: 'model 3d mesh generate create text image to 3d meshy' },
    { key: 'image',   group: 'mode',  icon: 'cmdi-image',   label: 'Generate image',      hint: 'Image',
      kw: 'image picture 2d art flux ideogram recraft imagen openai nano banana' },
    { key: 'video',   group: 'mode',  icon: 'cmdi-video',   label: 'Generate video',      hint: 'Video',
      kw: 'video clip motion veo seedance footage' },
    { key: 'remesh',  group: 'model', icon: 'cmdi-remesh',  label: 'Remesh',              hint: 'Model',
      kw: 'remesh retopology topology polycount quad triangle print prep optimise optimize' },
    { key: 'texture', group: 'model', icon: 'cmdi-texture', label: 'Texture',             hint: 'Model',
      kw: 'texture pbr material paint surface colour color' },
    { key: 'rig',     group: 'model', icon: 'cmdi-rig',     label: 'Rig',                 hint: 'Model',
      kw: 'rig rigging skeleton bones armature character' },
    { key: 'animate', group: 'model', icon: 'cmdi-animate', label: 'Animate',             hint: 'Model',
      kw: 'animate animation motion library walk run idle' }
  ];

  var ACTIONS = [
    {
      label: 'My assets', icon: 'cmdi-grid',
      kw: 'assets history library gallery my generations past work',
      run: function () {
        var link = document.querySelector('[data-open-assets]');
        if (link) link.click();
      }
    },
    {
      label: 'Inspire — browse ideas', icon: 'cmdi-learn',
      kw: 'inspire inspiration ideas discover prompts examples gallery',
      run: function () {
        if (window.TimrXInspire && typeof window.TimrXInspire.open === 'function') {
          window.TimrXInspire.open();
          return;
        }
        var btn = document.getElementById('inspireTriggerBtn');
        if (btn) btn.click();
      }
    },
    {
      label: 'Notifications', icon: 'cmdi-bell',
      kw: 'notifications alerts bell updates jobs messages',
      run: function () {
        var bell = document.getElementById('notificationBell');
        if (bell) bell.click();
      }
    }
  ];

  /* ---------------------------------------------------------------------------
     Build the injected rows
     ------------------------------------------------------------------------ */
  function makeRow(opts) {
    var el = document.createElement(opts.href ? 'a' : 'button');
    if (opts.href) {
      el.href = opts.href;
    } else {
      el.type = 'button';
    }
    el.className = 'ws-cmd__item';
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.id = 'wsCmdItem' + (idSeq++);
    el.dataset.cmdKeywords = opts.kw || '';
    if (opts.searchOnly) el.dataset.cmdSearchOnly = 'true';

    if (opts.iconNode) {
      opts.iconNode.setAttribute('class', 'ws-cmd__item-icon');
      opts.iconNode.setAttribute('aria-hidden', 'true');
      opts.iconNode.removeAttribute('width');
      opts.iconNode.removeAttribute('height');
      el.appendChild(opts.iconNode);
    } else if (opts.icon) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ws-cmd__item-icon');
      svg.setAttribute('aria-hidden', 'true');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + opts.icon);
      svg.appendChild(use);
      el.appendChild(svg);
    }

    var label = document.createElement('span');
    label.className = 'ws-cmd__item-label';
    label.textContent = opts.label;
    el.appendChild(label);

    if (opts.meta) {
      var meta = document.createElement('span');
      meta.className = 'ws-cmd__item-meta';
      meta.textContent = opts.meta;
      el.appendChild(meta);
    }

    if (opts.run) el.__cmdRun = opts.run;
    return el;
  }

  function group(name, labelText) {
    var g = document.createElement('div');
    g.className = 'ws-cmd__group';
    g.dataset.cmdGroup = name;
    var p = document.createElement('p');
    p.className = 'ws-cmd__group-label';
    p.setAttribute('role', 'presentation');
    p.textContent = labelText;
    g.appendChild(p);
    return g;
  }

  (function injectRows() {
    var goGroup = list.querySelector('[data-cmd-group="go"]');

    var toolGroup = group('tools', 'Tools');
    TOOLS.forEach(function (t) {
      toolGroup.appendChild(makeRow({
        label: t.label, meta: t.hint, kw: t.kw, icon: t.icon,
        searchOnly: true,
        run: function () { activateTool(t); }
      }));
    });

    var actionGroup = group('actions', 'Workspace');
    ACTIONS.forEach(function (a) {
      actionGroup.appendChild(makeRow(a));
    });

    list.insertBefore(toolGroup, goGroup);
    list.insertBefore(actionGroup, goGroup);

    // Give the authored anchors ids so aria-activedescendant can point at them.
    list.querySelectorAll('[data-cmd-group="go"] .ws-cmd__item').forEach(function (el) {
      if (!el.id) el.id = 'wsCmdItem' + (idSeq++);
    });
  })();

  /* ---------------------------------------------------------------------------
     Filtering — subsequence match over label + keywords, scored so that
     prefix matches on the label win.
     ------------------------------------------------------------------------ */
  function score(el, q) {
    var label = (el.querySelector('.ws-cmd__item-label') || {}).textContent || '';
    var hay = (label + ' ' + (el.dataset.cmdKeywords || '')).toLowerCase();
    var lab = label.toLowerCase();

    if (!q) return 1;
    if (lab.startsWith(q)) return 1000 - lab.length;
    var direct = hay.indexOf(q);
    if (direct === 0) return 800;
    if (direct > 0) return 600 - direct;

    // subsequence fallback: "rmsh" -> "remesh"
    var i = 0;
    for (var c = 0; c < hay.length && i < q.length; c++) {
      if (hay[c] === q[i]) i++;
    }
    return i === q.length ? 100 : 0;
  }

  function filter() {
    var q = input.value.trim().toLowerCase();
    var scored = [];

    list.querySelectorAll('.ws-cmd__item').forEach(function (el) {
      var s = score(el, q);
      el.__score = s;
      el.hidden = s === 0 || (!q && el.dataset.cmdSearchOnly === 'true');
    });

    // Reorder within each group by score, then hide empty groups.
    list.querySelectorAll('.ws-cmd__group').forEach(function (g) {
      var rows = Array.prototype.slice.call(g.querySelectorAll('.ws-cmd__item'));
      if (q) {
        rows.sort(function (a, b) { return b.__score - a.__score; });
        rows.forEach(function (r) { g.appendChild(r); });
      }
      var anyVisible = rows.some(function (r) { return !r.hidden; });
      g.hidden = !anyVisible;
    });

    items = Array.prototype.slice.call(list.querySelectorAll('.ws-cmd__item'))
      .filter(function (el) { return !el.hidden; });

    if (empty) empty.hidden = items.length > 0;
    if (count) {
      count.textContent = items.length
        ? items.length + (items.length === 1 ? ' result' : ' results')
        : 'No results';
    }
    setActive(items.length ? 0 : -1);
    return scored;
  }

  function setActive(i) {
    if (active > -1 && items[active]) {
      items[active].classList.remove('is-active');
      items[active].setAttribute('aria-selected', 'false');
    }
    active = i;
    if (active > -1 && items[active]) {
      var el = items[active];
      el.classList.add('is-active');
      el.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', el.id);
      var r = el.getBoundingClientRect();
      var lr = list.getBoundingClientRect();
      if (r.top < lr.top) el.scrollIntoView({ block: 'nearest' });
      else if (r.bottom > lr.bottom) el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  /* ---------------------------------------------------------------------------
     Open / close
     ------------------------------------------------------------------------ */
  function isOpen() { return !root.hidden; }

  function open() {
    if (isOpen()) return;
    lastFocus = document.activeElement;
    root.hidden = false;
    document.body.classList.add('ws-cmd-open');
    input.value = '';
    filter();
    // rAF so the open transition runs from the initial state
    requestAnimationFrame(function () {
      root.classList.add('is-open');
      input.focus();
    });
  }

  function close() {
    if (!isOpen()) return;
    root.classList.remove('is-open');
    document.body.classList.remove('ws-cmd-open');
    if (panel.contains(document.activeElement)) {
      // Opening with the keyboard leaves lastFocus on <body>, which is not
      // focusable — that would drop the caret to the top of the document.
      // Fall back to the trigger so tab order resumes at the header.
      var restore = (lastFocus && lastFocus !== document.body && document.contains(lastFocus))
        ? lastFocus
        : trigger;
      if (restore) restore.focus();
    }
    var done = function () { root.hidden = true; };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 160);
  }

  function activate(el) {
    if (!el) return;
    if (el.__cmdRun) {
      close();
      // let the palette finish closing before the workspace reacts
      setTimeout(function () { el.__cmdRun(); }, 0);
      return;
    }
    if (el.tagName === 'A' && el.getAttribute('href')) {
      // data-open-assets links are intercepted by main.js; let the click through
      close();
      el.click();
    }
  }

  /* ---------------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------------ */
  if (trigger) trigger.addEventListener('click', open);

  root.querySelectorAll('[data-cmd-close]').forEach(function (el) {
    el.addEventListener('click', close);
  });

  input.addEventListener('input', filter);

  list.addEventListener('click', function (e) {
    var el = e.target.closest('.ws-cmd__item');
    if (!el) return;
    if (el.__cmdRun) e.preventDefault();
    activate(el);
  });

  list.addEventListener('pointermove', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    var el = e.target.closest('.ws-cmd__item');
    if (!el || el.hidden) return;
    var i = items.indexOf(el);
    if (i > -1 && i !== active) setActive(i);
  });

  panel.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((active - 1 + items.length) % items.length);
    } else if (e.key === 'Home' && document.activeElement !== input) {
      e.preventDefault(); setActive(0);
    } else if (e.key === 'Enter') {
      if (active > -1) { e.preventDefault(); activate(items[active]); }
    } else if (e.key === 'Tab') {
      // single focus stop — keep focus in the field
      e.preventDefault();
    }
  });

  document.addEventListener('keydown', function (e) {
    // Accept either modifier rather than branching on platform: the chip shows
    // the native one, but a Mac user on a PC keyboard (or the reverse) still
    // gets the shortcut. e.altKey is excluded so ⌥⌘K stays free.
    var mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      isOpen() ? close() : open();
      return;
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);

  // Public hook — the mobile menu and anything else can open it.
  /* ---------------------------------------------------------------------------
     Chrome linkage
     ---------------------------------------------------------------------------
     The header actions and the command bar are one system at two depths, and
     nothing draws a line between them — the connection is carried by a light
     response that travels in both directions. These two body classes are the
     only state; the stagger and the styling live in css/nav.css.
     ------------------------------------------------------------------------ */
  /* ---------------------------------------------------------------------------
     Intro gate
     ---------------------------------------------------------------------------
     The model tool tray belongs to the command bar, so it must not appear
     before the bar does. Panel state is restored by 3dprint-app.js within
     ~270ms of navigation, which had the chips fully revealed by ~780ms while
     the bar was still 130ms from even starting its arrival.

     `body.ws-intro-done` is the signal the tray waits on. css/nav.css owns
     what happens next.
     ------------------------------------------------------------------------ */
  (function introGate() {
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      document.body.classList.add('ws-intro-done');
    }

    if (!trigger) { finish(); return; }

    trigger.addEventListener('animationend', function (e) {
      if (e.animationName === 'wsBarArrive') finish();
    });

    // Safety net: if the arrival never runs — animation stripped, element
    // hidden at load, restored from bfcache — the tray must not be stranded.
    setTimeout(finish, 3000);
  })();

  (function linkChrome() {
    var creditsGroup = document.getElementById('workspaceCreditsGroup');
    var brand = document.querySelector('.ws-header-left');

    function hot(cls, on) { document.body.classList.toggle(cls, on); }

    ['pointerenter', 'focusin'].forEach(function (ev) {
      trigger && trigger.addEventListener(ev, function () { hot('ws-cmd-hot', true); });
    });
    ['pointerleave', 'focusout'].forEach(function (ev) {
      trigger && trigger.addEventListener(ev, function () { hot('ws-cmd-hot', false); });
    });

    [creditsGroup, brand].forEach(function (el) {
      if (!el) return;
      el.addEventListener('pointerenter', function () { hot('ws-chrome-hot', true); });
      el.addEventListener('pointerleave', function () { hot('ws-chrome-hot', false); });
      el.addEventListener('focusin', function () { hot('ws-chrome-hot', true); });
      el.addEventListener('focusout', function (e) {
        if (!el.contains(e.relatedTarget)) hot('ws-chrome-hot', false);
      });
    });

    // The bar is mid-flight on load; a pointer already resting over it would
    // otherwise latch the hot state before the arrival finishes.
    window.addEventListener('pageshow', function () {
      hot('ws-cmd-hot', false);
      hot('ws-chrome-hot', false);
    });
  })();

  window.TimrXCommand = { open: open, close: close, toggle: function () { isOpen() ? close() : open(); } };
})();
