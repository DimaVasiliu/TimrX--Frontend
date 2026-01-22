/**
 * state.js
 * Manages state with database-backed storage via API.
 * Falls back to localStorage for active jobs and as a cache.
 * Uses window.TimrX globals (no ES modules).
 */

(function() {
  'use strict';

  // Get from TimrX globals (set by config.js)
  const { ACTIVE_JOBS_STORAGE_KEY, PENDING_JOBS_STORAGE_KEY, log, apiFetch } = window.TimrX;

  // ============================================================================
  // CONSTANTS
  // ============================================================================
  const HISTORY_CACHE_KEY = 'meshy_history_cache';
  const HISTORY_LIMIT = 500;
  const MAX_DATA_URI_LEN = 50000;

  // In-memory cache for history (populated from DB)
  let historyCache = null;
  let historyLoading = false;
  let historyLoadPromise = null;

  // ============================================================================
  // JOB WATCHERS (shared Map for tracking active job polling)
  // ============================================================================
  const watchers = new Map();

  // ============================================================================
  // ACTIVE JOBS MANAGEMENT
  // ============================================================================

  function getActiveJobs() {
    try {
      return JSON.parse(localStorage.getItem(ACTIVE_JOBS_STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function setActiveJobs(ids) {
    try {
      localStorage.setItem(ACTIVE_JOBS_STORAGE_KEY, JSON.stringify([...new Set(ids)].slice(0, 50)));
    } catch (e) {
      try {
        localStorage.setItem(ACTIVE_JOBS_STORAGE_KEY, '[]');
      } catch (_) {}
    }
  }

  function addActiveJob(id) {
    const ids = getActiveJobs();
    if (!ids.includes(id)) {
      ids.push(id);
      setActiveJobs(ids);
    }
  }

  function removeActiveJob(id) {
    setActiveJobs(getActiveJobs().filter(x => x !== id));
    const w = watchers.get(id);
    if (w && typeof w.abort === 'function') w.abort();
    watchers.delete(id);
    deletePendingMeta(id);
  }

  // ============================================================================
  // PENDING JOBS METADATA
  // ============================================================================

  function getPendingMeta() {
    try {
      return JSON.parse(localStorage.getItem(PENDING_JOBS_STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePendingMeta(id, meta) {
    try {
      const m = getPendingMeta();
      m[id] = meta;
      let entries = Object.entries(m);
      if (entries.length > 50) entries = entries.slice(entries.length - 50);
      localStorage.setItem(PENDING_JOBS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {
      console.warn('Pending meta save failed:', e);
    }
  }

  function deletePendingMeta(id) {
    try {
      const m = getPendingMeta();
      delete m[id];
      localStorage.setItem(PENDING_JOBS_STORAGE_KEY, JSON.stringify(m));
    } catch (_) {}
  }

  // ============================================================================
  // HISTORY DATABASE (API-backed with localStorage cache)
  // ============================================================================

  function sanitizeHistoryItem(item = {}) {
    if (!item || typeof item !== 'object') return item;
    const copy = { ...item };

    delete copy.image_base64;
    delete copy.raw;
    delete copy.images_base64;

    if (!copy.thumbnail_url && copy.image_url) {
      copy.thumbnail_url = copy.image_url;
    }

    if (copy.type === 'image' && copy.status === 'generating' && copy.image_url) {
      copy.status = 'finished';
    }

    return copy;
  }

  function getHistoryCache() {
    try {
      const cached = localStorage.getItem(HISTORY_CACHE_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  }

  function saveHistoryCache(arr) {
    try {
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
      } catch {}
    }
  }

  async function migrateOldHistory() {
    const OLD_HISTORY_KEY = 'meshy_history';
    const MIGRATION_FLAG = 'meshy_history_migrated';

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

      const result = await apiFetch('/api/history', {
        method: 'POST',
        body: oldHistory.map(sanitizeHistoryItem)
      });

      if (result.ok) {
        const data = result.data;
        if (data.skipped && data.skipped.length > 0) {
          console.warn('[History] Migration skipped items:', data.skipped);
        }
        localStorage.removeItem(OLD_HISTORY_KEY);
        localStorage.setItem(MIGRATION_FLAG, 'true');
        log('History migration complete');
      }
    } catch (err) {
      console.warn('[History] Migration failed:', err.message);
    }
  }

  async function loadHistoryFromDB() {
    if (historyLoading && historyLoadPromise) {
      return historyLoadPromise;
    }

    historyLoading = true;
    historyLoadPromise = (async () => {
      await migrateOldHistory();

      try {
        const result = await apiFetch('/api/history');
        if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`);
        historyCache = Array.isArray(result.data) ? result.data : [];
        saveHistoryCache(historyCache);
        log('History loaded from DB:', historyCache.length, 'items');
        return historyCache;
      } catch (err) {
        console.warn('[History] Failed to load from DB, using cache:', err.message);
        historyCache = getHistoryCache();
        return historyCache;
      } finally {
        historyLoading = false;
        historyLoadPromise = null;
      }
    })();

    return historyLoadPromise;
  }

  function getHistory() {
    if (historyCache !== null) {
      return historyCache;
    }
    historyCache = getHistoryCache();
    loadHistoryFromDB().catch(() => {});
    return historyCache;
  }

  function saveHistory(arr) {
    const source = Array.isArray(arr) ? arr : [];
    const sanitized = source.map(sanitizeHistoryItem);

    historyCache = sanitized;
    saveHistoryCache(sanitized);

    apiFetch('/api/history', {
      method: 'POST',
      body: sanitized
    }).then(result => {
      if (result.ok && result.data?.skipped?.length > 0) {
        console.warn('[History] Sync skipped items:', result.data.skipped);
        const skippedIds = new Set(result.data.skipped.map(s => s.client_id));
        historyCache = historyCache.map(item => {
          if (skippedIds.has(item.id)) {
            return { ...item, _skipReason: result.data.skipped.find(s => s.client_id === item.id)?.reason };
          }
          return item;
        });
        saveHistoryCache(historyCache);
      }
    }).catch(err => {
      console.warn('[History] Failed to save to DB:', err.message);
    });

    return true;
  }

  function addHistoryItem(item) {
    const sanitized = sanitizeHistoryItem(item);

    if (historyCache === null) historyCache = getHistoryCache();
    historyCache.unshift(sanitized);
    if (historyCache.length > HISTORY_LIMIT) historyCache.length = HISTORY_LIMIT;
    saveHistoryCache(historyCache);

    apiFetch('/api/history/item', {
      method: 'POST',
      body: sanitized
    }).then(result => {
      if (result.ok && result.data?.skipped) {
        console.warn('[History] Item skipped:', result.data.skipped);
        const idx = historyCache.findIndex(x => x.id === sanitized.id);
        if (idx !== -1) {
          historyCache[idx] = { ...historyCache[idx], _skipReason: result.data.skipped.reason };
          saveHistoryCache(historyCache);
        }
      }
    }).catch(err => {
      console.warn('[History] Failed to add item to DB:', err.message);
    });
  }

  function updateHistoryItem(jobId, updates = {}) {
    if (historyCache === null) historyCache = getHistoryCache();
    const idx = historyCache.findIndex(x => x.id === jobId);

    if (idx !== -1) {
      historyCache[idx] = { ...historyCache[idx], ...updates, status: updates.status || 'finished' };
      saveHistoryCache(historyCache);

      apiFetch(`/api/history/item/${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        body: { ...updates, status: updates.status || 'finished' }
      }).catch(err => {
        console.warn('[History] Failed to update item in DB:', err.message);
      });
      return true;
    }

    const newItem = { id: jobId, ...updates, status: updates.status || 'finished' };
    addHistoryItem(newItem);
    return true;
  }

  function deleteHistoryItem(jobId, options = {}) {
    if (historyCache === null) historyCache = getHistoryCache();
    historyCache = historyCache.filter(x => x.id !== jobId);
    saveHistoryCache(historyCache);

    if (!options.skipRemote) {
      apiFetch(`/api/history/item/${encodeURIComponent(jobId)}`, {
        method: 'DELETE'
      }).catch(err => {
        console.warn('[History] Failed to delete item from DB:', err.message);
      });
    }
  }

  function historyHasJobId(jobId) {
    return getHistory().some(x => x.id === jobId);
  }

  async function forceRestoreFromDB() {
    const fallbackCache = historyCache ?? getHistoryCache();

    historyLoading = false;
    historyLoadPromise = null;

    try {
      const result = await apiFetch('/api/history');
      if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`);
      historyCache = Array.isArray(result.data) ? result.data : [];
      saveHistoryCache(historyCache);
      log('History restored from DB:', historyCache.length, 'items');
      return historyCache;
    } catch (err) {
      historyCache = Array.isArray(fallbackCache) ? fallbackCache : [];
      saveHistoryCache(historyCache);
      console.error('[History] Failed to restore from DB:', err.message);
      throw err;
    }
  }

  function clearLocalHistoryCache() {
    historyCache = null;
    try {
      localStorage.removeItem(HISTORY_CACHE_KEY);
      log('Local history cache cleared');
    } catch (_) {}
  }

  // ============================================================================
  // HISTORY UI STATE
  // ============================================================================
  const historyState = {
    page: 1,
    pageSize: 9,
    query: '',
    filter: 'all',
    galleryExpanded: false,
    sort: 'desc'
  };

  const historyLineageCounts = new Map();
  const historyFreshThumbs = new Set();
  let historyActiveModelId = null;

  function setHistoryActiveModelId(id) {
    historyActiveModelId = id;
  }

  function getHistoryActiveModelId() {
    return historyActiveModelId;
  }

  // ============================================================================
  // EXPOSE GLOBALLY via window.State
  // ============================================================================
  window.State = {
    // Constants
    HISTORY_LIMIT,
    MAX_DATA_URI_LEN,

    // Watchers
    watchers,

    // Active jobs
    getActiveJobs,
    setActiveJobs,
    addActiveJob,
    removeActiveJob,

    // Pending meta
    getPendingMeta,
    savePendingMeta,
    deletePendingMeta,

    // History
    sanitizeHistoryItem,
    loadHistoryFromDB,
    getHistory,
    saveHistory,
    addHistoryItem,
    updateHistoryItem,
    deleteHistoryItem,
    historyHasJobId,
    forceRestoreFromDB,
    clearLocalHistoryCache,

    // History UI state
    historyState,
    historyLineageCounts,
    historyFreshThumbs,
    get historyActiveModelId() { return historyActiveModelId; },
    setHistoryActiveModelId,
    getHistoryActiveModelId,
  };

  // Also expose individual functions for backward compatibility
  window.watchers = watchers;
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

})();
