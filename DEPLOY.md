# Cloudflare Worker Deployment Guide

## Overview

This Worker is the edge router for the blog and blog-adjacent SEO surface on
`timrx.live`. It sits between Cloudflare Pages and the Render blog backend at
`blog.timrx.live`.

Use this file as the source of truth for when the Worker is required, which
routes it owns, and what stays outside the Worker entirely.

## Ownership Model

| Surface | Owner in production | Notes |
|---|---|---|
| `/`, static pages, assets, `/blogs` | Cloudflare Pages / static frontend | Worker should not intercept these |
| `/blog`, `/blog/*` | Worker -> `blog.timrx.live` | `/blog` redirects to `/blogs`; `/blog/*` is SSR from blog backend |
| `/read*` | Worker | Edge redirect only; canonical target is `/blog/<slug>` |
| `/tools*` | Worker -> `blog.timrx.live` | SSR page from blog backend |
| `/rss.xml`, `/sitemap*.xml` | Worker -> `blog.timrx.live` | Public SEO feeds and sitemaps |
| `/robots.txt` | Worker | Served directly at the edge |
| `/api/*` on `timrx.live` | Worker -> `blog.timrx.live` | Reserved for blog/API traffic on the apex domain |
| `https://3d.timrx.live/*` | 3D backend | Not part of this Worker |
| `https://chat.timrx.live/*` | Chat backend | Not part of this Worker |

## When the Worker Is Required

- Production: required if you want the canonical `timrx.live` blog, SEO, and
  same-origin blog API surface to work on the apex domain.
- Local development: usually not required. Run the static frontend, blog
  backend, 3D backend, and chat backend directly.
- Staging / pre-prod: only required if you specifically want to test the same
  edge route model as production.

If the Worker is disabled in production:
- `/blogs` still works because it is static
- `/blog/<slug>`, `/read`, `robots.txt`, RSS, sitemaps, and same-origin blog
  `/api/*` routes on `timrx.live` will not behave correctly

## Production Route Map

| Route on `timrx.live` | Worker action | Backend target / result | Cache |
|---|---|---|---|
| `/blog` or `/blog/` | 301 redirect | `/blogs` | none |
| `/blog/*` | proxy | `https://blog.timrx.live/blog/*` | backend-controlled |
| `/read*` | redirect | `/blog/<slug>` or `/blogs` | none |
| `/tools*` | proxy | `https://blog.timrx.live/tools` | backend-controlled |
| `/rss.xml` | proxy | `https://blog.timrx.live/rss.xml` | backend-controlled |
| `/sitemap-blogs.xml` | proxy | `https://blog.timrx.live/sitemap-blogs.xml` | backend-controlled |
| `/sitemap.xml` | proxy | `https://blog.timrx.live/sitemap.xml` | backend-controlled |
| `/sitemap-pages.xml` | proxy | `https://blog.timrx.live/sitemap-pages.xml` | backend-controlled |
| `/sitemap-recent.xml` | proxy | `https://blog.timrx.live/sitemap-recent.xml` | backend-controlled |
| `/robots.txt` | serve at edge | worker-generated | 1 day |
| `/api/*` | proxy | `https://blog.timrx.live/api/*` | no cache |

## Deployment Steps

### Option A: Cloudflare Dashboard

1. Go to <https://dash.cloudflare.com>.
2. Select the `timrx.live` zone.
3. Create or open the `blog-proxy` Worker.
4. Replace the Worker code with `blog-proxy.js`.
5. Add these route bindings:

| Route | Zone |
|---|---|
| `timrx.live/blog` | `timrx.live` |
| `timrx.live/blog/*` | `timrx.live` |
| `timrx.live/api/*` | `timrx.live` |
| `timrx.live/read*` | `timrx.live` |
| `timrx.live/tools*` | `timrx.live` |
| `timrx.live/rss.xml` | `timrx.live` |
| `timrx.live/sitemap-blogs.xml` | `timrx.live` |
| `timrx.live/sitemap.xml` | `timrx.live` |
| `timrx.live/sitemap-pages.xml` | `timrx.live` |
| `timrx.live/sitemap-recent.xml` | `timrx.live` |
| `timrx.live/robots.txt` | `timrx.live` |

Add matching `www.timrx.live/...` routes only if that hostname is live and
should expose the same blog/SEO surface.

### Option B: Wrangler CLI

1. Install Wrangler:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. Deploy from this folder:
   ```bash
   cd TimrX/cloudflare-worker
   wrangler deploy
   ```

`wrangler.toml` in this repo already contains the intended route model. Keep it
in sync with `blog-proxy.js`.

## Verification Commands

```bash
# /blog exact route should redirect to /blogs
curl -I https://timrx.live/blog

# Blog SSR page through the worker
curl -s https://timrx.live/blog/your-post-slug | head -50
curl -I https://timrx.live/blog/your-post-slug

# /read should canonicalize to /blog/<slug>
curl -I "https://timrx.live/read?slug=your-post-slug"

# Tools page through the worker
curl -I https://timrx.live/tools

# SEO endpoints
curl -s https://timrx.live/rss.xml | head -20
curl -s https://timrx.live/sitemap-blogs.xml | head -20
curl -s https://timrx.live/sitemap.xml | head -20

# Same-origin blog API through the worker
curl -I https://timrx.live/api/health

# Canonical URL in HTML
curl -s https://timrx.live/blog/your-post-slug | grep canonical
```

## Troubleshooting

### Worker not triggering

- Check route patterns match exactly.
- Ensure the zone is `timrx.live`.
- Check Worker metrics for incoming requests.

### Static page unexpectedly proxied

- The Worker should not own `/blogs` or normal frontend pages.
- Do not add overly broad routes like `timrx.live/*`.
- Keep the route set limited to the blog/SEO/API surface listed above.

### Same-origin `/api/*` conflicts

- On `timrx.live`, `/api/*` is currently reserved for the blog backend through
  the Worker.
- Do not introduce unrelated apex-domain APIs under `/api/*` unless you also
  change the Worker route model.

### 503 or 502 errors

- `blog.timrx.live` might be down or unhealthy.
- Check the Render blog backend first.
- If the Worker itself is deployed but the backend is down, the edge will still
  return failures.

### CORS issues

- The Worker handles preflight and response CORS headers for proxied blog
  `/api/*`.
- Blog pages themselves do not rely on CORS.

## Architecture

```text
Browser / Bot                Cloudflare Pages + Worker                 Render
─────────────────────────────────────────────────────────────────────────────────────
/blogs                  →    Pages static asset                        n/a
/blog/foo               →    Worker route match                        /blog/foo
/read?slug=foo          →    Worker 301 redirect                       n/a
/api/subscribe          →    Worker proxy (no cache)                   /api/subscribe
/rss.xml                →    Worker proxy                              /rss.xml
/robots.txt             →    Worker edge response                      n/a
/sitemap.xml            →    Worker proxy                              /sitemap.xml
```

## Local vs Production

### Local

- Serve `TimrX/Frontend` statically.
- Run `TimrX/Blogs_Backend` directly on its own port.
- Point the frontend at the blog backend directly if needed.
- Do not bother with the Worker unless you are specifically testing edge
  routing.

### Production

- Cloudflare Pages serves the static frontend.
- The Worker owns the same-origin blog/SEO/API route set listed above.
- `blog.timrx.live` stays the Render origin behind the Worker.
- `3d.timrx.live` and `chat.timrx.live` stay direct backend origins outside
  this Worker.
