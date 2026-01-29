/**
 * state.js
 * Manages state with database-backed storage via API.
 * Falls back to localStorage for active jobs and as a cache.
 */

import { ACTIVE_JOBS_STORAGE_KEY, PENDING_JOBS_STORAGE_KEY, log, apiFetch } from './config.js';

// ============================================================================
// CONSTANTS
// ============================================================================
const HISTORY_CACHE_KEY = 'meshy_history_cache';
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
  if (item.model_id || item.image_id) return false;
  return true;
}

/**
 * Get cached history from localStorage (fast, synchronous)
 */
function getHistoryCache() {
  try {
    const cached = localStorage.getItem(HISTORY_CACHE_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
}

/**
 * Save to localStorage cache (best-effort, ignore quota errors)
 */
function saveHistoryCache(arr) {
  try {
    // Only cache essential fields to avoid quota issues
    const minimal = (arr || []).slice(0, 100).map(item => ({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      prompt: item.prompt,
      thumbnail_url: item.thumbnail_url,
      image_url: item.image_url,
      glb_url: item.glb_url,
      glb_proxy: item.glb_proxy,
      stage: item.stage,
      created_at: item.created_at,
      art_style: item.art_style,
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
        const result = await apiFetch('/api/_mod/history');
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
    historyCache[idx] = { ...historyCache[idx], ...updates, status: updates.status || 'finished' };
    saveHistoryCache(historyCache);

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
// EXPOSE FUNCTIONS GLOBALLY (for backward compatibility)
// ============================================================================
window.getActiveJobs = getActiveJobs;
window.setActiveJobs = setActiveJobs;
window.addActiveJob = addActiveJob;
window.removeActiveJob = removeActiveJob;
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
