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

    // Show modal with proper focus management
    if (typeof window.openCreditsModal === 'function') {
      window.openCreditsModal();
    } else {
      // Fallback if helper not loaded yet
      modalEl.classList.remove('hidden');
      modalEl.style.display = 'flex';
      modalEl.inert = false;
    }
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
 * Handle API response errors, specifically 402 insufficient credits, 429 quota exceeded, and 400 expired models
 * @returns {boolean} true if error was handled (should stop), false to continue with normal error
 */
function handleApiError(response, action, reservationId = null) {
  // Extract error message from various possible locations in the response
  // Priority: data.error (backend message) > data.error.message > error (apiFetch fallback)
  // Skip generic "HTTP XXX" errors from apiFetch fallback when we have data.error
  const dataError = response.data?.error;
  const dataErrorMsg = typeof dataError === 'string' ? dataError : dataError?.message;
  const apiFetchError = response.error;
  const isGenericHttpError = typeof apiFetchError === 'string' && /^HTTP \d+$/.test(apiFetchError);

  // Prefer data error over generic HTTP error
  const errorMsg = dataErrorMsg || (isGenericHttpError ? '' : apiFetchError) || '';

  // Handle 402 Insufficient Credits - check for video credits FIRST
  if (response.status === 402) {
    log('[Credits] 402 Insufficient credits for:', action);

    // Release any reservation on 402
    if (reservationId) {
      releaseCreditsReservation(reservationId);
    }

    // Check if this is specifically a VIDEO credits error
    const insufficientCreditsMatch = parseInsufficientCreditsError(errorMsg);
    if (insufficientCreditsMatch) {
      log('[Credits] Parsed credits error:', insufficientCreditsMatch);
      if (insufficientCreditsMatch.creditType === 'video') {
        showInsufficientVideoCreditsModal(
          insufficientCreditsMatch.required,
          insufficientCreditsMatch.available
        );
        return true;
      }
      // General credits error with parsed values
      showInsufficientCreditsModal(
        insufficientCreditsMatch.required,
        insufficientCreditsMatch.available,
        action
      );
      return true;
    }

    // Fallback: generic insufficient credits handling
    if (window.WorkspaceCredits) {
      window.WorkspaceCredits.showInsufficientCreditsMessage(action);
    } else {
      alert('Insufficient credits. Please purchase more credits to continue.');
    }
    return true;
  }

  // Handle 429 quota exceeded errors
  if (response.status === 429) {
    log('[Quota] 429 Rate limit exceeded for:', action);
    if (reservationId) {
      releaseCreditsReservation(reservationId);
    }
    if (window.showQuotaExceededPopup) {
      window.showQuotaExceededPopup();
    } else {
      alert('Daily video generation limit reached. Please try again tomorrow.');
    }
    return true;
  }

  // Also check for quota errors in error message (some APIs return 400/500 with quota message)
  const isQuotaError = typeof errorMsg === 'string' && (
    errorMsg.toLowerCase().includes('quota') ||
    errorMsg.toLowerCase().includes('resource_exhausted') ||
    errorMsg.toLowerCase().includes('exceeded your current quota')
  );
  if (isQuotaError) {
    log('[Quota] Quota error detected for:', action, errorMsg);
    if (reservationId) {
      releaseCreditsReservation(reservationId);
    }
    if (window.showQuotaExceededPopup) {
      window.showQuotaExceededPopup();
    } else {
      alert('Daily video generation limit reached. Please try again tomorrow.');
    }
    return true;
  }

  // Handle 400 errors for expired/unavailable models and credit errors
  if (response.status === 400) {
    if (isExpiredModelError(errorMsg)) {
      log('[Model] 400 Expired/unavailable model for:', action);
      if (reservationId) {
        releaseCreditsReservation(reservationId);
      }
      showExpiredModelError(action);
      return true;
    }

    // Check for insufficient credits errors (video or general) - some backends return 400 instead of 402
    const insufficientCreditsMatch = parseInsufficientCreditsError(errorMsg);
    if (insufficientCreditsMatch) {
      log('[Credits] 400 Insufficient credits for:', action, insufficientCreditsMatch);
      if (reservationId) {
        releaseCreditsReservation(reservationId);
      }
      if (insufficientCreditsMatch.creditType === 'video') {
        showInsufficientVideoCreditsModal(
          insufficientCreditsMatch.required,
          insufficientCreditsMatch.available
        );
      } else {
        showInsufficientCreditsModal(
          insufficientCreditsMatch.required,
          insufficientCreditsMatch.available,
          action
        );
      }
      return true;
    }
  }

  return false;
}

/**
 * Parse insufficient credits error from backend error message
 * Format: INSUFFICIENT_VIDEO_CREDITS:required=60:balance=0:reserved=0:available=0
 * or: INSUFFICIENT_GENERAL_CREDITS:required=N:balance=N:reserved=N:available=N
 *
 * @param {string} errorMsg - The error message from backend
 * @returns {object|null} - { creditType, required, balance, reserved, available } or null
 */
function parseInsufficientCreditsError(errorMsg) {
  if (!errorMsg || typeof errorMsg !== 'string') {
    return null;
  }

  // Check for video credits error
  const videoMatch = errorMsg.match(/INSUFFICIENT_VIDEO_CREDITS:required=(\d+):balance=(\d+):reserved=(\d+):available=(\d+)/);
  if (videoMatch) {
    return {
      creditType: 'video',
      required: parseInt(videoMatch[1], 10),
      balance: parseInt(videoMatch[2], 10),
      reserved: parseInt(videoMatch[3], 10),
      available: parseInt(videoMatch[4], 10),
    };
  }

  // Check for general credits error
  const generalMatch = errorMsg.match(/INSUFFICIENT_GENERAL_CREDITS:required=(\d+):balance=(\d+):reserved=(\d+):available=(\d+)/);
  if (generalMatch) {
    return {
      creditType: 'general',
      required: parseInt(generalMatch[1], 10),
      balance: parseInt(generalMatch[2], 10),
      reserved: parseInt(generalMatch[3], 10),
      available: parseInt(generalMatch[4], 10),
    };
  }

  return null;
}

/**
 * Show insufficient VIDEO credits modal
 * Video credits are separate from general credits - this modal explains that
 * Styled to match the existing insufficientCreditsModal in 3dprint.html
 *
 * @param {number} required - Video credits required for this action
 * @param {number} available - Video credits currently available
 */
function showInsufficientVideoCreditsModal(required, available) {
  const numRequired = Number(required) || 0;
  const numAvailable = Number(available) || 0;
  const numNeeded = Math.max(0, numRequired - numAvailable);

  // Close modal helper
  const closeVideoCreditsModal = () => {
    const modal = document.getElementById('insufficientVideoCreditsModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('show');
      modal.style.display = 'none';
      modal.style.opacity = '0';
      modal.style.visibility = 'hidden';
      modal.inert = true;
    }
  };

  // Expose globally for onclick handlers
  window.closeVideoCreditsModal = closeVideoCreditsModal;

  // Check if modal already exists
  let modal = document.getElementById('insufficientVideoCreditsModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'insufficientVideoCreditsModal';
    modal.className = 'modal hidden';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:999999;padding:20px;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', 'insuffVideoCreditsTitle');
    modal.setAttribute('inert', '');
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="window.closeVideoCreditsModal()" style="position:absolute;inset:0;cursor:pointer;"></div>
      <div class="modal-content" style="max-width:400px;text-align:center;width:100%;padding:24px;border-radius:20px;background:linear-gradient(135deg,#1a1a1a 0%,#151515 100%);border:1px solid rgba(255,255,255,0.1);box-shadow:0 24px 60px rgba(0,0,0,0.6);position:relative;z-index:1;">
        <div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;border-bottom:none;padding-bottom:0;margin-bottom:0">
          <h2 style="margin:0;font-size:20px;color:#fff">Video Credits Needed</h2>
          <button class="modal-close" onclick="window.closeVideoCreditsModal()" aria-label="Close" style="width:32px;height:32px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#999;display:grid;place-items:center;cursor:pointer;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="modal-body" style="padding:24px 0">
          <div style="width:64px;height:64px;margin:0 auto 16px;background:rgba(139,92,246,0.1);border-radius:50%;display:flex;align-items:center;justify-content:center">
            <i class="fa-solid fa-video" style="font-size:28px;color:#8b5cf6"></i>
          </div>
          <p style="margin:0 0 16px;color:rgba(255,255,255,0.7);font-size:14px;line-height:1.5">
            Video generation requires <strong class="video-credits-required" style="color:#fff">0</strong> video credits.<br>
            You currently have <strong class="video-credits-available" style="color:#fff">0</strong> video credits.
          </p>
          <p style="margin:0;padding:12px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.2);border-radius:8px;font-size:13px;color:rgba(255,255,255,0.6)">
            You need <strong class="video-credits-needed" style="color:#8b5cf6">0</strong> more video credits to continue.
          </p>
        </div>
        <div class="modal-footer" style="display:flex;justify-content:center;gap:10px;border-top:none">
          <button onclick="window.closeVideoCreditsModal()" class="btn-secondary" style="padding:10px 18px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);color:#e0e0e0">Cancel</button>
          <a href="hub.html#video-pricing" class="btn-primary" id="insuffVideoCreditsCtaBtn" style="padding:10px 18px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;background:linear-gradient(135deg,#8b5cf6,#6366f1);border:0;color:#fff;box-shadow:0 4px 12px rgba(139,92,246,.25);text-decoration:none">Buy Video Credits</a>
        </div>
        <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.4)">
          Video credits are separate from general credits.
        </p>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // Update modal content with actual values
  const requiredEl = modal.querySelector('.video-credits-required');
  const availableEl = modal.querySelector('.video-credits-available');
  const neededEl = modal.querySelector('.video-credits-needed');
  if (requiredEl) requiredEl.textContent = numRequired;
  if (availableEl) availableEl.textContent = numAvailable;
  if (neededEl) neededEl.textContent = numNeeded;

  // Show modal - must add 'show' class because .modal CSS has opacity:0 and visibility:hidden
  modal.classList.remove('hidden');
  modal.classList.add('show');
  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.style.visibility = 'visible';
  modal.inert = false;
  modal.removeAttribute('inert');
  document.getElementById('insuffVideoCreditsCtaBtn')?.focus();
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
 * Shows "Still generating..." inline status instead of alert
 * Does NOT release reservation (backend will handle it)
 *
 * @param {object} result - API response from apiFetch
 * @param {string} action - Action name for logging
 * @returns {boolean} true if was timeout (caller should not release reservation)
 */
function handleGenerationTimeout(result, action) {
  if (!isTimeoutError(result)) return false;

  log(`[Timeout] ${action} request timed out - job may still be processing on server`);

  // NO ALERT - caller handles inline UI update and potential polling
  // Credits will only be charged if generation succeeds on backend

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

  // Polling safety: max attempts and error tracking
  const MAX_POLL_ATTEMPTS = 120;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const MAX_DELAY = 8000;
  let pollAttempts = 0;
  let consecutiveErrors = 0;

  const poll = async (delay = 900) => {
    if (aborted) {
      State.watchers.delete(job_id);
      return;
    }

    pollAttempts++;

    // Safety: stop after max attempts
    if (pollAttempts > MAX_POLL_ATTEMPTS) {
      console.error(`[Text-to-3D] Max poll attempts (${MAX_POLL_ATTEMPTS}) exceeded for job ${job_id}`);
      State.removeActiveJob(job_id);
      State.watchers.delete(job_id);
      prog.fail('Generation timed out - please try again');
      handleJobFailure('Generation timed out after max attempts', 'text-to-3d');
      return;
    }

    try {
      const result = await apiFetch(`/api/_mod/text-to-3d/status/${job_id}`);

      // Fatal errors: stop polling immediately
      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        console.error(`[Text-to-3D] Server error (${result.status}) for job ${job_id}:`, result.error);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[Text-to-3D] Too many consecutive errors (${consecutiveErrors}), stopping poll`);
          State.removeActiveJob(job_id);
          State.watchers.delete(job_id);
          prog.fail('Generation failed - server error');
          handleJobFailure(result.error || `Server error (${result.status})`, 'text-to-3d');
          if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          }
          return;
        }

        // Retry with exponential backoff for server errors
        const nextDelay = Math.min(MAX_DELAY, delay * 2);
        setTimeout(() => poll(nextDelay), nextDelay);
        return;
      }

      // 403 Forbidden: access denied, stop polling
      if (result.status === 403) {
        console.error(`[Text-to-3D] Access denied for job ${job_id}`);
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        prog.fail('Generation failed - access denied');
        return;
      }

      if (result.status === 404) {
        notFoundAttempts += 1;
        if (notFoundAttempts <= 5) {
          setTimeout(() => poll(Math.min(1500, delay)), 1000);
          return;
        }
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        prog.clear();
        return;
      }

      // Reset error counters on successful response
      notFoundAttempts = 0;
      consecutiveErrors = 0;

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

        // Update wallet - backend is authoritative (once per job)
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          // Prefer new_balance from response, then wallet object, then force sync
          if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'text_to_3d_done');
          } else if (st.wallet?.available !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.wallet.available, 'text_to_3d_done_wallet');
          } else if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend(); // Force sync - backend is truth
          } else {
            refreshCreditsInBackground();
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
        State.watchers.delete(job_id);
        return;
      }

      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        // Force sync with backend to show released credits (backend is truth)
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          } else {
            refreshCreditsInBackground();
          }
        }
        prog.fail(st.message || 'Job failed');
        handleJobFailure(st.message || 'Job failed', 'refine');
        return;
      }

      // Continue polling with exponential backoff, capped at MAX_DELAY
      const nextDelay = Math.min(MAX_DELAY, delay * 1.2);
      setTimeout(() => poll(nextDelay), delay);
    } catch (err) {
      // Unexpected error - increment error counter and retry with backoff
      consecutiveErrors++;
      console.error(`[Text-to-3D] Unexpected error polling job ${job_id}:`, err);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[Text-to-3D] Too many consecutive errors, stopping poll`);
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        prog.fail('Generation failed - connection error');
        handleJobFailure('Connection error while polling', 'text-to-3d');
        return;
      }

      // Retry with exponential backoff
      const retryDelay = Math.min(MAX_DELAY, delay * 2);
      setTimeout(() => poll(retryDelay), retryDelay);
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

  // Polling safety: max attempts and error tracking
  const MAX_POLL_ATTEMPTS = 120; // ~2-4 minutes depending on backoff
  const MAX_CONSECUTIVE_ERRORS = 5;
  const MAX_DELAY = 8000;
  let pollAttempts = 0;
  let consecutiveErrors = 0;

  const poll = async (delay = 900) => {
    if (aborted) {
      State.watchers.delete(job_id);
      return;
    }

    pollAttempts++;

    // Safety: stop after max attempts
    if (pollAttempts > MAX_POLL_ATTEMPTS) {
      console.error(`[${stageLabel}] Max poll attempts (${MAX_POLL_ATTEMPTS}) exceeded for job ${job_id}`);
      State.removeActiveJob(job_id);
      State.watchers.delete(job_id);
      prog.fail(`${stageLabel} timed out - please try again`);
      handleJobFailure(`${stageLabel} timed out after max attempts`, kind);
      return;
    }

    try {
      const result = await apiFetch(`${endpoint}/${job_id}`);

      // Fatal errors: stop polling immediately
      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        console.error(`[${stageLabel}] Server error (${result.status}) for job ${job_id}:`, result.error);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[${stageLabel}] Too many consecutive errors (${consecutiveErrors}), stopping poll`);
          State.removeActiveJob(job_id);
          State.watchers.delete(job_id);
          prog.fail(`${stageLabel} failed - server error`);
          handleJobFailure(result.error || `Server error (${result.status})`, kind);
          // Sync credits from backend
          if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          }
          return;
        }

        // Retry with exponential backoff for server errors
        const nextDelay = Math.min(MAX_DELAY, delay * 2);
        setTimeout(() => poll(nextDelay), nextDelay);
        return;
      }

      // 403 Forbidden: access denied, stop polling
      if (result.status === 403) {
        console.error(`[${stageLabel}] Access denied for job ${job_id}`);
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        prog.fail(`${stageLabel} failed - access denied`);
        return;
      }

      // 404 Not Found: job doesn't exist, stop polling
      if (result.status === 404) {
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        prog.clear();
        return;
      }

      // Reset error counter on successful response
      consecutiveErrors = 0;

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

        // Update wallet - backend is authoritative (once per job)
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          // Prefer new_balance from response, then wallet object, then force sync
          if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'meshy_done');
          } else if (st.wallet?.available !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.wallet.available, 'meshy_done_wallet');
          } else if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend(); // Force sync - backend is truth
          } else {
            refreshCreditsInBackground();
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
        State.watchers.delete(job_id);
        return;
      }

      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        // Sync credits from backend (once per job) to show released credits
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          } else {
            refreshCreditsInBackground();
          }
        }
        prog.fail(st.message || `${stageLabel} failed`);
        handleJobFailure(st.message || `${stageLabel} failed`, kind);
        State.watchers.delete(job_id);
        return;
      }

      // Continue polling with exponential backoff, capped at MAX_DELAY
      const nextDelay = Math.min(MAX_DELAY, delay * 1.2);
      setTimeout(() => poll(nextDelay), delay);
    } catch (err) {
      // Unexpected error - increment error counter and retry with backoff
      consecutiveErrors++;
      console.error(`[${stageLabel}] Unexpected error polling job ${job_id}:`, err);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[${stageLabel}] Too many consecutive errors, stopping poll`);
        State.removeActiveJob(job_id);
        State.watchers.delete(job_id);
        prog.fail(`${stageLabel} failed - connection error`);
        handleJobFailure('Connection error while polling', kind);
        return;
      }

      // Retry with exponential backoff
      const retryDelay = Math.min(MAX_DELAY, delay * 2);
      setTimeout(() => poll(retryDelay), retryDelay);
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

        // Apply new_balance immediately if returned in status, then sync with backend
        if (st.new_balance !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
          window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'openai_image_done');
        } else if (window.WorkspaceCredits?.syncWithBackend) {
          // Force sync with backend to ensure UI matches DB (backend is truth)
          window.WorkspaceCredits.syncWithBackend();
        } else {
          refreshCreditsInBackground();
        }

        // Unlock UI after job completes
        if (window.ImageJobControl?.unlock) {
          window.ImageJobControl.unlock();
        }
        State.removeActiveJob(jobId);
        return;
      }

      if (st.status === 'failed') {
        releaseCreditsReservation(reservationId);
        // Force sync with backend after failure to ensure UI matches DB (backend is truth)
        if (window.WorkspaceCredits?.syncWithBackend) {
          window.WorkspaceCredits.syncWithBackend();
        } else {
          refreshCreditsInBackground();
        }

        const errorMsg = st.error || 'Image generation failed';
        prog.fail(errorMsg);

        // Update history with failure status (no alert - inline status only)
        State.updateHistoryItem(jobId, {
          status: 'failed',
          status_label: errorMsg
        });
        renderHistory();

        // Unlock UI after job fails
        if (window.ImageJobControl?.unlock) {
          window.ImageJobControl.unlock();
        }
        State.watchers.delete(jobId);
        State.removeActiveJob(jobId);
        return;
      }

      setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
    } catch (err) {
      setTimeout(() => poll(1500), 1500);
    }
  };

  poll();
}

/**
 * Watch a Gemini image generation job until completion
 * Polls /api/image/gemini/status/<job_id> until ready/failed (max 120s)
 */
export function watchGeminiImageJob(jobId, reservationId, meta = {}) {
  if (State.watchers.has(jobId)) return;
  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(jobId, ctl);

  const prog = UI.makeProgressDriver();
  const startTime = Date.now();
  const estimatedDuration = 30000; // Gemini is typically faster
  const maxPollingDuration = 120000; // Max 120 seconds of polling
  let notFoundCount = 0;
  const maxNotFoundRetries = meta.isTimeoutRecovery ? 10 : 5; // More retries for timeout recovery

  const poll = async (delay = 2000) => {
    if (aborted) return;

    // Check if we've exceeded max polling time
    const elapsed = Date.now() - startTime;
    if (elapsed > maxPollingDuration) {
      console.log('[Gemini Image] Max polling duration exceeded');
      prog.fail('Generation timed out. Your credits will be refunded if generation failed.');
      State.updateHistoryItem(jobId, {
        status: 'failed',
        status_label: 'Generation timed out'
      });
      renderHistory();
      // Sync with backend to get actual credit status
      if (window.WorkspaceCredits?.syncWithBackend) {
        window.WorkspaceCredits.syncWithBackend();
      }
      if (window.ImageJobControl?.unlock) {
        window.ImageJobControl.unlock();
      }
      State.watchers.delete(jobId);
      State.removeActiveJob(jobId);
      return;
    }

    try {
      const result = await apiFetch(`/api/_mod/image/gemini/status/${jobId}`);

      if (result.status === 404) {
        notFoundCount++;
        console.log(`[Gemini Image] Job not found (attempt ${notFoundCount}/${maxNotFoundRetries})`);

        // Update inline status
        const pct = Math.min(90, Math.floor(90 * (elapsed / estimatedDuration)));
        prog.jump(pct);
        prog.label('Still generating...');
        updateThumbnailProgress(jobId, pct);

        if (notFoundCount >= maxNotFoundRetries) {
          // Job likely wasn't created - clean up
          console.log('[Gemini Image] Job not found after retries, cleaning up');
          prog.fail('Generation failed - job not found on server');
          State.updateHistoryItem(jobId, {
            status: 'failed',
            status_label: 'Job not found'
          });
          renderHistory();
          releaseCreditsReservation(reservationId);
          if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          }
          if (window.ImageJobControl?.unlock) {
            window.ImageJobControl.unlock();
          }
          State.watchers.delete(jobId);
          State.removeActiveJob(jobId);
          return;
        }

        setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
        return;
      }

      // Reset not found counter on successful response
      notFoundCount = 0;

      const st = result.data || {};
      if (st.message) prog.label(st.message);

      if (st.status !== 'done' && st.status !== 'failed') {
        const pct = Math.min(95, Math.floor(95 * (1 - Math.exp(-elapsed / estimatedDuration))));
        prog.jump(pct);
        prog.label('Generating image...');
        updateThumbnailProgress(jobId, pct);
      }

      if (st.status === 'done') {
        let imageUrl = preferHttpUrl(st.image_urls || st.image_url || null);
        if (!imageUrl && st.image_base64) {
          imageUrl = `data:image/png;base64,${st.image_base64}`;
        }
        if (!imageUrl) {
          throw new Error('Gemini did not return an image URL');
        }

        const historyData = {
          id: jobId,
          type: 'image',
          status: 'finished',
          status_label: '',
          created_at: Date.now(),
          prompt: meta.prompt || '',
          title: shortTitle(meta.prompt || 'Generated image'),
          image_url: imageUrl,
          thumbnail_url: imageUrl,
          stage: 'image',
          provider: 'google',
          provider_used: meta.provider_used || 'google',
          model: st.model || 'imagen-4.0'
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

        // Apply new_balance immediately if returned in status, then sync with backend
        if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
          window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'gemini_image_done');
        } else if (window.WorkspaceCredits?.syncWithBackend) {
          window.WorkspaceCredits.syncWithBackend();
        } else {
          refreshCreditsInBackground();
        }

        if (window.ImageJobControl?.unlock) {
          window.ImageJobControl.unlock();
        }
        State.watchers.delete(jobId);
        State.removeActiveJob(jobId);
        return;
      }

      if (st.status === 'failed') {
        releaseCreditsReservation(reservationId);
        if (window.WorkspaceCredits?.syncWithBackend) {
          window.WorkspaceCredits.syncWithBackend();
        } else {
          refreshCreditsInBackground();
        }

        const errorMsg = st.error || 'Image generation failed';
        prog.fail(errorMsg);

        // Update history with failure status (no alert)
        State.updateHistoryItem(jobId, {
          status: 'failed',
          status_label: errorMsg
        });
        renderHistory();

        if (window.ImageJobControl?.unlock) {
          window.ImageJobControl.unlock();
        }
        State.watchers.delete(jobId);
        State.removeActiveJob(jobId);
        return;
      }

      // Still processing - continue polling
      setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
    } catch (err) {
      console.error('[Gemini Image] Poll error:', err);
      setTimeout(() => poll(2000), 2000);
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

  // Generate idempotency key for this operation
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `temp-${kind}-${Date.now()}`);
  const tempMeta = { ...meta, stage: kind, idempotency_key: idempotencyKey };
  const startingLabel = `Starting ${statusLabel.replace(/\.+$/, '').toLowerCase()}...`;
  addGeneratingPlaceholder(tempId, { ...tempMeta, status_label: startingLabel, stage: kind });
  State.savePendingMeta(tempId, tempMeta);

  prog.label(statusLabel);

  let result;
  try {
    // Include idempotency key in header for duplicate prevention
    result = await apiFetch(endpoint, {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
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
 * Start text-to-3D or image-to-3D generation
 */
export async function onGenerateClick() {
  if (startLock) return;

  // Check if Image to 3D tab is active
  const image3dTab = byId('image3d');
  const isImage3dMode = image3dTab && !image3dTab.classList.contains('hidden');

  if (isImage3dMode) {
    return startImageTo3DFromUpload();
  }

  // Get batch count first for credit check
  const batchRaw = parseInt(byId('modelBatchCount')?.value || '1', 10);
  const batchCount = Math.min(4, Math.max(1, Number.isFinite(batchRaw) ? batchRaw : 1));

  // Check credits for entire batch before proceeding
  if (!checkCreditsFor('text-to-3d', batchCount)) {
    return;
  }

  startLock = true;

  // Dispatch generation:start event (e.g., to close Inspire panel)
  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'text-to-3d' } }));

  const allGenBtns = document.querySelectorAll('button[id*="generate"]');
  allGenBtns.forEach(btn => btn.setAttribute('disabled', ''));

  const prog = UI.makeProgressDriver();

  // Track reservations for cleanup on failure
  const reservations = [];

  try {
    let promptTextarea = byId('modelPrompt') || byId('imagePrompt') || byId('texturePrompt') || byId('videoMotion');
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

      // Generate idempotency key for this specific generation
      const idempotencyKey = State.generateIdempotencyKey();
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
        status_label: 'Starting...',
        idempotency_key: idempotencyKey
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

      // Include idempotency key in header for duplicate prevention
      const result = await apiFetch('/api/_mod/text-to-3d/start', {
        method: 'POST',
        body: payload,
        headers: { 'Idempotency-Key': idempotencyKey }
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

// Map shape to OpenAI gpt-image-1 resolution
// gpt-image-1 only supports: 1024x1024, 1024x1536, 1536x1024
const OPENAI_SHAPE_MAP = {
  square: '1024x1024',      // 1:1
  portrait: '1024x1536',    // 2:3 (portrait)
  landscape: '1536x1024',   // 3:2 (landscape)
};

/**
 * Start OpenAI image generation
 * IMPORTANT: Provider must be 'openai' in GenerationState before calling this.
 */
export async function startOpenAIImageGeneration() {
  // Verify provider is actually openai (defensive check)
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'openai') {
    console.error(`[OpenAI Image] BLOCKED: State provider is '${stateProvider}', not 'openai'`);
    return;
  }

  console.log('[Image] OpenAI generation started (provider=openai, state=' + stateProvider + ')');

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

  // Get settings from State (SINGLE SOURCE OF TRUTH - no DOM fallbacks)
  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const settings = {
    provider: 'openai',
    shape: stateSettings.shape || 'square',
    quality: stateSettings.quality || 'standard'
  };
  console.log('[OpenAI Image] Using settings from State:', JSON.stringify(settings));

  // Map shape to OpenAI resolution
  const resolution = OPENAI_SHAPE_MAP[settings.shape] || '1024x1024';
  const model = 'gpt-image-1';

  // Snapshot settings for this job
  const settingsSnapshot = {
    prompt: promptRaw,
    shape: settings.shape,
    quality: settings.quality,
    resolution,
    model,
    credits: IMAGE_CREDITS
  };

  // Reserve EXACT credits BEFORE API call (not multiplied by action cost)
  // Canonical action key: image_generate -> OPENAI_IMAGE (10 credits)
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount('image_generate', IMAGE_CREDITS);
  if (reservation.insufficient) {
    startLock = false;
    showInsufficientCreditsModal(IMAGE_CREDITS, creditCheck.available, 'image');
    return;
  }

  // Generate idempotency key for this image generation
  const idempotencyKey = State.generateIdempotencyKey();
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
    idempotency_key: idempotencyKey,
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

    // Include idempotency key in header for duplicate prevention
    const result = await apiFetch('/api/_mod/image/openai', {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      // Handle timeout gracefully - DON'T release reservation (backend handles it)
      if (handleGenerationTimeout(result, 'image_generate')) {
        // Update placeholder to show "still generating" state
        State.updateHistoryItem(tempId, { status_label: 'Still generating...' });
        renderHistory();
        prog.label('Still generating...');
        return; // Don't throw, don't release - job may still be processing
      }
      if (handleApiError(result, 'image_generate', reservation.reservationId)) {
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

    // Track as active job for recovery and indicator
    State.addActiveJob(activeHistoryId);
    State.savePendingMeta(activeHistoryId, {
      prompt: promptRaw,
      model,
      size: resolution,
      stage: 'image',
      type: 'image',
      provider: 'openai'
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

// Map shape to Google aspect ratio format
const GOOGLE_SHAPE_MAP = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9',
};

// Map quality to Google imageSize
const GOOGLE_QUALITY_MAP = {
  standard: '1K',
  high: '2K'
};

/**
 * Start Gemini (Google Imagen) image generation
 * IMPORTANT: Provider must be 'google' in GenerationState before calling this.
 */
export async function startGeminiImageGeneration() {
  // Verify provider is actually google (defensive check)
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'google') {
    console.error(`[Gemini Image] BLOCKED: State provider is '${stateProvider}', not 'google'`);
    return;
  }

  console.log('[Image] Gemini generation started (provider=google, state=' + stateProvider + ')');

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

  // Get settings from State (SINGLE SOURCE OF TRUTH - no DOM fallbacks)
  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const settings = {
    provider: 'google',
    shape: stateSettings.shape || 'square',
    quality: stateSettings.quality || 'standard'
  };
  console.log('[Gemini Image] Using settings from State:', JSON.stringify(settings));

  // Map shape to Google aspect ratio, quality to imageSize
  const aspectRatio = GOOGLE_SHAPE_MAP[settings.shape] || '1:1';
  const imageSize = GOOGLE_QUALITY_MAP[settings.quality] || '1K';

  // Snapshot settings for this job
  const settingsSnapshot = {
    prompt: promptRaw,
    shape: settings.shape,
    quality: settings.quality,
    aspectRatio,
    imageSize,
    credits: IMAGE_CREDITS
  };

  // Reserve EXACT credits BEFORE API call (not multiplied by action cost)
  // Canonical action key: image_generate -> OPENAI_IMAGE (10 credits)
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount('image_generate', IMAGE_CREDITS);
  if (reservation.insufficient) {
    startLock = false;
    showInsufficientCreditsModal(IMAGE_CREDITS, creditCheck.available, 'image');
    return;
  }

  // Generate idempotency key for this image generation
  const idempotencyKey = State.generateIdempotencyKey();
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
    provider_used: 'google',  // Locked provider for this job
    idempotency_key: idempotencyKey
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

    // Call unified endpoint with provider=google and idempotency key
    const result = await apiFetch('/api/image/generate', {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      // Handle timeout gracefully - start polling with tempId
      if (handleGenerationTimeout(result, 'image_generate')) {
        console.log('[Gemini Image] Timeout - showing inline status and starting poll');
        State.updateHistoryItem(tempId, {
          status: 'generating',
          status_label: 'Still generating... (checking server)'
        });
        renderHistory();
        prog.label('Still generating...');

        // Try polling with tempId - backend may have created job with our client_id
        // Use a longer polling interval since we're in timeout recovery mode
        watchGeminiImageJob(tempId, reservation.reservationId, {
          prompt: promptRaw,
          provider_used: 'google',
          isTimeoutRecovery: true
        });

        startLock = false;
        return;
      }
      if (handleApiError(result, 'image_generate', reservation.reservationId)) {
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
    const jobStatus = data.status;

    // Handle async response (status: "queued") - start polling
    if (jobStatus === 'queued' && imageId) {
      console.log('[Gemini Image] Job queued, starting watcher:', imageId);

      // Update placeholder with real job ID
      if (imageId !== tempId) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.addHistoryItem({
          id: imageId,
          type: 'image',
          status: 'generating',
          status_label: 'Generating image with Gemini...',
          created_at: Date.now(),
          prompt: promptRaw,
          title: shortTitle(promptRaw),
          image_url: '',
          thumbnail_url: '',
          stage: 'image',
          provider: 'google',
          provider_used: 'google',
          model: 'imagen-4.0'
        });
        State.setHistoryActiveModelId(imageId);
        renderHistory();
      }

      // Use backend reservation_id if provided, otherwise use local
      const backendReservationId = data.reservation_id || reservation.reservationId;

      // Update balance from response (now shows reduced available due to held credits)
      if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
        window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'gemini_image_queued');
      }

      // Track as active job for recovery and indicator
      State.addActiveJob(imageId);
      State.savePendingMeta(imageId, {
        prompt: promptRaw,
        stage: 'image',
        type: 'image',
        provider: 'google'
      });

      // Start polling - watchGeminiImageJob handles unlock on completion/failure
      watchGeminiImageJob(imageId, backendReservationId, {
        prompt: promptRaw,
        provider_used: 'google'
      });

      // Don't unlock here - watcher will do it when job completes
      startLock = false;
      return;
    }

    // Handle sync response (status: "done") - backward compatibility
    if (!imageUrl) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No image returned from Gemini');
    }

    // Gemini returned image synchronously - update history immediately
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

    // Update balance from response - backend is authoritative
    if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
      window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'gemini_image_response');
    } else if (window.WorkspaceCredits?.syncWithBackend) {
      window.WorkspaceCredits.syncWithBackend();
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
    // Only unlock if we didn't start a watcher (watcher handles its own unlock)
    // The watcher path returns early, so if we're here, unlock is needed
    if (window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  }
}

/**
 * Start image generation by selected provider
 * IMPORTANT: Uses GenerationState as the SINGLE source of truth for provider.
 * Never reads from DOM - provider must be set via dropdown -> GenerationState.setProvider()
 * NO AUTO-FALLBACK: If provider fails, show error - do not silently switch providers.
 */
export async function startImageGenerationByProvider() {
  // Dispatch generation:start event (e.g., to close Inspire panel)
  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'image' } }));

  // SINGLE SOURCE OF TRUTH: GenerationState.getProvider()
  // No DOM fallback - if state is unavailable, something is wrong
  if (!window.GenerationState?.getProvider) {
    console.error('[Image] GenerationState not available - cannot determine provider');
    alert('Image generation unavailable. Please refresh the page.');
    return;
  }

  const provider = window.GenerationState.getProvider('image');
  const snapshot = window.GenerationState.getGenerationSnapshot?.('image');

  // Log the provider being used (IMPORTANT for debugging conflicts)
  console.log(`[Image] ========================================`);
  console.log(`[Image] STARTING GENERATION`);
  console.log(`[Image] Provider from State: ${provider}`);
  console.log(`[Image] Settings:`, snapshot?.settings || 'N/A');
  console.log(`[Image] ========================================`);

  State.historyState.filter = 'image';
  State.historyState.page = 1;
  renderHistory();

  if (provider === 'openai') {
    await startOpenAIImageGeneration();
  } else if (provider === 'google') {
    await startGeminiImageGeneration();
  } else {
    // NO FALLBACK - show error and stop
    console.error(`[Image] Unknown provider: ${provider} - NO FALLBACK`);
    alert(`Image provider "${provider}" is not available. Please select OpenAI or Google.`);
  }
}

/**
 * Video credit calculation constants (must match 3dprint-app.js)
 */
const VIDEO_BASE_CREDITS = { 4: 30, 6: 45, 8: 60 };
const VIDEO_QUALITY_MULTIPLIER = { standard: 1.0, high: 1.5 };

// Map simplified aspect to API format (no square/1:1 - not supported by Veo)
const VIDEO_ASPECT_MAP = {
  landscape: '16:9',
  portrait: '9:16'
};

/**
 * Compute video credits based on settings (simplified)
 * @param {Object} settings - { durationSec, quality }
 * @returns {number} Total credits
 */
function computeVideoCredits(settings) {
  const base = VIDEO_BASE_CREDITS[settings.durationSec] || 30;
  const mult = VIDEO_QUALITY_MULTIPLIER[settings.quality] || 1.0;
  return Math.round(base * mult);
}

/**
 * Start video generation (Google Veo)
 */
export async function startVideoGeneration() {
  if (startLock) return;

  // Dispatch generation:start event (e.g., to close Inspire panel)
  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'video' } }));

  // Get video settings from UI (use window.VideoJobControl if available, else read directly)
  const settings = window.VideoJobControl?.getSettings?.() || {
    durationSec: parseInt(byId('videoDuration')?.value || '4', 10),
    quality: byId('videoQuality')?.value || 'standard',
    aspect: byId('videoAspectRatio')?.value || 'landscape',
    aspectRatio: VIDEO_ASPECT_MAP[byId('videoAspectRatio')?.value] || '16:9',
    loop: byId('videoLoop')?.checked ?? true,
    mode: byId('videoModeValue')?.value || 'text2video'
  };

  const motion = (byId('videoMotion')?.value || '').trim();
  const prompt = (byId('videoTextPrompt')?.value || '').trim();
  const stylePreset = byId('videoStylePreset')?.value || '';
  const motionPreset = byId('videoMotionPreset')?.value || '';

  // Compute credits using the SAME formula as UI
  const totalCredits = computeVideoCredits(settings);

  // Defensive logging for video credit flow
  console.log('[VIDEO] Credit check:', {
    durationSec: settings.durationSec,
    quality: settings.quality,
    computedCredits: totalCredits,
    formula: `base(${settings.durationSec}s) × quality(${settings.quality})`
  });

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(totalCredits, 'video');
  if (creditCheck.shouldBlock) {
    console.warn('[VIDEO] Credit check blocked:', creditCheck);
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'video');
    return;
  }

  startLock = true;

  const prog = UI.makeProgressDriver();

  // Reserve the EXACT computed credits (not multiplied by action cost)
  prog.label('Reserving credits...');
  console.log('[VIDEO] Reserving exact amount:', totalCredits, 'credits');
  const reservation = reserveExactAmount('video', totalCredits);
  if (reservation.insufficient) {
    console.warn('[VIDEO] Reservation failed:', reservation);
    startLock = false;
    showInsufficientCreditsModal(totalCredits, creditCheck.available, 'video');
    return;
  }
  console.log('[VIDEO] Reservation succeeded:', reservation.reservationId, 'for', reservation.amount, 'credits');

  State.historyState.filter = 'video';
  State.historyState.page = 1;
  renderHistory();

  // Generate idempotency key for this video generation
  const idempotencyKey = State.generateIdempotencyKey();
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
    credits_used: totalCredits,
    idempotency_key: idempotencyKey
  };
  State.addHistoryItem(placeholder);
  State.setHistoryActiveModelId(tempId);
  renderHistory();

  try {
    prog.label('Generating video with Veo...');

    // Build payload based on mode and pick the right endpoint
    let endpoint;
    let payload;

    if (settings.mode === 'image2video') {
      // ── C2: Image → video animation ──
      const videoImagePreview = byId('videoImagePreview');
      const imageData = videoImagePreview?.src;
      const isValidImage = imageData && (imageData.startsWith('data:') || imageData.startsWith('http'));

      if (!isValidImage) {
        startLock = false;
        releaseCreditsReservation(reservation.reservationId);
        UI.toast('Please upload a reference image for Image to Video mode', 'error');
        return;
      }

      endpoint = '/api/video/animate';
      payload = {
        image_data: imageData,
        prompt: motion || prompt,
        motion_preset: motionPreset || undefined,
        duration_sec: settings.durationSec,
        aspect_ratio: settings.aspectRatio,
        quality: settings.quality,
        loop: settings.loop
      };

      const isDataUrl = imageData.startsWith('data:');
      console.log('[VIDEO] Image2Video mode - image attached,', isDataUrl ? `size: ${Math.round(imageData.length / 1024)} KB` : `URL: ${imageData.slice(0, 60)}...`);

    } else {
      // ── C1: Text → cinematic clip ──
      endpoint = '/api/video/text';
      payload = {
        prompt: prompt,
        style_preset: stylePreset || undefined,
        duration_sec: settings.durationSec,
        aspect_ratio: settings.aspectRatio,
        quality: settings.quality,
        motion: motion,
        loop: settings.loop
      };
    }

    // Debug log before API call
    console.log('[GEN] mode=' + settings.mode + ' endpoint=' + endpoint +
                ' cost=' + totalCredits + ' available=' + creditCheck.available);

    // Include idempotency key in header for duplicate prevention
    const result = await apiFetch(endpoint, {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
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
      video_id: jobId,
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

    // Track as active job for recovery and indicator
    State.addActiveJob(jobId);
    State.savePendingMeta(jobId, {
      prompt: prompt || motion,
      duration_sec: settings.durationSec,
      quality: settings.quality,
      aspect_ratio: settings.aspectRatio,
      stage: 'video',
      type: 'video'
    });

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
    const errorMsg = err?.message || 'Video generation failed';

    // Check for quota/rate limit errors
    const isQuotaError = errorMsg.toLowerCase().includes('quota') ||
                        errorMsg.toLowerCase().includes('rate') ||
                        errorMsg.toLowerCase().includes('resource_exhausted') ||
                        errorMsg.toLowerCase().includes('exceeded') ||
                        errorMsg.includes('429');

    prog.fail(isQuotaError ? 'Daily limit reached' : errorMsg);

    if (isQuotaError && window.showQuotaExceededPopup) {
      window.showQuotaExceededPopup();
    } else {
      alert(errorMsg);
    }

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
  // D2: Exponential backoff — start at 2s, cap at 15s, ~10 min total budget
  const INITIAL_INTERVAL = 2000;
  const MAX_INTERVAL = 15000;
  const MAX_ELAPSED_MS = 10 * 60 * 1000; // 10 minutes
  let interval = INITIAL_INTERVAL;
  let elapsed = 0;

  while (elapsed < MAX_ELAPSED_MS) {
    await new Promise(r => setTimeout(r, interval));
    elapsed += interval;
    // Backoff: double every poll, capped at MAX_INTERVAL
    interval = Math.min(interval * 1.3, MAX_INTERVAL);

    try {
      const result = await apiFetch(`/api/video/status/${encodeURIComponent(jobId)}`);

      if (!result.ok) {
        // Job not found on backend — stop polling immediately
        if (result.status === 404) {
          console.warn('[Video] Job not found on backend, stopping poll:', jobId);
          State.updateHistoryItem(jobId, {
            status: 'failed',
            status_label: 'Job not found — please retry',
            type: 'video'
          });
          State.removeActiveJob(jobId);
          renderHistory();
          return;
        }
        console.warn('[Video] Status check failed:', result.error);
        continue;
      }

      const data = result.data;
      const status = data.status;

      if (status === 'done') {
        // Confirm credits reservation (converts to actual deduction)
        confirmCreditsReservation(reservationId, jobId);

        // Update history with video_id for proper remote sync
        State.updateHistoryItem(jobId, {
          status: 'finished',
          status_label: '',
          video_url: data.video_url,
          thumbnail_url: data.thumbnail_url || '',
          video_id: jobId,
          stage: 'video',
          type: 'video',
          provider: 'google',
          upstream_id: data.upstream_id || jobId
        });
        State.setHistoryActiveModelId(jobId);
        renderHistory();

        if (data.video_url) {
          const videoRailBtn = document.querySelector('[data-panel="video"]');
          if (videoRailBtn) videoRailBtn.click();
          Viewer.showVideoInViewer(data.video_url, {
            title: shortTitle(meta.prompt || 'Video') || 'Video Preview',
            hint: meta.prompt || 'Generated video',
            autoplay: true
          });
        }

        // Update balance - backend is authoritative
        if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
          window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'video_generation_complete');
        } else if (window.WorkspaceCredits?.syncWithBackend) {
          window.WorkspaceCredits.syncWithBackend(); // Force sync - backend is truth
        } else {
          refreshCreditsInBackground();
        }

        UI.makeProgressDriver().done('Video generated!');
        State.removeActiveJob(jobId);
        return;
      }

      if (status === 'failed') {
        releaseCreditsReservation(reservationId);
        // Force sync with backend after failure to ensure UI matches DB
        if (window.WorkspaceCredits?.syncWithBackend) {
          window.WorkspaceCredits.syncWithBackend();
        }
        const errorMsg = data.message || data.error || 'Video generation failed';
        const errorCode = data.error || '';

        // Check for content filtering (provider safety rejection)
        const isFiltered = errorCode === 'provider_filtered_third_party';

        // Check for quota/rate limit errors
        const isQuotaError = !isFiltered && (
                            errorMsg.toLowerCase().includes('quota') ||
                            errorMsg.toLowerCase().includes('rate') ||
                            errorMsg.toLowerCase().includes('resource_exhausted') ||
                            errorMsg.toLowerCase().includes('exceeded') ||
                            errorMsg.includes('429'));

        State.updateHistoryItem(jobId, {
          status: 'failed',
          status_label: isFiltered ? 'Content blocked' : isQuotaError ? 'Daily limit reached' : errorMsg,
          error_message: errorMsg,
          video_id: jobId,
          type: 'video'
        });
        renderHistory();

        if (isFiltered && window.showContentFilteredPopup) {
          window.showContentFilteredPopup(data.user_message || errorMsg);
        } else if (isQuotaError && window.showQuotaExceededPopup) {
          window.showQuotaExceededPopup();
        } else {
          UI.makeProgressDriver().fail(errorMsg);
        }
        State.removeActiveJob(jobId);
        return;
      }

      // Quota queued — job is waiting for provider quota reset
      if (status === 'queued' && data.quota_queued) {
        State.updateHistoryItem(jobId, {
          status: 'generating',
          status_label: 'Queued — waiting for provider quota reset'
        });
        renderHistory();
        continue;
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
    status_label: 'Video generation timed out',
    error_message: 'Video generation timed out',
    video_id: jobId,
    type: 'video'
  });
  renderHistory();
  UI.makeProgressDriver().fail('Video generation timed out');
  State.removeActiveJob(jobId);
}

/**
 * Start image-to-3D from the upload tab (user uploaded a fresh image)
 */
async function startImageTo3DFromUpload() {
  const modelImagePreview = byId('modelImagePreview');
  const imageData = modelImagePreview?.src || '';

  // Accept both data URLs (from file upload) and HTTP URLs (from history images)
  const isValidImage = imageData && (imageData.startsWith('data:') || imageData.startsWith('http'));
  if (!isValidImage) {
    alert('Please upload a reference image first.');
    return;
  }

  if (!checkCreditsFor('image-to-3d')) {
    return;
  }

  startLock = true;
  const allGenBtns = document.querySelectorAll('button[id*="generate"]');
  allGenBtns.forEach(btn => btn.setAttribute('disabled', ''));

  const nameInput = byId('imageModelName');
  const prompt = (nameInput?.value || '').trim() || 'Image to 3D';
  const model = byId('modelAIModel')?.value || 'latest';

  const meta = {
    prompt: `(image2-3d) ${prompt}`,
    root_prompt: prompt,
    art_style: 'realistic',
    model,
    stage: 'image3d',
    thumbnail_url: imageData.startsWith('http') ? imageData : ''
  };

  const prog = UI.makeProgressDriver();

  // Reserve credits BEFORE API call
  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction('image-to-3d', 1);
  if (reservation.insufficient) {
    startLock = false;
    allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
    return;
  }

  // Generate idempotency key for this generation
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `image3d-temp-${Date.now()}`);
  const tempMeta = { ...meta, type: 'model', idempotency_key: idempotencyKey };
  addGeneratingPlaceholder(tempId, { ...tempMeta, status_label: 'Starting image to 3D...', type: 'model' });
  State.savePendingMeta(tempId, tempMeta);

  prog.label('Starting image to 3D...');
  try {
    // Include idempotency key in header for duplicate prevention
    const result = await apiFetch('/api/_mod/image-to-3d/start', {
      method: 'POST',
      body: { image_url: imageData, prompt, model },
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      if (handleGenerationTimeout(result, 'image-to-3d')) {
        return;
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

    // Clean up temp placeholder
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);

    // Confirm reservation now that we have a job_id
    confirmCreditsReservation(reservation.reservationId, job_id);

    State.addActiveJob(job_id);
    State.savePendingMeta(job_id, { ...meta, type: 'model' });
    addGeneratingPlaceholder(job_id, { ...meta, status_label: 'Generating from image...', type: 'model' });
    watchMeshyTask(job_id, 'image3d');

    // Update balance if returned - backend is authoritative
    if (data.new_balance !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
      window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'image_to_3d_response');
    } else if (data.new_balance !== undefined && window.WorkspaceCredits?.setCredits) {
      window.WorkspaceCredits.setCredits(data.new_balance);
    }

    prog.label('Generating 3D model from image...');
  } catch (err) {
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    prog.fail(err?.message || 'Image to 3D failed');
    alert(err?.message || 'Image to 3D failed');
  } finally {
    startLock = false;
    allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
  }
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

  // Generate idempotency key for this generation
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `image3d-temp-${Date.now()}`);
  const tempMeta = { ...meta, type: 'model', idempotency_key: idempotencyKey };
  addGeneratingPlaceholder(tempId, { ...tempMeta, status_label: 'Starting image to 3D...', type: 'model' });
  State.savePendingMeta(tempId, tempMeta);

  prog.label('Starting image to 3D...');
  try {
    // Include idempotency key in header for duplicate prevention
    const result = await apiFetch('/api/_mod/image-to-3d/start', {
      method: 'POST',
      body: { image_url: item.image_url, prompt },
      headers: { 'Idempotency-Key': idempotencyKey }
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

    // Generate idempotency key for this refine operation
    const idempotencyKey = State.generateIdempotencyKey();
    tempId = (crypto?.randomUUID ? crypto.randomUUID() : `refine-temp-${Date.now()}`);
    addGeneratingPlaceholder(tempId, {
      ...jobMeta,
      status_label: 'Starting refine...',
      idempotency_key: idempotencyKey
    });
    State.savePendingMeta(tempId, { ...jobMeta, idempotency_key: idempotencyKey });

    // Include idempotency key in header for duplicate prevention
    const result = await apiFetch('/api/_mod/text-to-3d/refine', {
      method: 'POST',
      body: {
        preview_task_id: previewTaskId,
        model: item.model || 'meshy-6',
        enable_pbr: true
      },
      headers: { 'Idempotency-Key': idempotencyKey }
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

  // Dispatch generation:start event (e.g., to close Inspire panel)
  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'remesh' } }));

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

  // Dispatch generation:start event (e.g., to close Inspire panel)
  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'texture' } }));

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
          stage: item.stage || (item.type === 'image' ? 'image' : item.type === 'video' ? 'video' : 'remesh'),
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
        stage: item.stage || (item.type === 'image' ? 'image' : item.type === 'video' ? 'video' : 'remesh'),
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
  const videoIds = [];

  ids.forEach((id) => {
    const stage = pendingMeta?.[id]?.stage;
    if (stage === 'remesh' || stage === 'texture' || stage === 'rig' || stage === 'image3d') {
      meshIds.push(id);
    } else if (stage === 'image') {
      imageIds.push(id);
    } else if (stage === 'video') {
      videoIds.push(id);
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

  const allToResume = [...meshIds, ...textIds, ...videoIds];
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

  for (const id of videoIds) {
    const meta = pendingMeta[id] || {};
    watchVideoJob(id, null, meta);
  }
}

// ============================================================================
// BEFOREUNLOAD WARNING (Generation Reliability Layer)
// ============================================================================

/**
 * Warn user before leaving if there are active jobs
 * Jobs will continue on server, but user may lose live preview
 */
function handleBeforeUnload(e) {
  const activeJobs = State.getActiveJobs();
  if (activeJobs.length === 0) return;

  const message = `You have ${activeJobs.length} generation${activeJobs.length > 1 ? 's' : ''} in progress. They will continue in the background, but you may lose the live preview.`;
  e.preventDefault();
  e.returnValue = message;
  return message;
}

// Install beforeunload handler
window.addEventListener('beforeunload', handleBeforeUnload);
log('[API] beforeunload handler installed for active job warning');

// ============================================================================
// JOBS IN-PROGRESS INDICATOR
// ============================================================================

/**
 * Update the jobs-in-progress indicator badge
 * Shows a small pulse indicator when jobs are running
 */
export function updateJobsIndicator() {
  const count = State.getActiveJobs().length;
  let indicator = document.getElementById('jobs-indicator');

  if (count > 0) {
    if (!indicator) {
      // Create indicator styled like the upload button (icon-btn)
      indicator = document.createElement('button');
      indicator.id = 'jobs-indicator';
      indicator.type = 'button';
      indicator.className = 'icon-btn';
      indicator.setAttribute('aria-label', 'Jobs in progress');
      indicator.innerHTML = `
        <svg class="jobs-indicator__spinner" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.2"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        <span><span class="jobs-indicator__count">0</span> generating</span>
      `;

      // Add styles
      if (!document.getElementById('jobs-indicator-styles')) {
        const style = document.createElement('style');
        style.id = 'jobs-indicator-styles';
        style.textContent = `
          #jobs-indicator {
            animation: jobs-pulse 2s ease-in-out infinite;
            border: 1px solid rgba(56, 189, 248, 0.4) !important;
            background: rgba(56, 189, 248, 0.08) !important;
          }
          #jobs-indicator:hover {
            background: rgba(56, 189, 248, 0.15) !important;
            border-color: rgba(56, 189, 248, 0.6) !important;
          }
          @keyframes jobs-pulse {
            0%, 100% {
              box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.4);
            }
            50% {
              box-shadow: 0 0 8px 2px rgba(56, 189, 248, 0.3);
            }
          }
          #jobs-indicator .jobs-indicator__spinner {
            animation: jobs-spin 1s linear infinite;
            stroke: #38bdf8;
          }
          @keyframes jobs-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          #jobs-indicator .jobs-indicator__count {
            font-weight: 600;
            color: #38bdf8;
          }
        `;
        document.head.appendChild(style);
      }

      // Click handler to show jobs panel
      indicator.addEventListener('click', showJobsPanel);

      // Insert into pane-head-actions before the upload button
      const actionsContainer = document.querySelector('.pane-head-actions');
      if (actionsContainer) {
        actionsContainer.insertBefore(indicator, actionsContainer.firstChild);
      } else {
        // Fallback to fixed position
        indicator.style.cssText = 'position: fixed; top: 80px; right: 20px; z-index: 9999; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; background: rgba(30,30,40,0.95); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #e0e0e0; cursor: pointer;';
        document.body.appendChild(indicator);
      }
    }

    indicator.querySelector('.jobs-indicator__count').textContent = count;
    indicator.style.display = '';
  } else if (indicator) {
    indicator.style.display = 'none';
  }
}

/**
 * Show modal panel with list of active jobs
 */
export function showJobsPanel() {
  const activeJobIds = State.getActiveJobs();
  const meta = State.getPendingMeta();

  if (activeJobIds.length === 0) return;

  const existing = document.getElementById('jobs-panel-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'jobs-panel-modal';
  modal.className = 'modal show';
  modal.style.cssText = 'z-index: 10001;';

  const jobsList = activeJobIds.map(jobId => {
    const jobMeta = meta[jobId] || {};
    const title = (jobMeta.prompt || jobMeta.title || 'Generation').slice(0, 40);
    const progress = jobMeta.progress || 0;
    const type = jobMeta.stage || jobMeta.type || 'unknown';

    return `
      <div class="jobs-panel__item" data-job-id="${jobId}">
        <div class="jobs-panel__item-info">
          <div class="jobs-panel__item-title">${title}${(jobMeta.prompt?.length || 0) > 40 ? '...' : ''}</div>
          <div class="jobs-panel__item-type">${type}</div>
        </div>
        <div class="jobs-panel__item-progress">
          <div class="jobs-panel__progress-bar">
            <div class="jobs-panel__progress-fill" style="width: ${progress}%"></div>
          </div>
          <span class="jobs-panel__progress-text">${progress}%</span>
        </div>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="modal-panel" style="max-width: 480px;">
      <h3 style="margin-bottom: 16px; display: flex; align-items: center; gap: 10px;">
        <div style="width: 10px; height: 10px; background: #8b5cf6; border-radius: 50%; animation: jobs-pulse 1.5s ease-in-out infinite;"></div>
        Jobs in Progress
      </h3>
      <p class="modal-desc" style="margin-bottom: 16px; color: #94a3b8;">
        These generations are running on our servers. You can safely navigate away and come back - they'll keep running.
      </p>
      <div class="jobs-panel__list" style="max-height: 300px; overflow-y: auto;">
        ${jobsList || '<p style="color: #64748b; text-align: center; padding: 20px;">No active jobs</p>'}
      </div>
      <div class="modal-actions" style="margin-top: 20px; justify-content: center;">
        <button class="btn-submit" id="jobs-panel-close">Got it</button>
      </div>
    </div>
  `;

  // Add job item styles
  if (!document.getElementById('jobs-panel-styles')) {
    const style = document.createElement('style');
    style.id = 'jobs-panel-styles';
    style.textContent = `
      .jobs-panel__item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px;
        background: rgba(255,255,255,0.03);
        border-radius: 8px;
        margin-bottom: 8px;
      }
      .jobs-panel__item-title {
        font-weight: 500;
        color: #e2e8f0;
        margin-bottom: 4px;
      }
      .jobs-panel__item-type {
        font-size: 12px;
        color: #64748b;
        text-transform: capitalize;
      }
      .jobs-panel__item-progress {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .jobs-panel__progress-bar {
        width: 60px;
        height: 6px;
        background: rgba(255,255,255,0.1);
        border-radius: 3px;
        overflow: hidden;
      }
      .jobs-panel__progress-fill {
        height: 100%;
        background: #8b5cf6;
        transition: width 0.3s ease;
      }
      .jobs-panel__progress-text {
        font-size: 12px;
        color: #8b5cf6;
        min-width: 35px;
        text-align: right;
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  const closeModal = () => {
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
    setTimeout(() => modal.remove(), 200);
  };

  modal.querySelector('#jobs-panel-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
}

// Register callback to update indicator when jobs change
State.onActiveJobsChange(() => {
  updateJobsIndicator();
});

// Initialize indicator on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateJobsIndicator);
  } else {
    updateJobsIndicator();
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
window.updateJobsIndicator = updateJobsIndicator;
window.showJobsPanel = showJobsPanel;
