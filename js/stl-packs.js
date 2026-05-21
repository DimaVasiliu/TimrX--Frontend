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
  // First entry (Airplanes) is your real pack. The rest are
  // example rows — replace them with your real themed packs.
  const STL_PACKS = [
    {
      slug: 'airplanes',
      title: 'Airplanes STL Mega Pack',
      category: 'Vehicles',
      blurb: 'Fighter jets, airliners and vintage propeller planes. Every model cleaned, watertight and ready to slice.',
      priceGBP: 19.99,
      fileCount: 240,
      sizeMB: 1208,
      tier: 'mega',
      r2Key: 'airplanes.zip',
      image: '',
      tags: ['airplane', 'jet', 'aircraft', 'aviation', 'plane', 'fighter']
    },
    {
      slug: 'supercars',
      title: 'Supercars & Classic Cars Pack',
      category: 'Vehicles',
      blurb: 'Hypercars, muscle cars and vintage classics — display-quality models scaled for desk and shelf prints.',
      priceGBP: 14.99,
      fileCount: 110,
      sizeMB: 720,
      tier: 'standard',
      r2Key: 'supercars.zip',
      image: '',
      tags: ['car', 'supercar', 'vehicle', 'automotive']
    },
    {
      slug: 'wild-animals',
      title: 'Wild Animals Collection',
      category: 'Animals',
      blurb: 'Big cats, bears, birds and reptiles with print-friendly poses and stable bases.',
      priceGBP: 9.99,
      fileCount: 85,
      sizeMB: 540,
      tier: 'standard',
      r2Key: 'wild-animals.zip',
      image: '',
      tags: ['animal', 'wildlife', 'creature', 'nature']
    },
    {
      slug: 'tabletop-miniatures',
      title: 'Tabletop Miniatures Mega Pack',
      category: 'Tabletop',
      blurb: 'Heroes, monsters and scenery sized for 28–32mm tabletop gaming. Resin and FDM friendly.',
      priceGBP: 19.99,
      fileCount: 180,
      sizeMB: 950,
      tier: 'mega',
      r2Key: 'tabletop-miniatures.zip',
      image: '',
      tags: ['miniature', 'tabletop', 'dnd', 'wargaming', 'fantasy']
    },
    {
      slug: 'spaceships',
      title: 'Sci-Fi Spaceships Pack',
      category: 'Sci-Fi',
      blurb: 'Fighters, cruisers and stations with panelled hulls. Great for display and gaming fleets.',
      priceGBP: 14.99,
      fileCount: 95,
      sizeMB: 680,
      tier: 'standard',
      r2Key: 'spaceships.zip',
      image: '',
      tags: ['spaceship', 'scifi', 'space', 'starship']
    },
    {
      slug: 'architecture-landmarks',
      title: 'Architecture & Landmarks Pack',
      category: 'Architecture',
      blurb: 'Famous landmarks and detailed buildings, hollowed and optimised for clean tower prints.',
      priceGBP: 9.99,
      fileCount: 60,
      sizeMB: 430,
      tier: 'standard',
      r2Key: 'architecture-landmarks.zip',
      image: '',
      tags: ['architecture', 'building', 'landmark', 'city']
    },
    {
      slug: 'home-decor',
      title: 'Home & Desk Decor Pack',
      category: 'Home & Decor',
      blurb: 'Vases, planters, organisers and ornaments — useful, fast prints with no supports needed.',
      priceGBP: 4.99,
      fileCount: 35,
      sizeMB: 210,
      tier: 'starter',
      r2Key: 'home-decor.zip',
      image: '',
      tags: ['decor', 'home', 'vase', 'planter', 'functional']
    },
    {
      slug: 'articulated-toys',
      title: 'Articulated Toys Pack',
      category: 'Toys',
      blurb: 'Print-in-place flexi toys — dragons, fidgets and creatures that move straight off the bed.',
      priceGBP: 9.99,
      fileCount: 50,
      sizeMB: 380,
      tier: 'standard',
      r2Key: 'articulated-toys.zip',
      image: '',
      tags: ['toy', 'articulated', 'flexi', 'print-in-place']
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
