/**
 * workspace-credits.js
 * Manages credits/wallet state for the 3dprint.html workspace.
 * Fetches wallet balance and action costs on load, provides helpers for credit checks.
 */

import { BACKEND, log, apiFetch, updateSessionInfo, readWalletCache, writeWalletCache, clearAllUserCaches, setConfirmedIdentity, checkAuthFreshness } from './config.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const CREDITS_CACHE_KEY = 'timrx_credits_last';
const VIDEO_CREDITS_CACHE_KEY = 'timrx_video_credits_last';

// ============================================================================
// SINGLE-FLIGHT GUARD
// ============================================================================

// Track in-flight fetch promises to prevent duplicate requests
let walletFetchInFlight = null;
let refreshInFlight = null;
let pendingRetry = false; // Flag for window.focus retry
let lastRefreshTime = Date.now(); // Initialise to "now" so the first focus/visibility event doesn't race with initCredits()
const MIN_REFRESH_INTERVAL_MS = 60000; // Don't refresh more than once per 60s (reduces DB pressure)

// ============================================================================
// STATE
// ============================================================================

const creditsState = {
  wallet: {
    balance: 0,
    reserved: 0,
    available: 0,
    // Video credits (separate pool)
    videoBalance: 0,
    videoReserved: 0,
    videoAvailable: 0,
  },
  identityId: null,
  identityConfirmed: false,  // AUTH-7: true only after /api/me confirms identity
  email: null,  // User's email (null if not attached)
  emailVerified: false,
  actionCosts: {},
  loaded: false,
  loading: false,
  serverConfirmed: false,  // True only after server balance response received
  error: null,
  // Optimistic updates tracking
  pendingDeductions: [],  // Array of { id, amount, action, timestamp }
  lastServerBalance: null,
  // Reservation tracking (credits held during generation)
  reservations: new Map(),  // Map<jobId, { amount, action, timestamp }>
  totalReserved: 0,  // Sum of all active reservations
};

// Idempotency: track job IDs that have already been charged
// Prevents duplicate deductions from double-clicks or retries
const chargedJobs = new Set();

// ============================================================================
// EARLY RENDER (for perceived performance)
// ============================================================================

/**
 * Check if we should force a fresh fetch (e.g., after purchase redirect).
 * URL params: ?refresh=1 or referrer from hub after purchase
 */
function shouldForceRefresh() {
  const params = new URLSearchParams(window.location.search);
  // Force refresh if ?refresh=1 is in URL (set by hub after purchase)
  if (params.get('refresh') === '1') {
    // Clear the param from URL to avoid repeated refreshes on reload
    const url = new URL(window.location.href);
    url.searchParams.delete('refresh');
    window.history.replaceState({}, '', url.toString());
    log('[Credits] Force refresh requested via URL param');
    return true;
  }
  // AUTH-6: Force refresh if arriving from a different timrx subdomain.
  // Caches are origin-scoped, so cross-subdomain navigation means local
  // caches may be stale (identity change, balance change on other origin).
  if (document.referrer) {
    try {
      const refHost = new URL(document.referrer).hostname;
      const curHost = location.hostname;
      if (refHost !== curHost && refHost.endsWith('timrx.live') && curHost.endsWith('timrx.live')) {
        log('[Credits] Force refresh: cross-subdomain navigation from', refHost);
        return true;
      }
    } catch (_) { /* malformed referrer, ignore */ }
  }
  return false;
}

// Track if force refresh was requested (checked at module load time)
const FORCE_REFRESH = shouldForceRefresh();

/**
 * Render cached credits immediately on page load (before async fetch).
 * This provides instant visual feedback using the last known balance.
 * Call this as early as possible - even before DOM ready if elements exist.
 */
function renderCachedCreditsEarly() {
  const creditsPill = document.getElementById('workspaceCredits');
  const creditsValue = document.getElementById('workspaceCreditsValue');
  const creditsGroup = document.getElementById('workspaceCreditsGroup');

  // If UI elements don't exist yet, try again after DOM ready
  if (!creditsValue) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderCachedCreditsEarly, { once: true });
    }
    return;
  }

  // Skip cache if force refresh was requested (show syncing immediately)
  if (FORCE_REFRESH) {
    log('[Credits] Skipping cache render due to force refresh');
    creditsValue.textContent = '—';
    if (creditsGroup) creditsGroup.classList.add('syncing');
    if (creditsPill) {
      creditsPill.classList.add('syncing');
      creditsPill.setAttribute('title', 'Syncing credits...');
    }
    return;
  }

  // AUTH-7: Only show cached credits early if we can trust the cache owner.
  // The cross-page wallet cache includes identity_id (written by a confirmed
  // /api/me call). We trust it for display ONLY — we do NOT pre-populate
  // creditsState.identityId until /api/me confirms (prevents history cache
  // from matching against an unverified identity).
  const walletCache = readWalletCache();
  let displayValue = '—';
  let cacheSource = null;

  if (walletCache && typeof walletCache.available_credits === 'number' && walletCache.identity_id) {
    displayValue = walletCache.available_credits.toLocaleString();
    // Display only — do NOT pre-populate creditsState.wallet.available from cache.
    // Affordability checks must wait for server confirmation to prevent users
    // acting on stale balance (e.g., clicking Generate with 0 real credits).
    cacheSource = 'cross-page';
    log('[Credits] Early render from cross-page cache:', walletCache.available_credits,
        '(owner:', walletCache.identity_id.slice(0, 8) + '..., display only, not authoritative)');
  }
  // NOTE: local credits cache (CREDITS_CACHE_KEY) has NO identity_id tag,
  // so it is not trustworthy for early render. We skip it — /api/me will
  // populate the real balance shortly.

  if (!cacheSource) {
    log('[Credits] No trusted cache, showing syncing placeholder');
  }

  // Render immediately
  creditsValue.textContent = displayValue;

  // Add syncing indicator
  if (creditsGroup) {
    creditsGroup.classList.add('syncing');
  }
  if (creditsPill) {
    creditsPill.classList.add('syncing');
    creditsPill.setAttribute('title', 'Syncing credits...');
  }
}

/**
 * Save credits balance to localStorage for next page load
 */
function cacheCreditsBalance(balance, videoBalance) {
  try {
    if (typeof balance === 'number' && Number.isFinite(balance) && balance >= 0) {
      localStorage.setItem(CREDITS_CACHE_KEY, balance.toString());
      log('[Credits] Cached balance to localStorage:', balance);
    }
    if (typeof videoBalance === 'number' && Number.isFinite(videoBalance) && videoBalance >= 0) {
      localStorage.setItem(VIDEO_CREDITS_CACHE_KEY, videoBalance.toString());
    }
  } catch (_) { /* Safari: localStorage may be blocked */ }
}

// ============================================================================
// API FETCHING
// ============================================================================

/**
 * Fetch wallet balance from /api/me
 * Single-flight: returns existing promise if already in flight
 * Response format:
 * {
 *   ok: true,
 *   identity_id: "uuid",
 *   balance_credits: 100,
 *   reserved_credits: 0,
 *   available_credits: 100,
 *   ...
 * }
 */
export async function fetchWallet() {
  // Single-flight guard: return existing promise if already fetching
  if (walletFetchInFlight) {
    log('[Credits] fetchWallet already in flight, returning existing promise');
    return walletFetchInFlight;
  }

  const url = `${BACKEND}/api/me`;
  log('[Credits] Fetching wallet from:', url);

  // Create the fetch promise with single-flight tracking
  walletFetchInFlight = (async () => {
    try {
      const result = await apiFetch('/api/me', {
        cache: 'no-store',
        keepalive: true,
      });

      if (!result.ok) {
        // Not authenticated or error - log details
        log('[Credits] Wallet fetch failed:', result.status, result.error);
        creditsState.wallet = { balance: 0, reserved: 0, available: 0, videoBalance: 0, videoReserved: 0, videoAvailable: 0 };
        pendingRetry = true; // Schedule retry on window.focus
        return creditsState.wallet;
      }

      const data = result.data;
      log('[Credits] /api/me response:', {
        ok: data.ok,
        identity_id: data.identity_id,
        balance_credits: data.balance_credits,
        reserved_credits: data.reserved_credits,
        available_credits: data.available_credits,
      });

      if (data.ok) {
        const serverIdentityId = data.identity_id || null;

        // AUTH-6: Cross-subdomain freshness check.
        // Compare server state against locally stored auth stamp.
        // If identity changed OR an auth event happened on another origin,
        // clear ALL user caches (not just wallet) so history/jobs/etc.
        // don't show data for the wrong identity.
        const authStale = checkAuthFreshness(serverIdentityId, data.last_active_at || null);
        if (authStale) {
          log('[Credits] AUTH-6: Auth state stale — clearing all user caches');
          clearAllUserCaches();
        } else {
          // Even without a stamp change, check cross-page wallet cache identity
          const walletCache = readWalletCache();
          if (walletCache && walletCache.identity_id && serverIdentityId && walletCache.identity_id !== serverIdentityId) {
            log('[Credits] Identity mismatch — clearing all user caches');
            log('[Credits]   Cached:', walletCache.identity_id?.slice(0, 8) + '...');
            log('[Credits]   Server:', serverIdentityId?.slice(0, 8) + '...');
            clearAllUserCaches();
          }
        }

        // /api/me returns 0 for all wallet fields (wallet data moved to
        // /api/credits/wallet). Only set identity state here — wallet
        // state is populated by _fetchRealWalletBalances() below.
        // Keep existing wallet values intact to avoid 0-flicker.
        creditsState.identityId = serverIdentityId;
        creditsState.identityConfirmed = true;  // AUTH-7: identity now server-confirmed
        setConfirmedIdentity(serverIdentityId);  // AUTH-7: shared trust store
        creditsState.email = data.email || null;
        creditsState.emailVerified = data.email_verified || false;

        // Signal analytics.js (and any other listener) that the identity is now
        // server-confirmed. analytics.js uses this to poll the pending-conversion
        // queue — kept here so the trigger lands exactly once per /api/me success.
        try {
          window.dispatchEvent(new CustomEvent('timrx:identity:confirmed', {
            detail: { identity_id: serverIdentityId },
          }));
        } catch (_) { /* old browsers — no-op */ }

        // Server's available already accounts for backend reservations.
        // Clear client-side reservations to avoid double-counting.
        creditsState.reservations.clear();
        creditsState.totalReserved = 0;

        // Update email beacon visibility
        updateEmailBeaconUI();

        pendingRetry = false;
        lastRefreshTime = Date.now();

        log('[Credits] Identity loaded from /api/me (wallet via /api/credits/wallet)');

        // Update global session info for debugging
        updateSessionInfo(data, 'workspace');

        // /api/me no longer returns real wallet balances (returns 0 for all).
        // Fire /api/credits/wallet in background to get authoritative balances.
        // This is non-blocking — the identity bootstrap is already complete.
        _fetchRealWalletBalances();
      } else {
        log('[Credits] /api/me returned ok:false');
        creditsState.wallet = { balance: 0, reserved: 0, available: 0, videoBalance: 0, videoReserved: 0, videoAvailable: 0 };
        pendingRetry = true;
      }

      return creditsState.wallet;
    } catch (err) {
      log('[Credits] Wallet fetch error:', err.message);
      // Keep cached balance on timeout, schedule retry
      pendingRetry = true;
      creditsState.error = err.message;
      return creditsState.wallet;
    } finally {
      walletFetchInFlight = null; // Clear single-flight guard
    }
  })();

  return walletFetchInFlight;
}

/**
 * Fetch real wallet balances from /api/credits/wallet.
 * Called after /api/me bootstrap completes. Non-blocking — updates
 * creditsState and UI when the response arrives.
 */
async function _fetchRealWalletBalances() {
  try {
    const result = await apiFetch('/api/credits/wallet', { timeout: 10000 });
    if (!result.ok || !result.data?.ok) {
      log('[Credits] /api/credits/wallet failed:', result.status, result.error);
      return;
    }
    const d = result.data;
    const balance = d.credits_balance ?? 0;
    const reserved = d.reserved_credits ?? 0;
    const available = d.available_credits ?? Math.max(0, balance - reserved);
    const videoBalance = d.video_credits_balance ?? 0;
    const videoReserved = d.video_reserved_credits ?? 0;
    const videoAvailable = d.video_available_credits ?? Math.max(0, videoBalance - videoReserved);

    creditsState.wallet = { balance, reserved, available, videoBalance, videoReserved, videoAvailable };
    cacheCreditsBalance(available, videoAvailable);
    updateCreditsUI();
    log(`[Credits] Real wallet loaded: general=${available} video=${videoAvailable}`);
  } catch (err) {
    log('[Credits] /api/credits/wallet error (non-fatal):', err.message);
  }
}

/**
 * Fetch action costs from /api/billing/action-costs
 * Response format: { ok: true, action_costs: [{ action_key: "...", credits: N }, ...] }
 */
const _ACTION_COSTS_CACHE_KEY = 'timrx_action_costs';
const _ACTION_COSTS_CACHE_TTL = 3600000; // 1 hour — costs are admin-configured, rarely change
const _ACTION_COSTS_CACHE_VERSION = 2;   // Bump when pricing changes to invalidate stale caches

export async function fetchActionCosts() {
  // Fast path: use localStorage cache if fresh (avoids network call entirely on repeat loads)
  try {
    const raw = localStorage.getItem(_ACTION_COSTS_CACHE_KEY);
    if (raw) {
      const { data: cached, ts, v } = JSON.parse(raw);
      if (cached && v === _ACTION_COSTS_CACHE_VERSION && Date.now() - ts < _ACTION_COSTS_CACHE_TTL) {
        creditsState.actionCosts = { ...getDefaultActionCosts(), ...cached };
        log('[Credits] Action costs from localStorage cache:', Object.keys(cached).length, 'keys');
        updateGenerateButtonCosts();
        return creditsState.actionCosts;
      }
    }
  } catch (_) { /* corrupt cache — fall through to fetch */ }

  try {
    const result = await apiFetch('/api/billing/action-costs');

    if (!result.ok) {
      log('[Credits] Action costs fetch failed:', result.status);
      creditsState.actionCosts = getDefaultActionCosts();
      return creditsState.actionCosts;
    }

    const data = result.data;

    // Handle array format from backend: { action_costs: [{ action_key, credits }, ...] }
    if (data.ok && Array.isArray(data.action_costs)) {
      const costsMap = {};
      data.action_costs.forEach(item => {
        if (item.action_key && typeof item.credits === 'number') {
          costsMap[item.action_key] = item.credits;
        }
      });

      // Add legacy aliases for backward compatibility
      // Backend now returns canonical keys; we add aliases for any code still using old keys
      // Canonical -> Legacy aliases
      if (costsMap['text_to_3d_generate']) {
        costsMap['text-to-3d'] = costsMap['text_to_3d_generate'];
        costsMap['preview'] = costsMap['text_to_3d_generate'];
      }
      if (costsMap['image_to_3d_generate']) {
        costsMap['image-to-3d'] = costsMap['image_to_3d_generate'];
      }
      if (costsMap['image_generate']) {
        costsMap['text-to-image'] = costsMap['image_generate'];
        costsMap['image_studio_generate'] = costsMap['image_generate'];
      }
      if (costsMap['refine']) {
        costsMap['upscale'] = costsMap['refine'];
      }
      if (costsMap['retexture']) {
        costsMap['texture'] = costsMap['retexture'];
      }
      if (costsMap['video_generate']) {
        costsMap['video'] = costsMap['video_generate'];
      }
      if (costsMap['video_text_generate']) {
        costsMap['text2video'] = costsMap['video_text_generate'];
      }
      if (costsMap['video_image_animate']) {
        costsMap['image2video'] = costsMap['video_image_animate'];
      }
      if (costsMap['multi_color_print']) {
        costsMap['multi-color-print'] = costsMap['multi_color_print'];
        costsMap['multicolor-print'] = costsMap['multi_color_print'];
      }

      // If no costs were parsed, use defaults
      if (Object.keys(costsMap).length === 0) {
        log('[Credits] API returned empty action_costs array, using defaults');
        creditsState.actionCosts = getDefaultActionCosts();
      } else {
        // Merge: defaults as fallback, backend values take priority
        creditsState.actionCosts = { ...getDefaultActionCosts(), ...costsMap };
        log('[Credits] Action costs loaded:', Object.keys(costsMap).length, 'keys from backend +', Object.keys(creditsState.actionCosts).length, 'total with defaults');
      }
    } else if (data.costs && Object.keys(data.costs).length > 0) {
      // Handle old object format (backward compatibility)
      creditsState.actionCosts = data.costs;
      log('[Credits] Action costs from legacy format:', Object.keys(data.costs).length, 'keys');
    } else {
      // Fallback to defaults if API returns empty or unexpected format
      creditsState.actionCosts = getDefaultActionCosts();
      log('[Credits] Using default action costs (API returned empty or unexpected format)');
      log('[Credits] API response was:', data);
    }

    // Cache to localStorage for repeat page loads (1-hour TTL)
    try {
      localStorage.setItem(_ACTION_COSTS_CACHE_KEY, JSON.stringify({
        data: creditsState.actionCosts,
        ts: Date.now(),
        v: _ACTION_COSTS_CACHE_VERSION,
      }));
    } catch (_) { /* quota exceeded or private mode — ignore */ }

    // Re-evaluate generate buttons now that real costs are known.
    updateGenerateButtonCosts();

    return creditsState.actionCosts;
  } catch (err) {
    log('[Credits] Action costs fetch error:', err);
    creditsState.actionCosts = getDefaultActionCosts();
    creditsState.error = err.message;
    // Still refresh buttons — defaults are now loaded
    updateGenerateButtonCosts();
    return creditsState.actionCosts;
  }
}

/**
 * Default action costs (fallback if API unavailable)
 *
 * CANONICAL ACTION KEYS — Pricing refactor Mar 2026:
 * - image_generate          (4c)  - OpenAI standard image (1K)
 * - image_generate_2k       (8c)  - OpenAI 2K image
 * - gemini_image_generate   (4c)  - Gemini standard image
 * - piapi_image_generate    (7c)  - Nano Banana standard (premium)
 * - piapi_image_generate_2k (12c) - Nano Banana 2K (premium)
 * - text_to_3d_generate  (20c) - Text to 3D preview generation
 * - image_to_3d_generate (30c) - Image to 3D conversion
 * - refine               (6c)  - Refine/upscale 3D model
 * - remesh               (5c)  - Remesh 3D model
 * - retexture            (10c) - Apply new texture to 3D model
 * - convert              (1c)  - Format-only conversion (Meshy Convert)
 * - video_generate       (96c) - Generic video generation (Vertex 8s 720p base)
 * - video_text_generate  (96c) - Text-to-video generation (base)
 * - video_image_animate  (96c) - Image-to-video (equalized with text-to-video)
 *
 * VIDEO PRICING (DB-driven via video_credit_rules):
 * - 720p:  4s=48, 6s=72, 8s=96  (Vertex 12 c/s, margin-stabilized)
 * - 1080p: 8s=120 (requires 8s duration)
 * - 4K:    8s=156 (requires 8s duration)
 */
function getDefaultActionCosts() {
  return {
    // === CANONICAL ACTION KEYS — Pricing refactor Mar 2026 ===
    // Image — OpenAI/Gemini standard tier (4c / 8c / 12c)
    'image_generate': 4,
    'image_generate_2k': 8,
    'image_generate_4k': 12,
    // Image — Gemini tier (4c / 8c / 12c)
    'gemini_image_generate': 4,
    'gemini_image_generate_2k': 8,
    'gemini_image_generate_4k': 12,
    // Image — Nano Banana premium tier (7c / 12c / 18c)
    'piapi_image_generate': 7,
    'piapi_image_generate_2k': 12,
    'piapi_image_generate_4k': 18,
    'text_to_3d_generate': 20,    // Text to 3D preview
    'image_to_3d_generate': 30,   // Image to 3D
    'refine': 6,                  // Refine 3D model
    'remesh': 5,                  // Remesh 3D model
    'retexture': 10,              // Retexture 3D model
    'convert': 1,                 // Meshy Convert (format-only remesh)
    'resize': 1,                  // Meshy Resize
    'uv_unwrap': 5,               // Meshy UV Unwrap
    'print_analyze': 0,           // Meshy Analyze Printability (free)
    'print_repair': 10,           // Meshy Repair Printability
    'video_generate': 96,         // Video generation (Vertex 8s 720p base)
    'video_text_generate': 96,    // Text to video (base)
    'video_image_animate': 96,    // Image to video (equalized)
    'rig': 5,                     // Rig a 3D model
    'animate': 3,                 // Apply animation to rigged model
    'multi_color_print': 10,      // Full-color 3MF print conversion

    // === LEGACY ALIASES (backwards compatibility) ===
    // Hyphenated variants
    'text-to-3d': 20,
    'image-to-3d': 30,
    'text-to-image': 4,            // -> image_generate (OpenAI tier)

    // Old naming
    'preview': 20,                // -> text_to_3d_generate
    'texture': 10,                // -> retexture
    'upscale': 6,                 // -> refine
    'video': 96,                  // -> video_generate (base)
    'image_studio_generate': 4,   // -> image_generate (OpenAI tier)

    // Backend DB action codes (for direct lookups)
    'MESHY_TEXT_TO_3D': 20,
    'MESHY_IMAGE_TO_3D': 30,
    'MESHY_RETEXTURE': 10,
    'MESHY_REMESH': 5,
    'MESHY_CONVERT': 1,
    'MESHY_RESIZE': 1,
    'MESHY_UV_UNWRAP': 5,
    'MESHY_PRINT_ANALYZE': 0,
    'MESHY_PRINT_REPAIR': 10,
    'MESHY_REFINE': 6,
    'MESHY_RIGGING': 5,
    'MESHY_ANIMATION': 3,
    'MESHY_MULTI_COLOR_PRINT': 10,
    'OPENAI_IMAGE': 4,
    'OPENAI_IMAGE_2K': 8,
    // OPENAI_IMAGE_4K removed — OpenAI does not support 4K
    'GEMINI_IMAGE': 4,
    'GEMINI_IMAGE_2K': 8,
    // GEMINI_IMAGE_4K removed — Gemini does not support 4K
    'PIAPI_IMAGE': 7,
    'PIAPI_IMAGE_2K': 12,
    'PIAPI_IMAGE_4K': 18,
    'VIDEO_GENERATE': 96,
    'VIDEO_TEXT_GENERATE': 96,
    'VIDEO_IMAGE_ANIMATE': 96,
  };
}

/**
 * Initialize credits - fetch wallet and action costs
 * Idempotent: safe to call multiple times, will only run once
 */
export async function initCredits() {
  // Guard: already initialized
  if (creditsState.loaded) {
    log('[Credits] Already initialized, skipping...');
    return;
  }

  // Guard: currently loading (prevent concurrent calls)
  if (creditsState.loading) {
    log('[Credits] Already loading, skipping...');
    return;
  }

  creditsState.loading = true;
  creditsState.error = null;

  try {
    // Phase 1: /api/me first — bootstraps identity, wallet, session.
    // Must land before anything else so the backend pool serves the
    // critical auth request with no contention.
    await fetchWallet();

    // Phase 2: action-costs deferred 1.5s after wallet settles.
    // Pricing data changes rarely — hardcoded fallbacks via
    // defaultActionCosts() cover the first 1.5s of UI.  The delay
    // avoids overlapping with /api/_mod/history which fires right
    // after creditsPromise resolves in main.js.
    setTimeout(() => {
      fetchActionCosts().catch(err => {
        log('[Credits] Action costs fetch failed (non-blocking):', err.message);
      });
    }, 1500);

    creditsState.loaded = true;
    creditsState.serverConfirmed = true;
    log('[Credits] Initialization complete (balance is server-confirmed)');

    // Update any UI elements
    updateCreditsUI();

    // Setup batch count listeners for dynamic cost updates
    setupBatchCountListeners();

  } catch (err) {
    log('[Credits] Initialization error:', err);
    creditsState.error = err.message;
  } finally {
    creditsState.loading = false;
  }
}

// ============================================================================
// CREDIT CHECKS
// ============================================================================

// Track which actions we've already warned about (avoid log spam)
const _warnedActions = new Set();

/**
 * Resolve cost for an action key, trying multiple aliases.
 * Returns null if action is not found (distinct from 0 which means free).
 *
 * @param {string} action - The action key (e.g., 'text-to-3d', 'refine')
 * @returns {number|null} - Cost in credits, or null if unknown
 */
export function resolveCost(action) {
  if (!action) return null;

  // Direct lookup
  if (action in creditsState.actionCosts) {
    return creditsState.actionCosts[action];
  }

  // Try common aliases (hyphen <-> underscore)
  const underscore = action.replace(/-/g, '_');
  const hyphen = action.replace(/_/g, '-');

  if (underscore !== action && underscore in creditsState.actionCosts) {
    return creditsState.actionCosts[underscore];
  }
  if (hyphen !== action && hyphen in creditsState.actionCosts) {
    return creditsState.actionCosts[hyphen];
  }

  // Try with common suffixes
  const withGenerate = `${action}_generate`;
  if (withGenerate in creditsState.actionCosts) {
    return creditsState.actionCosts[withGenerate];
  }

  // Not found - log warning once per action key
  if (!_warnedActions.has(action) && creditsState.loaded) {
    _warnedActions.add(action);
    console.warn(`[Credits] Unknown action: "${action}". Available keys:`, Object.keys(creditsState.actionCosts).join(', '));
  }

  return null;
}

/**
 * Get cost for a specific action.
 * Returns 0 for unknown actions (backward compatible) - use resolveCost() for nullable result.
 *
 * @param {string} action - The action key
 * @returns {number} - Cost in credits (0 if unknown)
 */
export function getActionCost(action) {
  const cost = resolveCost(action);
  return cost !== null ? cost : 0;
}

/**
 * Check if user has enough credits for an action (pool-aware).
 * Returns false if balance has not been confirmed by the server yet,
 * preventing actions based on stale cached values.
 */
export function hasCreditsFor(action) {
  if (!creditsState.serverConfirmed) {
    log('[Credits] hasCreditsFor() blocked — balance not yet confirmed by server');
    return false;
  }
  const cost = getActionCost(action);
  if (isVideoAction(action)) {
    return creditsState.wallet.videoAvailable >= cost;
  }
  return creditsState.wallet.available >= cost;
}

/**
 * Get available credits
 */
export function getAvailableCredits() {
  return creditsState.wallet.available;
}

/**
 * Get wallet state (includes both general and video credits)
 */
export function getWallet() {
  return { ...creditsState.wallet };
}

/**
 * Get general credits wallet only (without video credits)
 */
export function getGeneralWallet() {
  return {
    balance: creditsState.wallet.balance,
    reserved: creditsState.wallet.reserved,
    available: creditsState.wallet.available,
  };
}

/**
 * Get all action costs
 */
export function getActionCosts() {
  return { ...creditsState.actionCosts };
}

/**
 * Check if credits system is loaded
 */
export function isLoaded() {
  return creditsState.loaded;
}

/**
 * Check if balance has been confirmed by the server
 */
export function isBalanceConfirmed() {
  return creditsState.serverConfirmed;
}

/**
 * Get server-confirmed balance, or null if not yet confirmed.
 */
export function getConfirmedBalance() {
  return creditsState.serverConfirmed ? creditsState.wallet.available : null;
}

// ============================================================================
// VIDEO CREDITS - Separate pool for video generation
// ============================================================================

/**
 * Get available video credits
 */
export function getVideoCredits() {
  return creditsState.wallet.videoAvailable;
}

/**
 * Get video wallet state
 */
export function getVideoWallet() {
  return {
    balance: creditsState.wallet.videoBalance,
    reserved: creditsState.wallet.videoReserved,
    available: creditsState.wallet.videoAvailable,
  };
}

/**
 * Check if user has enough video credits for a specific cost
 * @param {number} cost - Required video credits
 * @returns {boolean}
 */
export function hasVideoCredits(cost) {
  return creditsState.wallet.videoAvailable >= cost;
}

/**
 * Check if an action is a video action (uses video credits pool)
 * @param {string} action - Action key
 * @returns {boolean}
 */
export function isVideoAction(action) {
  if (!action) return false;
  const normalizedAction = action.toLowerCase().replace(/-/g, '_');
  return normalizedAction.includes('video') ||
         normalizedAction === 'text2video' ||
         normalizedAction === 'image2video';
}

/**
 * Build a canonical lowercase video action code.
 *
 * Patterns by provider:
 *   Vertex/Veo:    video_{task}_{dur}s_{res}                              (e.g. video_text_generate_4s_720p)
 *   fal Seedance:  fal_seedance_{task}_{dur}s                             (e.g. fal_seedance_image_animate_10s)
 *   PiAPI Seedance (GA, resolution-aware):
 *                  seedance_{mini|fast|quality|v25}_{task}_{dur}s_{res}   (e.g. seedance_quality_text_generate_15s_1080p)
 *
 * Legacy preview-era seedance codes (no resolution suffix) still exist in the
 * action_costs table for in-flight jobs, but new code always emits the GA form.
 *
 * @param {string} task         "text2video" | "image2video" | "image_transition" | "reference_video"
 * @param {number} durationSeconds
 * @param {string} resolution   "480p" | "720p" | "1080p" | "4k"
 * @param {string} [provider]   "vertex" | "seedance" | "fal_seedance"
 * @param {string} [seedanceTier] "mini" | "fast" | "quality" | "v25"  (legacy "preview" → "quality")
 * @returns {string} Action code
 */
// PiAPI's per-tier default resolution — Mini defaults to 720p, the others to 480p.
const SEEDANCE_TIER_DEFAULT_RES = { mini: '720p', fast: '480p', quality: '480p', v25: '720p' };

export function getVideoActionCode(task, durationSeconds, resolution, provider, seedanceTier) {
  // Lowercase snake_case canonical form.
  let taskPart;
  if (task === 'text2video') taskPart = 'text_generate';
  else if (task === 'image_transition') taskPart = 'image_transition';
  // Reference-Guided (Seedance omni_reference) has its own action codes — mapping it
  // to image_animate would look up the wrong row and miss the input-video surcharge.
  else if (task === 'reference_video') taskPart = 'reference_video';
  else taskPart = 'image_animate';

  const durationPart = `${durationSeconds}s`;

  if (provider === 'fal_seedance') {
    return `fal_seedance_${taskPart}_${durationPart}`;
  }

  if (provider === 'seedance') {
    let tier = (seedanceTier || 'fast').toLowerCase();
    if (tier === 'preview') tier = 'quality';  // legacy alias
    if (!SEEDANCE_TIER_DEFAULT_RES[tier]) tier = 'fast';
    const resPart = (resolution || SEEDANCE_TIER_DEFAULT_RES[tier]).toLowerCase();
    return `seedance_${tier}_${taskPart}_${durationPart}_${resPart}`;
  }

  // Vertex/Veo
  const resPart = resolution.toLowerCase();
  return `video_${taskPart}_${durationPart}_${resPart}`;
}

/**
 * Get video credit cost by duration and resolution.
 * Looks up from backend-fetched action costs, falls back to hardcoded defaults.
 * @param {string} task - "text2video" or "image2video"
 * @param {number} durationSeconds - 4, 6, or 8
 * @param {string} resolution - "720p", "1080p", or "4k"
 * @returns {number} Credit cost
 */
export function getVideoCreditCost(task, durationSeconds, resolution) {
  // Build the action code
  const actionCode = getVideoActionCode(task, durationSeconds, resolution);

  // Try to find in action costs (both uppercase and lowercase)
  const cost = resolveCost(actionCode) || resolveCost(actionCode.toLowerCase());

  if (cost !== null && cost > 0) {
    return cost;
  }

  // Fallback to hardcoded defaults (must match backend pricing_service.py)
  // Vertex Veo 3.1: 12 c/s (margin-stabilized). All modes equalized.
  const FALLBACK_COSTS = {
    '720p': { 4: 48, 6: 72, 8: 96 },
    '1080p': { 8: 120 },
    '4k': { 8: 156 },
  };

  const resLower = resolution.toLowerCase();
  const dur = parseInt(durationSeconds, 10);

  if (FALLBACK_COSTS[resLower] && FALLBACK_COSTS[resLower][dur] !== undefined) {
    console.warn(`[Credits] Using fallback cost for ${actionCode}: ${FALLBACK_COSTS[resLower][dur]}`);
    return FALLBACK_COSTS[resLower][dur];
  }

  // Ultimate fallback — Vertex 8s 720p base rate
  console.warn(`[Credits] No cost found for ${actionCode}, defaulting to 96`);
  return 96;
}

/**
 * Show insufficient video credits modal
 * @param {number} required - Credits required
 * @param {number} available - Credits available (optional, uses current state if not provided)
 */
export function showInsufficientVideoCreditsMessage(required, available = null) {
  const actualAvailable = available !== null ? available : creditsState.wallet.videoAvailable;
  const needed = Math.max(0, required - actualAvailable);

  log('[Credits] Insufficient video credits:', { required, available: actualAvailable, needed });

  // Create modal HTML
  const modalId = 'insufficient-video-credits-modal';

  // Remove existing modal if any
  const existingModal = document.getElementById(modalId);
  if (existingModal) {
    existingModal.remove();
  }

  const modal = document.createElement('div');
  modal.id = modalId;
  modal.className = 'modal show';
  modal.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);opacity:1;visibility:visible;';

  modal.innerHTML = `
    <div class="modal-backdrop" style="position:absolute;inset:0;cursor:pointer;"></div>
    <div class="modal-dialog" style="position:relative;z-index:1;background:var(--surface-elevated, #1e1e2e);border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <div class="modal-header" style="margin-bottom:16px;">
        <h3 style="margin:0;color:var(--text-primary, #fff);font-size:1.25rem;display:flex;align-items:center;gap:8px;">
          <i class="fa-solid fa-video" style="color:var(--accent-warning, #f59e0b);"></i>
          Video Credits Required
        </h3>
      </div>
      <div class="modal-body" style="color:var(--text-secondary, #a0a0b0);margin-bottom:20px;">
        <p style="margin:0 0 12px 0;">
          Video generation uses <strong style="color:var(--accent-warning, #f59e0b);">video credits</strong>,
          which are separate from your general credits.
        </p>
        <div style="background:var(--surface-base, #14141f);border-radius:8px;padding:12px;margin:12px 0;">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
            <span>Required:</span>
            <span style="color:var(--text-primary, #fff);font-weight:600;">${required} video credits</span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
            <span>Available:</span>
            <span style="color:var(--text-primary, #fff);">${actualAvailable} video credits</span>
          </div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border-subtle, #2a2a3a);padding-top:8px;margin-top:8px;">
            <span>Need:</span>
            <span style="color:var(--accent-error, #ef4444);font-weight:600;">${needed} more</span>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="display:flex;gap:12px;justify-content:flex-end;">
        <button class="btn btn-secondary" id="video-credits-modal-cancel" style="padding:10px 20px;border-radius:8px;border:1px solid var(--border-default, #3a3a4a);background:transparent;color:var(--text-primary, #fff);cursor:pointer;">
          Cancel
        </button>
        <button class="btn btn-primary" id="video-credits-modal-buy" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg, var(--accent-purple, #b8a77a), var(--accent-2, #8f8261));color:#fff;cursor:pointer;font-weight:600;">
          <i class="fa-solid fa-coins" style="margin-right:6px;"></i>
          Buy Video Credits
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Event handlers
  const closeModal = () => modal.remove();

  modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
  modal.querySelector('#video-credits-modal-cancel').addEventListener('click', closeModal);
  modal.querySelector('#video-credits-modal-buy').addEventListener('click', () => {
    closeModal();
    // Navigate to hub pricing section for video credits
    window.location.href = '/hub#pricing';
  });

  // Close on Escape key
  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);
}

// ============================================================================
// OPTIMISTIC UPDATES
// ============================================================================

/**
 * Generate unique ID for tracking pending deductions
 */
function generateDeductionId() {
  return `deduct_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Deduct credits optimistically (immediately update UI before API call)
 *
 * @param {string} action - The action key (e.g., 'image_to_3d', 'text_to_3d')
 * @param {number} count - Number of items (default 1, for batch operations)
 * @returns {object} - { id, amount } to use for reconcile/rollback
 */
export function deductOptimistic(action, count = 1) {
  const costPerItem = getActionCost(action);
  const totalCost = costPerItem * count;

  if (totalCost === 0) {
    log('[Credits] Optimistic deduct: action has no cost', action);
    return { id: null, amount: 0 };
  }

  const deductionId = generateDeductionId();
  const deduction = {
    id: deductionId,
    amount: totalCost,
    action,
    count,
    timestamp: Date.now(),
  };

  // Track this pending deduction
  creditsState.pendingDeductions.push(deduction);

  // Store current balance as "last server balance" if not already set
  if (creditsState.lastServerBalance === null) {
    creditsState.lastServerBalance = creditsState.wallet.available;
  }

  // Optimistically reduce available credits
  creditsState.wallet.available = Math.max(0, creditsState.wallet.available - totalCost);
  creditsState.wallet.balance = Math.max(0, creditsState.wallet.balance - totalCost);

  log('[Credits] Optimistic deduct:', {
    id: deductionId,
    action,
    cost: totalCost,
    newAvailable: creditsState.wallet.available,
  });

  // Update UI immediately
  updateCreditsUI();

  return { id: deductionId, amount: totalCost };
}

/**
 * Reconcile local state with server balance (call after API response)
 *
 * @param {number} serverBalance - The actual balance from server response
 * @param {string} deductionId - Optional: specific deduction to clear
 */
export function reconcile(serverBalance, deductionId = null) {
  log('[Credits] Reconciling with server balance:', serverBalance);

  // Clear specific deduction or all pending deductions
  if (deductionId) {
    creditsState.pendingDeductions = creditsState.pendingDeductions.filter(
      d => d.id !== deductionId
    );
  } else {
    // Clear all pending deductions on full reconcile
    creditsState.pendingDeductions = [];
  }

  // Update to server truth
  creditsState.wallet.available = serverBalance;
  creditsState.wallet.balance = serverBalance;
  creditsState.lastServerBalance = serverBalance;

  // Cache for next page load
  cacheCreditsBalance(serverBalance);

  log('[Credits] Reconciled:', {
    balance: serverBalance,
    pendingCount: creditsState.pendingDeductions.length,
  });

  // Update UI with server truth
  updateCreditsUI();
}

/**
 * Rollback a pending deduction (call if API call fails)
 *
 * @param {string} deductionId - The deduction ID from deductOptimistic
 */
export function rollback(deductionId) {
  const deductionIndex = creditsState.pendingDeductions.findIndex(
    d => d.id === deductionId
  );

  if (deductionIndex === -1) {
    log('[Credits] Rollback: deduction not found', deductionId);
    return;
  }

  const deduction = creditsState.pendingDeductions[deductionIndex];

  // Remove from pending
  creditsState.pendingDeductions.splice(deductionIndex, 1);

  // Restore credits
  creditsState.wallet.available += deduction.amount;
  creditsState.wallet.balance += deduction.amount;

  log('[Credits] Rolled back:', {
    id: deductionId,
    amount: deduction.amount,
    newAvailable: creditsState.wallet.available,
  });

  // Update UI
  updateCreditsUI();
}

/**
 * Clear all pending deductions (useful on page refresh or error recovery)
 */
export function clearPending() {
  creditsState.pendingDeductions = [];
  log('[Credits] Cleared all pending deductions');
}

/**
 * Get total pending deductions amount
 */
export function getPendingAmount() {
  return creditsState.pendingDeductions.reduce((sum, d) => sum + d.amount, 0);
}

// ============================================================================
// CREDIT RESERVATIONS (hold credits during generation)
// ============================================================================

/**
 * Reserve credits for a pending operation.
 * Shows "Reserving credits..." state and immediately reduces available.
 *
 * @param {string} action - The action key (e.g., 'text-to-3d', 'image-to-3d')
 * @param {number} count - Number of items (default 1, for batch operations)
 * @returns {{ reservationId: string, amount: number }} Reservation info
 */
export function reserveCredits(action, count = 1) {
  const costPerItem = getActionCost(action);
  const totalCost = costPerItem * count;

  if (totalCost === 0) {
    log('[Credits] Reserve: action has no cost', action);
    log('[Credits] Available action costs:', Object.keys(creditsState.actionCosts).join(', ') || '(empty)');
    log('[Credits] Action costs state:', creditsState.actionCosts);
    return { reservationId: null, amount: 0 };
  }

  // Check if enough credits available (accounting for existing reservations)
  const available = Number(creditsState.wallet.available) || 0;
  const reserved = Number(creditsState.totalReserved) || 0;
  const effectiveAvailable = available - reserved;
  const missing = Math.max(0, totalCost - effectiveAvailable);
  const shouldBlock = missing > 0;

  // Detailed logging for debugging credit issues
  console.log(`[CREDITS] ========================================`);
  console.log(`[CREDITS] RESERVE CREDITS CHECK (action-based)`);
  console.log(`[CREDITS] action=${action}`);
  console.log(`[CREDITS] costPerItem=${costPerItem}, count=${count}, totalCost=${totalCost}`);
  console.log(`[CREDITS] available=${available}`);
  console.log(`[CREDITS] reserved=${reserved}`);
  console.log(`[CREDITS] effectiveAvailable=${effectiveAvailable}`);
  console.log(`[CREDITS] missing=${missing}`);
  console.log(`[CREDITS] shouldBlock=${shouldBlock}`);
  console.log(`[CREDITS] ========================================`);

  if (shouldBlock) {
    log('[Credits] Reserve failed: insufficient credits', {
      action,
      cost: totalCost,
      available,
      reserved,
      effectiveAvailable,
      missing,
    });
    return { reservationId: null, amount: 0, insufficient: true, required: totalCost, available: effectiveAvailable, missing };
  }

  const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const reservation = {
    amount: totalCost,
    action,
    count,
    timestamp: Date.now(),
  };

  // Track reservation
  creditsState.reservations.set(reservationId, reservation);
  creditsState.totalReserved += totalCost;

  log('[Credits] Reserved:', {
    reservationId,
    action,
    amount: totalCost,
    totalReserved: creditsState.totalReserved,
    effectiveAvailable: creditsState.wallet.available - creditsState.totalReserved,
  });

  // Update UI to show reservation
  updateCreditsUI();

  return { reservationId, amount: totalCost };
}

/**
 * Reserve an EXACT amount of credits (use for pre-computed costs like video)
 * Unlike reserveCredits(action, count), this does NOT multiply by action cost.
 *
 * @param {object} params
 * @param {string} params.action - The action type (for logging/tracking)
 * @param {number} params.amount - Exact credits amount to reserve
 * @param {object} params.meta - Optional metadata
 * @returns {{ reservationId: string, amount: number, insufficient?: boolean }}
 */
export function reserveAmount({ action, amount, meta = {} }) {
  const numAmount = Number(amount) || 0;

  if (numAmount <= 0) {
    log('[Credits] reserveAmount: invalid amount', { action, amount });
    return { reservationId: null, amount: 0 };
  }

  // Pool-aware availability check: video actions use the video credits pool
  const isVidAction = isVideoAction(action || '');
  const available = Number(isVidAction ? creditsState.wallet.videoAvailable : creditsState.wallet.available) || 0;
  // Video pool has no client-side reservation tracking (server deducts after generation)
  const reserved = isVidAction ? 0 : Number(creditsState.totalReserved) || 0;
  const effectiveAvailable = available - reserved;
  const missing = Math.max(0, numAmount - effectiveAvailable);
  const shouldBlock = missing > 0;

  // Detailed logging for debugging credit issues
  console.log(`[CREDITS] ========================================`);
  console.log(`[CREDITS] RESERVE AMOUNT CHECK`);
  console.log(`[CREDITS] action=${action} pool=${isVidAction ? 'video' : 'general'}`);
  console.log(`[CREDITS] cost=${numAmount}`);
  console.log(`[CREDITS] available=${available}`);
  console.log(`[CREDITS] reserved=${reserved}`);
  console.log(`[CREDITS] effectiveAvailable=${effectiveAvailable}`);
  console.log(`[CREDITS] missing=${missing}`);
  console.log(`[CREDITS] shouldBlock=${shouldBlock}`);
  console.log(`[CREDITS] ========================================`);

  if (shouldBlock) {
    log('[Credits] reserveAmount failed: insufficient credits', {
      action,
      pool: isVidAction ? 'video' : 'general',
      cost: numAmount,
      available,
      reserved,
      effectiveAvailable,
      missing,
    });
    return { reservationId: null, amount: 0, insufficient: true, required: numAmount, available: effectiveAvailable, missing };
  }

  const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const reservation = {
    amount: numAmount,
    action,
    isVideo: isVidAction,
    meta,
    timestamp: Date.now(),
  };

  // Track reservation — video reservations do NOT increment totalReserved
  // (video pool deduction is tracked server-side; avoid double-deducting general display)
  creditsState.reservations.set(reservationId, reservation);
  if (!isVidAction) {
    creditsState.totalReserved += numAmount;
  } else {
    // Optimistically reduce video available to prevent double-clicks
    creditsState.wallet.videoAvailable = Math.max(0, creditsState.wallet.videoAvailable - numAmount);
  }

  log('[Credits] reserveAmount succeeded:', {
    reservationId,
    action,
    pool: isVidAction ? 'video' : 'general',
    amount: numAmount,
    totalReserved: creditsState.totalReserved,
    effectiveAvailable: available - (isVidAction ? numAmount : creditsState.totalReserved),
  });

  // Update UI to show reservation
  updateCreditsUI();

  return { reservationId, amount: numAmount };
}

/**
 * Confirm a reservation (job started successfully).
 * Converts reservation to actual deduction.
 *
 * @param {string} reservationId - The reservation ID from reserveCredits
 * @param {string} jobId - The actual job ID from backend
 */
export function confirmReservation(reservationId, jobId) {
  const reservation = creditsState.reservations.get(reservationId);
  if (!reservation) {
    log('[Credits] confirmReservation: not found', reservationId);
    return;
  }

  // Remove from reservations
  creditsState.reservations.delete(reservationId);

  if (reservation.isVideo) {
    // Video pool: server deducts on completion; videoAvailable already optimistically reduced
    // No applyDelta needed — next refreshCredits will reconcile
    log('[Credits] Video reservation confirmed (server will deduct):', {
      reservationId, jobId, amount: reservation.amount,
    });
  } else {
    creditsState.totalReserved -= reservation.amount;
    // Apply actual deduction to general pool
    applyDelta(-reservation.amount, reservation.action, jobId);
    log('[Credits] Reservation confirmed:', {
      reservationId, jobId, amount: reservation.amount, newBalance: creditsState.wallet.available,
    });
  }
}

/**
 * Release a reservation (job failed to start or was cancelled).
 * Returns credits to available.
 *
 * @param {string} reservationId - The reservation ID from reserveCredits
 */
export function releaseReservation(reservationId) {
  const reservation = creditsState.reservations.get(reservationId);
  if (!reservation) {
    log('[Credits] releaseReservation: not found', reservationId);
    return;
  }

  // Remove from reservations
  creditsState.reservations.delete(reservationId);

  if (reservation.isVideo) {
    // Restore the optimistic video deduction
    creditsState.wallet.videoAvailable += reservation.amount;
    log('[Credits] Video reservation released:', {
      reservationId, amount: reservation.amount, videoAvailable: creditsState.wallet.videoAvailable,
    });
  } else {
    creditsState.totalReserved -= reservation.amount;
    log('[Credits] Reservation released:', {
      reservationId, amount: reservation.amount, totalReserved: creditsState.totalReserved,
    });
  }

  // Update UI
  updateCreditsUI();
}

/**
 * Get total currently reserved credits
 */
export function getTotalReserved() {
  return creditsState.totalReserved;
}

/**
 * Get effective available credits (available minus reserved)
 */
export function getEffectiveAvailable() {
  return Math.max(0, creditsState.wallet.available - creditsState.totalReserved);
}

/**
 * Check if enough credits for action (pool-aware, accounting for reservations)
 */
export function hasEffectiveCreditsFor(action, count = 1) {
  const cost = getActionCost(action) * count;
  if (isVideoAction(action)) {
    return creditsState.wallet.videoAvailable >= cost;
  }
  return getEffectiveAvailable() >= cost;
}

// ============================================================================
// WALLET STATE MANAGEMENT
// ============================================================================

/**
 * Update wallet after a successful operation (e.g., after job completion)
 */
export function updateWallet(wallet) {
  if (wallet) {
    const available = wallet.available ?? Math.max(0, (wallet.balance || 0) - (wallet.reserved || 0));
    creditsState.wallet = {
      balance: wallet.balance || 0,
      reserved: wallet.reserved || 0,
      available,
    };
    // Cache for next page load
    cacheCreditsBalance(available);
    updateCreditsUI();
    log('[Credits] Wallet updated:', creditsState.wallet);
  }
}

// ============================================================================
// EMAIL BEACON - Navbar beacon prompt to add email
// ============================================================================

/**
 * Update account beacon status indicator (workspace navbar).
 * Shows person icon for anonymous, email initial for verified.
 */
function updateEmailBeaconUI() {
  const beacon = document.getElementById('accountBeacon');
  const icon = document.getElementById('accountBeaconIcon');
  const initial = document.getElementById('accountBeaconInitial');
  if (!beacon) return;

  if (creditsState.emailVerified && creditsState.email) {
    beacon.setAttribute('data-status', 'verified');
    beacon.setAttribute('title', `Signed in as ${creditsState.email}`);
    beacon.setAttribute('aria-label', `Account: ${creditsState.email}`);
    if (icon) icon.style.display = 'none';
    if (initial) {
      initial.textContent = creditsState.email[0].toUpperCase();
      initial.style.display = 'flex';
    }
  } else {
    beacon.setAttribute('data-status', 'anonymous');
    beacon.setAttribute('title', 'Sign In');
    beacon.setAttribute('aria-label', 'Sign In');
    if (icon) icon.style.display = '';
    if (initial) initial.style.display = 'none';
  }
}

async function handleBeaconClick() {
  const { openAuthModal } = window.TimrXAuth || {};
  openAuthModal();
}

function setupAccountBeaconListeners() {
  const beacon = document.getElementById('accountBeacon');
  beacon?.addEventListener('click', handleBeaconClick);
}

// Listen for auth events to refresh wallet
window.addEventListener('timrx:auth:verified', async () => {
  await fetchWallet();
  updateEmailBeaconUI();
});
window.addEventListener('timrx:auth:switched', () => {
  window.location.reload();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAccountBeaconListeners);
} else {
  setupAccountBeaconListeners();
}

// ============================================================================
// UI UPDATES
// ============================================================================

/**
 * Update credits display in the workspace UI
 */
export function updateCreditsUI() {
  // Update credits pill if it exists
  const creditsPill = document.getElementById('workspaceCredits');
  const creditsValue = document.getElementById('workspaceCreditsValue');
  const creditsGroup = document.getElementById('workspaceCreditsGroup');
  const reservedIndicator = document.getElementById('workspaceCreditsReserved');

  // Calculate effective available (balance - reserved)
  const effectiveAvailable = getEffectiveAvailable();
  const hasReservations = creditsState.totalReserved > 0;

  if (creditsValue) {
    creditsValue.textContent = effectiveAvailable.toLocaleString();
  }

  // Update hover tooltip with pool breakdown.
  // The mobile menu mirrors these because the header pill collapses below 900px.
  const generalText = effectiveAvailable.toLocaleString();
  const videoText = creditsState.wallet.videoAvailable.toLocaleString();
  ['tooltipGeneral', 'mobileCreditsGeneral'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = generalText;
  });
  ['tooltipVideo', 'mobileCreditsVideo'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = videoText;
  });

  // Show/hide reserved indicator
  if (reservedIndicator) {
    if (hasReservations) {
      reservedIndicator.textContent = `(${creditsState.totalReserved} reserved)`;
      reservedIndicator.classList.remove('hidden');
    } else {
      reservedIndicator.classList.add('hidden');
    }
  }

  if (creditsPill) {
    creditsPill.classList.toggle('low', effectiveAvailable < 30 && effectiveAvailable > 0);
    creditsPill.classList.toggle('empty', effectiveAvailable === 0);
    creditsPill.classList.toggle('has-credits', effectiveAvailable > 0);
    creditsPill.classList.toggle('has-reservations', hasReservations);

    // Make credits pill clickable to show buy options
    if (!creditsPill.dataset.clickWired) {
      creditsPill.dataset.clickWired = 'true';
      creditsPill.style.cursor = 'pointer';
      creditsPill.addEventListener('click', () => {
        // Redirect to pricing section
        window.location.href = '/hub#pricing';
      });
    }

    // Native title removed — hover tooltip shows pool breakdown instead
    creditsPill.removeAttribute('title');
  }

  // Toggle syncing class on group and pill
  const isSyncing = creditsState.loading && !creditsState.loaded;
  const wasSyncing = creditsPill?.classList.contains('syncing');

  if (creditsGroup) {
    creditsGroup.classList.toggle('syncing', isSyncing);
  }
  if (creditsPill) {
    creditsPill.classList.toggle('syncing', isSyncing);

    // Brief "just-synced" flash when syncing completes
    if (wasSyncing && !isSyncing && creditsState.loaded) {
      creditsPill.classList.add('just-synced');
      setTimeout(() => creditsPill.classList.remove('just-synced'), 1200);
    }
  }

  // Update generate buttons with cost indicators
  updateGenerateButtonCosts();
}

/**
 * Button to action mapping with associated batch count inputs.
 *
 * CANONICAL ACTION KEYS (use these):
 * - image_generate       (4c) - OpenAI/Gemini; piapi_image_generate (7c) - Nano Banana
 * - text_to_3d_generate  (20c) - Text to 3D preview
 * - image_to_3d_generate (30c) - Image to 3D
 * - refine               (6c)  - Refine 3D model
 * - remesh               (5c)  - Remesh 3D model / convert (1c) when format-only
 * - retexture            (10c) - Retexture 3D model
 * - multi_color_print   (10c) - Full-color 3MF print conversion
 * - video_generate       (48-156c) - Video generation (Vertex 12 c/s, varies by duration/resolution)
 * - video_text_generate  (48-156c) - Text to video (equalized with image-to-video)
 * - video_image_animate  (48-156c) - Image to video (equalized with text-to-video)
 */
const BUTTON_CONFIG = {
  // Core generation buttons (canonical keys)
  'generateModelBtn': { action: 'text_to_3d_generate', batchInput: 'modelBatchCount' },
  'generateImageBtn': { action: 'image_generate', batchInput: null },
  'imageTo3dBtn': { action: 'image_to_3d_generate', batchInput: null },
  // Post-processing buttons (canonical keys)
  'generateTextureBtn': { action: 'retexture', batchInput: null },
  'applyRemeshBtn': { action: 'remesh', batchInput: null },
  'applyRefineBtn': { action: 'refine', batchInput: null },
  'applyUpscaleBtn': { action: 'refine', batchInput: null },  // Upscale uses refine cost
  'generateVideoBtn': { action: 'video_generate', batchInput: null },
  'startRigBtn': { action: 'rig', batchInput: null },
  'applyAnimationBtn': { action: 'animate', batchInput: null },
  'applyAnimationBtn2': { action: 'animate', batchInput: null },
};

/**
 * Get batch count for a button (from associated input or default 1)
 */
function getBatchCountForButton(btnId) {
  const config = BUTTON_CONFIG[btnId];
  if (!config?.batchInput) return 1;

  const input = document.getElementById(config.batchInput);
  if (!input) return 1;

  const val = parseInt(input.value, 10);
  return Number.isFinite(val) && val > 0 ? Math.min(val, 4) : 1;
}

/**
 * Update generate buttons to show credit costs
 * Maps button IDs to action keys for cost lookup
 * Uses resolveCost() to show "—" for unknown costs instead of "0"
 */
function updateGenerateButtonCosts() {
  // Use effective available for general credits (accounting for reservations)
  const effectiveAvailable = getEffectiveAvailable();

  Object.entries(BUTTON_CONFIG).forEach(([btnId, config]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    // Check for dynamic action override (e.g., when switching between text-to-3d and image-to-3d tabs)
    const action = btn.dataset.currentAction || config.action;
    const batchCount = getBatchCountForButton(btnId);

    // Check for dynamic cost override from UI (e.g., video panel with duration/resolution/audio options)
    // The data-base-credits attribute is set by panel-specific JS when options change
    const dynamicCost = btn.dataset.baseCredits ? parseInt(btn.dataset.baseCredits, 10) : null;

    // Use dynamic cost if available, otherwise fall back to static action cost
    const costPerItem = dynamicCost !== null && !isNaN(dynamicCost) ? dynamicCost : resolveCost(action);
    const isUnknown = costPerItem === null;
    const totalCost = isUnknown ? 0 : costPerItem * batchCount;

    // Pool-aware affordability check: video actions use the video credits pool
    const isVideo = isVideoAction(action);
    const balanceForCheck = isVideo ? creditsState.wallet.videoAvailable : effectiveAvailable;

    // Three states:
    //   isChecking = true  → wallet or costs not yet loaded (show neutral/loading)
    //   hasCreds   = true  → confirmed affordable
    //   hasCreds   = false → confirmed insufficient
    const walletKnown = creditsState.loaded || creditsState.wallet.available > 0 || creditsState.wallet.videoAvailable > 0;
    const isChecking = isUnknown || !walletKnown;
    const hasCreds = isChecking ? true : balanceForCheck >= totalCost;

    // Find the .gen-credits span in the same footer card
    const footerCard = btn.closest('.gen-footer-card');
    if (footerCard) {
      const creditsSpan = footerCard.querySelector('.gen-credits');
      if (creditsSpan) {
        // Show "…" while checking, otherwise show the cost
        if (isChecking) {
          creditsSpan.textContent = '…';
          creditsSpan.title = 'Checking credits…';
          creditsSpan.classList.remove('insufficient');
        } else {
          // Show batch multiplier if > 1
          const costText = batchCount > 1
            ? `${costPerItem} × ${batchCount} = ${totalCost}`
            : `${totalCost}`;
          creditsSpan.innerHTML = `<i class="fa-solid fa-coins"></i> ${costText}`;
          creditsSpan.classList.toggle('insufficient', !hasCreds);
        }
      }
    }

    // Add/update insufficient state on button
    btn.classList.toggle('insufficient-credits', !hasCreds);

    // Disable button when insufficient credits
    // Only manage the disabled state for credits - don't override other reasons
    const currentlyDisabledForCredits = btn.getAttribute('data-disabled-reason') === 'insufficient-credits';
    const hasOtherDisabledReason = btn.disabled && !currentlyDisabledForCredits;

    if (!hasCreds) {
      btn.setAttribute('data-disabled-reason', 'insufficient-credits');
      btn.disabled = true;
    } else if (currentlyDisabledForCredits) {
      // Only re-enable if we were the ones who disabled it
      btn.removeAttribute('data-disabled-reason');
      if (!hasOtherDisabledReason) {
        btn.disabled = false;
      }
    }

    // Update tooltip with clear message about required credits
    btn.setAttribute('data-credits', isChecking ? '' : totalCost);
    if (isChecking) {
      btn.setAttribute('title', 'Checking credits…');
    } else if (!hasCreds) {
      // Ensure missing is never negative — use correct pool for message
      const missing = Math.max(0, totalCost - balanceForCheck);
      const poolLabel = isVideo ? 'video credits' : 'credits';
      btn.setAttribute('title', `You need ${totalCost} ${poolLabel} to generate this. (${missing} more needed)`);
    } else {
      btn.setAttribute('title', `${totalCost} credits`);
    }

    // Add cost badge to button (show "…" for checking, "—" for truly unknown, cost for known)
    let costBadge = btn.querySelector('.btn-cost-badge');
    if (isChecking || totalCost > 0) {
      if (!costBadge) {
        costBadge = document.createElement('span');
        costBadge.className = 'btn-cost-badge';
        btn.appendChild(costBadge);
      }
      if (isChecking) {
        costBadge.textContent = '…';
        costBadge.classList.add('unknown');
        costBadge.classList.remove('insufficient', 'has-batch');
      } else {
        // Show batch multiplier in badge if > 1
        costBadge.textContent = batchCount > 1 ? `${totalCost}` : totalCost;
        costBadge.classList.toggle('insufficient', !hasCreds);
        costBadge.classList.toggle('has-batch', batchCount > 1);
        costBadge.classList.remove('unknown');
      }
    } else if (costBadge) {
      costBadge.remove();
    }
  });
}

/**
 * Setup batch count input listeners to update costs dynamically
 */
function setupBatchCountListeners() {
  // Find all batch count inputs
  const batchInputIds = [...new Set(
    Object.values(BUTTON_CONFIG)
      .map(c => c.batchInput)
      .filter(Boolean)
  )];

  batchInputIds.forEach(inputId => {
    const input = document.getElementById(inputId);
    if (!input) return;

    // Update costs when value changes
    const updateHandler = () => {
      log('[Credits] Batch count changed:', inputId, input.value);
      updateGenerateButtonCosts();
    };

    input.addEventListener('input', updateHandler);
    input.addEventListener('change', updateHandler);

    // Note: Stepper buttons are handled by 3dprint-app.js which dispatches
    // change events that we listen to above. No duplicate handlers needed.
  });

  log('[Credits] Batch count listeners setup for:', batchInputIds);
}

/**
 * Show insufficient credits message and redirect to pricing
 */
export function showInsufficientCreditsMessage(action) {
  const cost = getActionCost(action);
  const available = creditsState.wallet.available;
  const needed = Math.max(0, cost - available);

  log('[Credits] Insufficient credits:', { action, cost, available, needed });

  // Check if we're on hub.html with the buy modal
  const hubBuyModal = document.getElementById('buyCreditsModal');
  if (hubBuyModal && window.TimrXCredits?.openModal) {
    window.TimrXCredits.openModal();
    return;
  }

  // Styled modal fallback (same design as the video credits modal in api.js)
  _showStyledCreditsModal(cost, available, needed);
}

/**
 * Dynamically-created styled modal for general insufficient credits.
 * Used when the DOM-based modal and hub buy modal are both unavailable.
 */
function _showStyledCreditsModal(required, available, needed) {
  const closeModal = () => {
    const m = document.getElementById('insufficientGeneralCreditsModal');
    if (m) m.remove();
    document.removeEventListener('keydown', escHandler);
  };
  window._closeGeneralCreditsModal = closeModal;

  document.getElementById('insufficientGeneralCreditsModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'insufficientGeneralCreditsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  modal.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999999;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 700px at 50% 10%,rgba(255,255,255,.06),transparent 60%),rgba(0,0,0,.75);backdrop-filter:blur(10px) saturate(120%);-webkit-backdrop-filter:blur(10px) saturate(120%);margin:0;padding:0';

  modal.innerHTML = `
    <div style="max-width:420px;text-align:center;padding:32px;position:relative;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(0,0,0,0)),#0f0f0f;border:1px solid rgba(255,255,255,.14);border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)">
      <button onclick="window._closeGeneralCreditsModal()" aria-label="Close" style="position:absolute;top:12px;right:12px;background:transparent;border:0;color:#cfcfcf;font-size:22px;line-height:1;cursor:pointer;padding:6px;border-radius:10px">&times;</button>
      <div style="width:72px;height:72px;margin:0 auto 20px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08)">
        <i class="fa-solid fa-coins" style="font-size:28px;color:#f0f0f0" aria-hidden="true"></i>
      </div>
      <h4 style="margin:0 0 16px;font-family:'Bebas Neue',system-ui,sans-serif;font-size:28px;letter-spacing:.5px;color:#f5f5f5">Not Enough Credits</h4>
      <p style="margin:0 0 20px;color:rgba(255,255,255,.72);font-size:15px;line-height:1.6">
        This action requires <strong style="color:#f0f0f0">${required}</strong> credits.<br>
        You currently have <strong style="color:#f0f0f0">${available}</strong> credits.
      </p>
      <div style="margin:0 0 24px;padding:14px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px">
        <span style="font-size:14px;color:rgba(255,255,255,.6)">You need </span>
        <strong style="color:#f0f0f0;font-size:15px">${needed}</strong>
        <span style="font-size:14px;color:rgba(255,255,255,.6)"> more credits to continue.</span>
      </div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button onclick="window._closeGeneralCreditsModal()" style="padding:14px 24px;background:transparent;border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.72);border-radius:12px;cursor:pointer;font-weight:600;font-size:14px">Cancel</button>
        <a href="/hub#pricing" style="padding:14px 24px;background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,0)),#1a1a1a;border:1px solid rgba(255,255,255,.18);color:#f5f5f5;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 8px 20px rgba(0,0,0,.4)">Buy Credits</a>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', escHandler);
}

// ============================================================================
// SIMPLE CLIENT API (credits-client interface)
// ============================================================================

/**
 * Initialize credits UI - loads current credits from backend and renders
 * Alias for initCredits() with a clearer name
 */
export async function initCreditsUI() {
  return initCredits();
}

/**
 * Get current cached numeric balance
 * @returns {number} Current available credits
 */
export function getCredits() {
  return creditsState.wallet.available;
}

/**
 * Set credits balance directly and update UI
 * @param {number} n - New balance to set
 */
export function setCredits(n) {
  const balance = Math.max(0, Math.floor(n));
  creditsState.wallet.available = balance;
  creditsState.wallet.balance = balance;
  creditsState.lastServerBalance = balance;
  // Cache for next page load
  cacheCreditsBalance(balance);
  log('[Credits] setCredits:', balance);
  updateCreditsUI();
}

/**
 * Apply a delta (positive or negative) to credits with tracking
 * Used for optimistic updates with reason/job tracking
 *
 * @param {number} delta - Amount to add (positive) or subtract (negative)
 * @param {string} reason - Reason for the change (e.g., 'text_to_3d', 'purchase')
 * @param {string} jobId - Optional job ID for idempotency tracking
 * @returns {{ id: string, previousBalance: number, newBalance: number }}
 */
export function applyDelta(delta, reason = 'unknown', jobId = null) {
  // Idempotency: skip if this jobId was already charged (prevents double-click/retry duplicates)
  if (jobId && delta < 0 && chargedJobs.has(jobId)) {
    log('[Credits] applyDelta: skipping duplicate charge for jobId:', jobId);
    return {
      id: jobId,
      previousBalance: creditsState.wallet.available,
      newBalance: creditsState.wallet.available,
      skipped: true,
    };
  }

  const previousBalance = creditsState.wallet.available;
  const deductionId = jobId || `delta_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

  // Track this change
  const change = {
    id: deductionId,
    amount: Math.abs(delta),
    delta,
    reason,
    jobId,
    timestamp: Date.now(),
  };

  if (delta < 0) {
    // Deduction - track as pending
    creditsState.pendingDeductions.push(change);
    // Mark this jobId as charged for idempotency
    if (jobId) {
      chargedJobs.add(jobId);
    }
  }

  // Store last server balance if not set
  if (creditsState.lastServerBalance === null) {
    creditsState.lastServerBalance = previousBalance;
  }

  // Apply delta
  const newBalance = Math.max(0, previousBalance + delta);
  creditsState.wallet.available = newBalance;
  creditsState.wallet.balance = newBalance;

  log('[Credits] applyDelta:', {
    id: deductionId,
    delta,
    reason,
    jobId,
    balance: `${previousBalance} → ${newBalance}`,
  });

  // Update UI immediately
  updateCreditsUI();

  return {
    id: deductionId,
    previousBalance,
    newBalance,
  };
}

/**
 * Refresh credits from server - calls GET /api/credits/wallet
 * Single-flight: returns existing promise if already in flight
 * Sets exact server balance, clearing any optimistic state
 * @returns {Promise<number>} The server balance
 */
export async function refreshCredits() {
  // Single-flight guard: return existing promise if already refreshing
  if (refreshInFlight) {
    log('[Credits] refreshCredits already in flight, returning existing promise');
    return refreshInFlight;
  }

  const url = `${BACKEND}/api/credits/wallet`;
  log('[Credits] Refreshing from:', url);

  // Show syncing indicator
  creditsState.loading = true;
  updateCreditsUI();

  refreshInFlight = (async () => {
    try {
      const result = await apiFetch('/api/credits/wallet', {
        cache: 'no-store',
        keepalive: true,
      });

      if (!result.ok) {
        log('[Credits] refreshCredits failed:', result.status, result.error);
        pendingRetry = true;
        // Fall back to /api/me
        return fetchWallet().then(() => creditsState.wallet.available);
      }

      const data = result.data;
      log('[Credits] /api/credits/wallet response:', data);

      if (data.ok && typeof data.credits_balance === 'number') {
        const serverBalance = data.credits_balance;
        const serverReserved = data.reserved_credits || 0;
        const serverAvailable = typeof data.available_credits === 'number'
          ? data.available_credits
          : Math.max(0, serverBalance - serverReserved);

        // Video credits (separate pool)
        const videoBalance = data.video_credits_balance ?? 0;
        const videoReserved = data.video_reserved_credits ?? 0;
        const videoAvailable = typeof data.video_available_credits === 'number'
          ? data.video_available_credits
          : Math.max(0, videoBalance - videoReserved);

        // Server is truth - use server's available (accounts for backend reservations)
        creditsState.pendingDeductions = [];
        creditsState.wallet.balance = serverBalance;
        creditsState.wallet.reserved = serverReserved;
        creditsState.wallet.available = serverAvailable;
        creditsState.wallet.videoBalance = videoBalance;
        creditsState.wallet.videoReserved = videoReserved;
        creditsState.wallet.videoAvailable = videoAvailable;
        creditsState.lastServerBalance = serverBalance;

        // Server's available_credits already accounts for all backend reservations.
        // Clear client-side reservations to avoid double-counting.
        creditsState.reservations.clear();
        creditsState.totalReserved = 0;

        if (data.identity_id) {
          creditsState.identityId = data.identity_id;
        }

        log('[Credits] Video credits: balance=%d, reserved=%d, available=%d',
            videoBalance, videoReserved, videoAvailable);

        // Cache available for next page load (not raw balance)
        cacheCreditsBalance(serverAvailable, videoAvailable);

        // Also write to cross-page wallet cache
        if (data.identity_id) {
          writeWalletCache(data.identity_id, serverAvailable);
        }

        pendingRetry = false; // Clear retry flag on success
        lastRefreshTime = Date.now(); // Track for visibility throttling

        // Update global session info
        updateSessionInfo({ ok: true, identity_id: data.identity_id, available_credits: serverAvailable }, 'workspace');

        log('[Credits] Refreshed from server: balance=%d, reserved=%d, available=%d',
            serverBalance, serverReserved, serverAvailable);
        updateCreditsUI();
        return serverAvailable;
      }

      // Fallback to /api/me if response format unexpected
      return fetchWallet().then(() => creditsState.wallet.available);
    } catch (err) {
      log('[Credits] refreshCredits error:', err.message);
      // Keep cached balance on timeout, schedule retry on focus
      pendingRetry = true;
      return creditsState.wallet.available;
    } finally {
      // Hide syncing indicator and clear single-flight guard
      creditsState.loading = false;
      refreshInFlight = null;
      updateCreditsUI();
    }
  })();

  return refreshInFlight;
}

// ============================================================================
// BACKEND SYNC HELPERS
// ============================================================================

/**
 * Force sync with backend - ALWAYS trusts backend over local state.
 * Use this after job completion (success or failure) to ensure UI matches DB.
 *
 * If backend returns a different balance than local, backend wins.
 * This prevents "snap back" issues where optimistic updates diverge from reality.
 *
 * @returns {Promise<number>} The authoritative server balance
 */
export async function syncWithBackend() {
  log('[Credits] syncWithBackend: Forcing reconciliation with backend (backend is truth)');

  // Clear any pending deductions - we're about to get authoritative balance
  creditsState.pendingDeductions = [];

  // Refresh from server - refreshCredits already treats server as truth
  const serverBalance = await refreshCredits();

  log('[Credits] syncWithBackend: Authoritative balance from backend:', serverBalance);
  return serverBalance;
}

/**
 * Apply backend balance immediately if returned in API response.
 * Call this whenever an API response includes new_balance.
 *
 * @param {number} newBalance - The new_balance from backend response
 * @param {string} source - Where this balance came from (for logging)
 */
export function applyBackendBalance(newBalance, source = 'api_response') {
  if (typeof newBalance !== 'number' || isNaN(newBalance)) {
    log('[Credits] applyBackendBalance: Invalid balance, ignoring:', newBalance);
    return;
  }

  const previousBalance = creditsState.wallet.available;
  const balance = Math.max(0, Math.floor(newBalance));

  // Clear pending deductions and client-side reservations - backend balance is authoritative
  creditsState.pendingDeductions = [];
  creditsState.reservations.clear();
  creditsState.totalReserved = 0;

  // Apply backend balance
  creditsState.wallet.available = balance;
  creditsState.wallet.balance = balance;
  creditsState.lastServerBalance = balance;
  creditsState.serverConfirmed = true;

  // Cache for next page load
  cacheCreditsBalance(balance);

  log(`[Credits] applyBackendBalance (${source}): ${previousBalance} → ${balance} (backend is truth)`);
  updateCreditsUI();
}

// ============================================================================
// IDEMPOTENCY HELPERS
// ============================================================================

/**
 * Clear charged jobs set (useful for testing or session reset)
 */
export function clearChargedJobs() {
  chargedJobs.clear();
  log('[Credits] Cleared chargedJobs set');
}

/**
 * Check if a job ID has already been charged
 */
export function isJobCharged(jobId) {
  return chargedJobs.has(jobId);
}

// ============================================================================
// EXPORTS FOR GLOBAL ACCESS
// ============================================================================

/**
 * Get the current identity ID (for debugging)
 */
export function getIdentityId() {
  return creditsState.identityId;
}

/**
 * Check if the current user can download assets.
 * Requires: wallet loaded AND (general credits > 0 OR video credits > 0).
 * Unauthenticated/zero-credit users are blocked.
 */
export function canDownloadAssets() {
  if (!creditsState.loaded) return false;
  const totalAvailable = (creditsState.wallet.available || 0)
    + (creditsState.wallet.videoAvailable || 0);
  return totalAvailable > 0;
}

/**
 * Show a pool-aware modal when downloads are blocked due to zero available credits.
 * Downloads do not consume a specific action cost here, but the modal still keeps
 * general and video balances separate so the user can see both pools clearly.
 *
 * @param {string} assetType - model | image | video | sprite | asset
 */
export function showDownloadAccessRequiredMessage(assetType = 'asset') {
  const normalizedType = String(assetType || 'asset').toLowerCase();
  const isVideoAsset = normalizedType === 'video';
  const assetLabel = {
    model: '3D model',
    image: 'image',
    video: 'video',
    sprite: 'sprite sheet',
    asset: 'asset',
  }[normalizedType] || 'asset';

  const generalAvailable = Number(creditsState.wallet.available) || 0;
  const videoAvailable = Number(creditsState.wallet.videoAvailable) || 0;
  const balanceKnown = !!creditsState.loaded;

  const closeModal = () => {
    const modal = document.getElementById('downloadAccessCreditsModal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', escHandler);
  };
  const escHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };

  window._closeDownloadAccessCreditsModal = closeModal;
  document.getElementById('downloadAccessCreditsModal')?.remove();

  const generalDisplay = balanceKnown ? generalAvailable : '—';
  const videoDisplay = balanceKnown ? videoAvailable : '—';
  const statusLine = balanceKnown
    ? `You currently have <strong style="color:#f0f0f0">${generalDisplay}</strong> general credits and <strong style="color:#f0f0f0">${videoDisplay}</strong> video credits.`
    : `We couldn't confirm your balances yet. Refresh your wallet or open pricing to continue.`;
  const helperLine = isVideoAsset
    ? 'Video generation still uses the separate video credits pool.'
    : 'General and video credits remain separate in the workspace.';

  const modal = document.createElement('div');
  modal.id = 'downloadAccessCreditsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-labelledby', 'downloadAccessCreditsTitle');
  modal.setAttribute('aria-modal', 'true');
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999999;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 700px at 50% 10%,rgba(255,255,255,.06),transparent 60%),rgba(0,0,0,.75);backdrop-filter:blur(10px) saturate(120%);-webkit-backdrop-filter:blur(10px) saturate(120%);margin:0;padding:0';
  modal.innerHTML = `
    <div style="max-width:440px;text-align:center;padding:32px;position:relative;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(0,0,0,0)),#0f0f0f;border:1px solid rgba(255,255,255,.14);border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.50),inset 0 1px 0 rgba(255,255,255,.10)">
      <button onclick="window._closeDownloadAccessCreditsModal()" aria-label="Close" style="position:absolute;top:12px;right:12px;background:transparent;border:0;color:#cfcfcf;font-size:22px;line-height:1;cursor:pointer;padding:6px;border-radius:10px">&times;</button>
      <div style="width:72px;height:72px;margin:0 auto 20px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08)">
        <i class="fa-solid fa-download" style="font-size:28px;color:#f0f0f0" aria-hidden="true"></i>
      </div>
      <h4 id="downloadAccessCreditsTitle" style="margin:0 0 16px;font-family:'Bebas Neue',system-ui,sans-serif;font-size:28px;letter-spacing:.5px;color:#f5f5f5">Credits Required</h4>
      <p style="margin:0 0 16px;color:rgba(255,255,255,.72);font-size:15px;line-height:1.6">
        ${assetLabel.charAt(0).toUpperCase() + assetLabel.slice(1)} downloads are available once your account has an active credit balance.
      </p>
      <p style="margin:0 0 20px;color:rgba(255,255,255,.64);font-size:14px;line-height:1.6">
        ${statusLine}
      </p>
      <div style="margin:0 0 18px;padding:14px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;text-align:left">
        <div style="display:flex;justify-content:space-between;gap:16px;font-size:14px;color:rgba(255,255,255,.7);margin-bottom:8px">
          <span>General credits</span>
          <strong style="color:#f0f0f0">${generalDisplay}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;gap:16px;font-size:14px;color:rgba(255,255,255,.7)">
          <span>Video credits</span>
          <strong style="color:#f0f0f0">${videoDisplay}</strong>
        </div>
      </div>
      <p style="margin:0 0 24px;color:rgba(255,255,255,.56);font-size:13px;line-height:1.5">
        ${helperLine}
      </p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button onclick="window._closeDownloadAccessCreditsModal()" style="padding:14px 24px;background:transparent;border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.72);border-radius:12px;cursor:pointer;font-weight:600;font-size:14px">Cancel</button>
        <a href="/hub#pricing" id="downloadAccessCreditsCtaBtn" style="padding:14px 24px;background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,0)),#1a1a1a;border:1px solid rgba(255,255,255,.18);color:#f5f5f5;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 8px 20px rgba(0,0,0,.4)">Get Credits</a>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', escHandler);
  document.getElementById('downloadAccessCreditsCtaBtn')?.focus();
}

// Expose globally for backward compatibility and cross-module access
window.WorkspaceCredits = {
  // Original API
  init: initCredits,
  refresh: fetchWallet,
  getWallet,
  getAvailableCredits,
  getActionCost,
  resolveCost,  // New: returns null for unknown actions (vs 0)
  getActionCosts,
  hasCreditsFor,
  updateWallet,
  updateUI: updateCreditsUI,
  updateButtonCosts: updateGenerateButtonCosts,
  setupBatchListeners: setupBatchCountListeners,
  showInsufficientCreditsMessage,
  isLoaded,
  isBalanceConfirmed,
  getConfirmedBalance,
  getIdentityId,
  canDownloadAssets,
  showDownloadAccessRequiredMessage,
  // Video credits API (separate pool)
  getVideoCredits,
  getVideoWallet,
  hasVideoCredits,
  isVideoAction,
  showInsufficientVideoCreditsMessage,
  // Video variant costs (backend-driven)
  getVideoActionCode,
  getVideoCreditCost,
  // Optimistic update functions
  deductOptimistic,
  reconcile,
  rollback,
  clearPending,
  getPendingAmount,
  // Reservation functions (hold credits during generation)
  reserveCredits,
  reserveAmount,
  confirmReservation,
  releaseReservation,
  getTotalReserved,
  getEffectiveAvailable,
  hasEffectiveCreditsFor,
  // Simple client API (credits-client interface)
  initCreditsUI,
  getCredits,
  setCredits,
  applyDelta,
  refreshCredits,
  // Backend sync (force reconciliation - backend is truth)
  syncWithBackend,
  applyBackendBalance,
  // Idempotency helpers
  clearChargedJobs,
  isJobCharged,
  // Early render (for external use if needed)
  renderCachedCreditsEarly,
};

// Standardized ready flag for diagnostics (workspace page)
window.__TIMRX_CREDITS_READY__ = true;
window.__TIMRX_CREDITS_PAGE__ = 'workspace';
console.log('[Credits] Workspace credits module ready');

// ============================================================================
// IMMEDIATE EXECUTION: Render cached credits ASAP
// ============================================================================

// Run early render immediately when module loads - don't wait for initCredits()
// This provides instant visual feedback using the last known balance
renderCachedCreditsEarly();

// ============================================================================
// VISIBILITY & FOCUS: Refresh credits when tab becomes visible/focused
// ============================================================================

/**
 * Refresh credits if enough time has passed since last refresh
 * Used for focus/visibility events to catch up after payments or generation
 */
const _APP_START_TIME = Date.now();
const _STARTUP_GRACE_MS = 10000; // Skip visibility refreshes for 10s after load

function maybeRefreshOnVisibility() {
  // Grace period: don't fire during startup — bootstrap handles the initial fetch
  if (Date.now() - _APP_START_TIME < _STARTUP_GRACE_MS) return;

  const now = Date.now();
  const timeSinceLastRefresh = now - lastRefreshTime;

  // Skip if already refreshing or too soon
  if (refreshInFlight || walletFetchInFlight) {
    log('[Credits] Skipping visibility refresh - already in flight');
    return;
  }

  // Refresh if pending retry OR enough time has passed (to catch payments in other tabs)
  if (pendingRetry || timeSinceLastRefresh > MIN_REFRESH_INTERVAL_MS) {
    log('[Credits] Visibility/focus refresh triggered');
    pendingRetry = false;
    lastRefreshTime = now;
    refreshCredits().catch(err => {
      log('[Credits] Visibility refresh failed:', err.message);
      pendingRetry = true;
    });
  }
}

// Refresh on window focus
window.addEventListener('focus', maybeRefreshOnVisibility);

// Refresh on visibility change (tab becomes visible)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    maybeRefreshOnVisibility();
  }
});

// ============================================================================
// CROSS-TAB SYNC: Detect wallet cache changes from hub purchases
// ============================================================================

/**
 * Listen for localStorage changes from other tabs.
 * When hub completes a purchase and writes to timrx_last_wallet,
 * this tab will detect it and refresh credits immediately.
 */
window.addEventListener('storage', (event) => {
  // Only react to wallet cache changes
  if (event.key !== 'timrx_last_wallet') return;

  log('[Credits] Cross-tab storage event detected');

  // Parse the new value
  if (event.newValue) {
    try {
      const newCache = JSON.parse(event.newValue);
      if (newCache && typeof newCache.available_credits === 'number') {
        const newCredits = newCache.available_credits;
        const currentCredits = creditsState.wallet.available;

        log('[Credits] Cross-tab wallet update:', currentCredits, '→', newCredits);

        // If credits increased (purchase in another tab), update immediately
        if (newCredits > currentCredits) {
          creditsState.wallet.available = newCredits;
          creditsState.wallet.balance = newCredits;

          // Update identity if provided
          if (newCache.identity_id) {
            creditsState.identityId = newCache.identity_id;
          }

          // Cache locally
          cacheCreditsBalance(newCredits);

          // Update UI immediately
          updateCreditsUI();

          log('[Credits] Cross-tab sync complete: credits now', newCredits);

          // Also verify with server in background (non-blocking)
          refreshCredits().catch(err => {
            log('[Credits] Background refresh after cross-tab sync failed:', err.message);
          });
        }
      }
    } catch (e) {
      log('[Credits] Failed to parse cross-tab storage value:', e.message);
    }
  }
});
