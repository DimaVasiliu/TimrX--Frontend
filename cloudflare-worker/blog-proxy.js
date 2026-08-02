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
 * CANONICAL URL SCHEME: /blog/<slug> (path-based, SSR from backend, 200).
 * The legacy /read?slug=<slug> reader is retained only as a 301 alias → /blog/<slug>.
 *
 * PROXIED ROUTES:
 * - /blog/<slug>           → 200 SSR post from backend (canonical); 410 if deleted; 404 if missing
 * - /blog/tag/<tag>        → Tag hub pages (SSR, noindex)
 * - /blog/category/<cat>   → Category hub pages (SSR, noindex)
 * - /tools                 → Tools I Use page (SSR)
 * - /rss.xml               → RSS feed
 * - /sitemap-blogs.xml     → Blog sitemap (proxied from /sitemap.xml)
 * - /robots.txt            → Dynamic robots.txt from backend
 * - /sitemap.xml           → Sitemap index from backend
 * - /sitemap-recent.xml    → Recent posts sitemap from backend
 * - /api/*                 → API endpoints (no caching)
 *
 * EDGE REDIRECTS:
 * - /read?slug=<slug>      → 301 to canonical /blog/<slug> (legacy alias)
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
Allow: /3dprint
Allow: /hub
Allow: /converter
Allow: /avi-to-mp4
Allow: /converters/
Allow: /prompts
Allow: /blog
Allow: /read

# Block admin & private/write areas only
Disallow: /admin
Disallow: /admin-edit
Disallow: /write
Disallow: /api/

# NOTE: /3dprint, /converter, /avi-to-mp4, /converters, /prompts, /blog, /read are PUBLIC pages — do NOT disallow them

Sitemap: https://timrx.live/sitemap.xml
`;

// ─────────────────────────────────────────────────────────────
// 301 Redirect map for old/broken URLs reported by GSC
// Add entries as: '/old-path': '/new-path'
// ─────────────────────────────────────────────────────────────
const PERMANENT_REDIRECTS = {
  // Renamed/legacy /blog/<slug> paths → their live canonical /blog/<slug> (or /blogs
  // if there is no relevant alive post). Canonical is now /blog/<slug>, so targets
  // point straight at the new path — no /read hop.
  '/blog/openai-unveils-moltbot-opeclaw-a-new-era-in-ai-automation':
    '/blog/openai-s-moltbot-openclaw-what-we-know-what-s-new-and-why-it-matters',
  '/blog/why-the-eufy-security-video-doorbell-dual-is-the-best-video-doorbell-without-a-subscription-in-the-uk':
    '/blog/eufy-security-video-doorbell-dual-the-best-video-doorbell-without-subscription-in-the-uk',
  '/blog/the-ultimate-guide-to-the-meacodry-arete-one-dehumidifier-air-purifier': '/blogs',
  '/blog/the-meacodry-arete-one-the-best-dehumidifier-for-drying-clothes-indoors-in-the-uk': '/blogs',
  '/blog/gradual-changes-sudden-shifts-adapting-in-the-digital-era': '/blogs',
  '/blog/react-performance': '/blogs',
  '/blog/webgl-performance': '/blogs',
};

const DELETED_BLOG_PATHS = new Set([
  '/blog/scroll-choreography',
]);

// Renamed slug mappings for the legacy /read?slug=X alias. Value = new slug →
// 301 to /blog/<new>. null → /blogs.
const SLUG_REDIRECTS = {
  'openai-unveils-moltbot-opeclaw-a-new-era-in-ai-automation':
    'openai-s-moltbot-openclaw-what-we-know-what-s-new-and-why-it-matters',
  'draft-mastering-gsap-in-2025-the-motion-engine-behind-modern-websites': null,
};

const DELETED_READ_SLUGS = new Set([
  '3d-printing-tips',
  'ai-workflow-2024',
  'blender-basics',
  'css-grid-mastery',
  'gsap-deep-dive',
  'print-workflow',
  'react-performance',
  'scroll-choreography',
  'threejs-materials',
  'ux-micro-interactions',
  'viewer-craft',
  'webgl-performance',
]);

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

    // Public tool alias. The static /avi-to-mp4 route can fall through to
    // the root Pages app depending on Pages routing order, so keep this alias
    // at the edge and send users to the Worker-owned converter page.
    if (pathname === '/avi-to-mp4' || pathname === '/avi-to-mp4/') {
      return Response.redirect(`${PUBLIC_DOMAIN}/converters/avi-to-mp4`, 302);
    }

    // 0a. Legacy /read?slug=X alias: renamed slugs → canonical /blog/<new>,
    //     deleted slugs → 410 Gone (before the generic /read → /blog redirect below).
    if (pathname === '/read') {
      const slug = url.searchParams.get('slug');
      if (slug && Object.prototype.hasOwnProperty.call(SLUG_REDIRECTS, slug)) {
        const target = SLUG_REDIRECTS[slug];
        const dest = target ? `/blog/${encodeURIComponent(target)}` : '/blogs';
        return Response.redirect(`${PUBLIC_DOMAIN}${dest}`, 301);
      }
      if (slug && DELETED_READ_SLUGS.has(slug)) {
        return goneResponse();
      }
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
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
          'X-TimrX-Worker': 'blog-proxy',
          'X-TimrX-SEO-Page': `${seoPage.basePath}/${seoPage.slug}`,
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
    // 1. Legacy /read?slug=<slug> reader → 301 to canonical /blog/<slug>.
    //    (Renamed/deleted slugs already handled in 0a above.)
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/read' || pathname === '/read/') {
      const slug = url.searchParams.get('slug');
      if (slug) {
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
    // 3. Canonical /blog/<slug> — serve the backend SSR post (200).
    //    Deleted slugs → 410 Gone. Tag/category hubs → SSR + noindex.
    //    NOTE: individual posts are NOT redirected — /blog/<slug> is the
    //    single canonical URL and must resolve 200 (or 410 if deleted).
    // ─────────────────────────────────────────────────────────────
    if (pathname.startsWith('/blog/')) {
      const isHub = pathname.startsWith('/blog/tag/') || pathname.startsWith('/blog/category/');
      if (!isHub) {
        const cleanPath = pathname.replace(/\/$/, '');
        const slug = cleanPath.slice('/blog/'.length);
        // Canonicalize trailing slash on individual posts (backend route has none).
        if (pathname !== cleanPath && slug) {
          return Response.redirect(`${PUBLIC_DOMAIN}${cleanPath}`, 301);
        }
        // Deleted posts stay 410 Gone at the edge regardless of backend DB state.
        if (DELETED_BLOG_PATHS.has(cleanPath) || DELETED_READ_SLUGS.has(slug)) {
          return goneResponse();
        }
      }
      const backendUrl = `${BLOG_ORIGIN}${pathname}`;
      const response = await proxyToBackend(request, backendUrl);
      if (isHub) {
        const headers = new Headers(response.headers);
        headers.set('X-Robots-Tag', 'noindex, follow');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
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
          'Cache-Control': 'public, max-age=300, s-maxage=300, must-revalidate',
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 8. Proxy dynamic SEO files to backend
    //    (sitemap index, page/recent sitemaps)
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/sitemap-recent.xml') {
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

function goneResponse() {
  return new Response('Gone', {
    status: 410,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, follow',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

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
