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
  setHistoryActiveModelId
} from './state.js';

// ============================================================================
// MENU STATE
// ============================================================================
let activeHistoryMenuBtn = null;
let activeHistoryMenu = null;
let activeHistorySubmenuBtn = null;
let activeHistorySubmenu = null;

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
  if (normalized === 'latest' || normalized === 'meshy6' || normalized === 'meshy6preview') return 'Meshy 6 Preview';
  if (normalized === 'meshy5') return 'Meshy 5';
  if (normalized === 'meshy4') return 'Meshy 4';
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
  // Priority: lineage_origin_id is the primary grouping key (set by backend)
  if (item.lineage_origin_id) return String(item.lineage_origin_id);
  // Fallback candidates for backward compatibility with older records
  const candidates = [
    'lineage_root_id', 'preview_task_id', 'root_lineage_id', 'origin_id',
    'source_job_id', 'parent_job_id', 'root_id', 'parent_id', 'job_id'
  ];
  for (const key of candidates) {
    if (item[key]) return String(item[key]);
  }
  return String(item.id || '');
}

function groupByLineage(items = []) {
  const lineages = new Map();
  const fingerprintCounts = new Map();

  items.forEach(item => {
    const fp = itemPromptFingerprint(item);
    if (!fp) return;
    fingerprintCounts.set(fp, (fingerprintCounts.get(fp) || 0) + 1);
  });

  items.forEach(item => {
    if (!item) return;
    const fingerprint = itemPromptFingerprint(item);
    const shouldUsePromptCohort = fingerprint && fingerprintCounts.get(fingerprint) >= 2;
    const promptKey = shouldUsePromptCohort ? `prompt:${fingerprint}` : '';
    const rootKey = promptKey || getLineageKey(item) || String(item.id || '');

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

    if (item.created_at) {
      const lineageTime = lineage.created_at ? new Date(lineage.created_at).getTime() : Infinity;
      const itemTime = new Date(item.created_at).getTime();
      if (itemTime < lineageTime) {
        lineage.created_at = item.created_at;
        lineage.title = shortTitle(item);
      }
    }
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

function compareHistoryModels(a = {}, b = {}) {
  const timeA = a?.created_at ? new Date(a.created_at).getTime() : 0;
  const timeB = b?.created_at ? new Date(b.created_at).getTime() : 0;
  if (timeA !== timeB) {
    return historyState.sort === 'asc' ? timeA - timeB : timeB - timeA;
  }
  const stageA = (a?.stage || '').toLowerCase();
  const stageB = (b?.stage || '').toLowerCase();
  return stageA.localeCompare(stageB);
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
    : '';

  const isProcessing = ['generating', 'refining', 'remeshing', 'texturing'].includes(status);
  const processingLabel = status === 'refining' ? 'Refining...'
    : status === 'remeshing' ? 'Remeshing...'
    : status === 'texturing' ? 'Texturing...'
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
    const imgSrc = displayModel.thumbnail_url || displayModel.image_url || '';
    const name = shortTitle(displayModel);
    const imgCanDownload = !!imgSrc && _hasCredits;
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
            ${imgSrc ? `<img src="${imgSrc}" alt="${name}" loading="lazy">` : ''}
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
              <button class="card-menu__item" type="button" data-act="image-to-3d" data-id="${displayModel.id}" data-image-url="${imgSrc}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#127912;</span>
                  <span>Create 3D Model</span>
                </span>
                <span class="card-menu__arrow">></span>
              </button>
              <button class="card-menu__item" type="button" data-act="image-to-video" data-id="${displayModel.id}" data-image-url="${imgSrc}">
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#127909;</span>
                  <span>Create Video</span>
                </span>
                <span class="card-menu__badge">110 cr</span>
              </button>
              <div class="card-menu__divider"></div>
              <button class="card-menu__item" type="button" data-act="download-image" data-id="${displayModel.id}" data-image-url="${imgSrc}" ${!imgCanDownload ? 'disabled' : ''}>
                <span class="card-menu__item-inner">
                  <span class="card-menu__icon">&#8595;</span>
                  <span>Download</span>
                </span>
              </button>
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
        <img src="${model.thumbnail_url || ''}" alt="${shortTitle(model)}" loading="lazy">
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
          <img src="${variant.thumbnail_url || ''}" alt="${shortTitle(variant)}" loading="lazy">
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
  const previewMarkup = status === 'failed'
    ? `<div class="${thumbPrefix}__error-card">
        <span class="${thumbPrefix}__error-icon">:(</span>
        <span class="${thumbPrefix}__error-text">Remeshing failed</span>
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

  const stageLabel = stageVal === 'refine' ? 'Refined'
    : stageVal === 'remesh' ? 'Remeshed'
    : stageVal === 'texture' ? 'Textured'
    : stageVal === 'image3d' ? 'Image to 3D'
    : '';

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
        </div>
      </div>
      ` : ''}
      ${overlayMarkup}
    </div>
  `;
}

function buildExpandedHistoryGallery(lineages = []) {
  if (!lineages.length) return '';

  let globalIndex = 0;
  const contentParts = [];

  lineages.forEach((lineage, groupIndex) => {
    if (!lineage || !Array.isArray(lineage.models) || !lineage.models.length) return;

    const models = lineage.models.sort(compareHistoryModels);
    const bundles = buildLineageBundles(models);

    bundles.forEach((b, bundleIndex) => {
      const delay = globalIndex * 0.04;
      globalIndex++;
      const thumbHtml = buildHistoryThumb(b, true);
      const isGroupStart = groupIndex > 0 && bundleIndex === 0;
      const groupClass = isGroupStart ? ' expanded-thumb--group-start' : '';
      contentParts.push(
        thumbHtml.replace(
          /class="expanded-thumb/,
          `style="animation-delay: ${delay}s" class="expanded-thumb${groupClass}`
        )
      );
    });
  });

  return `
    <div class="expanded-section" data-lineage-root="gallery-view">
      <div class="expanded-thumbs-grid">
        ${contentParts.join('')}
      </div>
    </div>
  `;
}

// ============================================================================
// FILTERING
// ============================================================================

export function getFilteredHistory() {
  const q = (historyState.query || '').toLowerCase();
  const filter = historyState.filter || 'all';
  const raw = getHistory();
  let arr = dedupeHistoryItems(raw);
  if (arr.length !== raw.length) {
    console.info('[history] deduped items', { before: raw.length, after: arr.length });
  }

  if (filter !== 'all') {
    arr = arr.filter((it) => {
      const type = it.type || (it.glb_url ? 'model' : it.image_url ? 'image' : it.video_url ? 'video' : 'model');
      return type === filter;
    });
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
    const poseFlag = it.is_a_t_pose ? 'pose' : '';
    return title.includes(q) || prompt.includes(q) || model.includes(q) || stage.includes(q) ||
           license.includes(q) || symmetry.includes(q) || batch.includes(q) || poseFlag.includes(q);
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
export function updateJobStatusInPlace(jobId, statusLabel) {
  const card = document.querySelector(`[data-job-id="${jobId}"]`);
  if (!card) return false;
  const statusEl = card.querySelector('[class*="__video-status"]');
  if (statusEl) {
    statusEl.textContent = statusLabel;
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

export function renderHistory() {
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
  const pageSize = Math.max(1, Number.isFinite(parsedSelectSize) ? parsedSelectSize : (parseInt(historyState.pageSize, 10) || 9));
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

    let start = (historyState.page - 1) * pageSize;
    let end = Math.min(start + pageSize, totalImages);
    let slice = sortedImages.slice(start, end);

    if (isGallery) {
      pages = 1;
      historyState.page = 1;
      slice = sortedImages;
    }

    const imageGridMarkup = slice.map(img => {
      const bundle = { models: [img], isBundle: false };
      return buildHistoryThumb(bundle, false);
    }).join('');

    grid.innerHTML = `<div class="history-image-grid">${imageGridMarkup}</div>`;

    if (pageLabel) {
      pageLabel.textContent = isGallery
        ? `Gallery - ${totalImages} image${totalImages === 1 ? '' : 's'}`
        : `${historyState.page}/${pages}`;
    }

    const disableNav = (btn, shouldDisable) => {
      if (!btn) return;
      if (shouldDisable) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    };
    disableNav(prevBtn, historyState.page <= 1 || isGallery);
    disableNav(nextBtn, historyState.page >= pages || isGallery);
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
      pageLabel.textContent = isGallery
        ? `Gallery - ${totalVideos} video${totalVideos === 1 ? '' : 's'}`
        : `${historyState.page}/${pages}`;
    }

    const disableNav = (btn, shouldDisable) => {
      if (!btn) return;
      if (shouldDisable) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    };
    disableNav(prevBtn, historyState.page <= 1 || isGallery);
    disableNav(nextBtn, historyState.page >= pages || isGallery);
    disableNav(firstBtn, historyState.page <= 1 || isGallery);
    disableNav(lastBtn, historyState.page >= pages || isGallery);
    return;
  }

  // MODEL/ALL FILTER - lineage grouping
  // Filter out videos when in 'all' filter and not in gallery mode
  // Videos should only be visible in video tab or expanded gallery view
  const srcForLineage = (historyState.filter === 'all' && !isGallery)
    ? src.filter(item => {
        const type = item.type || (item.glb_url ? 'model' : item.image_url ? 'image' : item.video_url ? 'video' : 'model');
        return type !== 'video';
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

    const countElement = hasMore
      ? `<button class="history-collection__count" type="button" data-action="toggle-collection" data-lineage-key="${rowKey}" aria-expanded="false">
          All ${lineage.models.length} asset${lineage.models.length === 1 ? '' : 's'} <span class="history-collection__arrow">&#8250;</span>
          ${showBump ? `<span class="history-collection__counter">+${delta}</span>` : ''}
        </button>`
      : `<span class="history-collection__count">
          All ${lineage.models.length} asset${lineage.models.length === 1 ? '' : 's'} &#8250;
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
        ${hasMore ? `<div class="history-collection__thumbs-extra">${hiddenThumbsMarkup}</div>` : ''}
      </div>
    `;
  }).join('');

  const rowsMarkup = isGallery ? buildExpandedHistoryGallery(sortedLineages) : timelineMarkup;
  grid.innerHTML = (skeletonMarkup || '') + rowsMarkup;

  if (pageLabel) {
    if (isGallery) {
      const assetLabel = `${totalAssets} asset${totalAssets === 1 ? '' : 's'}`;
      pageLabel.textContent = `Gallery - ${assetLabel}`;
    } else {
      pageLabel.textContent = `${historyState.page}/${pages}`;
    }
  }

  const disableNav = (btn, shouldDisable) => {
    if (!btn) return;
    if (shouldDisable) btn.setAttribute('disabled', '');
    else btn.removeAttribute('disabled');
  };
  disableNav(prevBtn, historyState.page <= 1 || isGallery);
  disableNav(nextBtn, historyState.page >= pages || isGallery);
  disableNav(firstBtn, historyState.page <= 1 || isGallery);
  disableNav(lastBtn, historyState.page >= pages || isGallery);

  // Notify listeners (e.g., toolbar disabled state)
  window.dispatchEvent(new CustomEvent('history:rendered'));
}

// Expose globally for backward compatibility
window.renderHistory = renderHistory;
window.shortTitle = shortTitle;
