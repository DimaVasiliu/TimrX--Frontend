/**
 * main.js
 * The entry point. Imports all modules, runs initialization logic,
 * and sets up the primary event listeners.
 */

import { byId, safe, log, onThreeReady, normalizeEpochMs, apiFetch, getLoadableModelUrl, isTimrxS3Url, BACKEND } from './config.js';
import { buildDownloadFilename, buildProxyDownloadUrl, inferExtensionFromUrl, triggerBrowserDownload } from './download-utils.js';
import * as State from './state.js?v=20260407e';
import * as Viewer from './viewer.js?v=20260513b';
import * as UI from './ui-utils.js';
import {
  renderHistory,
  shortTitle,
  closeActiveHistoryMenu,
  closeActiveHistorySubmenu,
  openHistoryMenu,
  openHistorySubmenu,
  updateActiveHistoryMenuPosition,
  getActiveHistoryMenu,
  getActiveHistorySubmenu,
  getGroupedCardItems,
  resetGalleryInfiniteScroll
} from './history.js?v=20260508a';
import * as API from './api.js?v=20260507b';
import * as Converter from './converter.js';
import * as Credits from './workspace-credits.js';
import * as Notifications from './notifications.js';
import { openMultiColorModal, openMeshyMultiColorModal } from './multi-color-print.js?v=20260513b';

// ============================================================================
// MODULE STATE
// ============================================================================

// DOM references
let imageDrop, imageInput, imagePreview, imageModelName;
let genHint;

function isMobileWorkspaceLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function setMobileWorkspaceTab(target = 'controls') {
  if (!isMobileWorkspaceLayout()) return;

  const wsLeft = document.getElementById('ws-left-panel');
  const wsRight = document.getElementById('ws-right-panel');
  const tabs = document.querySelectorAll('.ws-mobile-tab');
  if (!wsLeft || !wsRight || tabs.length === 0) return;

  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === target;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const showHistory = target === 'history';
  wsLeft.classList.toggle('mob-hidden', showHistory);
  wsRight.classList.toggle('mob-active', showHistory);
}

function getItemDownloadType(item = {}) {
  if (item.type === 'video' || item.video_url) return 'video';
  if (item.type === 'image' || (!item.glb_url && item.image_url)) return 'image';
  return 'model';
}

function buildItemDownloadFilename(item = {}, options = {}) {
  const sourceUrl = options.sourceUrl || item.glb_url || item.image_url || item.video_url || '';
  return buildDownloadFilename({
    type: options.type || getItemDownloadType(item),
    title: item.title,
    prompt: item.prompt,
    name: item.name,
    modelName: item.model,
    jobLabel: item.stage,
    filename: item.filename,
    assetId: item.id || item.image_id || item.video_id || item.model_id,
    createdAt: normalizeEpochMs(item.created_at || item.createdAt || Date.now()),
    sourceUrl,
    extension: options.extension,
  });
}

function startWorkspaceDownload(sourceUrl, filename) {
  if (!sourceUrl) return false;
  const proxiedUrl = buildProxyDownloadUrl(BACKEND, sourceUrl, filename);
  triggerBrowserDownload(proxiedUrl, filename);
  return true;
}

// ============================================================================
// HISTORY FILTER SWITCHING
// ============================================================================

let _suppressHistoryFilterReset = false;

function switchHistoryFilter(filter = 'all') {
  if (_suppressHistoryFilterReset) return;
  // Only reset page if filter actually changed
  if (State.historyState.filter !== filter) {
    // Collapse expanded gallery when switching away from 'all'
    if (filter !== 'all' && State.historyState.galleryExpanded) {
      State.historyState.galleryExpanded = false;
    }
    State.historyState.filter = filter;
    State.historyState.page = 1;
    // Render immediately with whatever is cached (may be fallback-filtered)
    renderHistory();
    // If this tab hasn't been loaded from DB yet, fetch its first page.
    // loadHistoryTab returns cached items instantly if already loaded.
    if (filter !== 'all') {
      State.loadHistoryTab(filter).then(() => renderHistory());
    }
  }
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

// Track last focused element before modal opens
// Upload modal removed — handled entirely by 3dprint-app.js

function showErrorToast(message) {
  if (!document.body) {
    alert(message);
    return;
  }
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed',
    'right:24px',
    'bottom:24px',
    'z-index:9999',
    'background:#2b1414',
    'color:#fff',
    'padding:12px 16px',
    'border:1px solid rgba(255,255,255,0.1)',
    'border-radius:12px',
    'box-shadow:0 10px 24px rgba(0,0,0,0.35)',
    'font-size:14px',
    'max-width:320px',
    'opacity:0',
    'transition:opacity 180ms ease'
  ].join(';');
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}

/**
 * Show a nice popup for Gemini quota exceeded errors
 * Gemini API quota resets at midnight Pacific Time
 */
function showQuotaExceededPopup() {
  // Remove any existing quota popup
  const existing = document.getElementById('quotaExceededPopup');
  if (existing) existing.remove();

  // Calculate time until midnight PT (Pacific Time) - Gemini quota resets at midnight PT
  const now = new Date();

  // Calculate midnight PT
  const midnightPT = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  midnightPT.setHours(24, 0, 0, 0);
  const nowPT = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const msUntilReset = midnightPT - nowPT;
  const hoursUntilReset = Math.floor(msUntilReset / (1000 * 60 * 60));
  const minutesUntilReset = Math.floor((msUntilReset % (1000 * 60 * 60)) / (1000 * 60));

  // Format reset time in user's local timezone
  const resetTimeLocal = new Date(now.getTime() + msUntilReset);
  const localFormatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const resetTimeStr = localFormatter.format(resetTimeLocal);

  const popup = document.createElement('div');
  popup.id = 'quotaExceededPopup';
  popup.setAttribute('role', 'alertdialog');
  popup.setAttribute('aria-labelledby', 'quotaTitle');
  popup.setAttribute('aria-describedby', 'quotaDesc');
  popup.innerHTML = `
    <div class="quota-popup-backdrop"></div>
    <div class="quota-popup-content">
      <button type="button" class="quota-popup-x" aria-label="Close">×</button>
      <div class="quota-popup-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4 2"/>
        </svg>
      </div>
      <h3 id="quotaTitle">Daily Limit Reached</h3>
      <p id="quotaDesc">
        Google Veo's daily video quota has been exceeded. This is a platform-wide limit.
      </p>
      <div class="quota-popup-timer">
        <span class="quota-popup-timer-label">Resets in approximately</span>
        <span class="quota-popup-timer-value">${hoursUntilReset}h ${minutesUntilReset}m</span>
        <span class="quota-popup-timer-hint">~${resetTimeStr} local time</span>
      </div>
      <p class="quota-popup-tip">
        Try generating 3D models or images while you wait.
      </p>
      <button type="button" class="quota-popup-close" aria-label="Close">Got it</button>
    </div>
  `;

  // Styles matching blogs.css aesthetic
  const style = document.createElement('style');
  style.textContent = `
    #quotaExceededPopup {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: quotaFadeIn 0.3s ease;
    }
    @keyframes quotaFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .quota-popup-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    .quota-popup-content {
      position: relative;
      background: #111;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 32px 28px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
      transform: translateY(20px);
      animation: quotaSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes quotaSlideUp {
      to { transform: translateY(0); }
    }
    .quota-popup-x {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 32px;
      height: 32px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      font-size: 20px;
      color: #666;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      line-height: 1;
    }
    .quota-popup-x:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
      color: #fff;
    }
    .quota-popup-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 16px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .quota-popup-icon svg {
      width: 26px;
      height: 26px;
      color: #888;
    }
    .quota-popup-content h3 {
      margin: 0 0 10px;
      font-size: 1.5rem;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.01em;
    }
    .quota-popup-content p {
      margin: 0 0 20px;
      font-size: 0.9rem;
      color: #777;
      line-height: 1.6;
    }
    .quota-popup-timer {
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.08), rgba(139, 92, 246, 0.08));
      border: 1px solid rgba(14, 165, 233, 0.15);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .quota-popup-timer-label {
      display: block;
      font-size: 10px;
      color: #777;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .quota-popup-timer-value {
      display: block;
      font-size: 2rem;
      font-weight: 800;
      background: linear-gradient(135deg, #0ea5e9, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .quota-popup-timer-hint {
      display: block;
      font-size: 11px;
      color: #555;
      margin-top: 4px;
    }
    .quota-popup-tip {
      font-size: 0.8rem !important;
      color: #555 !important;
      font-style: italic;
      margin-bottom: 20px !important;
    }
    .quota-popup-close {
      width: 100%;
      padding: 12px 20px;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(139, 92, 246, 0.15));
      border: 1px solid rgba(14, 165, 233, 0.25);
      border-radius: 999px;
      color: #fff;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      letter-spacing: 0.02em;
    }
    .quota-popup-close:hover {
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.25), rgba(139, 92, 246, 0.25));
      border-color: rgba(14, 165, 233, 0.5);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(14, 165, 233, 0.2);
    }
    .quota-popup-close:active {
      transform: translateY(0);
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(popup);

  // Close handlers
  const closeBtn = popup.querySelector('.quota-popup-close');
  const closeX = popup.querySelector('.quota-popup-x');
  const backdrop = popup.querySelector('.quota-popup-backdrop');
  const closePopup = () => {
    popup.style.opacity = '0';
    popup.style.transition = 'opacity 0.25s ease';
    setTimeout(() => {
      popup.remove();
      style.remove();
    }, 250);
  };
  closeBtn.addEventListener('click', closePopup);
  closeX.addEventListener('click', closePopup);
  backdrop.addEventListener('click', closePopup);
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      closePopup();
      document.removeEventListener('keydown', escHandler);
    }
  });

  // Focus the close button for accessibility
  closeBtn.focus();
}

/**
 * Show a popup when video generation is blocked by provider content filtering.
 * Explains why the content was rejected and how to fix it.
 */
function showContentFilteredPopup(userMessage) {
  const existing = document.getElementById('contentFilteredPopup');
  if (existing) existing.remove();

  const message = userMessage ||
    'Blocked by provider safety rules (third-party content). Try removing logos/faces/copyrighted characters.';

  const popup = document.createElement('div');
  popup.id = 'contentFilteredPopup';
  popup.setAttribute('role', 'alertdialog');
  popup.setAttribute('aria-labelledby', 'filterTitle');
  popup.setAttribute('aria-describedby', 'filterDesc');
  popup.innerHTML = `
    <div class="filter-popup-backdrop"></div>
    <div class="filter-popup-content">
      <button type="button" class="filter-popup-x" aria-label="Close">\u00d7</button>
      <div class="filter-popup-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 9v4m0 4h.01M3.27 17.44l7.46-12.88a1.5 1.5 0 0 1 2.54 0l7.46 12.88A1.5 1.5 0 0 1 19.46 20H4.54a1.5 1.5 0 0 1-1.27-2.56Z"/>
        </svg>
      </div>
      <h3 id="filterTitle">Content Blocked</h3>
      <p id="filterDesc">${message}</p>
      <div class="filter-popup-tips">
        <span class="filter-popup-tips-label">Common triggers</span>
        <ul>
          <li>Brand logos or trademarks</li>
          <li>Recognisable faces or celebrities</li>
          <li>Copyrighted characters or artwork</li>
        </ul>
      </div>
      <button type="button" class="filter-popup-close" aria-label="Close">Got it</button>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #contentFilteredPopup {
      position: fixed; inset: 0; z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
      animation: filterFadeIn 0.3s ease;
    }
    @keyframes filterFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .filter-popup-backdrop {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    }
    .filter-popup-content {
      position: relative; background: #111;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 16px;
      padding: 32px 28px; max-width: 400px; width: 100%;
      text-align: center;
      box-shadow: 0 24px 48px rgba(0,0,0,0.5);
      transform: translateY(20px);
      animation: filterSlideUp 0.35s cubic-bezier(0.16,1,0.3,1) forwards;
    }
    @keyframes filterSlideUp { to { transform: translateY(0); } }
    .filter-popup-x {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05); border-radius: 8px;
      font-size: 20px; color: #666; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s ease; line-height: 1;
    }
    .filter-popup-x:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.2); color: #fff;
    }
    .filter-popup-icon {
      width: 56px; height: 56px; margin: 0 auto 16px;
      background: rgba(245,158,11,0.08);
      border: 1px solid rgba(245,158,11,0.18); border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
    }
    .filter-popup-icon svg { width: 26px; height: 26px; color: #f59e0b; }
    .filter-popup-content h3 {
      margin: 0 0 10px; font-size: 1.5rem; font-weight: 700;
      color: #fff; letter-spacing: -0.01em;
    }
    .filter-popup-content p {
      margin: 0 0 20px; font-size: 0.9rem; color: #777; line-height: 1.6;
    }
    .filter-popup-tips {
      background: rgba(245,158,11,0.06);
      border: 1px solid rgba(245,158,11,0.12);
      border-radius: 10px; padding: 14px 18px; margin-bottom: 20px;
      text-align: left;
    }
    .filter-popup-tips-label {
      display: block; font-size: 10px; color: #888;
      text-transform: uppercase; letter-spacing: 0.15em;
      font-weight: 600; margin-bottom: 8px;
    }
    .filter-popup-tips ul {
      list-style: none; padding: 0; margin: 0;
    }
    .filter-popup-tips li {
      font-size: 0.85rem; color: #999; line-height: 1.8;
      padding-left: 16px; position: relative;
    }
    .filter-popup-tips li::before {
      content: "\\2022"; position: absolute; left: 0; color: #f59e0b;
    }
    .filter-popup-close {
      width: 100%; padding: 12px 20px; font-size: 14px; font-weight: 600;
      font-family: inherit;
      background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(234,88,12,0.15));
      border: 1px solid rgba(245,158,11,0.25); border-radius: 999px;
      color: #fff; cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4,0,0.2,1); letter-spacing: 0.02em;
    }
    .filter-popup-close:hover {
      background: linear-gradient(135deg, rgba(245,158,11,0.25), rgba(234,88,12,0.25));
      border-color: rgba(245,158,11,0.5);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(245,158,11,0.2);
    }
    .filter-popup-close:active { transform: translateY(0); }
  `;
  document.head.appendChild(style);
  document.body.appendChild(popup);

  const closeBtn = popup.querySelector('.filter-popup-close');
  const closeX = popup.querySelector('.filter-popup-x');
  const backdrop = popup.querySelector('.filter-popup-backdrop');
  const closePopup = () => {
    popup.style.opacity = '0';
    popup.style.transition = 'opacity 0.25s ease';
    setTimeout(() => { popup.remove(); style.remove(); }, 250);
  };
  closeBtn.addEventListener('click', closePopup);
  closeX.addEventListener('click', closePopup);
  backdrop.addEventListener('click', closePopup);
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { closePopup(); document.removeEventListener('keydown', escHandler); }
  });
  closeBtn.focus();
}

// Expose globally for api.js
window.showContentFilteredPopup = showContentFilteredPopup;

// Expose viewer for 3dprint-app.js (IIFE can't import ES modules)
window.TimrXViewer = {
  loadModelWithFallback: Viewer.loadModelWithFallback,
  loadGlbFromUrl: Viewer.loadGlbFromUrl,
  loadStlFromUrl: Viewer.loadStlFromUrl,
  clearModel: Viewer.clearModel,
  checkViewerAvailable: Viewer.checkViewerAvailable,
};

// ============================================================================
// FILE HANDLERS
// ============================================================================

function handleImageFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Please select an image (.png, .jpg, .webp)');
    return;
  }
  UI.state.imageFile = file;
  const url = URL.createObjectURL(file);
  if (imagePreview) {
    imagePreview.src = url;
    imagePreview.classList.remove('hidden');
  }
  UI.updateGenerateHint();
}

function handleModelFile(file) {
  const ok = /\.(glb|gltf)$/i.test(file.name);
  if (!ok) {
    alert('For instant preview, upload a .glb or .gltf file.');
    return;
  }
  UI.state.modelFile = file;
  if (modelFileHint) modelFileHint.textContent = `Selected: ${file.name}`;
}

// ============================================================================
// HISTORY MIGRATION
// ============================================================================

function migrateHistoryDates() {
  const arr = State.getHistory();
  let dirty = false;
  const fixed = arr.map(it => {
    const ms = normalizeEpochMs(it?.created_at);
    const y = new Date(ms).getFullYear();
    if (!it || (y < 2000 || y > 2099) || ms !== it.created_at) {
      dirty = true;
      return { ...it, created_at: ms };
    }
    return it;
  });
  if (dirty) State.saveHistory(fixed);
}

function migrateHistoryTitles() {
  try {
    const arr = State.getHistory();
    let dirty = false;
    const fixed = arr.map(it => {
      if (!it) return it;
      const title = shortTitle(it);
      if (it.title !== title) {
        dirty = true;
        return { ...it, title };
      }
      return it;
    });
    if (dirty) State.saveHistory(fixed);
  } catch { /* ignore */ }
}

// ============================================================================
// GENERATE BUTTON LISTENERS (Event Delegation)
// ============================================================================

function setupGenerateButtonListeners() {
  const leftStack = document.getElementById('leftStack');
  if (!leftStack) {
    log('leftStack not found for generate button listeners');
    return;
  }

  leftStack.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const btnId = btn.id;
    log('Generate button clicked:', btnId);

    if (btnId === 'applyRemeshBtn') {
      API.startRemeshFromPanel();
      return;
    }
    if (btnId === 'generateTextureBtn') {
      API.startTextureFromPanel();
      return;
    }
    if (btnId === 'startRigBtn') {
      API.startRigFromPanel();
      return;
    }
    if (btnId === 'applyAnimationBtn2') {
      const animState = window._timrxAnimState || {};
      const riggingTaskId = animState.rig_task_id || window._lastRigTaskId || '';
      const stateActionId = animState.selected_action_id;
      const domActionIdRaw = document.getElementById('animActionId2')?.value;
      const actionId = stateActionId != null ? parseInt(stateActionId, 10)
        : (domActionIdRaw ? parseInt(domActionIdRaw, 10) : null);
      console.log('[Anim] Apply clicked: rigTaskId=' + riggingTaskId + ' actionId=' + actionId + ' state=' + JSON.stringify({selected: stateActionId, dom: domActionIdRaw, is_rigged: animState.is_rigged}));

      // Pre-validate and give helpful feedback instead of silent failure
      if (!riggingTaskId) {
        alert('No rigged model loaded. Please rig a model first, or load one from history.');
        return;
      }
      if (actionId == null || isNaN(actionId)) {
        alert('Please select an animation from the library or quick picks before clicking Apply.');
        return;
      }
      let postProcess = null;
      try {
        postProcess = API.getAnimationPostProcessValues();
      } catch (err) {
        alert(err?.message || 'Invalid animation output settings.');
        return;
      }
      API.startAnimationFromPanel(riggingTaskId, actionId, postProcess);
      return;
    }
    if (!btnId || !btnId.includes('generate')) return;

    if (btnId === 'generateModelBtn') {
      API.onGenerateClick();
    } else if (btnId === 'generateImageBtn') {
      API.startImageGenerationByProvider();
    } else if (btnId === 'generateVideoBtn') {
      API.startVideoGeneration();
    }
  });

  log('Generate button listeners set up via event delegation');
}

// ============================================================================
// VIEWER TOOLBAR
// ============================================================================

let _printToastTimer = null;

function closeViewerPopovers() {
  document.getElementById('viewerSharePopover')?.classList.remove('is-visible');
  document.getElementById('viewerPrintPanel')?.classList.remove('is-visible');
  document.getElementById('viewerPrintBackdrop')?.classList.remove('is-visible');
  if (_printToastTimer) { clearTimeout(_printToastTimer); _printToastTimer = null; }
}

function initViewerToolbar() {
  const toolbar = document.getElementById('viewerToolbar');
  if (!toolbar) return;

  const sharePopover = document.getElementById('viewerSharePopover');
  const printPanel = document.getElementById('viewerPrintPanel');
  const printBackdrop = document.getElementById('viewerPrintBackdrop');
  const printCloseBtn = document.getElementById('printPanelCloseBtn');

  function togglePrintPanel(show) {
    printPanel?.classList.toggle('is-visible', !!show);
    printBackdrop?.classList.toggle('is-visible', !!show);
    document.body.classList.toggle('print-panel-open', !!show);
  }

  // ── Print Readiness Check ──
  let _printCheckInFlight = false;

  function showPrintPanelState(state) {
    const loading = document.getElementById('printPanelLoading');
    const error   = document.getElementById('printPanelError');
    const results = document.getElementById('printPanelResults');
    if (loading) loading.style.display = state === 'loading' ? '' : 'none';
    if (error)   error.style.display   = state === 'error'   ? '' : 'none';
    if (results) results.style.display = state === 'results' ? '' : 'none';
  }

  function renderPrintResults(data) {
    const printerTypeValue = document.getElementById('printPrinterType')?.value || 'fdm';
    const isResin = printerTypeValue === 'resin';
    const printerLabel = isResin ? 'Resin' : 'FDM';

    // Score badge
    const badge = document.getElementById('printScoreBadge');
    const verdict = document.getElementById('printVerdict');
    const summary = document.querySelector('.print-panel-summary');
    if (badge) {
      badge.textContent = data.score;
      badge.className = 'print-panel-score-badge';
      if (data.score >= 90)      badge.classList.add('score-good');
      else if (data.score >= 60) badge.classList.add('score-warn');
      else                       badge.classList.add('score-bad');
    }
    if (verdict) {
      const label = data.score >= 90 ? 'Excellent'
        : data.score >= 70 ? 'Print-Ready'
        : data.score >= 60 ? 'Printable with caveats'
        : 'Needs repair';
      verdict.textContent = label;
      verdict.className = 'print-panel-verdict';
      verdict.classList.add(data.score >= 70 ? 'is-good' : 'is-bad');
    }
    if (summary) {
      const isWatertight = data.checks?.is_manifold;
      const wasRemeshed = data.is_remeshed === true || (data.model_stage === 'remeshed');
      if (data.score >= 90) {
        summary.textContent = `Excellent mesh quality. Adjust the target size if needed and export a print-ready STL.`;
      } else if (data.score >= 70) {
        summary.textContent = `The model clears the main ${printerLabel} checks. ${!isWatertight ? (wasRemeshed ? 'The mesh still has open edges after remesh — most slicers can auto-repair this. ' : 'Remesh to close open edges for a higher score. ') : ''}Review below, adjust size, and export.`;
      } else if (data.score >= 60) {
        summary.textContent = wasRemeshed && !isWatertight
          ? `The model was remeshed but still has open edges — a known limitation with some AI geometry. Export the STL and let your slicer's auto-repair handle it, or fix manually in Blender/Meshmixer.`
          : `The model can be printed but has geometry issues. ${!isWatertight ? 'Use Remesh to repair open edges — this will unlock wall thickness analysis and improve the score.' : 'Review the issues below.'}`;
      } else {
        summary.textContent = wasRemeshed
          ? `The remeshed model still has significant geometry issues. This AI-generated mesh may need manual repair in Blender or Meshmixer. Export the STL and use their auto-repair tools before printing.`
          : `The model has critical geometry issues for ${printerLabel} printing. Remesh the model to repair it before exporting.`;
      }
    }

    // ── Model-state banner ─────────────────────────────────────────
    const stateBadge = document.getElementById('printModelStateBadge');
    const stateTitle = document.getElementById('printModelStateTitle');
    const stateAdvice = document.getElementById('printModelStateAdvice');
    const stateBanner = document.getElementById('printModelStateBanner');
    if (stateBanner) {
      const stage = data.model_stage || 'unknown';
      const isRemeshed = data.is_remeshed === true;
      const isRefined = data.is_refined === true;

      const stageLabels = {
        preview:     { label: 'Preview',     color: '#f59e0b', bg: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.25)' },
        refined:     { label: 'Refined',     color: '#3b82f6', bg: 'rgba(59,130,246,.12)', border: 'rgba(59,130,246,.25)' },
        retextured:  { label: 'Retextured',  color: '#8b5cf6', bg: 'rgba(139,92,246,.12)', border: 'rgba(139,92,246,.25)' },
        remeshed:    { label: 'Remeshed',    color: '#22c55e', bg: 'rgba(34,197,94,.12)',  border: 'rgba(34,197,94,.25)' },
        image3d:     { label: 'Image-to-3D', color: '#06b6d4', bg: 'rgba(6,182,212,.12)',  border: 'rgba(6,182,212,.25)' },
        unknown:     { label: 'Unknown',     color: '#888',    bg: 'rgba(255,255,255,.04)', border: 'rgba(255,255,255,.08)' },
      };
      const info = stageLabels[stage] || stageLabels.unknown;

      if (stateBadge) {
        stateBadge.textContent = info.label;
        stateBadge.style.background = info.bg;
        stateBadge.style.borderColor = info.border;
        stateBadge.style.color = info.color;
        stateBadge.style.border = `1px solid ${info.border}`;
      }

      let advice = '';
      const isWatertight = data.checks?.is_manifold === true;
      if (isRemeshed && isWatertight) {
        advice = 'This model has been remeshed and has clean, watertight topology. Verify dimensions, export STL, and do a final check in your slicer.';
      } else if (isRemeshed && !isWatertight) {
        advice = 'This model has been remeshed but still has open edges. This is a known limitation with some AI-generated geometry. Export the STL and use your slicer\'s auto-repair, or fix in Blender/Meshmixer before printing.';
      } else if (stage === 'preview') {
        advice = 'This is a preview-grade mesh with rough geometry. For best print results: Refine first (improves geometry + adds textures), then Remesh with the Print Ready preset before exporting.';
      } else if (isRefined) {
        advice = 'This model is refined with high-quality textures. For printing, textures do not matter — only geometry does. Remesh with the Print Ready preset to produce clean, watertight topology before exporting STL.';
      } else if (stage === 'retextured') {
        advice = 'This model has been retextured. Retexturing changes surface appearance but may have altered mesh topology. Remesh with Print Ready preset to ensure clean geometry for printing.';
      } else if (stage === 'image3d') {
        advice = 'This model was generated from an image. Image-to-3D models typically need remeshing before printing. Use the Remesh panel with the Print Ready preset, then re-run this check.';
      } else {
        advice = 'Model source unknown. Run a Remesh with Print Ready preset to ensure the mesh is watertight and suitable for slicing before exporting.';
      }

      if (stateAdvice) stateAdvice.textContent = advice;
      if (stateTitle) {
        if (isRemeshed && isWatertight) {
          stateTitle.textContent = 'Ready for print prep';
        } else if (isRemeshed && !isWatertight) {
          stateTitle.textContent = 'Remeshed — needs slicer repair';
        } else {
          stateTitle.textContent = 'Recommended: Remesh before export';
        }
      }
    }

    // Checks grid
    const grid = document.getElementById('printChecksGrid');
    if (grid) {
      const c = data.checks || {};
      const overhangValue = isResin ? c.overhang_resin_pct : c.overhang_fdm_pct;
      const rows = [
        { label: 'Watertight', ok: c.is_manifold, detail: c.is_manifold ? 'Closed manifold mesh' : 'Open edges detected' },
        { label: 'Face count', ok: c.face_count_ok, detail: c.face_count ? `${c.face_count.toLocaleString()} faces` : 'Unknown' },
        { label: 'Clean faces', ok: !c.has_degenerate_faces, detail: c.degenerate_face_count ? `${c.degenerate_face_count} degenerate faces` : 'No invalid faces found' },
        { label: 'Volume', ok: c.is_volume_positive, detail: c.estimated_volume_cm3 ? `${c.estimated_volume_cm3} cm³ volume` : 'Unavailable for non-watertight mesh' },
        { label: 'Dimensions', ok: true, detail: c.bounding_box_mm ? c.bounding_box_mm.map(v => v.toFixed(1)).join(' × ') + ' mm' : 'Unknown size' },
        { label: 'Wall thickness', ok: c.wall_thickness_ok, detail: c.min_wall_thickness_mm != null ? `Min ${c.min_wall_thickness_mm} mm` : 'Unavailable' },
        { label: `Overhangs (${printerLabel})`, ok: overhangValue != null ? overhangValue < (isResin ? 12 : 20) : null,
          detail: overhangValue != null ? `${overhangValue}% of faces need support review` : 'Unavailable' },
      ];
      grid.innerHTML = rows.map(r => `
        <div class="print-check-row ${r.ok === true ? 'is-good' : r.ok === false ? 'is-bad' : 'is-neutral'}">
          <span class="print-check-icon">${r.ok === true ? '✓' : r.ok === false ? '!' : '—'}</span>
          <span class="print-check-label">${r.label}</span>
          <span class="print-check-detail">${r.detail}</span>
        </div>
      `).join('');
    }

    // Issues
    const issuesList = document.getElementById('printIssuesList');
    if (issuesList) {
      issuesList.style.display = '';
      issuesList.innerHTML = '<p class="print-section-title">Issues</p>' +
        (data.issues?.length
          ? data.issues.map(i => `<p class="print-issue-item">• ${i}</p>`).join('')
          : '<p class="print-issue-item print-issue-item--empty">No critical issues found in this analysis.</p>');
    }

    // Suggestions
    const suggestionsList = document.getElementById('printSuggestionsList');
    if (suggestionsList) {
      suggestionsList.style.display = '';
      suggestionsList.innerHTML = '<p class="print-section-title">Suggestions</p>' +
        (data.suggestions?.length
          ? data.suggestions.map(s => `<p class="print-suggestion-item">→ ${s}</p>`).join('')
          : '<p class="print-suggestion-item print-suggestion-item--empty">No extra changes recommended before export.</p>');
    }

    // Show print prep section with dimensions from analysis
    const printPrepSection = document.getElementById('printPrepSection');
    if (printPrepSection && data.checks) {
      printPrepSection.style.display = '';
      const c = data.checks;

      // Display dimensions with unit detection info
      const dimDisplay = document.getElementById('printDimensionsDisplay');
      if (dimDisplay && c.bounding_box_mm) {
        const dims = c.bounding_box_mm;
        const unit = c.detected_unit || 'mm';
        dimDisplay.innerHTML = `
          <div class="print-prep-dimensions">
            <div class="print-prep-dim-row">
              <span class="print-prep-dim-label">Width</span>
              <span class="print-prep-dim-value">${dims[0].toFixed(1)} mm</span>
            </div>
            <div class="print-prep-dim-row">
              <span class="print-prep-dim-label">Height</span>
              <span class="print-prep-dim-value">${dims[1].toFixed(1)} mm</span>
            </div>
            <div class="print-prep-dim-row">
              <span class="print-prep-dim-label">Depth</span>
              <span class="print-prep-dim-value">${dims[2].toFixed(1)} mm</span>
            </div>
            ${unit === 'meters' ? '<div class="print-prep-dim-note">Auto-converted from meters to mm</div>' : ''}
          </div>
        `;
      }

      // Wire up target height → live dimension preview
      const targetInput = document.getElementById('printTargetHeight');
      const scaledDims = document.getElementById('printScaledDimensions');
      if (targetInput && scaledDims && c.bounding_box_mm) {
        targetInput.oninput = () => {
          const target = parseFloat(targetInput.value);
          if (target > 0 && c.bounding_box_mm[1] > 0) {
            const ratio = target / c.bounding_box_mm[1];
            scaledDims.style.display = '';
            scaledDims.innerHTML = `
              <div class="print-prep-dim-note">
                Scaled: ${(c.bounding_box_mm[0] * ratio).toFixed(1)} ×
                ${target.toFixed(1)} ×
                ${(c.bounding_box_mm[2] * ratio).toFixed(1)} mm
                (${(ratio * 100).toFixed(0)}% of original)
              </div>
            `;
          } else {
            scaledDims.style.display = 'none';
          }
        };
      }
    }

    // Wire up STL export button
    const stlBtn = document.getElementById('printExportSTLBtn');
    if (stlBtn) {
      stlBtn.onclick = async () => {
        const item = API.getActiveHistoryItem();
        if (!item) {
          alert('No model selected. Open a model from history first.');
          return;
        }

        // 1. Check if Meshy provided an STL URL directly
        const stlUrl = item.stl_url || item.model_urls?.stl || item.textured_model_urls?.stl;
        if (stlUrl) {
          const filename = buildItemDownloadFilename(item, {
            type: 'model',
            sourceUrl: stlUrl,
            extension: 'stl',
          });
          startWorkspaceDownload(stlUrl, filename);
          return;
        }

        // 2. Client-side STL export from viewer model
        const model = window._timrxCurrentModel || window.inspireCurrentModel || null;
        if (model && window.THREE?.STLExporter) {
          try {
            const { detectModelUnits, exportPrintReadySTL } = await import('./print-prep.js');
            const unitInfo = detectModelUnits(model);
            const displayScale = model.userData?.displayScale || 1;
            const targetHeight = parseFloat(document.getElementById('printTargetHeight')?.value) || 0;
            const filename = buildItemDownloadFilename(item, {
              type: 'model',
              sourceUrl: item.glb_url || item.glb_proxy || '',
              extension: 'stl',
            });
            exportPrintReadySTL(model, displayScale, unitInfo, targetHeight, filename);
            return;
          } catch (err) {
            console.error('[PrintExport] Client-side STL export failed:', err);
          }
        }

        // 3. Fallback — download the GLB file directly
        const glbUrl = item.glb_url || item.glb_proxy;
        if (glbUrl) {
          const filename = buildItemDownloadFilename(item, {
            type: 'model',
            sourceUrl: glbUrl,
            extension: inferExtensionFromUrl(glbUrl) || 'glb',
          });
          startWorkspaceDownload(glbUrl, filename);
          return;
        }

        alert('No exportable model found. Load the model in the viewer first.');
      };
    }

    // Wire up 3MF export button
    const threeMfBtn = document.getElementById('printExport3MFBtn');
    if (threeMfBtn) {
      threeMfBtn.onclick = async () => {
        const item = API.getActiveHistoryItem();
        if (!item) { alert('No model selected. Open a model from history first.'); return; }

        // Check for existing 3MF URL from Meshy
        const threeMfUrl = item.model_urls?.['3mf'] || item.textured_model_urls?.['3mf'];
        if (threeMfUrl) {
          const filename = buildItemDownloadFilename(item, { type: 'model', sourceUrl: threeMfUrl, extension: '3mf' });
          startWorkspaceDownload(threeMfUrl, filename);
          return;
        }

        // Fallback: download GLB (user can convert in slicer — most slicers accept GLB)
        const glbUrl = item.glb_url || item.glb_proxy;
        if (glbUrl) {
          const filename = buildItemDownloadFilename(item, { type: 'model', sourceUrl: glbUrl, extension: inferExtensionFromUrl(glbUrl) || 'glb' });
          startWorkspaceDownload(glbUrl, filename);
          if (window.showToast) window.showToast('3MF not available for this model. Downloaded GLB instead — import it into your slicer to convert.', 'info');
          return;
        }
        alert('No exportable model found. Load the model in the viewer first.');
      };
    }

    // Wire up slicer launch buttons
    document.querySelectorAll('.print-slicer-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slicer = btn.dataset.slicer;
        const item = API.getActiveHistoryItem();
        if (!item) { alert('No model selected. Open a model from history first.'); return; }

        // Get the best URL for the model
        const modelUrl = item.glb_url || item.glb_proxy;
        if (!modelUrl) { alert('No model URL available.'); return; }

        // Slicer URL schemes for local app launch
        const slicerSchemes = {
          bambustudio: 'bambustudioopen',
          orcaslicer: 'orcaslicer',
          cura: 'cura',
          prusaslicer: 'prusaslicer',
        };
        const scheme = slicerSchemes[slicer];
        if (!scheme) return;

        // Try to open via URL scheme (works if slicer is installed)
        // Most slicers register custom URL schemes that accept file URLs
        try {
          const filename = buildItemDownloadFilename(item, { type: 'model', sourceUrl: modelUrl, extension: inferExtensionFromUrl(modelUrl) || 'glb' });

          // Download file first so user has it, then attempt slicer launch
          startWorkspaceDownload(modelUrl, filename);
          if (window.showToast) {
            window.showToast(`File downloaded. Open it in ${btn.querySelector('.print-service-name').textContent} to slice and print.`, 'info');
          }
        } catch (err) {
          console.warn('[Slicer] Launch failed:', err);
          alert(`Could not open ${slicer}. Make sure it is installed on your computer.`);
        }
      });
    });

    showPrintPanelState('results');
  }

  async function runPrintCheck(item) {
    if (_printCheckInFlight) return;
    _printCheckInFlight = true;

    const printBtn = toolbar.querySelector('[data-action="print"]');
    if (printBtn) printBtn.classList.add('is-loading');

    // Show panel with loading state
    showPrintPanelState('loading');
    togglePrintPanel(true);

    try {
      const jobId = item.id || item.model_id;
      const printerType = document.getElementById('printPrinterType')?.value || 'fdm';
      const res = await apiFetch(`/api/_mod/print-check/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printer_type: printerType }),
      });
      if (!res.ok) {
        throw new Error(res.error || `Server error (${res.status})`);
      }
      renderPrintResults(res.data);
    } catch (err) {
      showPrintPanelState('error');
      const errMsg = document.getElementById('printPanelErrorMsg');
      if (errMsg) errMsg.textContent = err.message || 'Analysis failed. Please try again.';
    } finally {
      _printCheckInFlight = false;
      if (printBtn) printBtn.classList.remove('is-loading');
    }
  }

  // Retry button inside error state
  document.getElementById('printPanelRetryBtn')?.addEventListener('click', () => {
    const item = API.getActiveHistoryItem();
    if (item) runPrintCheck(item);
  });

  printCloseBtn?.addEventListener('click', () => {
    togglePrintPanel(false);
  });

  printBackdrop?.addEventListener('click', () => {
    togglePrintPanel(false);
  });

  document.getElementById('printPrinterType')?.addEventListener('change', () => {
    const item = API.getActiveHistoryItem();
    if (item && printPanel?.classList.contains('is-visible')) {
      runPrintCheck(item);
    }
  });

  // Share popover button clicks
  if (sharePopover) {
    sharePopover.addEventListener('click', async (e) => {
      const shareBtn = e.target.closest('[data-share-action]');
      if (!shareBtn) return;
      e.stopPropagation();
      const act = shareBtn.dataset.shareAction;
      const item = API.getActiveHistoryItem();

      if (act === 'copy-link') {
        const link = item?.glb_proxy || item?.glb_url;
        if (!link) { alert('No downloadable link available yet.'); return; }
        try {
          await navigator.clipboard.writeText(link);
          alert('Link copied to clipboard.');
        } catch { prompt('Copy link manually:', link); }
      }
      if (act === 'share-twitter') {
        const text = item?.prompt ? `Check out my creation: "${item.prompt.slice(0, 120)}"` : 'Check out my AI creation on TimrX!';
        window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://timrx.live/3dprint')}`, '_blank');
      }
      if (act === 'share-facebook') {
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent('https://timrx.live/3dprint')}`, '_blank');
      }
      if (act === 'share-linkedin') {
        window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://timrx.live/3dprint')}`, '_blank');
      }
      if (act === 'share-discord' && item) {
        const thumbUrl = item.thumbnail_url || item.image_url || '';
        const promptText = item.prompt || '';
        const assetType = item.video_url ? 'video' : (item.image_url && !item.glb_url ? 'image' : 'model');
        apiFetch('/api/_mod/community/discord-share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: assetType, prompt: promptText, thumbnail_url: thumbUrl }),
        }).then(() => alert('Shared to Discord!')).catch(() => alert('Failed to share to Discord.'));
        window.open('https://discord.gg/VpqT2UywDG', '_blank');
      }
      if (act === 'share-inspire' && item) {
        const assetType = item.video_url ? 'video' : (item.image_url && !item.glb_url ? 'image' : 'model');
        apiFetch('/api/_mod/inspire/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, type: assetType, share: true }),
        }).then(res => {
          if (res.ok && window.showToast) window.showToast('Shared to Inspire!', 'success');
          else if (window.showToast) window.showToast(res.data?.error || 'Failed to share', 'error');
        }).catch(() => { if (window.showToast) window.showToast('Failed to share to Inspire', 'error'); });
      }
      closeViewerPopovers();
    });
  }

  // Close popovers on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#viewerSharePopover') && !e.target.closest('[data-action="share"]')) {
      sharePopover?.classList.remove('is-visible');
    }
    if (!e.target.closest('#viewerPrintPanel') && !e.target.closest('[data-action="print"]')) {
      togglePrintPanel(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      togglePrintPanel(false);
      sharePopover?.classList.remove('is-visible');
    }
  });

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.viewer-toolbar__btn');
    if (!btn) return;

    const action = btn.dataset.action;
    const activeItem = API.getActiveHistoryItem();

    if (action === 'download' && activeItem?.glb_url) {
      if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
        Credits.showDownloadAccessRequiredMessage('model');
        return;
      }
      const filename = buildItemDownloadFilename(activeItem, {
        type: 'model',
        sourceUrl: activeItem.glb_url,
        extension: inferExtensionFromUrl(activeItem.glb_url) || 'glb',
      });
      startWorkspaceDownload(activeItem.glb_url, filename);
    }

    if (action === 'texture' && activeItem) {
      API.startTextureFromHistory(activeItem, 'viewer');
    }

    if (action === 'paint') {
      closeViewerPopovers();
      const uploadSource = window._timrxViewerUploadSource;
      const currentModel = window._timrxCurrentModel;
      if (uploadSource && currentModel?.clone) {
        currentModel.updateMatrixWorld?.(true);
        openMultiColorModal({
          taskId: null,
          title: uploadSource.title || uploadSource.fileName || 'Uploaded model',
          thumbnailUrl: '',
          glbUrl: '',
          sourceObject: currentModel.clone(true),
        });
        return;
      }

      if (activeItem) {
        const glbUrl = activeItem.glb_proxy || activeItem.glb_url || activeItem.model_url || '';
        if (!glbUrl) {
          if (window.showToast) window.showToast('No paintable model URL found for this item.', 'error');
          else alert('No paintable model URL found for this item.');
          return;
        }
        openMultiColorModal({
          taskId: activeItem.id || activeItem.model_id || '',
          title: activeItem.title || activeItem.prompt || 'Untitled',
          thumbnailUrl: activeItem.thumbnail_url || activeItem.image_url || '',
          glbUrl,
          onRepair: (options) => API.startPrintReadyRemeshFromItem(activeItem, options),
        });
        return;
      }

      if (currentModel?.clone) {
        currentModel.updateMatrixWorld?.(true);
        openMultiColorModal({
          taskId: null,
          title: 'Viewer model',
          thumbnailUrl: '',
          glbUrl: '',
          sourceObject: currentModel.clone(true),
        });
        return;
      }

      if (window.showToast) window.showToast('Load a model in the viewer first.', 'info');
      else alert('Load a model in the viewer first.');
    }

    if (action === 'refine' && activeItem) {
      API.startRefineFromHistory(activeItem, 'viewer');
    }

    if (action === 'remesh' && activeItem) {
      API.startRemeshFromHistory(activeItem);
    }

    if (action === 'share') {
      togglePrintPanel(false);
      sharePopover?.classList.toggle('is-visible');
    }

    if (action === 'print') {
      sharePopover?.classList.remove('is-visible');
      if (printPanel?.classList.contains('is-visible')) {
        togglePrintPanel(false);
      } else if (activeItem) {
        runPrintCheck(activeItem);
      }
    }

    // AR Quick Look handler
    if (action === 'ar') {
      const item = API.getActiveHistoryItem();
      if (!item) return;
      const glbUrl = item.glb_proxy || item.glb_url || item.model_url || '';
      const usdzUrl = item.processed_usdz_url || item.model_urls?.usdz || item.textured_model_urls?.usdz || '';
      const modelUrl = usdzUrl || glbUrl;
      if (!modelUrl) {
        if (window.showToast) window.showToast('No model available for AR preview.', 'info');
        return;
      }
      // Create a temporary model-viewer element for AR
      let arViewer = document.getElementById('timrx-ar-viewer');
      if (!arViewer) {
        arViewer = document.createElement('model-viewer');
        arViewer.id = 'timrx-ar-viewer';
        arViewer.setAttribute('ar', '');
        arViewer.setAttribute('camera-controls', '');
        arViewer.setAttribute('shadow-intensity', '0.5');
        arViewer.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:rgba(0,0,0,0.9);';
        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕ Close AR';
        closeBtn.style.cssText = 'position:fixed;top:70px;right:20px;z-index:100000;padding:10px 20px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;backdrop-filter:blur(8px);';
        closeBtn.onclick = function() { arViewer.remove(); closeBtn.remove(); };
        document.body.appendChild(arViewer);
        document.body.appendChild(closeBtn);
        // Load model-viewer if not already loaded
        if (!customElements.get('model-viewer')) {
          import('https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js');
        }
      }
      arViewer.setAttribute('ar-modes', usdzUrl ? 'webxr scene-viewer quick-look' : 'webxr scene-viewer');
      arViewer.setAttribute('src', glbUrl || modelUrl);
      if (usdzUrl) {
        arViewer.setAttribute('ios-src', usdzUrl);
      } else {
        arViewer.removeAttribute('ios-src');
      }
      arViewer.setAttribute('alt', item.title || item.prompt || '3D Model AR Preview');
      // Auto-activate AR if supported
      arViewer.addEventListener('load', function() {
        if (arViewer.canActivateAR) {
          arViewer.activateAR();
        }
      }, { once: true });
      return;
    }

    if (action === 'retry' && activeItem) {
      closeViewerPopovers();
      const prompt = activeItem.prompt || activeItem.root_prompt || '';
      if (!prompt) { alert('No prompt available to retry.'); return; }
      const isImage = activeItem.stage === 'image-to-3d' || activeItem.stage === 'image_to_3d';
      if (isImage) {
        const railBtn = document.querySelector('[data-panel="image3d"]');
        if (railBtn) railBtn.click();
      } else {
        const railBtn = document.querySelector('[data-panel="text3d"]');
        if (railBtn) railBtn.click();
        const promptInput = byId('modelPrompt');
        if (promptInput) {
          promptInput.value = prompt;
          promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }

    if (action === 'evolve' && activeItem) {
      closeViewerPopovers();
      API.evolveFromHistory(activeItem, 2);
    }

  });
}

// ============================================================================
// VIEWER ACTION BAR (Accept / Revert)
// ============================================================================

function initViewerActionBar() {
  const actionBar = byId('viewerActionBar');
  if (!actionBar) return;

  actionBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vab]');
    if (!btn) return;
    const act = btn.dataset.vab;

    if (act === 'accept') {
      actionBar.classList.add('hidden');
    }

    if (act === 'revert') {
      const popped = State.popModelVersion();
      if (popped && popped.glb_url) {
        Viewer.loadGlbFromUrl(popped.glb_url);
        State.setHistoryActiveModelId(popped.id);
      }
      if (!State.canRevertModel()) {
        actionBar.classList.add('hidden');
      }
    }
  });

  // Listen for model:edited events to show the bar
  window.addEventListener('model:edited', () => {
    if (State.canRevertModel()) {
      actionBar.classList.remove('hidden');
    }
  });

  // Update toolbar disabled states based on active model
  function updateToolbarState() {
    const toolbar = byId('viewerToolbar');
    if (!toolbar) return;
    const activeItem = API.getActiveHistoryItem();
    const hasModel = !!activeItem;
    const stage = String(activeItem?.stage || activeItem?.payload?.stage || '').toLowerCase();
    const canRefine = !!(activeItem && (activeItem.preview_task_id || stage === 'preview'));
    const actionBtns = toolbar.querySelectorAll('.viewer-toolbar__btn[data-action]');
    actionBtns.forEach(btn => {
      const act = btn.dataset.action;
      // download, share, print, remesh, texture, evolve, retry all need a model
      if (['download', 'remesh', 'texture', 'evolve', 'retry', 'print'].includes(act)) {
        btn.disabled = !hasModel;
      } else if (act === 'refine') {
        btn.disabled = !canRefine;
      }
    });
  }

  // Run on init and whenever history re-renders
  updateToolbarState();
  window.addEventListener('history:rendered', updateToolbarState);
}

// ============================================================================
// TIMRX PRINT ORDER MODAL
// ============================================================================

function initTimrxOrderModal() {
  const panel = document.getElementById('timrxOrderPanel');
  const backdrop = document.getElementById('timrxOrderBackdrop');
  const openBtn = document.getElementById('openTimrxOrderBtn');
  if (!panel || !backdrop || !openBtn) return;

  // Robust active-model resolver for print ordering.
  //
  // `API.getActiveHistoryItem()` keys off `State.historyActiveModelId`.
  // That ID can lag the viewer in several ways:
  //   - newly generated/loaded model whose history-item update hasn't
  //     finished propagating to the in-memory cache yet,
  //   - history-active-id pointing at a parent that has since been
  //     superseded by a remesh/texture variant on top of the version stack,
  //   - active id set but the matching history row has no glb_url cached.
  //
  // The viewer's `State.modelVersionStack` is the authoritative source of
  // what is currently rendered — its top entry has `{id, glb_url, ...}`.
  // We try that as a fallback, and finally fall back to the first history
  // entry that actually has a GLB. Only if all three turn up nothing do we
  // block ordering.
  function resolveActivePrintItem() {
    const activeFromHistory = (window.API && API.getActiveHistoryItem) ? API.getActiveHistoryItem() : null;
    if (activeFromHistory && (activeFromHistory.glb_url || activeFromHistory.glb_proxy) && (activeFromHistory.id || activeFromHistory.model_id)) {
      return activeFromHistory;
    }

    // Fall back to the top of the model version stack — that's the model
    // currently rendered in the viewer.
    const stack = State.getModelVersionStack ? State.getModelVersionStack() : [];
    const top = stack && stack.length ? stack[stack.length - 1] : null;
    if (top && top.id && top.glb_url) {
      // Prefer the fully-hydrated history item for the same id (title,
      // thumbnail_url, etc.), but synthesize a minimal item if it isn't
      // cached yet.
      const fromHistory = State.findHistoryItem ? State.findHistoryItem(top.id) : null;
      if (fromHistory && (fromHistory.glb_url || fromHistory.glb_proxy)) {
        return fromHistory;
      }
      return {
        id: top.id,
        glb_url: top.glb_url,
        thumbnail_url: top.thumbnail_url || '',
        prompt: top.prompt || '',
        stage: top.stage || ''
      };
    }

    // Last resort: most recent history item that has a printable GLB.
    const history = (State.getHistory ? State.getHistory() : []) || [];
    const firstPrintable = history.find((x) => x && (x.id || x.model_id) && (x.glb_url || x.glb_proxy));
    return firstPrintable || null;
  }

  const closeBtn   = document.getElementById('timrxOrderCloseBtn');
  const nextBtn    = document.getElementById('timrxOrderNextBtn');
  const backBtn    = document.getElementById('timrxOrderBackBtn');
  const doneBtn    = document.getElementById('timrxOrderDoneBtn');
  const matSelect  = document.getElementById('timrxOrderMaterial');
  const matHint    = document.getElementById('timrxOrderMaterialHint');
  const swatchBox  = document.getElementById('timrxOrderSwatches');
  const qualitySel = document.getElementById('timrxOrderQuality');
  const infillEl   = document.getElementById('timrxOrderInfill');
  const infillVal  = document.getElementById('timrxOrderInfillVal');
  const infillField= document.getElementById('timrxOrderInfillField');
  const heightEl   = document.getElementById('timrxOrderHeight');
  const finishSel  = document.getElementById('timrxOrderFinish');
  const qtyEl      = document.getElementById('timrxOrderQty');
  const countrySel = document.getElementById('timrxShipCountry');
  const speedSel   = document.getElementById('timrxShipSpeed');
  const consentEl  = document.getElementById('timrxOrderConsent');
  const reviewBox  = document.getElementById('timrxOrderReview');
  const scaledHint = document.getElementById('timrxOrderScaledHint');
  const footer     = document.getElementById('timrxOrderFooter');
  const stepsBox   = document.getElementById('timrxOrderSteps');

  const estMaterial = document.getElementById('timrxEstMaterial');
  const estTime     = document.getElementById('timrxEstTime');
  const estTotal    = document.getElementById('timrxEstTotal');

  // Country-to-currency map mirrors backend pick_currency.
  const USD_COUNTRIES = new Set(['US', 'CA', 'AU']);
  const GBP_COUNTRIES = new Set(['GB']);
  function currencyFor(country) {
    const c = String(country || '').toUpperCase();
    if (USD_COUNTRIES.has(c)) return 'USD';
    if (GBP_COUNTRIES.has(c)) return 'GBP';
    return 'EUR';
  }
  function currencySymbol(cur) {
    return cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : '$';
  }
  // Naive FX (matches backend FX_FROM_USD). Frontend display only —
  // the backend recomputes the authoritative price before charging.
  function fxFromUsd(cur) {
    if (cur === 'EUR') return 0.92;
    if (cur === 'GBP') return 0.79;
    return 1.0;
  }

  // ── Material catalog (per process) ─────────────────────────────────
  const MATERIALS = {
    fdm: [
      { id: 'pla',   label: 'PLA',          density: 1.24, ratePerKg: 38,  hint: 'Easy to print, vivid colors, biodegradable. Great for display pieces.' },
      { id: 'plaplus', label: 'PLA+ (tough)', density: 1.24, ratePerKg: 52, hint: 'Stronger and tougher than standard PLA. Recommended for functional parts.' },
      { id: 'petg',  label: 'PETG',         density: 1.27, ratePerKg: 58,  hint: 'Tough, slightly flexible, food-safe. Good for outdoor and mechanical parts.' },
      { id: 'abs',   label: 'ABS',          density: 1.04, ratePerKg: 62,  hint: 'High temp resistance, impact strong. Best for mechanical and automotive parts.' },
      { id: 'tpu',   label: 'TPU (flex)',   density: 1.21, ratePerKg: 78,  hint: 'Flexible rubber-like filament. Great for grips, gaskets and wearables.' },
      { id: 'silk',  label: 'PLA Silk',     density: 1.24, ratePerKg: 62,  hint: 'High-gloss premium PLA. Beautiful for figurines and decorative prints.' },
    ],
    resin: [
      { id: 'std',   label: 'Standard Resin', density: 1.10, ratePerKg: 95,  hint: 'Crisp detail, great for figurines, miniatures and presentation models.' },
      { id: 'tough', label: 'Tough Resin',    density: 1.13, ratePerKg: 120, hint: 'Impact-resistant resin. Suitable for functional prototypes.' },
      { id: 'clear', label: 'Clear Resin',    density: 1.10, ratePerKg: 130, hint: 'Translucent finish, ideal for light pieces, lenses, decorative items.' },
      { id: 'flex',  label: 'Flexible Resin', density: 1.10, ratePerKg: 160, hint: 'Soft & bendable. For grips, gaskets, wearables.' },
    ],
  };

  // ── Color catalog ──────────────────────────────────────────────────
  const COLORS = [
    { id: 'black',  label: 'Black',  hex: '#111111' },
    { id: 'white',  label: 'White',  hex: '#f3f3f3' },
    { id: 'gray',   label: 'Gray',   hex: '#9aa0a6' },
    { id: 'red',    label: 'Red',    hex: '#d83a3a' },
    { id: 'orange', label: 'Orange', hex: '#ff7a1a' },
    { id: 'yellow', label: 'Yellow', hex: '#f4c534' },
    { id: 'green',  label: 'Green',  hex: '#1ea561' },
    { id: 'teal',   label: 'Teal',   hex: '#14b8a6' },
    { id: 'blue',   label: 'Blue',   hex: '#1e6fdb' },
    { id: 'navy',   label: 'Navy',   hex: '#172a55' },
    { id: 'purple', label: 'Purple', hex: '#7b3ff2' },
    { id: 'pink',   label: 'Pink',   hex: '#ee5a9b' },
    { id: 'gold',   label: 'Gold',   hex: '#c9a44b' },
    { id: 'silver', label: 'Silver', hex: '#c2c8cf' },
  ];

  // Multipliers
  const QUALITY_MULT = { draft: 0.85, standard: 1.0, fine: 1.35, ultra: 1.8 };
  const FINISH_MULT  = { raw: 1.0, sanded: 1.15, primed: 1.3, painted: 1.8 };
  const SPEED_FEE    = { standard: 0, express: 18, priority: 42 };
  const SHIP_BASE    = { US: 9, CA: 14, GB: 14, EU: 16, AU: 22, JP: 22, OTHER: 28 };
  const BASE_FEE     = 6.50;  // Setup + cleaning fee per order

  let state = {
    process: 'fdm',
    materialId: 'pla',
    colorId: 'black',
    bboxMm: null, // [w, h, d]
    sourceHeight: null,
    step: 1,
    provider: 'mollie',
    providersAvailable: ['mollie'],
  };

  // ── Helpers ────────────────────────────────────────────────────────
  function getMaterial() {
    const list = MATERIALS[state.process] || MATERIALS.fdm;
    return list.find(m => m.id === state.materialId) || list[0];
  }

  function getColor() {
    return COLORS.find(c => c.id === state.colorId) || COLORS[0];
  }

  function renderMaterials() {
    const list = MATERIALS[state.process] || MATERIALS.fdm;
    matSelect.innerHTML = list.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
    // Reset to first item if current selection isn't in new list
    if (!list.find(m => m.id === state.materialId)) {
      state.materialId = list[0].id;
    }
    matSelect.value = state.materialId;
    matHint.textContent = getMaterial().hint;

    // Resin doesn't use infill — hide field
    if (infillField) infillField.style.display = state.process === 'resin' ? 'none' : '';
  }

  function renderSwatches() {
    swatchBox.innerHTML = COLORS.map(c => `
      <button type="button" class="timrx-order__swatch${c.id === state.colorId ? ' is-active' : ''}"
              data-color="${c.id}" style="--swatch-color:${c.hex};"
              role="radio" aria-checked="${c.id === state.colorId}" aria-label="${c.label}">
        <span class="timrx-order__swatch-label">${c.label}</span>
      </button>
    `).join('');
  }

  function setRangeFill() {
    const min = parseFloat(infillEl.min) || 0;
    const max = parseFloat(infillEl.max) || 100;
    const val = parseFloat(infillEl.value) || 0;
    const pct = ((val - min) / (max - min)) * 100;
    infillEl.style.setProperty('--range-pct', pct.toFixed(1) + '%');
    infillVal.textContent = `${val}%`;
  }

  function getScaledDims() {
    if (!state.bboxMm) return null;
    const targetH = parseFloat(heightEl.value);
    const sourceH = state.bboxMm[1];
    if (!(targetH > 0) || !(sourceH > 0)) return state.bboxMm.slice();
    const ratio = targetH / sourceH;
    return [state.bboxMm[0] * ratio, targetH, state.bboxMm[2] * ratio];
  }

  function updateScaledHint() {
    if (!state.bboxMm) {
      scaledHint.textContent = 'Open a model with a completed print check to auto-fill original dimensions.';
      return;
    }
    const dims = getScaledDims();
    if (!dims) return;
    scaledHint.textContent =
      `Scaled to ${dims[0].toFixed(0)} × ${dims[1].toFixed(0)} × ${dims[2].toFixed(0)} mm` +
      ` (original ${state.bboxMm[0].toFixed(0)} × ${state.bboxMm[1].toFixed(0)} × ${state.bboxMm[2].toFixed(0)} mm).`;
  }

  // Crude but defensible price model: volume × infill × density × $/kg × multipliers.
  function computeEstimate() {
    const dims = getScaledDims();
    let weightG = 0;
    let timeMin = 0;
    if (dims) {
      // Bounding box volume in cm³
      const volCm3 = (dims[0] * dims[1] * dims[2]) / 1000;
      // Rough "object fraction" — printed object is usually 25-40% of its bbox.
      const objectFraction = 0.32;
      const mat = getMaterial();
      const infillPct = state.process === 'resin' ? 100 : (parseFloat(infillEl.value) || 20);
      // For FDM: walls ~3 perimeters ≈ 30% solid, rest is infill of inner volume.
      const effectiveSolidFraction =
        state.process === 'resin'
          ? 1.0
          : 0.30 + (1 - 0.30) * (infillPct / 100);
      const solidVolCm3 = volCm3 * objectFraction * effectiveSolidFraction;
      weightG = solidVolCm3 * mat.density; // density g/cm³
      // Print time heuristic: ~1.6 minutes/g FDM standard; resin ~0.8 min/g for std
      const baseMinPerG = state.process === 'resin' ? 0.85 : 1.6;
      timeMin = weightG * baseMinPerG * (QUALITY_MULT[qualitySel.value] || 1);
    }

    const mat = getMaterial();
    const materialCost = (weightG / 1000) * mat.ratePerKg;
    const qualityMult = QUALITY_MULT[qualitySel.value] || 1;
    const finishMult  = FINISH_MULT[finishSel.value] || 1;
    const qty = Math.max(1, Math.min(100, parseInt(qtyEl.value) || 1));

    // Per-unit subtotal: base + material × quality × finish
    const perUnit = BASE_FEE + (materialCost * qualityMult * finishMult);
    // Quantity discount: -3% per extra unit, capped at 25%
    const qtyDiscount = Math.min(0.25, Math.max(0, (qty - 1) * 0.03));
    const subtotal = perUnit * qty * (1 - qtyDiscount);

    // Shipping
    const shipBase = SHIP_BASE[countrySel.value] ?? SHIP_BASE.OTHER;
    const shipFee  = shipBase + (SPEED_FEE[speedSel.value] || 0);

    const total = subtotal + shipFee;

    return {
      weightG: weightG * qty,
      timeMin: timeMin * qty,
      perUnit,
      subtotal,
      shipFee,
      qty,
      total,
      materialLabel: mat.label,
      qtyDiscount,
    };
  }

  // Convert a USD amount to the order currency for display only.
  // (Backend will recompute & charge the authoritative price.)
  function displayPrice(usdAmount) {
    const cur = currencyFor(countrySel.value);
    const fx = fxFromUsd(cur);
    return `${currencySymbol(cur)}${(usdAmount * fx).toFixed(2)}`;
  }

  function formatPrice(n) {
    return displayPrice(n);
  }

  function formatTime(min) {
    if (!(min > 0)) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h <= 0) return `${m} min`;
    if (m === 0) return `${h} h`;
    return `${h} h ${m} min`;
  }

  function refreshEstimate() {
    const e = computeEstimate();
    estMaterial.textContent = e.weightG > 0 ? `${e.weightG.toFixed(0)} g` : '— g';
    estTime.textContent     = formatTime(e.timeMin);
    estTotal.textContent    = formatPrice(e.total);
  }

  // ── Step navigation ────────────────────────────────────────────────
  function setStep(n) {
    state.step = n;
    panel.querySelectorAll('.timrx-order__step-pane').forEach(pane => {
      pane.classList.toggle('is-active', pane.dataset.pane === String(n));
    });
    if (stepsBox) {
      stepsBox.querySelectorAll('.timrx-order__step').forEach(el => {
        const stepNum = parseInt(el.dataset.step, 10);
        el.classList.toggle('is-active', stepNum === n);
        el.classList.toggle('is-done', stepNum < n);
      });
    }

    if (n === 1) {
      backBtn.disabled = true;
      nextBtn.textContent = 'Continue to shipping';
      nextBtn.disabled = false;
    } else if (n === 2) {
      backBtn.disabled = false;
      nextBtn.textContent = 'Review order';
      nextBtn.disabled = false;
    } else if (n === 3) {
      backBtn.disabled = false;
      nextBtn.textContent = 'Place order';
      nextBtn.disabled = !consentEl.checked;
      renderReview();
    }
  }

  function renderReview() {
    const e = computeEstimate();
    const dims = getScaledDims();
    const sizeStr = dims
      ? `${dims[0].toFixed(0)} × ${dims[1].toFixed(0)} × ${dims[2].toFixed(0)} mm`
      : `${heightEl.value} mm height (uniform scale)`;
    const color = getColor();
    const qualityLabel = qualitySel.options[qualitySel.selectedIndex]?.text || qualitySel.value;
    const finishLabel  = finishSel.options[finishSel.selectedIndex]?.text || finishSel.value;
    const speedLabel   = speedSel.options[speedSel.selectedIndex]?.text || speedSel.value;
    const countryLabel = countrySel.options[countrySel.selectedIndex]?.text || countrySel.value;
    const reviewItem   = resolveActivePrintItem();
    const modelName    = (reviewItem?.title || reviewItem?.prompt || 'Untitled model').toString().slice(0, 80);
    const infillStr    = state.process === 'resin' ? '100% (resin)' : `${infillEl.value}%`;
    const shipTo       = [
      escapeHtml(document.getElementById('timrxShipFirst').value || ''),
      escapeHtml(document.getElementById('timrxShipLast').value || ''),
    ].filter(Boolean).join(' ');
    const addr = escapeHtml(document.getElementById('timrxShipAddress').value || '');
    const city = escapeHtml(document.getElementById('timrxShipCity').value || '');
    const postal = escapeHtml(document.getElementById('timrxShipPostal').value || '');
    const email = escapeHtml(document.getElementById('timrxShipEmail').value || '—');

    reviewBox.innerHTML = `
      <div class="timrx-order__review-section">
        <p class="timrx-order__review-title">Model</p>
        <div class="timrx-order__review-row"><dt>Source</dt><dd>${escapeHtml(modelName)}</dd></div>
        <div class="timrx-order__review-row"><dt>Size</dt><dd>${sizeStr}</dd></div>
      </div>
      <div class="timrx-order__review-section">
        <p class="timrx-order__review-title">Print specification</p>
        <div class="timrx-order__review-row"><dt>Process</dt><dd>${state.process === 'fdm' ? 'FDM (filament)' : 'Resin (SLA)'}</dd></div>
        <div class="timrx-order__review-row"><dt>Material</dt><dd>${escapeHtml(e.materialLabel)}</dd></div>
        <div class="timrx-order__review-row"><dt>Color</dt><dd>${escapeHtml(color.label)}</dd></div>
        <div class="timrx-order__review-row"><dt>Quality</dt><dd>${escapeHtml(qualityLabel)}</dd></div>
        <div class="timrx-order__review-row"><dt>Infill</dt><dd>${infillStr}</dd></div>
        <div class="timrx-order__review-row"><dt>Finish</dt><dd>${escapeHtml(finishLabel)}</dd></div>
        <div class="timrx-order__review-row"><dt>Quantity</dt><dd>${e.qty}${e.qtyDiscount > 0 ? ` (−${(e.qtyDiscount * 100).toFixed(0)}% bulk)` : ''}</dd></div>
      </div>
      <div class="timrx-order__review-section">
        <p class="timrx-order__review-title">Shipping</p>
        <div class="timrx-order__review-row"><dt>Recipient</dt><dd>${shipTo || '—'}</dd></div>
        <div class="timrx-order__review-row"><dt>Address</dt><dd>${[addr, city, postal].filter(Boolean).join(', ') || '—'}</dd></div>
        <div class="timrx-order__review-row"><dt>Country</dt><dd>${escapeHtml(countryLabel)}</dd></div>
        <div class="timrx-order__review-row"><dt>Speed</dt><dd>${escapeHtml(speedLabel)}</dd></div>
        <div class="timrx-order__review-row"><dt>Email</dt><dd>${email}</dd></div>
      </div>
      <div class="timrx-order__review-section">
        <p class="timrx-order__review-title">Estimate</p>
        <div class="timrx-order__review-row"><dt>Print subtotal</dt><dd>${formatPrice(e.subtotal)}</dd></div>
        <div class="timrx-order__review-row"><dt>Shipping</dt><dd>${formatPrice(e.shipFee)}</dd></div>
        <div class="timrx-order__review-row"><dt>Estimated total</dt><dd>${formatPrice(e.total)}</dd></div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }

  function validateShipping() {
    const required = ['timrxShipFirst','timrxShipLast','timrxShipEmail','timrxShipAddress','timrxShipCity','timrxShipPostal'];
    for (const id of required) {
      const el = document.getElementById(id);
      if (!el) continue;
      const v = (el.value || '').trim();
      if (!v) {
        el.focus();
        if (window.showToast) window.showToast('Please complete all required shipping fields.', 'error');
        return false;
      }
      if (id === 'timrxShipEmail' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        el.focus();
        if (window.showToast) window.showToast('Please enter a valid email address.', 'error');
        return false;
      }
    }
    return true;
  }

  // ── Open / close ───────────────────────────────────────────────────
  function openModal() {
    // Close the underlying print panel so the two don't stack visually
    document.getElementById('viewerPrintPanel')?.classList.remove('is-visible');
    document.getElementById('viewerPrintBackdrop')?.classList.remove('is-visible');
    document.body.classList.remove('print-panel-open');

    const item = resolveActivePrintItem();

    // Try to grab dimensions from the print analysis if a check has been run
    const dimsText = document.querySelectorAll('#printDimensionsDisplay .print-prep-dim-value');
    if (dimsText && dimsText.length === 3) {
      const parsed = [...dimsText].map(el => parseFloat(el.textContent));
      if (parsed.every(n => Number.isFinite(n) && n > 0)) {
        state.bboxMm = parsed;
        state.sourceHeight = parsed[1];
        // Pre-fill target height with source height if smaller than 200mm, else 150mm.
        heightEl.value = parsed[1] < 200 ? Math.round(parsed[1]) : 150;
      }
    }

    // Model thumb + name
    const thumb = document.getElementById('timrxOrderThumb');
    const nameEl = document.getElementById('timrxOrderModelName');
    const dimsEl = document.getElementById('timrxOrderModelDims');
    const thumbUrl = item?.thumbnail_url || item?.image_url || '';
    if (thumb) {
      thumb.innerHTML = thumbUrl
        ? `<img src="${escapeHtml(thumbUrl)}" alt="Model preview" loading="lazy">`
        : `<div class="timrx-order__thumb-placeholder">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>
             <span>3D model</span>
           </div>`;
    }
    if (nameEl) {
      const title = (item?.title || item?.prompt || 'Untitled model').toString();
      nameEl.textContent = title.length > 60 ? title.slice(0, 60) + '…' : title;
    }
    if (dimsEl) {
      dimsEl.textContent = state.bboxMm
        ? `${state.bboxMm[0].toFixed(0)} × ${state.bboxMm[1].toFixed(0)} × ${state.bboxMm[2].toFixed(0)} mm original`
        : 'Dimensions pending — run a Print Check first for accurate sizing.';
    }

    // Reset step to 1 + success/footer
    panel.querySelector('.timrx-order__step-pane[data-pane="success"]')?.classList.remove('is-active');
    if (footer) footer.style.display = '';
    setStep(1);
    panel.setAttribute('aria-hidden', 'false');
    backdrop.classList.add('is-visible');
    panel.classList.add('is-visible');
    document.body.classList.add('timrx-order-open');
    updateScaledHint();
    refreshEstimate();
  }

  function closeModal() {
    panel.classList.remove('is-visible');
    backdrop.classList.remove('is-visible');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('timrx-order-open');
  }

  function buildShippingPayload() {
    return {
      first_name: document.getElementById('timrxShipFirst').value.trim(),
      last_name:  document.getElementById('timrxShipLast').value.trim(),
      email:      document.getElementById('timrxShipEmail').value.trim(),
      address:    document.getElementById('timrxShipAddress').value.trim(),
      city:       document.getElementById('timrxShipCity').value.trim(),
      postal:     document.getElementById('timrxShipPostal').value.trim(),
      country:    countrySel.value,
      speed:      speedSel.value,
      notes:      document.getElementById('timrxOrderNotes').value.trim(),
    };
  }

  function buildSpecPayload() {
    const dims = getScaledDims();
    return {
      process: state.process,
      material: state.materialId,
      color: state.colorId,
      quality: qualitySel.value,
      finish: finishSel.value,
      infill_pct: state.process === 'resin' ? 100 : parseInt(infillEl.value, 10),
      quantity: Math.max(1, Math.min(100, parseInt(qtyEl.value, 10) || 1)),
      target_height_mm: parseFloat(heightEl.value) || null,
      scaled_dimensions_mm: dims || null,
    };
  }

  function buildModelPayload() {
    const item = resolveActivePrintItem();
    return {
      id:        item?.id || item?.model_id || null,
      name:      item?.title || item?.prompt || null,
      glb_url:   item?.glb_url || item?.glb_proxy || null,
      thumb_url: item?.thumbnail_url || item?.image_url || null,
    };
  }

  async function refreshProvidersAvailable() {
    if (typeof apiFetch !== 'function') return;
    try {
      const res = await apiFetch('/api/print-orders/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec: buildSpecPayload(),
          shipping: { country: countrySel.value, speed: speedSel.value },
        }),
      });
      if (res?.ok && res.data?.providers_available) {
        state.providersAvailable = res.data.providers_available;
        const paypalBtn = document.getElementById('timrxPayPayPal');
        if (paypalBtn) {
          paypalBtn.hidden = !state.providersAvailable.includes('paypal');
        }
        // If selected provider is no longer available, fall back to first available.
        if (!state.providersAvailable.includes(state.provider)) {
          state.provider = state.providersAvailable[0] || 'mollie';
          syncProviderUi();
        }
      }
    } catch (_) { /* ignore — picker stays default */ }
  }

  function syncProviderUi() {
    panel.querySelectorAll('.timrx-order__pay-btn').forEach(btn => {
      const active = btn.dataset.provider === state.provider;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  async function submitOrder() {
    const payload = {
      provider: state.provider,
      spec:     buildSpecPayload(),
      shipping: buildShippingPayload(),
      model:    buildModelPayload(),
    };

    if (typeof apiFetch !== 'function') {
      if (window.showToast) window.showToast('Network is not ready — please try again.', 'error');
      throw new Error('apiFetch not available');
    }

    const res = await apiFetch('/api/print-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const code = res.data?.error?.code;
      if (res.status === 401 || code === 'UNAUTHORIZED') {
        if (window.showToast) window.showToast('Please sign in to place an order.', 'error');
        // Open auth modal if exposed by the app shell
        try { window.dispatchEvent(new CustomEvent('auth:open')); } catch (_) {}
        return;
      }
      if (code === 'EMAIL_NOT_VERIFIED') {
        if (window.showToast) window.showToast('Verify your email first, then try again.', 'error');
        return;
      }
      const msg = res.data?.error?.message || res.error || 'Could not create order';
      if (window.showToast) window.showToast(msg, 'error');
      return;
    }

    // Remember the pending order so we can show success on redirect back.
    try {
      localStorage.setItem('timrx_pending_print_order', JSON.stringify({
        order_number: res.data.order_number,
        total: res.data.total,
        currency: res.data.currency,
        provider: res.data.provider,
        shipping_email: payload.shipping.email,
        created_at: new Date().toISOString(),
      }));
    } catch (_) { /* ignore */ }

    // Hop the user off to the provider checkout. The webhook completes the order
    // server-side; the redirect just brings them back to /3dprint?print_order=...
    window.location.href = res.data.checkout_url;
  }

  // ── Redirect-back handler ────────────────────────────────────────
  function handlePrintOrderReturn() {
    try {
      const params = new URLSearchParams(window.location.search);
      const orderNum = params.get('print_order');
      const cancelled = params.get('cancelled') === '1';
      if (!orderNum) return;

      // Clean the URL so a refresh doesn't re-trigger
      params.delete('print_order');
      params.delete('cancelled');
      const newQs = params.toString();
      window.history.replaceState({}, '',
        window.location.pathname + (newQs ? '?' + newQs : '') + window.location.hash);

      if (cancelled) {
        if (window.showToast) window.showToast('Order payment was cancelled. You can try again any time.', 'info');
        return;
      }

      // Poll briefly for paid status (webhook may take a couple seconds)
      const startedAt = Date.now();
      const maxMs = 10000;
      const tick = async () => {
        if (typeof apiFetch !== 'function') return;
        try {
          const res = await apiFetch('/api/print-orders/' + encodeURIComponent(orderNum));
          if (res.ok && res.data?.order) {
            const order = res.data.order;
            if (order.status === 'paid') {
              if (window.showToast) {
                window.showToast(`Order ${order.order_number} confirmed — check your email for the receipt.`, 'success');
              }
              try { localStorage.removeItem('timrx_pending_print_order'); } catch (_) {}
              return;
            }
            if (order.status === 'failed' || order.status === 'cancelled') {
              if (window.showToast) window.showToast('Payment was not completed.', 'error');
              return;
            }
          }
        } catch (_) { /* keep polling */ }
        if (Date.now() - startedAt < maxMs) setTimeout(tick, 1500);
        else if (window.showToast) {
          window.showToast(`Order ${orderNum} received — confirmation will arrive shortly by email.`, 'info');
        }
      };
      tick();
    } catch (e) {
      console.warn('[Print order] return-handler error:', e);
    }
  }

  // ── Wire events ───────────────────────────────────────────────────
  openBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Block ordering only when no model is recoverable from any source —
    // active history id, model version stack (the viewer's source of
    // truth), or the first printable item in history. See
    // `resolveActivePrintItem` above for the full chain.
    const item = resolveActivePrintItem();
    const hasId  = !!(item && (item.id || item.model_id));
    const hasGlb = !!(item && (item.glb_url || item.glb_proxy));
    if (!hasId || !hasGlb) {
      if (window.showToast) {
        window.showToast(
          'Open a completed model from your History first — TimrX needs a finished GLB to print.',
          'info'
        );
      } else {
        alert('Open a completed model from your History first — TimrX needs a finished GLB to print.');
      }
      return;
    }

    openModal();
  });

  closeBtn?.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('is-visible')) closeModal();
  });

  // Process toggle
  panel.querySelectorAll('.timrx-order__toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.process;
      if (p === state.process) return;
      state.process = p;
      panel.querySelectorAll('.timrx-order__toggle-btn').forEach(b => {
        const active = b.dataset.process === p;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      renderMaterials();
      refreshEstimate();
    });
  });

  matSelect.addEventListener('change', () => {
    state.materialId = matSelect.value;
    matHint.textContent = getMaterial().hint;
    refreshEstimate();
  });

  swatchBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.timrx-order__swatch');
    if (!btn) return;
    state.colorId = btn.dataset.color;
    swatchBox.querySelectorAll('.timrx-order__swatch').forEach(s => {
      const active = s.dataset.color === state.colorId;
      s.classList.toggle('is-active', active);
      s.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  });

  infillEl.addEventListener('input', () => {
    setRangeFill();
    refreshEstimate();
  });

  qualitySel.addEventListener('change', refreshEstimate);
  finishSel.addEventListener('change', refreshEstimate);

  heightEl.addEventListener('input', () => {
    panel.querySelectorAll('.timrx-order__preset').forEach(p => {
      p.classList.toggle('is-active', p.dataset.size === heightEl.value);
    });
    updateScaledHint();
    refreshEstimate();
  });

  panel.querySelectorAll('.timrx-order__preset').forEach(p => {
    p.addEventListener('click', () => {
      heightEl.value = p.dataset.size;
      heightEl.dispatchEvent(new Event('input'));
    });
  });

  // Quantity stepper
  panel.querySelectorAll('.timrx-order__qty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const delta = parseInt(btn.dataset.qty, 10);
      const cur = parseInt(qtyEl.value, 10) || 1;
      qtyEl.value = Math.max(1, Math.min(100, cur + delta));
      refreshEstimate();
    });
  });
  qtyEl.addEventListener('input', refreshEstimate);

  countrySel.addEventListener('change', refreshEstimate);
  speedSel.addEventListener('change', refreshEstimate);

  consentEl?.addEventListener('change', () => {
    if (state.step === 3) nextBtn.disabled = !consentEl.checked;
  });

  // Navigation
  nextBtn.addEventListener('click', async () => {
    if (state.step === 1) {
      setStep(2);
    } else if (state.step === 2) {
      if (!validateShipping()) return;
      setStep(3);
      refreshProvidersAvailable();
    } else if (state.step === 3) {
      if (!consentEl.checked) return;
      nextBtn.disabled = true;
      nextBtn.textContent = 'Placing order…';
      try {
        await submitOrder();
      } finally {
        nextBtn.disabled = false;
      }
    }
  });

  backBtn.addEventListener('click', () => {
    if (state.step > 1) setStep(state.step - 1);
  });

  doneBtn?.addEventListener('click', closeModal);

  // Payment-method picker
  panel.querySelectorAll('.timrx-order__pay-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.provider = btn.dataset.provider || 'mollie';
      syncProviderUi();
    });
  });

  // Initial render
  renderMaterials();
  renderSwatches();
  setRangeFill();
  refreshEstimate();
  syncProviderUi();

  // Handle return from payment-provider checkout (mollie/paypal redirect)
  handlePrintOrderReturn();
}

// ============================================================================
// MAIN UI INITIALIZATION
// ============================================================================

function initUi() {
  // Initialize tab references
  UI.initTabRefs();

  // DOM lookups
  imageDrop = byId('imageDrop');
  imageInput = byId('imageUpload');
  imagePreview = byId('imagePreview');
  imageModelName = byId('imageModelName');

  genHint = byId('genHint');

  // Set initial tab
  UI.setActiveTab('text3d');

  // Image drop zone
  safe(imageDrop, () => {
    const hl = (on) => imageDrop.classList.toggle('dragover', !!on);
    ['dragenter', 'dragover'].forEach(evt =>
      imageDrop.addEventListener(evt, e => { e.preventDefault(); hl(true); })
    );
    ['dragleave', 'drop'].forEach(evt =>
      imageDrop.addEventListener(evt, e => { e.preventDefault(); hl(false); })
    );
    imageDrop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files?.[0];
      if (f) handleImageFile(f);
    });
    imageDrop.addEventListener('click', () => imageInput?.click());
    imageDrop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') imageInput?.click();
    });
  });

  safe(imageInput, () => {
    imageInput.addEventListener('change', () => {
      const f = imageInput.files?.[0];
      if (f) handleImageFile(f);
    });
  });

  // Upload modal + model drop zone — handled entirely by 3dprint-app.js

  // Enter key triggers Generate from prompt textareas
  const promptTextareas = ['modelPrompt', 'imagePrompt', 'texturePrompt', 'videoMotion'];
  promptTextareas.forEach(id => {
    const textarea = byId(id);
    if (textarea) {
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.repeat) {
          e.preventDefault();
          const genBtn = document.querySelector('button[id*="generate"]:not([disabled])');
          if (genBtn) API.onGenerateClick();
        }
      });
    }
  });

  // Global Enter key handler for focused buttons
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.repeat) return;
    const focused = document.activeElement;
    if (focused && focused.tagName === 'BUTTON' && !focused.disabled) {
      const inTextarea = document.activeElement?.tagName === 'TEXTAREA';
      if (!inTextarea) {
        e.preventDefault();
        focused.click();
        log('Enter key triggered button:', focused.id || focused.textContent?.trim().substring(0, 20));
      }
    }
  });

  // ESC to close modal — handled by 3dprint-app.js

  // Migrate history data (one-time, skips if already done)
  try {
    if (!localStorage.getItem('timrx_history_titles_migrated')) {
      migrateHistoryTitles();
      localStorage.setItem('timrx_history_titles_migrated', '1');
    }
    if (!localStorage.getItem('timrx_history_dates_migrated')) {
      migrateHistoryDates();
      localStorage.setItem('timrx_history_dates_migrated', '1');
    }
  } catch (_) { /* Safari: localStorage may be blocked */ }

  // Initialize custom selects
  UI.initNiceSelects();

  UI.updateGenerateHint();
}

// ============================================================================
// HISTORY GALLERY WIRING
// ============================================================================

function wireGallery() {
  const grid = document.getElementById('historyGrid');
  const q = document.getElementById('historySearch');
  const size = document.getElementById('historyPageSize');
  const prev = document.getElementById('historyPrev');
  const next = document.getElementById('historyNext');
  const first = document.getElementById('historyFirst');
  const last = document.getElementById('historyLast');

  // Search input
  if (q) {
    q.addEventListener('input', e => {
      State.historyState.query = e.target.value.trim().toLowerCase();
      State.historyState.page = 1;
      renderHistory();
    });
  }

  // Page size select
  if (size) {
    size.addEventListener('change', (e) => {
      const nextSize = Math.max(1, parseInt(e.target.value, 10) || 9);
      State.historyState.pageSize = nextSize;
      State.historyState.page = 1;
      renderHistory();
    });
  }

  // Filter buttons
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      closeActiveHistoryMenu();
      const filterType = btn.getAttribute('data-filter');
      if (filterType === 'all') {
        State.historyState.galleryExpanded = State.historyState.filter === 'all'
          ? !State.historyState.galleryExpanded
          : true;
        State.historyState.filter = 'all';
      } else {
        State.historyState.galleryExpanded = false;
        State.historyState.filter = filterType;
      }
      State.historyState.page = 1;
      renderHistory();
      // If a media tab hasn't fetched its own data yet, load it from DB
      // then re-render to replace the skeleton with actual content.
      if (filterType !== 'all' && !State.historyTabLoaded()) {
        State.loadHistoryTab(filterType).then(() => renderHistory());
      }
    });
  });

  // Sort toggle
  const sortToggle = document.getElementById('historySortToggle');
  if (sortToggle) {
    sortToggle.addEventListener('click', () => {
      State.historyState.sort = State.historyState.sort === 'desc' ? 'asc' : 'desc';
      renderHistory();
    });
  }

  // Collapse button
  const collapseBtn = document.getElementById('historyCollapseView');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      closeActiveHistoryMenu();
      State.historyState.galleryExpanded = false;
      State.historyState.page = 1;
      renderHistory();
    });
  }

  // Refresh/Restore from DB button
  const refreshBtn = document.getElementById('historyRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      if (refreshBtn.classList.contains('is-loading')) return;
      refreshBtn.classList.add('is-loading');
      try {
        await State.forceRestoreFromDB();
        State.historyState.page = 1;
        renderHistory();
        // Show success state briefly
        refreshBtn.classList.remove('is-loading');
        refreshBtn.classList.add('is-success');
        setTimeout(() => refreshBtn.classList.remove('is-success'), 1500);
      } catch (err) {
        console.error('Failed to restore history:', err);
        alert('Failed to restore history from database. Please try again.');
        refreshBtn.classList.remove('is-loading');
      }
    });
  }

  // Pagination — scroll history grid to top after page change
  function scrollHistoryToTop() {
    const panel = document.getElementById('ws-right-panel');
    if (panel) panel.scrollTop = 0;
    const gridEl = document.getElementById('historyGrid');
    if (gridEl) gridEl.scrollTop = 0;
  }

  if (first) first.addEventListener('click', () => {
    if (State.historyState.page > 1) {
      State.historyState.page = 1;
      renderHistory();
      scrollHistoryToTop();
    }
  });
  if (prev) prev.addEventListener('click', () => {
    if (State.historyState.page > 1) {
      State.historyState.page--;
      renderHistory();
      scrollHistoryToTop();
    }
  });
  if (next) next.addEventListener('click', async () => {
    const filter = State.historyState.filter;
    // Use the page count from the last render — this accounts for lineage
    // grouping (all/model tabs) vs flat item count (image/video tabs).
    const totalPages = State.historyState._renderedTotalPages || 1;
    const hasMore = State.historyHasMore();
    const tabLoaded = State.historyTabLoaded();

    log(`[Pagination] NEXT: filter=${filter} page=${State.historyState.page}/${totalPages}${hasMore ? '+' : ''} tabLoaded=${tabLoaded}`);

    if (State.historyState.page < totalPages) {
      // More cached pages available — navigate locally
      State.historyState.page++;
      renderHistory();
      scrollHistoryToTop();
    } else if (hasMore || !tabLoaded) {
      // On last cached page — try to fetch more from DB.
      next.setAttribute('disabled', '');
      next.classList.add('loading');

      let lastAddedCount = 0;
      let newTotalPages = totalPages;
      const maxFetchPasses = (filter === 'model' || filter === 'all') ? 4 : 2;

      for (let pass = 0; pass < maxFetchPasses; pass++) {
        let added = [];
        if (State.historyTabLoaded()) {
          added = await State.loadMoreHistory();
        } else {
          const tabItems = await State.loadHistoryTab(filter);
          added = tabItems || [];
        }
        lastAddedCount = added.length;

        // Re-render after each fetch so lineage grouping can recalculate the
        // true visible page count before deciding whether we can advance.
        renderHistory();
        newTotalPages = State.historyState._renderedTotalPages || 1;

        if (State.historyState.page < newTotalPages) {
          State.historyState.page++;
          renderHistory();
          break;
        }

        if (!State.historyHasMore() || added.length === 0) {
          break;
        }
      }

      next.classList.remove('loading');
      next.removeAttribute('disabled');

      log(`[Pagination] After load: filter=${filter} page=${State.historyState.page}/${newTotalPages}${State.historyHasMore() ? '+' : ''} added=${lastAddedCount}`);
      scrollHistoryToTop();
    }
    // else: no more data, button should already be disabled by renderHistory
  });
  if (last) last.addEventListener('click', () => {
    const totalPages = State.historyState._renderedTotalPages || 1;
    if (State.historyState.page < totalPages) {
      State.historyState.page = totalPages;
      renderHistory();
      scrollHistoryToTop();
    }
  });

  // Grid event delegation
  if (grid) {
    grid.addEventListener('click', async (e) => {
      // Toggle collection expansion
      const toggleBtn = e.target.closest('[data-action="toggle-collection"]');
      if (toggleBtn) {
        const collection = toggleBtn.closest('.history-collection');
        if (collection) {
          const isExpanded = collection.classList.toggle('is-expanded');
          toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
          // Lazy-render: inflate hidden thumbs from <template> on first expand
          if (isExpanded) {
            const tmpl = collection.querySelector('template.history-collection__thumbs-lazy');
            if (tmpl) {
              const extra = document.createElement('div');
              extra.className = 'history-collection__thumbs-extra';
              extra.innerHTML = tmpl.innerHTML;
              tmpl.replaceWith(extra);
            }
          }
        }
        e.stopPropagation();
        return;
      }

      // Gallery expanded view filter — uses infinite scroll batching
      const galleryFilterBtn = e.target.closest('[data-gallery-filter]');
      if (galleryFilterBtn) {
        const filterType = galleryFilterBtn.getAttribute('data-gallery-filter');
        const bar = galleryFilterBtn.closest('.expanded-filter-bar');
        if (bar) bar.querySelectorAll('.expanded-filter-btn').forEach(b => b.classList.toggle('active', b === galleryFilterBtn));
        // Reset infinite scroll with the selected filter
        resetGalleryInfiniteScroll(filterType);
        // Scroll to top of grid smoothly
        const section = grid.querySelector('.expanded-section');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      // Menu toggle
      const menuBtn = e.target.closest('[data-history-menu]');
      if (menuBtn) {
        const menu = menuBtn.nextElementSibling?.classList?.contains('card-menu')
          ? menuBtn.nextElementSibling
          : menuBtn.parentElement?.querySelector('.card-menu');
        if (!menu) return;
        const isOpen = menuBtn.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
          closeActiveHistoryMenu();
        } else {
          openHistoryMenu(menuBtn, menu);
        }
        e.stopPropagation();
        return;
      }

      // Submenu toggle
      const submenuBtn = e.target.closest('[data-submenu-open]');
      if (submenuBtn) {
        const targetId = submenuBtn.getAttribute('data-submenu-open');
        if (!targetId) return;
        const panel = document.querySelector(`[data-submenu-panel="${targetId}"]`);
        if (!panel) return;
        const isOpen = submenuBtn.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
          closeActiveHistorySubmenu();
        } else {
          openHistorySubmenu(submenuBtn, panel);
        }
        e.stopPropagation();
        return;
      }

      // Expanded gallery: clicking ANYWHERE on a card opens it in the viewer
      // Delegate to the first data-act button inside the card.
      if (State.historyState.galleryExpanded) {
        const expandedCard = e.target.closest('.expanded-thumb');
        if (expandedCard && !e.target.closest('[data-act]') && !e.target.closest('[data-history-menu]')) {
          const innerBtn = expandedCard.querySelector('[data-act="open"], [data-act="open-video"]');
          if (innerBtn && !innerBtn.disabled) {
            innerBtn.click();
            return;
          }
        }
      }

      // Action buttons
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.disabled) {
        console.warn(`[CardAction] Button is DISABLED: act=${btn.getAttribute('data-act')} id=${btn.getAttribute('data-id')}`);
        return;
      }
      closeActiveHistoryMenu();

      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      console.log(`[CardAction] act=${act} id=${id}`);

      // ── Grouped card actions: handled before item lookup since they use
      //    data-group-id / data-group-ids instead of data-id ──
      if (act === 'open-group') {
        const groupId = btn.getAttribute('data-group-id');
        if (groupId && typeof window.openGroupedViewer === 'function') {
          closeActiveHistoryMenu();
          if (State.historyState.galleryExpanded) {
            State.historyState.galleryExpanded = false;
            renderHistory();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          const model3dViewer = document.getElementById('model3dViewer');
          if (model3dViewer) model3dViewer.classList.remove('hidden');
          const imageViewer = document.getElementById('imageViewer');
          const videoViewer = document.getElementById('videoViewer');
          if (imageViewer) imageViewer.classList.add('hidden');
          if (videoViewer) videoViewer.classList.add('hidden');
          const modelRailBtn = document.querySelector('[data-panel="model"]');
          if (modelRailBtn) modelRailBtn.click();
          if (window.timrx3D?.resize) window.timrx3D.resize();
          requestAnimationFrame(() => {
            let groupItems = getGroupedCardItems(groupId);
            if (!groupItems || !groupItems.length) {
              const allHistory = State.getHistory();
              groupItems = allHistory.filter(i =>
                i.batch_group_id === groupId ||
                i.lineage_origin_id === groupId ||
                i.lineage_root_id === groupId
              );
            }
            if (groupItems && groupItems.length > 0) {
              window.openGroupedViewer(groupId, groupItems);
            }
          });
        }
        return;
      }

      if (act === 'delete-group') {
        const groupIdsStr = btn.getAttribute('data-group-ids') || '';
        const groupIds = groupIdsStr.split(',').filter(Boolean);
        if (!groupIds.length) return;
        closeActiveHistoryMenu();
        if (!confirm(`This will permanently delete all ${groupIds.length} variants in this batch. This action cannot be undone.`)) return;
        let deleted = 0;
        for (const itemId of groupIds) {
          try {
            const result = await apiFetch(`/api/_mod/history/item/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
            if (result.ok || result.status === 404) {
              State.deleteHistoryItem(itemId, { skipRemote: true });
              deleted++;
            }
          } catch (err) {
            console.warn(`[History] Delete group item failed: ${itemId}`, err?.message);
            State.deleteHistoryItem(itemId, { skipRemote: true });
            deleted++;
          }
        }
        if (window.showToast) window.showToast(`Deleted ${deleted} variants.`, 'info');
        renderHistory();
        return;
      }

      // Multi-color print — handled before item lookup since it only
      // needs data-attributes from the button, not the full item object.
      if (act === 'manual-multi-color-print') {
        const sourceItem = State.findHistoryItem(id);
        closeActiveHistoryMenu();
        openMultiColorModal({
          taskId: id,
          title: btn.getAttribute('data-title') || 'Untitled',
          thumbnailUrl: btn.getAttribute('data-thumb') || '',
          glbUrl: btn.getAttribute('data-glb') || '',
          onRepair: sourceItem ? (options) => API.startPrintReadyRemeshFromItem(sourceItem, options) : null,
        });
        return;
      }

      if (act === 'meshy-multi-color-print') {
        closeActiveHistoryMenu();
        openMeshyMultiColorModal({
          taskId: id,
          title: btn.getAttribute('data-title') || 'Untitled',
          thumbnailUrl: btn.getAttribute('data-thumb') || '',
          glbUrl: btn.getAttribute('data-glb') || '',
        });
        return;
      }

      const item = State.findHistoryItem(id);
      if (!item) {
        console.warn(`[CardAction] Item not found in cache: id=${id} act=${act}`);
        return;
      }

      const glbUrl = item.glb_proxy || item.glb_url;

      // Handle actions
      if (act === 'open') {
        const wasGallery = !!State.historyState.galleryExpanded;

        // Close expanded gallery FIRST — remove body class + re-render immediately
        // so the viewer panel becomes visible before we load content into it.
        if (wasGallery) {
          State.historyState.galleryExpanded = false;
          renderHistory();                        // toggles body.history-expanded off
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        // Handle video type
        if (item.type === 'video' || item.video_url) {
          const videoUrl = item.video_url;
          if (videoUrl) {
            State.setHistoryActiveModelId(id);
            _suppressHistoryFilterReset = true;
            const videoRailBtn = document.querySelector('[data-panel="video"]');
            if (videoRailBtn) videoRailBtn.click();
            _suppressHistoryFilterReset = false;
            Viewer.showVideoInViewer(videoUrl, {
              title: shortTitle(item) || 'Video Preview',
              hint: item.prompt || 'Generated video',
              autoplay: true
            });
          }
          return;
        }

        // Handle image type
        if (!glbUrl && (item.type === 'image' || item.image_url)) {
          State.setHistoryActiveModelId(id);
          const imgSrc = item.image_url || item.thumbnail_url || '';
          if (imgSrc) {
            _suppressHistoryFilterReset = true;
            const imageRailBtn = document.querySelector('[data-panel="image"]');
            if (imageRailBtn) imageRailBtn.click();
            _suppressHistoryFilterReset = false;
            Viewer.showImageInViewer(imgSrc);
          }
          if (!wasGallery) renderHistory();
          return;
        }

        if (!glbUrl) return;

        _suppressHistoryFilterReset = true;
        const modelRailBtn = document.querySelector('[data-panel="model"]');
        if (modelRailBtn) modelRailBtn.click();
        _suppressHistoryFilterReset = false;

        const genHintEl = byId('genHint');
        if (genHintEl) genHintEl.textContent = 'Loading model...';
        State.setHistoryActiveModelId(id);

        // Reset version stack for this model and hide action bar
        const loadUrl = item.glb_proxy || getLoadableModelUrl(item.glb_url);
        State.resetModelVersionStack({
          id,
          glb_url: loadUrl,
          thumbnail_url: item.thumbnail_url || '',
          stage: item.stage || 'preview',
          prompt: item.prompt || ''
        });
        const actionBar = byId('viewerActionBar');
        if (actionBar) actionBar.classList.add('hidden');

        const primary = loadUrl;
        const fallback = (item.glb_url && item.glb_url !== primary) ? item.glb_url : null;
        try {
          await Viewer.loadModelWithFallback(primary, fallback);
          if (genHintEl) genHintEl.textContent = 'Loaded from history.';
        } catch (err) {
          console.warn('[History] Failed to load model into viewer:', err);
          if (genHintEl) genHintEl.textContent = 'Failed to load model.';
          if (window.showToast) {
            window.showToast('Model failed to load. Please try again.', 'error');
          }
        }
        return;
      }

      if (act === 'download' || act === 'print') {
        const explicitDownloadUrl = btn.getAttribute('data-download-url') || '';
        const downloadUrl = explicitDownloadUrl || item.glb_url || item.glb_proxy;
        if (!downloadUrl) return;
        const filename = buildItemDownloadFilename(item, {
          type: 'model',
          sourceUrl: downloadUrl,
          extension: inferExtensionFromUrl(downloadUrl) || 'glb',
        });
        startWorkspaceDownload(downloadUrl, filename);
        return;
      }

      if (act === 'download-image') {
        if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
          Credits.showDownloadAccessRequiredMessage('image');
          return;
        }
        const imageUrl = btn.getAttribute('data-image-url') || item.image_url || item.thumbnail_url;
        if (!imageUrl) {
          alert('No image available to download.');
          return;
        }
        const artifactFormat = String(item.artifact_format || item.meta?.artifact_format || item.format || '').toLowerCase();
        const downloadExt = artifactFormat === 'svg'
          ? 'svg'
          : artifactFormat === 'jpg' || artifactFormat === 'jpeg'
            ? 'jpg'
            : artifactFormat === 'webp'
              ? 'webp'
              : inferExtensionFromUrl(imageUrl) || 'png';
        const filename = buildItemDownloadFilename(item, {
          type: 'image',
          sourceUrl: imageUrl,
          extension: downloadExt,
        });
        startWorkspaceDownload(imageUrl, filename);
        return;
      }

      // Video actions
      if (act === 'download-video') {
        if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
          Credits.showDownloadAccessRequiredMessage('video');
          return;
        }
        const videoUrl = btn.getAttribute('data-video-url') || item.video_url;
        if (!videoUrl) {
          alert('No video available to download.');
          return;
        }
        const filename = buildItemDownloadFilename(item, {
          type: 'video',
          sourceUrl: videoUrl,
          extension: inferExtensionFromUrl(videoUrl) || 'mp4',
        });
        startWorkspaceDownload(videoUrl, filename);
        return;
      }

      if (act === 'open-video') {
        // Collapse expanded gallery first (viewer is hidden in expanded mode)
        const wasGalleryV = !!State.historyState.galleryExpanded;
        if (wasGalleryV) {
          State.historyState.galleryExpanded = false;
          renderHistory();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        const videoUrl = btn.getAttribute('data-video-url') || item.video_url;
        if (videoUrl) {
          _suppressHistoryFilterReset = true;
          const videoRailBtn = document.querySelector('[data-panel="video"]');
          if (videoRailBtn) videoRailBtn.click();
          _suppressHistoryFilterReset = false;
          Viewer.showVideoInViewer(videoUrl, {
            title: shortTitle(item) || 'Video Preview',
            hint: item.prompt || 'Generated video',
            autoplay: true
          });
          State.setHistoryActiveModelId(item.id);
          if (!wasGalleryV) renderHistory();
        }
        return;
      }

      if (act === 'copy-video-link') {
        const videoUrl = btn.getAttribute('data-video-url') || item.video_url;
        if (!videoUrl) {
          alert('No video link available.');
          return;
        }
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(videoUrl);
            alert('Video link copied to clipboard.');
          } catch {
            prompt('Copy video link manually:', videoUrl);
          }
        } else {
          prompt('Copy video link manually:', videoUrl);
        }
        return;
      }

      if (act === 'copy-link') {
        const link = item.glb_proxy || item.glb_url || item.image_url;
        if (!link) {
          alert('No downloadable link available yet.');
          return;
        }
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(link);
            alert('Link copied to clipboard.');
          } catch {
            prompt('Copy link manually:', link);
          }
        } else {
          prompt('Copy link manually:', link);
        }
        return;
      }

      if (act === 'share-twitter') {
        const text = item.prompt ? `Check out my creation: "${item.prompt.slice(0, 120)}"` : 'Check out my AI creation on TimrX!';
        const url = 'https://timrx.live/3dprint';
        window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
        return;
      }

      if (act === 'share-facebook') {
        const url = 'https://timrx.live/3dprint';
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank');
        return;
      }

      if (act === 'share-linkedin') {
        const url = 'https://timrx.live/3dprint';
        window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`, '_blank');
        return;
      }

      if (act === 'share-discord') {
        const thumbUrl = item.thumbnail_url || item.image_url || '';
        const prompt = item.prompt || '';
        const assetType = item.video_url ? 'video' : (item.image_url && !item.glb_url ? 'image' : 'model');
        apiFetch('/api/_mod/community/discord-share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: assetType, prompt, thumbnail_url: thumbUrl }),
        }).then(() => {
          alert('Shared to Discord!');
        }).catch(() => {
          alert('Failed to share to Discord.');
        });
        window.open('https://discord.gg/VpqT2UywDG', '_blank');
        return;
      }

      if (act === 'share-community') {
        if (window.CommunityGallery && window.CommunityGallery.openShareModal) {
          window.CommunityGallery.openShareModal(item);
        }
        return;
      }

      if (act === 'share-inspire') {
        const assetType = item.video_url ? 'video' : (item.image_url && !item.glb_url ? 'image' : 'model');
        try {
          const res = await apiFetch('/api/_mod/inspire/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, type: assetType, share: true }),
          });
          if (res.ok) {
            if (window.showToast) window.showToast('Shared to Inspire!', 'success');
          } else {
            if (window.showToast) window.showToast(res.data?.error || 'Failed to share', 'error');
          }
        } catch (err) {
          console.error('[Inspire] share failed:', err);
          if (window.showToast) window.showToast('Failed to share to Inspire', 'error');
        }
        return;
      }

      if (act === 'texture') {
        await API.startTextureFromHistory(item, 'history');
        return;
      }

      if (act === 'remesh') {
        await API.startRemeshFromHistory(item);
        return;
      }

      if (act === 'refine') {
        console.log('[Refine] Dispatching refine for item:', item.id, 'stage:', item.stage, 'preview_task_id:', item.preview_task_id);
        // Close print panel if open so the refine modal isn't hidden behind it
        document.getElementById('viewerPrintPanel')?.classList.remove('is-visible');
        document.getElementById('viewerPrintBackdrop')?.classList.remove('is-visible');
        // Remove any stale refine settings overlay from a prior cancelled flow
        document.getElementById('refineSettingsOverlay')?.remove();
        await API.onPostProcessFromHistory(item, 'refine');
        return;
      }

      if (act === 'image-to-3d') {
        await API.startImageTo3DFromHistory(item);
        return;
      }

      if (act === 'image-to-video') {
        const imageUrl = btn.getAttribute('data-image-url') || item.image_url;
        if (!imageUrl) {
          showErrorToast('No image URL found');
          return;
        }

        // Switch to video panel
        const videoStudioTab = document.querySelector('[data-panel="video"]');
        if (videoStudioTab) videoStudioTab.click();

        // Set mode to image2video
        const videoModeValue = byId('videoModeValue');
        if (videoModeValue) videoModeValue.value = 'image2video';

        // Update mode switcher buttons (both primary and alt)
        document.querySelectorAll('.video-mode-btn').forEach(b => {
          b.classList.toggle('is-active', b.getAttribute('data-mode') === 'image2video');
        });

        // Toggle content cards
        const text2videoContent = byId('text2videoContent');
        const image2videoContent = byId('image2videoContent');
        if (text2videoContent) text2videoContent.classList.add('hidden');
        if (image2videoContent) image2videoContent.classList.remove('hidden');

        // Set duration to 4s (default), quality to standard
        const videoDuration = byId('videoDuration');
        const videoQuality = byId('videoQuality');
        if (videoDuration) {
          videoDuration.value = '4';
          videoDuration.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (videoQuality) {
          videoQuality.value = '720p';
          videoQuality.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Load image into the preview
        const videoImagePreview = byId('videoImagePreview');
        if (videoImagePreview) {
          videoImagePreview.src = imageUrl;
          videoImagePreview.style.display = 'block';
        }

        // Use original prompt as motion hint if available
        const videoMotion = byId('videoMotion');
        if (videoMotion && item.prompt) {
          videoMotion.value = '';
          videoMotion.placeholder = `Motion for: ${item.prompt.slice(0, 50)}...`;
        }

        // Update credits display — Veo image-to-video 4s 720p (equalized with text-to-video)
        const videoCreditsDisplay = byId('videoCreditsDisplay');
        if (videoCreditsDisplay) {
          videoCreditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 48';
        }
        const generateVideoBtn = byId('generateVideoBtn');
        if (generateVideoBtn) {
          generateVideoBtn.title = '48 credits';
          generateVideoBtn.dataset.baseCredits = '48';
          // Enable button since we have a valid image loaded
          generateVideoBtn.disabled = false;
          generateVideoBtn.removeAttribute('data-disabled-reason');
        }
        // Trigger workspace credits update
        if (window.WorkspaceCredits?.updateButtonCosts) {
          window.WorkspaceCredits.updateButtonCosts();
        }

        return;
      }

      if (act === 'retry-job') {
        // Retry a failed Meshy job via the backend retry endpoint
        // This creates a new job with the same parameters and charges credits
        const retryBtn = btn;
        const originalText = retryBtn.textContent;
        retryBtn.textContent = 'Retrying...';
        retryBtn.disabled = true;

        try {
          const res = await apiFetch(`/api/jobs/${encodeURIComponent(id)}/retry`, {
            method: 'POST',
          });

          if (res.ok && res.data?.ok) {
            const newJobId = res.data.new_job_id;
            if (window.showToast) {
              window.showToast(`Retrying generation (${res.data.cost_credits || '?'} credits)...`, 'info');
            }

            // Add the new job as active and start watching it
            State.addActiveJob(newJobId);
            State.addHistoryItem({
              id: newJobId,
              type: item?.type || 'model',
              status: 'generating',
              prompt: item?.prompt || '',
              thumbnail_url: item?.thumbnail_url || '',
              created_at: Date.now(),
              stage: item?.stage || 'preview',
            });

            // Start polling the new job
            if (window.API?.watchJob) {
              window.API.watchJob(newJobId);
            }

            // Refresh history UI
            if (window.renderHistory) window.renderHistory();
          } else {
            const errMsg = res.data?.error?.message || res.error || 'Retry failed';
            if (window.showToast) window.showToast(errMsg, 'error');
            else alert(errMsg);
          }
        } catch (err) {
          console.error('[Retry] Failed:', err);
          if (window.showToast) window.showToast('Retry failed. Please try again.', 'error');
        } finally {
          retryBtn.textContent = originalText;
          retryBtn.disabled = false;
        }
        return;
      }

      if (act === 'retry-video') {
        // Pre-fill video prompt with the original prompt and switch to video tab
        const originalPrompt = btn.getAttribute('data-prompt') || item.prompt || '';
        const videoPromptEl = byId('videoTextPrompt');
        if (videoPromptEl) {
          videoPromptEl.value = originalPrompt;
          // Trigger input event for any listeners
          videoPromptEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Switch to video studio tab
        const videoStudioTab = document.querySelector('[data-panel="video"]');
        if (videoStudioTab) {
          videoStudioTab.click();
        }
        // Focus the prompt input
        videoPromptEl?.focus();
        return;
      }

      if (act === 'delete') {
        // Check if this is a local-only placeholder (generating/processing) —
        // these are keyed by job_id and have no persisted history_items row
        const item = State.findHistoryItem(id);
        const isLocalOnly = item && ['generating', 'refining', 'remeshing',
          'texturing', 'rigging', 'animating'].includes(item.status);

        if (isLocalOnly) {
          // Local placeholder — just remove from state and cancel watcher
          State.removeActiveJob(id);
          State.deleteHistoryItem(id, { skipRemote: true });
          renderHistory();
          return;
        }

        if (!confirm('This will permanently delete this item and all associated files. This action cannot be undone.')) return;
        try {
          const result = await apiFetch(`/api/_mod/history/item/${encodeURIComponent(id)}`, {
            method: 'DELETE'
          });
          if (!result.ok && result.status !== 404) {
            throw new Error(result.error || `HTTP ${result.status}`);
          }
          // Remove from local state even on 404 (item already gone from DB)
          State.deleteHistoryItem(id, { skipRemote: true });
          renderHistory();
        } catch (err) {
          console.warn('[History] Delete failed:', err?.message || err);
          // Still remove locally if server says not found
          if (err?.message?.includes('404')) {
            State.deleteHistoryItem(id, { skipRemote: true });
            renderHistory();
          } else {
            showErrorToast('Delete failed. Please try again.');
          }
        }
        return;
      }
    });

    // Keyboard navigation in grid
    grid.addEventListener('keydown', (evt) => {
      const thumbBtn = evt.target.closest('.history-thumb__image, .history-thumb__preview');
      if (!thumbBtn) return;

      const moveFocus = (direction) => {
        const row = thumbBtn.closest('.history-collection');
        if (!row) return;
        const focusables = Array.from(row.querySelectorAll('.history-thumb__image, .history-thumb__preview'));
        if (!focusables.length) return;
        const currentIdx = focusables.indexOf(thumbBtn);
        if (currentIdx === -1) return;
        let nextIdx = currentIdx + direction;
        if (nextIdx < 0) nextIdx = focusables.length - 1;
        if (nextIdx >= focusables.length) nextIdx = 0;
        focusables[nextIdx]?.focus();
      };

      if (evt.key === 'ArrowRight') {
        evt.preventDefault();
        moveFocus(1);
        return;
      }
      if (evt.key === 'ArrowLeft') {
        evt.preventDefault();
        moveFocus(-1);
        return;
      }
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        thumbBtn.click();
      }
    });
  }

  // Close menus on outside click
  document.addEventListener('click', (evt) => {
    const { submenu: activeSubmenu } = getActiveHistorySubmenu();
    const { menu: activeMenu } = getActiveHistoryMenu();

    if (activeSubmenu) {
      const insideSubmenu = evt.target.closest('.card-submenu');
      const onSubToggle = evt.target.closest('[data-submenu-open]');
      if (!insideSubmenu && !onSubToggle) closeActiveHistorySubmenu();
    }
    if (!activeMenu) return;
    const insideMenu = evt.target.closest('.card-menu');
    const onToggle = evt.target.closest('[data-history-menu]');
    if (insideMenu || onToggle) return;
    closeActiveHistoryMenu();
  });

  // ESC to close menus/gallery
  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      const { submenu: activeSubmenu } = getActiveHistorySubmenu();
      const { menu: activeMenu } = getActiveHistoryMenu();

      if (activeSubmenu) {
        closeActiveHistorySubmenu();
        return;
      }
      if (activeMenu) {
        closeActiveHistoryMenu();
        return;
      }
      if (State.historyState.galleryExpanded) {
        State.historyState.galleryExpanded = false;
        State.historyState.page = 1;
        renderHistory();
      }
    }
  });

  // Initial render
  renderHistory();
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

window.addEventListener('DOMContentLoaded', () => {
  log('Initializing TimrX 3D Print Hub...');

  // =========================================================================
  // AUTH-LOSS HANDLER (AUTH-5) — listen for expired session, show banner + reload
  // =========================================================================
  window.addEventListener('timrx:auth-lost', () => {
    log('[Auth] Session lost — showing reload banner');

    // Don't stack multiple banners
    if (document.getElementById('timrx-auth-lost-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'timrx-auth-lost-banner';
    Object.assign(banner.style, {
      position: 'fixed',
      top: '56px',
      left: '0',
      right: '0',
      zIndex: '100001',
      background: '#1a1a2e',
      color: '#e0e0e0',
      padding: '10px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
      borderBottom: '2px solid #e94560',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    });

    const msg = document.createElement('span');
    msg.textContent = 'Your session has expired. Please refresh to continue.';

    const btn = document.createElement('button');
    btn.textContent = 'Refresh';
    Object.assign(btn.style, {
      background: '#e94560',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      padding: '6px 18px',
      cursor: 'pointer',
      fontWeight: '600',
      fontSize: '13px',
    });
    btn.addEventListener('click', () => window.location.reload());

    banner.appendChild(msg);
    banner.appendChild(btn);
    document.body.appendChild(banner);
  });

  // =========================================================================
  // CREDITS: Initialize IMMEDIATELY - must not depend on Three.js
  // =========================================================================
  // Phase 1: /api/me bootstraps identity + wallet (single request).
  // Phase 2: action-costs + history load after /api/me settles, so the
  //          critical auth bootstrap gets a clear pool lane.
  const creditsPromise = Credits.initCredits().catch(e => {
    console.error('Credits init failed:', e);
  });

  // Initialize notification center — attach bell listener immediately,
  // don't wait for credits (bell must work even if credits fail/hang)
  try {
    Notifications.initNotifications();
  } catch (e) {
    console.error('Notifications init failed:', e);
  }

  // Initialize converter tool
  try {
    Converter.init();
  } catch (e) {
    console.error('Converter init failed:', e);
  }

  // Wait for Three.js to be ready (credits already initializing above)
  onThreeReady(async () => {
    log('Three.js ready, initializing modules...');

    // Initialize viewer
    try {
      Viewer.initViewer();
      Viewer.initImageFitToggle();
    } catch (e) {
      console.error('Viewer init failed:', e);
    }

    // Initialize UI
    try {
      initUi();
    } catch (e) {
      console.error('UI init failed:', e);
    }

    // Wire up history gallery
    try {
      wireGallery();
    } catch (e) {
      console.error('Gallery wire failed:', e);
    }

    // ── Phase 2: wait for /api/me to complete, then load history ──
    // Rendering cached history is instant (no network), so do it first
    // for perceived performance while we wait for the bootstrap request.
    renderHistory();

    // Wait for credits/identity bootstrap before hitting more endpoints.
    // This prevents history + action-costs from racing /api/me for pool
    // connections during the critical first 500ms.
    await creditsPromise;

    // Load history from database (session now confirmed)
    try {
      await State.loadHistoryFromDB();
      renderHistory();
    } catch (e) {
      console.error('History load failed:', e);
      renderHistory(); // Still render with cache
    }

    // Sync history filter with rail buttons
    const imageRail = document.querySelector('[data-panel="image"]');
    const modelRail = document.querySelector('[data-panel="model"]');
    const videoRail = document.querySelector('[data-panel="video"]');
    if (imageRail) imageRail.addEventListener('click', () => switchHistoryFilter('image'));
    if (modelRail) modelRail.addEventListener('click', () => switchHistoryFilter('model'));
    if (videoRail) videoRail.addEventListener('click', () => switchHistoryFilter('video'));

    // MY ASSETS nav link → open expanded history gallery
    document.querySelectorAll('[data-open-assets]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        setMobileWorkspaceTab('history');
        State.historyState.galleryExpanded = true;
        State.historyState.filter = 'all';
        State.historyState.page = 1;
        renderHistory();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    // Set up generate button listeners
    setupGenerateButtonListeners();

    // Wire live character counter on model prompt textarea
    API.wirePromptCharCounter();

    // Initialize viewer toolbar
    initViewerToolbar();
    initViewerActionBar();
    initTimrxOrderModal();

    // Hide progress initially
    UI.showOutputEmpty();

    // ── Phase 3: Resume any pending jobs (credits + history ready) ──
    await API.resumePendingJobs({ skipEmptyUI: true });

    // Signal that critical startup is complete. Secondary modules (inspire,
    // community, subscription summary) listen for this to avoid competing
    // with auth/history/wallet for pool connections.
    window.dispatchEvent(new Event('timrx:startup-complete'));

    // After login/restore/identity swap, re-run job recovery for the new identity.
    // Use a timestamp guard: skip identity_changed events within 15s of startup
    // (the initial null→realId bootstrap transition), and also prevent rapid-fire
    // recovery if multiple identity events arrive close together.
    const _recoveryStartedAt = Date.now();
    let _lastRecoveryAt = _recoveryStartedAt; // resumePendingJobs just ran
    window.addEventListener('timrx:identity_changed', () => {
      const now = Date.now();
      // Skip during startup window (bootstrap null→realId fires here)
      if (now - _recoveryStartedAt < 15000) return;
      // Throttle: don't re-run if recovery ran less than 10s ago
      if (now - _lastRecoveryAt < 10000) return;
      _lastRecoveryAt = now;
      log('[Recovery] Identity changed — re-running job recovery');
      API.resumePendingJobs({ skipEmptyUI: true });
    });

    log('TimrX 3D Print Hub initialized successfully.');
  });
});

// ============================================================================
// EXPOSE GLOBALS (for backward compatibility)
// ============================================================================
window.renderHistory = renderHistory;
window.switchHistoryFilter = switchHistoryFilter;
window.showQuotaExceededPopup = showQuotaExceededPopup;
