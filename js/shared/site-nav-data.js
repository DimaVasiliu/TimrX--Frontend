/*
 * site-nav-data.js — canonical navigation + footer model for the whole site.
 *
 * PHASE 1 (Homepage & Hub foundation): this file is the single source of truth
 * for primary navigation, footer columns and internal route resolution.
 * Anything that renders a TimrX nav or footer should read from here instead of
 * hard-coding link lists.
 *
 * Consumers today:
 *   - js/site-shell.js  → shell pages (/hub, /community, /docs, /tutorials,
 *                          /prompts, /company, /converter, /stl-library,
 *                          /converters/avi-to-mp4)
 * Consumers planned (Phase 2):
 *   - index.html static header/footer (currently mirrors this model by hand —
 *     keep the two in sync until the landing shell is migrated)
 *   - the 25 legacy `.nav divider` tool pages
 *
 * ROUTE RULES (do not change without checking the migration audit):
 *   - /hub keeps its URL forever. The backend builds Mollie return URLs against
 *     it (mollie_service.py, billing.py) and DB notification rows deep-link to
 *     /hub#pricing and /hub#secure-credits. Only the *label* is "Dashboard".
 *   - /hub#pricing stays the in-product purchase surface. Public pricing may be
 *     retargeted to /pricing in a later phase — see PRICING_HREF below.
 *
 * Loaded as a classic script (no modules) so it works on every page, including
 * the ones that still load their JS with `defer` in document order.
 */
(function () {
  'use strict';

  /*
   * Public pricing destination.
   * Phase 1 keeps this on /hub#pricing so every pricing journey behaves exactly
   * as it does today. /pricing (pricing.html) already exists and is public; the
   * Phase 2 decision is whether marketing nav should point there instead.
   * In-product money links (workspace, backend JSON, notifications) must keep
   * using /hub#pricing regardless.
   */
  var PRICING_HREF = '/hub#pricing';

  /*
   * Route table used to resolve internal links.
   * `preview` is used when the site is opened as local .html files, `live` is
   * the deployed clean URL. `hash` is appended when the incoming href has none.
   */
  var routes = {
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
    '/dima-vasiliu': { preview: 'dima-vasiliu.html', live: '/dima-vasiliu' },
    '/terms': { preview: 'terms.html', live: '/terms' },
    '/privacy': { preview: 'privacy.html', live: '/privacy' },
    '/cookies': { preview: 'cookies.html', live: '/cookies' },
    '/blogs': { preview: 'blogs.html', live: '/blogs' },
    '/ai-tools': { preview: 'ai-tools.html', live: '/ai-tools' },
    '/ai-image-generator': { preview: 'ai-image-generator.html', live: '/ai-image-generator' },
    '/ai-video-generator': { preview: 'ai-video-generator.html', live: '/ai-video-generator' },
    '/ai-3d-generator': { preview: 'ai-3d-generator.html', live: '/ai-3d-generator' },
    '/text-to-3d': { preview: 'text-to-3d.html', live: '/text-to-3d' },
    '/image-to-3d': { preview: 'image-to-3d.html', live: '/image-to-3d' },
    '/3d-print-model-generator': { preview: '3d-print-model-generator.html', live: '/3d-print-model-generator' },
    '/3dprint-demo-video': { preview: '3dprint-demo-video.html', live: '/3dprint-demo-video' },
    /*
     * Kept from the previous shell implementation: /pricing currently resolves
     * to the hub pricing section so no existing link changes destination in
     * Phase 1. pricing.html exists and is live — flip this to
     * { preview: 'pricing.html', live: '/pricing' } when Phase 2 promotes it.
     */
    '/pricing': { preview: 'hub.html', live: '/hub', hash: '#pricing' }
  };

  /*
   * Primary navigation — the canonical order and labels.
   * `pages` lists the `data-shell-page` values that should mark the item active.
   * `accent` renders the item as the primary CTA.
   * `track` is the analytics event name; keep existing names so GA4 funnels stay
   * continuous (nav_open_workspace predates this refactor).
   */
  var primary = [
    { key: 'home', href: '/', label: 'Home', sub: 'Product overview and free trial', pages: ['home', 'index'] },
    { key: 'create', href: '/3dprint', label: 'Create', sub: 'Open the TimrX workspace', pages: ['3dprint', 'workspace'], accent: true, track: 'nav_open_workspace' },
    { key: 'community', href: '/community', label: 'Community', sub: 'Showcase, creators and discovery', pages: ['community'] },
    { key: 'tutorials', href: '/tutorials', label: 'Tutorials', sub: 'Guides, flows and walkthroughs', pages: ['tutorials'] },
    { key: 'docs', href: '/docs', label: 'Docs', sub: 'Reference, support and how-tos', pages: ['docs'] },
    { key: 'pricing', href: PRICING_HREF, label: 'Pricing', sub: 'Credits, packs and subscriptions', pages: ['pricing'], track: 'nav_pricing' },
    { key: 'blog', href: '/blogs', label: 'Blog', sub: 'Guides, updates and product notes', pages: ['blogs', 'blog'] },
    /* Route stays /hub — only the visible label is "Dashboard". */
    { key: 'dashboard', href: '/hub', label: 'Dashboard', sub: 'Account, credits and billing', pages: ['hub'] }
  ];

  /*
   * Footer columns. /prompts, /stl-library and /converter left the primary nav
   * in the Phase 1 redesign, so they are kept here to preserve internal linking.
   */
  var footerColumns = [
    {
      heading: 'Explore',
      links: [
        { href: '/blogs', label: 'Blog' },
        { href: '/tutorials', label: 'Tutorials' },
        { href: '/prompts', label: 'Prompts' },
        { href: '/stl-library', label: 'STL Library' },
        { href: '/converter', label: 'Converter' },
        { href: '/company', label: 'Company' },
        { href: '/dima-vasiliu', label: 'Founder' }
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
      heading: 'Account',
      links: [
        { href: '/hub', label: 'Dashboard' },
        { href: PRICING_HREF, label: 'Pricing' },
        { href: '/docs', label: 'Docs' }
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
        { href: 'https://www.linkedin.com/in/dumitru-vasiliu', label: 'LinkedIn', external: true },
        { href: 'https://github.com/DimaVasiliu', label: 'GitHub', external: true }
      ]
    }
  ];

  var brand = {
    href: '/',
    logo: 'img/logo.png',
    name: 'TimrX',
    wordmarkLead: 'Timr',
    wordmarkAccent: 'X',
    tagline: 'AI Creative Platform',
    description: 'TimrX is a creative AI platform for 3D models, image generation, video workflows and production-ready exports.'
  };

  window.TIMRX_NAV = {
    PRICING_HREF: PRICING_HREF,
    routes: routes,
    primary: primary,
    footerColumns: footerColumns,
    brand: brand,
    /* Resolve the active nav key for a `data-shell-page` value. */
    activeKeyForPage: function (page) {
      if (!page) return '';
      for (var i = 0; i < primary.length; i += 1) {
        var item = primary[i];
        if (item.key === page) return item.key;
        if (item.pages && item.pages.indexOf(page) !== -1) return item.key;
      }
      return '';
    }
  };
})();
