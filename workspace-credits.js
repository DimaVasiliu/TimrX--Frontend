/**
 * workspace-credits.js
 * Manages credits/wallet state for the 3dprint.html workspace.
 * Fetches wallet balance and action costs on load, provides helpers for credit checks.
 */

import { BACKEND, log } from './config.js';

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
};

// ============================================================================
// API FETCHING
// ============================================================================

/**
 * Fetch wallet balance from /api/me
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
  const url = `${BACKEND}/api/me`;
  log('[Credits] Fetching wallet from:', url);

  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      // Not authenticated or error - log details
      const text = await res.text().catch(() => '');
      log('[Credits] Wallet fetch failed:', res.status, text.slice(0, 200));
      creditsState.wallet = { balance: 0, reserved: 0, available: 0 };
      return creditsState.wallet;
    }

    const data = await res.json();
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

      creditsState.wallet = { balance, reserved, available };
      creditsState.identityId = data.identity_id || null;

      log('[Credits] Wallet loaded:', creditsState.wallet);
    } else {
      log('[Credits] /api/me returned ok:false');
      creditsState.wallet = { balance: 0, reserved: 0, available: 0 };
    }

    return creditsState.wallet;
  } catch (err) {
    log('[Credits] Wallet fetch error:', err);
    creditsState.wallet = { balance: 0, reserved: 0, available: 0 };
    creditsState.error = err.message;
    return creditsState.wallet;
  }
}

/**
 * Fetch action costs from /api/billing/action-costs
 * Response format: { ok: true, action_costs: [{ action_key: "...", credits: N }, ...] }
 */
export async function fetchActionCosts() {
  try {
    const res = await fetch(`${BACKEND}/api/billing/action-costs`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      log('[Credits] Action costs fetch failed:', res.status);
      creditsState.actionCosts = getDefaultActionCosts();
      return creditsState.actionCosts;
    }

    const data = await res.json();

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
 * Keys match backend ACTION_KEY_MAP in credits.py
 *
 * Backend mapping:
 *   text_to_3d    → MESHY_TEXT_TO_3D
 *   image_to_3d   → MESHY_IMAGE_TO_3D
 *   texture       → MESHY_RETEXTURE
 *   remesh/refine → MESHY_REFINE
 *   rig           → MESHY_REFINE
 *   image_generate→ OPENAI_IMAGE
 *   preview       → MESHY_TEXT_TO_3D (alias)
 *   upscale       → MESHY_REFINE (alias)
 */
function getDefaultActionCosts() {
  return {
    // === Core 3D generation ===
    'text_to_3d': 20,           // Text-to-3D preview (latest model)
    'text-to-3d': 20,           // Alias (hyphenated)
    'preview': 20,              // Preview is same as text_to_3d

    'image_to_3d': 30,          // Image-to-3D generation
    'image-to-3d': 30,          // Alias (hyphenated)

    // === Post-processing ===
    'texture': 10,              // Retexture a model
    'remesh': 10,               // Remesh/retopologize
    'refine': 10,               // Refine preview to full model
    'rig': 10,                  // Auto-rig a humanoid
    'upscale': 10,              // Upscale (alias for refine)

    // === Image generation ===
    'image_generate': 10,       // OpenAI image generation
    'text-to-image': 10,        // Alias (hyphenated)

    // === Backend DB action codes (for direct lookups) ===
    'MESHY_TEXT_TO_3D': 20,
    'MESHY_IMAGE_TO_3D': 30,
    'MESHY_RETEXTURE': 10,
    'MESHY_REFINE': 10,
    'OPENAI_IMAGE': 10,

    // === Legacy keys (backward compatibility) ===
    'text_to_3d_generate': 20,
    'image_to_3d_generate': 30,
    'image_studio_generate': 10,
  };
}

/**
 * Initialize credits - fetch wallet and action costs
 */
export async function initCredits() {
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

/**
 * Get cost for a specific action
 */
export function getActionCost(action) {
  return creditsState.actionCosts[action] || 0;
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
// WALLET STATE MANAGEMENT
// ============================================================================

/**
 * Update wallet after a successful operation (e.g., after job completion)
 */
export function updateWallet(wallet) {
  if (wallet) {
    creditsState.wallet = {
      balance: wallet.balance || 0,
      reserved: wallet.reserved || 0,
      available: wallet.available ?? Math.max(0, (wallet.balance || 0) - (wallet.reserved || 0)),
    };
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

  if (creditsValue) {
    creditsValue.textContent = creditsState.wallet.available.toLocaleString();
  }

  if (creditsPill) {
    const available = creditsState.wallet.available;
    creditsPill.classList.toggle('low', available < 30 && available > 0);
    creditsPill.classList.toggle('empty', available === 0);
    creditsPill.classList.toggle('has-credits', available > 0);
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
 */
function updateGenerateButtonCosts() {
  Object.entries(BUTTON_CONFIG).forEach(([btnId, config]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    const { action } = config;
    const batchCount = getBatchCountForButton(btnId);
    const costPerItem = getActionCost(action);
    const totalCost = costPerItem * batchCount;
    const hasCreds = creditsState.wallet.available >= totalCost;

    // Find the .gen-credits span in the same footer card
    const footerCard = btn.closest('.gen-footer-card');
    if (footerCard) {
      const creditsSpan = footerCard.querySelector('.gen-credits');
      if (creditsSpan) {
        // Show batch multiplier if > 1
        const costText = batchCount > 1
          ? `${costPerItem} × ${batchCount} = ${totalCost}`
          : `${totalCost}`;
        creditsSpan.innerHTML = `<i class="fa-solid fa-coins"></i> ${costText}`;
        creditsSpan.classList.toggle('insufficient', !hasCreds);
      }
    }

    // Add/update insufficient state on button
    btn.classList.toggle('insufficient-credits', !hasCreds);

    // Add/update cost tooltip on button (always visible on hover)
    btn.setAttribute('data-credits', totalCost);
    btn.setAttribute('title', `${totalCost} credits`);

    // Add cost badge to button if totalCost > 0
    let costBadge = btn.querySelector('.btn-cost-badge');
    if (totalCost > 0) {
      if (!costBadge) {
        costBadge = document.createElement('span');
        costBadge.className = 'btn-cost-badge';
        btn.appendChild(costBadge);
      }
      // Show batch multiplier in badge if > 1
      costBadge.textContent = batchCount > 1 ? `${totalCost}` : totalCost;
      costBadge.classList.toggle('insufficient', !hasCreds);
      costBadge.classList.toggle('has-batch', batchCount > 1);
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

    // Also handle stepper buttons
    const stepper = input.closest('.stepper-input');
    if (stepper) {
      const upBtn = stepper.querySelector('.stepper-up');
      const downBtn = stepper.querySelector('.stepper-down');

      if (upBtn) {
        upBtn.addEventListener('click', () => {
          const current = parseInt(input.value, 10) || 1;
          const max = parseInt(input.max, 10) || 4;
          input.value = Math.min(current + 1, max);
          updateHandler();
        });
      }

      if (downBtn) {
        downBtn.addEventListener('click', () => {
          const current = parseInt(input.value, 10) || 1;
          const min = parseInt(input.min, 10) || 1;
          input.value = Math.max(current - 1, min);
          updateHandler();
        });
      }
    }
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
 * Sets exact server balance, clearing any optimistic state
 * @returns {Promise<number>} The server balance
 */
export async function refreshCredits() {
  const url = `${BACKEND}/api/credits/wallet`;
  log('[Credits] Refreshing from:', url);

  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      log('[Credits] refreshCredits failed:', res.status);
      // Fall back to /api/me
      return fetchWallet().then(() => creditsState.wallet.available);
    }

    const data = await res.json();
    log('[Credits] /api/credits/wallet response:', data);

    if (data.ok && typeof data.credits_balance === 'number') {
      const serverBalance = data.credits_balance;

      // Clear all pending deductions - server is truth
      creditsState.pendingDeductions = [];
      creditsState.wallet.available = serverBalance;
      creditsState.wallet.balance = serverBalance;
      creditsState.lastServerBalance = serverBalance;

      if (data.identity_id) {
        creditsState.identityId = data.identity_id;
      }

      log('[Credits] Refreshed to server balance:', serverBalance);
      updateCreditsUI();
      return serverBalance;
    }

    // Fallback to /api/me if response format unexpected
    return fetchWallet().then(() => creditsState.wallet.available);
  } catch (err) {
    log('[Credits] refreshCredits error:', err);
    // Fallback to /api/me
    return fetchWallet().then(() => creditsState.wallet.available);
  }
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
  // Simple client API (credits-client interface)
  initCreditsUI,
  getCredits,
  setCredits,
  applyDelta,
  refreshCredits,
};
