/**
 * config.js
 * Stores configuration, constants, and generic utility functions used by every other file.
 * ALL exports are attached to window.TimrX for non-module script usage.
 */

(function() {
  'use strict';

  // ============================================================================
  // API ENDPOINTS
  // ============================================================================
  // Always use the custom domain for proper cookie handling
  const BACKEND = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  const CHAT_API = window.TIMRX_API_BASE || 'https://timrx-chat-1.onrender.com';

  // Debug: log API base and hostname at startup
  console.log('[Config] BACKEND:', BACKEND, 'hostname:', window.location.hostname);
  console.log('[Config] Cross-origin API?', new URL(BACKEND).hostname !== window.location.hostname);

  // ============================================================================
  // STORAGE KEYS
  // ============================================================================
  const ACTIVE_JOBS_STORAGE_KEY = 'activeJobs_v1';
  const PENDING_JOBS_STORAGE_KEY = 'pendingJobs_v1';

  // ============================================================================
  // UI CONSTANTS
  // ============================================================================
  const HISTORY_MENU_EDGE_PAD = 12;
  const HISTORY_SUBMENU_GAP = 10;

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  /**
   * Console logging with prefix
   */
  const log = (...args) => console.log('[TimrX]', ...args);

  /**
   * Shorthand for getElementById
   */
  const byId = (id) => document.getElementById(id);

  /**
   * Safely execute a function only if element exists
   */
  function safe(el, fn) {
    if (el) fn();
  }

  // ============================================================================
  // API CLIENT - Centralized fetch with credentials for cross-origin cookies
  // ============================================================================

  /**
   * Default timeout for API requests (ms)
   */
  const API_TIMEOUT_MS = 10000;

  /**
   * Endpoints that should retry once on timeout
   */
  const RETRY_ENDPOINTS = ['/api/me', '/api/credits/wallet'];

  /**
   * Check if response is HTML (wrong routing/redirect)
   */
  function isHtmlResponse(text, contentType) {
    if (contentType && contentType.toLowerCase().includes('text/html')) return true;
    if (!text) return false;

    const trimmed = text.trim().toLowerCase();
    if (trimmed.startsWith('<!doctype')) return true;
    if (trimmed.startsWith('<html')) return true;
    if (trimmed.startsWith('<head')) return true;
    if (trimmed.startsWith('<body')) return true;
    if (trimmed.startsWith('<') && !trimmed.startsWith('<[')) return true;

    return false;
  }

  /**
   * Update global session info for debugging
   */
  function updateSessionInfo(data, page = 'unknown') {
    if (data && data.ok) {
      window.__TIMRX_SESSION__ = {
        identity_id: data.identity_id,
        credits: data.available_credits ?? data.balance_credits ?? 0,
        apiBase: BACKEND,
        page,
        fetchedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Centralized API fetch with credentials for cross-origin cookie support.
   */
  async function apiFetch(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${BACKEND}${url}`;

    const {
      method = 'GET',
      body,
      timeout = API_TIMEOUT_MS,
      retry = true,
      ...rest
    } = options;

    const headers = {
      'Accept': 'application/json',
      ...(rest.headers || {}),
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOptions = {
      method,
      credentials: 'include',
      mode: 'cors',
      headers,
      ...rest,
    };

    if (body) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const doFetch = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(fullUrl, {
          ...fetchOptions,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const text = await response.text();
        const contentType = response.headers.get('content-type') || '';

        if (isHtmlResponse(text, contentType)) {
          console.error(`[API] HTML response from ${fullUrl} - possible wrong routing or redirect`);
          return {
            ok: false,
            status: response.status,
            error: `Unexpected HTML response from ${fullUrl}`,
            isHtml: true,
          };
        }

        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          console.error(`[API] Invalid JSON from ${fullUrl}:`, text.slice(0, 300));
          return {
            ok: false,
            status: response.status,
            error: `Invalid JSON response from ${fullUrl} (${e.message})`,
          };
        }

        return {
          ok: response.ok,
          status: response.status,
          data,
          error: response.ok ? null : (data?.error?.message || data?.message || `HTTP ${response.status}`),
        };
      } catch (err) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          return { ok: false, status: 0, error: 'Request timeout', isTimeout: true };
        }

        console.error(`[API] Fetch error for ${fullUrl}:`, err.message);
        return { ok: false, status: 0, error: err.message };
      }
    };

    let result = await doFetch();

    if (
      result.isTimeout &&
      retry &&
      method.toUpperCase() === 'GET' &&
      RETRY_ENDPOINTS.some(ep => fullUrl.includes(ep))
    ) {
      console.log(`[API] Retrying ${fullUrl} after timeout...`);
      await new Promise(r => setTimeout(r, 500));
      result = await doFetch();
    }

    return result;
  }

  /**
   * GET JSON from API
   */
  async function getJSON(url, options = {}) {
    return apiFetch(url, { ...options, method: 'GET' });
  }

  /**
   * POST JSON to API
   */
  async function postJSON(url, data, options = {}) {
    return apiFetch(url, { ...options, method: 'POST', body: data });
  }

  /**
   * Convert a File object to a data URL
   */
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Normalize any timestamp-ish value to epoch milliseconds
   */
  function normalizeEpochMs(input) {
    if (input == null) return Date.now();

    if (typeof input === 'string' && /^\d+$/.test(input)) input = Number(input);

    if (typeof input === 'string') {
      const t = Date.parse(input);
      return Number.isNaN(t) ? Date.now() : t;
    }

    if (typeof input === 'number') {
      if (input > 1e15) return Math.floor(input / 1000);
      if (input < 1e12) return input * 1000;
      return input;
    }

    return Date.now();
  }

  /**
   * Create a unique batch group ID
   */
  function createBatchGroupId(prefix = 'batch') {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (_) {}
    const rand = Math.floor(Math.random() * 1e6);
    return `${prefix}-${Date.now()}-${rand}`;
  }

  /**
   * Format a timestamp as DD/MM/YYYY
   */
  function dateLabel(ts) {
    try {
      const ms = normalizeEpochMs(ts);
      const d = new Date(ms);

      const y = d.getFullYear();
      if (y < 2000 || y > 2099) {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        return `${dd}/${mm}/${yyyy}`;
      }

      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${dd}/${mm}/${y}`;
    } catch {
      return '';
    }
  }

  /**
   * Wait for Three.js to be ready
   */
  function onThreeReady(cb) {
    if (window.THREE && THREE.GLTFLoader && THREE.OrbitControls) {
      cb();
    } else {
      window.addEventListener('three-ready', () => cb(), { once: true });
    }
  }

  // ============================================================================
  // WALLET CACHE - For instant credits display across pages
  // ============================================================================

  const WALLET_CACHE_KEY = 'timrx_wallet';
  const WALLET_CACHE_MAX_AGE_MS = 60000; // 1 minute max age

  /**
   * Read cached wallet from localStorage
   */
  function readWalletCache() {
    try {
      const cached = localStorage.getItem(WALLET_CACHE_KEY);
      if (!cached) return null;

      const data = JSON.parse(cached);
      if (!data || typeof data.available !== 'number') return null;

      const fetchedAt = new Date(data.fetchedAt).getTime();
      if (Date.now() - fetchedAt > WALLET_CACHE_MAX_AGE_MS) {
        log('[WalletCache] Cache expired, discarding');
        localStorage.removeItem(WALLET_CACHE_KEY);
        return null;
      }

      return data;
    } catch (err) {
      log('[WalletCache] Read error:', err.message);
      return null;
    }
  }

  /**
   * Write wallet data to localStorage cache
   */
  function writeWalletCache(identity_id, balance, available, reserved = 0) {
    try {
      if (!identity_id || typeof available !== 'number') return;

      const data = {
        identity_id,
        balance: balance ?? available,
        available,
        reserved: reserved ?? 0,
        fetchedAt: new Date().toISOString(),
      };
      localStorage.setItem(WALLET_CACHE_KEY, JSON.stringify(data));
      log('[WalletCache] Written:', available, 'credits for', identity_id.slice(0, 8) + '...');
    } catch (err) {
      log('[WalletCache] Write error:', err.message);
    }
  }

  /**
   * Clear wallet cache
   */
  function clearWalletCache() {
    try {
      localStorage.removeItem(WALLET_CACHE_KEY);
      log('[WalletCache] Cleared');
    } catch (_) {}
  }

  /**
   * Poll for credits update after purchase
   */
  async function pollForCreditsUpdate(previousCredits, maxWaitMs = 10000, onUpdate = null) {
    const startTime = Date.now();
    const pollInterval = 500;
    let lastCredits = previousCredits;

    log('[WalletCache] Polling for credits update, previous:', previousCredits);

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const result = await apiFetch('/api/me', { timeout: 3000 });

        if (result.ok && result.data?.ok) {
          const newCredits = result.data.available_credits ?? result.data.balance_credits ?? 0;
          const balance = result.data.balance_credits ?? newCredits;
          const reserved = result.data.reserved_credits ?? 0;
          const identityId = result.data.identity_id;

          if (newCredits > previousCredits) {
            log('[WalletCache] Credits updated:', previousCredits, '→', newCredits);

            writeWalletCache(identityId, balance, newCredits, reserved);
            updateSessionInfo(result.data, 'hub');

            if (onUpdate) onUpdate(newCredits, identityId);

            return { credits: newCredits, updated: true, identity_id: identityId };
          }

          lastCredits = newCredits;
        }
      } catch (err) {
        log('[WalletCache] Poll error:', err.message);
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    log('[WalletCache] Poll timeout, credits still:', lastCredits);
    return { credits: lastCredits, updated: false };
  }

  // ============================================================================
  // GLOBAL EXPOSURE - Attach everything to window.TimrX
  // ============================================================================
  window.TimrX = {
    // Constants
    BACKEND,
    CHAT_API,
    ACTIVE_JOBS_STORAGE_KEY,
    PENDING_JOBS_STORAGE_KEY,
    HISTORY_MENU_EDGE_PAD,
    HISTORY_SUBMENU_GAP,

    // Utility functions
    log,
    byId,
    safe,

    // API functions
    apiFetch,
    getJSON,
    postJSON,

    // Data helpers
    fileToDataURL,
    normalizeEpochMs,
    createBatchGroupId,
    dateLabel,
    onThreeReady,

    // Session/debug
    updateSessionInfo,

    // Wallet cache
    WALLET_CACHE_KEY,
    readWalletCache,
    writeWalletCache,
    clearWalletCache,
    pollForCreditsUpdate,
  };

  // Also expose as window.TimrXApi for backwards compatibility
  window.TimrXApi = window.TimrX;

  // Shortcut for API base
  window.API_BASE = BACKEND;

})();
