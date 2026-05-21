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
    { slug: 'airplanes', title: 'Airplanes STL Pack', category: 'Vehicles',
      blurb: 'Fighter jets, airliners and propeller planes — cleaned, watertight and ready to slice.',
      priceGBP: 3.99, fileCount: 42, sizeMB: 1100, r2Key: 'airplanes.zip', image: '',
      tags: ['airplane', 'jet', 'aircraft', 'plane'] },
    { slug: 'animals', title: 'Animals STL Pack', category: 'Animals',
      blurb: 'Animal and creature models with print-friendly poses and stable bases.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'animals.zip', image: '',
      tags: ['animal', 'creature', 'wildlife', 'pet'] },
    { slug: 'anime', title: 'Anime STL Pack', category: 'Characters',
      blurb: 'Anime and manga characters, ready for FDM or resin printing.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'anime.zip', image: '',
      tags: ['anime', 'manga', 'character'] },
    { slug: 'articulated-toys', title: 'Articulated Toys Pack', category: 'Toys',
      blurb: 'Print-in-place articulated toys and creatures that move straight off the bed.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'articulated-toys.zip', image: '',
      tags: ['articulated', 'flexi', 'toy', 'print-in-place'] },
    { slug: 'games', title: 'Games STL Pack', category: 'Gaming',
      blurb: 'Characters and props from popular video games, print-ready.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'games.zip', image: '',
      tags: ['game', 'gaming', 'video game'] },
    { slug: 'busts', title: 'Busts STL Pack', category: 'Characters',
      blurb: 'Detailed character busts sized for display and resin printing.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'busts.zip', image: '',
      tags: ['bust', 'character', 'portrait'] },
    { slug: 'scenes', title: 'Scenes STL Pack', category: 'Scenes',
      blurb: 'Complete themed scenes to print and assemble.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'scenes.zip', image: '',
      tags: ['scene', 'environment', 'set'] },
    { slug: 'chibi', title: 'Chibi STL Pack', category: 'Characters',
      blurb: 'Cute chibi-style figures — quick, fun prints.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'chibi.zip', image: '',
      tags: ['chibi', 'cute', 'figure'] },
    { slug: 'keychains', title: 'Keychains STL Pack', category: 'Home & Decor',
      blurb: 'Printable keychains and small everyday accessories.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'keychains.zip', image: '',
      tags: ['keychain', 'accessory', 'keyring'] },
    { slug: 'cosplay', title: 'Cosplay STL Pack', category: 'Characters',
      blurb: 'Wearable cosplay props and accessory parts.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'cosplay.zip', image: '',
      tags: ['cosplay', 'prop', 'wearable'] },
    { slug: 'dv', title: 'DV STL Pack', category: 'More',
      blurb: 'The DV collection — a curated mix of print-ready models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'dv.zip', image: '',
      tags: ['dv', 'collection', 'mixed'] },
    { slug: 'decorations', title: 'Decorations STL Pack', category: 'Home & Decor',
      blurb: 'Decorative pieces, ornaments and display models — cleaned and ready to print.',
      priceGBP: 4.99, fileCount: 66, sizeMB: 500, r2Key: 'decorations.zip', image: '',
      tags: ['decor', 'decoration', 'ornament', 'home'] },
    { slug: 'animated-cartoons', title: 'Animated Cartoons STL Pack', category: 'Characters',
      blurb: 'Characters from animated cartoons, cleaned and print-ready.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'animated-cartoons.zip', image: '',
      tags: ['cartoon', 'animated', 'character'] },
    { slug: 'disney', title: 'Disney STL Pack', category: 'Characters',
      blurb: 'Disney-style characters and figures, ready to print.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'disney.zip', image: '',
      tags: ['disney', 'character', 'figure'] },
    { slug: 'sculptures', title: 'Sculptures STL Pack', category: 'Characters',
      blurb: 'Artistic sculptures and statues for display printing.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'sculptures.zip', image: '',
      tags: ['sculpture', 'statue', 'art'] },
    { slug: 'dioramas', title: 'Dioramas STL Pack', category: 'Scenes',
      blurb: 'Diorama sets with figures, terrain and props.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'dioramas.zip', image: '',
      tags: ['diorama', 'scene', 'terrain'] },
    { slug: 'foldable', title: 'Foldable STL Pack', category: 'Toys',
      blurb: 'Foldable, flexible print-in-place models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'foldable.zip', image: '',
      tags: ['foldable', 'flexi', 'flexible'] },
    { slug: 'film', title: 'Film STL Pack', category: 'Film',
      blurb: 'Models and props inspired by film and TV.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'film.zip', image: '',
      tags: ['film', 'movie', 'tv', 'prop'] },
    { slug: 'mythological', title: 'Mythological STL Pack', category: 'Characters',
      blurb: 'Gods, monsters and legends from world mythology.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'mythological.zip', image: '',
      tags: ['mythology', 'myth', 'legend', 'gods'] },
    { slug: 'multipart', title: 'Multipart STL Pack', category: 'Miniatures',
      blurb: 'Multi-part models that print in sections and assemble.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'multipart.zip', image: '',
      tags: ['multipart', 'assembly', 'kit'] },
    { slug: 'religion', title: 'Religion STL Pack', category: 'Religion',
      blurb: 'Religious figures, symbols and devotional models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'religion.zip', image: '',
      tags: ['religion', 'religious', 'devotional'] },
    { slug: 'vehicles', title: 'Vehicles STL Pack', category: 'Vehicles',
      blurb: 'Cars, trucks and ground vehicles, print-ready.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'vehicles.zip', image: '',
      tags: ['vehicle', 'car', 'truck'] },
    { slug: 'supports', title: 'Supports STL Pack', category: 'More',
      blurb: 'Support structures and printing helper models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'supports.zip', image: '',
      tags: ['support', 'helper', 'printing'] },
    { slug: 'table-games', title: 'Table Games STL Pack', category: 'Gaming',
      blurb: 'Board and tabletop game pieces, tokens and accessories.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'table-games.zip', image: '',
      tags: ['board game', 'tabletop', 'tokens'] },
    { slug: 'utensils', title: 'Utensils STL Pack', category: 'Home & Decor',
      blurb: 'Functional kitchen and household utensils to print.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'utensils.zip', image: '',
      tags: ['utensil', 'kitchen', 'household'] },
    { slug: 'miniatures', title: 'Miniatures STL Pack', category: 'Miniatures',
      blurb: 'Tabletop miniatures scaled for 28-32mm gaming.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'miniatures.zip', image: '',
      tags: ['miniature', 'tabletop', '28mm', 'wargaming'] }
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
