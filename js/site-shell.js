/*
 * site-shell.js — renders the shared nav, context subnav and footer on shell
 * pages (/hub, /community, /docs, /tutorials, /prompts, /company, /converter,
 * /stl-library, /converters/avi-to-mp4).
 *
 * PHASE 1 refactor: the nav/footer link lists and markup used to live here as
 * copies. They now come from the shared component layer:
 *   js/shared/site-nav-data.js  → window.TIMRX_NAV (routes, nav items, footer)
 *   js/shared/tx-components.js  → window.TIMRX_UI  (markup factories)
 * This file is only the page adapter: mount points, active page, mobile menu.
 *
 * Load order matters — both shared files must be included before this one
 * (all three are `defer`, which executes in document order). If they are
 * missing (stale cached HTML), renderNav() bails out rather than wiping the
 * mount, so a page can never end up with no navigation.
 *
 * Commerce note: on /hub the Buy control renders as <button id="buyCreditsBtn">
 * because js/credits.js binds it to the buy-credits modal. On every other shell
 * page it is a link to the pricing section. Do not "simplify" that difference.
 */
(function () {
  'use strict';

  const body = document.body;
  if (!body) return;

  const UI = window.TIMRX_UI;
  const NAV = window.TIMRX_NAV;
  if (!UI || !NAV) {
    // Shared component layer missing — leave existing markup untouched.
    if (window.console && console.warn) {
      console.warn('[site-shell] shared component layer not loaded; nav/footer left as-is');
    }
    return;
  }

  const page = body.dataset.shellPage || '';

  function renderNav() {
    const navMount = document.querySelector('[data-site-shell="nav"]');
    if (!navMount) return;

    navMount.innerHTML =
      UI.navBar({ page: page, theme: 'shell', commerce: true, buyAsButton: page === 'hub' }) +
      UI.mobileMenu({ page: page });
  }

  function renderContextNav() {
    const mount = document.querySelector('[data-site-shell="subnav"]');
    if (!mount) return;

    /*
     * Hub in-page section nav. Phase 1 keeps every existing anchor alive while
     * marking future migration areas in hub.html. #pricing must survive forever
     * (backend return URLs + notification links).
     */
    mount.innerHTML = UI.contextNav([
      { href: '#overview', label: 'Overview' },
      { href: '#features', label: 'Features' },
      { href: '#liveShowcase', label: 'Showcase' },
      { href: '#pricing', label: 'Pricing' },
      { href: '#community', label: 'Resources' }
    ], 'Hub sections');
  }

  function renderFooter() {
    const footerMount = document.querySelector('[data-site-shell="footer"]');
    if (!footerMount) return;

    footerMount.innerHTML = UI.footer();
    footerMount.querySelectorAll('[data-site-shell-year]').forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });
  }

  renderNav();
  renderContextNav();
  renderFooter();
  UI.rewriteKnownInternalLinks();
  body.classList.add('has-site-shell');
  /* The nav is injected here, after tx-menu.js has already run, so the
     shared menu has to be bound once the markup exists. */
  if (window.TIMRX_MENU_INIT) window.TIMRX_MENU_INIT();
})();
