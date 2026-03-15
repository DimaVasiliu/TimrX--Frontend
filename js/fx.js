/**
 * fx.js
 * Multi-currency price display for TimrX
 *
 * Shows estimated prices in user's local currency while billing remains in GBP.
 * Uses 24h cached FX rates from backend or localStorage fallback.
 */

(function() {
  'use strict';

  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  const FX_CACHE_KEY = 'timrx_fx_rates';
  const FX_CACHE_TTL = 86400000; // 24 hours in ms

  // Country to currency mapping
  const COUNTRY_CURRENCY_MAP = {
    // USD countries
    'US': 'USD',
    'PR': 'USD', // Puerto Rico
    'GU': 'USD', // Guam
    'VI': 'USD', // US Virgin Islands
    // EUR countries (Eurozone)
    'AT': 'EUR', 'BE': 'EUR', 'CY': 'EUR', 'EE': 'EUR', 'FI': 'EUR',
    'FR': 'EUR', 'DE': 'EUR', 'GR': 'EUR', 'IE': 'EUR', 'IT': 'EUR',
    'LV': 'EUR', 'LT': 'EUR', 'LU': 'EUR', 'MT': 'EUR', 'NL': 'EUR',
    'PT': 'EUR', 'SK': 'EUR', 'SI': 'EUR', 'ES': 'EUR',
    // CAD
    'CA': 'CAD',
    // AUD
    'AU': 'AUD',
    // GBP - no conversion needed
    'GB': 'GBP',
    'UK': 'GBP',
  };

  // Locale to currency fallback
  const LOCALE_CURRENCY_MAP = {
    'en-US': 'USD',
    'en-CA': 'CAD',
    'en-AU': 'AUD',
    'en-GB': 'GBP',
    // European locales
    'de': 'EUR', 'de-DE': 'EUR', 'de-AT': 'EUR',
    'fr': 'EUR', 'fr-FR': 'EUR', 'fr-BE': 'EUR',
    'es': 'EUR', 'es-ES': 'EUR',
    'it': 'EUR', 'it-IT': 'EUR',
    'nl': 'EUR', 'nl-NL': 'EUR', 'nl-BE': 'EUR',
    'pt': 'EUR', 'pt-PT': 'EUR',
    'el': 'EUR', 'el-GR': 'EUR',
    'fi': 'EUR', 'fi-FI': 'EUR',
  };

  // Currency symbols and formatting
  const CURRENCY_CONFIG = {
    GBP: { symbol: '£', locale: 'en-GB' },
    USD: { symbol: '$', locale: 'en-US' },
    EUR: { symbol: '€', locale: 'de-DE' },
    CAD: { symbol: 'C$', locale: 'en-CA' },
    AUD: { symbol: 'A$', locale: 'en-AU' },
  };

  /**
   * Detect user's preferred display currency.
   * Priority: 1) Cloudflare country header, 2) Browser locale
   */
  function getTargetCurrency() {
    // 1. Check Cloudflare Worker country (set by edge)
    if (window.__IP_COUNTRY) {
      const country = window.__IP_COUNTRY.toUpperCase();
      if (COUNTRY_CURRENCY_MAP[country]) {
        return COUNTRY_CURRENCY_MAP[country];
      }
    }

    // 2. Fall back to browser locale
    const locale = navigator.language || navigator.userLanguage || 'en-GB';

    // Try exact match first
    if (LOCALE_CURRENCY_MAP[locale]) {
      return LOCALE_CURRENCY_MAP[locale];
    }

    // Try language part only (e.g., 'de' from 'de-CH')
    const lang = locale.split('-')[0];
    if (LOCALE_CURRENCY_MAP[lang]) {
      return LOCALE_CURRENCY_MAP[lang];
    }

    // Default: no conversion (show GBP only)
    return 'GBP';
  }

  /**
   * Get cached FX rates from localStorage.
   * Returns null if cache expired or invalid.
   */
  function getCachedRates() {
    try {
      const cached = localStorage.getItem(FX_CACHE_KEY);
      if (!cached) return null;

      const data = JSON.parse(cached);
      const age = Date.now() - (data.cached_at || 0);

      if (age < FX_CACHE_TTL && data.rates) {
        return data.rates;
      }
    } catch (e) {
      console.warn('[FX] Cache read error:', e);
    }
    return null;
  }

  /**
   * Save FX rates to localStorage cache.
   */
  function setCachedRates(rates) {
    try {
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify({
        rates: rates,
        cached_at: Date.now(),
      }));
    } catch (e) {
      console.warn('[FX] Cache write error:', e);
    }
  }

  /**
   * Fetch FX rates from backend with caching.
   * Returns rates object or null if unavailable.
   */
  async function getFxRatesCached() {
    // Check local cache first
    const cached = getCachedRates();
    if (cached) {
      console.log('[FX] Using cached rates');
      return cached;
    }

    // Fetch from backend
    try {
      const response = await fetch(`${API_BASE}/api/billing/public/fx`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      // AUTH-5: Log non-OK responses for diagnostics (public endpoint, 401 unlikely)
      if (!response.ok) {
        console.warn(`[FX] Non-OK response: ${response.status}`);
        return null;
      }
      const data = await response.json();
      if (data.ok && data.rates) {
        setCachedRates(data.rates);
        console.log('[FX] Fetched fresh rates:', data.rates);
        return data.rates;
      }
    } catch (e) {
      console.warn('[FX] Fetch error:', e);
    }

    return null;
  }

  /**
   * Convert GBP amount to target currency.
   * Returns null if conversion not possible.
   */
  function convert(amountGbp, currency, rates) {
    if (!rates || currency === 'GBP') return null;
    const rate = rates[currency];
    if (!rate) return null;
    return amountGbp * rate;
  }

  /**
   * Format currency amount using Intl.NumberFormat.
   */
  function formatCurrency(amount, currency) {
    const config = CURRENCY_CONFIG[currency] || CURRENCY_CONFIG.GBP;
    try {
      return new Intl.NumberFormat(config.locale, {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (e) {
      // Fallback formatting
      return `${config.symbol}${amount.toFixed(2)}`;
    }
  }

  /**
   * Format GBP price with symbol.
   */
  function formatGBP(amount) {
    return formatCurrency(amount, 'GBP');
  }

  /**
   * Generate the secondary price line HTML.
   * Returns empty string if no conversion available.
   *
   * @param {number} gbpAmount - Price in GBP
   * @param {string} targetCurrency - Target currency code
   * @param {object} rates - FX rates object
   * @returns {string} HTML string for secondary price line
   */
  function getConvertedPriceHtml(gbpAmount, targetCurrency, rates) {
    if (!rates || targetCurrency === 'GBP') return '';

    const converted = convert(gbpAmount, targetCurrency, rates);
    if (converted === null) return '';

    const formatted = formatCurrency(converted, targetCurrency);
    return `<span class="price-converted">≈ ${formatted} ${targetCurrency} <span class="price-disclaimer">(estimated, charged in GBP)</span></span>`;
  }

  /**
   * Initialize FX display - call this on page load.
   * Returns a promise that resolves with the FX context.
   */
  async function initFx() {
    const targetCurrency = getTargetCurrency();
    const rates = await getFxRatesCached();

    const context = {
      targetCurrency,
      rates,
      hasConversion: rates !== null && targetCurrency !== 'GBP',
    };

    console.log('[FX] Initialized:', context);
    return context;
  }

  // Expose public API
  window.TimrXFx = {
    init: initFx,
    getTargetCurrency,
    getFxRatesCached,
    convert,
    formatCurrency,
    formatGBP,
    getConvertedPriceHtml,
    CURRENCY_CONFIG,
  };

  // Auto-initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initFx().then(ctx => {
        window.__TIMRX_FX_CONTEXT__ = ctx;
      });
    });
  } else {
    initFx().then(ctx => {
      window.__TIMRX_FX_CONTEXT__ = ctx;
    });
  }

})();
