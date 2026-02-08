# Cloudflare Worker Deployment Guide

## Overview

This Worker proxies blog routes from `timrx.live` to `blog.timrx.live` (Render backend).

| Route on timrx.live | Proxied to blog.timrx.live | Cache |
|---------------------|---------------------------|-------|
| `/blog/*` | `/blog/*` | 5 min |
| `/rss.xml` | `/rss.xml` | 5 min |
| `/sitemap-blogs.xml` | `/sitemap.xml` | 1 hour |

---

## Deployment Steps

### Option A: Cloudflare Dashboard (Quick)

1. **Go to Cloudflare Dashboard**
   - Navigate to: https://dash.cloudflare.com
   - Select your account → Select `timrx.live` zone

2. **Create the Worker**
   - Go to **Workers & Pages** → **Overview**
   - Click **Create application** → **Create Worker**
   - Name it: `blog-proxy`
   - Click **Deploy**

3. **Edit the Worker Code**
   - Click **Edit code**
   - Replace all code with contents of `blog-proxy.js`
   - Click **Save and Deploy**

4. **Add Route Bindings**
   - Go to **Workers & Pages** → **blog-proxy** → **Settings** → **Triggers**
   - Under **Routes**, click **Add route**
   - Add these routes (one at a time):

   | Route | Zone |
   |-------|------|
   | `timrx.live/blog/*` | timrx.live |
   | `timrx.live/rss.xml` | timrx.live |
   | `timrx.live/sitemap-blogs.xml` | timrx.live |

   - Also add `www.timrx.live/*` versions if you have www subdomain

5. **Verify**
   ```bash
   curl -I https://timrx.live/blog/test-post
   curl -I https://timrx.live/rss.xml
   curl -I https://timrx.live/sitemap-blogs.xml
   ```

---

### Option B: Wrangler CLI (Recommended for CI/CD)

1. **Install Wrangler**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Create wrangler.toml**
   ```toml
   name = "blog-proxy"
   main = "blog-proxy.js"
   compatibility_date = "2024-01-01"

   routes = [
     { pattern = "timrx.live/blog/*", zone_name = "timrx.live" },
     { pattern = "timrx.live/rss.xml", zone_name = "timrx.live" },
     { pattern = "timrx.live/sitemap-blogs.xml", zone_name = "timrx.live" }
   ]
   ```

3. **Deploy**
   ```bash
   cd cloudflare-worker
   wrangler deploy
   ```

---

## Verification Commands

```bash
# Test blog post SSR
curl -s https://timrx.live/blog/your-post-slug | head -50

# Check headers
curl -I https://timrx.live/blog/your-post-slug

# Test RSS
curl -s https://timrx.live/rss.xml | head -20

# Test sitemap (mapped from /sitemap-blogs.xml to origin /sitemap.xml)
curl -s https://timrx.live/sitemap-blogs.xml | head -20

# Verify canonical URL in HTML
curl -s https://timrx.live/blog/your-post-slug | grep canonical
# Should show: <link rel="canonical" href="https://timrx.live/blog/your-post-slug"/>
```

---

## Troubleshooting

### Worker not triggering
- Check route patterns match exactly
- Ensure zone is correct (timrx.live, not www)
- Check Workers & Pages → blog-proxy → Metrics for requests

### 503 errors
- Backend (blog.timrx.live) might be down
- Check Render dashboard for backend status

### Wrong content returned
- Clear Cloudflare cache: Dashboard → Caching → Purge Everything
- Or purge specific URL: `Purge by URL`

### CORS issues
- Worker adds `Access-Control-Allow-Origin: *` for RSS/sitemap
- For blog pages, CORS is typically not needed

---

## Architecture

```
User Request                    Cloudflare                     Render
─────────────────────────────────────────────────────────────────────────
GET timrx.live/blog/foo   →   Worker matches /blog/*    →   blog.timrx.live/blog/foo
                          ←   HTML response cached      ←   SSR HTML
                              (s-maxage=300)
```

---

## Files Changed

| File | Change |
|------|--------|
| `Frontend/_redirects` | Removed invalid 200 proxy rules |
| `cloudflare-worker/blog-proxy.js` | New Worker script |
| `cloudflare-worker/DEPLOY.md` | This guide |
