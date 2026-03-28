/**
 * trustpilot.js
 * Central Trustpilot configuration, URL injection, and smart review prompting.
 * All Trustpilot URLs are defined here — do not hardcode them elsewhere.
 */
(function () {
    'use strict';
  
    // ── Config (single source of truth) ──────────────────────────
    var TP = {
      PUBLIC_URL:  'https://uk.trustpilot.com/review/timrx.live',
      INVITE_URL:  'https://uk.trustpilot.com/evaluate/timrx.live',
      ENABLED:     true,
      COOLDOWN_DAYS: 30,
      _STORAGE_KEY: 'timrx_tp_prompted'
    };
  
    window.TIMRX_TRUSTPILOT = TP;
  
    if (!TP.ENABLED) return;
  
    // ── URL injection ────────────────────────────────────────────
    // All links use data-tp="read" or data-tp="write" instead of hardcoded hrefs.
    function injectUrls() {
      var els = document.querySelectorAll('[data-tp]');
      for (var i = 0; i < els.length; i++) {
        var type = els[i].getAttribute('data-tp');
        if (type === 'read')  els[i].href = TP.PUBLIC_URL;
        if (type === 'write') els[i].href = TP.INVITE_URL;
      }
    }
  
    // ── Smart prompting (localStorage cooldown) ──────────────────
    function shouldPrompt() {
      try {
        var ts = localStorage.getItem(TP._STORAGE_KEY);
        if (!ts) return true;
        var days = (Date.now() - parseInt(ts, 10)) / 864e5;
        return days >= TP.COOLDOWN_DAYS;
      } catch (e) { return true; }
    }
  
    function markPrompted() {
      try { localStorage.setItem(TP._STORAGE_KEY, Date.now().toString()); } catch (e) {}
    }
  
    // ── Payment success modal CTA ───────────────────────────────
    function injectSuccessCta() {
      if (!shouldPrompt()) return;
      var actions = document.getElementById('successActions');
      if (!actions || actions.parentElement.querySelector('.tp-success-cta')) return;
  
      var wrap = document.createElement('div');
      wrap.className = 'tp-success-cta';
      wrap.innerHTML =
        '<p class="tp-success-text">Enjoying TimrX? We welcome honest feedback.</p>' +
        '<a class="tp-btn tp-btn--pill" href="' + TP.INVITE_URL + '" target="_blank" rel="noopener noreferrer">' +
        'Share your experience on Trustpilot</a>';
      actions.parentElement.appendChild(wrap);
      markPrompted();
    }
  
    function removeSuccessCta() {
      var el = document.querySelector('.tp-success-cta');
      if (el) el.remove();
    }
  
    // Watch payment success modal for open + celebrate state
    var modal = document.getElementById('paymentSuccessModal');
    if (modal) {
      new MutationObserver(function () {
        if (!modal.classList.contains('open')) {
          removeSuccessCta();
          return;
        }
        var card = modal.querySelector('.success-card');
        if (card && card.classList.contains('celebrate') &&
            !card.classList.contains('pending') &&
            !card.classList.contains('failed')) {
          setTimeout(injectSuccessCta, 1400);
        }
      }).observe(modal, { attributes: true, attributeFilter: ['class'], subtree: true });
    }
  
    // ── Expose helpers ──────────────────────────────────────────
    TP.shouldPrompt  = shouldPrompt;
    TP.markPrompted  = markPrompted;
  
    // ── Init ────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectUrls);
    } else {
      injectUrls();
    }
  })();
  