/**
 * credits.js
 * Handles credits display, wallet fetching, and buy credits modal for hub.html
 */

(function() {
  'use strict';

  // API endpoint - always use the custom domain for proper cookie handling
  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';

  // Endpoint-specific timeouts (ms) - Render cold starts can take 10-30s
  // These are generous to handle worst-case cold start scenarios
  const ENDPOINT_TIMEOUTS = {
    '/api/me': 25000,                    // 25s - called frequently, can be slow on cold start
    '/api/auth/restore/redeem': 45000,   // 45s - critical auth flow, must not abort early
    '/api/auth/email/verify': 40000,     // 40s - verification can be slow
    '/api/auth/email/attach': 30000,     // 30s - email operations
    '/api/auth/restore/request': 30000,  // 30s - code request (email sending can be slow)
    '/api/billing/confirm': 25000,       // 25s - payment confirmation
    '/api/billing/checkout': 25000,      // 25s - checkout initiation
  };
  const DEFAULT_TIMEOUT_MS = 20000;

  function getEndpointTimeout(url) {
    for (const [endpoint, timeout] of Object.entries(ENDPOINT_TIMEOUTS)) {
      if (url.includes(endpoint)) return timeout;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  console.log('[Credits] Init - API_BASE:', API_BASE, 'hostname:', window.location.hostname);
  console.log('[Credits] Cross-origin API?', new URL(API_BASE).hostname !== window.location.hostname);

  // ─────────────────────────────────────────────────────────────
  // Centralized API Client - ALWAYS includes credentials for cross-origin cookies
  // ─────────────────────────────────────────────────────────────

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
   * Centralized fetch with credentials, timeout, retry, and HTML detection.
   * @param {string} url - Full URL or path (if path, API_BASE is prepended)
   * @param {object} options - { method, body, timeout, retry }
   * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
   */
  async function apiFetch(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
    const endpointTimeout = getEndpointTimeout(fullUrl);
    const { method = 'GET', body, timeout = endpointTimeout, retry = true, ...rest } = options;

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

  // Video plan definitions (video credits)
  const VIDEO_PLANS = {
    video_starter_250: { name: 'Video Starter', credits: 250, price: 9.99 },
    video_creator_750: { name: 'Video Creator', credits: 750, price: 24.99 },
    video_studio_1600: { name: 'Video Studio', credits: 1600, price: 44.99 }
  };

  // Subscription plan definitions (must match backend subscription_service.py)
  const SUB_PLANS = {
    monthly: {
      starter:  { plan_code: 'starter_monthly',  name: 'Starter', credits_per_month: 120, price: 5.99,   cadence: 'monthly' },
      creator:  { plan_code: 'creator_monthly',  name: 'Creator', credits_per_month: 300, price: 14.99,  cadence: 'monthly' },
      studio:   { plan_code: 'studio_monthly',   name: 'Studio',  credits_per_month: 700, price: 29.99,  cadence: 'monthly' },
    },
    yearly: {
      starter:  { plan_code: 'starter_yearly',   name: 'Starter', credits_per_month: 100, price: 69.99,  cadence: 'yearly' },
      creator:  { plan_code: 'creator_yearly',   name: 'Creator', credits_per_month: 300, price: 149.99, cadence: 'yearly' },
      studio:   { plan_code: 'studio_yearly',    name: 'Studio',  credits_per_month: 700, price: 299.99, cadence: 'yearly' },
    },
  };

  // Map pricing card data-plan to subscription tier
  const CARD_TO_TIER = {
    starter_80:  'starter',
    creator_300: 'creator',
    studio_600:  'studio',
  };

  // Current pricing mode
  let pricingMode = localStorage.getItem('timrx_pricing_mode') || 'one_time';

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
  // Pricing Mode Toggle
  // ─────────────────────────────────────────────────────────────

  const pricingModeToggle = document.getElementById('pricingModeToggle');
  const modePills = pricingModeToggle ? pricingModeToggle.querySelectorAll('.mode-pill') : [];
  const modelPricingGrid = document.getElementById('modelPricingGrid');
  const videoPricingGrid = document.getElementById('videoPricingGrid');
  const pricingFootNote = document.getElementById('pricingFootNote');
  const pricingCards = modelPricingGrid ? modelPricingGrid.querySelectorAll('.price-card') : [];

  // Subscription modal elements
  const subModal = document.getElementById('subscriptionModal');
  const subModalClose = document.getElementById('subModalClose');
  const subModalTitle = document.getElementById('subModalTitle');
  const subModalSubtitle = document.getElementById('subModalSubtitle');
  const subModalCredits = document.getElementById('subModalCredits');
  const subModalCadence = document.getElementById('subModalCadence');
  const subModalPrice = document.getElementById('subModalPrice');
  const subCheckoutEmail = document.getElementById('subCheckoutEmail');
  const subCheckoutError = document.getElementById('subCheckoutError');
  const subCheckoutBtn = document.getElementById('subCheckoutBtn');

  let selectedSubPlan = null;

  /**
   * One-time card content per tier (original values)
   */
  const ONE_TIME_CARDS = {
    starter: { price: '£7.99', sub: '80 Credits · ~2-3 models', btn: 'Get Starter' },
    creator: { price: '£19.99', sub: '300 Credits · ~10 models', btn: 'Get Creator' },
    studio:  { price: '£34.99', sub: '600 Credits · ~20 models', btn: 'Get Studio' },
  };

  /**
   * Switch pricing mode and update card content
   */
  function setPricingMode(mode) {
    pricingMode = mode;
    localStorage.setItem('timrx_pricing_mode', mode);

    // Update pill active state
    modePills.forEach(pill => {
      pill.classList.toggle('active', pill.dataset.mode === mode);
    });

    // Handle video mode - show/hide appropriate grids
    if (mode === 'video') {
      if (modelPricingGrid) modelPricingGrid.style.display = 'none';
      if (videoPricingGrid) videoPricingGrid.style.display = '';
      if (pricingFootNote) pricingFootNote.textContent = '1 video ≈ 70-160 credits depending on resolution & duration.';
      return;
    } else {
      if (modelPricingGrid) modelPricingGrid.style.display = '';
      if (videoPricingGrid) videoPricingGrid.style.display = 'none';
      if (pricingFootNote) pricingFootNote.textContent = '1 model ≈ 30 credits (generation + refine).';
    }

    // Update each pricing card
    pricingCards.forEach(card => {
      const ctaBtn = card.querySelector('.pricing-cta');
      if (!ctaBtn) return;
      const planId = ctaBtn.dataset.plan;
      const tier = CARD_TO_TIER[planId];
      if (!tier) return;

      const priceEl = card.querySelector('.pc-price .big');
      const subEl = card.querySelector('.pc-price small');

      if (mode === 'one_time') {
        const info = ONE_TIME_CARDS[tier];
        if (priceEl) priceEl.textContent = info.price;
        if (subEl) subEl.textContent = info.sub;
        if (ctaBtn) ctaBtn.textContent = info.btn;
      } else {
        const cadence = mode; // 'monthly' or 'yearly'
        const plan = SUB_PLANS[cadence]?.[tier];
        if (!plan) {
          // No plan for this tier/cadence (e.g. yearly starter) — hide or grey out
          if (priceEl) priceEl.textContent = '—';
          if (subEl) subEl.textContent = 'Not available';
          if (ctaBtn) {
            ctaBtn.textContent = 'Not Available';
            ctaBtn.disabled = true;
          }
          return;
        }
        const priceStr = cadence === 'yearly'
          ? `£${plan.price.toFixed(2)}`
          : `£${plan.price.toFixed(2)}`;
        const cadenceLabel = cadence === 'yearly' ? '/yr' : '/mo';
        if (priceEl) priceEl.textContent = priceStr;
        if (subEl) subEl.textContent = `${plan.credits_per_month} Credits/mo${cadenceLabel}`;
        if (ctaBtn) {
          ctaBtn.textContent = `Subscribe ${plan.name}`;
          ctaBtn.disabled = false;
        }
      }
    });
  }

  // Toggle event listeners
  modePills.forEach(pill => {
    pill.addEventListener('click', () => {
      setPricingMode(pill.dataset.mode);
    });
  });

  // Restore saved mode on load
  if (pricingMode !== 'one_time') {
    setPricingMode(pricingMode);
  }

  // ─────────────────────────────────────────────────────────────
  // Subscription Modal
  // ─────────────────────────────────────────────────────────────

  // Track focus before subscription modal opens
  let lastFocusBeforeSubModal = null;

  function openSubscriptionModal(tier, cadence) {
    const plan = SUB_PLANS[cadence]?.[tier];
    if (!plan || !subModal) return;

    // Store current focus before opening
    lastFocusBeforeSubModal = document.activeElement;

    selectedSubPlan = plan;
    const cadenceLabel = cadence === 'yearly' ? 'Yearly' : 'Monthly';
    const priceLabel = cadence === 'yearly'
      ? `£${plan.price.toFixed(2)}<small>/yr</small>`
      : `£${plan.price.toFixed(2)}<small>/mo</small>`;

    if (subModalTitle) subModalTitle.textContent = `Subscribe — ${plan.name}`;
    if (subModalSubtitle) subModalSubtitle.textContent = `${plan.credits_per_month} credits every month. Cancel anytime.`;
    if (subModalCredits) subModalCredits.textContent = plan.credits_per_month.toLocaleString();
    if (subModalCadence) subModalCadence.textContent = cadenceLabel;
    if (subModalPrice) subModalPrice.innerHTML = priceLabel;

    // Pre-fill email
    if (subCheckoutEmail && userEmail && !subCheckoutEmail.value) {
      subCheckoutEmail.value = userEmail;
    }
    validateSubCheckout();

    // Clear errors
    if (subCheckoutError) {
      subCheckoutError.textContent = '';
      subCheckoutError.style.display = 'none';
    }

    subModal.classList.add('open');
    subModal.inert = false;
    // Focus the email input or first focusable
    requestAnimationFrame(() => {
      const target = subCheckoutEmail || subModal.querySelector('button, input');
      target?.focus();
    });
  }

  function closeSubscriptionModal() {
    if (!subModal) return;
    // Move focus OUT before hiding
    if (subModal.contains(document.activeElement)) {
      (lastFocusBeforeSubModal || document.body).focus();
    }
    subModal.classList.remove('open');
    subModal.inert = true;
    selectedSubPlan = null;
  }

  function validateSubCheckout() {
    const email = subCheckoutEmail?.value?.trim() || '';
    const valid = selectedSubPlan && isValidEmail(email);
    if (subCheckoutBtn) subCheckoutBtn.disabled = !valid;
    return valid;
  }

  function showSubError(msg) {
    if (subCheckoutError) {
      subCheckoutError.textContent = msg;
      subCheckoutError.style.display = 'block';
    }
  }

  async function startSubscriptionCheckout() {
    if (!validateSubCheckout()) {
      showSubError('Please enter a valid email.');
      return;
    }

    const email = subCheckoutEmail.value.trim();
    const btnText = subCheckoutBtn.querySelector('.btn-text');
    const btnLoader = subCheckoutBtn.querySelector('.btn-loader');

    subCheckoutBtn.disabled = true;
    if (btnText) btnText.style.display = 'none';
    if (btnLoader) btnLoader.style.display = 'inline-flex';
    if (subCheckoutError) subCheckoutError.style.display = 'none';

    try {
      const result = await apiFetch('/api/billing/subscriptions/checkout', {
        method: 'POST',
        body: {
          plan_code: selectedSubPlan.plan_code,
          email: email,
        },
      });

      if (!result.ok) {
        throw new Error(result.data?.error || result.error || 'Checkout failed');
      }

      const data = result.data;
      if (data.checkout_url) {
        // Store subscription context for return handling
        sessionStorage.setItem('timrx_pending_sub_plan', selectedSubPlan.plan_code);
        sessionStorage.setItem('timrx_pre_checkout_balance', String(walletAvailable || 0));
        if (data.payment_id) {
          sessionStorage.setItem('timrx_pending_payment_id', data.payment_id);
        }

        window.location.href = data.checkout_url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      console.error('[Credits] Subscription checkout failed:', err);
      showSubError(err.message || 'Failed to start checkout. Please try again.');
      subCheckoutBtn.disabled = false;
      if (btnText) btnText.style.display = '';
      if (btnLoader) btnLoader.style.display = 'none';
    }
  }

  // Subscription modal event listeners
  subModalClose?.addEventListener('click', closeSubscriptionModal);
  subModal?.addEventListener('click', (e) => {
    if (e.target === subModal) closeSubscriptionModal();
  });
  subCheckoutEmail?.addEventListener('input', () => {
    if (subCheckoutError) subCheckoutError.style.display = 'none';
    validateSubCheckout();
  });
  subCheckoutBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    startSubscriptionCheckout();
  });
  subCheckoutEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !subCheckoutBtn?.disabled) {
      e.preventDefault();
      startSubscriptionCheckout();
    }
  });

  // ESC closes subscription modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && subModal?.classList.contains('open')) {
      closeSubscriptionModal();
    }
  });

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

  // Track focus before buy credits modal opens
  let lastFocusBeforeBuyModal = null;

  function openBuyCreditsModal(preselectedPlan = null) {
    if (!buyCreditsModal) return;

    // Store current focus before opening
    lastFocusBeforeBuyModal = document.activeElement;

    // Reset state
    clearPlanSelection();
    clearCheckoutError();

    buyCreditsModal.classList.add('open');
    buyCreditsModal.inert = false;

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
    requestAnimationFrame(() => {
      if (!preselectedPlan) {
        const firstPlan = buyCreditsModal.querySelector('.plan-card');
        if (firstPlan) firstPlan.focus();
      }
    });
  }

  function closeBuyCreditsModal() {
    if (!buyCreditsModal) return;

    // Move focus OUT before hiding
    if (buyCreditsModal.contains(document.activeElement)) {
      (lastFocusBeforeBuyModal || buyCreditsBtn || document.body).focus();
    }

    buyCreditsModal.classList.remove('open');
    buyCreditsModal.inert = true;

    // Reset state
    clearPlanSelection();
    clearCheckoutError();
  }

  // ─────────────────────────────────────────────────────────────
  // Video Buy Modal
  // ─────────────────────────────────────────────────────────────

  const videoBuyModal = document.getElementById('videoBuyModal');
  const videoBuyClose = document.getElementById('videoBuyClose');
  const videoBuyTitle = document.getElementById('videoBuyTitle');
  const videoBuySubtitle = document.getElementById('videoBuySubtitle');
  const videoBuyCredits = document.getElementById('videoBuyCredits');
  const videoBuyPrice = document.getElementById('videoBuyPrice');
  const videoBuyEmail = document.getElementById('videoBuyEmail');
  const videoBuyError = document.getElementById('videoBuyError');
  const videoBuyBtn = document.getElementById('videoBuyBtn');

  let selectedVideoPlan = null;
  let lastFocusBeforeVideoModal = null;

  function openVideoBuyModal(planId) {
    if (!videoBuyModal) return;

    const plan = VIDEO_PLANS[planId];
    if (!plan) {
      console.warn('[Credits] Unknown video plan:', planId);
      return;
    }

    selectedVideoPlan = planId;
    lastFocusBeforeVideoModal = document.activeElement;

    // Update modal content
    if (videoBuyTitle) videoBuyTitle.textContent = `Buy ${plan.name}`;
    if (videoBuySubtitle) videoBuySubtitle.textContent = 'One-time purchase. No subscription.';
    if (videoBuyCredits) videoBuyCredits.textContent = plan.credits.toLocaleString();
    if (videoBuyPrice) videoBuyPrice.textContent = `£${plan.price.toFixed(2)}`;

    // Pre-fill email if we have it
    if (videoBuyEmail && userEmail && !videoBuyEmail.value) {
      videoBuyEmail.value = userEmail;
    }

    // Clear previous error
    if (videoBuyError) {
      videoBuyError.style.display = 'none';
      videoBuyError.textContent = '';
    }

    // Validate form
    validateVideoBuyForm();

    videoBuyModal.classList.add('open');
    videoBuyModal.inert = false;

    requestAnimationFrame(() => {
      if (videoBuyEmail) videoBuyEmail.focus();
    });
  }

  function closeVideoBuyModal() {
    if (!videoBuyModal) return;

    if (videoBuyModal.contains(document.activeElement)) {
      (lastFocusBeforeVideoModal || document.body).focus();
    }

    videoBuyModal.classList.remove('open');
    videoBuyModal.inert = true;
    selectedVideoPlan = null;
  }

  function validateVideoBuyForm() {
    const email = videoBuyEmail?.value?.trim() || '';
    const isValid = isValidEmail(email) && selectedVideoPlan;
    if (videoBuyBtn) videoBuyBtn.disabled = !isValid;
    return isValid;
  }

  function showVideoBuyError(msg) {
    if (videoBuyError) {
      videoBuyError.textContent = msg;
      videoBuyError.style.display = 'block';
    }
  }

  async function startVideoCheckout() {
    if (!selectedVideoPlan || !validateVideoBuyForm()) return;

    const plan = VIDEO_PLANS[selectedVideoPlan];
    if (!plan) return;

    const email = videoBuyEmail?.value?.trim();

    // Show loading state
    if (videoBuyBtn) {
      videoBuyBtn.disabled = true;
      const btnText = videoBuyBtn.querySelector('.btn-text');
      const btnLoader = videoBuyBtn.querySelector('.btn-loader');
      if (btnText) btnText.style.display = 'none';
      if (btnLoader) btnLoader.style.display = '';
    }

    try {
      // Call POST /api/billing/checkout (Mollie) using centralized API client
      const result = await apiFetch('/api/billing/checkout', {
        method: 'POST',
        body: {
          plan_code: selectedVideoPlan,
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
          console.log('[Credits] Video: Stored payment_id for confirmation:', data.payment_id);
        }

        // Store current balance BEFORE redirect
        sessionStorage.setItem('timrx_pre_checkout_balance', String(walletAvailable || 0));
        console.log('[Credits] Video: Stored pre-checkout balance:', walletAvailable || 0);

        // Store the plan's credit grant for optimistic balance display
        sessionStorage.setItem('timrx_pending_plan_credits', String(plan.credits));
        console.log('[Credits] Video: Stored plan credits:', plan.credits);

        // Redirect to Mollie checkout
        window.location.href = data.checkout_url;
      } else {
        throw new Error('No checkout URL returned');
      }

    } catch (err) {
      console.error('[Credits] Video checkout error:', err);
      showVideoBuyError(err.message || 'Checkout failed. Please try again.');

      // Reset button
      if (videoBuyBtn) {
        videoBuyBtn.disabled = false;
        const btnText = videoBuyBtn.querySelector('.btn-text');
        const btnLoader = videoBuyBtn.querySelector('.btn-loader');
        if (btnText) btnText.style.display = '';
        if (btnLoader) btnLoader.style.display = 'none';
      }
    }
  }

  // Video modal event listeners
  videoBuyClose?.addEventListener('click', closeVideoBuyModal);

  videoBuyModal?.addEventListener('click', (e) => {
    if (e.target === videoBuyModal) closeVideoBuyModal();
  });

  videoBuyEmail?.addEventListener('input', () => {
    if (videoBuyError) videoBuyError.style.display = 'none';
    validateVideoBuyForm();
  });

  videoBuyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    startVideoCheckout();
  });

  videoBuyEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !videoBuyBtn?.disabled) {
      e.preventDefault();
      startVideoCheckout();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Success Modal - Driven by WalletStore as single source of truth
  // ─────────────────────────────────────────────────────────────

  // Track modal state
  const successModalState = {
    isOpen: false,
    isPending: true,
    preCheckoutBalance: 0,
  };

  // Track focus before success modal opens
  let lastFocusBeforeSuccessModal = null;

  /**
   * Open success modal
   * @param {number|null} credits - Credits to display (null = show "Updating...")
   * @param {boolean} isPending - Whether credits are still being processed
   */
  function openSuccessModal(credits, isPending = false) {
    if (!successModal) return;

    // Store current focus before opening
    lastFocusBeforeSuccessModal = document.activeElement;

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
    successModal.inert = false;
    // Focus the close button
    requestAnimationFrame(() => {
      const closeBtn = successModal.querySelector('button, [data-action="close"]');
      closeBtn?.focus();
    });
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
    // Move focus OUT before hiding
    if (successModal.contains(document.activeElement)) {
      (lastFocusBeforeSuccessModal || document.body).focus();
    }
    successModal.classList.remove('open');
    successModal.inert = true;
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

        // Store the plan's credit grant for optimistic balance display on return
        const planCredits = selectedPlan.credits || PLANS[selectedPlan.id]?.credits || 0;
        sessionStorage.setItem('timrx_pending_plan_credits', String(planCredits));
        console.log('[Credits] Stored plan credits:', planCredits);

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

  // Pricing page CTA buttons -> open modal with preselection (or subscription modal)
  pricingCtaButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const planId = btn.dataset.plan;

      if (pricingMode === 'one_time') {
        openBuyCreditsModal(planId);
      } else if (pricingMode === 'video') {
        // Video mode — open video buy modal
        openVideoBuyModal(planId);
      } else {
        // Subscription mode — open subscription modal
        const tier = CARD_TO_TIER[planId];
        if (tier) {
          openSubscriptionModal(tier, pricingMode);
        }
      }
    });
  });

  // Also attach listeners to video pricing buttons (they're in a separate grid)
  const videoPricingButtons = videoPricingGrid ? videoPricingGrid.querySelectorAll('.pricing-cta') : [];
  videoPricingButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const planId = btn.dataset.plan;
      openVideoBuyModal(planId);
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

  // Check if this was a subscription return
  const pendingSubPlan = sessionStorage.getItem('timrx_pending_sub_plan');

  if (checkoutStatus === 'success' && pendingSubPlan) {
    // ── Subscription return flow ──
    window.history.replaceState({}, '', window.location.pathname);
    sessionStorage.removeItem('timrx_pending_sub_plan');
    sessionStorage.removeItem('timrx_pre_checkout_balance');
    sessionStorage.removeItem('timrx_pending_payment_id');

    const subPlanInfo = Object.values(SUB_PLANS.monthly).concat(Object.values(SUB_PLANS.yearly))
      .filter(Boolean)
      .find(p => p.plan_code === pendingSubPlan);
    const planName = subPlanInfo ? subPlanInfo.name : 'Subscription';
    const creditsPerMonth = subPlanInfo ? subPlanInfo.credits_per_month : 0;

    // Show subscription success in the existing success modal
    successModalState.preCheckoutBalance = 0;

    // Open success modal with subscription-specific text
    if (successModal) {
      const successTitle = successModal.querySelector('.success-title, h2');
      const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
      const creditsDisplay = successModal.querySelector('.success-credits');

      if (successTitle) successTitle.textContent = 'Subscription Active';
      if (successMessage) successMessage.textContent = `Your ${planName} plan is active. ${creditsPerMonth} credits have been added.`;
      if (creditsDisplay) creditsDisplay.style.display = 'none';

      successModal.classList.remove('pending', 'failed');
      successModal.classList.add('open');
      successModal.inert = false;
      successModalState.isOpen = true;
      successModalState.isPending = false;
      // Focus close button
      requestAnimationFrame(() => {
        const closeBtn = successModal.querySelector('button, [data-action="close"]');
        closeBtn?.focus();
      });
    }

    // Refresh wallet to pick up the granted credits
    refreshCredits({ force: true, maxRetries: 5 });

  } else if (checkoutStatus === 'success') {
    // ── One-time purchase return flow (existing) ──
    // Clean URL immediately
    window.history.replaceState({}, '', window.location.pathname);

    // Get stored payment_id, pre-checkout balance, and plan credits from sessionStorage
    const pendingPaymentId = sessionStorage.getItem('timrx_pending_payment_id');
    const preCheckoutBalance = parseInt(sessionStorage.getItem('timrx_pre_checkout_balance') || '0', 10);
    const planCredits = parseInt(sessionStorage.getItem('timrx_pending_plan_credits') || '0', 10);

    // Calculate OPTIMISTIC balance immediately (don't wait for server)
    const optimisticBalance = preCheckoutBalance + planCredits;
    const displayBalance = walletAvailable || parseInt(localStorage.getItem('timrx_credits_last') || '0', 10);

    console.log('[Credits] Checkout success - pre:', preCheckoutBalance, 'plan credits:', planCredits, 'optimistic:', optimisticBalance);

    // Store pre-checkout balance in modal state for event listener comparison
    successModalState.preCheckoutBalance = preCheckoutBalance;

    // IMMEDIATELY show success modal with OPTIMISTIC balance (not pending state)
    // This gives instant feedback - user sees expected new balance right away
    if (planCredits > 0) {
      // We know how many credits were purchased - show optimistic balance immediately
      openSuccessModal(optimisticBalance, false);  // false = not pending, show as complete
      console.log('[Credits] Showing optimistic balance:', optimisticBalance);

      // Update local wallet state optimistically
      walletAvailable = optimisticBalance;
      walletBalance = optimisticBalance;
      WalletStore.update({
        balance: optimisticBalance,
        reserved: 0,
        available: optimisticBalance,
      });
    } else {
      // Fallback: no plan credits stored, show pending state
      openSuccessModal(displayBalance, true);
    }

    // Clean up stored values
    sessionStorage.removeItem('timrx_pre_checkout_balance');
    sessionStorage.removeItem('timrx_pending_plan_credits');

    // Run reconciliation in background (non-blocking)
    (async function reconcilePayment() {
      const initialBalance = preCheckoutBalance;

      // Step 1: If we have payment_id, call confirm endpoint with longer timeout
      if (pendingPaymentId) {
        console.log('[Credits] Confirming payment:', pendingPaymentId);

        try {
          const confirmResult = await apiFetch(`/api/billing/confirm?payment_id=${encodeURIComponent(pendingPaymentId)}`, {
            timeout: 20000  // Longer timeout for confirm
          });

          // Clear stored payment_id regardless of result
          sessionStorage.removeItem('timrx_pending_payment_id');

          if (confirmResult.ok && confirmResult.data) {
            const confirmData = confirmResult.data;
            console.log('[Credits] Confirm response:', confirmData);

            if (confirmData.ok && confirmData.credits_granted) {
              // Credits were granted - USE BALANCE FROM CONFIRM RESPONSE if available
              const newBalance = confirmData.available_credits ?? confirmData.balance_credits ?? null;

              if (newBalance !== null && newBalance > initialBalance) {
                // We have a valid balance from confirm response - update directly!
                console.log('[Credits] Using balance from confirm response:', newBalance);
                WalletStore.update({
                  balance: confirmData.balance_credits ?? newBalance,
                  reserved: confirmData.reserved_credits ?? 0,
                  available: newBalance,
                  identityId: confirmData.identity_id || identityId,
                  email: confirmData.email || userEmail,
                  emailVerified: confirmData.email_verified ?? emailVerified,
                });
                // Modal will auto-update via wallet event listener
                return;
              }

              // Fallback: refresh wallet if confirm didn't include balance
              console.log('[Credits] Credits confirmed but no balance in response, refreshing wallet...');
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

      // Step 2: Refresh wallet to reconcile with server (even if we showed optimistic balance)
      // This ensures our local state matches the server truth
      let attempts = 0;
      const maxAttempts = 10; // Fewer attempts since we already showed optimistic
      const pollInterval = 1000; // Slower polling since we're just reconciling

      async function reconcileBalance() {
        attempts++;

        try {
          const wallet = await fetchWallet({ force: true, timeout: 8000 });
          const serverBalance = wallet ? wallet.available : 0;

          console.log(`[Credits] Reconcile ${attempts}/${maxAttempts}: server=${serverBalance}, expected=${initialBalance + planCredits}`);

          // If server balance is what we expected (or higher), we're done
          if (serverBalance >= initialBalance + planCredits) {
            console.log('[Credits] Server balance confirmed:', serverBalance);
            // WalletStore.update already happened in fetchWallet, which triggers modal update
            return;
          }

          // If modal was showing pending state and balance increased, transition it
          if (successModalState.isPending && serverBalance > initialBalance) {
            console.log('[Credits] Balance increased, transitioning modal');
            transitionSuccessModalToComplete(serverBalance);
            return;
          }
        } catch (err) {
          console.warn(`[Credits] Reconcile ${attempts} error:`, err.message);
          // Continue reconciling on error
        }

        // Continue reconciling if not at max attempts
        if (attempts < maxAttempts) {
          setTimeout(reconcileBalance, pollInterval);
        } else if (successModalState.isPending) {
          // Max attempts reached but modal still pending - show fallback message
          console.log('[Credits] Max reconcile attempts - showing sync message');
          updateSuccessModalToSyncing();
        } else {
          console.log('[Credits] Reconciliation complete after max attempts');
        }
      }

      // Start reconciliation after a short delay (give webhook time to process)
      setTimeout(reconcileBalance, 500);
    })();
  } else if (checkoutStatus === 'cancelled' || checkoutStatus === 'failed' || checkoutStatus === 'expired') {
    // Clean URL and clear stored values
    window.history.replaceState({}, '', window.location.pathname);
    sessionStorage.removeItem('timrx_pending_payment_id');
    sessionStorage.removeItem('timrx_pending_sub_plan');
    if (checkoutStatus !== 'cancelled') {
      console.log(`[Credits] Checkout ${checkoutStatus}`);
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

  // Toggle button and modal elements
  const secureToggleBtn = document.getElementById('secureToggleBtn');
  const secureCreditsCard = document.getElementById('secureCreditsCard');
  const secureModalBackdrop = document.getElementById('secureModalBackdrop');
  const secureModalClose = document.getElementById('secureModalClose');
  const secureInfoWrap = document.getElementById('secureInfoWrap');
  const secureInfoBtn = document.getElementById('secureInfoBtn');
  const secureInfoPopover = document.getElementById('secureInfoPopover');

  // Track focus before modal opens
  let lastFocusBeforeSecureModal = null;

  // Restore success modal elements
  const restoreSuccessModal = document.getElementById('restoreSuccessModal');
  const restoreCreditsValue = document.getElementById('restoreCreditsValue');
  const restoreSuccessCloseBtn = document.getElementById('restoreSuccessCloseBtn');

  // Track focus before restore success modal opens
  let lastFocusBeforeRestoreModal = null;

  /**
   * Open the restore success modal with animation
   * @param {number} credits - The restored credits balance to display
   */
  function openRestoreSuccessModal(credits) {
    if (!restoreSuccessModal) return;

    // Store current focus before opening
    lastFocusBeforeRestoreModal = document.activeElement;

    // Update credits display
    if (restoreCreditsValue) {
      restoreCreditsValue.textContent = credits != null ? credits.toLocaleString() : '--';
    }

    // Force reflow to restart animations
    restoreSuccessModal.classList.remove('open');
    void restoreSuccessModal.offsetWidth;

    // Open modal
    restoreSuccessModal.classList.add('open');
    restoreSuccessModal.inert = false;

    // Focus the close button
    requestAnimationFrame(() => {
      restoreSuccessCloseBtn?.focus();
    });

    console.log('[Credits] Restore success modal opened with', credits, 'credits');
  }

  /**
   * Close the restore success modal
   */
  function closeRestoreSuccessModal() {
    if (!restoreSuccessModal) return;
    // Move focus OUT before hiding
    if (restoreSuccessModal.contains(document.activeElement)) {
      (lastFocusBeforeRestoreModal || document.body).focus();
    }
    restoreSuccessModal.classList.remove('open');
    restoreSuccessModal.inert = true;
  }

  // Restore success modal event listeners
  restoreSuccessCloseBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    closeRestoreSuccessModal();
  });

  // Backdrop click closes modal
  restoreSuccessModal?.addEventListener('click', (e) => {
    if (e.target === restoreSuccessModal) {
      closeRestoreSuccessModal();
    }
  });

  // ESC key closes restore modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && restoreSuccessModal?.classList.contains('open')) {
      closeRestoreSuccessModal();
    }
  });

  /**
   * Open the secure credits modal
   */
  function openSecureCreditsModal() {
    if (!secureCreditsCard) return;

    // Store current focus before opening
    lastFocusBeforeSecureModal = document.activeElement;

    // Show backdrop and modal
    secureModalBackdrop?.classList.add('visible');
    secureCreditsCard.classList.remove('collapsed');
    secureCreditsCard.classList.add('expanded');
    secureToggleBtn?.classList.add('expanded');
    secureToggleBtn?.setAttribute('aria-expanded', 'true');

    // Prevent body scroll
    document.body.style.overflow = 'hidden';

    // Focus the first input or close button
    requestAnimationFrame(() => {
      const firstInput = secureCreditsCard.querySelector('input:not([style*="display: none"])');
      if (firstInput) {
        firstInput.focus();
      } else {
        secureModalClose?.focus();
      }
    });
  }

  /**
   * Close the secure credits modal
   */
  function closeSecureCreditsModal() {
    if (!secureCreditsCard) return;

    // Hide backdrop and modal
    secureModalBackdrop?.classList.remove('visible');
    secureCreditsCard.classList.remove('expanded');
    secureCreditsCard.classList.add('collapsed');
    secureToggleBtn?.classList.remove('expanded');
    secureToggleBtn?.setAttribute('aria-expanded', 'false');

    // Restore body scroll
    document.body.style.overflow = '';

    // Restore focus
    if (lastFocusBeforeSecureModal) {
      lastFocusBeforeSecureModal.focus();
      lastFocusBeforeSecureModal = null;
    }
  }

  /**
   * Toggle the secure credits modal visibility
   */
  function toggleSecureCredits() {
    if (!secureCreditsCard) return;

    const isExpanded = secureCreditsCard.classList.contains('expanded');

    if (isExpanded) {
      closeSecureCreditsModal();
    } else {
      openSecureCreditsModal();
    }
  }

  // Toggle button event listener
  secureToggleBtn?.addEventListener('click', toggleSecureCredits);

  // Close button event listener
  secureModalClose?.addEventListener('click', closeSecureCreditsModal);

  // Backdrop click closes modal
  secureModalBackdrop?.addEventListener('click', closeSecureCreditsModal);

  // ESC key closes secure credits modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && secureCreditsCard?.classList.contains('expanded')) {
      closeSecureCreditsModal();
    }
  });

  // Initialize aria-expanded state
  if (secureToggleBtn && secureCreditsCard) {
    const isExpanded = secureCreditsCard.classList.contains('expanded');
    secureToggleBtn.setAttribute('aria-expanded', String(isExpanded));
  }

  // Open modal if navigated with #secure-credits hash (from 3dprint beacon)
  if (window.location.hash === '#secure-credits') {
    // Small delay to ensure DOM is ready
    setTimeout(() => {
      openSecureCreditsModal();
      // Clear the hash without triggering a scroll
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }, 100);
  }

  function openSecureInfo() {
    if (!secureInfoWrap || !secureInfoBtn || !secureInfoPopover) return;
    secureInfoWrap.classList.add('open');
    secureInfoPopover.inert = false;
    secureInfoBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSecureInfo() {
    if (!secureInfoWrap || !secureInfoBtn || !secureInfoPopover) return;
    // Move focus back to button if inside popover
    if (secureInfoPopover.contains(document.activeElement)) {
      secureInfoBtn.focus();
    }
    secureInfoWrap.classList.remove('open');
    secureInfoPopover.inert = true;
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

    // Also update email beacon visibility
    updateEmailBeaconUI();
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
   * Includes robust timeout handling with retry and background polling
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
    clearSecureMessages();  // Reset error state before new request

    // Show progress message for long requests
    setVerifyMessage('Verifying...');

    const endpoint = isRestoreMode
      ? '/api/auth/restore/redeem'
      : '/api/auth/email/verify';

    // Retry logic for timeout - backend may be slow but still processing
    const maxAttempts = 3;
    let lastResult = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        console.log(`[Credits] Verify retry ${attempt}/${maxAttempts - 1}`);
        clearSecureMessages();  // Clear previous error before retry
        setVerifyMessage(`Still verifying (attempt ${attempt + 1})...`);
        await new Promise(r => setTimeout(r, 2000));  // Wait longer between retries
      }

      try {
        const result = await apiFetch(endpoint, {
          method: 'POST',
          body: { email: pendingEmail, code }
        });

        lastResult = result;

        // If not a timeout, break out of retry loop
        if (!result.isTimeout) {
          break;
        }

        console.log(`[Credits] Verify attempt ${attempt + 1} timed out, will retry`);
      } catch (err) {
        console.error(`[Credits] Verify attempt ${attempt + 1} error:`, err);
        lastResult = { ok: false, error: err.message };
        break;
      }
    }

    const result = lastResult;

    // Handle timeout after all retries - poll /api/me multiple times to detect eventual success
    if (result?.isTimeout) {
      console.log('[Credits] Verify timed out after retries, will poll for success');
      setVerifyMessage('Verification taking longer than expected, checking status...');

      // Poll /api/me multiple times to detect eventual success
      const pollMaxAttempts = 5;
      const pollInterval = 3000;  // 3 seconds between polls

      for (let pollAttempt = 0; pollAttempt < pollMaxAttempts; pollAttempt++) {
        if (pollAttempt > 0) {
          await new Promise(r => setTimeout(r, pollInterval));
          setVerifyMessage(`Checking verification status (${pollAttempt + 1}/${pollMaxAttempts})...`);
        }

        try {
          const meResult = await apiFetch('/api/me', { timeout: 15000 });
          if (meResult.ok && meResult.data?.ok && meResult.data.email_verified && meResult.data.email === pendingEmail) {
            // Verification succeeded in background!
            console.log('[Credits] Verification confirmed via /api/me poll');
            clearSecureMessages();  // Clear any error messages
            const wasRestoreMode = isRestoreMode;  // Capture before resetting
            userEmail = pendingEmail;
            emailVerified = true;
            isRestoreMode = false;
            const restoredCredits = meResult.data.available_credits ?? 0;
            WalletStore.update({
              balance: meResult.data.balance_credits ?? 0,
              reserved: meResult.data.reserved_credits ?? 0,
              available: restoredCredits,
              identityId: meResult.data.identity_id,
              email: meResult.data.email,
              emailVerified: true,
            });
            if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
            showSecureState(3);
            verifyCodeBtn?.classList.remove('loading');
            // Show restore success popup if this was a restore operation
            if (wasRestoreMode) {
              openRestoreSuccessModal(restoredCredits);
            }
            return;
          }
        } catch (meErr) {
          console.warn(`[Credits] /api/me poll ${pollAttempt + 1} failed:`, meErr);
        }
      }

      // Still not verified after polling - show friendly error with retry suggestion
      setVerifyError('Verification is taking too long. Your code may still be processing. Please wait a moment and click Verify again.');
      verifyCodeBtn?.classList.remove('loading');
      return;
    }

    if (!result?.ok) {
      const errorCode = result?.data?.error?.code;
      if (errorCode === 'INVALID_CODE') {
        setVerifyError('Invalid or expired code');
      } else if (errorCode === 'TOO_MANY_ATTEMPTS') {
        setVerifyError('Too many attempts. Please request a new code.');
      } else if (errorCode === 'CODE_EXPIRED') {
        setVerifyError('Code has expired. Please request a new one.');
      } else if (errorCode === 'EMAIL_IN_USE') {
        // Email belongs to another identity - prompt before switching to restore mode
        const currentCredits = walletAvailable || 0;
        let shouldRestore = true;

        if (currentCredits > 0 && !emailVerified) {
          // Warn user about potential credit loss
          shouldRestore = window.confirm(
            `This email is linked to another account.\n\n` +
            `You currently have ${currentCredits} credits on this device. ` +
            `Restoring will switch you to the other account's credits.\n\n` +
            `Do you want to restore the other account?`
          );
        }

        if (!shouldRestore) {
          setVerifyError('Restore cancelled. Your current credits are preserved.');
          verifyCodeBtn?.classList.remove('loading');
          return;
        }

        // Auto-switch to restore mode and try again with the same code
        clearSecureMessages();
        setVerifyMessage('This email is linked to another account. Restoring...');
        isRestoreMode = true;
        setTimeout(async () => {
          const restoreResult = await apiFetch('/api/auth/restore/redeem', {
            method: 'POST',
            body: { email: pendingEmail, code }
          });
          if (restoreResult.ok) {
            console.log('[Credits] Account restored successfully');
            clearSecureMessages();
            userEmail = pendingEmail;
            emailVerified = true;
            isRestoreMode = false;
            const wallet = await fetchWallet();
            if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
            showSecureState(3);
            // Show restore success popup
            const restoredCredits = wallet?.available ?? walletAvailable ?? 0;
            openRestoreSuccessModal(restoredCredits);
          } else if (restoreResult.isTimeout) {
            // Poll /api/me multiple times for eventual success
            setVerifyMessage('Restore taking longer, checking status...');
            const pollMaxAttempts = 4;
            const pollInterval = 3000;

            for (let pollAttempt = 0; pollAttempt < pollMaxAttempts; pollAttempt++) {
              if (pollAttempt > 0) {
                await new Promise(r => setTimeout(r, pollInterval));
              }
              try {
                const meCheck = await apiFetch('/api/me', { timeout: 15000 });
                if (meCheck.ok && meCheck.data?.ok && meCheck.data.email === pendingEmail) {
                  console.log('[Credits] Restore confirmed via /api/me poll');
                  clearSecureMessages();
                  userEmail = pendingEmail;
                  emailVerified = true;
                  isRestoreMode = false;
                  const wallet = await fetchWallet();
                  if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
                  showSecureState(3);
                  verifyCodeBtn?.classList.remove('loading');
                  // Show restore success popup
                  const restoredCredits = wallet?.available ?? walletAvailable ?? 0;
                  openRestoreSuccessModal(restoredCredits);
                  return;
                }
              } catch (meErr) {
                console.warn(`[Credits] /api/me poll ${pollAttempt + 1} failed:`, meErr);
              }
            }
            setVerifyError('Restore is taking too long. Please wait a moment and try again.');
          } else {
            setVerifyError(restoreResult.error || 'Restore failed. Please try again.');
          }
          verifyCodeBtn?.classList.remove('loading');
        }, 500);
        return; // Don't remove loading state here - async handler will do it
      } else {
        setVerifyError(result?.error || 'Verification failed');
      }
      verifyCodeBtn?.classList.remove('loading');
      return;
    }

    // Success!
    console.log('[Credits] Email verified successfully');
    const wasRestoreMode = isRestoreMode; // Capture before resetting
    userEmail = pendingEmail;
    emailVerified = true;
    isRestoreMode = false;

    // Clear any messages and show success briefly
    clearSecureMessages();

    // Refresh wallet to get updated state (especially for restore)
    const wallet = await fetchWallet();

    // Show verified state
    if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
    showSecureState(3);
    verifyCodeBtn?.classList.remove('loading');

    // Show restore success popup if this was a restore operation
    if (wasRestoreMode) {
      const restoredCredits = wallet?.available ?? walletAvailable ?? 0;
      openRestoreSuccessModal(restoredCredits);
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
   * Shows warning if user has credits on current identity
   */
  function showRestoreMode() {
    // Check if user has credits on their current anonymous identity
    const currentCredits = walletAvailable || 0;

    if (currentCredits > 0 && !emailVerified) {
      // Warn user about potential credit loss
      const confirmRestore = window.confirm(
        `You currently have ${currentCredits} credits on this device.\n\n` +
        `If you restore a different account, you'll switch to that account's credits instead.\n\n` +
        `Do you want to continue with restore?`
      );

      if (!confirmRestore) {
        return; // User cancelled
      }
    }

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
  // EMAIL BEACON - Navbar beacon prompt to add email
  // ─────────────────────────────────────────────────────────────

  const emailBeacon = document.getElementById('emailBeacon');

  /**
   * Update email beacon visibility based on email state
   * Shows beacon if: no email attached
   */
  function updateEmailBeaconUI() {
    if (!emailBeacon) return;

    const shouldShow = !userEmail;

    if (shouldShow) {
      emailBeacon.classList.remove('hidden');
      console.log('[Credits] Email beacon shown - no email attached');
    } else {
      emailBeacon.classList.add('hidden');
      console.log('[Credits] Email beacon hidden - email attached');
    }
  }

  /**
   * Handle beacon click - open secure credits modal
   */
  function handleBeaconClick() {
    // Open the modal if not already open
    if (secureCreditsCard && !secureCreditsCard.classList.contains('expanded')) {
      openSecureCreditsModal();
    }
  }

  // Beacon event listener
  emailBeacon?.addEventListener('click', handleBeaconClick);

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

    // Also fetch subscription status
    await fetchSubscription();
  }, 500);

  // ─────────────────────────────────────────────────────────────
  // Subscription Management
  // ─────────────────────────────────────────────────────────────

  // DOM elements for subscription
  const subscriptionSection = document.getElementById('subscriptionSection');
  const subscriptionCard = document.getElementById('subscriptionCard');
  const subscriptionCancelledCard = document.getElementById('subscriptionCancelledCard');
  const subscriptionPlanName = document.getElementById('subscriptionPlanName');
  const subscriptionCredits = document.getElementById('subscriptionCredits');
  const subscriptionStatus = document.getElementById('subscriptionStatus');
  const subscriptionNext = document.getElementById('subscriptionNext');
  const cancelSubscriptionBtn = document.getElementById('cancelSubscriptionBtn');
  const cancelledPlanName = document.getElementById('cancelledPlanName');
  const subscriptionEndDate = document.getElementById('subscriptionEndDate');

  let currentSubscription = null;

  /**
   * Fetch user's subscription status
   */
  async function fetchSubscription() {
    try {
      const result = await apiFetch('/api/billing/subscriptions/me');
      if (result.ok && result.data?.ok) {
        currentSubscription = result.data.subscription;
        updateSubscriptionUI();
      }
    } catch (err) {
      console.warn('[Credits] Failed to fetch subscription:', err);
    }
  }

  /**
   * Update subscription UI based on current state
   */
  function updateSubscriptionUI() {
    if (!subscriptionCard || !subscriptionCancelledCard) return;

    if (!currentSubscription) {
      // No subscription - hide the entire section
      subscriptionSection?.classList.add('hidden');
      subscriptionCard.classList.add('hidden');
      subscriptionCancelledCard.classList.add('hidden');
      return;
    }

    const { plan_name, credits_per_month, status, current_period_end, cadence } = currentSubscription;

    if (status === 'cancelled') {
      // Show cancelled card
      subscriptionSection?.classList.remove('hidden');
      subscriptionCard.classList.add('hidden');
      subscriptionCancelledCard.classList.remove('hidden');

      if (cancelledPlanName) cancelledPlanName.textContent = plan_name;
      if (subscriptionEndDate && current_period_end) {
        subscriptionEndDate.textContent = formatDate(current_period_end);
      }
    } else if (status === 'active' || status === 'past_due') {
      // Show active subscription card
      subscriptionSection?.classList.remove('hidden');
      subscriptionCard.classList.remove('hidden');
      subscriptionCancelledCard.classList.add('hidden');

      if (subscriptionPlanName) subscriptionPlanName.textContent = plan_name;
      if (subscriptionCredits) subscriptionCredits.textContent = credits_per_month?.toLocaleString() || '--';

      if (subscriptionStatus) {
        subscriptionStatus.textContent = status === 'past_due' ? 'Past Due' : 'Active';
        subscriptionStatus.classList.toggle('past-due', status === 'past_due');
      }

      // Show next billing/renewal date
      if (subscriptionNext && current_period_end) {
        subscriptionNext.textContent = `${cadence === 'yearly' ? 'Renews' : 'Next billing'}: ${formatDate(current_period_end)}`;
      }
    } else {
      // Expired or other status - hide entire section
      subscriptionSection?.classList.add('hidden');
      subscriptionCard.classList.add('hidden');
      subscriptionCancelledCard.classList.add('hidden');
    }
  }

  /**
   * Format date for display
   */
  function formatDate(dateStr) {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Handle cancel subscription button click
   */
  async function handleCancelSubscription() {
    if (!currentSubscription) return;

    // Confirm cancellation
    const confirmed = confirm(
      `Are you sure you want to cancel your ${currentSubscription.plan_name} subscription?\n\n` +
      `You'll keep access to your remaining credits until ${formatDate(currentSubscription.current_period_end)}.`
    );

    if (!confirmed) return;

    if (cancelSubscriptionBtn) {
      cancelSubscriptionBtn.disabled = true;
      cancelSubscriptionBtn.textContent = 'Cancelling...';
    }

    try {
      const result = await apiFetch('/api/billing/subscriptions/cancel', {
        method: 'POST'
      });

      if (result.ok && result.data?.ok) {
        // Update local state
        currentSubscription.status = 'cancelled';
        updateSubscriptionUI();

        // Show confirmation
        alert(`Your subscription has been cancelled.\n\nYou can continue using your credits until ${formatDate(result.data.period_end || currentSubscription.current_period_end)}.`);
      } else {
        alert(result.data?.message || 'Failed to cancel subscription. Please try again or contact support.');
      }
    } catch (err) {
      console.error('[Credits] Cancel subscription error:', err);
      alert('Failed to cancel subscription. Please try again or contact support.');
    } finally {
      if (cancelSubscriptionBtn) {
        cancelSubscriptionBtn.disabled = false;
        cancelSubscriptionBtn.textContent = 'Cancel Subscription';
      }
    }
  }

  // Attach cancel button handler
  if (cancelSubscriptionBtn) {
    cancelSubscriptionBtn.addEventListener('click', handleCancelSubscription);
  }

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
    // Subscription management
    fetchSubscription: fetchSubscription,
    getSubscription: () => currentSubscription,
  };

  // Standardized ready flag for diagnostics (hub page)
  window.__TIMRX_CREDITS_READY__ = true;
  window.__TIMRX_CREDITS_PAGE__ = 'hub';
  console.log('[Credits] Hub credits module ready');

})();
