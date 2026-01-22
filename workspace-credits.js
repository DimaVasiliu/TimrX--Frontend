/**
 * workspace-credits.js
 * Manages credits/wallet state for the 3dprint.html workspace.
 * Fetches wallet balance and action costs on load, provides helpers for credit checks.
 * Uses window globals (no ES modules).
 */

(function() {
  'use strict';

  // Get dependencies from window globals
  const { BACKEND, log, apiFetch, updateSessionInfo, readWalletCache, writeWalletCache, clearWalletCache } = window.TimrX;

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
   */
  async function fetchWallet() {
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
   */
  async function fetchActionCosts() {
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
        if (costsMap['text_to_3d_generate']) costsMap['text-to-3d'] = costsMap['text_to_3d_generate'];
        if (costsMap['image_to_3d_generate']) costsMap['image-to-3d'] = costsMap['image_to_3d_generate'];
        if (costsMap['image_studio_generate']) costsMap['text-to-image'] = costsMap['image_studio_generate'];

        creditsState.actionCosts = costsMap;
        log('[Credits] Action costs loaded:', creditsState.actionCosts);
      } else if (data.costs) {
        // Handle old object format (backward compatibility)
        creditsState.actionCosts = data.costs;
      } else {
        creditsState.actionCosts = getDefaultActionCosts();
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
   */
  function getDefaultActionCosts() {
    return {
      // === Core 3D generation ===
      'text_to_3d': 20,
      'text-to-3d': 20,
      'preview': 20,
      'image_to_3d': 30,
      'image-to-3d': 30,
      // === Post-processing ===
      'texture': 15,
      'remesh': 10,
      'refine': 10,
      'rig': 25,
      'upscale': 10,
      // === Image generation ===
      'image_generate': 10,
      'text-to-image': 10,
      // === Video generation ===
      'video': 60,
      'video_generate': 60,
      // === Backend DB action codes ===
      'MESHY_TEXT_TO_3D': 20,
      'MESHY_IMAGE_TO_3D': 30,
      'MESHY_RETEXTURE': 15,
      'MESHY_REFINE': 10,
      'MESHY_RIG': 25,
      'OPENAI_IMAGE': 10,
      'VIDEO_GENERATE': 60,
      // === Legacy keys ===
      'text_to_3d_generate': 20,
      'image_to_3d_generate': 30,
      'image_studio_generate': 10,
    };
  }

  /**
   * Initialize credits - fetch wallet and action costs
   */
  async function initCredits() {
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

  function getActionCost(action) {
    return creditsState.actionCosts[action] || 0;
  }

  function hasCreditsFor(action) {
    const cost = getActionCost(action);
    return creditsState.wallet.available >= cost;
  }

  function getAvailableCredits() {
    return creditsState.wallet.available;
  }

  function getWallet() {
    return { ...creditsState.wallet };
  }

  function getActionCosts() {
    return { ...creditsState.actionCosts };
  }

  function isLoaded() {
    return creditsState.loaded;
  }

  // ============================================================================
  // OPTIMISTIC UPDATES
  // ============================================================================

  function generateDeductionId() {
    return `deduct_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  function deductOptimistic(action, count = 1) {
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

    creditsState.pendingDeductions.push(deduction);

    if (creditsState.lastServerBalance === null) {
      creditsState.lastServerBalance = creditsState.wallet.available;
    }

    creditsState.wallet.available = Math.max(0, creditsState.wallet.available - totalCost);
    creditsState.wallet.balance = Math.max(0, creditsState.wallet.balance - totalCost);

    log('[Credits] Optimistic deduct:', {
      id: deductionId,
      action,
      cost: totalCost,
      newAvailable: creditsState.wallet.available,
    });

    updateCreditsUI();

    return { id: deductionId, amount: totalCost };
  }

  function reconcile(serverBalance, deductionId = null) {
    log('[Credits] Reconciling with server balance:', serverBalance);

    if (deductionId) {
      creditsState.pendingDeductions = creditsState.pendingDeductions.filter(
        d => d.id !== deductionId
      );
    } else {
      creditsState.pendingDeductions = [];
    }

    creditsState.wallet.available = serverBalance;
    creditsState.wallet.balance = serverBalance;
    creditsState.lastServerBalance = serverBalance;

    cacheCreditsBalance(serverBalance);

    log('[Credits] Reconciled:', {
      balance: serverBalance,
      pendingCount: creditsState.pendingDeductions.length,
    });

    updateCreditsUI();
  }

  function rollback(deductionId) {
    const deductionIndex = creditsState.pendingDeductions.findIndex(
      d => d.id === deductionId
    );

    if (deductionIndex === -1) {
      log('[Credits] Rollback: deduction not found', deductionId);
      return;
    }

    const deduction = creditsState.pendingDeductions[deductionIndex];

    creditsState.pendingDeductions.splice(deductionIndex, 1);

    creditsState.wallet.available += deduction.amount;
    creditsState.wallet.balance += deduction.amount;

    log('[Credits] Rolled back:', {
      id: deductionId,
      amount: deduction.amount,
      newAvailable: creditsState.wallet.available,
    });

    updateCreditsUI();
  }

  function clearPending() {
    creditsState.pendingDeductions = [];
    log('[Credits] Cleared all pending deductions');
  }

  function getPendingAmount() {
    return creditsState.pendingDeductions.reduce((sum, d) => sum + d.amount, 0);
  }

  // ============================================================================
  // CREDIT RESERVATIONS
  // ============================================================================

  function reserveCredits(action, count = 1) {
    const costPerItem = getActionCost(action);
    const totalCost = costPerItem * count;

    if (totalCost === 0) {
      log('[Credits] Reserve: action has no cost', action);
      return { reservationId: null, amount: 0 };
    }

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

    creditsState.reservations.set(reservationId, reservation);
    creditsState.totalReserved += totalCost;

    log('[Credits] Reserved:', {
      reservationId,
      action,
      amount: totalCost,
      totalReserved: creditsState.totalReserved,
      effectiveAvailable: creditsState.wallet.available - creditsState.totalReserved,
    });

    updateCreditsUI();

    return { reservationId, amount: totalCost };
  }

  function confirmReservation(reservationId, jobId) {
    const reservation = creditsState.reservations.get(reservationId);
    if (!reservation) {
      log('[Credits] confirmReservation: not found', reservationId);
      return;
    }

    creditsState.reservations.delete(reservationId);
    creditsState.totalReserved -= reservation.amount;

    applyDelta(-reservation.amount, reservation.action, jobId);

    log('[Credits] Reservation confirmed:', {
      reservationId,
      jobId,
      amount: reservation.amount,
      newBalance: creditsState.wallet.available,
    });
  }

  function releaseReservation(reservationId) {
    const reservation = creditsState.reservations.get(reservationId);
    if (!reservation) {
      log('[Credits] releaseReservation: not found', reservationId);
      return;
    }

    creditsState.reservations.delete(reservationId);
    creditsState.totalReserved -= reservation.amount;

    log('[Credits] Reservation released:', {
      reservationId,
      amount: reservation.amount,
      totalReserved: creditsState.totalReserved,
    });

    updateCreditsUI();
  }

  function getTotalReserved() {
    return creditsState.totalReserved;
  }

  function getEffectiveAvailable() {
    return Math.max(0, creditsState.wallet.available - creditsState.totalReserved);
  }

  function hasEffectiveCreditsFor(action, count = 1) {
    const cost = getActionCost(action) * count;
    return getEffectiveAvailable() >= cost;
  }

  // ============================================================================
  // WALLET STATE MANAGEMENT
  // ============================================================================

  function updateWallet(wallet) {
    if (wallet) {
      const available = wallet.available ?? Math.max(0, (wallet.balance || 0) - (wallet.reserved || 0));
      creditsState.wallet = {
        balance: wallet.balance || 0,
        reserved: wallet.reserved || 0,
        available,
      };
      cacheCreditsBalance(available);
      updateCreditsUI();
      log('[Credits] Wallet updated:', creditsState.wallet);
    }
  }

  // ============================================================================
  // UI UPDATES
  // ============================================================================

  function updateCreditsUI() {
    const creditsPill = document.getElementById('workspaceCredits');
    const creditsValue = document.getElementById('workspaceCreditsValue');
    const creditsGroup = document.getElementById('workspaceCreditsGroup');
    const reservedIndicator = document.getElementById('workspaceCreditsReserved');

    const effectiveAvailable = getEffectiveAvailable();
    const hasReservations = creditsState.totalReserved > 0;

    if (creditsValue) {
      creditsValue.textContent = effectiveAvailable.toLocaleString();
    }

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

      if (!creditsPill.dataset.clickWired) {
        creditsPill.dataset.clickWired = 'true';
        creditsPill.style.cursor = 'pointer';
        creditsPill.addEventListener('click', () => {
          window.location.href = 'hub.html#pricing';
        });
      }

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

    const isSyncing = creditsState.loading && !creditsState.loaded;
    const wasSyncing = creditsPill?.classList.contains('syncing');

    if (creditsGroup) {
      creditsGroup.classList.toggle('syncing', isSyncing);
    }
    if (creditsPill) {
      creditsPill.classList.toggle('syncing', isSyncing);

      if (wasSyncing && !isSyncing && creditsState.loaded) {
        creditsPill.classList.add('just-synced');
        setTimeout(() => creditsPill.classList.remove('just-synced'), 1200);
      }
    }

    updateGenerateButtonCosts();
  }

  const BUTTON_CONFIG = {
    'generateModelBtn': { action: 'text-to-3d', batchInput: 'modelBatchCount' },
    'generateImageBtn': { action: 'text-to-image', batchInput: null },
    'imageTo3dBtn': { action: 'image-to-3d', batchInput: null },
    'generateTextureBtn': { action: 'texture', batchInput: null },
    'applyRemeshBtn': { action: 'remesh', batchInput: null },
    'applyRefineBtn': { action: 'refine', batchInput: null },
    'applyRigBtn': { action: 'rig', batchInput: null },
    'applyUpscaleBtn': { action: 'upscale', batchInput: null },
    'generateVideoBtn': { action: 'video', batchInput: null },
  };

  function getBatchCountForButton(btnId) {
    const config = BUTTON_CONFIG[btnId];
    if (!config?.batchInput) return 1;

    const input = document.getElementById(config.batchInput);
    if (!input) return 1;

    const val = parseInt(input.value, 10);
    return Number.isFinite(val) && val > 0 ? Math.min(val, 4) : 1;
  }

  function updateGenerateButtonCosts() {
    const effectiveAvailable = getEffectiveAvailable();

    Object.entries(BUTTON_CONFIG).forEach(([btnId, config]) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;

      const action = btn.dataset.currentAction || config.action;
      const batchCount = getBatchCountForButton(btnId);
      const costPerItem = getActionCost(action);
      const totalCost = costPerItem * batchCount;
      const hasCreds = effectiveAvailable >= totalCost;

      const footerCard = btn.closest('.gen-footer-card');
      if (footerCard) {
        const creditsSpan = footerCard.querySelector('.gen-credits');
        if (creditsSpan) {
          const costText = batchCount > 1
            ? `${costPerItem} × ${batchCount} = ${totalCost}`
            : `${totalCost}`;
          creditsSpan.innerHTML = `<i class="fa-solid fa-coins"></i> ${costText}`;
          creditsSpan.classList.toggle('insufficient', !hasCreds);
        }
      }

      btn.classList.toggle('insufficient-credits', !hasCreds);

      const currentlyDisabledForCredits = btn.getAttribute('data-disabled-reason') === 'insufficient-credits';
      const hasOtherDisabledReason = btn.disabled && !currentlyDisabledForCredits;

      if (!hasCreds) {
        btn.setAttribute('data-disabled-reason', 'insufficient-credits');
        btn.disabled = true;
      } else if (currentlyDisabledForCredits) {
        btn.removeAttribute('data-disabled-reason');
        if (!hasOtherDisabledReason) {
          btn.disabled = false;
        }
      }

      btn.setAttribute('data-credits', totalCost);
      if (!hasCreds) {
        const needed = totalCost - effectiveAvailable;
        btn.setAttribute('title', `You need ${totalCost} credits to generate this. (${needed} more needed)`);
      } else {
        btn.setAttribute('title', `${totalCost} credits`);
      }

      let costBadge = btn.querySelector('.btn-cost-badge');
      if (totalCost > 0) {
        if (!costBadge) {
          costBadge = document.createElement('span');
          costBadge.className = 'btn-cost-badge';
          btn.appendChild(costBadge);
        }
        costBadge.textContent = batchCount > 1 ? `${totalCost}` : totalCost;
        costBadge.classList.toggle('insufficient', !hasCreds);
        costBadge.classList.toggle('has-batch', batchCount > 1);
      } else if (costBadge) {
        costBadge.remove();
      }
    });
  }

  function setupBatchCountListeners() {
    const batchInputIds = [...new Set(
      Object.values(BUTTON_CONFIG)
        .map(c => c.batchInput)
        .filter(Boolean)
    )];

    batchInputIds.forEach(inputId => {
      const input = document.getElementById(inputId);
      if (!input) return;

      const updateHandler = () => {
        log('[Credits] Batch count changed:', inputId, input.value);
        updateGenerateButtonCosts();
      };

      input.addEventListener('input', updateHandler);
      input.addEventListener('change', updateHandler);
    });

    log('[Credits] Batch count listeners setup for:', batchInputIds);
  }

  function showInsufficientCreditsMessage(action) {
    const cost = getActionCost(action);
    const available = creditsState.wallet.available;
    const needed = cost - available;

    log('[Credits] Insufficient credits:', { action, cost, available, needed });

    const hubBuyModal = document.getElementById('buyCreditsModal');
    if (hubBuyModal && window.TimrXCredits?.openModal) {
      window.TimrXCredits.openModal();
      return;
    }

    const modal = document.getElementById('insufficientCreditsModal');
    if (!modal) {
      log('[Credits] Modal not found, using fallback');
      const msg = `Insufficient credits.\n\nYou need ${cost} credits for this action but only have ${available} available.\nYou need ${needed} more credits.`;
      if (confirm(msg + '\n\nWould you like to buy more credits?')) {
        window.location.href = 'hub.html#pricing';
      }
      return;
    }

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

    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('visible');

    const handleBuy = () => {
      closeCreditsModal();
      window.location.href = 'hub.html#pricing';
    };

    const handleCancel = () => {
      closeCreditsModal();
    };

    const handleBackdrop = (e) => {
      if (e.target === modal) {
        closeCreditsModal();
      }
    };

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        closeCreditsModal();
      }
    };

    const closeCreditsModal = () => {
      modal.setAttribute('aria-hidden', 'true');
      modal.classList.remove('visible');
      if (buyBtn) buyBtn.removeEventListener('click', handleBuy);
      if (cancelBtn) cancelBtn.removeEventListener('click', handleCancel);
      modal.removeEventListener('click', handleBackdrop);
      document.removeEventListener('keydown', handleEscape);
    };

    if (buyBtn) buyBtn.addEventListener('click', handleBuy);
    if (cancelBtn) cancelBtn.addEventListener('click', handleCancel);
    modal.addEventListener('click', handleBackdrop);
    document.addEventListener('keydown', handleEscape);
  }

  // ============================================================================
  // SIMPLE CLIENT API
  // ============================================================================

  async function initCreditsUI() {
    return initCredits();
  }

  function getCredits() {
    return creditsState.wallet.available;
  }

  function setCredits(n) {
    const balance = Math.max(0, Math.floor(n));
    creditsState.wallet.available = balance;
    creditsState.wallet.balance = balance;
    creditsState.lastServerBalance = balance;
    cacheCreditsBalance(balance);
    log('[Credits] setCredits:', balance);
    updateCreditsUI();
  }

  function applyDelta(delta, reason = 'unknown', jobId = null) {
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

    const change = {
      id: deductionId,
      amount: Math.abs(delta),
      delta,
      reason,
      jobId,
      timestamp: Date.now(),
    };

    if (delta < 0) {
      creditsState.pendingDeductions.push(change);
      if (jobId) {
        chargedJobs.add(jobId);
      }
    }

    if (creditsState.lastServerBalance === null) {
      creditsState.lastServerBalance = previousBalance;
    }

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

    updateCreditsUI();

    return {
      id: deductionId,
      previousBalance,
      newBalance,
    };
  }

  async function refreshCredits() {
    if (refreshInFlight) {
      log('[Credits] refreshCredits already in flight, returning existing promise');
      return refreshInFlight;
    }

    const url = `${BACKEND}/api/credits/wallet`;
    log('[Credits] Refreshing from:', url);

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
          return fetchWallet().then(() => creditsState.wallet.available);
        }

        const data = result.data;
        log('[Credits] /api/credits/wallet response:', data);

        if (data.ok && typeof data.credits_balance === 'number') {
          const serverBalance = data.credits_balance;

          creditsState.pendingDeductions = [];
          creditsState.wallet.available = serverBalance;
          creditsState.wallet.balance = serverBalance;
          creditsState.lastServerBalance = serverBalance;

          if (data.identity_id) {
            creditsState.identityId = data.identity_id;
          }

          cacheCreditsBalance(serverBalance);

          if (data.identity_id) {
            writeWalletCache(data.identity_id, serverBalance);
          }

          pendingRetry = false;
          lastRefreshTime = Date.now();

          updateSessionInfo({ ok: true, identity_id: data.identity_id, available_credits: serverBalance }, 'workspace');

          log('[Credits] Refreshed to server balance:', serverBalance);
          updateCreditsUI();
          return serverBalance;
        }

        return fetchWallet().then(() => creditsState.wallet.available);
      } catch (err) {
        log('[Credits] refreshCredits error:', err.message);
        pendingRetry = true;
        return creditsState.wallet.available;
      } finally {
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

  function clearChargedJobs() {
    chargedJobs.clear();
    log('[Credits] Cleared chargedJobs set');
  }

  function isJobCharged(jobId) {
    return chargedJobs.has(jobId);
  }

  function getIdentityId() {
    return creditsState.identityId;
  }

  // ============================================================================
  // EXPOSE GLOBALLY
  // ============================================================================

  window.WorkspaceCredits = {
    // Original API
    init: initCredits,
    refresh: fetchWallet,
    getWallet,
    getAvailableCredits,
    getActionCost,
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
    // Reservation functions
    reserveCredits,
    confirmReservation,
    releaseReservation,
    getTotalReserved,
    getEffectiveAvailable,
    hasEffectiveCreditsFor,
    // Simple client API
    initCreditsUI,
    getCredits,
    setCredits,
    applyDelta,
    refreshCredits,
    // Idempotency helpers
    clearChargedJobs,
    isJobCharged,
    // Early render
    renderCachedCreditsEarly,
  };

  // ============================================================================
  // IMMEDIATE EXECUTION: Render cached credits ASAP
  // ============================================================================

  renderCachedCreditsEarly();

  // ============================================================================
  // VISIBILITY & FOCUS: Refresh credits when tab becomes visible/focused
  // ============================================================================

  function maybeRefreshOnVisibility() {
    const now = Date.now();
    const timeSinceLastRefresh = now - lastRefreshTime;

    if (refreshInFlight || walletFetchInFlight) {
      log('[Credits] Skipping visibility refresh - already in flight');
      return;
    }

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

  window.addEventListener('focus', maybeRefreshOnVisibility);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      maybeRefreshOnVisibility();
    }
  });

  // ============================================================================
  // CROSS-TAB SYNC: Detect wallet cache changes from hub purchases
  // ============================================================================

  window.addEventListener('storage', (event) => {
    if (event.key !== 'timrx_wallet') return;

    log('[Credits] Cross-tab storage event detected');

    if (event.newValue) {
      try {
        const newCache = JSON.parse(event.newValue);
        if (newCache && typeof newCache.available === 'number') {
          const newCredits = newCache.available;
          const currentCredits = creditsState.wallet.available;

          log('[Credits] Cross-tab wallet update:', currentCredits, '→', newCredits);

          if (newCredits > currentCredits) {
            creditsState.wallet.available = newCredits;
            creditsState.wallet.balance = newCredits;

            if (newCache.identity_id) {
              creditsState.identityId = newCache.identity_id;
            }

            cacheCreditsBalance(newCredits);
            updateCreditsUI();

            log('[Credits] Cross-tab sync complete: credits now', newCredits);

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

})();
