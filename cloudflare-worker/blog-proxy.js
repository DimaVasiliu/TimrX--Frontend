/**
 * Cloudflare Worker: Blog Reverse Proxy
 *
 * Proxies blog routes from timrx.live to blog.timrx.live (Render backend)
 *
 * Routes handled:
 *   /blog/*           -> https://blog.timrx.live/blog/*
 *   /rss.xml          -> https://blog.timrx.live/rss.xml
 *   /sitemap-blogs.xml -> https://blog.timrx.live/sitemap.xml
 */

const ORIGIN = 'https://blog.timrx.live';

// Cache durations (in seconds)
const CACHE_BLOG = 300;      // 5 minutes for blog posts
const CACHE_RSS = 300;       // 5 minutes for RSS
const CACHE_SITEMAP = 3600;  // 1 hour for sitemap

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Determine if this request should be proxied
    let originPath = null;
    let cacheDuration = 0;

    if (path.startsWith('/blog/')) {
      // /blog/<slug> -> same path
      originPath = path;
      cacheDuration = CACHE_BLOG;
    } else if (path === '/rss.xml') {
      // /rss.xml -> same path
      originPath = '/rss.xml';
      cacheDuration = CACHE_RSS;
    } else if (path === '/sitemap-blogs.xml') {
      // /sitemap-blogs.xml -> /sitemap.xml on origin
      originPath = '/sitemap.xml';
      cacheDuration = CACHE_SITEMAP;
    }

    // If no match, pass through to Pages (should not happen if routes are correct)
    if (!originPath) {
      return fetch(request);
    }

    // Build origin URL with querystring preserved
    const originUrl = new URL(originPath, ORIGIN);
    originUrl.search = url.search;

    // Create new request with correct Host header
    const proxyRequest = new Request(originUrl.toString(), {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
      redirect: 'follow',
    });

    // Set Host header to origin domain (required for Render to route correctly)
    proxyRequest.headers.set('Host', 'blog.timrx.live');

    // Forward real client IP
    proxyRequest.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
    proxyRequest.headers.set('X-Forwarded-Proto', 'https');

    try {
      // Fetch from origin
      const response = await fetch(proxyRequest);

      // Clone response to modify headers
      const newHeaders = new Headers(response.headers);

      // Apply cache control if origin didn't set it
      if (!response.headers.has('Cache-Control')) {
        newHeaders.set('Cache-Control', `public, s-maxage=${cacheDuration}, max-age=${cacheDuration}`);
      }

      // Ensure proper CORS for API-like endpoints (RSS, sitemap)
      if (path === '/rss.xml' || path === '/sitemap-blogs.xml') {
        newHeaders.set('Access-Control-Allow-Origin', '*');
      }

      // Return proxied response
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });

    } catch (error) {
      // Origin unreachable - return error page
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Service Unavailable</title></head>
<body>
<h1>503 Service Unavailable</h1>
<p>The blog service is temporarily unavailable. Please try again later.</p>
</body>
</html>`,
        {
          status: 503,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store',
          },
        }
      );
    }
  },
};
