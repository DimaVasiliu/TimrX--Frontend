/* ==========================================================================
   TimrX Asset Stage — v0.2, rebuilt for the new overlay-driven workspace
   --------------------------------------------------------------------------
   Ships as 3dprint-modules/asset-stage.js. Mounts a single element into
   .ws-grid spanning every row, so the field reads as one composition behind
   the whole workspace rather than a box inside a pane.

   Motion budget: zero per-frame JS layout. Drift is CSS keyframes on the
   compositor; the only rAF work is writing two custom properties for pointer
   parallax, throttled to one write per frame.
   ========================================================================== */
(function(){
  'use strict';

  var BACKEND = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';

  var CFG = {
    FEED_URL      : BACKEND + '/api/_mod/inspire/feed',
    FEED_LIMIT    : 36,
    FEED_TIMEOUT  : 6000,
    CACHE_KEY     : 'timrx_inspire_cache_v3', // v3 contains curated, lineage-deduped assets
    SHUFFLE_MS    : 6800,
    SHUFFLE_COUNT : 2,
    PARALLAX_MAX  : 22,
    DENSITY       : 'cozy'
  };

  /* Spotlight is now opt-in. Bump the preference key so an older saved
     spotlight:true value cannot silently override the new first-visit state. */
  var SETTINGS_KEY = 'timrx_asset_stage_settings_v2';
  var MODE_PRESETS = {
    calm    : { density:'calm', ms:11000, count:1, parallax:14, still:false, spotlight:true },
    balanced: { density:'cozy', ms:6800,  count:2, parallax:22, still:false, spotlight:true },
    awe     : { density:'rich', ms:4300,  count:3, parallax:30, still:false, spotlight:true },
    still   : { density:'calm', ms:0,     count:0, parallax:0,  still:true,  spotlight:true }
  };
  var DEFAULT_SETTINGS = { mode:'balanced', type:'all', spotlight:false, controlsOpen:false };

  /* Depth tiers, tuned down from the old page: the new shell is hairline
     borders and muted surfaces, so the field rests quiet and earns contrast
     on hover instead of at rest. */
  var TIERS = [
    /* far  */ { s:0.54, o:0.32, blur:1.2, par:0.18, z:10, shy:10, shb:26 },
    /* mid  */ { s:0.84, o:0.60, blur:0.2, par:0.52, z:20, shy:16, shb:40 },
    /* near */ { s:1.26, o:0.92, blur:0.0, par:1.00, z:30, shy:26, shb:60 }
  ];
  var DRIFTS  = ['af-drift-a','af-drift-b','af-drift-c','af-drift-d'];
  var ASPECTS = { square:1, portrait:0.78, landscape:1.42 };

  var ICON = {
    model:'<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>',
    image:'<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 16l4.6-4.6a2 2 0 012.8 0L16 16M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    video:'<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 10l4.6-2.3A1 1 0 0121 8.6v6.8a1 1 0 01-1.4.9L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>'
  };

  var root, fieldEl, controlsEl, statusEl, pool = [], poolAll = [], slots = [], cursor = 0,
      shuffleTimer = null, rafId = null, pendingEvt = null,
      io = null, ro = null, resizeDeb = null, destroyed = false, still = false;
  var settings = readSettings();
  var sourceState = 'fallback';

  // ==================================================================== DATA
  /* Muted to the new palette — teal, sand, rose, gold. The old neon set read
     as a different product next to this shell. */
  var PALETTE = [
    ['#7fc8c2','#12211f'],['#d8c879','#211d10'],['#c9909b','#221416'],
    ['#b8a77a','#1d1a12'],['#8fb9c9','#121c21'],['#a9c98f','#161f13'],
    ['#c9a98f','#211a14'],['#9f9fc9','#16161f']
  ];
  var FALLBACK_PROMPTS = [
    'Crystal wyrm reliquary, translucent quartz scales with ember glow',
    'Retro-futurist deep sea dive helmet, brushed brass and copper valves',
    'Biomechanical fox mask, porcelain plates split by cobalt seams',
    'Modular lunar rover scout, matte titanium and amber utility lights',
    'Gothic reliquary lantern, blackened iron and stained ruby glass',
    'Art nouveau perfume bottle, frosted emerald glass, dragonfly stopper',
    'Desert scavenger drone, asymmetrical plates, sand-worn orange paint',
    'Alchemist field pack, stitched leather with hanging potion vials',
    'Cyber monk bust, luminous tattoo channels across ceramic plates',
    'Coral reef automaton, brass ribs threaded with living polyps'
  ];

  /* Real, bundled TimrX work used only while the public feed is unavailable
     or has no explicitly shared rows. These files ship with the workspace, so
     the landing stage never falls back to abstract placeholder geometry. */
  var BUNDLED_FALLBACKS = [
    { id:'repo-model-1', type:'model', thumbnail:'img/model-posters/mod1.png', glb_url:'vid/models/mod1.glb', prompt:'Detailed fantasy creature collectible with a clean game-ready silhouette', aspect:'square' },
    { id:'repo-model-2', type:'model', thumbnail:'img/model-posters/mod2.png', glb_url:'vid/models/mod2.glb', prompt:'Stylized character model prepared for a polished 3D workflow', aspect:'square' },
    { id:'repo-model-3', type:'model', thumbnail:'img/model-posters/mod3.png', glb_url:'vid/models/mod3.glb', prompt:'Production-ready sci-fi character with refined surface detail', aspect:'square' },
    { id:'repo-model-4', type:'model', thumbnail:'img/model-posters/mod4.png', glb_url:'vid/models/mod4.glb', prompt:'Ornate fantasy model built as a premium digital collectible', aspect:'square' },
    { id:'repo-model-5', type:'model', thumbnail:'img/model-posters/mod5.png', glb_url:'vid/models/mod5.glb', prompt:'Detailed creature sculpture with a strong printable silhouette', aspect:'square' },
    { id:'repo-model-6', type:'model', thumbnail:'img/model-posters/mod6.png', glb_url:'vid/models/mod6.glb', prompt:'Hero character asset with cinematic materials and proportions', aspect:'square' },
    { id:'repo-image-1', type:'image', thumbnail:'img/AI-img-gen-1.png', image_url:'img/AI-img-gen-1.png', prompt:'Cinematic AI concept artwork generated in TimrX', aspect:'portrait' },
    { id:'repo-image-2', type:'image', thumbnail:'img/AI-img-gen-2.png', image_url:'img/AI-img-gen-2.png', prompt:'Detailed editorial visual generated in TimrX', aspect:'portrait' },
    { id:'repo-image-3', type:'image', thumbnail:'img/AI-img-gen-3.png', image_url:'img/AI-img-gen-3.png', prompt:'Premium character artwork generated in TimrX', aspect:'portrait' },
    { id:'repo-image-4', type:'image', thumbnail:'img/AI-img-gen-4.png', image_url:'img/AI-img-gen-4.png', prompt:'Atmospheric production artwork generated in TimrX', aspect:'portrait' },
    { id:'repo-image-5', type:'image', thumbnail:'img/AI-img-gen-5.png', image_url:'img/AI-img-gen-5.png', prompt:'High-detail creative image generated in TimrX', aspect:'portrait' },
    { id:'repo-image-6', type:'image', thumbnail:'img/AI-img-gen-6%2019.07.03.png', image_url:'img/AI-img-gen-6%2019.07.03.png', prompt:'Polished AI visual generated in TimrX', aspect:'portrait' },
    { id:'repo-video-1', type:'video', thumbnail:'img/video-posters/vid1.jpg', video_url:'vid/vid1.mp4', prompt:'Cinematic motion study generated in TimrX', aspect:'portrait' },
    { id:'repo-video-2', type:'video', thumbnail:'img/video-posters/vid2.jpg', video_url:'vid/vid2.mp4', prompt:'Short-form AI video generated in TimrX', aspect:'portrait' },
    { id:'repo-video-3', type:'video', thumbnail:'img/video-posters/vid3.jpg', video_url:'vid/vid3.mp4', prompt:'Dynamic character sequence generated in TimrX', aspect:'portrait' },
    { id:'repo-video-4', type:'video', thumbnail:'img/video-posters/vid4.jpg', video_url:'vid/vid4.mp4', prompt:'Cinematic environment clip generated in TimrX', aspect:'portrait' },
    { id:'repo-video-5', type:'video', thumbnail:'img/video-posters/vid5.jpg', video_url:'vid/vid5.mp4', prompt:'Creative motion concept generated in TimrX', aspect:'portrait' },
    { id:'repo-video-6', type:'video', thumbnail:'img/video-posters/vid6.jpg', video_url:'vid/vid6.mp4', prompt:'Production-style AI video generated in TimrX', aspect:'portrait' }
  ];

  function svgTile(i){
    var p = PALETTE[i % PALETTE.length], a = p[0], b = p[1], u = 's'+i;
    var shape = [
      '<circle cx="160" cy="152" r="72" fill="url(#o'+u+')"/>'+
      '<circle cx="160" cy="152" r="72" fill="none" stroke="'+a+'" stroke-opacity=".4" stroke-width="1.4"/>'+
      '<ellipse cx="136" cy="124" rx="24" ry="17" fill="#fff" opacity=".2"/>',

      '<path d="M160 68 L224 134 L194 234 L126 234 L96 134 Z" fill="url(#o'+u+')"/>'+
      '<path d="M160 68 L224 134 L194 234 L126 234 L96 134 Z" fill="none" stroke="'+a+'" stroke-opacity=".45" stroke-width="1.4"/>'+
      '<path d="M160 68 L160 234 M96 134 L224 134" stroke="#fff" stroke-opacity=".14" stroke-width="1.1"/>',

      '<circle cx="160" cy="152" r="74" fill="none" stroke="url(#o'+u+')" stroke-width="32"/>'+
      '<circle cx="160" cy="152" r="90" fill="none" stroke="'+a+'" stroke-opacity=".3" stroke-width="1.2"/>'+
      '<circle cx="160" cy="152" r="58" fill="none" stroke="'+a+'" stroke-opacity=".3" stroke-width="1.2"/>',

      '<path d="M160 74 L228 112 L228 190 L160 228 L92 190 L92 112 Z" fill="url(#o'+u+')"/>'+
      '<path d="M160 74 L228 112 L160 150 L92 112 Z" fill="#fff" opacity=".12"/>'+
      '<path d="M160 150 L160 228 M92 112 L160 150 L228 112" stroke="'+a+'" stroke-opacity=".4" stroke-width="1.3" fill="none"/>'
    ][i % 4];

    var s =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">'+
        '<defs>'+
          '<linearGradient id="bg'+u+'" x1="0" y1="0" x2="0" y2="1">'+
            '<stop offset="0%" stop-color="'+b+'"/><stop offset="60%" stop-color="#0b0f10"/>'+
            '<stop offset="100%" stop-color="#07090a"/></linearGradient>'+
          '<radialGradient id="key'+u+'" cx="32%" cy="20%" r="70%">'+
            '<stop offset="0%" stop-color="'+a+'" stop-opacity=".26"/>'+
            '<stop offset="100%" stop-color="'+a+'" stop-opacity="0"/></radialGradient>'+
          '<radialGradient id="o'+u+'" cx="35%" cy="27%" r="76%">'+
            '<stop offset="0%" stop-color="#ffffff" stop-opacity=".8"/>'+
            '<stop offset="32%" stop-color="'+a+'"/><stop offset="100%" stop-color="'+b+'"/></radialGradient>'+
          '<radialGradient id="sh'+u+'" cx="50%" cy="50%" r="50%">'+
            '<stop offset="0%" stop-color="#000" stop-opacity=".8"/>'+
            '<stop offset="100%" stop-color="#000" stop-opacity="0"/></radialGradient>'+
          '<filter id="n'+u+'"><feTurbulence baseFrequency=".85" numOctaves="3"/>'+
            '<feColorMatrix values="0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 .1 0"/></filter>'+
        '</defs>'+
        '<rect width="320" height="320" fill="url(#bg'+u+')"/>'+
        '<rect width="320" height="320" fill="url(#key'+u+')"/>'+
        '<g stroke="'+a+'" stroke-opacity=".085" stroke-width="1">'+
          '<path d="M0 252 H320 M0 278 H320 M0 304 H320"/>'+
          '<path d="M48 240 L-16 320 M160 240 L160 320 M272 240 L336 320"/></g>'+
        '<ellipse cx="160" cy="250" rx="88" ry="18" fill="url(#sh'+u+')"/>'+
        shape+
        '<path d="M0 0 H320 V92 Q160 38 0 92 Z" fill="#fff" opacity=".03"/>'+
        '<rect width="320" height="320" filter="url(#n'+u+')" opacity=".5"/>'+
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);
  }

  function fallbackPool(){
    return BUNDLED_FALLBACKS.map(function(asset){
      return Object.assign({ _fallback:true }, asset);
    });
  }

  function normalize(cards){
    var seen = {};
    return (cards||[]).map(function(c){
      var payload = c.payload || c.meta || {};
      var modelUrls = c.model_urls || payload.model_urls || {};
      var texturedModelUrls = c.textured_model_urls || payload.textured_model_urls || {};
      var rawType = c.type || c.asset_type || c.kind || '';
      var modelUrl = c.glb_url || c.glb_proxy || c.model_url || c.modelUrl ||
        c.animation_glb_url || c.rigged_character_glb_url || c.stl_url ||
        modelUrls.glb || modelUrls.gltf || modelUrls.stl ||
        texturedModelUrls.glb || texturedModelUrls.gltf || texturedModelUrls.stl ||
        payload.glb_url || payload.glb_proxy || payload.model_url || c.url || '';
      var glbUrl = modelUrl;
      var videoUrl = c.video_url || c.videoUrl || '';
      var imageUrl = c.thumb_refined || c.image_url || c.imageUrl || c.url || '';
      var type = /vid/i.test(rawType) || videoUrl ? 'video' :
        /ima?g/i.test(rawType) || (imageUrl && !glbUrl) ? 'image' : 'model';
      return {
        id       : c.id,
        type     : type,
        thumbnail: c.thumb_preview || c.thumb_url || c.thumbnail || c.thumbnail_url || '',
        video_url: videoUrl,
        glb_url  : glbUrl,
        model_url: modelUrl,
        image_url: imageUrl,
        prompt   : c.prompt || c.title || '',
        title    : c.title || c.prompt || '',
        aspect   : c.aspect || 'square'
      };
    }).filter(function(c){
      if (!c.thumbnail) return false;
      var raw = c.glb_url || c.video_url || c.image_url || c.thumbnail || c.id || '';
      var key = String(raw).split('?')[0].split('#')[0].replace(/\/+$/,'').toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function readWarmCache(){
    try{
      var raw = localStorage.getItem(CFG.CACHE_KEY);
      if(!raw) return null;
      var o = JSON.parse(raw);
      var cards = normalize(o.cards || (o.data && o.data.cards));
      return cards.length ? cards : null;
    }catch(e){ return null; }
  }

  function saveWarmCache(cards){
    try{
      localStorage.setItem(CFG.CACHE_KEY, JSON.stringify({ cards:cards, ts:Date.now() }));
    }catch(e){}
  }

  function readSettings(){
    try{
      var raw = localStorage.getItem(SETTINGS_KEY);
      if(!raw) return Object.assign({}, DEFAULT_SETTINGS);
      var parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_SETTINGS, parsed || {});
    }catch(e){ return Object.assign({}, DEFAULT_SETTINGS); }
  }

  function saveSettings(){
    try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
  }

  function filterPool(cards){
    var type = settings.type || 'all';
    if (type === 'all') return cards.slice();
    /* Was: fall back to the whole set when a type had no matches, which meant
       picking "Video" on a feed with no video silently showed everything and
       the filter looked broken. Return the empty set and let the zones
       collapse — build() widens the remaining ones. */
    return cards.filter(function(card){ return card.type === type; });
  }

  /* ---------------------------------------------------------------- zones ---
     The stage is one composition made of three zones, each with its own
     grammar:

       reel  (left)   videos   — a film strip running on a loop
       core  (centre) models   — organic scatter with depth, pushed by the
                                 thought engine (hero-sequence.js)
       sheet (right)  images   — a photographer's contact sheet, counter-drifting

     Before this the three types were shuffled into one farthest-point sample,
     so position carried no meaning at all. Grouping is the whole point: you
     can find the video wall without reading a single chip.

     ZONE_SIDE decides which rail gets which type. Swap the two values to
     mirror the stage. */
  var ZONE_SIDE = { video:'left', image:'right' };

  function splitPools(cards){
    var out = { video:[], image:[], model:[] };
    (cards || []).forEach(function(c){
      if (out[c.type]) out[c.type].push(c);
    });
    return out;
  }

  /* Rails only earn their space when they have enough to look deliberate. One
     lonely video in a film strip reads as a bug, so below the floor the type
     falls back into the centre scatter and the centre takes the width. */
  var REEL_MIN = 3;
  var SHEET_MIN = 6;

  function zoneGeometry(groups, w){
    var narrow  = w < 1080;
    var hasReel  = !narrow && groups.video.length >= REEL_MIN;
    var hasSheet = !narrow && groups.image.length >= SHEET_MIN;
    /* Rails are a fraction of the stage, clamped so they never become a
       thumbnail strip on a small laptop or a wall on an ultrawide. */
    var railW = Math.max(0.145, Math.min(0.215, 210 / Math.max(1, w)));

    /* The core band is ALWAYS symmetric about the centre line.
       It used to inset only the sides that actually had a rail, so a stage with
       one rail put the model field at 0.18–0.96 — centred on 0.57, visibly
       shoved to one side. The models sit around the thought engine, which types
       itself at dead centre, so the band they live in has to be centred too.
       The empty side keeps the same inset and simply reads as breathing room. */
    var inset = Math.max(
      hasReel  ? 0.035 + railW : 0.04,
      hasSheet ? 0.035 + railW : 0.04
    );

    return {
      reel : hasReel  ? { x0:0.012, x1:0.012 + railW } : null,
      sheet: hasSheet ? { x0:0.988 - railW, x1:0.988 } : null,
      core : { x0: inset, x1: 1 - inset },
      hasReel:hasReel, hasSheet:hasSheet, narrow:narrow
    };
  }

  /* ------------------------------------------------- even mass in the core ---
     Tier drives size, opacity and blur; `is-travelling` sends a card on a long
     journey in from the back, where it spends most of its cycle small and dim.
     Both used to be position-blind — tier from a hash of the grid cell index,
     travel from a bare Math.random() per card — so the big bright cards and the
     faded ones could all land on the same side. The POSITIONS were evenly
     spread the whole time; the visual weight was not, and that is what reads as
     "the models are bunched over there".

     Deal both per column instead: split the band into COLS buckets and give
     every bucket the same mix. Near tier still prefers the vertical middle of
     its own bucket, because the top and bottom of the band sit under the
     creation dock and the command bar and a big card there is only ever seen
     as a fading sliver. */
  function balanceCore(spots, band){
    var COLS = 5;
    var x0 = band.x0, w = Math.max(1e-6, band.x1 - band.x0);
    var buckets = [];
    for (var i = 0; i < COLS; i++) buckets.push([]);

    spots.forEach(function(s){
      var b = Math.min(COLS - 1, Math.max(0, Math.floor(((s.x - x0) / w) * COLS)));
      buckets[b].push(s);
    });

    buckets.forEach(function(list){
      // Most vertically central first — the near tier belongs where it can be
      // seen whole.
      list.sort(function(a, b){ return Math.abs(a.y - 0.5) - Math.abs(b.y - 0.5); });
      var near = list.length ? Math.max(1, Math.round(list.length * 0.34)) : 0;
      var mid  = Math.round(list.length * 0.40);
      list.forEach(function(s, k){
        s.tier   = k < near ? 2 : k < near + mid ? 1 : 0;
        // Every other non-near card in each column travels, so no side of the
        // field ever dims out by luck.
        s.travel = s.tier < 2 && (k % 2 === 1);
      });
    });
    return spots;
  }

  function setSourceState(v){
    sourceState = v;
    if (root) root.dataset.source = v;
    if (statusEl){
      statusEl.textContent = v === 'platform' ? 'Platform live' :
        v === 'cache' ? 'Cached platform' : 'Fallback visuals';
    }
  }

  function applySettings(opts){
    var preset = MODE_PRESETS[settings.mode] || MODE_PRESETS.balanced;
    CFG.DENSITY = preset.density;
    CFG.SHUFFLE_MS = preset.ms;
    CFG.SHUFFLE_COUNT = preset.count;
    CFG.PARALLAX_MAX = preset.parallax;
    if (root){
      root.dataset.mode = settings.mode;
      root.dataset.filter = settings.type;
      root.classList.toggle('af--spotlight', !!settings.spotlight && !!preset.spotlight);
    }
    pool = filterPool(poolAll.length ? poolAll : fallbackPool());
    setStill(!!preset.still);
    stopMotion();
    if (!preset.still && preset.ms) startMotion();
    if (!opts || !opts.skipBuild) build();
    updateControls();
  }

  function fetchFeed(forceType){
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var t = setTimeout(function(){ if (ctl) ctl.abort(); }, CFG.FEED_TIMEOUT);
    var type = forceType || settings.type || 'all';
    var url = CFG.FEED_URL + '?surface=workspace&type=' + encodeURIComponent(type) + '&mix=balanced&shuffle=true&limit=' + CFG.FEED_LIMIT;
    return fetch(url, ctl ? { signal: ctl.signal, credentials:'include' } : { credentials:'include' })
      .then(function(r){
        if(!r.ok) throw new Error('HTTP '+r.status);
        if((r.headers.get('content-type')||'').indexOf('json') === -1) throw new Error('non-JSON feed');
        return r.json();
      })
      .then(function(d){
        var cards = normalize(d.cards);
        if(!cards.length) throw new Error('empty feed');
        saveWarmCache(cards);
        return cards;
      })
      .then(function(v){ clearTimeout(t); return v; },
            function(e){ clearTimeout(t); throw e; });
  }

  // ================================================================== LAYOUT
  function rnd(seed){ var x = Math.sin(seed*12.9898)*43758.5453; return x - Math.floor(x); }

  /* No headline keep-out on this page — the stage is genuinely empty, so the
     composition uses the whole area. Over-generate a jittered grid, then
     farthest-point sample; a random subset leaves visible dead zones. */
  /* On a tall, narrow stage the creation dock stacks into one column and eats
     the top ~40%, so the usable band is only what is left underneath. Spreading
     over the full height there just parks cards under the mask. */
  function bandFor(w,h){
    return (w / Math.max(1,h)) < 0.90 ? { y0:0.40, y1:0.98 } : { y0:0.03, y1:0.97 };
  }

  function layout(count, w, h, xBand){
    var band = bandFor(w,h);
    var bh = h * (band.y1 - band.y0);
    var aspect = w / Math.max(1,bh);
    var over = count * 1.9;
    var cols = Math.max(3, Math.round(Math.sqrt(over * aspect)));
    var rows = Math.max(3, Math.ceil(over / cols));
    var cells = [];
    for (var r=0;r<rows;r++){
      for (var c=0;c<cols;c++){
        var i = r*cols + c;
        var ny = (r + .5 + (rnd(i+7.3) - .5) * 0.66) / rows;
        cells.push({
          i:i, k:rnd(i+13.7),
          x:(c + .5 + (rnd(i+1)   - .5) * 0.66) / cols,
          y:band.y0 + ny * (band.y1 - band.y0)
        });
      }
    }

    var chosen = [], pickIdx = 0;
    for (var s=1;s<cells.length;s++) if (cells[s].k > cells[pickIdx].k) pickIdx = s;
    if (!cells.length) return [];
    chosen.push(cells.splice(pickIdx,1)[0]);
    while (chosen.length < count && cells.length){
      var best = 0, bestD = -1;
      for (var m=0;m<cells.length;m++){
        var md = Infinity;
        for (var n=0;n<chosen.length;n++){
          var dx = cells[m].x - chosen[n].x, dy = cells[m].y - chosen[n].y;
          var dd = dx*dx + dy*dy;
          if (dd < md) md = dd;
        }
        if (md > bestD){ bestD = md; best = m; }
      }
      chosen.push(cells.splice(best,1)[0]);
    }

    var mid0 = (band.y0 + band.y1) / 2, half = (band.y1 - band.y0) / 2;
    /* The sample runs in unit space; xBand remaps it into the zone's own
       column so the centre scatter never wanders under a rail. */
    var xa = xBand ? xBand.x0 : 0.05;
    var xb = xBand ? xBand.x1 : 0.95;
    return chosen.map(function(c){
      /* Bias the near tier toward the middle of the band: its top and bottom
         are masked out under the dock and the command bar, so a big card there
         would only ever be seen as a fading sliver. */
      var mid  = 1 - Math.min(1, Math.abs(c.y - mid0) / half);
      var roll = rnd(c.i+3.1);
      var tier = roll < 0.30 + mid * 0.34 ? 2 : roll < 0.72 ? 1 : 0;
      return { x:xa + Math.max(0,Math.min(1,c.x)) * (xb - xa),
               y:Math.max(0.04,Math.min(0.96,c.y)), tier:tier, seed:c.i };
    });
  }

  /* Density from the CONTAINER, not the viewport — the stage is the full grid
     and its height changes with the header, dock and command bar. */
  function densityFor(w, h, mode){
    var base;
    if      (w < 480)  base = 12;
    else if (w < 760)  base = 15;
    else if (w < 1100) base = 18;
    else if (w < 1500) base = 22;
    else               base = 26;
    if (h < 460) base = Math.round(base * 0.72);
    if (mode === 'calm') base = Math.round(base * 0.62);
    if (mode === 'rich') base = Math.round(base * 1.4);
    return Math.max(5, Math.min(38, base));
  }

  function baseCardWidth(w, h, count){
    var band = bandFor(w,h);
    /* size against the band actually used, not the full stage — otherwise the
       mobile cards come out desktop-sized and overlap into a pile */
    var per = Math.sqrt((w * h * (band.y1 - band.y0)) / Math.max(1,count));
    /* Larger by design: the field is the page's hero, and at the old 215px cap
       a 3D model read as a thumbnail rather than a piece of work. */
    return Math.max(w < 560 ? 92 : 118, Math.min(330, per * 0.80));
  }

  // ================================================================== RENDER
  function esc(s){
    return String(s||'').replace(/[&<>"]/g,function(m){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; });
  }

  /* Aspect per zone. The reel is a film strip, so every frame is the same
     portrait cell or the perforations stop lining up; the contact sheet keeps
     each image's own shape because that is what a contact sheet is. */
  function aspectFor(asset, zone){
    if (zone === 'reel') return 0.5625;                 // 9:16
    return ASPECTS[asset.aspect] || 1;
  }

  function fillCard(btn, asset, zone){
    var t = asset.type;
    btn.style.setProperty('--ar', aspectFor(asset, zone));
    btn.setAttribute('aria-label',
      (t==='video'?'Video':t==='image'?'Image':'3D model')+': '+(asset.prompt||'Untitled creation'));
    btn.dataset.assetId = asset.id;
    btn.dataset.assetType = t;

    var extra = '';
    /* Model cards get the same studio floor the fallback tiles draw into
       their SVG — a perspective grid the object appears to stand on. Images
       and videos are captures of a scene and already have their own ground;
       a 3D model is an object in a void and reads as floating without it. */
    if (t === 'model') extra += '<span class="af__floor" aria-hidden="true"></span>';
    /* Play affordance follows the ASSET, not the zone. When a feed has too few
       videos to earn the reel they fall back into the centre scatter, and
       keying this on the zone left those cards as dead stills that still said
       "video" on the chip. */
    if (t === 'video'){
      extra += '<span class="af__play" aria-hidden="true">' +
                 '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="9 6 18 12 9 18"/></svg>' +
               '</span>';
    }
    /* The projector-lamp sweep is film-strip flavour, so it stays reel-only. */
    if (zone === 'reel') extra += '<span class="af__scan" aria-hidden="true"></span>';
    /* Contact-sheet frames carry a sheet number, like a real proof sheet. */
    if (zone === 'sheet'){
      extra += '<span class="af__frameno" aria-hidden="true">' +
               String((btn.dataset.frameNo || '1')).padStart(2,'0') + '</span>';
    }

    btn.innerHTML =
      '<img src="'+esc(asset.thumbnail)+'" alt="" loading="lazy" decoding="async"/>'+
      extra+
      '<span class="af__chip is-'+t+'">'+ICON[t]+'<span>'+t+'</span></span>'+
      '<span class="af__cap">'+esc(asset.prompt||'Untitled creation')+'</span>';
    btn.firstChild.addEventListener('error', function(){
      var s = btn.closest('.af__slot'); if (s) s.style.display = 'none';
    }, { once:true });
  }

  /* ------------------------------------------------------- reel playback ---
     A wall of stills where the one you touch comes alive.

     The <video> is attached on hover and torn down on leave. Attaching all of
     them up front would pull dozens of media files for a background field —
     the poster is the resting state and the motion is the reward for pointing
     at it. */
  var activeReelVideo = null;

  function stopReelPreview(){
    if (!activeReelVideo) return;
    var v = activeReelVideo;
    activeReelVideo = null;
    try { v.pause(); } catch(e){}
    v.removeAttribute('src');
    v.load && v.load();
    v.remove();
  }

  function startReelPreview(btn, asset){
    if (!asset || !asset.video_url) return;
    if (still || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stopReelPreview();

    var v = document.createElement('video');
    v.className = 'af__vid';
    v.muted = true; v.loop = true; v.playsInline = true;
    v.setAttribute('muted',''); v.setAttribute('playsinline','');
    v.preload = 'metadata';
    v.src = asset.video_url;
    v.addEventListener('canplay', function(){ v.classList.add('is-ready'); }, { once:true });
    btn.appendChild(v);
    activeReelVideo = v;
    var p = v.play();
    if (p && p.catch) p.catch(function(){ /* autoplay refused — poster stays */ });
  }

  // ---------------------------------------------------------- zone builders
  function makeSlot(zone, asset, opts){
    var slot = document.createElement('div');
    slot.className = 'af__slot af__slot--' + zone;
    slot.dataset.afZone = zone;

    var flo = document.createElement('div');
    flo.className = 'af__float';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'af__card';
    if (opts && opts.frameNo != null) btn.dataset.frameNo = opts.frameNo;
    fillCard(btn, asset, zone);

    flo.appendChild(btn);
    slot.appendChild(flo);
    return { el:slot, btn:btn, zone:zone, asset:asset };
  }

  /* LEFT — the video reel.
     One column of identical frames running upward forever. The track holds the
     frames twice; animating it to -50% and looping makes the seam invisible,
     so there is no JS in the motion path at all. Hover pauses the whole strip
     (CSS animation-play-state) so the frame you reached for stops coming to
     you — that pause is what makes it feel like an object rather than a video. */
  function buildReel(videos, geom, w, h){
    if (!geom.reel || !videos.length) return [];

    var zone = document.createElement('div');
    zone.className = 'af-zone af-zone--reel';
    zone.style.setProperty('--zx0', (geom.reel.x0 * 100).toFixed(2) + '%');
    zone.style.setProperty('--zw',  ((geom.reel.x1 - geom.reel.x0) * 100).toFixed(2) + '%');

    var track = document.createElement('div');
    track.className = 'af-reel__track';
    /* Slower for a long strip: the frames should pass, not race. */
    var n = Math.min(videos.length, 7);
    track.style.setProperty('--reel-dur', (n * 7.5).toFixed(1) + 's');

    var made = [];
    for (var pass = 0; pass < 2; pass++){
      for (var i = 0; i < n; i++){
        var rec = makeSlot('reel', videos[i % videos.length]);
        /* Hand-placed, not CSS-grid rigid: alternate a hair left and right. */
        rec.el.style.setProperty('--nudge', (i % 2 ? 6 : -6) + 'px');
        rec.el.style.setProperty('--tilt', (i % 2 ? 0.9 : -0.9) + 'deg');
        if (pass === 1){
          rec.el.setAttribute('aria-hidden', 'true');
          rec.el.dataset.afClone = '1';
        }
        track.appendChild(rec.el);
        if (pass === 0) made.push(rec);
      }
    }

    zone.appendChild(track);
    var sprock = document.createElement('span');
    sprock.className = 'af-reel__sprockets';
    sprock.setAttribute('aria-hidden','true');
    zone.appendChild(sprock);

    var label = document.createElement('span');
    label.className = 'af-zone__label';
    label.setAttribute('aria-hidden','true');
    label.textContent = 'Video';
    zone.appendChild(label);

    fieldEl.appendChild(zone);
    return made;
  }

  /* RIGHT — the contact sheet.
     Two staggered columns drifting the opposite way to the reel. The counter
     motion is the point: the stage reads as one composition with an internal
     current rather than as three lists that happen to sit side by side. */
  function buildSheet(images, geom, w, h){
    if (!geom.sheet || !images.length) return [];

    var zone = document.createElement('div');
    zone.className = 'af-zone af-zone--sheet';
    zone.style.setProperty('--zx0', (geom.sheet.x0 * 100).toFixed(2) + '%');
    zone.style.setProperty('--zw',  ((geom.sheet.x1 - geom.sheet.x0) * 100).toFixed(2) + '%');

    var COLS = 2;
    var total = Math.min(8, images.length);
    var made = [], idx = 0;

    for (var c = 0; c < COLS; c++){
      var col = document.createElement('div');
      col.className = 'af-sheet__col';
      /* Run the second column slower and start it mid-cycle, so the two never
         march in step. A negative animation-delay is the offset — a static
         transform would just be overwritten by the animation. */
      var start = Math.ceil(total / COLS) * c;
      var per = Math.min(Math.ceil(total / COLS), Math.max(0, total - start));
      if (!per) continue;
      var dur = per * (c ? 11.5 : 9.5);
      col.style.setProperty('--sheet-dur', dur.toFixed(1) + 's');
      col.style.animationDelay = (-dur * (c ? 0.42 : 0)).toFixed(1) + 's';

      for (var pass = 0; pass < 2; pass++){
        for (var i = 0; i < per; i++){
          var assetIndex = start + i;
          var asset = images[assetIndex];
          var rec = makeSlot('sheet', asset, { frameNo: (assetIndex + 1) });
          rec.el.style.setProperty('--tilt', (((i + c) % 2) ? 0.7 : -0.7) + 'deg');
          if (pass === 1){
            rec.el.setAttribute('aria-hidden','true');
            rec.el.dataset.afClone = '1';
          }
          col.appendChild(rec.el);
          if (pass === 0){ made.push(rec); idx++; }
        }
      }
      zone.appendChild(col);
    }

    var label = document.createElement('span');
    label.className = 'af-zone__label';
    label.setAttribute('aria-hidden','true');
    label.textContent = 'Images';
    zone.appendChild(label);

    fieldEl.appendChild(zone);
    return made;
  }

  /* CENTRE — models, unchanged in spirit.
     Organic scatter, three depth tiers, drift keyframes, and the only zone the
     thought engine pushes (hero-sequence.js filters on data-af-zone="core"). */
  function buildCore(models, geom, w, h){
    if (!models.length) return [];

    var zone = document.createElement('div');
    zone.className = 'af-zone af-zone--core';

    var count = Math.min(densityFor(w, h, CFG.DENSITY), models.length);
    if (geom.hasReel)  count = Math.round(count * 0.8);
    if (geom.hasSheet) count = Math.round(count * 0.8);
    count = Math.max(1, count);

    var spots = balanceCore(layout(count, w, h, geom.core), geom.core);
    var bw    = baseCardWidth(w, h, count) * (geom.hasReel && geom.hasSheet ? 0.92 : 1);

    var heroIndex = -1, heroScore = -1;
    if (settings.spotlight && (MODE_PRESETS[settings.mode] || MODE_PRESETS.balanced).spotlight){
      spots.forEach(function(sp, i){
        var dx = sp.x - .5, dy = sp.y - .52;
        var score = (sp.tier * 2) - Math.sqrt(dx*dx + dy*dy);
        if (score > heroScore){ heroScore = score; heroIndex = i; }
      });
    }

    var made = spots.map(function(sp, i){
      var tier = TIERS[sp.tier], asset = models[i % models.length];
      var rec  = makeSlot('core', asset);
      var slot = rec.el;

      if (i === heroIndex) slot.classList.add('is-hero');
      slot.style.setProperty('--x', (sp.x*100).toFixed(2)+'%');
      slot.style.setProperty('--y', (sp.y*100).toFixed(2)+'%');
      slot.style.setProperty('--w', Math.round(bw * tier.s)+'px');
      slot.style.setProperty('--o', tier.o);
      slot.style.setProperty('--blur', tier.blur+'px');
      slot.style.setProperty('--par', tier.par);
      slot.style.setProperty('--z', tier.z);

      var flo = slot.firstChild;
      flo.style.setProperty('--drift', DRIFTS[Math.floor(rnd(sp.seed+11)*DRIFTS.length)]);
      flo.style.setProperty('--dur', (8 + rnd(sp.seed+21)*10).toFixed(2)+'s');
      flo.style.setProperty('--delay', '-'+(rnd(sp.seed+31)*14).toFixed(2)+'s');

      /* Depth travel: part of the field makes the journey in from the back,
         each with its own duration and phase so the approaches never sync up
         into a pulse. Skipped for the near tier — a card already at the front
         has nowhere to come from. WHICH cards travel is decided by balanceCore
         per column, not by a coin flip here, so the dimming is spread evenly
         across the band. */
      if (sp.travel) {
        slot.classList.add('is-travelling');
        slot.style.setProperty('--travel', (38 + Math.random() * 34).toFixed(1) + 's');
        // Negative delay starts each card mid-journey, so they are already
        // spread through the cycle instead of all departing together.
        slot.style.setProperty('--travel-delay', (-Math.random() * 40).toFixed(1) + 's');
      }
      rec.btn.style.setProperty('--shy', tier.shy+'px');
      rec.btn.style.setProperty('--shb', tier.shb+'px');

      zone.appendChild(slot);
      rec.spot = sp;
      return rec;
    });

    fieldEl.appendChild(zone);
    return made;
  }

  function build(){
    if (destroyed || !fieldEl || !root) return;
    var w = root.clientWidth, h = root.clientHeight;
    if (!w || !h) return;

    /* The grid box can run past the bottom of the viewport (see --af-overflow
       in asset-stage.css). Measure it so the bottom fade is anchored to what
       the user can actually see, not to the grid's nominal height. */
    var rect = root.getBoundingClientRect();
    var over = Math.max(0, Math.round(rect.bottom - (window.innerHeight || rect.bottom)));
    root.style.setProperty('--af-overflow', over + 'px');

    stopReelPreview();

    var groups = splitPools(pool);
    var geom   = zoneGeometry(groups, w);

    /* Types that did not earn a rail fall back into the centre scatter, so a
       feed of nothing but images still fills the stage instead of leaving two
       thirds of it empty. */
    var corePool = [];
    if (geom.narrow) {
      var compactCount = Math.max(groups.model.length, groups.video.length, groups.image.length);
      for (var compactIndex = 0; compactIndex < compactCount; compactIndex++) {
        if (groups.model[compactIndex]) corePool.push(groups.model[compactIndex]);
        if (groups.video[compactIndex]) corePool.push(groups.video[compactIndex]);
        if (groups.image[compactIndex]) corePool.push(groups.image[compactIndex]);
      }
    } else {
      corePool = groups.model.slice();
      if (!geom.hasReel)  corePool = corePool.concat(groups.video);
      if (!geom.hasSheet) corePool = corePool.concat(groups.image);
    }
    if (!corePool.length) corePool = pool.slice();

    root.classList.toggle('af--has-reel',  !!geom.hasReel);
    root.classList.toggle('af--has-sheet', !!geom.hasSheet);
    root.dataset.reelSide  = ZONE_SIDE.video;
    root.dataset.sheetSide = ZONE_SIDE.image;

    fieldEl.textContent = '';
    slots = []
      .concat(buildReel(groups.video, geom, w, h))
      .concat(buildCore(corePool, geom, w, h))
      .concat(buildSheet(groups.image, geom, w, h));

    requestAnimationFrame(function(){ root.style.setProperty('--af-in','1'); });
  }

  // ================================================================= SHUFFLE
  /* A slot only ever receives an asset of its own type.
     The old shuffle drew from the whole pool, so a video could land in a model
     slot mid-cycle and the grouping would dissolve within a minute of being
     built. Each zone now draws from its own list. */
  var zoneCursor = { reel:0, core:0, sheet:0 };

  function poolForSlot(s){
    var groups = splitPools(pool);
    if (s.zone === 'reel')  return groups.video;
    if (s.zone === 'sheet') return groups.image;
    var core = groups.model.slice();
    if (!root || !root.classList.contains('af--has-reel'))  core = core.concat(groups.video);
    if (!root || !root.classList.contains('af--has-sheet')) core = core.concat(groups.image);
    return core.length ? core : pool;
  }

  function swapSlot(s){
    if (destroyed || !s || !s.el || !s.el.isConnected) return;
    var list = poolForSlot(s);
    if (!list.length) return;
    var occupied = {};
    slots.forEach(function(slot){
      if (slot !== s && slot.zone === s.zone && slot.asset) occupied[String(slot.asset.id)] = true;
    });
    var next = null;
    for (var attempt=0; attempt<list.length; attempt++){
      zoneCursor[s.zone] = (zoneCursor[s.zone] + 1) % list.length;
      var candidate = list[zoneCursor[s.zone]];
      if (!occupied[String(candidate.id)]) { next = candidate; break; }
    }
    if (!next) return;
    s.asset = next;
    fillCard(s.btn, next, s.zone);

    /* Only the centre re-jitters. The rails are compositions — nudging a film
       frame out of its column is exactly the chaos this replaced. */
    if (s.zone === 'core' && s.spot){
      var nx = Math.max(0.02, Math.min(0.98, s.spot.x + (Math.random()-.5)*0.05));
      var ny = Math.max(0.06, Math.min(0.94, s.spot.y + (Math.random()-.5)*0.05));
      s.spot.x = nx; s.spot.y = ny;
      s.el.style.setProperty('--x',(nx*100).toFixed(2)+'%');
      s.el.style.setProperty('--y',(ny*100).toFixed(2)+'%');
    }
  }

  /* Live core slots, resolved fresh every time.
     A shuffle spans ~800ms (a stagger, then a 450ms fade), and build() replaces
     every .af__slot — the feed arriving calls it, and so does the
     ResizeObserver on any layout change. Holding slot records across that delay
     meant the swap landed on detached nodes and silently did nothing, which is
     precisely how the shuffle came to look broken. Never cache them. */
  function liveCoreSlots(){
    return slots.filter(function(s){
      return s && s.zone === 'core' && s.el && s.el.isConnected;
    });
  }

  function shuffleTick(){
    if (destroyed || still || document.hidden || !slots.length || !pool.length) return;
    /* The reel and the sheet are already in motion on their own loops; swapping
       their contents underneath a running marquee reads as a glitch. Only the
       centre shuffles on the timer. */
    var n = Math.min(window.innerWidth < 760 ? 1 : CFG.SHUFFLE_COUNT, liveCoreSlots().length);
    for (var k=0;k<n;k++){
      setTimeout(function(){
        if (destroyed || still) return;
        // Re-resolve here, not at schedule time.
        var live = liveCoreSlots();
        if (!live.length) return;
        var s = live[Math.floor(Math.random()*live.length)];
        s.el.classList.add('is-swapping');
        setTimeout(function(){
          // Rebuilt mid-fade: the new field is already showing fresh cards, so
          // there is nothing to swap and nothing to clean up.
          if (destroyed || !s.el.isConnected) return;
          swapSlot(s);
          s.el.classList.remove('is-swapping');
        }, 450);
      }, k * 340);
    }
  }

  // ================================================================ CONTROLS
  function controlButton(group, value, label){
    var active = (group === 'mode' ? settings.mode : settings.type) === value;
    return '<button type="button" class="af-settings__choice'+(active?' is-active':'')+
      '" data-af-'+group+'="'+value+'">'+label+'</button>';
  }

  function updateControls(){
    if (!controlsEl) return;
    controlsEl.classList.toggle('is-open', !!settings.controlsOpen);
    var modeBtns = controlsEl.querySelectorAll('[data-af-mode]');
    modeBtns.forEach(function(btn){ btn.classList.toggle('is-active', btn.dataset.afMode === settings.mode); });
    var typeBtns = controlsEl.querySelectorAll('[data-af-type]');
    typeBtns.forEach(function(btn){ btn.classList.toggle('is-active', btn.dataset.afType === settings.type); });
    var spot = controlsEl.querySelector('[data-af-spotlight]');
    if (spot){
      spot.classList.toggle('is-active', !!settings.spotlight);
      spot.setAttribute('aria-pressed', settings.spotlight ? 'true' : 'false');
    }
    var toggle = controlsEl.querySelector('[data-af-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', settings.controlsOpen ? 'true' : 'false');
    setSourceState(sourceState);
  }

  function closeControls(){
    if (!settings.controlsOpen) return;
    settings.controlsOpen = false;
    saveSettings();
    updateControls();
  }

  function onDocumentPointerDown(e){
    if (!settings.controlsOpen || !controlsEl) return;
    if (controlsEl.contains(e.target)) return;
    closeControls();
  }

  function onDocumentKeyDown(e){
    if (e.key === 'Escape') closeControls();
  }

  /* Side controls.
     The field reshuffles on a timer, which is ambient but gives the viewer no
     way to say "not this — show me something else". Two edge buttons make that
     explicit: one cycles a few cards, the other rebuilds the whole field. */
  function buildSideRail(){
    if (!root || root.querySelector('.af-rail')) return;

    function mk(side, label, path, onClick){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'af-rail af-rail--' + side;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
                    'aria-hidden="true">' + path + '</svg>';
      b.addEventListener('click', function(e){
        e.stopPropagation();
        b.classList.remove('is-spun');
        void b.offsetWidth;          // restart the spin on repeat presses
        b.classList.add('is-spun');
        onClick();
      });
      root.appendChild(b);
      return b;
    }

    // left: swap a handful of cards
    mk('prev', 'Shuffle a few creations',
       '<path d="M3 8h13l-3.5-3.5M21 16H8l3.5 3.5"/>',
       function(){ shuffleTick(); });

    // right: rebuild the entire field
    mk('next', 'Reshuffle the whole field',
       '<path d="M21 12a9 9 0 11-3.2-6.9M21 3v5h-5"/>',
       function(){ reshuffleAll(); });
  }

  /* Rebuild every slot with a staggered fade so the change reads as a deck
     being dealt rather than a repaint. `slots` holds { el, btn, zone, ... }
     records, not elements — an early version treated them as nodes and threw
     on the first press.

     There used to be a SECOND reshuffleAll declared above shuffleTick; the two
     coexisted for a while and only this one ever ran, because a later function
     declaration wins. The dead one is gone. */
  function reshuffleAll(){
    if (destroyed || !slots.length || !pool.length) return;
    if (root) root.classList.add('af--dealing');
    stopReelPreview();

    slots.forEach(function(s, i){
      if (!s || !s.el) return;
      s.el.style.setProperty('--deal', (i % 12) * 40 + 'ms');
      s.el.classList.add('is-swapping');
    });

    setTimeout(function(){
      // Same rule as shuffleTick: re-read `slots` after the fade rather than
      // closing over the records, so a rebuild in between cannot leave the
      // field faded out with nothing swapped.
      if (destroyed) return;
      slots.forEach(function(s){
        if (!s || !s.el || !s.el.isConnected) return;
        swapSlot(s);
        s.el.classList.remove('is-swapping');
      });
      setTimeout(function(){ if (root) root.classList.remove('af--dealing'); }, 700);
    }, 340);
  }

  function buildControls(){
    if (!root || controlsEl) return;
    controlsEl = document.createElement('div');
    controlsEl.className = 'af-settings';
    controlsEl.innerHTML =
      '<button type="button" class="af-settings__toggle" data-af-toggle aria-label="Asset stage settings" aria-expanded="false">'+
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'+
          '<path d="M4 14.5c2.6-4.4 5.2-6.6 8-6.6s5.4 2.2 8 6.6"/>'+
          '<path d="M8 14.5a4 4 0 108 0"/>'+
          '<path d="M12 4v2.2M4.9 7.1l1.6 1.6M19.1 7.1l-1.6 1.6"/>'+
        '</svg>'+
      '</button>'+
      '<section class="af-settings__panel" aria-label="Asset stage controls">'+
        '<div class="af-settings__head"><span>Asset stage</span><strong data-af-status>Fallback visuals</strong></div>'+
        '<div class="af-settings__row"><span>Shuffle</span><div class="af-settings__choices">'+
          controlButton('mode','calm','Calm')+
          controlButton('mode','balanced','Balanced')+
          controlButton('mode','awe','Awe')+
          controlButton('mode','still','Still')+
        '</div></div>'+
        '<div class="af-settings__row"><span>Assets</span><div class="af-settings__choices">'+
          controlButton('type','all','All')+
          controlButton('type','model','Models')+
          controlButton('type','image','Images')+
          controlButton('type','video','Video')+
        '</div></div>'+
        '<div class="af-settings__foot">'+
          '<button type="button" class="af-settings__soft" data-af-spotlight aria-pressed="false">Spotlight</button>'+
          '<button type="button" class="af-settings__soft" data-af-refresh>Refresh feed</button>'+
        '</div>'+
      '</section>';
    statusEl = controlsEl.querySelector('[data-af-status]');
    (root.parentElement || root).appendChild(controlsEl);

    controlsEl.addEventListener('click', function(e){
      var toggle = e.target.closest('[data-af-toggle]');
      if (toggle){
        settings.controlsOpen = !settings.controlsOpen;
        saveSettings(); updateControls();
        return;
      }
      var mode = e.target.closest('[data-af-mode]');
      if (mode){
        settings.mode = mode.dataset.afMode;
        saveSettings(); applySettings();
        return;
      }
      var type = e.target.closest('[data-af-type]');
      if (type){
        settings.type = type.dataset.afType;
        saveSettings(); refreshFeed();
        return;
      }
      var spot = e.target.closest('[data-af-spotlight]');
      if (spot){
        settings.spotlight = !settings.spotlight;
        saveSettings(); applySettings();
        return;
      }
      if (e.target.closest('[data-af-refresh]')) refreshFeed(true);
    });
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown);
    updateControls();
  }

  function refreshFeed(force){
    setSourceState('fallback');
    fetchFeed(settings.type).then(function(cards){
      if (destroyed) return;
      poolAll = cards;
      cursor = 0;
      setSourceState('platform');
      applySettings();
    }).catch(function(err){
      var warm = readWarmCache();
      if (warm && warm.length){
        poolAll = warm;
        cursor = 0;
        setSourceState('cache');
        applySettings();
      } else if (force) {
        poolAll = fallbackPool();
        pool = filterPool(poolAll);
        setSourceState('fallback');
        applySettings();
      }
      console.warn('[AssetStage] live feed unavailable, using',
        warm ? 'warm Inspire cache' : 'fallback tiles', '·', err && err.message);
    });
  }

  // ================================================================ PARALLAX
  function onPointer(e){
    if (still) return;
    pendingEvt = e;
    if (rafId) return;
    rafId = requestAnimationFrame(function(){
      rafId = null;
      if (!pendingEvt || destroyed) return;
      var r = root.getBoundingClientRect();
      var nx = ((pendingEvt.clientX - r.left) / r.width  - .5) * 2;
      var ny = ((pendingEvt.clientY - r.top ) / r.height - .5) * 2;
      root.style.setProperty('--afx', (-nx * CFG.PARALLAX_MAX).toFixed(1)+'px');
      root.style.setProperty('--afy', (-ny * CFG.PARALLAX_MAX * 0.7).toFixed(1)+'px');
      pendingEvt = null;
    });
  }
  function onLeave(){
    root.style.setProperty('--afx','0px');
    root.style.setProperty('--afy','0px');
  }

  // =============================================================== LIFECYCLE
  function startMotion(){ if (!shuffleTimer && !still && !destroyed) shuffleTimer = setInterval(shuffleTick, CFG.SHUFFLE_MS); }
  function stopMotion(){ clearInterval(shuffleTimer); shuffleTimer = null; }

  function setStill(v){
    still = v;
    root.classList.toggle('af--still', v);
    if (v) { stopMotion(); onLeave(); } else { startMotion(); }
  }

  function activateWorkspaceMode(type){
    var panel = type === 'video' ? 'video' : type === 'image' ? 'image' : 'model';
    if (window.TimrXWorkspace && typeof window.TimrXWorkspace.activatePanel === 'function'){
      try { window.TimrXWorkspace.activatePanel(panel, { reveal:false }); return; } catch(e){}
    }
    var btn = document.querySelector('.rail-btn[data-panel="'+panel+'"]');
    if (btn) btn.click();
  }

  function showViewerShell(type){
    stopViewerMedia();
    document.body.classList.add('ws-viewer-open');
    document.body.classList.remove('assets-modal-open');
    if (window.TimrXAssets && typeof window.TimrXAssets.close === 'function'){
      try { window.TimrXAssets.close(); } catch(e){}
    }
    activateWorkspaceMode(type);
    closeControls();
    var viewer = document.querySelector('.timrx-3dprint .ws-viewer');
    if (viewer && typeof viewer.scrollIntoView === 'function'){
      viewer.scrollIntoView({ behavior:'smooth', block:'center' });
    }
    window.dispatchEvent(new Event('resize'));
  }

  /* Reset whatever is playing in the workspace viewer before we put something
     new there.

     Scoped to #videoViewer on purpose. This used to run over
     document.querySelectorAll('video, audio') — every media element on the
     page — and it is called on every open, including image and model opens.
     One click on a stage card therefore stripped the src off the hero video,
     the tutorial clips and any other player on the page, permanently. */
  function stopViewerMedia(){
    var viewerHost = document.getElementById('videoViewer');
    var media = viewerHost
      ? viewerHost.querySelectorAll('video, audio')
      : [document.getElementById('generatedVideo')];
    Array.prototype.forEach.call(media, function(el){
      if (!el) return;
      try { el.pause(); } catch(e){}
      try { el.currentTime = 0; } catch(e){}
      el.removeAttribute('src');
      el.src = '';
      el.querySelectorAll('source').forEach(function(source){
        source.removeAttribute('src');
        source.src = '';
      });
      try { el.load(); } catch(e){}
      el.classList.add('hidden');
    });
    var videoPh = document.getElementById('videoPlaceholder');
    if (videoPh) videoPh.classList.remove('hidden');
    if (window.TimrXViewer && typeof window.TimrXViewer.clearVideoViewer === 'function'){
      try { window.TimrXViewer.clearVideoViewer(); } catch(e){}
    }
  }

  function hideViewerShell(){
    stopViewerMedia();
    document.body.classList.remove('ws-viewer-open');
    window.dispatchEvent(new Event('resize'));
  }

  function setViewerInfo(asset, type){
    var viewerId = type === 'video' ? 'videoViewer' : type === 'image' ? 'imageViewer' : 'model3dViewer';
    var wrap = document.getElementById(viewerId);
    if (!wrap) return;
    var info = wrap.querySelector('.af-viewer-info');
    if (!info){
      info = document.createElement('div');
      info.className = 'af-viewer-info';
      wrap.appendChild(info);
    }
    var label = type === 'video' ? 'Video' : type === 'image' ? 'Image' : '3D model';
    var title = asset.title || label + ' asset';
    var prompt = asset.prompt && asset.prompt !== title ? asset.prompt : '';
    info.innerHTML =
      '<span class="af-viewer-info__type">'+esc(label)+'</span>'+
      '<strong>'+esc(title)+'</strong>'+
      (prompt ? '<p>'+esc(prompt)+'</p>' : '');
    var headerTitle = document.getElementById('viewerTitle');
    var hint = document.getElementById('genHint');
    if (headerTitle) headerTitle.textContent = title;
    if (hint) hint.textContent = prompt || ('Opened from the live asset stage.');
  }

  function ensureAuxViewerClose(viewerId){
    var wrap = document.getElementById(viewerId);
    if (!wrap || wrap.querySelector('[data-af-close-viewer]')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn viewer-close-btn af-viewer-close';
    btn.setAttribute('data-af-close-viewer', '');
    btn.setAttribute('data-close-3d-viewer', '');
    btn.setAttribute('aria-label', 'Close viewer');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
        '<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>'+
      '</svg><span>Close</span>';
    btn.addEventListener('click', hideViewerShell);
    wrap.appendChild(btn);
  }

  function showImageAsset(asset){
    var imageUrl = asset.image_url || asset.thumbnail;
    if (!imageUrl) return false;
    var presenter = window.TimrXViewer && window.TimrXViewer.presentAsset;
    if (typeof presenter === 'function'){
      ensureAuxViewerClose('imageViewer');
      Promise.resolve(presenter('image', imageUrl, {
        title: asset.title || 'Image Preview',
        hint: asset.prompt || 'Opened from the live asset stage.',
        alt: asset.title || asset.prompt || 'Asset image'
      })).then(function(opened){
        if (opened) setViewerInfo(asset, 'image');
      });
      return true;
    }
    showViewerShell('image');
    var showImage = (window.TimrXViewer && window.TimrXViewer.showImageInViewer) ||
      (window.Viewer && window.Viewer.showImageInViewer);
    if (typeof showImage === 'function'){
      showImage(imageUrl);
    } else {
      var modelV = document.getElementById('model3dViewer');
      var imageV = document.getElementById('imageViewer');
      var videoV = document.getElementById('videoViewer');
      var img = document.getElementById('generatedImage');
      var ph = document.getElementById('imagePlaceholder');
      var fitToggle = document.getElementById('imageFitToggle');
      if (modelV) modelV.classList.add('hidden');
      if (videoV) videoV.classList.add('hidden');
      if (imageV) imageV.classList.remove('hidden');
      if (img){
        img.src = imageUrl;
        img.alt = asset.title || asset.prompt || 'Asset image';
        img.classList.remove('hidden', 'fill-mode');
      }
      if (ph) ph.classList.add('hidden');
      if (fitToggle) fitToggle.classList.remove('hidden', 'is-fill');
    }
    ensureAuxViewerClose('imageViewer');
    setViewerInfo(asset, 'image');
    return true;
  }

  function showVideoAsset(asset){
    var videoUrl = asset.video_url || asset.url;
    if (!videoUrl) return false;
    var presenter = window.TimrXViewer && window.TimrXViewer.presentAsset;
    if (typeof presenter === 'function'){
      ensureAuxViewerClose('videoViewer');
      Promise.resolve(presenter('video', videoUrl, {
        title: asset.title || 'Video Preview',
        hint: asset.prompt || 'Opened from the live asset stage.',
        autoplay: true
      })).then(function(opened){
        if (opened) setViewerInfo(asset, 'video');
      });
      return true;
    }
    showViewerShell('video');
    var showVideo = (window.TimrXViewer && window.TimrXViewer.showVideoInViewer) ||
      (window.Viewer && window.Viewer.showVideoInViewer);
    if (typeof showVideo === 'function'){
      showVideo(videoUrl, {
        title: asset.title || 'Video Preview',
        hint: asset.prompt || 'Platform video asset',
        autoplay: true
      });
    } else {
      var modelV = document.getElementById('model3dViewer');
      var imageV = document.getElementById('imageViewer');
      var videoV = document.getElementById('videoViewer');
      var video = document.getElementById('generatedVideo');
      var ph = document.getElementById('videoPlaceholder');
      if (modelV) modelV.classList.add('hidden');
      if (imageV) imageV.classList.add('hidden');
      if (videoV) videoV.classList.remove('hidden');
      if (video){
        video.src = videoUrl;
        video.poster = asset.thumbnail || '';
        video.classList.remove('hidden');
        video.load();
        video.play().catch(function(){});
      }
      if (ph) ph.classList.add('hidden');
    }
    ensureAuxViewerClose('videoViewer');
    setViewerInfo(asset, 'video');
    return true;
  }

  function modelLoaderFor(url){
    var isStl = /\.stl(?:[?#]|$)/i.test(String(url || ''));
    var viewer = window.TimrXViewer || window.Viewer || {};
    return isStl
      ? (viewer.loadStlFromUrl || window.loadStlFromUrl)
      : (viewer.loadGlbFromUrl || window.loadGlbFromUrl);
  }

  function waitForModelLoader(url){
    var started = Date.now();
    return new Promise(function(resolve){
      (function check(){
        var loader = modelLoaderFor(url);
        // The viewer loader performs its own WebGL readiness check and can
        // initialize the scene after the panel opens. Do not require a
        // pre-existing scene here or the first card click races initialization.
        if (typeof loader === 'function' || Date.now() - started > 4200) {
          resolve(loader);
          return;
        }
        setTimeout(check, 80);
      })();
    });
  }

  function showModelAsset(asset){
    var modelUrl = asset.model_url || asset.glb_url || asset.stl_url || asset.url;
    var presenter = window.TimrXViewer && window.TimrXViewer.presentAsset;
    if (modelUrl && typeof presenter === 'function'){
      setViewerInfo(Object.assign({}, asset, { prompt:'Loading the original 3D asset...' }), 'model');
      Promise.resolve(presenter('model', modelUrl, {
        title: asset.title || '3D Model',
        hint: asset.prompt || 'Opened from the live asset stage.',
        isStl: /\.stl(?:[?#]|$)/i.test(String(modelUrl))
      })).then(function(opened){
        if (opened) setViewerInfo(asset, 'model');
      });
      return true;
    }
    showViewerShell('model');
    var modelV = document.getElementById('model3dViewer');
    var imageV = document.getElementById('imageViewer');
    var videoV = document.getElementById('videoViewer');
    if (modelV) modelV.classList.remove('hidden');
    if (imageV) imageV.classList.add('hidden');
    if (videoV) videoV.classList.add('hidden');
    setViewerInfo(asset, 'model');
    if (modelUrl){
      setViewerInfo(Object.assign({}, asset, { prompt:'Loading the original 3D asset...' }), 'model');
      waitForModelLoader(modelUrl).then(function(loader){
        if (typeof loader !== 'function'){
          console.warn('[AssetStage] no model loader available for', modelUrl);
          setViewerInfo(Object.assign({}, asset, { prompt:'The 3D viewer is still initializing. Please try again.' }), 'model');
          return;
        }
        Promise.resolve(loader(modelUrl)).then(function(){
          setViewerInfo(asset, 'model');
        }).catch(function(err){
          console.warn('[AssetStage] model viewer load failed', err && err.message);
          setViewerInfo(Object.assign({}, asset, { prompt:'The original 3D file could not be opened.' }), 'model');
          if (window.showToast) window.showToast('Could not open this 3D model.', 'error');
        });
      });
      return true;
    }
    setViewerInfo(Object.assign({}, asset, { prompt:'No 3D file is available for this asset.' }), 'model');
    if (window.showToast) window.showToast('This asset has no original 3D file.', 'error');
    return true;
  }

  function openAsset(asset){
    if (!asset) return;
    if (asset._fallback && !(asset.glb_url || asset.video_url || asset.image_url)){
      showImageAsset(asset);
      return;
    }
    var opened = asset.type === 'video' ? showVideoAsset(asset) :
      asset.type === 'image' ? showImageAsset(asset) :
      showModelAsset(asset);
    if (opened){
      root.dispatchEvent(new CustomEvent('timrx:asset-stage-view', { bubbles:true, detail:asset }));
      return;
    }
    root.dispatchEvent(new CustomEvent('timrx:asset-stage-open', { bubbles:true, detail:asset }));
  }

  // ==================================================================== MOUNT
  function mount(){
    root = document.getElementById('wsStage');
    if (!root) return;
    fieldEl = root.querySelector('.ws-stage__field');
    if (!fieldEl) return;
    buildControls();
    buildSideRail();
    applySettings({ skipBuild:true });

    var reduce  = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* Keep the live field animated on modest machines too. The stage already
       limits card density; only an explicit accessibility preference should
       disable the motion system automatically. */
    if (reduce) setStill(true);

    /* The stage is pointer-events:none so it never eats clicks meant for the
       dock; the parallax listener therefore has to live on the workspace. */
    var pointerHost = document.querySelector('.timrx-3dprint') || document.body;
    if (window.matchMedia('(hover:hover) and (pointer:fine)').matches){
      pointerHost.addEventListener('pointermove', onPointer, { passive:true });
      pointerHost.addEventListener('pointerleave', onLeave,  { passive:true });
    }

    if ('IntersectionObserver' in window){
      io = new IntersectionObserver(function(es){
        if (es[0].isIntersecting) startMotion(); else stopMotion();
      }, { threshold:0.02 });
      io.observe(root);
    } else startMotion();

    document.addEventListener('visibilitychange', function(){
      if (document.hidden) stopMotion(); else startMotion();
    });

    if ('ResizeObserver' in window){
      ro = new ResizeObserver(function(){
        clearTimeout(resizeDeb); resizeDeb = setTimeout(build, 190);
      });
      ro.observe(root);
    } else {
      window.addEventListener('resize', function(){
        clearTimeout(resizeDeb); resizeDeb = setTimeout(build, 190);
      });
    }

    fieldEl.addEventListener('click', function(e){
      var btn = e.target.closest('.af__card'); if(!btn) return;
      var id = btn.dataset.assetId, hit = null;
      for (var i=0;i<pool.length;i++) if (String(pool[i].id) === id) { hit = pool[i]; break; }
      openAsset(hit || { id:id, type:btn.dataset.assetType });
    });

    /* Reel hover: the frame you point at starts playing for real.
       pointerenter/leave on the field (delegated, capture phase — these events
       do not bubble) so there is no per-card listener to clean up on rebuild. */
    if (window.matchMedia('(hover:hover) and (pointer:fine)').matches){
      fieldEl.addEventListener('pointerover', function(e){
        var btn = e.target.closest && e.target.closest('.af__card[data-asset-type="video"]');
        if (!btn || btn.querySelector('.af__vid')) return;
        var id = btn.dataset.assetId, hit = null;
        for (var i=0;i<pool.length;i++) if (String(pool[i].id) === id) { hit = pool[i]; break; }
        startReelPreview(btn, hit);
      });
      fieldEl.addEventListener('pointerout', function(e){
        var btn = e.target.closest && e.target.closest('.af__card[data-asset-type="video"]');
        if (!btn) return;
        // Ignore moves between children of the same card.
        if (e.relatedTarget && btn.contains(e.relatedTarget)) return;
        stopReelPreview();
      });
    }

    var warm = readWarmCache();
    poolAll = warm || fallbackPool();
    pool = filterPool(poolAll);
    setSourceState(warm ? 'cache' : 'fallback');
    build();
    startMotion();

    fetchFeed().then(function(cards){
      if (destroyed) return;
      poolAll = cards; pool = filterPool(poolAll); cursor = 0; setSourceState('platform'); build();
    }).catch(function(err){
      console.warn('[AssetStage] live feed unavailable, using',
        warm ? 'warm Inspire cache' : 'fallback tiles', '·', err && err.message);
    });
  }

  function destroy(){
    if (destroyed) return;
    destroyed = true; stopMotion(); stopReelPreview();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    clearTimeout(resizeDeb);
    if (root){ root.style.display = 'none'; fieldEl.textContent = ''; }
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown);
    if (controlsEl) controlsEl.remove();
    slots = [];
  }

  window.TimrXAssetStage = {
    mount:mount, destroy:destroy, rebuild:build, reshuffle:reshuffleAll,
    setStill:setStill, setDensity:function(d){ CFG.DENSITY = d; build(); }
  };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', mount, { once:true });
  } else { mount(); }
})();
