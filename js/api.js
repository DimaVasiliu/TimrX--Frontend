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
import { renderHistory, updateJobStatusInPlace, shortTitle } from './history.js';

// ============================================================================
// LOCKS & STATE
// ============================================================================
let startLock = false;
let postProcessLock = false;

/**
 * Acquire the submit lock — prevents duplicate generation requests.
 * Mirrors the lock into GenerationState so there is one queryable authority.
 * @returns {boolean} true if lock was acquired, false if already held.
 */
function acquireSubmitLock() {
  if (startLock) return false;
  startLock = true;
  window.GenerationState?.setSubmitLock?.(true);
  return true;
}

/**
 * Release the submit lock. Safe to call multiple times (idempotent).
 */
function releaseSubmitLock() {
  startLock = false;
  window.GenerationState?.setSubmitLock?.(false);
}

// Track jobs that have already had credits refreshed on completion/failure
// Prevents multiple refresh calls for the same job
const creditsRefreshedJobs = new Set();

// ── Cross-tab poll deduplication via BroadcastChannel ──
// When multiple tabs watch the same job, only one tab needs to fetch.
// After each poll, the result is broadcast. Other tabs use the broadcast
// and reset their own poll timer, avoiding redundant API calls.
const _pollChannel = (typeof BroadcastChannel !== 'undefined')
  ? new BroadcastChannel('timrx-poll-dedup')
  : null;

// job_id → { data, timestamp } — recent results received from other tabs
const _crossTabResults = new Map();
const _CROSS_TAB_FRESHNESS_MS = 4000; // accept broadcast if < 4s old

if (_pollChannel) {
  _pollChannel.onmessage = (evt) => {
    const { jobId, data, ts } = evt.data || {};
    if (jobId && data) {
      _crossTabResults.set(jobId, { data, ts });
    }
  };
}

/**
 * Check if another tab recently polled this job and broadcast a fresh result.
 * Returns the cached result data or null if stale/missing.
 */
function _getCrossTabResult(jobId) {
  const entry = _crossTabResults.get(jobId);
  if (!entry) return null;
  if (Date.now() - entry.ts > _CROSS_TAB_FRESHNESS_MS) {
    _crossTabResults.delete(jobId);
    return null;
  }
  return entry.data;
}

/**
 * Broadcast a poll result so other tabs can skip their next fetch.
 */
function _broadcastPollResult(jobId, data) {
  if (_pollChannel) {
    try {
      _pollChannel.postMessage({ jobId, data, ts: Date.now() });
    } catch (_) { /* channel closed or serialization error — ignore */ }
  }
}

// ── Retry infrastructure for status polling ──
// When polling stops after MAX_CONSECUTIVE_ERRORS, register the job here
// so the UI can offer a manual "Check Status" button + auto-retry after 30s.
const _retryableJobs = new Map(); // job_id -> { endpoint, resumeFn, autoRetryTimer }

/**
 * Offer a manual retry after polling stops due to consecutive errors.
 * Shows a "Check Status" button on the job card and auto-retries once after 30s.
 *
 * @param {string} jobId - The job ID
 * @param {string} endpoint - The status endpoint URL (without job_id)
 * @param {Function} resumeFn - Function to call to resume full polling (e.g., () => watchJob(jobId))
 * @param {string} label - Human-readable job type label (e.g., "Text-to-3D")
 */
function offerStatusRetry(jobId, endpoint, resumeFn, label = 'Generation') {
  // Update card to show retryable state (not permanent failure)
  State.updateHistoryItem(jobId, {
    status: 'generating',
    status_label: 'Status checks paused — connection issue'
  });

  // Show retry button on the card
  _showRetryButton(jobId, endpoint, resumeFn, label);

  // Auto-retry once after 30s (catches brief server restarts / deploys)
  const autoRetryTimer = setTimeout(async () => {
    const entry = _retryableJobs.get(jobId);
    if (!entry) return; // already resolved or manually retried

    console.log(`[${label}] Auto-retry status check for ${jobId}`);
    const ok = await _singleStatusRetry(jobId, endpoint, resumeFn, label);
    if (!ok) {
      // Still failing — leave button visible for manual retry
      _updateRetryButtonState(jobId, 'idle');
    }
  }, 30000);

  _retryableJobs.set(jobId, { endpoint, resumeFn, autoRetryTimer, label });
}

/**
 * Perform a single status check. If successful, resume full polling.
 */
async function _singleStatusRetry(jobId, endpoint, resumeFn, label) {
  try {
    const result = await apiFetch(`${endpoint}/${jobId}`);
    if (result.ok || (result.data && result.data.status)) {
      console.log(`[${label}] Retry succeeded for ${jobId}, resuming polling`);
      _cleanupRetry(jobId);
      // Remove from watchers so resumeFn can re-register
      State.watchers.delete(jobId);
      resumeFn();
      return true;
    }
    console.warn(`[${label}] Retry failed for ${jobId}:`, result.error || result.status);
    return false;
  } catch (err) {
    console.warn(`[${label}] Retry error for ${jobId}:`, err);
    return false;
  }
}

function _cleanupRetry(jobId) {
  const entry = _retryableJobs.get(jobId);
  if (entry?.autoRetryTimer) clearTimeout(entry.autoRetryTimer);
  _retryableJobs.delete(jobId);
  // Remove retry button from card
  const btn = document.querySelector(`[data-retry-job="${jobId}"]`);
  if (btn) btn.remove();
}

function _showRetryButton(jobId, endpoint, resumeFn, label) {
  const card = document.querySelector(`[data-job-id="${jobId}"]`);
  if (!card) return;

  // Remove existing retry button if any
  const existing = card.querySelector(`[data-retry-job="${jobId}"]`);
  if (existing) existing.remove();

  const btn = document.createElement('button');
  btn.setAttribute('data-retry-job', jobId);
  btn.className = 'retry-status-btn';
  btn.textContent = 'Check Status';
  btn.style.cssText = `
    display: block; margin: 6px auto 0; padding: 5px 14px;
    background: rgba(255,255,255,0.12); color: #fff;
    border: 1px solid rgba(255,255,255,0.25); border-radius: 6px;
    font-size: 12px; cursor: pointer; transition: background 0.2s;
  `;
  btn.onmouseenter = () => { btn.style.background = 'rgba(255,255,255,0.22)'; };
  btn.onmouseleave = () => { btn.style.background = 'rgba(255,255,255,0.12)'; };

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = 'Checking...';
    btn.style.opacity = '0.6';

    const ok = await _singleStatusRetry(jobId, endpoint, resumeFn, label);
    if (!ok) {
      btn.disabled = false;
      btn.textContent = 'Check Status';
      btn.style.opacity = '1';
    }
    // If ok, _cleanupRetry already removed the button
  });

  card.appendChild(btn);
}

function _updateRetryButtonState(jobId, state) {
  const btn = document.querySelector(`[data-retry-job="${jobId}"]`);
  if (!btn) return;
  if (state === 'idle') {
    btn.disabled = false;
    btn.textContent = 'Check Status';
    btn.style.opacity = '1';
  }
}

// Show Discord share modal sparingly — once per 7 days max
const DISCORD_PROMPT_KEY = 'timrx_discord_prompt_ts';
const DISCORD_PROMPT_COOLDOWN = 7 * 24 * 60 * 60 * 1000; // 7 days

function shouldShowDiscordPrompt() {
  try {
    const last = parseInt(localStorage.getItem(DISCORD_PROMPT_KEY) || '0', 10);
    return Date.now() - last > DISCORD_PROMPT_COOLDOWN;
  } catch { return false; }
}

function markDiscordPromptShown() {
  try { localStorage.setItem(DISCORD_PROMPT_KEY, String(Date.now())); } catch {}
}

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
  // Pool-aware: video generation checks the video credits pool
  const isVideo = mode === 'video';
  const available = isVideo
    ? Number(wallet.videoAvailable ?? wallet.video_available_credits ?? 0)
    : Number(wallet.available ?? wallet.available_credits ?? 0);
  const numCost = Number(cost) || 0;
  const missing = Math.max(0, numCost - available);
  const shouldBlock = missing > 0;

  // Debug log before block decision
  console.log(`[CREDITS] pool=${isVideo ? 'video' : 'general'} available=${available}, cost=${numCost}, missing=${missing}, willBlock=${shouldBlock}`);

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

  // Handle 451/422 prompt safety block/warn
  if (response.status === 451 || response.status === 422) {
    const safetyData = response.data?.safety;
    if (safetyData && safetyData.decision) {
      log('[Safety]', safetyData.decision, 'for:', action, safetyData.categories);
      showPromptSafetyModal(safetyData, reservationId);
      return true;
    }
  }

  // Handle 429 rate limit / video limit errors
  if (response.status === 429) {
    if (reservationId) {
      releaseCreditsReservation(reservationId);
    }

    // Daily quota exceeded — show dedicated modal
    if (response.data?.error === 'DAILY_QUOTA_EXCEEDED') {
      log('[Quota] Daily quota exceeded:', response.data.provider, response.data.used_today + '/' + response.data.limit);
      showDailyQuotaModal(response.data);
      return true;
    }

    // Generic rate limit — toast
    log('[Quota] 429 Rate limit exceeded for:', action);
    const msg = response.data?.message || 'Rate limit reached. Please try again shortly.';
    if (typeof UI !== 'undefined' && UI.toast) {
      UI.toast(msg, 'error', 6000);
    } else if (window.showQuotaExceededPopup) {
      window.showQuotaExceededPopup();
    }
    return true;
  }

  // Handle 503 global budget / service unavailable — toast
  if (response.status === 503) {
    log('[Service] 503 Service unavailable for:', action);
    if (reservationId) {
      releaseCreditsReservation(reservationId);
    }
    const msg = response.data?.message || 'Service temporarily unavailable. Please try again later.';
    if (typeof UI !== 'undefined' && UI.toast) {
      UI.toast(msg, 'error', 6000);
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
    const msg = response.data?.message || 'Generation limit reached. Please try again later.';
    if (typeof UI !== 'undefined' && UI.toast) {
      UI.toast(msg, 'error', 6000);
    } else if (window.showQuotaExceededPopup) {
      window.showQuotaExceededPopup();
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
 * Styled to match hub.html modals with dark theme
 *
 * @param {number} required - Video credits required for this action
 * @param {number} available - Video credits currently available
 */
/**
 * Show daily quota exceeded modal — provider-specific, premium UX.
 * @param {Object} data — { provider, provider_name, limit, used_today, resets_at, message }
 */
function showDailyQuotaModal(data) {
  const providerName = data.provider_name || data.provider || 'this model';
  const limit = data.limit || 0;
  const used = data.used_today || 0;
  const resetsAt = data.resets_at ? new Date(data.resets_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'midnight UTC';

  // Remove existing modal if any
  const existing = document.getElementById('dailyQuotaModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'dailyQuotaModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';

  modal.innerHTML = `
    <div style="position:absolute;inset:0;cursor:pointer;" data-close></div>
    <div style="position:relative;z-index:1;background:var(--surface-elevated,#1e1e2e);border-radius:16px;padding:32px;max-width:420px;width:92%;box-shadow:0 12px 40px rgba(0,0,0,0.5);text-align:center;">
      <div style="width:56px;height:56px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);">
        <i class="fa-solid fa-hourglass-end" style="font-size:22px;color:#fbbf24;"></i>
      </div>
      <h3 style="margin:0 0 8px;color:var(--text-primary,#fff);font-size:20px;font-weight:700;">Daily Limit Reached</h3>
      <p style="margin:0 0 20px;color:var(--text-secondary,#a0a0b0);font-size:14px;line-height:1.6;">
        You've used all <strong style="color:var(--text-primary,#fff);">${limit}</strong> ${providerName} generations for today.
      </p>
      <div style="background:var(--surface-base,#14141f);border-radius:10px;padding:14px;margin:0 0 20px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="color:var(--text-secondary,#a0a0b0);font-size:13px;">Used today</span>
          <span style="color:var(--text-primary,#fff);font-weight:600;font-size:13px;">${used} / ${limit}</span>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span style="color:var(--text-secondary,#a0a0b0);font-size:13px;">Resets at</span>
          <span style="color:#fbbf24;font-weight:600;font-size:13px;">${resetsAt}</span>
        </div>
        <div style="margin-top:10px;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:100%;background:#fbbf24;border-radius:2px;"></div>
        </div>
      </div>
      <p style="margin:0 0 20px;color:var(--text-secondary,#a0a0b0);font-size:13px;">
        You can still use other video models that haven't reached their limit.
      </p>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button data-close style="flex:1;padding:12px 20px;border-radius:10px;border:none;background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;">
          Got it
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  const closeModal = () => modal.remove();
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // Focus the button
  requestAnimationFrame(() => modal.querySelector('button[data-close]')?.focus());
}


function showInsufficientVideoCreditsModal(required, available) {
  const numRequired = Number(required) || 0;
  const numAvailable = Number(available) || 0;
  const numNeeded = Math.max(0, numRequired - numAvailable);

  // Close modal helper
  const closeVideoCreditsModal = () => {
    const modal = document.getElementById('insufficientVideoCreditsModal');
    if (modal) {
      modal.remove();
    }
  };

  // Expose globally for onclick handlers
  window.closeVideoCreditsModal = closeVideoCreditsModal;

  // Remove existing modal if any
  const existingModal = document.getElementById('insufficientVideoCreditsModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Create fresh modal each time
  const modal = document.createElement('div');
  modal.id = 'insufficientVideoCreditsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-labelledby', 'insuffVideoCreditsTitle');
  modal.setAttribute('aria-modal', 'true');

  // Set styles directly - no CSS class to avoid conflicts
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.zIndex = '999999';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.background = 'radial-gradient(1200px 700px at 50% 10%, rgba(255,255,255,0.06), transparent 60%), rgba(0,0,0,0.75)';
  modal.style.backdropFilter = 'blur(10px) saturate(120%)';
  modal.style.webkitBackdropFilter = 'blur(10px) saturate(120%)';
  modal.style.margin = '0';
  modal.style.padding = '0';

  modal.innerHTML = `
    <div style="max-width: 420px; text-align: center; padding: 32px; position: relative; background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0)), #0f0f0f; border: 1px solid rgba(255,255,255,0.14); border-radius: 20px; box-shadow: 0 24px 80px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.10);">
      <button onclick="window.closeVideoCreditsModal()" aria-label="Close" style="position: absolute; top: 12px; right: 12px; background: transparent; border: 0; color: #cfcfcf; font-size: 22px; line-height: 1; cursor: pointer; padding: 6px; border-radius: 10px;">&times;</button>
      <div style="width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.08);">
        <i class="fa-solid fa-video" style="font-size: 28px; color: #f0f0f0;" aria-hidden="true"></i>
      </div>
      <h4 id="insuffVideoCreditsTitle" style="margin: 0 0 16px; font-family: 'Bebas Neue', system-ui, sans-serif; font-size: 28px; letter-spacing: 0.5px; color: #f5f5f5;">Video Credits Needed</h4>
      <p style="margin: 0 0 20px; color: rgba(255, 255, 255, 0.72); font-size: 15px; line-height: 1.6;">
        Video generation requires <strong class="video-credits-required" style="color: #f0f0f0;">${numRequired}</strong> video credits.<br>
        You currently have <strong class="video-credits-available" style="color: #f0f0f0;">${numAvailable}</strong> video credits.
      </p>
      <div style="margin: 0 0 24px; padding: 14px 16px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px;">
        <span style="font-size: 14px; color: rgba(255, 255, 255, 0.6);">You need </span>
        <strong class="video-credits-needed" style="color: #f0f0f0; font-size: 15px;">${numNeeded}</strong>
        <span style="font-size: 14px; color: rgba(255, 255, 255, 0.6);"> more video credits to continue.</span>
      </div>
      <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
        <button onclick="window.closeVideoCreditsModal()" style="padding: 14px 24px; background: transparent; border: 1px solid rgba(255, 255, 255, 0.14); color: rgba(255, 255, 255, 0.72); border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px;">Cancel</button>
        <a href="hub.html#video-pricing" id="insuffVideoCreditsCtaBtn" style="padding: 14px 24px; background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0)), #1a1a1a; border: 1px solid rgba(255, 255, 255, 0.18); color: #f5f5f5; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);">Buy Video Credits</a>
      </div>
      <p style="margin: 20px 0 0; font-size: 12px; color: rgba(255, 255, 255, 0.45);">
        Video credits are separate from general credits.
      </p>
    </div>
  `;

  document.body.appendChild(modal);

  // Backdrop click closes modal
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeVideoCreditsModal();
  });

  // ESC key closes modal
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeVideoCreditsModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  // Focus the CTA button
  document.getElementById('insuffVideoCreditsCtaBtn')?.focus();
}


// ============================================================================
// PROMPT SAFETY MODAL
// ============================================================================

/**
 * Show a safety modal when the backend blocks or warns about a prompt.
 * @param {object} safety - The safety object from the backend response
 * @param {string} reservationId - Optional reservation to release
 */
function showPromptSafetyModal(safety, reservationId = null) {
  if (reservationId) {
    releaseCreditsReservation(reservationId);
  }

  const isBlock = safety.decision === 'block';
  const categoryLabel = safety.category_label || (safety.categories || []).join(', ') || 'content policy';

  const closeSafetyModal = () => {
    const el = document.getElementById('promptSafetyModal');
    if (el) el.remove();
    document.removeEventListener('keydown', safetyEscHandler);
  };
  window.closePromptSafetyModal = closeSafetyModal;

  const existing = document.getElementById('promptSafetyModal');
  if (existing) existing.remove();

  const accentColor = isBlock ? '#c47070' : '#c9a35a';
  const iconClass = isBlock ? 'fa-shield-halved' : 'fa-triangle-exclamation';
  const title = isBlock ? 'Generation Blocked' : 'Prompt Needs Adjustment';

  // Penalty — only show when relevant
  let footerHtml = '';
  if (safety.credit_penalty > 0) {
    footerHtml = `
      <div style="margin-top: 14px; padding: 10px 14px; background: rgba(255,255,255,0.025);
                  border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; text-align: center;">
        <span style="font-size: 12px; color: rgba(255, 255, 255, 0.55);">
          <i class="fa-solid fa-coins" style="color: ${accentColor}; margin-right: 5px;"></i>
          <strong style="color: rgba(255,255,255,0.8);">${safety.credit_penalty}-credit</strong> penalty applied
        </span>
      </div>`;
  } else if (safety.penalty_notice) {
    footerHtml = `<p style="margin: 12px 0 0; font-size: 11px; color: rgba(255,255,255,0.3); text-align: center;">${safety.penalty_notice}</p>`;
  }

  // Strike badge — only show at ≥2
  let strikeBadge = '';
  if (safety.strike_count_24h >= 2) {
    strikeBadge = `<span style="display: inline-block; margin-left: 8px; padding: 2px 8px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px; font-size: 10px; color: rgba(255,255,255,0.35);
      font-family: Inter, system-ui, sans-serif; font-weight: 500;
      vertical-align: middle;">${safety.strike_count_24h} flagged today</span>`;
  }

  const modal = document.createElement('div');
  modal.id = 'promptSafetyModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-labelledby', 'promptSafetyTitle');
  modal.setAttribute('aria-modal', 'true');

  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    z-index: 999999; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.75);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    margin: 0; padding: 20px;
  `;

  modal.innerHTML = `
    <div style="max-width: 440px; width: 100%; padding: 28px 28px 24px; position: relative;
                background: linear-gradient(135deg, #1a1a1a 0%, #151515 100%);
                border: 1px solid rgba(255,255,255,0.1); border-radius: 20px;
                box-shadow: 0 24px 60px rgba(0,0,0,0.6);">

      <button onclick="window.closePromptSafetyModal()" aria-label="Close"
              style="position: absolute; top: 14px; right: 14px; width: 28px; height: 28px;
                     display: grid; place-items: center; background: rgba(0,0,0,0.3);
                     border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
                     color: #999; font-size: 15px; line-height: 1; cursor: pointer;"
              onmouseenter="this.style.background='rgba(255,255,255,0.06)';this.style.color='#fff'"
              onmouseleave="this.style.background='rgba(0,0,0,0.3)';this.style.color='#999'">&times;</button>

      <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 16px;">
        <div style="width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);">
          <i class="fa-solid ${iconClass}" style="font-size: 18px; color: ${accentColor};" aria-hidden="true"></i>
        </div>
        <div>
          <h4 id="promptSafetyTitle" style="margin: 0; font-size: 17px; font-weight: 800;
              letter-spacing: -0.01em; color: #fff; line-height: 1.2;">
            ${title}${strikeBadge}
          </h4>
          <p style="margin: 3px 0 0; font-size: 12px; color: ${accentColor}; font-weight: 600;">
            ${categoryLabel}
          </p>
        </div>
      </div>

      <p style="margin: 0 0 ${safety.rewrite_hint ? '12px' : '0'}; color: rgba(255,255,255,0.55);
                font-size: 13px; line-height: 1.6;">
        ${safety.message || 'This prompt may violate provider safety rules.'}
      </p>

      ${safety.rewrite_hint ? `
      <div style="padding: 10px 14px; background: rgba(255,255,255,0.025);
                  border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; margin-bottom: 4px;">
        <p style="margin: 0; font-size: 12px; color: rgba(255,255,255,0.45); line-height: 1.55;">
          <i class="fa-regular fa-lightbulb" style="color: rgba(255,255,255,0.25); margin-right: 5px;"></i>
          ${safety.rewrite_hint}
        </p>
      </div>` : ''}

      ${footerHtml}

      <div style="display: flex; justify-content: center; margin-top: 18px;">
        <button onclick="window.closePromptSafetyModal()"
                style="padding: 10px 28px; background: rgba(255,255,255,0.04);
                       border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.65);
                       border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 13px;"
                onmouseenter="this.style.background='rgba(255,255,255,0.08)';this.style.color='#fff'"
                onmouseleave="this.style.background='rgba(255,255,255,0.04)';this.style.color='rgba(255,255,255,0.65)'">
          ${isBlock ? 'Got It' : 'Edit Prompt'}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSafetyModal();
  });

  // ESC key
  const safetyEscHandler = (e) => {
    if (e.key === 'Escape') {
      closeSafetyModal();
    }
  };
  document.addEventListener('keydown', safetyEscHandler);
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
 * @param {string} operation - 'refine', 'remesh', or 'texture'
 */
function showExpiredModelError(operation = 'process') {
  const opNames = {
    refine: 'refine',
    remesh: 'remesh',
    texture: 'retexture',
  };
  const opName = opNames[operation] || operation;

  showErrorModal(
    'Model No Longer Available',
    `This model's source data has expired and can no longer be ${opName}d. Models typically expire after 7 days.`,
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
/**
 * Handle job failure. Shows alert for user-initiated jobs,
 * silently logs for background-recovered jobs.
 * @param {string} message - Error message
 * @param {string} operation - Job type
 * @param {object} opts - Options
 * @param {boolean} opts.isRecovery - If true, suppress popup (stale recovery)
 */
function handleJobFailure(message, operation = '', opts = {}) {
  if (isExpiredModelError(message)) {
    showExpiredModelError(operation);
    return true;
  }
  if (opts.isRecovery) {
    // Stale recovered job — log but don't spam the user with alerts
    console.warn(`[Recovery] Silently failed recovered ${operation} job: ${message}`);
    return false;
  }
  const msg = message || 'Job failed';
  // Translate prompt-length backend errors into actionable user message
  if (/prompt.*(too long|too many char|length|exceed)|char.*limit|max.*char/i.test(msg)) {
    alert('Your prompt is too long. Please shorten it to 800 characters or fewer and try again.');
  } else {
    alert(msg);
  }
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
 * Build source object for Meshy API from a history item.
 * Used by remesh, rig, and other non-retexture operations.
 */
function buildMeshySourceFromItem(item = {}) {
  if (!item) return {};
  const taskId = item.id || item.preview_task_id || item.preview_task || item.source_task_id;
  const modelUrl = item.glb_url || item.glb_proxy;
  const result = {};
  if (taskId) result.input_task_id = taskId;
  if (modelUrl) result.model_url = modelUrl;
  return Object.keys(result).length ? result : {};
}

/**
 * Build canonical source for Meshy retexture.
 *
 * ALL retexture entry points (rail panel, viewer toolbar, history dropdown)
 * MUST call this for consistent behavior.
 *
 * Source priority (enforced by backend, communicated here):
 *   1. Valid upstream Meshy task ID  →  backend sends ONLY input_task_id
 *   2. Model URL (S3 / public)      →  backend sends ONLY model_url
 *   3. Neither                       →  returns null (caller must block)
 *
 * Both fields are sent to the backend so it can resolve the upstream ID and
 * fall back to model_url if the task ID is stale/invalid.  The backend will
 * NEVER forward both to Meshy (Meshy silently prefers input_task_id, and a
 * stale one causes async failure even when model_url is valid).
 *
 * @param {object} item  History item / active viewer model
 * @param {string} origin  Caller label for diagnostics: "rail" | "viewer" | "history"
 * @returns {object|null}  {input_task_id?, model_url?} or null
 */
function buildCanonicalRetextureSource(item, origin = 'unknown') {
  if (!item) return null;

  const upstreamTaskId = item.id || item.preview_task_id || item.source_task_id;
  const modelUrl = item.glb_url || item.glb_proxy;

  if (!upstreamTaskId && !modelUrl) {
    console.warn('[Retexture:SRC] No valid source for item', item.id, 'origin=' + origin);
    return null;
  }

  const source = {};
  if (upstreamTaskId) source.input_task_id = upstreamTaskId;
  if (modelUrl) source.model_url = modelUrl;

  // Dev-only diagnostic — visible in browser console, never in prod alerts
  console.debug('[Retexture:SRC]', {
    origin,
    source_mode: upstreamTaskId ? (modelUrl ? 'task+fallback' : 'task') : 'model_url',
    upstream_task_id: upstreamTaskId || null,
    model_url_preview: modelUrl ? modelUrl.substring(0, 80) : null,
    history_item_id: item.id,
  });

  return source;
}

/**
 * Get remesh form values from the UI
 */
function getRemeshFormValues() {
  // Try active preset first
  const activePreset = document.querySelector('#remeshPresets .remesh-preset.is-active');
  const advancedOpen = document.querySelector('#remeshAdvanced') &&
    !document.querySelector('#remeshAdvanced').classList.contains('remesh-advanced--collapsed');

  let target_polycount;
  let topology;

  if (activePreset && !advancedOpen) {
    target_polycount = parseInt(activePreset.dataset.poly || '50000', 10);
    topology = activePreset.dataset.topo || 'triangle';
  } else {
    const polyInput = byId('targetPolyCount');
    const modeInput = byId('remeshMode');
    target_polycount = parseInt(polyInput?.value || '0', 10);
    if (!Number.isFinite(target_polycount) || target_polycount <= 0) target_polycount = 45000;
    const remeshMode = (modeInput?.value || '').toLowerCase();
    topology = remeshMode.includes('quad') ? 'quad' : 'triangle';
  }

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
  // Default to false when the texture panel isn't rendered (viewer/history
  // entry points).  enable_original_uv=true on models without user-designed
  // UVs (e.g. text-to-3d previews) causes Meshy async failures.  The backend
  // also overrides to false for preview/imported models as a safety net.
  const enable_original_uv = seamlessInput ? !!seamlessInput.checked : false;
  const enable_pbr = textureType === 'pbr-all';
  return {
    text_style_prompt: prompt,
    enable_pbr,
    enable_original_uv,
    ai_model: 'latest'
  };
}

/**
 * Add a generating placeholder to history
 */
function addGeneratingPlaceholder(jobId, meta = {}) {
  if (State.historyHasJobId(jobId)) {
    // Don't overwrite completed/failed items with a generating overlay —
    // this prevents flicker on reload when recovery touches finished cards
    const existing = State.findHistoryItem(jobId);
    if (existing && (existing.status === 'finished' || existing.status === 'failed')) {
      return;
    }
    State.updateHistoryItem(jobId, {
      status: meta.status_label?.includes('Refin') ? 'refining' : meta.status_label?.includes('Remesh') ? 'remeshing' : meta.stage === 'texture' ? 'texturing' : meta.stage === 'rig' ? 'rigging' : (meta.stage === 'animation' || meta.stage === 'animate') ? 'animating' : 'generating',
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
  if (meta.stage === 'animation' || meta.stage === 'animate') statusType = 'animating';
  if (meta.type === 'image') statusType = 'generating';
  const stage = meta.stage || (isRefine ? 'refine' : isRemesh ? 'remesh' : 'preview');

  // Spread meta first so extra fields (provider, provider_used, image_url,
  // idempotency_key for image jobs) are included, then set computed fields
  // that must not be overridden by the spread.
  const placeholder = {
    ...meta,
    id: jobId,
    type: meta.type || 'model',
    status: statusType,
    status_label: meta.status_label || 'Generating...',
    created_at: Date.now(),
    prompt: meta.prompt || '',
    root_prompt: meta.root_prompt || meta.prompt || '',
    title: meta.prompt ? meta.prompt.slice(0, 50) + (meta.prompt.length > 50 ? '...' : '') : meta.status_label || 'Generating...',
    model: meta.model || 'latest',
    license: meta.license || 'private',
    batch_count: meta.batch_count || 1,
    batch_slot: meta.batch_slot || 1,
    batch_group_id: meta.batch_group_id || null,
    stage,
    thumbnail_url: meta.thumbnail_url || '',
    glb_url: meta.glb_url ?? '',
    glb_proxy: meta.glb_proxy ?? '',
    lineage_origin_id: meta.lineage_origin_id || meta.lineage_root_id || meta.batch_group_id || jobId,
    lineage_root_id: meta.lineage_origin_id || meta.lineage_root_id || meta.batch_group_id || jobId,
  };

  State.addHistoryItem(placeholder);
  State.setHistoryActiveModelId(jobId);
  State.historyFreshThumbs.add(jobId);
  renderHistory();
}

// ============================================================================
// JOB WATCHERS
// ============================================================================

/**
 * Watch a text-to-3D job until completion
 */
export function watchJob(job_id, { isRecovery = false } = {}) {
  if (State.watchers.has(job_id)) return;

  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(job_id, ctl);

  const prog = UI.makeProgressDriver();
  let notFoundAttempts = 0;

  // Polling safety: max attempts and error tracking
  // Adaptive polling: 5s for first 30s (catch quick failures), then 10s steady state.
  // 3D generation takes 1-5 minutes — frequent polls waste DB connections.
  const MAX_POLL_ATTEMPTS = 120;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const INITIAL_DELAY = 5000;       // 5s — catch early failures quickly
  const STEADY_DELAY = 10000;       // 10s — steady state during generation
  const RAMP_UP_AFTER = 30000;      // switch to steady after 30s elapsed
  const pollStartedAt = Date.now();
  let pollAttempts = 0;
  let consecutiveErrors = 0;

  const poll = async (delay = INITIAL_DELAY) => {
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
      handleJobFailure('Generation timed out after max attempts', 'text-to-3d', { isRecovery });
      return;
    }

    try {
      // Cross-tab dedup: use broadcast from another tab if fresh
      const _xtab = _getCrossTabResult(job_id);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`/api/_mod/text-to-3d/status/${job_id}`);
      if (!_xtab && result.ok) _broadcastPollResult(job_id, result.data);

      // Fatal errors: stop polling immediately
      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        console.error(`[Text-to-3D] Server error (${result.status}) for job ${job_id}:`, result.error);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[Text-to-3D] Too many consecutive errors (${consecutiveErrors}), stopping poll`);
          State.watchers.delete(job_id);
          // Don't removeActiveJob — job may still be running on server
          // Offer manual retry instead of permanent failure
          offerStatusRetry(
            job_id,
            '/api/_mod/text-to-3d/status',
            () => watchJob(job_id, { isRecovery: true }),
            'Text-to-3D'
          );
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
        // Meshy often reports 0% throughout generation, then jumps to 100.
        // Simulate progress based on elapsed time so the user sees movement.
        // Preview typically takes 1-3 minutes; ramp to 85% over 2 minutes.
        const elapsed = Date.now() - pollStartedAt;
        const simulated = Math.min(85, Math.floor((elapsed / 120000) * 85));
        const pct = Math.min(98, Math.max(simulated, st.pct));
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
          model: meta.model || 'latest',
          license: meta.license || 'private',
          symmetry_mode: meta.symmetry_mode || 'auto',
          pose_mode: meta.pose_mode || '',
          batch_count: Math.max(1, parseInt(meta.batch_count, 10) || 1),
          batch_slot: meta.batch_slot || 1,
          batch_group_id: meta.batch_group_id || null,
          stage,
          thumbnail_url: st.thumbnail_url || '',
          glb_url: st.glb_url,
          glb_proxy: glbProxy,
          preview_task_id: previewTaskIdForHistory,
          lineage_origin_id: lineageRootId,
          lineage_root_id: lineageRootId,
        };

        if (State.historyHasJobId(job_id)) {
          State.updateHistoryItem(job_id, historyData);
        } else {
          State.addHistoryItem(historyData);
        }

        State.historyFreshThumbs.add(job_id);
        setTimeout(() => {
          State.historyFreshThumbs.delete(job_id);
          renderHistory();
        }, 1800);
        // Recovery: update history only, don't hijack the viewer
        if (!isRecovery) {
          State.setHistoryActiveModelId(job_id);
        }
        renderHistory();

        if (!isRecovery) {
          prog.jump(99, 'Downloading model...');
          await Viewer.loadModelWithFallback(glbProxy, st.glb_url);
          prog.done(st.stage === 'refine' ? 'Loaded refined model.' : 'Loaded preview model.');
          // Re-render after async model load to ensure the card shows
          // the finished thumbnail (the microtask render before the await
          // may have been blocked or dropped by rapid state changes).
          renderHistory();
        } else {
          prog.clear();
        }

        // Version stack: push for edit operations, dispatch event for action bar
        if (!isRecovery && (stage === 'remesh' || stage === 'texture')) {
          State.pushModelVersion({
            id: job_id,
            glb_url: glbProxy || st.glb_url,
            thumbnail_url: st.thumbnail_url || '',
            stage,
            prompt: meta.prompt || ''
          });
          window.dispatchEvent(new CustomEvent('model:edited', { detail: { id: job_id, stage } }));
        }

        // Show Discord share modal sparingly (once per 7 days, not on recovery)
        if (!isRecovery && shouldShowDiscordPrompt()) {
          markDiscordPromptShown();
          UI.showDiscordSharePrompt('model', meta.prompt || '', st.thumbnail_url || '');
        }
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
        const errorMsg = st.message || 'Job failed';
        prog.fail(errorMsg);
        State.updateHistoryItem(job_id, { status: 'failed', status_label: errorMsg });
        renderHistory();
        handleJobFailure(errorMsg, 'refine', { isRecovery });
        return;
      }

      // Adaptive polling: fast for first 30s, then steady 8s
      const elapsed = Date.now() - pollStartedAt;
      const nextDelay = elapsed < RAMP_UP_AFTER
        ? Math.min(INITIAL_DELAY, delay)   // stay at 3s during ramp-up
        : STEADY_DELAY;                    // 8s steady state
      setTimeout(() => poll(nextDelay), nextDelay);
    } catch (err) {
      // Unexpected error - increment error counter and retry with backoff
      consecutiveErrors++;
      console.error(`[Text-to-3D] Unexpected error polling job ${job_id}:`, err);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[Text-to-3D] Too many consecutive errors, stopping poll`);
        State.watchers.delete(job_id);
        offerStatusRetry(
          job_id,
          '/api/_mod/text-to-3d/status',
          () => watchJob(job_id, { isRecovery: true }),
          'Text-to-3D'
        );
        return;
      }

      // Retry with longer backoff on errors
      const retryDelay = Math.min(STEADY_DELAY * 2, delay * 2);
      setTimeout(() => poll(retryDelay), retryDelay);
    }
  };
  poll();
}

/**
 * Watch a Meshy task (remesh, texture, rig, image3d)
 */
export function watchMeshyTask(job_id, kind = 'remesh', { isRecovery = false } = {}) {
  if (State.watchers.has(job_id)) return;
  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(job_id, ctl);

  const endpoint = kind === 'texture'
    ? '/api/_mod/mesh/retexture'
    : kind === 'image3d'
      ? '/api/_mod/image-to-3d/status'
      : '/api/_mod/mesh/remesh';

  const stageLabel = kind === 'texture'
    ? 'Texturing'
    : kind === 'image3d'
      ? 'Image to 3D'
      : 'Remeshing';

  const prog = UI.makeProgressDriver();

  // For image3d, simulate progress since Meshy API doesn't return real progress
  const startTime = Date.now();
  const estimatedDuration = kind === 'image3d' ? 120000 : 60000; // 2 mins for image3d, 1 min for others
  let simulatedPct = 0;

  // Polling safety: adaptive timing to reduce DB pressure
  const MAX_POLL_ATTEMPTS = 120;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const INITIAL_DELAY = 5000;
  const STEADY_DELAY = 10000;
  const RAMP_UP_AFTER = 30000;
  const pollStartedAt = Date.now();
  let pollAttempts = 0;
  let consecutiveErrors = 0;

  const poll = async (delay = INITIAL_DELAY) => {
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
      handleJobFailure(`${stageLabel} timed out after max attempts`, kind, { isRecovery });
      return;
    }

    try {
      // Cross-tab dedup: use broadcast from another tab if fresh
      const _xtab = _getCrossTabResult(job_id);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`${endpoint}/${job_id}`);
      if (!_xtab && result.ok) _broadcastPollResult(job_id, result.data);

      // Fatal errors: stop polling immediately
      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        console.error(`[${stageLabel}] Server error (${result.status}) for job ${job_id}:`, result.error);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[${stageLabel}] Too many consecutive errors (${consecutiveErrors}), stopping poll`);
          State.watchers.delete(job_id);
          offerStatusRetry(
            job_id,
            endpoint,
            () => watchMeshyTask(job_id, kind, { isRecovery: true }),
            stageLabel
          );
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
          || (st.model_urls && st.model_urls.glb)
          || '';
        // Use S3 URL directly if available (no proxy needed), otherwise proxy Meshy URLs
        const glbProxy = glbDirect ? getLoadableModelUrl(glbDirect) : '';
        const existingItem = State.findHistoryItem(job_id) || {};
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
          model: meta.model || 'latest',
          license: meta.license || 'private',
          stage: kind,
          thumbnail_url: st.thumbnail_url || meta.thumbnail_url || '',
          glb_url: glbDirect,
          glb_proxy: glbProxy,
          preview_task_id: meta.preview_task_id || null,
          lineage_origin_id: lineageRootId,
          lineage_root_id: lineageRootId,
          texture_urls: st.texture_urls || [],
          model_urls: st.model_urls || {},
        };
        if (promptCandidate) historyData.prompt = promptCandidate;
        if (rootPromptCandidate) historyData.root_prompt = rootPromptCandidate;
        if (titleCandidate) historyData.title = titleCandidate;
        if (fingerprintSource) historyData.prompt_fingerprint = promptFingerprint(fingerprintSource);

        if (State.historyHasJobId(job_id)) State.updateHistoryItem(job_id, historyData);
        else State.addHistoryItem(historyData);

        // Recovery: update history only, don't hijack the viewer
        if (!isRecovery) {
          State.setHistoryActiveModelId(job_id);
        }
        State.historyFreshThumbs.add(job_id);
        setTimeout(() => {
          State.historyFreshThumbs.delete(job_id);
          renderHistory();
        }, 1800);
        renderHistory();

        if (!isRecovery && glbDirect) {
          prog.jump(99, 'Downloading model...');
          await Viewer.loadModelWithFallback(glbProxy || glbDirect, glbDirect);
          prog.done(`${stageLabel} complete.`);
        } else if (isRecovery) {
          prog.clear();
        } else {
          prog.done(`${stageLabel} complete.`);
        }

        // Show Discord share modal for texture completions (respects cooldown, not on recovery)
        if (!isRecovery && kind === 'texture' && shouldShowDiscordPrompt()) {
          markDiscordPromptShown();
          UI.showDiscordSharePrompt('model', meta.prompt || promptCandidate || '', st.thumbnail_url || meta.thumbnail_url || '');
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
        const errorMsg = st.message || `${stageLabel} failed`;
        prog.fail(errorMsg);
        State.updateHistoryItem(job_id, { status: 'failed', status_label: errorMsg });
        renderHistory();
        handleJobFailure(errorMsg, kind, { isRecovery });
        return;
      }

      // Adaptive polling: fast for first 30s, then steady 8s
      const elapsed = Date.now() - pollStartedAt;
      const nextDelay = elapsed < RAMP_UP_AFTER
        ? Math.min(INITIAL_DELAY, delay)
        : STEADY_DELAY;
      setTimeout(() => poll(nextDelay), nextDelay);
    } catch (err) {
      // Unexpected error - increment error counter and retry with backoff
      consecutiveErrors++;
      console.error(`[${stageLabel}] Unexpected error polling job ${job_id}:`, err);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[${stageLabel}] Too many consecutive errors, stopping poll`);
        State.watchers.delete(job_id);
        offerStatusRetry(
          job_id,
          endpoint,
          () => watchMeshyTask(job_id, kind, { isRecovery: true }),
          stageLabel
        );
        return;
      }

      // Retry with longer backoff on errors
      const retryDelay = Math.min(STEADY_DELAY * 2, delay * 2);
      setTimeout(() => poll(retryDelay), retryDelay);
    }
  };
  poll();
}

/**
 * @deprecated Use watchImageJob() instead — delegates to unified handler.
 */
export function watchOpenAIImageJob(jobId, reservationId, meta = {}) {
  watchImageJob(jobId, reservationId, { ...meta, provider: meta.provider || 'openai' });
}

/** @deprecated Use watchImageJob() instead — delegates to unified handler. */
export function watchGeminiImageJob(jobId, reservationId, meta = {}) {
  watchImageJob(jobId, reservationId, { ...meta, provider: meta.provider || 'google' });
}

// ============================================================================
// MESHY TASK STARTER (shared)
// ============================================================================

/**
 * Begin a Meshy task (remesh, texture)
 */
async function beginMeshyTask(kind, payload, meta = {}) {
  // Check credits before proceeding
  if (!checkCreditsFor(kind)) {
    return;
  }

  const endpoint = kind === 'texture'
    ? '/api/_mod/mesh/retexture'
    : '/api/_mod/mesh/remesh';
  const statusLabel = kind === 'texture' ? 'Texturing...' : 'Remeshing...';
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
  if (!acquireSubmitLock()) return;

  // Check if Multi-Image to 3D tab is active
  const multiImage3dTab = byId('multiimage3d');
  const isMultiImage3dMode = multiImage3dTab && !multiImage3dTab.classList.contains('hidden');

  if (isMultiImage3dMode) {
    releaseSubmitLock();
    return startMultiImageTo3D();
  }

  // Check if Image to 3D tab is active
  const image3dTab = byId('image3d');
  const isImage3dMode = image3dTab && !image3dTab.classList.contains('hidden');

  if (isImage3dMode) {
    releaseSubmitLock();
    return startImageTo3DFromUpload();
  }

  // Get batch count first for credit check
  const batchRaw = parseInt(byId('modelBatchCount')?.value || '1', 10);
  const batchCount = Math.min(4, Math.max(1, Number.isFinite(batchRaw) ? batchRaw : 1));

  // Check credits for entire batch before proceeding
  if (!checkCreditsFor('text-to-3d', batchCount)) {
    releaseSubmitLock();
    return;
  }

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
    if (prompt.length > 800) {
      prog.clear();
      alert(`Your prompt is ${prompt.length} characters. Please shorten it to 800 characters or fewer.`);
      return;
    }

    const model = byId('modelAIModel')?.value || byId('modelSelect')?.value || 'latest';
    const license = (byId('modelLicense')?.value || 'private').trim() || 'private';
    const symmetry = (byId('modelSymmetry')?.value || 'auto').trim() || 'auto';
    const poseMode = byId('modelPoseMode')?.value || '';
    const batchGroupId = createBatchGroupId();

    log('Generating with:', { prompt, model, batchCount, symmetry, poseMode, license });

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
        model,
        root_prompt: prompt,
        license,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        stage: 'preview',
        status_label: 'Starting...',
        idempotency_key: idempotencyKey
      };
      addGeneratingPlaceholder(tempId, tempMeta);
      State.savePendingMeta(tempId, tempMeta);

      // Collect advanced options
      const modelType = byId('modelModelType')?.value || '';
      const shouldRemesh = byId('modelShouldRemesh')?.checked || false;
      const shouldTexture = byId('modelShouldTexture')?.checked ?? true;

      const payload = {
        prompt,
        model,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        license,
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        refine: false
      };

      if (modelType) payload.model_type = modelType;
      if (shouldRemesh) payload.should_remesh = true;
      if (!shouldTexture) payload.should_texture = false;

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
        model,
        root_prompt: prompt,
        license,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
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
    releaseSubmitLock();
    const allGenBtns = document.querySelectorAll('button[id*="generate"]');
    allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
  }
}

// Image credits — provider-specific (reads from GenerationState capabilities)
// Nano Banana (premium): standard 15c, high 20c, 4k 30c (EXCLUSIVE)
// OpenAI / Google:       standard 10c, high 15c (no 4K)
const IMAGE_ACTION_BY_QUALITY = { standard: 'image_generate', high: 'image_generate_2k', '4k': 'image_generate_4k' };

/**
 * Get image credits for the current quality + provider from GenerationState
 * @param {string} quality - 'standard' or 'high'
 * @returns {number}
 */
function getImageCredits(quality = 'standard') {
  const snapshot = window.GenerationState?.getGenerationSnapshot?.('image');
  if (snapshot?.capabilities?.creditsByQuality) {
    return snapshot.capabilities.creditsByQuality[quality] ?? snapshot.capabilities.credits ?? 4;
  }
  // Fallback: cheapest tier (OpenAI/Gemini)
  return quality === 'high' ? 8 : 4;
}

/**
 * Get the action key for image generation based on quality
 * @param {string} quality - 'standard' or 'high'
 * @returns {string}
 */
function getImageActionKey(quality = 'standard') {
  return IMAGE_ACTION_BY_QUALITY[quality] || 'image_generate';
}

// Map shape to OpenAI gpt-image-1 resolution
// gpt-image-1 only supports: 1024x1024, 1024x1536, 1536x1024
const OPENAI_SHAPE_MAP = {
  square: '1024x1024',      // 1:1
  portrait: '1024x1536',    // 2:3 (portrait)
  landscape: '1536x1024',   // 3:2 (landscape)
};

// Map quality to OpenAI image_size tier (for pricing — OpenAI API uses pixel sizes, not 1K/2K)
const OPENAI_QUALITY_MAP = {
  standard: '1K',
  high: '2K'
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

  // Single generation guard: covers both submit lock and UI-level lock
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[OpenAI Image] Generation already in progress');
    return;
  }

  // Get settings from State first to determine credit cost
  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const settings = {
    provider: 'openai',
    shape: stateSettings.shape || 'square',
    quality: stateSettings.quality || 'standard'
  };

  // Get dynamic credits based on quality + provider
  const imageCredits = getImageCredits(settings.quality);
  const imageActionKey = getImageActionKey(settings.quality);

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(imageCredits, 'image');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'image');
    return;
  }

  acquireSubmitLock();

  const prog = UI.makeProgressDriver();
  let promptRaw = (byId('imagePrompt')?.value || '').trim();
  if (!promptRaw) promptRaw = 'Generated image';

  console.log('[OpenAI Image] Using settings from State:', JSON.stringify(settings), 'credits:', imageCredits);

  // Map shape to OpenAI resolution, quality to image_size tier (for pricing)
  const resolution = OPENAI_SHAPE_MAP[settings.shape] || '1024x1024';
  const imageSize = OPENAI_QUALITY_MAP[settings.quality] || '1K';
  const model = 'gpt-image-1';

  // Snapshot settings for this job
  const settingsSnapshot = {
    prompt: promptRaw,
    shape: settings.shape,
    quality: settings.quality,
    resolution,
    model,
    credits: imageCredits
  };

  // Reserve EXACT credits BEFORE API call (not multiplied by action cost)
  // Canonical action key varies by quality — cost depends on provider
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount(imageActionKey, imageCredits);
  if (reservation.insufficient) {
    releaseSubmitLock();
    showInsufficientCreditsModal(imageCredits, creditCheck.available, 'image');
    return;
  }

  // Generate idempotency key for this image generation
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `openai-temp-${Date.now()}`);

  // Lock UI with provider and settings snapshot
  if (window.ImageJobControl?.lock) {
    window.ImageJobControl.lock('openai', settingsSnapshot, tempId, reservation.reservationId);
  }

  addGeneratingPlaceholder(tempId, {
    type: 'image',
    status_label: 'Generating image...',
    prompt: promptRaw,
    stage: 'image',
    provider: 'openai',
    provider_used: 'openai',
    idempotency_key: idempotencyKey,
    image_url: '',
  });

  let activeHistoryId = tempId;

  try {
    prog.label('Queueing image...');

    // Debug log before API call
    const payload = {
      prompt: promptRaw,
      size: resolution,
      image_size: imageSize,
      model,
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=openai cost=' + imageCredits +
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
        State.deleteHistoryItem(tempId, { skipRemote: true });
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
      addGeneratingPlaceholder(activeHistoryId, {
        type: 'image',
        status_label: 'Generating image...',
        prompt: promptRaw,
        stage: 'image',
        provider: 'openai',
        provider_used: 'openai',
        image_url: '',
      });
    }

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
    watchImageJob(activeHistoryId, reservation.reservationId, {
      prompt: promptRaw,
      model,
      size: resolution,
      provider: 'openai',
      provider_used: 'openai'
    });
    // Note: UI unlock will happen in watchImageJob when job completes
  } catch (err) {
    console.error('[OpenAI] Error:', err);
    prog.fail(err?.message || 'Image generation failed');
    alert(err?.message || 'Image generation failed.');
    // Clean up placeholder on error
    State.deleteHistoryItem(activeHistoryId, { skipRemote: true });
    renderHistory();
    // Unlock UI on error
    if (window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  } finally {
    releaseSubmitLock();
  }
}

// Map shape to Google aspect ratio format
const GOOGLE_SHAPE_MAP = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9',
};

// Map quality to Google imageSize (Imagen 4.0 only supports 1K and 2K)
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

  // Single generation guard: covers both submit lock and UI-level lock
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[Gemini Image] Generation already in progress');
    return;
  }

  // Get settings from State first to determine credit cost
  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const settings = {
    provider: 'google',
    shape: stateSettings.shape || 'square',
    quality: stateSettings.quality || 'standard'
  };

  // Get dynamic credits based on quality + provider
  const imageCredits = getImageCredits(settings.quality);
  const imageActionKey = getImageActionKey(settings.quality);

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(imageCredits, 'image');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'image');
    return;
  }

  acquireSubmitLock();

  const prog = UI.makeProgressDriver();
  let promptRaw = (byId('imagePrompt')?.value || '').trim();
  if (!promptRaw) promptRaw = 'Generated image';

  console.log('[Gemini Image] Using settings from State:', JSON.stringify(settings), 'credits:', imageCredits);

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
    credits: imageCredits
  };

  // Reserve EXACT credits BEFORE API call (not multiplied by action cost)
  // Canonical action key varies by quality — cost depends on provider
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount(imageActionKey, imageCredits);
  if (reservation.insufficient) {
    releaseSubmitLock();
    showInsufficientCreditsModal(imageCredits, creditCheck.available, 'image');
    return;
  }

  // Generate idempotency key for this image generation
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `gemini-temp-${Date.now()}`);

  // Lock UI with provider and settings snapshot
  if (window.ImageJobControl?.lock) {
    window.ImageJobControl.lock('google', settingsSnapshot, tempId, reservation.reservationId);
  }

  addGeneratingPlaceholder(tempId, {
    type: 'image',
    status_label: 'Generating image with Imagen...',
    prompt: promptRaw,
    stage: 'image',
    provider: 'google',
    provider_used: 'google',
    idempotency_key: idempotencyKey,
    image_url: '',
  });

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
    console.log('[GEN] mode=image provider=google cost=' + imageCredits +
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
        watchImageJob(tempId, reservation.reservationId, {
          prompt: promptRaw,
          provider: 'google',
          provider_used: 'google',
          isTimeoutRecovery: true
        });

        startLock = false;
        return;
      }
      if (handleApiError(result, 'image_generate', reservation.reservationId)) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
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

      // Replace temp placeholder with real job ID
      if (imageId !== tempId) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        addGeneratingPlaceholder(imageId, {
          type: 'image',
          status_label: 'Generating image with Gemini...',
          prompt: promptRaw,
          stage: 'image',
          provider: 'google',
          provider_used: 'google',
          model: 'imagen-4.0',
          image_url: '',
        });
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

      // Start polling - watchImageJob handles unlock on completion/failure
      watchImageJob(imageId, backendReservationId, {
        prompt: promptRaw,
        provider: 'google',
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
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
  } finally {
    releaseSubmitLock();
    // Only unlock if we didn't start a watcher (watcher handles its own unlock)
    // The watcher path returns early, so if we're here, unlock is needed
    if (window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  }
}

// Map shape to Nano Banana aspect ratio (same as Google format)
const NANO_BANANA_SHAPE_MAP = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9',
};

// Map quality to Nano Banana resolution (4K is exclusive to Nano Banana)
const NANO_BANANA_QUALITY_MAP = {
  standard: '1K',
  high: '2K',
  '4k': '4K'
};

/**
 * Start Nano Banana (PiAPI) image generation
 * IMPORTANT: Provider must be 'nano_banana' in GenerationState before calling this.
 */
export async function startNanoBananaImageGeneration() {
  // Verify provider is actually nano_banana (defensive check)
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'nano_banana') {
    console.error(`[Nano Banana] BLOCKED: State provider is '${stateProvider}', not 'nano_banana'`);
    return;
  }

  console.log('[Image] Nano Banana generation started (provider=nano_banana, state=' + stateProvider + ')');

  // Single generation guard: covers both submit lock and UI-level lock
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[Nano Banana] Generation already in progress');
    return;
  }

  // Get settings from State first to determine credit cost
  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const settings = {
    provider: 'nano_banana',
    shape: stateSettings.shape || 'square',
    quality: stateSettings.quality || 'standard'
  };

  // Get dynamic credits based on quality + provider
  const imageCredits = getImageCredits(settings.quality);
  const imageActionKey = getImageActionKey(settings.quality);

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(imageCredits, 'image');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'image');
    return;
  }

  acquireSubmitLock();

  const prog = UI.makeProgressDriver();
  let promptRaw = (byId('imagePrompt')?.value || '').trim();
  if (!promptRaw) promptRaw = 'Generated image';

  console.log('[Nano Banana] Using settings from State:', JSON.stringify(settings), 'credits:', imageCredits);

  // Map shape to aspect ratio, quality to resolution
  const aspectRatio = NANO_BANANA_SHAPE_MAP[settings.shape] || '1:1';
  const imageSize = NANO_BANANA_QUALITY_MAP[settings.quality] || '1K';

  // Snapshot settings for this job
  const settingsSnapshot = {
    prompt: promptRaw,
    shape: settings.shape,
    quality: settings.quality,
    aspectRatio,
    imageSize,
    credits: imageCredits
  };

  // Reserve EXACT credits BEFORE API call
  prog.label('Reserving credits...');
  const reservation = reserveExactAmount(imageActionKey, imageCredits);
  if (reservation.insufficient) {
    releaseSubmitLock();
    showInsufficientCreditsModal(imageCredits, creditCheck.available, 'image');
    return;
  }

  // Generate idempotency key
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `nb-temp-${Date.now()}`);

  // Lock UI with provider and settings snapshot
  if (window.ImageJobControl?.lock) {
    window.ImageJobControl.lock('nano_banana', settingsSnapshot, tempId, reservation.reservationId);
  }

  addGeneratingPlaceholder(tempId, {
    type: 'image',
    status_label: 'Generating image with Nano Banana...',
    prompt: promptRaw,
    stage: 'image',
    provider: 'nano_banana',
    provider_used: 'nano_banana',
    idempotency_key: idempotencyKey,
    image_url: '',
  });

  try {
    prog.label('Generating image with Nano Banana...');

    const payload = {
      provider: 'nano_banana',
      prompt: promptRaw,
      aspect_ratio: aspectRatio,
      image_size: imageSize,
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=nano_banana cost=' + imageCredits +
                ' available=' + creditCheck.available + ' payload=' + JSON.stringify(payload));

    // Call unified endpoint with provider=nano_banana and idempotency key
    const result = await apiFetch('/api/image/generate', {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      // Handle timeout gracefully
      if (handleGenerationTimeout(result, 'image_generate')) {
        console.log('[Nano Banana] Timeout - showing inline status and starting poll');
        State.updateHistoryItem(tempId, {
          status: 'generating',
          status_label: 'Still generating... (checking server)'
        });
        renderHistory();
        prog.label('Still generating...');

        watchImageJob(tempId, reservation.reservationId, {
          prompt: promptRaw,
          provider: 'nano_banana',
          provider_used: 'nano_banana',
          isTimeoutRecovery: true
        });

        startLock = false;
        return;
      }
      if (handleApiError(result, 'image_generate', reservation.reservationId)) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        renderHistory();
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error?.message || result.error || `Nano Banana image failed: HTTP ${result.status}`);
    }

    const data = result.data;
    const imageId = data.image_id || data.job_id;
    const imageUrl = data.image_url;
    const jobStatus = data.status;

    // Handle async response (status: "queued") - start polling
    if (jobStatus === 'queued' && imageId) {
      console.log('[Nano Banana] Job queued, starting watcher:', imageId);

      // Replace temp placeholder with real job ID
      if (imageId !== tempId) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        addGeneratingPlaceholder(imageId, {
          type: 'image',
          status_label: 'Generating image with Nano Banana...',
          prompt: promptRaw,
          stage: 'image',
          provider: 'nano_banana',
          provider_used: 'nano_banana',
          model: 'nano-banana-2',
          image_url: '',
        });
      }

      const backendReservationId = data.reservation_id || reservation.reservationId;

      if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
        window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'nano_banana_image_queued');
      }

      State.addActiveJob(imageId);
      State.savePendingMeta(imageId, {
        prompt: promptRaw,
        stage: 'image',
        type: 'image',
        provider: 'nano_banana'
      });

      // Start polling
      watchImageJob(imageId, backendReservationId, {
        prompt: promptRaw,
        provider: 'nano_banana',
        provider_used: 'nano_banana'
      });

      startLock = false;
      return;
    }

    // Handle sync response (unlikely for PiAPI but keep for safety)
    if (!imageUrl) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No image returned from Nano Banana');
    }

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
      provider: 'nano_banana',
      provider_used: 'nano_banana',
      model: 'nano-banana-2'
    };

    if (imageId && imageId !== tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.addHistoryItem(finalItem);
      State.setHistoryActiveModelId(imageId);
    } else {
      State.updateHistoryItem(tempId, finalItem);
    }

    renderHistory();
    prog.done('Image generated!');

    if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
      window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'nano_banana_image_response');
    } else if (window.WorkspaceCredits?.syncWithBackend) {
      window.WorkspaceCredits.syncWithBackend();
    }

  } catch (err) {
    console.error('[Nano Banana] Error:', err);
    prog.fail(err?.message || 'Nano Banana image generation failed');
    alert(err?.message || 'Nano Banana image generation failed.');
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
  } finally {
    releaseSubmitLock();
    if (window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  }
}

/** @deprecated Use watchImageJob() instead — delegates to unified handler. */
export function watchNanoBananaImageJob(jobId, reservationId, meta = {}) {
  watchImageJob(jobId, reservationId, { ...meta, provider: meta.provider || 'nano_banana' });
}


/**
 * Unified image job watcher — works for all image providers.
 * Polls the canonical /api/_mod/image/status/<job_id> endpoint which
 * resolves the provider server-side from the DB job row.
 *
 * Replaces the need to choose between watchOpenAIImageJob, watchGeminiImageJob,
 * and watchNanoBananaImageJob on the frontend.
 */
export function watchImageJob(jobId, reservationId, meta = {}) {
  if (State.watchers.has(jobId)) return;
  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(jobId, ctl);

  const prog = UI.makeProgressDriver();
  const startTime = meta.created_at ? new Date(meta.created_at).getTime() : Date.now();
  const estimatedDuration = 45000;
  const maxPollingDuration = 180000; // 3 minutes max
  let notFoundCount = 0;
  const maxNotFoundRetries = meta.isTimeoutRecovery ? 10 : 5;

  const poll = async (delay = 1500) => {
    if (aborted) return;

    const elapsed = Date.now() - startTime;
    if (elapsed > maxPollingDuration) {
      console.log('[Image] Max polling duration exceeded');
      prog.fail('Generation timed out. Your credits will be refunded if generation failed.');
      State.updateHistoryItem(jobId, { status: 'failed', status_label: 'Generation timed out' });
      renderHistory();
      if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
      if (window.ImageJobControl?.unlock) window.ImageJobControl.unlock();
      State.watchers.delete(jobId);
      State.removeActiveJob(jobId);
      return;
    }

    try {
      // Cross-tab dedup: use broadcast from another tab if fresh
      const _xtab = _getCrossTabResult(jobId);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`/api/_mod/image/status/${jobId}`);
      if (!_xtab && result.ok) _broadcastPollResult(jobId, result.data);

      if (result.status === 404) {
        notFoundCount++;
        const pct = Math.min(90, Math.floor(90 * (elapsed / estimatedDuration)));
        prog.jump(pct);
        prog.label('Still generating...');
        updateThumbnailProgress(jobId, pct);

        if (notFoundCount >= maxNotFoundRetries) {
          prog.fail('Generation failed - job not found on server');
          State.updateHistoryItem(jobId, { status: 'failed', status_label: 'Job not found' });
          renderHistory();
          releaseCreditsReservation(reservationId);
          if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
          if (window.ImageJobControl?.unlock) window.ImageJobControl.unlock();
          State.watchers.delete(jobId);
          State.removeActiveJob(jobId);
          return;
        }
        setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
        return;
      }

      notFoundCount = 0;
      const st = result.data || {};
      if (st.message) prog.label(st.message);

      if (st.status !== 'done' && st.status !== 'failed') {
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
          throw new Error('Provider did not return an image URL');
        }

        const provider = st.provider || meta.provider || 'unknown';
        const historyData = {
          id: jobId,
          type: 'image',
          status: 'finished',
          status_label: '',
          created_at: Date.now(),
          prompt: meta.prompt || '',
          title: shortTitle(meta.prompt || 'Generated image'),
          image_url: imageUrl,
          thumbnail_url: st.thumbnail_url || imageUrl,
          stage: 'image',
          provider: provider,
          provider_used: meta.provider_used || provider,
          model: st.model || meta.model || ''
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

        if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
          window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'image_done');
        } else if (window.WorkspaceCredits?.syncWithBackend) {
          window.WorkspaceCredits.syncWithBackend();
        } else {
          refreshCreditsInBackground();
        }

        if (window.ImageJobControl?.unlock) window.ImageJobControl.unlock();
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
        State.updateHistoryItem(jobId, { status: 'failed', status_label: errorMsg });
        renderHistory();

        if (window.ImageJobControl?.unlock) window.ImageJobControl.unlock();
        State.watchers.delete(jobId);
        State.removeActiveJob(jobId);
        return;
      }

      setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
    } catch (err) {
      console.error('[Image] Poll error:', err);
      setTimeout(() => poll(2000), 2000);
    }
  };

  poll();
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

  renderHistory();

  if (provider === 'nano_banana') {
    await startNanoBananaImageGeneration();
  } else if (provider === 'openai') {
    await startOpenAIImageGeneration();
  } else if (provider === 'google') {
    await startGeminiImageGeneration();
  } else {
    // NO FALLBACK - show error and stop
    console.error(`[Image] Unknown provider: ${provider} - NO FALLBACK`);
    alert(`Image provider "${provider}" is not available. Please select Nano Banana, OpenAI, or Google.`);
  }
}

// Map simplified aspect names to API ratio strings.
// Vertex uses "landscape"/"portrait" names; Seedance passes ratios directly
// (e.g. "16:9", "1:1") which fall through via || aspectVal in the caller.
const VIDEO_ASPECT_MAP = {
  landscape: '16:9',
  portrait: '9:16',
};

/**
 * Canonical video credit costs (MUST match backend pricing_service.py)
 * This is the SINGLE SOURCE OF TRUTH for frontend video pricing.
 *
 * Resolution constraints:
 * - 720p: 4s, 6s, or 8s
 * - 1080p: 8s only
 * - 4k: 8s only
 */
// Vertex Veo 3.1: 12 c/s (margin-stabilized). All modes equalized.
const VIDEO_CREDIT_COSTS = {
  '720p':  { 4: 48, 6: 72, 8: 96 },
  '1080p': { 8: 120 },
  '4k':    { 8: 156 }
};

// Image-to-Video costs — EQUALIZED with text-to-video (no premium)
const VIDEO_IMAGE_CREDIT_COSTS = {
  '720p':  { 4: 48, 6: 72, 8: 96 },
  '1080p': { 8: 120 },
  '4k':    { 8: 156 }
};

// Seedance: Fast=STANDARD (10 cps), Preview=PREMIUM (16 cps)
const SEEDANCE_CPS = { fast: 10, preview: 16 };
// fal Seedance 1.5 Pro: BUDGET tier (8 cps)
const FAL_SEEDANCE_CPS = 8;

/**
 * Check if a provider belongs to the Seedance family (fal or PiAPI).
 * Use this instead of binary `=== 'seedance'` checks.
 */
function _isSeedanceProvider(provider) {
  return provider === 'seedance' || provider === 'fal_seedance';
}

/**
 * Get display name for a provider.
 */
function _providerDisplayName(provider) {
  if (provider === 'fal_seedance') return 'Seedance';
  if (provider === 'seedance') return 'Seedance 2.0';
  return 'Veo';
}

/**
 * Get video credit cost based on provider, resolution and duration.
 * Uses VideoJobControl if available, falls back to local costs.
 *
 * @param {Object} settings - { provider, durationSec, resolution }
 * @returns {number} Total credits (40-240)
 */
function getVideoCredits(settings) {
  // Prefer VideoJobControl.computeCredits() as single source of truth
  if (window.VideoJobControl?.computeCredits) {
    return window.VideoJobControl.computeCredits(settings);
  }

  // fal Seedance: BUDGET tier (8 cps)
  if (settings.provider === 'fal_seedance') {
    return FAL_SEEDANCE_CPS * (settings.durationSec || 5);
  }

  // Seedance (PiAPI): tier * duration (Fast=10 cps, Preview=16 cps)
  if (settings.provider === 'seedance') {
    const tier = settings.seedanceTier || 'fast';
    const cps = SEEDANCE_CPS[tier] || 10;
    return cps * (settings.durationSec || 5);
  }

  // Veo — all modes equalized (no image-to-video premium)
  const resolution = settings.resolution || '720p';
  const duration = settings.durationSec || 4;
  const resolutionCosts = VIDEO_CREDIT_COSTS[resolution] || VIDEO_CREDIT_COSTS['720p'];
  return resolutionCosts[duration] || 96;
}

/**
 * Compose Seedance prompt: [main]. [style phrase]. [motion phrase].
 * For non-Seedance providers, returns the original prompt unchanged.
 */
function _composeSeedancePrompt(mainPrompt, stylePreset, motionText, settings) {
  if (!settings || !_isSeedanceProvider(settings.provider)) return mainPrompt;
  if (!mainPrompt) return mainPrompt;

  const SEEDANCE_STYLE_PHRASES = {
    cinematic: 'Cinematic style.',
    realistic: 'Realistic style.',
    anime: 'Anime style.',
    fantasy: 'Fantasy style.',
    cyberpunk: 'Cyberpunk style.',
    cartoon: 'Cartoon style.',
  };

  let composed = mainPrompt.trim();
  if (stylePreset && stylePreset !== 'auto' && SEEDANCE_STYLE_PHRASES[stylePreset]) {
    composed += ' ' + SEEDANCE_STYLE_PHRASES[stylePreset];
  }
  if (motionText && motionText.trim()) {
    composed += ' ' + motionText.trim() + '.';
  }
  return composed;
}

/**
 * Start video generation
 */
export async function startVideoGeneration() {
  if (!acquireSubmitLock()) return;

  // Dispatch generation:start event (e.g., to close Inspire panel)
  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'video' } }));

  // Get video settings from UI (use window.VideoJobControl if available, else read directly)
  // Resolution values: "720p", "1080p", "4k" (NOT "standard" or "high")
  const aspectVal = byId('videoAspectRatio')?.value || 'landscape';
  const settings = window.VideoJobControl?.getSettings?.() || {
    provider: byId('videoAIProvider')?.value || 'vertex',
    durationSec: parseInt(byId('videoDuration')?.value || '4', 10),
    resolution: byId('videoQuality')?.value || '720p',
    aspect: aspectVal,
    aspectRatio: VIDEO_ASPECT_MAP[aspectVal] || aspectVal || '16:9',
    loop: byId('videoLoop')?.checked ?? true,
    mode: byId('videoModeValue')?.value || 'text2video'
  };

  // Read provider from UI (vertex or seedance)
  if (!settings.provider || settings.provider === 'google' || settings.provider === 'veo') {
    settings.provider = byId('videoAIProvider')?.value || 'vertex';
  }

  const motion = (byId('videoMotion')?.value || '').trim();
  const prompt = (byId('videoTextPrompt')?.value || '').trim();
  const stylePreset = byId('videoStylePreset')?.value || '';
  const motionPreset = byId('videoMotionPreset')?.value || '';

  const totalCredits = getVideoCredits(settings);

  console.log('[VIDEO] Credit check:', {
    provider: settings.provider,
    durationSec: settings.durationSec,
    resolution: settings.resolution,
    computedCredits: totalCredits,
  });

  // Unified credit check with proper numeric conversion
  const creditCheck = checkCreditsForGeneration(totalCredits, 'video');
  if (creditCheck.shouldBlock) {
    console.warn('[VIDEO] Credit check blocked:', creditCheck);
    releaseSubmitLock();
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'video');
    return;
  }

  const prog = UI.makeProgressDriver();

  // Reserve the EXACT computed credits (not multiplied by action cost)
  prog.label('Reserving credits...');
  console.log('[VIDEO] Reserving exact amount:', totalCredits, 'credits');
  const reservation = reserveExactAmount('video', totalCredits);
  if (reservation.insufficient) {
    console.warn('[VIDEO] Reservation failed:', reservation);
    releaseSubmitLock();
    showInsufficientCreditsModal(totalCredits, creditCheck.available, 'video');
    return;
  }
  console.log('[VIDEO] Reservation succeeded:', reservation.reservationId, 'for', reservation.amount, 'credits');

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
    prompt: (byId('videoAnimationPrompt')?.value || '').trim() || (byId('videoTransitionPrompt')?.value || '').trim() || prompt || motion || 'Video generation',
    title: shortTitle((byId('videoAnimationPrompt')?.value || '').trim() || (byId('videoTransitionPrompt')?.value || '').trim() || prompt || motion || 'Video'),
    video_url: '',
    thumbnail_url: '',
    stage: 'video',
    provider: settings.provider || 'vertex',
    provider_used: settings.provider || 'vertex',
    credits_used: totalCredits,
    idempotency_key: idempotencyKey
  };
  State.addHistoryItem(placeholder);
  State.setHistoryActiveModelId(tempId);
  renderHistory();

  try {
    prog.label(_isSeedanceProvider(settings.provider)
      ? `Sending to ${_providerDisplayName(settings.provider)}${settings.seedanceTier === 'preview' ? ' Preview' : ''}...`
      : 'Sending to Veo...');

    // Build payload for Veo
    let endpoint;
    let payload;

    if (settings.mode === 'image2video') {
      // ── Image → video (animate or transition) ──
      const imgSubMode = byId('videoImgModeValue')?.value || 'animate_image';
      endpoint = '/api/video/animate';

      if (imgSubMode === 'image_transition') {
        // ── Image Transition: two images + transition prompt ──
        const startSrc = byId('videoStartImagePreview')?.src || '';
        const endSrc = byId('videoEndImagePreview')?.src || '';
        const hasStart = startSrc.startsWith('data:') || startSrc.startsWith('http');
        const hasEnd = endSrc.startsWith('data:') || endSrc.startsWith('http');

        if (!hasStart || !hasEnd) {
          releaseSubmitLock();
          releaseCreditsReservation(reservation.reservationId);
          UI.toast('Please upload both a start and end image', 'error');
          return;
        }

        const transitionPrompt = (byId('videoTransitionPrompt')?.value || '').trim();
        if (!transitionPrompt) {
          releaseSubmitLock();
          releaseCreditsReservation(reservation.reservationId);
          UI.toast('Describe how the first image should transition into the second', 'error');
          return;
        }

        payload = {
          provider: settings.provider,
          mode: 'image_transition',
          start_image: startSrc,
          end_image: endSrc,
          prompt: _composeSeedancePrompt(transitionPrompt, stylePreset, null, settings),
          motion_prompt: motion || undefined,
          duration_sec: settings.durationSec,
          aspect_ratio: settings.aspectRatio,
          resolution: settings.resolution,
          loop: settings.loop,
          seedance_variant: settings.seedanceVariant || undefined,
        };

        console.log('[VIDEO] Image Transition mode - start:', Math.round(startSrc.length / 1024), 'KB, end:', Math.round(endSrc.length / 1024), 'KB');

      } else if (imgSubMode === 'experimental_morph') {
        // ── Experimental Morph (Beta): two images + morph prompt via Seedance ──
        const mStartSrc = byId('morphStartImagePreview')?.src || '';
        const mEndSrc = byId('morphEndImagePreview')?.src || '';
        const mHasStart = mStartSrc.startsWith('data:') || mStartSrc.startsWith('http');
        const mHasEnd = mEndSrc.startsWith('data:') || mEndSrc.startsWith('http');

        if (!mHasStart || !mHasEnd) {
          releaseSubmitLock();
          releaseCreditsReservation(reservation.reservationId);
          UI.toast('Please upload both images for morph', 'error');
          return;
        }

        const morphPrompt = (byId('morphPrompt')?.value || '').trim();
        if (!morphPrompt) {
          releaseSubmitLock();
          releaseCreditsReservation(reservation.reservationId);
          UI.toast('Describe how the two images should morph together', 'error');
          return;
        }

        payload = {
          provider: settings.provider,
          mode: 'experimental_morph',
          start_image: mStartSrc,
          end_image: mEndSrc,
          prompt: _composeSeedancePrompt(morphPrompt, stylePreset, null, settings),
          motion_prompt: motion || undefined,
          duration_sec: settings.durationSec,
          aspect_ratio: settings.aspectRatio,
          resolution: settings.resolution,
          loop: settings.loop,
          seedance_variant: settings.seedanceVariant || undefined,
        };

        console.log('[VIDEO] Experimental Morph (Beta) - img1:', Math.round(mStartSrc.length / 1024), 'KB, img2:', Math.round(mEndSrc.length / 1024), 'KB');

      } else {
        // ── Animate Image: single image + animation prompt ──
        const videoImagePreview = byId('videoImagePreview');
        const imageData = videoImagePreview?.src;
        const isValidImage = imageData && (imageData.startsWith('data:') || imageData.startsWith('http'));

        if (!isValidImage) {
          releaseSubmitLock();
          releaseCreditsReservation(reservation.reservationId);
          UI.toast('Please upload a reference image for Image to Video mode', 'error');
          return;
        }

        const animationPrompt = (byId('videoAnimationPrompt')?.value || '').trim();
        if (_isSeedanceProvider(settings.provider) && !animationPrompt) {
          releaseSubmitLock();
          releaseCreditsReservation(reservation.reservationId);
          UI.toast('Describe how the image should animate', 'error');
          return;
        }

        const effectivePrompt = _isSeedanceProvider(settings.provider)
          ? animationPrompt
          : (motion || prompt);

        payload = {
          provider: settings.provider,
          mode: 'animate_image',
          image_data: imageData,
          prompt: _composeSeedancePrompt(effectivePrompt, stylePreset, null, settings),
          motion_prompt: motion || undefined,
          motion_preset: motionPreset || undefined,
          duration_sec: settings.durationSec,
          aspect_ratio: settings.aspectRatio,
          resolution: settings.resolution,
          loop: settings.loop,
          seedance_variant: settings.seedanceVariant || undefined,
        };

        const isDataUrl = imageData.startsWith('data:');
        console.log('[VIDEO] Animate Image mode - image attached,', isDataUrl ? `size: ${Math.round(imageData.length / 1024)} KB` : `URL: ${imageData.slice(0, 60)}...`);
      }

    } else {
      // ── Text → cinematic clip ──
      endpoint = '/api/video/text';
      payload = {
        provider: settings.provider,
        prompt: _composeSeedancePrompt(prompt, stylePreset, motion, settings),
        style_preset: stylePreset || undefined,
        duration_sec: settings.durationSec,
        aspect_ratio: settings.aspectRatio,
        resolution: settings.resolution,
        motion: motion,
        loop: settings.loop,
        seedance_variant: settings.seedanceVariant || undefined,
      };
    }

    // Log action code for debugging (lowercase canonical format)
    const actionCode = window.WorkspaceCredits?.getVideoActionCode?.(settings.mode, settings.durationSec, settings.resolution, settings.provider) ||
                 `video_${settings.mode === 'text2video' ? 'text_generate' : 'image_animate'}_${settings.durationSec}s_${settings.resolution.toLowerCase()}`;
    console.log('[VIDEO] Action code:', actionCode, '| Provider:', settings.provider, '| Expected cost:', totalCredits);
    console.log('[GEN] provider=' + settings.provider + ' mode=' + settings.mode + ' endpoint=' + endpoint +
                ' cost=' + totalCredits + ' available=' + creditCheck.available);

    // Include idempotency key in header for duplicate prevention
    const result = await apiFetch(endpoint, {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      if (handleApiError(result, 'video', reservation.reservationId)) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        renderHistory();
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error?.message || result.error || `Video generation failed: HTTP ${result.status}`);
    }

    const data = result.data;
    const jobId = data.job_id || data.video_id;
    // video_uuid is the real videos.id from the videos table (FK target for history_items).
    // Falls back to jobId for backward compat with older backend responses.
    const videoUuid = data.video_uuid || jobId;

    if (!jobId) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No job ID returned');
    }

    // Update placeholder with real job ID
    if (jobId !== tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
    }

    const provName = _providerDisplayName(settings.provider);
    const queuedPlaceholder = {
      ...placeholder,
      id: jobId,
      video_id: videoUuid,
      status: 'generating',
      status_label: `Generating with ${provName}...`
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
      resolution: settings.resolution,
      aspect_ratio: settings.aspectRatio,
      stage: 'video',
      type: 'video'
    });

    // Show effective settings confirmation
    UI.showJobCreatedSettings({
      resolution: data.params?.resolution || settings.resolution,
      duration_seconds: data.params?.duration_seconds || settings.durationSec,
      aspect_ratio: data.params?.aspect_ratio || settings.aspectRatio
    });

    // Watch the video job
    watchVideoJob(jobId, reservation.reservationId, {
      prompt: prompt || motion,
      duration_sec: settings.durationSec,
      resolution: settings.resolution,
      aspect_ratio: settings.aspectRatio,
      stage: 'video',
      provider: settings.provider || 'vertex',
      video_uuid: videoUuid
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

    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
  } finally {
    releaseSubmitLock();
  }
}

/**
 * Map machine error codes to user-friendly failure messages.
 * Falls back to the raw message if no mapping exists.
 */
function _friendlyVideoError(errorCode, rawMsg) {
  const map = {
    // Normalized error categories (from video_errors.py)
    pending_timeout: 'Provider queue timed out — job was not started',
    processing_timeout: 'Render timed out — started but did not finish',
    network: 'Lost connection to provider',
    auth: 'Provider authentication failed',
    no_output: 'Completed but no video was returned',
    finalization_failed: 'Video completed but processing failed',
    dispatch_failed: 'Could not reach provider — please retry',
    max_retries: 'Exhausted retry attempts',
    validation: 'Invalid request — check your settings',
    quota: 'Provider quota reached — try again later',
    // Seedance-specific (legacy)
    seedance_pending_timeout: 'Seedance queue timed out',
    seedance_processing_timeout: 'Seedance render timed out',
    seedance_poll_error: 'Lost connection to Seedance',
    seedance_generation_failed: 'Seedance rejected this generation',
    seedance_no_video_url: 'Completed but no video returned',
    seedance_auth_error: 'Provider authentication failed',
    // fal Seedance-specific
    fal_seedance_auth_error: 'fal Seedance authentication failed',
    fal_seedance_network_error: 'Lost connection to fal Seedance',
    fal_seedance_no_request_id: 'fal Seedance completed but no video returned',
    fal_seedance_api_error: 'fal Seedance rejected this generation',
    fal_seedance_download_error: 'Failed to download from fal Seedance',
    // Vertex-specific
    vertex_video_failed: 'Veo generation failed — try a lower resolution',
    vertex_no_result_url: 'Vertex completed but no video returned',
    vertex_timeout: 'Vertex generation timed out',
    vertex_auth_failed: 'Vertex authentication failed',
    vertex_auth_error: 'Vertex authentication failed',
    vertex_quota: 'Vertex quota reached — try again later',
    vertex_pending_timeout: 'Veo queue timed out — try again',
    vertex_processing_timeout: 'Veo render timed out — try a lower resolution',
    vertex_poll_error: 'Lost connection to Veo — try again',
    provider_filtered_content: 'Content blocked by safety filters',
    // Gemini (legacy)
    gemini_video_failed: 'Video generation failed',
    gemini_timeout: 'Generation timed out',
    gemini_poll_error: 'Lost connection to provider',
    // Internal
    worker_limit_exceeded: 'Server busy — please retry',
    no_provider_available: 'No video providers available',
    provider_filtered_third_party: 'Content blocked by provider safety filter',
  };
  return map[errorCode] || rawMsg || 'Video generation failed';
}

/**
 * Watch a video generation job for completion
 */
async function watchVideoJob(jobId, reservationId, meta, { isRecovery = false } = {}) {
  // Resolve the real videos.id for history_items FK.
  // meta.video_uuid is set by the initial dispatch; falls back to jobId for recovery polls.
  const videoUuid = meta.video_uuid || State.findHistoryItem(jobId)?.video_id || jobId;

  // D2: Exponential backoff — start at 5s, cap at 15s
  // 55 min frontend budget — backend Seedance preview can take 30 min pending
  // + fallback to fast adds another 20 min worst case
  const INITIAL_INTERVAL = 5000;
  const MAX_INTERVAL = 15000;
  const MAX_ELAPSED_MS = 55 * 60 * 1000;
  const MAX_CONSECUTIVE_ERRORS = 5;
  let interval = INITIAL_INTERVAL;
  let elapsed = 0;
  let consecutiveErrors = 0;

  while (elapsed < MAX_ELAPSED_MS) {
    await new Promise(r => setTimeout(r, interval));
    elapsed += interval;
    // Backoff: increase every poll, capped at MAX_INTERVAL
    interval = Math.min(interval * 1.3, MAX_INTERVAL);

    try {
      // Cross-tab dedup: use broadcast from another tab if fresh
      const _xtab = _getCrossTabResult(jobId);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`/api/video/status/${encodeURIComponent(jobId)}`);
      if (!_xtab && result.ok) _broadcastPollResult(jobId, result.data);

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
        consecutiveErrors++;
        console.warn(`[Video] Status check failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, result.error);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error('[Video] Too many consecutive errors, stopping poll for', jobId);
          offerStatusRetry(
            jobId,
            '/api/video/status',
            () => watchVideoJob(jobId, reservationId, meta, { isRecovery: true }),
            'Video'
          );
          return;
        }
        continue;
      }

      // Reset on success
      consecutiveErrors = 0;

      const data = result.data;
      const status = data.status;

      if (status === 'done') {
        // Confirm credits reservation (converts to actual deduction)
        confirmCreditsReservation(reservationId, jobId);

        // Update history with video_id (real videos.id) for proper remote sync.
        // Prefer video_uuid from status response (authoritative) over local fallback.
        const resolvedVideoId = data.video_uuid || videoUuid;
        State.updateHistoryItem(jobId, {
          status: 'finished',
          status_label: '',
          video_url: data.video_url,
          thumbnail_url: data.thumbnail_url || '',
          video_id: resolvedVideoId,
          stage: 'video',
          type: 'video',
          provider: 'google',
          upstream_id: data.upstream_id || jobId
        });
        if (!isRecovery) {
          State.setHistoryActiveModelId(jobId);
        }
        renderHistory();

        if (!isRecovery && data.video_url) {
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

        // Show effective settings confirmation with actual provider used
        UI.showJobCompletedSettings({
          provider: data.provider || 'google',
          resolution: data.resolution || meta.resolution || '720p',
          duration_seconds: data.duration_seconds || meta.duration_sec
        });

        // Credit upsell — show remaining balance with buy-more prompt
        try {
          const bal = typeof data.new_balance === 'number'
            ? data.new_balance
            : (window.WorkspaceCredits?.getBalance?.() ?? null);
          if (bal !== null && bal < 100) {
            setTimeout(() => {
              UI.toast(
                `You have ${bal} credits remaining. <a href="/hub#pricing" style="color:#7dd3fc;text-decoration:underline">Buy more</a>`,
                'info', 8000
              );
            }, 2000);
          }
        } catch (_) { /* non-critical */ }

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
          status_label: isFiltered ? 'Content blocked' : isQuotaError ? 'Daily limit reached' : _friendlyVideoError(errorCode, errorMsg),
          error_message: errorMsg,
          error_code: errorCode,
          provider_stalled: data.provider_stalled || false,
          video_id: videoUuid,
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

      // Provider pending — job accepted but never started upstream
      if (status === 'provider_pending') {
        const pendSec = data.pending_seconds || 0;
        const prov = _providerDisplayName(meta.provider);
        const ppLabel = pendSec > 120
          ? `${prov} queue busy — please wait`
          : `Queued with ${prov}`;
        State.updateHistoryItem(jobId, {
          status: 'generating',
          status_label: ppLabel
        });
        if (!updateJobStatusInPlace(jobId, ppLabel)) renderHistory();
        // Extend frontend timeout while provider is pending (don't time out early)
        elapsed = Math.min(elapsed, MAX_ELAPSED_MS * 0.5);
        continue;
      }

      // Quota queued — job is waiting for provider quota reset
      if (status === 'queued' && data.quota_queued) {
        const qLabel = 'Queued — waiting for provider quota reset';
        State.updateHistoryItem(jobId, {
          status: 'generating',
          status_label: qLabel
        });
        if (!updateJobStatusInPlace(jobId, qLabel)) renderHistory();
        continue;
      }

      // Still processing - update progress (surgical DOM update to avoid flicker)
      if (data.progress !== undefined || status === 'processing') {
        const provLabel = _providerDisplayName(meta.provider);
        // Use indeterminate state when progress is 0 or missing — avoids
        // fake "0%" that stalls on screen while provider works in background.
        const hasRealProgress = typeof data.progress === 'number' && data.progress > 0;
        const pLabel = hasRealProgress
          ? `${provLabel} rendering... ${data.progress}%`
          : (data.message || `${provLabel} processing...`);
        State.updateHistoryItem(jobId, {
          status: 'generating',
          status_label: pLabel
        });
        updateJobStatusInPlace(jobId, pLabel);
      }

    } catch (err) {
      console.warn('[Video] Poll error:', err);
    }
  }

  // Frontend poll timeout — do a final check before giving up.
  // The backend may still be tracking the job with longer Seedance timeouts.
  try {
    const finalCheck = await apiFetch(`/api/video/status/${encodeURIComponent(jobId)}`);
    const fs = finalCheck.data?.status;
    if (fs === 'provider_pending' || fs === 'processing' || fs === 'queued') {
      // Backend is still working — don't mark failed, just stop polling
      State.updateHistoryItem(jobId, {
        status: 'generating',
        status_label: fs === 'provider_pending'
          ? `Delayed — still queued with ${_providerDisplayName(meta.provider)}`
          : 'Still rendering — check back shortly',
        video_id: videoUuid,
        type: 'video'
      });
      renderHistory();
      UI.makeProgressDriver().done('Video is still processing — it will appear in your history when ready.');
      State.removeActiveJob(jobId);
      return;
    }
  } catch (_) { /* final check failed, proceed with timeout */ }

  releaseCreditsReservation(reservationId);
  const timeoutProv = _providerDisplayName(meta.provider);
  State.updateHistoryItem(jobId, {
    status: 'failed',
    status_label: `${timeoutProv} generation timed out`,
    error_message: `${timeoutProv} generation timed out`,
    video_id: videoUuid,
    type: 'video'
  });
  renderHistory();
  UI.makeProgressDriver().fail(`${timeoutProv} generation timed out — credits have been released`);
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
    console.log('[Image3D] Replacing temp placeholder', tempId, '→', job_id);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);

    // Confirm reservation now that we have a job_id
    confirmCreditsReservation(reservation.reservationId, job_id);

    State.addActiveJob(job_id);
    State.savePendingMeta(job_id, { ...meta, type: 'model' });
    addGeneratingPlaceholder(job_id, { ...meta, status_label: 'Generating from image...', type: 'model' });
    console.log('[Image3D] Placeholder added, filter=', State.historyState.filter,
      'tabLoaded=', State.historyTabLoaded?.(),
      'cacheHas=', State.historyHasJobId(job_id),
      'activeJobs=', State.getActiveJobs().length);
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
    model: 'latest',
    stage: 'image3d',
    thumbnail_url: item.thumbnail_url || item.image_url || '',
    lineage_origin_id: item.lineage_origin_id || item.lineage_root_id || item.id || null,
    lineage_root_id: item.lineage_root_id || item.lineage_origin_id || item.id || null,
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
      body: { image_url: item.image_url, prompt, source_image_history_id: item.id },
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
      model: item.model || 'latest',
      preview_task_id: previewTaskId || previewTaskIdFromItem || null,
      root_prompt: item.root_prompt || item.prompt || item.title || '',
      lineage_origin_id: item.lineage_root_id || item.id || null,
      license: item.license || 'private',
      symmetry_mode: item.symmetry_mode || 'auto',
      pose_mode: item.pose_mode || '',
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
// PANEL-BASED OPERATIONS (Remesh, Texture)
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
    // Canonical retexture source — shared logic across all entry points
    source = buildCanonicalRetextureSource(baseItem, 'rail');
    if (!source) {
      alert('This model has no valid source for retexturing. Try generating a new model first.');
      return;
    }
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

// ============================================================================
// MULTI-IMAGE TO 3D
// ============================================================================

/**
 * Start multi-image-to-3D from the panel UI (1–4 images)
 */
async function startMultiImageTo3D() {
  if (startLock) return;

  // Collect image data URLs from the multi-image grid
  const grid = byId('multiImageGrid');
  if (!grid) { alert('Multi-image panel not found.'); return; }

  const previews = grid.querySelectorAll('.multi-img-preview');
  const imageUrls = [];
  previews.forEach(img => {
    if (img.style.display !== 'none' && img.src) {
      imageUrls.push(img.src);
    }
  });

  if (imageUrls.length < 1 || imageUrls.length > 4) {
    alert(`Please upload 1–4 images. Currently ${imageUrls.length} selected.`);
    return;
  }

  if (!checkCreditsFor('image-to-3d')) return;

  startLock = true;
  const allGenBtns = document.querySelectorAll('button[id*="generate"]');
  allGenBtns.forEach(btn => btn.setAttribute('disabled', ''));

  const nameInput = byId('multiImageModelName');
  const prompt = (nameInput?.value || '').trim() || 'Multi-Image to 3D';
  const model = byId('modelAIModel')?.value || 'latest';

  const meta = {
    prompt: `(multi-image) ${prompt}`,
    root_prompt: prompt,
    model,
    stage: 'image3d',
    thumbnail_url: ''
  };

  const prog = UI.makeProgressDriver();

  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction('image-to-3d', 1);
  if (reservation.insufficient) {
    startLock = false;
    allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
    return;
  }

  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `multi-img-temp-${Date.now()}`);
  const tempMeta = { ...meta, type: 'model', idempotency_key: idempotencyKey };
  addGeneratingPlaceholder(tempId, { ...tempMeta, status_label: 'Starting multi-image to 3D...', type: 'model' });
  State.savePendingMeta(tempId, tempMeta);

  prog.label('Starting multi-image to 3D...');
  try {
    const result = await apiFetch('/api/_mod/multi-image-to-3d/start', {
      method: 'POST',
      body: { image_urls: imageUrls, prompt, model },
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      if (handleGenerationTimeout(result, 'multi-image-to-3d')) {
        return;
      }
      if (handleApiError(result, 'multi-image-to-3d', reservation.reservationId)) {
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

    confirmCreditsReservation(reservation.reservationId, job_id);

    State.addActiveJob(job_id);
    State.savePendingMeta(job_id, { ...meta, type: 'model' });
    addGeneratingPlaceholder(job_id, { ...meta, status_label: 'Generating from multiple images...', type: 'model' });
    watchMeshyTask(job_id, 'image3d');

    if (data.new_balance !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
      window.WorkspaceCredits.applyBackendBalance(data.new_balance, 'multi_image_to_3d_response');
    }

    prog.label('Generating 3D model from images...');
  } catch (err) {
    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    prog.fail(err?.message || 'Multi-image to 3D failed');
    alert(err?.message || 'Multi-image to 3D failed');
  } finally {
    startLock = false;
    allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
  }
}


// ============================================================================
// RIGGING & ANIMATION
// ============================================================================

/**
 * Persist a data URL thumbnail to S3 via the backend.
 * Called after rig/animate completion captures a viewer screenshot.
 * Fire-and-forget — failure is non-fatal (localStorage still has it).
 */
async function _persistThumbnailToS3(jobId, dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return;
  try {
    const result = await apiFetch(`/api/_mod/rig/thumbnail/${jobId}`, {
      method: 'PATCH',
      body: { thumbnail_url: dataUrl }
    });
    if (result.ok) {
      const s3Url = result.data?.thumbnail_url;
      console.log(`[Thumb] Persisted to S3: job=${jobId} url=${s3Url?.substring(0, 60)}...`);
      // Update local history item with S3 URL so it survives reload
      if (s3Url) {
        State.updateHistoryItem(jobId, { thumbnail_url: s3Url });
      }
    } else {
      console.warn(`[Thumb] S3 persist failed: job=${jobId} error=${result.error}`);
    }
  } catch (err) {
    console.warn(`[Thumb] S3 persist error: job=${jobId}`, err.message);
  }
}

/**
 * Run preflight check before rigging — validates face count, source availability,
 * and whether model is already rigged. Updates _timrxRigState and UI.
 */
export async function runRigPreflight() {
  const choice = byId('rigModelSelect')?.value || 'current';
  const baseItem = choice === 'current' ? getActiveHistoryItem() : null;

  if (choice === 'current' && !baseItem) {
    if (window.showToast) window.showToast('Load or generate a model before checking.', 'info');
    return;
  }

  let payload = {};
  if (choice === 'upload') {
    // Can't preflight an upload without sending it — skip backend check
    const rigState = window._timrxRigState;
    if (rigState) {
      rigState.preflight_done = true;
      rigState.is_riggable = true;
      rigState.recommended_action = 'proceed';
      rigState.source_type = 'upload';
    }
    _showRigPreflightResult({ riggable: true, reason: null, face_count: null, recommended_action: 'proceed' });
    return;
  }

  if (baseItem) {
    const source = buildMeshySourceFromItem(baseItem);
    Object.assign(payload, source);
  }

  try {
    const result = await apiFetch('/api/_mod/rig/preflight', { method: 'POST', body: payload });
    if (!result.ok) {
      console.warn('[RigPreflight] API error:', result.error);
      // Non-fatal: let user proceed anyway
      _showRigPreflightResult({ riggable: true, reason: 'Preflight check unavailable — you can still proceed.', face_count: null, recommended_action: 'proceed' });
      return;
    }

    const data = result.data;
    const rigState = window._timrxRigState;
    if (rigState) {
      rigState.preflight_done = true;
      rigState.face_count = data.face_count;
      rigState.vertex_count = data.vertex_count;
      rigState.is_riggable = data.riggable;
      rigState.preflight_reason = data.reason;
      rigState.recommended_action = data.recommended_action;
      rigState.needs_remesh = data.recommended_action === 'remesh_first';
      rigState.source_type = 'current';
      rigState.source_model_id = baseItem?.id || null;
      rigState.source_title = shortTitle(baseItem) || '';
    }

    _showRigPreflightResult(data);
  } catch (err) {
    console.warn('[RigPreflight] Failed:', err);
    _showRigPreflightResult({ riggable: true, reason: 'Preflight check failed — you can still proceed.', face_count: null, recommended_action: 'proceed' });
  }
}

/** Update the rig panel UI with preflight results */
function _showRigPreflightResult(data) {
  const resultDiv = byId('rigPreflightResult');
  const infoDiv = byId('rigPreflightInfo');
  const faceWarning = byId('rigFaceCountWarning');
  const faceMsg = byId('rigFaceCountMsg');
  const alreadyRigged = byId('rigAlreadyRiggedNotice');
  const step1 = byId('rigWizardStep1');
  const step2 = byId('rigWizardStep2');

  if (resultDiv) resultDiv.style.display = '';

  if (data.riggable) {
    if (infoDiv) {
      let info = '<span style="color:#50c878;font-weight:500">Model is ready for rigging</span>';
      if (data.face_count) info += `<br><span style="color:#888">${data.face_count.toLocaleString()} faces</span>`;
      infoDiv.innerHTML = info;
      infoDiv.style.background = 'rgba(80,200,120,.06)';
      infoDiv.style.borderLeft = '3px solid rgba(80,200,120,.4)';
    }
    if (faceWarning) faceWarning.style.display = 'none';
    // Show alignment and submit steps
    if (step1) step1.style.display = '';
    if (step2) step2.style.display = '';
  } else {
    if (infoDiv) {
      infoDiv.innerHTML = '<span style="color:#ff6b6b;font-weight:500">Model cannot be rigged</span>';
      infoDiv.style.background = 'rgba(255,80,80,.06)';
      infoDiv.style.borderLeft = '3px solid rgba(255,80,80,.4)';
    }
    if (data.recommended_action === 'remesh_first' && faceWarning && faceMsg) {
      faceWarning.style.display = '';
      faceMsg.textContent = data.reason || `Model has too many faces (limit: 300,000).`;
    }
    // Keep steps hidden
    if (step1) step1.style.display = 'none';
    if (step2) step2.style.display = 'none';
  }

  if (data.already_rigged && alreadyRigged) {
    alreadyRigged.style.display = '';
  }
}

// Expose for 3dprint-app.js (IIFE)
window._runRigPreflight = runRigPreflight;

/**
 * Start rigging from the panel UI
 */
export async function startRigFromPanel() {
  if (startLock) return;
  startLock = true;

  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'rig' } }));

  const choice = byId('rigModelSelect')?.value || 'current';
  const baseItem = choice === 'current' ? getActiveHistoryItem() : null;

  if (choice === 'current' && !baseItem) {
    alert('Load or generate a model before rigging.');
    startLock = false;
    return;
  }

  if (!checkCreditsFor('rig')) { startLock = false; return; }

  const heightVal = parseFloat(byId('rigHeight')?.value) || 1.7;
  const height_meters = Math.max(0.1, Math.min(5.0, heightVal));

  let payload = { height_meters };
  let labelPrompt = '';

  if (choice === 'upload') {
    const file = byId('rigModelUpload')?.files?.[0];
    if (!file) { alert('Please choose a model to rig.'); startLock = false; return; }
    const dataUrl = await fileToDataURL(file);
    payload.model_url = dataUrl;
    labelPrompt = `Rig ${file.name}`;
  } else if (baseItem) {
    const source = buildMeshySourceFromItem(baseItem);
    Object.assign(payload, source);
    // Pass history item ID for reliable lineage linking (survives ID resolution)
    if (baseItem.id) payload.source_history_id = String(baseItem.id);
    labelPrompt = `Rig ${shortTitle(baseItem)}`;
  }

  const prog = UI.makeProgressDriver();
  const sourceThumbnail = baseItem?.thumbnail_url || '';

  // Show placeholder card in history IMMEDIATELY (before API call)
  const tempId = `rig-temp-${Date.now()}`;
  const rigMeta = {
    prompt: labelPrompt,
    root_prompt: labelPrompt,
    stage: 'rig',
    status_label: 'Starting rigging...',
    type: 'model',
    source_thumbnail_url: sourceThumbnail,
    thumbnail_url: sourceThumbnail,
    lineage_origin_id: baseItem?.lineage_root_id || baseItem?.lineage_origin_id || baseItem?.id || null,
    lineage_root_id: baseItem?.lineage_root_id || baseItem?.lineage_origin_id || baseItem?.id || null,
  };
  addGeneratingPlaceholder(tempId, rigMeta);
  State.savePendingMeta(tempId, rigMeta);
  renderHistory();

  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction('rig', 1);
  if (reservation.insufficient) {
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    startLock = false;
    return;
  }

  prog.label('Starting rigging...');
  if (labelPrompt) payload.prompt = labelPrompt;

  let result;
  try {
    result = await apiFetch('/api/_mod/rig/start', {
      method: 'POST',
      body: payload
    });
  } catch (err) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    prog.fail('Rigging request failed');
    startLock = false;
    throw err;
  }

  if (!result.ok) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    const errMsg = result.data?.message || result.error || 'Rigging failed';
    prog.fail(errMsg);
    alert(errMsg);
    startLock = false;
    return;
  }

  const { job_id } = result.data;
  if (!job_id) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    prog.fail('No job ID returned');
    startLock = false;
    return;
  }

  confirmCreditsReservation(reservation.reservationId, job_id);

  // Replace temp placeholder with real job_id
  State.deleteHistoryItem(tempId, { skipRemote: true });
  State.deletePendingMeta(tempId);
  rigMeta.status_label = 'Rigging...';
  addGeneratingPlaceholder(job_id, rigMeta);
  State.savePendingMeta(job_id, { ...rigMeta, source_thumbnail_url: sourceThumbnail });
  State.addActiveJob(job_id);
  renderHistory();

  startLock = false;
  prog.label('Rigging in progress...');
  watchRigJob(job_id);
}

// ─── Estimated progress for tasks that report 0% until done ────────────
//
// Creates a smooth time-based progress curve that runs independently.
// Real API progress (> 0) overrides the estimate instantly.
// Never reaches 100% on its own — only real completion triggers that.
//
// Curve for rigging (~90s expected):
//   0-10s → 0-15%   (queue / pending)
//  10-40s → 15-60%  (processing ramp)
//  40-70s → 60-85%  (slower phase)
//  70s+   → 85-95%  (asymptotic hold, never 100%)
//
// Curve for animation (~45s expected):
//   0-5s  → 0-15%
//   5-20s → 15-60%
//  20-35s → 60-85%
//  35s+   → 85-95%

function _createEstimatedProgress(type = 'rig') {
  const startTime = Date.now();
  const isRig = type === 'rig';

  // Phase breakpoints: [endTimeSec, startPct, endPct]
  const phases = isRig
    ? [[10, 0, 15], [40, 15, 60], [70, 60, 85], [Infinity, 85, 95]]
    : [[5, 0, 15],  [20, 15, 60], [35, 60, 85], [Infinity, 85, 95]];

  let _stopped = false;
  let _realPct = 0; // last real value from API

  return {
    /** Call with the real API pct on every poll/SSE event */
    feedReal(pct) {
      _realPct = pct;
    },

    /** Get the display percentage (real if > 0, else estimated) */
    get() {
      if (_stopped) return _realPct || 0;
      // If API reports real progress, use it
      if (_realPct > 0) return _realPct;

      const elapsed = (Date.now() - startTime) / 1000;
      let prevEnd = 0;
      for (const [endT, startP, endP] of phases) {
        if (elapsed < endT) {
          const phaseElapsed = elapsed - prevEnd;
          const phaseDuration = Math.min(endT, 300) - prevEnd; // cap infinite
          const t = Math.min(phaseElapsed / phaseDuration, 1);
          // Ease-out for natural feel
          const eased = 1 - Math.pow(1 - t, 2);
          return Math.round(startP + (endP - startP) * eased);
        }
        prevEnd = endT === Infinity ? prevEnd + 60 : endT;
      }
      return 95;
    },

    stop() { _stopped = true; }
  };
}

/**
 * Handle a completed rigging result — shared by SSE and polling paths.
 */
async function _handleRigComplete(job_id, st, prog) {
  prog.done('Rigging complete!');
  if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
  State.removeActiveJob(job_id);

  // Check if backend persistence succeeded
  if (st.db_ok === false) {
    console.error(`[Rig] Backend persistence failed for ${job_id}:`, st.db_errors);
  }

  const pendingMeta = State.getPendingMeta()[job_id] || {};
  const glbUrl = st.rigged_character_glb_url || st.glb_url || st.glb || st.model_urls?.glb || '';
  const glbProxy = getLoadableModelUrl(glbUrl);

  // Load rigged model into 3D viewer FIRST so we can capture a thumbnail
  let viewerLoaded = false;
  if (glbUrl) {
    try {
      prog.jump(99, 'Downloading model...');
      await Viewer.loadModelWithFallback(glbProxy || glbUrl, glbUrl);
      viewerLoaded = true;
    } catch (err) {
      console.warn('[Rig] Failed to load model in viewer:', err);
    }
  }

  // Thumbnail resolution chain: viewer capture > Meshy thumbnail > source thumbnail
  let thumbnail = st.thumbnail_url || '';
  let thumbSource = thumbnail ? 'meshy' : 'none';
  if (viewerLoaded) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const viewerThumbnail = Viewer.captureViewerThumbnail(256) || '';
    if (viewerThumbnail) {
      thumbnail = viewerThumbnail;
      thumbSource = 'viewer';
    }
  }
  if (!thumbnail && pendingMeta.source_thumbnail_url) {
    thumbnail = pendingMeta.source_thumbnail_url;
    thumbSource = 'inherited';
  }
  console.log(`[Rig] Thumbnail resolved: source=${thumbSource} hasUrl=${!!thumbnail}`);

  // Persist data URL thumbnail to S3 via backend (fire-and-forget)
  if (thumbnail && thumbnail.startsWith('data:')) {
    _persistThumbnailToS3(job_id, thumbnail).catch(err => {
      console.warn('[Rig] Thumbnail S3 persist failed (non-fatal):', err.message);
    });
  }

  const rigHistoryData = {
    id: job_id,
    type: 'model',
    status: 'finished',
    stage: 'rig',
    created_at: Date.now(),
    prompt: pendingMeta.prompt || 'Rigged Model',
    root_prompt: pendingMeta.root_prompt || '',
    title: pendingMeta.prompt || 'Rigged Model',
    glb_url: glbUrl,
    glb_proxy: glbProxy || '',
    thumbnail_url: thumbnail,
    model: 'latest',
    lineage_origin_id: pendingMeta.lineage_origin_id || pendingMeta.lineage_root_id || null,
    lineage_root_id: pendingMeta.lineage_root_id || pendingMeta.lineage_origin_id || null,
  };
  if (State.historyHasJobId(job_id)) {
    State.updateHistoryItem(job_id, rigHistoryData);
  } else {
    State.addHistoryItem(rigHistoryData);
  }
  State.deletePendingMeta(job_id);
  State.setHistoryActiveModelId(job_id);
  renderHistory();

  // Show results section + hide wizard steps
  const resultsSection = byId('rigResultsSection');
  if (resultsSection) resultsSection.style.display = 'block';
  ['rigPreflightCard', 'rigWizardStep1', 'rigWizardStep2'].forEach(id => {
    const el = byId(id);
    if (el) el.style.display = 'none';
  });

  // Populate download links for rigged model
  const linksDiv = byId('rigDownloadLinks');
  if (linksDiv) {
    linksDiv.innerHTML = '';
    const formats = [
      { key: 'rigged_character_glb_url', ext: 'glb', label: 'GLB' },
      { key: 'rigged_character_fbx_url', ext: 'fbx', label: 'FBX' }
    ];
    formats.forEach(fmt => {
      const url = st[fmt.key];
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `rigged-model.${fmt.ext}`;
        a.className = 'gen-btn';
        a.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:8px 14px;font-size:12px;text-decoration:none';
        a.innerHTML = `<i class="fa-solid fa-download"></i> ${fmt.label}`;
        linksDiv.appendChild(a);
      }
    });
  }

  // Populate built-in animation chips — click to preview in viewer, icon to download
  const builtinDiv = byId('rigBuiltinAnimations');
  const rigAnimations = st.basic_animations;
  if (builtinDiv && Array.isArray(rigAnimations) && rigAnimations.length > 0) {
    builtinDiv.innerHTML = '';
    rigAnimations.forEach(anim => {
      const glb = anim.glb_url || anim.url || anim.glb;
      if (!glb) return;
      const chip = document.createElement('div');
      chip.className = 'material-chip';
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding:6px 10px;font-size:12px';
      // Preview button (main click area)
      const label = document.createElement('span');
      label.textContent = anim.name || anim.action || 'Animation';
      label.title = 'Click to preview in viewer';
      label.style.cursor = 'pointer';
      label.addEventListener('click', async () => {
        try {
          const proxy = getLoadableModelUrl(glb);
          await Viewer.loadModelWithFallback(proxy || glb, glb);
        } catch (err) {
          console.warn('[Rig] Failed to load animation in viewer:', err);
        }
      });
      // Download icon
      const dl = document.createElement('a');
      dl.href = glb;
      dl.download = `${anim.name || anim.action || 'animation'}.glb`;
      dl.title = 'Download';
      dl.style.cssText = 'opacity:0.5;font-size:10px;margin-left:2px';
      dl.innerHTML = '<i class="fa-solid fa-download"></i>';
      dl.addEventListener('click', (e) => e.stopPropagation());
      chip.appendChild(label);
      chip.appendChild(dl);
      builtinDiv.appendChild(chip);
    });
  } else if (builtinDiv) {
    builtinDiv.innerHTML = '<span style="font-size:11px;color:#666">No built-in animations included</span>';
  }

  // Store rigging task ID globally for animate panel
  const rigTaskId = st.id || job_id;
  const fbxUrl = st.rigged_character_fbx_url || '';
  window._lastRigTaskId = rigTaskId;
  window._lastRigTitle = pendingMeta.prompt || 'Rigged Model';
  window._lastRigGlbUrl = glbUrl;
  window._lastRigThumbnail = thumbnail;

  // Populate persistent rig state
  if (window._timrxRigState) {
    Object.assign(window._timrxRigState, {
      rig_task_id: rigTaskId,
      rig_glb_url: glbUrl,
      rig_fbx_url: fbxUrl,
      rig_thumbnail: thumbnail,
      basic_animations: st.basic_animations || null,
      rig_complete: true,
    });
  }

  // Populate persistent animation state for the ANIMATE panel
  if (window._timrxAnimState) {
    Object.assign(window._timrxAnimState, {
      source_type: 'rig',
      model_id: job_id,
      rig_task_id: rigTaskId,
      model_url: glbUrl,
      title: pendingMeta.prompt || 'Rigged Model',
      thumbnail_url: thumbnail,
      is_rigged: true,
      selected_action_id: null,
      selected_animation: null,
      lineage_origin_id: pendingMeta.lineage_origin_id || pendingMeta.lineage_root_id || null,
      lineage_root_id: pendingMeta.lineage_root_id || pendingMeta.lineage_origin_id || null,
    });
  }

  // Sync animate panel UI if it's currently mounted
  if (typeof window._syncAnimatePanelUI === 'function') {
    window._syncAnimatePanelUI();
  }

  // Trigger animation library load (exposed globally from 3dprint-app.js)
  if (typeof window._loadAnimLibrary === 'function') {
    window._loadAnimLibrary();
  }
}

// ─── Stuck-job UX thresholds (seconds) ──────────────────────────────────
const _RIG_THRESHOLDS  = { delayed: 90, warning: 180, stale: 300, abandon: 600 };
const _ANIM_THRESHOLDS = { delayed: 60, warning: 120, stale: 240, abandon: 480 };

function _stuckLabel(type, elapsedSec, queuePos) {
  const th = type === 'rig' ? _RIG_THRESHOLDS : _ANIM_THRESHOLDS;
  const verb = type === 'rig' ? 'Rigging' : 'Animating';
  const queueHint = (queuePos != null && queuePos > 0)
    ? ` (${queuePos} job${queuePos > 1 ? 's' : ''} ahead in queue)`
    : '';

  if (elapsedSec >= th.stale)
    return `${verb} is taking unusually long.${queueHint} You can close this and check history later.`;
  if (elapsedSec >= th.warning)
    return `${verb} is still running — Meshy may be under heavy load.${queueHint}`;
  if (elapsedSec >= th.delayed)
    return `${verb} is taking longer than usual...${queueHint}`;
  return null; // no special message yet
}

/**
 * Watch rigging job — polling with estimated progress and stuck-job UX.
 *
 * SSE is disabled: gunicorn sync workers buffer streaming responses,
 * so EventSource never receives incremental data on the current infra.
 */
export function watchRigJob(job_id) {
  const prog = UI.makeProgressDriver();
  const est = _createEstimatedProgress('rig');
  const startedAt = Date.now();
  const shared = { queuePos: null }; // shared with poll loop

  // Tick estimated progress every 500ms with stuck-job messaging
  const estInterval = setInterval(() => {
    const pct = est.get();
    const elapsed = (Date.now() - startedAt) / 1000;
    const stuck = _stuckLabel('rig', elapsed, shared.queuePos);
    const label = stuck || `Rigging...`;
    prog.pct(pct, label);
    State.updateHistoryItem(job_id, { status: 'generating', status_label: `${label} ${pct}%` });
    // Update the history card in-place (no full re-render)
    updateJobStatusInPlace(job_id, label, pct);
  }, 500);

  const cleanup = () => { est.stop(); clearInterval(estInterval); };

  _pollRigJob(job_id, prog, est, cleanup, startedAt, shared);
}

/**
 * Poll rigging job with timing, stuck-job thresholds, and abandon policy.
 */
function _pollRigJob(job_id, prog, est, cleanup, startedAt, shared) {
  const MAX_CONSECUTIVE_ERRORS = 5;
  const INITIAL_DELAY = 5000;
  const STEADY_DELAY = 10000;
  const RAMP_UP_AFTER = 30000;
  let consecutiveErrors = 0;

  const poll = async (delay = INITIAL_DELAY) => {
    const elapsedSec = (Date.now() - startedAt) / 1000;

    // Abandon policy: stop active polling after threshold, move to background
    if (elapsedSec > _RIG_THRESHOLDS.abandon) {
      cleanup();
      prog.pct(95, 'Rigging moved to background — check history for results.');
      State.updateHistoryItem(job_id, {
        status: 'generating',
        status_label: 'Processing in background...'
      });
      // Keep job in active list so history shows it, but stop polling
      console.warn(`[Rig] Abandoned active polling for ${job_id} after ${Math.round(elapsedSec)}s`);
      return;
    }

    try {
      const _xtab = _getCrossTabResult(job_id);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`/api/_mod/rig/status/${job_id}`);
      if (!_xtab && result.ok) _broadcastPollResult(job_id, result.data);

      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          cleanup();
          offerStatusRetry(
            job_id,
            '/api/_mod/rig/status',
            () => watchRigJob(job_id),
            'Rigging'
          );
          return;
        }
        setTimeout(() => poll(Math.min(MAX_DELAY, delay * 2)), delay);
        return;
      }

      if (result.status === 403 || result.status === 404) {
        cleanup();
        prog.fail('Rigging job not found');
        return;
      }

      consecutiveErrors = 0;
      const st = result.data;

      // Feed real API progress — overrides estimate when > 0
      const realPct = st.pct ?? st.progress ?? 0;
      est.feedReal(realPct);

      // Track queue position for UX messaging (shared with interval timer)
      if (st.preceding_tasks != null) shared.queuePos = st.preceding_tasks;

      if (st.status === 'done' || st.status === 'SUCCEEDED' || st.status === 'succeeded') {
        cleanup();
        await _handleRigComplete(job_id, st, prog);
        return;
      }

      if (st.status === 'FAILED' || st.status === 'failed') {
        cleanup();
        prog.fail(st.message || st.error || 'Rigging failed');
        State.removeActiveJob(job_id);
        State.updateHistoryItem(job_id, { status: 'failed', error_message: st.message || st.error || 'Rigging failed' });
        State.deletePendingMeta(job_id);
        renderHistory();
        if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
        return;
      }

      // Adaptive polling: fast for first 30s, then steady 8s
      const elapsed = Date.now() - startedAt;
      const nextDelay = elapsed < RAMP_UP_AFTER ? INITIAL_DELAY : STEADY_DELAY;
      setTimeout(() => poll(nextDelay), nextDelay);
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        cleanup();
        prog.fail('Rigging failed - network error');
        return;
      }
      setTimeout(() => poll(Math.min(MAX_DELAY, delay * 2)), delay);
    }
  };

  poll();
}

/**
 * Start animation from rigged model.
 * @param {string} riggingTaskId — completed rig task ID
 * @param {number} actionId — integer action_id from Meshy animation library
 * @param {object} [postProcess] — optional post_process config
 */
export async function startAnimationFromPanel(riggingTaskId, actionId, postProcess) {
  if (startLock) return;
  startLock = true;

  console.log('[Anim] startAnimationFromPanel called: rigTaskId=' + riggingTaskId + ' actionId=' + actionId);
  if (!riggingTaskId) {
    alert('No rigged model available. Please complete rigging first.');
    startLock = false;
    return;
  }
  if (actionId == null || isNaN(actionId)) {
    alert('Please select an animation from the library.');
    startLock = false;
    return;
  }

  if (!checkCreditsFor('animate')) { startLock = false; return; }

  // Build title BEFORE payload
  const animState = window._timrxAnimState || {};
  const sourceTitle = animState.title || window._lastRigTitle || '';
  const animName = animState.selected_animation?.name || '';
  let animLabel;
  if (sourceTitle && animName) {
    animLabel = `${sourceTitle} — ${animName}`;
  } else if (sourceTitle) {
    animLabel = `${sourceTitle} — Animated`;
  } else if (animName) {
    animLabel = animName;
  } else {
    animLabel = `Animation #${actionId}`;
  }
  console.log(`[Anim] Title resolved: source="${sourceTitle}" action="${animName}" final="${animLabel}"`);

  const prog = UI.makeProgressDriver();

  // Show placeholder card in history IMMEDIATELY
  const tempId = `anim-temp-${Date.now()}`;
  const animMeta = {
    prompt: animLabel,
    root_prompt: sourceTitle || animLabel,
    stage: 'animation',
    status_label: 'Starting animation...',
    type: 'model',
    thumbnail_url: animState.thumbnail_url || '',
    lineage_origin_id: animState.lineage_origin_id || animState.lineage_root_id || animState.model_id || null,
    lineage_root_id: animState.lineage_root_id || animState.lineage_origin_id || animState.model_id || null,
  };
  addGeneratingPlaceholder(tempId, animMeta);
  State.savePendingMeta(tempId, animMeta);
  renderHistory();

  prog.label('Reserving credits...');
  const reservation = reserveCreditsForAction('animate', 1);
  if (reservation.insufficient) {
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    startLock = false;
    return;
  }

  prog.label('Starting animation...');

  const payload = {
    rig_task_id: riggingTaskId,
    action_id: parseInt(actionId, 10),
    prompt: animLabel,
  };
  if (postProcess) payload.post_process = postProcess;
  // Pass rig history item ID for reliable lineage linking
  if (riggingTaskId) payload.source_history_id = String(riggingTaskId);

  let result;
  try {
    result = await apiFetch('/api/_mod/rig/animate', {
      method: 'POST',
      body: payload
    });
  } catch (err) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    prog.fail('Animation request failed');
    startLock = false;
    throw err;
  }

  if (!result.ok) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    prog.fail(result.error || 'Animation failed');
    alert(result.error || `Animation failed (HTTP ${result.status})`);
    startLock = false;
    return;
  }

  const { job_id } = result.data;
  if (!job_id) {
    releaseCreditsReservation(reservation.reservationId);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
    prog.fail('No job ID returned');
    startLock = false;
    return;
  }

  confirmCreditsReservation(reservation.reservationId, job_id);

  // Replace temp placeholder with real job_id
  State.deleteHistoryItem(tempId, { skipRemote: true });
  State.deletePendingMeta(tempId);
  animMeta.status_label = 'Animating...';
  addGeneratingPlaceholder(job_id, animMeta);
  State.savePendingMeta(job_id, animMeta);
  State.addActiveJob(job_id);
  renderHistory();

  startLock = false;
  prog.label('Animating...');
  watchAnimationJob(job_id);
}

/**
 * Handle a completed animation result — shared by SSE and polling paths.
 */
async function _handleAnimComplete(job_id, st, prog) {
  prog.done('Animation complete!');
  if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
  State.removeActiveJob(job_id);

  const pendingMeta = State.getPendingMeta()[job_id] || {};
  const animGlbUrl = st.animation_glb_url || st.glb_url || '';
  const glbProxy = getLoadableModelUrl(animGlbUrl);

  // Load animated model into viewer FIRST so we can capture a thumbnail
  let viewerLoaded = false;
  if (animGlbUrl) {
    try {
      prog.jump(99, 'Loading animation...');
      await Viewer.loadModelWithFallback(glbProxy || animGlbUrl, animGlbUrl);
      viewerLoaded = true;
    } catch (err) {
      console.warn('[Anim] Failed to load animation in viewer:', err);
    }
  }

  // Capture fresh thumbnail from the animated model in the viewer
  let thumbnail = st.thumbnail_url || '';
  if (viewerLoaded) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const viewerThumbnail = Viewer.captureViewerThumbnail(256) || '';
    if (viewerThumbnail) {
      thumbnail = viewerThumbnail;
      console.log('[Anim] Thumbnail captured from viewer');
    }
  }
  // Fallback: inherit from parent rig state
  if (!thumbnail && window._timrxAnimState?.thumbnail_url) {
    thumbnail = window._timrxAnimState.thumbnail_url;
    console.log('[Anim] Thumbnail inherited from rig state');
  }

  // Persist data URL thumbnail to S3 via backend (fire-and-forget)
  if (thumbnail && thumbnail.startsWith('data:')) {
    _persistThumbnailToS3(job_id, thumbnail).catch(err => {
      console.warn('[Anim] Thumbnail S3 persist failed (non-fatal):', err.message);
    });
  }

  // Resolve title — prefer the label set at submission (which includes source + action name)
  // Fallback through animState title, then generic
  const animTitle = pendingMeta.prompt && pendingMeta.prompt !== 'Animation'
    ? pendingMeta.prompt
    : (window._timrxAnimState?.title
        ? `${window._timrxAnimState.title} — Animated`
        : 'Animation');
  console.log(`[Anim] Final title for history: "${animTitle}"`);

  // Persist to history
  const animHistoryData = {
    id: job_id,
    type: 'model',
    status: 'finished',
    stage: 'animation',
    created_at: Date.now(),
    prompt: animTitle,
    root_prompt: pendingMeta.root_prompt || animTitle,
    title: animTitle,
    glb_url: animGlbUrl,
    glb_proxy: glbProxy || '',
    thumbnail_url: thumbnail,
    model: 'latest',
    lineage_origin_id: pendingMeta.lineage_origin_id || pendingMeta.lineage_root_id || null,
    lineage_root_id: pendingMeta.lineage_root_id || pendingMeta.lineage_origin_id || null,
  };
  if (State.historyHasJobId(job_id)) {
    State.updateHistoryItem(job_id, animHistoryData);
  } else {
    State.addHistoryItem(animHistoryData);
  }
  State.deletePendingMeta(job_id);
  State.setHistoryActiveModelId(job_id);
  renderHistory();

  // Show animation results — try animate panel (animResultsSection2) first, then legacy
  const animSection = byId('animResultsSection2') || byId('animResultsSection');
  if (animSection) animSection.style.display = 'block';

  // Render all download links — core outputs + post-processed variants
  const linksDiv = byId('animDownloadLinks2') || byId('animDownloadLinks');
  if (linksDiv) {
    linksDiv.innerHTML = '';
    const formats = [
      { key: 'animation_glb_url', ext: 'glb', label: 'GLB' },
      { key: 'animation_fbx_url', ext: 'fbx', label: 'FBX' },
      { key: 'processed_usdz_url', ext: 'usdz', label: 'USDZ' },
      { key: 'processed_armature_fbx_url', ext: 'fbx', label: 'Armature FBX' },
      { key: 'processed_animation_fps_fbx_url', ext: 'fbx', label: 'FPS FBX' }
    ];
    formats.forEach(fmt => {
      const url = st[fmt.key];
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `animation.${fmt.ext}`;
        a.className = 'gen-btn';
        a.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:8px 14px;font-size:12px;text-decoration:none';
        a.innerHTML = `<i class="fa-solid fa-download"></i> ${fmt.label}`;
        linksDiv.appendChild(a);
      }
    });
  }
}

/**
 * Watch animation job — polling with estimated progress and stuck-job UX.
 */
export function watchAnimationJob(job_id) {
  const prog = UI.makeProgressDriver();
  const est = _createEstimatedProgress('animate');
  const startedAt = Date.now();
  const shared = { queuePos: null };

  const estInterval = setInterval(() => {
    const pct = est.get();
    const elapsed = (Date.now() - startedAt) / 1000;
    const stuck = _stuckLabel('animate', elapsed, shared.queuePos);
    const label = stuck || `Animating...`;
    prog.pct(pct, label);
    State.updateHistoryItem(job_id, { status: 'generating', status_label: `${label} ${pct}%` });
    updateJobStatusInPlace(job_id, label, pct);
  }, 500);

  const cleanup = () => { est.stop(); clearInterval(estInterval); };

  _pollAnimJob(job_id, prog, est, cleanup, startedAt, shared);
}

/**
 * Poll animation job with stuck-job thresholds and abandon policy.
 */
function _pollAnimJob(job_id, prog, est, cleanup, startedAt, shared) {
  const MAX_CONSECUTIVE_ERRORS = 5;
  const INITIAL_DELAY = 5000;
  const STEADY_DELAY = 10000;
  const RAMP_UP_AFTER = 30000;
  let consecutiveErrors = 0;

  const poll = async (delay = INITIAL_DELAY) => {
    const elapsedSec = (Date.now() - startedAt) / 1000;

    if (elapsedSec > _ANIM_THRESHOLDS.abandon) {
      cleanup();
      prog.pct(95, 'Animation moved to background — check history for results.');
      State.updateHistoryItem(job_id, {
        status: 'generating',
        status_label: 'Processing in background...'
      });
      console.warn(`[Anim] Abandoned active polling for ${job_id} after ${Math.round(elapsedSec)}s`);
      return;
    }

    try {
      const _xtab = _getCrossTabResult(job_id);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`/api/_mod/rig/animate/status/${job_id}`);
      if (!_xtab && result.ok) _broadcastPollResult(job_id, result.data);

      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          cleanup();
          offerStatusRetry(
            job_id,
            '/api/_mod/rig/animate/status',
            () => watchAnimationJob(job_id),
            'Animation'
          );
          return;
        }
        setTimeout(() => poll(Math.min(MAX_DELAY, delay * 2)), delay);
        return;
      }

      if (result.status === 403 || result.status === 404) {
        cleanup();
        prog.fail('Animation job not found');
        return;
      }

      consecutiveErrors = 0;
      const st = result.data;

      const realPct = st.pct ?? st.progress ?? 0;
      est.feedReal(realPct);

      if (st.preceding_tasks != null) shared.queuePos = st.preceding_tasks;

      if (st.status === 'done' || st.status === 'SUCCEEDED' || st.status === 'succeeded') {
        cleanup();
        await _handleAnimComplete(job_id, st, prog);
        return;
      }

      if (st.status === 'FAILED' || st.status === 'failed') {
        cleanup();
        prog.fail(st.message || st.error || 'Animation failed');
        State.removeActiveJob(job_id);
        State.updateHistoryItem(job_id, { status: 'failed', error_message: st.message || st.error || 'Animation failed' });
        State.deletePendingMeta(job_id);
        renderHistory();
        if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
        return;
      }

      // Adaptive polling: fast for first 30s, then steady 8s
      const elapsed = Date.now() - startedAt;
      const nextDelay = elapsed < RAMP_UP_AFTER ? INITIAL_DELAY : STEADY_DELAY;
      setTimeout(() => poll(nextDelay), nextDelay);
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        cleanup();
        prog.fail('Animation failed - network error');
        return;
      }
      setTimeout(() => poll(Math.min(STEADY_DELAY * 2, delay * 2)), delay);
    }
  };

  poll();
}

// ============================================================================
// HISTORY-BASED OPERATIONS (Remesh, Texture)
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
export async function startTextureFromHistory(item, origin = 'history') {
  if (!item) return;
  State.setHistoryActiveModelId(item.id);

  // Canonical retexture source — same helper as rail panel and viewer toolbar
  const source = buildCanonicalRetextureSource(item, origin);
  if (!source) {
    alert('This model has no valid source for retexturing. Try generating a new model first.');
    return;
  }

  const texValues = getTextureFormValues();
  if (!texValues.text_style_prompt) {
    // Fallback: derive a short texture-appropriate prompt from the model title.
    // Do NOT use item.prompt — that's the model generation prompt which can be
    // 600+ chars (enhanced) and describes geometry, not texture style.  Meshy's
    // text_style_prompt has a 600-char limit and expects texture descriptions.
    const title = shortTitle(item);
    texValues.text_style_prompt = title && title !== '(untitled)'
      ? `High quality realistic texture for ${title}`
      : 'High quality realistic PBR texture';
  }
  // Enforce Meshy's 600-char limit for text_style_prompt
  if (texValues.text_style_prompt.length > 600) {
    texValues.text_style_prompt = texValues.text_style_prompt.substring(0, 597) + '...';
  }
  const meta = {
    prompt: texValues.text_style_prompt || `Texture ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || texValues.text_style_prompt || '',
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
 * Evolve: re-generate variants from an existing model's prompt
 */
export async function evolveFromHistory(item, count = 2) {
  if (!item) return;
  const prompt = item.prompt || item.root_prompt || '';
  if (!prompt) {
    alert('No prompt available to evolve from.');
    return;
  }

  if (!checkCreditsFor('text-to-3d', count)) return;

  const model = item.model || 'latest';
  const license = item.license || 'private';
  const symmetry = item.symmetry_mode || 'auto';
  const poseMode = item.pose_mode || '';
  const batchGroupId = crypto?.randomUUID ? crypto.randomUUID() : `evolve-${Date.now()}`;

  window.dispatchEvent(new CustomEvent('generation:start', { detail: { type: 'evolve' } }));
  const prog = UI.makeProgressDriver();

  for (let slot = 0; slot < count; slot++) {
    try {
      const reservation = reserveCreditsForAction('text-to-3d', 1);
      if (reservation.insufficient) continue;

      const idempotencyKey = State.generateIdempotencyKey();
      const tempId = crypto?.randomUUID ? crypto.randomUUID() : `evolve-${Date.now()}-${slot}`;
      const tempMeta = {
        prompt, model, license,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        batch_count: count, batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        stage: 'preview',
        status_label: `Evolving ${slot + 1}/${count}...`,
        idempotency_key: idempotencyKey
      };
      addGeneratingPlaceholder(tempId, tempMeta);
      State.savePendingMeta(tempId, tempMeta);

      const payload = {
        prompt, model,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        license,
        batch_count: count, batch_slot: slot + 1,
        batch_group_id: batchGroupId, refine: false
      };

      const result = await apiFetch('/api/_mod/text-to-3d/start', {
        method: 'POST', body: payload,
        headers: { 'Idempotency-Key': idempotencyKey }
      });

      if (!result.ok) {
        releaseCreditsReservation(reservation.reservationId);
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.deletePendingMeta(tempId);
        console.error(`[Evolve] Variant ${slot + 1} failed:`, result.error);
        continue;
      }

      const { job_id } = result.data;
      if (!job_id) {
        releaseCreditsReservation(reservation.reservationId);
        State.deleteHistoryItem(tempId, { skipRemote: true });
        State.deletePendingMeta(tempId);
        continue;
      }

      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      confirmCreditsReservation(reservation.reservationId, job_id);
      State.addActiveJob(job_id);
      State.savePendingMeta(job_id, {
        prompt, model, root_prompt: prompt, license,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        batch_count: count, batch_slot: slot + 1,
        batch_group_id: batchGroupId
      });
      addGeneratingPlaceholder(job_id, {
        prompt, model, root_prompt: prompt,
        batch_count: count, batch_slot: slot + 1,
        batch_group_id: batchGroupId, stage: 'preview',
        status_label: `Evolving ${slot + 1}/${count}...`
      });
      watchJob(job_id);
    } catch (err) {
      console.error(`[Evolve] Variant ${slot + 1} error:`, err);
    }
  }

  prog.label(`Evolving ${count} variants...`);
  renderHistory();
}

// ============================================================================
// RESUME PENDING JOBS ON PAGE LOAD
// ============================================================================

/**
 * Fetch active (in-progress) jobs from the backend for the current identity.
 * Returns array of job objects, or null on network failure.
 */
async function fetchActiveJobsFromBackend() {
  try {
    const result = await apiFetch('/api/jobs/active', { timeout: 8000 });
    if (!result.ok) return null;
    const jobs = result.data?.jobs;
    return Array.isArray(jobs) ? jobs : [];
  } catch (err) {
    console.warn('[Recovery] Failed to fetch active jobs from backend:', err);
    return null;
  }
}

// ── Resume contract helpers ──────────────────────────────────────────────
// The backend /api/jobs/active response includes canonical resume fields:
//   frontend_resume_id — the exact ID the frontend must poll with
//   resume_strategy    — which watcher to start
// These helpers extract them, with fallbacks for legacy payloads.

/**
 * Get the polling ID for a backend job object.
 * Prefers the canonical frontend_resume_id, falls back to legacy inference.
 */
function _getResumeId(job) {
  if (job.frontend_resume_id) return job.frontend_resume_id;
  // Legacy fallback: infer from provider/stage
  const stage = job.stage || _inferStageFromAction(job);
  const usesUpstream = job.upstream_job_id
    && ['remesh', 'texture', 'rig', 'animate'].includes(stage);
  return usesUpstream ? job.upstream_job_id : job.id;
}

/**
 * Get the watcher strategy for a backend job object.
 * Prefers the canonical resume_strategy, falls back to legacy inference.
 */
function _getResumeStrategy(job) {
  if (job.resume_strategy) return job.resume_strategy;
  // Legacy fallback
  return _inferStrategyFromStage(job.stage || _inferStageFromAction(job));
}

/** Legacy: infer stage from action_code (only used when backend doesn't provide stage) */
function _inferStageFromAction(job) {
  const code = (job.action_code || '').toLowerCase();
  if (code.includes('image_to_3d')) return 'image3d';
  if (code.includes('refine')) return 'refine';
  if (code.includes('remesh') || code.includes('upscale')) return 'remesh';
  if (code.includes('retexture') || code.includes('texture')) return 'texture';
  if (code.includes('rigging') || code === 'rig') return 'rig';
  if (code.includes('animation') || code === 'animate') return 'animate';
  if (code.includes('video') || code.includes('seedance')) return 'video';
  if (code.includes('image') && !code.includes('3d')) return 'image';
  return 'preview';
}

/** Map resume_strategy → the watcher category used for dispatch */
const _STRATEGY_TO_CATEGORY = {
  meshy_retexture:   'mesh',
  meshy_remesh:      'mesh',
  meshy_image_to_3d: 'mesh',
  meshy_text_to_3d:  'text',
  meshy_refine:      'text',
  meshy_rig:         'rig',
  meshy_animation:   'animate',
  video:             'video',
  image:             'image',
};

/** Map resume_strategy → the stage value for pendingMeta / placeholder */
const _STRATEGY_TO_STAGE = {
  meshy_retexture:   'texture',
  meshy_remesh:      'remesh',
  meshy_image_to_3d: 'image3d',
  meshy_text_to_3d:  'preview',
  meshy_refine:      'refine',
  meshy_rig:         'rig',
  meshy_animation:   'animate',
  video:             'video',
  image:             'image',
};

/** Legacy: infer resume_strategy from a stage string */
function _inferStrategyFromStage(stage) {
  const map = { texture: 'meshy_retexture', remesh: 'meshy_remesh', image3d: 'meshy_image_to_3d',
    preview: 'meshy_text_to_3d', refine: 'meshy_refine', rig: 'meshy_rig',
    animate: 'meshy_animation', animation: 'meshy_animation', video: 'video', image: 'image' };
  return map[stage] || 'meshy_text_to_3d';
}

/**
 * Resume watching any jobs that were in progress.
 *
 * Recovery strategy (backend is source of truth):
 * 1. Fetch active jobs from GET /api/jobs/active
 * 2. Merge into local state (discover jobs from other tabs/devices/sessions)
 * 3. Remove local stale jobs that backend says are finished/missing
 * 4. Fall back to history scan if backend is unreachable
 * 5. Start watchers with built-in dedup (watchers.has() check)
 */
let _resumeInFlight = null;
export async function resumePendingJobs(options = {}) {
  // Single-flight guard: the identity_changed event fires on first
  // WalletStore update (null→realId), which overlaps with the explicit
  // Phase 3 call in main.js.  Coalesce into one backend fetch.
  if (_resumeInFlight) {
    log('[Recovery] resumePendingJobs already in flight, returning existing promise');
    return _resumeInFlight;
  }
  _resumeInFlight = _doResumePendingJobs(options);
  try { return await _resumeInFlight; } finally { _resumeInFlight = null; }
}

async function _doResumePendingJobs(options = {}) {
  const { skipEmptyUI = false } = options;

  // ── Step 1: Fetch active jobs from backend (source of truth) ──
  const backendJobs = await fetchActiveJobsFromBackend();

  if (backendJobs && backendJobs.length) {
    log(`[Recovery] Backend reports ${backendJobs.length} active job(s)`);
    for (const job of backendJobs) {
      // Use canonical resume contract from backend (preferred) or legacy fallback
      const id = _getResumeId(job);
      const strategy = _getResumeStrategy(job);
      const stage = _STRATEGY_TO_STAGE[strategy] || job.stage || 'preview';
      if (!id) continue;
      // Add to local tracking if not already there
      if (!State.getActiveJobs().includes(id)) {
        State.addActiveJob(id);
        log(`[Recovery] Discovered job ${id} strategy=${strategy} (${job.action_code || ''})`);
      }
      // Ensure pendingMeta exists for watcher selection
      const meta = job.meta || {};
      State.savePendingMeta(id, {
        stage,
        resume_strategy: strategy,
        type: stage === 'video' ? 'video' : stage === 'image' ? 'image' : 'model',
        prompt: meta.prompt || job.prompt || '',
        root_prompt: meta.root_prompt || meta.prompt || job.prompt || '',
        job_type: job.job_type || '',
        provider: job.provider || '',
        internal_job_id: job.id,
        provider_job_id: job.provider_job_id || job.upstream_job_id || null,
        created_at: job.created_at || null,
        lineage_origin_id: meta.lineage_origin_id || meta.lineage_root_id || meta.source_task_id || null,
        lineage_root_id: meta.lineage_root_id || meta.lineage_origin_id || meta.source_task_id || null,
        source_task_id: meta.source_task_id || meta.preview_task_id || meta.rig_task_id || null,
        thumbnail_url: meta.thumbnail_url || meta.source_thumbnail_url || '',
      });
    }
  } else if (backendJobs && backendJobs.length === 0) {
    log('[Recovery] Backend confirms no active jobs');
  } else {
    log('[Recovery] Backend unreachable — using local state only');
  }

  // ── Step 2: Read local state (now includes backend-merged jobs) ──
  let ids = State.getActiveJobs();
  let pendingMeta = State.getPendingMeta();

  // ── Step 3: Remove local jobs that backend says are gone ──
  if (backendJobs !== null) {
    // Include all ID forms so locally-cached jobs match regardless of ID convention
    const backendIds = new Set(backendJobs.flatMap(j =>
      [j.id, j.upstream_job_id, j.frontend_resume_id, j.provider_job_id].filter(Boolean)
    ));
    const staleLocal = ids.filter(id => !backendIds.has(id));
    let staleCleanedUp = false;
    for (const id of staleLocal) {
      // Keep if history shows it finished (avoid flicker on completed jobs)
      const hist = State.findHistoryItem(id);
      if (hist && (hist.status === 'finished' || hist.status === 'failed')) {
        State.removeActiveJob(id);
        log(`[Recovery] Cleared completed local job ${id}`);
        continue;
      }
      // For jobs not in backend AND not in history, remove as stale
      if (!hist) {
        State.removeActiveJob(id);
        log(`[Recovery] Removed stale local job ${id} (not on server)`);
        continue;
      }
      // Backend confirms job is gone but history still shows 'generating' —
      // mark as failed so the card stops showing "Generating 0%"
      State.removeActiveJob(id);
      State.updateHistoryItem(id, { status: 'failed', status_label: 'Generation failed' });
      staleCleanedUp = true;
      log(`[Recovery] Marked stale generating job ${id} as failed (not on server)`);
    }
    if (staleCleanedUp) renderHistory();
    ids = State.getActiveJobs();
    pendingMeta = State.getPendingMeta();
  }

  // ── Step 4: Fall back to history scan if no active jobs found locally ──
  if (!ids.length) {
    const history = State.getHistory();
    const resumable = history.filter(item => {
      if (!item || !item.id) return false;
      const status = (item.status || '').toLowerCase();
      return status && status !== 'finished' && status !== 'failed';
    });
    if (resumable.length) {
      log(`[Recovery] Found ${resumable.length} resumable job(s) in history`);
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
            thumbnail_url: item.thumbnail_url || '',
            lineage_origin_id: item.lineage_origin_id || item.lineage_root_id || null,
            lineage_root_id: item.lineage_root_id || item.lineage_origin_id || null,
          });
        }
      });
      pendingMeta = State.getPendingMeta();
    }
  }

  // ── Step 5: Ensure pendingMeta stage is set for all active jobs ──
  if (ids.length) {
    const history = State.getHistory();
    for (const id of ids) {
      const meta = pendingMeta?.[id];
      if (meta && meta.stage) continue;
      const item = history.find(entry => entry && entry.id === id);
      if (!item) continue;
      State.savePendingMeta(id, {
        stage: item.stage || (item.type === 'image' ? 'image' : item.type === 'video' ? 'video' : 'remesh'),
        type: item.type || 'model',
        prompt: item.prompt || '',
        root_prompt: item.root_prompt || item.prompt || '',
        title: item.title || '',
        thumbnail_url: item.thumbnail_url || '',
        lineage_origin_id: item.lineage_origin_id || item.lineage_root_id || null,
        lineage_root_id: item.lineage_root_id || item.lineage_origin_id || null,
      });
    }
    pendingMeta = State.getPendingMeta();
  }

  if (!ids.length) {
    if (!skipEmptyUI) UI.showOutputEmpty();
    return;
  }

  // ── Step 6: Categorize by resume_strategy and start watchers ──
  const buckets = { mesh: [], text: [], video: [], rig: [], animate: [], image: [] };

  for (const id of ids) {
    if (State.watchers.has(id)) {
      log(`[Recovery] Skipping ${id} — already polling`);
      continue;
    }
    const meta = pendingMeta?.[id] || {};
    const strategy = meta.resume_strategy || _inferStrategyFromStage(meta.stage || 'preview');
    const category = _STRATEGY_TO_CATEGORY[strategy] || 'text';
    (buckets[category] || buckets.text).push(id);
  }

  const allToResume = [...buckets.mesh, ...buckets.text, ...buckets.video, ...buckets.rig, ...buckets.animate, ...buckets.image];
  if (!allToResume.length) {
    if (!skipEmptyUI) UI.showOutputEmpty();
    return;
  }

  log(`[Recovery] Resuming ${allToResume.length} job(s): mesh=${buckets.mesh.length} text=${buckets.text.length} video=${buckets.video.length} rig=${buckets.rig.length} animate=${buckets.animate.length} image=${buckets.image.length}`);

  // Mark recovered jobs as "generating" in history so cards show progress overlay
  const STATUS_LABELS = {
    texture: 'Texturing...', remesh: 'Remeshing...', image3d: 'Generating 3D...',
    video: 'Generating video...', rig: 'Rigging...', animate: 'Animating...',
    animation: 'Animating...', refine: 'Refining...', preview: 'Generating...',
    image: 'Generating image...',
  };
  for (const id of allToResume) {
    const meta = pendingMeta[id] || {};
    addGeneratingPlaceholder(id, {
      ...meta,
      status_label: STATUS_LABELS[meta.stage] || 'Generating...',
    });
  }
  renderHistory();

  // Start the correct watcher for each category.
  // If there is exactly one text-to-3d job (preview/refine), let it auto-load
  // into the viewer when it finishes — the user started it and wants to see it.
  // Multiple jobs or derivative ops (mesh/rig/animate) stay recovery-only.
  const soloPreview = buckets.text.length === 1 && allToResume.length === 1;
  for (const id of buckets.mesh) {
    watchMeshyTask(id, pendingMeta[id]?.stage || 'remesh', { isRecovery: true });
  }
  for (const id of buckets.text) {
    watchJob(id, { isRecovery: !soloPreview });
  }
  for (const id of buckets.video) {
    watchVideoJob(id, null, pendingMeta[id] || {}, { isRecovery: true });
  }
  for (const id of buckets.rig) {
    watchRigJob(id);
  }
  for (const id of buckets.animate) {
    watchAnimationJob(id);
  }
  for (const id of buckets.image) {
    const meta = pendingMeta[id] || {};
    watchImageJob(id, null, meta);
    log(`[Recovery] Resumed image job ${id} (unified watcher)`);
  }
}

// ============================================================================
// BEFOREUNLOAD WARNING (Generation Reliability Layer)
// ============================================================================

/**
 * Soft reminder before leaving — jobs are backend-durable and will resume
 * on next page load via /api/jobs/active recovery.
 */
function handleBeforeUnload(e) {
  const activeJobs = State.getActiveJobs();
  if (activeJobs.length === 0) return;

  const message = `You have ${activeJobs.length} generation${activeJobs.length > 1 ? 's' : ''} running. They will continue on the server and resume automatically when you return.`;
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

      // Insert centered in the main viewer pane (shared parent of all viewer types)
      // so the indicator is visible whether the user is on 3D, image, or video display
      const viewerPane = document.querySelector('.ws-viewer') || document.querySelector('.viewer-wrap') || document.getElementById('model3dViewer');
      if (viewerPane) {
        indicator.style.cssText = 'position: absolute; top: 56px; left: 50%; transform: translateX(-50%); z-index: 15; display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 10px; font-size: 13px; cursor: pointer;';
        viewerPane.appendChild(indicator);
      } else {
        indicator.style.cssText = 'position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 9999; display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; background: rgba(30,30,40,0.95); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; color: #e0e0e0; font-size: 13px; cursor: pointer;';
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
window.startRigFromPanel = startRigFromPanel;
window.startAnimationFromPanel = startAnimationFromPanel;
window.watchRigJob = watchRigJob;
window.watchAnimationJob = watchAnimationJob;
window.startTextureFromHistory = startTextureFromHistory;
window.startRemeshFromHistory = startRemeshFromHistory;
window.startImageTo3DFromHistory = startImageTo3DFromHistory;
window.onGenerateClick = onGenerateClick;
window.startVideoGeneration = startVideoGeneration;
window.getActiveHistoryItem = getActiveHistoryItem;
window.updateJobsIndicator = updateJobsIndicator;
window.showJobsPanel = showJobsPanel;
