(function () {
  'use strict';

  const body = document.body;
  if (!body) return;
  const pathname = window.location.pathname || '';
  const isLocalHtmlPreview = /\.html?$/i.test(pathname);
  const currentDir = pathname.replace(/[^/]*$/, '');
  const routeDefinitions = {
    '/': { preview: 'index.html', live: '/' },
    '/hub': { preview: 'hub.html', live: '/hub' },
    '/tutorials': { preview: 'tutorials.html', live: '/tutorials' },
    '/community': { preview: 'community.html', live: '/community' },
    '/prompts': { preview: 'prompts.html', live: '/prompts' },
    '/docs': { preview: 'docs.html', live: '/docs' },
    '/3dprint': { preview: '3dprint.html', live: '/3dprint' },
    '/converter': { preview: 'converter.html', live: '/converter' },
    '/avi-to-mp4': { preview: 'avi-to-mp4.html', live: '/avi-to-mp4' },
    '/stl-library': { preview: 'stl-library.html', live: '/stl-library' },
    '/company': { preview: 'company.html', live: '/company' },
    '/about': { preview: 'about.html', live: '/about' },
    '/terms': { preview: 'terms.html', live: '/terms' },
    '/privacy': { preview: 'privacy.html', live: '/privacy' },
    '/cookies': { preview: 'cookies.html', live: '/cookies' },
    '/blogs': { preview: 'blogs.html', live: '/blogs' },
    '/ai-image-generator': { preview: 'ai-image-generator.html', live: '/ai-image-generator' },
    '/ai-video-generator': { preview: 'ai-video-generator.html', live: '/ai-video-generator' },
    '/ai-3d-generator': { preview: 'ai-3d-generator.html', live: '/ai-3d-generator' },
    '/text-to-3d': { preview: 'text-to-3d.html', live: '/text-to-3d' },
    '/image-to-3d': { preview: 'image-to-3d.html', live: '/image-to-3d' },
    '/3d-print-model-generator': { preview: '3d-print-model-generator.html', live: '/3d-print-model-generator' },
    '/3dprint-demo-video': { preview: '3dprint-demo-video.html', live: '/3dprint-demo-video' },
    '/pricing': { preview: 'hub.html', live: '/hub', hash: '#pricing' }
  };

  const page = body.dataset.shellPage || '';

  function resolveAssetHref(assetPath) {
    const normalized = String(assetPath || '').replace(/^\/+/, '');
    return isLocalHtmlPreview ? `${currentDir}${normalized}` : `/${normalized}`;
  }

  function resolveInternalHref(href) {
    if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) {
      return href;
    }

    const url = new URL(href, window.location.origin);
    const route = routeDefinitions[url.pathname];
    if (!route) return href;

    const basePath = isLocalHtmlPreview
      ? `${currentDir}${route.preview}`
      : route.live;
    const hash = url.hash || route.hash || '';
    return `${basePath}${url.search}${hash}`;
  }

  function rewriteKnownInternalLinks(root = document) {
    if (!isLocalHtmlPreview) return;

    root.querySelectorAll('a[href^="/"]').forEach((link) => {
      const originalHref = link.getAttribute('href');
      const resolvedHref = resolveInternalHref(originalHref);
      if (resolvedHref !== originalHref) {
        link.setAttribute('href', resolvedHref);
      }
    });
  }

  const navItems = [
    { key: 'hub', href: '/hub', label: 'Hub', sub: 'Overview and product entry point' },
    { key: 'tutorials', href: '/tutorials', label: 'Tutorials', sub: 'Guides, flows, and walkthroughs' },
    { key: 'community', href: '/community', label: 'Community', sub: 'Showcase, creators, and discovery' },
    { key: 'prompts', href: '/prompts', label: 'Prompts', sub: 'Reusable prompt library' },
    { key: 'docs', href: '/docs', label: 'Docs', sub: 'Reference, pricing, and support' },
    { key: 'stl-library', href: '/stl-library', label: 'STL Library', sub: 'Ready-to-print STL file packs' },
    { key: 'workspace', href: '/3dprint', label: 'Open Workspace', sub: 'Launch the TimrX app shell', accent: true }
  ];

  const footerColumns = [
    {
      heading: 'Explore',
      links: [
        { href: '/blogs', label: 'Blog' },
        { href: '/stl-library', label: 'STL Library' },
        { href: '/#works', label: 'Works' },
        { href: '/#services', label: 'Services' },
        { href: '/#contact', label: 'Contact' }
      ]
    },
    {
      heading: 'AI Tools',
      links: [
        { href: '/ai-image-generator', label: 'AI Image Generator' },
        { href: '/ai-video-generator', label: 'AI Video Generator' },
        { href: '/ai-3d-generator', label: 'AI 3D Generator' },
        { href: '/text-to-3d', label: 'Text to 3D' },
        { href: '/image-to-3d', label: 'Image to 3D' },
        { href: '/3d-print-model-generator', label: '3D Print Models' }
      ]
    },
    {
      heading: 'Legal',
      links: [
        { href: '/terms', label: 'Terms' },
        { href: '/privacy', label: 'Privacy' },
        { href: '/cookies', label: 'Cookies' }
      ]
    },
    {
      heading: 'Connect',
      links: [
        { href: '/rss.xml', label: 'RSS' },
        { href: 'mailto:admin@timrx.live', label: 'Email' },
        { href: 'https://www.youtube.com/@TimrX-Studio', label: 'YouTube', external: true },
        { href: 'https://www.linkedin.com/in/dumitru-vasiliu', label: 'LinkedIn', external: true },
        { href: 'https://github.com/DimaVasiliu', label: 'GitHub', external: true }
      ]
    }
  ];

  function linkAttrs(item) {
    return item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  }

  function renderNav() {
    const navMount = document.querySelector('[data-site-shell="nav"]');
    if (!navMount) return;

    const navLinks = navItems.map((item) => {
      const active = item.key === page;
      const classes = [
        'site-shell-nav-link',
        active ? 'is-active' : '',
        item.accent ? 'is-accent' : ''
      ].filter(Boolean).join(' ');
      const current = active ? ' aria-current="page"' : '';
      return `<a href="${resolveInternalHref(item.href)}" class="${classes}"${current}>${item.label}</a>`;
    }).join('');

    const mobileLinks = navItems.map((item) => {
      const active = item.key === page;
      const classes = ['site-shell-mobile-link', active ? 'is-active' : ''].filter(Boolean).join(' ');
      return `
        <a href="${resolveInternalHref(item.href)}" class="${classes}">
          <span class="site-shell-mobile-link-label">${item.label}</span>
          <span class="site-shell-mobile-link-sub">${item.sub}</span>
        </a>
      `;
    }).join('');

    const buyControl = page === 'hub'
      ? '<button class="site-shell-buy-btn" id="buyCreditsBtn" type="button">Buy</button>'
      : `<a class="site-shell-buy-btn" href="${resolveInternalHref('/hub#pricing')}">Buy</a>`;

    navMount.innerHTML = `
      <nav class="site-shell-nav" aria-label="Primary">
        <div class="site-shell-container site-shell-nav-inner">
          <div class="site-shell-nav-left">
            <a href="${resolveInternalHref('/hub')}" class="site-shell-brand" aria-label="TimrX Hub">
              <img src="${resolveAssetHref('img/logo.png')}" alt="TimrX" width="42" height="42">
              <span class="site-shell-brand-wordmark"><span>Timr</span><span class="site-shell-brand-x">X</span></span>
            </a>
          </div>

          <div class="site-shell-nav-links">${navLinks}</div>

          <div class="site-shell-nav-right">
            <div class="site-shell-utility">
              <button type="button" class="site-shell-subscription-pill hidden" id="subscriptionStatusPill" aria-label="Manage subscription">
                <i class="fa-solid fa-rotate subscription-icon" id="subscriptionIcon"></i>
                <span class="subscription-text" id="subscriptionText"></span>
              </button>
              <div class="site-shell-credits-group" id="creditsGroup">
                <button type="button" class="site-shell-account-btn" id="accountStatusBtn" data-status="anonymous" data-tooltip="Sign In" aria-label="Sign In">
                  <i class="fa-solid fa-user"></i>
                </button>
                <span class="site-shell-credits-pill" id="creditsPill">
                  <i class="fa-solid fa-coins"></i>
                  <span class="site-shell-credits-value" id="creditsValue">0</span>
                  <span class="site-shell-credits-tooltip" id="creditsHoverPanel">
                    <span class="site-shell-credits-tooltip-row">
                      <i class="fa-solid fa-coins"></i>
                      <span>General</span>
                      <span class="site-shell-credits-tooltip-val" id="hoverGeneralValue">0</span>
                    </span>
                    <span class="site-shell-credits-tooltip-row">
                      <i class="fa-solid fa-film"></i>
                      <span>Video</span>
                      <span class="site-shell-credits-tooltip-val" id="hoverVideoValue">0</span>
                    </span>
                  </span>
                </span>
                ${buyControl}
              </div>
            </div>
            <button class="site-shell-burger" type="button" aria-label="Open menu" aria-expanded="false" data-site-shell-burger>
              <span></span>
              <span></span>
              <span></span>
            </button>
          </div>
        </div>
      </nav>

      <div class="site-shell-mobile-menu" aria-hidden="true" data-site-shell-menu>
        <div class="site-shell-mobile-panel">
          <nav class="site-shell-mobile-nav" aria-label="Mobile navigation">
            ${mobileLinks}
          </nav>
          <div class="site-shell-mobile-footer">
            <span class="site-shell-mobile-footer-text">TimrX / Dima Vasiliu</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderContextNav() {
    const mount = document.querySelector('[data-site-shell="subnav"]');
    if (!mount) return;

    mount.innerHTML = `
      <div class="site-shell-context-nav" aria-label="Hub sections">
        <div class="site-shell-container site-shell-context-nav-inner">
          <a href="#overview" class="site-shell-context-link">Overview</a>
          <a href="#features" class="site-shell-context-link">Features</a>
          <a href="#liveShowcase" class="site-shell-context-link">Showcase</a>
          <a href="#pricing" class="site-shell-context-link">Pricing</a>
          <a href="#community" class="site-shell-context-link">Resources</a>
        </div>
      </div>
    `;
  }

  function renderFooter() {
    const footerMount = document.querySelector('[data-site-shell="footer"]');
    if (!footerMount) return;

    const footerCols = footerColumns.map((column) => `
      <div>
        <h3 class="site-shell-footer-heading">${column.heading}</h3>
        <ul class="site-shell-footer-links">
          ${column.links.map((item) => `<li><a href="${item.external ? item.href : resolveInternalHref(item.href)}"${linkAttrs(item)}>${item.label}</a></li>`).join('')}
        </ul>
      </div>
    `).join('');

    footerMount.innerHTML = `
      <footer class="site-shell-footer">
        <div class="site-shell-container site-shell-footer-inner">
          <div class="site-shell-footer-main">
            <div class="site-shell-footer-brand">
              <a href="${resolveInternalHref('/hub')}" class="site-shell-footer-mark" aria-label="TimrX Hub">
                <img src="${resolveAssetHref('img/logo.png')}" alt="TimrX" width="32" height="32">
                <span class="site-shell-footer-name">TimrX</span>
              </a>
              <span class="site-shell-footer-tag">AI Creative Platform</span>
              <p class="site-shell-footer-desc">TimrX is a creative AI platform by Dima Vasiliu for 3D models, AI image generation, and video workflows built for the web.</p>
            </div>
            <div class="site-shell-footer-cols">${footerCols}</div>
          </div>
          <div class="site-shell-footer-bottom">
            <span>&copy; <span data-site-shell-year></span> TimrX / Dima Vasiliu</span>
            <span>Built in London &middot; AI creative tools</span>
          </div>
        </div>
      </footer>
    `;

    footerMount.querySelectorAll('[data-site-shell-year]').forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });
  }

  function initMobileMenu() {
    const burger = document.querySelector('[data-site-shell-burger]');
    const menu = document.querySelector('[data-site-shell-menu]');
    if (!burger || !menu) return;

    const closeMenu = () => {
      burger.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'Open menu');
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
      body.classList.remove('site-menu-open');
    };

    const openMenu = () => {
      burger.classList.add('is-open');
      burger.setAttribute('aria-expanded', 'true');
      burger.setAttribute('aria-label', 'Close menu');
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      body.classList.add('site-menu-open');
    };

    burger.addEventListener('click', () => {
      if (menu.classList.contains('is-open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    menu.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeMenu);
    });

    menu.addEventListener('click', (event) => {
      if (event.target === menu) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('is-open')) {
        closeMenu();
        burger.focus();
      }
    });

    window.addEventListener('resize', () => {
      // Keep in sync with the burger-swap media query in site-shell.css (1024px).
      if (window.innerWidth > 1024 && menu.classList.contains('is-open')) {
        closeMenu();
      }
    });
  }

  renderNav();
  renderContextNav();
  renderFooter();
  rewriteKnownInternalLinks();
  body.classList.add('has-site-shell');
  initMobileMenu();
})();
