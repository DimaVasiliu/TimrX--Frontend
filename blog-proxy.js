import { findSeoPage, generateSeoSitemap } from './seo-pages.js';
import { renderSeoPage } from './seo-template.js';

/**
 * TimrX Blog Proxy Worker
 *
 * This Cloudflare Worker proxies blog-related routes from timrx.live to the backend at blog.timrx.live.
 * It also handles /read redirects at the edge for SEO purposes.
 *
 * NOTE: /blogs is served STATICALLY by Cloudflare Pages (blogs.html) - NOT proxied here.
 *
 * PROXIED ROUTES:
 * - /blog/<slug>           → Individual blog posts (SSR)
 * - /blog/tag/<tag>        → Tag hub pages (SSR)
 * - /blog/category/<cat>   → Category hub pages (SSR)
 * - /tools                 → Tools I Use page (SSR)
 * - /rss.xml               → RSS feed
 * - /sitemap-blogs.xml     → Blog sitemap (proxied from /sitemap.xml)
 * - /robots.txt            → Dynamic robots.txt from backend
 * - /sitemap.xml           → Sitemap index from backend
 * - /sitemap-pages.xml     → Pages sitemap from backend
 * - /sitemap-recent.xml    → Recent posts sitemap from backend
 * - /api/*                 → API endpoints (no caching)
 *
 * EDGE REDIRECTS:
 * - /read?slug=<slug>      → 301 to /blog/<slug>
 * - /blog or /blog/        → 301 to /blogs
 *
 * WORKER ROUTES (add all of these in Cloudflare dashboard):
 *    - timrx.live/blog
 *    - timrx.live/blog/*
 *    - timrx.live/read*
 *    - timrx.live/tools*
 *    - timrx.live/rss.xml
 *    - timrx.live/sitemap-blogs.xml
 *    - timrx.live/sitemap.xml
 *    - timrx.live/sitemap-pages.xml
 *    - timrx.live/sitemap-recent.xml
 *    - timrx.live/robots.txt
 *    - timrx.live/api/*
 *    (DO NOT add timrx.live/blogs* — Pages _worker.js serves it)
 */

const BLOG_ORIGIN = 'https://blog.timrx.live';
const PUBLIC_DOMAIN = 'https://timrx.live';

// Public robots.txt served at the edge (no backend round-trip)
const ROBOTS_TXT = `# TimrX robots.txt
# https://timrx.live

User-agent: *
Allow: /

# Block admin & private areas
Disallow: /admin
Disallow: /admin-edit
Disallow: /write
Disallow: /api/
Disallow: /3dprint
Disallow: /converter
Disallow: /prompts

# Sitemap index
Sitemap: https://timrx.live/sitemap.xml
`;

// ─────────────────────────────────────────────────────────────
// 301 Redirect map for old/broken URLs reported by GSC
// Add entries as: '/old-path': '/new-path'
// ─────────────────────────────────────────────────────────────
const PERMANENT_REDIRECTS = {
  // TODO: Export actual 404 URLs from GSC → Indexing → Pages → "Not found (404)"
  // and fill in the correct mappings. Examples:
  // '/old-blog-slug': '/blog/correct-slug',
  // '/deleted-page': '/blogs',
  // '/typo-url': '/',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ─────────────────────────────────────────────────────────────
    // 0. Handle permanent redirects for old/broken URLs (GSC 404 fixes)
    // ─────────────────────────────────────────────────────────────
    const permanentRedirect = PERMANENT_REDIRECTS[pathname] || PERMANENT_REDIRECTS[pathname.replace(/\/$/, '')];
    if (permanentRedirect) {
      return Response.redirect(`${PUBLIC_DOMAIN}${permanentRedirect}`, 301);
    }

    // ─────────────────────────────────────────────────────────────
    // 0b. Serve programmatic SEO pages (/3d-models/:slug, /text-to-3d/:slug)
    // ─────────────────────────────────────────────────────────────
    const seoPage = findSeoPage(pathname);
    if (seoPage) {
      const html = renderSeoPage(seoPage);
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 0c. Serve dynamic sitemap for SEO pages
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/sitemap-seo.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${generateSeoSitemap()}
</urlset>`;
      return new Response(xml, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 1. Handle /read redirect at the edge (SEO: push to /blog/<slug>)
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/read' || pathname === '/read/') {
      const slug = url.searchParams.get('slug');
      if (slug) {
        // 301 Permanent redirect to the canonical SEO URL
        return Response.redirect(`${PUBLIC_DOMAIN}/blog/${encodeURIComponent(slug)}`, 301);
      } else {
        // No slug - 302 redirect to blog listing
        return Response.redirect(`${PUBLIC_DOMAIN}/blogs`, 302);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 2. Handle /blog (no slug) - redirect to /blogs
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/blog' || pathname === '/blog/') {
      return Response.redirect(`${PUBLIC_DOMAIN}/blogs`, 301);
    }

    // ─────────────────────────────────────────────────────────────
    // 3. Proxy /blog/* to backend SSR
    //    Includes: /blog/<slug>, /blog/tag/<tag>, /blog/category/<cat>
    // ─────────────────────────────────────────────────────────────
    if (pathname.startsWith('/blog/')) {
      const backendUrl = `${BLOG_ORIGIN}${pathname}`;
      return proxyToBackend(request, backendUrl);
    }

    // ─────────────────────────────────────────────────────────────
    // 4. /blogs is served by Cloudflare Pages (static blogs.html)
    //    DO NOT proxy - let it fall through to fetch(request)
    // ─────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────
    // 5. Proxy /tools to backend (Tools I Use page)
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/tools' || pathname === '/tools/') {
      return proxyToBackend(request, `${BLOG_ORIGIN}/tools`);
    }

    // ─────────────────────────────────────────────────────────────
    // 6. Proxy /rss.xml to backend
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/rss.xml') {
      return proxyToBackend(request, `${BLOG_ORIGIN}/rss.xml`);
    }

    // ─────────────────────────────────────────────────────────────
    // 6. Proxy /sitemap-blogs.xml to backend's /sitemap-blogs.xml
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/sitemap-blogs.xml') {
      return proxyToBackend(request, `${BLOG_ORIGIN}/sitemap-blogs.xml`);
    }

    // ─────────────────────────────────────────────────────────────
    // 7. Serve robots.txt directly at the edge (no backend proxy)
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/robots.txt') {
      return new Response(ROBOTS_TXT, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 8. Proxy dynamic SEO files to backend
    //    (sitemap index, page/recent sitemaps)
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/sitemap-pages.xml' ||
        pathname === '/sitemap-recent.xml') {
      return proxyToBackend(request, `${BLOG_ORIGIN}${pathname}`);
    }

    // Sitemap index: proxy from backend then inject sitemap-seo.xml
    if (pathname === '/sitemap.xml') {
      const backendResponse = await proxyToBackend(request, `${BLOG_ORIGIN}/sitemap.xml`);
      const xml = await backendResponse.text();
      const injected = xml.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>https://timrx.live/sitemap-seo.xml</loc>\n    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>\n  </sitemap>\n</sitemapindex>`
      );
      return new Response(injected, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 9. Proxy /api/* to backend (for engagement, comments, etc.)
    //    IMPORTANT: No caching for API responses to ensure fresh data
    // ─────────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      // Resolve CORS origin against allowlist (no wildcard)
      const ALLOWED_ORIGINS = ['https://timrx.live', 'https://www.timrx.live', 'https://3d.timrx.live'];
      const requestOrigin = request.headers.get('Origin') || '';
      const corsOrigin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];

      // Handle CORS preflight at the edge (fast, no backend round-trip)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
            'Access-Control-Max-Age': '600',
            'Vary': 'Origin',
          },
        });
      }
      const backendUrl = `${BLOG_ORIGIN}${pathname}${url.search}`;
      return proxyToBackend(request, backendUrl, { noCache: true, corsOrigin });
    }

    // ─────────────────────────────────────────────────────────────
    // Default: Pass through to Cloudflare Pages (static assets)
    // ─────────────────────────────────────────────────────────────
    return fetch(request);
  }
};

/**
 * Proxy request to backend origin
 * @param {Request} request - Original request
 * @param {string} backendUrl - Backend URL to proxy to
 * @param {Object} options - Options { noCache: boolean }
 */
async function proxyToBackend(request, backendUrl, options = {}) {
  // Clone headers - don't override Host (Cloudflare sets it correctly)
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', 'https');

  // Create new request to backend
  const backendRequest = new Request(backendUrl, {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'manual', // Don't follow redirects, pass them through
  });

  // Fetch options - disable Cloudflare caching for API routes
  const fetchOptions = options.noCache
    ? { cf: { cacheTtl: 0, cacheEverything: false } }
    : {};

  try {
    const response = await fetch(backendRequest, fetchOptions);

    // Clone response and modify headers if needed
    const newHeaders = new Headers(response.headers);

    // Ensure CORS headers for API requests (use allowlisted origin, not wildcard)
    if (request.url.includes('/api/')) {
      const origin = options.corsOrigin || 'https://timrx.live';
      newHeaders.set('Access-Control-Allow-Origin', origin);
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
      newHeaders.set('Vary', 'Origin');
    }

    // Set no-cache headers for API responses to prevent stale data
    if (options.noCache) {
      newHeaders.set('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
      newHeaders.set('CDN-Cache-Control', 'no-store');
      newHeaders.set('Pragma', 'no-cache');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response('Backend unavailable', { status: 502 });
  }
}
