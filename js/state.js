/**
 * main.js
 * The entry point. Imports all modules, runs initialization logic,
 * and sets up the primary event listeners.
 */

import { byId, safe, log, onThreeReady, normalizeEpochMs, apiFetch, getLoadableModelUrl, isTimrxS3Url } from './config.js';
import * as State from './state.js';
import * as Viewer from './viewer.js';
import * as UI from './ui-utils.js';
import {
  renderHistory,
  shortTitle,
  closeActiveHistoryMenu,
  closeActiveHistorySubmenu,
  openHistoryMenu,
  openHistorySubmenu,
  updateActiveHistoryMenuPosition,
  getFilteredHistory,
  getActiveHistoryMenu,
  getActiveHistorySubmenu
} from './history.js';
import * as API from './api.js';
import * as Converter from './converter.js';
import * as Credits from './workspace-credits.js';

// ============================================================================
// MODULE STATE
// ============================================================================

// DOM references
let imageDrop, imageInput, imagePreview, imageModelName;
let uploadModal, openUpload, closeUpload, cancelUpload, continueUpload;
let modelDrop, modelInput, modelFileHint, historyUploadBtn;
let genHint;

// ============================================================================
// HISTORY FILTER SWITCHING
// ============================================================================

function switchHistoryFilter(filter = 'all') {
  // Only reset page if filter actually changed
  if (State.historyState.filter !== filter) {
    // Collapse expanded gallery when switching away from 'all'
    if (filter !== 'all' && State.historyState.galleryExpanded) {
      State.historyState.galleryExpanded = false;
    }
    State.historyState.filter = filter;
    State.historyState.page = 1;
    renderHistory();
  }
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

// Track last focused element before modal opens
let lastFocusedBeforeModal = null;

function showModal(show) {
  const on = !!show;

  if (on) {
    // Opening: store current focus, then show modal
    lastFocusedBeforeModal = document.activeElement;
    uploadModal?.classList.add('show');
    if (uploadModal) {
      uploadModal.inert = false;
      // Focus the first focusable element in the modal
      const firstFocusable = uploadModal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      requestAnimationFrame(() => firstFocusable?.focus());
    }
  } else {
    // Closing: move focus OUT before hiding
    if (uploadModal?.contains(document.activeElement)) {
      (lastFocusedBeforeModal || document.body).focus();
    }
    uploadModal?.classList.remove('show');
    if (uploadModal) {
      uploadModal.inert = true;
    }
  }

  document.body.classList.toggle('modal-open', on);
  if (window.viewerControls) window.viewerControls.enabled = !on;
}

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
    if (btnId === 'applyAnimationBtn') {
      const riggingTaskId = btn.dataset.riggingTaskId;
      const action = document.getElementById('rigAnimationAction')?.value;
      API.startAnimationFromPanel(riggingTaskId, action);
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
  document.getElementById('viewerPrintToast')?.classList.remove('is-visible');
  if (_printToastTimer) { clearTimeout(_printToastTimer); _printToastTimer = null; }
}

function initViewerToolbar() {
  const toolbar = document.getElementById('viewerToolbar');
  if (!toolbar) return;

  const sharePopover = document.getElementById('viewerSharePopover');
  const printToast = document.getElementById('viewerPrintToast');

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
      closeViewerPopovers();
    });
  }

  // Close popovers on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#viewerSharePopover') && !e.target.closest('[data-action="share"]')) {
      sharePopover?.classList.remove('is-visible');
    }
    if (!e.target.closest('#viewerPrintToast') && !e.target.closest('[data-action="print"]')) {
      printToast?.classList.remove('is-visible');
      if (_printToastTimer) { clearTimeout(_printToastTimer); _printToastTimer = null; }
    }
  });

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.viewer-toolbar__btn');
    if (!btn) return;

    const action = btn.dataset.action;
    const activeItem = API.getActiveHistoryItem();

    if (action === 'download' && activeItem?.glb_url) {
      if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
        if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = 'hub.html#pricing';
        return;
      }
      const a = document.createElement('a');
      a.href = activeItem.glb_url;
      a.download = 'model.glb';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    if (action === 'texture' && activeItem) {
      API.startTextureFromHistory(activeItem);
    }

    if (action === 'remesh' && activeItem) {
      API.startRemeshFromHistory(activeItem);
    }

    if (action === 'share') {
      printToast?.classList.remove('is-visible');
      sharePopover?.classList.toggle('is-visible');
    }

    if (action === 'print') {
      sharePopover?.classList.remove('is-visible');
      const showing = printToast?.classList.toggle('is-visible');
      if (_printToastTimer) { clearTimeout(_printToastTimer); _printToastTimer = null; }
      if (showing) {
        _printToastTimer = setTimeout(() => {
          printToast?.classList.remove('is-visible');
          _printToastTimer = null;
        }, 8000);
      }
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
    const hasModel = !!API.getActiveHistoryItem();
    const actionBtns = toolbar.querySelectorAll('.viewer-toolbar__btn[data-action]');
    actionBtns.forEach(btn => {
      const act = btn.dataset.action;
      // download, share, print, remesh, texture, evolve, retry all need a model
      if (['download', 'remesh', 'texture', 'evolve', 'retry'].includes(act)) {
        btn.disabled = !hasModel;
      }
    });
  }

  // Run on init and whenever history re-renders
  updateToolbarState();
  window.addEventListener('history:rendered', updateToolbarState);
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

  uploadModal = byId('uploadModal');
  openUpload = byId('openUpload');
  closeUpload = byId('closeUpload');
  cancelUpload = byId('cancelUpload');
  continueUpload = byId('continueUpload');
  modelDrop = byId('modelDrop');
  modelInput = byId('customModelUpload');
  modelFileHint = byId('modelFileHint');
  historyUploadBtn = byId('historyUploadBtn');
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

  // Upload modal
  safe(openUpload, () => {
    openUpload.addEventListener('click', (e) => { e.preventDefault(); showModal(true); });
  });
  safe(historyUploadBtn, () => {
    historyUploadBtn.addEventListener('click', (e) => { e.preventDefault(); showModal(true); });
  });
  safe(closeUpload, () => closeUpload.addEventListener('click', () => showModal(false)));
  safe(cancelUpload, () => cancelUpload.addEventListener('click', () => showModal(false)));
  safe(uploadModal, () => {
    uploadModal.addEventListener('click', (e) => {
      if (e.target === uploadModal) showModal(false);
    });
  });

  const uploadDialog = uploadModal?.querySelector('.upload-modal-content');
  if (uploadDialog) {
    uploadDialog.addEventListener('click', (e) => e.stopPropagation());
  }

  // Model drop zone
  safe(modelDrop, () => {
    const hl = (on) => modelDrop.classList.toggle('dragover', !!on);
    ['dragenter', 'dragover'].forEach(evt =>
      modelDrop.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); hl(true); })
    );
    ['dragleave', 'drop'].forEach(evt =>
      modelDrop.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); hl(false); })
    );
    modelDrop.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) handleModelFile(f);
    });
    modelDrop.addEventListener('click', () => modelInput?.click());
    modelDrop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); modelInput?.click(); }
    });
  });

  safe(modelInput, () => {
    modelInput.addEventListener('change', () => {
      const f = modelInput.files?.[0];
      if (f) handleModelFile(f);
    });
  });

  safe(continueUpload, () => {
    continueUpload.addEventListener('click', (e) => {
      e.preventDefault();
      if (!UI.state.modelFile) {
        alert('Please choose a .glb or .gltf file.');
        return;
      }
      if (typeof loadLocalGLB === 'function') {
        loadLocalGLB(UI.state.modelFile);
      }
      showModal(false);
    });
  });

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

  // ESC to close modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && uploadModal?.classList.contains('show')) showModal(false);
  });

  // Migrate history data
  migrateHistoryTitles();
  migrateHistoryDates();

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

  // Pagination
  if (first) first.addEventListener('click', () => {
    if (State.historyState.page > 1) {
      State.historyState.page = 1;
      renderHistory();
    }
  });
  if (prev) prev.addEventListener('click', () => {
    if (State.historyState.page > 1) {
      State.historyState.page--;
      renderHistory();
    }
  });
  if (next) next.addEventListener('click', () => {
    const filtered = getFilteredHistory();
    const total = Math.max(1, Math.ceil(filtered.length / State.historyState.pageSize));
    if (State.historyState.page < total) {
      State.historyState.page++;
      renderHistory();
    }
  });
  if (last) last.addEventListener('click', () => {
    const filtered = getFilteredHistory();
    const total = Math.max(1, Math.ceil(filtered.length / State.historyState.pageSize));
    if (State.historyState.page < total) {
      State.historyState.page = total;
      renderHistory();
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
        }
        e.stopPropagation();
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

      // Action buttons
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      closeActiveHistoryMenu();

      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      const item = State.getHistory().find(x => x.id === id);
      if (!item) return;

      const glbUrl = item.glb_proxy || item.glb_url;

      // Handle actions
      if (act === 'open') {
        const wasGallery = !!State.historyState.galleryExpanded;
        if (wasGallery) {
          State.historyState.galleryExpanded = false;
          State.historyState.page = 1;
        }

        // Handle video type
        if (item.type === 'video' || item.video_url) {
          const videoUrl = item.video_url;
          if (videoUrl) {
            State.setHistoryActiveModelId(id);
            renderHistory();
            const videoRailBtn = document.querySelector('[data-panel="video"]');
            if (videoRailBtn) videoRailBtn.click();
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
            renderHistory();
            const imgSrc = item.image_url || item.thumbnail_url || '';
          if (imgSrc) {
            const imageRailBtn = document.querySelector('[data-panel="image"]');
            if (imageRailBtn) imageRailBtn.click();
            Viewer.showImageInViewer(imgSrc);
          }
          return;
        }

        if (!glbUrl) return;

        const modelRailBtn = document.querySelector('[data-panel="model"]');
        if (modelRailBtn) modelRailBtn.click();

        const genHintEl = byId('genHint');
        if (genHintEl) genHintEl.textContent = 'Loading model...';
        State.setHistoryActiveModelId(id);
        renderHistory();

        // Reset version stack for this model and hide action bar
        const loadUrl = isTimrxS3Url(item.glb_url) ? item.glb_url : (item.glb_proxy || getLoadableModelUrl(item.glb_url));
        State.resetModelVersionStack({
          id,
          glb_url: loadUrl,
          thumbnail_url: item.thumbnail_url || '',
          stage: item.stage || 'preview',
          prompt: item.prompt || ''
        });
        const actionBar = byId('viewerActionBar');
        if (actionBar) actionBar.classList.add('hidden');

        if (wasGallery) {
          requestAnimationFrame(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }

        // Use S3 URL directly if available (no proxy needed), otherwise use glb_proxy for Meshy URLs
        const primary = loadUrl;
        const fallback = (item.glb_url && item.glb_url !== primary) ? item.glb_url : null;
        await Viewer.loadModelWithFallback(primary, fallback);
        if (genHintEl) genHintEl.textContent = 'Loaded from history.';
        return;
      }

      if ((act === 'download' || act === 'print') && item.glb_url) {
        if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
          if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = 'hub.html#pricing';
          return;
        }
        const a = document.createElement('a');
        a.href = item.glb_url;
        a.download = 'model.glb';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      if (act === 'download-image') {
        if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
          if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = 'hub.html#pricing';
          return;
        }
        const imageUrl = btn.getAttribute('data-image-url') || item.image_url || item.thumbnail_url;
        if (!imageUrl) {
          alert('No image available to download.');
          return;
        }
        const a = document.createElement('a');
        a.href = imageUrl;
        a.download = `${shortTitle(item)}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      // Video actions
      if (act === 'download-video') {
        if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
          if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = 'hub.html#pricing';
          return;
        }
        const videoUrl = btn.getAttribute('data-video-url') || item.video_url;
        if (!videoUrl) {
          alert('No video available to download.');
          return;
        }
        const a = document.createElement('a');
        a.href = videoUrl;
        a.download = `${shortTitle(item)}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      if (act === 'open-video') {
        // Collapse expanded gallery first (viewer is hidden in expanded mode)
        if (State.historyState.galleryExpanded) {
          State.historyState.galleryExpanded = false;
          State.historyState.page = 1;
        }
        const videoUrl = btn.getAttribute('data-video-url') || item.video_url;
        if (videoUrl) {
          const videoRailBtn = document.querySelector('[data-panel="video"]');
          if (videoRailBtn) videoRailBtn.click();
          // Show video in the viewer panel
          Viewer.showVideoInViewer(videoUrl, {
            title: shortTitle(item) || 'Video Preview',
            hint: item.prompt || 'Generated video',
            autoplay: true
          });
          // Update active state
          State.setHistoryActiveModelId(item.id);
          renderHistory();
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

      if (act === 'texture') {
        await API.startTextureFromHistory(item);
        return;
      }

      if (act === 'remesh') {
        await API.startRemeshFromHistory(item);
        return;
      }

      if (act === 'refine') {
        API.onPostProcessFromHistory(item, 'refine');
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

        // Update credits display — Veo image-to-video 4s 720p = 110 credits
        const videoCreditsDisplay = byId('videoCreditsDisplay');
        if (videoCreditsDisplay) {
          videoCreditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 110';
        }
        const generateVideoBtn = byId('generateVideoBtn');
        if (generateVideoBtn) {
          generateVideoBtn.title = '110 credits';
          generateVideoBtn.dataset.baseCredits = '110';
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
        if (!confirm('Delete from database and S3 permanently?')) return;
        try {
          const result = await apiFetch(`/api/_mod/history/item/${encodeURIComponent(id)}`, {
            method: 'DELETE'
          });
          if (!result.ok) {
            throw new Error(result.error || `HTTP ${result.status}`);
          }
          State.deleteHistoryItem(id, { skipRemote: true });
          renderHistory();
        } catch (err) {
          console.warn('[History] Delete failed:', err?.message || err);
          showErrorToast('Delete failed. Please try again.');
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
      top: '0',
      left: '0',
      right: '0',
      zIndex: '99999',
      background: '#1a1a2e',
      color: '#e0e0e0',
      padding: '14px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
      borderBottom: '2px solid #e94560',
      boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
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
  const creditsPromise = Credits.initCredits().catch(e => {
    console.error('Credits init failed:', e);
  });

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

    // Load history from database and render
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
    if (modelRail) modelRail.addEventListener('click', () => switchHistoryFilter('all'));
    if (videoRail) videoRail.addEventListener('click', () => switchHistoryFilter('video'));

    // MY ASSETS nav link → open expanded history gallery
    document.querySelectorAll('[data-open-assets]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        St/**
        * state.js
        * Manages state with database-backed storage via API.
        * Falls back to localStorage for active jobs and as a cache.
        */
       
       import { ACTIVE_JOBS_STORAGE_KEY, PENDING_JOBS_STORAGE_KEY, log, apiFetch, getConfirmedIdentity, getStampedIdentityId } from './config.js';
       
       // ============================================================================
       // CONSTANTS
       // ============================================================================
       const HISTORY_CACHE_KEY = 'meshy_history_cache';
       const HISTORY_OWNER_KEY = 'meshy_history_owner';
       export const HISTORY_LIMIT = 500;
       export const MAX_DATA_URI_LEN = 50000;
       
       // In-memory cache for history (populated from DB)
       let historyCache = null;
       let historyLoading = false;
       let historyLoadPromise = null;
       
       // ============================================================================
       // JOB WATCHERS (shared Map for tracking active job polling)
       // ============================================================================
       export const watchers = new Map();
       
       // Expose globally for backward compatibility
       if (!window.watchers) window.watchers = watchers;
       
       // ============================================================================
       // ACTIVE JOBS MANAGEMENT
       // ============================================================================
       
       // Callbacks for when active jobs change (for UI updates like jobs indicator)
       const activeJobCallbacks = [];
       
       /**
        * Register a callback to be called when active jobs change
        * @param {Function} callback - (activeJobIds: string[]) => void
        */
       export function onActiveJobsChange(callback) {
         if (typeof callback === 'function') {
           activeJobCallbacks.push(callback);
         }
       }
       
       /**
        * Notify all callbacks that active jobs changed
        */
       function notifyActiveJobsChange() {
         const jobs = getActiveJobs();
         activeJobCallbacks.forEach(cb => {
           try {
             cb(jobs);
           } catch (e) {
             console.error('[State] Active job callback error:', e);
           }
         });
       }
       
       /**
        * Get the list of active job IDs from localStorage
        */
       export function getActiveJobs() {
         try {
           return JSON.parse(localStorage.getItem(ACTIVE_JOBS_STORAGE_KEY)) || [];
         } catch {
           return [];
         }
       }
       
       /**
        * Save the list of active job IDs to localStorage
        */
       export function setActiveJobs(ids) {
         try {
           localStorage.setItem(ACTIVE_JOBS_STORAGE_KEY, JSON.stringify([...new Set(ids)].slice(0, 50)));
         } catch (e) {
           try {
             localStorage.setItem(ACTIVE_JOBS_STORAGE_KEY, '[]');
           } catch (_) {
             /* ignore */
           }
         }
       }
       
       /**
        * Add a job ID to the active jobs list
        */
       export function addActiveJob(id) {
         const ids = getActiveJobs();
         if (!ids.includes(id)) {
           ids.push(id);
           setActiveJobs(ids);
           notifyActiveJobsChange();
         }
       }
       
       /**
        * Remove a job ID from the active jobs list and clean up its watcher
        */
       export function removeActiveJob(id) {
         setActiveJobs(getActiveJobs().filter(x => x !== id));
         const w = watchers.get(id);
         if (w && typeof w.abort === 'function') w.abort();
         watchers.delete(id);
         deletePendingMeta(id);
         notifyActiveJobsChange();
       }
       
       // ============================================================================
       // PENDING JOBS METADATA
       // ============================================================================
       
       /**
        * Get pending jobs metadata from localStorage
        */
       export function getPendingMeta() {
         try {
           return JSON.parse(localStorage.getItem(PENDING_JOBS_STORAGE_KEY)) || {};
         } catch {
           return {};
         }
       }
       
       /**
        * Save metadata for a pending job
        */
       export function savePendingMeta(id, meta) {
         try {
           const m = getPendingMeta();
           m[id] = meta;
           let entries = Object.entries(m);
           if (entries.length > 50) entries = entries.slice(entries.length - 50);
           localStorage.setItem(PENDING_JOBS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
         } catch (e) {
           console.warn('Pending meta save failed, keeping previous data:', e);
         }
       }
       
       /**
        * Delete metadata for a pending job
        */
       export function deletePendingMeta(id) {
         try {
           const m = getPendingMeta();
           delete m[id];
           localStorage.setItem(PENDING_JOBS_STORAGE_KEY, JSON.stringify(m));
         } catch (_) {
           /* ignore */
         }
       }
       
       // ============================================================================
       // HISTORY DATABASE (API-backed with localStorage cache)
       // ============================================================================
       
       /**
        * Sanitize a history item before saving (removes bulky fields)
        */
       export function sanitizeHistoryItem(item = {}) {
         if (!item || typeof item !== 'object') return item;
         const copy = { ...item };
       
         // Drop bulky fields/base64
         delete copy.image_base64;
         delete copy.raw;
         delete copy.images_base64;
       
         // Ensure thumbnails have a source (fallback to image_url)
         if (!copy.thumbnail_url && copy.image_url) {
           copy.thumbnail_url = copy.image_url;
         }
       
         // Fix: Set image status to 'finished' only if stuck in 'generating' but actually has an image
         // (This fixes images that completed but status wasn't updated, while allowing
         // legitimately generating images to show progress)
         if (copy.type === 'image' && copy.status === 'generating' && copy.image_url) {
           copy.status = 'finished';
         }
       
         return copy;
       }
       
       function shouldSkipRemoteHistoryItem(item = {}) {
         if (!item || typeof item !== 'object') return true;
         if (item.status && item.status !== 'finished') return true;
         // Don't skip if we have a valid ID for any content type
         if (item.model_id || item.image_id || item.video_id) return false;
         // Also check if this is a video with a video_url (completed video)
         if (item.type === 'video' && item.video_url) return false;
         return true;
       }
       
       /**
        * Get the current user's identity_id.
        * AUTH-7: Prefer the server-confirmed identity (set after /api/me).
        * AUTH-8: Fall back to auth stamp (survives page loads) before returning null,
        *         so history cache isn't defensively cleared on every cold navigation.
        */
       function getCurrentIdentityId() {
         // Prefer confirmed identity (set by fetchWallet after /api/me)
         const confirmed = getConfirmedIdentity();
         if (confirmed) return confirmed;
         // AUTH-8: Auth stamp provides a fast synchronous identity hint written by
         // the previous /api/me call. It survives cache clears and page navigations,
         // preventing unnecessary defensive clears of the history cache while
         // fetchWallet() is still in flight.
         const stamped = getStampedIdentityId();
         if (stamped) return stamped;
         // Truly unknown — no server confirmation and no stamp from a prior page load.
         return null;
       }
       
       /**
        * Clear all user-scoped caches (history, active jobs, pending jobs)
        */
       function clearUserCaches() {
         localStorage.removeItem(HISTORY_CACHE_KEY);
         localStorage.removeItem(HISTORY_OWNER_KEY);
         localStorage.removeItem(ACTIVE_JOBS_STORAGE_KEY);
         localStorage.removeItem(PENDING_JOBS_STORAGE_KEY);
       }
       
       /**
        * Get cached history from localStorage (fast, synchronous).
        * Returns empty if cache belongs to a different user.
        */
       function getHistoryCache() {
         try {
           const currentUser = getCurrentIdentityId();
           const cacheOwner = localStorage.getItem(HISTORY_OWNER_KEY);
       
           // If we know who the current user is and the cache belongs to someone else, clear it
           if (currentUser && cacheOwner && cacheOwner !== currentUser) {
             log('[History] User changed, clearing stale cache');
             clearUserCaches();
             return [];
           }
       
           // AUTH-8: If we can't determine the current user (wallet cache expired) but
           // the cache is tagged to a specific owner, don't trust it — it may belong
           // to a previous identity. Clear defensively and let the next fetch repopulate.
           if (!currentUser && cacheOwner) {
             log('[History] Identity unknown (wallet cache expired), clearing owned cache defensively');
             clearUserCaches();
             return [];
           }
       
           const cached = localStorage.getItem(HISTORY_CACHE_KEY);
           return cached ? JSON.parse(cached) : [];
         } catch {
           return [];
         }
       }
       
       /**
        * Save to localStorage cache (best-effort, ignore quota errors).
        * Tags the cache with the current user's identity so it won't leak to other accounts.
        */
       function saveHistoryCache(arr) {
         try {
           // Tag cache with current user
           const currentUser = getCurrentIdentityId();
           if (currentUser) {
             localStorage.setItem(HISTORY_OWNER_KEY, currentUser);
           }
       
           // Only cache essential fields to avoid quota issues
           const minimal = (arr || []).slice(0, 100).map(item => ({
             id: item.id,
             type: item.type,
             status: item.status,
             title: item.title,
             prompt: item.prompt,
             thumbnail_url: item.thumbnail_url,
             image_url: item.image_url,
             video_url: item.video_url,
             video_id: item.video_id,
             error_message: item.error_message,
             glb_url: item.glb_url,
             glb_proxy: item.glb_proxy,
             stage: item.stage,
             created_at: item.created_at,
             pose_mode: item.pose_mode,
             model: item.model,
             license: item.license,
             lineage_root_id: item.lineage_root_id,
             preview_task_id: item.preview_task_id,
             batch_count: item.batch_count,
             batch_slot: item.batch_slot,
             batch_group_id: item.batch_group_id
           }));
           localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(minimal));
         } catch (e) {
           // Quota exceeded - clear cache and try again with fewer items
           try {
             localStorage.removeItem(HISTORY_CACHE_KEY);
             const smaller = (arr || []).slice(0, 20).map(item => ({
               id: item.id,
               type: item.type,
               status: item.status,
               title: item.title,
               thumbnail_url: item.thumbnail_url,
               stage: item.stage,
               created_at: item.created_at
             }));
             localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(smaller));
           } catch {
             // Give up on caching
           }
         }
       }
       
       /**
        * Migrate old localStorage history to database (one-time)
        */
       async function migrateOldHistory() {
         const OLD_HISTORY_KEY = 'meshy_history';
         const MIGRATION_FLAG = 'meshy_history_migrated';
       
         // Check if already migrated
         if (localStorage.getItem(MIGRATION_FLAG)) return;
       
         try {
           const oldData = localStorage.getItem(OLD_HISTORY_KEY);
           if (!oldData) {
             localStorage.setItem(MIGRATION_FLAG, 'true');
             return;
           }
       
           const oldHistory = JSON.parse(oldData);
           if (!Array.isArray(oldHistory) || oldHistory.length === 0) {
             localStorage.setItem(MIGRATION_FLAG, 'true');
             return;
           }
       
           log('Migrating', oldHistory.length, 'history items to database...');
       
           // Send to database
           const result = await apiFetch('/api/_mod/history', {
             method: 'POST',
             body: oldHistory.map(sanitizeHistoryItem)
           });
       
           if (result.ok) {
             const data = result.data;
             // Log any skipped items (frontend should not retry these)
             if (data.skipped && data.skipped.length > 0) {
               console.warn('[History] Migration skipped items:', data.skipped);
             }
             // Migration successful - clear old data
             localStorage.removeItem(OLD_HISTORY_KEY);
             localStorage.setItem(MIGRATION_FLAG, 'true');
             log('History migration complete:', 'inserted=' + (data.inserted?.length || 0), 'updated=' + (data.updated?.length || 0), 'skipped=' + (data.skipped?.length || 0));
           }
         } catch (err) {
           console.warn('[History] Migration failed:', err.message);
           // Don't set flag - will retry next time
         }
       }
       
       /**
        * Load history from database API
        */
       export async function loadHistoryFromDB() {
         if (historyLoading && historyLoadPromise) {
           return historyLoadPromise;
         }
       
         historyLoading = true;
         historyLoadPromise = (async () => {
           try {
             // First, try to migrate old localStorage data
             await migrateOldHistory();
       
             // Helper to attempt a single fetch
             const attemptFetch = async () => {
               const result = await apiFetch(`/api/_mod/history?limit=${HISTORY_LIMIT}`);
               if (!result.ok) {
                 const err = new Error(result.error || `HTTP ${result.status}`);
                 err.isTimeout = result.isTimeout;
                 throw err;
               }
               return Array.isArray(result.data) ? result.data : [];
             };
       
             // Try up to 2 times on timeout
             for (let attempt = 1; attempt <= 2; attempt++) {
               try {
                 historyCache = await attemptFetch();
                 saveHistoryCache(historyCache);
                 log('History loaded from DB:', historyCache.length, 'items', attempt > 1 ? '(retry succeeded)' : '');
                 return historyCache;
               } catch (err) {
                 // Only retry on timeout, and only once
                 if (err.isTimeout && attempt < 2) {
                   console.warn('[History] Load timeout, retrying in 1s...');
                   await new Promise(r => setTimeout(r, 1000));
                   continue;
                 }
                 // All attempts failed - use cache
                 console.warn('[History] Failed to load from DB, using cache:', err.message);
                 historyCache = getHistoryCache();
                 return historyCache;
               }
             }
       
             // Fallback (shouldn't reach here)
             historyCache = getHistoryCache();
             return historyCache;
           } finally {
             historyLoading = false;
             historyLoadPromise = null;
           }
         })();
       
         return historyLoadPromise;
       }
       
       /**
        * Get history items (synchronous - returns cache, triggers background refresh)
        */
       export function getHistory() {
         // Return in-memory cache if available
         if (historyCache !== null) {
           return historyCache;
         }
         // Fall back to localStorage cache
         historyCache = getHistoryCache();
         // Trigger background refresh from DB
         loadHistoryFromDB().catch(() => {});
         return historyCache;
       }
       
       /**
        * Save entire history array to database
        */
       export function saveHistory(arr) {
         const source = Array.isArray(arr) ? arr : [];
         const sanitized = source.map(sanitizeHistoryItem);
       
         // Update in-memory cache immediately
         historyCache = sanitized;
         saveHistoryCache(sanitized);
       
         // Save to database in background
         apiFetch('/api/_mod/history', {
           method: 'POST',
           body: sanitized
         }).then(result => {
           if (result.ok && result.data) {
             // Log skipped items - frontend should not retry these
             if (result.data.skipped && result.data.skipped.length > 0) {
               console.warn('[History] Sync skipped items (will not retry):', result.data.skipped);
               // Mark skipped items in local cache so we don't retry them
               const skippedIds = new Set(result.data.skipped.map(s => s.client_id));
               historyCache = historyCache.map(item => {
                 if (skippedIds.has(item.id)) {
                   return { ...item, _skipReason: result.data.skipped.find(s => s.client_id === item.id)?.reason };
                 }
                 return item;
               });
               saveHistoryCache(historyCache);
             }
           }
         }).catch(err => {
           console.warn('[History] Failed to save to DB:', err.message);
         });
       
         return true;
       }
       
       /**
        * Add an item to the beginning of history
        */
       export function addHistoryItem(item) {
         const sanitized = sanitizeHistoryItem(item);
       
         // Update in-memory cache
         if (historyCache === null) historyCache = getHistoryCache();
         historyCache.unshift(sanitized);
         if (historyCache.length > HISTORY_LIMIT) historyCache.length = HISTORY_LIMIT;
         saveHistoryCache(historyCache);
       
         if (shouldSkipRemoteHistoryItem(sanitized)) {
           return true;
         }
       
         // Save to database
         apiFetch('/api/_mod/history/item', {
           method: 'POST',
           body: sanitized
         }).then(result => {
           if (result.ok && result.data) {
             // If item was skipped, mark it in local cache
             if (result.data.skipped) {
               console.warn('[History] Item skipped (will not retry):', result.data.skipped);
               const idx = historyCache.findIndex(x => x.id === sanitized.id);
               if (idx !== -1) {
                 historyCache[idx] = { ...historyCache[idx], _skipReason: result.data.skipped.reason };
                 saveHistoryCache(historyCache);
               }
             }
           }
         }).catch(err => {
           console.warn('[History] Failed to add item to DB:', err.message);
         });
       }
       
       /**
        * Update an existing history item by job ID
        */
       export function updateHistoryItem(jobId, updates = {}) {
         // Update in-memory cache
         if (historyCache === null) historyCache = getHistoryCache();
         const idx = historyCache.findIndex(x => x.id === jobId);
       
         if (idx !== -1) {
           const updated = { ...historyCache[idx], ...updates, status: updates.status || 'finished' };
           historyCache[idx] = updated;
           saveHistoryCache(historyCache);
       
           if (shouldSkipRemoteHistoryItem(updated)) {
             return true;
           }
       
           // Update in database
           apiFetch(`/api/_mod/history/item/${encodeURIComponent(jobId)}`, {
             method: 'PATCH',
             body: { ...updates, status: updates.status || 'finished' }
           }).catch(err => {
             console.warn('[History] Failed to update item in DB:', err.message);
           });
           return true;
         }
       
         // Item not in cache - add it instead
         const newItem = { id: jobId, ...updates, status: updates.status || 'finished' };
         addHistoryItem(newItem);
         return true;
       }
       
       /**
        * Delete a history item by ID
        */
       export function deleteHistoryItem(jobId, options = {}) {
         // Update in-memory cache
         if (historyCache === null) historyCache = getHistoryCache();
         historyCache = historyCache.filter(x => x.id !== jobId);
         saveHistoryCache(historyCache);
       
         if (!options.skipRemote) {
           // Delete from database
           apiFetch(`/api/_mod/history/item/${encodeURIComponent(jobId)}`, {
             method: 'DELETE'
           }).then(() => {
             // Invalidate Inspire cache so deleted items disappear on next open
             window.dispatchEvent(new CustomEvent('inspire:invalidate'));
           }).catch(err => {
             console.warn('[History] Failed to delete item from DB:', err.message);
           });
         }
       }
       
       /**
        * Check if a job ID exists in history
        */
       export function historyHasJobId(jobId) {
         return getHistory().some(x => x.id === jobId);
       }
       
       /**
        * Force restore history from database (clears local cache first)
        * Returns the restored history array
        */
       export async function forceRestoreFromDB() {
         const fallbackCache = historyCache ?? getHistoryCache();
       
         // Reset loading state to force fresh load
         historyLoading = false;
         historyLoadPromise = null;
       
         // Helper to attempt a single fetch
         const attemptFetch = async () => {
           const result = await apiFetch('/api/_mod/history');
           if (!result.ok) {
             const err = new Error(result.error || `HTTP ${result.status}`);
             err.isTimeout = result.isTimeout;
             throw err;
           }
           return Array.isArray(result.data) ? result.data : [];
         };
       
         // Load fresh from database with retry on timeout
         let lastError = null;
         for (let attempt = 1; attempt <= 2; attempt++) {
           try {
             historyCache = await attemptFetch();
             saveHistoryCache(historyCache);
             log('History restored from DB:', historyCache.length, 'items', attempt > 1 ? '(retry succeeded)' : '');
             return historyCache;
           } catch (err) {
             lastError = err;
             // Only retry on timeout, and only once
             if (err.isTimeout && attempt < 2) {
               console.warn('[History] Fetch timeout, retrying in 1s...');
               await new Promise(r => setTimeout(r, 1000));
               continue;
             }
             break;
           }
         }
       
         // All attempts failed
         historyCache = Array.isArray(fallbackCache) ? fallbackCache : [];
         saveHistoryCache(historyCache);
         console.error('[History] Failed to restore from DB:', lastError?.message);
         throw lastError;
       }
       
       /**
        * Clear all local history cache (for debugging/reset)
        */
       export function clearLocalHistoryCache() {
         historyCache = null;
         try {
           localStorage.removeItem(HISTORY_CACHE_KEY);
           log('Local history cache cleared');
         } catch (_) {
           /* ignore */
         }
       }
       
       // ============================================================================
       // HISTORY UI STATE (pagination, filtering, sorting)
       // ============================================================================
       export const historyState = {
         page: 1,
         pageSize: 9,
         query: '',
         filter: 'all',
         galleryExpanded: false,
         sort: 'desc'
       };
       
       // ============================================================================
       // PROVIDER CAPABILITIES MAP
       // Defines what each provider supports for each mode
       // ============================================================================
       export const PROVIDER_CAPABILITIES = {
         image: {
           openai: {
             name: 'OpenAI',
             shapes: ['square', 'portrait', 'landscape'],
             qualities: ['standard', 'high', '4k'],
             defaultShape: 'square',
             defaultQuality: 'standard',
             credits: 10, // Default (standard), actual credits determined by creditsByQuality
             creditsByQuality: { standard: 10, high: 15, '4k': 20 },
             genTimeByQuality: { standard: '30 sec', high: '45 sec', '4k': '60 sec' },
             genTime: '30 sec', // Default for standard
             // Shape controls layout (aspect ratio), Quality controls detail level + resolution
             // gpt-image-1 sizes: 1024x1024 (square), 1024x1536 (portrait), 1536x1024 (landscape)
             shapeMap: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
             qualityMap: { standard: 'standard', high: 'hd', '4k': 'hd' }, // 4K uses HD quality
             sizeMap: { standard: '1024x1024', high: '1792x1024', '4k': '2048x2048' }
           },
           google: {
             name: 'Google (Imagen)',
             shapes: ['square', 'portrait', 'landscape'],
             qualities: ['standard', 'high', '4k'],
             defaultShape: 'square',
             defaultQuality: 'standard',
             credits: 10, // Default (standard), actual credits determined by creditsByQuality
             creditsByQuality: { standard: 10, high: 15, '4k': 20 },
             genTimeByQuality: { standard: '30 sec', high: '45 sec', '4k': '60 sec' },
             genTime: '30 sec', // Default for standard
             // Shape controls layout (aspect ratio), Quality controls imageSize
             shapeMap: { square: '1:1', portrait: '9:16', landscape: '16:9' },
             qualityMap: { standard: '1K', high: '2K', '4k': '4K' }
           }
         },
         video: {
           google: {
             name: 'Google (Veo)',
             aspects: ['landscape', 'portrait'],
             qualities: ['standard', 'high'],
             durations: [4, 6, 8],
             defaultAspect: 'landscape',
             defaultQuality: 'standard',
             defaultDuration: 4,
             maxDuration: 8,
             fps: 24,
             genTime: '~2 min',
             aspectMap: { landscape: '16:9', portrait: '9:16' },
             qualityMultiplier: { standard: 1.0, high: 1.5 },
             baseCreditsByDuration: { 4: 30, 6: 45, 8: 60 }
           }
         },
         model: {
           meshy: {
             name: 'Meshy',
             modes: ['text-to-3d', 'image-to-3d'],
             defaultMode: 'text-to-3d',
             credits: 50,
             genTime: '~3 min'
           }
         }
       };
       
       // ============================================================================
       // GENERATION STATE (single source of truth)
       // All UI controls and API calls read/write through this state
       // ============================================================================
       export const generation = {
         // Current mode
         mode: 'image',  // 'image' | 'video' | 'model'
       
         // Provider (per mode)
         provider: {
           image: 'openai',
           video: 'google',
           model: 'meshy'
         },
       
         // Image settings
         image: {
           prompt: '',
           shape: 'square',
           quality: 'standard'
         },
       
         // Video settings
         video: {
           prompt: '',
           motion: '',
           aspect: 'landscape',
           quality: 'standard',
           duration: 4,
           loop: true,
           mode: 'text2video'  // 'text2video' | 'image2video'
         },
       
         // Model settings
         model: {
           prompt: '',
           mode: 'text-to-3d',
           pose: false,
           batchCount: 1
         },
       
         // Lock state (prevents changes during generation)
         locked: false,
       
         // Current job info (when locked)
         currentJob: null
       };
       
       /**
        * Get provider capabilities for current mode
        * @param {string} mode - 'image' | 'video' | 'model'
        * @param {string} provider - provider name
        * @returns {object} capability config
        */
       export function getProviderCapabilities(mode, provider) {
         return PROVIDER_CAPABILITIES[mode]?.[provider] || null;
       }
       
       /**
        * Get current provider for a mode
        * @param {string} mode
        * @returns {string}
        */
       export function getProvider(mode) {
         return generation.provider[mode] || 'openai';
       }
       
       // Track who is allowed to change providers
       // ONLY 'user' and 'init' are allowed - background refreshes are blocked
       const ALLOWED_PROVIDER_SOURCES = new Set(['user', 'init']);
       
       // Provider change callbacks - called when provider switches
       // Used to cancel pending operations for the old provider
       const providerChangeCallbacks = [];
       
       /**
        * Register a callback to be called when provider changes
        * @param {Function} callback - (mode, oldProvider, newProvider) => void
        */
       export function onProviderChange(callback) {
         if (typeof callback === 'function') {
           providerChangeCallbacks.push(callback);
         }
       }
       
       /**
        * Set provider for a mode and normalize settings
        * IMPORTANT: Only 'user' (dropdown change) and 'init' (initial load) are allowed.
        * Background refreshes, wallet sync, etc. must NOT change the provider.
        *
        * @param {string} mode - 'image' | 'video' | 'model'
        * @param {string} provider
        * @param {string} source - 'user' | 'init' (ONLY these are allowed)
        * @returns {boolean} success
        */
       export function setProvider(mode, provider, source = 'user') {
         // CRITICAL: Block non-user/init sources from changing provider
         if (!ALLOWED_PROVIDER_SOURCES.has(source)) {
           console.warn(`[Provider] BLOCKED change to ${provider} (source: ${source}) - only user/init allowed`);
           return false;
         }
       
         if (generation.locked) {
           console.warn(`[Provider] BLOCKED change to ${provider} (source: ${source}) - generation locked`);
           return false;
         }
       
         const caps = getProviderCapabilities(mode, provider);
         if (!caps) {
           console.warn(`[Provider] FAILED -> ${provider} (source: ${source}) - unknown provider`);
           return false;
         }
       
         const previousProvider = generation.provider[mode];
       
         // Only log and update if actually changing
         if (previousProvider !== provider) {
           generation.provider[mode] = provider;
       
           // Normalize settings for the new provider
           normalizeSettings(mode, provider);
       
           // Log provider change with source and stack trace for debugging
           console.log(`[Provider] ${mode}: ${previousProvider} -> ${provider} (source: ${source})`);
       
           // Notify listeners to cancel pending operations for old provider
           providerChangeCallbacks.forEach(cb => {
             try {
               cb(mode, previousProvider, provider);
             } catch (e) {
               console.error('[Provider] Callback error:', e);
             }
           });
         }
       
         return true;
       }
       
       /**
        * Normalize settings when provider changes
        * Auto-corrects invalid selections based on provider capabilities
        * @param {string} mode
        * @param {string} provider
        */
       export function normalizeSettings(mode, provider) {
         const caps = getProviderCapabilities(mode, provider);
         if (!caps) return;
       
         const settings = generation[mode];
         if (!settings) return;
       
         // Normalize shape (images use shape, videos use aspect)
         if (settings.shape !== undefined && caps.shapes) {
           if (!caps.shapes.includes(settings.shape)) {
             settings.shape = caps.defaultShape || caps.shapes[0];
             console.log('[GEN] Normalized shape to:', settings.shape);
           }
         }
       
         // Normalize aspect (for video mode)
         if (settings.aspect !== undefined && caps.aspects) {
           if (!caps.aspects.includes(settings.aspect)) {
             settings.aspect = caps.defaultAspect || caps.aspects[0];
             console.log('[GEN] Normalized aspect to:', settings.aspect);
           }
         }
       
         // Normalize quality
         if (settings.quality !== undefined && caps.qualities) {
           if (!caps.qualities.includes(settings.quality)) {
             settings.quality = caps.defaultQuality || caps.qualities[0];
             console.log('[GEN] Normalized quality to:', settings.quality);
           }
         }
       
         // Normalize duration (video only)
         if (settings.duration !== undefined && caps.durations) {
           if (!caps.durations.includes(settings.duration)) {
             settings.duration = caps.defaultDuration || caps.durations[0];
             console.log('[GEN] Normalized duration to:', settings.duration);
           }
         }
       }
       
       /**
        * Update a setting value
        * @param {string} mode - 'image' | 'video' | 'model'
        * @param {string} key - setting key
        * @param {*} value - new value
        * @returns {boolean} success
        */
       export function setSetting(mode, key, value) {
         if (generation.locked) {
           console.warn('[GEN] Cannot change settings while generation is in progress');
           return false;
         }
       
         if (!generation[mode]) {
           console.warn('[GEN] Unknown mode:', mode);
           return false;
         }
       
         generation[mode][key] = value;
       
         // Re-normalize in case the value is invalid for current provider
         normalizeSettings(mode, generation.provider[mode]);
       
         return true;
       }
       
       /**
        * Get current settings for a mode
        * @param {string} mode
        * @returns {object}
        */
       export function getSettings(mode) {
         return { ...generation[mode] };
       }
       
       /**
        * Get full generation state snapshot for API call
        * @param {string} mode
        * @returns {object} { provider, settings, capabilities, credits }
        */
       export function getGenerationSnapshot(mode) {
         const provider = generation.provider[mode];
         const caps = getProviderCapabilities(mode, provider);
         const settings = { ...generation[mode] };
       
         // Calculate credits based on mode
         let credits = caps?.credits || 5;
         let genTime = caps?.genTime || '30 sec';
       
         if (mode === 'image' && caps) {
           // Image: tiered pricing by quality (Standard 5c, High/2K 7c, 4K 10c)
           const quality = settings.quality || 'standard';
           credits = caps.creditsByQuality?.[quality] ?? caps.credits ?? 5;
           genTime = caps.genTimeByQuality?.[quality] ?? caps.genTime ?? '30 sec';
         } else if (mode === 'video' && caps) {
           // Video: pricing by duration and quality multiplier
           const base = caps.baseCreditsByDuration?.[settings.duration] || 30;
           const mult = caps.qualityMultiplier?.[settings.quality] || 1.0;
           credits = Math.round(base * mult);
         }
       
         return {
           mode,
           provider,
           settings,
           capabilities: { ...caps, genTime }, // Include dynamic genTime
           credits
         };
       }
       
       /**
        * Lock generation state (call when starting)
        * @param {object} jobInfo - { jobId, reservationId, startedAt }
        */
       export function lockGeneration(jobInfo) {
         generation.locked = true;
         generation.currentJob = {
           ...jobInfo,
           snapshot: getGenerationSnapshot(generation.mode)
         };
         console.log('[GEN] Locked:', generation.currentJob);
       }
       
       /**
        * Unlock generation state (call when complete/failed)
        */
       export function unlockGeneration() {
         generation.locked = false;
         generation.currentJob = null;
         console.log('[GEN] Unlocked');
       }
       
       /**
        * Check if generation is locked
        * @returns {boolean}
        */
       export function isLocked() {
         return generation.locked;
       }
       
       /**
        * Set current mode
        * @param {string} mode - 'image' | 'video' | 'model'
        */
       export function setMode(mode) {
         if (generation.locked) {
           console.warn('[GEN] Cannot change mode while generation is in progress');
           return false;
         }
         generation.mode = mode;
         return true;
       }
       
       /**
        * Get current mode
        * @returns {string}
        */
       export function getMode() {
         return generation.mode;
       }
       
       // Legacy compatibility aliases
       export const activeProvider = generation.provider;
       export function getActiveProvider(mode) { return getProvider(mode); }
       export function setActiveProvider(mode, provider) { return setProvider(mode, provider); }
       export function lockProviders() { lockGeneration({}); }
       export function unlockProviders() { unlockGeneration(); }
       export function isProviderLocked() { return isLocked(); }
       
       // Track lineage counts for grouped history items
       export const historyLineageCounts = new Map();
       
       // Track fresh thumbnails that need animation
       export const historyFreshThumbs = new Set();
       
       // Currently active model in the viewer
       export let historyActiveModelId = null;
       
       /**
        * Set the currently active model ID
        */
       export function setHistoryActiveModelId(id) {
         historyActiveModelId = id;
       }
       
       // ============================================================================
       // MODEL VERSION STACK (for Accept/Revert flow)
       // ============================================================================
       let modelVersionStack = []; // [{id, glb_url, thumbnail_url, stage, prompt}]
       
       /**
        * Push a model version onto the stack (after remesh/texture/evolve)
        */
       export function pushModelVersion(entry) {
         if (entry && entry.id) {
           modelVersionStack.push(entry);
         }
       }
       
       /**
        * Pop the latest version, returning it. Returns null if only base version remains.
        */
       export function popModelVersion() {
         if (modelVersionStack.length > 1) {
           return modelVersionStack.pop();
         }
         return null;
       }
       
       /**
        * Get the current version stack (copy)
        */
       export function getModelVersionStack() {
         return [...modelVersionStack];
       }
       
       /**
        * Reset the version stack (when a new model is loaded from history)
        */
       export function resetModelVersionStack(initialEntry) {
         modelVersionStack = initialEntry ? [initialEntry] : [];
       }
       
       /**
        * Check if revert is possible (stack has more than base entry)
        */
       export function canRevertModel() {
         return modelVersionStack.length > 1;
       }
       
       // ============================================================================
       // IDEMPOTENCY KEY MANAGEMENT (for generation reliability)
       // ============================================================================
       const IDEMPOTENCY_KEYS_STORAGE = 'timrx_idempotency_keys';
       
       /**
        * Generate a new idempotency key (UUID v4)
        */
       export function generateIdempotencyKey() {
         if (typeof crypto !== 'undefined' && crypto.randomUUID) {
           return crypto.randomUUID();
         }
         return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
           const r = Math.random() * 16 | 0;
           const v = c === 'x' ? r : (r & 0x3 | 0x8);
           return v.toString(16);
         });
       }
       
       /**
        * Store idempotency key -> job mapping
        */
       export function saveIdempotencyMapping(idempotencyKey, jobId, meta = {}) {
         try {
           const mappings = JSON.parse(localStorage.getItem(IDEMPOTENCY_KEYS_STORAGE) || '{}');
           mappings[idempotencyKey] = { jobId, createdAt: Date.now(), ...meta };
           const entries = Object.entries(mappings);
           if (entries.length > 100) {
             const sorted = entries.sort((a, b) => b[1].createdAt - a[1].createdAt);
             localStorage.setItem(IDEMPOTENCY_KEYS_STORAGE, JSON.stringify(Object.fromEntries(sorted.slice(0, 100))));
           } else {
             localStorage.setItem(IDEMPOTENCY_KEYS_STORAGE, JSON.stringify(mappings));
           }
         } catch (e) {
           console.warn('[State] Failed to save idempotency mapping:', e);
         }
       }
       
       /**
        * Get job_id for an idempotency key
        */
       export function getJobForIdempotencyKey(idempotencyKey) {
         try {
           const mappings = JSON.parse(localStorage.getItem(IDEMPOTENCY_KEYS_STORAGE) || '{}');
           return mappings[idempotencyKey]?.jobId || null;
         } catch {
           return null;
         }
       }
       
       /**
        * Clear idempotency mapping when job completes
        */
       export function clearIdempotencyMapping(idempotencyKey) {
         try {
           const mappings = JSON.parse(localStorage.getItem(IDEMPOTENCY_KEYS_STORAGE) || '{}');
           delete mappings[idempotencyKey];
           localStorage.setItem(IDEMPOTENCY_KEYS_STORAGE, JSON.stringify(mappings));
         } catch { /* ignore */ }
       }
       
       /**
        * Check if there are any active jobs (for beforeunload warning)
        */
       export function hasActiveJobs() {
         return getActiveJobs().length > 0;
       }
       
       // ============================================================================
       // EXPOSE FUNCTIONS GLOBALLY (for backward compatibility)
       // ============================================================================
       window.getActiveJobs = getActiveJobs;
       window.setActiveJobs = setActiveJobs;
       window.addActiveJob = addActiveJob;
       window.removeActiveJob = removeActiveJob;
       window.onActiveJobsChange = onActiveJobsChange;
       window.getPendingMeta = getPendingMeta;
       window.savePendingMeta = savePendingMeta;
       window.deletePendingMeta = deletePendingMeta;
       window.getHistory = getHistory;
       window.saveHistory = saveHistory;
       window.addHistoryItem = addHistoryItem;
       window.updateHistoryItem = updateHistoryItem;
       window.deleteHistoryItem = deleteHistoryItem;
       window.loadHistoryFromDB = loadHistoryFromDB;
       window.forceRestoreFromDB = forceRestoreFromDB;
       window.clearLocalHistoryCache = clearLocalHistoryCache;
       // Idempotency key functions (generation reliability)
       window.generateIdempotencyKey = generateIdempotencyKey;
       window.saveIdempotencyMapping = saveIdempotencyMapping;
       window.getJobForIdempotencyKey = getJobForIdempotencyKey;
       window.clearIdempotencyMapping = clearIdempotencyMapping;
       window.hasActiveJobs = hasActiveJobs;
       
       // ============================================================================
       // EXPOSE GENERATION STATE GLOBALLY
       // ============================================================================
       window.GenerationState = {
         // State object (read-only reference)
         get generation() { return generation; },
         get capabilities() { return PROVIDER_CAPABILITIES; },
       
         // Getters
         getMode,
         getProvider,
         getSettings,
         getProviderCapabilities,
         getGenerationSnapshot,
         isLocked,
       
         // Setters
         setMode,
         setProvider,
         setSetting,
         normalizeSettings,
       
         // Lock/unlock
         lockGeneration,
         unlockGeneration,
       
         // Provider change notifications
         onProviderChange
       };
       ate.historyState.galleryExpanded = true;
        State.historyState.filter = 'all';
        State.historyState.page = 1;
        renderHistory();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    // Set up generate button listeners
    setupGenerateButtonListeners();

    // Initialize viewer toolbar
    initViewerToolbar();
    initViewerActionBar();

    // Hide progress initially
    UI.showOutputEmpty();

    // Ensure credits are loaded before resuming jobs (they may need credit checks)
    await creditsPromise;

    // Resume any pending jobs
    await API.resumePendingJobs({ skipEmptyUI: true });

    log('TimrX 3D Print Hub initialized successfully.');
  });
});

// ============================================================================
// EXPOSE GLOBALS (for backward compatibility)
// ============================================================================
window.renderHistory = renderHistory;
window.switchHistoryFilter = switchHistoryFilter;
window.showModal = showModal;
window.showQuotaExceededPopup = showQuotaExceededPopup;
