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
import * as State from './state.js?v=20260407e';
import * as Viewer from './viewer.js?v=20260408b';
import * as UI from './ui-utils.js';
import { renderHistory, updateJobStatusInPlace, shortTitle } from './history.js?v=20260525a';

// ============================================================================
// LOCKS & STATE
// ============================================================================
let startLock = false;
let postProcessLock = false;

// ============================================================================
// MESHY PROMPT LIMITS
// ============================================================================
const MESHY_PROMPT_HARD_LIMIT = 600;   // Meshy Text-to-3D accepts max 600 chars
const MESHY_PROMPT_WARN_LIMIT = 480;   // Show warning colour above this
const MESHY_NEGATIVE_PROMPT_LIMIT = 240;

function getNegativePromptValue(id) {
  const value = (byId(id)?.value || '').trim().replace(/\s+/g, ' ');
  return value.slice(0, MESHY_NEGATIVE_PROMPT_LIMIT).replace(/^[\s:,-]+|[\s:,-]+$/g, '');
}

function meshyProviderPromptLength(prompt, negativePrompt) {
  const cleanPrompt = (prompt || '').trim();
  const cleanNegative = (negativePrompt || '').trim();
  if (!cleanPrompt || !cleanNegative) return cleanPrompt.length;
  return `${cleanPrompt} Avoid: ${cleanNegative}.`.length;
}

function validateMeshyPromptLength(prompt, textareaRef, negativePrompt = '') {
  const effectiveLen = meshyProviderPromptLength(prompt, negativePrompt);
  if (effectiveLen <= MESHY_PROMPT_HARD_LIMIT) return true;
  showPromptLimitModal(prompt, textareaRef, {
    extraText: negativePrompt,
    effectiveLen,
  });
  return false;
}

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

function stableOperationValue(value) {
  if (Array.isArray(value)) return value.map(stableOperationValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      const next = stableOperationValue(value[key]);
      if (next !== undefined && next !== null && next !== '') acc[key] = next;
      return acc;
    }, {});
  }
  return value;
}

function buildDerivedOperationKey(stage, parts = {}) {
  const normalized = stableOperationValue(parts);
  return `${stage}:${JSON.stringify(normalized)}`;
}

function hashOperationKey(value = '') {
  let hash = 2166136261;
  const input = String(value);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function operationIdempotencyKey(stage, operationKey, forceNew = false) {
  const salt = forceNew ? `:${Date.now()}:${Math.random().toString(36).slice(2)}` : '';
  return `${stage}:${hashOperationKey(`${operationKey}${salt}`)}`;
}

function activeDerivedOperationJob(operationKey) {
  if (!operationKey) return null;
  const activeJobs = new Set(State.getActiveJobs?.() || []);
  const pendingMeta = State.getPendingMeta?.() || {};
  for (const [jobId, meta] of Object.entries(pendingMeta)) {
    if (meta?.operation_key === operationKey) return jobId;
  }
  for (const jobId of activeJobs) {
    const item = State.findHistoryItem?.(jobId);
    if ((item?.operation_key || item?.payload?.operation_key) === operationKey) return jobId;
  }
  return null;
}

function finishedDerivedOperation(operationKey) {
  if (!operationKey) return null;
  return (State.getHistory?.() || []).find((item) => (
    item
    && (item.status === 'finished' || item.status === 'done' || !item.status)
    && (item.operation_key || item.payload?.operation_key) === operationKey
  )) || null;
}

async function shouldStartDerivedOperation(label, operationKey) {
  const activeJob = activeDerivedOperationJob(operationKey);
  if (activeJob) {
    alert(`${label} is already running for this model and settings.`);
    return { start: false, forceNew: false };
  }

  const existing = finishedDerivedOperation(operationKey);
  if (!existing) return { start: true, forceNew: false };

  const runAgain = window.confirm?.(`${label} already exists for this model and settings. Run it again anyway?`) ?? true;
  if (runAgain) return { start: true, forceNew: true };

  State.setHistoryActiveModelId(existing.id);
  const existingUrl = existing.glb_url || existing.glb_proxy || existing.model_urls?.glb || existing.payload?.glb_url || '';
  if (existingUrl) {
    try {
      await Viewer.loadModelWithFallback(getLoadableModelUrl(existingUrl) || existingUrl, existingUrl);
    } catch (err) {
      console.warn(`[${label}] Failed to load existing derived asset:`, err);
    }
  }
  renderHistory();
  return { start: false, forceNew: false };
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

// ============================================================================
// Meshy stuck/failed retry — surface a "Cancel & Try Again" UI.
// NOTE: Our backend releases the TimrX credit reservation on failure (verified
// in production logs: res=20→0). HOWEVER Meshy itself charges credits on task
// SUBMISSION and does NOT auto-refund failed tasks on the API path. The Studio
// plan's "8 free retries per task" is enforced via Meshy support / dashboard,
// not the API. So a retry IS free on our side, but the user may need to claim
// the Meshy refund via their support with the task ID.
// ============================================================================

const MESHY_PENDING_STUCK_MS = 4 * 60 * 1000;   // 4 min stuck-pending → offer retry
const MESHY_MAX_RETRIES = 8;                    // matches Studio plan policy
const _meshyStuckOffered = new Set();           // job_ids we've already prompted
const _meshyRetryCount = new Map();             // root_job_id → retries used

function _meshyInjectStyles() {
  if (document.getElementById('meshy-retry-styles')) return;
  const s = document.createElement('style');
  s.id = 'meshy-retry-styles';
  s.textContent = `
    .mxy-toast{position:fixed;right:24px;bottom:24px;z-index:9000;max-width:360px;
      padding:16px 18px;border-radius:12px;background:rgba(15,23,42,.96);
      border:1px solid rgba(125,211,252,.25);box-shadow:0 18px 48px rgba(0,0,0,.5);
      color:#f8fafc;font-family:Inter,system-ui,sans-serif;font-size:13px;
      line-height:1.45;animation:mxy-toast-in .22s ease both}
    @keyframes mxy-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .mxy-toast-head{font-weight:700;font-size:14px;margin-bottom:6px;color:#fff}
    .mxy-toast-body{color:rgba(248,250,252,.78);margin-bottom:12px}
    .mxy-toast-actions{display:flex;gap:8px;flex-wrap:wrap}
    .mxy-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:transparent;
      color:#f8fafc;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:600;
      cursor:pointer;transition:background .15s,border-color .15s}
    .mxy-btn:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.28)}
    .mxy-btn-primary{background:linear-gradient(90deg,#0ea5e9,#7dd3fc);color:#0b1220;border-color:transparent}
    .mxy-btn-primary:hover{filter:brightness(1.08)}
    .mxy-btn-ghost{color:rgba(248,250,252,.55);border-color:transparent}
  `;
  document.head.appendChild(s);
}

function _meshyMetaFor(jobId) {
  const meta = State.getPendingMeta?.()[jobId] || {};
  if (meta.prompt) return meta;
  const item = State.getHistory?.().find(h => h && h.id === jobId);
  return item || meta;
}

async function cancelTextTo3DJob(jobId, { silent = false } = {}) {
  if (!jobId) return;
  try { State.watchers?.delete(jobId); } catch {}
  State.removeActiveJob(jobId);
  _meshyStuckOffered.delete(jobId);
  // Best-effort backend cancel — may 404 on older builds, non-fatal.
  try {
    await apiFetch(`/api/_mod/text-to-3d/cancel/${encodeURIComponent(jobId)}`, {
      method: 'POST', body: {}, timeout: 5000,
    });
  } catch (err) {
    console.warn('[Meshy] cancel endpoint not available (non-fatal):', err?.message);
  }
  try {
    if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
  } catch {}
  State.updateHistoryItem(jobId, { status: 'failed', status_label: 'Cancelled' });
  renderHistory();
  if (!silent && window.showToast) {
    window.showToast('Job cancelled. Credits refunded.', 'info');
  }
}

async function retryTextTo3DJob(jobId) {
  if (!jobId) return;
  const used = _meshyRetryCount.get(jobId) || 0;
  if (used >= MESHY_MAX_RETRIES) {
    const msg = `Free retry limit reached (${MESHY_MAX_RETRIES}/task). Try again later or contact support.`;
    if (window.showToast) window.showToast(msg, 'warning');
    return;
  }

  const meta = _meshyMetaFor(jobId);
  const prompt = meta.prompt || meta.root_prompt || '';
  if (!prompt) {
    if (window.showToast) window.showToast('Cannot retry — original prompt not found.', 'error');
    return;
  }

  await cancelTextTo3DJob(jobId, { silent: true });
  _meshyRetryCount.set(jobId, used + 1);

  if (window.showToast) {
    window.showToast(`Retrying… (attempt ${used + 1}/${MESHY_MAX_RETRIES}). TimrX won't charge again — if Meshy does and it fails, request their refund.`, 'info');
  }

  // Re-submit with identical params. Failed/cancelled Meshy tasks don't deduct
  // from the Meshy account, and our backend already released the reservation,
  // so this is genuinely free.
  const payload = {
    mode: 'preview',
    prompt,
    negative_prompt: meta.negative_prompt || '',
    model: meta.model || 'latest',
    symmetry_mode: meta.symmetry_mode || 'auto',
    pose_mode: meta.pose_mode || '',
    license: meta.license || 'private',
    model_type: meta.model_type || 'standard',
    should_remesh: !!meta.should_remesh,
    moderation: !!meta.moderation,
    auto_size: meta.auto_size !== false,
    target_formats: meta.target_formats || ['glb'],
    refine: false,
  };
  if (meta.topology) payload.topology = meta.topology;
  if (meta.target_polycount) payload.target_polycount = meta.target_polycount;
  if (meta.origin_at) payload.origin_at = meta.origin_at;

  const result = await apiFetch('/api/_mod/text-to-3d/start', { method: 'POST', body: payload });
  if (!result.ok || !result.data?.job_id) {
    if (window.showToast) window.showToast(`Retry failed: ${result.error || 'unknown error'}`, 'error');
    return;
  }
  const newJobId = result.data.job_id;
  _meshyRetryCount.set(newJobId, used + 1);
  if (typeof State.savePendingMeta === 'function') {
    State.savePendingMeta(newJobId, { ...meta, root_prompt: meta.root_prompt || prompt });
  }
  State.addActiveJob(newJobId);
  watchJob(newJobId);
  return newJobId;
}

function _meshyShowToast(jobId, kind) {
  _meshyInjectStyles();
  const existing = document.getElementById(`mxy-toast-${jobId}`);
  if (existing) return;
  const used = _meshyRetryCount.get(jobId) || 0;
  const remaining = Math.max(0, MESHY_MAX_RETRIES - used);
  const headline = kind === 'failed' ? 'Generation failed' : 'Meshy is taking longer than usual';
  const body = kind === 'failed'
    ? `Your TimrX credits were refunded. If Meshy charged you, request a refund via their support with task ID <code>${jobId}</code> (Studio plan: 8 free retries per task). Retries left: ${remaining}.`
    : `Job has been queued for over 4 minutes. Cancel and re-submit — TimrX won't charge you again. If Meshy charges and the task fails, contact their support for a refund. Retries left: ${remaining}.`;
  const el = document.createElement('div');
  el.id = `mxy-toast-${jobId}`;
  el.className = 'mxy-toast';
  el.innerHTML = `
    <div class="mxy-toast-head">${headline}</div>
    <div class="mxy-toast-body">${body}</div>
    <div class="mxy-toast-actions">
      <button class="mxy-btn mxy-btn-primary" data-act="retry">Try Again</button>
      <button class="mxy-btn" data-act="cancel">Cancel</button>
      <button class="mxy-btn mxy-btn-ghost" data-act="meshy-support">Meshy support ↗</button>
      <button class="mxy-btn mxy-btn-ghost" data-act="dismiss">Dismiss</button>
    </div>`;
  el.querySelector('[data-act="meshy-support"]').addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(`https://www.meshy.ai/contact-support?task_id=${encodeURIComponent(jobId)}`, '_blank', 'noopener');
  });
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'retry') retryTextTo3DJob(jobId);
    else if (act === 'cancel') cancelTextTo3DJob(jobId);
    el.remove();
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 60000); // self-dismiss after 60s
}

// Expose for UI buttons / debug from the console
if (typeof window !== 'undefined') {
  window.TimrXMeshy = Object.assign(window.TimrXMeshy || {}, {
    cancel: cancelTextTo3DJob,
    retry: retryTextTo3DJob,
    showStuckToast: (id) => _meshyShowToast(id, 'stuck'),
    getRetryCount: (id) => _meshyRetryCount.get(id) || 0,
    maxRetries: MESHY_MAX_RETRIES,
  });
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
 * Show a lightweight cost confirmation before a paid action.
 * Returns a Promise that resolves to true (confirmed) or false (cancelled).
 *
 * @param {string} action - Action key (e.g., 'text-to-3d')
 * @param {number} count - Batch count (default 1)
 * @returns {Promise<boolean>}
 */
function confirmCostBeforeAction(action, count = 1) {
  // If credits system isn't loaded or balance not confirmed, skip confirmation
  // (checkCreditsFor or the server will catch the real issue)
  if (!window.WorkspaceCredits?.isBalanceConfirmed?.()) {
    return Promise.resolve(true);
  }

  const costPer = window.WorkspaceCredits.getActionCost(action) || 0;
  const totalCost = costPer * count;
  const balance = window.WorkspaceCredits.getAvailableCredits() || 0;
  const balanceAfter = Math.max(0, balance - totalCost);

  if (totalCost === 0) return Promise.resolve(true);

  // Inject styles once
  if (!document.getElementById('costConfirmStyles')) {
    const style = document.createElement('style');
    style.id = 'costConfirmStyles';
    style.textContent = `
      .cost-confirm-overlay {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        background: rgba(0,0,0,.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 999999;
        display: flex; align-items: center; justify-content: center;
        animation: ccFadeIn .15s ease;
      }
      @keyframes ccFadeIn { from { opacity: 0; } to { opacity: 1; } }

      .cost-confirm-card {
        width: min(380px, 88vw);
        background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(0,0,0,0)), #111;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 16px;
        padding: 28px 24px 22px;
        text-align: center;
        animation: ccPop .2s cubic-bezier(.34,1.56,.64,1) both;
        box-shadow: 0 20px 60px rgba(0,0,0,.5);
      }
      @keyframes ccPop { from { transform: scale(.92) translateY(8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }

      .cost-confirm-card .cc-icon {
        width: 44px; height: 44px;
        border-radius: 12px;
        background: linear-gradient(135deg, rgba(14,165,233,.15), rgba(139,92,246,.10));
        border: 1px solid rgba(14,165,233,.20);
        display: flex; align-items: center; justify-content: center;
        font-size: 20px; color: #7dd3fc;
        margin: 0 auto 14px;
      }
      .cost-confirm-card .cc-action {
        font-size: 15px; font-weight: 600; color: #e2e8f0;
        margin: 0 0 16px;
        text-transform: capitalize;
      }
      .cost-confirm-card .cc-breakdown {
        display: flex; flex-direction: column; gap: 0;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 10px;
        overflow: hidden;
        margin-bottom: 18px;
      }
      .cost-confirm-card .cc-row {
        display: flex; justify-content: space-between;
        padding: 10px 16px;
        font-size: 13px;
        color: #94a3b8;
        border-bottom: 1px solid rgba(255,255,255,.06);
      }
      .cost-confirm-card .cc-row:last-child { border-bottom: none; }
      .cost-confirm-card .cc-row span:last-child {
        font-weight: 600; color: #e2e8f0;
      }
      .cost-confirm-card .cc-row.cc-after span:last-child {
        color: ${balanceAfter < 50 ? '#fbbf24' : '#e2e8f0'};
      }
      .cost-confirm-card .cc-btns {
        display: flex; gap: 10px; justify-content: center;
      }
      .cost-confirm-card .cc-btn {
        padding: 10px 24px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: all .15s;
        letter-spacing: .02em;
        text-transform: uppercase;
      }
      .cost-confirm-card .cc-yes {
        background: linear-gradient(135deg, #0ea5e9, #8b5cf6);
        border: none;
        color: #fff;
        flex: 1;
      }
      .cost-confirm-card .cc-yes:hover {
        filter: brightness(1.1);
        box-shadow: 0 4px 16px rgba(14,165,233,.3);
      }
      .cost-confirm-card .cc-no {
        background: transparent;
        border: 1px solid rgba(255,255,255,.12);
        color: #94a3b8;
        flex: 1;
      }
      .cost-confirm-card .cc-no:hover {
        background: rgba(255,255,255,.06);
        color: #e2e8f0;
      }
    `;
    document.head.appendChild(style);
  }

  return new Promise((resolve) => {
    // Remove any existing
    document.querySelector('.cost-confirm-overlay')?.remove();

    const actionLabel = action.replace(/-/g, ' ');
    const overlay = document.createElement('div');
    overlay.className = 'cost-confirm-overlay';
    overlay.innerHTML = `
      <div class="cost-confirm-card">
        <div class="cc-icon"><i class="fa-solid fa-coins"></i></div>
        <p class="cc-action">${count > 1 ? count + '× ' : ''}${actionLabel}</p>
        <div class="cc-breakdown">
          <div class="cc-row"><span>Cost</span><span>${totalCost} credits</span></div>
          <div class="cc-row"><span>Current balance</span><span>${balance.toLocaleString()}</span></div>
          <div class="cc-row cc-after"><span>Balance after</span><span>${balanceAfter.toLocaleString()}</span></div>
        </div>
        <div class="cc-btns">
          <button class="cc-btn cc-yes">Confirm</button>
          <button class="cc-btn cc-no">Cancel</button>
        </div>
      </div>
    `;

    const cleanup = (result) => {
      overlay.style.animation = 'ccFadeIn .1s ease reverse';
      setTimeout(() => overlay.remove(), 100);
      resolve(result);
    };

    overlay.querySelector('.cc-yes').onclick = () => cleanup(true);
    overlay.querySelector('.cc-no').onclick = () => cleanup(false);
    // Backdrop click = cancel
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    // Escape = cancel
    const escHandler = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); cleanup(false); } };
    document.addEventListener('keydown', escHandler);

    // Append to <html> to escape any transformed parents that break position:fixed
    document.documentElement.appendChild(overlay);

    // Focus the confirm button
    setTimeout(() => overlay.querySelector('.cc-yes')?.focus(), 50);
  });
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

  // Final fallback: dynamically-created styled modal (same design as video credits modal)
  _showStyledGeneralCreditsModal(numCost, numAvailable, missing);
}

/**
 * Dynamically-created styled modal for general insufficient credits.
 * Mirrors showInsufficientVideoCreditsModal design but for general credits:
 * - fa-coins icon instead of fa-video
 * - Links to /hub#pricing instead of #video-pricing
 * - No "separate from video credits" footer
 *
 * @param {number} required - Credits required
 * @param {number} available - Credits the user has
 * @param {number} needed - Additional credits needed (required - available)
 */
function _showStyledGeneralCreditsModal(required, available, needed) {
  const closeModal = () => {
    const m = document.getElementById('insufficientGeneralCreditsModal');
    if (m) m.remove();
    document.removeEventListener('keydown', escHandler);
  };
  window._closeGeneralCreditsModal = closeModal;

  // Remove existing
  document.getElementById('insufficientGeneralCreditsModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'insufficientGeneralCreditsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-labelledby', 'insuffGeneralCreditsTitle');
  modal.setAttribute('aria-modal', 'true');

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

  const hasNumbers = required > 0 || available > 0;
  const bodyText = hasNumbers
    ? `This action requires <strong style="color: #f0f0f0;">${required}</strong> credits.<br>You currently have <strong style="color: #f0f0f0;">${available}</strong> credits.`
    : `You don't have enough credits for this action.`;
  const neededBox = hasNumbers
    ? `<div style="margin: 0 0 24px; padding: 14px 16px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px;">
        <span style="font-size: 14px; color: rgba(255, 255, 255, 0.6);">You need </span>
        <strong style="color: #f0f0f0; font-size: 15px;">${needed}</strong>
        <span style="font-size: 14px; color: rgba(255, 255, 255, 0.6);"> more credits to continue.</span>
      </div>`
    : '';

  modal.innerHTML = `
    <div style="max-width: 420px; text-align: center; padding: 32px; position: relative; background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0)), #0f0f0f; border: 1px solid rgba(255,255,255,0.14); border-radius: 20px; box-shadow: 0 24px 80px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.10);">
      <button onclick="window._closeGeneralCreditsModal()" aria-label="Close" style="position: absolute; top: 12px; right: 12px; background: transparent; border: 0; color: #cfcfcf; font-size: 22px; line-height: 1; cursor: pointer; padding: 6px; border-radius: 10px;">&times;</button>
      <div style="width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.08);">
        <i class="fa-solid fa-coins" style="font-size: 28px; color: #f0f0f0;" aria-hidden="true"></i>
      </div>
      <h4 id="insuffGeneralCreditsTitle" style="margin: 0 0 16px; font-family: 'Bebas Neue', system-ui, sans-serif; font-size: 28px; letter-spacing: 0.5px; color: #f5f5f5;">Not Enough Credits</h4>
      <p style="margin: 0 0 20px; color: rgba(255, 255, 255, 0.72); font-size: 15px; line-height: 1.6;">
        ${bodyText}
      </p>
      ${neededBox}
      <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
        <button onclick="window._closeGeneralCreditsModal()" style="padding: 14px 24px; background: transparent; border: 1px solid rgba(255, 255, 255, 0.14); color: rgba(255, 255, 255, 0.72); border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px;">Cancel</button>
        <a href="/hub#pricing" id="insuffGeneralCreditsCtaBtn" style="padding: 14px 24px; background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0)), #1a1a1a; border: 1px solid rgba(255, 255, 255, 0.18); color: #f5f5f5; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);">Buy Credits</a>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  const escHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escHandler);

  document.getElementById('insuffGeneralCreditsCtaBtn')?.focus();
}

// ============================================================================
// PROMPT LENGTH VALIDATION
// ============================================================================

/**
 * Show a modal warning the user their prompt exceeds Meshy's character limit.
 * Includes a live character counter and lets the user trim the prompt inline.
 */
function showPromptLimitModal(prompt, textareaRef, options = {}) {
  const existing = document.getElementById('promptLimitOverlay');
  if (existing) existing.remove();

  const len = prompt.length;
  const effectiveLen = Number(options.effectiveLen || len);
  const over = effectiveLen - MESHY_PROMPT_HARD_LIMIT;
  const extraNote = options.extraText
    ? ' This includes the Avoid field because TimrX folds it into the Meshy prompt.'
    : '';

  const overlay = document.createElement('div');
  overlay.id = 'promptLimitOverlay';
  overlay.className = 'workspace-modal-overlay';
  overlay.innerHTML = `
    <div class="workspace-modal prompt-limit-modal" role="dialog" aria-modal="true">
      <div class="workspace-modal__header">
        <div>
          <p class="workspace-modal__eyebrow">Prompt too long</p>
          <h3 class="workspace-modal__title">Shorten your prompt to continue</h3>
          <p class="workspace-modal__subtitle">Meshy's API accepts a maximum of ${MESHY_PROMPT_HARD_LIMIT} characters. Your provider prompt is <strong>${over}</strong> characters over the limit.${extraNote}</p>
        </div>
        <button type="button" class="workspace-modal__close" id="promptLimitClose">&times;</button>
      </div>
      <div class="workspace-modal__body">
        <div class="card">
          <div class="prompt-limit__counter-row">
            <span class="prompt-limit__label">Characters</span>
            <span class="prompt-limit__counter ${effectiveLen > MESHY_PROMPT_HARD_LIMIT ? 'is-over' : effectiveLen > MESHY_PROMPT_WARN_LIMIT ? 'is-warn' : ''}" id="promptLimitCount">${effectiveLen} / ${MESHY_PROMPT_HARD_LIMIT}</span>
          </div>
          <textarea id="promptLimitTextarea" class="prompt-limit__textarea" spellcheck="false">${prompt.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
          <p class="field-hint">Edit your prompt above. The counter updates as you type.</p>
        </div>
      </div>
      <div class="workspace-modal__footer">
        <div class="prompt-limit__bar">
          <div class="prompt-limit__bar-fill" id="promptLimitBar" style="width:${Math.min(100, (effectiveLen / MESHY_PROMPT_HARD_LIMIT) * 100)}%"></div>
        </div>
        <div class="workspace-modal__actions">
          <button type="button" class="gen-btn gen-btn--rail workspace-modal__ghost" id="promptLimitCancel">Cancel</button>
          <button type="button" class="gen-btn" id="promptLimitApply" ${effectiveLen > MESHY_PROMPT_HARD_LIMIT ? 'disabled' : ''}>Use this prompt</button>
        </div>
      </div>
    </div>
  `;

  const cleanup = () => { overlay.remove(); };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

  const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);

  const textarea = overlay.querySelector('#promptLimitTextarea');
  const counter  = overlay.querySelector('#promptLimitCount');
  const bar      = overlay.querySelector('#promptLimitBar');
  const applyBtn = overlay.querySelector('#promptLimitApply');

  const updateCounter = () => {
    const l = textarea.value.length;
    const total = meshyProviderPromptLength(textarea.value, options.extraText || '');
    counter.textContent = `${total} / ${MESHY_PROMPT_HARD_LIMIT}`;
    counter.classList.toggle('is-over', total > MESHY_PROMPT_HARD_LIMIT);
    counter.classList.toggle('is-warn', total > MESHY_PROMPT_WARN_LIMIT && total <= MESHY_PROMPT_HARD_LIMIT);
    bar.style.width = `${Math.min(100, (total / MESHY_PROMPT_HARD_LIMIT) * 100)}%`;
    bar.classList.toggle('is-over', total > MESHY_PROMPT_HARD_LIMIT);
    bar.classList.toggle('is-warn', total > MESHY_PROMPT_WARN_LIMIT && total <= MESHY_PROMPT_HARD_LIMIT);
    applyBtn.disabled = total > MESHY_PROMPT_HARD_LIMIT || l === 0;
  };

  textarea.addEventListener('input', updateCounter);

  overlay.querySelector('#promptLimitClose')?.addEventListener('click', cleanup);
  overlay.querySelector('#promptLimitCancel')?.addEventListener('click', cleanup);

  applyBtn.addEventListener('click', () => {
    if (textareaRef) textareaRef.value = textarea.value.trim();
    document.removeEventListener('keydown', onKey);
    cleanup();
  });

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/**
 * Wire a live character counter onto the model prompt textarea.
 * Call once during init.
 */
export function wirePromptCharCounter() {
  const textarea = byId('modelPrompt');
  if (!textarea) return;
  const negativeTextarea = byId('modelNegativePrompt');

  // Create counter element
  const counter = document.createElement('span');
  counter.className = 'prompt-char-counter';
  counter.setAttribute('aria-live', 'polite');
  textarea.parentElement?.appendChild(counter);

  const update = () => {
    const total = meshyProviderPromptLength(textarea.value, getNegativePromptValue('modelNegativePrompt'));
    counter.textContent = `${total}/${MESHY_PROMPT_HARD_LIMIT}`;
    counter.classList.toggle('is-warn', total > MESHY_PROMPT_WARN_LIMIT && total <= MESHY_PROMPT_HARD_LIMIT);
    counter.classList.toggle('is-over', total > MESHY_PROMPT_HARD_LIMIT);
  };

  textarea.addEventListener('input', update);
  negativeTextarea?.addEventListener('input', update);
  update();
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

  // Rejected reference media (unreadable / unsupported / too large). The backend
  // validates every image before reserving credits, so nothing was charged — say
  // which image failed and let the user swap it out.
  if (response.status === 400 && response.data?.error === 'invalid_reference_media') {
    if (reservationId) releaseCreditsReservation(reservationId);
    const idx = response.data.index;
    const which = Number.isInteger(idx) ? ` (image ${idx + 1})` : '';
    UI.toast(`${response.data.message || 'That image could not be used.'}${which}`, 'error');
    return true;
  }

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
      // Styled modal fallback (no parsed values available — show generic message)
      _showStyledGeneralCreditsModal(0, 0, 0);
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
        <a href="/hub#video-pricing" id="insuffVideoCreditsCtaBtn" style="padding: 14px 24px; background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0)), #1a1a1a; border: 1px solid rgba(255, 255, 255, 0.18); color: #f5f5f5; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);">Buy Video Credits</a>
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

  // Show user-visible recovery message
  showTimeoutRecoveryBanner(action);

  return true;
}

/**
 * Show contextual next-step suggestions after model generation completes.
 * Helps users discover Refine, Remesh, Rig, and STL export features.
 */
function showNextStepSuggestions(jobId, stage) {
  // Only show for preview stage — refined models already went through this
  if (stage && stage !== 'preview') return;

  // Remove existing panel
  document.querySelector('.next-steps-panel')?.remove();

  const panel = document.createElement('div');
  panel.className = 'next-steps-panel';
  panel.style.cssText = 'padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-top:10px;font-size:13px;color:#ccc';
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;color:#e0e0e0">Model generated! Next steps:</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      <button class="next-step-btn" data-action="refine" style="padding:6px 12px;background:rgba(14,165,233,0.15);border:1px solid rgba(14,165,233,0.3);border-radius:8px;color:#7dd3fc;font-size:12px;cursor:pointer">Refine <span class="btn-cost-badge">10 cr</span></button>
      <button class="next-step-btn" data-action="remesh" style="padding:6px 12px;background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.25);border-radius:8px;color:#c4b5fd;font-size:12px;cursor:pointer">Remesh <span class="btn-cost-badge">6 cr</span></button>
      <button class="next-step-btn" data-action="rig" style="padding:6px 12px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.25);border-radius:8px;color:#6ee7b7;font-size:12px;cursor:pointer">Rig <span class="btn-cost-badge">5 cr</span></button>
      <button class="next-step-btn" data-action="export-stl" style="padding:6px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#aaa;font-size:12px;cursor:pointer">Export STL</button>
    </div>
  `;

  // Wire up button clicks to switch tabs
  panel.querySelectorAll('.next-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      panel.remove();
      // Dispatch tab-switch event that 3dprint-app.js listens for
      const tabMap = { refine: 'model', remesh: 'remesh', rig: 'rig', 'export-stl': 'export' };
      const tabId = tabMap[action];
      if (tabId) {
        const tabBtn = document.querySelector(`[data-tab="${tabId}"]`);
        if (tabBtn) tabBtn.click();
      }
    });
  });

  const target = document.querySelector('.gen-footer-card') || document.querySelector('.workspace-controls');
  if (target) {
    target.appendChild(panel);
    // Auto-dismiss after 30 seconds
    setTimeout(() => panel.remove(), 30000);
  }
}

/**
 * Show a visible banner when a generation request times out but
 * the job may still be running server-side.
 */
function showTimeoutRecoveryBanner(action) {
  // Remove existing banner
  document.querySelector('.timeout-recovery-banner')?.remove();

  const banner = document.createElement('div');
  banner.className = 'timeout-recovery-banner';
  banner.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 16px;margin:8px 0;background:rgba(14,165,233,0.12);border:1px solid rgba(14,165,233,0.25);border-radius:10px;color:#e0e0e0;font-size:13px;animation:fadeIn .2s ease';
  banner.innerHTML = `
    <span style="font-size:18px;animation:spin 1.5s linear infinite">&#9203;</span>
    <span>Your ${action.replace(/-/g, ' ')} is still generating on our servers. This typically takes 1-3 minutes. We'll update you when it's ready.</span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:#888;font-size:16px;cursor:pointer">&times;</button>
  `;

  const target = document.querySelector('.gen-footer-card') || document.querySelector('.workspace-controls') || document.querySelector('.card:has(.gen-btn)');
  if (target) {
    target.prepend(banner);
  }
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
  const roundedPct = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const historyItem = State.findHistoryItem(jobId);
  const pendingMeta = State.getPendingMeta()?.[jobId] || {};
  if (historyItem) {
    State.updateHistoryItem(jobId, { progress_pct: roundedPct });
  }

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
    if (roundedPct > 0) {
      if (pctEl) {
        pctEl.classList.remove('history-thumb__processing-pct--indeterminate');
        pctEl.classList.remove('expanded-thumb__processing-pct--indeterminate');
      }
      if (barEl) {
        barEl.classList.remove('history-thumb__progress-bar--indeterminate');
        barEl.classList.remove('expanded-thumb__progress-bar--indeterminate');
      }
    }

    if (pctEl) pctEl.textContent = `${roundedPct}%`;
    if (fillEl) fillEl.style.width = `${roundedPct}%`;
  });

  const batchCount = Math.max(
    1,
    parseInt(
      historyItem?.batch_count
      || historyItem?.payload?.batch_count
      || pendingMeta.batch_count,
      10
    ) || 1
  );
  const batchGroupId = historyItem?.batch_group_id
    || historyItem?.payload?.batch_group_id
    || pendingMeta.batch_group_id
    || null;

  // Grouped cards render aggregated progress from local history state, so
  // re-render them when a multi-model batch advances.
  if (batchGroupId && batchCount > 1) {
    window.GroupedViewer?.upsertItem?.(batchGroupId, {
      ...(historyItem || {}),
      ...pendingMeta,
      id: jobId,
      batch_count: batchCount,
      batch_group_id: batchGroupId,
      batch_slot: pendingMeta.batch_slot || historyItem?.batch_slot || 1,
      progress_pct: roundedPct,
      status: historyItem?.status || inferProgressStatus(pendingMeta?.stage),
      status_label: `${roundedPct}%`,
    });
    renderHistory();
  }
}

/**
 * Generate a prompt fingerprint for lineage grouping
 */
function promptFingerprint(input = '') {
  const normalized = (input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
}

function normalizePendingMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return typeof meta === 'object' ? meta : {};
}

function inferProgressStatus(stage = '') {
  const normalized = String(stage || '').toLowerCase();
  if (normalized === 'refine') return 'refining';
  if (normalized === 'remesh') return 'remeshing';
  if (normalized === 'texture') return 'texturing';
  if (normalized === 'rig') return 'rigging';
  if (normalized === 'animate' || normalized === 'animation') return 'animating';
  return 'generating';
}

function revealFreshHistoryEntry(type = 'model') {
  const currentFilter = State.historyState?.filter || 'all';
  if (currentFilter !== 'all' && currentFilter !== type) return;
  if (State.historyState) {
    State.historyState.page = 1;
  }
  requestAnimationFrame(() => {
    const panel = document.getElementById('ws-right-panel');
    if (panel) panel.scrollTop = 0;
    const grid = document.getElementById('historyGrid');
    if (grid) grid.scrollTop = 0;
  });
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
  const convertFormatOnlyInput = byId('remeshConvertFormatOnly');
  const resizeInput = byId('remeshResizeHeight');
  const originInput = byId('remeshOriginAt');
  const formatInputs = Array.from(document.querySelectorAll('#remeshTargetFormats input[type="checkbox"]:checked'));
  const convert_format_only = !!convertFormatOnlyInput?.checked;

  let target_polycount;
  let topology;

  if (activePreset && !advancedOpen) {
    target_polycount = parseInt(activePreset.dataset.poly || '50000', 10);
    topology = activePreset.dataset.topo || 'triangle';
  } else {
    const polyInput = byId('targetPolyCount');
    target_polycount = parseInt(polyInput?.value || '0', 10);
    if (!Number.isFinite(target_polycount) || target_polycount <= 0) target_polycount = 45000;
    // Topology is determined by the active preset; default to triangle
    topology = activePreset?.dataset.topo || 'triangle';
  }

  const target_formats = Array.from(new Set([
    'glb',
    ...formatInputs.map((input) => String(input.value || '').trim().toLowerCase()).filter(Boolean)
  ]));

  const result = {
    target_formats,
    convert_format_only,
  };

  if (!convert_format_only) {
    result.target_polycount = target_polycount;
    result.topology = topology;

    const resizeHeight = parseFloat(resizeInput?.value || '0');
    if (Number.isFinite(resizeHeight) && resizeHeight > 0) {
      result.resize_height = resizeHeight;
    }

    const originAt = (originInput?.value || '').trim().toLowerCase();
    if (originAt === 'bottom' || originAt === 'center') {
      result.origin_at = originAt;
    }

    // Preserve the print workflow: if no Meshy resize height is set and the
    // print-ready preset is active, keep forwarding the mm target height so the
    // STL export path can respect the user's print scale.
    const isPrintPreset = activePreset?.dataset.preset === 'print-ready';
    const printHeight = document.getElementById('printTargetHeight')?.value;
    if (!result.resize_height && isPrintPreset && printHeight && parseFloat(printHeight) > 0) {
      result.print_height_mm = parseFloat(printHeight);
    }
  }

  return result;
}

/**
 * Get text-to-3d preview form values from the UI
 */
function getPreviewFormValues() {
  const modelType = (byId('modelModelType')?.value || '').trim().toLowerCase();
  const isLowPoly = modelType === 'lowpoly';
  const should_remesh = isLowPoly ? false : !!byId('modelShouldRemesh')?.checked;
  const moderation = !!byId('modelModeration')?.checked;
  const auto_size = !!byId('modelAutoSize')?.checked;
  const topologyValue = (byId('modelTopology')?.value || 'triangle').trim().toLowerCase();
  const targetPolyInput = parseInt(byId('modelTargetPolycount')?.value || '30000', 10);
  const originAt = (byId('modelOriginAt')?.value || 'bottom').trim().toLowerCase();
  const targetFormatContainer = document.querySelector('#modelTargetFormats');
  const targetFormatInputs = Array.from(document.querySelectorAll('#modelTargetFormats input[type="checkbox"]:checked'));
  const target_formats = targetFormatContainer
    ? Array.from(new Set([
        'glb',
        ...targetFormatInputs.map((input) => String(input.value || '').trim().toLowerCase()).filter(Boolean)
      ]))
    : ['glb'];

  const values = {
    model_type: modelType || 'standard',
    should_remesh,
    moderation,
    auto_size,
    target_formats
  };

  if (should_remesh) {
    values.topology = topologyValue === 'quad' ? 'quad' : 'triangle';
    values.target_polycount = Number.isFinite(targetPolyInput)
      ? Math.max(100, Math.min(300000, targetPolyInput))
      : 30000;
  }

  if (auto_size && (originAt === 'bottom' || originAt === 'center')) {
    values.origin_at = originAt;
  }

  return values;
}

/**
 * Get texture form values from the UI
 */
async function getTextureFormValues() {
  const prompt = (byId('texturePrompt')?.value || '').trim();
  const negativePrompt = getNegativePromptValue('textureNegativePrompt');
  const textureType = (byId('textureType')?.value || 'pbr-all').toLowerCase();
  const aiModel = (byId('textureAiModel')?.value || 'latest').trim() || 'latest';
  const seamlessInput = byId('seamless');
  const removeLightingInput = byId('textureRemoveLighting');
  const styleImageInput = byId('textureStyleImageUpload');
  const styleImageUrlInput = byId('textureStyleImageUrl');
  // Default to false when the texture panel isn't rendered (viewer/history
  // entry points).  enable_original_uv=true on models without user-designed
  // UVs (e.g. text-to-3d previews) causes Meshy async failures.  The backend
  // also overrides to false for preview/imported models as a safety net.
  const enable_original_uv = seamlessInput ? !!seamlessInput.checked : false;
  const enable_pbr = textureType === 'pbr-all';
  let image_style_url = '';
  const uploadedStyleFile = styleImageInput?.files?.[0] || null;
  if (uploadedStyleFile) {
    const mime = (uploadedStyleFile.type || '').toLowerCase();
    const fileName = (uploadedStyleFile.name || '').toLowerCase();
    const hasAllowedExtension = fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png');
    // Require either valid MIME type OR allowed extension (both must be checked)
    if (!['image/jpeg', 'image/png'].includes(mime) && !hasAllowedExtension) {
      throw new Error('Texture style image must be a JPG or PNG file.');
    }
    image_style_url = await fileToDataURL(uploadedStyleFile);
  } else {
    image_style_url = (styleImageUrlInput?.value || '').trim();
  }

  const targetFormatContainer = document.querySelector('#textureTargetFormats');
  const targetFormatInputs = Array.from(document.querySelectorAll('#textureTargetFormats input[type="checkbox"]:checked'));
  const target_formats = targetFormatContainer
    ? ['glb', ...targetFormatInputs.map((input) => String(input.value || '').trim().toLowerCase()).filter(Boolean)]
    : null;

  const values = {
    text_style_prompt: prompt,
    negative_prompt: negativePrompt,
    image_style_url,
    enable_pbr,
    enable_original_uv,
    remove_lighting: removeLightingInput ? !!removeLightingInput.checked : aiModel !== 'meshy-5',
    ai_model: aiModel
  };
  if (target_formats?.length) {
    values.target_formats = Array.from(new Set(target_formats));
  }
  return values;
}

async function openRefineSettingsModal(item = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById('refineSettingsOverlay');
    if (existing) existing.remove();

    const sourceTitle = shortTitle(item) || 'Preview model';
    const overlay = document.createElement('div');
    overlay.id = 'refineSettingsOverlay';
    overlay.className = 'workspace-modal-overlay refine-settings-overlay';
    overlay.innerHTML = `
      <div class="workspace-modal refine-settings-modal" role="dialog" aria-modal="true" aria-labelledby="refineSettingsTitle">
        <div class="workspace-modal__header">
          <div>
            <p class="workspace-modal__eyebrow">Preview refinement</p>
            <h3 id="refineSettingsTitle" class="workspace-modal__title">Refine ${sourceTitle}</h3>
            <p class="workspace-modal__subtitle">Add material direction, guide the refine pass with an image, and choose the Meshy model used for the high-detail pass.</p>
          </div>
          <button type="button" class="workspace-modal__close" id="refineSettingsClose" aria-label="Close refine settings">&times;</button>
        </div>

        <div class="workspace-modal__body">
          <div class="card">
            <h3>Style Direction</h3>
            <textarea id="refineTexturePrompt" placeholder="Optional material or surface notes, e.g. polished obsidian with engraved gold details...">${item.texture_prompt || ''}</textarea>
            <p class="field-hint texture-setting-note">Leave this empty if you want a pure geometry/detail refine. Add text only when you want the refine pass to steer surface character too.</p>
            <div class="negative-prompt-field">
              <label for="refineNegativePrompt">Avoid <span class="field-optional">(optional)</span></label>
              <textarea id="refineNegativePrompt" class="negative-prompt-input negative-prompt-input--compact" maxlength="${MESHY_NEGATIVE_PROMPT_LIMIT}" placeholder="plastic shine, noisy texture, text, logos, extra artifacts">${item.negative_prompt || item.texture_negative_prompt || ''}</textarea>
              <p class="field-hint texture-setting-note">TimrX stores this separately and folds it into the Meshy refine prompt as an avoid instruction.</p>
            </div>

            <div class="texture-style-block">
              <div class="image-upload-control">
                <input id="refineStyleImageUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg">
                <label class="image-upload-trigger" for="refineStyleImageUpload">
                  <span class="image-upload-trigger__text">
                    <strong>Add texture reference</strong>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="refineStyleImageStatus">Optional JPG or PNG reference</div>
                <button type="button" class="image-upload-clear hidden" id="refineStyleImageClear">Clear</button>
              </div>
              <div class="image-upload-list image-upload-list--preview hidden" id="refineStyleImagePreview"></div>
              <div class="inline-field texture-style-url-row">
                <label for="refineStyleImageUrl">Or paste image URL</label>
                <input type="text" id="refineStyleImageUrl" placeholder="https://example.com/refine-style.jpg">
              </div>
              <p class="field-hint texture-setting-note">If both text and image are set, Meshy uses the text style prompt.</p>
            </div>
          </div>

          <div class="card">
            <h3>Advanced Settings</h3>
            <div class="inline-field">
              <label for="refineAiModel">Meshy Model</label>
              <select id="refineAiModel">
                <option value="latest" selected>Latest (Meshy 6)</option>
                <option value="meshy-6">Meshy 6</option>
                <option value="meshy-5">Meshy 5</option>
              </select>
            </div>
            <div class="field-row">
              <span class="field-label-inline">PBR Maps</span>
              <label class="toggle-switch">
                <input type="checkbox" id="refineEnablePbr" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="field-row">
              <span class="field-label-inline">Remove Lighting</span>
              <label class="toggle-switch">
                <input type="checkbox" id="refineRemoveLighting" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <p class="field-hint texture-setting-note" id="refineRemoveLightingNote">Cleaner base textures for custom lighting setups. Only available on Meshy 6 / latest.</p>
            <div class="field-row">
              <span class="field-label-inline">HD Texture</span>
              <label class="toggle-switch">
                <input type="checkbox" id="refineHdTexture">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <p class="field-hint texture-setting-note" id="refineHdTextureNote">Generate a 4K base color texture. Only available on Meshy 6 / latest.</p>
          </div>
        </div>

        <div class="workspace-modal__footer">
          <div class="gen-meta">
            <span class="gen-time">~2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 6</span>
          </div>
          <div class="workspace-modal__actions">
            <button type="button" class="gen-btn gen-btn--rail workspace-modal__ghost" id="refineSettingsCancel">Cancel</button>
            <button type="button" class="gen-btn" id="refineSettingsApply">Start Refine <span class="btn-cost-badge">6 cr</span></button>
          </div>
        </div>
      </div>
    `;

    const cleanup = (value = null) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(value);
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onKeyDown);
        cleanup(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector('#refineSettingsClose');
    const cancelBtn = overlay.querySelector('#refineSettingsCancel');
    const applyBtn = overlay.querySelector('#refineSettingsApply');
    const styleUpload = overlay.querySelector('#refineStyleImageUpload');
    const styleUrl = overlay.querySelector('#refineStyleImageUrl');
    const styleStatus = overlay.querySelector('#refineStyleImageStatus');
    const styleClear = overlay.querySelector('#refineStyleImageClear');
    const stylePreview = overlay.querySelector('#refineStyleImagePreview');
    const aiModel = overlay.querySelector('#refineAiModel');
    const removeLighting = overlay.querySelector('#refineRemoveLighting');
    const removeLightingNote = overlay.querySelector('#refineRemoveLightingNote');
    const hdTexture = overlay.querySelector('#refineHdTexture');
    const hdTextureNote = overlay.querySelector('#refineHdTextureNote');

    const closeModal = () => {
      cleanup(null);
    };

    const syncStylePreview = () => {
      const file = styleUpload?.files?.[0] || null;
      if (styleStatus) {
        styleStatus.textContent = file
          ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)`
          : 'Optional JPG or PNG reference';
        styleStatus.classList.toggle('is-empty', !file);
      }
      if (styleClear) styleClear.classList.toggle('hidden', !file);
      if (!stylePreview) return;
      if (!file) {
        stylePreview.classList.add('hidden');
        stylePreview.innerHTML = '';
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      stylePreview.innerHTML = `
        <figure class="image-upload-preview">
          <img class="image-upload-preview__image" src="${objectUrl}" alt="Refine style preview">
          <figcaption class="image-upload-preview__caption">${file.name}</figcaption>
        </figure>
      `;
      stylePreview.classList.remove('hidden');
      const img = stylePreview.querySelector('img');
      if (img) {
        img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
        img.addEventListener('error', () => URL.revokeObjectURL(objectUrl), { once: true });
      }
    };

    const syncLightingSupport = () => {
      if (!aiModel || !removeLighting) return;
      const supported = aiModel.value !== 'meshy-5';
      removeLighting.disabled = !supported;
      if (!supported) removeLighting.checked = false;
      if (removeLightingNote) {
        removeLightingNote.textContent = supported
          ? 'Cleaner base textures for custom lighting setups. Only available on Meshy 6 / latest.'
          : 'Remove Lighting is unavailable on Meshy 5 and stays off until you switch back to Meshy 6 / latest.';
      }
      if (hdTexture) {
        hdTexture.disabled = !supported;
        if (!supported) hdTexture.checked = false;
      }
      if (hdTextureNote) {
        hdTextureNote.textContent = supported
          ? 'Generate a 4K base color texture. Only available on Meshy 6 / latest.'
          : 'HD Texture is unavailable on Meshy 5 and stays off until you switch back to Meshy 6 / latest.';
      }
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);
    styleUpload?.addEventListener('change', () => {
      if (styleUpload.files?.[0] && styleUrl) styleUrl.value = '';
      syncStylePreview();
    });
    styleClear?.addEventListener('click', () => {
      if (styleUpload) styleUpload.value = '';
      syncStylePreview();
    });
    aiModel?.addEventListener('change', syncLightingSupport);
    syncLightingSupport();

    applyBtn?.addEventListener('click', async () => {
      applyBtn.disabled = true;
      try {
        let texture_image_url = '';
        const uploadedStyleFile = styleUpload?.files?.[0] || null;
        if (uploadedStyleFile) {
          const mime = (uploadedStyleFile.type || '').toLowerCase();
          const fileName = (uploadedStyleFile.name || '').toLowerCase();
          const hasAllowedExtension = fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png');
          // Require either valid MIME type OR allowed extension (both must be checked)
          if (!['image/jpeg', 'image/png'].includes(mime) && !hasAllowedExtension) {
            throw new Error('Refine style image must be a JPG or PNG file.');
          }
          texture_image_url = await fileToDataURL(uploadedStyleFile);
        } else {
          texture_image_url = (styleUrl?.value || '').trim();
        }

        document.removeEventListener('keydown', onKeyDown);
        cleanup({
          texture_prompt: (overlay.querySelector('#refineTexturePrompt')?.value || '').trim(),
          negative_prompt: getNegativePromptValue('refineNegativePrompt'),
          texture_negative_prompt: getNegativePromptValue('refineNegativePrompt'),
          texture_image_url,
          enable_pbr: !!overlay.querySelector('#refineEnablePbr')?.checked,
          remove_lighting: !!removeLighting?.checked,
          hd_texture: !!hdTexture?.checked,
          ai_model: (aiModel?.value || 'latest').trim() || 'latest'
        });
      } catch (err) {
        applyBtn.disabled = false;
        alert(err?.message || 'Unable to read refine settings.');
      }
    });
  });
}

export function getAnimationPostProcessValues() {
  const type = (byId('animPostProcessType')?.value || '').trim();
  if (!type) return null;

  if (type === 'change_fps') {
    const fps = parseInt(byId('animTargetFps')?.value || '0', 10);
    if (!Number.isFinite(fps) || ![24, 25, 30, 60].includes(fps)) {
      throw new Error('Target FPS must be 24, 25, 30, or 60.');
    }
    return { operation_type: 'change_fps', fps };
  }

  if (type === 'fbx2usdz') {
    return { operation_type: 'fbx2usdz' };
  }

  if (type === 'extract_armature') {
    return { operation_type: 'extract_armature' };
  }

  return null;
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
    generation_group_id: meta.generation_group_id || null,
    progress_pct: typeof meta.progress_pct === 'number' ? meta.progress_pct : 0,
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
  revealFreshHistoryEntry(placeholder.type || 'model');
}

// ============================================================================
// JOB WATCHERS
// ============================================================================

/**
 * Shared polling skeleton for all job watchers.
 *
 * Handles: dedup guard, abort control, cross-tab dedup, 500/403/404 handling,
 * consecutive error tracking, adaptive delay, exponential backoff, offerStatusRetry.
 *
 * Each watcher provides its custom logic via the onStatus callback, which receives
 * the status response and returns 'done' (stop polling) or 'continue'.
 *
 * @param {Object} opts
 * @param {string} opts.jobId
 * @param {string} opts.endpoint         - e.g. '/api/_mod/text-to-3d/status'
 * @param {string} opts.label            - e.g. 'Text-to-3D' (for logs/error messages)
 * @param {number} [opts.initialDelay=5000]
 * @param {number} [opts.steadyDelay=10000]
 * @param {number} [opts.rampUpAfter=30000]
 * @param {number} [opts.maxAttempts=120]
 * @param {number} [opts.maxConsecutiveErrors=5]
 * @param {number} [opts.notFoundRetries=5]
 * @param {number} [opts.abandonAfterSec]  - if set, stop polling after this many seconds
 * @param {(st: object, prog: object, elapsed: number) => 'done'|'continue'|Promise<'done'|'continue'>} opts.onStatus
 * @param {() => void} [opts.onTimeout]    - called when maxAttempts exceeded
 * @param {() => void} [opts.onAbandon]    - called when abandonAfterSec exceeded
 * @param {(msg: string) => void} [opts.onFatalError]
 * @param {() => void} opts.restartFn      - passed to offerStatusRetry
 * @param {() => void} [opts.onCleanup]    - called on any terminal exit (for interval cleanup)
 * @returns {{ prog: object, ctl: { abort(): void } } | null}
 */
function createPoller({
  jobId,
  endpoint,
  label,
  initialDelay = 5000,
  steadyDelay = 10000,
  rampUpAfter = 30000,
  maxAttempts = 120,
  maxConsecutiveErrors = 5,
  notFoundRetries = 5,
  abandonAfterSec,
  onStatus,
  onTimeout,
  onAbandon,
  onFatalError,
  restartFn,
  onCleanup,
  externalProg,
}) {
  if (State.watchers.has(jobId)) return null;

  let aborted = false;
  const ctl = { abort() { aborted = true; } };
  State.watchers.set(jobId, ctl);

  const prog = externalProg || UI.makeProgressDriver();
  let notFoundAttempts = 0;
  let pollAttempts = 0;
  let consecutiveErrors = 0;
  const pollStartedAt = Date.now();

  const _cleanup = () => {
    State.watchers.delete(jobId);
    onCleanup?.();
  };

  const poll = async (delay = initialDelay) => {
    if (aborted) { _cleanup(); return; }

    pollAttempts++;

    // Abandon policy (rig/animate): stop after N seconds, move to background
    if (abandonAfterSec != null) {
      const elapsedSec = (Date.now() - pollStartedAt) / 1000;
      if (elapsedSec > abandonAfterSec) {
        _cleanup();
        onAbandon?.();
        return;
      }
    }

    // Max attempts exceeded
    if (pollAttempts > maxAttempts) {
      console.error(`[${label}] Max poll attempts (${maxAttempts}) exceeded for job ${jobId}`);
      State.removeActiveJob(jobId);
      _cleanup();
      prog.fail(`${label} timed out - please try again`);
      onTimeout?.();
      return;
    }

    try {
      // Cross-tab dedup
      const _xtab = _getCrossTabResult(jobId);
      const result = _xtab
        ? { ok: true, data: _xtab, status: 200 }
        : await apiFetch(`${endpoint}/${jobId}`);
      if (!_xtab && result.ok) _broadcastPollResult(jobId, result.data);

      // 500+ / HTML error page
      if (result.status >= 500 || result.isHtml) {
        consecutiveErrors++;
        console.error(`[${label}] Server error (${result.status}) for job ${jobId}:`, result.error);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`[${label}] Too many consecutive errors (${consecutiveErrors}), stopping poll`);
          _cleanup();
          offerStatusRetry(jobId, endpoint, restartFn, label);
          return;
        }
        const nextDelay = Math.min(MAX_DELAY, delay * 2);
        setTimeout(() => poll(nextDelay), nextDelay);
        return;
      }

      // 403 Forbidden
      if (result.status === 403) {
        console.error(`[${label}] Access denied for job ${jobId}`);
        State.removeActiveJob(jobId);
        _cleanup();
        prog.fail(`${label} failed - access denied`);
        onFatalError?.('Access denied');
        return;
      }

      // 404 Not Found
      if (result.status === 404) {
        notFoundAttempts++;
        if (notFoundAttempts <= notFoundRetries) {
          setTimeout(() => poll(Math.min(1500, delay)), 1000);
          return;
        }
        State.removeActiveJob(jobId);
        _cleanup();
        prog.clear();
        return;
      }

      // Success — reset counters, delegate to watcher callback
      notFoundAttempts = 0;
      consecutiveErrors = 0;
      const st = result.data;
      const elapsed = Date.now() - pollStartedAt;

      const action = await onStatus(st, prog, elapsed);
      if (action === 'done') {
        _cleanup();
        return;
      }

      // Adaptive delay
      const nextDelay = elapsed < rampUpAfter ? initialDelay : steadyDelay;
      setTimeout(() => poll(nextDelay), nextDelay);

    } catch (err) {
      consecutiveErrors++;
      console.error(`[${label}] Unexpected error polling job ${jobId}:`, err);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        _cleanup();
        offerStatusRetry(jobId, endpoint, restartFn, label);
        return;
      }
      const retryDelay = Math.min(steadyDelay * 2, delay * 2);
      setTimeout(() => poll(retryDelay), retryDelay);
    }
  };

  poll();
  return { prog, ctl };
}


/**
 * Watch a text-to-3D job until completion
 */
export function watchJob(job_id, { isRecovery = false } = {}) {
  createPoller({
    jobId: job_id,
    endpoint: '/api/_mod/text-to-3d/status',
    label: 'Text-to-3D',
    notFoundRetries: 5,
    restartFn: () => watchJob(job_id, { isRecovery: true }),
    onTimeout: () => {
      handleJobFailure('Generation timed out after max attempts', 'text-to-3d', { isRecovery });
    },
    onStatus: async (st, prog, elapsed) => {
      // --- progress ---
      if (st.message) prog.label(st.message);
      if (typeof st.pct === 'number') {
        if (st.pct > 0) {
          const pct = Math.min(98, st.pct);
          prog.jump(pct);
          updateThumbnailProgress(job_id, pct);
        } else {
          const gentle = Math.min(15, Math.floor((elapsed / 120000) * 15));
          prog.jump(gentle);
          updateThumbnailProgress(job_id, gentle);
        }
      }

      // --- stuck-pending detection ---
      // If Meshy has the job at status=pending with no pct for > 4 min, surface
      // a non-blocking "Cancel / Retry" toast. Studio plan refunds failed tasks,
      // so retry is free. Only nudge once per job.
      if (!isRecovery
          && st.status === 'pending'
          && (st.pct == null)
          && elapsed > MESHY_PENDING_STUCK_MS
          && !_meshyStuckOffered.has(job_id)) {
        _meshyStuckOffered.add(job_id);
        _meshyShowToast(job_id, 'stuck');
      }

      // --- done ---
      if (st.status === 'done' && st.glb_url) {
        const meta = State.getPendingMeta()[job_id] || {};
        State.removeActiveJob(job_id);

        // Update wallet - backend is authoritative (once per job)
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'text_to_3d_done');
          } else if (st.wallet?.available !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.wallet.available, 'text_to_3d_done_wallet');
          } else if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          } else {
            refreshCreditsInBackground();
          }
        }

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
          model_type: meta.model_type || 'standard',
          should_remesh: !!meta.should_remesh,
          topology: meta.topology || '',
          target_polycount: meta.target_polycount || null,
          moderation: !!meta.moderation,
          target_formats: meta.target_formats || [],
          auto_size: !!meta.auto_size,
          origin_at: meta.origin_at || '',
          batch_count: Math.max(1, parseInt(meta.batch_count, 10) || 1),
          batch_slot: meta.batch_slot || 1,
          batch_group_id: meta.batch_group_id || null,
          generation_group_id: meta.generation_group_id || null,
          progress_pct: 100,
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
        if (!isRecovery) {
          State.setHistoryActiveModelId(job_id);
        }
        renderHistory();

        if (!isRecovery) {
          const isBatchPreview = historyData.batch_group_id && historyData.batch_count > 1;
          prog.jump(99, isBatchPreview ? `Loading variant ${historyData.batch_slot}/${historyData.batch_count}...` : 'Downloading model...');
          if (isBatchPreview) {
            window.GroupedViewer?.upsertItem?.(historyData.batch_group_id, historyData);
          } else {
            await Viewer.loadModelWithFallback(glbProxy, st.glb_url);
          }
          const doneLabel = isBatchPreview
            ? `Loaded variant ${historyData.batch_slot}/${historyData.batch_count}.`
            : (st.stage === 'refine' ? 'Loaded refined model.' : 'Loaded preview model.');
          const durationSuffix = st.generation_duration_ms
            ? ` Generated in ${Math.round(st.generation_duration_ms / 1000)}s.`
            : '';
          prog.done(doneLabel + durationSuffix);
          renderHistory();
        } else {
          prog.clear();
        }

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

        if (!isRecovery) {
          showNextStepSuggestions(job_id, stage);
        }

        if (!isRecovery && shouldShowDiscordPrompt()) {
          markDiscordPromptShown();
          UI.showDiscordSharePrompt('model', meta.prompt || '', st.thumbnail_url || '');
        }
        return 'done';
      }

      // --- failed ---
      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
        _meshyStuckOffered.delete(job_id);
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
        // Replace the blocking alert() with a non-blocking action toast.
        // For non-recovery jobs, offer Cancel/Retry. handleJobFailure still runs
        // on expired-model errors via its own path.
        if (!isRecovery && !isExpiredModelError(errorMsg)) {
          _meshyShowToast(job_id, 'failed');
        } else {
          handleJobFailure(errorMsg, 'refine', { isRecovery });
        }
        return 'done';
      }

      return 'continue';
    },
  });
}

/**
 * Watch a Meshy task (remesh, texture, rig, image3d)
 */
export function watchMeshyTask(job_id, kind = 'remesh', { isRecovery = false } = {}) {
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

  // For image3d, simulate progress since Meshy API doesn't return real progress
  const startTime = Date.now();
  const estimatedDuration = kind === 'image3d' ? 120000 : 60000;
  let simulatedPct = 0;

  createPoller({
    jobId: job_id,
    endpoint,
    label: stageLabel,
    notFoundRetries: 0,
    restartFn: () => watchMeshyTask(job_id, kind, { isRecovery: true }),
    onTimeout: () => {
      handleJobFailure(`${stageLabel} timed out after max attempts`, kind, { isRecovery });
    },
    onStatus: async (st, prog, elapsed) => {
      // --- progress ---
      if (typeof st.pct === 'number' && st.pct > 0) {
        const pct = Math.min(98, Math.max(0, st.pct));
        prog.jump(pct);
        updateThumbnailProgress(job_id, pct);
      } else if (kind === 'image3d' && st.status !== 'done' && st.status !== 'failed') {
        const elapsedMs = Date.now() - startTime;
        simulatedPct = Math.min(95, Math.floor(95 * (1 - Math.exp(-elapsedMs / estimatedDuration))));
        prog.jump(simulatedPct);
        updateThumbnailProgress(job_id, simulatedPct);
      }

      // --- done ---
      if (st.status === 'done') {
        const meta = State.getPendingMeta()[job_id] || {};
        State.removeActiveJob(job_id);

        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'meshy_done');
          } else if (st.wallet?.available !== undefined && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.wallet.available, 'meshy_done_wallet');
          } else if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          } else {
            refreshCreditsInBackground();
          }
        }

        const glbDirect = st.glb_url || (st.model_urls && st.model_urls.glb) || '';
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
          model_type: meta.model_type || 'standard',
          should_remesh: !!meta.should_remesh,
          topology: meta.topology || '',
          target_polycount: meta.target_polycount || null,
          moderation: !!meta.moderation,
          target_formats: meta.target_formats || [],
          auto_size: !!meta.auto_size,
          origin_at: meta.origin_at || '',
          batch_count: Math.max(1, parseInt(meta.batch_count, 10) || 1),
          batch_slot: meta.batch_slot || 1,
          batch_group_id: meta.batch_group_id || null,
          generation_group_id: meta.generation_group_id || null,
          progress_pct: 100,
          stage: kind,
          thumbnail_url: st.thumbnail_url || meta.thumbnail_url || '',
          glb_url: glbDirect,
          glb_proxy: glbProxy,
          preview_task_id: meta.preview_task_id || null,
          source_model_id: meta.source_model_id || meta.source_history_id || null,
          source_history_id: meta.source_history_id || meta.source_model_id || null,
          operation_key: meta.operation_key || '',
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

        if (!isRecovery && kind === 'texture' && shouldShowDiscordPrompt()) {
          markDiscordPromptShown();
          UI.showDiscordSharePrompt('model', meta.prompt || promptCandidate || '', st.thumbnail_url || meta.thumbnail_url || '');
        }
        return 'done';
      }

      // --- failed ---
      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
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
        return 'done';
      }

      return 'continue';
    },
  });
}

/**
 * Watch a Meshy automatic multi-color print job until the 3MF is saved.
 */
export function watchMultiColorPrintJob(job_id, { isRecovery = false } = {}) {
  createPoller({
    jobId: job_id,
    endpoint: '/api/_mod/print/multi-color',
    label: 'Meshy 3MF',
    initialDelay: 4000,
    steadyDelay: 8000,
    notFoundRetries: 2,
    restartFn: () => watchMultiColorPrintJob(job_id, { isRecovery: true }),
    onTimeout: () => {
      handleJobFailure('Meshy 3MF timed out after max attempts', 'multi_color_print', { isRecovery });
    },
    onStatus: async (st, prog) => {
      const pct = typeof st.pct === 'number'
        ? Math.min(98, Math.max(0, st.pct))
        : (st.status === 'done' ? 100 : 15);
      if (st.message) prog.label(st.message);
      updateThumbnailProgress(job_id, pct);

      if (st.status === 'done') {
        const meta = State.getPendingMeta()[job_id] || {};
        State.removeActiveJob(job_id);

        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (typeof st.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
            window.WorkspaceCredits.applyBackendBalance(st.new_balance, 'meshy_multi_color_done');
          } else if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          } else {
            refreshCreditsInBackground();
          }
        }

        const threeMfUrl = st.three_mf_url || st.model_urls?.['3mf'] || '';
        const sourceModelUrl = st.source_model_url || meta.source_model_url || meta.glb_url || '';
        const sourceProxy = sourceModelUrl ? getLoadableModelUrl(sourceModelUrl) : '';
        const title = meta.title || shortTitle(meta) || 'Meshy Auto 3MF';
        const rootPrompt = meta.root_prompt || meta.prompt || title || '';

        const historyData = {
          id: job_id,
          type: 'model',
          status: 'finished',
          status_label: 'Meshy 3MF ready',
          created_at: normalizeEpochMs(st.created_at) || Date.now(),
          prompt: meta.prompt || title || '',
          root_prompt: rootPrompt,
          prompt_fingerprint: promptFingerprint(rootPrompt),
          title,
          progress_pct: 100,
          stage: 'multi_color_print',
          thumbnail_url: st.thumbnail_url || meta.thumbnail_url || '',
          glb_url: sourceModelUrl,
          glb_proxy: sourceProxy,
          preview_task_id: meta.source_task_id || st.source_task_id || null,
          lineage_origin_id: meta.lineage_origin_id || meta.lineage_root_id || meta.source_task_id || job_id,
          lineage_root_id: meta.lineage_root_id || meta.lineage_origin_id || meta.source_task_id || job_id,
          model_urls: {
            ...(st.model_urls || {}),
            ...(threeMfUrl ? { '3mf': threeMfUrl } : {}),
          },
          three_mf_url: threeMfUrl,
        };

        if (State.historyHasJobId(job_id)) State.updateHistoryItem(job_id, historyData);
        else State.addHistoryItem(historyData);

        State.historyFreshThumbs.add(job_id);
        setTimeout(() => {
          State.historyFreshThumbs.delete(job_id);
          renderHistory();
        }, 1800);
        renderHistory();
        prog.done('Meshy 3MF ready.');
        if (!isRecovery && window.showToast) window.showToast('Meshy 3MF is ready.', 'success');
        return 'done';
      }

      if (st.status === 'failed') {
        State.removeActiveJob(job_id);
        if (!creditsRefreshedJobs.has(job_id)) {
          creditsRefreshedJobs.add(job_id);
          if (window.WorkspaceCredits?.syncWithBackend) {
            window.WorkspaceCredits.syncWithBackend();
          } else {
            refreshCreditsInBackground();
          }
        }
        const errorMsg = st.message || st.error || 'Meshy 3MF failed';
        prog.fail(errorMsg);
        State.updateHistoryItem(job_id, { status: 'failed', status_label: errorMsg });
        renderHistory();
        handleJobFailure(errorMsg, 'multi_color_print', { isRecovery });
        return 'done';
      }

      return 'continue';
    },
  });
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

  // Prefer a stable operation key for derived tasks; random fallback for generic texture jobs.
  const idempotencyKey = meta.idempotency_key || State.generateIdempotencyKey();
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
      body: { ...payload, idempotency_key: idempotencyKey },
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
  State.savePendingMeta(job_id, { ...meta, stage: kind, idempotency_key: idempotencyKey, source_model_id: meta.source_model_id || meta.id });
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

  // Show cost confirmation before charging
  const confirmed = await confirmCostBeforeAction('text-to-3d', batchCount);
  if (!confirmed) {
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
    const negativePrompt = getNegativePromptValue('modelNegativePrompt');
    if (!prompt) {
      prog.clear();
      alert('Please type a prompt describing what you want to generate.');
      return;
    }

    // Meshy enforces a 600-character hard limit on provider-facing prompts.
    if (!validateMeshyPromptLength(prompt, promptTextarea, negativePrompt)) {
      prog.clear();
      releaseSubmitLock();
      allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
      return;
    }

    const model = byId('modelAIModel')?.value || byId('modelSelect')?.value || 'latest';
    const license = (byId('modelLicense')?.value || 'private').trim() || 'private';
    const symmetry = (byId('modelSymmetry')?.value || 'auto').trim() || 'auto';
    const poseMode = byId('modelPoseMode')?.value || '';
    const batchGroupId = createBatchGroupId();
    if (batchCount > 1) {
      window.GroupedViewer?.reserve?.(batchGroupId, Array.from({ length: batchCount }, (_, index) => ({
        id: `${batchGroupId}:${index + 1}`,
        batch_group_id: batchGroupId,
        batch_count: batchCount,
        batch_slot: index + 1,
        prompt,
        root_prompt: prompt,
        negative_prompt: negativePrompt,
        model,
        license,
        pose_mode: poseMode,
        symmetry_mode: symmetry,
        stage: 'preview',
        status: 'generating',
        status_label: 'Generating...',
        progress_pct: 0,
      })));
    }

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
      const previewValues = getPreviewFormValues();
      const tempMeta = {
        prompt,
        model,
        root_prompt: prompt,
        negative_prompt: negativePrompt,
        license,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        model_type: previewValues.model_type,
        should_remesh: previewValues.should_remesh,
        topology: previewValues.topology,
        target_polycount: previewValues.target_polycount,
        moderation: previewValues.moderation,
        target_formats: previewValues.target_formats,
        auto_size: previewValues.auto_size,
        origin_at: previewValues.origin_at || '',
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
        negative_prompt: negativePrompt,
        model,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        license,
        model_type: previewValues.model_type,
        should_remesh: previewValues.should_remesh,
        moderation: previewValues.moderation,
        auto_size: previewValues.auto_size,
        target_formats: previewValues.target_formats,
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        refine: false
      };

      if (previewValues.topology) payload.topology = previewValues.topology;
      if (previewValues.target_polycount) payload.target_polycount = previewValues.target_polycount;
      if (previewValues.origin_at) payload.origin_at = previewValues.origin_at;

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
        negative_prompt: negativePrompt,
        license,
        symmetry_mode: symmetry,
        pose_mode: poseMode,
        model_type: previewValues.model_type,
        should_remesh: previewValues.should_remesh,
        topology: previewValues.topology,
        target_polycount: previewValues.target_polycount,
        moderation: previewValues.moderation,
        target_formats: previewValues.target_formats,
        auto_size: previewValues.auto_size,
        origin_at: previewValues.origin_at || '',
        batch_count: batchCount,
        batch_slot: slot + 1,
        batch_group_id: batchGroupId,
        generation_group_id: data.generation_group_id || null
      };
      State.savePendingMeta(job_id, jobMeta);
      addGeneratingPlaceholder(job_id, jobMeta);
      if (batchCount > 1) {
        window.GroupedViewer?.upsertItem?.(batchGroupId, { id: job_id, ...jobMeta, status: 'generating' });
      }
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

/**
 * Get image credits for the current quality + provider from GenerationState
 * @param {string} quality - 'standard' or 'high'
 * @returns {number}
 */
function getImageCredits(quality = 'standard') {
  const snapshot = window.GenerationState?.getGenerationSnapshot?.('image');
  if (snapshot?.capabilities?.creditsByQuality) {
    const outputMode = snapshot?.settings?.outputMode || 'raster';
    if (snapshot.capabilities.creditsByOutputMode?.[outputMode] != null) {
      return snapshot.capabilities.creditsByOutputMode[outputMode];
    }
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
  const snapshot = window.GenerationState?.getGenerationSnapshot?.('image');
  const outputMode = snapshot?.settings?.outputMode || 'raster';
  const caps = snapshot?.capabilities || {};
  if (caps.actionKeyByOutputMode?.[outputMode]) {
    return caps.actionKeyByOutputMode[outputMode];
  }
  if (caps.actionKeyByQuality?.[quality]) {
    return caps.actionKeyByQuality[quality];
  }
  return 'image_generate';
}

// Map shape to OpenAI gpt-image-1.5 resolution
// gpt-image-1/1.5 supports: 1024x1024, 1024x1536, 1536x1024
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
  const model = 'gpt-image-1.5';

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

    // Image-to-image refs (any of these → backend routes through /v1/images/edits)
    const refs = normalizeImageAssetList(stateSettings.referenceImages);
    const srcImg = stateSettings.sourceImage || '';
    const maskImg = stateSettings.maskImage || '';
    const operation = stateSettings.operation
      || ((srcImg || refs.length) ? 'edit' : 'generate');

    // Debug log before API call
    const payload = {
      prompt: promptRaw,
      size: resolution,
      image_size: imageSize,
      model,
      operation,
      source_image: srcImg,
      reference_images: refs,
      mask_image: maskImg,
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=openai cost=' + imageCredits +
                ' available=' + creditCheck.available + ' op=' + operation +
                ' refs=' + (refs.length + (srcImg ? 1 : 0)));

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

    // Image-to-image refs (any of these → backend routes through Vertex Imagen 3 capability)
    const refs = normalizeImageAssetList(stateSettings.referenceImages);
    const srcImg = stateSettings.sourceImage || '';
    const maskImg = stateSettings.maskImage || '';
    const operation = stateSettings.operation
      || ((srcImg || refs.length) ? 'edit' : 'generate');

    // Debug log before API call
    const payload = {
      provider: 'google',
      prompt: promptRaw,
      aspect_ratio: aspectRatio,
      image_size: imageSize,
      operation,
      source_image: srcImg,
      reference_images: refs,
      mask_image: maskImg,
      edit_mode: stateSettings.editMode || 'EDIT_MODE_DEFAULT',
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=google cost=' + imageCredits +
                ' available=' + creditCheck.available + ' op=' + operation +
                ' refs=' + (refs.length + (srcImg ? 1 : 0)));

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

const GOOGLE_NANO_SHAPE_MAP = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9',
};

const FLUX_PRO_SHAPE_MAP = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
};

const IDEOGRAM_V3_ASPECT_MAP = {
  square: '1x1',
  portrait: '2x3',
  landscape: '3x2',
};

const IDEOGRAM_V3_REFRAME_MAP = {
  square: '1024x1024',
  portrait: '512x1536',
  landscape: '1280x800',
};

const RECRAFT_V4_SHAPE_MAP = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
};

function normalizeImageAssetList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return [value].filter(Boolean);
}

function buildFluxRequestFromState(stateSettings = {}) {
  const shape = stateSettings.shape || 'square';
  const resolution = FLUX_PRO_SHAPE_MAP[shape] || '1024x1024';
  return {
    provider: 'flux_pro',
    prompt: (byId('imagePrompt')?.value || '').trim() || 'Generated image',
    shape,
    resolution,
    image_size: '1K',
    operation: stateSettings.operation || (stateSettings.sourceImage ? 'edit' : 'generate'),
    model_variant: stateSettings.modelVariant || 'pro',
    source_image: stateSettings.sourceImage || '',
    reference_images: normalizeImageAssetList(stateSettings.referenceImages),
    prompt_upsampling: stateSettings.promptUpsampling !== false,
    seed: stateSettings.seed || undefined,
    guidance: stateSettings.guidance || undefined,
    steps: stateSettings.steps || undefined,
    safety_tolerance: stateSettings.safetyTolerance || 2,
    output_format: stateSettings.outputFormat || 'jpeg',
    transparent_background: !!stateSettings.transparentBackground,
  };
}

function buildIdeogramRequestFromState(stateSettings = {}) {
  const shape = stateSettings.shape || 'square';
  const operation = stateSettings.operation || 'generate';
  const aspectRatio = IDEOGRAM_V3_ASPECT_MAP[shape] || '1x1';
  const resolution = operation === 'reframe'
    ? (IDEOGRAM_V3_REFRAME_MAP[shape] || IDEOGRAM_V3_REFRAME_MAP.square)
    : undefined;
  return {
    provider: 'ideogram_v3',
    prompt: (byId('imagePrompt')?.value || '').trim() || '',
    shape,
    resolution,
    aspect_ratio: aspectRatio,
    image_size: '1K',
    operation,
    source_image: stateSettings.sourceImage || '',
    mask_image: stateSettings.maskImage || '',
    style_reference_images: normalizeImageAssetList(stateSettings.styleReferenceImages),
    character_reference_images: normalizeImageAssetList(stateSettings.characterReferenceImages),
    character_reference_masks: normalizeImageAssetList(stateSettings.characterReferenceMasks),
    negative_prompt: stateSettings.negativePrompt || '',
    seed: stateSettings.seed || undefined,
    rendering_speed: stateSettings.renderingSpeed || 'DEFAULT',
    magic_prompt: stateSettings.magicPrompt || 'AUTO',
    style_type: stateSettings.styleType || '',
    style_preset: stateSettings.stylePreset || '',
    style_codes: stateSettings.styleCodes || '',
    color_palette_name: stateSettings.colorPaletteName || '',
    color_palette_members: stateSettings.colorPaletteMembers || '',
    image_weight: stateSettings.imageWeight || 50,
    upscale_factor: stateSettings.transparentBackground ? 'X2' : 'X1',
    detail: stateSettings.detail || 50,
    resemblance: stateSettings.resemblance || 50,
  };
}

function buildRecraftRequestFromState(stateSettings = {}) {
  const shape = stateSettings.shape || 'square';
  const size = RECRAFT_V4_SHAPE_MAP[shape] || '1024x1024';
  const operation = stateSettings.operation || 'generate';
  const modelVariant = stateSettings.modelVariant || (stateSettings.outputMode === 'vector_svg' ? 'recraftv4_vector' : 'recraftv4');
  const isVectorModel = /vector/i.test(modelVariant);
  const isV3Model = /^recraftv3(?:_vector)?$/i.test(modelVariant);
  const supportsStyles = isV3Model && ['generate', 'image_to_image', 'inpaint', 'replace_background', 'generate_background'].includes(operation);
  const supportsNegativePrompt = isV3Model && ['generate', 'image_to_image', 'inpaint', 'replace_background', 'generate_background'].includes(operation);
  const supportsTextLayout = isV3Model && ['generate', 'image_to_image', 'inpaint', 'replace_background', 'generate_background'].includes(operation);
  const style = supportsStyles ? (stateSettings.style || '') : '';
  const styleId = supportsStyles && !style ? (stateSettings.styleId || '') : '';
  const negativePrompt = supportsNegativePrompt ? (stateSettings.negativePrompt || '') : '';
  const textLayout = supportsTextLayout ? (stateSettings.textLayout || '') : '';
  return {
    provider: 'recraft_v4',
    prompt: (byId('imagePrompt')?.value || '').trim() || '',
    shape,
    size,
    resolution: size,
    image_size: '1K',
    operation,
    model_variant: modelVariant,
    output_mode: operation === 'vectorize' || isVectorModel ? 'vector_svg' : (stateSettings.outputMode || 'raster'),
    source_image: stateSettings.sourceImage || '',
    mask_image: stateSettings.maskImage || '',
    style,
    style_id: styleId,
    negative_prompt: negativePrompt,
    strength: stateSettings.strength || undefined,
    seed: stateSettings.seed || undefined,
    background_color: stateSettings.backgroundColor || '',
    preferred_colors: stateSettings.preferredColors || '',
    artistic_level: stateSettings.artisticLevel || undefined,
    no_text: !!stateSettings.noText,
    response_format: 'url',
    svg_compression: !!stateSettings.svgCompression,
    limit_num_shapes: !!stateSettings.limitNumShapes,
    max_num_shapes: stateSettings.maxNumShapes || undefined,
    text_layout: textLayout,
  };
}

function buildImageFinalItem(id, prompt, imageUrl, data = {}, meta = {}) {
  const provider = data.provider || meta.provider || 'unknown';
  return {
    id,
    type: 'image',
    status: 'finished',
    status_label: '',
    created_at: Date.now(),
    prompt,
    title: shortTitle(prompt),
    image_url: imageUrl,
    image_urls: data.image_urls || meta.image_urls || [imageUrl],
    thumbnail_url: data.thumbnail_url || imageUrl,
    stage: 'image',
    provider,
    provider_used: meta.provider_used || provider,
    model: data.model || meta.model || '',
    artifact_format: data.artifact_format || meta.artifact_format || data.format || 'png',
    provider_variant: data.provider_variant || meta.provider_variant || '',
    output_mode: data.output_mode || meta.output_mode || 'raster',
    operation: data.operation || meta.operation || '',
    upstream_request_id: data.upstream_request_id || meta.upstream_request_id || '',
    upstream_cost: data.upstream_cost ?? meta.upstream_cost ?? null,
    meta: {
      artifact_format: data.artifact_format || meta.artifact_format || data.format || 'png',
      provider_variant: data.provider_variant || meta.provider_variant || '',
      output_mode: data.output_mode || meta.output_mode || 'raster',
      operation: data.operation || meta.operation || '',
      upstream_request_id: data.upstream_request_id || meta.upstream_request_id || '',
      upstream_cost: data.upstream_cost ?? meta.upstream_cost ?? null,
    }
  };
}

async function startAsyncImageProvider({
  provider,
  providerLabel,
  logPrefix,
  prompt,
  settingsSnapshot,
  requestBody,
  placeholderLabel,
  queuedLabel,
  successLabel,
  tempIdPrefix,
  pendingMeta = {},
  responseModel,
}) {
  const imageCredits = settingsSnapshot.credits;
  const imageActionKey = getImageActionKey(settingsSnapshot.quality || 'standard');
  const creditCheck = checkCreditsForGeneration(imageCredits, 'image');
  if (creditCheck.shouldBlock) {
    showInsufficientCreditsModal(creditCheck.cost, creditCheck.available, 'image');
    return;
  }

  acquireSubmitLock();
  const prog = UI.makeProgressDriver();
  const idempotencyKey = State.generateIdempotencyKey();
  const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `${tempIdPrefix}-${Date.now()}`);
  let handoffToWatcher = false;

  prog.label('Reserving credits...');
  const reservation = reserveExactAmount(imageActionKey, imageCredits);
  if (reservation.insufficient) {
    releaseSubmitLock();
    showInsufficientCreditsModal(imageCredits, creditCheck.available, 'image');
    return;
  }

  if (window.ImageJobControl?.lock) {
    window.ImageJobControl.lock(provider, settingsSnapshot, tempId, reservation.reservationId);
  }

  addGeneratingPlaceholder(tempId, {
    type: 'image',
    status_label: placeholderLabel,
    prompt,
    stage: 'image',
    provider,
    provider_used: provider,
    idempotency_key: idempotencyKey,
    image_url: '',
    output_mode: settingsSnapshot.outputMode || 'raster',
  });

  try {
    prog.label(queuedLabel);
    console.log(`[GEN] mode=image provider=${provider} cost=${imageCredits} available=${creditCheck.available} payload=${JSON.stringify(requestBody)}`);

    const result = await apiFetch('/api/image/generate', {
      method: 'POST',
      body: requestBody,
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      if (handleGenerationTimeout(result, 'image_generate')) {
        State.updateHistoryItem(tempId, {
          status: 'generating',
          status_label: 'Still generating... (checking server)'
        });
        renderHistory();
        prog.label('Still generating...');
        watchImageJob(tempId, reservation.reservationId, {
          prompt,
          provider,
          provider_used: provider,
          model: responseModel,
          output_mode: settingsSnapshot.outputMode || 'raster',
          isTimeoutRecovery: true
        });
        handoffToWatcher = true;
        return;
      }
      if (handleApiError(result, 'image_generate', reservation.reservationId)) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        renderHistory();
        return;
      }
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error?.message || result.error || `${providerLabel} image failed: HTTP ${result.status}`);
    }

    const data = result.data || {};
    const imageId = data.image_id || data.job_id;
    const imageUrl = data.image_url;
    const jobStatus = data.status;

    if (jobStatus === 'queued' && imageId) {
      if (imageId !== tempId) {
        State.deleteHistoryItem(tempId, { skipRemote: true });
        addGeneratingPlaceholder(imageId, {
          type: 'image',
          status_label: placeholderLabel,
          prompt,
          stage: 'image',
          provider,
          provider_used: provider,
          model: responseModel,
          image_url: '',
          output_mode: settingsSnapshot.outputMode || 'raster',
        });
      }

      const backendReservationId = data.reservation_id || reservation.reservationId;
      if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
        window.WorkspaceCredits.applyBackendBalance(data.new_balance, `${provider}_image_queued`);
      }

      State.addActiveJob(imageId);
      State.savePendingMeta(imageId, {
        prompt,
        stage: 'image',
        type: 'image',
        provider,
        model: responseModel,
        output_mode: settingsSnapshot.outputMode || 'raster',
        ...pendingMeta
      });

      watchImageJob(imageId, backendReservationId, {
        prompt,
        provider,
        provider_used: provider,
        model: responseModel,
        output_mode: settingsSnapshot.outputMode || 'raster',
        ...pendingMeta
      });
      handoffToWatcher = true;
      return;
    }

    if (!imageUrl) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(`No image returned from ${providerLabel}`);
    }

    const finalItem = buildImageFinalItem(imageId || tempId, prompt, imageUrl, data, {
      provider,
      provider_used: provider,
      model: responseModel,
      output_mode: settingsSnapshot.outputMode || 'raster',
      ...pendingMeta
    });

    if (imageId && imageId !== tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.addHistoryItem(finalItem);
      State.setHistoryActiveModelId(imageId);
    } else {
      State.updateHistoryItem(tempId, finalItem);
    }

    renderHistory();
    prog.done(successLabel);

    if (typeof data.new_balance === 'number' && window.WorkspaceCredits?.applyBackendBalance) {
      window.WorkspaceCredits.applyBackendBalance(data.new_balance, `${provider}_image_response`);
    } else if (window.WorkspaceCredits?.syncWithBackend) {
      window.WorkspaceCredits.syncWithBackend();
    }
  } catch (err) {
    console.error(`[${logPrefix}] Error:`, err);
    prog.fail(err?.message || `${providerLabel} image generation failed`);
    alert(err?.message || `${providerLabel} image generation failed.`);
    State.deleteHistoryItem(tempId, { skipRemote: true });
    renderHistory();
  } finally {
    releaseSubmitLock();
    if (!handoffToWatcher && window.ImageJobControl?.unlock) {
      window.ImageJobControl.unlock();
    }
  }
}

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

    // Image-to-image refs (Nano Banana 2 uses a single reference image)
    const refs = normalizeImageAssetList(stateSettings.referenceImages);
    const srcImg = stateSettings.sourceImage || '';
    const operation = stateSettings.operation
      || ((srcImg || refs.length) ? 'edit' : 'generate');

    const payload = {
      provider: 'nano_banana',
      prompt: promptRaw,
      aspect_ratio: aspectRatio,
      image_size: imageSize,
      operation,
      source_image: srcImg,
      reference_images: refs,
      client_id: tempId
    };
    console.log('[GEN] mode=image provider=nano_banana cost=' + imageCredits +
                ' available=' + creditCheck.available + ' op=' + operation +
                ' refs=' + (refs.length + (srcImg ? 1 : 0)));

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


export async function startGoogleNanoImageGeneration() {
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'google_nano') {
    console.error(`[Google Nano] BLOCKED: State provider is '${stateProvider}', not 'google_nano'`);
    return;
  }
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[Google Nano] Generation already in progress');
    return;
  }

  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const promptRaw = (byId('imagePrompt')?.value || '').trim() || 'Generated image';
  const aspectRatio = GOOGLE_NANO_SHAPE_MAP[stateSettings.shape || 'square'] || '1:1';
  const settingsSnapshot = {
    prompt: promptRaw,
    shape: stateSettings.shape || 'square',
    quality: 'standard',
    outputMode: 'raster',
    aspectRatio,
    imageSize: '1K',
    credits: getImageCredits('standard')
  };

  // Image-to-image refs (Gemini 2.5 Flash Image supports inline_data parts)
  const refs = normalizeImageAssetList(stateSettings.referenceImages);
  const srcImg = stateSettings.sourceImage || '';
  const operation = stateSettings.operation
    || ((srcImg || refs.length) ? 'edit' : 'generate');

  await startAsyncImageProvider({
    provider: 'google_nano',
    providerLabel: 'Google Nano',
    logPrefix: 'Google Nano',
    prompt: promptRaw,
    settingsSnapshot,
    requestBody: {
      provider: 'google_nano',
      prompt: promptRaw,
      aspect_ratio: aspectRatio,
      image_size: '1K',
      operation,
      source_image: srcImg,
      reference_images: refs
    },
    placeholderLabel: 'Generating image with Google Nano...',
    queuedLabel: 'Queueing image with Google Nano...',
    successLabel: 'Image generated!',
    tempIdPrefix: 'google-nano-temp',
    responseModel: 'gemini-2.5-flash-image',
    pendingMeta: { provider_variant: 'direct_google', operation }
  });
}


export async function startFluxProImageGeneration() {
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'flux_pro') {
    console.error(`[FLUX.2 Pro] BLOCKED: State provider is '${stateProvider}', not 'flux_pro'`);
    return;
  }
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[FLUX.2 Pro] Generation already in progress');
    return;
  }

  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const requestBody = buildFluxRequestFromState(stateSettings);
  const promptRaw = requestBody.prompt || 'FLUX.2 image';
  const settingsSnapshot = {
    ...stateSettings,
    prompt: promptRaw,
    shape: stateSettings.shape || 'square',
    quality: 'standard',
    outputMode: 'raster',
    resolution: requestBody.resolution,
    operation: requestBody.operation,
    modelVariant: requestBody.model_variant,
    credits: getImageCredits('standard')
  };

  await startAsyncImageProvider({
    provider: 'flux_pro',
    providerLabel: 'FLUX.2 Pro',
    logPrefix: 'FLUX.2 Pro',
    prompt: promptRaw,
    settingsSnapshot,
    requestBody,
    placeholderLabel: requestBody.operation === 'edit'
      ? 'Generating FLUX.2 edit...'
      : 'Generating image with FLUX.2...',
    queuedLabel: 'Queueing FLUX.2 request...',
    successLabel: 'Image generated!',
    tempIdPrefix: 'flux-pro-temp',
    responseModel: requestBody.model_variant === 'flex'
      ? 'flux-2-flex'
      : requestBody.model_variant === 'pro_preview'
        ? 'flux-2-pro-preview'
        : 'flux-2-pro',
    pendingMeta: {
      provider_variant: requestBody.model_variant,
      operation: requestBody.operation
    }
  });
}


export async function startIdeogramV3ImageGeneration() {
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'ideogram_v3') {
    console.error(`[Ideogram V3] BLOCKED: State provider is '${stateProvider}', not 'ideogram_v3'`);
    return;
  }
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[Ideogram V3] Generation already in progress');
    return;
  }

  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const requestBody = buildIdeogramRequestFromState(stateSettings);
  const promptRaw = requestBody.prompt || `Ideogram ${requestBody.operation || 'generate'}`;
  const settingsSnapshot = {
    ...stateSettings,
    prompt: promptRaw,
    shape: stateSettings.shape || 'square',
    quality: 'standard',
    outputMode: 'raster',
    resolution: requestBody.resolution,
    operation: requestBody.operation,
    credits: getImageCredits('standard')
  };

  await startAsyncImageProvider({
    provider: 'ideogram_v3',
    providerLabel: 'Ideogram V3',
    logPrefix: 'Ideogram V3',
    prompt: promptRaw,
    settingsSnapshot,
    requestBody,
    placeholderLabel: `Running Ideogram ${requestBody.operation.replaceAll('_', ' ')}...`,
    queuedLabel: 'Queueing Ideogram request...',
    successLabel: 'Image generated!',
    tempIdPrefix: 'ideogram-v3-temp',
    responseModel: 'ideogram-v3',
    pendingMeta: {
      provider_variant: requestBody.operation,
      operation: requestBody.operation
    }
  });
}


export async function startRecraftV4ImageGeneration() {
  const stateProvider = window.GenerationState?.getProvider?.('image');
  if (stateProvider !== 'recraft_v4') {
    console.error(`[Recraft V4] BLOCKED: State provider is '${stateProvider}', not 'recraft_v4'`);
    return;
  }
  if (window.GenerationState?.isGenerating?.()) {
    console.warn('[Recraft V4] Generation already in progress');
    return;
  }

  const stateSettings = window.GenerationState?.getSettings?.('image') || {};
  const requestBody = buildRecraftRequestFromState(stateSettings);
  const promptRaw = requestBody.prompt || `Recraft ${requestBody.operation.replaceAll('_', ' ')}`;
  const outputMode = requestBody.output_mode || 'raster';
  const settingsSnapshot = {
    ...stateSettings,
    prompt: promptRaw,
    shape: stateSettings.shape || 'square',
    quality: 'standard',
    outputMode,
    size: requestBody.size,
    operation: requestBody.operation,
    modelVariant: requestBody.model_variant,
    credits: getImageCredits('standard')
  };

  await startAsyncImageProvider({
    provider: 'recraft_v4',
    providerLabel: 'Recraft V4',
    logPrefix: 'Recraft V4',
    prompt: promptRaw,
    settingsSnapshot,
    requestBody,
    placeholderLabel: requestBody.operation === 'vectorize'
      ? 'Vectorizing image with Recraft...'
      : outputMode === 'vector_svg'
        ? 'Generating SVG vector with Recraft...'
        : `Running Recraft ${requestBody.operation.replaceAll('_', ' ')}...`,
    queuedLabel: 'Queueing Recraft request...',
    successLabel: outputMode === 'vector_svg' ? 'Vector ready!' : 'Image generated!',
    tempIdPrefix: 'recraft-v4-temp',
    responseModel: requestBody.model_variant || (outputMode === 'vector_svg' ? 'recraftv4_vector' : 'recraftv4'),
    pendingMeta: {
      provider_variant: requestBody.operation,
      operation: requestBody.operation,
      output_mode: outputMode,
      artifact_format: outputMode === 'vector_svg' ? 'svg' : 'png'
    }
  });
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
          imageUrl = `data:${st.mime_type || 'image/png'};base64,${st.image_base64}`;
        }
        if (!imageUrl) {
          throw new Error('Provider did not return an image URL');
        }

        const provider = st.provider || meta.provider || 'unknown';
        const historyData = buildImageFinalItem(jobId, meta.prompt || '', imageUrl, st, {
          provider,
          provider_used: meta.provider_used || provider,
          model: st.model || meta.model || '',
          output_mode: st.output_mode || meta.output_mode || 'raster',
          artifact_format: st.artifact_format || meta.artifact_format || st.format || 'png',
          provider_variant: st.provider_variant || meta.provider_variant || '',
          upstream_request_id: st.upstream_request_id || meta.upstream_request_id || '',
          upstream_cost: st.upstream_cost ?? meta.upstream_cost ?? null
        });

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

  const providerDispatch = {
    nano_banana: startNanoBananaImageGeneration,
    openai: startOpenAIImageGeneration,
    google: startGeminiImageGeneration,
    google_nano: startGoogleNanoImageGeneration,
    flux_pro: startFluxProImageGeneration,
    ideogram_v3: startIdeogramV3ImageGeneration,
    recraft_v4: startRecraftV4ImageGeneration,
  };

  const startProvider = providerDispatch[provider];
  if (!startProvider) {
    console.error(`[Image] Unknown provider: ${provider} - NO FALLBACK`);
    alert(`Image provider "${provider}" is not available. Please select a valid image provider.`);
    return;
  }

  await startProvider();
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

// Seedance 2 GA credit costs. Keep in sync with pricing_service.py and migrations 068/069/076.
const SEEDANCE_COSTS = {
  // seedance-2.5: newer model, $0.30/s 480p and $0.60/s 720p at 120 credits per $/s.
  v25: {
    '480p': { 5: 180, 10: 360, 15: 540 },
    '720p': { 5: 360, 10: 720, 15: 1080 },
  },
  // seedance-2-mini: 12.5% cheaper upstream than Fast, priced at 87.5% of it. No 1080p.
  mini: {
    '480p': { 5: 70,  10: 140, 15: 210 },
    '720p': { 5: 105, 10: 210, 15: 315 },
  },
  fast: {
    '480p': { 5: 80, 10: 160, 15: 240 },
    '720p': { 5: 120, 10: 240, 15: 360 },
  },
  quality: {
    '480p': { 5: 100, 10: 200, 15: 300 },
    '720p': { 5: 160, 10: 320, 15: 480 },
    '1080p': { 5: 300, 10: 600, 15: 900 },
  },
};
const SEEDANCE_CPS = { mini: 14, fast: 16, quality: 20, preview: 20, v25: 36 };
// PiAPI's per-tier default resolution — Mini defaults to 720p, not 480p.
const SEEDANCE_DEFAULT_RESOLUTION = { mini: '720p', fast: '480p', quality: '480p', preview: '480p', v25: '720p' };
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

  // Seedance (PiAPI): exact GA tier/resolution/duration table, plus Reference Video input surcharge.
  if (settings.provider === 'seedance') {
    let tier = settings.seedanceTier || 'fast';
    if (tier === 'preview') tier = 'quality';
    const duration = settings.durationSec || 5;
    const resolution = (settings.resolution || SEEDANCE_DEFAULT_RESOLUTION[tier] || '480p').toLowerCase();
    const tierCosts = SEEDANCE_COSTS[tier] || {};
    let resCosts = tierCosts[resolution];
    // Mini and Fast have no 1080p — the backend snaps down to 720p, so quote that.
    if (!resCosts && resolution === '1080p') {
      resCosts = tierCosts['720p'];
    }
    let baseCost = resCosts?.[duration] ?? ((SEEDANCE_CPS[tier] || 16) * duration);
    if (settings.mode === 'reference_video') {
      const ref = window.VideoReferenceState?.getPayload?.();
      const inputVideoSeconds = Math.max(0, Number(ref?.input_video_seconds || 0));
      if (inputVideoSeconds > 0) {
        baseCost += Math.ceil((baseCost / Math.max(1, duration)) * 0.5 * inputVideoSeconds);
      }
    }
    return baseCost;
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
    prompt: (byId('videoAnimationPrompt')?.value || '').trim() || prompt || motion || 'Video generation',
    title: shortTitle((byId('videoAnimationPrompt')?.value || '').trim() || prompt || motion || 'Video'),
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
      ? `Sending to ${_providerDisplayName(settings.provider)}${(settings.seedanceTier === 'quality' || settings.seedanceTier === 'preview') ? ' Quality' : ''}...`
      : 'Sending to Veo...');

    // Build payload for Veo
    let endpoint;
    let payload;

    if (settings.mode === 'image2video') {
      // ── Image → video ──
      // One branch for every image count. The old code had three near-identical
      // branches (animate / transition / legacy morph DOM) reading from six
      // different preview <img> elements; images now live in one ordered list and
      // the mode is derived from its length.
      endpoint = '/api/video/animate';

      const refs = (window.VideoImageRefs || []).filter(Boolean);
      if (!refs.length) {
        releaseSubmitLock();
        releaseCreditsReservation(reservation.reservationId);
        UI.toast('Add at least one image', 'error');
        return;
      }

      const imgPrompt = (byId('videoAnimationPrompt')?.value || '').trim();
      const promptRequired = _isSeedanceProvider(settings.provider) || refs.length >= 2;
      if (promptRequired && !imgPrompt) {
        releaseSubmitLock();
        releaseCreditsReservation(reservation.reservationId);
        UI.toast(
          refs.length >= 2
            ? 'Describe how the first image should become the last'
            : 'Describe how the image should animate',
          'error'
        );
        return;
      }

      const effectivePrompt = imgPrompt || motion || prompt;
      const imgMode = refs.length >= 3 ? 'reference_images'
                    : refs.length === 2 ? 'image_transition'
                    : 'animate_image';

      payload = {
        provider: settings.provider,
        mode: imgMode,
        prompt: _composeSeedancePrompt(effectivePrompt, stylePreset, null, settings),
        motion_prompt: motion || undefined,
        motion_preset: motionPreset || undefined,
        duration_sec: settings.durationSec,
        aspect_ratio: settings.aspectRatio,
        resolution: settings.resolution,
        loop: settings.loop,
        seedance_variant: settings.seedanceVariant || undefined,
        seedance_tier: settings.seedanceTier || undefined,
        audio: settings.provider === 'seedance' ? settings.seedanceAudio : undefined,
      };

      if (refs.length === 1) {
        payload.image_data = refs[0].dataUrl;
      } else if (refs.length === 2) {
        // First frame → last frame.
        payload.start_image = refs[0].dataUrl;
        payload.end_image = refs[1].dataUrl;
      } else {
        // 3+ images are Seedance omni_reference. That has its own action codes and
        // credit cost, so it must go to /video/reference — posting it to
        // /video/animate would price it as a plain image-animate job.
        endpoint = '/api/video/reference';
        payload.image_urls = refs.map(r => r.dataUrl);
        payload.video_urls = [];
        payload.audio_urls = [];
        payload.input_video_seconds = 0;
        delete payload.mode;
        delete payload.motion_prompt;
        delete payload.motion_preset;
        delete payload.loop;
      }

      console.log('[VIDEO] image2video mode=' + imgMode + ' images=' + refs.length + ' endpoint=' + endpoint);

    } else if (settings.mode === 'reference_video') {
      // ── Reference Video (Seedance 2.0 omni_reference): mixed image/video/audio refs ──
      endpoint = '/api/video/reference';

      const refState = window.VideoReferenceState;
      const ref = (refState && typeof refState.getPayload === 'function') ? refState.getPayload() : null;

      if (!ref || (ref.total_refs || 0) === 0) {
        releaseSubmitLock();
        releaseCreditsReservation(reservation.reservationId);
        UI.toast('Add at least one image, video, or audio reference', 'error');
        return;
      }
      const refPrompt = (ref.prompt || prompt || '').trim();
      if (!refPrompt) {
        releaseSubmitLock();
        releaseCreditsReservation(reservation.reservationId);
        UI.toast('Describe the video and reference your media with @image1 / @video1 / @audio1', 'error');
        return;
      }
      if (ref.audio_urls.length && !(ref.image_urls.length || ref.video_urls.length)) {
        releaseSubmitLock();
        releaseCreditsReservation(reservation.reservationId);
        UI.toast('Audio references need at least one image or video reference too', 'error');
        return;
      }

      payload = {
        provider: 'seedance',
        prompt: _composeSeedancePrompt(refPrompt, stylePreset, null, settings),
        image_urls: ref.image_urls,
        video_urls: ref.video_urls,
        audio_urls: ref.audio_urls,
        input_video_seconds: ref.input_video_seconds,
        duration_sec: settings.durationSec,
        aspect_ratio: settings.aspectRatio,
        resolution: settings.resolution,
        seedance_variant: settings.seedanceVariant || undefined,
        seedance_tier: settings.seedanceTier || undefined,
        audio: settings.provider === 'seedance' ? settings.seedanceAudio : undefined,
      };

      console.log('[VIDEO] Reference Video mode -',
        'images:', ref.image_urls.length, 'videos:', ref.video_urls.length,
        'audios:', ref.audio_urls.length, 'inputVideoSec:', ref.input_video_seconds);

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
        seedance_tier: settings.seedanceTier || undefined,
        audio: settings.provider === 'seedance' ? settings.seedanceAudio : undefined,
      };
    }

    // Log action code for debugging (lowercase canonical format).
    // Seedance now carries the tier suffix (fast/quality) and resolution.
    const actionCode = window.WorkspaceCredits?.getVideoActionCode?.(
      settings.mode, settings.durationSec, settings.resolution, settings.provider, settings.seedanceTier
    ) ||
      (settings.provider === 'seedance'
        ? `seedance_${(settings.seedanceTier === 'preview' ? 'quality' : (settings.seedanceTier || 'fast'))}_${settings.mode === 'text2video' ? 'text_generate' : 'image_animate'}_${settings.durationSec}s_${(settings.resolution || '480p').toLowerCase()}`
        : `video_${settings.mode === 'text2video' ? 'text_generate' : 'image_animate'}_${settings.durationSec}s_${settings.resolution.toLowerCase()}`);
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
  const negativePrompt = getNegativePromptValue('image3dNegativePrompt');
  const model = byId('modelAIModel')?.value || 'latest';

  const meta = {
    prompt: `(image2-3d) ${prompt}`,
    root_prompt: prompt,
    negative_prompt: negativePrompt,
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
      body: { image_url: imageData, prompt, negative_prompt: negativePrompt, model },
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
  const negativePrompt = getNegativePromptValue('image3dNegativePrompt');
  const meta = {
    prompt: `(image2-3d) ${prompt}`,
    root_prompt: prompt,
    negative_prompt: negativePrompt,
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
      body: { image_url: item.image_url, prompt, negative_prompt: negativePrompt, source_image_history_id: item.id },
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
  if (!item) return;

  if (type === 'refine') {
    await startRefineFromHistory(item, 'history');
    return;
  }

  if (postProcessLock) return;
  postProcessLock = true;

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
  postProcessLock = false;
  throw new Error('Unknown post-process type');
}

export async function startRefineFromHistory(item, origin = 'history') {
  // If a prior refine modal was dismissed, the lock may still be held
  // momentarily. Force-release it if no generating placeholder is active.
  if (postProcessLock) {
    const hasActivePlaceholder = document.querySelector('.history-thumb--generating');
    if (!hasActivePlaceholder) {
      console.warn('[Refine] Clearing stale postProcessLock');
      postProcessLock = false;
    } else {
      console.warn('[Refine] Blocked by postProcessLock — another operation is in progress');
      return;
    }
  }
  if (!item) return;

  const stage = String(item.stage || item.payload?.stage || '').toLowerCase();
  const payload = item.payload || {};
  const previewTaskId =
    item.preview_task_id ||
    payload.preview_task_id ||
    item.source_task_id ||
    payload.source_task_id ||
    item.upstream_job_id ||
    payload.original_job_id ||
    (stage === 'preview' ? item.id : null);
  if (!previewTaskId) {
    console.warn('[Refine] No preview_task_id found:', { id: item.id, stage, keys: Object.keys(item) });
    alert('Only finished preview models can be refined. Select a preview result first.');
    return;
  }
  console.log('[Refine] Starting with previewTaskId:', previewTaskId, 'stage:', stage, 'origin:', origin);

  if (!checkCreditsFor('refine')) return;

  postProcessLock = true;
  const prog = UI.makeProgressDriver();
  let tempId = null;

  try {
    const refineValues = await openRefineSettingsModal(item);
    if (!refineValues) return;

    prog.label('Reserving credits...');
    const reservation = reserveCreditsForAction('refine', 1);
    if (reservation.insufficient) return;

    const styleMode = refineValues.texture_image_url ? 'image' : 'text';
    const promptLabel = refineValues.texture_prompt
      || (styleMode === 'image' ? `Image-guided refine for ${shortTitle(item)}` : `Refine ${shortTitle(item)}`);

    const jobMeta = {
      prompt: promptLabel,
      root_prompt: item.root_prompt || item.prompt || item.title || '',
      license: item.license || 'private',
      lineage_origin_id: item.lineage_root_id || item.id || null,
      preview_task_id: previewTaskId,
      thumbnail_url: item.thumbnail_url || '',
      enable_pbr: refineValues.enable_pbr,
      remove_lighting: refineValues.remove_lighting,
      ai_model: refineValues.ai_model || 'latest',
      negative_prompt: refineValues.negative_prompt || '',
      texture_negative_prompt: refineValues.texture_negative_prompt || '',
      texture_style_mode: styleMode,
      uses_image_style: styleMode === 'image',
      source_origin: origin
    };

    const idempotencyKey = State.generateIdempotencyKey();
    tempId = (crypto?.randomUUID ? crypto.randomUUID() : `refine-temp-${Date.now()}`);
    addGeneratingPlaceholder(tempId, {
      ...jobMeta,
      stage: 'refine',
      status_label: 'Starting refine...',
      idempotency_key: idempotencyKey
    });
    State.savePendingMeta(tempId, { ...jobMeta, stage: 'refine', idempotency_key: idempotencyKey });

    prog.label('Starting refine...');
    const body = {
      preview_task_id: previewTaskId,
      enable_pbr: refineValues.enable_pbr,
      ai_model: refineValues.ai_model || 'latest',
      remove_lighting: refineValues.remove_lighting,
      hd_texture: refineValues.hd_texture,
      target_formats: ['glb']
    };
    if (refineValues.negative_prompt) body.negative_prompt = refineValues.negative_prompt;
    if (refineValues.texture_negative_prompt) body.texture_negative_prompt = refineValues.texture_negative_prompt;
    if (refineValues.texture_prompt) body.texture_prompt = refineValues.texture_prompt;
    else if (refineValues.texture_image_url) body.texture_image_url = refineValues.texture_image_url;

    const result = await apiFetch('/api/_mod/text-to-3d/refine', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey }
    });

    if (!result.ok) {
      if (handleGenerationTimeout(result, 'refine')) return;
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

    const { job_id } = result.data || {};
    if (!job_id) {
      releaseCreditsReservation(reservation.reservationId);
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
      throw new Error('No job id returned for refine');
    }

    State.deleteHistoryItem(tempId, { skipRemote: true });
    State.deletePendingMeta(tempId);
    confirmCreditsReservation(reservation.reservationId, job_id);

    State.addActiveJob(job_id);
    State.savePendingMeta(job_id, { ...jobMeta, stage: 'refine' });
    addGeneratingPlaceholder(job_id, {
      ...jobMeta,
      stage: 'refine',
      status_label: 'Refining...'
    });
    watchJob(job_id);
  } catch (err) {
    if (tempId) {
      State.deleteHistoryItem(tempId, { skipRemote: true });
      State.deletePendingMeta(tempId);
    }
    console.error(err);
    prog.fail(err?.message || 'Refine failed');
    alert(err?.message || 'Refine failed');
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
    if (!source.input_task_id && !source.model_url) {
      alert('This model has no valid source for remeshing. Try generating or uploading a model first.');
      return;
    }
    labelPrompt = `Remesh ${shortTitle(baseItem)}`;
  }

  const remeshValues = getRemeshFormValues();
  const remeshActionLabel = remeshValues.convert_format_only ? 'Convert' : 'Remesh';
  const meta = {
    prompt: labelPrompt ? labelPrompt.replace(/^Remesh\b/, remeshActionLabel) : `${remeshActionLabel} model`,
    root_prompt: baseItem?.root_prompt || baseItem?.prompt || '',
    model: baseItem?.model || 'latest',
    license: baseItem?.license || 'private',
    lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
    source_model_id: baseItem?.id || null,
    topology: remeshValues.topology,
    target_polycount: remeshValues.target_polycount,
    target_formats: remeshValues.target_formats || [],
    resize_height: remeshValues.resize_height,
    origin_at: remeshValues.origin_at || '',
    convert_format_only: !!remeshValues.convert_format_only,
    print_height_mm: remeshValues.print_height_mm || null
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

  let texValues;
  try {
    texValues = await getTextureFormValues();
  } catch (err) {
    alert(err?.message || 'Unable to read texture settings.');
    return;
  }
  if (!texValues.text_style_prompt && !texValues.image_style_url) {
    alert('Please describe the texture you want or add a style image.');
    return;
  }
  const textureStyleMode = texValues.image_style_url ? 'image' : 'text';
  const texturePromptLabel = texValues.text_style_prompt
    || (baseItem ? `Image-guided texture for ${shortTitle(baseItem)}` : labelPrompt || 'Image-guided texture');

  const meta = {
    prompt: texturePromptLabel,
    root_prompt: baseItem?.root_prompt || baseItem?.prompt || texValues.text_style_prompt || '',
    model: baseItem?.model || 'latest',
    license: baseItem?.license || 'private',
    lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
    source_model_id: baseItem?.id || null,
    thumbnail_url: baseItem?.thumbnail_url || '',
    enable_pbr: texValues.enable_pbr,
    enable_original_uv: texValues.enable_original_uv,
    remove_lighting: texValues.remove_lighting,
    target_formats: texValues.target_formats || [],
    ai_model: texValues.ai_model || 'latest',
    negative_prompt: texValues.negative_prompt || '',
    texture_style_mode: textureStyleMode,
    uses_image_style: textureStyleMode === 'image'
  };

  try {
    await beginMeshyTask('texture', {
      ...source,
      ...texValues,
      title: baseItem ? shortTitle(baseItem) : labelPrompt || 'Uploaded model'
    }, meta);
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
  const negativePrompt = getNegativePromptValue('multiImageNegativePrompt');
  const model = byId('modelAIModel')?.value || 'latest';

  const meta = {
    prompt: `(multi-image) ${prompt}`,
    root_prompt: prompt,
    negative_prompt: negativePrompt,
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
      body: { image_urls: imageUrls, prompt, negative_prompt: negativePrompt, model },
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
    const file = byId('rigModelUpload')?.files?.[0];
    if (!file) {
      if (window.showToast) window.showToast('Choose a GLB file before checking readiness.', 'info');
      return;
    }
    payload.model_url = await fileToDataURL(file);
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
      rigState.preflight_limited = !!data.preflight_limited;
      rigState.source_type = choice;
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

  if (data.preflight_limited) {
    if (infoDiv) {
      let info = '<span style="color:#e3c47a;font-weight:500">Limited preflight for uploads</span>';
      if (data.reason) info += `<br><span style="color:#aaa">${data.reason}</span>`;
      infoDiv.innerHTML = info;
      infoDiv.style.background = 'rgba(227,196,122,.08)';
      infoDiv.style.borderLeft = '3px solid rgba(227,196,122,.42)';
    }
    if (faceWarning) faceWarning.style.display = 'none';
    if (step1) step1.style.display = '';
    if (step2) step2.style.display = '';
    return;
  }

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
  const rigTextureImageUpload = byId('rigTextureImageUpload');
  const rigTextureImageUrlInput = byId('rigTextureImageUrl');

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

  const uploadedRigTexture = rigTextureImageUpload?.files?.[0] || null;
  if (uploadedRigTexture) {
    const mime = (uploadedRigTexture.type || '').toLowerCase();
    const fileName = (uploadedRigTexture.name || '').toLowerCase();
    const hasAllowedExtension = fileName.endsWith('.png');
    if (mime && mime !== 'image/png' && !hasAllowedExtension) {
      alert('Rig texture image must be a PNG file.');
      startLock = false;
      return;
    }
    if (!mime && !hasAllowedExtension) {
      alert('Rig texture image must be a PNG file.');
      startLock = false;
      return;
    }
    payload.texture_image_url = await fileToDataURL(uploadedRigTexture);
  } else {
    const textureImageUrl = (rigTextureImageUrlInput?.value || '').trim();
    if (textureImageUrl) payload.texture_image_url = textureImageUrl;
  }

  const lineageRootId = baseItem?.lineage_root_id || baseItem?.lineage_origin_id || baseItem?.id || null;
  const sourceOperationId = baseItem?.id || payload.input_task_id || payload.model_url || '';
  const operationKey = buildDerivedOperationKey('rig', {
    source_id: sourceOperationId,
    lineage_id: lineageRootId,
    height_meters,
    uses_texture_image: !!payload.texture_image_url,
  });
  const rigDecision = await shouldStartDerivedOperation('Rigging', operationKey);
  if (!rigDecision.start) {
    startLock = false;
    return;
  }

  const idempotencyKey = operationIdempotencyKey('rig', operationKey, rigDecision.forceNew);
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
    uses_texture_image: !!payload.texture_image_url,
    height_meters,
    source_model_id: baseItem?.id || null,
    source_history_id: baseItem?.id || null,
    operation_key: operationKey,
    idempotency_key: idempotencyKey,
    lineage_origin_id: lineageRootId,
    lineage_root_id: lineageRootId,
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
  payload.idempotency_key = idempotencyKey;

  let result;
  try {
    result = await apiFetch('/api/_mod/rig/start', {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
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
    height_meters: pendingMeta.height_meters || null,
    source_model_id: pendingMeta.source_model_id || pendingMeta.source_history_id || null,
    source_history_id: pendingMeta.source_history_id || pendingMeta.source_model_id || null,
    operation_key: pendingMeta.operation_key || '',
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
  createPoller({
    jobId: job_id,
    endpoint: '/api/_mod/rig/status',
    label: 'Rigging',
    notFoundRetries: 0,
    externalProg: prog,
    abandonAfterSec: _RIG_THRESHOLDS.abandon,
    restartFn: () => watchRigJob(job_id),
    onCleanup: cleanup,
    onAbandon: () => {
      prog.pct(95, 'Rigging moved to background — check history for results.');
      State.updateHistoryItem(job_id, {
        status: 'generating',
        status_label: 'Processing in background...'
      });
      console.warn(`[Rig] Abandoned active polling for ${job_id}`);
    },
    onFatalError: () => {
      cleanup();
      prog.fail('Rigging job not found');
    },
    onStatus: async (st, prog, elapsed) => {
      // Feed real API progress
      const realPct = st.pct ?? st.progress ?? 0;
      est.feedReal(realPct);

      // Track queue position
      if (st.preceding_tasks != null) shared.queuePos = st.preceding_tasks;

      // --- done ---
      if (st.status === 'done' || st.status === 'SUCCEEDED' || st.status === 'succeeded') {
        cleanup();
        await _handleRigComplete(job_id, st, prog);
        return 'done';
      }

      // --- failed ---
      if (st.status === 'FAILED' || st.status === 'failed') {
        cleanup();
        prog.fail(st.message || st.error || 'Rigging failed');
        State.removeActiveJob(job_id);
        State.updateHistoryItem(job_id, { status: 'failed', error_message: st.message || st.error || 'Rigging failed' });
        State.deletePendingMeta(job_id);
        renderHistory();
        if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
        return 'done';
      }

      return 'continue';
    },
  });
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

  const operationKey = buildDerivedOperationKey('animate', {
    rig_task_id: riggingTaskId,
    action_id: parseInt(actionId, 10),
    post_process: postProcess || null,
  });
  const animDecision = await shouldStartDerivedOperation('Animation', operationKey);
  if (!animDecision.start) {
    startLock = false;
    return;
  }
  const idempotencyKey = operationIdempotencyKey('animate', operationKey, animDecision.forceNew);
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
    rig_task_id: riggingTaskId,
    action_id: parseInt(actionId, 10),
    post_process: postProcess || null,
    operation_key: operationKey,
    idempotency_key: idempotencyKey,
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
    idempotency_key: idempotencyKey,
  };
  if (postProcess) payload.post_process = postProcess;
  // Pass rig history item ID for reliable lineage linking
  if (animState.model_id || riggingTaskId) {
    payload.source_history_id = String(animState.model_id || riggingTaskId);
  }

  let result;
  try {
    result = await apiFetch('/api/_mod/rig/animate', {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
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
    animation_fbx_url: st.animation_fbx_url || '',
    processed_usdz_url: st.processed_usdz_url || '',
    processed_armature_fbx_url: st.processed_armature_fbx_url || '',
    processed_animation_fps_fbx_url: st.processed_animation_fps_fbx_url || '',
    rig_task_id: pendingMeta.rig_task_id || '',
    action_id: pendingMeta.action_id || null,
    post_process: pendingMeta.post_process || null,
    operation_key: pendingMeta.operation_key || '',
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
  createPoller({
    jobId: job_id,
    endpoint: '/api/_mod/rig/animate/status',
    label: 'Animation',
    notFoundRetries: 0,
    externalProg: prog,
    abandonAfterSec: _ANIM_THRESHOLDS.abandon,
    restartFn: () => watchAnimationJob(job_id),
    onCleanup: cleanup,
    onAbandon: () => {
      prog.pct(95, 'Animation moved to background — check history for results.');
      State.updateHistoryItem(job_id, {
        status: 'generating',
        status_label: 'Processing in background...'
      });
      console.warn(`[Anim] Abandoned active polling for ${job_id}`);
    },
    onFatalError: () => {
      cleanup();
      prog.fail('Animation job not found');
    },
    onStatus: async (st, prog, elapsed) => {
      const realPct = st.pct ?? st.progress ?? 0;
      est.feedReal(realPct);

      if (st.preceding_tasks != null) shared.queuePos = st.preceding_tasks;

      // --- done ---
      if (st.status === 'done' || st.status === 'SUCCEEDED' || st.status === 'succeeded') {
        cleanup();
        await _handleAnimComplete(job_id, st, prog);
        return 'done';
      }

      // --- failed ---
      if (st.status === 'FAILED' || st.status === 'failed') {
        cleanup();
        prog.fail(st.message || st.error || 'Animation failed');
        State.removeActiveJob(job_id);
        State.updateHistoryItem(job_id, { status: 'failed', error_message: st.message || st.error || 'Animation failed' });
        State.deletePendingMeta(job_id);
        renderHistory();
        if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
        return 'done';
      }

      return 'continue';
    },
    });
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
  if (!source.input_task_id && !source.model_url) {
    alert('This model has no valid source for remeshing. Try generating or uploading a model first.');
    return;
  }
  const remeshValues = getRemeshFormValues();
  const remeshActionLabel = remeshValues.convert_format_only ? 'Convert' : 'Remesh';
  const lineageRootId = item.lineage_root_id || item.lineage_origin_id || item.id;
  const operationKey = buildDerivedOperationKey('remesh', {
    source_id: item.id,
    lineage_id: lineageRootId,
    topology: remeshValues.topology || '',
    target_polycount: remeshValues.target_polycount || null,
    target_formats: remeshValues.target_formats || [],
    resize_height: remeshValues.resize_height || null,
    origin_at: remeshValues.origin_at || '',
    convert_format_only: !!remeshValues.convert_format_only,
    print_height_mm: remeshValues.print_height_mm || null,
  });
  const remeshDecision = await shouldStartDerivedOperation(remeshActionLabel, operationKey);
  if (!remeshDecision.start) return;
  const meta = {
    prompt: `${remeshActionLabel} ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || '',
    model: item.model || 'latest',
    license: item.license || 'private',
    lineage_origin_id: lineageRootId,
    lineage_root_id: lineageRootId,
    source_model_id: item.id,
    source_history_id: item.id,
    operation_key: operationKey,
    idempotency_key: operationIdempotencyKey('remesh', operationKey, remeshDecision.forceNew),
    thumbnail_url: item.thumbnail_url || '',
    topology: remeshValues.topology,
    target_polycount: remeshValues.target_polycount,
    target_formats: remeshValues.target_formats || [],
    resize_height: remeshValues.resize_height,
    origin_at: remeshValues.origin_at || '',
    convert_format_only: !!remeshValues.convert_format_only,
    print_height_mm: remeshValues.print_height_mm || null
  };
  try {
    await beginMeshyTask('remesh', { ...source, ...remeshValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Remesh failed.');
  }
}

/**
 * Start a print-focused repair/remesh from a history item.
 * Used by the manual paint workflow before users spend time coloring a mesh
 * that slicers will later reject.
 */
export async function startPrintReadyRemeshFromItem(item, options = {}) {
  if (!item) return;
  State.setHistoryActiveModelId(item.id);
  const source = buildMeshySourceFromItem(item);
  if (!source.input_task_id && !source.model_url) {
    alert('This model has no valid source for repair. Try generating or uploading a model first.');
    return;
  }

  const targetHeight = Number.parseFloat(options.print_height_mm || options.resize_height || '');
  const repairValues = {
    topology: options.topology || 'triangle',
    target_polycount: Number.parseInt(options.target_polycount || '120000', 10),
    target_formats: Array.from(new Set(['glb', 'stl', '3mf', ...(options.target_formats || [])])),
    origin_at: options.origin_at || 'bottom',
    convert_format_only: false,
  };

  if (Number.isFinite(targetHeight) && targetHeight > 0) {
    repairValues.resize_height = targetHeight;
    repairValues.print_height_mm = targetHeight;
  }

  const meta = {
    prompt: `Print repair ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || '',
    model: item.model || 'latest',
    license: item.license || 'private',
    lineage_origin_id: item.lineage_root_id || item.id,
    source_model_id: item.id,
    thumbnail_url: item.thumbnail_url || '',
    topology: repairValues.topology,
    target_polycount: repairValues.target_polycount,
    target_formats: repairValues.target_formats,
    resize_height: repairValues.resize_height,
    origin_at: repairValues.origin_at,
    convert_format_only: false,
    print_height_mm: repairValues.print_height_mm || null,
  };

  try {
    await beginMeshyTask('remesh', { ...source, ...repairValues }, meta);
  } catch (err) {
    console.error(err);
    alert(err?.message || 'Print repair failed.');
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

  let texValues;
  try {
    texValues = await getTextureFormValues();
  } catch (err) {
    alert(err?.message || 'Unable to read texture settings.');
    return;
  }
  if (!texValues.text_style_prompt && !texValues.image_style_url) {
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
  const textureStyleMode = texValues.image_style_url ? 'image' : 'text';
  const meta = {
    prompt: texValues.text_style_prompt || `Image-guided texture for ${shortTitle(item)}`,
    root_prompt: item.root_prompt || item.prompt || texValues.text_style_prompt || '',
    model: item.model || 'latest',
    license: item.license || 'private',
    lineage_origin_id: item.lineage_root_id || item.id,
    source_model_id: item.id,
    thumbnail_url: item.thumbnail_url || '',
    enable_pbr: texValues.enable_pbr,
    enable_original_uv: texValues.enable_original_uv,
    remove_lighting: texValues.remove_lighting,
    target_formats: texValues.target_formats || [],
    ai_model: texValues.ai_model || 'latest',
    texture_style_mode: textureStyleMode,
    uses_image_style: textureStyleMode === 'image'
  };
  try {
    await beginMeshyTask('texture', {
      ...source,
      ...texValues,
      title: shortTitle(item)
    }, meta);
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
  const modelType = (item.model_type || 'standard').trim() || 'standard';
  const shouldRemesh = modelType === 'lowpoly' ? false : !!item.should_remesh;
  const topology = (item.topology || '').trim().toLowerCase();
  const targetPolycount = parseInt(item.target_polycount, 10);
  const moderation = !!item.moderation;
  const autoSize = !!item.auto_size;
  const originAt = (item.origin_at || '').trim().toLowerCase();
  const targetFormats = Array.isArray(item.target_formats)
    ? Array.from(new Set(item.target_formats.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)))
    : [];
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
        model_type: modelType,
        should_remesh: shouldRemesh,
        topology,
        target_polycount: Number.isFinite(targetPolycount) ? targetPolycount : null,
        moderation,
        target_formats: targetFormats,
        auto_size: autoSize,
        origin_at: originAt,
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
        model_type: modelType,
        should_remesh: shouldRemesh,
        moderation,
        auto_size: autoSize,
        target_formats: targetFormats.length ? targetFormats : ['glb'],
        batch_count: count, batch_slot: slot + 1,
        batch_group_id: batchGroupId, refine: false
      };

      if (shouldRemesh && topology) payload.topology = topology;
      if (shouldRemesh && Number.isFinite(targetPolycount)) payload.target_polycount = targetPolycount;
      if (autoSize && (originAt === 'bottom' || originAt === 'center')) payload.origin_at = originAt;

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
        model_type: modelType,
        should_remesh: shouldRemesh,
        topology,
        target_polycount: Number.isFinite(targetPolycount) ? targetPolycount : null,
        moderation,
        target_formats: targetFormats,
        auto_size: autoSize,
        origin_at: originAt,
        batch_count: count, batch_slot: slot + 1,
        batch_group_id: batchGroupId
      });
      addGeneratingPlaceholder(job_id, {
        prompt, model, root_prompt: prompt,
        model_type: modelType,
        should_remesh: shouldRemesh,
        topology,
        target_polycount: Number.isFinite(targetPolycount) ? targetPolycount : null,
        moderation,
        target_formats: targetFormats,
        auto_size: autoSize,
        origin_at: originAt,
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
  if (code.includes('multi_color_print') || code.includes('multi-color')) return 'multi_color_print';
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
  meshy_multi_color_print: 'multiColor',
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
  meshy_multi_color_print: 'multi_color_print',
  meshy_rig:         'rig',
  meshy_animation:   'animate',
  video:             'video',
  image:             'image',
};

/** Legacy: infer resume_strategy from a stage string */
function _inferStrategyFromStage(stage) {
  const map = { texture: 'meshy_retexture', remesh: 'meshy_remesh', image3d: 'meshy_image_to_3d',
    preview: 'meshy_text_to_3d', refine: 'meshy_refine', rig: 'meshy_rig',
    animate: 'meshy_animation', animation: 'meshy_animation', video: 'video', image: 'image',
    multi_color_print: 'meshy_multi_color_print' };
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
      const meta = normalizePendingMeta(job.meta);
      State.savePendingMeta(id, {
        stage,
        resume_strategy: strategy,
        type: stage === 'video' ? 'video' : stage === 'image' ? 'image' : 'model',
        prompt: meta.prompt || job.prompt || '',
        root_prompt: meta.root_prompt || meta.prompt || job.prompt || '',
        title: meta.title || job.title || '',
        job_type: job.job_type || '',
        provider: job.provider || '',
        internal_job_id: job.id,
        provider_job_id: job.provider_job_id || job.upstream_job_id || null,
        created_at: job.created_at || null,
        batch_count: job.batch_count || meta.batch_count || 1,
        batch_slot: job.batch_slot || meta.batch_slot || 1,
        batch_group_id: job.batch_group_id || meta.batch_group_id || null,
        generation_group_id: job.generation_group_id || meta.generation_group_id || null,
        progress_pct: typeof job.progress === 'number' ? job.progress : (typeof meta.progress_pct === 'number' ? meta.progress_pct : 0),
        lineage_origin_id: meta.lineage_origin_id || meta.lineage_root_id || meta.source_task_id || null,
        lineage_root_id: meta.lineage_root_id || meta.lineage_origin_id || meta.source_task_id || null,
        source_task_id: meta.source_task_id || meta.preview_task_id || meta.rig_task_id || null,
        source_model_url: meta.source_model_url || meta.glb_url || '',
        glb_url: meta.glb_url || meta.source_model_url || '',
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
      // If in history but not finished — check age. Jobs older than 30 minutes
      // that the backend no longer knows about are stuck/orphaned. Mark as failed
      // and remove from active tracking to stop the infinite "Generating..." card.
      const createdAt = hist.created_at ? new Date(hist.created_at).getTime() : 0;
      const ageMs = createdAt ? (Date.now() - createdAt) : Infinity;
      const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
      if (ageMs > STALE_THRESHOLD_MS) {
        State.removeActiveJob(id);
        State.updateHistoryItem(id, { status: 'failed', status_label: 'Job expired' });
        log(`[Recovery] Expired stale job ${id} (age=${Math.round(ageMs / 60000)}min, not on server)`);
        continue;
      }
      // If recent and in history but not finished — keep it, the status endpoint will resolve it
    }
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
            batch_count: item.batch_count || item.payload?.batch_count || 1,
            batch_slot: item.batch_slot || item.payload?.batch_slot || 1,
            batch_group_id: item.batch_group_id || item.payload?.batch_group_id || null,
            generation_group_id: item.generation_group_id || item.payload?.generation_group_id || null,
            progress_pct: typeof item.progress_pct === 'number' ? item.progress_pct : 0,
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
        batch_count: item.batch_count || item.payload?.batch_count || 1,
        batch_slot: item.batch_slot || item.payload?.batch_slot || 1,
        batch_group_id: item.batch_group_id || item.payload?.batch_group_id || null,
        generation_group_id: item.generation_group_id || item.payload?.generation_group_id || null,
        progress_pct: typeof item.progress_pct === 'number' ? item.progress_pct : 0,
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
  const buckets = { mesh: [], text: [], video: [], rig: [], animate: [], image: [], multiColor: [] };

  for (const id of ids) {
    if (State.watchers.has(id)) {
      log(`[Recovery] Skipping ${id} — already polling`);
      continue;
    }
    const meta = pendingMeta?.[id] || {};
    const strategy = meta.resume_strategy || _inferStrategyFromStage(meta.stage || 'preview');
    // Skip jobs that handle their own polling (e.g. multi-color print modal)
    if (strategy === 'skip') {
      log(`[Recovery] Skipping ${id} — self-managed job (${meta.stage || 'unknown'})`);
      State.removeActiveJob(id);
      continue;
    }
    const category = _STRATEGY_TO_CATEGORY[strategy] || 'text';
    (buckets[category] || buckets.text).push(id);
  }

  const allToResume = [...buckets.mesh, ...buckets.text, ...buckets.video, ...buckets.rig, ...buckets.animate, ...buckets.image, ...buckets.multiColor];
  if (!allToResume.length) {
    if (!skipEmptyUI) UI.showOutputEmpty();
    return;
  }

  log(`[Recovery] Resuming ${allToResume.length} job(s): mesh=${buckets.mesh.length} text=${buckets.text.length} video=${buckets.video.length} rig=${buckets.rig.length} animate=${buckets.animate.length} image=${buckets.image.length} multiColor=${buckets.multiColor.length}`);

  // Mark recovered jobs as "generating" in history so cards show progress overlay
  const STATUS_LABELS = {
    texture: 'Texturing...', remesh: 'Remeshing...', image3d: 'Generating 3D...',
    video: 'Generating video...', rig: 'Rigging...', animate: 'Animating...',
    animation: 'Animating...', refine: 'Refining...', preview: 'Generating...',
    image: 'Generating image...', multi_color_print: 'Preparing Meshy 3MF...',
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
  // If there is exactly one model-producing job, let it auto-load into the
  // viewer when it finishes. Multiple jobs and non-model jobs stay recovery-only.
  const soloPreview = buckets.text.length === 1 && allToResume.length === 1;
  const soloMeshJobId = buckets.mesh.length === 1 && allToResume.length === 1 ? buckets.mesh[0] : null;
  const soloMeshStage = soloMeshJobId ? (pendingMeta[soloMeshJobId]?.stage || 'remesh') : '';
  const soloMeshAutoLoad = soloMeshJobId && ['texture', 'image3d'].includes(soloMeshStage);
  for (const id of buckets.mesh) {
    const stage = pendingMeta[id]?.stage || 'remesh';
    watchMeshyTask(id, stage, { isRecovery: !(soloMeshAutoLoad && id === soloMeshJobId) });
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
  for (const id of buckets.multiColor) {
    watchMultiColorPrintJob(id, { isRecovery: true });
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
window.watchMultiColorPrintJob = watchMultiColorPrintJob;
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
