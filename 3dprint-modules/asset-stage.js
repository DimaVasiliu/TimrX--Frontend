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
    CACHE_KEY     : 'timrx_inspire_cache_v2', // v2 includes real model URLs
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
    var out = [], types = ['model','image','video'], aspects = ['square','portrait','landscape'];
    for (var i=0;i<16;i++){
      out.push({ id:'fb-'+i, type:types[i%3], thumbnail:svgTile(i),
                 prompt:FALLBACK_PROMPTS[i % FALLBACK_PROMPTS.length],
                 aspect:aspects[(i*2)%3], _fallback:true });
    }
    return out;
  }

  function normalize(cards){
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
    }).filter(function(c){ return c.thumbnail; });
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
    var filtered = cards.filter(function(card){ return card.type === type; });
    return filtered.length ? filtered : cards.slice();
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
    var url = CFG.FEED_URL + '?type=' + encodeURIComponent(type) + '&mix=balanced&shuffle=true&limit=' + CFG.FEED_LIMIT;
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

  function layout(count, w, h){
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
    return chosen.map(function(c){
      /* Bias the near tier toward the middle of the band: its top and bottom
         are masked out under the dock and the command bar, so a big card there
         would only ever be seen as a fading sliver. */
      var mid  = 1 - Math.min(1, Math.abs(c.y - mid0) / half);
      var roll = rnd(c.i+3.1);
      var tier = roll < 0.30 + mid * 0.34 ? 2 : roll < 0.72 ? 1 : 0;
      return { x:Math.max(0.05,Math.min(0.95,c.x)),
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

  function fillCard(btn, asset){
    var t = asset.type;
    btn.style.setProperty('--ar', ASPECTS[asset.aspect] || 1);
    btn.setAttribute('aria-label',
      (t==='video'?'Video':t==='image'?'Image':'3D model')+': '+(asset.prompt||'Untitled creation'));
    btn.dataset.assetId = asset.id;
    btn.dataset.assetType = t;
    btn.innerHTML =
      '<img src="'+esc(asset.thumbnail)+'" alt="" loading="lazy" decoding="async"/>'+
      /* Model cards get the same studio floor the fallback tiles draw into
         their SVG — a perspective grid the object appears to stand on. Images
         and videos are captures of a scene and already have their own ground;
         a 3D model is an object in a void and reads as floating without it. */
      (t === 'model' ? '<span class="af__floor" aria-hidden="true"></span>' : '')+
      '<span class="af__chip is-'+t+'">'+ICON[t]+'<span>'+t+'</span></span>'+
      '<span class="af__cap">'+esc(asset.prompt||'Untitled creation')+'</span>';
    btn.firstChild.addEventListener('error', function(){
      var s = btn.closest('.af__slot'); if (s) s.style.display = 'none';
    }, { once:true });
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

    var count = Math.min(densityFor(w,h,CFG.DENSITY), pool.length ? pool.length * 2 : 1);
    var spots = layout(count, w, h);
    var bw    = baseCardWidth(w,h,count);

    fieldEl.textContent = '';
    var heroIndex = -1, heroScore = -1;
    if (settings.spotlight && (MODE_PRESETS[settings.mode] || MODE_PRESETS.balanced).spotlight){
      spots.forEach(function(sp, i){
        var dx = sp.x - .5, dy = sp.y - .52;
        var score = (sp.tier * 2) - Math.sqrt(dx*dx + dy*dy);
        if (score > heroScore){ heroScore = score; heroIndex = i; }
      });
    }

    slots = spots.map(function(sp, i){
      var tier = TIERS[sp.tier], asset = pool[i % pool.length];

      var slot = document.createElement('div');
      slot.className = 'af__slot' + (i === heroIndex ? ' is-hero' : '');
      slot.style.setProperty('--x', (sp.x*100).toFixed(2)+'%');
      slot.style.setProperty('--y', (sp.y*100).toFixed(2)+'%');
      slot.style.setProperty('--w', Math.round(bw * tier.s)+'px');
      slot.style.setProperty('--o', tier.o);
      slot.style.setProperty('--blur', tier.blur+'px');
      slot.style.setProperty('--par', tier.par);
      slot.style.setProperty('--z', tier.z);

      var flo = document.createElement('div');
      flo.className = 'af__float';
      flo.style.setProperty('--drift', DRIFTS[Math.floor(rnd(sp.seed+11)*DRIFTS.length)]);
      flo.style.setProperty('--dur', (8 + rnd(sp.seed+21)*10).toFixed(2)+'s');
      flo.style.setProperty('--delay', '-'+(rnd(sp.seed+31)*14).toFixed(2)+'s');

      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'af__card';
      /* Depth travel: about a third of the field makes the journey in from
         the back. Chosen per slot, with its own duration and phase so the
         approaches never sync up into a pulse. Skipped for the near tier —
         a card that is already at the front has nowhere to come from. */
      if (sp.tier < 2 && Math.random() < 0.34) {
        slot.classList.add('is-travelling');
        slot.style.setProperty('--travel', (38 + Math.random() * 34).toFixed(1) + 's');
        // Negative delay starts each card mid-journey, so they are already
        // spread through the cycle instead of all departing together.
        slot.style.setProperty('--travel-delay', (-Math.random() * 40).toFixed(1) + 's');
      }
      btn.style.setProperty('--shy', tier.shy+'px');
      btn.style.setProperty('--shb', tier.shb+'px');
      fillCard(btn, asset);

      flo.appendChild(btn); slot.appendChild(flo); fieldEl.appendChild(slot);
      return { el:slot, btn:btn, spot:sp };
    });

    requestAnimationFrame(function(){ root.style.setProperty('--af-in','1'); });
  }

  // ================================================================= SHUFFLE
  function shuffleTick(){
    if (destroyed || still || document.hidden || !slots.length || !pool.length) return;
    var n = Math.min(window.innerWidth < 760 ? 1 : CFG.SHUFFLE_COUNT, slots.length);
    for (var k=0;k<n;k++){
      (function(delay){
        var s = slots[Math.floor(Math.random()*slots.length)];
        setTimeout(function(){
          if (destroyed || !s || !s.el.isConnected) return;
          s.el.classList.add('is-swapping');
          setTimeout(function(){
            if (destroyed || !s.el.isConnected) return;
            cursor = (cursor + 1 + Math.floor(Math.random()*3)) % pool.length;
            fillCard(s.btn, pool[cursor]);
            /* re-jitter inside the same cell: the composition breathes, but
               nothing ever teleports across the stage */
            var nx = Math.max(0.05, Math.min(0.95, s.spot.x + (Math.random()-.5)*0.05));
            var ny = Math.max(0.06, Math.min(0.94, s.spot.y + (Math.random()-.5)*0.05));
            s.spot.x = nx; s.spot.y = ny;
            s.el.style.setProperty('--x',(nx*100).toFixed(2)+'%');
            s.el.style.setProperty('--y',(ny*100).toFixed(2)+'%');
            s.el.classList.remove('is-swapping');
          }, 450);
        }, delay);
      })(k * 340);
    }
  }

  function reshuffleAll(){
    if (!slots.length || !pool.length) return;
    slots.forEach(function(s,i){
      setTimeout(function(){
        if (destroyed || !s.el.isConnected) return;
        s.el.classList.add('is-swapping');
        setTimeout(function(){
          cursor = (cursor+1) % pool.length;
          fillCard(s.btn, pool[cursor]);
          s.el.classList.remove('is-swapping');
        }, 380);
      }, i*40);
    });
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
     being dealt rather than a repaint. `slots` holds { el, btn, spot } records,
     not elements — the first version of this treated them as nodes and threw
     on the first press. */
  function reshuffleAll(){
    if (destroyed || !slots.length || !pool.length) return;
    if (root) root.classList.add('af--dealing');

    slots.forEach(function(s, i){
      if (!s || !s.el) return;
      s.el.style.setProperty('--deal', (i % 12) * 40 + 'ms');
      s.el.classList.add('is-swapping');
    });

    setTimeout(function(){
      slots.forEach(function(s){
        if (destroyed || !s || !s.el || !s.el.isConnected) return;
        cursor = (cursor + 1 + Math.floor(Math.random() * 3)) % pool.length;
        fillCard(s.btn, pool[cursor]);
        /* re-jitter within the same cell, exactly as the timed shuffle does,
           so the field recomposes without anything crossing the stage */
        var nx = Math.max(0.05, Math.min(0.95, s.spot.x + (Math.random() - 0.5) * 0.08));
        var ny = Math.max(0.06, Math.min(0.94, s.spot.y + (Math.random() - 0.5) * 0.08));
        s.spot.x = nx; s.spot.y = ny;
        s.el.style.setProperty('--x', (nx * 100).toFixed(2) + '%');
        s.el.style.setProperty('--y', (ny * 100).toFixed(2) + '%');
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

  function stopViewerMedia(){
    document.querySelectorAll('video, audio').forEach(function(media){
      try { media.pause(); } catch(e){}
      try { media.currentTime = 0; } catch(e){}
      media.removeAttribute('src');
      media.src = '';
      media.querySelectorAll('source').forEach(function(source){
        source.removeAttribute('src');
        source.src = '';
      });
      try { media.load(); } catch(e){}
      media.classList.add('hidden');
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
    destroyed = true; stopMotion();
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
