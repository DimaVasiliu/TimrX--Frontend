/**
 * history.js
 * Renders the history list. Contains HTML templates for history cards.
 */

import { byId, dateLabel, normalizeEpochMs, HISTORY_MENU_EDGE_PAD, HISTORY_SUBMENU_GAP } from './config.js';
import {
  getHistory,
  getActiveJobs,
  getPendingMeta,
  historyState,
  historyLineageCounts,
  historyFreshThumbs,
  historyActiveModelId,
  setHistoryActiveModelId,
  historyHasMore,
  historyLoadingMore,
  historyTabLoaded,
  getTabHistory,
  loadHistoryTab,
  loadMoreHistory
} from './state.js?v=20260812a';

// ============================================================================
// MENU STATE
// ============================================================================
let activeHistoryMenuBtn = null;
let activeHistoryMenu = null;
let activeHistorySubmenuBtn = null;
let activeHistorySubmenu = null;

function isMobileAssetsMenu() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  return document.body.classList.contains('assets-modal-open') &&
    window.matchMedia('(max-width: 760px)').matches;
}

function resetMenuPlacement(el) {
  if (!el) return;
  el.classList.remove('is-mobile-sheet');
  el.style.left = '';
  el.style.right = '';
  el.style.top = '';
  el.style.bottom = '';
  el.style.width = '';
}

// ============================================================================
// INFINITE SCROLL STATE (expanded gallery)
// ============================================================================
const GALLERY_SCROLL_THRESHOLD = 600; // px from bottom to trigger load
let _galleryAllCards = [];            // full card list from current data
let _galleryActiveFilter = 'all';     // current gallery filter tab
let _galleryScrollBound = false;      // scroll listener attached
let _galleryFetching = false;         // prevent concurrent DB fetches

function escapeAttr(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inferPendingStatus(meta = {}) {
  const stage = String(meta.stage || '').toLowerCase();
  if (stage === 'refine') return 'refining';
  if (stage === 'remesh') return 'remeshing';
  if (stage === 'texture') return 'texturing';
  if (stage === 'rig') return 'rigging';
  if (stage === 'animate' || stage === 'animation') return 'animating';
  return 'generating';
}

function materializePendingHistoryItems(items = []) {
  const list = Array.isArray(items) ? items : [];
  const existingIds = new Set(list.map(item => String(item?.id || '')));
  const pendingMeta = typeof getPendingMeta === 'function' ? (getPendingMeta() || {}) : {};
  const currentFilter = historyState.filter || 'all';
  const pendingEntries = Object.entries(pendingMeta);
  if (!pendingEntries.length) return list;

  const synthetic = [];
  pendingEntries.forEach(([id, meta], index) => {
    const key = String(id || '');
    if (!key || existingIds.has(key)) return;
    if (!meta || typeof meta !== 'object') return;

    const type = meta.type || (meta.stage === 'image' ? 'image' : meta.stage === 'video' ? 'video' : 'model');
    if (currentFilter !== 'all' && type !== currentFilter) return;
    const createdAt = meta.created_at || (Date.now() + index);
    const status = inferPendingStatus(meta);
    synthetic.push({
      id: key,
      type,
      status,
      status_label: meta.status_label || 'Generating...',
      created_at: createdAt,
      prompt: meta.prompt || '',
      root_prompt: meta.root_prompt || meta.prompt || '',
      title: meta.title || meta.prompt || meta.status_label || 'Generating...',
      model: meta.model || 'latest',
      license: meta.license || 'private',
      symmetry_mode: meta.symmetry_mode || 'auto',
      pose_mode: meta.pose_mode || '',
      stage: meta.stage || '',
      thumbnail_url: meta.thumbnail_url || '',
      glb_url: meta.glb_url || '',
      glb_proxy: meta.glb_proxy || '',
      preview_task_id: meta.preview_task_id || null,
      batch_count: Math.max(1, parseInt(meta.batch_count, 10) || 1),
      batch_slot: Math.max(1, parseInt(meta.batch_slot, 10) || 1),
      batch_group_id: meta.batch_group_id || null,
      generation_group_id: meta.generation_group_id || null,
      progress_pct: typeof meta.progress_pct === 'number' ? meta.progress_pct : 0,
      lineage_origin_id: meta.lineage_origin_id || meta.lineage_root_id || meta.batch_group_id || key,
      lineage_root_id: meta.lineage_root_id || meta.lineage_origin_id || meta.batch_group_id || key,
    });
  });

  return synthetic.length ? [...synthetic, ...list] : list;
}

// ============================================================================
// GROUPED CARD BUILDER
// ============================================================================

/**
 * Build grouped card as an HTML string for inline rendering in timeline/gallery.
 * After innerHTML is set, call bindGroupedCardEvents(container) to wire up click handlers.
 */
function getGroupedCardState(group, items) {
  const count = Array.isArray(items) ? items.length : 0;
  const batchTotal = Math.max(1, parseInt(group?.model_count || count, 10) || count || 1);
  const completedCount = Math.max(0, parseInt(group?.completed_count, 10) || 0);
  const failedCount = Math.max(0, parseInt(group?.failed_count, 10) || 0);

  let progressTotal = 0;
  (items || []).forEach((item) => {
    const status = (item?.status || '').toLowerCase();
    if (!status || status === 'finished') {
      progressTotal += 100;
      return;
    }
    const pct = Number(item?.progress_pct);
    progressTotal += Number.isFinite(pct) ? Math.max(0, Math.min(99, Math.round(pct))) : 0;
  });
  const avgProgress = Math.max(0, Math.min(100, Math.round(progressTotal / batchTotal)));
  const pendingCount = Math.max(0, batchTotal - completedCount - failedCount);

  let statusText = `${count} variants`;
  let statusClass = '';
  let statusKey = `idle:${count}:${batchTotal}`;

  if (pendingCount <= 0 && failedCount === 0) {
    statusText = `${batchTotal} variants · done`;
    statusKey = `done:${batchTotal}`;
  } else if (pendingCount <= 0 && failedCount > 0) {
    statusText = `${completedCount}/${batchTotal} ready · ${failedCount} failed`;
    statusClass = ' has-error';
    statusKey = `failed:${completedCount}:${failedCount}:${batchTotal}`;
  } else {
    const prefix = avgProgress > 0 ? `${avgProgress}% · ` : '';
    statusText = `${prefix}${completedCount}/${batchTotal} generating...`;
    statusClass = failedCount > 0 ? ' has-error' : ' is-generating';
    statusKey = `generating:${avgProgress}:${completedCount}:${failedCount}:${batchTotal}`;
  }

  return {
    batchTotal,
    completedCount,
    failedCount,
    avgProgress,
    statusText,
    statusClass,
    statusKey,
  };
}

function buildGroupedCardHTML(group, items) {
  const count = items.length;
  const gridCount = Math.min(count, 4);

  let thumbsHtml = '';
  items.slice(0, 4).forEach((item, i) => {
    const thumbSrc = item.thumbnail_url || item.image_url || '';
    if (thumbSrc) {
      thumbsHtml += `<img src="${thumbSrc}" alt="Variant ${i + 1}" loading="lazy" class="history-group-card__thumb-img" onerror="this.style.display='none';this.parentElement?.classList.add('thumb-broken');">`;
    } else {
      thumbsHtml += `<div class="history-group-card__thumb-img history-group-card__thumb-placeholder"><div class="history-group-card__spinner"></div></div>`;
    }
  });
  const groupedState = getGroupedCardState(group, items);
  const batchTotal = groupedState.batchTotal;
  for (let i = count; i < Math.min(batchTotal, 4); i++) {
    thumbsHtml += `<div class="history-group-card__thumb-img history-group-card__thumb-placeholder"><div class="history-group-card__spinner"></div></div>`;
  }

  const safeGroupId = String(group.id || '').replace(/"/g, '&quot;');

  const completedLabel = groupedState.completedCount > 0
    ? `${groupedState.completedCount}/${batchTotal}`
    : `0/${batchTotal}`;

  // Determine stage label from first item
  const firstStage = (items[0]?.stage || 'preview').toLowerCase();
  const stageLabel = firstStage === 'refine' || firstStage === 'refined' ? 'Refined'
    : firstStage === 'remesh' || firstStage === 'remeshed' ? 'Remeshed'
    : firstStage === 'convert' ? 'Converted'
    : firstStage === 'resize' ? 'Resized'
    : firstStage === 'uv_unwrap' || firstStage === 'uv-unwrap' ? 'UV Unwrapped'
    : firstStage === 'texture' || firstStage === 'textured' ? 'Textured'
    : firstStage === 'image3d' ? 'Image to 3D'
    : firstStage === 'multi_color_print' ? '3D Print'
    : 'Preview';

  // Collect item IDs for batch delete
  const itemIds = items.map(i => i.id).filter(Boolean);
  const safeItemIds = itemIds.join(',').replace(/"/g, '&quot;');

  // Build download variant list — each finished model gets its own download button
  const downloadSubmenuId = `dl-group-${safeGroupId}`;
  let downloadVariantItems = '';
  items.forEach((item, i) => {
    const hasGlb = !!(item.glb_url || item.glb_proxy);
    const varLabel = `Variant ${i + 1}`;
    const stg = (item.stage || 'preview').toLowerCase();
    const badge = stg === 'refine' || stg === 'refined' ? ' · Refined'
      : stg === 'remesh' || stg === 'remeshed' ? ' · Remeshed'
      : stg === 'texture' || stg === 'textured' ? ' · Textured'
      : stg === 'multi_color_print' ? ' · 3D Print'
      : '';
    downloadVariantItems += `
      <button class="card-menu__item" type="button" data-act="download" data-id="${item.id || ''}" ${!hasGlb ? 'disabled' : ''}>
        <span class="card-menu__item-inner">
          <span class="card-menu__icon">${hasGlb ? '&#8595;' : '&#8987;'}</span>
          <span>${varLabel}${badge}</span>
        </span>
      </button>`;
  });

  const anyCanDownload = items.some(i => i.glb_url || i.glb_proxy);

  return `<div class="history-group-card" data-group-id="${safeGroupId}" data-group-count="${gridCount}">
    <div class="history-group-card__thumbs history-group-card__thumbs--${Math.min(Math.max(gridCount, batchTotal), 4)}">
      ${thumbsHtml}
    </div>
    <span class="history-group-card__stage" data-stage="${firstStage}">${stageLabel}</span>
    <div class="history-group-card__footer">
      <span class="history-group-card__count-pill">${completedLabel}</span>
      <span class="history-group-card__status-dot${groupedState.statusClass}"></span>
    </div>
    <div class="history-group-card__menu-wrap">
      <button class="history-group-card__menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Group actions" data-history-menu>
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <circle cx="5" cy="12" r="2"/>
          <circle cx="12" cy="12" r="2"/>
          <circle cx="19" cy="12" r="2"/>
        </svg>
      </button>
      <div class="card-menu" role="menu" aria-label="Group actions">
        <div class="card-menu__list">
          <button class="card-menu__item" type="button" data-act="open-group" data-group-id="${safeGroupId}">
            <span class="card-menu__item-inner">
              <span class="card-menu__icon">&#9638;</span>
              <span>Open in Viewer</span>
            </span>
          </button>
          <div class="card-menu__divider"></div>
          <button class="card-menu__item" type="button" data-submenu-open="${downloadSubmenuId}" aria-expanded="false" ${!anyCanDownload ? 'disabled' : ''}>
            <span class="card-menu__item-inner">
              <span class="card-menu__icon">&#8595;</span>
              <span>Download</span>
            </span>
            <span class="card-menu__arrow">></span>
          </button>
          <div class="card-menu__divider"></div>
          <button class="card-menu__item card-submenu__item--community" type="button" data-act="share-community" data-id="${itemIds[0] || ''}">
            <span class="card-menu__item-inner">
              <span class="card-menu__icon">&#9651;</span>
              <span>Share to Community</span>
            </span>
          </button>
          <button class="card-menu__item" type="button" data-act="share-inspire" data-id="${itemIds[0] || ''}">
            <span class="card-menu__item-inner">
              <span class="card-menu__icon">&#10024;</span>
              <span>Share to Inspire</span>
            </span>
          </button>
          <div class="card-menu__divider"></div>
          <button class="card-menu__item is-danger" type="button" data-act="delete-group" data-group-ids="${safeItemIds}">
            <span class="card-menu__item-inner">
              <span class="card-menu__icon">&#128465;</span>
              <span>Delete All (${itemIds.length})</span>
            </span>
          </button>
        </div>
      </div>
      <div class="card-submenu" data-submenu-panel="${downloadSubmenuId}" role="menu" aria-label="Download variant">
        <div class="card-menu__list">
          ${downloadVariantItems}
        </div>
      </div>
    </div>
  </div>`;
}

const _groupedCardData = new Map();

function bindGroupedCardEvents(container) {
  if (!container) return;
  container.querySelectorAll('.history-group-card[data-group-id]').forEach(card => {
    const gid = card.dataset.groupId;
    const items = _groupedCardData.get(gid);
    if (!items) return;

    card.onclick = function (e) {
      // Let menu button, card-menu, submenu, and action buttons bubble to grid
      if (e.target.closest('[data-history-menu]') ||
          e.target.closest('.card-menu') ||
          e.target.closest('.card-submenu') ||
          e.target.closest('[data-act]') ||
          e.target.closest('[data-submenu-open]')) {
        return; // Don't stop propagation — let grid delegation handle it
      }
      e.stopPropagation();
      // The library sits on top of the workspace; leaving it open meant the
      // grouped viewer loaded behind it and the click looked like it did nothing.
      if (document.body.classList.contains('assets-modal-open')) {
        window.TimrXAssets?.close?.();
      }
      // Close expanded gallery view first so the 3D viewer is visible
      if (historyState.galleryExpanded) {
        historyState.galleryExpanded = false;
        renderHistory();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      // Switch to the model panel WITHOUT opening its control sheet — the rail
      // button's own handler pops the Prompt/Settings sheet over the viewer.
      if (typeof window.TimrXViewer?.activateWorkspacePanelForViewer === 'function') {
        window.TimrXViewer.activateWorkspacePanelForViewer('model');
      } else {
        try { window.TimrXSheet?.close?.(); } catch (_) { /* sheet not booted */ }
        if (typeof window.TimrXWorkspace?.activatePanel === 'function') {
          window.TimrXWorkspace.activatePanel('model', { reveal: false });
        } else {
          document.querySelector('.rail-btn[data-panel="model"]')?.click();
          try { window.TimrXSheet?.close?.(); } catch (_) { /* sheet not booted */ }
        }
      }
      // Ensure the 3D viewer wrapper is visible (not hidden by image/video mode)
      const model3dViewer = document.getElementById('model3dViewer');
      if (model3dViewer) model3dViewer.classList.remove('hidden');
      const imageViewer = document.getElementById('imageViewer');
      const videoViewer = document.getElementById('videoViewer');
      if (imageViewer) imageViewer.classList.add('hidden');
      if (videoViewer) videoViewer.classList.add('hidden');

      // Ensure Three.js viewer is booted
      if (typeof window.TimrXViewer?.checkViewerAvailable === 'function') {
        window.TimrXViewer.checkViewerAvailable();
      }
      if (window.timrx3D?.resize) {
        window.timrx3D.resize();
      }

      // Small delay to let the DOM settle after panel switch
      requestAnimationFrame(() => {
        if (typeof window.openGroupedViewer === 'function') {
          window.openGroupedViewer(gid, items);
        }
      });
    };
  });
}

/**
 * Show / hide / update the loading sentinel at the bottom of the gallery.
 */
function _updateGallerySentinel(show, rendered, total) {
  const section = document.querySelector('.expanded-section');
  if (!section) return;
  let sentinel = section.querySelector('.expanded-gallery-sentinel');

  if (show) {
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.className = 'expanded-gallery-sentinel';
      section.appendChild(sentinel);
    }
    const moreLabel = total ? `${rendered} of ${total}+` : 'Loading more…';
    sentinel.innerHTML = `
      <div class="expanded-gallery-loader">
        <div class="expanded-gallery-loader__dot"></div>
        <div class="expanded-gallery-loader__dot"></div>
        <div class="expanded-gallery-loader__dot"></div>
      </div>
      <span class="expanded-gallery-loader__text">${moreLabel}</span>
    `;
  } else if (sentinel) {
    sentinel.remove();
  }
}

/**
 * Fetch more history items from the DB, rebuild cards, and append the NEW
 * cards into the already-rendered grid (so existing cards don't flicker).
 */
async function _fetchAndAppendMore() {
  if (_galleryFetching || !historyState.galleryExpanded) return;
  if (!historyHasMore() && !historyLoadingMore()) return;

  _galleryFetching = true;
  const grid = document.querySelector('.expanded-thumbs-grid');
  const renderedBefore = grid ? grid.children.length : 0;

  _updateGallerySentinel(true, renderedBefore);

  try {
    const newItems = await loadMoreHistory();
    if (!newItems.length) {
      _updateGallerySentinel(false);
      return;
    }

    // Full re-render is called by the polling cycle after state changes,
    // but we can trigger it now for immediate feedback.
    renderHistory();
  } catch (err) {
    console.warn('[Gallery] loadMore error:', err);
  } finally {
    _galleryFetching = false;
    _updateGallerySentinel(historyHasMore(), 0);
  }
}

function _onGalleryScroll() {
  if (!historyState.galleryExpanded) return;
  if (_galleryFetching) return;

  const scrollY = window.scrollY || window.pageYOffset;
  const windowH = window.innerHeight;
  const docH = document.documentElement.scrollHeight;

  // Near the bottom? Fetch more from DB
  if (docH - scrollY - windowH < GALLERY_SCROLL_THRESHOLD) {
    _fetchAndAppendMore();
  }
}

function _ensureScrollTopFab() {
  let fab = document.querySelector('.expanded-gallery-scroll-top');
  if (!fab) {
    fab = document.createElement('button');
    fab.className = 'expanded-gallery-scroll-top';
    fab.setAttribute('aria-label', 'Scroll to top');
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>`;
    fab.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.body.appendChild(fab);
  }
  return fab;
}

function _onGalleryScrollFab() {
  const fab = document.querySelector('.expanded-gallery-scroll-top');
  if (!fab) return;
  const scrollY = window.scrollY || window.pageYOffset;
  fab.classList.toggle('is-visible', scrollY > 400);
}

function _bindGalleryScroll() {
  if (_galleryScrollBound) return;
  window.addEventListener('scroll', _onGalleryScroll, { passive: true });
  window.addEventListener('scroll', _onGalleryScrollFab, { passive: true });
  _ensureScrollTopFab();
  _galleryScrollBound = true;
}

function _unbindGalleryScroll() {
  if (!_galleryScrollBound) return;
  window.removeEventListener('scroll', _onGalleryScroll);
  window.removeEventListener('scroll', _onGalleryScrollFab);
  const fab = document.querySelector('.expanded-gallery-scroll-top');
  if (fab) fab.remove();
  _galleryScrollBound = false;
}

/**
 * Update the gallery header stat pills and family-filter counts
 * after new cards have been appended to the grid.
 */
function _updateGalleryHeaderStats(gridEl) {
  if (!gridEl) return;
  // Stack revisions are in the DOM but belong to their face card — counting
  // them would make the chips disagree with what the grid shows.
  const thumbs = gridEl.querySelectorAll('.expanded-thumb:not([data-stack-revision])');
  const counts = { all: thumbs.length, model: 0, image: 0, animated: 0, video: 0 };
  thumbs.forEach(t => {
    const type = t.getAttribute('data-asset-type') || '';
    if (counts[type] !== undefined) counts[type]++;
  });

  // Update filter pill counts
  document.querySelectorAll('.expanded-filter-btn').forEach(btn => {
    const f = btn.getAttribute('data-gallery-filter');
    const countEl = btn.querySelector('.expanded-filter-btn__count');
    if (!countEl || !f) return;
    if (f === 'all') countEl.textContent = counts.all;
    else if (counts[f] !== undefined) countEl.textContent = counts[f];
  });
}

/**
 * Reset gallery filter tab — re-filters already-loaded cards client-side
 * and shows/hides them. Does NOT re-fetch from DB (that happens on scroll).
 */
export function resetGalleryInfiniteScroll(filter) {
  _galleryActiveFilter = filter || 'all';
  const grid = document.querySelector('.expanded-thumbs-grid');
  if (!grid) return;

  document.querySelectorAll('.expanded-filter-btn').forEach((btn) => {
    const active = btn.getAttribute('data-gallery-filter') === _galleryActiveFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // Client-side show/hide by asset type
  grid.querySelectorAll('.expanded-thumb').forEach(thumb => {
    const hidden = filter !== 'all' && thumb.getAttribute('data-asset-type') !== filter;
    thumb.classList.toggle('is-gallery-hidden', hidden);
  });
  syncGalleryLiveHeading(grid);

  // If few visible cards remain, try fetching more
  const visible = grid.querySelectorAll('.expanded-thumb:not(.is-gallery-hidden)').length;
  if (visible < 12 && historyHasMore()) {
    _fetchAndAppendMore();
  }
}

export function syncAssetsToolbarFilters() {
  const slot = document.getElementById('assetsToolbarFilters');
  if (!slot) return;

  const source = document.querySelector('#historyGrid .expanded-filter-bar');
  if (source && source.parentElement !== slot) {
    slot.replaceChildren(source);
    return;
  }

  if (!source && slot.firstElementChild && !historyState.galleryExpanded) {
    slot.replaceChildren();
  }
}

// ---------------------------------------------------------------------------
// Version stacks: one card per lineage, older revisions folded behind it.
// A single delegated listener survives every grid rebuild, so expansion state
// is restored from the DOM rather than re-bound per card.
// ---------------------------------------------------------------------------
const _expandedStacks = new Set();

function applyStackState(grid) {
  if (!grid) return;
  grid.querySelectorAll('.expanded-thumb[data-stack-face="1"]').forEach((face) => {
    const key = face.getAttribute('data-stack-key') || '';
    const open = _expandedStacks.has(key);
    face.classList.toggle('is-stack-open', open);
    const toggle = face.querySelector('[data-stack-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  grid.querySelectorAll('.expanded-thumb[data-stack-revision="1"]').forEach((rev) => {
    const key = rev.getAttribute('data-stack-key') || '';
    rev.classList.toggle('is-stack-hidden', !_expandedStacks.has(key));
  });
}

function _onStackToggleClick(e) {
  const btn = e.target?.closest?.('[data-stack-toggle]');
  if (!btn) return;
  // Must not fall through to the card's open-in-viewer handler.
  e.preventDefault();
  e.stopPropagation();
  const key = btn.getAttribute('data-stack-toggle') || '';
  if (_expandedStacks.has(key)) _expandedStacks.delete(key);
  else _expandedStacks.add(key);
  applyStackState(btn.closest('.expanded-thumbs-grid') || document);
}

if (typeof document !== 'undefined' && !document.__txStackToggleBound) {
  document.__txStackToggleBound = true;
  document.addEventListener('click', _onStackToggleClick, true);
}

function getHistoryMenuHost(node) {
  return node?.closest?.('.history-thumb, .expanded-thumb, .history-group-card') || null;
}

function getHistoryMenuHosts(node) {
  const host = getHistoryMenuHost(node);
  if (!host) return [];
  const hosts = [host];
  // Group cards sit inside an animated .expanded-thumb wrapper in the All
  // gallery. Both ancestors must lose their transform while a fixed menu is
  // open, otherwise the outer wrapper still becomes the fixed-positioning
  // containing block.
  const outer = host.closest('.expanded-thumb');
  if (outer && outer !== host) hosts.push(outer);
  return hosts;
}

// Export getters for menu state (needed by main.js)
export function getGroupedCardItems(groupId) {
  return _groupedCardData.get(String(groupId)) || null;
}

export function getActiveHistoryMenu() {
  return { btn: activeHistoryMenuBtn, menu: activeHistoryMenu };
}

export function getActiveHistorySubmenu() {
  return { btn: activeHistorySubmenuBtn, submenu: activeHistorySubmenu };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a short title from various input types
 */
export function shortTitle(input, words = 6) {
  let t = '';
  if (typeof input === 'string') t = input.trim();
  else if (input && typeof input === 'object') {
    t = input.prompt || input.title || input.name || input.model_name || '';
    if (!t) {
      const src = input.filename || input.glb_proxy || input.glb_url || '';
      const m = String(src).match(/([^/?#]+?)(\.glb|\.gltf)?(?:[?#].*)?$/i);
      if (m) t = m[1].replace(/[_-]+/g, ' ');
    }
  }
  if (!t) return '(untitled)';
  const parts = t.split(/\s+/);
  const cut = parts.slice(0, words).join(' ');
  return parts.length > words ? cut + '...' : cut;
}

function normalizePromptText(input = '') {
  if (!input || typeof input !== 'string') return '';
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

function promptFingerprint(input = '') {
  const normalized = normalizePromptText(input);
  if (!normalized) return '';
  return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
}

function itemPromptFingerprint(item = {}) {
  if (!item || typeof item !== 'object') return '';
  return item.prompt_fingerprint || promptFingerprint(item.root_prompt || item.prompt || item.title || '');
}

/**
 * Short, human provider label for the card caption ("Meshy", "Seedance",
 * "Nano Banana"...). Falls back to the AI-model label so a card never shows a
 * raw slug. Returns '' when we genuinely don't know — the caption then just
 * omits the chip rather than printing "Unknown".
 */
const PROVIDER_LABELS = Object.freeze({
  meshy: 'Meshy',
  piapi: 'PiAPI',
  seedance: 'Seedance',
  fal: 'Fal',
  fal_seedance: 'Seedance',
  gemini: 'Gemini',
  veo: 'Veo',
  vertex: 'Veo',
  openai: 'OpenAI',
  flux_pro: 'Flux Pro',
  ideogram_v3: 'Ideogram',
  recraft_v4: 'Recraft',
  nano_banana: 'Nano Banana',
  google_nano: 'Nano Banana',
  piapi_nano_banana: 'Nano Banana',
  nano_banana_pro: 'Nano Banana Pro',
});

function providerLabelFor(item = {}) {
  const raw = String(item.provider || item.provider_name || (item.payload || {}).provider || '').toLowerCase().trim();
  if (raw && PROVIDER_LABELS[raw]) return PROVIDER_LABELS[raw];
  if (raw) {
    // Unknown slug: title-case it rather than dropping information.
    return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (item.glb_url || item.glb_proxy) return aiModelLabel(item.ai_model);
  return '';
}

function aiModelLabel(value = '') {
  const normalized = (value || '').toLowerCase().replace(/\s+/g, '');
  if (!normalized) return 'Meshy';
  if (normalized === 'latest' || normalized === 'meshy6' || normalized === 'meshy6preview') return 'Meshy 6';
  if (normalized === 'meshy5') return 'Meshy 5';
  return value;
}

function licenseLabel(value = '') {
  const normalized = (value || '').toLowerCase();
  if (normalized.includes('cc')) return 'CC BY 4.0';
  return 'Private';
}

function symmetryLabel(value = '') {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'off') return 'Off';
  if (normalized === 'on') return 'On';
  return 'Auto';
}

function getDedupeKey(item = {}) {
  const provider = item.provider || item.provider_used || item.ai_provider || item?.payload?.provider || 'unknown';
  const upstream = item.upstream_id
    || item.upstream_job_id
    || item.original_id
    || item?.payload?.upstream_id
    || item?.payload?.original_id
    || item?.payload?.original_job_id
    || item?.payload?.job_id
    || '';
  if (upstream) return `job:${upstream}`;
  if (item.image_id) return `image:${item.image_id}`;
  if (item.model_id) return `model:${item.model_id}`;
  const glbUrl = item.glb_url || item?.payload?.glb_url || '';
  const imageUrl = item.image_url || item?.payload?.image_url || '';
  const contentHash = item.content_hash || item?.payload?.content_hash || '';
  const itemType = item.type || item.item_type || (glbUrl ? 'model' : imageUrl ? 'image' : '');
  if (itemType === 'model' && glbUrl) return `${provider}:glb:${glbUrl}`;
  if (itemType === 'image' && imageUrl) return `${provider}:img:${imageUrl}`;
  if (contentHash) return `${provider}:hash:${contentHash}`;
  return item.id ? `${provider}:id:${item.id}` : '';
}

function getCreatedAt(item = {}) {
  const ts = item.created_at || item.updated_at;
  if (!ts) return 0;
  return normalizeEpochMs(ts);
}

function dedupeHistoryItems(items = []) {
  const map = new Map();
  items.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const key = getDedupeKey(item);
    const mapKey = key || `fallback:${item.id || idx}`;
    const existing = map.get(mapKey);
    if (!existing) {
      map.set(mapKey, item);
      return;
    }
    const existingTime = getCreatedAt(existing);
    const currentTime = getCreatedAt(item);
    if (currentTime >= existingTime) {
      map.set(mapKey, item);
    }
  });
  return Array.from(map.values());
}

// ============================================================================
// LINEAGE GROUPING
// ============================================================================

function getLineageKey(item = {}) {
  if (!item || typeof item !== 'object') return '';
  // Primary: lineage_origin_id from backend DB column
  if (item.lineage_origin_id) return String(item.lineage_origin_id);
  // Also check lineage_root_id (set by frontend watchers during current session)
  if (item.lineage_root_id) return String(item.lineage_root_id);
  // Fallback: check payload for lineage/source fields (older records)
  const payload = item.payload || {};
  const fallbackCandidates = [
    payload.lineage_origin_id,
    payload.lineage_root_id,
    payload.source_task_id,
    payload.preview_task_id,
    payload.parent_job_id,
    item.preview_task_id,
    item.source_job_id,
    item.parent_job_id,
  ];
  for (const val of fallbackCandidates) {
    if (val) return String(val);
  }
  return String(item.id || '');
}

function normalizeHistoryStage(stage = '') {
  const value = String(stage || '').toLowerCase();
  if (value === 'remeshed') return 'remesh';
  if (value === 'rigged') return 'rig';
  if (value === 'animated' || value === 'animation') return 'animate';
  if (value === 'textured') return 'texture';
  if (value === 'refined') return 'refine';
  return value || 'preview';
}

function historyPrimaryAssetUrl(item = {}) {
  const payload = item.payload || {};
  return item.glb_url
    || item.model_urls?.glb
    || payload.glb_url
    || payload.model_urls?.glb
    || payload.rigged_character_glb_url
    || payload.animation_glb_url
    || item.image_url
    || payload.image_url
    || item.video_url
    || payload.video_url
    || '';
}

function canonicalHistoryAssetUrl(rawUrl = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const url = new URL(rawUrl, window.location.origin);
    const proxied = url.searchParams.get('u');
    if (proxied) return canonicalHistoryAssetUrl(decodeURIComponent(proxied));
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch (_) {
    return rawUrl.split('#')[0].split('?')[0];
  }
}

function preferHistoryDuplicateCandidate(current, next) {
  const currentFinished = current?.status === 'finished' || current?.status === 'done' || !current?.status;
  const nextFinished = next?.status === 'finished' || next?.status === 'done' || !next?.status;
  if (currentFinished !== nextFinished) return nextFinished ? next : current;
  return getCreatedAt(next) >= getCreatedAt(current) ? next : current;
}

function dedupeLineageModels(models = []) {
  const output = [];
  const exactAssetKeys = new Map();

  models.forEach((item) => {
    if (!item) return;
    const url = canonicalHistoryAssetUrl(historyPrimaryAssetUrl(item));
    const key = url ? `${normalizeHistoryStage(item.stage)}|${url}` : '';
    if (!key) {
      output.push(item);
      return;
    }

    const existingIndex = exactAssetKeys.get(key);
    if (existingIndex === undefined) {
      exactAssetKeys.set(key, output.length);
      output.push(item);
      return;
    }

    output[existingIndex] = preferHistoryDuplicateCandidate(output[existingIndex], item);
  });

  return output;
}

function groupByLineage(items = []) {
  const lineages = new Map();
  const fingerprintCounts = new Map();
  let fallbackCount = 0;

  // ── Pass 0: Detect batch groups ──
  const batchGroupMap = new Map();
  items.forEach(item => {
    if (!item) return;
    const bgid = item.batch_group_id
      || (item.payload && item.payload.batch_group_id)
      || null;
    const bc = parseInt(item.batch_count || (item.payload && item.payload.batch_count), 10) || 1;
    if (bgid && bc > 1) {
      if (!batchGroupMap.has(bgid)) {
        batchGroupMap.set(bgid, `batch:${bgid}`);
      }
    }
  });

  items.forEach(item => {
    const fp = itemPromptFingerprint(item);
    if (!fp) return;
    fingerprintCounts.set(fp, (fingerprintCounts.get(fp) || 0) + 1);
  });

  // Stage prefixes to strip from group titles
  const _stagePrefixes = /^(rig|remesh|texture|refine|animate|animation)\s+/i;

  items.forEach(item => {
    if (!item) return;

    const bgid = item.batch_group_id
      || (item.payload && item.payload.batch_group_id)
      || null;
    const bc = parseInt(item.batch_count || (item.payload && item.payload.batch_count), 10) || 1;
    const isBatchSibling = bgid && bc > 1 && batchGroupMap.has(bgid);

    const lineageKey = getLineageKey(item);
    const hasExplicitLineage = !!(item.lineage_origin_id || item.lineage_root_id);
    const fingerprint = itemPromptFingerprint(item);
    const shouldUsePromptCohort = !hasExplicitLineage && fingerprint && fingerprintCounts.get(fingerprint) >= 3;
    const promptKey = shouldUsePromptCohort ? `prompt:${fingerprint}` : '';

    let rootKey;
    if (isBatchSibling) {
      rootKey = batchGroupMap.get(bgid);
    } else {
      rootKey = (hasExplicitLineage ? lineageKey : '') || promptKey || lineageKey || String(item.id || '');
    }

    if (!hasExplicitLineage && !promptKey && !isBatchSibling) fallbackCount++;

    if (!lineages.has(rootKey)) {
      lineages.set(rootKey, {
        id: item.id,
        rootId: rootKey,
        title: shortTitle(item),
        created_at: item.created_at,
        models: [],
        isBatchGroup: isBatchSibling,
        batchGroupId: isBatchSibling ? bgid : null,
        batchCount: isBatchSibling ? bc : 0,
      });
    }

    const lineage = lineages.get(rootKey);
    lineage.models.push(item);
    if (isBatchSibling) {
      lineage.isBatchGroup = true;
      lineage.batchGroupId = bgid;
      lineage.batchCount = Math.max(lineage.batchCount || 0, bc);
    }

    // Pick group title from the oldest item, preferring base stages over derived
    const stage = (item.stage || '').toLowerCase();
    const isBase = !stage || stage === 'preview' || stage === 'image3d';
    const lineageTime = lineage.created_at ? new Date(lineage.created_at).getTime() : Infinity;
    const itemTime = item.created_at ? new Date(item.created_at).getTime() : Infinity;

    if (isBase || itemTime < lineageTime) {
      lineage.created_at = item.created_at || lineage.created_at;
      // Use clean title: strip stage prefixes like "Rig ", "Remesh " from group heading
      let title = shortTitle(item);
      title = title.replace(_stagePrefixes, '').trim() || title;
      // Only update title if this is a base item or if current title looks derived
      if (isBase || lineage.title.match(_stagePrefixes)) {
        lineage.title = title;
      }
    }
  });

  if (fallbackCount > 0) {
    console.log(`[HISTORY_GROUP] ${fallbackCount} items used fallback grouping (no lineage_origin_id)`);
  }

  lineages.forEach((lineage) => {
    lineage.rawModelCount = lineage.models.length;
    lineage.models = dedupeLineageModels(lineage.models);
  });

  return Array.from(lineages.values());
}

// ============================================================================
// BUNDLE BUILDING
// ============================================================================

const BATCH_BUNDLE_WINDOW_MS = 1000 * 60 * 5;

function deriveBatchBundleKey(model = {}) {
  if (!model || typeof model !== 'object') return '';
  const stage = (model.stage || '').toLowerCase();
  const batchCount = Math.max(1, parseInt(model.batch_count, 10) || 1);
  if (batchCount <= 1 || stage !== 'preview') return '';
  const declared = model.batch_group_id || model.batch_cohort_id;
  if (declared) return `declared:${declared}`;
  const fingerprint = itemPromptFingerprint(model);
  if (!fingerprint) return '';
  const createdBucket = model.created_at
    ? Math.floor(normalizeEpochMs(model.created_at) / BATCH_BUNDLE_WINDOW_MS)
    : '';
  return `cohort:${fingerprint}:${createdBucket}:${batchCount}`;
}

/**
 * Deterministic sort for models within a family.
 * Stage-based order first (preview → refine → texture → remesh → rig → animate),
 * then by created_at, so the same family renders identically before and after reload.
 */
const _STAGE_ORDER = { preview: 0, image3d: 1, refine: 2, texture: 3, remesh: 4,
  convert: 4, resize: 4, uv_unwrap: 4, 'uv-unwrap': 4, rig: 5, animate: 6, animation: 6 };

function compareHistoryModels(a = {}, b = {}) {
  const stageA = (a?.stage || 'preview').toLowerCase();
  const stageB = (b?.stage || 'preview').toLowerCase();
  const orderA = _STAGE_ORDER[stageA] ?? 99;
  const orderB = _STAGE_ORDER[stageB] ?? 99;
  if (orderA !== orderB) return orderA - orderB;
  // Within the same stage, sort by time
  const timeA = a?.created_at ? new Date(a.created_at).getTime() : 0;
  const timeB = b?.created_at ? new Date(b.created_at).getTime() : 0;
  if (timeA !== timeB) {
    return historyState.sort === 'asc' ? timeA - timeB : timeB - timeA;
  }
  return 0;
}

function buildLineageBundles(models = []) {
  if (!Array.isArray(models) || !models.length) return [];
  const map = new Map();
  models.forEach((model) => {
    const key = deriveBatchBundleKey(model);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(model);
  });

  const validBundleKeys = new Set();
  map.forEach((arr, key) => {
    if (Array.isArray(arr) && arr.length > 1) validBundleKeys.add(key);
  });

  const seen = new Set();
  const bundles = [];
  models.forEach((model) => {
    if (!model) return;
    const key = deriveBatchBundleKey(model);
    if (key && validBundleKeys.has(key)) {
      if (seen.has(key)) return;
      seen.add(key);
      const bucket = map.get(key) || [];
      const ordered = bucket.slice().sort((a, b) => {
        const slotA = parseInt(a.batch_slot, 10) || 0;
        const slotB = parseInt(b.batch_slot, 10) || 0;
        if (slotA !== slotB) return slotA - slotB;
        return compareHistoryModels(a, b);
      });
      bundles.push({ key, models: ordered, isBundle: true });
    } else {
      bundles.push({
        key: `single-${model.id || Math.random()}`,
        models: [model],
        isBundle: false
      });
    }
  });
  return bundles;
}

// ============================================================================
// MENU POSITIONING
// ============================================================================

export function closeActiveHistorySubmenu() {
  if (activeHistorySubmenuBtn) {
    activeHistorySubmenuBtn.setAttribute('aria-expanded', 'false');
    activeHistorySubmenuBtn.classList.remove('is-open');
  }
  if (activeHistorySubmenu) {
    activeHistorySubmenu.classList.remove('is-open');
    resetMenuPlacement(activeHistorySubmenu);
  }
  if (activeHistoryMenu) activeHistoryMenu.classList.remove('has-mobile-submenu');
  activeHistorySubmenuBtn = null;
  activeHistorySubmenu = null;
}

export function closeActiveHistoryMenu() {
  closeActiveHistorySubmenu();
  if (activeHistoryMenuBtn) {
    activeHistoryMenuBtn.setAttribute('aria-expanded', 'false');
    activeHistoryMenuBtn.classList.remove('is-open');
    getHistoryMenuHosts(activeHistoryMenuBtn).forEach((host) => host.classList.remove('is-menu-open'));
  }
  if (activeHistoryMenu) {
    activeHistoryMenu.classList.remove('is-open');
    resetMenuPlacement(activeHistoryMenu);
  }
  activeHistoryMenuBtn = null;
  activeHistoryMenu = null;
  document.body.classList.remove('history-menu-open');
}

/**
 * Open a history card menu
 */
export function openHistoryMenu(menuBtn, menu) {
  if (!menuBtn || !menu) return;
  closeActiveHistoryMenu();
  menuBtn.setAttribute('aria-expanded', 'true');
  menuBtn.classList.add('is-open');
  getHistoryMenuHosts(menuBtn).forEach((host) => host.classList.add('is-menu-open'));
  menu.classList.add('is-open');
  activeHistoryMenuBtn = menuBtn;
  activeHistoryMenu = menu;
  menu.classList.toggle('is-mobile-sheet', isMobileAssetsMenu());
  document.body.classList.add('history-menu-open');
  positionHistoryMenu(menuBtn, menu);
  requestAnimationFrame(() => {
    if (activeHistoryMenuBtn === menuBtn && activeHistoryMenu === menu) {
      positionHistoryMenu(menuBtn, menu);
    }
  });
}

/**
 * Open a history card submenu
 */
export function openHistorySubmenu(submenuBtn, submenu) {
  if (!submenuBtn || !submenu) return;
  closeActiveHistorySubmenu();
  submenuBtn.setAttribute('aria-expanded', 'true');
  submenuBtn.classList.add('is-open');
  submenu.classList.add('is-open');
  activeHistorySubmenuBtn = submenuBtn;
  activeHistorySubmenu = submenu;
  submenu.classList.toggle('is-mobile-sheet', isMobileAssetsMenu());
  if (activeHistoryMenu) activeHistoryMenu.classList.toggle('has-mobile-submenu', isMobileAssetsMenu());
  positionHistorySubmenu(submenuBtn, submenu);
}

function positionHistoryMenu(anchorBtn, menu) {
  if (!anchorBtn || !menu) return;
  if (isMobileAssetsMenu()) {
    menu.style.left = '';
    menu.style.right = '';
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.width = '';
    return;
  }
  const spacing = HISTORY_MENU_EDGE_PAD;
  const gap = 4;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  const btnRect = anchorBtn.getBoundingClientRect();
  const hostRect = getHistoryMenuHost(anchorBtn)?.getBoundingClientRect() || btnRect;
  // Reset so getBoundingClientRect returns the menu's natural size
  menu.style.left = '0px';
  menu.style.top = '0px';
  const menuRect = menu.getBoundingClientRect();
  const originLeft = menuRect.left;
  const originTop = menuRect.top;
  const menuWidth = menuRect.width;
  const menuHeight = menuRect.height;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const fits = (left, top) => left >= spacing &&
    top >= spacing &&
    left + menuWidth + spacing <= viewportWidth &&
    top + menuHeight + spacing <= viewportHeight;
  const overlapsHost = (left, top) => {
    const right = left + menuWidth;
    const bottom = top + menuHeight;
    return !(right <= hostRect.left || left >= hostRect.right || bottom <= hostRect.top || top >= hostRect.bottom);
  };

  const topNearButton = clamp(btnRect.top, spacing, viewportHeight - menuHeight - spacing);
  const alignedLeft = clamp(btnRect.right - menuWidth, spacing, viewportWidth - menuWidth - spacing);
  const candidates = [
    { left: hostRect.right + gap, top: topNearButton },
    { left: hostRect.left - menuWidth - gap, top: topNearButton },
    { left: alignedLeft, top: hostRect.bottom + gap },
    { left: alignedLeft, top: hostRect.top - menuHeight - gap }
  ];

  let chosen = candidates.find((pos) => fits(pos.left, pos.top) && !overlapsHost(pos.left, pos.top)) ||
    candidates.find((pos) => fits(pos.left, pos.top)) ||
    {
      left: clamp(alignedLeft, spacing, viewportWidth - menuWidth - spacing),
      top: clamp(hostRect.bottom + gap, spacing, viewportHeight - menuHeight - spacing)
    };

  menu.style.left = `${Math.round(chosen.left - originLeft)}px`;
  menu.style.top = `${Math.round(chosen.top - originTop)}px`;
}

function positionHistorySubmenu(anchorBtn, submenu) {
  if (!anchorBtn || !submenu) return;
  if (isMobileAssetsMenu()) {
    submenu.style.left = '';
    submenu.style.right = '';
    submenu.style.top = '';
    submenu.style.bottom = '';
    submenu.style.width = '';
    return;
  }
  const spacing = HISTORY_MENU_EDGE_PAD;
  const gap = Math.min(HISTORY_SUBMENU_GAP, 6);
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  submenu.style.left = '0px';
  submenu.style.top = '0px';

  const btnRect = anchorBtn.getBoundingClientRect();
  const menuRect = activeHistoryMenu?.getBoundingClientRect() || btnRect;
  const hostRect = activeHistoryMenuBtn ?
    (getHistoryMenuHost(activeHistoryMenuBtn)?.getBoundingClientRect() || null) :
    null;
  const submenuRect = submenu.getBoundingClientRect();
  const originLeft = submenuRect.left;
  const originTop = submenuRect.top;
  const submenuWidth = submenuRect.width;
  const submenuHeight = submenuRect.height;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const top = clamp(btnRect.top, spacing, viewportHeight - submenuHeight - spacing);
  const candidates = [
    { left: menuRect.right + gap, top },
    { left: menuRect.left - submenuWidth - gap, top },
    { left: clamp(btnRect.right - submenuWidth, spacing, viewportWidth - submenuWidth - spacing), top: menuRect.bottom + gap },
    { left: clamp(btnRect.right - submenuWidth, spacing, viewportWidth - submenuWidth - spacing), top: menuRect.top - submenuHeight - gap }
  ];

  const fitsViewport = (pos) => pos.left >= spacing &&
    pos.top >= spacing &&
    pos.left + submenuWidth + spacing <= viewportWidth &&
    pos.top + submenuHeight + spacing <= viewportHeight;
  const overlapsRect = (pos, rect) => {
    if (!rect) return false;
    const right = pos.left + submenuWidth;
    const bottom = pos.top + submenuHeight;
    return !(right <= rect.left || pos.left >= rect.right || bottom <= rect.top || pos.top >= rect.bottom);
  };

  const chosen = candidates.find((pos) => fitsViewport(pos) && !overlapsRect(pos, hostRect) && !overlapsRect(pos, menuRect)) ||
    candidates.find((pos) => fitsViewport(pos) && !overlapsRect(pos, hostRect)) ||
    candidates.find(fitsViewport) || {
      left: clamp(menuRect.left, spacing, viewportWidth - submenuWidth - spacing),
      top: clamp(menuRect.bottom + gap, spacing, viewportHeight - submenuHeight - spacing)
    };

  submenu.style.left = `${Math.round(chosen.left - originLeft)}px`;
  submenu.style.top = `${Math.round(chosen.top - originTop)}px`;
}

export function updateActiveHistoryMenuPosition() {
  if (!activeHistoryMenuBtn || !activeHistoryMenu) return;
  const mobileAssets = isMobileAssetsMenu();
  activeHistoryMenu.classList.toggle('is-mobile-sheet', mobileAssets);
  if (activeHistorySubmenu) activeHistorySubmenu.classList.toggle('is-mobile-sheet', mobileAssets);
  activeHistoryMenu.classList.toggle('has-mobile-submenu', mobileAssets && !!activeHistorySubmenu);
  positionHistoryMenu(activeHistoryMenuBtn, activeHistoryMenu);
  if (activeHistorySubmenuBtn && activeHistorySubmenu) {
    positionHistorySubmenu(activeHistorySubmenuBtn, activeHistorySubmenu);
  }
}

// ============================================================================
// HTML TEMPLATES
// ============================================================================

function buildHistorySkeleton(rows = 2, thumbsPerRow = 3) {
  const filterLabelMap = {
    all: 'assets',
    model: '3D models',
    image: 'images',
    video: 'videos',
  };
  const filter = historyState.filter || 'all';
  const label = filterLabelMap[filter] || 'assets';
  const title = filter === 'all' ? 'Loading history' : `Loading ${label}`;
  const meta = filter === 'all'
    ? 'Refreshing your latest creations and in-progress jobs.'
    : `Pulling your latest ${label} into the history panel.`;

  return `
    <div class="history-loading-state" role="status" aria-live="polite">
      <div class="history-loading-state__panel">
        <div class="history-loading-state__orbital" aria-hidden="true">
          <div class="history-loading-state__ring"></div>
          <div class="history-loading-state__core"></div>
          <span class="history-loading-state__dot history-loading-state__dot--a"></span>
          <span class="history-loading-state__dot history-loading-state__dot--b"></span>
          <span class="history-loading-state__dot history-loading-state__dot--c"></span>
        </div>
        <div class="history-loading-state__copy">
          <p class="history-loading-state__title">${title}</p>
          <p class="history-loading-state__meta">${meta}</p>
        </div>
        <div class="history-loading-state__chips" aria-hidden="true">
          <span>3D</span>
          <span>Image</span>
          <span>Video</span>
        </div>
      </div>
    </div>
  `;
}

function buildHistoryThumb(bundle = {}, isExpanded = false) {
  const models = Array.isArray(bundle?.models) ? bundle.models.filter(Boolean) : [];
  if (!models.length) return '';

  const thumbPrefix = isExpanded ? 'expanded-thumb' : 'history-thumb';
  // Gallery cards still need their full action menus when they are rendered
  // inside the Assets modal. The old expanded gallery hid them because it was
  // a read-only page, but the modal is now the primary history workspace.
  const showActions = !isExpanded || !!document.getElementById('assetsToolbarFilters') ||
    document.body?.classList.contains('assets-modal-open');
  const activeModel = historyActiveModelId
    ? models.find((m) => m && m.id === historyActiveModelId)
    : null;
  const displayModel = activeModel || models[0];
  const hasVariants = bundle.isBundle && models.length > 1;
  const itemType = (displayModel.type || (
    (displayModel.glb_url || displayModel.glb_proxy) ? 'model' :
    displayModel.video_url ? 'video' :
    displayModel.image_url ? 'image' :
    'model'
  ));

  let status = displayModel.status || 'finished';
  if (itemType === 'image' && (displayModel.image_url || displayModel.thumbnail_url)) status = 'finished';
  if (itemType === 'video' && displayModel.video_url) status = 'finished';
  if (itemType === 'model' && (displayModel.glb_url || displayModel.glb_proxy)) status = 'finished';

  const statusClass = status === 'generating' ? 'status-generating'
    : status === 'refining' ? 'status-refining'
    : status === 'remeshing' ? 'status-remeshing'
    : status === 'texturing' ? 'status-texturing'
    : status === 'rigging' ? 'status-generating'
    : status === 'animating' ? 'status-generating'
    : '';

  const isProcessing = ['generating', 'refining', 'remeshing', 'texturing', 'rigging', 'animating'].includes(status);
  const processingLabel = status === 'refining' ? 'Refining...'
    : status === 'remeshing' ? 'Remeshing...'
    : status === 'texturing' ? 'Texturing...'
    : status === 'rigging' ? 'Rigging...'
    : status === 'animating' ? 'Animating...'
    : 'Generating...';

  let modelName = displayModel.title || displayModel.prompt?.slice(0, 30) || 'New Model';
  // Clean up prefixes like "(refine)", "(texture)", "(remesh)", "(rig)", "(image2-3d)" from model names
  modelName = modelName.replace(/^\s*\((refine|texture|remesh|image2?-?3d)\)\s*/i, '');
  const createdLabel = dateLabel(displayModel.created_at);
  // Caption strip shared by every card type. The gallery used to show a bare
  // badge with no date, prompt, or provider, so two visually identical cards
  // (a duplicate, or preview vs textured of the same model) were impossible to
  // tell apart. One definition here keeps all four card branches in sync.
  const _captionProvider = providerLabelFor(displayModel);
  const _captionPromptFull = displayModel.prompt || displayModel.title || '';
  const _captionPrompt = shortTitle(displayModel, 10);
  const statusBarInner = `
        <span class="${thumbPrefix}__status-date">${createdLabel || '-'}</span>
        ${_captionProvider ? `<span class="${thumbPrefix}__status-provider">${escapeAttr(_captionProvider)}</span>` : ''}
        <span class="${thumbPrefix}__status-prompt" title="${escapeAttr(_captionPromptFull)}">${escapeAttr(_captionPrompt)}</span>`;
  const stageLC = (displayModel.stage || '').toLowerCase();
  const canRefine = status === 'finished' && !!(
    stageLC === 'preview' ||
    displayModel.preview_task_id ||
    (displayModel.payload || {}).preview_task_id
  );
  const canRemesh = !!displayModel.prompt && status === 'finished';
  const canTexture = status === 'finished';
  const canDownload = !!(displayModel.glb_url || displayModel.glb_proxy);
  const canMeshyAuto3mf = status === 'finished' && !!displayModel.id;
  const modelDownloadUrl = String(displayModel.glb_proxy || displayModel.glb_url || '').replace(/"/g, '&quot;');
  const isActive = models.some((m) => m && m.id === historyActiveModelId);
  const isFreshThumb = models.some((m) => historyFreshThumbs.has(m.id));
  const variantCount = models.length;
  const editSubmenuId = `edit-${displayModel.id}`;
  const overlayVisible = hasVariants || (Math.max(1, parseInt(displayModel.batch_count, 10) || 1) > 1);
  // IMAGE TYPE
  if (itemType === 'image') {
    // Use smallest available URL for card display (saves bandwidth),
    // but always use full-quality URL for downloads and actions.
    const thumbSrc = displayModel.thumbnail_url || displayModel.image_url || '';
    const fullSrc = displayModel.image_url || displayModel.output_url || displayModel.original_url || displayModel.thumbnail_url || '';
    const name = shortTitle(displayModel);
    const imgCanDownload = !!fullSrc && (typeof _hasCredits !== 'undefined' ? _hasCredits : true);
    const artifactFormat = (displayModel.artifact_format || displayModel.meta?.artifact_format || displayModel.format || 'png').toLowerCase();
    const isVectorImage = artifactFormat === 'svg';
    const isImageFailed = status === 'failed';

    // Failed image card
    if (isImageFailed) {
      const errorMsg = displayModel.status_label || displayModel.error_message || displayModel.error || 'Image generation failed';
      // Make moderation errors user-friendly
      const displayError = errorMsg.includes('safety system') || errorMsg.includes('moderation')
        ? 'Blocked by content policy'
        : (errorMsg.length > 50 ? errorMsg.slice(0, 50) + '...' : errorMsg);
      return `
        <div class="${thumbPrefix} ${thumbPrefix}--image ${thumbPrefix}--failed ${isActive ? 'is-active' : ''}">
          <div class="${thumbPrefix}__status-bar">
            ${statusBarInner}
            <span class="${thumbPrefix}__image-badge ${thumbPrefix}__image-badge--failed">Failed</span>
          </div>
          <div class="${thumbPrefix}__error-card">
            <span class="${thumbPrefix}__error-icon">&#9888;</span>
            <span class="${thumbPrefix}__error-text">${displayError}</span>
          </div>
          <span class="${thumbPrefix}__name">${name}</span>
          ${showActions ? `
          <div class="${thumbPrefix}__menu-wrap">
            <button class="${thumbPrefix}__menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Image actions" data-history-menu>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
            <div class="card-menu" role="menu" aria-label="Image actions">
              <div class="card-menu__list">
                <button class="card-menu__item card-menu__item--danger" type="button" data-act="delete" data-id="${displayModel.id}">
                  <span class="card-menu__item-inner">
                    <span class="card-menu__icon">&#128465;</span>
                    <span>Delete</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
          ` : ''}
        </div>
      `;
    }

    return `
      <div class="${thumbPrefix} ${thumbPrefix}--image ${statusClass} ${isActive ? 'is-active' : ''} ${isFreshThumb ? 'is-fresh' : ''}">
        <div class="${thumbPrefix}__status-bar">
          ${statusBarInner}
        </div>
        <div class="${thumbPrefix}__image-wrapper">
          <button class="${thumbPrefix}__image ${isProcessing ? 'is-loading' : ''}"
                  type="button"
                  data-act="open"
                  data-id="${displayModel.id}"
                  data-asset-type="image"
                  data-image-url="${escapeAttr(fullSrc)}"
                  data-thumbnail-url="${escapeAttr(thumbSrc)}"
                  data-title="${escapeAttr(name)}"
                  data-prompt="${escapeAttr(displayModel.prompt || displayModel.root_prompt || '')}"
                  aria-label="Open ${name}">
            ${thumbSrc ? `<img src="${thumbSrc}" alt="${name}" loading="lazy" onerror="this.style.display='none';">` : ''}
          </button>
        </div>
        ${isProcessing ? `
          <div class="${thumbPrefix}__processing ${thumbPrefix}__processing--image" data-job-id="${displayModel.id}">
            <span class="${thumbPrefix}__processing-label">${processingLabel}</span>
            <span class="${thumbPrefix}__processing-pct ${thumbPrefix}__processing-pct--indeterminate"></span>
            <div class="${thumbPrefix}__progress-bar ${thumbPrefix}__progress-bar--indeterminate">
              <div class="${thumbPrefix}__progress-fill"></div>
            </div>
          </div>
        ` : ''}
        <span class="${thumbPrefix}__name">${name}</span>
        ${showActions ? `
        <div class="${thumbPrefix}__menu-wrap">
          <button class="${thumbPrefix}__menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Image actions" data-history-menu>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2"/>
              <circle cx="12" cy="12" r="2"/>
              <circle cx="19" cy="12" r="2"/>
            </svg>
          </button>
          <div class="card-menu" role="menu" aria-label="Image actions">
            <div class="card-menu__list">
              <button class="card-menu__item" type="button" data-act="image-to-3d" data-id="${displayModel.id}" data-image-url="${escapeAttr(fullSrc)}" ${isVectorImage ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#127912;</span>
                  <span>${isVectorImage ? 'Rasterize Before 3D' : 'Create 3D Model'}</span>
                </span>
                <span class="card-menu__arrow">></span>
              </button>
              <button class="card-menu__item" type="button" data-act="image-to-video" data-id="${displayModel.id}" data-image-url="${escapeAttr(fullSrc)}" ${isVectorImage ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#127909;</span>
                  <span>${isVectorImage ? 'Rasterize Before Video' : 'Create Video'}</span>
                </span>
                <span class="card-menu__badge">45c</span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item" type="button" data-act="download-image" data-id="${displayModel.id}" data-image-url="${escapeAttr(fullSrc)}" ${!imgCanDownload ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#8595;</span>
                  <span>Download</span>
                </span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item card-submenu__item--community" type="button" data-act="share-community" data-id="${displayModel.id}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#9651;</span>
                  <span>Share to Community</span>
                </span>
              </button>
              <button class="card-menu__item" type="button" data-act="share-inspire" data-id="${displayModel.id}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#10024;</span>
                  <span>Share to Inspire</span>
                </span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item is-danger" type="button" data-act="delete" data-id="${displayModel.id}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#128465;</span>
                  <span>Delete</span>
                </span>
              </button>
            </div>
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }

  // VIDEO TYPE
  if (itemType === 'video') {
    const videoSrc = displayModel.video_url || displayModel.output_video_url || displayModel.media_url || '';
    const thumbSrc = displayModel.thumbnail_url || '';
    const name = shortTitle(displayModel);
    const videoCanDownload = !!videoSrc && (typeof _hasCredits !== 'undefined' ? _hasCredits : true);
    const isFailed = status === 'failed';
    const statusLabel = displayModel.status_label || '';
    const videoProcessingLabel = statusLabel
      ? statusLabel
      : status === 'generating' ? 'Generating video...'
      : status === 'processing' ? 'Processing...'
      : status === 'queued' ? 'Queued...'
      : processingLabel;
    const videoStatusClass = isFailed ? 'status-failed' : statusClass;

    // Failed video card
    if (isFailed) {
      // Prefer status_label (friendly) > error_message (raw) > fallback
      const errorMsg = displayModel.status_label || displayModel.error_message || displayModel.error || 'Video generation failed';
      const errorCode = displayModel.error_code || '';
      const isStalled = displayModel.provider_stalled;
      const failBadge = isStalled ? 'Timed out' : 'Failed';

      // Resolution-aware retry: if a high-res job failed (4K/1080p timeout),
      // suggest retrying at a lower resolution instead of blind retry.
      const failRes = displayModel.failure_resolution || displayModel.resolution || '';
      const isTimeout = errorCode.includes('timeout') || errorCode.includes('deadline') ||
                        errorMsg.toLowerCase().includes('timeout') || errorMsg.toLowerCase().includes('deadline');
      const isHighRes = failRes === '4k' || failRes === '1080p';
      const suggestLowerRes = isTimeout && isHighRes;

      // Build retry menu items with fallback options
      let retryMenuItems = `
                <button class="card-menu__item" type="button" data-act="retry-video" data-id="${displayModel.id}" data-prompt="${(displayModel.prompt || '').replace(/"/g, '&quot;')}">
                  <span class="card-menu__item-inner">
                    <span class="card-menu__icon">&#8635;</span>
                    <span>Retry Generation</span>
                  </span>
                </button>`;
      if (suggestLowerRes) {
        const fallbackRes = failRes === '4k' ? ['1080p', '720p'] : ['720p'];
        fallbackRes.forEach(res => {
          retryMenuItems += `
                <button class="card-menu__item" type="button" data-act="retry-video" data-id="${displayModel.id}" data-prompt="${(displayModel.prompt || '').replace(/"/g, '&quot;')}" data-retry-resolution="${res}">
                  <span class="card-menu__item-inner">
                    <span class="card-menu__icon">&#8595;</span>
                    <span>Retry at ${res}</span>
                  </span>
                </button>`;
        });
      }

      // Main retry button label
      const retryLabel = suggestLowerRes
        ? `<span>&#8635;</span> Retry at ${failRes === '4k' ? '1080p' : '720p'}`
        : '<span>&#8635;</span> Retry';
      const retryResAttr = suggestLowerRes
        ? ` data-retry-resolution="${failRes === '4k' ? '1080p' : '720p'}"`
        : '';

      return `
        <div class="${thumbPrefix} ${thumbPrefix}--video ${thumbPrefix}--failed ${isStalled ? thumbPrefix + '--stalled' : ''} ${isActive ? 'is-active' : ''}">
          <div class="${thumbPrefix}__status-bar">
            ${statusBarInner}
            <span class="${thumbPrefix}__video-badge ${thumbPrefix}__video-badge--failed">${failBadge}</span>
          </div>
          <div class="${thumbPrefix}__error-card">
            <span class="${thumbPrefix}__error-icon">${isStalled ? '&#9203;' : '&#9888;'}</span>
            <span class="${thumbPrefix}__error-text">${errorMsg.length > 80 ? errorMsg.slice(0, 80) + '...' : errorMsg}</span>
            <button class="${thumbPrefix}__retry-btn" type="button" data-act="retry-video" data-id="${displayModel.id}" data-prompt="${(displayModel.prompt || '').replace(/"/g, '&quot;')}"${retryResAttr}>
              ${retryLabel}
            </button>
          </div>
          <span class="${thumbPrefix}__name">${name}</span>
          ${showActions ? `
          <div class="${thumbPrefix}__menu-wrap">
            <button class="${thumbPrefix}__menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Video actions" data-history-menu>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
            <div class="card-menu" role="menu" aria-label="Video actions">
              <div class="card-menu__list">
                ${retryMenuItems}
                <div class="card-menu__divider"></div>
                <button class="card-menu__item is-danger" type="button" data-act="delete" data-id="${displayModel.id}">
                  <span class="card-menu__item-inner">
                    <span class="card-menu__icon">&#128465;</span>
                    <span>Delete</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
          ` : ''}
        </div>
      `;
    }

    // Normal/processing video card - Clean modern design with big click area
    return `
      <div class="${thumbPrefix} ${thumbPrefix}--video ${videoStatusClass} ${isActive ? 'is-active' : ''} ${isFreshThumb ? 'is-fresh' : ''}">
        <div class="${thumbPrefix}__status-bar">
          ${statusBarInner}
        </div>
        <button class="${thumbPrefix}__video-click ${isProcessing ? 'is-loading' : ''}"
                type="button"
                data-act="open-video"
                data-id="${displayModel.id}"
                data-asset-type="video"
                data-video-url="${escapeAttr(videoSrc)}"
                data-thumbnail-url="${escapeAttr(thumbSrc)}"
                data-title="${escapeAttr(name)}"
                data-prompt="${escapeAttr(displayModel.prompt || displayModel.root_prompt || '')}"
                aria-label="Play ${name}"
                ${isProcessing ? 'disabled' : ''}>
          ${thumbSrc ? `<img src="${thumbSrc}" alt="${name}" loading="lazy" onerror="this.style.display='none';">` : `
            <div class="${thumbPrefix}__video-empty">
              <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 19 12 8 19 8 5"/></svg>
            </div>
          `}
          ${!isProcessing && videoSrc ? `
            <span class="${thumbPrefix}__play-btn">
              <svg viewBox="0 0 24 24" fill="none">
                <polygon points="9 6 18 12 9 18 9 6" fill="currentColor"/>
              </svg>
            </span>
          ` : ''}
          <span class="${thumbPrefix}__video-name">${name}</span>
        </button>
        ${isProcessing ? `
          <div class="${thumbPrefix}__video-processing" data-job-id="${displayModel.id}">
            <div class="${thumbPrefix}__video-spinner">
              <span class="${thumbPrefix}__video-spinner-dot"></span>
            </div>
            <span class="${thumbPrefix}__video-status">${videoProcessingLabel}</span>
          </div>
        ` : ''}
        ${showActions ? `
        <div class="${thumbPrefix}__menu-wrap">
          <button class="${thumbPrefix}__menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Video actions" data-history-menu>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2"/>
              <circle cx="12" cy="12" r="2"/>
              <circle cx="19" cy="12" r="2"/>
            </svg>
          </button>
          <div class="card-menu card-menu--video" role="menu" aria-label="Video actions">
            <div class="card-menu__list">
              <button class="card-menu__item" type="button" data-act="download-video" data-id="${displayModel.id}" data-video-url="${escapeAttr(videoSrc)}" ${!videoCanDownload ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#8595;</span>
                  <span>Download</span>
                </span>
              </button>
              <button class="card-menu__item" type="button" data-act="copy-video-link" data-id="${displayModel.id}" data-video-url="${escapeAttr(videoSrc)}" ${!videoCanDownload ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#128279;</span>
                  <span>Copy Link</span>
                </span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item card-submenu__item--community" type="button" data-act="share-community" data-id="${displayModel.id}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#9651;</span>
                  <span>Share to Community</span>
                </span>
              </button>
              <button class="card-menu__item" type="button" data-act="share-inspire" data-id="${displayModel.id}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#10024;</span>
                  <span>Share to Inspire</span>
                </span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item is-danger" type="button" data-act="delete" data-id="${displayModel.id}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#128465;</span>
                  <span>Delete</span>
                </span>
              </button>
            </div>
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }

  // MODEL TYPE
  // A derived asset (e.g. a rigged model) often has no thumbnail of its own —
  // fall back to the group's thumbnail so its tile is never blank.
  const galleryGroupThumb = (function(){
    var wt = models.find(function(m){ return m && (m.thumbnail_url || m.image_url); });
    return wt ? (wt.thumbnail_url || wt.image_url) : '';
  })();
  const buildSinglePreview = (model) => {
    const isVariantActive = historyActiveModelId === model.id;
    const _thumb = model.thumbnail_url || galleryGroupThumb;
    return `
      <button class="${thumbPrefix}__preview ${isVariantActive ? 'is-focused' : ''} ${status === 'generating' ? 'is-loading' : ''}"
              type="button"
              data-act="open"
              data-id="${model.id}"
              data-asset-type="model"
              data-glb-url="${escapeAttr(model.glb_url || model.model_url || model.model_glb_url || '')}"
              data-glb-proxy="${escapeAttr(model.glb_proxy || '')}"
              data-stl-url="${escapeAttr(model.stl_url || model.model_stl_url || model.print_url || '')}"
              data-thumbnail-url="${escapeAttr(_thumb)}"
              data-title="${escapeAttr(shortTitle(model))}"
              data-prompt="${escapeAttr(model.prompt || model.root_prompt || '')}"
              aria-pressed="${isVariantActive ? 'true' : 'false'}"
              title="Open ${shortTitle(model)}">
        ${_thumb ? `<img src="${_thumb}" alt="${shortTitle(model)}" loading="lazy" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span class=\\'thumb-no-image\\'>${shortTitle(model)}</span>');">` : `<span class="thumb-no-image">${shortTitle(model)}</span>`}
      </button>
    `;
  };

  const buildVariantGrid = () => {
    const tiles = models.slice(0, 4).map((variant, idx) => {
      if (!variant) return '';
      const isVariantActive = historyActiveModelId === variant.id;
      const _thumb = variant.thumbnail_url || galleryGroupThumb;
      return `
        <button class="${thumbPrefix}__composite-tile ${isVariantActive ? 'is-focused' : ''}"
                type="button"
                data-act="open"
                data-id="${variant.id}"
                data-asset-type="model"
                data-glb-url="${escapeAttr(variant.glb_url || variant.model_url || variant.model_glb_url || '')}"
                data-glb-proxy="${escapeAttr(variant.glb_proxy || '')}"
                data-stl-url="${escapeAttr(variant.stl_url || variant.model_stl_url || variant.print_url || '')}"
                data-thumbnail-url="${escapeAttr(_thumb)}"
                data-title="${escapeAttr(shortTitle(variant))}"
                data-prompt="${escapeAttr(variant.prompt || variant.root_prompt || '')}"
                aria-label="Open variation ${idx + 1}">
          ${_thumb ? `<img src="${_thumb}" alt="${shortTitle(variant)}" loading="lazy" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span class=\\'thumb-no-image\\'>${shortTitle(variant)}</span>');">` : `<span class="thumb-no-image">${shortTitle(variant)}</span>`}
        </button>
      `;
    }).join('');
    const overflow = Math.max(0, variantCount - 4);
    return `
      <div class="${thumbPrefix}__composite" role="group" aria-label="${variantCount} variations">
        ${tiles}
        ${overflow > 0 ? `<span class="${thumbPrefix}__composite-count">+${overflow}</span>` : ''}
      </div>
    `;
  };

  const stageVal = (displayModel.stage || '').toLowerCase();
  const failLabel = stageVal === 'rig' || stageVal === 'rigged' ? 'Rigging failed'
    : stageVal === 'animate' || stageVal === 'animation' || stageVal === 'animated' ? 'Animation failed'
    : stageVal === 'texture' || stageVal === 'textured' ? 'Texturing failed'
    : stageVal === 'refine' || stageVal === 'refined' ? 'Refining failed'
    : stageVal === 'convert' ? 'Convert failed'
    : stageVal === 'resize' ? 'Resize failed'
    : stageVal === 'uv_unwrap' || stageVal === 'uv-unwrap' ? 'UV unwrap failed'
    : stageVal === 'image3d' ? 'Image to 3D failed'
    : 'Generation failed';
  const previewMarkup = status === 'failed'
    ? `<div class="${thumbPrefix}__error-card">
        <span class="${thumbPrefix}__error-icon">:(</span>
        <span class="${thumbPrefix}__error-text">${failLabel}</span>
        <button class="${thumbPrefix}__retry-btn" type="button" data-act="retry-job" data-id="${displayModel.id}">Retry</button>
      </div>`
    : isProcessing
      ? `<div class="${thumbPrefix}__processing-placeholder"></div>`
      : hasVariants
        ? buildVariantGrid()
        : buildSinglePreview(displayModel);

  const overlayMarkup = overlayVisible ? `
    <div class="${thumbPrefix}__overlay">
      <span class="${thumbPrefix}__overlay-pill">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M5 19V5l7-3 7 3v14l-7 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M5 9l7 3 7-3" fill="none" stroke="currentColor" stroke-width="1.4"/>
        </svg>
        ${variantCount > 1 ? `<span>+x${variantCount}</span>` : ''}
      </span>
    </div>
  ` : '';

  const stageLabel = stageVal === 'refine' || stageVal === 'refined' ? 'Refined'
    : stageVal === 'remesh' || stageVal === 'remeshed' ? 'Remeshed'
    : stageVal === 'convert' ? 'Converted'
    : stageVal === 'resize' ? 'Resized'
    : stageVal === 'uv_unwrap' || stageVal === 'uv-unwrap' ? 'UV Unwrapped'
    : stageVal === 'texture' || stageVal === 'textured' ? 'Textured'
    : stageVal === 'image3d' ? 'Image to 3D'
    : stageVal === 'rig' || stageVal === 'rigged' ? 'Rigged'
    : stageVal === 'animate' || stageVal === 'animation' || stageVal === 'animated' ? 'Animated'
    : 'Preview';

  return `
    <div class="${thumbPrefix} ${statusClass} ${isActive ? 'is-active' : ''} ${isFreshThumb ? 'is-fresh' : ''} ${hasVariants ? `${thumbPrefix}--bundle` : `${thumbPrefix}--single`}">
      <div class="${thumbPrefix}__status-bar">
        ${statusBarInner}
      </div>
      ${previewMarkup}
      ${isProcessing ? `
        <div class="${thumbPrefix}__processing" data-job-id="${displayModel.id}">
          <span class="${thumbPrefix}__processing-label">${processingLabel}</span>
          <span class="${thumbPrefix}__processing-pct">0%</span>
          <div class="${thumbPrefix}__progress-bar">
            <div class="${thumbPrefix}__progress-fill"></div>
          </div>
        </div>
      ` : ''}
      ${stageLabel ? `<span class="${thumbPrefix}__stage" data-stage="${(stageVal || '').toLowerCase()}">${stageLabel}</span>` : ''}
      ${showActions ? `
      <div class="${thumbPrefix}__menu-wrap">
        <button class="${thumbPrefix}__menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Model actions" data-history-menu>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2"/>
            <circle cx="12" cy="12" r="2"/>
            <circle cx="19" cy="12" r="2"/>
          </svg>
        </button>
        <div class="card-menu" role="menu" aria-label="Model actions">
          <div class="card-menu__list">
            <button class="card-menu__item" type="button" data-submenu-open="${editSubmenuId}" aria-expanded="false">
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#11042;</span>
                <span>Edit Model</span>
              </span>
              <span class="card-menu__arrow">></span>
            </button>
            <button class="card-menu__item" type="button" data-act="print" data-id="${displayModel.id}" data-download-url="${modelDownloadUrl}" ${!canDownload ? 'disabled' : ''}>
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#128424;</span>
                <span>Print</span>
              </span>
              <span class="card-menu__arrow">></span>
            </button>
            <button class="card-menu__item" type="button" data-act="manual-multi-color-print" data-id="${displayModel.id}" data-title="${(displayModel.title || displayModel.prompt || '').replace(/"/g, '&quot;')}" data-thumb="${displayModel.thumbnail_url || ''}" data-glb="${modelDownloadUrl}" ${!canDownload ? 'disabled' : ''}>
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#127912;</span>
                <span>Manual Paint 3MF</span>
              </span>
            </button>
            <button class="card-menu__item" type="button" data-act="meshy-multi-color-print" data-id="${displayModel.id}" data-title="${(displayModel.title || displayModel.prompt || '').replace(/"/g, '&quot;')}" data-thumb="${displayModel.thumbnail_url || ''}" data-glb="${modelDownloadUrl}" ${!canMeshyAuto3mf ? 'disabled' : ''}>
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#9881;</span>
                <span>Meshy Auto 3MF</span>
              </span>
              <span class="card-menu__badge" style="background:rgba(var(--accent-blue-rgb, 127, 200, 194),.18);color:var(--accent-blue-soft, #a5ded9);font-size:9px;">10 cr</span>
            </button>
            <div class="card-menu__divider"></div>
            <button class="card-menu__item" type="button" data-submenu-open="share-${displayModel.id}" aria-expanded="false">
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#8599;</span>
                <span>Share</span>
              </span>
              <span class="card-menu__arrow">></span>
            </button>
            <button class="card-menu__item" type="button" data-act="download" data-id="${displayModel.id}" data-download-url="${modelDownloadUrl}" ${!canDownload ? 'disabled' : ''}>
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#8595;</span>
                <span>Download</span>
              </span>
            </button>
            <button class="card-menu__item" type="button" data-act="license" data-id="${displayModel.id}">
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#10227;</span>
                <span>Change License</span>
              </span>
              <span class="card-menu__badge">${licenseLabel(displayModel.license)}</span>
            </button>
            <button class="card-menu__item is-danger" type="button" data-act="delete" data-id="${displayModel.id}">
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#128465;</span>
                <span>Delete</span>
              </span>
            </button>
          </div>
        </div>
        <div class="card-submenu" data-submenu-panel="${editSubmenuId}">
          <button class="card-submenu__item" type="button" data-act="texture" data-id="${displayModel.id}" ${!canTexture ? 'disabled' : ''}>
            <span class="card-menu__icon">&#9639;</span>
            Texture
          </button>
          <button class="card-submenu__item" type="button" data-act="remesh" data-id="${displayModel.id}" ${!canRemesh ? 'disabled' : ''}>
            <span class="card-menu__icon">&#11041;</span>
            Remesh
          </button>
          <div class="card-submenu__divider"></div>
          <button class="card-submenu__item" type="button" data-act="refine" data-id="${displayModel.id}" ${!canRefine ? 'disabled' : ''}>
            <span class="card-menu__icon">&#10022;</span>
            Refine Preview
          </button>
        </div>
        <div class="card-submenu" data-submenu-panel="share-${displayModel.id}">
          <button class="card-submenu__item" type="button" data-act="copy-link" data-id="${displayModel.id}">
            <span class="card-menu__icon">&#128279;</span>
            Copy Link
          </button>
          <button class="card-submenu__item" type="button" data-act="embed" data-id="${displayModel.id}">
            <span class="card-menu__icon">&#9723;</span>
            Embed Code
          </button>
          <div class="card-submenu__divider"></div>
          <button class="card-submenu__item" type="button" data-act="share-twitter" data-id="${displayModel.id}">
            <span class="card-menu__icon">&#120143;</span>
            Share on X
          </button>
          <button class="card-submenu__item" type="button" data-act="share-facebook" data-id="${displayModel.id}">
            <span class="card-menu__icon">f</span>
            Share on Facebook
          </button>
          <button class="card-submenu__item" type="button" data-act="share-linkedin" data-id="${displayModel.id}">
            <span class="card-menu__icon">in</span>
            Share on LinkedIn
          </button>
          <button class="card-submenu__item" type="button" data-act="share-discord" data-id="${displayModel.id}">
            <span class="card-menu__icon">&#9670;</span>
            Share on Discord
          </button>
          <div class="card-submenu__divider"></div>
          <button class="card-submenu__item card-submenu__item--community" type="button" data-act="share-community" data-id="${displayModel.id}" data-type="${displayModel.item_type || 'model'}" data-thumb="${displayModel.thumbnail_url || ''}" data-prompt="${(displayModel.prompt || '').replace(/"/g, '&quot;')}">
            <span class="card-menu__icon">&#9651;</span>
            Share to Community
          </button>
          <div class="card-submenu__divider"></div>
          <button class="card-submenu__item" type="button" data-act="share-inspire" data-id="${displayModel.id}">
            <span class="card-menu__icon">&#10024;</span>
            Share to Inspire
          </button>
        </div>
      </div>
      ` : ''}
      ${overlayMarkup}
    </div>
  `;
}

function _getItemAssetType(item) {
  if (!item) return 'model';
  const stage = (item.stage || '').toLowerCase();
  const action = (item.action || (item.payload && item.payload.action) || '').toLowerCase();
  if (item.type === 'video' || item.video_url) return 'video';
  if (item.type === 'image' || (!item.glb_url && item.image_url)) return 'image';
  if (stage === 'animate' || stage === 'animation' || action.includes('animat')) return 'animated';
  if (stage === 'rig' || action.includes('rig')) return 'animated';
  return 'model';
}

const GALLERY_LIVE_STATUSES = new Set([
  'generating', 'refining', 'remeshing', 'texturing', 'rigging', 'animating',
  'processing', 'queued', 'pending',
]);

function _isLiveItem(item) {
  return GALLERY_LIVE_STATUSES.has(String(item?.status || '').toLowerCase());
}

/**
 * Build individual gallery card objects from lineages.
 * Each card has { id, status, html } for surgical DOM patching.
 */
function _buildGalleryCards(lineages) {
  let globalIndex = 0;
  const cards = [];
  lineages.forEach((lineage, groupIndex) => {
    if (!lineage || !Array.isArray(lineage.models) || !lineage.models.length) return;

    // Batch group: emit a single grouped card
    if (lineage.isBatchGroup && (lineage.models.length > 1 || (lineage.batchCount || 0) > 1)) {
      const delay = globalIndex * 0.03;
      globalIndex++;
      const sortedBatch = [...lineage.models].sort((a, b) => {
        const sa = parseInt(a.batch_slot || (a.payload && a.payload.batch_slot), 10) || 0;
        const sb = parseInt(b.batch_slot || (b.payload && b.payload.batch_slot), 10) || 0;
        return sa - sb;
      });
      const groupKey = String(lineage.rootId || lineage.id);
      const group = {
        id: lineage.batchGroupId || groupKey,
        model_count: lineage.batchCount || sortedBatch.length,
        completed_count: sortedBatch.filter(i => i.status === 'finished' || !i.status).length,
        failed_count: sortedBatch.filter(i => i.status === 'error' || i.status === 'failed').length,
      };
      _groupedCardData.set(String(group.id), sortedBatch);
      const cardHtml = buildGroupedCardHTML(group, sortedBatch);
      const html = `<div class="expanded-thumb" data-gid="${groupKey}" data-asset-type="model" style="animation-delay: ${delay}s">${cardHtml}</div>`;
      cards.push({
        id: groupKey,
        family: 'model',
        order: globalIndex,
        status: getGroupedCardState(group, sortedBatch).statusKey,
        isLive: sortedBatch.some(_isLiveItem),
        html,
      });
      return;
    }

    const models = lineage.models.sort(compareHistoryModels);
    const bundles = buildLineageBundles(models);

    // ── Version stack ──────────────────────────────────────────────────────
    // Every revision of one lineage used to claim its own grid cell, so a
    // model that went preview → textured showed up twice (and a duplicate
    // dispatch showed up twice again). Collapse the lineage into a single
    // card whose face is the most advanced revision; older ones live behind
    // it and fan out on click.
    const faceIndex = bundles.length - 1;
    const stackDepth = bundles.length - 1;
    // One grid slot per lineage: the face takes the slot, revisions inherit it
    // with a fractional offset so they always sort directly behind their face.
    const lineageOrder = ++globalIndex;
    const delay = (lineageOrder - 1) * 0.03;

    bundles.forEach((b, bundleIndex) => {
      const isFace = bundleIndex === faceIndex;
      const displayModel = b.models[0] || {};
      const assetType = _getItemAssetType(displayModel);
      const thumbHtml = buildHistoryThumb(b, true);
      const isGroupStart = groupIndex > 0 && isFace;
      const stackKey = String(lineage.rootId || lineage.id || displayModel.id || '');
      const classes = [
        isGroupStart ? 'expanded-thumb--group-start' : '',
        isFace && stackDepth > 0 ? 'expanded-thumb--stacked' : '',
        isFace ? '' : 'expanded-thumb--revision is-stack-hidden',
      ].filter(Boolean).join(' ');
      const html = thumbHtml.replace(
        /class="expanded-thumb/,
        `style="animation-delay: ${delay}s" data-asset-type="${assetType}" data-gid="${displayModel.id || ''}" data-stack-key="${escapeAttr(stackKey)}" ${isFace ? `data-stack-face="1" data-stack-depth="${stackDepth}"` : 'data-stack-revision="1"'} class="expanded-thumb ${classes}`
      );
      const stackToggle = (isFace && stackDepth > 0)
        ? `<button type="button" class="expanded-thumb__stack-toggle" data-stack-toggle="${escapeAttr(stackKey)}" aria-expanded="false" title="${stackDepth + 1} versions of this asset">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
             <span class="expanded-thumb__stack-count">${stackDepth + 1}</span>
             <span class="sr-only">versions</span>
           </button>`
        : '';
      const withToggle = stackToggle
        ? html.replace(/<\/div>\s*$/, `${stackToggle}</div>`)
        : html;

      cards.push({
        id: displayModel.id || '',
        family: assetType,
        // Revisions must render immediately after their face card, so they
        // share the face's slot and break the tie on stage depth.
        order: isFace ? lineageOrder : lineageOrder + (bundleIndex + 1) / 1000,
        status: displayModel.status || 'finished',
        stackKey,
        isRevision: !isFace,
        isLive: isFace && _isLiveItem(displayModel),
        html: withToggle,
      });
    });
  });

  // One flat, recency-ordered grid. Family runs used to split the feed into
  // 3D-models-then-images-then-videos blocks, which duplicated what the filter
  // chips already do and buried today's work below last month's models. The
  // only thing that jumps the queue now is work that is still running.
  return cards.sort((a, b) => {
    const liveA = a.isLive ? 0 : 1;
    const liveB = b.isLive ? 0 : 1;
    return (liveA - liveB) || (a.order - b.order);
  });
}

function syncGalleryLiveHeading(grid) {
  if (!grid) return;
  const heading = grid.querySelector('[data-live-heading]');
  if (!heading) return;
  // Also excludes .is-lib-hidden: the Phase 2 filter row can hide every live
  // card, and a "Generating now" heading over an empty run reads as a bug.
  const live = grid.querySelectorAll('.expanded-thumb[data-live="1"]:not(.is-gallery-hidden):not(.is-lib-hidden)');
  const count = heading.querySelector('.history-live-heading__count');
  if (count) count.textContent = String(live.length);
  heading.hidden = live.length === 0;
}

function ensureGalleryLiveHeading(grid, cards = []) {
  if (!grid) return;
  const hasLive = Array.isArray(cards) && cards.some((c) => c.isLive);
  let heading = grid.querySelector('[data-live-heading]');
  if (hasLive && !heading) {
    heading = document.createElement('div');
    heading.className = 'history-live-heading';
    heading.setAttribute('data-live-heading', '');
    heading.innerHTML = `
      <span class="history-live-heading__pulse" aria-hidden="true"></span>
      <span>Generating now</span>
      <span class="history-live-heading__count">0</span>
    `;
    grid.insertBefore(heading, grid.firstChild);
  }
  syncGalleryLiveHeading(grid);
}

/**
 * Check if existing gallery grid children match the expected card IDs.
 * Used to decide whether we can patch in-place vs full rebuild.
 */
function _galleryIdsMatch(gridEl, cards) {
  // Compare cards only. The grid also holds non-card children — the live
  // heading and the library's empty-state note — and counting them made this
  // return false forever, forcing a full innerHTML rebuild on every poll
  // tick: thumbnails re-decoded, the enter animation replayed, and any open
  // card menu was destroyed mid-interaction.
  const cardEls = gridEl.querySelectorAll('.expanded-thumb');
  if (cardEls.length !== cards.length) return false;
  for (let i = 0; i < cards.length; i++) {
    if ((cardEls[i].dataset.gid || '') !== cards[i].id) return false;
  }
  return true;
}

function buildExpandedHistoryGallery(cards = []) {
  // Revisions live behind their face card in a version stack — they must not
  // inflate the chip counts, otherwise "Models 37" counts the same model once
  // per refinement and never matches what the user can actually see.
  const visible = cards.filter((c) => !c.isRevision);
  const counts = { all: visible.length, model: 0, image: 0, animated: 0, video: 0 };
  visible.forEach((c) => {
    const family = c.family || 'model';
    if (counts[family] !== undefined) counts[family]++;
  });
  const liveCount = visible.filter((c) => c.isLive).length;

  const chip = (key, label, icon) => {
    // A chip for a category with nothing in it is noise (the old "Animated 0"),
    // but "All" always renders so the grid is never chip-less.
    if (key !== 'all' && !counts[key]) return '';
    return `
        <button type="button" class="expanded-filter-btn${key === 'all' ? ' active' : ''}" data-gallery-filter="${key}" aria-pressed="${key === 'all' ? 'true' : 'false'}">
          ${icon}
          ${label} <span class="expanded-filter-btn__count">${counts[key]}</span>
        </button>`;
  };

  const ICONS = {
    model: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    animated: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    video: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>',
  };

  const filterBar = `
    <div class="expanded-filter-bar">
      <div class="expanded-filter-bar__pills">
        ${chip('all', 'All', '')}
        ${chip('model', 'Models', ICONS.model)}
        ${chip('image', 'Images', ICONS.image)}
        ${chip('animated', 'Animated', ICONS.animated)}
        ${chip('video', 'Videos', ICONS.video)}
      </div>
    </div>
  `;

  // Live work is pinned to the top of the grid by _buildGalleryCards; this
  // heading labels that run so a running job never looks like a broken card.
  const liveHeading = liveCount ? `
        <div class="history-live-heading" data-live-heading>
          <span class="history-live-heading__pulse" aria-hidden="true"></span>
          <span>Generating now</span>
          <span class="history-live-heading__count">${liveCount}</span>
        </div>` : '';

  return `
    <div class="expanded-section" data-lineage-root="gallery-view">
      ${filterBar}
      <div class="expanded-thumbs-grid">${liveHeading}</div>
    </div>
  `;
}

// ============================================================================
// FILTERING
// ============================================================================

export function getFilteredHistory() {
  const q = (historyState.query || '').toLowerCase();
  // Use the per-tab DB-backed cache.  getTabHistory() returns the
  // tab-specific items if loaded, or falls back to filtering the
  // global "all" cache for backward compatibility.
  const raw = materializePendingHistoryItems(getTabHistory());
  let arr = dedupeHistoryItems(raw);
  if (arr.length !== raw.length) {
    console.info('[history] deduped items', { before: raw.length, after: arr.length });
  }

  if (!q) return arr;
  return arr.filter((it) => {
    const title = shortTitle(it).toLowerCase();
    const prompt = (it.prompt || '').toLowerCase();
    const model = (it.model || '').toLowerCase();
    const stage = (it.stage || '').toLowerCase();
    const license = (it.license || '').toLowerCase();
    const symmetry = (it.symmetry_mode || '').toLowerCase();
    const batch = String(it.batch_count || '');
    const pose = (it.pose_mode || '').toLowerCase();
    return title.includes(q) || prompt.includes(q) || model.includes(q) || stage.includes(q) ||
           license.includes(q) || symmetry.includes(q) || batch.includes(q) || pose.includes(q);
  });
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Lightweight in-place update for a generating job's status text.
 * Avoids full DOM rebuild (renderHistory) to prevent flicker during polling.
 * Returns true if the card was found and updated, false otherwise.
 */
export function updateJobStatusInPlace(jobId, statusLabel, pct) {
  const card = document.querySelector(`[data-job-id="${jobId}"]`);
  if (!card) return false;

  // Video cards: update __video-status
  const statusEl = card.querySelector('[class*="__video-status"]');
  if (statusEl) {
    statusEl.textContent = statusLabel;
    return true;
  }

  // Model/rig/animate cards: update __processing-label, __processing-pct, __progress-fill
  const labelEl = card.querySelector('[class*="__processing-label"]');
  const pctEl = card.querySelector('[class*="__processing-pct"]');
  const fillEl = card.querySelector('[class*="__progress-fill"]');
  if (labelEl || pctEl) {
    if (labelEl && statusLabel) labelEl.textContent = statusLabel;
    if (pctEl && pct != null) pctEl.textContent = `${pct}%`;
    if (fillEl && pct != null) fillEl.style.width = `${Math.min(100, pct)}%`;
    return true;
  }

  return false;
}

/**
 * Check if the existing video grid children match the expected card IDs.
 * Used to decide whether we can patch in-place vs full rebuild.
 */
function _videoGridIdsMatch(gridEl, cards) {
  for (let i = 0; i < cards.length; i++) {
    const child = gridEl.children[i];
    if (!child) return false;
    const idEl = child.querySelector('[data-id]');
    const childId = idEl?.dataset.id
                 || child.querySelector('[data-job-id]')?.dataset.jobId
                 || '';
    if (childId !== cards[i].id) return false;
  }
  return true;
}

// ─── Microtask debounce ─────────────────────────────────────────────────
// Multiple synchronous renderHistory() calls within the same microtask
// (e.g. filter switch + addItem + setActive) collapse into a single render.
// The render runs before the next paint via queueMicrotask, so the UI never
// shows a stale intermediate state.
let _renderQueued = false;
export function renderHistory() {
  if (_renderQueued) return;
  _renderQueued = true;
  queueMicrotask(() => {
    _renderQueued = false;
    _renderHistoryImpl();
  });
}

function _renderHistoryImpl() {
  const grid = document.getElementById('historyGrid');
  const pageLabel = document.getElementById('historyPageLabel');
  const sizeSel = document.getElementById('historyPageSize');
  const prevBtn = document.getElementById('historyPrev');
  const nextBtn = document.getElementById('historyNext');
  const firstBtn = document.getElementById('historyFirst');
  const lastBtn = document.getElementById('historyLast');
  const collapseBtn = document.getElementById('historyCollapseView');

  if (!grid) return;
  closeActiveHistoryMenu();

  const parsedSelectSize = sizeSel ? parseInt(sizeSel.value, 10) : NaN;
  const pageSize = Math.max(1, Number.isFinite(parsedSelectSize) ? parsedSelectSize : (parseInt(historyState.pageSize, 10) || 12));
  historyState.pageSize = pageSize;
  if (sizeSel && (Number.isNaN(parsedSelectSize) || parsedSelectSize !== pageSize)) {
    sizeSel.value = String(pageSize);
  }

  const isGallery = !!historyState.galleryExpanded;
  if (document.body) {
    document.body.classList.toggle('history-expanded', isGallery);
  }
  if (collapseBtn) collapseBtn.hidden = !isGallery;

  const sortToggle = document.getElementById('historySortToggle');
  if (sortToggle) {
    const label = sortToggle.querySelector('.history-sort-btn__label');
    if (label) {
      label.textContent = historyState.sort === 'desc' ? 'Newest' : 'Oldest';
    }
    sortToggle.classList.toggle('is-asc', historyState.sort === 'asc');
  }

  const activeJobs = typeof getActiveJobs === 'function' ? getActiveJobs() : [];
  const isLoading = Array.isArray(activeJobs) && activeJobs.length > 0;

  // If a media tab hasn't fetched its own data yet, show a loading skeleton —
  // UNLESS the global historyCache already has items for this tab (generating
  // placeholders, recently completed assets, or items loaded from localStorage).
  // getTabHistory() falls back to filtering historyCache when ts.items is null.
  if (historyState.filter !== 'all' && !historyTabLoaded()) {
    const hasCacheItems = getFilteredHistory().length > 0;
    console.log('[History] Skeleton gate:', { filter: historyState.filter, tabLoaded: false, hasCacheItems, isLoading });
    if (!hasCacheItems && !isLoading) {
      grid.innerHTML = buildHistorySkeleton(2, 3);
      if (pageLabel) pageLabel.textContent = 'Loading...';
      [prevBtn, nextBtn, firstBtn, lastBtn].forEach(btn => btn?.setAttribute('disabled', ''));
      return;
    }
    // If we have items OR active jobs, fall through to render from cache
  }

  const src = getFilteredHistory();

  // IMAGE FILTER - simple grid
  if (historyState.filter === 'image') {
    const sortedImages = [...src].sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return historyState.sort === 'asc' ? aTime - bTime : bTime - aTime;
    });

    if (!sortedImages.length) {
      grid.innerHTML = `
        <div class="history-empty" role="status" aria-live="polite">
          <div class="history-empty__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M6 11h12M10 15h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
            </svg>
          </div>
          <p>No images yet</p>
          <span>Generate your first image to see it here.</span>
        </div>
      `;
      if (pageLabel) pageLabel.textContent = '0/0';
      [prevBtn, nextBtn, firstBtn, lastBtn].forEach(btn => btn?.setAttribute('disabled', ''));
      return;
    }

    const totalImages = sortedImages.length;
    let pages = Math.max(1, Math.ceil(totalImages / pageSize));
    if (historyState.page > pages) historyState.page = pages;
    if (historyState.page < 1) historyState.page = 1;
    historyState._renderedTotalPages = pages;

    let start = (historyState.page - 1) * pageSize;
    let end = Math.min(start + pageSize, totalImages);
    let slice = sortedImages.slice(start, end);

    if (isGallery) {
      pages = 1;
      historyState.page = 1;
      slice = sortedImages;
    }

    const activeId = historyActiveModelId;
    const imageCards = slice.map(img => {
      const bundle = { models: [img], isBundle: false };
      // fingerprint: status + active flag — if either changes, card must be replaced
      const fp = (img.status || 'finished') + (img.id === activeId ? ':A' : '');
      return { id: img.id, fp, html: buildHistoryThumb(bundle, false) };
    });

    // Surgical update: if the grid already shows the same image IDs in the
    // same order, patch only the cards whose fingerprint changed.  This
    // prevents thumbnail images from flickering on every re-render (innerHTML
    // destroys <img> elements causing them to re-download).
    const existingImageGrid = grid.querySelector('.history-image-grid');
    const canPatchImages = existingImageGrid
      && existingImageGrid.children.length === imageCards.length
      && _videoGridIdsMatch(existingImageGrid, imageCards);

    if (canPatchImages) {
      for (let i = 0; i < imageCards.length; i++) {
        const child = existingImageGrid.children[i];
        if (child.dataset._fp === imageCards[i].fp) continue; // unchanged — skip
        const temp = document.createElement('div');
        temp.innerHTML = imageCards[i].html;
        const replacement = temp.firstElementChild;
        if (replacement) {
          replacement.dataset._fp = imageCards[i].fp;
          existingImageGrid.replaceChild(replacement, child);
        }
      }
    } else {
      // Full rebuild — tag each child with fingerprint for future patches
      const markup = imageCards.map(c => c.html).join('');
      grid.innerHTML = `<div class="history-image-grid">${markup}</div>`;
      const builtGrid = grid.querySelector('.history-image-grid');
      if (builtGrid) {
        Array.from(builtGrid.children).forEach((child, i) => {
          if (imageCards[i]) child.dataset._fp = imageCards[i].fp;
        });
      }
    }

    if (pageLabel) {
      const imgTabLoaded = historyTabLoaded();
      const imgHasMore = historyHasMore();
      const pagesLabel = (!imgTabLoaded || imgHasMore) ? `${pages}+` : `${pages}`;
      pageLabel.textContent = isGallery
        ? `Gallery - ${totalImages} image${totalImages === 1 ? '' : 's'}`
        : `${historyState.page}/${pagesLabel}`;
    }

    const disableNav = (btn, shouldDisable) => {
      if (!btn) return;
      if (shouldDisable) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    };
    disableNav(prevBtn, historyState.page <= 1 || isGallery);
    const imgNextOff = historyState.page >= pages && historyTabLoaded() && !historyHasMore();
    disableNav(nextBtn, imgNextOff || isGallery);
    disableNav(firstBtn, historyState.page <= 1 || isGallery);
    disableNav(lastBtn, historyState.page >= pages || isGallery);
    return;
  }

  // VIDEO FILTER - simple grid (same structure as image filter)
  if (historyState.filter === 'video') {
    const sortedVideos = [...src].sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return historyState.sort === 'asc' ? aTime - bTime : bTime - aTime;
    });

    if (!sortedVideos.length) {
      grid.innerHTML = `
        <div class="history-empty" role="status" aria-live="polite">
          <div class="history-empty__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <p>No videos yet</p>
          <span>Generate your first video to see it here.</span>
        </div>
      `;
      if (pageLabel) pageLabel.textContent = '0/0';
      [prevBtn, nextBtn, firstBtn, lastBtn].forEach(btn => btn?.setAttribute('disabled', ''));
      return;
    }

    const totalVideos = sortedVideos.length;
    let pages = Math.max(1, Math.ceil(totalVideos / pageSize));
    if (historyState.page > pages) historyState.page = pages;
    if (historyState.page < 1) historyState.page = 1;
    historyState._renderedTotalPages = pages;

    let start = (historyState.page - 1) * pageSize;
    let end = Math.min(start + pageSize, totalVideos);
    let slice = sortedVideos.slice(start, end);

    if (isGallery) {
      pages = 1;
      historyState.page = 1;
      slice = sortedVideos;
    }

    const videoCards = slice.map(vid => {
      const bundle = { models: [vid], isBundle: false };
      return { id: vid.id, status: vid.status, html: buildHistoryThumb(bundle, false) };
    });

    // Surgical update: if the grid already shows the same item IDs in the same
    // order, patch only the cards whose status changed.  This prevents thumbnail
    // images from flickering on every poll tick (innerHTML destroys <img> elements
    // causing them to reload).
    const existingGrid = grid.querySelector('.history-video-grid');
    const canPatch = existingGrid
      && existingGrid.children.length === videoCards.length
      && _videoGridIdsMatch(existingGrid, videoCards);

    if (canPatch) {
      for (let i = 0; i < videoCards.length; i++) {
        const child = existingGrid.children[i];
        // Skip unchanged finished cards (their thumbnails are expensive to rebuild)
        const childStatus = child.dataset._vs || '';
        if (childStatus === videoCards[i].status && videoCards[i].status === 'finished') continue;
        const temp = document.createElement('div');
        temp.innerHTML = videoCards[i].html;
        const replacement = temp.firstElementChild;
        if (replacement) {
          replacement.dataset._vs = videoCards[i].status;
          existingGrid.replaceChild(replacement, child);
        }
      }
    } else {
      // Full rebuild — tag each child with status for future patches
      const markup = videoCards.map(c => c.html).join('');
      grid.innerHTML = `<div class="history-video-grid">${markup}</div>`;
      const builtGrid = grid.querySelector('.history-video-grid');
      if (builtGrid) {
        Array.from(builtGrid.children).forEach((child, i) => {
          if (videoCards[i]) child.dataset._vs = videoCards[i].status;
        });
      }
    }

    if (pageLabel) {
      const vidTabLoaded = historyTabLoaded();
      const vidHasMore = historyHasMore();
      const pagesLabel = (!vidTabLoaded || vidHasMore) ? `${pages}+` : `${pages}`;
      pageLabel.textContent = isGallery
        ? `Gallery - ${totalVideos} video${totalVideos === 1 ? '' : 's'}`
        : `${historyState.page}/${pagesLabel}`;
    }

    const disableNav = (btn, shouldDisable) => {
      if (!btn) return;
      if (shouldDisable) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    };
    disableNav(prevBtn, historyState.page <= 1 || isGallery);
    const vidNextOff = historyState.page >= pages && historyTabLoaded() && !historyHasMore();
    disableNav(nextBtn, vidNextOff || isGallery);
    disableNav(firstBtn, historyState.page <= 1 || isGallery);
    disableNav(lastBtn, historyState.page >= pages || isGallery);
    return;
  }

  // MODEL/ALL FILTER - lineage grouping
  // "All" tab (non-gallery) shows models + any in-progress items regardless
  // of type. This ensures generating images/videos appear immediately when
  // the user clicks Generate from the default tab. Finished images and
  // videos live in their dedicated tabs. Gallery mode still shows everything.
  const _IN_PROGRESS_STATUSES = new Set([
    'generating', 'refining', 'remeshing', 'texturing', 'rigging', 'animating',
    'processing', 'queued', 'pending',
  ]);
  // Filter out failed placeholder items that have no useful content
  // (no thumbnail, no model, no image, no video). These are jobs that
  // failed before producing any output (e.g., insufficient credits).
  const srcFiltered = src.filter(item => {
    if (!item) return false;
    if (item.status !== 'failed' && item.status !== 'error') return true;
    // Keep failed items that have actual content the user can see or retry
    if (item.thumbnail_url || item.glb_url || item.glb_proxy ||
        item.image_url || item.video_url) return true;
    // Remove empty failed placeholders — they have no content and just clutter the UI
    return false;
  });

  const srcForLineage = srcFiltered;
  const lineages = groupByLineage(srcForLineage);
  const currentLineageKeys = new Set(lineages.map(l => String(l.rootId || l.id)));
  historyLineageCounts.forEach((_, key) => {
    if (!currentLineageKeys.has(key)) historyLineageCounts.delete(key);
  });

  const sortedLineages = [...lineages].sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
    return historyState.sort === 'asc' ? aTime - bTime : bTime - aTime;
  });

  const shouldShowSkeleton = isLoading && !sortedLineages.length;
  const skeletonMarkup = shouldShowSkeleton ? buildHistorySkeleton(isGallery ? 1 : 2, isGallery ? 5 : 4) : '';

  if (!sortedLineages.length) {
    if (isGallery) {
      grid.innerHTML = (skeletonMarkup || '') + buildExpandedHistoryGallery([]);
      syncAssetsToolbarFilters();
      const builtGrid = grid.querySelector('.expanded-thumbs-grid');
      if (builtGrid) {
        builtGrid.innerHTML = `
          <div class="history-empty" role="status" aria-live="polite">
            <div class="history-empty__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M6 11h12M10 15h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
              </svg>
            </div>
            <p>No assets yet</p>
            <span>Run your first generation to fill this library.</span>
          </div>
        `;
      }
      if (pageLabel) pageLabel.textContent = skeletonMarkup ? 'Loading...' : 'Gallery - 0 assets';
      [prevBtn, nextBtn].forEach(btn => btn?.setAttribute('disabled', ''));
      return;
    }

    grid.innerHTML = skeletonMarkup || `
      <div class="history-empty" role="status" aria-live="polite">
        <div class="history-empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M6 11h12M10 15h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
          </svg>
        </div>
        <p>No assets yet</p>
        <span>Run your first generation to fill this library.</span>
      </div>
    `;
    if (pageLabel) pageLabel.textContent = skeletonMarkup ? 'Loading...' : '0/0';
    [prevBtn, nextBtn].forEach(btn => btn?.setAttribute('disabled', ''));
    return;
  }

  const totalRows = sortedLineages.length;
  const totalAssets = sortedLineages.reduce((sum, lineage) => {
    return sum + (Array.isArray(lineage.models) ? lineage.models.length : 0);
  }, 0);

  let pages = Math.max(1, Math.ceil(totalRows / pageSize));
  if (historyState.page > pages) historyState.page = pages;
  if (historyState.page < 1) historyState.page = 1;
  historyState._renderedTotalPages = pages;

  let start = (historyState.page - 1) * pageSize;
  let end = Math.min(start + pageSize, totalRows);
  let slice = sortedLineages.slice(start, end);

  if (isGallery) {
    pages = 1;
    historyState.page = 1;
    slice = sortedLineages;
  }

  const timelineMarkup = slice.map(lineage => {
    const rowKey = String(lineage.rootId || lineage.id);
    const previousCount = historyLineageCounts.has(rowKey)
      ? historyLineageCounts.get(rowKey)
      : lineage.models.length;
    const delta = Math.max(0, lineage.models.length - previousCount);
    const showBump = delta > 0;
    historyLineageCounts.set(rowKey, lineage.models.length);

    // ── Batch group: render as a single grouped card inside a collection wrapper ──
    if (lineage.isBatchGroup && (lineage.models.length > 1 || (lineage.batchCount || 0) > 1)) {
      const sortedBatchModels = [...lineage.models].sort((a, b) => {
        const slotA = parseInt(a.batch_slot || (a.payload && a.payload.batch_slot), 10) || 0;
        const slotB = parseInt(b.batch_slot || (b.payload && b.payload.batch_slot), 10) || 0;
        return slotA - slotB;
      });
      const group = {
        id: lineage.batchGroupId || rowKey,
        model_count: lineage.batchCount || sortedBatchModels.length,
        completed_count: sortedBatchModels.filter(i => i.status === 'finished' || !i.status).length,
        failed_count: sortedBatchModels.filter(i => i.status === 'error' || i.status === 'failed').length,
      };
      _groupedCardData.set(String(group.id), sortedBatchModels);
      const lineageTitle = shortTitle(lineage.title || sortedBatchModels[0] || '');
      const groupedState = getGroupedCardState(group, sortedBatchModels);
      return `
        <div class="history-collection" data-lineage-root="${rowKey}" data-thumb-count="1">
          <span class="history-collection__divider" aria-hidden="true"></span>
          <div class="history-collection__head">
            <div class="history-collection__title" title="${lineageTitle}">${lineageTitle}</div>
            <span class="history-collection__count">${groupedState.statusText}</span>
          </div>
          <div class="history-collection__thumbs history-collection__thumbs--batch">
            ${buildGroupedCardHTML(group, sortedBatchModels)}
          </div>
        </div>
      `;
    }

    const sortedModels = [...lineage.models].sort(compareHistoryModels);
    const bundles = buildLineageBundles(sortedModels);

    const MAX_VISIBLE = 3;
    const hasMore = bundles.length > MAX_VISIBLE;
    const visibleBundles = hasMore ? bundles.slice(0, MAX_VISIBLE) : bundles;
    const hiddenBundles = hasMore ? bundles.slice(MAX_VISIBLE) : [];

    const visibleThumbsMarkup = visibleBundles.map((b) => buildHistoryThumb(b, false)).join('');
    const hiddenThumbsMarkup = hiddenBundles.map((b) => buildHistoryThumb(b, false)).join('');
    const lineageTitle = shortTitle(lineage.title || sortedModels[0] || '');

    // Type breakdown for the count label (e.g. "3 models, 1 video" for mixed lineages)
    const _typeCounts = {};
    lineage.models.forEach(m => {
      const t = m.type || (m.glb_url ? 'model' : m.image_url ? 'image' : m.video_url ? 'video' : 'model');
      _typeCounts[t] = (_typeCounts[t] || 0) + 1;
    });
    const _typeKeys = Object.keys(_typeCounts);
    let _countLabel;
    if (_typeKeys.length > 1) {
      const _parts = [];
      for (const t of ['model', 'video', 'image']) {
        if (_typeCounts[t]) _parts.push(`${_typeCounts[t]} ${t}${_typeCounts[t] > 1 ? 's' : ''}`);
      }
      _countLabel = _parts.join(', ');
    } else {
      _countLabel = `All ${lineage.models.length} asset${lineage.models.length === 1 ? '' : 's'}`;
    }

    const countElement = hasMore
      ? `<button class="history-collection__count" type="button" data-action="toggle-collection" data-lineage-key="${rowKey}" aria-expanded="false">
          ${_countLabel} <span class="history-collection__arrow">&#8250;</span>
          ${showBump ? `<span class="history-collection__counter">+${delta}</span>` : ''}
        </button>`
      : `<span class="history-collection__count">
          ${_countLabel} &#8250;
          ${showBump ? `<span class="history-collection__counter">+${delta}</span>` : ''}
        </span>`;

    // data-thumb-count drives how many columns the collection claims in the
    // Assets modal grid, so a one-thumb lineage occupies one tile and a
    // three-thumb lineage occupies three — every thumbnail the same square.
    return `
      <div class="history-collection" data-lineage-root="${rowKey}" data-thumb-count="${visibleBundles.length || 1}">
        <span class="history-collection__divider" aria-hidden="true"></span>
        <div class="history-collection__head" aria-label="${lineage.models.length} version${lineage.models.length > 1 ? 's' : ''}">
          <div class="history-collection__title" title="${lineageTitle}">${lineageTitle}</div>
          ${countElement}
        </div>
        <div class="history-collection__thumbs">
          ${visibleThumbsMarkup}
        </div>
        ${hasMore ? `<template class="history-collection__thumbs-lazy">${hiddenThumbsMarkup}</template>` : ''}
      </div>
    `;
  }).join('');

  // Gallery mode: render all cards, fetch more on scroll.
  // Uses surgical DOM patching to prevent flicker during poll ticks.
  if (isGallery) {
    const galleryCards = _buildGalleryCards(sortedLineages);
    const existingGrid = grid.querySelector('.expanded-thumbs-grid');

    // Build lookup of existing card IDs already in the DOM
    const existingIdSet = new Set();
    if (existingGrid) {
      Array.from(existingGrid.children).forEach(el => {
        if (el.dataset.gid) existingIdSet.add(el.dataset.gid);
      });
    }

    const isFirstRender = !existingGrid;
    const hasNewCards = galleryCards.some(c => !existingIdSet.has(c.id));
    const orderChanged = !!existingGrid && !_galleryIdsMatch(existingGrid, galleryCards);

    if (isFirstRender || orderChanged) {
      // First render: build shell + all cards
      _galleryAllCards = galleryCards;
      if (isFirstRender) _galleryActiveFilter = 'all';
      grid.innerHTML = (skeletonMarkup || '') + buildExpandedHistoryGallery(galleryCards);
      syncAssetsToolbarFilters();
      const builtGrid = grid.querySelector('.expanded-thumbs-grid');
      if (builtGrid) {
        // Render ALL current cards into the grid
        const fragment = document.createDocumentFragment();
        galleryCards.forEach((c, i) => {
          const temp = document.createElement('div');
          temp.innerHTML = c.html;
          const card = temp.firstElementChild;
          if (card) {
            card.dataset._gs = c.status;
            if (c.isLive) card.dataset.live = '1';
            card.style.animationDelay = `${i * 0.03}s`;
            // Apply filter visibility
            if (_galleryActiveFilter !== 'all' && card.getAttribute('data-asset-type') !== _galleryActiveFilter) {
              card.classList.add('is-gallery-hidden');
            }
            fragment.appendChild(card);
          }
        });
        builtGrid.appendChild(fragment);
        bindGroupedCardEvents(builtGrid);
        syncGalleryLiveHeading(builtGrid);
        applyStackState(builtGrid);
        // Phase 2 decoration (stars, tags, collections, filters) lives in the
        // classic script js/library.js. Optional chain on purpose: if that file
        // fails to load the library still renders, just without organisation.
        window.TimrXLibrary?.decorate?.(builtGrid);
      }
      _bindGalleryScroll();
      // Show sentinel if DB has more pages
      _updateGallerySentinel(historyHasMore(), galleryCards.length);
    } else if (hasNewCards && existingGrid) {
      // Append only the NEW cards (from loadMoreHistory) without disturbing existing ones
      _galleryAllCards = galleryCards;
      ensureGalleryLiveHeading(existingGrid, galleryCards);
      const fragment = document.createDocumentFragment();
      let appendCount = 0;
      galleryCards.forEach((c) => {
        if (existingIdSet.has(c.id)) return; // already in DOM
        const temp = document.createElement('div');
        temp.innerHTML = c.html;
        const card = temp.firstElementChild;
        if (card) {
          card.dataset._gs = c.status;
          if (c.isLive) card.dataset.live = '1';
          card.style.animationDelay = `${appendCount * 0.03}s`;
          if (_galleryActiveFilter !== 'all' && card.getAttribute('data-asset-type') !== _galleryActiveFilter) {
            card.classList.add('is-gallery-hidden');
          }
          fragment.appendChild(card);
          appendCount++;
        }
      });
      existingGrid.appendChild(fragment);
      syncGalleryLiveHeading(existingGrid);
      applyStackState(existingGrid);
      window.TimrXLibrary?.decorate?.(existingGrid);
      // Update sentinel
      _updateGallerySentinel(historyHasMore(), existingGrid.children.length);
      // Update header stats count
      _updateGalleryHeaderStats(existingGrid);
    } else if (existingGrid) {
      // Same card set — patch status changes in-place (poll tick)
      _galleryAllCards = galleryCards;
      const cardById = new Map(galleryCards.map(c => [c.id, c]));
      Array.from(existingGrid.children).forEach(child => {
        const gid = child.dataset.gid || '';
        const card = cardById.get(gid);
        if (!card) return;
        const prevStatus = child.dataset._gs || '';
        if (prevStatus === card.status && card.status === 'finished') return;
        const temp = document.createElement('div');
        temp.innerHTML = card.html;
        const replacement = temp.firstElementChild;
        if (replacement) {
          replacement.dataset._gs = card.status;
          // data-live drives the live ring and the "Generating now" count.
          // The rebuilt node starts without it, so a card that transitions
          // into a running state would silently drop out of the live run.
          if (card.isLive) replacement.dataset.live = '1';
          else delete replacement.dataset.live;
          replacement.style.animationDelay = '0s';
          replacement.style.opacity = '1';
          if (_galleryActiveFilter !== 'all' && replacement.getAttribute('data-asset-type') !== _galleryActiveFilter) {
            replacement.classList.add('is-gallery-hidden');
          }
          existingGrid.replaceChild(replacement, child);
        }
      });
      // A patched card may have entered or left the live run, and its stack
      // state and library decoration live on the node we just replaced.
      ensureGalleryLiveHeading(existingGrid, galleryCards);
      applyStackState(existingGrid);
      window.TimrXLibrary?.decorate?.(existingGrid);
    }
  } else {
    _unbindGalleryScroll();
    // Preserve which lineage collections are expanded before DOM rebuild.
    // Without this, expanded collections snap back to collapsed on every
    // poll tick or re-render (innerHTML destroys the is-expanded class).
    const _expandedRoots = new Set();
    grid.querySelectorAll('.history-collection.is-expanded').forEach(el => {
      const root = el.dataset.lineageRoot;
      if (root) _expandedRoots.add(root);
    });

    grid.innerHTML = (skeletonMarkup || '') + timelineMarkup;
    bindGroupedCardEvents(grid);

    // Restore expanded state after rebuild
    if (_expandedRoots.size) {
      _expandedRoots.forEach(root => {
        const collection = grid.querySelector(`.history-collection[data-lineage-root="${CSS.escape(root)}"]`);
        if (!collection) return;
        collection.classList.add('is-expanded');
        const toggleBtn = collection.querySelector('[data-action="toggle-collection"]');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
        // Inflate lazy <template> so the extra thumbs are visible
        const tmpl = collection.querySelector('template.history-collection__thumbs-lazy');
        if (tmpl) {
          const extra = document.createElement('div');
          extra.className = 'history-collection__thumbs-extra';
          extra.innerHTML = tmpl.innerHTML;
          tmpl.replaceWith(extra);
        }
      });
    }
  }

  const serverHasMore = historyHasMore();
  const tabLoaded = historyTabLoaded();

  if (pageLabel) {
    if (isGallery) {
      const assetLabel = `${totalAssets} asset${totalAssets === 1 ? '' : 's'}`;
      pageLabel.textContent = `Gallery - ${assetLabel}`;
    } else {
      // Show "+" when backend may have more (or tab hasn't loaded yet)
      const pagesLabel = (!tabLoaded || serverHasMore) ? `${pages}+` : `${pages}`;
      pageLabel.textContent = `${historyState.page}/${pagesLabel}`;
    }
  }

  const disableNav = (btn, shouldDisable) => {
    if (!btn) return;
    if (shouldDisable) btn.setAttribute('disabled', '');
    else btn.removeAttribute('disabled');
  };
  disableNav(prevBtn, historyState.page <= 1 || isGallery);
  // Next is disabled ONLY when on last cached page AND backend confirmed
  // no more data. If tab hasn't loaded yet, keep next enabled.
  const nextDisabled = historyState.page >= pages && tabLoaded && !serverHasMore;
  disableNav(nextBtn, nextDisabled || isGallery);
  disableNav(firstBtn, historyState.page <= 1 || isGallery);
  disableNav(lastBtn, historyState.page >= pages || isGallery);

  // Clean up any leftover load-more banners from previous renders
  const existingBanner = grid.querySelector('.history-load-more');
  if (existingBanner) existingBanner.remove();
  // Pagination is now entirely button-driven (next/prev arrows).
  // No infinite scroll or "load more" banner — the next button in main.js
  // handles DB fetching when the user reaches the last cached page.

  // Notify listeners (e.g., toolbar disabled state)
  window.dispatchEvent(new CustomEvent('history:rendered'));
}

// Expose globally for backward compatibility
window.renderHistory = renderHistory;
window.shortTitle = shortTitle;
