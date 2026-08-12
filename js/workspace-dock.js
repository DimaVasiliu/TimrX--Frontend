/* ==========================================================================
   WORKSPACE-DOCK.JS — Bottom prompt dock (workspace redesign, 2026-08-11)
   --------------------------------------------------------------------------
   Adapter UI over the existing workspace. It renders one centered prompt
   bar with setting chips and proxies every interaction to the legacy
   controls, so 3dprint-app.js / api.js / state.js / workspace-credits.js
   run completely unchanged:

     mode chip      -> clicks .rail-btn[data-panel] (header rail)
     tool chip      -> clicks .model-feature-btn[data-model-panel] (tray)
     engine chip    -> writes #modelAIModel / #imageAIProvider selects or
                       clicks .video-provider-btn, then dispatches 'change'
     setting chips  -> write the matching panel <select>s + 'change'
     prompt box     -> mirrors the active panel textarea + 'input'
     Generate       -> clicks the panel's commit button; cost + disabled
                       state are mirrored FROM that button, so the credits
                       engine stays the single source of truth
     Advanced       -> window.TimrXSheet.open() (the legacy control sheet)

   Safety: init() verifies the element contract first. On any miss it
   leaves the page in legacy mode (no body.ws-dock-on), logs once, and
   the old command bar + trays remain fully functional.
   ========================================================================== */
(function () {
  'use strict';

  var COMMIT_IDS = {
    model: 'generateModelBtn',
    image: 'generateImageBtn',
    video: 'generateVideoBtn',
    remesh: 'applyRemeshBtn',
    texture: 'generateTextureBtn',
    rig: 'startRigBtn',
    animate: 'applyAnimationBtn2'
  };

  var PROMPT_IDS = {
    model: 'modelPrompt',
    image: 'imagePrompt',
    texture: 'texturePrompt'
    /* video resolved dynamically from #videoModeValue */
  };

  var MODE_META = {
    model: { ico: '◆', label: '3D Model', ph: 'Describe the 3D model you want…' },
    video: { ico: '▶', label: 'Video', ph: 'Describe the video — scene, motion, camera…' },
    image: { ico: '▣', label: 'Image', ph: 'Describe the image you want…' }
  };

  var TOOL_LABELS = {
    model: 'Generate',
    remesh: 'Remesh',
    texture: 'Texture',
    rig: 'Rig',
    animate: 'Animate'
  };

  var dock, chipsRow, promptEl, genBtn, genLabel, costEl, pop;
  var openChip = null;
  var syncTimer = null;

  function $(id) { return document.getElementById(id); }
  function q(sel) { return document.querySelector(sel); }

  /* ---------- state readers (legacy DOM is the source of truth) --------- */

  function activePanel() {
    var railBtn = q('.rail-btn.is-active');
    var mode = railBtn ? railBtn.getAttribute('data-panel') : 'model';
    if (mode === 'model') {
      var toolBtn = q('.model-feature-btn.is-active');
      var tool = toolBtn ? toolBtn.getAttribute('data-model-panel') : 'model';
      return { mode: 'model', panel: tool || 'model' };
    }
    return { mode: mode, panel: mode };
  }

  function promptTarget(panel) {
    if (panel === 'video') {
      var vm = $('videoModeValue');
      var v = vm ? vm.value : 'text2video';
      if (v === 'image2video') return $('videoAnimationPrompt');
      if (v === 'reference_video') return $('videoReferencePrompt');
      return $('videoTextPrompt');
    }
    return PROMPT_IDS[panel] ? $(PROMPT_IDS[panel]) : null;
  }

  function commitButton(panel) { return $(COMMIT_IDS[panel] || ''); }

  function selText(sel) {
    if (!sel || sel.selectedIndex < 0 || !sel.options[sel.selectedIndex]) return '';
    return (sel.options[sel.selectedIndex].textContent || '').trim();
  }

  /* ---------- popover ---------------------------------------------------- */

  function hidePop() {
    if (!pop) return;
    pop.classList.remove('is-on');
    if (openChip) openChip.classList.remove('is-open');
    openChip = null;
  }

  function showPop(chip, title, items) {
    if (openChip === chip) { hidePop(); return; }
    hidePop();
    openChip = chip;
    chip.classList.add('is-open');
    pop.innerHTML = '';
    if (title) {
      var t = document.createElement('div');
      t.className = 'ws-dock-pop__title';
      t.textContent = title;
      pop.appendChild(t);
    }
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-dock-pop__item' + (it.selected ? ' is-sel' : '');
      b.innerHTML = it.html;
      b.addEventListener('click', function () {
        hidePop();
        it.onPick();
        scheduleRender();
      });
      pop.appendChild(b);
    });
    pop.classList.add('is-on');
    var a = chip.getBoundingClientRect();
    var p = pop.getBoundingClientRect();
    var x = Math.max(10, Math.min(a.left + a.width / 2 - p.width / 2, window.innerWidth - p.width - 10));
    var y = a.top - p.height - 10;
    if (y < 64) y = a.bottom + 10;
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function selectItems(sel, onWrite) {
    return Array.prototype.map.call(sel.options, function (opt) {
      return {
        selected: opt.value === sel.value,
        html: esc((opt.textContent || '').trim()),
        onPick: function () {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          if (onWrite) onWrite(opt);
        }
      };
    });
  }

  /* ---------- chips ------------------------------------------------------ */

  function chipEl(inner, cls, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ws-dock__chip' + (cls ? ' ' + cls : '');
    if (title) b.title = title;
    b.innerHTML = inner;
    return b;
  }

  function chipHtml(ico, val, caret) {
    return '<span class="c-ico">' + ico + '</span><span class="c-val">' + esc(val) + '</span>' +
      (caret ? '<span class="c-caret">▼</span>' : '');
  }

  function addSelectChip(sel, ico, title, popTitle) {
    if (!sel || !sel.options || sel.options.length < 2) return;
    var chip = chipEl(chipHtml(ico, selText(sel), true), '', title);
    chip.addEventListener('click', function () { showPop(chip, popTitle, selectItems(sel)); });
    chipsRow.appendChild(chip);
  }

  function render() {
    if (!chipsRow) return;
    var st = activePanel();
    var meta = MODE_META[st.mode] || MODE_META.model;
    chipsRow.innerHTML = '';
    hidePop();

    /* mode chip */
    var modeChip = chipEl(chipHtml(meta.ico, meta.label, true), 'ws-dock__chip--mode', 'Creation mode');
    modeChip.addEventListener('click', function () {
      showPop(modeChip, 'Create', ['model', 'video', 'image'].map(function (m) {
        return {
          selected: st.mode === m,
          html: '<span class="c-ico">' + MODE_META[m].ico + '</span>' + MODE_META[m].label,
          onPick: function () {
            var btn = q('.rail-btn[data-panel="' + m + '"]');
            if (btn) btn.click();
            /* keep the dock primary: retract the auto-opened sheet */
            closeSheetSoon();
          }
        };
      }));
    });
    chipsRow.appendChild(modeChip);

    /* model tool chip (Generate / Remesh / Texture / Rig / Animate) */
    if (st.mode === 'model') {
      var toolChip = chipEl(chipHtml('⚒', TOOL_LABELS[st.panel] || 'Generate', true), '', '3D tool');
      toolChip.addEventListener('click', function () {
        showPop(toolChip, '3D tools', Object.keys(TOOL_LABELS).map(function (t) {
          return {
            selected: st.panel === t,
            html: TOOL_LABELS[t],
            onPick: function () {
              var btn = q('.model-feature-btn[data-model-panel="' + t + '"]');
              if (btn) btn.click();
              /* tools beyond Generate need their panel: leave the sheet open */
              if (t === 'model') closeSheetSoon();
            }
          };
        }));
      });
      chipsRow.appendChild(toolChip);
    }

    /* engine chip + per-mode setting chips */
    if (st.panel === 'model') {
      addSelectChip($('modelAIModel'), '✦', 'Engine', '3D engines');
      addSelectChip($('modelTextureResolution'), '◈', 'Texture resolution', 'Texture resolution');
      var batch = $('modelBatchCount');
      if (batch) {
        var bChip = chipEl(chipHtml('⧉', '×' + (batch.value || '1'), true), '', 'Batch count');
        bChip.addEventListener('click', function () {
          showPop(bChip, 'Batch', ['1', '2', '3', '4'].map(function (n) {
            return {
              selected: String(batch.value) === n,
              html: n + (n === '1' ? ' model' : ' models'),
              onPick: function () {
                batch.value = n;
                batch.dispatchEvent(new Event('input', { bubbles: true }));
                batch.dispatchEvent(new Event('change', { bubbles: true }));
              }
            };
          }));
        });
        chipsRow.appendChild(bChip);
      }
    } else if (st.panel === 'image') {
      addSelectChip($('imageAIProvider'), '✦', 'Engine', 'Image engines');
      addSelectChip($('imageShape'), '▭', 'Shape', 'Shape');
      addSelectChip($('imageQuality'), '◈', 'Quality', 'Quality');
    } else if (st.panel === 'video') {
      var prov = q('.video-provider-btn.is-active');
      var provChip = chipEl(chipHtml('✦', prov ? (prov.querySelector('.vpb-name') || prov).textContent.trim() : 'Engine', true), '', 'Video engine');
      provChip.addEventListener('click', function () {
        var btns = document.querySelectorAll('.video-provider-btn');
        showPop(provChip, 'Video engines', Array.prototype.map.call(btns, function (b) {
          var name = (b.querySelector('.vpb-name') || b).textContent.trim();
          var tag = b.querySelector('.vpb-tag') ? b.querySelector('.vpb-tag').textContent.trim() : '';
          return {
            selected: b.classList.contains('is-active'),
            html: esc(name) + (tag ? '<span class="pi-sub">' + esc(tag) + '</span>' : ''),
            onPick: function () { b.click(); }
          };
        }));
      });
      chipsRow.appendChild(provChip);
      addSelectChip($('seedanceTierSelect'), '≋', 'Tier', 'Seedance tier');
      addSelectChip($('videoDuration'), '◔', 'Duration', 'Duration');
      addSelectChip($('videoAspectRatio'), '▭', 'Aspect ratio', 'Aspect ratio');
      addSelectChip($('videoQuality'), '◈', 'Quality', 'Quality');
    }

    /* advanced chip -> the legacy sheet */
    var adv = chipEl('<span class="c-ico">⚙</span>Advanced', 'ws-dock__chip--adv', 'All settings');
    adv.addEventListener('click', function () {
      if (window.TimrXSheet) {
        if (window.TimrXSheet.isOpen && window.TimrXSheet.isOpen()) window.TimrXSheet.close();
        else window.TimrXSheet.open();
      }
    });
    chipsRow.appendChild(adv);

    /* prompt placeholder + mirror current panel text */
    promptEl.placeholder = meta.ph;
    var src = promptTarget(st.panel);
    if (src && document.activeElement !== promptEl) promptEl.value = src.value || '';
    promptEl.style.display = (st.panel === 'remesh' || st.panel === 'rig' || st.panel === 'animate') ? 'none' : '';

    syncGenerate();
  }

  function syncGenerate() {
    var st = activePanel();
    var btn = commitButton(st.panel);
    if (!btn) { genBtn.disabled = true; return; }
    genBtn.disabled = !!btn.disabled;
    var working = /generating|processing|starting/i.test(btn.textContent || '');
    genBtn.classList.toggle('is-working', working);
    var badge = btn.querySelector('.btn-cost-badge');
    costEl.textContent = badge ? badge.textContent.trim() : '';
    costEl.style.display = badge ? '' : 'none';
    var labels = { model: 'Generate', image: 'Generate', video: 'Generate', remesh: 'Apply remesh', texture: 'Generate texture', rig: 'Start rig', animate: 'Apply animation' };
    genLabel.textContent = working ? 'Working…' : (labels[st.panel] || 'Generate');
  }

  function scheduleRender() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(render, 60);
  }

  function closeSheetSoon() {
    /* the rail click auto-opens the sheet; retract it so the dock stays primary */
    setTimeout(function () {
      if (window.TimrXSheet && window.TimrXSheet.isOpen && window.TimrXSheet.isOpen()) {
        window.TimrXSheet.close();
      }
    }, 30);
  }

  /* ---------- build ------------------------------------------------------ */

  function build() {
    dock = document.createElement('div');
    dock.className = 'ws-dock';
    /* bare data-panel keeps clicks inside the dock from dismissing the sheet
       (KEEPS_SHEET_OPEN allow-list in 3dprint-app.js matches [data-panel]) */
    dock.setAttribute('data-panel', '');
    dock.innerHTML =
      '<div class="ws-dock__card">' +
      '  <div class="ws-dock__row">' +
      '    <button type="button" class="ws-dock__agent" title="AI Agent — natural language to a staged generation (⌘K)" aria-label="Open AI agent">✦</button>' +
      '    <textarea class="ws-dock__prompt" rows="1" placeholder="Describe any idea…" aria-label="Generation prompt"></textarea>' +
      '    <button type="button" class="ws-dock__generate"><span class="ws-dock__label">Generate</span><span class="ws-dock__cost"></span></button>' +
      '  </div>' +
      '  <div class="ws-dock__chips" role="toolbar" aria-label="Generation settings"></div>' +
      '</div>' +
      '<div class="ws-dock__hint" role="status">' +
      '  <span class="ws-dock__hint-ico" aria-hidden="true">✦</span>' +
      '  <span class="ws-dock__hint-txt"><strong>Your AI agent.</strong> Describe an idea in plain words — it picks the mode and settings and stages the generation for you. <kbd>⌘K</kbd></span>' +
      '  <button type="button" class="ws-dock__hint-x" aria-label="Dismiss hint">✕</button>' +
      '</div>';
    document.body.appendChild(dock);

    pop = document.createElement('div');
    pop.className = 'ws-dock-pop';
    pop.setAttribute('data-panel', '');
    document.body.appendChild(pop);

    chipsRow = dock.querySelector('.ws-dock__chips');
    promptEl = dock.querySelector('.ws-dock__prompt');
    genBtn = dock.querySelector('.ws-dock__generate');
    genLabel = dock.querySelector('.ws-dock__label');
    costEl = dock.querySelector('.ws-dock__cost');

    /* prompt: dock -> panel */
    promptEl.addEventListener('input', function () {
      promptEl.style.height = 'auto';
      promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
      var target = promptTarget(activePanel().panel);
      if (target && target.value !== promptEl.value) {
        target.value = promptEl.value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    promptEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!genBtn.disabled) genBtn.click();
      }
    });

    /* agent hint bubble: explains the ✦ button once, then stays out of the
       way (localStorage). Auto-hides; dismiss or first agent use remembers. */
    var hint = dock.querySelector('.ws-dock__hint');
    var HINT_KEY = 'txWsAgentHint1';
    var hintTimer = 0;
    function hideHint(remember) {
      clearTimeout(hintTimer);
      hint.classList.remove('is-on');
      if (remember) { try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {} }
    }
    (function maybeShowHint() {
      var seen = false;
      try { seen = !!localStorage.getItem(HINT_KEY); } catch (e) {}
      if (seen) return;
      /* after the loader veil has opened and the chrome has settled */
      hintTimer = setTimeout(function () {
        hint.classList.add('is-on');
        hintTimer = setTimeout(function () { hideHint(false); }, 12000);
      }, 4600);
    })();
    hint.querySelector('.ws-dock__hint-x').addEventListener('click', function () {
      hideHint(true);
    });

    /* agent button: opens the ⌘K palette (command-ai.js stages the plan
       from natural language). Carries the dock prompt over if one is typed. */
    dock.querySelector('.ws-dock__agent').addEventListener('click', function () {
      hideHint(true);
      if (!window.TimrXCommand || !window.TimrXCommand.open) return;
      window.TimrXCommand.open();
      var text = promptEl.value.trim();
      if (!text) return;
      setTimeout(function () {
        var cmdInput = $('wsCmdInput');
        if (cmdInput && !cmdInput.value) {
          cmdInput.value = text;
          cmdInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, 120);
    });

    /* generate: proxy to the live commit button */
    genBtn.addEventListener('click', function () {
      var btn = commitButton(activePanel().panel);
      if (btn && !btn.disabled) btn.click();
      setTimeout(syncGenerate, 120);
    });

    /* panel -> dock mirroring */
    var leftStack = $('leftStack');
    if (leftStack) {
      new MutationObserver(scheduleRender).observe(leftStack, { childList: true });
      leftStack.addEventListener('change', scheduleRender, true);
      leftStack.addEventListener('input', function (e) {
        var st = activePanel();
        var target = promptTarget(st.panel);
        if (target && e.target === target && document.activeElement !== promptEl) {
          promptEl.value = target.value || '';
        }
      }, true);
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest && (e.target.closest('.rail-btn') || e.target.closest('.model-feature-btn') ||
          e.target.closest('.video-provider-btn') || e.target.closest('.video-mode-btn'))) {
        scheduleRender();
      }
      if (pop.classList.contains('is-on') && !pop.contains(e.target) && (!openChip || !openChip.contains(e.target))) {
        hidePop();
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hidePop();
    });
    window.addEventListener('resize', hidePop);

    /* header 3D Viewer button proxies the (hidden) corner launcher, whose
       id-bound handler owns the open/close logic */
    var headerViewerBtn = $('wsHeaderViewerBtn');
    if (headerViewerBtn) {
      headerViewerBtn.addEventListener('click', function () {
        var t = $('open3dViewerBtn');
        if (t) t.click();
      });
    }

    /* ---- phase 2 (2026-08-11): hero hints, filmstrip, fullscreen ------- */
    initHeroHints();
    initFilmstrip();
    initFullscreen();

    /* keep cost/disabled fresh (credits engine flips these asynchronously) */
    setInterval(syncGenerate, 900);
  }

  /* ---------- hero hints ------------------------------------------------- */

  function initHeroHints() {
    document.addEventListener('click', function (e) {
      var hint = e.target.closest && e.target.closest('.ws-hero__hint[data-hint]');
      if (!hint) return;
      var wantMode = hint.getAttribute('data-hint-mode');
      var st = activePanel();
      if (wantMode && st.mode !== wantMode) {
        var btn = q('.rail-btn[data-panel="' + wantMode + '"]');
        if (btn) { btn.click(); closeSheetSoon(); }
      }
      setTimeout(function () {
        promptEl.value = hint.getAttribute('data-hint') || '';
        promptEl.dispatchEvent(new Event('input', { bubbles: true }));
        promptEl.focus();
      }, 120);
    });
  }

  /* ---------- right filmstrip (recent assets) ---------------------------- */

  var filmstrip = null;

  function initFilmstrip() {
    filmstrip = document.createElement('aside');
    filmstrip.className = 'ws-filmstrip';
    filmstrip.setAttribute('aria-label', 'Recent assets');
    filmstrip.setAttribute('data-panel', '');
    document.body.appendChild(filmstrip);
    window.addEventListener('history:rendered', function () {
      /* let history.js finish painting the grid first */
      setTimeout(renderFilmstrip, 80);
    });
    window.addEventListener('timrx:startup-complete', function () {
      setTimeout(renderFilmstrip, 300);
    });
    /* history may have painted before this module booted — catch up */
    [800, 2500, 6000].forEach(function (ms) { setTimeout(renderFilmstrip, ms); });
    renderFilmstrip();
  }

  function renderFilmstrip() {
    if (!filmstrip) return;
    var grid = $('historyGrid');
    filmstrip.innerHTML = '';
    var shown = 0;
    var seen = {};
    var imgs = grid ? grid.querySelectorAll('img') : [];
    for (var i = 0; i < imgs.length && shown < 6; i++) {
      var img = imgs[i];
      var src = img.currentSrc || img.getAttribute('src') || '';
      if (!src || src.indexOf('data:image/svg') === 0 || seen[src]) continue;
      seen[src] = true;
      /* the element whose click the delegated #historyGrid handler understands */
      var opener = img.closest('[data-act]') || img.closest('button, a') ||
                   img.closest('.history-group-card, .history-collection, [data-asset-type]') || img;
      var typeHost = img.closest('[data-asset-type]');
      var hostCls = (img.closest('[class*="video"]') ? 'video' : '') ||
                    (typeHost ? typeHost.getAttribute('data-asset-type') : '');
      var tipo = /video/i.test(hostCls) ? 'VID' : /image/i.test(hostCls) ? 'IMG' : '3D';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-filmstrip__item';
      b.title = 'Open asset';
      b.innerHTML = '<img src="' + src.replace(/"/g, '&quot;') + '" alt="" loading="lazy">' +
        '<span class="ws-filmstrip__tipo">' + tipo + '</span>';
      (function (openerEl) {
        b.addEventListener('click', function () { openerEl.click(); });
      })(opener);
      filmstrip.appendChild(b);
      shown++;
    }
    if (shown) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'ws-filmstrip__more';
      more.textContent = 'All →';
      more.setAttribute('data-open-assets', '');
      filmstrip.appendChild(more);
    }
    filmstrip.classList.toggle('has-items', shown > 0);
  }

  /* ---------- viewer fullscreen ------------------------------------------ */

  function initFullscreen() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-viewer-fullscreen]');
      if (!btn) return;
      var host = document.querySelector('.ws-viewer') || document.documentElement;
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
      } else if (host.requestFullscreen) {
        host.requestFullscreen().catch(function () { /* blocked — ignore */ });
      }
    });
    document.addEventListener('fullscreenchange', function () {
      /* three.js canvas has no ResizeObserver (see viewer.js) — poke it */
      window.dispatchEvent(new Event('resize'));
    });
  }

  function contractOk() {
    return !!(q('.rail-btn[data-panel]') && $('leftStack') && window.TimrXSheet &&
      (commitButton('model') || commitButton('image') || commitButton('video')));
  }

  function init(attempt) {
    attempt = attempt || 0;
    if (!contractOk()) {
      if (attempt < 40) { setTimeout(function () { init(attempt + 1); }, 250); return; }
      console.warn('[workspace-dock] element contract not met — staying in legacy mode');
      return;
    }
    build();
    document.body.classList.add('ws-dock-on');
    render();
    /* the initial panel bootstrap opens the sheet on some paths */
    closeSheetSoon();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(0); });
  } else {
    init(0);
  }
})();
