/**
 * workspace-credits.js
 * Manages credits/wallet state for the 3dprint.html workspace.
 * Fetches wallet balance and action costs on load, provides helpers for credit checks.
 */

import { BACKEND, log, apiFetch, updateSessionInfo, readWalletCache, writeWalletCache, clearWalletCache } from './config.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const CREDITS_CACHE_KEY = 'timrx_credits_last';

// ============================================================================
// SINGLE-FLIGHT GUARD
// ============================================================================

// Track in-flight fetch promises to prevent duplicate requests
let walletFetchInFlight = null;
let refreshInFlight = null;
let pendingRetry = false; // Flag for window.focus retry
let lastRefreshTime = 0; // Track last refresh for visibility/focus throttling
const MIN_REFRESH_INTERVAL_MS = 5000; // Don't refresh more than once per 5s

// ============================================================================
// STATE
// ============================================================================

const creditsState = {
  wallet: {
    balance: 0,
    reserved: 0,
    available: 0,
  },
  identityId: null,
  actionCosts: {},
  loaded: false,
  loading: false,
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
  // Force refresh if coming from hub (different origin purchase flow)
  if (document.referrer && document.referrer.includes('timrx.live') && !document.referrer.includes('3d.timrx.live')) {
    log('[Credits] Force refresh: navigated from hub');
    return true;
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

  // Priority 1: Check cross-page wallet cache (fresher, from hub after purchase)
  const walletCache = readWalletCache();
  let displayValue = '—';
  let cacheSource = null;

  if (walletCache && typeof walletCache.available_credits === 'number') {
    displayValue = walletCache.available_credits.toLocaleString();
    // Pre-populate state so hasCreditsFor() works with cached value
    creditsState.wallet.available = walletCache.available_credits;
    creditsState.wallet.balance = walletCache.available_credits;
    creditsState.identityId = walletCache.identity_id || null;
    cacheSource = 'cross-page';
    log('[Credits] Early render from cross-page cache:', walletCache.available_credits);
  } else {
    // Priority 2: Fall back to local credits cache
    const cached = localStorage.getItem(CREDITS_CACHE_KEY);
    if (cached !== null) {
      const cachedBalance = parseInt(cached, 10);
      if (Number.isFinite(cachedBalance) && cachedBalance >= 0) {
        displayValue = cachedBalance.toLocaleString();
        // Pre-populate state so hasCreditsFor() works with cached value
        creditsState.wallet.available = cachedBalance;
        creditsState.wallet.balance = cachedBalance;
        cacheSource = 'local';
        log('[Credits] Early render from local cache:', cachedBalance);
      }
    }
  }

  if (!cacheSource) {
    log('[Credits] No cached balance, showing syncing placeholder');
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
function cacheCreditsBalance(balance) {
  if (typeof balance === 'number' && Number.isFinite(balance) && balance >= 0) {
    localStorage.setItem(CREDITS_CACHE_KEY, balance.toString());
    log('[Credits] Cached balance to localStorage:', balance);
  }
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
        creditsState.wallet = { balance: 0, reserved: 0, available: 0 };
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
        // Read credits from top-level fields (new format) with fallback to nested wallet object
        const balance = data.balance_credits ?? data.wallet?.balance ?? 0;
        const reserved = data.reserved_credits ?? data.wallet?.reserved ?? 0;
        const available = data.available_credits ?? data.wallet?.available ?? Math.max(0, balance - reserved);
        const serverIdentityId = data.identity_id || null;

        // Check if identity differs from cross-page cache - if so, discard cache
        const walletCache = readWalletCache();
        if (walletCache && walletCache.identity_id && serverIdentityId && walletCache.identity_id !== serverIdentityId) {
          log('[Credits] Identity mismatch - clearing cross-page cache');
          log('[Credits]   Cached:', walletCache.identity_id?.slice(0, 8) + '...');
          log('[Credits]   Server:', serverIdentityId?.slice(0, 8) + '...');
          clearWalletCache();
        }

        creditsState.wallet = { balance, reserved, available };
        creditsState.identityId = serverIdentityId;

        // Cache balance for next page load (perceived performance)
        cacheCreditsBalance(available);

        // Also write to cross-page wallet cache
        if (serverIdentityId) {
          writeWalletCache(serverIdentityId, available);
        }

        pendingRetry = false; // Clear retry flag on success
        lastRefreshTime = Date.now(); // Track for visibility throttling

        log('[Credits] Wallet loaded:', creditsState.wallet);

        // Update global session info for debugging
        updateSessionInfo(data, 'workspace');
      } else {
        log('[Credits] /api/me returned ok:false');
        creditsState.wallet = { balance: 0, reserved: 0, available: 0 };
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
 * Fetch action costs from /api/billing/action-costs
 * Response format: { ok: true, action_costs: [{ action_key: "...", credits: N }, ...] }
 */
export async function fetchActionCosts() {
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

      // Add all frontend aliases for backward compatibility
      // These ensure BUTTON_CONFIG action keys are covered
      if (costsMap['text_to_3d_generate']) {
        costsMap['text-to-3d'] = costsMap['text_to_3d_generate'];
        costsMap['text_to_3d'] = costsMap['text_to_3d_generate'];
        costsMap['preview'] = costsMap['text_to_3d_generate'];
      }
      if (costsMap['image_to_3d_generate']) {
        costsMap['image-to-3d'] = costsMap['image_to_3d_generate'];
        costsMap['image_to_3d'] = costsMap['image_to_3d_generate'];
      }
      if (costsMap['image_studio_generate']) {
        costsMap['text-to-image'] = costsMap['image_studio_generate'];
        costsMap['image_generate'] = costsMap['image_studio_generate'];
      }
      if (costsMap['refine']) {
        costsMap['upscale'] = costsMap['refine'];
      }
      if (costsMap['texture']) {
        costsMap['retexture'] = costsMap['texture'];
      }
      if (costsMap['video']) {
        costsMap['video_generate'] = costsMap['video'];
      }

      // If no costs were parsed, use defaults
      if (Object.keys(costsMap).length === 0) {
        log('[Credits] API returned empty action_costs array, using defaults');
        creditsState.actionCosts = getDefaultActionCosts();
      } else {
        creditsState.actionCosts = costsMap;
        log('[Credits] Action costs loaded:', Object.keys(costsMap).length, 'keys:', Object.keys(costsMap).join(', '));
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

    return creditsState.actionCosts;
  } catch (err) {
    log('[Credits] Action costs fetch error:', err);
    creditsState.actionCosts = getDefaultActionCosts();
    creditsState.error = err.message;
    return creditsState.actionCosts;
  }
}

/**
 * Default action costs (fallback if API unavailable)
 * Keys match backend ACTION_KEY_MAP in credits.py
 *
 * Backend mapping:
 *   text_to_3d    → MESHY_TEXT_TO_3D (20c)
 *   image_to_3d   → MESHY_IMAGE_TO_3D (30c)
 *   texture       → MESHY_RETEXTURE (15c)
 *   remesh/refine → MESHY_REFINE (10c)
 *   rig           → MESHY_RIG (25c)
 *   image_generate→ OPENAI_IMAGE (10c)
 *   video         → VIDEO_GENERATE (60c)
 *   preview       → MESHY_TEXT_TO_3D (alias, 20c)
 *   upscale       → MESHY_REFINE (alias, 10c)
 */
function getDefaultActionCosts() {
  return {
    // === Core 3D generation ===
    'text_to_3d': 20,           // Text-to-3D preview (draft)
    'text-to-3d': 20,           // Alias (hyphenated)
    'preview': 20,              // Preview is same as text_to_3d

    'image_to_3d': 30,          // Image-to-3D generation
    'image-to-3d': 30,          // Alias (hyphenated)

    // === Post-processing ===
    'texture': 15,              // Retexture a model
    'remesh': 10,               // Remesh/retopologize
    'refine': 10,               // Refine preview to full model (same as remesh)
    'rig': 25,                  // Auto-rig a humanoid
    'upscale': 10,              // Upscale (alias for refine)

    // === Image generation ===
    'image_generate': 10,       // OpenAI image generation (2D)
    'text-to-image': 10,        // Alias (hyphenated)

    // === Video generation ===
    'video': 60,                // Video generation
    'video_generate': 60,       // Alias

    // === Backend DB action codes (for direct lookups) ===
    'MESHY_TEXT_TO_3D': 20,
    'MESHY_IMAGE_TO_3D': 30,
    'MESHY_RETEXTURE': 15,
    'MESHY_REFINE': 10,
    'MESHY_RIG': 25,
    'OPENAI_IMAGE': 10,
    'VIDEO_GENERATE': 60,

    // === Legacy keys (backward compatibility) ===
    'text_to_3d_generate': 20,
    'image_to_3d_generate': 30,
    'image_studio_generate': 10,
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
    // Fetch both in parallel
    await Promise.all([
      fetchWallet(),
      fetchActionCosts(),
    ]);

    creditsState.loaded = true;
    log('[Credits] Initialization complete');

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
 * Check if user has enough credits for an action
 */
export function hasCreditsFor(action) {
  const cost = getActionCost(action);
  return creditsState.wallet.available >= cost;
}

/**
 * Get available credits
 */
export function getAvailableCredits() {
  return creditsState.wallet.available;
}

/**
 * Get wallet state
 */
export function getWallet() {
  return { ...creditsState.wallet };
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
  const effectiveAvailable = creditsState.wallet.available - creditsState.totalReserved;
  if (effectiveAvailable < totalCost) {
    log('[Credits] Reserve failed: insufficient credits', {
      action,
      required: totalCost,
      effectiveAvailable,
    });
    return { reservationId: null, amount: 0, insufficient: true };
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
  creditsState.totalReserved -= reservation.amount;

  // Apply actual deduction
  applyDelta(-reservation.amount, reservation.action, jobId);

  log('[Credits] Reservation confirmed:', {
    reservationId,
    jobId,
    amount: reservation.amount,
    newBalance: creditsState.wallet.available,
  });
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
  creditsState.totalReserved -= reservation.amount;

  log('[Credits] Reservation released:', {
    reservationId,
    amount: reservation.amount,
    totalReserved: creditsState.totalReserved,
  });

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
 * Check if enough credits for action (accounting for reservations)
 */
export function hasEffectiveCreditsFor(action, count = 1) {
  const cost = getActionCost(action) * count;
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
        window.location.href = 'hub.html#pricing';
      });
    }

    // Update tooltip based on balance and reservations
    if (effectiveAvailable === 0 && hasReservations) {
      creditsPill.setAttribute('title', `${creditsState.totalReserved} credits reserved for generation - click to buy more`);
    } else if (effectiveAvailable === 0) {
      creditsPill.setAttribute('title', 'No credits - click to buy');
    } else if (hasReservations) {
      creditsPill.setAttribute('title', `${effectiveAvailable} available (${creditsState.totalReserved} reserved)`);
    } else if (effectiveAvailable < 30) {
      creditsPill.setAttribute('title', `${effectiveAvailable} credits remaining - running low`);
    } else {
      creditsPill.setAttribute('title', `${effectiveAvailable} credits available`);
    }
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
 * Button to action mapping with associated batch count inputs
 */
const BUTTON_CONFIG = {
  // Core generation buttons
  'generateModelBtn': { action: 'text-to-3d', batchInput: 'modelBatchCount' },
  'generateImageBtn': { action: 'text-to-image', batchInput: null },
  'imageTo3dBtn': { action: 'image-to-3d', batchInput: null },
  // Post-processing buttons
  'generateTextureBtn': { action: 'texture', batchInput: null },
  'applyRemeshBtn': { action: 'remesh', batchInput: null },
  'applyRefineBtn': { action: 'refine', batchInput: null },
  'applyRigBtn': { action: 'rig', batchInput: null },
  'applyUpscaleBtn': { action: 'upscale', batchInput: null },
  'generateVideoBtn': { action: 'video', batchInput: null },
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
  // Use effective available (accounting for reservations)
  const effectiveAvailable = getEffectiveAvailable();

  Object.entries(BUTTON_CONFIG).forEach(([btnId, config]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    // Check for dynamic action override (e.g., when switching between text-to-3d and image-to-3d tabs)
    const action = btn.dataset.currentAction || config.action;
    const batchCount = getBatchCountForButton(btnId);

    // Use resolveCost to detect unknown actions (null vs 0)
    const costPerItem = resolveCost(action);
    const isUnknown = costPerItem === null;
    const totalCost = isUnknown ? 0 : costPerItem * batchCount;
    const hasCreds = isUnknown ? false : effectiveAvailable >= totalCost;

    // Find the .gen-credits span in the same footer card
    const footerCard = btn.closest('.gen-footer-card');
    if (footerCard) {
      const creditsSpan = footerCard.querySelector('.gen-credits');
      if (creditsSpan) {
        // Show "—" for unknown costs, otherwise show the cost
        if (isUnknown) {
          creditsSpan.textContent = '—';
          creditsSpan.title = `Cost unknown for action: ${action}`;
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
    btn.setAttribute('data-credits', isUnknown ? '' : totalCost);
    if (isUnknown) {
      btn.setAttribute('title', `Cost unknown for action: ${action}`);
    } else if (!hasCreds) {
      const needed = totalCost - effectiveAvailable;
      btn.setAttribute('title', `You need ${totalCost} credits to generate this. (${needed} more needed)`);
    } else {
      btn.setAttribute('title', `${totalCost} credits`);
    }

    // Add cost badge to button (show "—" for unknown, cost for known)
    let costBadge = btn.querySelector('.btn-cost-badge');
    if (isUnknown || totalCost > 0) {
      if (!costBadge) {
        costBadge = document.createElement('span');
        costBadge.className = 'btn-cost-badge';
        btn.appendChild(costBadge);
      }
      if (isUnknown) {
        costBadge.textContent = '—';
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
 * Show insufficient credits modal
 */
export function showInsufficientCreditsMessage(action) {
  const cost = getActionCost(action);
  const available = creditsState.wallet.available;
  const needed = cost - available;

  log('[Credits] Insufficient credits:', { action, cost, available, needed });

  // Check if we're on hub.html with the buy modal
  const hubBuyModal = document.getElementById('buyCreditsModal');
  if (hubBuyModal && window.TimrXCredits?.openModal) {
    window.TimrXCredits.openModal();
    return;
  }

  // Use the insufficient credits modal in 3dprint.html
  const modal = document.getElementById('insufficientCreditsModal');
  if (!modal) {
    // Fallback if modal doesn't exist
    log('[Credits] Modal not found, using fallback');
    const msg = `Insufficient credits.\n\nYou need ${cost} credits for this action but only have ${available} available.\nYou need ${needed} more credits.`;
    if (confirm(msg + '\n\nWould you like to buy more credits?')) {
      window.location.href = 'hub.html#pricing';
    }
    return;
  }

  // Populate modal values
  const messageEl = document.getElementById('creditsModalMessage');
  const requiredEl = document.getElementById('creditsModalRequired');
  const availableEl = document.getElementById('creditsModalAvailable');
  const neededEl = document.getElementById('creditsModalNeeded');
  const buyBtn = document.getElementById('creditsModalBuy');
  const cancelBtn = document.getElementById('creditsModalCancel');

  if (messageEl) {
    messageEl.textContent = `You need more credits to perform this action.`;
  }
  if (requiredEl) requiredEl.textContent = cost.toLocaleString();
  if (availableEl) availableEl.textContent = available.toLocaleString();
  if (neededEl) neededEl.textContent = needed.toLocaleString();

  // Show modal
  modal.setAttribute('aria-hidden', 'false');
  modal.classList.add('visible');

  // Handle buy button
  const handleBuy = () => {
    closeCreditsModal();
    window.location.href = 'hub.html#pricing';
  };

  // Handle cancel button
  const handleCancel = () => {
    closeCreditsModal();
  };

  // Handle backdrop click
  const handleBackdrop = (e) => {
    if (e.target === modal) {
      closeCreditsModal();
    }
  };

  // Handle escape key
  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      closeCreditsModal();
    }
  };

  // Close modal helper
  const closeCreditsModal = () => {
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove('visible');
    // Clean up event listeners
    if (buyBtn) buyBtn.removeEventListener('click', handleBuy);
    if (cancelBtn) cancelBtn.removeEventListener('click', handleCancel);
    modal.removeEventListener('click', handleBackdrop);
    document.removeEventListener('keydown', handleEscape);
  };

  // Attach event listeners
  if (buyBtn) buyBtn.addEventListener('click', handleBuy);
  if (cancelBtn) cancelBtn.addEventListener('click', handleCancel);
  modal.addEventListener('click', handleBackdrop);
  document.addEventListener('keydown', handleEscape);
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

        // Server is truth - use server's available (accounts for backend reservations)
        creditsState.pendingDeductions = [];
        creditsState.wallet.balance = serverBalance;
        creditsState.wallet.reserved = serverReserved;
        creditsState.wallet.available = serverAvailable;
        creditsState.lastServerBalance = serverBalance;

        // Clear local reservations if server has none (reconciliation)
        if (serverReserved === 0) {
          creditsState.reservations.clear();
          creditsState.totalReserved = 0;
        }

        if (data.identity_id) {
          creditsState.identityId = data.identity_id;
        }

        // Cache available for next page load (not raw balance)
        cacheCreditsBalance(serverAvailable);

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
  getIdentityId,
  // Optimistic update functions
  deductOptimistic,
  reconcile,
  rollback,
  clearPending,
  getPendingAmount,
  // Reservation functions (hold credits during generation)
  reserveCredits,
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
function maybeRefreshOnVisibility() {
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
