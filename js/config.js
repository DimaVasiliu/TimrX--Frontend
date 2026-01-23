/**
 * config.js
 * Stores configuration, constants, and generic utility functions used by every other file.
 */

// ============================================================================
// API ENDPOINTS
// ============================================================================
// Always use the custom domain for proper cookie handling
export const BACKEND = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
export const CHAT_API = window.TIMRX_API_BASE || 'https://timrx-chat-1.onrender.com';

// Debug: log API base and hostname at startup
console.log('[Config] BACKEND:', BACKEND, 'hostname:', window.location.hostname);
console.log('[Config] Cross-origin API?', new URL(BACKEND).hostname !== window.location.hostname);

// ============================================================================
// STORAGE KEYS
// ============================================================================
export const ACTIVE_JOBS_STORAGE_KEY = 'activeJobs_v1';
export const PENDING_JOBS_STORAGE_KEY = 'pendingJobs_v1';

// ============================================================================
// UI CONSTANTS
// ============================================================================
export const HISTORY_MENU_EDGE_PAD = 12;
export const HISTORY_SUBMENU_GAP = 10;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Console logging with prefix
 */
export const log = (...args) => console.log('[TimrX]', ...args);

/**
 * Shorthand for getElementById
 */
export const byId = (id) => document.getElementById(id);

/**
 * Safely execute a function only if element exists
 */
export function safe(el, fn) {
  if (el) fn();
}

// ============================================================================
// API CLIENT - Centralized fetch with credentials for cross-origin cookies
// ============================================================================

/**
 * Default timeout for API requests (ms)
 */
const API_TIMEOUT_MS = 12000;

/**
 * Endpoint-specific timeouts (ms) - Render cold starts can take 5-10s
 */
const ENDPOINT_TIMEOUTS = {
  '/api/me': 20000,                    // 20s - called frequently, can be slow on cold start
  '/api/auth/restore/redeem': 30000,   // 30s - critical auth flow, must not abort early
  '/api/auth/email/verify': 25000,     // 25s - verification can be slow
  '/api/auth/email/attach': 20000,     // 20s - email operations
  '/api/auth/restore/request': 20000,  // 20s - code request
  '/api/billing/confirm': 20000,       // 20s - payment confirmation
  '/api/billing/checkout': 20000,      // 20s - checkout initiation
};

/**
 * Fallback timeout for slow endpoints not in ENDPOINT_TIMEOUTS
 */
const SLOW_ENDPOINT_TIMEOUT_MS = 20000;

/**
 * Pattern-based slow endpoints (if not in ENDPOINT_TIMEOUTS)
 */
const SLOW_ENDPOINT_PATTERNS = ['/api/auth/', '/api/billing/', '/api/me'];

/**
 * Get timeout for a specific endpoint
 */
function getEndpointTimeout(url) {
  // Check exact matches first
  for (const [endpoint, timeout] of Object.entries(ENDPOINT_TIMEOUTS)) {
    if (url.includes(endpoint)) {
      return timeout;
    }
  }
  // Check pattern matches
  for (const pattern of SLOW_ENDPOINT_PATTERNS) {
    if (url.includes(pattern)) {
      return SLOW_ENDPOINT_TIMEOUT_MS;
    }
  }
  return API_TIMEOUT_MS;
}

/**
 * Endpoints that should retry with backoff on timeout (GET only)
 */
const RETRY_ENDPOINTS = ['/api/me', '/api/credits/wallet'];

/**
 * Retry delays in ms for progressive backoff
 */
const RETRY_DELAYS = [0, 1000, 3000];

/**
 * Check if response is HTML (wrong routing/redirect)
 * Handles whitespace, case variations, and various HTML patterns
 */
function isHtmlResponse(text, contentType) {
  if (contentType && contentType.toLowerCase().includes('text/html')) return true;
  if (!text) return false;

  // Trim and check for common HTML patterns (case-insensitive)
  const trimmed = text.trim().toLowerCase();
  if (trimmed.startsWith('<!doctype')) return true;
  if (trimmed.startsWith('<html')) return true;
  if (trimmed.startsWith('<head')) return true;
  if (trimmed.startsWith('<body')) return true;
  // Check if first non-whitespace char is '<' and doesn't look like valid JSON
  if (trimmed.startsWith('<') && !trimmed.startsWith('<[')) return true;

  return false;
}

/**
 * Update global session info for debugging (accessible via window.__TIMRX_SESSION__)
 */
export function updateSessionInfo(data, page = 'unknown') {
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
 *
 * Features:
 * - Always sets credentials: "include" for cross-origin cookies
 * - Always sets mode: "cors"
 * - Detects HTML responses (wrong routing) and logs clear error
 * - Auto-retry once for GET requests to /api/me and /api/credits/wallet
 * - Timeout support with AbortController
 *
 * @param {string} url - Full URL or path (if path, BACKEND is prepended)
 * @param {object} options - Fetch options (method, body, timeout, etc.)
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
export async function apiFetch(url, options = {}) {
  // Prepend BACKEND if url is a relative path
  const fullUrl = url.startsWith('http') ? url : `${BACKEND}${url}`;

  // Get endpoint-specific timeout (handles cold start delays on Render)
  const endpointTimeout = getEndpointTimeout(fullUrl);

  const {
    method = 'GET',
    body,
    timeout = endpointTimeout,
    retry = true,
    maxRetries = 3,
    ...rest
  } = options;

  // Build headers
  const headers = {
    'Accept': 'application/json',
    ...(rest.headers || {}),
  };

  // Add Content-Type for POST/PUT/PATCH with body
  if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    headers['Content-Type'] = 'application/json';
  }

  // Build fetch options - ALWAYS include credentials for cross-origin cookies
  const fetchOptions = {
    method,
    credentials: 'include',
    mode: 'cors',
    headers,
    ...rest,
  };

  // Add body if present
  if (body) {
    fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // Helper to perform single fetch with timeout
  const doFetch = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(fullUrl, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Get response text first to check for HTML
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';

      // Check for HTML response (wrong routing/redirect)
      if (isHtmlResponse(text, contentType)) {
        console.error(`[API] HTML response from ${fullUrl} - possible wrong routing or redirect`);
        return {
          ok: false,
          status: response.status,
          error: `Unexpected HTML response from ${fullUrl}`,
          isHtml: true,
        };
      }

      // Parse JSON
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        console.error(`[API] Invalid JSON from ${fullUrl}:`);
        console.error(`[API]   Status: ${response.status}`);
        console.error(`[API]   Content-Type: ${contentType}`);
        console.error(`[API]   Response preview: ${text.slice(0, 300)}`);
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

  // Determine if this endpoint supports retry
  const canRetry = retry && method.toUpperCase() === 'GET' && RETRY_ENDPOINTS.some(ep => fullUrl.includes(ep));

  // First attempt
  let result = await doFetch();
  let attemptCount = 1;

  // Retry logic with progressive backoff for specific GET endpoints on timeout
  while (
    result.isTimeout &&
    canRetry &&
    attemptCount < Math.min(maxRetries, RETRY_DELAYS.length)
  ) {
    const delay = RETRY_DELAYS[attemptCount] || 1000;
    console.log(`[API] Retry ${attemptCount}/${maxRetries - 1} for ${fullUrl} after ${delay}ms...`);

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    result = await doFetch();
    attemptCount++;

    // If this attempt succeeded, clear the timeout flag so callers know it worked
    if (result.ok) {
      result.retriedSuccessfully = true;
      console.log(`[API] Retry succeeded for ${fullUrl}`);
    }
  }

  return result;
}

/**
 * Convenience: GET JSON from API
 */
export async function apiGet(url, options = {}) {
  return apiFetch(url, { ...options, method: 'GET' });
}

/**
 * Convenience: POST JSON to API
 */
export async function apiPost(url, data, options = {}) {
  return apiFetch(url, { ...options, method: 'POST', body: data });
}

/**
 * Convert a File object to a data URL
 */
export function fileToDataURL(file) {
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
export function normalizeEpochMs(input) {
  if (input == null) return Date.now();

  // If it's a numeric-looking string, make it a number
  if (typeof input === 'string' && /^\d+$/.test(input)) input = Number(input);

  // ISO date string?
  if (typeof input === 'string') {
    const t = Date.parse(input);
    return Number.isNaN(t) ? Date.now() : t;
  }

  // Number -> decide seconds vs milliseconds
  if (typeof input === 'number') {
    if (input > 1e15) {
      return Math.floor(input / 1000);
    }
    if (input < 1e12) {
      // looks like seconds
      return input * 1000;
    }
    return input; // already ms
  }

  return Date.now();
}

/**
 * Create a unique batch group ID
 */
export function createBatchGroupId(prefix = 'batch') {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) {
    /* noop */
  }
  const rand = Math.floor(Math.random() * 1e6);
  return `${prefix}-${Date.now()}-${rand}`;
}

/**
 * Format a timestamp as DD/MM/YYYY
 */
export function dateLabel(ts) {
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
 * Wait for Three.js to be ready before executing callback
 */
export function onThreeReady(cb) {
  if (window.THREE && THREE.GLTFLoader && THREE.OrbitControls) {
    cb();
  } else {
    window.addEventListener('three-ready', () => cb(), { once: true });
  }
}

// ============================================================================
// CROSS-PAGE WALLET CACHE
// Used for instant credits display when navigating hub → workspace after purchase
// ============================================================================

const WALLET_CACHE_KEY = 'timrx_last_wallet';
const WALLET_CACHE_MAX_AGE_MS = 60000; // 1 minute max age for cache

/**
 * Read cached wallet from localStorage
 * Returns null if cache is missing, expired, or invalid
 * @returns {{ identity_id: string, available_credits: number, fetchedAt: string } | null}
 */
export function readWalletCache() {
  try {
    const cached = localStorage.getItem(WALLET_CACHE_KEY);
    if (!cached) return null;

    const data = JSON.parse(cached);
    if (!data || typeof data.available_credits !== 'number') return null;

    // Check if cache is expired
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
 * @param {string} identity_id - The identity ID
 * @param {number} available_credits - Current available credits
 */
export function writeWalletCache(identity_id, available_credits) {
  try {
    if (!identity_id || typeof available_credits !== 'number') return;

    const data = {
      identity_id,
      available_credits,
      fetchedAt: new Date().toISOString(),
    };
    localStorage.setItem(WALLET_CACHE_KEY, JSON.stringify(data));
    log('[WalletCache] Written:', available_credits, 'credits for', identity_id.slice(0, 8) + '...');
  } catch (err) {
    log('[WalletCache] Write error:', err.message);
  }
}

/**
 * Clear wallet cache (use when identity changes or on logout)
 */
export function clearWalletCache() {
  try {
    localStorage.removeItem(WALLET_CACHE_KEY);
    log('[WalletCache] Cleared');
  } catch (_) {
    /* ignore */
  }
}

/**
 * Poll for credits update after purchase
 * Polls /api/me every 500ms until credits increase or timeout
 *
 * @param {number} previousCredits - Credits before purchase
 * @param {number} maxWaitMs - Maximum wait time (default 10s)
 * @param {function} onUpdate - Callback with new credits when updated
 * @returns {Promise<{ credits: number, updated: boolean }>}
 */
export async function pollForCreditsUpdate(previousCredits, maxWaitMs = 10000, onUpdate = null) {
  const startTime = Date.now();
  const pollInterval = 500;
  let lastCredits = previousCredits;

  log('[WalletCache] Polling for credits update, previous:', previousCredits);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = await apiFetch('/api/me', { timeout: 3000 });

      if (result.ok && result.data?.ok) {
        const newCredits = result.data.available_credits ?? result.data.balance_credits ?? 0;
        const identityId = result.data.identity_id;

        // Credits increased - purchase confirmed!
        if (newCredits > previousCredits) {
          log('[WalletCache] Credits updated:', previousCredits, '→', newCredits);

          // Update cache immediately
          writeWalletCache(identityId, newCredits);

          // Update global session info
          updateSessionInfo(result.data, 'hub');

          // Callback with new credits
          if (onUpdate) onUpdate(newCredits, identityId);

          return { credits: newCredits, updated: true, identity_id: identityId };
        }

        lastCredits = newCredits;
      }
    } catch (err) {
      log('[WalletCache] Poll error:', err.message);
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, pollInterval));
  }

  log('[WalletCache] Poll timeout, credits still:', lastCredits);
  return { credits: lastCredits, updated: false };
}

// ============================================================================
// GLOBAL EXPOSURE - Allow non-module scripts (like credits.js) to use API helpers
// ============================================================================
window.TimrXApi = {
  BACKEND,
  apiFetch,
  apiGet,
  apiPost,
  updateSessionInfo,
  readWalletCache,
  writeWalletCache,
  clearWalletCache,
  pollForCreditsUpdate,
};
