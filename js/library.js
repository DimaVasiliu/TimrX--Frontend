/* ==========================================================================
   library.js — My Assets Phase 2: organisation, selection, remix, filters
   --------------------------------------------------------------------------
   Deliberately a CLASSIC script, not an ES module.

   Every module in the import graph carries a ?v= cache-bust string that must
   match in every importer, and getting that wrong has taken the navbar down
   before. A classic script has no importers, so adding this file cannot
   invalidate anyone else's version. It publishes window.TimrXLibrary and
   history.js calls into it through an optional chain — if this file fails to
   load, the library still renders, just without stars, tags and filters.

   Backend: backend/routes/library.py (/api/library/*), tables from
   migration 083. Ownership is enforced server-side; nothing here is trusted.
   ========================================================================== */
(function () {
  'use strict';

  var API = null;               // resolved lazily — api.js may load after us
  var state = {
    loaded: false,
    loading: null,
    favorites: new Set(),
    tagsByAsset: {},            // history_id -> [tag]
    tags: [],                   // [{tag,label,count}]
    collections: [],            // [{id,name,color,item_count}]
    collectionsByAsset: {},     // history_id -> [collection_id]
    filter: { favorites: false, tag: '', collection: '', provider: '', status: '' },
    selection: new Set(),
    selectMode: false,
  };

  function api() {
    if (!API) API = window.TimrXApi || null;
    return API;
  }

  function toast(message, tone) {
    if (typeof window.showToast === 'function') window.showToast(message, tone || 'info');
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function grid() {
    return document.querySelector('.expanded-thumbs-grid');
  }

  function cards() {
    var g = grid();
    return g ? Array.prototype.slice.call(g.querySelectorAll('.expanded-thumb')) : [];
  }

  function cardId(el) {
    return (el && el.getAttribute('data-gid')) || '';
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // ---------------------------------------------------------------- dialog
  // window.prompt() cannot be styled, blocks the main thread, and is silently
  // suppressed in some embedded contexts — and the collection picker it gave
  // us was "type the number of the collection you want". One small promise-
  // based dialog replaces every prompt in this file.
  //
  //   openDialog({ title, hint, placeholder, value, submitLabel, swatches })
  //     -> Promise<string|null>            text entry, null when cancelled
  //   openDialog({ title, choices:[{id,label,meta,color}] })
  //     -> Promise<choice|null>            picker
  function openDialog(opts) {
    return new Promise(function (resolve) {
      var host = document.createElement('div');
      host.className = 'lib-dialog';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');

      var isPicker = Array.isArray(opts.choices);
      var swatches = opts.swatches || [];
      var chosenColor = swatches.length ? swatches[0] : null;

      host.innerHTML =
        '<div class="lib-dialog__panel" role="document">' +
          '<h2 class="lib-dialog__title">' + esc(opts.title || '') + '</h2>' +
          (opts.hint ? '<p class="lib-dialog__hint">' + esc(opts.hint) + '</p>' : '') +
          '<div class="lib-dialog__body">' +
            (isPicker
              ? '<div class="lib-dialog__choices">' + opts.choices.map(function (c, i) {
                  return '<button type="button" class="lib-choice" data-choice="' + i + '">' +
                    '<span class="lib-choice__dot"' + (c.color ? ' style="background:' + esc(c.color) + '"' : '') + '></span>' +
                    '<span>' + esc(c.label) + '</span>' +
                    (c.meta ? '<span class="lib-choice__meta">' + esc(c.meta) + '</span>' : '') +
                  '</button>';
                }).join('') + '</div>'
              : '<input class="lib-dialog__input" type="text" autocomplete="off" spellcheck="false"' +
                ' maxlength="' + (opts.maxLength || 64) + '"' +
                ' placeholder="' + esc(opts.placeholder || '') + '"' +
                ' value="' + esc(opts.value || '') + '">' +
                (swatches.length
                  ? '<div class="lib-dialog__swatches" role="group" aria-label="Colour">' +
                      swatches.map(function (c, i) {
                        return '<button type="button" class="lib-swatch' + (i === 0 ? ' is-on' : '') +
                          '" data-swatch="' + esc(c) + '" style="background:' + esc(c) + '"' +
                          ' aria-label="Colour ' + (i + 1) + '"></button>';
                      }).join('') +
                    '</div>'
                  : '') +
                '<p class="lib-dialog__error" data-dialog-error></p>') +
          '</div>' +
          '<div class="lib-dialog__foot">' +
            '<button type="button" class="lib-dialog__btn" data-dialog-cancel>Cancel</button>' +
            (isPicker ? '' :
              '<button type="button" class="lib-dialog__btn lib-dialog__btn--primary" data-dialog-ok>' +
                esc(opts.submitLabel || 'Save') + '</button>') +
          '</div>' +
        '</div>';

      document.body.appendChild(host);
      var input = host.querySelector('.lib-dialog__input');
      var errEl = host.querySelector('[data-dialog-error]');
      var settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        host.remove();
        resolve(result);
      }

      function submit() {
        var text = (input && input.value || '').trim();
        if (!text) {
          if (errEl) errEl.textContent = 'Give it a name first.';
          if (input) input.focus();
          return;
        }
        close(swatches.length ? { name: text, color: chosenColor } : text);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && !isPicker) { e.preventDefault(); submit(); }
      }

      host.addEventListener('click', function (e) {
        // click on the backdrop, never on the panel
        if (e.target === host) { close(null); return; }
        var swatch = e.target.closest('[data-swatch]');
        if (swatch) {
          chosenColor = swatch.getAttribute('data-swatch');
          host.querySelectorAll('[data-swatch]').forEach(function (el) {
            el.classList.toggle('is-on', el === swatch);
          });
          return;
        }
        var choice = e.target.closest('[data-choice]');
        if (choice) { close(opts.choices[parseInt(choice.getAttribute('data-choice'), 10)]); return; }
        if (e.target.closest('[data-dialog-cancel]')) { close(null); return; }
        if (e.target.closest('[data-dialog-ok]')) submit();
      });

      document.addEventListener('keydown', onKey, true);
      if (input) { input.focus(); input.select(); }
      else { var first = host.querySelector('.lib-choice'); if (first) first.focus(); }
    });
  }

  var COLLECTION_COLORS = ['#7fc8c2', '#b8a77a', '#d98a8a', '#8ab4d9', '#a98ad9', '#8ad99b'];

  // ------------------------------------------------------------------ data
  function request(path, options) {
    var a = api();
    if (!a || typeof a.apiFetch !== 'function') {
      return Promise.resolve({ ok: false, error: 'API unavailable' });
    }
    return a.apiFetch(path, options || {});
  }

  function load(force) {
    if (state.loading) return state.loading;
    if (state.loaded && !force) return Promise.resolve(state);

    state.loading = request('/api/library/overview').then(function (res) {
      state.loading = null;
      var data = (res && res.data) || {};
      if (!res || !res.ok || !data.ok) {
        // A library without stars is still a usable library — degrade quietly
        // rather than blocking the modal on an optional feature.
        state.loaded = true;
        return state;
      }
      state.favorites = new Set(data.favorites || []);
      state.tags = data.tags || [];
      state.tagsByAsset = data.tags_by_asset || {};
      state.collections = data.collections || [];
      state.collectionsByAsset = data.collections_by_asset || {};
      state.loaded = true;
      return state;
    }).catch(function () {
      state.loading = null;
      state.loaded = true;
      return state;
    });

    return state.loading;
  }

  // ------------------------------------------------------- card decoration
  var STAR_PATH = 'M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.44 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95L12 2.6z';

  function starButton(id, on) {
    return '<button type="button" class="lib-star' + (on ? ' is-on' : '') + '"' +
      ' data-lib-star="' + esc(id) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
      ' title="' + (on ? 'Remove from favourites' : 'Add to favourites') + '"' +
      ' aria-label="' + (on ? 'Remove from favourites' : 'Add to favourites') + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg></button>';
  }

  function decorateCard(el) {
    var id = cardId(el);
    if (!id) return;

    // --- star -------------------------------------------------------------
    var on = state.favorites.has(id);
    var star = el.querySelector('[data-lib-star]');
    if (!star) {
      el.insertAdjacentHTML('beforeend', starButton(id, on));
    } else {
      star.classList.toggle('is-on', on);
      star.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    el.classList.toggle('is-favorited', on);

    // --- tag count --------------------------------------------------------
    var tags = state.tagsByAsset[id] || [];
    var chip = el.querySelector('[data-lib-tagcount]');
    if (tags.length) {
      var label = '#' + tags.length;
      var title = 'Tags: ' + tags.join(', ');
      if (!chip) {
        el.insertAdjacentHTML('beforeend',
          '<span class="lib-tagcount" data-lib-tagcount title="' + esc(title) + '">' + esc(label) + '</span>');
      } else {
        chip.textContent = label;
        chip.setAttribute('title', title);
      }
    } else if (chip) {
      chip.remove();
    }

    // --- collection dot ---------------------------------------------------
    var inCollections = state.collectionsByAsset[id] || [];
    el.classList.toggle('is-collected', inCollections.length > 0);

    // --- selection checkbox ----------------------------------------------
    var box = el.querySelector('[data-lib-select]');
    if (state.selectMode) {
      if (!box) {
        el.insertAdjacentHTML('beforeend',
          '<button type="button" class="lib-select" data-lib-select="' + esc(id) + '"' +
          ' role="checkbox" aria-checked="false" aria-label="Select asset"></button>');
        box = el.querySelector('[data-lib-select]');
      }
      var picked = state.selection.has(id);
      box.classList.toggle('is-on', picked);
      box.setAttribute('aria-checked', picked ? 'true' : 'false');
      el.classList.toggle('is-selected', picked);
    } else if (box) {
      box.remove();
      el.classList.remove('is-selected');
    }

    decorateMenu(el, id);
    applyFilterToCard(el, id);
  }

  // ------------------------------------------------------------- card menu
  function remixActions(el, id) {
    // Read the asset's shape off the card rather than re-querying state: the
    // grid is the only place that knows what this particular card renders.
    var type = el.getAttribute('data-asset-type') || 'model';
    var promptEl = el.querySelector('.expanded-thumb__status-prompt');
    // title carries the full prompt; textContent is shortTitle()'s output and
    // falls back to the literal "(untitled)" for prompt-less assets, which is
    // not something anyone wants pasted into the prompt box.
    var prompt = promptEl ? (promptEl.getAttribute('title') || '') : '';
    if (!prompt || prompt === '(untitled)') prompt = '';
    var items = [];

    if (type === 'image') {
      items.push(['remix-image-to-3d', 'Make 3D model', 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4']);
      items.push(['remix-image-to-video', 'Animate to video', 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z']);
    } else if (type === 'model' || type === 'animated') {
      items.push(['remix-model-texture', 'Re-texture', 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z']);
    }
    if (prompt) {
      items.push(['remix-rerun', 'Run this prompt again', 'M4 4v5h5M20 20v-5h-5M20 9A8 8 0 006 5.3M4 15a8 8 0 0014 3.7']);
      items.push(['remix-copy-prompt', 'Copy prompt', 'M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-2M8 5a2 2 0 002 2h4a2 2 0 002-2M8 5a2 2 0 012-2h4a2 2 0 012 2m0 0h2a2 2 0 012 2v3']);
    }

    return items.map(function (item) {
      return '<button class="card-menu__item" type="button" data-lib-act="' + item[0] + '"' +
        ' data-id="' + esc(id) + '" data-prompt="' + esc(prompt) + '">' +
        '<span class="card-menu__item-inner">' +
        '<span class="card-menu__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + item[2] + '"/></svg></span>' +
        '<span>' + esc(item[1]) + '</span></span></button>';
    }).join('');
  }

  function collectionRows(id) {
    var member = state.collectionsByAsset[id] || [];
    if (!state.collections.length) {
      return '<div class="card-menu__hint">No collections yet — create one from the toolbar.</div>';
    }
    return state.collections.map(function (c) {
      var inIt = member.indexOf(c.id) !== -1;
      return '<button class="card-menu__item" type="button" data-lib-act="toggle-collection"' +
        ' data-id="' + esc(id) + '" data-collection="' + esc(c.id) + '">' +
        '<span class="card-menu__item-inner">' +
        '<span class="card-menu__icon">' + (inIt ? '&#10003;' : '&#43;') + '</span>' +
        '<span>' + esc(c.name) + '</span></span></button>';
    }).join('');
  }

  function decorateMenu(el, id) {
    var menu = el.querySelector('.card-menu');
    if (!menu) return;
    // Replace rather than bail out: tags and collection ticks change under us
    // after every add/remove, and an inject-once guard left the menu showing
    // the state from whenever the card was last rebuilt.
    var existing = menu.querySelector('[data-lib-menu]');
    if (existing) existing.remove();

    var tags = state.tagsByAsset[id] || [];
    var tagChips = tags.map(function (t) {
      return '<button type="button" class="lib-menu-tag" data-lib-act="remove-tag"' +
        ' data-id="' + esc(id) + '" data-tag="' + esc(t) + '" title="Remove tag">' +
        esc(t) + '<span aria-hidden="true">&times;</span></button>';
    }).join('');

    var block =
      '<div class="card-menu__group" data-lib-menu>' +
        '<div class="card-menu__label">Do more with this</div>' +
        remixActions(el, id) +
        '<div class="card-menu__label">Organise</div>' +
        '<button class="card-menu__item" type="button" data-lib-act="add-tag" data-id="' + esc(id) + '">' +
          '<span class="card-menu__item-inner"><span class="card-menu__icon">#</span><span>Add tag</span></span>' +
        '</button>' +
        (tagChips ? '<div class="lib-menu-tags">' + tagChips + '</div>' : '') +
        collectionRows(id) +
      '</div>';

    menu.insertAdjacentHTML('afterbegin', block);
  }

  // -------------------------------------------------------------- filtering
  function matchesFilter(el, id) {
    var f = state.filter;
    if (f.favorites && !state.favorites.has(id)) return false;
    if (f.tag && (state.tagsByAsset[id] || []).indexOf(f.tag) === -1) return false;
    if (f.collection && (state.collectionsByAsset[id] || []).indexOf(f.collection) === -1) return false;
    if (f.provider) {
      var p = el.querySelector('.expanded-thumb__status-provider');
      if (!p || p.textContent.trim().toLowerCase() !== f.provider.toLowerCase()) return false;
    }
    if (f.status) {
      var live = el.getAttribute('data-live') === '1';
      if (f.status === 'live' && !live) return false;
      if (f.status === 'done' && live) return false;
    }
    return true;
  }

  function applyFilterToCard(el, id) {
    if (el.getAttribute('data-stack-revision') === '1') {
      // A revision follows its face card. Without this, filtering out a
      // lineage left its expanded older versions on screen with no parent —
      // and they still counted as "visible", suppressing the empty state.
      var key = el.getAttribute('data-stack-key') || '';
      var face = key && grid()
        ? grid().querySelector('.expanded-thumb[data-stack-face="1"][data-stack-key="' + cssEscape(key) + '"]')
        : null;
      el.classList.toggle('is-lib-hidden', !!(face && face.classList.contains('is-lib-hidden')));
      return;
    }
    el.classList.toggle('is-lib-hidden', !matchesFilter(el, id));
  }

  function applyFilters() {
    cards().forEach(function (el) { applyFilterToCard(el, cardId(el)); });
    // The live heading counts visible live cards, so it has to re-run after
    // the filter pass or it labels a run that is no longer on screen.
    if (window.TimrXGenerationTracker && typeof window.TimrXGenerationTracker.refresh === 'function') {
      // no-op guard: keeps the floating tracker in step when filters change
    }
    var heading = grid() && grid().querySelector('[data-live-heading]');
    if (heading) {
      var liveVisible = grid().querySelectorAll(
        '.expanded-thumb[data-live="1"]:not(.is-gallery-hidden):not(.is-lib-hidden)').length;
      var count = heading.querySelector('.history-live-heading__count');
      if (count) count.textContent = String(liveVisible);
      heading.hidden = liveVisible === 0;
    }
    syncEmptyState();
    syncFilterChips();
  }

  function activeFilterCount() {
    var f = state.filter;
    return (f.favorites ? 1 : 0) + (f.tag ? 1 : 0) + (f.collection ? 1 : 0) +
           (f.provider ? 1 : 0) + (f.status ? 1 : 0);
  }

  function syncEmptyState() {
    var g = grid();
    if (!g) return;
    var visible = g.querySelectorAll('.expanded-thumb:not(.is-lib-hidden):not(.is-gallery-hidden):not(.is-stack-hidden)').length;
    var note = g.querySelector('[data-lib-empty]');
    if (visible === 0 && activeFilterCount() > 0) {
      if (!note) {
        g.insertAdjacentHTML('beforeend',
          '<div class="lib-empty" data-lib-empty role="status">' +
          '<p>Nothing matches these filters.</p>' +
          '<button type="button" class="lib-empty__clear" data-lib-act="clear-filters">Clear filters</button>' +
          '</div>');
      }
    } else if (note) {
      note.remove();
    }
  }

  // ---------------------------------------------------------------- toolbar
  function providersInGrid() {
    var seen = {};
    cards().forEach(function (el) {
      var p = el.querySelector('.expanded-thumb__status-provider');
      var name = p ? p.textContent.trim() : '';
      if (name) seen[name] = (seen[name] || 0) + 1;
    });
    return Object.keys(seen).sort();
  }

  function buildToolbar() {
    var host = document.getElementById('assetsToolbarFilters');
    if (!host || !host.parentElement) return;

    var row = document.getElementById('libFilterRow');
    if (!row) {
      row = document.createElement('div');
      row.id = 'libFilterRow';
      row.className = 'lib-filters';
      // NOT host.parentElement: in the modal that parent is .history-head-row-top,
      // a three-column CSS grid with exactly three children. Inserting a fourth
      // child re-flows the search box into the 112px column and drops the
      // refresh/sort/close buttons onto their own line. Anchor to the row
      // itself so the filters land underneath the whole toolbar.
      var anchor = host.closest('.history-head-row-top') || host;
      anchor.parentElement.insertBefore(row, anchor.nextSibling);
    }

    var providers = providersInGrid();
    var topTags = state.tags.slice(0, 6);

    row.innerHTML =
      '<button type="button" class="lib-chip lib-chip--star' + (state.filter.favorites ? ' is-on' : '') + '"' +
        ' data-lib-act="filter-favorites" aria-pressed="' + (state.filter.favorites ? 'true' : 'false') + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg>Favourites' +
        '<span class="lib-chip__count">' + state.favorites.size + '</span></button>' +

      topTags.map(function (t) {
        return '<button type="button" class="lib-chip' + (state.filter.tag === t.tag ? ' is-on' : '') + '"' +
          ' data-lib-act="filter-tag" data-tag="' + esc(t.tag) + '">#' + esc(t.label || t.tag) +
          '<span class="lib-chip__count">' + t.count + '</span></button>';
      }).join('') +

      (state.collections.length
        ? '<select class="lib-select-input' + (state.filter.collection ? ' is-on' : '') + '" data-lib-act="filter-collection" aria-label="Filter by collection">' +
            '<option value="">All collections</option>' +
            state.collections.map(function (c) {
              return '<option value="' + esc(c.id) + '"' + (state.filter.collection === c.id ? ' selected' : '') + '>' +
                esc(c.name) + ' (' + c.item_count + ')</option>';
            }).join('') +
          '</select>'
        : '') +

      (providers.length > 1
        ? '<select class="lib-select-input' + (state.filter.provider ? ' is-on' : '') + '" data-lib-act="filter-provider" aria-label="Filter by provider">' +
            '<option value="">All providers</option>' +
            providers.map(function (p) {
              return '<option value="' + esc(p) + '"' + (state.filter.provider === p ? ' selected' : '') + '>' + esc(p) + '</option>';
            }).join('') +
          '</select>'
        : '') +

      '<select class="lib-select-input' + (state.filter.status ? ' is-on' : '') + '" data-lib-act="filter-status" aria-label="Filter by status">' +
        '<option value="">Any status</option>' +
        '<option value="live"' + (state.filter.status === 'live' ? ' selected' : '') + '>Generating</option>' +
        '<option value="done"' + (state.filter.status === 'done' ? ' selected' : '') + '>Finished</option>' +
      '</select>' +

      '<span class="lib-filters__spacer"></span>' +

      // The actions stay glued together at the right edge instead of being
      // three loose chips that the spacer can separate.
      '<span class="lib-filters__actions">' +
        (activeFilterCount()
          ? '<button type="button" class="lib-chip lib-chip--clear" data-lib-act="clear-filters">Clear</button>'
          : '') +
        '<button type="button" class="lib-chip' + (state.selectMode ? ' is-on' : '') + '" data-lib-act="toggle-select">' +
          (state.selectMode ? 'Done' : 'Select') + '</button>' +
        '<button type="button" class="lib-chip lib-chip--primary" data-lib-act="new-collection">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="fill:none" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
          'Collection</button>' +
      '</span>';
  }

  function syncFilterChips() {
    var row = document.getElementById('libFilterRow');
    if (row) buildToolbar();
  }

  // -------------------------------------------------------------- selection
  function buildBulkBar() {
    var bar = document.getElementById('libBulkBar');
    if (!state.selectMode || state.selection.size === 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'libBulkBar';
      bar.className = 'lib-bulk';
      document.body.appendChild(bar);
    }
    bar.innerHTML =
      '<span class="lib-bulk__count">' + state.selection.size + ' selected</span>' +
      '<button type="button" class="lib-bulk__btn" data-lib-act="bulk-favorite">Favourite</button>' +
      '<button type="button" class="lib-bulk__btn" data-lib-act="bulk-unfavorite">Unfavourite</button>' +
      '<button type="button" class="lib-bulk__btn" data-lib-act="bulk-tag">Tag&hellip;</button>' +
      (state.collections.length
        ? '<button type="button" class="lib-bulk__btn" data-lib-act="bulk-collect">Add to collection&hellip;</button>'
        : '') +
      '<button type="button" class="lib-bulk__btn" data-lib-act="bulk-download">Download</button>' +
      '<span class="lib-bulk__spacer"></span>' +
      '<button type="button" class="lib-bulk__btn lib-bulk__btn--ghost" data-lib-act="bulk-clear">Clear</button>';
  }

  function pruneSelection() {
    if (!state.selection.size) return;
    var present = {};
    cards().forEach(function (el) { present[cardId(el)] = true; });
    Array.from(state.selection).forEach(function (id) {
      if (!present[id]) state.selection.delete(id);
    });
  }

  function selectedIds() {
    // Array.from, not Array.prototype.slice — a Set is iterable but not
    // array-like, so slice() silently returns [] and every bulk action
    // becomes a no-op that still reports success.
    return Array.from(state.selection);
  }

  // ----------------------------------------------------------------- writes
  var _favSeq = {};

  function toggleFavorite(id, el) {
    var was = state.favorites.has(id);
    // Rapid clicks previously rolled each other back: two failed requests
    // could leave the star lit with nothing saved. Only the newest request
    // for an id is allowed to touch the UI.
    var seq = (_favSeq[id] = (_favSeq[id] || 0) + 1);
    // Optimistic: the star must feel instant, and the server is the tiebreak.
    if (was) state.favorites.delete(id); else state.favorites.add(id);
    if (el) decorateCard(el);
    syncFilterChips();

    request('/api/library/favorites/' + encodeURIComponent(id), {
      method: 'POST', body: { favorited: !was },
    }).then(function (res) {
      if (seq !== _favSeq[id]) return; // superseded by a newer click
      var data = (res && res.data) || {};
      if (!res || !res.ok || !data.ok) {
        if (was) state.favorites.add(id); else state.favorites.delete(id);
        if (el) decorateCard(el);
        syncFilterChips();
        toast((data.error && data.error.message) || 'Could not update favourites.', 'error');
      } else if (typeof data.favorited === 'boolean') {
        // Trust the server's answer over our optimistic guess.
        if (data.favorited) state.favorites.add(id); else state.favorites.delete(id);
        if (el) decorateCard(el);
        syncFilterChips();
      }
    });
  }

  function addTag(id) {
    openDialog({
      title: 'Add a tag',
      hint: 'Tags are lower-cased and shared across your whole library.',
      placeholder: 'e.g. low poly',
      submitLabel: 'Add tag',
      maxLength: 48,
    }).then(function (raw) {
      if (!raw) return;
      applyTag(id, raw);
    });
  }

  function applyTag(id, raw) {
    request('/api/library/tags/' + encodeURIComponent(id), {
      method: 'POST', body: { tag: raw },
    }).then(function (res) {
      var data = (res && res.data) || {};
      if (!res || !res.ok || !data.ok) {
        toast((data.error && data.error.message) || 'Could not add that tag.', 'error');
        return;
      }
      load(true).then(refresh);
    });
  }

  function removeTag(id, tag) {
    request('/api/library/tags/' + encodeURIComponent(id), {
      method: 'DELETE', body: { tag: tag },
    }).then(function () { load(true).then(refresh); });
  }

  function toggleCollection(id, collectionId) {
    var member = (state.collectionsByAsset[id] || []).indexOf(collectionId) !== -1;
    request('/api/library/collections/' + encodeURIComponent(collectionId) + '/items', {
      method: member ? 'DELETE' : 'POST', body: { history_ids: [id] },
    }).then(function (res) {
      var data = (res && res.data) || {};
      if (!res || !res.ok || !data.ok) {
        toast((data.error && data.error.message) || 'Could not update that collection.', 'error');
        return;
      }
      load(true).then(refresh);
    });
  }

  function newCollection() {
    openDialog({
      title: 'New collection',
      hint: 'Group assets however you like — a client, a print run, a mood.',
      placeholder: 'e.g. Print queue',
      submitLabel: 'Create',
      swatches: COLLECTION_COLORS,
    }).then(function (result) {
      if (!result || !result.name) return;
      request('/api/library/collections', { method: 'POST', body: { name: result.name, color: result.color } })
      .then(function (res) {
        var data = (res && res.data) || {};
        if (!res || !res.ok || !data.ok) {
          toast((data.error && data.error.message) || 'Could not create that collection.', 'error');
          return;
        }
        var c = data.collection || {};
        toast(c.created === false
          ? 'You already have a collection called "' + c.name + '".'
          : 'Collection "' + c.name + '" created.', c.created === false ? 'info' : 'success');
        load(true).then(refresh);
      });
    });
  }

  function bulk(action, extra) {
    var ids = selectedIds();
    if (!ids.length) return;
    var body = { action: action, history_ids: ids };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    request('/api/library/bulk', { method: 'POST', body: body }).then(function (res) {
      var data = (res && res.data) || {};
      if (!res || !res.ok || !data.ok) {
        toast((data.error && data.error.message) || 'Bulk action failed.', 'error');
        return;
      }
      toast(data.changed + ' of ' + data.requested + ' assets updated.', 'success');
      load(true).then(refresh);
    });
  }

  function bulkDownload() {
    // No server-side ZIP yet: trigger each card's own download action, which
    // already knows the right URL per asset type. Staggered so the browser
    // does not treat a burst of downloads as a popup storm.
    var ids = selectedIds();
    var started = 0;
    ids.forEach(function (id, index) {
      var el = grid() && grid().querySelector('.expanded-thumb[data-gid="' + cssEscape(id) + '"]');
      if (!el) return;
      // Model cards use data-act="download" (not "download-"), and grouped
      // batch cards expose only that — the prefix selector matched neither and
      // only worked by accident via the print button appearing earlier.
      var btn = el.querySelector('[data-act="download"], [data-act^="download-"], [data-act="print"]');
      if (!btn || btn.hasAttribute('disabled')) return;
      started++;
      setTimeout(function () { btn.click(); }, index * 400);
    });
    toast(started
      ? 'Downloading ' + started + ' asset' + (started === 1 ? '' : 's') + '…'
      : 'None of the selected assets have a downloadable file yet.',
      started ? 'info' : 'error');
  }

  // ------------------------------------------------------------- remix wiring
  function remix(action, id, prompt) {
    var el = grid() && grid().querySelector('.expanded-thumb[data-gid="' + cssEscape(id) + '"]');

    if (action === 'remix-copy-prompt') {
      if (navigator.clipboard && prompt) {
        navigator.clipboard.writeText(prompt)
          .then(function () { toast('Prompt copied.', 'success'); })
          .catch(function () { toast('Could not copy the prompt.', 'error'); });
      }
      return;
    }

    if (action === 'remix-rerun') {
      // Fill the workspace prompt box and let the user pick settings; silently
      // re-spending credits on their behalf would be the wrong default.
      var box = document.getElementById('promptInput') || document.querySelector('textarea[id*="rompt"]');
      if (box) {
        box.value = prompt;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        if (window.TimrXAssets && typeof window.TimrXAssets.close === 'function') window.TimrXAssets.close();
        box.focus();
        toast('Prompt loaded — adjust settings and hit Generate.', 'info');
      } else {
        toast('Open the workspace to re-run this prompt.', 'info');
      }
      return;
    }

    // The remaining actions reuse the card's own menu entries, so the existing
    // pipelines (and their credit checks) stay the single source of truth.
    var map = {
      'remix-image-to-3d': '[data-act="image-to-3d"], [data-act="use-image-3d"]',
      'remix-image-to-video': '[data-act="animate-image"], [data-act="image-to-video"]',
      'remix-model-texture': '[data-act="texture"], [data-act="retexture"]',
    };
    var target = el && map[action] ? el.querySelector(map[action]) : null;
    if (target) {
      target.click();
    } else {
      toast('That action is not available for this asset yet.', 'info');
    }
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', function (e) {
    var star = e.target.closest && e.target.closest('[data-lib-star]');
    if (star) {
      e.preventDefault(); e.stopPropagation();
      toggleFavorite(star.getAttribute('data-lib-star'), star.closest('.expanded-thumb'));
      return;
    }

    var box = e.target.closest && e.target.closest('[data-lib-select]');
    if (box) {
      e.preventDefault(); e.stopPropagation();
      var sid = box.getAttribute('data-lib-select');
      if (state.selection.has(sid)) state.selection.delete(sid); else state.selection.add(sid);
      decorateCard(box.closest('.expanded-thumb'));
      buildBulkBar();
      return;
    }

    var act = e.target.closest && e.target.closest('[data-lib-act]');
    if (!act) return;
    var action = act.getAttribute('data-lib-act');
    var id = act.getAttribute('data-id') || '';

    // Filter selects fire on change, not click.
    if (act.tagName === 'SELECT') return;

    e.preventDefault();
    // Deliberately NOT stopPropagation for menu items. This listener runs at
    // document-capture, and stopping there kills every later listener on the
    // document too — including main.js's "close menus on outside click", which
    // left the card menu floating open after every organise action. Items
    // inside .card-menu let the event through so the menu closes itself.
    if (!act.closest('.card-menu')) e.stopPropagation();

    switch (action) {
      case 'filter-favorites':
        state.filter.favorites = !state.filter.favorites;
        applyFilters(); break;
      case 'filter-tag':
        var tag = act.getAttribute('data-tag');
        state.filter.tag = state.filter.tag === tag ? '' : tag;
        applyFilters(); break;
      case 'clear-filters':
        state.filter = { favorites: false, tag: '', collection: '', provider: '', status: '' };
        applyFilters(); break;
      case 'toggle-select':
        state.selectMode = !state.selectMode;
        if (!state.selectMode) state.selection.clear();
        refresh(); buildBulkBar(); break;
      case 'new-collection': newCollection(); break;
      case 'add-tag': addTag(id); break;
      case 'remove-tag': removeTag(id, act.getAttribute('data-tag')); break;
      case 'toggle-collection': toggleCollection(id, act.getAttribute('data-collection')); break;
      case 'bulk-favorite': bulk('favorite'); break;
      case 'bulk-unfavorite': bulk('unfavorite'); break;
      case 'bulk-tag':
        openDialog({
          title: 'Tag ' + state.selection.size + ' asset' + (state.selection.size === 1 ? '' : 's'),
          placeholder: 'e.g. client x',
          submitLabel: 'Apply tag',
          maxLength: 48,
        }).then(function (t) { if (t) bulk('tag', { tag: t }); });
        break;
      case 'bulk-collect':
        openDialog({
          title: 'Add to collection',
          hint: state.selection.size + ' asset' + (state.selection.size === 1 ? '' : 's') + ' selected.',
          choices: state.collections.map(function (c) {
            return { id: c.id, label: c.name, color: c.color,
                     meta: c.item_count + (c.item_count === 1 ? ' item' : ' items') };
          }),
        }).then(function (c) { if (c) bulk('collect', { collection_id: c.id }); });
        break;
      case 'bulk-download': bulkDownload(); break;
      case 'bulk-clear':
        state.selection.clear(); refresh(); buildBulkBar(); break;
      default:
        if (action.indexOf('remix-') === 0) remix(action, id, act.getAttribute('data-prompt') || '');
    }
  }, true);

  document.addEventListener('change', function (e) {
    var act = e.target.closest && e.target.closest('[data-lib-act]');
    if (!act || act.tagName !== 'SELECT') return;
    var action = act.getAttribute('data-lib-act');
    if (action === 'filter-collection') state.filter.collection = act.value;
    else if (action === 'filter-provider') state.filter.provider = act.value;
    else if (action === 'filter-status') state.filter.status = act.value;
    else return;
    applyFilters();
  });

  // ----------------------------------------------------------------- public
  function refresh() {
    // Ids can outlive their cards across a re-render; a bulk action on a
    // vanished id reports "0 of 3 updated" and the count disagrees with the
    // ticks on screen.
    pruneSelection();
    cards().forEach(decorateCard);
    buildToolbar();
    syncEmptyState();
  }

  function decorate() {
    // history.js calls this after every grid build/patch. The first call
    // fetches; later ones just redraw from cache.
    load().then(refresh);
  }

  window.TimrXLibrary = {
    decorate: decorate,
    refresh: refresh,
    reload: function () { return load(true).then(refresh); },
    state: state,
  };

  // The modal can open before the first grid render; both entry points are
  // safe because decorate() is idempotent.
  window.addEventListener('timrx:assets-opened', decorate);
})();
