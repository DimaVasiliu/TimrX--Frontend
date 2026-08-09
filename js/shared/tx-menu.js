/* ==========================================================================
   TimrX mobile menu — the single burger behaviour for every page.
   Pairs with tx-menu.css; see that file for the markup contract.

   Wires up any [data-tx-burger] / [data-tx-menu] pair on the page:
   open + close, backdrop, scroll lock, Escape, focus trap and focus restore.
   Self-initialising and safe to load on pages that have no menu at all.
   ========================================================================== */
(function () {
  'use strict';

  var FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';
  /* Rows rise in DOM order; the index drives the stagger in CSS. */
  var ROWS = '.tx-menu-head,.tx-menu-extra,.tx-menu-links a,.tx-menu-links button,.tx-menu-cta,.tx-menu-foot';

  function init() {
    var burger = document.querySelector('[data-tx-burger]');
    var menu = document.querySelector('[data-tx-menu]');
    if (!burger || !menu) return;

    var body = document.body;
    var closeButton = menu.querySelector('[data-tx-menu-close]');
    var scrollY = 0;

    var backdrop = document.querySelector('[data-tx-menu-backdrop]');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'tx-menu-backdrop';
      backdrop.setAttribute('data-tx-menu-backdrop', '');
      body.appendChild(backdrop);
    }

    Array.prototype.forEach.call(menu.querySelectorAll(ROWS), function (row, index) {
      row.style.setProperty('--tx-row', String(index));
    });

    function isOpen() {
      return burger.getAttribute('aria-expanded') === 'true';
    }

    /* Only called while the menu is open, and the burger is hidden for the
       whole of that — so the trap is exactly the drawer's own focusables. */
    function items() {
      return Array.prototype.filter.call(
        menu.querySelectorAll(FOCUSABLE),
        function (el) { return el.offsetParent !== null; }
      );
    }

    function open() {
      if (isOpen()) return;
      burger.setAttribute('aria-expanded', 'true');
      burger.setAttribute('aria-label', 'Close menu');
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      backdrop.classList.add('is-open');
      scrollY = window.scrollY || document.documentElement.scrollTop || 0;
      body.style.top = '-' + scrollY + 'px';
      body.classList.add('tx-menu-open');
      requestAnimationFrame(function () {
        (closeButton || burger).focus({ preventScroll: true });
      });
    }

    function close(restoreFocus) {
      var wasOpen = isOpen();
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'Open menu');
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
      backdrop.classList.remove('is-open');
      if (wasOpen) {
        body.classList.remove('tx-menu-open');
        body.style.top = '';
        window.scrollTo(0, scrollY);
      }
      /* Hand focus back to the burger — the close button is about to be
         hidden with the panel, which would otherwise drop focus to the top
         of the page. */
      if (restoreFocus !== false) burger.focus({ preventScroll: true });
    }

    burger.addEventListener('click', function () {
      isOpen() ? close() : open();
    });

    if (closeButton) closeButton.addEventListener('click', function () { close(); });
    backdrop.addEventListener('click', function () { close(); });

    Array.prototype.forEach.call(menu.querySelectorAll('a'), function (link) {
      link.addEventListener('click', function () { close(false); });
    });

    document.addEventListener('keydown', function (event) {
      if (!isOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      var list = items();
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1024 && isOpen()) close(false);
    }, { passive: true });

    /* Shell pages build their nav after load, so expose a re-bind hook. */
    window.TIMRX_MENU = { open: open, close: close, isOpen: isOpen };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.TIMRX_MENU_INIT = init;
})();
