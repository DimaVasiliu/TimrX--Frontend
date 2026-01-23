/**
 * credits.js
 * Handles credits display, wallet fetching, and buy credits modal for hub.html
 */

(function() {
  'use strict';

  // API endpoint - always use the custom domain for proper cookie handling
  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  const API_TIMEOUT_MS = 10000;

  console.log('[Credits] Init - API_BASE:', API_BASE, 'hostname:', window.location.hostname);
  console.log('[Credits] Cross-origin API?', new URL(API_BASE).hostname !== window.location.hostname);

  // ─────────────────────────────────────────────────────────────
  // Centralized API Client - ALWAYS includes credentials for cross-origin cookies
  // ─────────────────────────────────────────────────────────────

  /**
   * Check if response is HTML (wrong routing/redirect)
   * Handles whitespace, case variations, and various HTML patterns
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
   * Centralized fetch with credentials, timeout, retry, and HTML detection.
   * @param {string} url - Full URL or path (if path, API_BASE is prepended)
   * @param {object} options - { method, body, timeout, retry }
   * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
   */
  async function apiFetch(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
    const { method = 'GET', body, timeout = API_TIMEOUT_MS, retry = true, ...rest } = options;

    const headers = { 'Accept': 'application/json', ...(rest.headers || {}) };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOptions = {
      method,
      credentials: 'include',
      mode: 'cors',
      headers,
    };
    if (body) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const doFetch = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(fullUrl, { ...fetchOptions, signal: controller.signal });
        clearTimeout(timeoutId);

        const text = await response.text();
        const contentType = response.headers.get('content-type') || '';

        if (isHtmlResponse(text, contentType)) {
          console.error(`[API] HTML response from ${fullUrl} - possible wrong routing`);
          return { ok: false, status: response.status, error: `HTML response from ${fullUrl}`, isHtml: true };
        }

        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          console.error(`[API] Invalid JSON from ${fullUrl}:`);
          console.error(`[API]   Status: ${response.status}`);
          console.error(`[API]   Content-Type: ${contentType}`);
          console.error(`[API]   Response preview: ${text.slice(0, 300)}`);
          return { ok: false, status: response.status, error: `Invalid JSON (${e.message})` };
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

    // Retry once on timeout for GET /api/me
    if (result.isTimeout && retry && method === 'GET' && fullUrl.includes('/api/me')) {
      console.log(`[API] Retrying ${fullUrl} after timeout...`);
      await new Promise(r => setTimeout(r, 500));
      result = await doFetch();
    }

    return result;
  }

  // Plan definitions (must match DB: starter_80, creator_300, studio_600)
  const PLANS = {
    starter_80: { name: 'Starter', credits: 80, price: 7.99 },
    creator_300: { name: 'Creator', credits: 300, price: 19.99 },
    studio_600: { name: 'Studio', credits: 600, price: 34.99 }
  };

  // DOM elements
  const creditsPill = document.getElementById('creditsPill');
  const creditsValue = document.getElementById('creditsValue');
  const buyCreditsBtn = document.getElementById('buyCreditsBtn');
  const buyCreditsModal = document.getElementById('buyCreditsModal');
  const buyCreditsClose = document.getElementById('buyCreditsClose');
  const planCards = document.querySelectorAll('.plan-card');
  const pricingCtaButtons = document.querySelectorAll('.pricing-cta');

  // Checkout section elements
  const checkoutSection = document.getElementById('checkoutSection');
  const selectedPlanDisplay = document.getElementById('selectedPlanDisplay');
  const selectedPlanName = document.getElementById('selectedPlanName');
  const selectedPlanPrice = document.getElementById('selectedPlanPrice');
  const checkoutEmail = document.getElementById('checkoutEmail');
  const checkoutError = document.getElementById('checkoutError');
  const checkoutBtn = document.getElementById('checkoutBtn');

  // Success modal elements
  const successModal = document.getElementById('paymentSuccessModal');
  const successCreditsValue = document.getElementById('successCreditsValue');
  const successCloseBtn = document.getElementById('successCloseBtn');

  // State
  let walletBalance = 0;
  let walletReserved = 0;
  let walletAvailable = 0;
  let userEmail = '';
  let identityId = null;
  let selectedPlan = null;

  // ─────────────────────────────────────────────────────────────
  // WalletStore - Single Source of Truth for wallet state
  // ─────────────────────────────────────────────────────────────

  const WalletStore = {
    _state: {
      balance: 0,
      reserved: 0,
      available: 0,
      identityId: null,
      email: null,
      emailVerified: false,
      fetchedAt: null,
      lastError: null,
      isFetching: false,
    },

    /**
     * Get current wallet snapshot
     * @returns {{ available: number, balance: number, reserved: number, identityId: string|null, email: string|null, fetchedAt: string|null }}
     */
    getSnapshot() {
      return {
        available: this._state.available,
        balance: this._state.balance,
        reserved: this._state.reserved,
        identityId: this._state.identityId,
        email: this._state.email,
        emailVerified: this._state.emailVerified,
        fetchedAt: this._state.fetchedAt,
      };
    },

    /**
     * Update wallet state and broadcast event
     */
    update(data) {
      const prev = { ...this._state };

      this._state.balance = data.balance ?? this._state.balance;
      this._state.reserved = data.reserved ?? this._state.reserved;
      this._state.available = data.available ?? this._state.available;
      this._state.identityId = data.identityId ?? this._state.identityId;
      this._state.email = data.email ?? this._state.email;
      this._state.emailVerified = data.emailVerified ?? this._state.emailVerified;
      this._state.fetchedAt = new Date().toISOString();
      this._state.lastError = null;

      // Update module-level vars for backward compatibility
      walletBalance = this._state.balance;
      walletReserved = this._state.reserved;
      walletAvailable = this._state.available;
      identityId = this._state.identityId;
      userEmail = this._state.email || '';

      // Broadcast wallet update event
      this.broadcast();

      console.log('[WalletStore] Updated:', this._state.available, 'credits (was:', prev.available, ')');
    },

    /**
     * Set error state
     */
    setError(error) {
      this._state.lastError = error;
    },

    /**
     * Set fetching state
     */
    setFetching(isFetching) {
      this._state.isFetching = isFetching;
    },

    /**
     * Broadcast wallet update event
     */
    broadcast() {
      const event = new CustomEvent('timrx:wallet', {
        detail: this.getSnapshot(),
        bubbles: true,
      });
      window.dispatchEvent(event);
      console.log('[WalletStore] Broadcasted timrx:wallet event');
    },
  };

  // Expose WalletStore globally for debugging and external access
  window.__TIMRX_WALLET__ = WalletStore;

  /**
   * Get wallet snapshot - convenience function
   * @returns {{ available: number, balance: number, reserved: number, identityId: string|null, fetchedAt: string|null }}
   */
  function getWalletSnapshot() {
    return WalletStore.getSnapshot();
  }

  // ─────────────────────────────────────────────────────────────
  // Wallet API
  // ─────────────────────────────────────────────────────────────

  /**
   * Fetch wallet/session info from /api/me using centralized API client
   * @param {object} options - { force: boolean, timeout: number }
   * @returns {Promise<{balance: number, reserved: number, available: number}|null>}
   */
  async function fetchWallet(options = {}) {
    const { force = false, timeout = 15000 } = options;

    console.log('[Credits] Fetching wallet from:', `${API_BASE}/api/me`, force ? '(forced)' : '');
    WalletStore.setFetching(true);

    const result = await apiFetch('/api/me', { timeout });

    if (!result.ok) {
      console.warn('[Credits] Wallet fetch failed:', result.status, result.error);
      WalletStore.setError(result.error);
      WalletStore.setFetching(false);
      updateCreditsDisplay(0, 0, 0);
      return null;
    }

    const data = result.data;
    console.log('[Credits] /api/me response:', {
      ok: data.ok,
      identity_id: data.identity_id,
      balance_credits: data.balance_credits,
      reserved_credits: data.reserved_credits,
      available_credits: data.available_credits,
      email: data.email
    });

    if (data.ok) {
      // Read credits from top-level fields (new format)
      const balance = data.balance_credits ?? data.wallet?.balance ?? 0;
      const reserved = data.reserved_credits ?? data.wallet?.reserved ?? 0;
      const available = data.available_credits ?? data.wallet?.available ?? Math.max(0, balance - reserved);
      const id = data.identity_id || null;

      // Update WalletStore (this also broadcasts the event and updates module vars)
      WalletStore.update({
        balance,
        reserved,
        available,
        identityId: id,
        email: data.email || null,
        emailVerified: data.email_verified || false,
      });
      WalletStore.setFetching(false);

      // Debug: Log identity info for session diagnostics
      console.log('[Session Debug] identity_id:', id, 'credits:', available, 'apiBase:', API_BASE);

      // Expose identity for debugging (compare with workspace to verify same session)
      window.__TIMRX_SESSION__ = {
        identity_id: id,
        credits: available,
        apiBase: API_BASE,
        page: 'hub',
        fetchedAt: new Date().toISOString(),
      };

      // Write to cross-page wallet cache (for instant display on workspace after purchase)
      if (window.TimrXApi?.writeWalletCache && id) {
        window.TimrXApi.writeWalletCache(id, available);
      }

      updateCreditsDisplay(available, balance, reserved);

      // Store email if available
      if (data.email) {
        if (checkoutEmail && !checkoutEmail.value) {
          checkoutEmail.value = data.email;
          validateCheckoutForm();
        }
      }

      return { balance, reserved, available };
    } else {
      console.warn('[Credits] /api/me returned ok:false');
      WalletStore.setFetching(false);
      updateCreditsDisplay(0, 0, 0);
      return null;
    }
  }

  /**
   * Refresh credits with retry support
   * @param {object} options - { force: boolean, maxRetries: number }
   * @returns {Promise<number>} - Available credits
   */
  async function refreshCredits(options = {}) {
    const { force = false, maxRetries = 3 } = options;

    let lastResult = null;
    const delays = [0, 500, 1500]; // Progressive backoff

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = delays[attempt] || 1000;
        console.log(`[Credits] Refresh retry ${attempt}/${maxRetries - 1} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      const wallet = await fetchWallet({ force, timeout: 15000 });
      lastResult = wallet;

      if (wallet) {
        return wallet.available;
      }
    }

    console.warn('[Credits] All refresh attempts failed');
    return lastResult ? lastResult.available : 0;
  }

  function updateCreditsDisplay(available, total, reserved) {
    if (!creditsValue) return;

    // Show available credits
    creditsValue.textContent = available.toLocaleString();

    // Add visual indicator if credits are low
    if (creditsPill) {
      creditsPill.classList.toggle('low', available < 30 && available > 0);
      creditsPill.classList.toggle('empty', available === 0);
      // Hide plus icon when user has credits
      creditsPill.classList.toggle('has-credits', available > 0);
    }

    console.log('[Credits] UI updated: available=' + available + ', total=' + total + ', reserved=' + reserved);
  }

  // ─────────────────────────────────────────────────────────────
  // Plan Selection
  // ─────────────────────────────────────────────────────────────

  function selectPlan(planId) {
    const plan = PLANS[planId];
    if (!plan) return;

    selectedPlan = { id: planId, ...plan };

    // Update UI - highlight selected plan card
    planCards.forEach(card => {
      const cardPlan = card.dataset.plan;
      card.classList.toggle('selected', cardPlan === planId);
    });

    // Update selected plan display
    if (selectedPlanName) selectedPlanName.textContent = plan.name;
    if (selectedPlanPrice) selectedPlanPrice.textContent = `£${plan.price.toFixed(2)}`;

    // Show checkout section
    if (checkoutSection) {
      checkoutSection.classList.add('visible');
    }

    // Focus email input if empty
    if (checkoutEmail && !checkoutEmail.value) {
      checkoutEmail.focus();
    }

    // Validate form
    validateCheckoutForm();
  }

  function clearPlanSelection() {
    selectedPlan = null;
    planCards.forEach(card => card.classList.remove('selected'));
    if (checkoutSection) checkoutSection.classList.remove('visible');
    if (selectedPlanName) selectedPlanName.textContent = '-';
    if (selectedPlanPrice) selectedPlanPrice.textContent = '-';
    if (checkoutBtn) checkoutBtn.disabled = true;
    clearCheckoutError();
  }

  // ─────────────────────────────────────────────────────────────
  // Form Validation
  // ─────���───────────────────────────────────────────────────────

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function validateCheckoutForm() {
    const email = checkoutEmail?.value?.trim() || '';
    const isValid = selectedPlan && isValidEmail(email);

    if (checkoutBtn) {
      checkoutBtn.disabled = !isValid;
    }

    return isValid;
  }

  function showCheckoutError(message) {
    if (checkoutError) {
      checkoutError.textContent = message;
      checkoutError.style.display = 'block';
    }
  }

  function clearCheckoutError() {
    if (checkoutError) {
      checkoutError.textContent = '';
      checkoutError.style.display = 'none';
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Modal Management
  // ─────────────────────────────────────────────────────────────

  function openBuyCreditsModal(preselectedPlan = null) {
    if (!buyCreditsModal) return;

    // Reset state
    clearPlanSelection();
    clearCheckoutError();

    buyCreditsModal.classList.add('open');
    buyCreditsModal.setAttribute('aria-hidden', 'false');

    // Preselect plan if specified
    if (preselectedPlan && PLANS[preselectedPlan]) {
      selectPlan(preselectedPlan);
    }

    // Pre-fill email if we have it
    if (checkoutEmail && userEmail && !checkoutEmail.value) {
      checkoutEmail.value = userEmail;
      validateCheckoutForm();
    }

    // Focus first plan card if no preselection, otherwise focus email
    if (!preselectedPlan) {
      const firstPlan = buyCreditsModal.querySelector('.plan-card');
      if (firstPlan) firstPlan.focus();
    }
  }

  function closeBuyCreditsModal() {
    if (!buyCreditsModal) return;
    buyCreditsModal.classList.remove('open');
    buyCreditsModal.setAttribute('aria-hidden', 'true');

    // Reset state
    clearPlanSelection();
    clearCheckoutError();

    // Return focus to buy button
    if (buyCreditsBtn) buyCreditsBtn.focus();
  }

  // ─────────────────────────────────────────────────────────────
  // Success Modal - Driven by WalletStore as single source of truth
  // ─────────────────────────────────────────────────────────────

  // Track modal state
  const successModalState = {
    isOpen: false,
    isPending: true,
    preCheckoutBalance: 0,
  };

  /**
   * Open success modal
   * @param {number|null} credits - Credits to display (null = show "Updating...")
   * @param {boolean} isPending - Whether credits are still being processed
   */
  function openSuccessModal(credits, isPending = false) {
    if (!successModal) return;

    successModalState.isOpen = true;
    successModalState.isPending = isPending;

    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
    const creditsDisplay = successModal.querySelector('.success-credits');

    if (isPending) {
      // Show immediate feedback with "Updating balance..." state
      if (successTitle) successTitle.textContent = 'Payment Received';
      if (successMessage) successMessage.textContent = 'Updating balance…';
      successModal.classList.add('pending');
      successModal.classList.remove('failed');

      // Show current balance or placeholder
      if (successCreditsValue) {
        successCreditsValue.textContent = credits != null ? credits.toLocaleString() : '—';
      }
      if (creditsDisplay) creditsDisplay.style.display = '';
    } else {
      // Credits have been granted - show success state
      if (successTitle) successTitle.textContent = 'Payment Successful';
      if (successMessage) successMessage.textContent = 'Your credits have been added to your account.';
      successModal.classList.remove('pending');
      successModal.classList.remove('failed');

      // Update balance display
      if (successCreditsValue && credits != null) {
        successCreditsValue.textContent = credits.toLocaleString();
      }
      if (creditsDisplay) creditsDisplay.style.display = '';
    }

    successModal.classList.add('open');
    successModal.setAttribute('aria-hidden', 'false');
  }

  /**
   * Transition modal from pending to success state with new balance
   */
  function transitionSuccessModalToComplete(balance) {
    if (!successModal || !successModalState.isOpen) return;

    successModalState.isPending = false;

    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
    const creditsDisplay = successModal.querySelector('.success-credits');

    if (successTitle) successTitle.textContent = 'Payment Successful';
    if (successMessage) successMessage.textContent = 'Your credits have been added to your account.';
    if (successCreditsValue) successCreditsValue.textContent = balance.toLocaleString();
    if (creditsDisplay) creditsDisplay.style.display = '';

    successModal.classList.remove('pending');
    successModal.classList.remove('failed');

    console.log('[Credits] Modal transitioned to complete, balance:', balance);
  }

  function closeSuccessModal() {
    if (!successModal) return;
    successModal.classList.remove('open');
    successModal.setAttribute('aria-hidden', 'true');
    successModalState.isOpen = false;
    successModalState.isPending = false;
  }

  /**
   * Update success modal to show payment failed state
   */
  function updateSuccessModalToFailed(status) {
    if (!successModal) return;

    successModalState.isPending = false;

    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
    const creditsDisplay = successModal.querySelector('.success-credits');

    if (successTitle) {
      successTitle.textContent = status === 'canceled' ? 'Payment Cancelled' : 'Payment Failed';
    }
    if (successMessage) {
      successMessage.textContent = status === 'canceled'
        ? 'Your payment was cancelled. No credits were charged.'
        : 'Your payment could not be processed. Please try again.';
    }
    if (creditsDisplay) creditsDisplay.style.display = 'none';

    successModal.classList.remove('pending');
    successModal.classList.add('failed');
  }

  /**
   * Update success modal to show syncing state (credits still processing but no error)
   */
  function updateSuccessModalToSyncing() {
    if (!successModal) return;

    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');

    if (successTitle) successTitle.textContent = 'Payment Received';
    if (successMessage) {
      successMessage.textContent = 'Credits will appear shortly. Refresh if needed.';
    }

    // Keep pending class for visual styling
    successModal.classList.add('pending');
    successModal.classList.remove('failed');
  }

  // Subscribe to wallet events to update modal automatically
  window.addEventListener('timrx:wallet', (event) => {
    const wallet = event.detail;
    if (!wallet || !successModalState.isOpen) return;

    console.log('[Credits] Wallet event while modal open, pending:', successModalState.isPending, 'balance:', wallet.available);

    // If modal is pending and balance increased, transition to complete
    if (successModalState.isPending && wallet.available > successModalState.preCheckoutBalance) {
      transitionSuccessModalToComplete(wallet.available);
    } else if (!successModalState.isPending && successCreditsValue) {
      // Update balance display if modal is showing success
      successCreditsValue.textContent = wallet.available.toLocaleString();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Checkout Flow
  // ─────────────────────────────────────────────────────────────

  async function startCheckout() {
    if (!validateCheckoutForm()) {
      showCheckoutError('Please select a plan and enter a valid email.');
      return;
    }

    const email = checkoutEmail.value.trim();

    // Show loading state
    setCheckoutLoading(true);
    clearCheckoutError();

    try {
      // Call POST /api/billing/checkout (Mollie) using centralized API client
      const result = await apiFetch('/api/billing/checkout', {
        method: 'POST',
        body: {
          plan_code: selectedPlan.id,  // plan_code matches DB: starter_80, creator_300, studio_600
          email: email
        }
      });

      if (!result.ok) {
        throw new Error(result.data?.detail || result.error || `Checkout failed (${result.status})`);
      }

      const data = result.data;
      if (data.checkout_url) {
        // Store payment_id for post-redirect confirmation
        if (data.payment_id) {
          sessionStorage.setItem('timrx_pending_payment_id', data.payment_id);
          console.log('[Credits] Stored payment_id for confirmation:', data.payment_id);
        }

        // Store current balance BEFORE redirect - used to detect balance change on return
        // This is critical: if webhook arrives before redirect, walletAvailable will already be updated
        sessionStorage.setItem('timrx_pre_checkout_balance', String(walletAvailable || 0));
        console.log('[Credits] Stored pre-checkout balance:', walletAvailable || 0);

        // Redirect to Mollie checkout
        window.location.href = data.checkout_url;
      } else {
        throw new Error('No checkout URL returned');
      }

    } catch (err) {
      console.error('[Credits] Checkout failed:', err);
      showCheckoutError(err.message || 'Failed to start checkout. Please try again.');
      setCheckoutLoading(false);
    }
  }

  function setCheckoutLoading(loading) {
    if (!checkoutBtn) return;

    checkoutBtn.disabled = loading;

    const btnText = checkoutBtn.querySelector('.btn-text');
    const btnLoader = checkoutBtn.querySelector('.btn-loader');

    if (btnText) btnText.style.display = loading ? 'none' : '';
    if (btnLoader) btnLoader.style.display = loading ? 'inline-flex' : 'none';
  }

  // ─────────────────────────────────────────────────────────────
  // Event Listeners
  // ─────────────────────────────────────────────────────────────

  // Buy button opens modal
  buyCreditsBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    openBuyCreditsModal();
  });

  // Credits pill click also opens modal
  creditsPill?.addEventListener('click', () => {
    openBuyCreditsModal();
  });

  // Close button
  buyCreditsClose?.addEventListener('click', (e) => {
    e.preventDefault();
    closeBuyCreditsModal();
  });

  // Backdrop click closes modal
  buyCreditsModal?.addEventListener('click', (e) => {
    if (e.target === buyCreditsModal) {
      closeBuyCreditsModal();
    }
  });

  // ESC closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (successModal?.classList.contains('open')) {
        closeSuccessModal();
      } else if (buyCreditsModal?.classList.contains('open')) {
        closeBuyCreditsModal();
      }
    }
  });

  // Plan card selection (in modal)
  planCards.forEach(card => {
    card.addEventListener('click', () => {
      const planId = card.dataset.plan;
      if (planId) selectPlan(planId);
    });

    // Keyboard support
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const planId = card.dataset.plan;
        if (planId) selectPlan(planId);
      }
    });
  });

  // Pricing page CTA buttons -> open modal with preselection
  pricingCtaButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const planId = btn.dataset.plan;
      openBuyCreditsModal(planId);
    });
  });

  // Email input validation
  checkoutEmail?.addEventListener('input', () => {
    clearCheckoutError();
    validateCheckoutForm();
  });

  checkoutEmail?.addEventListener('blur', () => {
    const email = checkoutEmail.value.trim();
    if (email && !isValidEmail(email)) {
      showCheckoutError('Please enter a valid email address.');
    }
  });

  // Checkout button
  checkoutBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    startCheckout();
  });

  // Enter key in email field triggers checkout
  checkoutEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !checkoutBtn?.disabled) {
      e.preventDefault();
      startCheckout();
    }
  });

  // Success modal close button
  successCloseBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    closeSuccessModal();
  });

  // Success modal backdrop click
  successModal?.addEventListener('click', (e) => {
    if (e.target === successModal) {
      closeSuccessModal();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────

  // Fetch wallet on load
  fetchWallet();

  // Refresh wallet periodically (every 60 seconds)
  setInterval(fetchWallet, 60000);

  // Handle checkout return (check URL params)
  const urlParams = new URLSearchParams(window.location.search);
  const checkoutStatus = urlParams.get('checkout');

  if (checkoutStatus === 'success') {
    // Clean URL immediately
    window.history.replaceState({}, '', window.location.pathname);

    // Get stored payment_id and pre-checkout balance from sessionStorage
    const pendingPaymentId = sessionStorage.getItem('timrx_pending_payment_id');
    const preCheckoutBalance = parseInt(sessionStorage.getItem('timrx_pre_checkout_balance') || '0', 10);
    const displayBalance = walletAvailable || parseInt(localStorage.getItem('timrx_credits_last') || '0', 10);

    console.log('[Credits] Checkout success - pre-checkout balance:', preCheckoutBalance, 'current display:', displayBalance);

    // Store pre-checkout balance in modal state for event listener comparison
    successModalState.preCheckoutBalance = preCheckoutBalance;

    // IMMEDIATELY show success modal in "pending/updating" state
    openSuccessModal(displayBalance, true);

    // Clean up stored values
    sessionStorage.removeItem('timrx_pre_checkout_balance');

    // Run reconciliation in background (non-blocking)
    (async function reconcilePayment() {
      const initialBalance = preCheckoutBalance;

      // Step 1: If we have payment_id, call confirm endpoint with longer timeout
      if (pendingPaymentId) {
        console.log('[Credits] Confirming payment:', pendingPaymentId);

        try {
          const confirmResult = await apiFetch(`/api/billing/confirm?payment_id=${encodeURIComponent(pendingPaymentId)}`, {
            timeout: 15000  // Longer timeout for confirm
          });

          // Clear stored payment_id regardless of result
          sessionStorage.removeItem('timrx_pending_payment_id');

          if (confirmResult.ok && confirmResult.data) {
            const confirmData = confirmResult.data;
            console.log('[Credits] Confirm response:', confirmData);

            if (confirmData.ok && confirmData.credits_granted) {
              // Credits were granted - refresh wallet (will broadcast event and update modal)
              console.log('[Credits] Credits confirmed, refreshing wallet...');
              await refreshCredits({ force: true, maxRetries: 3 });
              // Modal will auto-update via wallet event listener
              return;
            } else if (confirmData.status === 'failed' || confirmData.status === 'canceled' || confirmData.status === 'expired') {
              console.log('[Credits] Payment failed:', confirmData.status);
              updateSuccessModalToFailed(confirmData.status);
              return;
            }
            // For 'open'/'pending', continue to polling below
          } else if (confirmResult.isTimeout) {
            console.log('[Credits] Confirm timed out, continuing to polling...');
          }
        } catch (err) {
          console.error('[Credits] Confirm error:', err);
          // Continue to polling
        }
      } else {
        console.log('[Credits] No payment_id found, starting wallet refresh');
        sessionStorage.removeItem('timrx_pending_payment_id');
      }

      // Step 2: Poll for credit update with progressive backoff
      // The wallet event listener will auto-update the modal when balance changes
      let attempts = 0;
      const maxAttempts = 20; // 20 * 500ms = ~10 seconds max
      const pollInterval = 500;

      async function pollBalance() {
        attempts++;

        // Modal might have already been updated by wallet event listener
        if (!successModalState.isPending) {
          console.log('[Credits] Modal already updated, stopping poll');
          return;
        }

        try {
          const wallet = await fetchWallet({ force: true, timeout: 8000 });
          const newBalance = wallet ? wallet.available : 0;

          console.log(`[Credits] Poll ${attempts}/${maxAttempts}: balance=${newBalance} (was ${initialBalance})`);

          // If balance increased, transition modal (also handled by event listener as backup)
          if (newBalance > initialBalance) {
            console.log('[Credits] Balance increased! Transitioning modal...');
            transitionSuccessModalToComplete(newBalance);
            return;
          }
        } catch (err) {
          console.warn(`[Credits] Poll ${attempts} error:`, err.message);
          // Continue polling on error
        }

        // Continue polling if not at max attempts and modal still pending
        if (attempts < maxAttempts && successModalState.isPending) {
          setTimeout(pollBalance, pollInterval);
        } else if (successModalState.isPending) {
          // Max attempts reached but modal still pending - show fallback message
          console.log('[Credits] Max poll attempts - showing sync message');
          updateSuccessModalToSyncing();
        }
      }

      // Start polling immediately
      pollBalance();
    })();
  } else if (checkoutStatus === 'cancelled' || checkoutStatus === 'failed' || checkoutStatus === 'expired') {
    // Clean URL and clear stored payment_id
    window.history.replaceState({}, '', window.location.pathname);
    sessionStorage.removeItem('timrx_pending_payment_id');
    if (checkoutStatus !== 'cancelled') {
      console.log(`[Credits] Checkout ${checkoutStatus}`);
      // Could show a toast/alert here if needed
    }
  }

  // ─────────────────────────────────────────────────────────────
  // EMAIL ATTACH / VERIFY / RESTORE
  // ─────────────────────────────────────────────────────────────

  // Secure credits section DOM elements
  const secureState1 = document.getElementById('secureState1');
  const secureState2 = document.getElementById('secureState2');
  const secureState3 = document.getElementById('secureState3');
  const restorePanel = document.getElementById('restorePanel');

  const secureEmailInput = document.getElementById('secureEmail');
  const sendCodeBtn = document.getElementById('sendCodeBtn');
  const secureError = document.getElementById('secureError');
  const secureMessage = document.getElementById('secureMessage');

  const sentToEmail = document.getElementById('sentToEmail');
  const verifyCodeInput = document.getElementById('verifyCode');
  const verifyCodeBtn = document.getElementById('verifyCodeBtn');
  const verifyError = document.getElementById('verifyError');
  const verifyMessage = document.getElementById('verifyMessage');
  const resendCodeBtn = document.getElementById('resendCodeBtn');
  const changeEmailBtn = document.getElementById('changeEmailBtn');

  const verifiedEmailEl = document.getElementById('verifiedEmail');
  const changeVerifiedEmailBtn = document.getElementById('changeVerifiedEmailBtn');
  const showRestoreBtn = document.getElementById('showRestoreBtn');

  // Toggle button and collapsible card
  const secureToggleBtn = document.getElementById('secureToggleBtn');
  const secureCreditsCard = document.getElementById('secureCreditsCard');
  const secureCreditsWrap = document.getElementById('secure-credits');
  const secureInfoWrap = document.getElementById('secureInfoWrap');
  const secureInfoBtn = document.getElementById('secureInfoBtn');
  const secureInfoPopover = document.getElementById('secureInfoPopover');

  /**
   * Toggle the secure credits card visibility
   */
  function toggleSecureCredits() {
    if (!secureToggleBtn || !secureCreditsCard) return;

    const isExpanded = secureCreditsCard.classList.contains('expanded');
    const willExpand = !isExpanded;

    if (isExpanded) {
      // Collapse
      secureCreditsCard.classList.remove('expanded');
      secureCreditsCard.classList.add('collapsed');
      secureToggleBtn.classList.remove('expanded');
      secureCreditsWrap?.classList.remove('is-open');
    } else {
      // Expand
      secureCreditsCard.classList.remove('collapsed');
      secureCreditsCard.classList.add('expanded');
      secureToggleBtn.classList.add('expanded');
      secureCreditsWrap?.classList.add('is-open');
    }

    secureToggleBtn.setAttribute('aria-expanded', String(willExpand));

    if (willExpand && typeof secureCreditsCard.scrollIntoView === 'function') {
      secureCreditsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Toggle button event listener
  secureToggleBtn?.addEventListener('click', toggleSecureCredits);

  if (secureToggleBtn && secureCreditsCard) {
    const isExpanded = secureCreditsCard.classList.contains('expanded');
    secureToggleBtn.setAttribute('aria-expanded', String(isExpanded));
    secureCreditsWrap?.classList.toggle('is-open', isExpanded);
  }

  function openSecureInfo() {
    if (!secureInfoWrap || !secureInfoBtn || !secureInfoPopover) return;
    secureInfoWrap.classList.add('open');
    secureInfoPopover.setAttribute('aria-hidden', 'false');
    secureInfoBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSecureInfo() {
    if (!secureInfoWrap || !secureInfoBtn || !secureInfoPopover) return;
    secureInfoWrap.classList.remove('open');
    secureInfoPopover.setAttribute('aria-hidden', 'true');
    secureInfoBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleSecureInfo(event) {
    if (!secureInfoWrap || !secureInfoPopover || !secureInfoBtn) return;
    event?.stopPropagation();
    const isOpen = secureInfoWrap.classList.contains('open');
    if (isOpen) {
      closeSecureInfo();
    } else {
      openSecureInfo();
    }
  }

  secureInfoBtn?.addEventListener('click', toggleSecureInfo);

  document.addEventListener('click', (event) => {
    if (!secureInfoWrap || !secureInfoWrap.classList.contains('open')) return;
    if (!secureInfoWrap.contains(event.target)) {
      closeSecureInfo();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSecureInfo();
    }
  });

  // Email state
  let pendingEmail = '';
  let emailVerified = false;
  let resendCooldown = 0;
  let resendTimer = null;
  let isRestoreMode = false;

  /**
   * Show secure credits section state
   * @param {1|2|3} stateNum - Which state to show
   */
  function showSecureState(stateNum) {
    if (secureState1) secureState1.style.display = stateNum === 1 ? 'block' : 'none';
    if (secureState2) secureState2.style.display = stateNum === 2 ? 'block' : 'none';
    if (secureState3) secureState3.style.display = stateNum === 3 ? 'block' : 'none';

    // Show restore panel only in state 1 (anonymous)
    if (restorePanel) {
      restorePanel.style.display = stateNum === 1 ? 'block' : 'none';
    }

    // Clear error/message when switching states
    clearSecureMessages();
  }

  function clearSecureMessages() {
    if (secureError) secureError.textContent = '';
    if (secureMessage) secureMessage.textContent = '';
    if (verifyError) verifyError.textContent = '';
    if (verifyMessage) verifyMessage.textContent = '';
  }

  function setSecureError(msg) {
    if (secureError) secureError.textContent = msg;
    if (secureMessage) secureMessage.textContent = '';
  }

  function setSecureMessage(msg) {
    if (secureMessage) secureMessage.textContent = msg;
    if (secureError) secureError.textContent = '';
  }

  function setVerifyError(msg) {
    if (verifyError) verifyError.textContent = msg;
    if (verifyMessage) verifyMessage.textContent = '';
  }

  function setVerifyMessage(msg) {
    if (verifyMessage) verifyMessage.textContent = msg;
    if (verifyError) verifyError.textContent = '';
  }

  /**
   * Update secure credits UI based on current email state
   */
  function updateSecureCreditsUI() {
    if (!secureState1) return; // Not on hub.html

    if (emailVerified && userEmail) {
      // State 3: Verified
      if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
      showSecureState(3);
    } else if (userEmail && !emailVerified) {
      // State 2: Email attached but unverified (code sent)
      pendingEmail = userEmail;
      if (sentToEmail) sentToEmail.textContent = userEmail;
      showSecureState(2);
    } else {
      // State 1: No email
      showSecureState(1);
    }
  }

  /**
   * Send verification code to email
   * Uses optimistic UI - transitions to code entry immediately even if request times out,
   * since the email may still arrive (backend might process before timeout).
   */
  async function sendCode() {
    const email = secureEmailInput?.value?.trim().toLowerCase();

    if (!email) {
      setSecureError('Please enter an email address');
      return;
    }

    if (!email.includes('@') || !email.includes('.')) {
      setSecureError('Please enter a valid email address');
      return;
    }

    sendCodeBtn?.classList.add('loading');
    clearSecureMessages();

    // Store pending email immediately for optimistic UI
    pendingEmail = email;

    try {
      const endpoint = isRestoreMode
        ? '/api/auth/restore/request'
        : '/api/auth/email/attach';

      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: { email },
        timeout: 15000  // Longer timeout for this endpoint
      });

      // Handle rate limiting - this is the only case where we show an error and stay on state 1
      if (!result.ok && result.data?.error?.code === 'RATE_LIMITED') {
        setSecureError(result.data.error.message || 'Please wait before requesting another code');
        sendCodeBtn?.classList.remove('loading');
        return;
      }

      // For all other cases (success, timeout, other errors), proceed to state 2
      // The backend returns generic success for anti-enumeration, and even on timeout
      // the request may have been processed server-side
      if (sentToEmail) sentToEmail.textContent = email;
      showSecureState(2);

      // Show neutral message (anti-enumeration safe)
      setVerifyMessage('If an account exists for this email, a code has been sent.');

      // Start resend cooldown
      startResendCooldown();

      // Focus code input
      verifyCodeInput?.focus();

      // Log if there was a timeout but we're proceeding anyway
      if (result.isTimeout) {
        console.log('[Credits] Send code timed out but proceeding optimistically');
      }

    } catch (err) {
      console.error('[Credits] sendCode error:', err);
      // Even on unexpected errors, proceed to state 2 optimistically
      // The user can still enter a code if they receive it
      if (sentToEmail) sentToEmail.textContent = email;
      showSecureState(2);
      setVerifyMessage('If an account exists for this email, a code has been sent.');
      startResendCooldown();
      verifyCodeInput?.focus();
    } finally {
      sendCodeBtn?.classList.remove('loading');
    }
  }

  /**
   * Skip to code entry without sending a new code
   * For users who already have a code from a previous request
   */
  function skipToCodeEntry() {
    const email = secureEmailInput?.value?.trim().toLowerCase();

    if (!email) {
      setSecureError('Please enter your email address first');
      return;
    }

    if (!email.includes('@') || !email.includes('.')) {
      setSecureError('Please enter a valid email address');
      return;
    }

    pendingEmail = email;
    if (sentToEmail) sentToEmail.textContent = email;
    showSecureState(2);
    setVerifyMessage('Enter the code you received.');
    verifyCodeInput?.focus();
  }

  /**
   * Verify the entered code
   */
  async function verifyCode() {
    const code = verifyCodeInput?.value?.trim();

    if (!code) {
      setVerifyError('Please enter the code');
      return;
    }

    if (code.length !== 6 || !/^\d+$/.test(code)) {
      setVerifyError('Code must be 6 digits');
      return;
    }

    verifyCodeBtn?.classList.add('loading');
    clearSecureMessages();

    try {
      const endpoint = isRestoreMode
        ? '/api/auth/restore/redeem'
        : '/api/auth/email/verify';

      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: { email: pendingEmail, code }
      });

      if (!result.ok) {
        const errorCode = result.data?.error?.code;
        if (errorCode === 'INVALID_CODE') {
          setVerifyError('Invalid or expired code');
        } else if (errorCode === 'TOO_MANY_ATTEMPTS') {
          setVerifyError('Too many attempts. Please request a new code.');
        } else if (errorCode === 'CODE_EXPIRED') {
          setVerifyError('Code has expired. Please request a new one.');
        } else if (errorCode === 'EMAIL_IN_USE') {
          // Email belongs to another identity - switch to restore mode
          setVerifyError('This email is linked to another account. Switching to restore mode...');
          // Auto-switch to restore mode and try again with the same code
          isRestoreMode = true;
          setTimeout(async () => {
            clearSecureMessages();
            const restoreResult = await apiFetch('/api/auth/restore/redeem', {
              method: 'POST',
              body: { email: pendingEmail, code },
              timeout: 15000
            });
            if (restoreResult.ok) {
              console.log('[Credits] Account restored successfully');
              userEmail = pendingEmail;
              emailVerified = true;
              isRestoreMode = false;
              await fetchWallet();
              if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
              showSecureState(3);
            } else {
              setVerifyError(restoreResult.error || 'Restore failed. Please try again.');
            }
            verifyCodeBtn?.classList.remove('loading');
          }, 500);
          return; // Don't remove loading state here - async handler will do it
        } else {
          setVerifyError(result.error || 'Verification failed');
        }
        return;
      }

      // Success!
      console.log('[Credits] Email verified successfully');
      userEmail = pendingEmail;
      emailVerified = true;
      isRestoreMode = false;

      // Refresh wallet to get updated state (especially for restore)
      await fetchWallet();

      // Show verified state
      if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
      showSecureState(3);

    } catch (err) {
      console.error('[Credits] verifyCode error:', err);
      setVerifyError('Verification failed. Please try again.');
    } finally {
      verifyCodeBtn?.classList.remove('loading');
    }
  }

  /**
   * Start resend cooldown timer (60 seconds)
   */
  function startResendCooldown() {
    resendCooldown = 60;
    updateResendButton();

    if (resendTimer) clearInterval(resendTimer);

    resendTimer = setInterval(() => {
      resendCooldown--;
      updateResendButton();

      if (resendCooldown <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
      }
    }, 1000);
  }

  function updateResendButton() {
    if (!resendCodeBtn) return;

    if (resendCooldown > 0) {
      resendCodeBtn.disabled = true;
      resendCodeBtn.textContent = `Resend (${resendCooldown}s)`;
    } else {
      resendCodeBtn.disabled = false;
      resendCodeBtn.textContent = 'Resend Code';
    }
  }

  /**
   * Resend verification code
   * Uses optimistic UI - shows success message even on timeout
   */
  async function resendCode() {
    if (resendCooldown > 0) return;

    resendCodeBtn?.classList.add('loading');
    clearSecureMessages();

    try {
      const endpoint = isRestoreMode
        ? '/api/auth/restore/request'
        : '/api/auth/email/attach';

      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: { email: pendingEmail },
        timeout: 15000  // Longer timeout
      });

      // Handle rate limiting - show error
      if (!result.ok && result.data?.error?.code === 'RATE_LIMITED') {
        setVerifyError(result.data.error.message || 'Please wait before requesting another code');
        return;
      }

      // For all other cases (success, timeout, other errors), show optimistic message
      setVerifyMessage('New code sent! Check your email.');
      startResendCooldown();

      // Clear code input
      if (verifyCodeInput) verifyCodeInput.value = '';

      if (result.isTimeout) {
        console.log('[Credits] Resend code timed out but proceeding optimistically');
      }

    } catch (err) {
      console.error('[Credits] resendCode error:', err);
      // Even on error, show optimistic message
      setVerifyMessage('New code sent! Check your email.');
      startResendCooldown();
      if (verifyCodeInput) verifyCodeInput.value = '';
    } finally {
      resendCodeBtn?.classList.remove('loading');
    }
  }

  /**
   * Go back to change email
   */
  function changeEmail() {
    isRestoreMode = false;
    showSecureState(1);
    if (secureEmailInput) {
      secureEmailInput.value = pendingEmail || '';
      secureEmailInput.focus();
    }
  }

  /**
   * Switch to restore mode for existing account
   */
  function showRestoreMode() {
    isRestoreMode = true;
    // Update UI to indicate restore mode
    if (secureState1) {
      const h3 = secureState1.querySelector('h3');
      const subtitle = secureState1.querySelector('.secure-subtitle');
      if (h3) h3.textContent = 'Restore Your Account';
      if (subtitle) subtitle.textContent = 'Enter the email linked to your existing credits.';
    }
    secureEmailInput?.focus();
  }

  /**
   * Reset to attach mode (from restore mode)
   */
  function resetToAttachMode() {
    isRestoreMode = false;
    if (secureState1) {
      const h3 = secureState1.querySelector('h3');
      const subtitle = secureState1.querySelector('.secure-subtitle');
      if (h3) h3.textContent = 'Secure Your Credits';
      if (subtitle) subtitle.textContent = 'Add an email to restore your credits on any device.';
    }
  }

  // Event listeners for secure credits section
  sendCodeBtn?.addEventListener('click', sendCode);
  verifyCodeBtn?.addEventListener('click', verifyCode);
  resendCodeBtn?.addEventListener('click', resendCode);
  changeEmailBtn?.addEventListener('click', changeEmail);
  changeVerifiedEmailBtn?.addEventListener('click', () => {
    emailVerified = false;
    userEmail = '';
    changeEmail();
  });
  showRestoreBtn?.addEventListener('click', showRestoreMode);

  // "I already have a code" link - bind if exists, or add dynamically
  const alreadyHaveCodeBtn = document.getElementById('alreadyHaveCodeBtn');
  if (alreadyHaveCodeBtn) {
    alreadyHaveCodeBtn.addEventListener('click', skipToCodeEntry);
  } else if (secureState1) {
    // Create the link dynamically if not in HTML
    const existingLink = secureState1.querySelector('.already-have-code-link');
    if (!existingLink) {
      // Create a subtle text link placed below the email/button row
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'already-have-code-link';
      link.textContent = 'I already have a code';
      link.addEventListener('click', skipToCodeEntry);

      // Style it as a subtle link with tight spacing
      Object.assign(link.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: '0.8rem',
        cursor: 'pointer',
        padding: '0.25rem 0',
        marginTop: '0.35rem',
        marginBottom: '0',
        display: 'block',
        width: '100%',
        textAlign: 'center',
        transition: 'color 0.2s ease',
      });

      // Hover effect
      link.addEventListener('mouseenter', () => {
        link.style.color = 'rgba(255, 255, 255, 0.8)';
        link.style.textDecoration = 'underline';
      });
      link.addEventListener('mouseleave', () => {
        link.style.color = 'rgba(255, 255, 255, 0.5)';
        link.style.textDecoration = 'none';
      });

      // Insert after the email input row (parent of sendCodeBtn)
      const sendBtnParent = sendCodeBtn?.parentElement;
      if (sendBtnParent && sendBtnParent.parentElement) {
        sendBtnParent.parentElement.insertBefore(link, sendBtnParent.nextSibling);
      }
    }
  }

  // Enter key handlers
  secureEmailInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCode();
    }
  });

  verifyCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      verifyCode();
    }
  });

  // Auto-format code input (numbers only)
  verifyCodeInput?.addEventListener('input', () => {
    if (verifyCodeInput) {
      verifyCodeInput.value = verifyCodeInput.value.replace(/\D/g, '').slice(0, 6);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // UPDATED INIT: Also update secure credits UI
  // ─────────────────────────────────────────────────────────────

  // Modify fetchWallet to also update email state
  const originalFetchWallet = fetchWallet;

  // Wrap fetchWallet to update secure credits UI
  async function fetchWalletAndUpdateUI() {
    const result = await originalFetchWallet();

    // Update email state from latest /api/me response
    // (userEmail is already set in originalFetchWallet)
    // We need to track email_verified separately
    try {
      const meResult = await apiFetch('/api/me');
      if (meResult.ok && meResult.data?.ok) {
        userEmail = meResult.data.email || '';
        emailVerified = meResult.data.email_verified || false;
        updateSecureCreditsUI();
      }
    } catch (err) {
      console.warn('[Credits] Failed to update email state:', err);
    }

    return result;
  }

  // Initial secure credits UI update
  // This happens after the first fetchWallet call
  setTimeout(async () => {
    try {
      const meResult = await apiFetch('/api/me');
      if (meResult.ok && meResult.data?.ok) {
        userEmail = meResult.data.email || '';
        emailVerified = meResult.data.email_verified || false;
        updateSecureCreditsUI();
      }
    } catch (err) {
      console.warn('[Credits] Failed to get email state:', err);
      updateSecureCreditsUI(); // Still update to show state 1
    }
  }, 500);

  // Expose for external use
  window.TimrXCredits = {
    refresh: refreshCredits,
    fetchWallet: fetchWallet,
    openModal: openBuyCreditsModal,
    closeModal: closeBuyCreditsModal,
    selectPlan: selectPlan,
    getBalance: () => walletBalance,
    getReserved: () => walletReserved,
    getAvailable: () => walletAvailable,
    getIdentityId: () => identityId,
    getEmail: () => userEmail,
    isEmailVerified: () => emailVerified,
    // New: Single source of truth snapshot
    getWalletSnapshot: getWalletSnapshot,
    WalletStore: WalletStore,
  };

  // Standardized ready flag for diagnostics (hub page)
  window.__TIMRX_CREDITS_READY__ = true;
  window.__TIMRX_CREDITS_PAGE__ = 'hub';
  console.log('[Credits] Hub credits module ready');

})();
