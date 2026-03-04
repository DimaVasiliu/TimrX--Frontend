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
 * - /api/*                 → API endpoints (no caching)
 *
 * EDGE REDIRECTS:
 * - /read?slug=<slug>      → 301 to /blog/<slug>
 * - /blog or /blog/        → 301 to /blogs
 *
 * DEPLOYMENT:
 * 1. Go to Cloudflare Dashboard → Workers & Pages → Create Worker
 * 2. Name it "timrx-blog-proxy" (or your preferred name)
 * 3. Paste this code
 * 4. Add routes in the Workers Routes section:
 *    - timrx.live/blog
 *    - timrx.live/blog/*
 *    - timrx.live/read*
 *    - timrx.live/rss.xml
 *    - timrx.live/sitemap-blogs.xml
 *    - timrx.live/api/*
 *    (DO NOT add timrx.live/blogs* - let Pages serve it statically)
 */

const BLOG_ORIGIN = 'https://blog.timrx.live';
const PUBLIC_DOMAIN = 'https://timrx.live';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

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
    // 6. Proxy /sitemap-blogs.xml to backend's /sitemap.xml
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/sitemap-blogs.xml') {
      return proxyToBackend(request, `${BLOG_ORIGIN}/sitemap.xml`);
    }

    // ─────────────────────────────────────────────────────────────
    // 7. Proxy /api/* to backend (for engagement, comments, etc.)
    //    IMPORTANT: No caching for API responses to ensure fresh data
    // ─────────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      // Handle CORS preflight at the edge (fast, no backend round-trip)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*, Content-Type, X-Admin-Token',
            'Access-Control-Max-Age': '600',
          },
        });
      }
      const backendUrl = `${BLOG_ORIGIN}${pathname}${url.search}`;
      return proxyToBackend(request, backendUrl, { noCache: true });
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

    // Ensure CORS headers for API requests
    if (request.url.includes('/api/')) {
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', '*, Content-Type, X-Admin-Token');
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
