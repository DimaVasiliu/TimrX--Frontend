/**
 * job-recovery.js
 * Generation Reliability Layer - Frontend
 *
 * Ensures generations never break on page reload, navigation, or tab close:
 * - Persists active jobs in localStorage with idempotency keys
 * - Recovers and reconnects to running jobs on page load
 * - Shows warning before leaving page with active jobs
 * - Provides a persistent "Jobs in Progress" indicator
 */

import { apiFetch, log } from './config.js';
import {
  getActiveJobs,
  setActiveJobs,
  addActiveJob,
  removeActiveJob,
  getPendingMeta,
  savePendingMeta,
  watchers,
} from './state.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const IDEMPOTENCY_KEYS_STORAGE = 'timrx_idempotency_keys';
const JOB_RECOVERY_INTERVAL = 30000; // Check for stale jobs every 30s

// ============================================================================
// IDEMPOTENCY KEY MANAGEMENT
// ============================================================================

/**
 * Generate a new idempotency key (UUID v4)
 */
export function generateIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Store idempotency key -> job_id mapping for recovery
 */
export function saveIdempotencyMapping(idempotencyKey, jobId, meta = {}) {
  try {
    const mappings = JSON.parse(localStorage.getItem(IDEMPOTENCY_KEYS_STORAGE) || '{}');
    mappings[idempotencyKey] = {
      jobId,
      createdAt: Date.now(),
      ...meta,
    };
    // Keep only last 100 mappings
    const entries = Object.entries(mappings);
    if (entries.length > 100) {
      const sorted = entries.sort((a, b) => b[1].createdAt - a[1].createdAt);
      const kept = Object.fromEntries(sorted.slice(0, 100));
      localStorage.setItem(IDEMPOTENCY_KEYS_STORAGE, JSON.stringify(kept));
    } else {
      localStorage.setItem(IDEMPOTENCY_KEYS_STORAGE, JSON.stringify(mappings));
    }
  } catch (e) {
    console.warn('[JobRecovery] Failed to save idempotency mapping:', e);
  }
}

/**
 * Get job_id for an idempotency key (if we've seen it before)
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
  } catch {
    // Ignore
  }
}

// ============================================================================
// JOB RECOVERY ON PAGE LOAD
// ============================================================================

/**
 * Recover active jobs from server on page load.
 * Merges server-side active jobs with localStorage jobs.
 * Reconnects watchers for any jobs that are still running.
 *
 * @param {Function} watchJobFn - Function to start watching a job (jobId, meta) => void
 * @returns {Promise<Array>} List of recovered jobs
 */
export async function recoverActiveJobs(watchJobFn) {
  log('[JobRecovery] Checking for active jobs to recover...');

  try {
    // 1. Get active jobs from localStorage
    const localJobIds = getActiveJobs();
    const localMeta = getPendingMeta();

    // 2. Fetch active jobs from server
    const response = await apiFetch('/api/jobs/active', { timeout: 15000 });

    let serverJobs = [];
    if (response.ok && response.data?.jobs) {
      serverJobs = response.data.jobs;
    }

    // 3. Build merged list of jobs to recover
    const jobsToRecover = new Map();

    // Add server jobs (authoritative)
    for (const job of serverJobs) {
      const jobId = job.id || job.job_id;
      if (!jobId) continue;

      jobsToRecover.set(jobId, {
        jobId,
        status: job.status,
        progress: job.progress || 0,
        jobType: job.job_type || job.action_code,
        stage: job.stage,
        prompt: job.prompt,
        meta: localMeta[jobId] || {},
        fromServer: true,
      });
    }

    // Add local jobs not on server (may have completed or failed)
    for (const jobId of localJobIds) {
      if (!jobsToRecover.has(jobId)) {
        // Job not on server - might be completed, check status
        const meta = localMeta[jobId] || {};
        jobsToRecover.set(jobId, {
          jobId,
          status: 'unknown',
          progress: meta.progress || 0,
          jobType: meta.job_type || meta.action,
          stage: meta.stage,
          prompt: meta.prompt,
          meta,
          fromServer: false,
        });
      }
    }

    // 4. Reconnect to active jobs
    const recovered = [];
    for (const [jobId, job] of jobsToRecover) {
      // Skip if already being watched
      if (watchers.has(jobId)) {
        log('[JobRecovery] Job already being watched:', jobId);
        continue;
      }

      // Skip if job status indicates completion
      if (['succeeded', 'ready', 'failed', 'done'].includes(job.status)) {
        log('[JobRecovery] Job already complete:', jobId, job.status);
        removeActiveJob(jobId);
        continue;
      }

      // Reconnect watcher
      log('[JobRecovery] Reconnecting to job:', jobId, job.status, job.progress);

      // Add to active jobs if not already there
      addActiveJob(jobId);

      // Start watching
      if (typeof watchJobFn === 'function') {
        watchJobFn(jobId, job.meta);
      }

      recovered.push(job);
    }

    log('[JobRecovery] Recovered', recovered.length, 'active jobs');

    // Update jobs indicator
    updateJobsIndicator(recovered.length);

    return recovered;

  } catch (e) {
    console.error('[JobRecovery] Error recovering jobs:', e);
    return [];
  }
}

// ============================================================================
// BEFOREUNLOAD WARNING
// ============================================================================

let beforeUnloadEnabled = true;

/**
 * Enable/disable the beforeunload warning
 */
export function setBeforeUnloadEnabled(enabled) {
  beforeUnloadEnabled = enabled;
}

/**
 * Handler for beforeunload event.
 * Jobs are backend-durable and will resume on next page load via
 * /api/jobs/active recovery — this is a soft reminder, not a real warning.
 */
function handleBeforeUnload(e) {
  if (!beforeUnloadEnabled) return;

  const activeJobs = getActiveJobs();
  if (activeJobs.length === 0) return;

  const message = `You have ${activeJobs.length} generation${activeJobs.length > 1 ? 's' : ''} running. They will continue on the server and resume automatically when you return.`;

  e.preventDefault();
  e.returnValue = message;
  return message;
}

/**
 * Install the beforeunload handler
 */
export function installBeforeUnloadHandler() {
  window.addEventListener('beforeunload', handleBeforeUnload);
  log('[JobRecovery] beforeunload handler installed');
}

/**
 * Remove the beforeunload handler
 */
export function removeBeforeUnloadHandler() {
  window.removeEventListener('beforeunload', handleBeforeUnload);
}

// ============================================================================
// JOBS IN PROGRESS INDICATOR
// ============================================================================

let indicatorElement = null;

/**
 * Create or update the jobs-in-progress indicator
 * Shows a clean button when there are active jobs
 */
export function updateJobsIndicator(count = null) {
  // Count active jobs if not provided
  if (count === null) {
    count = getActiveJobs().length;
  }

  // Find or create indicator element
  if (!indicatorElement) {
    indicatorElement = document.getElementById('jobs-indicator');

    // Create if not exists
    if (!indicatorElement) {
      // Create indicator styled like the upload button (icon-btn)
      indicatorElement = document.createElement('button');
      indicatorElement.id = 'jobs-indicator';
      indicatorElement.type = 'button';
      indicatorElement.className = 'icon-btn';
      indicatorElement.setAttribute('aria-label', 'Jobs in progress');
      indicatorElement.innerHTML = `
        <svg class="jobs-indicator__spinner" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.2"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        <span><span class="jobs-indicator__count">0</span> generating</span>
      `;

      // Add styles if not already present
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

      // Add click handler to show jobs panel
      indicatorElement.addEventListener('click', () => {
        showJobsPanel();
      });

      // Insert centered inside the viewer
      const viewerWrap = document.querySelector('.viewer-wrap') || document.getElementById('model3dViewer');
      if (viewerWrap) {
        indicatorElement.style.cssText = 'position: absolute; top: 56px; left: 50%; transform: translateX(-50%); z-index: 15; display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 10px; font-size: 13px; cursor: pointer;';
        viewerWrap.appendChild(indicatorElement);
      } else {
        indicatorElement.style.cssText = 'position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 9999; display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; background: rgba(30,30,40,0.95); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; color: #e0e0e0; font-size: 13px; cursor: pointer;';
        document.body.appendChild(indicatorElement);
      }
    }
  }

  // Update count and visibility
  const countEl = indicatorElement.querySelector('.jobs-indicator__count');
  if (countEl) {
    countEl.textContent = count;
  }

  if (count > 0) {
    indicatorElement.style.display = '';
  } else {
    indicatorElement.style.display = 'none';
  }
}

/**
 * Show the jobs panel/modal with list of active jobs
 */
export function showJobsPanel() {
  const activeJobIds = getActiveJobs();
  const meta = getPendingMeta();

  if (activeJobIds.length === 0) {
    // Nothing to show
    return;
  }

  // Create modal
  const existing = document.getElementById('jobs-panel-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'jobs-panel-modal';
  modal.className = 'modal show';
  modal.style.cssText = 'z-index: 10001;';

  const jobsList = activeJobIds.map(jobId => {
    const jobMeta = meta[jobId] || {};
    const title = jobMeta.prompt?.slice(0, 40) || jobMeta.title || 'Generation';
    const progress = jobMeta.progress || 0;
    const type = jobMeta.job_type || jobMeta.action || 'unknown';

    return `
      <div class="jobs-panel__item" data-job-id="${jobId}">
        <div class="jobs-panel__item-info">
          <div class="jobs-panel__item-title">${title}${jobMeta.prompt?.length > 40 ? '...' : ''}</div>
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

  // Add styles for job items
  const style = document.createElement('style');
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
  modal.appendChild(style);

  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  // Close handlers
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

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the job recovery system
 * Call this on page load
 *
 * @param {Function} watchJobFn - Function to start watching a job
 */
export async function initJobRecovery(watchJobFn) {
  log('[JobRecovery] Initializing...');

  // Install beforeunload handler
  installBeforeUnloadHandler();

  // Recover active jobs
  const recovered = await recoverActiveJobs(watchJobFn);

  // Update indicator
  updateJobsIndicator();

  return recovered;
}

// ============================================================================
// EXPORTS FOR GLOBAL ACCESS
// ============================================================================

if (typeof window !== 'undefined') {
  window.JobRecovery = {
    generateIdempotencyKey,
    saveIdempotencyMapping,
    getJobForIdempotencyKey,
    clearIdempotencyMapping,
    recoverActiveJobs,
    initJobRecovery,
    updateJobsIndicator,
    showJobsPanel,
    setBeforeUnloadEnabled,
  };
}