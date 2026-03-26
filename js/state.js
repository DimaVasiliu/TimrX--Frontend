/**
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
export const HISTORY_LIMIT = 50;
export const MAX_DATA_URI_LEN = 50000;

// In-memory cache for history (populated from DB)
let historyCache = null;
let historyLoading = false;
let historyLoadPromise = null;
let _historyLastFetchedAt = 0; // monotonic timestamp of last successful fetch
const _HISTORY_DEDUP_MS = 5000; // skip duplicate calls within 5s

// Global single-flight gate: only ONE history API request in flight at a time.
// Prevents tab-switch + load-more from running concurrent history queries
// that compete for the same pool connections.
let _historyFetchInFlight = null; // Promise | null

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
// Per-tab pagination state — each filter type has its own cache/cursor/hasMore.
// "all" is the default tab; "image", "video", "model" are the media tabs.
// nextCursor is an opaque base64 string from the backend; nextOffset is legacy fallback.
const _tabState = {
  all:   { items: null, hasMore: false, nextCursor: null, nextOffset: 0, loading: false },
  image: { items: null, hasMore: false, nextCursor: null, nextOffset: 0, loading: false },
  video: { items: null, hasMore: false, nextCursor: null, nextOffset: 0, loading: false },
  model: { items: null, hasMore: false, nextCursor: null, nextOffset: 0, loading: false },
};

function _currentTab() { return historyState.filter || 'all'; }
function _ts(tab) { return _tabState[tab] || _tabState.all; }

export function historyHasMore() { return _ts(_currentTab()).hasMore; }
export function historyLoadingMore() { return _ts(_currentTab()).loading; }
/** True if the current tab has fetched its first page from the DB. */
export function historyTabLoaded() { return _ts(_currentTab()).items !== null; }

/**
 * Parse the history API response, which may be:
 * - New format: { ok, items, has_more, next_offset, ... }
 * - Legacy format: bare Array
 */
function _parseHistoryResponse(data) {
  if (data && data.ok && Array.isArray(data.items)) {
    // New paginated format (supports cursor + legacy offset)
    return {
      items: data.items,
      hasMore: !!data.has_more,
      nextCursor: data.next_cursor || null,
      nextOffset: data.next_offset ?? 0,
    };
  }
  // Legacy: bare array
  const items = Array.isArray(data) ? data : [];
  return { items, hasMore: false, nextCursor: null, nextOffset: 0 };
}

export async function loadHistoryFromDB() {
  if (historyLoading && historyLoadPromise) {
    return historyLoadPromise;
  }

  // Skip if we successfully fetched very recently (prevents double-fetch on
  // page load when both main.js and getHistory() trigger loadHistoryFromDB)
  if (historyCache && (Date.now() - _historyLastFetchedAt) < _HISTORY_DEDUP_MS) {
    log('[History] Skipping duplicate load (fetched', Date.now() - _historyLastFetchedAt, 'ms ago)');
    return historyCache;
  }

  historyLoading = true;
  historyLoadPromise = (async () => {
    try {
      // First, try to migrate old localStorage data
      await migrateOldHistory();

      // Helper to attempt a single fetch (always fetches "all" tab for initial load)
      const attemptFetch = async () => {
        const result = await apiFetch(`/api/_mod/history?limit=${HISTORY_LIMIT}&offset=0&type=all`);
        if (!result.ok) {
          const err = new Error(result.error || `HTTP ${result.status}`);
          err.isTimeout = result.isTimeout;
          throw err;
        }
        return _parseHistoryResponse(result.data);
      };

      // Try up to 2 times on timeout
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const page = await attemptFetch();

          // Preserve in-flight generating items that were added to historyCache
          // while the DB fetch was running. Without this merge, items added by
          // addHistoryItem() (e.g., generating placeholders) would be silently
          // dropped when the DB response overwrites historyCache.
          const dbIds = new Set(page.items.map(i => i.id));
          const inFlightItems = (historyCache || []).filter(
            i => i && !dbIds.has(i.id) && i.status && i.status !== 'finished'
          );
          historyCache = [...inFlightItems, ...page.items];

          _historyLastFetchedAt = Date.now();
          const ts = _ts('all');
          ts.items = null;  // Force getTabHistory() to use merged historyCache
          ts.hasMore = page.hasMore;
          ts.nextCursor = page.nextCursor;
          ts.nextOffset = page.nextOffset;
          saveHistoryCache(historyCache);
          log('History loaded from DB:', historyCache.length, 'items',
            ts.hasMore ? `(has_more, cursor=${ts.nextCursor ? 'yes' : 'no'})` : '(all loaded)',
            attempt > 1 ? '(retry succeeded)' : '');
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
          _ts('all').hasMore = false;
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
 * Load page 1 of a specific tab from the DB.
 * Used when the user switches to a media tab (image/video/model) for the first time.
 * Returns the items for that tab, or [] on failure.
 */
export async function loadHistoryTab(tab) {
  const ts = _ts(tab);
  if (ts.loading) return ts.items || [];
  // If already loaded, return cached items
  if (ts.items !== null) return ts.items;

  // Wait for any other history request to finish first (prevents concurrent
  // history API calls from competing for the same pool connections).
  if (_historyFetchInFlight) {
    try { await _historyFetchInFlight; } catch (_) { /* ignore */ }
  }

  ts.loading = true;
  const fetchPromise = (async () => {
    try {
      const typeParam = tab === 'all' ? 'all' : tab;
      const result = await apiFetch(`/api/_mod/history?limit=${HISTORY_LIMIT}&offset=0&type=${typeParam}`);
      if (!result.ok) {
        console.warn(`[History] loadTab(${tab}) failed:`, result.error);
        ts.items = [];
        return [];
      }
      const page = _parseHistoryResponse(result.data);
      ts.items = page.items;
      ts.hasMore = page.hasMore;
      ts.nextCursor = page.nextCursor;
      ts.nextOffset = page.nextOffset;
      log(`[History] tab=${tab} loaded: ${page.items.length} items, has_more=${ts.hasMore}, cursor=${ts.nextCursor ? 'yes' : 'null'}`);
      return ts.items;
    } catch (err) {
      console.warn(`[History] loadTab(${tab}) error:`, err.message);
      ts.items = [];
      return [];
    } finally {
      ts.loading = false;
      _historyFetchInFlight = null;
    }
  })();
  _historyFetchInFlight = fetchPromise;
  return fetchPromise;
}

/**
 * Load the next page of history from the DB and APPEND to the current tab's cache.
 * Returns the newly appended items, or [] if no more pages.
 */
export async function loadMoreHistory() {
  const tab = _currentTab();
  const ts = _ts(tab);

  if (ts.loading || !ts.hasMore) {
    return [];
  }

  // Wait for any other history request to finish first
  if (_historyFetchInFlight) {
    try { await _historyFetchInFlight; } catch (_) { /* ignore */ }
  }

  ts.loading = true;
  const fetchPromise = (async () => {
    try {
      const typeParam = tab === 'all' ? 'all' : tab;
      // Prefer cursor-based pagination (avoids OFFSET row-scan); fall back to offset
      const paginationParam = ts.nextCursor
        ? `cursor=${encodeURIComponent(ts.nextCursor)}`
        : `offset=${ts.nextOffset}`;
      const result = await apiFetch(
        `/api/_mod/history?limit=${HISTORY_LIMIT}&${paginationParam}&type=${typeParam}`
      );
      if (!result.ok) {
        console.warn(`[History] loadMore(${tab}) failed:`, result.error);
        return [];
      }

      const page = _parseHistoryResponse(result.data);
      if (!page.items.length) {
        ts.hasMore = false;
        return [];
      }

      // Append to tab cache (dedupe by id)
      const existingIds = new Set((ts.items || []).map(h => h.id));
      const newItems = page.items.filter(h => !existingIds.has(h.id));
      if (ts.items) {
        ts.items.push(...newItems);
      } else {
        ts.items = newItems;
      }
      ts.hasMore = page.hasMore;
      ts.nextCursor = page.nextCursor;
      ts.nextOffset = page.nextOffset;

      // Also update the global historyCache if this is the "all" tab,
      // preserving any in-flight generating items not yet in DB.
      if (tab === 'all') {
        const loadedIds = new Set(ts.items.map(h => h.id));
        const inFlight = (historyCache || []).filter(
          h => h && !loadedIds.has(h.id) && h.status && h.status !== 'finished'
        );
        historyCache = [...inFlight, ...ts.items];
        saveHistoryCache(historyCache);
      }

      log(`[History] loadMore(${tab}): +${newItems.length} items (total=${ts.items.length}, has_more=${ts.hasMore}, cursor=${ts.nextCursor ? 'yes' : 'null'})`);
      return newItems;
    } catch (err) {
      console.warn(`[History] loadMore(${tab}) error:`, err.message);
      return [];
    } finally {
      ts.loading = false;
      _historyFetchInFlight = null;
    }
  })();
  _historyFetchInFlight = fetchPromise;
  return fetchPromise;
}

/**
 * Get the items for the current tab. Returns the tab-specific cache if loaded,
 * otherwise falls back to filtering the global historyCache (backward compat).
 */
export function getTabHistory() {
  const tab = _currentTab();
  const ts = _ts(tab);
  if (ts.items !== null) return ts.items;
  // Fallback: filter the global "all" cache (covers the case before tab-specific load)
  const all = getHistory();
  if (tab === 'all') return all;
  return all.filter(it => {
    const type = it.type || (it.glb_url ? 'model' : it.image_url ? 'image' : it.video_url ? 'video' : 'model');
    return type === tab;
  });
}

/**
 * Invalidate all tab caches including 'all' (called after new generations,
 * deletes, etc.). This ensures newly added items (e.g., generating
 * placeholders) are visible immediately — getTabHistory() falls back to
 * the global historyCache which is the source of truth.
 */
export function invalidateTabCaches() {
  for (const key of Object.keys(_tabState)) {
    _tabState[key].items = null;
    _tabState[key].hasMore = false;
    _tabState[key].nextCursor = null;
    _tabState[key].nextOffset = 0;
  }
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
 * Find a history item by ID across ALL loaded caches (current tab, other tabs, global).
 * This is the correct way to resolve an item for viewer opening — it covers
 * items loaded via pagination or tab-specific fetches that aren't in the
 * global "all" cache.
 */
export function findHistoryItem(id) {
  if (!id) return null;
  // 1. Check current tab first (most likely match)
  const currentItems = _ts(_currentTab()).items;
  if (currentItems) {
    const found = currentItems.find(x => x.id === id);
    if (found) return found;
  }
  // 2. Check all other tab caches
  for (const key of Object.keys(_tabState)) {
    const items = _tabState[key].items;
    if (items && items !== currentItems) {
      const found = items.find(x => x.id === id);
      if (found) return found;
    }
  }
  // 3. Fall back to global cache (covers localStorage fallback)
  const global = getHistory();
  if (global) {
    const found = global.find(x => x.id === id);
    if (found) return found;
  }
  return null;
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
  // Cap in-memory cache at 500 to prevent unbounded growth.
  // This is a soft cap — the user's full history is always reachable via load-more.
  if (historyCache.length > 500) historyCache.length = 500;
  saveHistoryCache(historyCache);
  // Invalidate tab caches so getTabHistory() re-derives from updated global cache
  invalidateTabCaches();

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
    // Invalidate tab caches so getTabHistory() re-derives from updated global cache
    invalidateTabCaches();

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
  // Invalidate tab caches so getTabHistory() re-derives from updated global cache
  invalidateTabCaches();

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
    const result = await apiFetch(`/api/_mod/history?limit=${HISTORY_LIMIT}&offset=0&type=all`);
    if (!result.ok) {
      const err = new Error(result.error || `HTTP ${result.status}`);
      err.isTimeout = result.isTimeout;
      throw err;
    }
    const page = _parseHistoryResponse(result.data);
    const ts = _ts('all');
    ts.hasMore = page.hasMore;
    ts.nextCursor = page.nextCursor;
    ts.nextOffset = page.nextOffset;
    ts.items = page.items;
    // Also invalidate media tab caches so they re-fetch with fresh data
    invalidateTabCaches();
    return page.items;
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
  sort: 'desc',
  _renderedTotalPages: 1,  // Updated by renderHistory — used by next-page handler
};

// ============================================================================
// PROVIDER CAPABILITIES MAP
// Defines what each provider supports for each mode
// ============================================================================
export const PROVIDER_CAPABILITIES = {
  image: {
    nano_banana: {
      name: 'Nano Banana',
      shapes: ['square', 'portrait', 'landscape'],
      qualities: ['standard', 'high', '4k'],
      defaultShape: 'square',
      defaultQuality: 'standard',
      credits: 7,   // PREMIUM provider
      creditsByQuality: { standard: 7, high: 12, '4k': 18 },
      genTimeByQuality: { standard: '45 sec', high: '60 sec', '4k': '90 sec' },
      genTime: '45 sec',
      shapeMap: { square: '1:1', portrait: '9:16', landscape: '16:9' },
      qualityMap: { standard: '1K', high: '2K', '4k': '4K' }
    },
    openai: {
      name: 'OpenAI',
      shapes: ['square', 'portrait', 'landscape'],
      qualities: ['standard', 'high'],
      defaultShape: 'square',
      defaultQuality: 'standard',
      credits: 4,
      creditsByQuality: { standard: 4, high: 8 },
      genTimeByQuality: { standard: '30 sec', high: '45 sec' },
      genTime: '30 sec',
      shapeMap: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
      qualityMap: { standard: 'standard', high: 'hd' },
      sizeMap: { standard: '1024x1024', high: '1792x1024' }
    },
    google: {
      name: 'Google (Imagen)',
      shapes: ['square', 'portrait', 'landscape'],
      qualities: ['standard', 'high'],
      defaultShape: 'square',
      defaultQuality: 'standard',
      credits: 4,
      creditsByQuality: { standard: 4, high: 8 },
      genTimeByQuality: { standard: '30 sec', high: '45 sec' },
      genTime: '30 sec',
      shapeMap: { square: '1:1', portrait: '9:16', landscape: '16:9' },
      qualityMap: { standard: '1K', high: '2K' }
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
    image: 'nano_banana',
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
  return generation.provider[mode] || 'nano_banana';
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
    // Image: provider-specific pricing (OpenAI/Gemini: 4/8, Nano Banana: 7/12/18)
    const quality = settings.quality || 'standard';
    credits = caps.creditsByQuality?.[quality] ?? caps.credits ?? 4;
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
 * Check if the UI-level generation lock is active (job in progress).
 * @returns {boolean}
 */
export function isLocked() {
  return generation.locked;
}

// ── Submit lock: request-level mutex for duplicate-click prevention ──
// This is the centralized version of the module-scoped startLock in api.js.
// It covers the synchronous portion of a generate function (validation →
// API call → watcher handoff). Released in the finally block.
let _submitLock = false;

/**
 * Set the submit lock (call at top of generate functions).
 * @param {boolean} locked
 */
export function setSubmitLock(locked) {
  _submitLock = !!locked;
}

/**
 * Check if a generation submit is in progress (request-level).
 * @returns {boolean}
 */
export function isSubmitting() {
  return _submitLock;
}

/**
 * Check if ANY generation activity is happening — either a request is
 * being submitted (submit lock) or a job is in progress (UI lock).
 * This is the single authority for "should we block a new generation?".
 * @returns {boolean}
 */
export function isGenerating() {
  return _submitLock || generation.locked;
}

/**
 * Reset transient generation state on rail/tab switch.
 *
 * Clears the lock and currentJob so stale provider/mode state cannot
 * bleed into the next panel. Does NOT touch per-mode settings (provider,
 * shape, quality, etc.) — those are intentionally persistent so users
 * keep their selections when switching back.
 *
 * Active job polling and localStorage recovery data are unaffected.
 */
export function resetTransientGenerationState() {
  if (generation.locked || _submitLock) {
    console.log('[GEN] Rail switch: clearing stale lock (currentJob:', generation.currentJob?.jobId || 'none', ', submitLock:', _submitLock, ')');
    generation.locked = false;
    generation.currentJob = null;
    _submitLock = false;
  }
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
window.findHistoryItem = findHistoryItem;
window.saveHistory = saveHistory;
window.addHistoryItem = addHistoryItem;
window.updateHistoryItem = updateHistoryItem;
window.deleteHistoryItem = deleteHistoryItem;
window.loadHistoryFromDB = loadHistoryFromDB;
window.loadMoreHistory = loadMoreHistory;
window.loadHistoryTab = loadHistoryTab;
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
  resetTransientGenerationState,
  setSubmitLock,
  isSubmitting,
  isGenerating,

  // Provider change notifications
  onProviderChange
};
