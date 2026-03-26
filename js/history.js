/**
 * history.js
 * Renders the history list. Contains HTML templates for history cards.
 */

import { byId, dateLabel, normalizeEpochMs, HISTORY_MENU_EDGE_PAD, HISTORY_SUBMENU_GAP } from './config.js';
import {
  getHistory,
  getActiveJobs,
  historyState,
  historyLineageCounts,
  historyFreshThumbs,
  historyActiveModelId,
  setHistoryActiveModelId,
  historyHasMore,
  historyTabLoaded,
  getTabHistory,
  loadHistoryTab
} from './state.js';

// ============================================================================
// MENU STATE
// ============================================================================
let activeHistoryMenuBtn = null;
let activeHistoryMenu = null;
let activeHistorySubmenuBtn = null;
let activeHistorySubmenu = null;

// ============================================================================
// INFINITE SCROLL STATE (expanded gallery)
// ============================================================================
const GALLERY_PAGE_SIZE = 24;        // cards per batch
const GALLERY_SCROLL_THRESHOLD = 400; // px from bottom to trigger load
let _galleryAllCards = [];            // full card list (unfiltered)
let _galleryRenderedCount = 0;        // how many cards are in DOM
let _galleryActiveFilter = 'all';     // current filter tab
let _galleryScrollBound = false;      // scroll listener attached
let _galleryLoading = false;          // prevent concurrent loads

function _getFilteredGalleryCards() {
  if (_galleryActiveFilter === 'all') return _galleryAllCards;
  return _galleryAllCards.filter(c => {
    const el = document.createElement('div');
    el.innerHTML = c.html;
    const thumb = el.firstElementChild;
    return thumb?.dataset?.assetType === _galleryActiveFilter;
  });
}

function _appendGalleryBatch(grid, count) {
  if (!grid || _galleryLoading) return;
  _galleryLoading = true;
  const filtered = _getFilteredGalleryCards();
  const start = _galleryRenderedCount;
  const end = Math.min(start + count, filtered.length);
  if (start >= filtered.length) { _galleryLoading = false; return; }

  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const temp = document.createElement('div');
    temp.innerHTML = filtered[i].html;
    const card = temp.firstElementChild;
    if (card) {
      card.dataset._gs = filtered[i].status;
      card.style.animationDelay = `${(i - start) * 0.03}s`;
      fragment.appendChild(card);
    }
  }
  grid.appendChild(fragment);
  _galleryRenderedCount = end;
  _galleryLoading = false;

  // Update load-more sentinel
  _updateGalleryLoadMore(grid);
}

function _updateGalleryLoadMore(grid) {
  const section = grid?.closest('.expanded-section');
  if (!section) return;
  let sentinel = section.querySelector('.expanded-gallery-sentinel');
  const filtered = _getFilteredGalleryCards();
  const hasMore = _galleryRenderedCount < filtered.length;

  if (hasMore) {
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.className = 'expanded-gallery-sentinel';
      sentinel.innerHTML = `
        <div class="expanded-gallery-loader">
          <div class="expanded-gallery-loader__dot"></div>
          <div class="expanded-gallery-loader__dot"></div>
          <div class="expanded-gallery-loader__dot"></div>
        </div>
        <span class="expanded-gallery-loader__text">${_galleryRenderedCount} of ${filtered.length}</span>
      `;
      section.appendChild(sentinel);
    } else {
      const textEl = sentinel.querySelector('.expanded-gallery-loader__text');
      if (textEl) textEl.textContent = `${_galleryRenderedCount} of ${filtered.length}`;
    }
  } else if (sentinel) {
    sentinel.remove();
  }
}

function _onGalleryScroll() {
  if (!historyState.galleryExpanded) return;
  const grid = document.querySelector('.expanded-thumbs-grid');
  if (!grid) return;
  const filtered = _getFilteredGalleryCards();
  if (_galleryRenderedCount >= filtered.length) return;

  const scrollY = window.scrollY || window.pageYOffset;
  const windowH = window.innerHeight;
  const docH = document.documentElement.scrollHeight;

  if (docH - scrollY - windowH < GALLERY_SCROLL_THRESHOLD) {
    _appendGalleryBatch(grid, GALLERY_PAGE_SIZE);
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
 * Reset gallery to show first batch, optionally changing filter.
 * Called on initial render and on filter tab click.
 */
export function resetGalleryInfiniteScroll(filter) {
  _galleryActiveFilter = filter || 'all';
  _galleryRenderedCount = 0;
  const grid = document.querySelector('.expanded-thumbs-grid');
  if (grid) {
    grid.innerHTML = '';
    _appendGalleryBatch(grid, GALLERY_PAGE_SIZE);
  }
}

function getHistoryMenuHost(node) {
  return node?.closest?.('.history-thumb, .expanded-thumb') || null;
}

// Export getters for menu state (needed by main.js)
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
  const provider = item.provider || item.ai_provider || item?.payload?.provider || 'unknown';
  const upstream = item.upstream_id || item.upstream_job_id || item?.payload?.upstream_id || item?.payload?.original_job_id || item?.payload?.job_id || '';
  if (upstream) return `${provider}:${upstream}`;
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

function groupByLineage(items = []) {
  const lineages = new Map();
  const fingerprintCounts = new Map();
  let fallbackCount = 0;

  items.forEach(item => {
    const fp = itemPromptFingerprint(item);
    if (!fp) return;
    fingerprintCounts.set(fp, (fingerprintCounts.get(fp) || 0) + 1);
  });

  // Stage prefixes to strip from group titles
  const _stagePrefixes = /^(rig|remesh|texture|refine|animate|animation)\s+/i;

  items.forEach(item => {
    if (!item) return;
    const lineageKey = getLineageKey(item);
    const hasExplicitLineage = !!(item.lineage_origin_id || item.lineage_root_id);
    const fingerprint = itemPromptFingerprint(item);
    const shouldUsePromptCohort = !hasExplicitLineage && fingerprint && fingerprintCounts.get(fingerprint) >= 3;
    const promptKey = shouldUsePromptCohort ? `prompt:${fingerprint}` : '';
    const rootKey = (hasExplicitLineage ? lineageKey : '') || promptKey || lineageKey || String(item.id || '');

    if (!hasExplicitLineage && !promptKey) fallbackCount++;

    if (!lineages.has(rootKey)) {
      lineages.set(rootKey, {
        id: item.id,
        rootId: rootKey,
        title: shortTitle(item),
        created_at: item.created_at,
        models: []
      });
    }

    const lineage = lineages.get(rootKey);
    lineage.models.push(item);

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
const _STAGE_ORDER = { preview: 0, image3d: 1, refine: 2, texture: 3, remesh: 4, rig: 5, animate: 6, animation: 6 };

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
    activeHistorySubmenu.style.left = '';
    activeHistorySubmenu.style.top = '';
  }
  activeHistorySubmenuBtn = null;
  activeHistorySubmenu = null;
}

export function closeActiveHistoryMenu() {
  closeActiveHistorySubmenu();
  if (activeHistoryMenuBtn) {
    activeHistoryMenuBtn.setAttribute('aria-expanded', 'false');
    activeHistoryMenuBtn.classList.remove('is-open');
    const host = getHistoryMenuHost(activeHistoryMenuBtn);
    if (host) host.classList.remove('is-menu-open');
  }
  if (activeHistoryMenu) {
    activeHistoryMenu.classList.remove('is-open');
    activeHistoryMenu.style.left = '';
    activeHistoryMenu.style.top = '';
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
  const host = getHistoryMenuHost(menuBtn);
  if (host) host.classList.add('is-menu-open');
  menu.classList.add('is-open');
  activeHistoryMenuBtn = menuBtn;
  activeHistoryMenu = menu;
  positionHistoryMenu(menuBtn, menu);
  document.body.classList.add('history-menu-open');
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
  positionHistorySubmenu(submenuBtn, submenu);
}

function positionHistoryMenu(anchorBtn, menu) {
  if (!anchorBtn || !menu) return;
  const spacing = HISTORY_MENU_EDGE_PAD;
  const btnSpacing = 2;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  const btnRect = anchorBtn.getBoundingClientRect();
  menu.style.left = '0px';
  menu.style.top = '0px';

  const menuRect = menu.getBoundingClientRect();
  let left = btnRect.right - menuRect.width;
  let top = btnRect.bottom + btnSpacing;

  if (left < spacing) left = spacing;
  if (left + menuRect.width + spacing > viewportWidth) {
    left = viewportWidth - menuRect.width - spacing;
  }
  if (top + menuRect.height + spacing > viewportHeight) {
    top = btnRect.top - menuRect.height - btnSpacing;
  }
  if (top < spacing) top = spacing;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function positionHistorySubmenu(anchorBtn, submenu) {
  if (!anchorBtn || !submenu) return;
  const spacing = HISTORY_MENU_EDGE_PAD;
  const gap = HISTORY_SUBMENU_GAP;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  submenu.style.left = '0px';
  submenu.style.top = '0px';

  const btnRect = anchorBtn.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();

  let left = btnRect.right + gap;
  let top = btnRect.top;

  if (left + submenuRect.width + spacing > viewportWidth) {
    left = btnRect.left - submenuRect.width - gap;
  }
  if (left < spacing) left = spacing;
  if (top + submenuRect.height + spacing > viewportHeight) {
    top = viewportHeight - submenuRect.height - spacing;
  }
  if (top < spacing) top = spacing;

  submenu.style.left = `${Math.round(left)}px`;
  submenu.style.top = `${Math.round(top)}px`;
}

export function updateActiveHistoryMenuPosition() {
  if (!activeHistoryMenuBtn || !activeHistoryMenu) return;
  positionHistoryMenu(activeHistoryMenuBtn, activeHistoryMenu);
  if (activeHistorySubmenuBtn && activeHistorySubmenu) {
    positionHistorySubmenu(activeHistorySubmenuBtn, activeHistorySubmenu);
  }
}

// ============================================================================
// HTML TEMPLATES
// ============================================================================

function buildHistorySkeleton(rows = 2, thumbsPerRow = 3) {
  return Array.from({ length: rows }).map(() => `
    <div class="history-collection history-collection--skeleton">
      <span class="history-collection__divider" aria-hidden="true"></span>
      <div class="history-collection__head">
        <span class="history-skeleton history-skeleton__line"></span>
        <span class="history-skeleton history-skeleton__chip"></span>
      </div>
      <div class="history-collection__thumbs">
        ${Array.from({ length: thumbsPerRow }).map(() => `
          <div class="history-thumb history-thumb--skeleton">
            <div class="history-thumb__status-bar">
              <span class="history-skeleton history-skeleton__chip"></span>
              <span class="history-skeleton history-skeleton__chip"></span>
            </div>
            <div class="history-skeleton history-skeleton__thumb"></div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function buildHistoryThumb(bundle = {}, isExpanded = false) {
  const models = Array.isArray(bundle?.models) ? bundle.models.filter(Boolean) : [];
  if (!models.length) return '';

  const thumbPrefix = isExpanded ? 'expanded-thumb' : 'history-thumb';
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
  const canRefine = displayModel.stage === 'preview' && status === 'finished';
  const canRemesh = !!displayModel.prompt && status === 'finished';
  const canTexture = status === 'finished';
  const _hasCredits = window.WorkspaceCredits?.canDownloadAssets?.() ?? false;
  const canDownload = !!displayModel.glb_url && _hasCredits;
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
    const fullSrc = displayModel.image_url || displayModel.thumbnail_url || '';
    const name = shortTitle(displayModel);
    const imgCanDownload = !!fullSrc && _hasCredits;
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
            <span class="${thumbPrefix}__status-date">${createdLabel || '-'}</span>
            <span class="${thumbPrefix}__image-badge ${thumbPrefix}__image-badge--failed">Failed</span>
          </div>
          <div class="${thumbPrefix}__error-card">
            <span class="${thumbPrefix}__error-icon">&#9888;</span>
            <span class="${thumbPrefix}__error-text">${displayError}</span>
          </div>
          <span class="${thumbPrefix}__name">${name}</span>
          ${!isExpanded ? `
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
          <span class="${thumbPrefix}__status-date">${createdLabel || '-'}</span>
        </div>
        <div class="${thumbPrefix}__image-wrapper">
          <button class="${thumbPrefix}__image ${isProcessing ? 'is-loading' : ''}"
                  type="button"
                  data-act="open"
                  data-id="${displayModel.id}"
                  aria-label="Open ${name}">
            ${thumbSrc ? `<img src="${thumbSrc}" alt="${name}" loading="lazy">` : ''}
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
        ${!isExpanded ? `
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
              <button class="card-menu__item" type="button" data-act="image-to-3d" data-id="${displayModel.id}" data-image-url="${fullSrc}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#127912;</span>
                  <span>Create 3D Model</span>
                </span>
                <span class="card-menu__arrow">></span>
              </button>
              <button class="card-menu__item" type="button" data-act="image-to-video" data-id="${displayModel.id}" data-image-url="${fullSrc}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#127909;</span>
                  <span>Create Video</span>
                </span>
                <span class="card-menu__badge">45c</span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item" type="button" data-act="download-image" data-id="${displayModel.id}" data-image-url="${fullSrc}" ${!imgCanDownload ? 'disabled' : ''}>
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
    const videoSrc = displayModel.video_url || '';
    const thumbSrc = displayModel.thumbnail_url || '';
    const name = shortTitle(displayModel);
    const videoCanDownload = !!videoSrc && _hasCredits;
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
            <span class="${thumbPrefix}__status-date">${createdLabel || '-'}</span>
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
          ${!isExpanded ? `
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
        <button class="${thumbPrefix}__video-click ${isProcessing ? 'is-loading' : ''}"
                type="button"
                data-act="open-video"
                data-id="${displayModel.id}"
                data-video-url="${videoSrc}"
                aria-label="Play ${name}"
                ${isProcessing ? 'disabled' : ''}>
          ${thumbSrc ? `<img src="${thumbSrc}" alt="${name}" loading="lazy">` : `
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
        ${!isExpanded ? `
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
              <button class="card-menu__item" type="button" data-act="download-video" data-id="${displayModel.id}" data-video-url="${videoSrc}" ${!videoCanDownload ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#8595;</span>
                  <span>Download</span>
                </span>
              </button>
              <button class="card-menu__item" type="button" data-act="copy-video-link" data-id="${displayModel.id}" data-video-url="${videoSrc}" ${!videoCanDownload ? 'disabled' : ''}>
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
  const buildSinglePreview = (model) => {
    const isVariantActive = historyActiveModelId === model.id;
    return `
      <button class="${thumbPrefix}__preview ${isVariantActive ? 'is-focused' : ''} ${status === 'generating' ? 'is-loading' : ''}"
              type="button"
              data-act="open"
              data-id="${model.id}"
              aria-pressed="${isVariantActive ? 'true' : 'false'}"
              title="Open ${shortTitle(model)}">
        ${model.thumbnail_url ? `<img src="${model.thumbnail_url}" alt="${shortTitle(model)}" loading="lazy">` : `<span class="thumb-no-image">${shortTitle(model)}</span>`}
      </button>
    `;
  };

  const buildVariantGrid = () => {
    const tiles = models.slice(0, 4).map((variant, idx) => {
      if (!variant) return '';
      const isVariantActive = historyActiveModelId === variant.id;
      return `
        <button class="${thumbPrefix}__composite-tile ${isVariantActive ? 'is-focused' : ''}"
                type="button"
                data-act="open"
                data-id="${variant.id}"
                aria-label="Open variation ${idx + 1}">
          ${variant.thumbnail_url ? `<img src="${variant.thumbnail_url}" alt="${shortTitle(variant)}" loading="lazy">` : `<span class="thumb-no-image">${shortTitle(variant)}</span>`}
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
    : stageVal === 'image3d' ? 'Image to 3D failed'
    : 'Generation failed';
  const previewMarkup = status === 'failed'
    ? `<div class="${thumbPrefix}__error-card">
        <span class="${thumbPrefix}__error-icon">:(</span>
        <span class="${thumbPrefix}__error-text">${failLabel}</span>
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
    : stageVal === 'texture' || stageVal === 'textured' ? 'Textured'
    : stageVal === 'image3d' ? 'Image to 3D'
    : stageVal === 'rig' || stageVal === 'rigged' ? 'Rigged'
    : stageVal === 'animate' || stageVal === 'animation' || stageVal === 'animated' ? 'Animated'
    : 'Preview';

  return `
    <div class="${thumbPrefix} ${statusClass} ${isActive ? 'is-active' : ''} ${isFreshThumb ? 'is-fresh' : ''} ${hasVariants ? `${thumbPrefix}--bundle` : `${thumbPrefix}--single`}">
      <div class="${thumbPrefix}__status-bar">
        <span class="${thumbPrefix}__status-date">${createdLabel || '-'}</span>
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
      ${stageLabel ? `<span class="${thumbPrefix}__stage">${stageLabel}</span>` : ''}
      ${!isExpanded ? `
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
            <button class="card-menu__item" type="button" data-act="print" data-id="${displayModel.id}" ${!canDownload ? 'disabled' : ''}>
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#128424;</span>
                <span>Print</span>
              </span>
              <span class="card-menu__arrow">></span>
            </button>
            <div class="card-menu__divider"></div>
            <button class="card-menu__item" type="button" data-submenu-open="share-${displayModel.id}" aria-expanded="false">
              <span class="card-menu__item-inner">
                <span class="card-menu__icon">&#8599;</span>
                <span>Share</span>
              </span>
              <span class="card-menu__arrow">></span>
            </button>
            <button class="card-menu__item" type="button" data-act="download" data-id="${displayModel.id}" ${!canDownload ? 'disabled' : ''}>
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

/**
 * Build individual gallery card objects from lineages.
 * Each card has { id, status, html } for surgical DOM patching.
 */
function _buildGalleryCards(lineages) {
  let globalIndex = 0;
  const cards = [];
  lineages.forEach((lineage, groupIndex) => {
    if (!lineage || !Array.isArray(lineage.models) || !lineage.models.length) return;
    const models = lineage.models.sort(compareHistoryModels);
    const bundles = buildLineageBundles(models);
    bundles.forEach((b, bundleIndex) => {
      const delay = globalIndex * 0.03;
      globalIndex++;
      const displayModel = b.models[0] || {};
      const assetType = _getItemAssetType(displayModel);
      const thumbHtml = buildHistoryThumb(b, true);
      const isGroupStart = groupIndex > 0 && bundleIndex === 0;
      const groupClass = isGroupStart ? ' expanded-thumb--group-start' : '';
      const html = thumbHtml.replace(
        /class="expanded-thumb/,
        `style="animation-delay: ${delay}s" data-asset-type="${assetType}" data-gid="${displayModel.id || ''}" class="expanded-thumb${groupClass}`
      );
      cards.push({ id: displayModel.id || '', status: displayModel.status || 'finished', html });
    });
  });
  return cards;
}

/**
 * Check if existing gallery grid children match the expected card IDs.
 * Used to decide whether we can patch in-place vs full rebuild.
 */
function _galleryIdsMatch(gridEl, cards) {
  if (gridEl.children.length !== cards.length) return false;
  for (let i = 0; i < cards.length; i++) {
    if ((gridEl.children[i].dataset.gid || '') !== cards[i].id) return false;
  }
  return true;
}

function buildExpandedHistoryGallery(cards = []) {
  if (!cards.length) return '';

  // Count by type for badge stats
  const counts = { all: cards.length, model: 0, image: 0, animated: 0, video: 0 };
  cards.forEach(c => {
    const el = document.createElement('div');
    el.innerHTML = c.html;
    const thumb = el.firstElementChild;
    const type = thumb?.dataset?.assetType || '';
    if (type === 'model') counts.model++;
    else if (type === 'image') counts.image++;
    else if (type === 'animated') counts.animated++;
    else if (type === 'video') counts.video++;
  });

  const galleryHeader = `
    <div class="expanded-gallery-header">
      <div class="expanded-gallery-header__content">
        <h2 class="expanded-gallery-header__title">Your Creations</h2>
        <div class="expanded-gallery-header__stats">
          <span class="expanded-gallery-header__stat">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
            <strong>${counts.model}</strong> Models
          </span>
          <span class="expanded-gallery-header__stat">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <strong>${counts.image}</strong> Images
          </span>
          <span class="expanded-gallery-header__stat">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            <strong>${counts.video + counts.animated}</strong> Videos
          </span>
          <span class="expanded-gallery-header__stat expanded-gallery-header__stat--total">
            <strong>${counts.all}</strong> Total
          </span>
        </div>
      </div>
    </div>
  `;

  const filterBar = `
    <div class="expanded-filter-bar">
      <div class="expanded-filter-bar__pills">
        <button type="button" class="expanded-filter-btn active" data-gallery-filter="all">
          All <span class="expanded-filter-btn__count">${counts.all}</span>
        </button>
        <button type="button" class="expanded-filter-btn" data-gallery-filter="model">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
          Models <span class="expanded-filter-btn__count">${counts.model}</span>
        </button>
        <button type="button" class="expanded-filter-btn" data-gallery-filter="image">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          Images <span class="expanded-filter-btn__count">${counts.image}</span>
        </button>
        <button type="button" class="expanded-filter-btn" data-gallery-filter="animated">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          Animated <span class="expanded-filter-btn__count">${counts.animated}</span>
        </button>
        <button type="button" class="expanded-filter-btn" data-gallery-filter="video">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Videos <span class="expanded-filter-btn__count">${counts.video}</span>
        </button>
      </div>
    </div>
  `;

  return `
    <div class="expanded-section" data-lineage-root="gallery-view">
      ${galleryHeader}
      ${filterBar}
      <div class="expanded-thumbs-grid"></div>
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
  const raw = getTabHistory();
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

  const filterButtons = document.querySelectorAll('.filter-btn');
  filterButtons.forEach(btn => {
    const type = btn.getAttribute('data-filter');
    btn.classList.toggle('active', type === historyState.filter);
    if (type === 'all') {
      btn.setAttribute('aria-pressed', historyState.galleryExpanded ? 'true' : 'false');
    }
  });

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
  const srcForLineage = (historyState.filter === 'all' && !isGallery)
    ? src.filter(item => {
        const type = item.type || (item.glb_url ? 'model' : item.image_url ? 'image' : item.video_url ? 'video' : 'model');
        if (type === 'model') return true;
        return _IN_PROGRESS_STATUSES.has(item.status);
      })
    : src;
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
    grid.innerHTML = skeletonMarkup || `
      <div class="history-empty" role="status" aria-live="polite">
        <div class="history-empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M6 11h12M10 15h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
          </svg>
        </div>
        <p>No models yet</p>
        <span>Run your first generation to fill this timeline.</span>
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

    return `
      <div class="history-collection" data-lineage-root="${rowKey}">
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

  // Gallery mode: infinite-scroll batching with surgical in-place patches
  // for status changes during poll ticks.
  if (isGallery) {
    const galleryCards = _buildGalleryCards(sortedLineages);
    const existingGrid = grid.querySelector('.expanded-thumbs-grid');

    // Check if the card set changed (new/removed items)
    const prevIds = _galleryAllCards.map(c => c.id).join(',');
    const newIds = galleryCards.map(c => c.id).join(',');
    const structureChanged = prevIds !== newIds;

    if (structureChanged) {
      // Full rebuild: store all cards, render first batch via infinite scroll
      _galleryAllCards = galleryCards;
      grid.innerHTML = (skeletonMarkup || '') + buildExpandedHistoryGallery(galleryCards);
      _galleryRenderedCount = 0;
      _galleryActiveFilter = 'all';

      // Restore active filter from DOM if available
      const activeBtn = grid.querySelector('.expanded-filter-btn.active');
      if (activeBtn) {
        _galleryActiveFilter = activeBtn.getAttribute('data-gallery-filter') || 'all';
      }

      const builtGrid = grid.querySelector('.expanded-thumbs-grid');
      if (builtGrid) {
        _appendGalleryBatch(builtGrid, GALLERY_PAGE_SIZE);
      }
      _bindGalleryScroll();
    } else if (existingGrid) {
      // Same structure — patch status changes in-place for rendered cards
      _galleryAllCards = galleryCards;
      const renderedCount = Math.min(_galleryRenderedCount, existingGrid.children.length);
      const filtered = _getFilteredGalleryCards();
      for (let i = 0; i < renderedCount; i++) {
        const child = existingGrid.children[i];
        if (!child) continue;
        const prevStatus = child.dataset._gs || '';
        // Find matching card
        const card = filtered[i];
        if (!card) continue;
        if (prevStatus === card.status && card.status === 'finished') continue;
        const temp = document.createElement('div');
        temp.innerHTML = card.html;
        const replacement = temp.firstElementChild;
        if (replacement) {
          replacement.dataset._gs = card.status;
          replacement.style.animationDelay = '0s';
          replacement.style.opacity = '1';
          existingGrid.replaceChild(replacement, child);
        }
      }
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
