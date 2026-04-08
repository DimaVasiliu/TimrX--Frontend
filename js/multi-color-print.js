/**
 * multi-color-print.js
 * ────────────────────
 * Full-color 3D Print modal — converts textured models into
 * slicer-ready 3MF files with configurable color palettes.
 *
 * Usage:
 *   import { openMultiColorModal } from './multi-color-print.js';
 *   openMultiColorModal({ taskId, title, thumbnailUrl });
 */

import { BACKEND, apiFetch } from './config.js';

// ─── State ──────────────────────────────────────────────────────────────
let _overlay = null;
let _activeJobId = null;
let _pollTimer = null;
const POLL_INTERVAL = 3000;
const CREDIT_COST = 10;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Open the multi-color print modal for a given task.
 * @param {object} opts
 * @param {string} opts.taskId   — Meshy task ID (from prior generation)
 * @param {string} opts.title    — Display title of the source model
 * @param {string} opts.thumbnailUrl — Preview thumbnail URL
 */
export function openMultiColorModal({ taskId, title, thumbnailUrl }) {
  console.log('[MultiColorPrint] Opening modal for task:', taskId);
  if (!taskId) return;
  _cleanup();
  _injectStylesOnce();
  _overlay = _createOverlay(taskId, title || 'Untitled Model', thumbnailUrl || '');
  document.body.appendChild(_overlay);
  requestAnimationFrame(() => {
    _overlay.classList.add('open');
    _overlay.inert = false;
    console.log('[MultiColorPrint] Modal opened, overlay in DOM:', document.body.contains(_overlay));
  });
  document.body.classList.add('has-modal');
  document.addEventListener('keydown', _onEscape);
}

/**
 * Close and destroy the modal.
 */
export function closeMultiColorModal() {
  _cleanup();
}

// ─── Internal ───────────────────────────────────────────────────────────

function _cleanup() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _activeJobId = null;
  if (_overlay) {
    _overlay.classList.remove('open');
    document.body.classList.remove('has-modal');
    setTimeout(() => { _overlay?.remove(); _overlay = null; }, 250);
  }
  document.removeEventListener('keydown', _onEscape);
}

function _onEscape(e) {
  if (e.key === 'Escape') _cleanup();
}

function _createOverlay(taskId, title, thumbUrl) {
  const el = document.createElement('div');
  el.className = 'mcp-overlay';
  el.inert = true;
  el.innerHTML = `
    <div class="mcp-modal" role="dialog" aria-labelledby="mcpTitle">
      <!-- Header -->
      <div class="mcp-modal__header">
        <div>
          <span class="mcp-modal__eyebrow">Full-Color 3D Print</span>
          <h3 class="mcp-modal__title" id="mcpTitle">Prepare for Printing</h3>
        </div>
        <button class="mcp-modal__close" type="button" aria-label="Close" data-mcp-close>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Body — Config state -->
      <div class="mcp-modal__body" data-mcp-state="config">
        <!-- Source preview -->
        <div class="mcp-source">
          ${thumbUrl ? `<img class="mcp-source__thumb" src="${thumbUrl}" alt="" />` : `
            <div class="mcp-source__thumb mcp-source__thumb--empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28">
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </div>
          `}
          <div class="mcp-source__info">
            <span class="mcp-source__title">${_esc(title)}</span>
            <span class="mcp-source__subtitle">Source model</span>
          </div>
        </div>

        <!-- Color palette -->
        <div class="mcp-field">
          <label class="mcp-field__label">Color Palette</label>
          <span class="mcp-field__hint">How many filament colors your printer can use (1–16)</span>
          <div class="mcp-color-presets" data-mcp-presets>
            <button class="mcp-preset" type="button" data-colors="2">
              <span class="mcp-preset__swatches">
                <span style="background:#2563eb"></span><span style="background:#f97316"></span>
              </span>
              <span class="mcp-preset__label">2 Colors</span>
            </button>
            <button class="mcp-preset is-active" type="button" data-colors="4">
              <span class="mcp-preset__swatches">
                <span style="background:#ef4444"></span><span style="background:#22c55e"></span>
                <span style="background:#3b82f6"></span><span style="background:#eab308"></span>
              </span>
              <span class="mcp-preset__label">4 Colors</span>
            </button>
            <button class="mcp-preset" type="button" data-colors="8">
              <span class="mcp-preset__swatches">
                <span style="background:#ef4444"></span><span style="background:#f97316"></span>
                <span style="background:#eab308"></span><span style="background:#22c55e"></span>
                <span style="background:#3b82f6"></span><span style="background:#8b5cf6"></span>
                <span style="background:#ec4899"></span><span style="background:#f5f5f5"></span>
              </span>
              <span class="mcp-preset__label">8 Colors</span>
            </button>
            <button class="mcp-preset" type="button" data-colors="16">
              <span class="mcp-preset__swatches mcp-preset__swatches--dense">
                <span style="background:#ef4444"></span><span style="background:#f97316"></span>
                <span style="background:#eab308"></span><span style="background:#84cc16"></span>
                <span style="background:#22c55e"></span><span style="background:#14b8a6"></span>
                <span style="background:#06b6d4"></span><span style="background:#3b82f6"></span>
                <span style="background:#6366f1"></span><span style="background:#8b5cf6"></span>
                <span style="background:#a855f7"></span><span style="background:#d946ef"></span>
                <span style="background:#ec4899"></span><span style="background:#f43f5e"></span>
                <span style="background:#fafafa"></span><span style="background:#171717"></span>
              </span>
              <span class="mcp-preset__label">16 Colors</span>
            </button>
          </div>
        </div>

        <!-- Detail level -->
        <div class="mcp-field">
          <label class="mcp-field__label">Color Detail</label>
          <span class="mcp-field__hint">Higher values capture finer color transitions but increase file size</span>
          <div class="mcp-detail-row">
            <input type="range" class="mcp-detail-slider" min="3" max="6" value="4" step="1" data-mcp-depth />
            <div class="mcp-detail-labels">
              <span class="mcp-detail-label" data-depth="3">Fast</span>
              <span class="mcp-detail-label is-active" data-depth="4">Balanced</span>
              <span class="mcp-detail-label" data-depth="5">Fine</span>
              <span class="mcp-detail-label" data-depth="6">Ultra</span>
            </div>
          </div>
        </div>

        <!-- Output format info -->
        <div class="mcp-info-card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <div>
            <strong>Output: 3MF</strong>
            <span>Ready for Bambu Studio, OrcaSlicer, Cura, and other modern slicers.</span>
          </div>
        </div>
      </div>

      <!-- Body — Processing state -->
      <div class="mcp-modal__body mcp-modal__body--hidden" data-mcp-state="processing">
        <div class="mcp-processing">
          <div class="mcp-processing__spinner"></div>
          <h4 class="mcp-processing__title">Preparing your print file</h4>
          <p class="mcp-processing__desc">Converting colors and optimizing mesh for printing...</p>
          <div class="mcp-processing__progress">
            <div class="mcp-processing__bar">
              <div class="mcp-processing__fill" data-mcp-progress></div>
            </div>
            <span class="mcp-processing__pct" data-mcp-pct>0%</span>
          </div>
        </div>
      </div>

      <!-- Body — Done state -->
      <div class="mcp-modal__body mcp-modal__body--hidden" data-mcp-state="done">
        <div class="mcp-done">
          <div class="mcp-done__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32">
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <h4 class="mcp-done__title">Print file ready</h4>
          <p class="mcp-done__desc">Your full-color 3MF is ready for slicing.</p>
          <a class="mcp-done__download" href="#" data-mcp-download target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download 3MF
          </a>
          <div class="mcp-done__slicer-hint">
            Open in <strong>Bambu Studio</strong>, <strong>OrcaSlicer</strong>, or your slicer of choice
          </div>
        </div>
      </div>

      <!-- Body — Error state -->
      <div class="mcp-modal__body mcp-modal__body--hidden" data-mcp-state="error">
        <div class="mcp-error">
          <div class="mcp-error__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <h4 class="mcp-error__title">Something went wrong</h4>
          <p class="mcp-error__desc" data-mcp-error-msg>Please try again later.</p>
          <button class="mcp-error__retry" type="button" data-mcp-retry>Try Again</button>
        </div>
      </div>

      <!-- Footer -->
      <div class="mcp-modal__footer" data-mcp-footer="config">
        <div class="mcp-footer__meta">
          <span class="mcp-footer__time">~1 min</span>
          <span class="mcp-footer__divider">|</span>
          <span class="mcp-footer__credits">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><circle cx="12" cy="12" r="10"/></svg>
            ${CREDIT_COST}
          </span>
        </div>
        <div class="mcp-footer__actions">
          <button class="mcp-btn mcp-btn--ghost" type="button" data-mcp-close>Cancel</button>
          <button class="mcp-btn mcp-btn--primary" type="button" data-mcp-start data-task-id="${taskId}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            Generate 3MF
            <span class="mcp-btn__badge">${CREDIT_COST} cr</span>
          </button>
        </div>
      </div>

      <!-- Footer — processing (minimal) -->
      <div class="mcp-modal__footer mcp-modal__footer--hidden" data-mcp-footer="processing">
        <div class="mcp-footer__meta">
          <span class="mcp-footer__time">Processing...</span>
        </div>
        <button class="mcp-btn mcp-btn--ghost" type="button" data-mcp-close>Close</button>
      </div>

      <!-- Footer — done -->
      <div class="mcp-modal__footer mcp-modal__footer--hidden" data-mcp-footer="done">
        <div></div>
        <button class="mcp-btn mcp-btn--ghost" type="button" data-mcp-close>Done</button>
      </div>
    </div>
  `;

  // Wire events
  el.querySelectorAll('[data-mcp-close]').forEach(b => b.addEventListener('click', _cleanup));
  el.addEventListener('click', e => { if (e.target === el) _cleanup(); });

  // Preset buttons
  el.querySelector('[data-mcp-presets]')?.addEventListener('click', e => {
    const btn = e.target.closest('.mcp-preset');
    if (!btn) return;
    el.querySelectorAll('.mcp-preset').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
  });

  // Depth slider
  const slider = el.querySelector('[data-mcp-depth]');
  slider?.addEventListener('input', () => {
    el.querySelectorAll('.mcp-detail-label').forEach(l => {
      l.classList.toggle('is-active', l.dataset.depth === slider.value);
    });
  });

  // Start button
  el.querySelector('[data-mcp-start]')?.addEventListener('click', () => {
    const selectedPreset = el.querySelector('.mcp-preset.is-active');
    const maxColors = parseInt(selectedPreset?.dataset.colors || '4', 10);
    const maxDepth = parseInt(slider?.value || '4', 10);
    _startJob(taskId, maxColors, maxDepth);
  });

  // Retry button
  el.querySelector('[data-mcp-retry]')?.addEventListener('click', () => {
    _switchState('config');
  });

  return el;
}

function _switchState(state) {
  if (!_overlay) return;
  // Toggle body panels
  _overlay.querySelectorAll('[data-mcp-state]').forEach(panel => {
    panel.classList.toggle('mcp-modal__body--hidden', panel.dataset.mcpState !== state);
  });
  // Toggle footer panels
  _overlay.querySelectorAll('[data-mcp-footer]').forEach(footer => {
    footer.classList.toggle('mcp-modal__footer--hidden', footer.dataset.mcpFooter !== state);
  });
}

async function _startJob(taskId, maxColors, maxDepth) {
  _switchState('processing');
  _updateProgress(0);

  try {
    const res = await apiFetch(`${BACKEND}/api/_mod/print/multi-color`, {
      method: 'POST',
      body: JSON.stringify({
        input_task_id: taskId,
        max_colors: maxColors,
        max_depth: maxDepth,
      }),
    });

    if (!res.ok && !res.data?.ok) {
      const msg = res.data?.message || res.data?.error || res.error || 'Failed to start job';
      _showError(msg);
      return;
    }

    _activeJobId = res.data?.job_id;
    if (!_activeJobId) {
      _showError('No job ID returned');
      return;
    }

    // Update wallet display if new_balance is present
    if (res.data?.new_balance != null) {
      _updateWalletDisplay(res.data.new_balance);
    }

    // Start polling
    _pollTimer = setInterval(() => _pollStatus(), POLL_INTERVAL);
    // Also poll immediately after a short delay
    setTimeout(() => _pollStatus(), 1000);

  } catch (err) {
    console.error('[MultiColorPrint] start failed:', err);
    _showError('Network error — please check your connection.');
  }
}

async function _pollStatus() {
  if (!_activeJobId || !_overlay) { _stopPolling(); return; }

  try {
    const res = await apiFetch(`${BACKEND}/api/_mod/print/multi-color/${_activeJobId}`);
    const data = res.data || res;

    if (data.status === 'done') {
      _stopPolling();
      _updateProgress(100);
      const threeMfUrl = data.three_mf_url;
      if (threeMfUrl) {
        const downloadLink = _overlay.querySelector('[data-mcp-download]');
        if (downloadLink) downloadLink.href = threeMfUrl;
      }
      setTimeout(() => _switchState('done'), 400);
      return;
    }

    if (data.status === 'failed') {
      _stopPolling();
      _showError(data.message || 'The print conversion failed. Please try again.');
      return;
    }

    // Still running — update progress
    const pct = data.pct || 0;
    _updateProgress(pct);

  } catch (err) {
    console.error('[MultiColorPrint] poll error:', err);
    // Don't stop polling on transient errors
  }
}

function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function _updateProgress(pct) {
  if (!_overlay) return;
  const fill = _overlay.querySelector('[data-mcp-progress]');
  const label = _overlay.querySelector('[data-mcp-pct]');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${Math.round(pct)}%`;
}

function _showError(msg) {
  if (!_overlay) return;
  const el = _overlay.querySelector('[data-mcp-error-msg]');
  if (el) el.textContent = msg;
  _switchState('error');
}

function _updateWalletDisplay(newBalance) {
  // Update any visible wallet badge in the header
  const badge = document.querySelector('.credits-balance, .wallet-balance, [data-wallet-balance]');
  if (badge) {
    badge.textContent = newBalance;
  }
}

function _esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
