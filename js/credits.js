/**
 * credits.js
 * Handles credits display, wallet fetching, and buy credits modal for hub.html
 */

(function() {
  'use strict';

  // API endpoint - always use the custom domain for proper cookie handling
  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';

  // ─────────────────────────────────────────────────────────────
  // Checkout Funnel Analytics
  // Lightweight event tracking for the verify-before-checkout flow.
  // Dispatches a custom DOM event and logs to console.
  // If a global analytics handler is later added (gtag, posthog, etc.),
  // it can listen for 'timrx:checkout_funnel' events on window.
  // Never blocks UI — all failures are silently caught.
  // ─────────────────────────────────────────────────────────────
  function trackCheckoutEvent(eventName, metadata = {}) {
    try {
      const payload = { event: eventName, ts: Date.now(), ...metadata };
      console.log('[Funnel]', eventName, payload);
      window.dispatchEvent(new CustomEvent('timrx:checkout_funnel', { detail: payload }));
    } catch (_) { /* never block UI */ }
  }

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

  // Plan definitions (must match DB — plan codes kept for backward compat, credit_grant updated)
  // Pricing refactor Mar 2026
  const PLANS = {
    starter_250: { name: 'Starter', credits: 350, price: 7.99 },
    creator_900: { name: 'Creator', credits: 1100, price: 19.99 },
    studio_2200: { name: 'Studio', credits: 2400, price: 37.99 }
  };

  // Video plan definitions (video credits — separate pool) — Pricing refactor Mar 2026
  const VIDEO_PLANS = {
    video_starter_300: { name: 'Video Starter', credits: 550, price: 9.99 },
    video_creator_900: { name: 'Video Creator', credits: 1800, price: 29.99 },
    video_studio_2000: { name: 'Video Studio', credits: 4000, price: 59.99 }
  };

  // Subscription plan definitions (must match backend subscription_service.py)
  // Pricing refactor Mar 2026 — includes video bridge credits
  const SUB_PLANS = {
    monthly: {
      starter:  { plan_code: 'starter_monthly',  name: 'Starter', credits_per_month: 300,  video_credits_per_month: 100,  price: 9.99,   cadence: 'monthly' },
      creator:  { plan_code: 'creator_monthly',  name: 'Creator', credits_per_month: 800,  video_credits_per_month: 300,  price: 24.99,  cadence: 'monthly' },
      studio:   { plan_code: 'studio_monthly',   name: 'Studio',  credits_per_month: 2000, video_credits_per_month: 800,  price: 49.99,  cadence: 'monthly' },
    },
    yearly: {
      // Yearly = ~2 months free. Credits distributed monthly
      starter:  { plan_code: 'starter_yearly',   name: 'Starter', credits_per_month: 300,  video_credits_per_month: 100,  credits_total: 3600,  video_credits_total: 1200,  price: 99.00,  cadence: 'yearly' },
      creator:  { plan_code: 'creator_yearly',   name: 'Creator', credits_per_month: 800,  video_credits_per_month: 300,  credits_total: 9600,  video_credits_total: 3600,  price: 249.00, cadence: 'yearly' },
      studio:   { plan_code: 'studio_yearly',    name: 'Studio',  credits_per_month: 2000, video_credits_per_month: 800,  credits_total: 24000, video_credits_total: 9600,  price: 499.00, cadence: 'yearly' },
    },
  };

  // Tier benefits for UI display (must match backend TIER_PERKS)
  // Based on new action costs: image=4c, 3D model=20c
  const TIER_BENEFITS = {
    starter: {
      images: 75,       // 300 credits ÷ 4 per image
      models: 15,       // 300 credits ÷ 20 per model
      videos: 2,        // 100 video credits ÷ 45c (budget 5s) ≈ 2 short videos
      perks: ['Up to 75 AI images/mo', 'Up to 15 3D models/mo', '2 AI videos included/mo', 'GLB/GLTF downloads'],
    },
    creator: {
      images: 200,      // 800 credits ÷ 4 per image
      models: 40,       // 800 credits ÷ 20 per model
      videos: 6,        // 300 video credits ÷ 45c (budget 5s) ≈ 6 short videos
      perks: ['Up to 200 AI images/mo', 'Up to 40 3D models/mo', '6 AI videos included/mo', 'Priority queue'],
    },
    studio: {
      images: 500,      // 2000 credits ÷ 4 per image
      models: 100,      // 2000 credits ÷ 20 per model
      videos: 16,       // 800 video credits ÷ 45c (budget 5s) ≈ 17 short videos (conservative)
      perks: ['Up to 500 AI images/mo', 'Up to 100 3D models/mo', '16 AI videos included/mo', 'Pro priority queue'],
    },
  };

  // Map pricing card data-plan to subscription tier
  const CARD_TO_TIER = {
    starter_250:  'starter',
    creator_900:  'creator',
    studio_2200:  'studio',
  };

  // Dynamic bullet copy per pricing mode and tier — Pricing refactor Mar 2026
  const PLAN_BULLETS = {
    one_time: {
      starter: [
        'Up to 87 AI images',
        'Up to 17 3D models',
        'Refinements & retextures included',
        'GLB/GLTF downloads',
      ],
      creator: [
        'Up to 275 AI images',
        'Up to 55 3D models',
        'Refinements & retextures included',
        'GLB/GLTF downloads',
      ],
      studio: [
        'Up to 600 AI images',
        'Up to 120 3D models',
        'Refinements & retextures included',
        'Priority queue access',
      ],
    },
    monthly: {
      starter: [
        'Up to 75 AI images/mo',
        'Up to 15 3D models/mo',
        '2 AI videos included/mo',
        'Cancel anytime',
      ],
      creator: [
        'Up to 200 AI images/mo',
        'Up to 40 3D models/mo',
        '6 AI videos included/mo',
        'Priority queue',
      ],
      studio: [
        'Up to 500 AI images/mo',
        'Up to 100 3D models/mo',
        '16 AI videos included/mo',
        'Pro priority queue',
      ],
    },
    yearly: {
      starter: [
        'Billed yearly (12 monthly refills)',
        'Save ~2 months vs monthly',
        '2 AI videos included/mo',
        'Cancel anytime',
      ],
      creator: [
        'Billed yearly (12 monthly refills)',
        'Save ~2 months vs monthly',
        '6 AI videos included/mo',
        'Priority queue',
      ],
      studio: [
        'Billed yearly (12 monthly refills)',
        'Save ~2 months vs monthly',
        '16 AI videos included/mo',
        'Pro priority queue',
      ],
    },
  };

  // Current pricing mode
  let pricingMode = localStorage.getItem('timrx_pricing_mode') || 'one_time';

  // DOM elements
  const creditsPill = document.getElementById('creditsPill');
  const creditsValue = document.getElementById('creditsValue');
  const hoverGeneralValue = document.getElementById('hoverGeneralValue');
  const hoverVideoValue = document.getElementById('hoverVideoValue');
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

  // Checkout verify state elements (inline email verification before purchase)
  const checkoutEmailState = document.getElementById('checkoutEmailState');
  const checkoutVerifyState = document.getElementById('checkoutVerifyState');
  const checkoutSentToEmail = document.getElementById('checkoutSentToEmail');
  const checkoutVerifyCodeInput = document.getElementById('checkoutVerifyCode');
  const checkoutVerifyMessage = document.getElementById('checkoutVerifyMessage');
  const checkoutVerifyError = document.getElementById('checkoutVerifyError');
  const checkoutVerifyBtn = document.getElementById('checkoutVerifyBtn');
  const checkoutResendCodeBtn = document.getElementById('checkoutResendCode');
  const checkoutBackToEmailBtn = document.getElementById('checkoutBackToEmail');

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
      videoBalance: 0,
      videoReserved: 0,
      videoAvailable: 0,
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
        videoAvailable: this._state.videoAvailable,
        videoBalance: this._state.videoBalance,
        videoReserved: this._state.videoReserved,
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
      this._state.videoBalance = data.videoBalance ?? this._state.videoBalance;
      this._state.videoReserved = data.videoReserved ?? this._state.videoReserved;
      this._state.videoAvailable = data.videoAvailable ?? this._state.videoAvailable;
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

      // Detect identity change (session swap, restore) and notify open modals
      if (prev.identityId && this._state.identityId
          && prev.identityId !== this._state.identityId) {
        console.log('[WalletStore] Identity changed: %s → %s', prev.identityId, this._state.identityId);
        window.dispatchEvent(new CustomEvent('timrx:identity_changed', {
          detail: { prevId: prev.identityId, newId: this._state.identityId },
        }));
      }

      console.log('[WalletStore] Updated: general=%d video=%d (was: %d/%d)',
        this._state.available, this._state.videoAvailable, prev.available, prev.videoAvailable);
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
  let _walletFetchInFlight = null;
  let _walletFetchedAt = 0;

  async function fetchWallet(options = {}) {
    const { force = false, timeout = 15000 } = options;

    // Dedupe: return in-flight promise if one exists
    if (_walletFetchInFlight && !force) {
      return _walletFetchInFlight;
    }

    // Skip if fetched recently (within 5s) unless forced
    const now = Date.now();
    if (!force && _walletFetchedAt && (now - _walletFetchedAt) < 5000) {
      return null;
    }

    console.log('[Credits] Fetching wallet from:', `${API_BASE}/api/me`, force ? '(forced)' : '');
    WalletStore.setFetching(true);

    _walletFetchInFlight = apiFetch('/api/me', { timeout });
    const result = await _walletFetchInFlight;
    _walletFetchInFlight = null;
    _walletFetchedAt = Date.now();

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
      const videoBalance = data.balance_video_credits ?? 0;
      const videoReserved = data.reserved_video_credits ?? 0;
      const videoAvailable = data.available_video_credits ?? Math.max(0, videoBalance - videoReserved);

      // Update WalletStore (this also broadcasts the event and updates module vars)
      WalletStore.update({
        balance,
        reserved,
        available,
        videoBalance,
        videoReserved,
        videoAvailable,
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

    // Show available general credits
    creditsValue.textContent = available.toLocaleString();

    // Add visual indicator if credits are low
    if (creditsPill) {
      creditsPill.classList.toggle('low', available < 30 && available > 0);
      creditsPill.classList.toggle('empty', available === 0);
      // Hide plus icon when user has credits
      creditsPill.classList.toggle('has-credits', available > 0);
    }

    // Update hover panel with both pool balances (values are pre-populated so panel is instant on CSS :hover)
    const videoAvail = WalletStore._state.videoAvailable || 0;
    if (hoverGeneralValue) hoverGeneralValue.textContent = available.toLocaleString();
    if (hoverVideoValue) hoverVideoValue.textContent = videoAvail.toLocaleString();

    console.log('[Credits] UI updated: available=' + available + ', total=' + total + ', reserved=' + reserved + ', video=' + videoAvail);
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
  const subCheckoutMessage = document.getElementById('subCheckoutMessage');
  const subCheckoutBtn = document.getElementById('subCheckoutBtn');
  // Verification state elements
  const subEmailState = document.getElementById('subEmailState');
  const subVerifyState = document.getElementById('subVerifyState');
  const subSentToEmail = document.getElementById('subSentToEmail');
  const subVerifyCode = document.getElementById('subVerifyCode');
  const subVerifyError = document.getElementById('subVerifyError');
  const subVerifyMessage = document.getElementById('subVerifyMessage');
  const subVerifyBtn = document.getElementById('subVerifyBtn');
  const subResendCode = document.getElementById('subResendCode');
  const subBackToEmail = document.getElementById('subBackToEmail');

  let selectedSubPlan = null;
  let subPendingEmail = null;  // Email pending verification for subscription
  let subIsRestoreMode = false;  // Whether we're restoring another identity's email

  /**
   * One-time card content per tier (original values)
   */
  const ONE_TIME_CARDS = {
    starter: { price: '£7.99', sub: '350 Credits', btn: 'Get Starter' },
    creator: { price: '£19.99', sub: '1,100 Credits', btn: 'Get Creator' },
    studio:  { price: '£37.99', sub: '2,400 Credits', btn: 'Get Studio' },
  };

  /**
   * Switch pricing mode and update card content
   */
  function setPricingMode(mode) {
    pricingMode = mode;
    localStorage.setItem('timrx_pricing_mode', mode);

    // Notify calculator of mode change
    window.dispatchEvent(new CustomEvent('timrx:pricing-mode', { detail: { mode } }));

    // Update pill active state
    modePills.forEach(pill => {
      pill.classList.toggle('active', pill.dataset.mode === mode);
    });

    // Handle video mode - show/hide appropriate grids
    if (mode === 'video') {
      if (modelPricingGrid) modelPricingGrid.style.display = 'none';
      if (videoPricingGrid) videoPricingGrid.style.display = '';
      if (pricingFootNote) pricingFootNote.textContent = 'Video sold separately · 1 video ≈ 45–240 credits';
      return;
    } else {
      if (modelPricingGrid) modelPricingGrid.style.display = '';
      if (videoPricingGrid) videoPricingGrid.style.display = 'none';
      // Simplified footer - no internal math explanations
      if (pricingFootNote) pricingFootNote.textContent = 'AI Image from 4 credits · 3D from 3–30 credits · 5s video from 45 credits · 8s standard video from 96 credits · Subscriptions include general + video credits';
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
      const listEl = card.querySelector('.pc-list');

      // Update bullets based on mode
      const bullets = PLAN_BULLETS[mode]?.[tier];
      if (listEl && bullets) {
        listEl.innerHTML = bullets.map(b => `<li>${b}</li>`).join('');
      }

      if (mode === 'one_time') {
        const info = ONE_TIME_CARDS[tier];
        if (priceEl) priceEl.textContent = info.price;
        if (subEl) subEl.textContent = info.sub;
        if (ctaBtn) ctaBtn.textContent = info.btn;
      } else {
        const cadence = mode; // 'monthly' or 'yearly'
        const plan = SUB_PLANS[cadence]?.[tier];
        if (!plan) {
          // No plan for this tier/cadence — hide or grey out
          if (priceEl) priceEl.textContent = '—';
          if (subEl) subEl.textContent = 'Not available';
          if (ctaBtn) {
            ctaBtn.textContent = 'Not Available';
            ctaBtn.disabled = true;
          }
          return;
        }
        const priceStr = `£${plan.price.toFixed(2)}`;
        if (priceEl) priceEl.textContent = priceStr;
        // Show credits appropriately for each cadence
        if (cadence === 'yearly') {
          // Yearly: show total credits for the year
          if (subEl) subEl.textContent = `${plan.credits_total.toLocaleString()} Credits/year`;
        } else {
          // Monthly: show credits per month
          if (subEl) subEl.textContent = `${plan.credits_per_month.toLocaleString()} Credits/month`;
        }
        if (ctaBtn) {
          ctaBtn.textContent = `Subscribe ${plan.name}`;
          ctaBtn.disabled = false;
        }
      }
    });

    // Update converted prices after cards are rendered
    updateConvertedPrices();
  }

  // ─────────────────────────────────────────────────────────────
  // Multi-Currency Price Display (uses TimrXFx)
  // ─────────────────────────────────────────────────────────────

  /**
   * Update all pricing cards with converted prices.
   * Called after setPricingMode and when FX data becomes available.
   */
  function updateConvertedPrices() {
    // Check if TimrXFx is available
    if (!window.TimrXFx) return;

    const fxContext = window.__TIMRX_FX_CONTEXT__;
    if (!fxContext || !fxContext.hasConversion) {
      // Remove any existing converted price elements if no conversion
      document.querySelectorAll('.price-converted').forEach(el => el.remove());
      return;
    }

    const { targetCurrency, rates } = fxContext;

    // Update each pricing card
    pricingCards.forEach(card => {
      const priceEl = card.querySelector('.pc-price');
      if (!priceEl) return;

      // Get the GBP price from the card's data or current mode
      const ctaBtn = card.querySelector('.pricing-cta');
      if (!ctaBtn) return;

      const planId = ctaBtn.dataset.plan;
      const tier = CARD_TO_TIER[planId];
      if (!tier) return;

      let gbpPrice = 0;
      if (pricingMode === 'one_time') {
        // One-time prices: parse from ONE_TIME_CARDS
        const priceStr = ONE_TIME_CARDS[tier]?.price || '£0';
        gbpPrice = parseFloat(priceStr.replace('£', ''));
      } else {
        // Subscription prices
        const plan = SUB_PLANS[pricingMode]?.[tier];
        if (plan) gbpPrice = plan.price;
      }

      if (!gbpPrice) return;

      // Remove existing converted price if any
      const existingConverted = priceEl.querySelector('.price-converted');
      if (existingConverted) existingConverted.remove();

      // Add converted price
      const convertedHtml = window.TimrXFx.getConvertedPriceHtml(gbpPrice, targetCurrency, rates);
      if (convertedHtml) {
        priceEl.insertAdjacentHTML('beforeend', convertedHtml);
      }
    });
  }

  /**
   * Initialize FX conversion display.
   * Called when TimrXFx finishes loading rates.
   */
  function initFxDisplay() {
    if (window.__TIMRX_FX_CONTEXT__) {
      updateConvertedPrices();
    } else if (window.TimrXFx) {
      // Wait for FX context to be ready
      window.TimrXFx.init().then(ctx => {
        window.__TIMRX_FX_CONTEXT__ = ctx;
        updateConvertedPrices();
      });
    }
  }

  // Initialize FX display after a short delay (allow fx.js to load)
  setTimeout(initFxDisplay, 100);

  // Toggle event listeners
  modePills.forEach(pill => {
    pill.addEventListener('click', () => {
      setPricingMode(pill.dataset.mode);
    });
  });

  // Initialize pricing mode on load (always call to update bullets)
  setPricingMode(pricingMode);

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

    // Build converted price label if FX available
    let convertedLabel = '';
    const fxContext = window.__TIMRX_FX_CONTEXT__;
    if (fxContext?.hasConversion && window.TimrXFx) {
      const { targetCurrency, rates } = fxContext;
      const converted = window.TimrXFx.convert(plan.price, targetCurrency, rates);
      if (converted !== null) {
        const formatted = window.TimrXFx.formatCurrency(converted, targetCurrency);
        convertedLabel = `<span class="checkout-converted">≈ ${formatted} ${targetCurrency} <span class="price-disclaimer">(charged in GBP)</span></span>`;
      }
    }

    if (subModalTitle) subModalTitle.textContent = `Subscribe — ${plan.name}`;
    const videoPerMonth = plan.video_credits_per_month || 0;
    if (subModalSubtitle) {
      subModalSubtitle.textContent = videoPerMonth > 0
        ? `${plan.credits_per_month} general + ${videoPerMonth} video credits every month. Cancel anytime.`
        : `${plan.credits_per_month} credits every month. Cancel anytime.`;
    }
    if (subModalCredits) subModalCredits.textContent = plan.credits_per_month.toLocaleString();
    const subModalVideoCredits = document.getElementById('subModalVideoCredits');
    const subModalVideoRow = document.getElementById('subModalVideoRow');
    if (subModalVideoCredits) subModalVideoCredits.textContent = videoPerMonth.toLocaleString();
    if (subModalVideoRow) subModalVideoRow.style.display = videoPerMonth > 0 ? '' : 'none';
    if (subModalCadence) subModalCadence.textContent = cadenceLabel;
    if (subModalPrice) subModalPrice.innerHTML = priceLabel + convertedLabel;

    // Pre-fill email
    if (subCheckoutEmail && userEmail) {
      subCheckoutEmail.value = userEmail;
      // If email is verified, make field read-only (security: backend enforces this)
      if (emailVerified) {
        subCheckoutEmail.readOnly = true;
        subCheckoutEmail.classList.add('verified-email');
        subCheckoutEmail.title = 'Using your verified email address';
      } else {
        subCheckoutEmail.readOnly = false;
        subCheckoutEmail.classList.remove('verified-email');
        subCheckoutEmail.title = '';
      }
    }

    // Reset state machine to email input state
    subPendingEmail = null;
    subIsRestoreMode = false;
    showSubEmailState();
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

  // ─────────────────────────────────────────────────────────────
  // Subscription Modal - Email Verification State Machine
  // States: email_input -> sending_code -> code_input -> verifying -> checkout
  // ─────────────────────────────────────────────────────────────

  function showSubError(msg, isVerify = false) {
    const el = isVerify ? subVerifyError : subCheckoutError;
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }

  function showSubMessage(msg, isVerify = false) {
    const el = isVerify ? subVerifyMessage : subCheckoutMessage;
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }

  function clearSubMessages(isVerify = false) {
    if (isVerify) {
      if (subVerifyError) subVerifyError.style.display = 'none';
      if (subVerifyMessage) subVerifyMessage.style.display = 'none';
    } else {
      if (subCheckoutError) subCheckoutError.style.display = 'none';
      if (subCheckoutMessage) subCheckoutMessage.style.display = 'none';
    }
  }

  function showSubEmailState() {
    if (subEmailState) subEmailState.style.display = 'block';
    if (subVerifyState) subVerifyState.style.display = 'none';
    clearSubMessages(false);
    clearSubMessages(true);
  }

  function showSubVerifyState() {
    if (subEmailState) subEmailState.style.display = 'none';
    if (subVerifyState) subVerifyState.style.display = 'block';
    if (subSentToEmail) subSentToEmail.textContent = subPendingEmail;
    if (subVerifyCode) {
      subVerifyCode.value = '';
      subVerifyCode.focus();
    }
    clearSubMessages(true);
  }

  function setSubBtnLoading(btn, loading) {
    if (!btn) return;
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    btn.disabled = loading;
    if (btnText) btnText.style.display = loading ? 'none' : '';
    if (btnLoader) btnLoader.style.display = loading ? 'inline-flex' : 'none';
  }

  /**
   * Step 1: User clicks Continue - check if email verified, else start verification
   */
  async function handleSubEmailContinue() {
    if (!validateSubCheckout()) {
      showSubError('Please enter a valid email.');
      return;
    }

    const email = subCheckoutEmail.value.trim();
    clearSubMessages(false);
    setSubBtnLoading(subCheckoutBtn, true);

    // If user already has this email verified, go straight to checkout
    if (emailVerified && userEmail && userEmail.toLowerCase() === email.toLowerCase()) {
      console.log('[Credits] Email already verified, proceeding to checkout');
      await executeSubCheckout();
      return;
    }

    // Otherwise, need to verify email first - send code via attach
    subPendingEmail = email;
    subIsRestoreMode = false;
    showSubMessage('Sending verification code...');

    try {
      const result = await apiFetch('/api/auth/email/attach', {
        method: 'POST',
        body: { email }
      });

      // Note: attach returns 200 even if email belongs to another identity (anti-enumeration).
      // Cross-identity cases: server switches session to the email-owning account.
      if (result.ok || result.status === 200) {
        setSubBtnLoading(subCheckoutBtn, false);

        if (result.data?.hint === 'account_switch_required') {
          // Email belongs to another account — do NOT show verify state
          // (no code was sent for this identity). Guide to restore instead.
          showSubError('This email belongs to another account. Use Restore to switch accounts.', false);
          return;
        }

        console.log('[Credits] Verification code sent to:', email);
        showSubVerifyState();
      } else {
        throw new Error(result.error || 'Failed to send verification code');
      }
    } catch (err) {
      console.error('[Credits] Failed to send code:', err);
      showSubError(err.message || 'Failed to send code. Please try again.');
      setSubBtnLoading(subCheckoutBtn, false);
    }
  }

  /**
   * Step 2: User enters code and clicks Verify & Subscribe
   */
  async function handleSubVerifyCode() {
    const code = subVerifyCode?.value?.trim() || '';

    if (code.length !== 6 || !/^\d+$/.test(code)) {
      showSubError('Code must be 6 digits', true);
      return;
    }

    clearSubMessages(true);
    setSubBtnLoading(subVerifyBtn, true);
    showSubMessage('Verifying...', true);

    const endpoint = subIsRestoreMode
      ? '/api/auth/restore/redeem'
      : '/api/auth/email/verify';

    try {
      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: { email: subPendingEmail, code }
      });

      if (result.ok) {
        // Email verified/restored successfully
        console.log('[Credits] Email verified, refreshing session...');
        // If identity changed via cross-identity account switch, clear stale caches
        if (result.data?.identity_changed && window.TimrXApi?.clearAllUserCaches) {
          window.TimrXApi.clearAllUserCaches();
          if (window.clearLocalHistoryCache) window.clearLocalHistoryCache();
        }
        showSubMessage('Email verified! Starting checkout...', true);

        // Refresh session to get updated identity
        await refreshIdentityAndCheckout();
        return;
      }

      // Handle specific error codes
      const errorCode = result.data?.error?.code || result.data?.code;

      if (errorCode === 'INVALID_CODE') {
        showSubError('Invalid or expired code', true);
      } else if (errorCode === 'TOO_MANY_ATTEMPTS') {
        showSubError('Too many attempts. Please request a new code.', true);
      } else if (errorCode === 'CODE_EXPIRED') {
        showSubError('Code has expired. Please request a new one.', true);
      } else {
        showSubError((result.isHtml || result.status >= 500) ? 'Verification failed. Please try again.' : (result.error || 'Verification failed'), true);
      }

      setSubBtnLoading(subVerifyBtn, false);
    } catch (err) {
      console.error('[Credits] Verification error:', err);
      showSubError(err.message || 'Verification failed', true);
      setSubBtnLoading(subVerifyBtn, false);
    }
  }

  /**
   * Refresh identity after verify/restore, then proceed to checkout
   */
  async function refreshIdentityAndCheckout() {
    try {
      // Refresh session to get updated identity
      const meResult = await apiFetch('/api/me', { timeout: 15000 });
      if (meResult.ok && meResult.data?.ok) {
        userEmail = meResult.data.email;
        emailVerified = meResult.data.email_verified || false;
        identityId = meResult.data.identity_id;

        WalletStore.update({
          balance: meResult.data.balance_credits ?? 0,
          reserved: meResult.data.reserved_credits ?? 0,
          available: meResult.data.available_credits ?? 0,
          videoBalance: meResult.data.balance_video_credits ?? 0,
          videoReserved: meResult.data.reserved_video_credits ?? 0,
          videoAvailable: meResult.data.available_video_credits ?? 0,
          identityId: meResult.data.identity_id,
          email: meResult.data.email,
          emailVerified: meResult.data.email_verified,
        });
      }

      // Now execute the checkout
      await executeSubCheckout();
    } catch (err) {
      console.error('[Credits] Failed to refresh identity:', err);
      showSubError('Failed to refresh session. Please try again.', true);
      setSubBtnLoading(subVerifyBtn, false);
    }
  }

  /**
   * Execute the actual checkout API call.
   * Uses an in-flight guard to prevent double-submit even if the button
   * loading state is somehow bypassed (e.g. rapid Enter key).
   */
  let _subCheckoutInFlight = false;

  async function executeSubCheckout() {
    if (!selectedSubPlan) {
      showSubError('No plan selected');
      setSubBtnLoading(subCheckoutBtn, false);
      setSubBtnLoading(subVerifyBtn, false);
      return;
    }

    // ── Double-submit guard ──────────────────────────────────────
    if (_subCheckoutInFlight) {
      console.warn('[Credits] Subscription checkout already in-flight, ignoring duplicate call');
      return;
    }
    _subCheckoutInFlight = true;

    try {
      const result = await apiFetch('/api/billing/subscriptions/checkout', {
        method: 'POST',
        body: {
          plan_code: selectedSubPlan.plan_code,
        },
      });

      if (!result.ok) {
        const errorCode = result.data?.error?.code || result.data?.code;

        // If still EMAIL_REQUIRED or EMAIL_NOT_VERIFIED, show message and stay in verify state
        if (result.status === 403 && (errorCode === 'EMAIL_REQUIRED' || errorCode === 'EMAIL_NOT_VERIFIED')) {
          console.log('[Credits] Checkout requires email verification:', errorCode);
          showSubError('Email verification required. Please verify your email.', true);
          setSubBtnLoading(subVerifyBtn, false);
          setSubBtnLoading(subCheckoutBtn, false);
          return;
        }

        // Handle other billing errors
        if (handleBillingError(result, 'subscription-checkout')) {
          closeSubscriptionModal();
          return;
        }

        throw new Error(result.data?.error?.message || result.data?.error || result.error || 'Checkout failed');
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
      const isVerifyVisible = subVerifyState && subVerifyState.style.display !== 'none';
      showSubError(err.message || 'Failed to start checkout. Please try again.', isVerifyVisible);
      setSubBtnLoading(subCheckoutBtn, false);
      setSubBtnLoading(subVerifyBtn, false);
      _subCheckoutInFlight = false;  // Reset guard on error so user can retry
    }
  }

  /**
   * Resend verification code
   */
  async function handleSubResendCode() {
    if (!subPendingEmail) return;

    clearSubMessages(true);
    showSubMessage('Resending code...', true);

    try {
      const result = await apiFetch('/api/auth/email/attach', {
        method: 'POST',
        body: { email: subPendingEmail }
      });

      if (result.ok || result.status === 200) {
        showSubMessage('New code sent!', true);
        if (subVerifyCode) subVerifyCode.value = '';
      } else {
        showSubError(result.error || 'Failed to resend code', true);
      }
    } catch (err) {
      showSubError('Failed to resend code', true);
    }
  }

  /**
   * Go back to email input state
   */
  function handleSubBackToEmail() {
    subPendingEmail = null;
    subIsRestoreMode = false;
    showSubEmailState();
    if (subCheckoutEmail) subCheckoutEmail.focus();
  }

  // Subscription modal event listeners
  subModalClose?.addEventListener('click', closeSubscriptionModal);
  subModal?.addEventListener('click', (e) => {
    if (e.target === subModal) closeSubscriptionModal();
  });
  subCheckoutEmail?.addEventListener('input', () => {
    clearSubMessages(false);
    validateSubCheckout();
  });
  subCheckoutBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    handleSubEmailContinue();
  });
  subCheckoutEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !subCheckoutBtn?.disabled) {
      e.preventDefault();
      handleSubEmailContinue();
    }
  });
  // Verify state event listeners
  subVerifyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    handleSubVerifyCode();
  });
  subVerifyCode?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubVerifyCode();
    }
  });
  subResendCode?.addEventListener('click', (e) => {
    e.preventDefault();
    handleSubResendCode();
  });
  subBackToEmail?.addEventListener('click', (e) => {
    e.preventDefault();
    handleSubBackToEmail();
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
    trackCheckoutEvent('plan_selected', { flow: 'general', plan: planId });

    // Update UI - highlight selected plan card
    planCards.forEach(card => {
      const cardPlan = card.dataset.plan;
      card.classList.toggle('selected', cardPlan === planId);
    });

    // Update selected plan display
    if (selectedPlanName) selectedPlanName.textContent = plan.name;
    if (selectedPlanPrice) {
      let priceHtml = `£${plan.price.toFixed(2)}`;

      // Add converted price if FX available
      const fxContext = window.__TIMRX_FX_CONTEXT__;
      if (fxContext?.hasConversion && window.TimrXFx) {
        const { targetCurrency, rates } = fxContext;
        const converted = window.TimrXFx.convert(plan.price, targetCurrency, rates);
        if (converted !== null) {
          const formatted = window.TimrXFx.formatCurrency(converted, targetCurrency);
          priceHtml += `<span class="checkout-converted">≈ ${formatted} ${targetCurrency} <span class="price-disclaimer">(charged in GBP)</span></span>`;
        }
      }
      selectedPlanPrice.innerHTML = priceHtml;
    }

    // Show checkout section
    if (checkoutSection) {
      checkoutSection.classList.add('visible');
    }

    // Update button mode based on verification status
    if (emailVerified) {
      setCheckoutBtnMode('buy');
    } else {
      setCheckoutBtnMode('continue');
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
    if (selectedPlanPrice) selectedPlanPrice.innerHTML = '-';
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
    generalVerifier.reset();

    buyCreditsModal.classList.add('open');
    buyCreditsModal.inert = false;

    // Preselect plan if specified
    if (preselectedPlan && PLANS[preselectedPlan]) {
      selectPlan(preselectedPlan);
    }

    // Pre-fill email if we have it
    if (checkoutEmail && userEmail) {
      checkoutEmail.value = userEmail;
      if (emailVerified) {
        // Verified user: read-only email, button says "Buy · £X.xx"
        checkoutEmail.readOnly = true;
        checkoutEmail.classList.add('verified-email');
        checkoutEmail.title = 'Using your verified email address';
        setCheckoutBtnMode('buy');
      } else {
        // Unverified: editable email, button says "Continue"
        checkoutEmail.readOnly = false;
        checkoutEmail.classList.remove('verified-email');
        checkoutEmail.title = '';
        setCheckoutBtnMode('continue');
      }
      validateCheckoutForm();
    } else {
      // No email at all — anonymous user, button says "Continue"
      setCheckoutBtnMode('continue');
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

    // Best-effort: track if user had started verification but abandoned
    if (selectedPlan && generalVerifier.pendingEmail) {
      trackCheckoutEvent('abandoned_before_verify', { flow: 'general', plan: selectedPlan.id });
    }

    // Move focus OUT before hiding
    if (buyCreditsModal.contains(document.activeElement)) {
      (lastFocusBeforeBuyModal || buyCreditsBtn || document.body).focus();
    }

    buyCreditsModal.classList.remove('open');
    buyCreditsModal.inert = true;

    // Reset state
    clearPlanSelection();
    clearCheckoutError();
    generalVerifier.reset();
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

  // Video verify state elements (inline email verification before video purchase)
  const videoBuyEmailState = document.getElementById('videoBuyEmailState');
  const videoBuyVerifyState = document.getElementById('videoBuyVerifyState');
  const videoBuySentToEmail = document.getElementById('videoBuySentToEmail');
  const videoBuyVerifyCodeInput = document.getElementById('videoBuyVerifyCode');
  const videoBuyVerifyMessage = document.getElementById('videoBuyVerifyMessage');
  const videoBuyVerifyError = document.getElementById('videoBuyVerifyError');
  const videoBuyVerifyBtn = document.getElementById('videoBuyVerifyBtn');
  const videoBuyResendCodeBtn = document.getElementById('videoBuyResendCode');
  const videoBuyBackToEmailBtn = document.getElementById('videoBuyBackToEmail');

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
    trackCheckoutEvent('plan_selected', { flow: 'video', plan: planId });

    // Update modal content
    if (videoBuyTitle) videoBuyTitle.textContent = `Buy ${plan.name}`;
    if (videoBuySubtitle) videoBuySubtitle.textContent = 'One-time purchase. No subscription.';
    if (videoBuyCredits) videoBuyCredits.textContent = plan.credits.toLocaleString();
    if (videoBuyPrice) videoBuyPrice.textContent = `£${plan.price.toFixed(2)}`;

    // Reset verify state (uses shared verification layer)
    videoVerifier.reset();

    // Pre-fill email if we have it
    if (videoBuyEmail && userEmail) {
      videoBuyEmail.value = userEmail;
      if (emailVerified) {
        videoBuyEmail.readOnly = true;
        videoBuyEmail.classList.add('verified-email');
        videoBuyEmail.title = 'Using your verified email address';
        setVideoBuyBtnMode('buy');
      } else {
        videoBuyEmail.readOnly = false;
        videoBuyEmail.classList.remove('verified-email');
        videoBuyEmail.title = '';
        setVideoBuyBtnMode('continue');
      }
    } else {
      setVideoBuyBtnMode('continue');
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

    // Best-effort: track if user had started verification but abandoned
    if (selectedVideoPlan && videoVerifier.pendingEmail) {
      trackCheckoutEvent('abandoned_before_verify', { flow: 'video', plan: selectedVideoPlan });
    }

    if (videoBuyModal.contains(document.activeElement)) {
      (lastFocusBeforeVideoModal || document.body).focus();
    }

    videoBuyModal.classList.remove('open');
    videoBuyModal.inert = true;
    selectedVideoPlan = null;
    videoVerifier.reset();
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

    // Handoff guard: ensure verified identity still matches current session
    if (!validateCheckoutHandoff('video')) {
      showVideoBuyError('Your account changed during verification. Please confirm checkout again.');
      videoVerifier.reset();
      return;
    }

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
        // Check for billing-specific errors (401/403)
        if (handleBillingError(result, 'video-checkout')) {
          closeVideoBuyModal();
          return;
        }

        // Checkout idempotency — a payment session already exists for this identity
        if (result.data?.error_code === 'CHECKOUT_IN_PROGRESS' || result.data?.error === 'checkout_in_progress') {
          const retryAfter = result.data.retry_after_seconds || 60;
          showVideoBuyCooldown(retryAfter);
          return;
        }

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
        sessionStorage.setItem('timrx_pre_checkout_video_balance', String(WalletStore._state.videoAvailable || 0));
        console.log('[Credits] Video: Stored pre-checkout balance:', walletAvailable || 0, 'video:', WalletStore._state.videoAvailable || 0);

        // Store the plan's credit grant and plan code for post-return type detection
        sessionStorage.setItem('timrx_pending_plan_credits', String(plan.credits));
        sessionStorage.setItem('timrx_pending_plan_code', selectedVideoPlan);
        console.log('[Credits] Video: Stored plan credits:', plan.credits, 'plan_code:', selectedVideoPlan);

        // Redirect to Mollie checkout
        trackCheckoutEvent('redirect_started', { flow: 'video', plan: selectedVideoPlan });
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

  // Video buy button — routes through verification for unverified users
  videoBuyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (emailVerified) {
      startVideoCheckout();
    } else {
      videoVerifier.handleEmailContinue();
    }
  });

  // Enter key in video email field — same routing
  videoBuyEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !videoBuyBtn?.disabled) {
      e.preventDefault();
      if (emailVerified) {
        startVideoCheckout();
      } else {
        videoVerifier.handleEmailContinue();
      }
    }
  });

  // Video verify state event listeners (delegated to videoVerifier)
  videoBuyVerifyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    videoVerifier.handleVerifyCode();
  });
  videoBuyVerifyCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      videoVerifier.handleVerifyCode();
    }
  });
  videoBuyVerifyCodeInput?.addEventListener('input', () => {
    videoVerifier.clearVerifyMessages();
  });
  videoBuyResendCodeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    videoVerifier.handleResendCode();
  });
  videoBuyBackToEmailBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    videoVerifier.handleBackToEmail();
  });

  // ─────────────────────────────────────────────────────────────
  // Success Modal - Driven by WalletStore as single source of truth
  // ─────────────────────────────────────────────────────────────

  // Track modal state
  const successModalState = {
    isOpen: false,
    isPending: true,
    preCheckoutBalance: 0,
    isVideoPlan: false,
  };

  // Track focus before success modal opens
  let lastFocusBeforeSuccessModal = null;

  /**
   * Animate a number counting up from start to end
   */
  function animateCountUp(el, start, end, duration = 600) {
    if (!el || start === end) { el.textContent = end.toLocaleString(); return; }
    const startTime = performance.now();
    const diff = end - start;
    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + diff * eased).toLocaleString();
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

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

    const successCard = successModal.querySelector('.success-card');
    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
    const creditsDisplay = successModal.querySelector('.success-credits');
    const addedBadge = document.getElementById('successAddedBadge');
    const microcopy = document.getElementById('successMicrocopy');
    const primaryCta = document.getElementById('successPrimaryCta');

    // Pool labels
    const isVideo = successModalState.isVideoPlan;
    const poolLabel = isVideo ? 'video credits' : 'general credits';

    // Reset animation classes
    if (successCard) {
      successCard.classList.remove('celebrate', 'pending', 'failed');
      // Force re-trigger entrance animation
      successCard.style.animation = 'none';
      successCard.offsetHeight; // reflow
      successCard.style.animation = '';
    }

    if (isPending) {
      if (successTitle) successTitle.textContent = 'Processing Payment';
      if (successMessage) successMessage.textContent = `Updating ${poolLabel} balance…`;
      if (successCard) successCard.classList.add('pending');
      if (addedBadge) { addedBadge.textContent = ''; addedBadge.classList.remove('visible'); }
      if (microcopy) microcopy.style.display = 'none';

      if (successCreditsValue) {
        successCreditsValue.textContent = credits != null ? credits.toLocaleString() : '—';
      }
      if (creditsDisplay) creditsDisplay.style.display = '';
    } else {
      // Success! Show celebration state
      if (successTitle) successTitle.textContent = "You're All Set";
      if (successMessage) successMessage.textContent = isVideo
        ? 'Your video credits have been added.'
        : 'Your general credits have been added.';

      // Trigger celebration animations
      if (successCard) successCard.classList.add('celebrate');

      // Show "+N credits" badge
      const planCredits = parseInt(sessionStorage.getItem('timrx_pending_plan_credits') || '0', 10);
      if (addedBadge && planCredits > 0) {
        addedBadge.textContent = `+${planCredits.toLocaleString()} ${poolLabel}`;
        addedBadge.classList.add('visible');
      }

      // Count-up animation for the balance value
      if (successCreditsValue && credits != null) {
        const prevBalance = successModalState.preCheckoutBalance || 0;
        animateCountUp(successCreditsValue, prevBalance, credits, 700);
      }
      if (creditsDisplay) creditsDisplay.style.display = '';

      // Contextual microcopy
      if (microcopy) {
        microcopy.textContent = isVideo
          ? 'Your videos are waiting to be created.'
          : 'Ready to create something amazing?';
        microcopy.style.display = '';
      }

      // Contextual CTA
      if (primaryCta) {
        primaryCta.textContent = isVideo ? 'Create Video' : 'Start Creating';
        primaryCta.href = 'https://timrx.live/3dprint?refresh=1';
      }
    }

    // Update unit label
    const unitEl = successModal.querySelector('.success-unit');
    if (unitEl) unitEl.textContent = poolLabel;

    successModal.classList.add('open');
    successModal.inert = false;
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

    const successCard = successModal.querySelector('.success-card');
    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
    const creditsDisplay = successModal.querySelector('.success-credits');
    const addedBadge = document.getElementById('successAddedBadge');
    const microcopy = document.getElementById('successMicrocopy');
    const primaryCta = document.getElementById('successPrimaryCta');

    const isVideo = successModalState.isVideoPlan;
    const poolLabel = isVideo ? 'video credits' : 'general credits';
    if (successTitle) successTitle.textContent = "You're All Set";
    if (successMessage) successMessage.textContent = isVideo
      ? 'Your video credits have been added.'
      : 'Your general credits have been added.';

    // Count-up from previous balance
    const prevBalance = successModalState.preCheckoutBalance || 0;
    if (successCreditsValue) animateCountUp(successCreditsValue, prevBalance, balance, 700);
    if (creditsDisplay) creditsDisplay.style.display = '';

    // Show added badge
    const planCredits = parseInt(sessionStorage.getItem('timrx_pending_plan_credits') || '0', 10);
    if (addedBadge && planCredits > 0) {
      addedBadge.textContent = `+${planCredits.toLocaleString()} ${poolLabel}`;
      addedBadge.classList.add('visible');
    }

    // Trigger celebrate
    if (successCard) {
      successCard.classList.remove('pending', 'failed');
      successCard.classList.add('celebrate');
    }

    // Show microcopy + contextual CTA
    if (microcopy) {
      microcopy.textContent = isVideo ? 'Your videos are waiting to be created.' : 'Ready to create something amazing?';
      microcopy.style.display = '';
    }
    if (primaryCta) {
      primaryCta.textContent = isVideo ? 'Create Video' : 'Start Creating';
    }

    // Update unit label
    const unitEl = successModal.querySelector('.success-unit');
    if (unitEl) unitEl.textContent = poolLabel;

    console.log('[Credits] Modal transitioned to complete, balance:', balance, `(${poolLabel})`);
  }

  function closeSuccessModal() {
    if (!successModal) return;
    // Move focus OUT before hiding
    if (successModal.contains(document.activeElement)) {
      (lastFocusBeforeSuccessModal || document.body).focus();
    }
    successModal.classList.remove('open');
    successModal.inert = true;

    // Clean up animation classes
    const successCard = successModal.querySelector('.success-card');
    if (successCard) successCard.classList.remove('celebrate', 'pending', 'failed');
    const addedBadge = document.getElementById('successAddedBadge');
    if (addedBadge) addedBadge.classList.remove('visible');

    successModalState.isOpen = false;
    successModalState.isPending = false;

    // Paid checkout requires verified email before billing, so credits
    // are always secured to the purchasing account. No post-purchase
    // action needed.
  }

  /**
   * Update success modal to show payment failed state
   */
  function updateSuccessModalToFailed(status) {
    if (!successModal) return;

    successModalState.isPending = false;

    const successCard = successModal.querySelector('.success-card');
    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
    const creditsDisplay = successModal.querySelector('.success-credits');
    const addedBadge = document.getElementById('successAddedBadge');
    const microcopy = document.getElementById('successMicrocopy');
    const primaryCta = document.getElementById('successPrimaryCta');

    if (successTitle) {
      successTitle.textContent = status === 'canceled' ? 'Payment Cancelled' : 'Payment Failed';
    }
    if (successMessage) {
      successMessage.textContent = status === 'canceled'
        ? 'No credits were charged. You can try again anytime.'
        : 'Something went wrong. Please try again.';
    }
    if (creditsDisplay) creditsDisplay.style.display = 'none';
    if (addedBadge) { addedBadge.textContent = ''; addedBadge.classList.remove('visible'); }
    if (microcopy) microcopy.style.display = 'none';

    // Update CTA to retry
    if (primaryCta) {
      primaryCta.textContent = 'Try Again';
      primaryCta.href = '#pricing';
      primaryCta.addEventListener('click', (e) => {
        e.preventDefault();
        closeSuccessModal();
        document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' });
      }, { once: true });
    }

    if (successCard) {
      successCard.classList.remove('pending', 'celebrate');
      successCard.classList.add('failed');
    }
  }

  /**
   * Update success modal to show syncing state (credits still processing but no error)
   */
  function updateSuccessModalToSyncing() {
    if (!successModal) return;

    const successTitle = successModal.querySelector('.success-title, h2');
    const successMessage = successModal.querySelector('.success-message, .modal-subtitle');

    const poolLabel = successModalState.isVideoPlan ? 'Video credits' : 'Credits';
    if (successTitle) successTitle.textContent = 'Payment Received';
    if (successMessage) {
      successMessage.textContent = `${poolLabel} will appear shortly. Refresh if needed.`;
    }

    // Keep pending class on card for visual styling
    const successCard = successModal.querySelector('.success-card');
    if (successCard) {
      successCard.classList.add('pending');
      successCard.classList.remove('failed', 'celebrate');
    }
  }

  // Subscribe to wallet events to update modal automatically
  window.addEventListener('timrx:wallet', (event) => {
    const wallet = event.detail;
    if (!wallet || !successModalState.isOpen) return;

    // Use the correct pool balance depending on what was purchased
    const relevantBalance = successModalState.isVideoPlan
      ? (wallet.videoAvailable ?? 0)
      : wallet.available;

    console.log('[Credits] Wallet event while modal open, pending:', successModalState.isPending,
      'balance:', relevantBalance, successModalState.isVideoPlan ? '(video)' : '(general)');

    // If modal is pending and balance increased, transition to complete
    if (successModalState.isPending && relevantBalance > successModalState.preCheckoutBalance) {
      transitionSuccessModalToComplete(relevantBalance);
    } else if (!successModalState.isPending && successCreditsValue) {
      // Update balance display if modal is showing success
      successCreditsValue.textContent = relevantBalance.toLocaleString();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // BILLING ERROR HANDLER - Handle 401/403 from checkout endpoints
  // ─────────────────────────────────────────────────────────────

  /**
   * Handle billing API errors (401/403) with appropriate UI feedback.
   * Returns true if error was handled, false if caller should handle it.
   *
   * @param {object} result - API response from apiFetch
   * @param {string} context - Which checkout flow triggered this (for logging)
   * @returns {boolean} - Whether the error was handled
   */
  function handleBillingError(result, context = 'checkout') {
    if (!result) return false;

    const status = result.status;
    // Check both error formats: nested (error.code) and flat (error_code)
    const errorCode = result.data?.error?.code || result.data?.error_code;
    const identityEmail = result.data?.identity_email || result.data?.error?.identity_email;

    console.log(`[Credits] handleBillingError: status=${status}, code=${errorCode}, context=${context}`);

    // 401 - Session expired
    if (status === 401) {
      showSessionExpiredModal();
      return true;
    }

    // 403 - Email issues
    // EMAIL_REQUIRED and EMAIL_NOT_VERIFIED are no longer expected in normal flow
    // because inline verification completes before checkout. If the backend still
    // returns them (e.g. race condition, session expiry), log defensively and
    // let the caller show its own error. Do NOT open the old modal routing that
    // created the double-email experience.
    if (status === 403) {
      if (errorCode === 'EMAIL_REQUIRED' || errorCode === 'EMAIL_NOT_VERIFIED') {
        console.warn(`[Credits] Unexpected ${errorCode} in verified-first flow (context: ${context}). Refresh may be needed.`);
        return false;  // Let caller handle with inline error
      }
      if (errorCode === 'EMAIL_MISMATCH') {
        showEmailMismatchModal(identityEmail, context);
        return true;
      }
    }

    return false;
  }

  /**
   * Show session expired modal with refresh button
   */
  function showSessionExpiredModal() {
    // Check if modal already exists
    let modal = document.getElementById('sessionExpiredModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'sessionExpiredModal';
      modal.className = 'modal blocking-modal';
      modal.setAttribute('role', 'alertdialog');
      modal.setAttribute('aria-labelledby', 'sessionExpiredTitle');
      modal.innerHTML = `
        <div class="modal-content modal-sm">
          <h2 id="sessionExpiredTitle">Session Expired</h2>
          <p class="modal-subtitle">Your session has expired. Please refresh the page to continue.</p>
          <button class="btn btn-primary" id="sessionRefreshBtn">
            <span class="btn-text">Refresh Page</span>
          </button>
        </div>
      `;
      document.body.appendChild(modal);

      // Refresh button handler
      document.getElementById('sessionRefreshBtn')?.addEventListener('click', () => {
        window.location.reload();
      });
    }

    modal.classList.add('open');
    modal.inert = false;
    document.getElementById('sessionRefreshBtn')?.focus();
  }

  /**
   * Show email mismatch modal - when user tries to checkout with different email
   * @param {string} identityEmail - The verified email on the account
   * @param {string} context - Which checkout flow triggered this
   */
  function showEmailMismatchModal(identityEmail, context = 'checkout') {
    // Check if modal already exists
    let modal = document.getElementById('emailMismatchModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'emailMismatchModal';
      modal.className = 'modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-labelledby', 'emailMismatchTitle');
      modal.innerHTML = `
        <div class="modal-content modal-sm">
          <button class="modal-close" id="emailMismatchClose" aria-label="Close">&times;</button>
          <h2 id="emailMismatchTitle">Wrong Email for This Account</h2>
          <p class="modal-subtitle">
            You're logged in as <strong id="emailMismatchIdentity"></strong>.
            <br><br>
            To buy credits, use this email address. If you want to use a different email, switch to that account.
          </p>
          <div class="modal-actions">
            <button class="btn btn-primary" id="emailMismatchUse">
              <span class="btn-text">Use This Email</span>
            </button>
            <button class="btn btn-secondary" id="emailMismatchSwitch">
              <span class="btn-text">Switch Account</span>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // Close button
      document.getElementById('emailMismatchClose')?.addEventListener('click', () => {
        closeEmailMismatchModal();
      });

      // Backdrop click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeEmailMismatchModal();
      });

      // "Use This Email" button - close and let user retry
      // (Backend always uses identity email for checkout, so no autofill needed.
      //  The frontend inline-verify flow already ensures the correct email.)
      document.getElementById('emailMismatchUse')?.addEventListener('click', () => {
        closeEmailMismatchModal();
      });

      // "Switch Account" button - open restore flow
      document.getElementById('emailMismatchSwitch')?.addEventListener('click', () => {
        closeEmailMismatchModal();
        // Open the secure credits modal in restore mode
        openSecureCreditsModal();
        // Navigate to the restore section if the modal supports it
        const restoreLink = document.querySelector('[data-action="restore"]');
        if (restoreLink) {
          restoreLink.click();
        }
      });
    }

    // Update the email display
    const emailDisplay = document.getElementById('emailMismatchIdentity');
    if (emailDisplay && identityEmail) {
      emailDisplay.textContent = identityEmail;
    }

    modal.classList.add('open');
    modal.inert = false;
    document.getElementById('emailMismatchUse')?.focus();

    console.log(`[Credits] Email mismatch modal shown for ${context}, identity: ${identityEmail}`);
  }

  function closeEmailMismatchModal() {
    const modal = document.getElementById('emailMismatchModal');
    if (modal) {
      modal.classList.remove('open');
      modal.inert = true;
    }
  }

  // ESC key closes billing error modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEmailMismatchModal();
      // Don't close session expired - it requires refresh
    }
  });

  /**
   * Show a toast notification
   * @param {string} message - Message to display
   * @param {string} type - 'success', 'error', or 'info'
   * @param {number} duration - Auto-dismiss duration in ms (default 4000)
   */
  function showToast(message, type = 'info', duration = 4000) {
    // Get or create toast container
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `
      <span class="toast-message">${message}</span>
      <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;

    container.appendChild(toast);

    // Close button handler
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn?.addEventListener('click', () => dismissToast(toast));

    // Trigger entrance animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Auto-dismiss
    if (duration > 0) {
      setTimeout(() => dismissToast(toast), duration);
    }

    return toast;
  }

  function dismissToast(toast) {
    if (!toast || toast.classList.contains('dismissing')) return;
    toast.classList.add('dismissing');
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }

  // ─────────────────────────────────────────────────────────────
  // Verified-Checkout Handoff Latch
  //
  // Short-lived token set after email verification succeeds and
  // /api/me refreshes. Consumed exactly once by startCheckout() or
  // startVideoCheckout(). Prevents a stale identity from proceeding
  // to billing if the session changes between verify and checkout.
  //
  // Cleared on: modal close, identity change, logout, expiry (30s),
  // or successful consumption by a checkout executor.
  // ─────────────────────────────────────────────────────────────

  const HANDOFF_TTL_MS = 30000;

  let checkoutHandoff = null;    // { identityId, email, flow, nonce, ts, timer }

  function setCheckoutHandoff(flow) {
    clearCheckoutHandoff();
    const nonce = Math.random().toString(36).slice(2, 10);
    checkoutHandoff = {
      identityId: identityId,
      email: userEmail,
      flow,
      nonce,
      ts: Date.now(),
      timer: setTimeout(() => {
        console.log('[Handoff] Expired after', HANDOFF_TTL_MS, 'ms');
        checkoutHandoff = null;
      }, HANDOFF_TTL_MS),
    };
    console.log('[Handoff] Set:', flow, 'identity:', identityId, 'nonce:', nonce);
    return nonce;
  }

  function clearCheckoutHandoff() {
    if (checkoutHandoff) {
      clearTimeout(checkoutHandoff.timer);
      checkoutHandoff = null;
    }
  }

  /**
   * Validate that current session still matches the verified handoff state.
   * Returns true if checkout may proceed, false if stale.
   * @param {string} expectedFlow - 'general' or 'video'
   */
  function validateCheckoutHandoff(expectedFlow) {
    if (!checkoutHandoff) {
      // No handoff — user is already-verified (fast path) or direct click.
      // Check live state instead.
      if (!emailVerified) {
        console.warn('[Handoff] No handoff and email not verified');
        return false;
      }
      return true;
    }

    const h = checkoutHandoff;
    const now = Date.now();

    // Check expiry
    if (now - h.ts > HANDOFF_TTL_MS) {
      console.warn('[Handoff] Expired at validation time');
      clearCheckoutHandoff();
      return false;
    }

    // Check flow matches
    if (h.flow !== expectedFlow) {
      console.warn('[Handoff] Flow mismatch: handoff=%s expected=%s', h.flow, expectedFlow);
      clearCheckoutHandoff();
      return false;
    }

    // Check identity still matches
    if (h.identityId !== identityId) {
      console.warn('[Handoff] Identity mismatch: handoff=%s current=%s', h.identityId, identityId);
      clearCheckoutHandoff();
      return false;
    }

    // Check email still matches
    if (h.email?.toLowerCase() !== userEmail?.toLowerCase()) {
      console.warn('[Handoff] Email mismatch: handoff=%s current=%s', h.email, userEmail);
      clearCheckoutHandoff();
      return false;
    }

    // Check emailVerified is still true
    if (!emailVerified) {
      console.warn('[Handoff] emailVerified became false after handoff was set');
      clearCheckoutHandoff();
      return false;
    }

    // Valid — consume it (one-shot)
    clearCheckoutHandoff();
    return true;
  }

  // Clear handoff on identity change
  window.addEventListener('timrx:identity_changed', () => {
    if (checkoutHandoff) {
      console.log('[Handoff] Cleared by identity change');
      clearCheckoutHandoff();
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

    // Handoff guard: ensure verified identity still matches current session
    if (!validateCheckoutHandoff('general')) {
      showCheckoutError('Your account changed during verification. Please confirm checkout again.');
      setCheckoutLoading(false);
      generalVerifier.reset();
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
          plan_code: selectedPlan.id,  // plan_code matches DB: starter_250, creator_900, studio_2200
          email: email
        }
      });

      if (!result.ok) {
        // Check for billing-specific errors (401/403)
        if (handleBillingError(result, 'one-time-checkout')) {
          setCheckoutLoading(false);
          closeBuyCreditsModal();
          return;
        }

        // Checkout idempotency — a payment session already exists for this identity
        if (result.data?.error_code === 'CHECKOUT_IN_PROGRESS' || result.data?.error === 'checkout_in_progress') {
          setCheckoutLoading(false);
          const retryAfter = result.data.retry_after_seconds || 60;
          showCheckoutCooldown(retryAfter);
          return;
        }

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
        sessionStorage.setItem('timrx_pre_checkout_video_balance', String(WalletStore._state.videoAvailable || 0));
        console.log('[Credits] Stored pre-checkout balance:', walletAvailable || 0);

        // Store the plan's credit grant and plan code for post-return type detection
        const planCredits = selectedPlan.credits || PLANS[selectedPlan.id]?.credits || 0;
        const planCode = selectedPlan.plan_code || selectedPlan.id || '';
        sessionStorage.setItem('timrx_pending_plan_credits', String(planCredits));
        sessionStorage.setItem('timrx_pending_plan_code', planCode);
        console.log('[Credits] Stored plan credits:', planCredits, 'plan_code:', planCode);

        // Redirect to Mollie checkout
        trackCheckoutEvent('redirect_started', { flow: 'general', plan: selectedPlan.id });
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

  /**
   * Show a user-friendly cooldown message when checkout is blocked by
   * the idempotency guard.  Disables the buy button with a countdown
   * that re-enables it when the slot expires.
   *
   * @param {number} seconds - Remaining seconds from retry_after_seconds
   */
  function showCheckoutCooldown(seconds) {
    showCheckoutError(`A payment session was started recently. You can try again in ${seconds}s.`);

    const btnText = checkoutBtn?.querySelector('.btn-text');
    if (!btnText || !checkoutBtn) return;

    checkoutBtn.disabled = true;
    const originalLabel = btnText.textContent;

    let remaining = seconds;
    const tick = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        showCheckoutError(`A payment session was started recently. You can try again in ${remaining}s.`);
      } else {
        clearInterval(tick);
        checkoutBtn.disabled = false;
        btnText.textContent = originalLabel;
        clearCheckoutError();
      }
    }, 1000);
  }

  /**
   * Video-checkout equivalent of showCheckoutCooldown.
   */
  function showVideoBuyCooldown(seconds) {
    showVideoBuyError(`A payment session was started recently. You can try again in ${seconds}s.`);

    if (!videoBuyBtn) return;

    // Reset loading spinner state before starting cooldown
    videoBuyBtn.disabled = true;
    const btnText = videoBuyBtn.querySelector('.btn-text');
    const btnLoader = videoBuyBtn.querySelector('.btn-loader');
    if (btnText) btnText.style.display = '';
    if (btnLoader) btnLoader.style.display = 'none';
    const originalLabel = btnText?.textContent || 'Buy';

    let remaining = seconds;
    const tick = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        showVideoBuyError(`A payment session was started recently. You can try again in ${remaining}s.`);
      } else {
        clearInterval(tick);
        videoBuyBtn.disabled = false;
        if (btnText) btnText.textContent = originalLabel;
        if (videoBuyError) videoBuyError.style.display = 'none';
      }
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────────
  // Pre-Checkout Email Verification — Shared Layer
  //
  // Factory that creates a reusable verification controller for
  // any checkout modal. Handles ONLY email attach, code verify,
  // resend cooldown, identity-changed cleanup, and /api/me refresh.
  //
  // Does NOT touch pricing, wallets, plan selection, or checkout
  // execution — those are injected via callbacks.
  //
  // Usage:
  //   const v = createPreCheckoutVerifier({ ...domRefs, onCheckout, ... });
  //   v.handleEmailContinue();   // Step 1: send code
  //   v.handleVerifyCode();      // Step 2: verify + auto-checkout
  //   v.reset();                 // Reset state on modal open/close
  // ─────────────────────────────────────────────────────────────

  /**
   * @param {Object} cfg
   * @param {string}       cfg.name             - Log prefix, e.g. 'Checkout' or 'Video'
   * @param {HTMLElement}  cfg.emailStateEl      - Container for email-input state
   * @param {HTMLElement}  cfg.verifyStateEl     - Container for code-verify state
   * @param {HTMLElement}  cfg.emailInput        - The email <input>
   * @param {HTMLElement}  cfg.sentToEmailEl     - <strong> showing where code was sent
   * @param {HTMLElement}  cfg.codeInput         - The 6-digit code <input>
   * @param {HTMLElement}  cfg.verifyMsgEl       - Verify info message <p>
   * @param {HTMLElement}  cfg.verifyErrEl       - Verify error message <p>
   * @param {HTMLElement}  cfg.verifyBtn         - "Verify & Buy" button
   * @param {HTMLElement}  cfg.resendBtn         - "Resend code" link-button
   * @param {HTMLElement}  cfg.emailErrorEl      - Email-state error display (optional)
   * @param {Function}     cfg.setEmailLoading   - fn(bool) to toggle email-state button loading
   * @param {Function}     cfg.showEmailError    - fn(msg) to show error in email state
   * @param {Function}     cfg.clearEmailError   - fn() to clear email state error
   * @param {Function}     cfg.validateForm      - fn() → bool, returns false if form invalid
   * @param {Function}     cfg.onCheckout        - fn() called after verification succeeds.
   *                                               THIS is where product-specific billing runs.
   *                                               General credits: startCheckout()
   *                                               Video credits:   startVideoCheckout()
   * @param {Function}     cfg.getBuyLabel       - fn() → string for the "Buy · £X.xx" button label
   */
  function createPreCheckoutVerifier(cfg) {
    let pendingEmail = null;
    let resendCooldown = 0;
    let resendTimer = null;
    let active = false;  // true while verification flow is in progress

    // ── Identity change detection ──
    // If the identity/session changes while this verifier is active (e.g. user
    // restores account in another tab, or periodic /api/me detects a swap),
    // discard stale pending verification state and rehydrate the modal.
    window.addEventListener('timrx:identity_changed', () => {
      if (!active) return;
      console.log(`[Credits] ${cfg.name}: identity changed during verification, resetting`);

      // Wipe pending email/code from old identity + any pending handoff
      active = false;
      pendingEmail = null;
      resendCooldown = 0;
      clearInterval(resendTimer);
      clearCheckoutHandoff();
      showEmailState();

      // Let the modal re-apply email prefill, button mode, readOnly from new identity
      if (typeof cfg.onIdentityChanged === 'function') {
        cfg.onIdentityChanged();
      }

      // Show a brief message so the user understands why the form reset
      cfg.showEmailError('Your account changed. Please confirm your email to continue.');
    });

    // ── UI helpers (all operate on this instance's DOM refs) ──

    function showEmailState() {
      if (cfg.emailStateEl) cfg.emailStateEl.style.display = '';
      if (cfg.verifyStateEl) cfg.verifyStateEl.style.display = 'none';
      clearVerifyMessages();
    }

    function showVerifyState() {
      if (cfg.emailStateEl) cfg.emailStateEl.style.display = 'none';
      if (cfg.verifyStateEl) cfg.verifyStateEl.style.display = '';
      if (cfg.sentToEmailEl) cfg.sentToEmailEl.textContent = pendingEmail || '';
      if (cfg.codeInput) { cfg.codeInput.value = ''; cfg.codeInput.focus(); }
      clearVerifyMessages();
    }

    function showVerifyMsg(msg) {
      if (cfg.verifyMsgEl) { cfg.verifyMsgEl.textContent = msg; cfg.verifyMsgEl.style.display = ''; }
    }

    function showVerifyErr(msg) {
      if (cfg.verifyErrEl) { cfg.verifyErrEl.textContent = msg; cfg.verifyErrEl.style.display = ''; }
    }

    function clearVerifyMessages() {
      if (cfg.verifyMsgEl) { cfg.verifyMsgEl.textContent = ''; cfg.verifyMsgEl.style.display = 'none'; }
      if (cfg.verifyErrEl) { cfg.verifyErrEl.textContent = ''; cfg.verifyErrEl.style.display = 'none'; }
    }

    function setVerifyLoading(loading) {
      if (!cfg.verifyBtn) return;
      cfg.verifyBtn.disabled = loading;
      const t = cfg.verifyBtn.querySelector('.btn-text');
      const l = cfg.verifyBtn.querySelector('.btn-loader');
      if (t) t.style.display = loading ? 'none' : '';
      if (l) l.style.display = loading ? 'inline-flex' : 'none';
    }

    function startResendCooldown() {
      resendCooldown = 60;
      if (cfg.resendBtn) { cfg.resendBtn.disabled = true; cfg.resendBtn.textContent = 'Resend code (60s)'; }
      clearInterval(resendTimer);
      resendTimer = setInterval(() => {
        resendCooldown--;
        if (cfg.resendBtn) {
          cfg.resendBtn.textContent = resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code';
        }
        if (resendCooldown <= 0) {
          clearInterval(resendTimer);
          if (cfg.resendBtn) cfg.resendBtn.disabled = false;
        }
      }, 1000);
    }

    // ── Shared post-verify session refresh (identity + wallet) ──

    async function refreshSessionAfterVerify() {
      try {
        const meResult = await apiFetch('/api/me', { timeout: 15000 });
        if (meResult.ok && meResult.data?.ok) {
          userEmail = meResult.data.email;
          emailVerified = meResult.data.email_verified || false;
          identityId = meResult.data.identity_id;
          WalletStore.update({
            balance: meResult.data.balance_credits ?? 0,
            reserved: meResult.data.reserved_credits ?? 0,
            available: meResult.data.available_credits ?? 0,
            videoBalance: meResult.data.balance_video_credits ?? 0,
            videoReserved: meResult.data.reserved_video_credits ?? 0,
            videoAvailable: meResult.data.available_video_credits ?? 0,
            identityId: meResult.data.identity_id,
            email: meResult.data.email,
            emailVerified: meResult.data.email_verified,
          });
        }
      } catch (meErr) {
        console.warn(`[Credits] ${cfg.name}: /api/me refresh after verify failed:`, meErr);
        userEmail = pendingEmail;
        emailVerified = true;
      }
    }

    // ── Shared verify error handler ──

    function handleVerifyErrorCode(result) {
      const errorCode = result.data?.error?.code || result.data?.code;
      setVerifyLoading(false);

      if (errorCode === 'INVALID_CODE') {
        showVerifyErr('Invalid or expired code');
      } else if (errorCode === 'TOO_MANY_ATTEMPTS') {
        showVerifyErr('Too many attempts. Please request a new code.');
      } else if (errorCode === 'CODE_EXPIRED') {
        showVerifyErr('Code has expired. Please request a new one.');
      } else {
        showVerifyErr(result.error || 'Verification failed');
      }
    }

    // ── Public API ──

    return {
      /** Current pending email (readable for external state checks) */
      get pendingEmail() { return pendingEmail; },

      /** Reset all verification state. Call on modal open/close. */
      reset() {
        active = false;
        pendingEmail = null;
        resendCooldown = 0;
        clearInterval(resendTimer);
        clearCheckoutHandoff();
        showEmailState();
      },

      /** Step 1: Send verification code. */
      async handleEmailContinue() {
        if (!cfg.validateForm()) {
          cfg.showEmailError('Please enter a valid email.');
          return;
        }

        const email = cfg.emailInput.value.trim();
        const flow = cfg.flowType || 'unknown';
        trackCheckoutEvent('email_continue_clicked', { flow, path: emailVerified ? 'fast' : 'verify' });

        // Fast path: already verified with same email → skip to checkout
        if (emailVerified && userEmail && userEmail.toLowerCase() === email.toLowerCase()) {
          console.log(`[Credits] ${cfg.name}: email already verified, proceeding to checkout`);
          cfg.onCheckout();
          return;
        }

        active = true;  // Mark as in-use for identity-change detection
        pendingEmail = email;
        cfg.setEmailLoading(true);
        cfg.clearEmailError();

        try {
          const result = await apiFetch('/api/auth/email/attach', {
            method: 'POST',
            body: { email }
          });

          cfg.setEmailLoading(false);

          if (!result.ok && result.data?.error?.code === 'RATE_LIMITED') {
            cfg.showEmailError(result.data.error.message || 'Please wait before requesting another code.');
            return;
          }

          if (result.data?.hint === 'account_switch_required') {
            // Email belongs to another account — do NOT show verify state
            // (no code was sent for this identity). Guide to restore instead.
            cfg.showEmailError('This email belongs to another account. Use Restore to switch accounts.');
            return;
          }

          trackCheckoutEvent('code_sent', { flow });
          showVerifyState();
          startResendCooldown();
        } catch (err) {
          cfg.setEmailLoading(false);
          // Proceed optimistically — code may have been sent
          trackCheckoutEvent('code_sent', { flow, optimistic: true });
          showVerifyState();
          startResendCooldown();
        }
      },

      /** Step 2: Verify 6-digit code, refresh session, then call onCheckout. */
      async handleVerifyCode() {
        const code = cfg.codeInput?.value?.trim() || '';
        const flow = cfg.flowType || 'unknown';

        if (code.length !== 6 || !/^\d+$/.test(code)) {
          showVerifyErr('Code must be 6 digits');
          return;
        }

        clearVerifyMessages();
        setVerifyLoading(true);
        showVerifyMsg('Verifying...');

        try {
          const result = await apiFetch('/api/auth/email/verify', {
            method: 'POST',
            body: { email: pendingEmail, code }
          });

          if (result.ok) {
            console.log(`[Credits] ${cfg.name}: email verified, proceeding to checkout`);
            trackCheckoutEvent('code_verified', {
              flow,
              identity_changed: !!result.data?.identity_changed,
            });

            // Cross-identity account switch — clear stale caches
            if (result.data?.identity_changed && window.TimrXApi?.clearAllUserCaches) {
              window.TimrXApi.clearAllUserCaches();
              if (window.clearLocalHistoryCache) window.clearLocalHistoryCache();
            }

            showVerifyMsg('Email verified! Redirecting to payment...');
            await refreshSessionAfterVerify();

            // Set handoff latch — captures verified identity state for checkout guard
            setCheckoutHandoff(flow);

            // Brief pause for user to see confirmation, then proceed to checkout.
            // The checkout executor will validate the handoff before calling billing.
            setTimeout(() => cfg.onCheckout(), 500);
            return;
          }

          const errorCode = result.data?.error?.code || result.data?.code || 'unknown';
          trackCheckoutEvent('verify_error', { flow, error: errorCode });
          handleVerifyErrorCode(result);
        } catch (err) {
          console.error(`[Credits] ${cfg.name} verify error:`, err);
          trackCheckoutEvent('verify_error', { flow, error: 'network' });
          setVerifyLoading(false);
          showVerifyErr(err.message || 'Verification failed. Please try again.');
        }
      },

      /** Resend verification code. */
      async handleResendCode() {
        if (!pendingEmail || resendCooldown > 0) return;

        clearVerifyMessages();
        showVerifyMsg('Resending code...');

        try {
          const result = await apiFetch('/api/auth/email/attach', {
            method: 'POST',
            body: { email: pendingEmail }
          });

          if (result.ok || result.status === 200) {
            showVerifyMsg('New code sent!');
            if (cfg.codeInput) cfg.codeInput.value = '';
            startResendCooldown();
          } else {
            showVerifyErr(result.error || 'Failed to resend code');
          }
        } catch (err) {
          showVerifyErr('Failed to resend code');
        }
      },

      /** Go back to email input state. */
      handleBackToEmail() {
        pendingEmail = null;
        showEmailState();
        if (cfg.emailInput) cfg.emailInput.focus();
      },

      /** Clear verify-state messages (for external input listeners). */
      clearVerifyMessages,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // General Credits — Pre-checkout verifier instance
  // onCheckout → startCheckout() (general plan_code, general balance)
  // ─────────────────────────────────────────────────────────────

  const generalVerifier = createPreCheckoutVerifier({
    name: 'Checkout',
    flowType: 'general',
    emailStateEl:    checkoutEmailState,
    verifyStateEl:   checkoutVerifyState,
    emailInput:      checkoutEmail,
    sentToEmailEl:   checkoutSentToEmail,
    codeInput:       checkoutVerifyCodeInput,
    verifyMsgEl:     checkoutVerifyMessage,
    verifyErrEl:     checkoutVerifyError,
    verifyBtn:       checkoutVerifyBtn,
    resendBtn:       checkoutResendCodeBtn,
    setEmailLoading: setCheckoutLoading,
    showEmailError:  showCheckoutError,
    clearEmailError: clearCheckoutError,
    validateForm:    validateCheckoutForm,
    onCheckout:      () => startCheckout(),
    onIdentityChanged() {
      // Rehydrate email input + button mode from new identity (same as openBuyCreditsModal)
      if (checkoutEmail && userEmail) {
        checkoutEmail.value = userEmail;
        if (emailVerified) {
          checkoutEmail.readOnly = true;
          checkoutEmail.classList.add('verified-email');
          setCheckoutBtnMode('buy');
        } else {
          checkoutEmail.readOnly = false;
          checkoutEmail.classList.remove('verified-email');
          setCheckoutBtnMode('continue');
        }
      } else {
        if (checkoutEmail) { checkoutEmail.value = ''; checkoutEmail.readOnly = false; }
        setCheckoutBtnMode('continue');
      }
      validateCheckoutForm();
    },
  });

  /** Set the general-credits button label based on verification state. */
  function setCheckoutBtnMode(mode) {
    const btnText = checkoutBtn?.querySelector('.btn-text');
    if (!btnText) return;
    if (mode === 'buy' && selectedPlan) {
      btnText.textContent = `Buy · £${selectedPlan.price.toFixed(2)}`;
    } else {
      btnText.textContent = 'Continue';
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Video Credits — Pre-checkout verifier instance
  // onCheckout → startVideoCheckout() (video plan_code, video balance)
  // ─────────────────────────────────────────────────────────────

  const videoVerifier = createPreCheckoutVerifier({
    name: 'Video',
    flowType: 'video',
    emailStateEl:    videoBuyEmailState,
    verifyStateEl:   videoBuyVerifyState,
    emailInput:      videoBuyEmail,
    sentToEmailEl:   videoBuySentToEmail,
    codeInput:       videoBuyVerifyCodeInput,
    verifyMsgEl:     videoBuyVerifyMessage,
    verifyErrEl:     videoBuyVerifyError,
    verifyBtn:       videoBuyVerifyBtn,
    resendBtn:       videoBuyResendCodeBtn,
    setEmailLoading(loading) {
      if (!videoBuyBtn) return;
      videoBuyBtn.disabled = loading;
      const t = videoBuyBtn.querySelector('.btn-text');
      const l = videoBuyBtn.querySelector('.btn-loader');
      if (t) t.style.display = loading ? 'none' : '';
      if (l) l.style.display = loading ? '' : 'none';
    },
    showEmailError:  showVideoBuyError,
    clearEmailError() { if (videoBuyError) videoBuyError.style.display = 'none'; },
    validateForm:    validateVideoBuyForm,
    onCheckout:      () => startVideoCheckout(),
    onIdentityChanged() {
      // Rehydrate email input + button mode from new identity (same as openVideoBuyModal)
      if (videoBuyEmail && userEmail) {
        videoBuyEmail.value = userEmail;
        if (emailVerified) {
          videoBuyEmail.readOnly = true;
          videoBuyEmail.classList.add('verified-email');
          setVideoBuyBtnMode('buy');
        } else {
          videoBuyEmail.readOnly = false;
          videoBuyEmail.classList.remove('verified-email');
          setVideoBuyBtnMode('continue');
        }
      } else {
        if (videoBuyEmail) { videoBuyEmail.value = ''; videoBuyEmail.readOnly = false; }
        setVideoBuyBtnMode('continue');
      }
      validateVideoBuyForm();
    },
  });

  /** Set the video-credits button label based on verification state. */
  function setVideoBuyBtnMode(mode) {
    const btnText = videoBuyBtn?.querySelector('.btn-text');
    if (!btnText) return;
    if (mode === 'buy' && selectedVideoPlan) {
      const plan = VIDEO_PLANS[selectedVideoPlan];
      btnText.textContent = plan ? `Buy · £${plan.price.toFixed(2)}` : 'Buy';
    } else {
      btnText.textContent = 'Continue';
    }
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

  // Checkout button — routes through verification for unverified users
  checkoutBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (emailVerified) {
      startCheckout();
    } else {
      generalVerifier.handleEmailContinue();
    }
  });

  // Enter key in email field — same routing as button
  checkoutEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !checkoutBtn?.disabled) {
      e.preventDefault();
      if (emailVerified) {
        startCheckout();
      } else {
        generalVerifier.handleEmailContinue();
      }
    }
  });

  // Checkout verify state event listeners (delegated to generalVerifier)
  checkoutVerifyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    generalVerifier.handleVerifyCode();
  });
  checkoutVerifyCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      generalVerifier.handleVerifyCode();
    }
  });
  checkoutVerifyCodeInput?.addEventListener('input', () => {
    generalVerifier.clearVerifyMessages();
  });
  checkoutResendCodeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    generalVerifier.handleResendCode();
  });
  checkoutBackToEmailBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    generalVerifier.handleBackToEmail();
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

  // ── Hub page boot: fetch wallet + subscription directly ──
  // On the workspace page, workspace-credits.js handles /api/me and
  // main.js dispatches timrx:startup-complete for subscription timing.
  // But on hub.html, those modules don't load. So credits.js must
  // bootstrap itself when it detects it's on the Hub page.
  //
  // Detection: hub.html sets creditsValue element but does NOT load
  // workspace-credits.js or main.js.  We check for the absence of the
  // workspace init flag to know we need to self-boot.
  const _isWorkspace = typeof window.WorkspaceCredits !== 'undefined'
    || document.querySelector('script[src*="workspace-credits"]') !== null
    || document.getElementById('generateModelBtn') !== null;

  if (!_isWorkspace && creditsValue) {
    // ── Hub boot: fetch identity + wallet in parallel ──
    // /api/me → identity only (fast, no wallet DB queries)
    // /api/credits/wallet → authoritative wallet balances
    // Both fire in parallel so the pill updates as fast as possible.
    creditsValue.textContent = '...';
    console.log('[Credits][Hub] Self-booting: /api/me + /api/credits/wallet in parallel');

    // 1) Identity (for email, session confirmation)
    fetchWallet().catch(err => {
      console.warn('[Credits][Hub] /api/me failed:', err.message);
    });

    // 2) Wallet (for pill balances) — this is the authoritative source
    apiFetch('/api/credits/wallet', { timeout: 10000 }).then(result => {
      if (result.ok && result.data?.ok) {
        const d = result.data;
        const available = d.available_credits ?? Math.max(0, (d.credits_balance || 0) - (d.reserved_credits || 0));
        const videoAvail = d.video_available_credits ?? Math.max(0, (d.video_credits_balance || 0) - (d.video_reserved_credits || 0));

        WalletStore.update({
          balance: d.credits_balance || 0,
          reserved: d.reserved_credits || 0,
          available,
          videoBalance: d.video_credits_balance || 0,
          videoReserved: d.video_reserved_credits || 0,
          videoAvailable: videoAvail,
        });
        updateCreditsDisplay(available, d.credits_balance || 0, d.reserved_credits || 0);
        console.log(`[Credits][Hub] Wallet pill updated: general=${available} video=${videoAvail}`);
      } else {
        console.warn('[Credits][Hub] /api/credits/wallet failed:', result.status, result.error);
        // Only show 0 if nothing else has already populated the pill
        if (creditsValue.textContent === '...') {
          creditsValue.textContent = '0';
        }
      }
    }).catch(err => {
      console.warn('[Credits][Hub] Wallet fetch error:', err.message);
      if (creditsValue.textContent === '...') {
        creditsValue.textContent = '0';
      }
    });
  }

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
    const videoCreditsPerMonth = subPlanInfo ? (subPlanInfo.video_credits_per_month || 0) : 0;

    // Show subscription success in the existing success modal
    successModalState.preCheckoutBalance = 0;

    // Build subscription success message with both pools
    let subSuccessMsg = `Your ${planName} plan is active.`;
    if (creditsPerMonth > 0 && videoCreditsPerMonth > 0) {
      subSuccessMsg += ` ${creditsPerMonth} general + ${videoCreditsPerMonth} video credits added.`;
    } else if (creditsPerMonth > 0) {
      subSuccessMsg += ` ${creditsPerMonth} credits have been added.`;
    }

    // Open success modal with subscription-specific text
    if (successModal) {
      const successCard = successModal.querySelector('.success-card');
      const successTitle = successModal.querySelector('.success-title, h2');
      const successMessage = successModal.querySelector('.success-message, .modal-subtitle');
      const creditsDisplay = successModal.querySelector('.success-credits');
      const addedBadge = document.getElementById('successAddedBadge');
      const microcopy = document.getElementById('successMicrocopy');
      const primaryCta = document.getElementById('successPrimaryCta');

      if (successTitle) successTitle.textContent = 'Subscription Active';
      if (successMessage) successMessage.textContent = subSuccessMsg;
      if (creditsDisplay) creditsDisplay.style.display = 'none';

      // Subscription celebration
      if (successCard) {
        successCard.classList.remove('pending', 'failed');
        successCard.classList.add('celebrate');
        // Re-trigger entrance animation
        successCard.style.animation = 'none';
        successCard.offsetHeight;
        successCard.style.animation = '';
      }
      if (addedBadge) { addedBadge.textContent = ''; addedBadge.classList.remove('visible'); }
      if (microcopy) {
        microcopy.textContent = "Let's build something.";
        microcopy.style.display = '';
      }
      if (primaryCta) {
        primaryCta.textContent = 'Start Creating';
        primaryCta.href = 'https://timrx.live/3dprint?refresh=1';
      }

      successModal.classList.remove('pending', 'failed');
      successModal.classList.add('open');
      successModal.inert = false;
      successModalState.isOpen = true;
      successModalState.isPending = false;
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

    // Get stored payment_id, pre-checkout balances, plan credits, and plan code from sessionStorage
    const pendingPaymentId = sessionStorage.getItem('timrx_pending_payment_id');
    const preCheckoutBalance = parseInt(sessionStorage.getItem('timrx_pre_checkout_balance') || '0', 10);
    const preCheckoutVideoBalance = parseInt(sessionStorage.getItem('timrx_pre_checkout_video_balance') || '0', 10);
    const planCredits = parseInt(sessionStorage.getItem('timrx_pending_plan_credits') || '0', 10);
    const pendingPlanCode = sessionStorage.getItem('timrx_pending_plan_code') || '';
    const isVideoPlan = pendingPlanCode.startsWith('video_');
    trackCheckoutEvent('return_success', {
      flow: isVideoPlan ? 'video' : 'general',
      plan: pendingPlanCode,
      credits: planCredits,
    });

    // Choose the right pre-checkout base depending on credit pool
    const initialBalance = isVideoPlan ? preCheckoutVideoBalance : preCheckoutBalance;

    // Calculate OPTIMISTIC balance for the correct pool
    const optimisticBalance = initialBalance + planCredits;
    const displayBalance = walletAvailable || parseInt(localStorage.getItem('timrx_credits_last') || '0', 10);

    console.log('[Credits] Checkout success - plan:', pendingPlanCode, 'isVideo:', isVideoPlan,
      'pre:', initialBalance, 'credits:', planCredits, 'optimistic:', optimisticBalance);

    // Store pre-checkout balance in modal state for event listener comparison
    successModalState.preCheckoutBalance = isVideoPlan ? preCheckoutVideoBalance : preCheckoutBalance;
    successModalState.isVideoPlan = isVideoPlan;

    // IMMEDIATELY show success modal with OPTIMISTIC balance (not pending state)
    // This gives instant feedback - user sees expected new balance right away
    if (planCredits > 0) {
      // We know how many credits were purchased - show optimistic balance immediately
      openSuccessModal(optimisticBalance, false);  // false = not pending, show as complete
      console.log('[Credits] Showing optimistic balance:', optimisticBalance, isVideoPlan ? '(video pool)' : '(general pool)');

      // Update local wallet state optimistically — only touch the correct credit pool
      if (isVideoPlan) {
        WalletStore.update({
          videoBalance: optimisticBalance,
          videoReserved: 0,
          videoAvailable: optimisticBalance,
        });
      } else {
        walletAvailable = optimisticBalance;
        walletBalance = optimisticBalance;
        WalletStore.update({
          balance: optimisticBalance,
          reserved: 0,
          available: optimisticBalance,
        });
      }
    } else {
      // Fallback: no plan credits stored, show pending state
      openSuccessModal(displayBalance, true);
    }

    // Clean up stored values
    sessionStorage.removeItem('timrx_pre_checkout_balance');
    sessionStorage.removeItem('timrx_pre_checkout_video_balance');
    sessionStorage.removeItem('timrx_pending_plan_credits');
    sessionStorage.removeItem('timrx_pending_plan_code');

    // Run reconciliation in background (non-blocking)
    (async function reconcilePayment() {

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
              // Pick the right balance field based on credit type in confirm response
              const confirmedCreditType = confirmData.credit_type || (isVideoPlan ? 'video' : 'general');
              const isVideoConfirm = confirmedCreditType === 'video';

              const newBalance = isVideoConfirm
                ? (confirmData.available_video_credits ?? confirmData.balance_video_credits ?? null)
                : (confirmData.available_credits ?? confirmData.balance_credits ?? null);

              if (newBalance !== null && newBalance > initialBalance) {
                // We have a valid balance from confirm response - update directly!
                console.log('[Credits] Using balance from confirm response:', newBalance, isVideoConfirm ? '(video)' : '(general)');
                if (isVideoConfirm) {
                  WalletStore.update({
                    videoBalance: confirmData.balance_video_credits ?? newBalance,
                    videoReserved: confirmData.reserved_video_credits ?? 0,
                    videoAvailable: newBalance,
                    // Also store general pool values if present
                    balance: confirmData.balance_credits ?? WalletStore._state.balance,
                    reserved: confirmData.reserved_credits ?? WalletStore._state.reserved,
                    available: confirmData.available_credits ?? WalletStore._state.available,
                    identityId: confirmData.identity_id || identityId,
                  });
                } else {
                  WalletStore.update({
                    balance: confirmData.balance_credits ?? newBalance,
                    reserved: confirmData.reserved_credits ?? 0,
                    available: newBalance,
                    videoBalance: confirmData.balance_video_credits ?? WalletStore._state.videoBalance,
                    videoReserved: confirmData.reserved_video_credits ?? WalletStore._state.videoReserved,
                    videoAvailable: confirmData.available_video_credits ?? WalletStore._state.videoAvailable,
                    identityId: confirmData.identity_id || identityId,
                  });
                }
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
          // Check the correct pool based on what was purchased
          const serverBalance = wallet
            ? (isVideoPlan ? (wallet.videoAvailable ?? 0) : wallet.available)
            : 0;

          console.log(`[Credits] Reconcile ${attempts}/${maxAttempts}: server=${serverBalance} (${isVideoPlan ? 'video' : 'general'}), expected=${initialBalance + planCredits}`);

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

  // Account modal DOM elements
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
  const restoreVideoRow = document.getElementById('restoreVideoRow');
  const restoreVideoValue = document.getElementById('restoreVideoValue');
  const restoreSuccessCloseBtn = document.getElementById('restoreSuccessCloseBtn');

  // Track focus before restore success modal opens
  let lastFocusBeforeRestoreModal = null;

  /**
   * Open the restore success modal with animation
   * @param {number} credits - The restored general credits balance to display
   * @param {number} [videoCredits] - The restored video credits balance (optional)
   */
  function openRestoreSuccessModal(credits, videoCredits) {
    if (!restoreSuccessModal) return;

    // Store current focus before opening
    lastFocusBeforeRestoreModal = document.activeElement;

    // Show which account was switched to
    const successEmail = document.getElementById('restoreSuccessEmail');
    if (successEmail) successEmail.textContent = userEmail || '(unknown)';

    // Update general credits display
    if (restoreCreditsValue) {
      restoreCreditsValue.textContent = credits != null ? credits.toLocaleString() : '--';
    }

    // Show video credits row only when user has video credits
    const videoAmt = Number(videoCredits) || 0;
    if (restoreVideoRow) restoreVideoRow.style.display = videoAmt > 0 ? 'flex' : 'none';
    if (restoreVideoValue) restoreVideoValue.textContent = videoAmt.toLocaleString();

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

  // ─────────────────────────────────────────────────────────────
  // GENERIC CONFIRM MODAL (replaces window.confirm)
  // ─────────────────────────────────────────────────────────────
  const confirmModal = document.getElementById('confirmModal');
  const confirmModalTitle = document.getElementById('confirmModalTitle');
  const confirmModalMessage = document.getElementById('confirmModalMessage');
  const confirmModalYes = document.getElementById('confirmModalYes');
  const confirmModalNo = document.getElementById('confirmModalNo');
  const confirmModalIcon = document.getElementById('confirmModalIcon');

  let _confirmResolve = null;

  /**
   * Show a styled confirmation modal (replaces window.confirm)
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} opts.message - supports HTML
   * @param {string} [opts.confirmText='Confirm']
   * @param {string} [opts.cancelText='Cancel']
   * @param {string} [opts.icon='fa-circle-question']
   * @returns {Promise<boolean>}
   */
  function showConfirm({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', icon = 'fa-circle-question' }) {
    if (!confirmModal) return Promise.resolve(true); // fallback if HTML missing

    confirmModalTitle.textContent = title;
    confirmModalMessage.innerHTML = message;
    confirmModalYes.textContent = confirmText;
    confirmModalNo.textContent = cancelText;
    if (confirmModalIcon) {
      confirmModalIcon.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    }

    confirmModal.classList.add('open');
    confirmModal.setAttribute('aria-hidden', 'false');
    confirmModalYes?.focus();

    return new Promise((resolve) => {
      _confirmResolve = resolve;
    });
  }

  function _closeConfirmModal(result) {
    if (!confirmModal) return;
    confirmModal.classList.remove('open');
    confirmModal.setAttribute('aria-hidden', 'true');
    if (_confirmResolve) {
      _confirmResolve(result);
      _confirmResolve = null;
    }
  }

  confirmModalYes?.addEventListener('click', () => _closeConfirmModal(true));
  confirmModalNo?.addEventListener('click', () => _closeConfirmModal(false));
  confirmModal?.addEventListener('click', (e) => {
    if (e.target === confirmModal) _closeConfirmModal(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirmModal?.classList.contains('open')) {
      _closeConfirmModal(false);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // RESTORE ACCOUNT MODAL (logged-in 4-step flow)
  // ─────────────────────────────────────────────────────────────
  const restoreAccountModal = document.getElementById('restoreAccountModal');
  const restoreAccountClose = document.getElementById('restoreAccountClose');
  // Step elements
  const raStep1 = document.getElementById('raStep1');
  const raStep2 = document.getElementById('raStep2');
  const raStep3 = document.getElementById('raStep3');
  const raStep4 = document.getElementById('raStep4');
  const raEmailInput = document.getElementById('raEmailInput');
  const raEmailError = document.getElementById('raEmailError');
  const raSendCodeBtn = document.getElementById('raSendCodeBtn');
  const raSentToEmail = document.getElementById('raSentToEmail');
  const raCodeInput = document.getElementById('raCodeInput');
  const raCodeError = document.getElementById('raCodeError');
  const raCodeMessage = document.getElementById('raCodeMessage');
  const raVerifyBtn = document.getElementById('raVerifyBtn');
  const raResendBtn = document.getElementById('raResendBtn');
  const raConfirmEmail = document.getElementById('raConfirmEmail');
  const raConfirmCredits = document.getElementById('raConfirmCredits');

  let raPendingEmail = '';
  let raResendCooldown = 0;
  let raResendTimer = null;

  function showRaStep(n) {
    [raStep1, raStep2, raStep3, raStep4].forEach((el, i) => {
      if (el) el.style.display = (i === n - 1) ? 'block' : 'none';
    });
    // Clear errors when switching steps
    if (raEmailError) raEmailError.textContent = '';
    if (raCodeError) raCodeError.textContent = '';
    if (raCodeMessage) raCodeMessage.textContent = '';
  }

  function openRestoreAccountModal() {
    if (!restoreAccountModal) return;
    raPendingEmail = '';
    if (raEmailInput) raEmailInput.value = '';
    if (raCodeInput) raCodeInput.value = '';
    showRaStep(1);
    restoreAccountModal.classList.add('open');
    restoreAccountModal.setAttribute('aria-hidden', 'false');
  }

  function closeRestoreAccountModal() {
    if (!restoreAccountModal) return;
    restoreAccountModal.classList.remove('open');
    restoreAccountModal.setAttribute('aria-hidden', 'true');
    if (raResendTimer) { clearInterval(raResendTimer); raResendTimer = null; }
  }

  // Close handlers
  restoreAccountClose?.addEventListener('click', closeRestoreAccountModal);
  restoreAccountModal?.addEventListener('click', (e) => {
    if (e.target === restoreAccountModal) closeRestoreAccountModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && restoreAccountModal?.classList.contains('open')) {
      closeRestoreAccountModal();
    }
  });

  // Step 1 → Step 2
  document.getElementById('raNextToEmail')?.addEventListener('click', () => {
    showRaStep(2);
    raEmailInput?.focus();
  });
  document.getElementById('raCancelStep1')?.addEventListener('click', closeRestoreAccountModal);

  // Logout from restore modal — two-click inline confirm (no stacked modal)
  const raLogoutBtn = document.getElementById('raLogoutBtn');
  let _logoutArmed = false;
  let _logoutTimer = null;

  raLogoutBtn?.addEventListener('click', async () => {
    // First click: arm (change label to "Confirm Log Out?")
    if (!_logoutArmed) {
      _logoutArmed = true;
      raLogoutBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Confirm Log Out?';
      raLogoutBtn.classList.add('armed');
      // Auto-disarm after 3s
      _logoutTimer = setTimeout(() => {
        _logoutArmed = false;
        raLogoutBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Log Out';
        raLogoutBtn.classList.remove('armed');
      }, 3000);
      return;
    }

    // Second click: execute logout
    clearTimeout(_logoutTimer);
    raLogoutBtn.classList.add('loading');
    raLogoutBtn.disabled = true;

    try {
      await apiFetch('/api/me/logout', { method: 'POST' });

      // Clear local state
      emailVerified = false;
      userEmail = '';
      isRestoreMode = false;

      // Clear ALL user-scoped caches (history, wallet, jobs, credits, etc.)
      // This prevents stale data from leaking to the next user session
      if (window.TimrXApi?.clearAllUserCaches) {
        window.TimrXApi.clearAllUserCaches();
      }
      // Also clear auth stamp so next session starts completely fresh
      try { localStorage.removeItem('timrx_auth_stamp'); } catch (_) {}

      closeRestoreAccountModal();

      // Reload to get a fresh anonymous session
      window.location.reload();
    } catch (err) {
      console.error('[RestoreAccount] Logout error:', err);
      _logoutArmed = false;
      raLogoutBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Log Out';
      raLogoutBtn.classList.remove('loading', 'armed');
      raLogoutBtn.disabled = false;
    }
  });

  // Step 2: Send code
  async function raSendCode() {
    const email = raEmailInput?.value?.trim().toLowerCase();
    if (!email || !email.includes('@') || !email.includes('.')) {
      if (raEmailError) raEmailError.textContent = 'Please enter a valid email address';
      return;
    }

    raPendingEmail = email;
    raSendCodeBtn?.classList.add('loading');
    if (raEmailError) raEmailError.textContent = '';

    try {
      const result = await apiFetch('/api/auth/restore/request', {
        method: 'POST',
        body: { email },
        timeout: 15000
      });

      if (!result.ok && result.data?.error?.code === 'RATE_LIMITED') {
        if (raEmailError) raEmailError.textContent = result.data.error.message || 'Please wait before requesting another code';
        return;
      }

      if (raSentToEmail) raSentToEmail.textContent = email;

      showRaStep(3);
      raStartResendCooldown();
      raCodeInput?.focus();

    } catch (err) {
      console.error('[RestoreAccount] sendCode error:', err);
      if (raSentToEmail) raSentToEmail.textContent = email;
      showRaStep(3);
      raStartResendCooldown();
      raCodeInput?.focus();
    } finally {
      raSendCodeBtn?.classList.remove('loading');
    }
  }

  raSendCodeBtn?.addEventListener('click', raSendCode);
  raEmailInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); raSendCode(); }
  });

  // Step 2 back
  document.getElementById('raBackToIntro')?.addEventListener('click', () => showRaStep(1));

  // Step 3: Verify code → goes to Step 4 for final confirmation
  async function raVerifyCode() {
    const code = raCodeInput?.value?.trim();
    if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
      if (raCodeError) raCodeError.textContent = 'Code must be 6 digits';
      return;
    }

    raVerifyBtn?.classList.add('loading');
    if (raCodeError) raCodeError.textContent = '';
    if (raCodeMessage) raCodeMessage.textContent = 'Verifying...';

    try {
      const result = await apiFetch('/api/auth/restore/redeem', {
        method: 'POST',
        body: { email: raPendingEmail, code }
      });

      if (!result.ok) {
        const errorCode = result.data?.error?.code;
        if (errorCode === 'INVALID_CODE') {
          if (raCodeError) raCodeError.textContent = 'Invalid or expired code';
        } else if (errorCode === 'TOO_MANY_ATTEMPTS') {
          if (raCodeError) raCodeError.textContent = 'Too many attempts. Please request a new code.';
        } else if (errorCode === 'CODE_EXPIRED') {
          if (raCodeError) raCodeError.textContent = 'Code has expired. Please request a new one.';
        } else {
          if (raCodeError) raCodeError.textContent = (result.isHtml || result.status >= 500)
            ? 'Verification failed. Please try again.'
            : (result.error || 'Verification failed');
        }
        if (raCodeMessage) raCodeMessage.textContent = '';
        raVerifyBtn?.classList.remove('loading');
        return;
      }

      // Success — code is valid. Show final confirmation (Step 4)
      if (raConfirmEmail) raConfirmEmail.textContent = raPendingEmail;

      // Show credit context in confirmation
      const currentCredits = walletAvailable || 0;
      if (raConfirmCredits && currentCredits > 0) {
        raConfirmCredits.textContent = `You currently have ${currentCredits.toLocaleString()} credits. They will remain on your current account.`;
        raConfirmCredits.style.display = 'block';
      } else if (raConfirmCredits) {
        raConfirmCredits.style.display = 'none';
      }

      if (raCodeMessage) raCodeMessage.textContent = '';
      showRaStep(4);

    } catch (err) {
      console.error('[RestoreAccount] verifyCode error:', err);
      if (raCodeError) raCodeError.textContent = 'Verification failed. Please try again.';
      if (raCodeMessage) raCodeMessage.textContent = '';
    } finally {
      raVerifyBtn?.classList.remove('loading');
    }
  }

  raVerifyBtn?.addEventListener('click', raVerifyCode);
  raCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); raVerifyCode(); }
  });

  // Step 3: Resend
  function raStartResendCooldown() {
    raResendCooldown = 60;
    raUpdateResendBtn();
    if (raResendTimer) clearInterval(raResendTimer);
    raResendTimer = setInterval(() => {
      raResendCooldown--;
      raUpdateResendBtn();
      if (raResendCooldown <= 0) { clearInterval(raResendTimer); raResendTimer = null; }
    }, 1000);
  }

  function raUpdateResendBtn() {
    if (!raResendBtn) return;
    if (raResendCooldown > 0) {
      raResendBtn.disabled = true;
      raResendBtn.textContent = `Resend (${raResendCooldown}s)`;
    } else {
      raResendBtn.disabled = false;
      raResendBtn.textContent = 'Resend Code';
    }
  }

  raResendBtn?.addEventListener('click', async () => {
    if (raResendCooldown > 0) return;
    raResendBtn?.classList.add('loading');
    try {
      const result = await apiFetch('/api/auth/restore/request', {
        method: 'POST',
        body: { email: raPendingEmail },
        timeout: 15000
      });
      if (!result.ok && result.data?.error?.code === 'RATE_LIMITED') {
        if (raCodeError) raCodeError.textContent = result.data.error.message || 'Please wait before requesting another code';
        return;
      }
      if (raCodeMessage) raCodeMessage.textContent = 'New code sent! Check your email.';
      raStartResendCooldown();
      if (raCodeInput) raCodeInput.value = '';
    } catch (err) {
      if (raCodeMessage) raCodeMessage.textContent = 'New code sent! Check your email.';
      raStartResendCooldown();
    } finally {
      raResendBtn?.classList.remove('loading');
    }
  });

  // Step 3: Change email → back to step 2
  document.getElementById('raChangeEmail')?.addEventListener('click', () => {
    showRaStep(2);
    raEmailInput?.focus();
  });

  // Step 4: Confirm switch
  document.getElementById('raConfirmSwitch')?.addEventListener('click', async () => {
    const confirmBtn = document.getElementById('raConfirmSwitch');
    confirmBtn?.classList.add('loading');

    try {
      // The restore/redeem already executed successfully in step 3.
      // Refresh wallet and session state.
      console.log('[RestoreAccount] Account switch confirmed');
      // NEW-1: Clear stale caches from previous identity before loading new state
      if (window.TimrXApi?.clearAllUserCaches) window.TimrXApi.clearAllUserCaches();
      // Also clear in-memory history cache so stale items don't flash
      if (window.clearLocalHistoryCache) window.clearLocalHistoryCache();
      userEmail = raPendingEmail;
      emailVerified = true;
      isRestoreMode = false;

      const wallet = await fetchWallet();
      await fetchSubscription();

      if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;

      closeRestoreAccountModal();

      // Reload history from DB for the new identity and re-render
      if (window.loadHistoryFromDB) {
        window.loadHistoryFromDB().then(() => {
          if (window.renderHistory) window.renderHistory();
        }).catch(() => {});
      }

      // Show restore success celebration
      const restoredCredits = wallet?.available ?? walletAvailable ?? 0;
      const restoredVideoCredits = wallet?.videoAvailable ?? 0;
      openRestoreSuccessModal(restoredCredits, restoredVideoCredits);

    } catch (err) {
      console.error('[RestoreAccount] confirm switch error:', err);
    } finally {
      confirmBtn?.classList.remove('loading');
    }
  });

  document.getElementById('raCancelSwitch')?.addEventListener('click', closeRestoreAccountModal);

  // ─────────────────────────────────────────────────────────────
  // GUEST CHOOSER MODAL (anonymous users)
  // ─────────────────────────────────────────────────────────────
  const guestChooserModal = document.getElementById('guestChooserModal');

  function openGuestChooserModal() {
    if (!guestChooserModal) return;
    guestChooserModal.classList.add('open');
    guestChooserModal.setAttribute('aria-hidden', 'false');
  }

  function closeGuestChooserModal() {
    if (!guestChooserModal) return;
    guestChooserModal.classList.remove('open');
    guestChooserModal.setAttribute('aria-hidden', 'true');
  }

  document.getElementById('guestChooserClose')?.addEventListener('click', closeGuestChooserModal);
  guestChooserModal?.addEventListener('click', (e) => {
    if (e.target === guestChooserModal) closeGuestChooserModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && guestChooserModal?.classList.contains('open')) {
      closeGuestChooserModal();
    }
  });

  // "Secure Your Account" → open account modal in attach mode
  document.getElementById('chooserSecure')?.addEventListener('click', () => {
    closeGuestChooserModal();
    isRestoreMode = false;
    resetToAttachMode();
    openSecureCreditsModal();
  });

  // "I Already Have an Account" → open account modal in restore mode
  document.getElementById('chooserRestore')?.addEventListener('click', () => {
    closeGuestChooserModal();
    isRestoreMode = true;
    if (secureState1) {
      const h3 = secureState1.querySelector('h3');
      const subtitle = secureState1.querySelector('.secure-subtitle');
      if (h3) h3.textContent = 'Restore Your Account';
      if (subtitle) subtitle.textContent = 'Enter the email linked to your existing account.';
    }
    openSecureCreditsModal();
    secureEmailInput?.focus();
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

    // Refresh subscription data so the section is visible
    fetchSubscription();

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
   * Toggle the secure credits modal visibility.
   * Routes by user state:
   *  - logged in → restore-account flow
   *  - guest → two-option chooser modal
   */
  function toggleSecureCredits() {
    // Logged-in: restore-only flow
    if (emailVerified) {
      openRestoreAccountModal();
      return;
    }

    // If secure credits modal is already open, close it
    if (secureCreditsCard?.classList.contains('expanded')) {
      closeSecureCreditsModal();
      return;
    }

    // Guest: show chooser modal
    openGuestChooserModal();
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
      // Route through the same logic as the shield button
      toggleSecureCredits();
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
    // Clear restore hint
    const hintEl = document.getElementById('verifyRestoreHint');
    if (hintEl) { hintEl.textContent = ''; hintEl.style.display = 'none'; }
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

      const responseData = result.data || {};

      // If email belongs to another account, stay on state 1 with guidance
      if (!isRestoreMode && responseData.hint === 'account_switch_required') {
        setSecureError('This email belongs to another account. Use Restore Account to switch.');
        sendCodeBtn?.classList.remove('loading');
        return;
      }

      // Code was sent — transition to state 2 (code entry)
      if (sentToEmail) sentToEmail.textContent = email;
      showSecureState(2);
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
            // NEW-1: Clear stale caches from previous identity before loading new state
            if (isRestoreMode && window.TimrXApi?.clearAllUserCaches) {
              window.TimrXApi.clearAllUserCaches();
              if (window.clearLocalHistoryCache) window.clearLocalHistoryCache();
            }
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
            // Reload history for the (possibly new) identity
            if (wasRestoreMode && window.loadHistoryFromDB) {
              window.loadHistoryFromDB().then(() => {
                if (window.renderHistory) window.renderHistory();
              }).catch(() => {});
            }
            // Show restore success popup if this was a restore operation
            if (wasRestoreMode) {
              const restoredVideoCredits = meResult.data.available_video_credits ?? 0;
              openRestoreSuccessModal(restoredCredits, restoredVideoCredits);
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
      } else {
        setVerifyError(result?.error || 'Verification failed');
      }
      verifyCodeBtn?.classList.remove('loading');
      return;
    }

    // Success!
    console.log('[Credits] Email verified successfully');
    const wasRestoreMode = isRestoreMode; // Capture before resetting
    const identityChanged = result?.data?.identity_changed || false;
    // Clear stale caches when identity changed (restore or cross-identity account switch)
    if ((wasRestoreMode || identityChanged) && window.TimrXApi?.clearAllUserCaches) {
      window.TimrXApi.clearAllUserCaches();
      if (window.clearLocalHistoryCache) window.clearLocalHistoryCache();
    }
    userEmail = pendingEmail;
    emailVerified = true;
    isRestoreMode = false;

    // Check if subscriptions were resumed
    const subscriptionsResumed = result?.data?.subscriptions_resumed || 0;
    console.log('[Credits] Subscriptions resumed:', subscriptionsResumed);

    // Clear any messages and show success briefly
    clearSecureMessages();

    // Refresh wallet to get updated state (especially for restore)
    const wallet = await fetchWallet();

    // Refresh subscription status
    await fetchSubscription();

    // Show verified state
    if (verifiedEmailEl) verifiedEmailEl.textContent = userEmail;
    showSecureState(3);
    verifyCodeBtn?.classList.remove('loading');

    // Reload history from DB for the (possibly new) identity and re-render
    if ((wasRestoreMode || identityChanged) && window.loadHistoryFromDB) {
      window.loadHistoryFromDB().then(() => {
        if (window.renderHistory) window.renderHistory();
      }).catch(() => {});
    }

    // Show restore success popup if this was a restore operation
    if (wasRestoreMode) {
      const restoredCredits = wallet?.available ?? walletAvailable ?? 0;
      const restoredVideoCredits = wallet?.videoAvailable ?? 0;
      openRestoreSuccessModal(restoredCredits, restoredVideoCredits);
    } else if (subscriptionsResumed > 0) {
      // Show subscription resumed toast
      showToast('Email verified. Subscription resumed.', 'success');
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
  async function showRestoreMode() {
    // Check if user has credits on their current anonymous identity
    const currentCredits = walletAvailable || 0;

    if (currentCredits > 0 && !emailVerified) {
      // Warn user about potential credit loss
      const confirmRestore = await showConfirm({
        title: 'Switch Account?',
        message: `You currently have <strong>${currentCredits.toLocaleString()}</strong> credits on this device.<br><br>If you restore a different account, you'll switch to that account's credits instead.`,
        confirmText: 'Continue with Restore',
        cancelText: 'Cancel',
        icon: 'fa-arrow-right-arrow-left'
      });

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
      if (subtitle) subtitle.textContent = 'Enter the email linked to your existing account.';
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
      if (h3) h3.textContent = 'Your Account';
      if (subtitle) subtitle.textContent = 'Add an email to access your account on any device.';
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
  // Account Status Shield (navbar, inside credits group)
  // Single indicator replaces old emailBeacon + accountStatusBtn.
  // Shield icon color: red (anonymous) / amber (unverified) / green (verified)
  // Click: opens secure-credits flow or restore modal depending on state.
  // ─────────────────────────────────────────────────────────────

  const accountStatusBtn = document.getElementById('accountStatusBtn');

  /**
   * Update all account-safety UI: navbar shield, checkout button hints.
   * Called by updateSecureCreditsUI() on every wallet/identity refresh.
   */
  function updateEmailBeaconUI() {
    // Update navbar shield indicator
    updateAccountStatusUI();
    // Update checkout CTA button hints
    updateCheckoutButtonStates();
  }

  function updateAccountStatusUI() {
    if (!accountStatusBtn) return;

    let status, tooltip;

    if (emailVerified && userEmail) {
      status = 'verified';
      tooltip = 'Account secured';
    } else if (userEmail && !emailVerified) {
      status = 'unverified';
      tooltip = 'Verify your email';
    } else {
      status = 'anonymous';
      tooltip = 'Secure your account';
    }

    accountStatusBtn.setAttribute('data-status', status);
    accountStatusBtn.setAttribute('data-tooltip', tooltip);
    accountStatusBtn.setAttribute('aria-label', tooltip);

    // Shield icon stays fa-shield-halved in all states — color does the work
    // (icon is set in HTML, no className swap needed)
  }

  /**
   * Update checkout button states based on email verification status.
   */
  function updateCheckoutButtonStates() {
    const needsVerification = userEmail && !emailVerified;
    const needsEmail = !userEmail;

    const checkoutCtaButtons = document.querySelectorAll('.pricing-cta');
    checkoutCtaButtons.forEach(btn => {
      if (needsEmail || needsVerification) {
        btn.setAttribute('data-requires-verified-email', 'true');
        btn.setAttribute('data-hint', needsEmail ? 'Add email first' : 'Verify email first');
      } else {
        btn.removeAttribute('data-requires-verified-email');
        btn.removeAttribute('data-hint');
      }
    });
  }

  accountStatusBtn?.addEventListener('click', () => {
    if (emailVerified) {
      openRestoreAccountModal();
    } else if (secureCreditsCard && !secureCreditsCard.classList.contains('expanded')) {
      openSecureCreditsModal();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // UPDATED INIT: Also update secure credits UI
  // ─────────────────────────────────────────────────────────────

  // Initial secure credits UI update.
  // Email state is already available from the workspace-credits bootstrap
  // (/api/me via initCredits → fetchWallet) which writes to WalletStore.
  // We read from WalletStore instead of making a duplicate /api/me call.
  setTimeout(() => {
    const snap = WalletStore.getSnapshot();
    if (snap.email !== null || snap.emailVerified) {
      userEmail = snap.email || '';
      emailVerified = snap.emailVerified || false;
    }
    updateSecureCreditsUI();
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
  let _subFetchInFlight = null;
  let _subFetchedAt = 0;

  async function fetchSubscription(force = false) {
    // Dedupe: skip if fetched recently (10s) unless forced
    if (_subFetchInFlight && !force) return _subFetchInFlight;
    if (!force && _subFetchedAt && (Date.now() - _subFetchedAt) < 10000) return;

    try {
      _subFetchInFlight = apiFetch('/api/billing/subscriptions/me');
      const result = await _subFetchInFlight;
      _subFetchInFlight = null;
      _subFetchedAt = Date.now();
      if (result.ok && result.data?.ok) {
        currentSubscription = result.data.subscription;
        updateSubscriptionUI();
      }
    } catch (err) {
      _subFetchInFlight = null;
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
      hideSubscriptionPausedBanner();
      hidePaymentFailedBanner();
      return;
    }

    const { plan_name, credits_per_month, status, current_period_end, pause_reason } = currentSubscription;

    // Check if subscription is paused due to email verification
    const isPausedForEmail = pause_reason === 'email_unverified';

    if (status === 'cancelled') {
      // Show cancelled card
      subscriptionSection?.classList.remove('hidden');
      subscriptionCard.classList.add('hidden');
      subscriptionCancelledCard.classList.remove('hidden');
      hideSubscriptionPausedBanner();
      hidePaymentFailedBanner();

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
        if (isPausedForEmail) {
          subscriptionStatus.textContent = 'Paused';
          subscriptionStatus.classList.add('paused');
          subscriptionStatus.classList.remove('past-due');
        } else if (status === 'past_due') {
          subscriptionStatus.textContent = 'Past Due';
          subscriptionStatus.classList.add('past-due');
          subscriptionStatus.classList.remove('paused');
        } else {
          subscriptionStatus.textContent = 'Active';
          subscriptionStatus.classList.remove('past-due', 'paused');
        }
      }

      // Show next credits refill date (prefer explicit field, fall back to period_end)
      if (subscriptionNext) {
        if (status === 'past_due') {
          subscriptionNext.textContent = 'Credits paused — waiting for payment';
        } else {
          const refillDate = currentSubscription.credits_next_refill || current_period_end;
          if (refillDate) {
            subscriptionNext.textContent = `Next credits refill: ${formatDate(refillDate)}`;
          }
        }
      }

      // Show paused banner if applicable
      if (isPausedForEmail) {
        showSubscriptionPausedBanner();
        hidePaymentFailedBanner();
      } else if (status === 'past_due') {
        hideSubscriptionPausedBanner();
        showPaymentFailedBanner();
      } else {
        hideSubscriptionPausedBanner();
        hidePaymentFailedBanner();
      }
    } else {
      // Expired or other status - hide entire section
      subscriptionSection?.classList.add('hidden');
      subscriptionCard.classList.add('hidden');
      subscriptionCancelledCard.classList.add('hidden');
      hideSubscriptionPausedBanner();
      hidePaymentFailedBanner();
    }
  }

  /**
   * Show the subscription paused banner (email verification required)
   */
  function showSubscriptionPausedBanner() {
    let banner = document.getElementById('subscriptionPausedBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'subscriptionPausedBanner';
      banner.className = 'subscription-paused-banner';
      banner.innerHTML = `
        <div class="paused-banner-content">
          <svg class="paused-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div class="paused-text">
            <strong>Credits Paused</strong>
            <span>Verify your email to continue receiving monthly credits.</span>
          </div>
          <button class="btn btn-sm btn-primary" id="pausedVerifyBtn">Verify Email</button>
        </div>
      `;

      // Insert after subscription card
      if (subscriptionCard && subscriptionCard.parentNode) {
        subscriptionCard.parentNode.insertBefore(banner, subscriptionCard.nextSibling);
      } else {
        subscriptionSection?.appendChild(banner);
      }

      // Add verify button handler
      document.getElementById('pausedVerifyBtn')?.addEventListener('click', () => {
        openSecureCreditsModal();
        if (userEmail && sentToEmail) {
          pendingEmail = userEmail;
          sentToEmail.textContent = userEmail;
          showSecureState(2);
          verifyCodeInput?.focus();
        }
      });
    }

    banner.classList.remove('hidden');
  }

  /**
   * Hide the subscription paused banner
   */
  function hideSubscriptionPausedBanner() {
    const banner = document.getElementById('subscriptionPausedBanner');
    if (banner) {
      banner.classList.add('hidden');
    }
  }

  /**
   * Show the payment failed banner (past_due subscription)
   */
  function showPaymentFailedBanner() {
    let banner = document.getElementById('paymentFailedBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'paymentFailedBanner';
      banner.className = 'subscription-paused-banner payment-failed-banner';
      banner.innerHTML = `
        <div class="paused-banner-content">
          <svg class="paused-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div class="paused-text">
            <strong>Payment failed</strong>
            <span>We couldn't process your subscription payment. We'll retry automatically. Credits will resume after payment succeeds.</span>
          </div>
          <button class="btn btn-sm btn-primary" id="paymentFailedActionBtn">Update Payment</button>
        </div>
      `;

      // Insert after subscription card
      if (subscriptionCard && subscriptionCard.parentNode) {
        subscriptionCard.parentNode.insertBefore(banner, subscriptionCard.nextSibling);
      } else {
        subscriptionSection?.appendChild(banner);
      }

      // Action button opens manage subscription modal (closest to billing management)
      document.getElementById('paymentFailedActionBtn')?.addEventListener('click', () => {
        openManageSubModal();
      });
    }

    banner.classList.remove('hidden');
  }

  /**
   * Hide the payment failed banner
   */
  function hidePaymentFailedBanner() {
    const banner = document.getElementById('paymentFailedBanner');
    if (banner) {
      banner.classList.add('hidden');
    }
  }

  /**
   * Format date for display (billing/subscription dates).
   * Uses UTC components so the displayed calendar day never shifts
   * due to the viewer's browser timezone.
   */
  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;
      return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
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

  // ─────────────────────────────────────────────────────────────
  // Subscription Status Pill (Nav Bar)
  // ─────────────────────────────────────────────────────────────

  const subscriptionStatusPill = document.getElementById('subscriptionStatusPill');
  const subscriptionIcon = document.getElementById('subscriptionIcon');
  const subscriptionText = document.getElementById('subscriptionText');

  /**
   * Format date in UK style: "1 Mar 2026"
   * Uses UTC components so billing/subscription dates never shift
   * due to the viewer's browser timezone.
   */
  function formatDateUK(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const day = d.getUTCDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    return `${day} ${month} ${year}`;
  }

  /**
   * Load subscription summary and update nav pill
   * Uses GET /api/billing/subscriptions/summary
   * Includes retry logic for reliability
   */
  let _subSummaryInFlight = null;
  let _subSummaryFetchedAt = 0;

  async function loadSubscriptionSummary(retryCount = 0) {
    if (!subscriptionStatusPill) return;

    // Dedupe: return in-flight promise or skip if fetched recently (10s)
    if (_subSummaryInFlight && retryCount === 0) return _subSummaryInFlight;
    if (retryCount === 0 && _subSummaryFetchedAt && (Date.now() - _subSummaryFetchedAt) < 10000) return;

    try {
      _subSummaryInFlight = apiFetch('/api/billing/subscriptions/summary', { timeout: 15000 });
      const result = await _subSummaryInFlight;
      _subSummaryInFlight = null;
      _subSummaryFetchedAt = Date.now();

      if (!result.ok || !result.data?.ok) {
        // Retry up to 2 times on failure
        if (retryCount < 2) {
          console.log(`[Credits] Retrying subscription summary (attempt ${retryCount + 2})...`);
          await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
          return loadSubscriptionSummary(retryCount + 1);
        }
        console.warn('[Credits] Failed to load subscription summary:', result.error);
        subscriptionStatusPill.classList.add('hidden');
        return;
      }

      const data = result.data;

      // If no subscription, hide the pill
      if (!data.has_subscription) {
        subscriptionStatusPill.classList.add('hidden');
        return;
      }

      // Map DB status to display status
      // pending_payment -> "processing" in UI
      let status = data.status;
      if (status === 'pending_payment') status = 'processing';

      // Update pill styling
      subscriptionStatusPill.classList.remove('hidden', 'status-active', 'status-cancelled', 'status-processing', 'status-suspended', 'status-past_due');
      subscriptionStatusPill.classList.add(`status-${status}`);

      // Update icon
      if (subscriptionIcon) {
        subscriptionIcon.className = 'fa-solid subscription-icon';
        if (status === 'active') {
          subscriptionIcon.classList.add('fa-rotate');
        } else if (status === 'cancelled') {
          subscriptionIcon.classList.add('fa-clock');
        } else if (status === 'processing') {
          subscriptionIcon.classList.add('fa-hourglass-half');
        } else if (status === 'past_due') {
          subscriptionIcon.classList.add('fa-exclamation-triangle');
        } else if (status === 'suspended') {
          subscriptionIcon.classList.add('fa-exclamation-triangle');
        } else {
          subscriptionIcon.classList.add('fa-rotate');
        }
      }

      // Build status text
      let statusText = '';
      if (status === 'active') {
        const nextDate = formatDateUK(data.credits_next_refill || data.next_credit_date);
        statusText = nextDate ? `Active — Next credits refill: ${nextDate}` : 'Active';
      } else if (status === 'past_due') {
        statusText = 'Payment failed — credits paused';
      } else if (status === 'cancelled') {
        const endDate = formatDateUK(data.ends_at || data.current_period_end);
        statusText = endDate ? `Cancelled — Ends on: ${endDate}` : 'Cancelled';
      } else if (status === 'processing') {
        statusText = 'Payment processing… (SEPA can take 1–2 business days)';
      } else if (status === 'suspended') {
        const reason = data.suspend_reason || 'payment issue/refund detected';
        statusText = `Suspended: ${reason}`;
      } else {
        statusText = status.charAt(0).toUpperCase() + status.slice(1);
      }

      if (subscriptionText) {
        subscriptionText.textContent = statusText;
        subscriptionText.title = statusText; // Full text on hover
      }

      console.log('[Credits] Subscription status pill updated:', status);
    } catch (err) {
      console.error('[Credits] Error loading subscription summary:', err);
      // Retry on error
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
        return loadSubscriptionSummary(retryCount + 1);
      }
      subscriptionStatusPill.classList.add('hidden');
    }
  }

  // Load subscription summary after the wallet/auth bootstrap settles.
  // On workspace: main.js dispatches 'timrx:startup-complete' after Phase 3.
  // On Hub: that event never fires, so we use a shorter direct fallback.
  let _subSummaryScheduled = false;
  const _scheduleSubSummary = () => {
    if (_subSummaryScheduled) return;
    _subSummaryScheduled = true;
    setTimeout(() => loadSubscriptionSummary(), 2000);
  };
  window.addEventListener('timrx:startup-complete', _scheduleSubSummary, { once: true });
  // On Hub, wallet fetch takes ~200-700ms. Schedule subscription 2s after
  // that completes, or 3s from page load (whichever is first).
  const _hubFallbackMs = _isWorkspace ? 8000 : 3000;
  setTimeout(_scheduleSubSummary, _hubFallbackMs);

  // ─────────────────────────────────────────────────────────────
  // MANAGE SUBSCRIPTION MODAL (standalone, opened from pill)
  // ─────────────────────────────────────────────────────────────
  const manageSubModal = document.getElementById('manageSubModal');
  const manageSubClose = document.getElementById('manageSubClose');
  const manageSubActive = document.getElementById('manageSubActive');
  const manageSubPastDue = document.getElementById('manageSubPastDue');
  const manageSubCancelled = document.getElementById('manageSubCancelled');
  const manageSubNone = document.getElementById('manageSubNone');

  function openManageSubModal() {
    if (!manageSubModal) return;

    // Fetch fresh data then show
    fetchSubscription().then(() => {
      // Reset all states
      if (manageSubActive) manageSubActive.style.display = 'none';
      if (manageSubPastDue) manageSubPastDue.style.display = 'none';
      if (manageSubCancelled) manageSubCancelled.style.display = 'none';
      if (manageSubNone) manageSubNone.style.display = 'none';

      if (!currentSubscription) {
        if (manageSubNone) manageSubNone.style.display = 'block';
      } else if (currentSubscription.status === 'cancelled') {
        if (manageSubCancelled) manageSubCancelled.style.display = 'block';
        const cp = document.getElementById('manageSubCancelledPlan');
        const ed = document.getElementById('manageSubEndDate');
        if (cp) cp.textContent = currentSubscription.plan_name;
        if (ed) ed.textContent = formatDate(currentSubscription.current_period_end);
      } else if (currentSubscription.status === 'past_due') {
        // Show dedicated past_due panel
        if (manageSubPastDue) manageSubPastDue.style.display = 'block';
        const pdp = document.getElementById('manageSubPastDuePlan');
        const pdc = document.getElementById('manageSubPastDueCredits');
        if (pdp) pdp.textContent = currentSubscription.plan_name;
        if (pdc) pdc.textContent = (currentSubscription.credits_per_month || 0).toLocaleString();
      } else {
        if (manageSubActive) manageSubActive.style.display = 'block';
        const mp = document.getElementById('manageSubPlan');
        const mc = document.getElementById('manageSubCredits');
        const ms = document.getElementById('manageSubStatus');
        const mn = document.getElementById('manageSubNext');
        if (mp) mp.textContent = currentSubscription.plan_name;
        if (mc) mc.textContent = (currentSubscription.credits_per_month || 0).toLocaleString();
        if (ms) {
          ms.textContent = 'Active';
          ms.style.color = '#4ade80';
        }
        const refill = currentSubscription.credits_next_refill || currentSubscription.current_period_end;
        if (mn) mn.textContent = refill ? formatDate(refill) : '--';
      }
    });

    manageSubModal.classList.add('open');
    manageSubModal.setAttribute('aria-hidden', 'false');
  }

  function closeManageSubModal() {
    if (!manageSubModal) return;
    manageSubModal.classList.remove('open');
    manageSubModal.setAttribute('aria-hidden', 'true');
  }

  manageSubClose?.addEventListener('click', closeManageSubModal);
  manageSubModal?.addEventListener('click', (e) => {
    if (e.target === manageSubModal) closeManageSubModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && manageSubModal?.classList.contains('open')) {
      closeManageSubModal();
    }
  });

  // Cancel button inside manage modal
  document.getElementById('manageSubCancelBtn')?.addEventListener('click', async () => {
    await handleCancelSubscription();
    // Refresh the modal to show cancelled state
    if (currentSubscription) {
      openManageSubModal();
      loadSubscriptionSummary();
    }
  });

  // Browse plans button
  document.getElementById('manageSubBrowseBtn')?.addEventListener('click', () => {
    closeManageSubModal();
    document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' });
  });

  // Past-due modal: "Update Payment" → scroll to pricing (re-subscribe is the Mollie-supported recovery path)
  document.getElementById('manageSubRetryBtn')?.addEventListener('click', () => {
    closeManageSubModal();
    document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' });
  });

  // Past-due modal: cancel button
  document.getElementById('manageSubPastDueCancelBtn')?.addEventListener('click', async () => {
    await handleCancelSubscription();
    if (currentSubscription) {
      openManageSubModal();
      loadSubscriptionSummary();
    }
  });

  // Clicking the subscription pill opens the manage subscription modal
  subscriptionStatusPill?.addEventListener('click', () => {
    openManageSubModal();
  });

  // Expose for external use
  // ─────────────────────────────────────────────────────────────
  // Value Calculator — "What can I create?"
  // ─────────────────────────────────────────────────────────────
  const calcGrid = document.getElementById('calcGrid');
  const calcPills = document.getElementById('calcPills');
  // calcToggleRow and calcVideoTier removed — tiers are now inline dropdowns
  const calcSub = document.querySelector('.calc-sub');

  // Credit costs (single source of truth — matches backend pricing_service.py)
  const CALC_COSTS = {
    general: {
      image_1k: 4,
      image_2k: 8,
      image_4k_nb: 18,
      text_to_3d: 20,
      image_to_3d: 30,
      refine: 6,
      retexture: 5,
    },
    video: {
      budget:  { '5s': 45, '10s': 80, '12s': 95 },
      standard: { '4s': 48, '6s': 72, '8s': 96, '8s_1080p': 120, '8s_4k': 156 },
      fast:    { '5s': 50, '10s': 100, '15s': 150 },
      premium: { '5s': 80, '10s': 160, '15s': 240 },
    },
  };

  function renderCalcGrid(credits, type) {
    if (!calcGrid) return;

    let items = [];

    if (type === 'general') {
      const c = CALC_COSTS.general;
      items = [
        { icon: 'fa-image',       value: Math.floor(credits / c.image_1k),   label: 'AI Images',   detail: '1K · 4c each' },
        { icon: 'fa-expand',      value: Math.floor(credits / c.image_2k),   label: 'HD Images',   detail: '2K · 8c each' },
        { icon: 'fa-cube',        value: Math.floor(credits / c.text_to_3d), label: '3D Models',   detail: 'Text to 3D · 20c' },
        { icon: 'fa-upload',      value: Math.floor(credits / c.image_to_3d),label: 'Image to 3D', detail: 'Photo → model · 30c' },
        { icon: 'fa-wand-magic-sparkles', value: Math.floor(credits / c.refine), label: 'Refines', detail: 'Enhance · 6c' },
        { icon: 'fa-palette',     value: Math.floor(credits / c.retexture),  label: 'Retextures',  detail: 'New textures · 5c' },
      ];
    } else {
      // Video mode — show key durations across all tiers (3x3 grid)
      const v = CALC_COSTS.video;
      items = [
        { icon: 'fa-bolt',        value: Math.floor(credits / v.budget['5s']),   label: '5s Draft',      detail: 'Seedance 1.5 · 45c' },
        { icon: 'fa-bolt',        value: Math.floor(credits / v.budget['10s']),  label: '10s Draft',     detail: 'Seedance 1.5 · 80c' },
        { icon: 'fa-bolt',        value: Math.floor(credits / v.budget['12s']),  label: '12s Draft',     detail: 'Seedance 1.5 · 95c' },
        { icon: 'fa-video',       value: Math.floor(credits / v.fast['5s']),     label: '5s Standard',   detail: 'Seedance 2.0 · 50c' },
        { icon: 'fa-video',       value: Math.floor(credits / v.fast['10s']),    label: '10s Standard',  detail: 'Seedance 2.0 · 100c' },
        { icon: 'fa-video',       value: Math.floor(credits / v.fast['15s']),    label: '15s Standard',  detail: 'Seedance 2.0 · 150c' },
        { icon: 'fa-film',        value: Math.floor(credits / v.standard['4s']), label: '4s HD',         detail: 'Veo 3.1 720p · 48c' },
        { icon: 'fa-film',        value: Math.floor(credits / v.standard['8s']), label: '8s HD',         detail: 'Veo 3.1 720p · 96c' },
        { icon: 'fa-clapperboard',value: Math.floor(credits / v.standard['8s_4k']),label: '8s Ultra',    detail: 'Veo 3.1 4K · 156c' },
      ];
    }

    calcGrid.innerHTML = items.map(item =>
      item ? `<div class="calc-item">
        <i class="fa-solid ${item.icon} calc-item-icon"></i>
        <span class="calc-item-value pop">${item.value.toLocaleString()}</span>
        <span class="calc-item-label">${item.label}</span>
        <span class="calc-item-detail">${item.detail}</span>
      </div>` : '<div class="calc-item calc-item-empty"></div>'
    ).join('');

    // All tiers shown at once — no separate toggle needed
  }

  function updateCalcPills(mode) {
    if (!calcPills) return;

    // Tier options per pool
    const generalTiers = (mode === 'monthly' || mode === 'yearly')
      ? [{ value: 300, label: 'Starter · 300/mo' }, { value: 800, label: 'Creator · 800/mo' }, { value: 2000, label: 'Studio · 2,000/mo' }]
      : [{ value: 350, label: 'Starter · 350' }, { value: 1100, label: 'Creator · 1,100' }, { value: 2400, label: 'Studio · 2,400' }];

    const videoTiers = [
      { value: 550, label: 'Starter · 550' },
      { value: 1800, label: 'Creator · 1,800' },
      { value: 4000, label: 'Studio · 4,000' },
    ];

    const activePool = mode === 'video' ? 'video' : 'general';

    calcPills.innerHTML = `
      <button type="button" class="calc-pill${activePool === 'general' ? ' active' : ''}" data-calc-pool="general">
        <i class="fa-solid fa-cube" style="margin-right:5px;font-size:12px;opacity:.6"></i>General
      </button>
      <select class="calc-tier-select" id="calcGeneralTier">
        ${generalTiers.map((t, i) => `<option value="${t.value}"${i === 0 ? ' selected' : ''}>${t.label}</option>`).join('')}
      </select>
      <button type="button" class="calc-pill${activePool === 'video' ? ' active' : ''}" data-calc-pool="video">
        <i class="fa-solid fa-video" style="margin-right:5px;font-size:12px;opacity:.6"></i>Video
      </button>
      <select class="calc-tier-select" id="calcVideoTierSelect">
        ${videoTiers.map((t, i) => `<option value="${t.value}"${i === 0 ? ' selected' : ''}>${t.label}</option>`).join('')}
      </select>
    `;

    // Refs
    const generalPillBtn = calcPills.querySelector('[data-calc-pool="general"]');
    const videoPillBtn = calcPills.querySelector('[data-calc-pool="video"]');
    const generalTierSel = document.getElementById('calcGeneralTier');
    const videoTierSel = document.getElementById('calcVideoTierSelect');

    function activatePool(pool) {
      generalPillBtn.classList.toggle('active', pool === 'general');
      videoPillBtn.classList.toggle('active', pool === 'video');
      generalTierSel.style.display = pool === 'general' ? '' : 'none';
      videoTierSel.style.display = pool === 'video' ? '' : 'none';
      const credits = parseInt(pool === 'general' ? generalTierSel.value : videoTierSel.value, 10);
      renderCalcGrid(credits, pool);
      if (calcSub) {
        calcSub.textContent = pool === 'video'
          ? 'Video credits are separate — used only for video generation.'
          : 'General credits — used for images, 3D, refine & retexture.';
      }
    }

    generalPillBtn.addEventListener('click', () => activatePool('general'));
    videoPillBtn.addEventListener('click', () => activatePool('video'));
    generalTierSel.addEventListener('change', () => {
      activatePool('general');
    });
    videoTierSel.addEventListener('change', () => {
      activatePool('video');
    });

    // Initial render
    activatePool(activePool);
  }

  // Listen for pricing mode changes to update calculator
  window.addEventListener('timrx:pricing-mode', (e) => {
    updateCalcPills(e.detail?.mode || 'one_time');
  });

  // Title button toggles calculator open/closed
  const calcToggleBtn = document.getElementById('calcToggleBtn');
  const calcWrap = document.getElementById('valueCalculator');

  if (calcToggleBtn && calcWrap) {
    calcToggleBtn.addEventListener('click', () => {
      const isOpen = calcWrap.classList.contains('open');
      if (isOpen) {
        calcWrap.classList.remove('open');
        calcWrap.classList.add('collapsed');
      } else {
        calcWrap.classList.remove('collapsed');
        calcWrap.classList.add('open');
        // Initialize grid on first open
        updateCalcPills(pricingMode);
      }
    });
  }

  // Initialize calculator on load (only if already visible)
  if (calcGrid && calcWrap && calcWrap.classList.contains('open')) updateCalcPills(pricingMode);

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
    loadSubscriptionSummary: loadSubscriptionSummary,
  };

  // Standardized ready flag for diagnostics (hub page)
  window.__TIMRX_CREDITS_READY__ = true;
  window.__TIMRX_CREDITS_PAGE__ = 'hub';
  console.log('[Credits] Hub credits module ready');

})();
