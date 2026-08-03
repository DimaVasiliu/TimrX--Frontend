/*
 * tx-components.js — shared UI components for TimrX.
 *
 * PHASE 1 (Homepage & Hub foundation). Every reusable chunk of chrome that was
 * previously copy-pasted between shells lives here as a factory returning an
 * HTML string. Factories are skinned per shell via a `theme` option so they can
 * be adopted incrementally without restyling anything:
 *
 *   theme: 'shell'   → the site-shell.css design language (/hub, /community, …)
 *   theme: 'landing' → the landing.css design language (/)
 *
 * The class names emitted are the ones the existing stylesheets already define.
 * No new CSS ships with this file — that is deliberate: Phase 1 must not change
 * how anything looks.
 *
 * IMPORTANT — commerce contract:
 * The nav's auth/credits block renders ids that js/credits.js binds to
 * (#accountStatusBtn, #creditsPill, #creditsValue, #creditsHoverPanel,
 * #hoverGeneralValue, #hoverVideoValue, #subscriptionStatusPill,
 * #buyCreditsBtn). Renaming or dropping any of them silently disables the
 * buy/credits UI. Treat them as a public API.
 *
 * Classic script, no modules. Exposes window.TIMRX_UI.
 */
(function () {
  'use strict';

  var pathname = (window.location && window.location.pathname) || '';
  /* Local .html preview mode (opening files directly) vs deployed clean URLs. */
  var isLocalHtmlPreview = /\.html?$/i.test(pathname);
  var currentDir = pathname.replace(/[^/]*$/, '');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function routes() {
    return (window.TIMRX_NAV && window.TIMRX_NAV.routes) || {};
  }

  function resolveAssetHref(assetPath) {
    var normalized = String(assetPath || '').replace(/^\/+/, '');
    return isLocalHtmlPreview ? currentDir + normalized : '/' + normalized;
  }

  function resolveInternalHref(href) {
    if (typeof href !== 'string' || href.charAt(0) !== '/' || href.indexOf('//') === 0) {
      return href;
    }

    var url = new URL(href, window.location.origin);
    var route = routes()[url.pathname];
    if (!route) return href;

    var basePath = isLocalHtmlPreview ? currentDir + route.preview : route.live;
    var hash = url.hash || route.hash || '';
    return basePath + url.search + hash;
  }

  /* Rewrite hard-coded internal links when previewing local .html files. */
  function rewriteKnownInternalLinks(root) {
    if (!isLocalHtmlPreview) return;
    (root || document).querySelectorAll('a[href^="/"]').forEach(function (link) {
      var originalHref = link.getAttribute('href');
      var resolvedHref = resolveInternalHref(originalHref);
      if (resolvedHref !== originalHref) link.setAttribute('href', resolvedHref);
    });
  }

  function externalAttrs(item) {
    return item && item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  }

  function trackAttr(item) {
    return item && item.track ? ' data-track="' + escapeHtml(item.track) + '"' : '';
  }

  function classList() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
  }

  /* ---------------------------------------------------------------- brand */

  function brand(options) {
    var opts = options || {};
    var model = (window.TIMRX_NAV && window.TIMRX_NAV.brand) || {};
    var theme = opts.theme === 'landing' ? 'landing' : 'shell';
    var size = opts.size || 42;
    var href = resolveInternalHref(model.href || '/');
    var logo = resolveAssetHref(model.logo || 'img/logo.png');

    if (theme === 'landing') {
      return '<a class="brand" href="' + href + '" aria-label="' + escapeHtml(model.name || 'TimrX') + ' home">'
        + '<img src="' + logo + '" width="' + size + '" height="' + size + '" alt="">'
        + '<span>' + escapeHtml(model.wordmarkLead) + '<span>' + escapeHtml(model.wordmarkAccent) + '</span></span>'
        + '</a>';
    }

    return '<a href="' + href + '" class="site-shell-brand" aria-label="' + escapeHtml(model.name || 'TimrX') + ' home">'
      + '<img src="' + logo + '" alt="' + escapeHtml(model.name || 'TimrX') + '" width="' + size + '" height="' + size + '">'
      + '<span class="site-shell-brand-wordmark"><span>' + escapeHtml(model.wordmarkLead) + '</span>'
      + '<span class="site-shell-brand-x">' + escapeHtml(model.wordmarkAccent) + '</span></span>'
      + '</a>';
  }

  /* ------------------------------------------------------------ nav links */

  function navLink(item, options) {
    var opts = options || {};
    var active = Boolean(opts.active);
    var theme = opts.theme === 'landing' ? 'landing' : 'shell';
    var href = resolveInternalHref(item.href);
    var current = active ? ' aria-current="page"' : '';

    if (theme === 'landing') {
      return '<a href="' + href + '"' + current + trackAttr(item) + '>' + escapeHtml(item.label) + '</a>';
    }

    var classes = classList(
      'site-shell-nav-link',
      active ? 'is-active' : '',
      item.accent ? 'is-accent' : ''
    );
    return '<a href="' + href + '" class="' + classes + '"' + current + trackAttr(item) + '>' + escapeHtml(item.label) + '</a>';
  }

  function mobileNavLink(item, options) {
    var opts = options || {};
    var active = Boolean(opts.active);
    var theme = opts.theme === 'landing' ? 'landing' : 'shell';
    var href = resolveInternalHref(item.href);

    if (theme === 'landing') {
      return '<a href="' + href + '"' + trackAttr(item) + '><span>' + escapeHtml(item.label) + '</span>'
        + '<small>' + escapeHtml(item.sub || '') + '</small></a>';
    }

    var classes = classList('site-shell-mobile-link', active ? 'is-active' : '');
    return '<a href="' + href + '" class="' + classes + '"' + trackAttr(item) + '>'
      + '<span class="site-shell-mobile-link-label">' + escapeHtml(item.label) + '</span>'
      + '<span class="site-shell-mobile-link-sub">' + escapeHtml(item.sub || '') + '</span>'
      + '</a>';
  }

  /* -------------------------------------------------- buttons / CTA / badge */

  var BUTTON_CLASSES = {
    shell: { primary: 'site-shell-buy-btn', ghost: 'site-shell-nav-link', accent: 'site-shell-nav-link is-accent' },
    landing: { primary: 'button button-primary', ghost: 'button button-small', accent: 'button button-primary' }
  };

  /*
   * button({ label, href, variant, theme, id, track, ariaLabel })
   * Renders <a> when `href` is set, otherwise <button type="button">.
   */
  function button(options) {
    var opts = options || {};
    var theme = opts.theme === 'landing' ? 'landing' : 'shell';
    var variant = opts.variant || 'primary';
    var cls = classList((BUTTON_CLASSES[theme] || {})[variant] || (BUTTON_CLASSES[theme] || {}).primary, opts.className);
    var id = opts.id ? ' id="' + escapeHtml(opts.id) + '"' : '';
    var track = opts.track ? ' data-track="' + escapeHtml(opts.track) + '"' : '';
    var aria = opts.ariaLabel ? ' aria-label="' + escapeHtml(opts.ariaLabel) + '"' : '';
    var label = escapeHtml(opts.label || '');
    var trailing = opts.trailingIcon ? ' <span aria-hidden="true">' + escapeHtml(opts.trailingIcon) + '</span>' : '';

    if (opts.href) {
      return '<a class="' + cls + '" href="' + resolveInternalHref(opts.href) + '"' + id + track + aria
        + externalAttrs(opts) + '>' + label + trailing + '</a>';
    }
    return '<button class="' + cls + '" type="button"' + id + track + aria + '>' + label + trailing + '</button>';
  }

  /* Primary conversion button — same as button({variant:'primary'}) with an arrow. */
  function ctaButton(options) {
    var opts = options || {};
    return button({
      label: opts.label,
      href: opts.href,
      id: opts.id,
      track: opts.track,
      ariaLabel: opts.ariaLabel,
      className: opts.className,
      theme: opts.theme,
      variant: opts.variant || 'primary',
      trailingIcon: opts.trailingIcon === undefined ? '→' : opts.trailingIcon
    });
  }

  /*
   * badge({ label, tone })
   * Emits the badge classes the current stylesheets already define, so no new
   * CSS is needed:
   *   'plan'    → .plan-badge            (hub.css pricing cards, e.g. "Popular")
   *   'eyebrow' → .feature-card__eyebrow (hub.css feature cards)
   *   'landing' → .eyebrow               (landing.css section kickers)
   */
  var BADGE_CLASSES = {
    plan: 'plan-badge',
    eyebrow: 'feature-card__eyebrow',
    landing: 'eyebrow'
  };

  function badge(options) {
    var opts = options || {};
    var cls = BADGE_CLASSES[opts.tone] || BADGE_CLASSES.plan;
    return '<span class="' + cls + '">' + escapeHtml(opts.label || '') + '</span>';
  }

  /* ------------------------------------------------------------- cards ---- */

  /*
   * featureCard({ index, icon, title, copy, href, linkLabel, track, iconClass })
   * The homepage capability card shape (index.html "01 / CAPABILITIES").
   * Phase 2 will render the homepage capability grid through this factory once
   * the provider names from the hub #features section are merged in.
   */
  function featureCard(options) {
    var opts = options || {};
    var num = opts.index ? '<span class="card-num">' + escapeHtml(opts.index) + '</span>' : '';
    var icon = opts.icon
      ? '<div class="cap-icon ' + escapeHtml(opts.iconClass || '') + '" aria-hidden="true">' + escapeHtml(opts.icon) + '</div>'
      : '';
    var link = opts.href
      ? '<a href="' + resolveInternalHref(opts.href) + '"' + (opts.track ? ' data-track="' + escapeHtml(opts.track) + '"' : '') + '>'
        + escapeHtml(opts.linkLabel || 'Open') + ' <span>→</span></a>'
      : '';
    return '<article class="capability-card' + (opts.reveal === false ? '' : ' reveal') + '" data-tx-component="feature-card">'
      + num + icon
      + '<h3>' + escapeHtml(opts.title || '') + '</h3>'
      + '<p>' + escapeHtml(opts.copy || '') + '</p>'
      + link
      + '</article>';
  }

  /*
   * providerCard({ eyebrow, title, copy, points, href, linkLabel, icon, id })
   * The hub #features card shape (hub.css .feature-card), repeated six times in
   * hub.html today. Phase 2 merges provider names from those cards into the
   * homepage capabilities — this factory is where that markup is defined once.
   * `icon` is raw inline SVG (trusted, author-supplied), everything else is escaped.
   */
  function providerCard(options) {
    var opts = options || {};
    var icon = opts.icon ? '<div class="feature-card__icon" aria-hidden="true">' + opts.icon + '</div>' : '';
    var eyebrow = opts.eyebrow ? badge({ label: opts.eyebrow, tone: 'eyebrow' }) : '';
    var points = (opts.points || []).map(function (p) {
      return '<span>' + escapeHtml(p) + '</span>';
    }).join('');
    var link = opts.href
      ? '<a href="' + resolveInternalHref(opts.href) + '" class="feature-link"'
        + (opts.id ? ' id="' + escapeHtml(opts.id) + '"' : '')
        + (opts.track ? ' data-track="' + escapeHtml(opts.track) + '"' : '') + '>'
        + escapeHtml(opts.linkLabel || 'Open panel') + '</a>'
      : '';
    return '<article class="feature-card" data-tx-component="provider-card">'
      + icon + eyebrow
      + '<h3>' + escapeHtml(opts.title || '') + '</h3>'
      + (opts.copy ? '<p>' + escapeHtml(opts.copy) + '</p>' : '')
      + (points ? '<div class="feature-points">' + points + '</div>' : '')
      + link
      + '</article>';
  }

  /*
   * pricingPreview({ heading, copy, ctaLabel, ctaHref, bullets, theme })
   * The homepage "Create when you need to" block. Numbers are intentionally NOT
   * baked in here: Phase 2 feeds them from GET /api/billing/plans so the price
   * triplication (credits.js constants / hub.html markup / backend) collapses to
   * one source. Until then callers pass copy through.
   */
  function pricingPreview(options) {
    var opts = options || {};
    var bullets = (opts.bullets || []).map(function (b) {
      return '<li><span>' + escapeHtml(b.label) + '</span><small>' + escapeHtml(b.copy || '') + '</small></li>';
    }).join('');
    var cta = ctaButton({
      label: opts.ctaLabel || 'View Pricing',
      href: opts.ctaHref || (window.TIMRX_NAV && window.TIMRX_NAV.PRICING_HREF) || '/hub#pricing',
      track: opts.track || 'pricing_view',
      theme: opts.theme || 'landing'
    });
    return '<div class="shell pricing-card reveal" data-tx-component="pricing-preview">'
      + '<div class="pricing-main">'
      + '<span class="section-index">' + escapeHtml(opts.kicker || 'FLEXIBLE CREDITS') + '</span>'
      + '<h2>' + escapeHtml(opts.heading || '') + '</h2>'
      + '<p>' + escapeHtml(opts.copy || '') + '</p>'
      + cta
      + '</div>'
      + (bullets
        ? '<div class="pricing-uses"><span class="pricing-uses-cap">' + escapeHtml(opts.bulletsCap || 'One balance, every tool')
          + '</span><ul aria-label="What credits unlock">' + bullets + '</ul></div>'
        : '')
      + '</div>';
  }

  /* -------------------------------------------------- nav / footer regions */

  /*
   * navBar({ page, theme, commerce })
   * Renders the primary navigation from window.TIMRX_NAV.primary.
   * `commerce: true` includes the auth/credits/buy block (shell theme only).
   * `buyAsButton: true` renders #buyCreditsBtn as a <button> (the /hub case,
   * where credits.js opens the buy modal); otherwise it links to /hub#pricing.
   */
  function navBar(options) {
    var opts = options || {};
    var model = window.TIMRX_NAV || {};
    var items = model.primary || [];
    var activeKey = model.activeKeyForPage ? model.activeKeyForPage(opts.page) : '';
    var theme = opts.theme === 'landing' ? 'landing' : 'shell';

    var links = items.map(function (item) {
      return navLink(item, { active: item.key === activeKey, theme: theme });
    }).join('');

    var commerce = '';
    if (opts.commerce) {
      var buyControl = opts.buyAsButton
        ? '<button class="site-shell-buy-btn" id="buyCreditsBtn" type="button">Buy</button>'
        : '<a class="site-shell-buy-btn" href="' + resolveInternalHref(model.PRICING_HREF || '/hub#pricing') + '">Buy</a>';

      commerce = ''
        + '<div class="site-shell-utility">'
        + '  <button type="button" class="site-shell-subscription-pill hidden" id="subscriptionStatusPill" aria-label="Manage subscription">'
        + '    <i class="fa-solid fa-rotate subscription-icon" id="subscriptionIcon"></i>'
        + '    <span class="subscription-text" id="subscriptionText"></span>'
        + '  </button>'
        + '  <div class="site-shell-credits-group" id="creditsGroup">'
        + '    <button type="button" class="site-shell-account-btn" id="accountStatusBtn" data-status="anonymous" data-tooltip="Sign In" aria-label="Sign In">'
        + '      <i class="fa-solid fa-user"></i>'
        + '    </button>'
        + '    <span class="site-shell-credits-pill" id="creditsPill">'
        + '      <i class="fa-solid fa-coins"></i>'
        + '      <span class="site-shell-credits-value" id="creditsValue">0</span>'
        + '      <span class="site-shell-credits-tooltip" id="creditsHoverPanel">'
        + '        <span class="site-shell-credits-tooltip-row">'
        + '          <i class="fa-solid fa-coins"></i><span>General</span>'
        + '          <span class="site-shell-credits-tooltip-val" id="hoverGeneralValue">0</span>'
        + '        </span>'
        + '        <span class="site-shell-credits-tooltip-row">'
        + '          <i class="fa-solid fa-film"></i><span>Video</span>'
        + '          <span class="site-shell-credits-tooltip-val" id="hoverVideoValue">0</span>'
        + '        </span>'
        + '      </span>'
        + '    </span>'
        + '    ' + buyControl
        + '  </div>'
        + '</div>';
    }

    return ''
      + '<nav class="site-shell-nav" aria-label="Primary">'
      + '  <div class="site-shell-container site-shell-nav-inner">'
      + '    <div class="site-shell-nav-left">' + brand({ theme: 'shell', size: 42 }) + '</div>'
      + '    <div class="site-shell-nav-links">' + links + '</div>'
      + '    <div class="site-shell-nav-right">'
      + commerce
      + '      <button class="site-shell-burger" type="button" aria-label="Open menu" aria-expanded="false" data-site-shell-burger>'
      + '        <span></span><span></span><span></span>'
      + '      </button>'
      + '    </div>'
      + '  </div>'
      + '</nav>';
  }

  function mobileMenu(options) {
    var opts = options || {};
    var model = window.TIMRX_NAV || {};
    var items = model.primary || [];
    var activeKey = model.activeKeyForPage ? model.activeKeyForPage(opts.page) : '';

    var links = items.map(function (item) {
      return mobileNavLink(item, { active: item.key === activeKey, theme: 'shell' });
    }).join('');

    return ''
      + '<div class="site-shell-mobile-menu" aria-hidden="true" data-site-shell-menu>'
      + '  <div class="site-shell-mobile-panel">'
      + '    <nav class="site-shell-mobile-nav" aria-label="Mobile navigation">' + links + '</nav>'
      + '    <div class="site-shell-mobile-footer">'
      + '      <span class="site-shell-mobile-footer-text">TimrX creative platform</span>'
      + '    </div>'
      + '  </div>'
      + '</div>';
  }

  function footer() {
    var model = window.TIMRX_NAV || {};
    var brandModel = model.brand || {};
    var columns = model.footerColumns || [];

    var cols = columns.map(function (column) {
      var links = (column.links || []).map(function (item) {
        var href = item.external ? item.href : resolveInternalHref(item.href);
        return '<li><a href="' + href + '"' + externalAttrs(item) + '>' + escapeHtml(item.label) + '</a></li>';
      }).join('');
      return '<div><h3 class="site-shell-footer-heading">' + escapeHtml(column.heading) + '</h3>'
        + '<ul class="site-shell-footer-links">' + links + '</ul></div>';
    }).join('');

    return ''
      + '<footer class="site-shell-footer">'
      + '  <div class="site-shell-container site-shell-footer-inner">'
      + '    <div class="site-shell-footer-main">'
      + '      <div class="site-shell-footer-brand">'
      + '        <a href="' + resolveInternalHref(brandModel.href || '/') + '" class="site-shell-footer-mark" aria-label="TimrX home">'
      + '          <img src="' + resolveAssetHref(brandModel.logo || 'img/logo.png') + '" alt="TimrX" width="32" height="32">'
      + '          <span class="site-shell-footer-name">' + escapeHtml(brandModel.name || 'TimrX') + '</span>'
      + '        </a>'
      + '        <span class="site-shell-footer-tag">' + escapeHtml(brandModel.tagline || '') + '</span>'
      + '        <p class="site-shell-footer-desc">' + escapeHtml(brandModel.description || '') + '</p>'
      + '      </div>'
      + '      <div class="site-shell-footer-cols">' + cols + '</div>'
      + '    </div>'
      + '    <div class="site-shell-footer-bottom">'
      + '      <span>&copy; <span data-site-shell-year></span> TimrX</span>'
      + '      <a href="' + resolveInternalHref('/dima-vasiliu') + '">Built by Dima Vasiliu</a>'
      + '    </div>'
      + '  </div>'
      + '</footer>';
  }

  /*
   * contextNav(links)
   * In-page section nav (currently the /hub subnav). The anchors it points at
   * are hub marketing sections that later phases will retire — see the
   * MIGRATION ZONE comments in hub.html.
   */
  function contextNav(links, label) {
    var items = (links || []).map(function (item) {
      return '<a href="' + escapeHtml(item.href) + '" class="site-shell-context-link">' + escapeHtml(item.label) + '</a>';
    }).join('');
    return ''
      + '<div class="site-shell-context-nav" aria-label="' + escapeHtml(label || 'Page sections') + '">'
      + '  <div class="site-shell-container site-shell-context-nav-inner">' + items + '</div>'
      + '</div>';
  }

  window.TIMRX_UI = {
    isLocalHtmlPreview: isLocalHtmlPreview,
    escapeHtml: escapeHtml,
    resolveAssetHref: resolveAssetHref,
    resolveInternalHref: resolveInternalHref,
    rewriteKnownInternalLinks: rewriteKnownInternalLinks,
    brand: brand,
    navLink: navLink,
    mobileNavLink: mobileNavLink,
    button: button,
    ctaButton: ctaButton,
    badge: badge,
    featureCard: featureCard,
    providerCard: providerCard,
    pricingPreview: pricingPreview,
    navBar: navBar,
    mobileMenu: mobileMenu,
    footer: footer,
    contextNav: contextNav
  };
})();
