/**
 * TimrX — Cloudflare Pages Advanced Mode Worker
 *
 * Serves clean URLs (/hub, /archive, etc.) by fetching .html assets directly
 * via env.ASSETS.fetch(), which bypasses V3's automatic .html → 308 stripping
 * that causes infinite redirect loops with _redirects 200 rewrites.
 *
 * Blog/API routes (/blog/*, /api/*, /read*, /tools*, /rss.xml, /sitemap*.xml,
 * /robots.txt) are handled by the standalone blog-proxy Worker (zone-level
 * routes in the Cloudflare dashboard). They never reach this _worker.js.
 *
 * NOTE: When _worker.js exists, Pages runs in Advanced Mode and _redirects
 *       / _headers files are IGNORED. All routing lives here.
 */

// ── Clean URL → .html asset mapping ──────────────────────────────
const PAGES = {
  '/':           '/index.html',
  '/archive':    '/archive.html',
  '/about':      '/about.html',
  '/hub':        '/hub.html',
  '/3dprint':    '/3dprint.html',
  '/blogs':      '/blogs.html',
  '/write':      '/write.html',
  '/terms':      '/terms.html',
  '/cookies':    '/cookies.html',
  '/privacy':    '/privacy.html',
  '/admin':      '/admin/admin.html',
  '/admin/edit': '/admin/admin-edit.html',
};

// ── .html → clean URL canonical redirects (301) ─────────────────
const HTML_TO_CLEAN = {
  '/index.html':      '/',
  '/archive.html':    '/archive',
  '/about.html':      '/about',
  '/hub.html':        '/hub',
  '/3dprint.html':    '/3dprint',
  '/blogs.html':      '/blogs',
  '/write.html':      '/write',
  '/terms.html':      '/terms',
  '/cookies.html':    '/cookies',
  '/privacy.html':    '/privacy',
  '/admin.html':      '/admin',
  '/admin-edit.html': '/admin/edit',
};

// ── Trailing-slash → no-slash redirects (301) ───────────────────
const TRAILING_SLASH = {
  '/archive/':    '/archive',
  '/about/':      '/about',
  '/hub/':        '/hub',
  '/3dprint/':    '/3dprint',
  '/blogs/':      '/blogs',
  '/write/':      '/write',
  '/terms/':      '/terms',
  '/cookies/':    '/cookies',
  '/privacy/':    '/privacy',
  '/admin/edit/': '/admin/edit',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Canonical: /page.html → /page (301)
    const cleanTarget = HTML_TO_CLEAN[path];
    if (cleanTarget) {
      return Response.redirect(`${url.origin}${cleanTarget}`, 301);
    }

    // 2. Trailing-slash normalization: /page/ → /page (301)
    const slashTarget = TRAILING_SLASH[path];
    if (slashTarget) {
      return Response.redirect(`${url.origin}${slashTarget}`, 301);
    }

    // 3. Clean URL → serve .html asset directly (bypasses V3 308)
    const htmlFile = PAGES[path];
    if (htmlFile) {
      const assetUrl = new URL(htmlFile, request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // 4. Everything else: static assets (CSS, JS, images, fonts, etc.)
    return env.ASSETS.fetch(request);
  },
};
