import { findSeoPage, generateSeoSitemap } from './seo-pages.js';
import { renderSeoPage } from './seo-template.js';
import { OUTAGE_PAGES } from './outage-pages.js';

/**
 * TimrX Blog Proxy Worker
 *
 * This Cloudflare Worker proxies blog-related routes from timrx.live to the backend at blog.timrx.live.
 * It also handles /read redirects at the edge for SEO purposes.
 *
 * NOTE: /blogs is served STATICALLY by Cloudflare Pages (blogs.html) - NOT proxied here.
 *
 * PROXIED ROUTES:
 * - /blog/<slug>           → 301 to /read?slug=<slug>
 * - /blog/tag/<tag>        → Tag hub pages (SSR)
 * - /blog/category/<cat>   → Category hub pages (SSR)
 * - /tools                 → Tools I Use page (SSR)
 * - /rss.xml               → RSS feed
 * - /sitemap-blogs.xml     → Blog sitemap (proxied from /sitemap.xml)
 * - /robots.txt            → Dynamic robots.txt from backend
 * - /sitemap.xml           → Sitemap index from backend
 * - /sitemap-recent.xml    → Recent posts sitemap from backend
 * - /api/*                 → API endpoints (no caching)
 *
 * EDGE REDIRECTS:
 * - /read?slug=<slug>      → Public reader page with per-post metadata
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
Allow: /read

# Block admin & private/write areas only
Disallow: /admin
Disallow: /admin-edit
Disallow: /write
Disallow: /api/

# NOTE: /3dprint, /converter, /avi-to-mp4, /converters, /prompts, /read are PUBLIC pages — do NOT disallow them

Sitemap: https://timrx.live/sitemap.xml
`;

// ─────────────────────────────────────────────────────────────
// 301 Redirect map for old/broken URLs reported by GSC
// Add entries as: '/old-path': '/new-path'
// ─────────────────────────────────────────────────────────────
const PERMANENT_REDIRECTS = {
  // Deleted/legacy paths → live equivalents (or /blogs if no relevant alive post).
  // For /blog/<slug> the worker already 301s to /read?slug=<slug>, but if the slug
  // itself was deleted we override here.
  '/blog/openai-unveils-moltbot-opeclaw-a-new-era-in-ai-automation':
    '/read?slug=openai-s-moltbot-openclaw-what-we-know-what-s-new-and-why-it-matters',
  '/blog/why-the-eufy-security-video-doorbell-dual-is-the-best-video-doorbell-without-a-subscription-in-the-uk':
    '/read?slug=eufy-security-video-doorbell-dual-the-best-video-doorbell-without-subscription-in-the-uk',
  '/blog/the-ultimate-guide-to-the-meacodry-arete-one-dehumidifier-air-purifier': '/blogs',
  '/blog/the-meacodry-arete-one-the-best-dehumidifier-for-drying-clothes-indoors-in-the-uk': '/blogs',
  '/blog/gradual-changes-sudden-shifts-adapting-in-the-digital-era': '/blogs',
  '/blog/react-performance': '/blogs',
  '/blog/webgl-performance': '/blogs',
};

// Deleted /read?slug=X mappings. Value = new slug → /read?slug=<new>. null → /blogs.
const SLUG_REDIRECTS = {
  'openai-unveils-moltbot-opeclaw-a-new-era-in-ai-automation':
    'openai-s-moltbot-openclaw-what-we-know-what-s-new-and-why-it-matters',
  'draft-mastering-gsap-in-2025-the-motion-engine-behind-modern-websites': null,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ─────────────────────────────────────────────────────────────
    // 0z. OUTAGE WORKAROUND — Cloudflare Pages currently returns empty
    // HTTP 500s when serving the clean URLs of 12 specific pages
    // (/hub, /3dprint, /pricing and the AI/3D tool pages). Until Pages
    // is fixed, serve those pages directly from the embedded snapshot
    // in outage-pages.js.
    //
    // TO REVERT once Cloudflare Pages serves these pages again:
    //   1. delete this block
    //   2. delete the `import { OUTAGE_PAGES }` line
    //   3. delete outage-pages.js
    //   4. remove the matching 12 routes from wrangler.toml, then redeploy
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' || request.method === 'HEAD') {
      const outageKey = pathname.replace(/\/+$/, '') || '/';
      const outageHtml = OUTAGE_PAGES[outageKey];
      if (outageHtml !== undefined) {
        return new Response(request.method === 'HEAD' ? null : outageHtml, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
            'X-TimrX-Worker': 'outage-pagefix',
          },
        });
      }
    }

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

    // 0a. Redirect deleted /read?slug=X to live equivalents (or /blogs if no match)
    if (pathname === '/read') {
      const slug = url.searchParams.get('slug');
      if (slug && Object.prototype.hasOwnProperty.call(SLUG_REDIRECTS, slug)) {
        const target = SLUG_REDIRECTS[slug];
        const dest = target ? `/read?slug=${encodeURIComponent(target)}` : '/blogs';
        return Response.redirect(`${PUBLIC_DOMAIN}${dest}`, 301);
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
    // 1. Handle /read at the edge.
    // /read?slug=... is public and canonical, so serve it from Pages.
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/read' || pathname === '/read/') {
      const slug = url.searchParams.get('slug');
      if (slug) {
        return serveReadPageWithMetadata(request, slug);
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
    // 3. Redirect legacy /blog/<slug> URLs to canonical /read?slug=<slug>.
    //    Keep tag/category hubs proxied to backend SSR.
    // ─────────────────────────────────────────────────────────────
    if (pathname.startsWith('/blog/')) {
      if (!pathname.startsWith('/blog/tag/') && !pathname.startsWith('/blog/category/')) {
        const slug = pathname.slice('/blog/'.length).replace(/\/$/, '');
        if (slug) {
          return Response.redirect(`${PUBLIC_DOMAIN}/read?slug=${encodeURIComponent(slug)}`, 301);
        }
      }
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

async function serveReadPageWithMetadata(request, slug) {
  const pageResponse = await fetch(request);
  const contentType = pageResponse.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return pageResponse;

  let html = await pageResponse.text();
  const canonical = `${PUBLIC_DOMAIN}/read?slug=${encodeURIComponent(slug)}`;

  try {
    const postResponse = await fetch(`${BLOG_ORIGIN}/api/post/${encodeURIComponent(slug)}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (postResponse.ok) {
      const post = await postResponse.json();
      const title = escapeHtml(post.title || 'Read');
      const description = escapeHtml(post.excerpt || post.description || 'Read blog posts on TimrX — web development, 3D, and creative tech.');
      const image = escapeHtml(post.cover_url || `${PUBLIC_DOMAIN}/img/blogs.png`);

      html = html
        .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title} — TimrX</title>`)
        .replace(/<meta name="description" content="[^"]*"\s*\/?>/i, `<meta name="description" content="${description}" />`)
        .replace(/<meta property="og:title" id="ogTitle" content="[^"]*"\s*\/?>/i, `<meta property="og:title" id="ogTitle" content="${title}" />`)
        .replace(/<meta property="og:description" id="ogDesc" content="[^"]*"\s*\/?>/i, `<meta property="og:description" id="ogDesc" content="${description}" />`)
        .replace(/<meta property="og:image" id="ogImage" content="[^"]*"\s*\/?>/i, `<meta property="og:image" id="ogImage" content="${image}" />`)
        .replace(/<meta name="twitter:title" id="twTitle" content="[^"]*"\s*\/?>/i, `<meta name="twitter:title" id="twTitle" content="${title}" />`)
        .replace(/<meta name="twitter:description" id="twDesc" content="[^"]*"\s*\/?>/i, `<meta name="twitter:description" id="twDesc" content="${description}" />`)
        .replace(/<meta name="twitter:image" id="twImage" content="[^"]*"\s*\/?>/i, `<meta name="twitter:image" id="twImage" content="${image}" />`);
    }
  } catch (error) {
    console.warn('Read metadata injection failed:', error);
  }

  html = html
    .replace(/<meta name="robots" content="[^"]*"\s*\/?>/i, '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />')
    .replace(/<link rel="canonical" id="canonicalLink" href="[^"]*"\s*\/?>/i, `<link rel="canonical" id="canonicalLink" href="${canonical}" />`)
    .replace(/<meta property="og:url" id="ogUrl" content="[^"]*"\s*\/?>/i, `<meta property="og:url" id="ogUrl" content="${canonical}" />`)
    .replace(/<meta name="twitter:url" id="twUrl" content="[^"]*"\s*\/?>/i, `<meta name="twitter:url" id="twUrl" content="${canonical}" />`);

  const headers = new Headers(pageResponse.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  headers.delete('X-Robots-Tag');
  return new Response(html, {
    status: pageResponse.status,
    statusText: pageResponse.statusText,
    headers,
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
