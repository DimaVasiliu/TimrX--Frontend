/*
 * Google Ads purchase conversion helper.
 * Keeps the public gtag_report_conversion name from Google Ads, but allows
 * callers to pass real order values and transaction ids.
 */
(function () {
  'use strict';

  const SEND_TO = 'AW-18162436469/ruWaCPm54qwcEPWSw9RD';
  const DEFAULT_CURRENCY = 'USD';
  const DEFAULT_VALUE = 1.0;
  const DEDUPE_PREFIX = 'timrx_ads_purchase_conversion:';

  function hasReported(transactionId) {
    if (!transactionId) return false;
    try {
      return localStorage.getItem(DEDUPE_PREFIX + transactionId) === '1';
    } catch (_) {
      return false;
    }
  }

  function markReported(transactionId) {
    if (!transactionId) return;
    try {
      localStorage.setItem(DEDUPE_PREFIX + transactionId, '1');
    } catch (_) {
      /* Storage can be blocked; Google Ads still handles transaction_id dedupe. */
    }
  }

  window.gtag_report_conversion = function gtagReportConversion(url, options) {
    const opts = options || {};
    const transactionId = String(opts.transaction_id || opts.transactionId || '');
    const value = Number.isFinite(Number(opts.value)) ? Number(opts.value) : DEFAULT_VALUE;
    const currency = opts.currency || DEFAULT_CURRENCY;

    const callback = function () {
      if (typeof url !== 'undefined' && url) {
        window.location = url;
      }
    };

    if (hasReported(transactionId)) {
      callback();
      return false;
    }

    if (typeof window.gtag !== 'function') {
      callback();
      return false;
    }

    const payload = {
      send_to: SEND_TO,
      value,
      currency,
      transaction_id: transactionId,
      event_callback: callback,
      event_timeout: 2000,
    };

    if (typeof opts.new_customer === 'boolean') {
      payload.new_customer = opts.new_customer;
    }

    markReported(transactionId);
    window.gtag('event', 'conversion', payload);
    return false;
  };
})();
