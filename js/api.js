/**
 * api.js
 * Handles all fetch calls to the backend, job polling, and orchestrates the other modules
 * (updates State, tells Viewer to load, tells History to refresh).
 */

import {
  CHAT_API,
  normalizeEpochMs,
  log,
  byId,
  fileToDataURL,
  createBatchGroupId,
  apiFetch,
  getLoadableModelUrl,
  isTimrxS3Url
} from './config.js';
import * as State from './state.js';
import * as Viewer from './viewer.js';
import * as UI from './ui-utils.js';
import { renderHistory, shortTitle } from './history.js';

// ============================================================================
// LOCKS & STATE
// ============================================================================
let startLock = false;
let postProcessLock = false;

// Track jobs that have already had credits refreshed on completion/failure
// Prevents multiple refresh calls for the same job
const creditsRefreshedJobs = new Set();

// ============================================================================
// CREDITS HELPERS
// ============================================================================

/**
 * Check if user has enough credits for an action (pre-flight check)
 * Uses effective available (accounting for existing reservations)
 * @returns {boolean} true if can proceed, false if insufficient
 */
function checkCreditsFor(action, count = 1) {
  if (!window.WorkspaceCredits) return true; // Skip if credits system not loaded
  if (!window.WorkspaceCredits.isLoaded()) return true; // Skip if not yet loaded

  // Use effective available (accounts for existing reservations)
  const hasCredits = window.WorkspaceCredits.hasEffectiveCreditsFor
    ? window.WorkspaceCredits.hasEffectiveCreditsFor(action, count)
    : window.WorkspaceCredits.hasCreditsFor(action);

  if (!hasCredits) {
    window.WorkspaceCredits.showInsufficientCreditsMessage(action);
    return false;
  }
  return true;
}

/**
 * Reserve credits BEFORE making API call (optimistic reservation)
 * Shows "Reserving credits..." status and immediately reduces available
 *
 * @param {string} action - The action key (e.g., 'text-to-3d', 'image-to-3d')
 * @param {number} count - Number of items (default 1, for batch operations)
 * @returns {{ reservationId: string, amount: number, insufficient?: boolean }}
 */
function reserveCreditsForAction(action, count = 1) {
  if (!window.WorkspaceCredits?.reserveCredits) {
    log('[Credits] reserveCredits not available');
    return { reservationId: null, amount: 0 };
  }

  const result = window.WorkspaceCredits.reserveCredits(action, count);
  if (result.insufficient) {
    window.WorkspaceCredits.showInsufficientCreditsMessage(action);
  }
  return result;
}

/**
 * Reserve an EXACT amount of credits (pre-computed, not multiplied by action cost).
 * Use this for video/image generation where cost is already computed from settings.
 *
 * @param {string} action - The action key (for logging/tracking)
 * @param {number} amount - Exact credits amount to reserve
 * @returns {{ reservationId: string, amount: number, insufficient?: boolean }}
 */
function reserveExactAmount(action, amount) {
  if (!window.WorkspaceCredits?.reserveAmount) {
    log('[Credits] reserveAmount not available, falling back to old method');
    // Fallback: if new function not available, try old method with count=1
    return reserveCreditsForAction(action, 1);
  }

  const result = window.WorkspaceCredits.reserveAmount({ action, amount });
  return result;
}

/**
 * Confirm reservation after successful job start
 * Converts reservation to actual deduction
 *
 * @param {string} reservationId - The reservation ID from reserveCreditsForAction
 * @param {string} jobId - The job ID from backend
 */
function confirmCreditsReservation(reservationId, jobId) {
  if (!window.WorkspaceCredits?.confirmReservation || !reservationId) {
    // Fallback to old deduction if reservation system not available
    return;
  }

  window.WorkspaceCredits.confirmReservation(reservationId, jobId);
  log('[Credits] Confirmed reservation:', { reservationId, jobId });

  // Refresh in background to reconcile with server
  refreshCreditsInBackground();
}

/**
 * Release reservation if job fails to start
 *
 * @param {string} reservationId - The reservation ID from reserveCreditsForAction
 */
function releaseCreditsReservation(reservationId) {
  if (!window.WorkspaceCredits?.releaseReservation || !reservationId) {
    return;
  }

  window.WorkspaceCredits.releaseReservation(reservationId);
}

/**
 * Show insufficient credits modal with exact required vs available
 * Replaces alert() for better UX
 *
 * @param {number} cost - Credits required for this action
 * @param {number} available - Credits currently available
 * @param {string} actionType - Type of action (for analytics)
 */
function showInsufficientCreditsModal(cost, available, actionType = 'generation') {
  // Ensure numeric and compute missing (never negative)
  const numCost = Number(cost) || 0;
  const numAvailable = Number(available) || 0;
  const missing = Math.max(0, numCost - numAvailable);

  // Try to use the workspace modal if available
  const modalEl = document.getElementById('insufficientCreditsModal');
  if (modalEl) {
    // Update modal content - only show missing credits
    const requiredEl = modalEl.querySelector('.credits-required');
    const availableEl = modalEl.querySelector('.credits-available');
    const neededEl = modalEl.querySelector('.credits-needed');

    if (requiredEl) requiredEl.textContent = numCost;
    if (availableEl) availableEl.textContent = numAvailable;
    if (neededEl) neededEl.textContent = missing;

    // Show modal
    modalEl.classList.remove('hidden');
    modalEl.style.display = 'flex';
    return;
  }

  // Fallback: check for hub buy modal
  const hubBuyModal = document.getElementById('buyCreditsModal');
  if (hubBuyModal && window.TimrXCredits?.openModal) {
    window.TimrXCredits.openModal();
    return;
  }

  // Final fallback: confirm dialog (never show negative numbers)
  const msg = `This ${actionType} requires ${numCost} credits.\n\nYou currently have ${numAvailable} credits.\nYou need ${missing} more credits.`;
  if (confirm(msg + '\n\nWould you like to buy more credits?')) {
    window.location.href = '/pricing';
  }
}

/**
 * Unified credit check helper for all generation types
 * Performs proper numeric conversion and logs debug info
 *
 * @param {number|string} cost - Credits required for this action
 * @param {string} mode - Generation mode ('image', 'video', 'model')
 * @returns {{ available: number, cost: number, missing: number, shouldBlock: boolean }}
 */
function checkCreditsForGeneration(cost, mode = 'generation') {
  // Get wallet and ensure numeric conversion
  const wallet = window.WorkspaceCredits?.getWallet?.() || {};
  const available = Number(wallet.available ?? wallet.available_credits ?? 0);
  const numCost = Number(cost) || 0;
  const missing = Math.max(0, numCost - available);
  const shouldBlock = missing > 0;

  // Debug log before block decision
  console.log(`[CREDITS] available=${available}, cost=${numCost}, missing=${missing}, willBlock=${shouldBlock}`);

  return { available, cost: numCost, missing, shouldBlock };
}

/**
 * Apply credits deduction AFTER successful job start (legacy)
 * Call this only after receiving a valid job_id from backend
 *
 * @param {string} action - The action key (e.g., 'text-to-3d', 'image-to-3d')
 * @param {string} jobId - The job ID from the backend response
 * @param {number} count - Number of items (default 1, for batch operations)
 */
function applyCreditsDeduction(action, jobId, count = 1) {
  if (!window.WorkspaceCredits?.applyDelta) {
    log('[Credits] applyDelta not available');
    return;
  }

  const cost = window.WorkspaceCredits.getActionCost(action) * count;
  if (cost > 0) {
    window.WorkspaceCredits.applyDelta(-cost, action, jobId);
    log('[Credits] Applied deduction:', { action, jobId, cost, count });

    // Refresh in background to reconcile with server
    refreshCreditsInBackground();
  }
}

/**
 * Refresh credits from server in background (non-blocking)
 */
function refreshCreditsInBackground() {
  if (window.WorkspaceCredits?.refreshCredits) {
    // Fire and forget - don't await
    window.WorkspaceCredits.refreshCredits().catch(err => {
      log('[Credits] Background refresh failed:', err);
    });
  }
}

/**
 * Handle API response errors, specifically 402 insufficient credits and 400 expired models
 * @returns {boolean} true if error was handled (should stop), false to continue with normal error
 */
function handleApiError(response, action, reservationId = null) {
  if (response.status === 402) {
    log('[Credits] 402 Insufficient credits for:', action);
    // Release any reservation on 402
    if (reservationId) {
      releaseCreditsReservation(reservationId);
    }
    if (window.WorkspaceCredits) {
      window.WorkspaceCredits.showInsufficientCreditsMessage(action);
    } else {
      alert('Insufficient credits. Please purchase more credits to continue.');
    }
    return true;
  }

  // Handle 400 errors for expired/unavailable models
  if (response.status === 400) {
    const errorMsg = response.error || response.data?.error || '';
    if (isExpiredModelError(errorMsg)) {
      log('[Model] 400 Expired/unavailable model for:', action);
      if (reservationId) {
        releaseCreditsReservation(reservationId);
      }
      showExpiredModelError(action);
      return true;
    }
  }

  return false;
}

/**
 * Check if API result is a timeout error
 * @param {object} result - API response from apiFetch
 * @returns {boolean} true if timeout
 */
function isTimeoutError(result) {
  return result?.isTimeout === true || result?.error === 'Request timeout';
}

/**
 * Handle timeout gracefully for generation requests
 * Shows "Still generating..." message instead of error
 * Does NOT release reservation (backend will handle it)
 *
 * @param {object} result - API response from apiFetch
 * @param {string} action - Action name for logging
 * @returns {boolean} true if was timeout (caller should not release reservation)
 */
function handleGenerationTimeout(result, action) {
  if (!isTimeoutError(result)) return false;

  log(`[Timeout] ${action} request timed out - job may still be processing on server`);

  // Show user-friendly message
  const msg = 'Still generating... The server is still processing your request. ' +
              'Check back in a moment - your credits will only be charged if generation succeeds.';
  alert(msg);

  return true;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Prefer HTTP URLs over data URIs when multiple are available
 */
function preferHttpUrl(urlLike) {
  if (Array.isArray(urlLike)) {
    const http = urlLike.find(u => typeof u === 'string' && /^https?:/i.test(u));
    return http || urlLike[0] || '';
  }
  if (typeof urlLike !== 'string') return '';
  return urlLike;
}

/**
 * Update the progress display on a history thumbnail
 * Handles both regular view (history-thumb) and expanded/gallery view (expanded-thumb)
 */
function updateThumbnailProgress(jobId, pct) {
  // Find processing elements in both regular and expanded views
  const selectors = [
    `.history-thumb__processing[data-job-id="${jobId}"]`,
    `.expanded-thumb__processing[data-job-id="${jobId}"]`
  ];

  selectors.forEach(selector => {
    const processingEl = document.querySelector(selector);
    if (!processingEl) return;

    // Find child elements using class that ends with the suffix (works for both prefixes)
    const pctEl = processingEl.querySelector('[class*="__processing-pct"]');
    const fillEl = processingEl.querySelector('[class*="__progress-fill"]');
    const barEl = processingEl.querySelector('[class*="__progress-bar"]');

    // Remove indeterminate state when we have actual progress
    if (pct > 0) {
      if (pctEl) {
        pctEl.classList.remove('history-thumb__processing-pct--indeterminate');
        pctEl.classList.remove('expanded-thumb__processing-pct--indeterminate');
      }
      if (barEl) {
        barEl.classList.remove('history-thumb__progress-bar--indeterminate');
        barEl.classList.remove('expanded-thumb__progress-bar--indeterminate');
      }
    }

    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
  });
}

/**
 * Generate a prompt fingerprint for lineage grouping
 */
function promptFingerprint(input = '') {
  const normalized = (input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
}

// ============================================================================
// ERROR MODAL FOR EXPIRED/OLD MODELS
// ============================================================================

/**
 * Check if an error message indicates an expired or unavailable model
 */
function isExpiredModelError(message) {
  if (!message || typeof message !== 'string') return false;
  const lowerMsg = message.toLowerCase();
  return (
    lowerMsg.includes('preview task not found') ||
    lowerMsg.includes('task not found') ||
    lowerMsg.includes('source task id not found') ||
    lowerMsg.includes('not yet ready') ||
    lowerMsg.includes('model url not found') ||
    lowerMsg.includes('input_task_id') && lowerMsg.includes('not found')
  );
}

/**
 * Show a styled error modal for job failures
 * @param {string} title - Modal title
 * @param {string} message - Main message
 * @param {string} [suggestion] - Optional suggestion text
 * @param {string} [icon] - Optional icon (emoji or HTML)
 */
function showErrorModal(title, message, suggestion = '', icon = '') {
  // Remove any existing error modal
  const existing = document.getElementById('timrx-error-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'timrx-error-modal';
  modal.className = 'modal show';
  modal.style.cssText = 'z-index: 10000;';

  modal.innerHTML = `
    <div class="modal-panel" style="max-width: 480px; text-align: center;">
      ${icon ? `<div style="font-size: 48px; margin-bottom: 16px;">${icon}</div>` : ''}
      <h3 style="color: #fca5a5; margin-bottom: 12px;">${title}</h3>
      <p class="modal-desc" style="margin-bottom: 16px; line-height: 1.6;">${message}</p>
      ${suggestion ? `<p style="color: #94a3b8; font-size: 13px; margin-bottom: 20px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">${suggestion}</p>` : ''}
      <div class="modal-actions" style="justify-content: center;">
        <button class="btn-submit" id="timrx-error-modal-close" style="min-width: 120px;">Got it</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  // Close handlers
  const closeModal = () => {
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
    setTimeout(() => modal.remove(), 200);
  };

  modal.querySelector('#timrx-error-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // ESC key
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      window.removeEventListener('keydown', escHandler);
    }
  };
  window.addEventListener('keydown', escHandler);
}

/**
 * Show user-friendly error for expired/old models
 * @param {string} operation - 'refine', 'remesh', 'texture', or 'rig'
 */
function showExpiredModelError(operation = 'process') {
  const opNames = {
    refine: 'refine',
    remesh: 'remesh',
    texture: 'retexture',
    rig: 'rig'
  };
  const opName = opNames[operation] || operation;

  showErrorModal(
    'Model No Longer Available',
    `This model's original data has expired on Meshy's servers and can no longer be ${opName}d.`,
    `<strong>What you can do:</strong><br>
    • Generate a new model with the same prompt<br>
    • Use a recently created model instead<br>
    • Download and re-upload the GLB file if you have it saved`,
    '⏰'
  );
}

/**
 * Handle job failure - shows appropriate modal or alert
 * @param {string} message - Error message from server
 * @param {string} operation - Operation type (refine, texture, etc.)
 * @returns {boolean} true if handled with modal, false if used alert
 */
function handleJobFailure(message, operation = '') {
  if (isExpiredModelError(message)) {
    showExpiredModelError(operation);
    return true;
  }
  // Fall back to regular alert for other errors
  alert(message || 'Job failed');
  return false;
}

/**
 * Get the currently active history item
 */
export function getActiveHistoryItem() {
  const history = State.getHistory();
  if (!history.length) return null;
  if (State.historyActiveModelId) {
    const active = history.find((x) => x && x.id === State.historyActiveModelId);
    if (active) return active;
  }
  return history[0] || null;
}

/**
 * Build source object for Meshy API from a history item
 */
function buildMeshySourceFromItem(item = {}) {
  if (!item) return {};
  const taskId = item.id || item.preview_task_id || item.preview_task || item.source_task_id;
  const modelUrl = item.glb_url || item.glb_proxy;
  if (modelUrl) return { model_url: modelUrl };
  if (taskId) return { input_task_id: taskId };
  return {};
}

/**
 * Get remesh form values from the UI
 */
function getRemeshFormValues() {
  const polyInput = byId('targetPolyCount');
  const modeInput = byId('remeshMode');
  let target_polycount = parseInt(polyInput?.value || '0', 10);
  if (!Number.isFinite(target_polycount) || target_polycount <= 0) target_polycount = 45000;
  const remeshMode = (modeInput?.value || '').toLowerCase();
  const topology = remeshMode.includes('quad') ? 'quad' : 'triangle';
  return {
    target_polycount,
    topology,
    target_formats: ['glb']
  };
}

/**
 * Get texture form values from the UI
 */
function getTextureFormValues() {
  const prompt = (byId('texturePrompt')?.value || '').trim();
  const textureType = (byId('textureType')?.value || 'pbr-all').toLowerCase();
  const seamlessInput = byId('seamless');
  const seamless = seamlessInput ? !!seamlessInput.checked : true;
  const enable_pbr = textureType === 'pbr-all';
  return {
    text_style_prompt: prompt,
    enable_pbr,
    enable_original_uv: seamless,
    ai_model: 'latest'
  };
}

/**
 * Get rig form values from the UI
 */
async function getRigFormValues() {
  const heightInput = byId('rigHeight');
  let height_meters = parseFloat(heightInput?.value || '1.7');
  if (!Number.isFinite(height_meters) || height_meters <= 0) height_meters = 1.7;
  let texture_image_url = '';
  const texFile = byId('rigTextureUpload')?.files?.[0];
  if (texFile) {
    texture_image_url = await fileToDataURL(texFile);
  }
  return { height_meters, texture_image_url };
}

/**
 * Add a generating placeholder to history
 */
function addGeneratingPlaceholder(jobId, meta = {}) {
  if (State.historyHasJobId(jobId)) {
    State.updateHistoryItem(jobId, {
      status: meta.status_label?.includes('Refin') ? 'refining' : meta.status_label?.includes('Remesh') ? 'remeshing' : meta.stage === 'texture' ? 'texturing' : meta.stage === 'rig' ? 'rigging' : meta.type === 'image' ? 'generating' : 'generating',
      status_label: meta.status_label || 'Generating...',
      stage: meta.stage || 'preview',
      prompt: meta.prompt || '',
      root_prompt: meta.root_prompt || meta.prompt || '',
      title: meta.prompt ? meta.prompt.slice(0, 50) + (meta.prompt.length > 50 ? '...' : '') : meta.status_label || 'Generating...',
      thumbnail_url: meta.thumbnail_url || '',
      type: meta.type || 'model'
    });
    return;
  }
  const isRefine = meta.status_label?.includes('Refin');
  const isRemesh = meta.status_label?.includes('Remesh');
  let statusType = isRefine ? 'refining' : isRemesh ? 'remeshing' : 'generating';
  if (meta.stage === 'texture') statusType = 'texturing';
  if (meta.stage === 'rig') statusType = 'rigging';
  if (meta.type === 'image') statusType = 'generating';
  const stage = meta.stage || (isRefine ? 'refine' : isRemesh ? 'remesh' : 'preview');

  const placeholder = {
    id: jobId,
    type: meta.type || 'model',
    status: statusType,
    status_label: meta.status_label || 'Generating...',
    created_at: Date.now(),
    prompt: meta.prompt || '',
    root_prompt: meta.root_prompt || meta.prompt || '',
    title: meta.prompt ? meta.prompt.slice(0, 50) + (meta.prompt.length > 50 ? '...' : '') : meta.status_label || 'Generating...',
    art_style: meta.art_style || 'realistic',
    model: meta.model || 'latest',
    license: meta.license || 'private',
    batch_count: meta.batch_count || 1,
    batch_slot: meta.batch_slot || 1,
    batch_group_id: meta.batch_group_id || null,
    stage,
    thumbnail_url: meta.thumbnail_url || '',
    glb_url: '',
    glb_proxy: '',
    lineage_root_id: meta.lineage_origin_id || meta.batch_group_id || jobId
  };

  State.addHistoryItem(placeholder);
  State.historyFreshThumbs.add(jobId);
  renderHistory();
}

// ============================================================================
// JOB WATCHERS
// ============================================================================

/**
 * Watch a text-to-3D job until completion
 */
export function watchJob(job_id) {
  if (State.watchers.has(job_id)) return;

  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(job_id, ctl);

  const prog = UI.makeProgressDriver();
  let notFoundAttempts = 0;

  const poll = async (delay = 900) => {
    if (aborted) return;
    try {
      const result = await apiFetch(`/api/_mod/text-to-3d/status/${job_id}`);
      if (result.status === 404) {
        notFoundAttempts += 1;
        if (notFoundAttempts <= 5) {
          setTimeout(() => poll(Math.min(1500, delay)), 1000);
          return;
        }
        State.removeActiveJob(job_id);
        prog.clear();
        return;
      }
      notFoundAttempts = 0;
      const st = result.data;

      if (st.message) prog.label(st.message);
      if (typeof st.pct === 'number') {
        const pct = Math.min(98, Math.max(0, st.pct));
        prog.jump(pct);
        updateThumbnailProgress(job_id, pct);
      }

      if (st.status === 'done' && st.glb_url) {
        const meta = State.getPendingMeta()[job_id] || {};
        State.removeActiveJob(job_id);

        // Update wallet - use returned data or refresh from API (once per job)
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (st.wallet && window.WorkspaceCredits?.updateWallet) {
            window.WorkspaceCredits.updateWallet(st.wallet);
          } else {
            refreshCreditsInBackground(); // Fallback: refresh from API
          }
        }

        // Use S3 URL directly if available (no proxy needed), otherwise proxy Meshy URLs
        const glbProxy = getLoadableModelUrl(st.glb_url);
        log('Job done:', { st, glbProxy, isS3: isTimrxS3Url(st.glb_url) });

        const title = shortTitle(meta);
        const stage = st.stage || 'preview';
        const previewTaskIdForHistory =
          st.preview_task_id || (stage === 'preview' ? job_id : (meta.preview_task_id || null));
        const lineageOverride = meta.lineage_origin_id || null;
        const rootPrompt = meta.root_prompt || meta.prompt || '';
        const promptHash = promptFingerprint(rootPrompt);
        const lineageRootId = lineageOverride || previewTaskIdForHistory || job_id;

        const historyData = {
          id: job_id,
          type: 'model',
          status: 'finished',
          created_at: normalizeEpochMs(st.created_at),
          prompt: meta.prompt || '',
          root_prompt: rootPrompt,
          prompt_fingerprint: promptHash,
          title,
          art_style: meta.art_style || 'realistic',
          model: meta.model || 'latest',
          license: meta.license || 'private',
          symmetry_mode: meta.symmetry_mode || 'auto',
          is_a_t_pose: !!meta.is_a_t_pose,
          batch_count: Math.max(1, parseInt(meta.batch_count, 10) || 1),
          batch_slot: meta.batch_slot || 1,
          batch_group_id: meta.batch_group_id || null,
          stage,
          thumbnail_url: st.thumbnail_url || '',
          glb_url: st.glb_url,
          glb_proxy: glbProxy,
          preview_task_id: previewTaskIdForHistory,
          lineage_root_id: lineageRootId
        };

        if (State.historyHasJobId(job_id)) {
          State.updateHistoryItem(job_id, historyData);
        } else {
          State.addHistoryItem(historyData);
        }

        State.historyState.page = 1;
        State.historyFreshThumbs.add(job_id);
        setTimeout(() => {
          State.historyFreshThumbs.delete(job_id);
          renderHistory();
        }, 1800);
        State.setHistoryActiveModelId(job_id);
        renderHistory();

        prog.jump(99, 'Downloading model...');
        await Viewer.loadModelWithFallback(glbProxy, st.glb_url);
        prog.done(st.stage === 'refine' ? 'Loaded refined model.' : 'Loaded preview model.');
        return;
      }

      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
        // Refresh credits (once per job) to show released credits
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          refreshCreditsInBackground();
        }
        prog.fail(st.message || 'Job failed');
        handleJobFailure(st.message || 'Job failed', 'refine');
        return;
      }

      setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
    } catch {
      setTimeout(() => poll(1500), 1500);
    }
  };
  poll();
}

/**
 * Watch a Meshy task (remesh, texture, rig, image3d)
 */
export function watchMeshyTask(job_id, kind = 'remesh') {
  if (State.watchers.has(job_id)) return;
  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(job_id, ctl);

  const endpoint = kind === 'texture'
    ? '/api/_mod/mesh/retexture'
    : kind === 'rig'
      ? '/api/_mod/mesh/rigging'
      : kind === 'image3d'
        ? '/api/_mod/image-to-3d/status'
        : '/api/_mod/mesh/remesh';

  const stageLabel = kind === 'texture'
    ? 'Texturing'
    : kind === 'rig'
      ? 'Rigging'
      : kind === 'image3d'
        ? 'Image to 3D'
        : 'Remeshing';

  const prog = UI.makeProgressDriver();

  // For image3d, simulate progress since Meshy API doesn't return real progress
  const startTime = Date.now();
  const estimatedDuration = kind === 'image3d' ? 120000 : 60000; // 2 mins for image3d, 1 min for others
  let simulatedPct = 0;

  const poll = async (delay = 900) => {
    if (aborted) return;
    try {
      const result = await apiFetch(`${endpoint}/${job_id}`);
      if (result.status === 404) {
        State.removeActiveJob(job_id);
        prog.clear();
        return;
      }
      const st = result.data;

      // Use real progress if available, otherwise simulate for image3d
      if (typeof st.pct === 'number' && st.pct > 0) {
        const pct = Math.min(98, Math.max(0, st.pct));
        prog.jump(pct);
        updateThumbnailProgress(job_id, pct);
      } else if (kind === 'image3d' && st.status !== 'done' && st.status !== 'failed') {
        // Simulate progress for image3d (asymptotic approach to 95%)
        const elapsed = Date.now() - startTime;
        simulatedPct = Math.min(95, Math.floor(95 * (1 - Math.exp(-elapsed / estimatedDuration))));
        prog.jump(simulatedPct);
        updateThumbnailProgress(job_id, simulatedPct);
      }

      if (st.status === 'done') {
        const meta = State.getPendingMeta()[job_id] || {};
        State.removeActiveJob(job_id);

        // Update wallet - use returned data or refresh from API (once per job)
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (st.wallet && window.WorkspaceCredits?.updateWallet) {
            window.WorkspaceCredits.updateWallet(st.wallet);
          } else {
            refreshCreditsInBackground(); // Fallback: refresh from API
          }
        }

        const glbDirect = st.glb_url
          || st.rigged_character_glb_url
          || (st.model_urls && st.model_urls.glb)
          || '';
        // Use S3 URL directly if available (no proxy needed), otherwise proxy Meshy URLs
        const glbProxy = glbDirect ? getLoadableModelUrl(glbDirect) : '';
        const existingItem = State.getHistory().find((x) => x.id === job_id) || {};
        const existingPrompt = existingItem.prompt || '';
        const existingRootPrompt = existingItem.root_prompt || '';
        const existingTitle = existingItem.title || '';
        const promptFromStatus = st.prompt || st.root_prompt || '';
        const promptCandidate = meta.prompt || promptFromStatus || existingPrompt || '';
        const rootPromptCandidate = meta.root_prompt || st.root_prompt || meta.prompt || promptFromStatus || existingRootPrompt || '';
        let titleCandidate = shortTitle(meta);
        if (!titleCandidate || titleCandidate === '(untitled)') {
          const promptForTitle = promptCandidate || rootPromptCandidate || '';
          titleCandidate = promptForTitle ? shortTitle(promptForTitle) : '';
        }
        if (!titleCandidate || titleCandidate === '(untitled)') {
          titleCandidate = existingTitle && existingTitle !== '(untitled)' ? existingTitle : '';
        }
        const fingerprintSource = rootPromptCandidate || promptCandidate || existingRootPrompt || existingPrompt || '';
        const lineageRootId = meta.lineage_origin_id || meta.lineage_root_id || meta.preview_task_id || job_id;

        const historyData = {
          id: job_id,
          type: 'model',
          status: 'finished',
          created_at: normalizeEpochMs(st.created_at),
          art_style: meta.art_style || 'realistic',
          model: meta.model || 'latest',
          license: meta.license || 'private',
          stage: kind,
          thumbnail_url: st.thumbnail_url || meta.thumbnail_url || '',
          glb_url: glbDirect,
          glb_proxy: glbProxy,
          preview_task_id: meta.preview_task_id || null,
          lineage_root_id: lineageRootId,
          texture_urls: st.texture_urls || [],
          model_urls: st.model_urls || {},
          rigged_character_glb_url: st.rigged_character_glb_url,
          rigged_character_fbx_url: st.rigged_character_fbx_url,
          basic_animations: st.basic_animations || []
        };
        if (promptCandidate) historyData.prompt = promptCandidate;
        if (rootPromptCandidate) historyData.root_prompt = rootPromptCandidate;
        if (titleCandidate) historyData.title = titleCandidate;
        if (fingerprintSource) historyData.prompt_fingerprint = promptFingerprint(fingerprintSource);

        if (State.historyHasJobId(job_id)) State.updateHistoryItem(job_id, historyData);
        else State.addHistoryItem(historyData);

        State.setHistoryActiveModelId(job_id);
        State.historyFreshThumbs.add(job_id);
        setTimeout(() => {
          State.historyFreshThumbs.delete(job_id);
          renderHistory();
        }, 1800);
        renderHistory();

        if (glbDirect) {
          prog.jump(99, 'Downloading model...');
          await Viewer.loadModelWithFallback(glbProxy || glbDirect, glbDirect);
          prog.done(`${stageLabel} complete.`);
        } else {
          prog.done(`${stageLabel} complete.`);
        }
        return;
      }

      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
        // Refresh credits (once per job) to show released credits
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          refreshCreditsInBackground();
        }
        prog.fail(st.message || `${stageLabel} failed`);
        handleJobFailure(st.message || `${stageLabel} failed`, kind);
        return;
      }

      setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
    } catch {
      setTimeout(() => poll(1500), 1500);
    }
  };
  poll();
}

/**
 * Watch an OpenAI image generation job until completion
 */
export function watchOpenAIImageJob(jobId, reservationId, meta = {}) {
  if (State.watchers.has(jobId)) return;
  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(jobId, ctl);

  const prog = UI.makeProgressDriver();
  const startTime = Date.now();
  const estimatedDuration = 45000;

  const poll = async (delay = 900) => {
    if (aborted) return;
    try {
      const result = await apiFetch(`/api/_mod/image/openai/status/${jobId}`);
      if (result.status === 404) {
        setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
        return;
      }

      const st = result.data || {};
      if (st.message) prog.label(st.message);

      if (st.status !== 'done' && st.status !== 'failed') {
        const elapsed = Date.now() - startTime;
        const pct = Math.min(95, Math.floor(95 * (1 - Math.exp(-elapsed / estimatedDuration))));
        prog.jump(pct);
        updateThumbnailProgress(jobId, pct);
      }

      if (st.status === 'done') {
        let imageUrl = preferHttpUrl(st.image_urls || st.image_url || null);
        if (!imageUrl && st.image_base64) {
          imageUrl = `data:image/png;base64,${st.image_base64}`;
        }
        if (!imageUrl) {
          throw new Error('OpenAI did not return an image URL');
        }

        const historyData = {
          id: jobId,
          type: 'image',
          status: 'finished',
          created_at: Date.now(),
          prompt: meta.prompt || '',
          title: shortTitle(meta.prompt || 'Generated image'),
          image_url: imageUrl,
          thumbnail_url: imageUrl,
          stage: 'image',
          provider: 'openai',
          provider_used: meta.provider_used || 'openai'  // Locked provider for this job
        };

        if (State.historyHasJobId(jobId)) {
          State.updateHistoryItem(jobId, historyData);
        } else {
          State.addHistoryItem(historyData);
        }

        State.setHistoryActiveModelId(jobId);
        renderHistory();
        Viewer.showImageInViewer(imageUrl);
        prog.done('Image ready.');

        confirmCreditsReservation(reservationId, jobId);
        refreshCreditsInBackground();

        // Unlock UI after job completes
        if (window.ImageJobControl?.unlock) {
          window.ImageJobControl.unlock();
        }
        return;
      }

      if (st.status === 'failed') {
        releaseCreditsReservation(reservationId);
        prog.fail(st.error || 'Image generation failed');
        alert(st.error || 'Image generation failed');
        State.deleteHistoryItem(jobId, { skipRemote: true });

        // Unlock UI after job fails
        if (window.ImageJobControl?.unlock) {
          window.ImageJobControl.unlock();
        }
        return;
      }

      setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
    } catch (err) {
      setTimeout(() => poll(1500), 1500);
    }
  };

  poll();
}

// ============================================================================
// MESHY TASK STARTER (shared)
// ============================================================================

/**
 * Begin a Meshy task (remesh, texture, rig)
 */
async function beginMeshyTask(kind, payload, meta = {}) {
  // Check credits before proceeding
  if (!checkCreditsFor(kind)) {
    return;
  }

  const endpoint = kind === 'texture'
    ? '/api/_mod/mesh/retexture'
    : kind === 'rig'
      ? '/api/_mod/mesh/rigging'
      : '/api/_mod/mesh/remesh';
  const statusLabel = kind === 'texture' ? 'Texturing...' : kind === 'rig' ? 'Rigging...' : 'Remeshing...';
  const prog = UI.makeProgressDriver();

  // Reserve credits BEFORE API call
  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction(kind, 1);
  if (reservation.insufficient) {
    return; // Insufficient credits modal shown
  }

  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `temp-${kind}-${Date.now()}`);
  const tempMeta = { ...meta, stage: kind };
  const startingLabel = `Starting ${statusLabel.replace(/\.+$/, '').toLowerCase()}...`;
  addGeneratingPlaceholder(tempId, { ...tempMeta, status_label: startingLabel, stage: kind });
  State.savePendingMeta(tempId, tempMeta);

  prog.label(statusLabel);

  let result;
  try {
    result = await apiFetch(endpoint, {
      method: 'POST',
      body: payload
    });
  } catch (err) {
    // Network errors (not timeout) - release reservation
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    throw err;
  }

  if (!result.ok) {
    // Handle timeout gracefully - DON'T release reservation (backend handles it)
    if (handleGenerationTimeout(result, kind)) {
      return; // Don't throw, don't release - job may still be processing
    }
    if (handleApiError(result, kind, reservation.reservationId)) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      return;
    }
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    throw new Error(result.error || `HTTP ${result.status}`);
  }
  const data = result.data;
  const { job_id } = data;

  if (!job_id) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    throw new Error('No job id returned');
  }

  State.deleteHistoryItem(tempId, { skipRemote: true });
  State.deletePendingMeta(tempId);

  // Confirm reservation now that we have a job_id
  confirmCreditsReservation(reservation.reservationId, job_id);

  State.addActiveJob(job_id);
  State.savePendingMeta(job_id, { ...meta, stage: kind, source_model_id: meta.source_model_id || meta.id });
  addGeneratingPlaceholder(job_id, { ...meta, status_label: statusLabel, stage: kind });
  watchMeshyTask(job_id, kind);
}

// ============================================================================
// GENERATION TRIGGERS
// ============================================================================

/**
 * Start text-to-3D generation
 */
export async function onGenerateClick() {
  if (startLock) return;

  // Get batch count first for credit check
  const batchRaw = parseInt(byId('modelBatchCount')?.value || '1', 10);
  const batchCount = Math.min(4, Math.max(1, Number.isFinite(batchRaw) ? batchRaw : 1));

  // Check credits for entire batch before proceeding
  if (!checkCreditsFor('text-to-3d', batchCount)) {
    return;
  }

  startLock = true;

  const allGenBtns = document.querySelectorAll('button[id*="generate"]');
  allGenBtns.forEach(btn => btn.setAttribute('disabled', ''));

  const prog = UI.makeProgressDriver();

  // Track reservations for cleanup on failure
  const reservations = [];

  try {
    let promptTextarea = byId('modelPrompt') || byId('imagePrompt') || byId('texturePrompt') || byId('videoMotion');

    if (byId('text3d') && byId('image3d')) {
      const text3dTab = byId('text3d');
      const image3dTab = byId('image3d');
      if (text3dTab && !text3dTab.classList.contains('hidden')) {
        promptTextarea = byId('modelPrompt');
      } else if (image3dTab && !image3dTab.classList.contains('hidden')) {
        promptTextarea = null;
      }
    }

    const prompt = (promptTextarea?.value || '').trim();
    if (!prompt) {
      prog.clear();
      alert('Please type a prompt describing what you want to generate.');
      return;
    }

    const art_style = byId('modelArtStyle')?.value || byId('artStyle')?.value || 'realistic';
    const model = byId('modelAIModel')?.value || byId('modelSelect')?.value || 'latest';
    const license = (byId('modelLicense')?.value || 'private').trim() || 'private';
    const symmetry = (byId('modelSymmetry')?.value || 'auto').trim() || 'auto';
    const isPose = !!byId('modelPoseToggle')?.checked;
    const batchGroupId = createBatchGroupId();

    log('Generating with:', { prompt, art_style, model, batchCount, symmetry, isPose, license });

    const queueOne = async (slot) => {
      // Reserve credits for this job BEFORE API call
      prog.label(batchCount > 1
        ? `Reserving credits for preview ${slot + 1}/${batchCount}...`
        : 'Reserving credits...');

      const reservation = reserveCreditsForAction('text-to-3d', 1);
      if (reservation.insufficient) {
        return null; // Insufficient credits modal shown
      }
      reservations.push(reservation);

      prog.label(batchCount > 1
        ? `Generating preview ${slot + 1}/${batchCount}...`
        : 'Generating...');

      const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `temp-${Date.now()}-${slot}`);
      const tempMeta = {
        prompt,
        art_style,
        model,
        root_prompt: prompt,
        license,
        symmetry_mode: symmetry,
        is_a_t_pose: isPose,
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        stage: 'preview',
        status_label: 'Starting...'
      };
      addGeneratingPlaceholder(tempId, tempMeta);
      State.savePendingMeta(tempId, tempMeta);

      const payload = {
        prompt,
        art_style,
        model,
        symmetry_mode: symmetry,
        is_a_t_pose: isPose,
        license,
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        refine: false
      };

      const result = await apiFetch('/api/_mod/text-to-3d/start', {
        method: 'POST',
        body: payload
      });

      if (!result.ok) {
        // Handle timeout gracefully - DON'T release reservation (backend handles it)
        if (handleGenerationTimeout(result, 'text-to-3d')) {
          return null; // Don't throw, don't release - job may still be processing
        }
        if (handleApiError(result, 'text-to-3d', reservation.reservationId)) {
          State.deleteHistoryItem(tempId, { skipRemote: true });
          State.deletePendingMeta(tempId);
          return null;
        }
        // Release reservation on other (non-timeout) errors
        releaseCreditsReservation(reservation.reservationId);
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.deletePendingMeta(tempId);
        throw new Error(result.error || `HTTP ${result.status}`);
      }
      const data = result.data;
      const { job_id } = data;

      if (!job_id) {
        releaseCreditsReservation(reservation.reservationId);
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.deletePendingMeta(tempId);
        throw new Error('No job id returned');
      }

      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);

      // Confirm reservation now that we have a job_id
      confirmCreditsReservation(reservation.reservationId, job_id);

      State.addActiveJob(job_id);
      const jobMeta = {
        prompt,
        art_style,
        model,
        root_prompt: prompt,
        license,
        symmetry_mode: symmetry,
        is_a_t_pose: isPose,
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId
      };
      State.savePendingMeta(job_id, jobMeta);
      addGeneratingPlaceholder(job_id, jobMeta);
      watchJob(job_id);
      return job_id;
    };

    for (let i = 0; i < batchCount; i++) {
      const result = await queueOne(i);
      if (result === null) return; // 402 error handled or insufficient credits
    }

  } catch (err) {
    console.error(err);
    prog.fail(err?.message || String(err));
    alert(`Generation failed: ${err?.message || err}`);
    // Release any remaining reservations on error
    reservations.forEach(r => {
      if (r.reservationId) releaseCreditsReservation(r.reservationId);
    });
  } finally {
    startLock = false;
    const allGenBtns = document.querySelectorAll('button[id*="generate"]');
    allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
  }
}

// Flat credit cost for images
const IMAGE_CREDITS = 10;

// Map simplified aspect to OpenAI resolution
const OPENAI_RESOLUTION_MAP = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024'
};

/**
 * Start OpenAI image generation
 */
export async function startOpenAIImageGeneration() {
  if (startLock) return;

  // Check if already generating (job state lock)
  if (window.ImageJobControl?.isGenerating?.()) {
    console.warn('[OpenAI Image] Generation already in progress');
    return;
  }

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(IMAGE_CREDITS, 'image');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'image');
    return;
  }

  startLock = true;

  const prog = UI.makeProgressDriver();
  let promptRaw = (byId('imagePrompt')?.value || '').trim();
  if (!promptRaw) promptRaw = 'Generated image';

  // Get settings from UI (simplified)
  const settings = window.ImageJobControl?.getSettings?.() || {
    provider: 'openai',
    aspect: byId('imageAspectRatio')?.value || 'square',
    quality: byId('imageQuality')?.value || 'standard'
  };

  // Map aspect to OpenAI resolution
  const resolution = OPENAI_RESOLUTION_MAP[settings.aspect] || '1024x1024';
  const model = 'gpt-image-1';

  // Snapshot settings for this job
  const settingsSnapshot = {
    prompt: promptRaw,
    aspect: settings.aspect,
    quality: settings.quality,
    resolution,
    model,
    credits: IMAGE_CREDITS
  };

  // Reserve EXACT credits BEFORE API call (not multiplied by action cost)
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount('text-to-image', IMAGE_CREDITS);
  if (reservation.insufficient) {
    startLock = false;
    showInsufficientCreditsModal(IMAGE_CREDITS, creditCheck.available, 'image');
    return;
  }

  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `openai-temp-${Date.now()}`);

  // Lock UI with provider and settings snapshot
  if (window.ImageJobControl?.lock) {
    window.ImageJobControl.lock('openai', settingsSnapshot, tempId, reservation.reservationId);
  }

  State.historyState.filter = 'image';
  State.historyState.page = 1;
  renderHistory();

  const placeholder = {
    id: tempId,
    type: 'image',
    status: 'generating',
    status_label: 'Generating image...',
    created_at: Date.now(),
    prompt: promptRaw,
    title: shortTitle(promptRaw),
    image_url: '',
    thumbnail_url: '',
    stage: 'image',
    provider: 'openai',
    provider_used: 'openai'  // Locked provider for this job
  };
  State.addHistoryItem(placeholder);
  State.setHistoryActiveModelId(tempId);
  renderHistory();

  let activeHistoryId = tempId;

  try {
    prog.label('Queueing image...');

    // Debug log before API call
    const payload = {
      prompt: promptRaw,
      size: resolution,
      model,
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=openai cost=' + IMAGE_CREDITS +
                ' available=' + creditCheck.available + ' payload=' + JSON.stringify(payload));

    const result = await apiFetch('/api/_mod/image/openai', {
      method: 'POST',
      body: payload
    });

    if (!result.ok) {
      // Handle timeout gracefully - DON'T release reservation (backend handles it)
      if (handleGenerationTimeout(result, 'text-to-image')) {
        // Update placeholder to show "still generating" state
        State.updateHistoryItem(tempId, { status_label: 'Still generating...' });
        renderHistory();
        prog.label('Still generating...');
        return; // Don't throw, don't release - job may still be processing
      }
      if (handleApiError(result, 'text-to-image', reservation.reservationId)) {
        // Clean up placeholder on credits error
        const arr = State.getHistory().filter((x) => x.id !== tempId);
        State.saveHistory(arr);
        renderHistory();
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error || `OpenAI HTTP ${result.status}`);
    }
    const data = result.data;
    const jobId = data.job_id || data.image_id;
    if (!jobId) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No job id returned');
    }

    if (jobId !== tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      activeHistoryId = jobId;
    }

    const queuedPlaceholder = {
      ...placeholder,
      id: activeHistoryId,
      status: 'generating',
      status_label: 'Generating image...'
    };

    if (State.historyHasJobId(activeHistoryId)) {
      State.updateHistoryItem(activeHistoryId, queuedPlaceholder);
    } else {
      State.addHistoryItem(queuedPlaceholder);
    }

    State.setHistoryActiveModelId(activeHistoryId);
    renderHistory();

    State.savePendingMeta(activeHistoryId, {
      prompt: promptRaw,
      model,
      size: resolution,
      stage: 'image'
    });

    // Pass provider info to watcher for proper unlock
    watchOpenAIImageJob(activeHistoryId, reservation.reservationId, {
      prompt: promptRaw,
      model,
      size: resolution,
      provider_used: 'openai'
    });
    // Note: UI unlock will happen in watchOpenAIImageJob when job completes
  } catch (err) {
    console.error('[OpenAI] Error:', err);
    prog.fail(err?.message || 'Image generation failed');
    alert(err?.message || 'Image generation failed.');
    // Clean up placeholder on error
    const arr = State.getHistory().filter((x) => x.id !== activeHistoryId);
    State.saveHistory(arr);
    renderHistory();
    // Unlock UI on error
    if (window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  } finally {
    startLock = false;
  }
}

// Map simplified aspect to Google format
const GOOGLE_ASPECT_MAP = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9'
};

// Map simplified quality to Google imageSize
const GOOGLE_QUALITY_MAP = {
  standard: '1K',
  high: '2K'
};

/**
 * Start Gemini (Google Imagen) image generation
 */
export async function startGeminiImageGeneration() {
  if (startLock) return;

  // Check if already generating (job state lock)
  if (window.ImageJobControl?.isGenerating?.()) {
    console.warn('[Gemini Image] Generation already in progress');
    return;
  }

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(IMAGE_CREDITS, 'image');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'image');
    return;
  }

  startLock = true;

  const prog = UI.makeProgressDriver();
  let promptRaw = (byId('imagePrompt')?.value || '').trim();
  if (!promptRaw) promptRaw = 'Generated image';

  // Get settings from UI (simplified)
  const settings = window.ImageJobControl?.getSettings?.() || {
    provider: 'google',
    aspect: byId('imageAspectRatio')?.value || 'square',
    quality: byId('imageQuality')?.value || 'standard'
  };

  // Map to Google-specific formats
  const aspectRatio = GOOGLE_ASPECT_MAP[settings.aspect] || '1:1';
  const imageSize = GOOGLE_QUALITY_MAP[settings.quality] || '1K';

  // Snapshot settings for this job
  const settingsSnapshot = {
    prompt: promptRaw,
    aspect: settings.aspect,
    quality: settings.quality,
    aspectRatio,
    imageSize,
    credits: IMAGE_CREDITS
  };

  // Reserve EXACT credits BEFORE API call (not multiplied by action cost)
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount('text-to-image', IMAGE_CREDITS);
  if (reservation.insufficient) {
    startLock = false;
    showInsufficientCreditsModal(IMAGE_CREDITS, creditCheck.available, 'image');
    return;
  }

  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `gemini-temp-${Date.now()}`);

  // Lock UI with provider and settings snapshot
  if (window.ImageJobControl?.lock) {
    window.ImageJobControl.lock('google', settingsSnapshot, tempId, reservation.reservationId);
  }

  State.historyState.filter = 'image';
  State.historyState.page = 1;
  renderHistory();

  const placeholder = {
    id: tempId,
    type: 'image',
    status: 'generating',
    status_label: 'Generating image with Imagen...',
    created_at: Date.now(),
    prompt: promptRaw,
    title: shortTitle(promptRaw),
    image_url: '',
    thumbnail_url: '',
    stage: 'image',
    provider: 'google',
    provider_used: 'google'  // Locked provider for this job
  };
  State.addHistoryItem(placeholder);
  State.setHistoryActiveModelId(tempId);
  renderHistory();

  try {
    prog.label('Generating image with Gemini...');

    // Debug log before API call
    const payload = {
      provider: 'google',
      prompt: promptRaw,
      aspect_ratio: aspectRatio,
      image_size: imageSize,
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=google cost=' + IMAGE_CREDITS +
                ' available=' + creditCheck.available + ' payload=' + JSON.stringify(payload));

    // Call unified endpoint with provider=google
    const result = await apiFetch('/api/image/generate', {
      method: 'POST',
      body: payload
    });

    if (!result.ok) {
      // Handle timeout gracefully
      if (handleGenerationTimeout(result, 'text-to-image')) {
        State.updateHistoryItem(tempId, { status_label: 'Still generating...' });
        renderHistory();
        prog.label('Still generating...');
        return;
      }
      if (handleApiError(result, 'text-to-image', reservation.reservationId)) {
        const arr = State.getHistory().filter((x) => x.id !== tempId);
        State.saveHistory(arr);
        renderHistory();
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error?.message || result.error || `Gemini image failed: HTTP ${result.status}`);
    }

    const data = result.data;
    const imageId = data.image_id || data.job_id;
    const imageUrl = data.image_url;

    if (!imageUrl) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No image returned from Gemini');
    }

    // Gemini returns image synchronously - update history immediately
    const finalItem = {
      id: imageId || tempId,
      type: 'image',
      status: 'finished',
      status_label: '',
      created_at: Date.now(),
      prompt: promptRaw,
      title: shortTitle(promptRaw),
      image_url: imageUrl,
      thumbnail_url: imageUrl,
      stage: 'image',
      provider: 'google',
      provider_used: 'google',  // Locked provider for this job
      model: 'imagen-4.0'
    };

    // Replace temp placeholder with final item
    if (imageId && imageId !== tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.addHistoryItem(finalItem);
      State.setHistoryActiveModelId(imageId);
    } else {
      State.updateHistoryItem(tempId, finalItem);
    }

    renderHistory();
    prog.done('Image generated!');

    // Update balance from response
    if (data.new_balance !== undefined && window.WorkspaceCredits?.setCredits) {
      window.WorkspaceCredits.setCredits(data.new_balance);
    }

  } catch (err) {
    console.error('[Gemini Image] Error:', err);
    prog.fail(err?.message || 'Gemini image generation failed');
    alert(err?.message || 'Gemini image generation failed.');
    // Clean up placeholder on error
    const arr = State.getHistory().filter((x) => x.id !== tempId);
    State.saveHistory(arr);
    renderHistory();
  } finally {
    startLock = false;
    // Unlock UI after generation completes/fails
    if (window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  }
}

/**
 * Start image generation by selected provider
 */
export async function startImageGenerationByProvider() {
  // Use GenerationState as single source of truth for provider
  const provider = window.GenerationState?.getProvider?.('image') ||
                   (byId('imageAIProvider')?.value || 'openai').toLowerCase();

  State.historyState.filter = 'image';
  State.historyState.page = 1;
  renderHistory();

  if (provider === 'openai') {
    await startOpenAIImageGeneration();
  } else if (provider === 'google') {
    await startGeminiImageGeneration();
  } else {
    alert(`Image provider "${provider}" is not yet available. Use "openai" or "google".`);
  }
}

/**
 * Video credit calculation constants (must match 3dprint-app.js)
 */
const VIDEO_BASE_CREDITS = { 4: 30, 6: 45, 8: 60 };
const VIDEO_QUALITY_MULTIPLIER = { standard: 1.0, high: 1.5 };
const VIDEO_AUDIO_ADDON = 30;

// Map simplified aspect to API format
const VIDEO_ASPECT_MAP = {
  landscape: '16:9',
  square: '1:1',
  portrait: '9:16'
};

/**
 * Compute video credits based on settings (simplified)
 * @param {Object} settings - { durationSec, quality, addAudio }
 * @returns {number} Total credits
 */
function computeVideoCredits(settings) {
  const base = VIDEO_BASE_CREDITS[settings.durationSec] || 30;
  const mult = VIDEO_QUALITY_MULTIPLIER[settings.quality] || 1.0;
  let cost = Math.round(base * mult);
  if (settings.addAudio) {
    cost += VIDEO_AUDIO_ADDON;
  }
  return cost;
}

/**
 * Start video generation (Google Veo)
 */
export async function startVideoGeneration() {
  if (startLock) return;

  // Get video settings from UI (use window.VideoJobControl if available, else read directly)
  const settings = window.VideoJobControl?.getSettings?.() || {
    durationSec: parseInt(byId('videoDuration')?.value || '4', 10),
    quality: byId('videoQuality')?.value || 'standard',
    aspect: byId('videoAspectRatio')?.value || 'landscape',
    aspectRatio: VIDEO_ASPECT_MAP[byId('videoAspectRatio')?.value] || '16:9',
    loop: byId('videoLoop')?.checked ?? true,
    addAudio: byId('videoAudio')?.checked ?? false,
    mode: byId('videoModeValue')?.value || 'text2video'
  };

  const motion = (byId('videoMotion')?.value || '').trim();
  const prompt = (byId('videoTextPrompt')?.value || '').trim();

  // Compute credits using the SAME formula as UI
  const totalCredits = computeVideoCredits(settings);

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(totalCredits, 'video');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'video');
    return;
  }

  startLock = true;

  const prog = UI.makeProgressDriver();

  // Reserve the EXACT computed credits (not multiplied by action cost)
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount('video', totalCredits);
  if (reservation.insufficient) {
    startLock = false;
    showInsufficientCreditsModal(totalCredits, creditCheck.available, 'video');
    return;
  }

  State.historyState.filter = 'video';
  State.historyState.page = 1;
  renderHistory();

  const tempId = crypto?.randomUUID ? crypto.randomUUID() : `video-temp-${Date.now()}`;
  const placeholder = {
    id: tempId,
    type: 'video',
    status: 'generating',
    status_label: 'Generating video...',
    created_at: Date.now(),
    prompt: prompt || motion || 'Video generation',
    title: shortTitle(prompt || motion || 'Video'),
    video_url: '',
    thumbnail_url: '',
    stage: 'video',
    provider: 'google',
    provider_used: 'google',
    credits_used: totalCredits
  };
  State.addHistoryItem(placeholder);
  State.setHistoryActiveModelId(tempId);
  renderHistory();

  try {
    prog.label('Generating video with Veo...');

    // Build payload with simplified settings
    const payload = {
      provider: 'google',
      task: settings.mode,
      prompt: prompt,
      duration_sec: settings.durationSec,
      aspect_ratio: settings.aspectRatio,
      quality: settings.quality,
      motion: motion,
      audio: settings.addAudio,
      loop: settings.loop
    };

    // Debug log before API call
    console.log('[GEN] mode=video provider=google cost=' + totalCredits +
                ' available=' + creditCheck.available + ' payload=' + JSON.stringify(payload));

    const result = await apiFetch('/api/video/generate', {
      method: 'POST',
      body: payload
    });

    if (!result.ok) {
      if (handleApiError(result, 'video', reservation.reservationId)) {
        const arr = State.getHistory().filter((x) => x.id !== tempId);
        State.saveHistory(arr);
        renderHistory();
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error?.message || result.error || `Video generation failed: HTTP ${result.status}`);
    }

    const data = result.data;
    const jobId = data.job_id || data.video_id;

    if (!jobId) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No job ID returned');
    }

    // Update placeholder with real job ID
    if (jobId !== tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
    }

    const queuedPlaceholder = {
      ...placeholder,
      id: jobId,
      status: 'generating',
      status_label: 'Generating video...'
    };

    if (State.historyHasJobId(jobId)) {
      State.updateHistoryItem(jobId, queuedPlaceholder);
    } else {
      State.addHistoryItem(queuedPlaceholder);
    }

    State.setHistoryActiveModelId(jobId);
    renderHistory();

    // Watch the video job
    watchVideoJob(jobId, reservation.reservationId, {
      prompt: prompt || motion,
      duration_sec: settings.durationSec,
      quality: settings.quality,
      aspect_ratio: settings.aspectRatio,
      stage: 'video'
    });

  } catch (err) {
    console.error('[Video] Error:', err);
    prog.fail(err?.message || 'Video generation failed');
    alert(err?.message || 'Video generation failed.');
    const arr = State.getHistory().filter((x) => x.id !== tempId);
    State.saveHistory(arr);
    renderHistory();
  } finally {
    startLock = false;
  }
}

/**
 * Watch a video generation job for completion
 */
async function watchVideoJob(jobId, reservationId, meta) {
  const POLL_INTERVAL = 5000;
  const MAX_POLLS = 180; // 15 minutes max

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    try {
      const result = await apiFetch(`/api/video/generate/status/${encodeURIComponent(jobId)}`);

      if (!result.ok) {
        console.warn('[Video] Status check failed:', result.error);
        continue;
      }

      const data = result.data;
      const status = data.status;

      if (status === 'done') {
        // Finalize credits
        finalizeCreditsReservation(reservationId, jobId);

        // Update history
        State.updateHistoryItem(jobId, {
          status: 'finished',
          status_label: '',
          video_url: data.video_url,
          thumbnail_url: data.thumbnail_url,
          stage: 'video',
          type: 'video'
        });
        renderHistory();

        // Update balance
        if (data.new_balance !== undefined && window.WorkspaceCredits?.setCredits) {
          window.WorkspaceCredits.setCredits(data.new_balance);
        }

        UI.makeProgressDriver().done('Video generated!');
        return;
      }

      if (status === 'failed') {
        releaseCreditsReservation(reservationId);
        State.updateHistoryItem(jobId, {
          status: 'failed',
          status_label: data.message || 'Video generation failed'
        });
        renderHistory();
        UI.makeProgressDriver().fail(data.message || 'Video generation failed');
        return;
      }

      // Still processing - update progress
      if (data.progress !== undefined) {
        State.updateHistoryItem(jobId, {
          status: 'generating',
          status_label: `Generating... ${data.progress}%`
        });
        renderHistory();
      }

    } catch (err) {
      console.warn('[Video] Poll error:', err);
    }
  }

  // Timeout
  releaseCreditsReservation(reservationId);
  State.updateHistoryItem(jobId, {
    status: 'failed',
    status_label: 'Video generation timed out'
  });
  renderHistory();
}

/**
 * Start image-to-3D from a history item
 */
export async function startImageTo3DFromHistory(item) {
  if (!item || !item.image_url) {
    alert('No image found to convert to 3D.');
    return;
  }

  // Check credits before proceeding
  if (!checkCreditsFor('image-to-3d')) {
    return;
  }

  const prompt = item.prompt || item.title || 'Image to 3D';
  const meta = {
    prompt: `(image2-3d) ${prompt}`,
    root_prompt: prompt,
    art_style: 'realistic',
    model: 'latest',
    stage: 'image3d',
    thumbnail_url: item.thumbnail_url || item.image_url || ''
  };

  const prog = UI.makeProgressDriver();

  // Reserve credits BEFORE API call
  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction('image-to-3d', 1);
  if (reservation.insufficient) {
    return; // Insufficient credits modal shown
  }

  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `image3d-temp-${Date.now()}`);
  const tempMeta = { ...meta, type: 'model' };
  addGeneratingPlaceholder(tempId, { ...tempMeta, status_label: 'Starting image to 3D...', type: 'model' });
  State.savePendingMeta(tempId, tempMeta);

  prog.label('Starting image to 3D...');
  try {
    const result = await apiFetch('/api/_mod/image-to-3d/start', {
      method: 'POST',
      body: { image_url: item.image_url, prompt }
    });

    if (!result.ok) {
      // Handle timeout gracefully - DON'T release reservation (backend handles it)
      if (handleGenerationTimeout(result, 'image-to-3d')) {
        return; // Don't throw, don't release - job may still be processing
      }
      if (handleApiError(result, 'image-to-3d', reservation.reservationId)) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.deletePendingMeta(tempId);
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      throw new Error(result.error || `HTTP ${result.status}`);
    }
    const data = result.data;
    const { job_id } = data;

    if (!job_id) {
      releaseCreditsReservation(reservation.reservationId);
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      throw new Error('No job id returned');
    }

    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);

    // Confirm reservation now that we have a job_id
    confirmCreditsReservation(reservation.reservationId, job_id);

    State.addActiveJob(job_id);
    State.savePendingMeta(job_id, { ...meta, type: 'model' });
    addGeneratingPlaceholder(job_id, { ...meta, status_label: 'Generating from image...', type: 'model' });
    watchMeshyTask(job_id, 'image3d');
  } catch (err) {
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    prog.fail(err?.message || 'Image to 3D failed');
    alert(err?.message || 'Image to 3D failed');
  }
}

// ============================================================================
// POST-PROCESS FROM HISTORY (Refine)
// ============================================================================

/**
 * Refine a preview model
 */
export async function onPostProcessFromHistory(item, type) {
  if (postProcessLock) return;
  if (!item) return;

  // Check credits before proceeding (remesh check happens in beginMeshyTask)
  if (type === 'refine' && !checkCreditsFor('refine')) {
    return;
  }

  postProcessLock = true;
  const prog = UI.makeProgressDriver();

  // For remesh, delegate to the function that uses beginMeshyTask
  if (type === 'remesh') {
    try {
      await startRemeshFromHistory(item);
    } finally {
      postProcessLock = false;
    }
    return;
  }

  if (type !== 'refine') {
    postProcessLock = false;
    throw new Error('Unknown post-process type');
  }

  // Reserve credits BEFORE API call
  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction('refine', 1);
  if (reservation.insufficient) {
    postProcessLock = false;
    return; // Insufficient credits modal shown
  }

  let tempId = null;

  prog.label('Starting refine...');

  try {
    const previewTaskIdFromItem = item.preview_task_id || (item.stage === 'preview' ? item.id : null);
    const previewTaskId = previewTaskIdFromItem;

    if (!previewTaskId) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error("Cannot refine: preview task id is missing and this card isn't a preview.");
    }

    const jobMeta = {
      prompt: `(${type}) ${item.prompt || item.title}`,
      art_style: item.art_style || 'realistic',
      model: item.model || 'latest',
      preview_task_id: previewTaskId || previewTaskIdFromItem || null,
      root_prompt: item.root_prompt || item.prompt || item.title || '',
      lineage_origin_id: item.lineage_root_id || item.id || null,
      license: item.license || 'private',
      symmetry_mode: item.symmetry_mode || 'auto',
      is_a_t_pose: !!item.is_a_t_pose,
      batch_count: 1,
      batch_group_id: item.lineage_root_id || item.id
    };

    tempId = (crypto?.randomUUID ? crypto.randomUUID() : `refine-temp-${Date.now()}`);
    addGeneratingPlaceholder(tempId, {
      ...jobMeta,
      status_label: 'Starting refine...'
    });
    State.savePendingMeta(tempId, jobMeta);

    const result = await apiFetch('/api/_mod/text-to-3d/refine', {
      method: 'POST',
      body: {
        preview_task_id: previewTaskId,
        model: item.model || 'meshy-6',
        enable_pbr: true
      }
    });

    if (!result.ok) {
      if (handleApiError(result, 'refine', reservation.reservationId)) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.deletePendingMeta(tempId);
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      throw new Error(result.error || `HTTP ${result.status}`);
    }
    const data = result.data;
    const { job_id } = data;

    if (!job_id) {
      releaseCreditsReservation(reservation.reservationId);
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      throw new Error(`No job id returned for ${type}`);
    }

    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);

    // Confirm reservation now that we have a job_id
    confirmCreditsReservation(reservation.reservationId, job_id);

    State.addActiveJob(job_id);
    State.savePendingMeta(job_id, jobMeta);
    addGeneratingPlaceholder(job_id, {
      ...jobMeta,
      status_label: 'Refining...'
    });
    watchJob(job_id);
  } catch (e) {
    if (tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
    }
    prog.fail(`${type} failed`);
    console.error(e);
    alert(e.message || `${type} failed`);
  } finally {
    postProcessLock = false;
  }
}

// ============================================================================
// PANEL-BASED OPERATIONS (Remesh, Texture, Rig)
// ============================================================================

/**
 * Start remesh from the panel UI
 */
export async function startRemeshFromPanel() {
  if (startLock) return;
  const choice = byId('remeshModelSelect')?.value || 'current';
  const baseItem = choice === 'current' ? getActiveHistoryItem() : null;

  if (choice === 'current' && !baseItem) {
    alert('Load or generate a model before remeshing.');
    return;
  }

  let source = {};
  let labelPrompt = '';
  if (choice === 'upload') {
    const file = byId('remeshModelUpload')?.files?.[0];
    if (!file) { alert('Please choose a model to remesh.'); return; }
    const dataUrl = await fileToDataURL(file);
    source = { model_url: dataUrl };
    labelPrompt = `Remesh ${file.name}`;
  } else if (baseItem) {
    source = buildMeshySourceFromItem(baseItem);
    labelPrompt = `Remesh ${shortTitle(baseItem)}`;
  }

  const remeshValues = getRemeshFormValues();
  const meta = {
    prompt: labelPrompt || remeshValues.text_style_prompt || 'Remesh',
    root_prompt: baseItem?.root_prompt || baseItem?.prompt || '',
    art_style: baseItem?.art_style || 'realistic',
    model: baseItem?.model || 'latest',
    license: baseItem?.license || 'private',
    lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
    source_model_id: baseItem?.id || null
  };

  try {
    await beginMeshyTask('remesh', { ...source, ...remeshValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Remesh failed.');
  }
}

/**
 * Start texture from the panel UI
 */
export async function startTextureFromPanel() {
  if (startLock) return;
  const choice = byId('textureModelSelect')?.value || 'current';
  const baseItem = choice === 'current' ? getActiveHistoryItem() : null;
  if (choice === 'current' && !baseItem) {
    alert('Load or generate a model before texturing.');
    return;
  }

  let source = {};
  let labelPrompt = '';
  if (choice === 'upload') {
    const file = byId('textureModelUpload')?.files?.[0];
    if (!file) { alert('Please choose a model to texture.'); return; }
    const dataUrl = await fileToDataURL(file);
    source = { model_url: dataUrl };
    labelPrompt = `Texture ${file.name}`;
  } else if (baseItem) {
    source = buildMeshySourceFromItem(baseItem);
    labelPrompt = `Texture ${shortTitle(baseItem)}`;
  }

  const texValues = getTextureFormValues();
  if (!texValues.text_style_prompt) {
    alert('Please describe the texture you want.');
    return;
  }

  const meta = {
    prompt: texValues.text_style_prompt,
    root_prompt: baseItem?.root_prompt || baseItem?.prompt || texValues.text_style_prompt,
    art_style: baseItem?.art_style || 'realistic',
    model: baseItem?.model || 'latest',
    license: baseItem?.license || 'private',
    lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
    source_model_id: baseItem?.id || null,
    thumbnail_url: baseItem?.thumbnail_url || ''
  };

  try {
    await beginMeshyTask('texture', { ...source, ...texValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Texture generation failed.');
  }
}

/**
 * Start rig from the panel UI
 */
export async function startRigFromPanel() {
  if (startLock) return;
  const choice = byId('rigModelSelect')?.value || 'current';
  const baseItem = choice === 'current' ? getActiveHistoryItem() : null;
  if (choice === 'current' && !baseItem) {
    alert('Load or generate a humanoid model before rigging.');
    return;
  }

  let source = {};
  let labelPrompt = '';
  if (choice === 'upload') {
    const file = byId('rigModelUpload')?.files?.[0];
    if (!file) { alert('Please choose a humanoid GLB/GLTF to rig.'); return; }
    const dataUrl = await fileToDataURL(file);
    source = { model_url: dataUrl };
    labelPrompt = `Rig ${file.name}`;
  } else if (baseItem) {
    source = buildMeshySourceFromItem(baseItem);
    labelPrompt = `Rig ${shortTitle(baseItem)}`;
  }

  const rigValues = await getRigFormValues();
  const meta = {
    prompt: labelPrompt || 'Rig character',
    root_prompt: baseItem?.root_prompt || baseItem?.prompt || labelPrompt,
    art_style: baseItem?.art_style || 'realistic',
    model: baseItem?.model || 'latest',
    license: baseItem?.license || 'private',
    lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
    source_model_id: baseItem?.id || null,
    thumbnail_url: baseItem?.thumbnail_url || ''
  };

  try {
    await beginMeshyTask('rig', { ...source, ...rigValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Rigging failed.');
  }
}

// ============================================================================
// HISTORY-BASED OPERATIONS (Remesh, Texture, Rig)
// ============================================================================

/**
 * Start remesh from a history item
 */
export async function startRemeshFromHistory(item) {
  if (!item) return;
  State.setHistoryActiveModelId(item.id);
  const source = buildMeshySourceFromItem(item);
  const remeshValues = getRemeshFormValues();
  const meta = {
    prompt: `Remesh ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || '',
    art_style: item.art_style || 'realistic',
    model: item.model || 'latest',
    license: item.license || 'private',
    lineage_origin_id: item.lineage_root_id || item.id,
    source_model_id: item.id,
    thumbnail_url: item.thumbnail_url || ''
  };
  try {
    await beginMeshyTask('remesh', { ...source, ...remeshValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Remesh failed.');
  }
}

/**
 * Start texture from a history item
 */
export async function startTextureFromHistory(item) {
  if (!item) return;
  State.setHistoryActiveModelId(item.id);
  const source = buildMeshySourceFromItem(item);
  const texValues = getTextureFormValues();
  if (!texValues.text_style_prompt) {
    texValues.text_style_prompt = item.prompt || `Texture ${shortTitle(item)}`;
  }
  const meta = {
    prompt: texValues.text_style_prompt || `Texture ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || texValues.text_style_prompt || '',
    art_style: item.art_style || 'realistic',
    model: item.model || 'latest',
    license: item.license || 'private',
    lineage_origin_id: item.lineage_root_id || item.id,
    source_model_id: item.id,
    thumbnail_url: item.thumbnail_url || ''
  };
  try {
    await beginMeshyTask('texture', { ...source, ...texValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Texture generation failed.');
  }
}

/**
 * Start rig from a history item
 */
export async function startRigFromHistory(item) {
  if (!item) return;
  State.setHistoryActiveModelId(item.id);
  const source = buildMeshySourceFromItem(item);
  const rigValues = await getRigFormValues();
  const meta = {
    prompt: `Rig ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || '',
    art_style: item.art_style || 'realistic',
    model: item.model || 'latest',
    license: item.license || 'private',
    lineage_origin_id: item.lineage_root_id || item.id,
    source_model_id: item.id,
    thumbnail_url: item.thumbnail_url || ''
  };
  try {
    await beginMeshyTask('rig', { ...source, ...rigValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Rigging failed.');
  }
}

// ============================================================================
// RESUME PENDING JOBS ON PAGE LOAD
// ============================================================================

/**
 * Fetch backend job IDs to verify active jobs
 */
async function fetchBackendJobIds() {
  try {
    const result = await apiFetch('/api/_mod/text-to-3d/list');
    if (!result.ok) return null;
    const payload = result.data;
    if (!Array.isArray(payload)) return [];
    return payload
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === 'string') return entry.trim();
        if (typeof entry === 'object') return entry.job_id || entry.id || null;
        return null;
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Failed to fetch backend job list:', err);
    return null;
  }
}

/**
 * Resume watching any jobs that were in progress
 */
export async function resumePendingJobs(options = {}) {
  const { skipEmptyUI = false } = options;
  let pendingMeta = State.getPendingMeta();
  let ids = State.getActiveJobs();
  if (!ids.length) {
    const history = State.getHistory();
    const resumable = history.filter(item => {
      if (!item || !item.id) return false;
      const status = (item.status || '').toLowerCase();
      if (status && status !== 'finished' && status !== 'failed') return true;
      return false;
    });
    ids = resumable.map(item => item.id);
    ids.forEach(id => State.addActiveJob(id));
    resumable.forEach(item => {
      if (!pendingMeta[item.id]) {
        State.savePendingMeta(item.id, {
          stage: item.stage || (item.type === 'image' ? 'image' : 'remesh'),
          type: item.type || 'model',
          prompt: item.prompt || '',
          root_prompt: item.root_prompt || item.prompt || '',
          title: item.title || '',
          thumbnail_url: item.thumbnail_url || ''
        });
      }
    });
    pendingMeta = State.getPendingMeta();
  }
  if (ids.length) {
    const history = State.getHistory();
    ids.forEach((id) => {
      const meta = pendingMeta?.[id];
      if (meta && meta.stage) return;
      const item = history.find(entry => entry && entry.id === id);
      if (!item) return;
      State.savePendingMeta(id, {
        stage: item.stage || (item.type === 'image' ? 'image' : 'remesh'),
        type: item.type || 'model',
        prompt: item.prompt || '',
        root_prompt: item.root_prompt || item.prompt || '',
        title: item.title || '',
        thumbnail_url: item.thumbnail_url || ''
      });
    });
    pendingMeta = State.getPendingMeta();
  }
  if (!ids.length) {
    if (!skipEmptyUI) UI.showOutputEmpty();
    return;
  }
  const meshIds = [];
  const imageIds = [];
  const textIds = [];

  ids.forEach((id) => {
    const stage = pendingMeta?.[id]?.stage;
    if (stage === 'remesh' || stage === 'texture' || stage === 'rig' || stage === 'image3d') {
      meshIds.push(id);
    } else if (stage === 'image') {
      imageIds.push(id);
    } else {
      textIds.push(id);
    }
  });

  // Verify text-to-3d jobs still exist on backend
  if (textIds.length) {
    const remoteIds = await fetchBackendJobIds();
    if (remoteIds !== null) {
      const validIds = textIds.filter(id => remoteIds.includes(id));
      const staleIds = textIds.filter(id => !remoteIds.includes(id));
      staleIds.forEach(id => State.removeActiveJob(id));
      textIds.length = 0;
      textIds.push(...validIds);
    }
  }

  // OpenAI image jobs are synchronous (no polling) - if we refresh mid-request,
  // they can't be resumed. Mark them as failed and clean up.
  if (imageIds.length) {
    log(`[Resume] Cleaning up ${imageIds.length} stale image job(s) - cannot resume synchronous requests`);
    imageIds.forEach(id => {
      State.removeActiveJob(id);
      // Mark as failed in history so user knows it didn't complete
      if (State.historyHasJobId(id)) {
        State.updateHistoryItem(id, {
          status: 'failed',
          status_label: 'Interrupted - please retry'
        });
      }
    });
    renderHistory();
  }

  const allToResume = [...meshIds, ...textIds];
  if (!allToResume.length) {
    if (!skipEmptyUI) UI.showOutputEmpty();
    return;
  }

  log(`Resuming ${allToResume.length} pending job(s)`);

  for (const id of meshIds) {
    const stage = pendingMeta[id]?.stage || 'remesh';
    watchMeshyTask(id, stage);
  }

  for (const id of textIds) {
    watchJob(id);
  }
}

// ============================================================================
// EXPOSE GLOBALLY (for backward compatibility)
// ============================================================================
window.watchJob = watchJob;
window.watchMeshyTask = watchMeshyTask;
window.startTextureFromHistory = startTextureFromHistory;
window.startRemeshFromHistory = startRemeshFromHistory;
window.startRigFromHistory = startRigFromHistory;
window.startImageTo3DFromHistory = startImageTo3DFromHistory;
window.onGenerateClick = onGenerateClick;
window.startVideoGeneration = startVideoGeneration;
window.getActiveHistoryItem = getActiveHistoryItem;
