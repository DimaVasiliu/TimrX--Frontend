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

  const STL_PACK_ASSET_VERSION = '20260522a';

  // ── CATALOG ────────────────────────────────────────────────
  // Your real packs. Each slug MUST match (a) the backend catalog in
  // backend/services/stl_pack_service.py and (b) the <slug>.zip file
  // uploaded to the R2 bucket.
  // priceGBP must match the backend price (backend re-checks at checkout).
  // fileCount / sizeMB are display-only — set them to your real numbers.
  const STL_PACKS = [
    { slug: 'airplanes', title: 'Airplanes STL Pack', category: 'Vehicles',
      blurb: 'Fighter jets, airliners and propeller planes — cleaned, watertight and ready to slice.',
      priceGBP: 3.99, fileCount: 42, sizeMB: 1100, r2Key: 'airplanes.zip', image: 'img/stl/airplanes.webp',
      tags: ['airplane', 'jet', 'aircraft', 'plane'] },
    { slug: 'animals', title: 'Animals STL Pack', category: 'Animals',
      blurb: 'Animal and creature models with print-friendly poses and stable bases.',
      priceGBP: 3.99, fileCount: 138, sizeMB: 0, r2Key: 'animals.zip', image: 'img/stl/animals.webp',
      tags: ['animal', 'creature', 'wildlife', 'pet'] },
    { slug: 'anime', title: 'Anime STL Pack', category: 'Characters',
      blurb: 'Anime and manga characters, ready for FDM or resin printing.',
      priceGBP: 3.99, fileCount: '100+', sizeMB: 0, r2Key: 'anime.zip', image: 'img/stl/anime.webp',
      tags: ['anime', 'manga', 'character'] },
    { slug: 'articulated-toys', title: 'Articulated Toys Pack', category: 'Toys',
      blurb: 'Print-in-place articulated toys and creatures that move straight off the bed.',
      priceGBP: 3.99, fileCount: 173, sizeMB: 0, r2Key: 'articulated-toys.zip', image: 'img/stl/articulated-toys.webp',
      tags: ['articulated', 'flexi', 'toy', 'print-in-place'] },
    { slug: 'games', title: 'Games STL Pack', category: 'Gaming',
      blurb: 'Characters and props from popular video games, print-ready.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'games.zip', image: 'img/stl/games.webp',
      tags: ['game', 'gaming', 'video game'] },
    { slug: 'busts', title: 'Busts STL Pack', category: 'Characters',
      blurb: 'Detailed character busts sized for display and resin printing.',
      priceGBP: 3.99, fileCount: 182, sizeMB: 0, r2Key: 'busts.zip', image: 'img/stl/busts.webp',
      tags: ['bust', 'character', 'portrait'] },
    { slug: 'scenes', title: 'Scenes STL Pack', category: 'Scenes',
      blurb: 'Complete themed scenes to print and assemble.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'scenes.zip', image: 'img/stl/scenes.webp',
      tags: ['scene', 'environment', 'set'] },
    { slug: 'chibi', title: 'Chibi STL Pack', category: 'Characters',
      blurb: 'Cute chibi-style figures — quick, fun prints.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'chibi.zip', image: 'img/stl/chibi.webp',
      tags: ['chibi', 'cute', 'figure'] },
    { slug: 'keychains', title: 'Keychains STL Pack', category: 'Home & Decor',
      blurb: 'Printable keychains and small everyday accessories.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'keychains.zip', image: 'img/stl/keychains.webp',
      tags: ['keychain', 'accessory', 'keyring'] },
    { slug: 'cosplay', title: 'Cosplay STL Pack', category: 'Characters',
      blurb: 'Wearable cosplay props and accessory parts.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'cosplay.zip', image: 'img/stl/cosplay.webp',
      tags: ['cosplay', 'prop', 'wearable'] },
    { slug: 'dc', title: 'DC STL Pack', category: 'More',
      blurb: 'The DC collection — a curated mix of print-ready models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'dc.zip', image: 'img/stl/dc.webp',
      tags: ['dc', 'collection', 'mixed'] },
    { slug: 'decorations', title: 'Decorations STL Pack', category: 'Home & Decor',
      blurb: 'Decorative pieces, ornaments and display models — cleaned and ready to print.',
      priceGBP: 4.99, fileCount: 66, sizeMB: 500, r2Key: 'decorations.zip', image: 'img/stl/decorations.webp',
      tags: ['decor', 'decoration', 'ornament', 'home'] },
    { slug: 'animated-cartoons', title: 'Animated Cartoons STL Pack', category: 'Characters',
      blurb: 'Characters from animated cartoons, cleaned and print-ready.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'animated-cartoons.zip', image: 'img/stl/animated-cartoons.webp',
      tags: ['cartoon', 'animated', 'character'] },
    { slug: 'disney', title: 'Disney STL Pack', category: 'Characters',
      blurb: 'Disney-style characters and figures, ready to print.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'disney.zip', image: 'img/stl/disney.webp',
      tags: ['disney', 'character', 'figure'] },
    { slug: 'sculptures', title: 'Sculptures STL Pack', category: 'Characters',
      blurb: 'Artistic sculptures and statues for display printing.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'sculptures.zip', image: 'img/stl/sculptures.webp',
      tags: ['sculpture', 'statue', 'art'] },
    { slug: 'dioramas', title: 'Dioramas STL Pack', category: 'Scenes',
      blurb: 'Diorama sets with figures, terrain and props.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'dioramas.zip', image: 'img/stl/dioramas.webp',
      tags: ['diorama', 'scene', 'terrain'] },
    { slug: 'foldable', title: 'Foldable STL Pack', category: 'Toys',
      blurb: 'Foldable, flexible print-in-place models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'foldable.zip', image: 'img/stl/foldable.webp',
      tags: ['foldable', 'flexi', 'flexible'] },
    { slug: 'film', title: 'Film STL Pack', category: 'Film',
      blurb: 'Models and props inspired by film and TV.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'film.zip', image: 'img/stl/film.webp',
      tags: ['film', 'movie', 'tv', 'prop'] },
    { slug: 'mythological', title: 'Mythological STL Pack', category: 'Characters',
      blurb: 'Gods, monsters and legends from world mythology.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'mythological.zip', image: 'img/stl/mythological.webp',
      tags: ['mythology', 'myth', 'legend', 'gods'] },
    { slug: 'multipart', title: 'Multipart STL Pack', category: 'Miniatures',
      blurb: 'Multi-part models that print in sections and assemble.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'multipart.zip', image: 'img/stl/multipart.webp',
      tags: ['multipart', 'assembly', 'kit'] },
    { slug: 'religion', title: 'Religion STL Pack', category: 'Religion',
      blurb: 'Religious figures, symbols and devotional models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'religion.zip', image: 'img/stl/religion.webp',
      tags: ['religion', 'religious', 'devotional'] },
    { slug: 'vehicles', title: 'Vehicles STL Pack', category: 'Vehicles',
      blurb: 'Cars, trucks and ground vehicles, print-ready.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'vehicles.zip', image: 'img/stl/vehicles.webp',
      tags: ['vehicle', 'car', 'truck'] },
    { slug: 'supports', title: 'Supports STL Pack', category: 'More',
      blurb: 'Support structures and printing helper models.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'supports.zip', image: 'img/stl/supports.webp',
      tags: ['support', 'helper', 'printing'] },
    { slug: 'table-games', title: 'Table Games STL Pack', category: 'Gaming',
      blurb: 'Board and tabletop game pieces, tokens and accessories.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'table-games.zip', image: 'img/stl/table-games.webp',
      tags: ['board game', 'tabletop', 'tokens'] },
    { slug: 'utensils', title: 'Utensils STL Pack', category: 'Home & Decor',
      blurb: 'Functional kitchen and household utensils to print.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'utensils.zip', image: 'img/stl/utensils.webp',
      tags: ['utensil', 'kitchen', 'household'] },
    { slug: 'miniatures', title: 'Miniatures STL Pack', category: 'Miniatures',
      blurb: 'Tabletop miniatures scaled for 28-32mm gaming.',
      priceGBP: 3.99, fileCount: 40, sizeMB: 0, r2Key: 'miniatures.zip', image: 'img/stl/miniatures.webp',
      tags: ['miniature', 'tabletop', '28mm', 'wargaming'] }
  ];

  // ── ALL-ACCESS PASS ────────────────────────────────────────
  // A single SKU that grants every pack (entitlement slug "*").
  const ALL_ACCESS = {
    slug: '*',
    title: 'All-Access Library Pass',
    blurb: 'Buy every pack on this page in one go — plus every pack added in the future. One payment, lifetime access.',
    priceGBP: 23.99,
    fullPriceGBP: 104
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

  /* List the packs the signed-in user owns.  -> { ok, ownsAll, slugs:[...] }
     Backend route: GET /api/stl/my-packs */
  async function myPacks() {
    try {
      var res = await _fetch(BACKEND + '/api/stl/my-packs', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data && data.ok) {
        return {
          ok: true,
          ownsAll: !!data.owns_all_access,
          slugs: (data.packs || []).map(function (p) { return p.slug; })
        };
      }
      return { ok: false, ownsAll: false, slugs: [] };
    } catch (e) {
      return { ok: false, ownsAll: false, slugs: [] };
    }
  }

  // ── Export ─────────────────────────────────────────────────
  window.STL_PACKS = STL_PACKS;
  window.STLMarket = {
    assetVersion: STL_PACK_ASSET_VERSION,
    packs: STL_PACKS,
    allAccess: ALL_ACCESS,
    getPack: getPack,
    categories: categories,
    formatPrice: formatPrice,
    formatSize: formatSize,
    checkout: checkout,
    download: download,
    myPacks: myPacks
  };
})();
