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
