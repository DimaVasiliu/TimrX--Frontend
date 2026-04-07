/**
 * config.js
 * Stores configuration, constants, and generic utility functions used by every other file.
 */

// ============================================================================
// API ENDPOINTS
// ============================================================================
const TIMRX_ENV = window.TIMRX_ENV || {};
export const FRONTEND_ENV = TIMRX_ENV.mode || 'production';
export const BLOG_API_BASE = TIMRX_ENV.blogApiBase || window.TIMRX_BLOGS_API_BASE || window.location.origin.replace(/\/$/, '');
export const BACKEND = TIMRX_ENV.threedApiBase || window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
export const CHAT_API = TIMRX_ENV.chatApiBase || window.TIMRX_API_BASE || 'https://chat.timrx.live';

const NATIVE_FETCH = window.fetch.bind(window);
const CSRF_COOKIE_NAME = 'timrx_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
let csrfBootstrapPromise = null;
let globalFetchPatched = false;

// Debug: log resolved environment at startup
console.log('[Config] env:', FRONTEND_ENV, 'blog:', BLOG_API_BASE, '3d:', BACKEND, 'chat:', CHAT_API);
console.log('[Config] Cross-origin 3D API?', new URL(BACKEND).hostname !== window.location.hostname);

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

function getCookieValue(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function isStateChangingMethod(method = 'GET') {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase());
}

function targets3dBackend(url) {
  try {
    const resolved = new URL(url, window.location.origin);
    const backendOrigin = new URL(BACKEND, window.location.origin).origin;
    return resolved.origin === backendOrigin && resolved.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export function getCsrfToken() {
  return getCookieValue(CSRF_COOKIE_NAME);
}

export async function ensureCsrfToken() {
  const existing = getCsrfToken();
  if (existing) return existing;
  if (csrfBootstrapPromise) return csrfBootstrapPromise;

  csrfBootstrapPromise = (async () => {
    try {
      const response = await NATIVE_FETCH(`${BACKEND}/api/me`, {
        method: 'GET',
        credentials: 'include',
        mode: 'cors',
        headers: { Accept: 'application/json' },
      });
      await response.text().catch(() => '');
    } catch (err) {
      console.warn('[CSRF] Bootstrap request failed:', err?.message || err);
    }
    return getCsrfToken();
  })().finally(() => {
    csrfBootstrapPromise = null;
  });

  return csrfBootstrapPromise;
}

async function withCsrfHeaders(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!isStateChangingMethod(method) || !targets3dBackend(url)) {
    return options;
  }

  const headers = new Headers(options.headers || {});
  if (!headers.has(CSRF_HEADER_NAME)) {
    const token = getCsrfToken() || await ensureCsrfToken();
    if (token) headers.set(CSRF_HEADER_NAME, token);
  }

  return {
    ...options,
    credentials: options.credentials || 'include',
    headers,
  };
}

export async function fetchWithCsrf(input, init = {}) {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const requestInit = input instanceof Request
    ? {
        method: input.method,
        headers: input.headers,
        credentials: input.credentials,
        mode: input.mode,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        integrity: input.integrity,
        keepalive: input.keepalive,
        signal: input.signal,
        ...init,
      }
    : init;

  const finalInit = await withCsrfHeaders(requestUrl, requestInit);
  if (input instanceof Request) {
    return NATIVE_FETCH(new Request(input, finalInit));
  }
  return NATIVE_FETCH(input, finalInit);
}

function installGlobalCsrfFetchPatch() {
  if (globalFetchPatched || typeof window.fetch !== 'function') return;
  window.fetch = function patchedFetch(input, init) {
    return fetchWithCsrf(input, init);
  };
  globalFetchPatched = true;
}

// ============================================================================
// API CLIENT - Centralized fetch with credentials for cross-origin cookies
// ============================================================================

/**
 * Default timeout for API requests (ms)
 */
const API_TIMEOUT_MS = 12000;

/**
 * Endpoint-specific timeouts (ms) - Render cold starts can take 10-30s
 * These are generous to handle worst-case cold start scenarios
 */
const ENDPOINT_TIMEOUTS = {
  '/api/me': 25000,                    // 25s - called frequently, can be slow on cold start
  '/api/auth/restore/redeem': 45000,   // 45s - critical auth flow, must not abort early (cold start + DB)
  '/api/auth/email/verify': 40000,     // 40s - verification can be slow (cold start + email check)
  '/api/auth/email/attach': 30000,     // 30s - email operations
  '/api/auth/restore/request': 30000,  // 30s - code request (email sending can be slow)
  '/api/billing/confirm': 25000,       // 25s - payment confirmation
  '/api/billing/checkout': 25000,      // 25s - checkout initiation
  // History endpoint - can be slow with many items (now paginated)
  '/api/_mod/history': 20000,          // 20s - history fetch
  '/api/history': 20000,               // 20s - legacy path
  // Print check - mesh analysis runs in subprocess, can take 15-20s for complex models
  '/api/_mod/print-check/': 30000,          // 30s - trimesh analysis in subprocess
  // Generation endpoints - long timeout while async refactor is in progress
  '/api/_mod/text-to-3d/start': 120000,     // 120s - generation can take time
  '/api/_mod/image-to-3d/start': 120000,    // 120s - generation can take time
  '/api/_mod/image/openai': 120000,         // 120s - image generation
  '/api/_mod/text-to-3d/refine': 120000,    // 120s - refinement
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
    headers: customHeaders,  // Extract headers separately so it's not in rest
    ...rest
  } = options;

  // Build headers - merge custom headers but ensure Content-Type is set for JSON body
  const headers = {
    'Accept': 'application/json',
    ...(customHeaders || {}),
  };

  // Add Content-Type for POST/PUT/PATCH with body
  if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    headers['Content-Type'] = 'application/json';
  }

  // Build fetch options - ALWAYS include credentials for cross-origin cookies
  // Note: headers is set AFTER ...rest to prevent any accidental override
  const fetchOptions = {
    method,
    credentials: 'include',
    mode: 'cors',
    ...rest,
    headers,  // Set headers last to ensure our built headers aren't overwritten
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
      const requestOptions = await withCsrfHeaders(fullUrl, fetchOptions);
      const response = await NATIVE_FETCH(fullUrl, {
        ...requestOptions,
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

      const result = {
        ok: response.ok,
        status: response.status,
        data,
        error: response.ok ? null : (
          (typeof data?.error === 'string' ? data.error : data?.error?.message)
          || data?.message
          || `HTTP ${response.status}`
        ),
      };

      // AUTH-5: detect 401 and trigger global auth-loss handler
      if (response.status === 401) {
        _handleAuthLost(fullUrl);
      }

      return result;
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
// AUTH-LOSS DETECTION (AUTH-5 hotfix)
// Global 401 handler — clears user caches, dispatches event, debounces spam
// ============================================================================

// ============================================================================
// AUTH-7: Identity trust gate
// ============================================================================

/**
 * Lightweight identity trust store — shared across modules via config.js
 * to avoid circular imports between workspace-credits.js and state.js.
 *
 * identityId is set ONLY after /api/me confirms the server identity.
 * Before that, it is null — any code that checks identity ownership
 * (e.g. history cache, wallet cache) should treat null as "unknown".
 */
const _identityTrust = { id: null };

/** Mark identity as server-confirmed. Called by fetchWallet() after /api/me. */
export function setConfirmedIdentity(id) {
  _identityTrust.id = id || null;
}

/** Get the server-confirmed identity, or null if not yet confirmed. */
export function getConfirmedIdentity() {
  return _identityTrust.id;
}

/** Reset identity trust (called on logout/auth-loss/cache clear). */
export function clearConfirmedIdentity() {
  _identityTrust.id = null;
}

/**
 * AUTH-8: Read identity_id from the auth stamp in localStorage.
 * The stamp survives cache clears and page navigations, so it provides
 * a fast synchronous identity hint before fetchWallet() completes.
 * Returns null if no stamp exists or if the stamp is unparseable.
 */
export function getStampedIdentityId() {
  try {
    const raw = localStorage.getItem(AUTH_STAMP_KEY);
    if (!raw) return null;
    const stamp = JSON.parse(raw);
    return (stamp && stamp.identity_id) || null;
  } catch { return null; }
}

/**
 * All localStorage keys that hold user-specific data.
 * Site-wide settings (timrx_pricing_mode, tx_seen_modal_v1) are NOT cleared.
 * NOTE: AUTH_STAMP_KEY is intentionally NOT in this list — it survives
 * clearAllUserCaches() so the next /api/me can compare against it.
 */
const USER_CACHE_KEYS = [
  'timrx_last_wallet',
  'timrx_credits_last',
  'timrx_video_credits_last',
  'meshy_history_cache',
  'meshy_history_owner',
  'activeJobs_v1',
  'pendingJobs_v1',
  'timrx_idempotency_keys',
];

// ============================================================================
// AUTH-6: Cross-subdomain auth freshness stamp
// ============================================================================

/**
 * Stores {identity_id, auth_at} — written after every successful /api/me.
 * On the next /api/me (possibly from a different subdomain), if the server's
 * identity_id or last_active_at differs from the stamp, all user caches are
 * stale and must be cleared.
 *
 * NOT included in USER_CACHE_KEYS because it must survive cache clears —
 * it's the reference point, not a cache.
 */
const AUTH_STAMP_KEY = 'timrx_auth_stamp';

/**
 * Compare server-confirmed identity state against the locally stored stamp.
 * Returns true if caches should be invalidated (identity changed, auth event
 * happened on another origin, or no stamp exists yet).
 *
 * Always updates the stamp to the latest server values.
 *
 * @param {string} serverIdentityId
 * @param {string|null} serverAuthAt - last_active_at from /api/me
 * @returns {boolean} true if caches were stale and should be cleared
 */
export function checkAuthFreshness(serverIdentityId, serverAuthAt) {
  if (!serverIdentityId) return false;

  try {
    const raw = localStorage.getItem(AUTH_STAMP_KEY);
    const stamp = raw ? JSON.parse(raw) : null;

    // Write/update stamp with latest server values
    const newStamp = {
      identity_id: serverIdentityId,
      auth_at: serverAuthAt || null,
      origin: location.origin,
      written_at: new Date().toISOString(),
    };
    localStorage.setItem(AUTH_STAMP_KEY, JSON.stringify(newStamp));

    // No previous stamp → first visit on this origin, nothing to invalidate
    if (!stamp) return false;

    // Identity changed → everything is stale
    if (stamp.identity_id && stamp.identity_id !== serverIdentityId) {
      log('[Auth] AUTH-6: Identity changed since last visit — was', stamp.identity_id?.slice(0, 8), 'now', serverIdentityId?.slice(0, 8));
      return true;
    }

    // Same identity but auth event happened elsewhere (last_active_at moved forward)
    if (serverAuthAt && stamp.auth_at && serverAuthAt !== stamp.auth_at) {
      log('[Auth] AUTH-6: Auth state changed — last_active_at was', stamp.auth_at, 'now', serverAuthAt);
      return true;
    }

    return false;
  } catch (err) {
    log('[Auth] AUTH-6: Stamp check error:', err.message);
    return false;
  }
}

/** Debounce timestamp — last time we fired timrx:auth-lost */
let _lastAuthLostAt = 0;
const AUTH_LOST_DEBOUNCE_MS = 5000;

/**
 * Clear all user-specific localStorage caches.
 * Does NOT clear site-wide settings.
 */
export function clearAllUserCaches() {
  for (const key of USER_CACHE_KEYS) {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }
  clearConfirmedIdentity();  // AUTH-7: reset identity trust
  log('[Auth] All user caches cleared');
}

/**
 * URLs excluded from auth-lost handling (restore flows intentionally use 401).
 */
const AUTH_LOST_EXCLUDE = [
  '/api/auth/restore/',
];

/**
 * Handle a 401 response centrally: clear caches once, dispatch event once.
 * Debounced so concurrent 401s from parallel requests only trigger once.
 */
function _handleAuthLost(url) {
  // Skip excluded endpoints (restore flows)
  if (AUTH_LOST_EXCLUDE.some(p => url.includes(p))) return;

  const now = Date.now();
  if (now - _lastAuthLostAt < AUTH_LOST_DEBOUNCE_MS) return;
  _lastAuthLostAt = now;

  console.warn(`[Auth] Session expired (401 from ${url}). Clearing user caches.`);
  clearAllUserCaches();
  window.dispatchEvent(new CustomEvent('timrx:auth-lost', {
    detail: { url, timestamp: now },
  }));
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
 * Poll for credits update after purchase.
 * Uses /api/credits/wallet (lightweight, authoritative for balances).
 *
 * @param {number} previousCredits - Credits before purchase
 * @param {number} maxWaitMs - Maximum wait time (default 10s)
 * @param {function} onUpdate - Callback with new credits when updated
 * @returns {Promise<{ credits: number, updated: boolean }>}
 */
export async function pollForCreditsUpdate(previousCredits, maxWaitMs = 10000, onUpdate = null) {
  const startTime = Date.now();
  const pollInterval = 1500;  // 1.5s — wallet cache has 5s TTL, so faster polling just hits cache
  let lastCredits = previousCredits;

  log('[WalletCache] Polling for credits update, previous:', previousCredits);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = await apiFetch('/api/credits/wallet', { timeout: 5000 });

      if (result.ok && result.data?.ok) {
        const d = result.data;
        const newCredits = d.available_credits ?? Math.max(0, (d.credits_balance || 0) - (d.reserved_credits || 0));
        const identityId = d.identity_id;

        if (newCredits > previousCredits) {
          log('[WalletCache] Credits updated:', previousCredits, '→', newCredits);
          if (identityId) writeWalletCache(identityId, newCredits);
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
// S3 URL HELPERS - Detect our S3 bucket URLs (no proxy needed for these)
// ============================================================================

/**
 * Our S3 bucket patterns - URLs from these don't need proxying
 * They're served directly with proper CORS headers
 */
const TIMRX_S3_PATTERNS = [
  'timrx-3d-models.s3.',        // Primary bucket pattern
  'timrx-3d-models.s3.eu-west-2.amazonaws.com',
  'timrx-3d-models.s3.amazonaws.com',
];

/**
 * Check if a URL is from our S3 bucket (doesn't need proxying)
 * @param {string} url - URL to check
 * @returns {boolean} - True if URL is from our S3 bucket
 */
export function isTimrxS3Url(url) {
  if (!url || typeof url !== 'string') return false;
  return TIMRX_S3_PATTERNS.some(pattern => url.includes(pattern));
}

/**
 * Check if a URL needs to be proxied (external URLs like Meshy)
 * Returns false for our S3 URLs (load directly), true for others
 * @param {string} url - URL to check
 * @returns {boolean} - True if URL should be proxied
 */
export function shouldProxyUrl(url) {
  if (!url || typeof url !== 'string') return false;

  // Our S3 URLs don't need proxying - load directly
  if (isTimrxS3Url(url)) return false;

  // Meshy asset URLs need proxying (CORS blocked)
  if (url.includes('assets.meshy.ai')) return true;

  // Other external URLs may need proxying
  if (url.includes('meshy.ai')) return true;

  // Default: don't proxy (assume CORS is OK or it's a data URL)
  return false;
}

/**
 * Get the best URL for loading a model:
 * - S3 URLs: return directly (no proxy needed)
 * - Meshy URLs: wrap in proxy
 * - Other: return directly
 *
 * @param {string} url - Original URL
 * @returns {string} - URL to use for loading
 */
export function getLoadableModelUrl(url) {
  if (!url) return '';

  // S3 URLs load directly - CORS is configured
  if (isTimrxS3Url(url)) {
    return url;
  }

  // Meshy URLs need proxying
  if (shouldProxyUrl(url)) {
    return `${BACKEND}/api/_mod/proxy-glb?u=${encodeURIComponent(url)}`;
  }

  // Everything else (data URLs, other sources): return as-is
  return url;
}

// ============================================================================
// GLOBAL EXPOSURE - Allow non-module scripts (like credits.js) to use API helpers
// ============================================================================
installGlobalCsrfFetchPatch();

window.TimrXApi = {
  BACKEND,
  apiFetch,
  apiGet,
  apiPost,
  ensureCsrfToken,
  fetchWithCsrf,
  getCsrfToken,
  updateSessionInfo,
  readWalletCache,
  writeWalletCache,
  clearWalletCache,
  clearAllUserCaches,
  pollForCreditsUpdate,
  // S3 helpers
  isTimrxS3Url,
  shouldProxyUrl,
  getLoadableModelUrl,
};
