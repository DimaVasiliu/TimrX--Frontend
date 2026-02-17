/**
 * ui-utils.js
 * Pure UI helpers: Progress bars, tab switching, and "Nice Select" initialization.
 */

import { byId, safe } from './config.js';

// ============================================================================
// APP STATE (for tabs)
// ============================================================================
export const state = {
  activeTab: 'text3d',
  imageFile: null,
  modelFile: null
};

// DOM references (set during init)
let btnTextTab, btnImageTab, textTab, imageTab, genHint;

// ============================================================================
// TAB SWITCHING
// ============================================================================

/**
 * Initialize tab DOM references
 */
export function initTabRefs() {
  btnTextTab = byId('btnTextTab');
  btnImageTab = byId('btnImageTab');
  textTab = byId('text3d');
  imageTab = byId('image3d');
  genHint = byId('genHint');
}

/**
 * Switch between text3d and image3d tabs
 */
export function setActiveTab(tab) {
  state.activeTab = tab;

  safe(btnTextTab, () => btnTextTab.classList.toggle('active', tab === 'text3d'));
  safe(btnImageTab, () => btnImageTab.classList.toggle('active', tab === 'image3d'));

  safe(textTab, () => {
    textTab.classList.toggle('active', tab === 'text3d');
    textTab.classList.toggle('hidden', tab !== 'text3d');
  });
  safe(imageTab, () => {
    imageTab.classList.toggle('active', tab === 'image3d');
    imageTab.classList.toggle('hidden', tab !== 'image3d');
  });

  updateGenerateHint();
}

/**
 * Update the generate hint text based on active tab
 */
export function updateGenerateHint() {
  if (!genHint) genHint = byId('genHint');
  if (!genHint) return;
  genHint.textContent = (state.activeTab === 'text3d')
    ? 'Enter a descriptive prompt, then Generate.'
    : 'Choose an image and a model name, then Generate.';
}

// ============================================================================
// PROGRESS DRIVER
// ============================================================================

/**
 * No-op progress display functions (progress now shown on thumbnails)
 */
export function showOutputEmpty() {}
export function showOutputProgress() {}
export function setOutputProgress() {}

/**
 * Create a progress driver for tracking job progress
 * Returns an object with: label, jump, done, fail, clear methods
 * Note: Visual progress is now displayed on history thumbnails
 */
export function makeProgressDriver() {
  let pct = 0, id = null;

  return {
    label: () => {},
    jump: (to) => { pct = Math.max(pct, to); },
    done: () => { clearInterval(id); },
    fail: () => { clearInterval(id); },
    clear: () => { clearInterval(id); }
  };
}

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - 'success', 'error', 'info', or 'settings'
 * @param {number} duration - Auto-dismiss duration in ms (default 4000)
 */
export function toast(message, type = 'info', duration = 4000) {
  // Get or create toast container
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Create toast element
  const toastEl = document.createElement('div');
  toastEl.className = `toast toast-${type}`;
  toastEl.setAttribute('role', 'alert');
  toastEl.innerHTML = `
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Dismiss">&times;</button>
  `;

  container.appendChild(toastEl);

  // Close button handler
  const closeBtn = toastEl.querySelector('.toast-close');
  closeBtn?.addEventListener('click', () => dismissToast(toastEl));

  // Trigger entrance animation
  requestAnimationFrame(() => {
    toastEl.classList.add('show');
  });

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismissToast(toastEl), duration);
  }

  return toastEl;
}

function dismissToast(toastEl) {
  if (!toastEl || toastEl.classList.contains('dismissing')) return;
  toastEl.classList.add('dismissing');
  toastEl.classList.remove('show');
  setTimeout(() => toastEl.remove(), 300);
}

// ============================================================================
// EFFECTIVE SETTINGS DISPLAY
// ============================================================================

const QUALITY_LABELS = {
  '720p': 'Standard (HD)',
  '1080p': 'Pro (Full HD)',
  '4k': 'Ultra (4K)'
};

/**
 * Show effective settings when a video job is created
 * @param {Object} params - Job parameters (resolution, duration_seconds, aspect_ratio)
 */
export function showJobCreatedSettings(params) {
  const resolution = params.resolution || '720p';
  const duration = params.duration_seconds || 6;
  const aspect = params.aspect_ratio || '16:9';
  const qualityLabel = QUALITY_LABELS[resolution.toLowerCase()] || resolution;

  const message = `Video queued • ${qualityLabel} • ${duration}s • ${aspect}`;
  toast(message, 'settings', 3000);
}

/**
 * Show effective settings when a video job completes
 * @param {Object} data - Completion data (provider, resolution, duration_seconds)
 */
export function showJobCompletedSettings(data) {
  const provider = data.provider || 'google';
  const resolution = data.resolution || '720p';
  const qualityLabel = QUALITY_LABELS[resolution.toLowerCase()] || resolution;

  // Provider display names
  const providerNames = {
    'vertex': 'Veo',
    'google': 'Veo',
    'ai_studio': 'AI Studio'
  };
  const providerLabel = providerNames[provider.toLowerCase()] || provider;

  const message = `Generated: ${qualityLabel} • ${providerLabel}`;
  toast(message, 'success', 5000);
}

// ============================================================================
// NICE SELECT INITIALIZATION
// ============================================================================

/**
 * Initialize custom dropdown (.nice-select) components
 * Powers the custom dropdowns and syncs with hidden <select> elements
 */
export function initNiceSelects() {
  document.querySelectorAll('.nice-select').forEach(ns => {
    const targetId = ns.getAttribute('data-target');
    const real = document.getElementById(targetId);
    const btn = ns.querySelector('.ns-control');
    const val = ns.querySelector('.ns-value');
    const menu = ns.querySelector('.ns-menu');

    if (!btn || !menu) return;

    btn.addEventListener('click', () => {
      const open = ns.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    menu.querySelectorAll('[role="option"]').forEach(opt => {
      opt.addEventListener('click', () => {
        menu.querySelectorAll('[role="option"]').forEach(o => o.removeAttribute('aria-selected'));
        opt.setAttribute('aria-selected', 'true');

        if (val) val.textContent = opt.textContent;
        if (real) {
          real.value = opt.getAttribute('data-value');
          real.dispatchEvent(new Event('change', { bubbles: true }));
        }

        ns.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('click', (e) => {
      if (!ns.contains(e.target)) {
        ns.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  });
}
