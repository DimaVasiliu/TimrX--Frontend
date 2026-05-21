/* ============================================================
   TimrX STL Pack Catalog + Storefront Helpers
   ------------------------------------------------------------
   HOW TO ADD A PACK:
     1. Upload  <slug>.zip  to the R2 bucket "timrx-stl-packs".
     2. Add one entry to STL_PACKS below.
     3. Deploy. The storefront and SEO pages pick it up automatically.

   priceGBP shown here is for display only — the backend re-checks
   the real price at checkout, so the client cannot be tampered with.

   tier:  'starter' | 'standard' | 'mega'   (just controls the badge)
   image: optional preview render in /img/stl/. Leave '' for a
          generated gradient placeholder card.
   ============================================================ */
(function () {
  'use strict';

  // ── CATALOG ────────────────────────────────────────────────
  // Your real packs. Each slug MUST match (a) the backend catalog in
  // backend/services/stl_pack_service.py and (b) the <slug>.zip file
  // uploaded to the R2 bucket.
  // priceGBP must match the backend price (backend re-checks at checkout).
  // fileCount / sizeMB are display-only — set them to your real numbers.
  const STL_PACKS = [
    {
      slug: 'airplanes',
      title: 'Airplanes STL Mega Pack',
      category: 'Vehicles',
      blurb: 'Fighter jets, airliners and vintage propeller planes. Every model cleaned, watertight and ready to slice.',
      priceGBP: 19.99,
      fileCount: 240,
      sizeMB: 1100,
      tier: 'mega',
      r2Key: 'airplanes.zip',
      image: '',
      tags: ['airplane', 'jet', 'aircraft', 'aviation', 'plane', 'fighter']
    },
    {
      slug: 'decorations',
      title: 'Decorations STL Pack',
      category: 'Home & Decor',
      blurb: 'Decorative pieces, ornaments and display models — cleaned, watertight and ready to print.',
      priceGBP: 9.99,
      fileCount: 80,
      sizeMB: 500,
      tier: 'standard',
      r2Key: 'decorations.zip',
      image: '',
      tags: ['decor', 'decoration', 'ornament', 'home', 'display']
    },
    {
      slug: 'animals',
      title: 'Animals STL Pack',
      category: 'Animals',
      blurb: 'A collection of animal and creature models — print-friendly poses, watertight and ready to slice.',
      priceGBP: 9.99,
      fileCount: 80,
      sizeMB: 500,
      tier: 'standard',
      r2Key: 'animals.zip',
      image: '',
      tags: ['animal', 'animals', 'creature', 'wildlife', 'pet']
    }
  ];

  // ── ALL-ACCESS PASS ────────────────────────────────────────
  // A single SKU that grants every pack (entitlement slug "*").
  const ALL_ACCESS = {
    slug: '*',
    title: 'All-Access Library Pass',
    blurb: 'Unlock every pack on this page — plus every pack added in the future. One payment, lifetime access.',
    priceGBP: 49,
    fullPriceGBP: 69
  };

  // ── API ────────────────────────────────────────────────────
  const BACKEND = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';

  function _fetch(url, opts) {
    // Use the site's CSRF-aware fetch when present, else a plain fetch.
    if (window.TimrXApi && typeof window.TimrXApi.fetchWithCsrf === 'function') {
      return window.TimrXApi.fetchWithCsrf(url, opts);
    }
    return fetch(url, Object.assign({ credentials: 'include' }, opts));
  }

  // ── Helpers ────────────────────────────────────────────────
  function formatPrice(gbp) {
    return '£' + Number(gbp).toFixed(2).replace(/\.00$/, '');
  }

  function formatSize(mb) {
    return mb >= 1000 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  function getPack(slug) {
    return STL_PACKS.find(function (p) { return p.slug === slug; }) || null;
  }

  function categories() {
    var seen = {};
    STL_PACKS.forEach(function (p) { seen[p.category] = true; });
    return Object.keys(seen);
  }

  /* Start a Mollie checkout for a pack (or '*' for All-Access).
     Backend route: POST /api/stl/checkout  -> { checkout_url }
     Until that route is deployed this fails gracefully. */
  async function checkout(slug) {
    try {
      var res = await _fetch(BACKEND + '/api/stl/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pack_slug: slug })
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data && data.checkout_url) {
        window.location.href = data.checkout_url;
        return { ok: true };
      }
      return { ok: false, status: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || 'network error' };
    }
  }

  /* Get a signed download link for an owned pack.
     Backend route: GET /api/stl/download?pack=<slug> -> { download_url } */
  async function download(slug) {
    try {
      var res = await _fetch(BACKEND + '/api/stl/download?pack=' + encodeURIComponent(slug), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data && data.download_url) {
        window.location.href = data.download_url;
        return { ok: true };
      }
      return { ok: false, status: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || 'network error' };
    }
  }

  // ── Export ─────────────────────────────────────────────────
  window.STL_PACKS = STL_PACKS;
  window.STLMarket = {
    packs: STL_PACKS,
    allAccess: ALL_ACCESS,
    getPack: getPack,
    categories: categories,
    formatPrice: formatPrice,
    formatSize: formatSize,
    checkout: checkout,
    download: download
  };
})();
