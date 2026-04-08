/**
 * ============================================================================
 * INSPIRE MODULE — Premium Discovery Overlay for TimrX 3D Workspace
 * ============================================================================
 * Production-quality implementation with:
 * - Robust fetch error handling (checks Content-Type before JSON parse)
 * - LocalStorage caching for instant load
 * - Balanced shuffle with server + local fallback
 * - Lazy loading images, no heavy 3D viewers in cards
 * - Session-scoped auto-open (once per workspace session)
 * - Thumbnail → Viewer integration (images, videos, 3D models)
 */

(function() {
  'use strict';

  // =========================================================================
  // CONFIGURATION
  // =========================================================================

  // Use the global backend URL (set in 3dprint.html) to avoid cross-origin issues
  // Frontend is on timrx.live, API is on 3d.timrx.live
  const BACKEND = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';

  const CONFIG = {
    SESSION_KEY: 'timrx_inspire_session_shown', // sessionStorage key for one-time auto-open
    CACHE_KEY: 'timrx_inspire_cache',
    CACHE_TTL: 5 * 60 * 1000, // 5 minutes
    API_BASE: `${BACKEND}/api/_mod`,
    FETCH_LIMIT: 24,
    FETCH_TIMEOUT: 8000,
    FETCH_COOLDOWN: 10000, // 10 seconds between failed retries
    MAX_CONSECUTIVE_FAILURES: 3,
    AUTO_OPEN_DELAY: 600 // ms delay before auto-open
  };

  console.log('[Inspire] Config initialized, API_BASE:', CONFIG.API_BASE);

  // Cooldown state to prevent fetch spam
  let fetchState = {
    lastFailedAt: 0,
    consecutiveFailures: 0
  };

  // =========================================================================
  // CURATED PROMPT LIBRARY
  // =========================================================================

  const PROMPT_TARGETS = {
    model: {
      panel: 'model',
      label: '3D Model',
      cta: 'Open in 3D',
      inputSelectors: ['#modelPrompt']
    },
    image: {
      panel: 'image',
      label: 'Image',
      cta: 'Open in Image',
      inputSelectors: ['#imagePrompt']
    },
    video: {
      panel: 'video',
      label: 'Video',
      cta: 'Open in Video',
      inputSelectors: ['#videoTextPrompt', '#videoMotion']
    }
  };

  const CURATED_PROMPT_SETS = {
    model: [
      {
        title: 'Crystal Wyrm Reliquary',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Single-subject silhouette, premium materials, collectible finish.',
        prompt: 'single centered collectible crystal wyrm statue, wings partially folded, translucent quartz scales with ember glow trapped inside, carved obsidian horns, polished basalt plinth fused into the tail, heroic clear silhouette, highly readable tabletop figure, premium fantasy artifact'
      },
      {
        title: 'Retro Dive Helmet',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Hard-surface prop with strong shape language and visible materials.',
        prompt: 'single isolated retro-futurist deep sea dive helmet, brushed brass shell, thick circular glass viewport, weathered copper valves, rubber neck gasket, tiny engraved depth markings, museum-grade prop design, centered on a clean background, crisp industrial silhouette'
      },
      {
        title: 'Biomech Fox Mask',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Works well for stylized mask assets and cosplay props.',
        prompt: 'single centered biomechanical fox mask, porcelain face plates split by glowing cobalt seams, carbon fiber ear fins, delicate etched circuit filigree, ceremonial sci-fi aesthetic, symmetrical front-facing design, clean silhouette, premium cosplay prop'
      },
      {
        title: 'Lunar Rover Scout',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Mechanical props benefit from explicit function and structure.',
        prompt: 'single isolated modular lunar rover scout, compact exploration chassis, six articulated suspension wheels, matte titanium panels, amber utility lights, fold-out sensor mast, realistic hard-surface detailing, centered clean presentation, production-friendly silhouette'
      },
      {
        title: 'Gothic Lantern Core',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Good for ornate fantasy props with readable geometry.',
        prompt: 'single floating gothic reliquary lantern, blackened iron frame, stained ruby glass chambers, suspended glowing core, chains and tiny cathedral arches, elegant fantasy prop, centered clean background, high-detail ornamental metalwork, readable silhouette'
      },
      {
        title: 'Art Nouveau Perfume Bottle',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Strong for luxury product-style 3D objects.',
        prompt: 'single centered art nouveau perfume bottle, frosted emerald glass, flowing brass vine filigree, dragonfly stopper, faceted crystal cap, luxury vanity object, elegant curves, premium materials, isolated product presentation, highly readable silhouette'
      },
      {
        title: 'Desert Drone Salvage',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Clear functional parts improve mechanical generation.',
        prompt: 'single isolated desert scavenger drone, asymmetrical repair plates, exposed turbine intake, folded landing legs, sand-worn orange paint, utility cables, improvised survival tech aesthetic, centered presentation, believable hard-surface detailing'
      },
      {
        title: 'Alchemist Field Pack',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Inventories and straps create strong storytelling props.',
        prompt: 'single centered fantasy alchemist field backpack, stitched leather satchel body, hanging potion vials, brass clamps, rolled maps, herb bundles, compact burner kit, travel-worn textures, adventure prop, clean silhouette, isolated asset presentation'
      },
      {
        title: 'Spellbook Mimic',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Stylized characters work best with one main read.',
        prompt: 'single centered spellbook mimic creature, thick leather tome body, carved eye clasp, layered parchment teeth, ribbon tongue, tiny clawed feet, whimsical dark fantasy style, readable silhouette, collectible creature figurine, isolated asset'
      },
      {
        title: 'Cyber Monk Bust',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Busts give Meshy a strong focal hierarchy.',
        prompt: 'single centered cyber monk bust, shaved head with luminous tattoo channels, ceramic facial plates, woven tech cowl, serene expression, premium collectible statue, high-detail portrait sculpt, isolated clean background, balanced symmetry'
      },
      {
        title: 'Astronomical Orrery',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Nested rings and gears work well as hero props.',
        prompt: 'single isolated antique astronomical orrery, concentric brass rings, suspended enamel planets, engraved celestial markings, velvet-black central sun sphere, luxury observatory artifact, centered clean staging, precise hard-surface detail'
      },
      {
        title: 'Mecha Crab Toy',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Compact creature-mech hybrids produce readable tabletop assets.',
        prompt: 'single centered toy-scale mecha crab walker, chunky armor shell, hydraulic claws, glowing sensor eyes, playful industrial design, clean silhouette, glossy painted panels, premium desktop collectible, isolated asset render'
      },
      {
        title: 'Deep Sea Submersible',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Vehicle prompts land better when shape and use are explicit.',
        prompt: 'single isolated deep sea research submersible, spherical observation cockpit, external floodlights, articulated sampling arms, pressure hull plating, scientific expedition design, centered product-style presentation, realistic hard-surface detailing'
      },
      {
        title: 'Ceremonial Dagger',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Weapon props benefit from material contrast and clear profile.',
        prompt: 'single centered ceremonial obsidian dagger, faceted black blade, hammered gold guard, wrapped ivory grip, red silk tassel, ancient royal artifact, clean side-readable silhouette, isolated premium prop presentation'
      },
      {
        title: 'Mascot Astronaut',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Cute character figures work well as full-body collectibles.',
        prompt: 'single centered plush-inspired mascot astronaut figure, oversized round helmet, stitched fabric suit panels, tiny utility patches, soft toy proportions, charming expression, collectible designer toy aesthetic, clean readable silhouette'
      },
      {
        title: 'Shrine Bell Totem',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Good for mystical props with layered ornamentation.',
        prompt: 'single isolated shrine bell totem, carved cedar frame, suspended bronze bell, braided ropes, paper talismans, faint spirit glow, elegant vertical silhouette, premium fantasy prop, clean centered asset'
      }
    ],
    image: [
      {
        title: 'Luxury Watch Macro',
        providerHint: 'Best with OpenAI, Imagen, or FLUX.2 Pro',
        hint: 'Strong for premium product photography and material realism.',
        prompt: 'macro product photograph of a luxury skeleton watch resting on dark volcanic stone, brushed titanium case, sapphire reflections, warm edge light, deep shadows, ultra-sharp dial details, premium editorial ad photography, clean composition'
      },
      {
        title: 'Brutalist Cafe Editorial',
        providerHint: 'Best with OpenAI or Imagen',
        hint: 'Detailed environment, grounded materials, strong interior light.',
        prompt: 'editorial interior photo of a brutalist cafe at blue hour, poured concrete walls, smoked glass, brushed steel counter, soft practical lamps, a few guests in tailored monochrome outfits, cinematic natural composition, premium architecture magazine style'
      },
      {
        title: 'Streetwear Portrait',
        providerHint: 'Best with OpenAI, Imagen, or FLUX.2 Pro',
        hint: 'Portrait-driven fashion shots respond well to concrete styling cues.',
        prompt: 'fashion portrait of a streetwear creative standing under a subway platform, oversized charcoal coat, silver jewelry, rain-slick pavement, moody side light, crisp skin texture, candid editorial energy, shallow depth of field'
      },
      {
        title: 'Botanical Perfume Ad',
        providerHint: 'Best with OpenAI or Imagen',
        hint: 'Clear hero subject plus surrounding art direction.',
        prompt: 'high-end perfume campaign image, emerald glass bottle surrounded by wet fig leaves and sliced pear, dramatic softbox lighting, luxury beauty ad composition, polished reflections, fresh green palette, premium brand mood'
      },
      {
        title: 'Packaging Flat Lay',
        providerHint: 'Best with Recraft or OpenAI',
        hint: 'Useful for clean brand mockups and layout studies.',
        prompt: 'top-down flat lay of a premium tea packaging system, three matte cartons, foil stamp details, dried botanicals, elegant spacing, warm natural light, art-directed product styling, minimal luxury brand photography'
      },
      {
        title: 'Neon Transit Matte',
        providerHint: 'Best with Imagen or FLUX.2 Pro',
        hint: 'Scene scale, weather, and light cues help cinematic worldbuilding.',
        prompt: 'cinematic matte painting of a futuristic transit station in heavy rain, neon route markers, reflective pavement, commuters with translucent umbrellas, volumetric fog, magenta and cyan glow, grand scale, richly layered urban atmosphere'
      },
      {
        title: 'Childrens Book Meadow',
        providerHint: 'Best with OpenAI or Imagen',
        hint: 'Clear subject, medium, and tone create stable illustration results.',
        prompt: 'children’s book illustration of a fox courier crossing a flower meadow with a satchel of letters, bright watercolor textures, warm morning sun, whimsical rounded shapes, friendly storybook charm, highly readable scene composition'
      },
      {
        title: 'Travel Poster Type',
        providerHint: 'Best with Ideogram or Recraft',
        hint: 'Places quoted text near the start for better typography.',
        prompt: '"VISIT LUCERNE" vintage travel poster, towering alpine lake, classic paddle steamer, elegant art deco layout, bold geometric framing, crisp typography, limited cobalt and cream palette, poster-ready vector graphic design'
      },
      {
        title: 'Icon System Sheet',
        providerHint: 'Best with Recraft Vector',
        hint: 'Designed for SVG-friendly shape language and consistency.',
        prompt: 'clean vector icon system for a sustainable home app, 12 icons, rounded geometric strokes, solar panel, water drop, heat pump, leaf, battery, recycling, minimalist grid layout, crisp monochrome with sage accent, product design presentation'
      },
      {
        title: 'Album Cover Portrait',
        providerHint: 'Best with OpenAI, FLUX.2 Pro, or Ideogram',
        hint: 'Good for expressive portrait-led graphics.',
        prompt: 'album cover portrait of a singer in profile under crimson stage haze, glitter tear makeup, dramatic rim light, grainy film texture, negative space for title treatment, bold emotional mood, premium music editorial style'
      },
      {
        title: 'Dessert Hero Shot',
        providerHint: 'Best with OpenAI or Imagen',
        hint: 'Food prompts improve with texture and lighting specificity.',
        prompt: 'hero food photograph of a glossy pistachio mille-feuille, flaky pastry layers, crushed pistachios, tiny edible flowers, dark moody background, studio side light, ultra-detailed textures, luxury patisserie advertising'
      },
      {
        title: 'Minimal Desk Product',
        providerHint: 'Best with OpenAI, Imagen, or FLUX.2 Pro',
        hint: 'Works for clean tech product renders and landing-page imagery.',
        prompt: 'minimal product render of a compact mechanical keyboard on a pale oak desk, soft daylight from the left, brushed aluminum frame, crisp shadows, modern creative workspace styling, airy premium tech aesthetic'
      },
      {
        title: 'Skincare Billboard',
        providerHint: 'Best with Ideogram or Recraft',
        hint: 'Quote-first structure helps keep short ad copy readable.',
        prompt: '"RESET YOUR SKIN" clean beauty billboard concept, frosted serum bottle splashing through clear water, pale stone backdrop, subtle mint accents, premium typography, luxury skincare campaign, modern editorial graphic design'
      },
      {
        title: 'Fantasy Cover Art',
        providerHint: 'Best with OpenAI, Imagen, or FLUX.2 Pro',
        hint: 'Strong for character-plus-environment key art.',
        prompt: 'epic fantasy book cover art, lone mage on a cliff above a storm-lit city, cloak whipping in the wind, electric blue runes, towering clouds, cinematic scale, dramatic focal lighting, premium cover illustration'
      },
      {
        title: 'Isometric House Cutaway',
        providerHint: 'Best with Recraft or Imagen',
        hint: 'Explicit layout language helps for structured diagram scenes.',
        prompt: 'isometric cutaway illustration of a compact eco house, visible rooms, solar battery wall, cozy reading loft, indoor plants, clean labels space, bright informative palette, polished architectural infographic style'
      },
      {
        title: 'Coffee Brand Mark',
        providerHint: 'Best with Recraft Vector or Ideogram',
        hint: 'Short, design-led prompt for logos and marks.',
        prompt: 'vector logo concept for a specialty coffee brand called "EMBER ROAST", elegant flame hidden inside a coffee bean shape, premium minimal geometry, warm copper and espresso palette, clean brand presentation on light background'
      }
    ],
    video: [
      {
        title: 'Neon Alley Pursuit',
        providerHint: 'Best with Veo or Seedance',
        hint: 'Subject, camera move, weather, and atmosphere are all explicit.',
        prompt: 'A courier sprints through a neon alley at night, weaving past steam vents and glowing signs. Camera: handheld tracking shot from behind, then a quick arc to profile. Visual style: cinematic cyberpunk, wet reflections, electric magenta and teal, urgent momentum.'
      },
      {
        title: 'Chef Fire Sequence',
        providerHint: 'Best with Seedance or Veo with audio',
        hint: 'Built for motion plus synchronized sound cues.',
        prompt: 'Chef’s hands toss vegetables into a blazing wok in an open kitchen, flames bursting upward, steam rolling toward the lens. Audio: metal pan hits, sizzling oil, short bursts of fire, energetic kitchen ambience. Visual style: fast culinary commercial, crisp highlights, rich food detail.'
      },
      {
        title: 'Arctic Sky Timelapse',
        providerHint: 'Best with Veo',
        hint: 'Simple scene-first structure works well for Veo clips.',
        prompt: 'Wide shot of the northern lights rippling over a frozen arctic lake, stars sharp above the horizon, subtle wind drifting snow across the foreground. Camera: locked-off tripod timelapse. Visual style: photoreal, cold blue night, serene epic atmosphere.'
      },
      {
        title: 'Island Drone Reveal',
        providerHint: 'Best with Veo or Seedance',
        hint: 'Explicit drone motion and landscape staging.',
        prompt: 'Sweeping aerial drone shot over a volcanic island at sunrise, sea mist wrapping dark cliffs, small waves flashing gold below. Camera: fast forward glide that rises to reveal the crater lake. Visual style: cinematic travel film, high contrast golden hour, grand scale.'
      },
      {
        title: 'Wind Portrait Fashion',
        providerHint: 'Best with Veo or Seedance',
        hint: 'Portrait plus subtle motion makes a clean hero clip.',
        prompt: 'A fashion model stands on a rooftop in a tailored black coat, wind lifting loose strands of hair and the coat hem. Camera: slow dolly in from medium shot to close-up. Visual style: luxury editorial, soft overcast light, restrained monochrome palette, poised confidence.'
      },
      {
        title: 'Coffee Pour Ad',
        providerHint: 'Best with Seedance',
        hint: 'Object action and texture changes read well in short clips.',
        prompt: 'Fresh coffee pours in a smooth dark ribbon into a ceramic mug on a wooden table, steam rising as the surface ripples. Audio: liquid pour, soft ceramic clink, low cafe ambience. Camera: close-up with slight slider move. Visual style: premium cafe commercial, warm morning light.'
      },
      {
        title: 'Noir Rack Focus',
        providerHint: 'Best with Veo',
        hint: 'Designed around focus change and mood.',
        prompt: 'A detective’s gloved hand holds a brass key in the foreground under flickering streetlight. Camera: medium shot with a slow rack focus from the key to the detective’s tired face in the rain. Visual style: noir thriller, wet asphalt, deep shadows, moody contrast.'
      },
      {
        title: 'Greenhouse Astronaut',
        providerHint: 'Best with Veo or Seedance',
        hint: 'Strong contrast between subject and environment.',
        prompt: 'An astronaut tends glowing plants inside a humid greenhouse on a distant moon base, water droplets drifting from glass pipes. Camera: slow orbit around the subject. Audio: soft ventilation hum, droplets, faint suit servos. Visual style: hopeful sci-fi, lush greens against white habitat walls.'
      },
      {
        title: 'Storm Window Interior',
        providerHint: 'Best with Seedance or Veo with audio',
        hint: 'Audio cues help the scene feel grounded and alive.',
        prompt: 'A candlelit apartment window during a thunderstorm, raindrops racing down the glass while lightning reveals the skyline beyond. Audio: rolling thunder, rain on the pane, quiet room tone. Camera: static close shot. Visual style: intimate cinematic realism, warm interior versus cold storm outside.'
      },
      {
        title: 'Skate Follow Cam',
        providerHint: 'Best with Seedance',
        hint: 'Momentum and camera language are concise and clear.',
        prompt: 'A skateboarder launches down a concrete river channel at sunset, wheels spraying dust and sparks from a brief slide. Camera: low follow cam racing alongside, then whip pan to landing. Visual style: energetic sports commercial, golden haze, high-speed grit.'
      },
      {
        title: 'Library Shock Beat',
        providerHint: 'Best with Seedance',
        hint: 'Short narrative timing plus sound punctuation.',
        prompt: 'Quiet library reading room, sudden heavy book slam on a table, everyone looks up, tension breaks into nervous laughter. Audio: paper rustle, sharp book impact, hushed reactions, soft room ambience. Visual style: grounded cinematic comedy, warm academic interior.'
      },
      {
        title: 'Koi Pond Macro',
        providerHint: 'Best with Veo',
        hint: 'Macro visuals benefit from specific optical language.',
        prompt: 'Extreme close-up of orange koi gliding beneath lily pads, concentric ripples catching sunlight on the water surface. Camera: macro lens, shallow depth of field, gentle floating drift. Visual style: meditative nature cinematography, delicate highlights, tranquil pacing.'
      },
      {
        title: 'Robot Piano Recital',
        providerHint: 'Best with Seedance or Veo with audio',
        hint: 'Audio-first sequences give Seedance more to work with.',
        prompt: 'A polished service robot performs a piano recital in a dark hall, articulated fingers moving precisely over ivory keys, audience silhouettes still in the background. Audio: resonant piano chords, pedal clicks, quiet room reverb. Camera: slow lateral dolly. Visual style: elegant futuristic concert film.'
      },
      {
        title: 'Waterfall Trek Reveal',
        providerHint: 'Best with Veo or Seedance',
        hint: 'Good travel-style clip with clear reveal motion.',
        prompt: 'A hiker emerges from dense jungle foliage onto a ledge facing a colossal waterfall. Camera: over-the-shoulder push forward, then crane up to reveal the full falls. Visual style: lush adventure cinema, misty sunlight, rich greens, awe-filled scale.'
      },
      {
        title: 'Boxing Gym Drill',
        providerHint: 'Best with Seedance',
        hint: 'Physical action plus foley creates punchy sports footage.',
        prompt: 'A boxer drills combinations on a heavy bag in a worn gym, sweat catching hard side light as the bag swings back. Audio: sharp glove impacts, skipping rope in the distance, gritty gym room tone. Camera: handheld medium shot with short punch-ins. Visual style: raw sports documentary.'
      },
      {
        title: 'Subway Door Moment',
        providerHint: 'Best with Veo or Seedance',
        hint: 'Short human moment with clean cinematic staging.',
        prompt: 'A commuter catches the subway doors at the last second, steps inside, exhales, and looks up as tunnel lights streak past the windows. Audio: closing door chime, train rumble, breath, faint station announcement. Camera: medium shot that settles into a close-up. Visual style: contemporary city drama.'
      }
    ]
  };

  const CURATED_PROMPTS = Object.entries(CURATED_PROMPT_SETS).flatMap(([type, items]) =>
    items.map((item, index) => ({
      ...item,
      id: `curated-${type}-${index + 1}`,
      type
    }))
  );

  // =========================================================================
  // MOCK FEED GENERATOR (fallback when API + cache both fail)
  // =========================================================================

  function generateMockFeed(count = 12) {
    const types = ['model', 'model', 'image', 'image', 'video'];
    const sizes = ['sm', 'sm', 'md', 'md', 'lg'];
    const cards = [];

    for (let i = 0; i < count; i++) {
      const type = types[i % types.length];
      const promptEntry = pickPromptEntry(type);
      const prompt = promptEntry.prompt;
      cards.push({
        id: `ins-mock-${i}`,
        type: type,
        prompt: prompt,
        title: promptEntry.title,
        thumbnail: '', // Will be filtered out, but shows empty state is intentional
        size: sizes[i % sizes.length],
        tags: ['community'],
        created_at: new Date().toISOString()
      });
    }

    return {
      promptOfTheDay: pickPromptEntry(),
      cards: cards
    };
  }

  // =========================================================================
  // STATE & CACHE
  // =========================================================================

  let state = {
    isOpen: false,
    activeFilter: 'all',
    cards: [],
    initialized: false,
    loading: false,
    error: null,
    lastFetchTime: 0,
    // User intent tracking - prevents auto-behavior from overriding manual control
    userManuallyClosed: false,  // Set when user explicitly closes
    userManuallyOpened: false,  // Set when user explicitly opens
    hasAutoOpenedThisSession: false  // In-memory guard for auto-open
  };

  let overlayEl = null;
  let boundListeners = false; // Prevent duplicate event listeners

  // In-memory cache
  let memoryCache = {
    promptOfTheDay: null,
    cards: [],
    timestamp: 0
  };

  // =========================================================================
  // INSTANT SHUFFLE: In-memory pool for flicker-free "Surprise Me"
  // =========================================================================

  let INSPIRE_POOL = null;       // Large pool of cards fetched once
  let INSPIRE_POOL_TS = 0;       // Timestamp of last pool fetch
  const POOL_TTL = 10 * 60 * 1000; // 10 minutes TTL
  const POOL_FETCH_LIMIT = 96;    // Fetch large pool once
  const DISPLAY_LIMIT = 24;       // Show 24 cards at a time

  let isShuffling = false;        // Debounce flag for rapid clicking
  let cardElements = [];          // Persistent card DOM elements for in-place updates

  // =========================================================================
  // CACHE UTILITIES
  // =========================================================================

  function loadCachedContent() {
    try {
      const cached = localStorage.getItem(CONFIG.CACHE_KEY);
      if (!cached) return null;

      const data = JSON.parse(cached);
      const age = Date.now() - (data.timestamp || 0);

      // Return even stale cache for instant display
      memoryCache = data;
      return data;
    } catch (e) {
      console.warn('[Inspire] Cache read error:', e.message);
      return null;
    }
  }

  function saveCacheContent(data) {
    try {
      const cacheData = {
        ...data,
        timestamp: Date.now()
      };
      memoryCache = cacheData;
      localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(cacheData));
    } catch (e) {
      // localStorage might be full or unavailable
      console.warn('[Inspire] Cache write error:', e.message);
    }
  }

  function isCacheFresh() {
    return memoryCache.timestamp && (Date.now() - memoryCache.timestamp < CONFIG.CACHE_TTL);
  }

  // =========================================================================
  // INSPIRE POOL UTILITIES (for instant shuffle)
  // =========================================================================

  function isPoolValid() {
    return INSPIRE_POOL && INSPIRE_POOL.length > 0 && (Date.now() - INSPIRE_POOL_TS < POOL_TTL);
  }

  /**
   * Fetch a large pool of cards once for instant local shuffling.
   * Returns true if pool is ready.
   */
  async function ensurePoolLoaded() {
    if (isPoolValid()) {
      return true;
    }

    try {
      const params = new URLSearchParams({
        type: 'all',
        shuffle: 'false', // Get consistent results, we shuffle locally
        limit: String(POOL_FETCH_LIMIT),
        mix: 'balanced'
      });

      const url = `${CONFIG.API_BASE}/inspire/feed?${params}`;
      console.log('[Inspire] Fetching pool:', url);

      const result = await safeFetch(url);

      if (result.ok && result.data?.ok) {
        const cards = (result.data.cards || []).map(card => ({
          ...card,
          thumbnail: card.thumb_preview || card.thumb_url || card.thumbnail || card.thumbnail_url || ''
        })).filter(card => card.thumbnail);

        INSPIRE_POOL = cards;
        INSPIRE_POOL_TS = Date.now();

        // Keep the top prompt curated and type-aware.
        if (result.data.prompt_of_the_day) {
          memoryCache.promptOfTheDay = normalizePromptEntry(result.data.prompt_of_the_day);
        } else if (!memoryCache.promptOfTheDay?.prompt) {
          memoryCache.promptOfTheDay = pickPromptEntry(promptTypeForActiveFilter());
        }

        console.log(`[Inspire] Pool loaded: ${INSPIRE_POOL.length} cards`);
        return true;
      }
    } catch (err) {
      console.warn('[Inspire] Pool fetch failed:', err.message);
    }

    // Fallback: try to use existing memoryCache
    if (memoryCache.cards?.length > 0) {
      INSPIRE_POOL = [...memoryCache.cards];
      INSPIRE_POOL_TS = Date.now();
      return true;
    }

    return false;
  }

  /**
   * Preload an image and wait for decode before returning.
   * Prevents flash of broken/loading image.
   */
  async function preloadImage(url) {
    if (!url) return false;
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return true;
    } catch (e) {
      // Image failed to load/decode, but that's ok - browser will show placeholder
      return false;
    }
  }

  // =========================================================================
  // ICONS
  // =========================================================================

  const ICONS = {
    sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z"/></svg>`,
    shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
    view: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    remix: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    use: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
    model: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>`,
    image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
    video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><path d="M10 8l6 4-6 4V8z"/></svg>`,
    star: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
  };

  // =========================================================================
  // ROBUST FETCH WITH ERROR HANDLING
  // =========================================================================

  /**
   * Safe fetch that checks Content-Type before parsing JSON.
   * Returns { ok, data, error } object.
   */
  async function safeFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        credentials: 'include'
      });

      clearTimeout(timeout);

      // Check if response is OK
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.warn(`[Inspire] HTTP ${response.status}: ${text.slice(0, 120)}`);
        return { ok: false, error: `HTTP ${response.status}`, status: response.status };
      }

      // Check Content-Type before parsing
      const contentType = response.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) {
        const text = await response.text().catch(() => '');
        // Check if we got HTML (common when route is not registered)
        if (contentType.includes('text/html') || text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
          console.error(`[Inspire] GOT HTML instead of JSON! Status: ${response.status}, Content-Type: ${contentType}`);
          console.error(`[Inspire] HTML preview: ${text.slice(0, 120)}...`);
          console.error('[Inspire] This usually means the /api/_mod/inspire/feed route is not registered on the backend.');
        } else {
          console.warn(`[Inspire] Non-JSON response (${contentType}): ${text.slice(0, 120)}`);
        }
        return { ok: false, error: 'Response is not JSON', contentType, isHtml: contentType.includes('text/html') };
      }

      // Parse JSON
      const data = await response.json();
      return { ok: true, data };

    } catch (err) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        console.warn('[Inspire] Request timed out');
        return { ok: false, error: 'Request timed out' };
      }

      console.warn('[Inspire] Fetch error:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // =========================================================================
  // API FUNCTIONS
  // =========================================================================

  async function fetchInspireContent(options = {}) {
    const {
      type = 'all',
      shuffle = true,
      limit = CONFIG.FETCH_LIMIT,
      forceRefresh = false
    } = options;

    // Use cache if fresh and not forcing refresh
    if (!forceRefresh && isCacheFresh() && memoryCache.cards?.length > 0) {
      console.log('[Inspire] Using cached content');
      state.cards = [...memoryCache.cards];
      return true;
    }

    // Cooldown check: prevent fetch spam after failures
    const now = Date.now();
    if (fetchState.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
      const timeSinceLastFail = now - fetchState.lastFailedAt;
      if (timeSinceLastFail < CONFIG.FETCH_COOLDOWN) {
        console.log(`[Inspire] Cooldown active (${Math.ceil((CONFIG.FETCH_COOLDOWN - timeSinceLastFail) / 1000)}s remaining)`);
        // Use cache if available during cooldown
        if (memoryCache.cards?.length > 0) {
          state.cards = [...memoryCache.cards];
          return true;
        }
        return false;
      }
      // Reset after cooldown expires
      fetchState.consecutiveFailures = 0;
    }

    try {
      state.loading = true;
      state.error = null;
      updateLoadingState();

      const params = new URLSearchParams({
        type: type === 'all' ? 'all' : type === 'models' ? 'model' : type === 'images' ? 'image' : type === 'videos' ? 'video' : type,
        shuffle: String(shuffle),
        limit: String(limit),
        mix: 'balanced'
      });

      const url = `${CONFIG.API_BASE}/inspire/feed?${params}`;
      console.log('[Inspire] Fetching:', url);

      const result = await safeFetch(url);

      if (result.ok && result.data?.ok) {
        const data = result.data;

        // Normalize card format (backend uses thumb_url/thumb_preview, we also support thumbnail)
        const cards = (data.cards || []).map(card => ({
          ...card,
          thumbnail: card.thumb_preview || card.thumb_url || card.thumbnail || card.thumbnail_url || ''
        })).filter(card => card.thumbnail); // Only cards with valid thumbnails

        // Update state and cache
        memoryCache.promptOfTheDay = data.prompt_of_the_day
          ? normalizePromptEntry(data.prompt_of_the_day)
          : pickPromptEntry(promptTypeForActiveFilter());
        memoryCache.cards = cards;
        state.cards = [...cards];

        saveCacheContent({
          promptOfTheDay: memoryCache.promptOfTheDay,
          cards: cards
        });

        state.lastFetchTime = Date.now();
        // Reset failure tracking on success
        fetchState.consecutiveFailures = 0;
        console.log(`[Inspire] Loaded ${cards.length} cards from API`);
        return true;

      } else {
        throw new Error(result.error || 'API error');
      }

    } catch (err) {
      console.warn('[Inspire] API fetch failed:', err.message);
      state.error = err.message;

      // Track failure for cooldown
      fetchState.consecutiveFailures++;
      fetchState.lastFailedAt = Date.now();
      console.log(`[Inspire] Consecutive failures: ${fetchState.consecutiveFailures}/${CONFIG.MAX_CONSECUTIVE_FAILURES}`);

      // Fall back to cache if available
      if (memoryCache.cards?.length > 0) {
        console.log('[Inspire] Using stale cache as fallback');
        state.cards = [...memoryCache.cards];
        return true;
      }

      // Final fallback: use mock feed so UI doesn't break
      console.log('[Inspire] Using mock feed as final fallback');
      const mock = generateMockFeed(12);
      memoryCache.promptOfTheDay = normalizePromptEntry(mock.promptOfTheDay);
      // Note: mock cards have no thumbnails, so they'll show empty state
      // but POTD will still work
      state.cards = [];
      return false;

    } finally {
      state.loading = false;
      updateLoadingState();
    }
  }

  function updateLoadingState() {
    if (!overlayEl) return;

    const grid = overlayEl.querySelector('#inspireGrid');
    if (!grid) return;

    if (state.loading && state.cards.length === 0) {
      grid.innerHTML = `
        <div class="inspire-loading">
          <div class="inspire-loading__spinner"></div>
          <p>Loading inspiration...</p>
        </div>
      `;
    } else if (state.cards.length === 0 && !state.loading) {
      grid.innerHTML = `
        <div class="inspire-empty-state">
          <div class="inspire-empty-state__icon">${ICONS.sparkle}</div>
          <h3>No creations yet</h3>
          <p>Be the first to share your amazing creations!</p>
        </div>
      `;
    }
  }

  // =========================================================================
  // UTILITY FUNCTIONS
  // =========================================================================

  /** Fisher-Yates shuffle */
  function shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function normalizePromptType(type) {
    const normalized = String(type || '').toLowerCase();
    if (normalized === 'models' || normalized === 'model' || normalized === '3d' || normalized === '3d-model') return 'model';
    if (normalized === 'images' || normalized === 'image') return 'image';
    if (normalized === 'videos' || normalized === 'video') return 'video';
    return 'model';
  }

  function workspaceTargetForType(type) {
    return PROMPT_TARGETS[normalizePromptType(type)] || PROMPT_TARGETS.model;
  }

  function pickPromptEntry(preferredType = null) {
    const type = preferredType ? normalizePromptType(preferredType) : null;
    const pool = type ? CURATED_PROMPT_SETS[type] || [] : CURATED_PROMPTS;

    if (!pool.length) {
      return {
        id: 'curated-fallback',
        type: 'model',
        title: 'Featured Prompt',
        providerHint: 'Best with Meshy text-to-3D',
        hint: 'Single-subject prompt for a clear 3D asset.',
        prompt: 'single centered fantasy relic, polished bronze and obsidian, clean silhouette, premium collectible prop'
      };
    }

    const item = pool[Math.floor(Math.random() * pool.length)];
    return type ? { ...item, type, id: item.id || `curated-${type}` } : { ...item };
  }

  function normalizePromptEntry(entry, fallbackType = 'model') {
    if (typeof entry === 'string') {
      const fallbackTarget = workspaceTargetForType(fallbackType);
      return {
        id: `inline-${normalizePromptType(fallbackType)}`,
        type: normalizePromptType(fallbackType),
        title: fallbackTarget.label,
        providerHint: '',
        hint: '',
        prompt: entry
      };
    }

    if (!entry || typeof entry !== 'object') {
      return pickPromptEntry(fallbackType);
    }

    const type = normalizePromptType(entry.type || entry.target_type || entry.category || fallbackType);
    const target = workspaceTargetForType(type);

    return {
      id: entry.id || `inline-${type}`,
      type,
      title: entry.title || target.label,
      providerHint: entry.providerHint || entry.provider_hint || entry.provider || '',
      hint: entry.hint || entry.description || '',
      prompt: entry.prompt || ''
    };
  }

  function setPromptOfTheDay(entry) {
    memoryCache.promptOfTheDay = normalizePromptEntry(entry);
    updatePOTDDisplay();
  }

  function promptTypeForActiveFilter() {
    if (state.activeFilter === 'models') return 'model';
    if (state.activeFilter === 'images') return 'image';
    if (state.activeFilter === 'videos') return 'video';
    return null;
  }

  function getRandomPrompt() {
    return pickPromptEntry().prompt;
  }

  /**
   * Check if auto-open has already happened this session
   */
  function hasShownThisSession() {
    // Check in-memory guard first (fastest)
    if (state.hasAutoOpenedThisSession) return true;
    // Check sessionStorage as backup (survives page reloads within session)
    try {
      return sessionStorage.getItem(CONFIG.SESSION_KEY) === 'true';
    } catch (e) {
      return false;
    }
  }

  /**
   * Mark that auto-open has occurred this session
   */
  function markAutoOpenDone() {
    state.hasAutoOpenedThisSession = true;
    try {
      sessionStorage.setItem(CONFIG.SESSION_KEY, 'true');
    } catch (e) {}
  }

  // =========================================================================
  // RENDER FUNCTIONS
  // =========================================================================

  function renderCard(card, index) {
    const tags = card.tags || ['community'];
    const tagsHTML = tags.map(tag =>
      `<span class="inspire-card__tag ${tag}">${tag.replace('-', ' ')}</span>`
    ).join('');

    const normalizedType = normalizePromptType(card.type);
    const typeIcon = ICONS[normalizedType] || ICONS.model;
    const promptTarget = workspaceTargetForType(normalizedType);
    // Use normalized thumbnail fields (thumb_preview preferred, fallback to legacy)
    const thumbPreview = card.thumb_preview || card.thumbnail || card.thumb_url || '';
    const thumbRefined = card.thumb_refined || '';  // May be empty
    const hasRefine = card.has_refine || (thumbRefined && thumbRefined !== thumbPreview);
    const prompt = card.prompt || card.title || 'Untitled creation';
    const aspect = card.aspect || 'square';

    // Map aspect to intrinsic dimensions so the browser can reserve space
    // before the image loads (eliminates layout shift). Actual pixel values
    // don't matter — the ratio does, combined with object-fit: cover CSS.
    const dims = { landscape: { w: 320, h: 200 }, portrait: { w: 240, h: 320 }, square: { w: 280, h: 280 } };
    const d = dims[aspect] || dims.square;

    // First ~6 cards are above the fold — load eagerly with high priority
    const isAboveFold = typeof index === 'number' && index < 6;
    const loadAttr = isAboveFold ? '' : 'loading="lazy"';
    const priorityAttr = isAboveFold ? 'fetchpriority="high"' : '';

    // Pure thumbnail-based cards - NO WebGL, NO Three.js
    // Store both thumbnail URLs in data attributes for hover swap
    const videoUrl = card.video_url || '';

    // Model cards with refined: use data-src (NOT src) so the refined image
    // only loads on first hover, cutting initial bandwidth nearly in half.
    const refinedLayer = (card.type === 'model' && hasRefine && thumbRefined)
      ? `<img class="inspire-card__image-refined" data-src="${thumbRefined}" alt="" loading="lazy" decoding="async"/>`
      : '';

    // Video cards: inline <video> element for autoplay
    const videoLayer = (card.type === 'video' && videoUrl)
      ? `<video class="inspire-card__video" src="${videoUrl}" muted loop playsinline preload="none"></video>`
      : '';

    return `
      <article class="inspire-card ${aspect}${hasRefine ? ' has-refine' : ''}"
               data-id="${card.id}"
               data-type="${normalizedType}"
               data-thumb-preview="${thumbPreview}"
               data-thumb-refined="${thumbRefined}"
               data-video-url="${videoUrl}">
        <div class="inspire-card__media">
          ${refinedLayer}
          <img class="inspire-card__image"
               src="${thumbPreview}"
               alt="${prompt}"
               width="${d.w}" height="${d.h}"
               ${loadAttr}
               ${priorityAttr}
               decoding="async"
               onload="(function(img){var c=img.closest('.inspire-card');if(!c)return;var r=img.naturalWidth/img.naturalHeight;var a=r>1.3?'landscape':r<0.77?'portrait':'square';c.classList.remove('landscape','portrait','square');c.classList.add(a)})(this)"
               onerror="this.closest('.inspire-card').style.display='none'"/>
          ${videoLayer}
          ${normalizedType === 'video' ? '<div class="inspire-card__video-badge">&#9658;</div>' : ''}
          ${hasRefine ? '<div class="inspire-card__refine-badge" title="Refined version available">&#10024;</div>' : ''}
        </div>
        <div class="inspire-card__type-badge ${normalizedType}">${typeIcon}<span>${normalizedType}</span></div>
        <div class="inspire-card__actions">
          <button class="inspire-card__action-btn" data-action="use" title="${promptTarget.cta}" aria-label="${promptTarget.cta}">${ICONS.use}</button>
        </div>
        <div class="inspire-card__overlay">
          <div class="inspire-card__info">
            <p class="inspire-card__prompt">${prompt}</p>
            <div class="inspire-card__meta">${tagsHTML}</div>
          </div>
        </div>
      </article>
    `;
  }

  function renderFilters() {
    const filters = [
      { id: 'all', label: 'All' },
      { id: 'models', label: '3D Models' },
      { id: 'images', label: 'Images' },
      { id: 'videos', label: 'Videos' },
      { id: 'trending', label: 'Trending' }
    ];
    return filters.map(f => `
      <button class="inspire-filter-btn ${f.id === state.activeFilter ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>
    `).join('');
  }

  // =========================================================================
  // CARD VIDEO AUTOPLAY (IntersectionObserver-based, lazy)
  // =========================================================================

  let videoObserver = null;

  function initCardVideos(container) {
    // Clean up previous observer
    if (videoObserver) videoObserver.disconnect();

    const videos = container.querySelectorAll('.inspire-card__video');
    if (videos.length === 0) return;

    videoObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const video = entry.target;
        if (entry.isIntersecting) {
          // Start loading and playing when visible
          video.preload = 'auto';
          video.play().then(() => {
            video.classList.add('is-playing');
          }).catch(() => {
            // Autoplay blocked — keep thumbnail visible
          });
        } else {
          // Pause when scrolled out of view to save resources
          video.pause();
          video.classList.remove('is-playing');
        }
      });
    }, { root: container.closest('.inspire-content'), threshold: 0.3 });

    videos.forEach(v => videoObserver.observe(v));
  }

  function renderGrid() {
    const grid = overlayEl?.querySelector('#inspireGrid');
    if (!grid) return;

    let filteredCards = [...state.cards];

    // Apply local filter
    if (state.activeFilter === 'models') {
      filteredCards = filteredCards.filter(c => c.type === 'model');
    } else if (state.activeFilter === 'images') {
      filteredCards = filteredCards.filter(c => c.type === 'image');
    } else if (state.activeFilter === 'videos') {
      filteredCards = filteredCards.filter(c => c.type === 'video');
    } else if (state.activeFilter === 'trending') {
      filteredCards = filteredCards.filter(c => c.tags?.includes('trending'));
    }

    if (filteredCards.length === 0) {
      grid.innerHTML = `
        <div class="inspire-empty-state">
          <div class="inspire-empty-state__icon">${ICONS.sparkle}</div>
          <h3>No ${state.activeFilter} found</h3>
          <p>Try a different filter or shuffle for new content!</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = filteredCards.map(renderCard).join('');

    // Store references to card elements for in-place updates
    cardElements = Array.from(grid.querySelectorAll('.inspire-card'));

    // Initialize video autoplay for visible cards
    initCardVideos(grid);
  }

  async function hydrateFeed(options = {}) {
    const { forceRefresh = false } = options;

    if (state.loading) return false;

    if (!forceRefresh && state.cards.length > 0) {
      renderGrid();
      return true;
    }

    updateLoadingState();
    const ok = await fetchInspireContent({ forceRefresh, shuffle: true, type: 'all' });

    if (state.cards.length > 0) {
      renderGrid();
      updatePOTDDisplay();
      return true;
    }

    updateLoadingState();
    return ok;
  }

  /**
   * Update existing card DOM elements in-place (no flicker).
   * Preloads images before swapping src to prevent blank flash.
   */
  async function updateCardsInPlace(cards) {
    const grid = overlayEl?.querySelector('#inspireGrid');
    if (!grid) return;

    // First render: create persistent card elements
    if (cardElements.length === 0) {
      renderGrid();
      return;
    }

    // Ensure we have enough card elements (create with full structure)
    while (cardElements.length < cards.length) {
      const idx = cardElements.length;
      const cardData = cards[idx] || cards[0]; // Use corresponding data or fallback
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = renderCard(cardData);
      const newCard = tempDiv.firstElementChild;
      grid.appendChild(newCard);
      cardElements.push(newCard);
    }

    // Hide extra cards if we have fewer items
    for (let i = cards.length; i < cardElements.length; i++) {
      cardElements[i].style.display = 'none';
    }

    // Preload all images in parallel for instant swap
    const preloadPromises = cards.map(card => {
      const thumbUrl = card.thumb_preview || card.thumbnail || card.thumb_url || '';
      return preloadImage(thumbUrl);
    });

    // Wait for all images to preload (with timeout fallback)
    await Promise.race([
      Promise.all(preloadPromises),
      new Promise(resolve => setTimeout(resolve, 500)) // 500ms max wait
    ]);

    // Update each card element in-place
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const el = cardElements[i];

      if (!el) continue;

      // Show the card
      el.style.display = '';

      // Update data attributes
      el.dataset.id = card.id;
      el.dataset.type = normalizePromptType(card.type);
      el.dataset.thumbPreview = card.thumb_preview || card.thumbnail || card.thumb_url || '';
      el.dataset.thumbRefined = card.thumb_refined || '';
      el.dataset.videoUrl = card.video_url || '';

      // Update class for aspect ratio and refine badge
      const aspect = card.aspect || 'square';
      const normalizedType = normalizePromptType(card.type);
      const hasRefine = card.has_refine || (card.thumb_refined && card.thumb_refined !== el.dataset.thumbPreview);
      el.className = `inspire-card ${aspect}${hasRefine ? ' has-refine' : ''}`;

      // Update image (already preloaded, so instant)
      const img = el.querySelector('.inspire-card__image');
      const thumbUrl = card.thumb_preview || card.thumbnail || card.thumb_url || '';
      if (img && img.src !== thumbUrl) {
        img.src = thumbUrl;
        img.alt = card.prompt || card.title || 'Untitled creation';
      }

      // Update prompt text
      const promptEl = el.querySelector('.inspire-card__prompt');
      if (promptEl) {
        promptEl.textContent = card.prompt || card.title || 'Untitled creation';
      }

      // Update type badge
      const typeBadge = el.querySelector('.inspire-card__type-badge');
      if (typeBadge) {
        const typeIcon = ICONS[normalizedType] || ICONS.model;
        typeBadge.className = `inspire-card__type-badge ${normalizedType}`;
        typeBadge.innerHTML = `${typeIcon}<span>${normalizedType}</span>`;
      }

      const actionBtn = el.querySelector('.inspire-card__action-btn');
      if (actionBtn) {
        const target = workspaceTargetForType(normalizedType);
        actionBtn.title = target.cta;
        actionBtn.setAttribute('aria-label', target.cta);
      }

      // Update tags
      const metaEl = el.querySelector('.inspire-card__meta');
      if (metaEl) {
        const tags = card.tags || ['community'];
        metaEl.innerHTML = tags.map(tag =>
          `<span class="inspire-card__tag ${tag}">${tag.replace('-', ' ')}</span>`
        ).join('');
      }

      // Update video layer
      let videoEl = el.querySelector('.inspire-card__video');
      if (normalizedType === 'video' && card.video_url) {
        if (!videoEl) {
          videoEl = document.createElement('video');
          videoEl.className = 'inspire-card__video';
          videoEl.muted = true;
          videoEl.loop = true;
          videoEl.playsInline = true;
          videoEl.preload = 'none';
          el.querySelector('.inspire-card__media').appendChild(videoEl);
        }
        if (videoEl.src !== card.video_url) {
          videoEl.classList.remove('is-playing');
          videoEl.src = card.video_url;
        }
      } else if (videoEl) {
        videoEl.pause();
        videoEl.remove();
      }

      // Update refined image layer (for model crossfade)
      // Use data-src so refined image only loads on first hover (not eagerly).
      let refinedImg = el.querySelector('.inspire-card__image-refined');
      const thumbRefined = card.thumb_refined || '';
      if (normalizedType === 'model' && hasRefine && thumbRefined) {
        if (!refinedImg) {
          refinedImg = document.createElement('img');
          refinedImg.className = 'inspire-card__image-refined';
          refinedImg.loading = 'lazy';
          refinedImg.decoding = 'async';
          el.querySelector('.inspire-card__media').prepend(refinedImg);
        }
        refinedImg.dataset.src = thumbRefined;
      } else if (refinedImg) {
        refinedImg.remove();
      }

      // Update video badge visibility
      const videoBadge = el.querySelector('.inspire-card__video-badge');
      if (videoBadge) {
        videoBadge.style.display = normalizedType === 'video' ? '' : 'none';
      }

      // Update refine badge visibility
      const refineBadge = el.querySelector('.inspire-card__refine-badge');
      if (refineBadge) {
        refineBadge.style.display = hasRefine ? '' : 'none';
      }

      // Subtle animation for visual feedback
      el.style.opacity = '0.7';
      el.style.transform = 'scale(0.98)';
      requestAnimationFrame(() => {
        el.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
        el.style.opacity = '1';
        el.style.transform = 'scale(1)';
      });
    }

    // Re-initialize video autoplay after shuffle
    initCardVideos(grid);
  }

  // =========================================================================
  // CORE FUNCTIONS
  // =========================================================================

  /**
   * Open Inspire panel
   * @param {Object} options
   * @param {boolean} options.isAuto - True if this is an auto-open (not user initiated)
   */
  function openInspire(options = {}) {
    const { isAuto = false } = options;

    if (state.isOpen || !overlayEl) return;

    // If user manually closed, don't auto-open again
    if (isAuto && state.userManuallyClosed) {
      console.log('[Inspire] Skipping auto-open: user manually closed');
      return;
    }

    state.isOpen = true;
    if (!isAuto) {
      state.userManuallyOpened = true;
    }

    document.body.classList.add('inspire-open');
    overlayEl.style.display = 'flex';
    overlayEl.inert = false;

    // Small delay for CSS transition
    requestAnimationFrame(() => {
      overlayEl.classList.add('is-open');
      overlayEl.querySelector('#inspireCloseBtn')?.focus();
    });

    if (state.cards.length === 0 && !state.loading) {
      hydrateFeed({ forceRefresh: true }).catch((err) => {
        console.warn('[Inspire] Failed to hydrate feed on open:', err?.message || err);
      });
    } else if (state.cards.length > 0) {
      renderGrid();
    } else {
      updateLoadingState();
    }

    // Re-initialize video autoplay when panel opens
    const grid = overlayEl.querySelector('#inspireGrid');
    if (grid) initCardVideos(grid);

    window.dispatchEvent(new CustomEvent('inspire:open'));
  }

  /**
   * Close Inspire panel
   * @param {Object} options
   * @param {boolean} options.isManual - True if user explicitly closed (not programmatic)
   */
  function closeInspire(options = {}) {
    const { isManual = false } = options;

    if (!state.isOpen || !overlayEl) return;

    // Track user intent
    if (isManual) {
      state.userManuallyClosed = true;
    }

    // Move focus before hiding for accessibility
    const triggerBtn = document.getElementById('inspireTriggerBtn');
    if (overlayEl.contains(document.activeElement) && triggerBtn) {
      triggerBtn.focus();
    }

    state.isOpen = false;
    document.body.classList.remove('inspire-open');
    overlayEl.classList.remove('is-open');
    overlayEl.inert = true;

    // Pause all card videos and disconnect observer to free resources
    if (videoObserver) videoObserver.disconnect();
    overlayEl.querySelectorAll('.inspire-card__video').forEach(v => {
      v.pause();
      v.classList.remove('is-playing');
    });

    // Hide after transition
    setTimeout(() => {
      if (!state.isOpen) {
        overlayEl.style.display = 'none';
      }
    }, 300);

    window.dispatchEvent(new CustomEvent('inspire:close'));
  }

  /**
   * Toggle Inspire panel (user-initiated)
   */
  function toggleInspire() {
    if (state.isOpen) {
      closeInspire({ isManual: true });
    } else {
      // Reset manual close flag when user explicitly opens
      state.userManuallyClosed = false;
      openInspire({ isAuto: false });
    }
  }

  /**
   * Shuffle - INSTANT local shuffle from pool, no network call.
   * Uses in-place DOM updates to prevent flicker.
   */
  async function shuffleCards() {
    // Debounce: ignore rapid clicks while shuffling
    if (isShuffling) {
      return;
    }
    isShuffling = true;

    try {
      // Ensure pool is loaded (fetches once, then cached for 10 min)
      const poolReady = await ensurePoolLoaded();

      if (poolReady && INSPIRE_POOL.length > 0) {
        // Shuffle the entire pool locally (Fisher-Yates)
        INSPIRE_POOL = shuffleArray(INSPIRE_POOL);

        // Take first DISPLAY_LIMIT cards for display
        state.cards = INSPIRE_POOL.slice(0, DISPLAY_LIMIT);

        // Update cards in-place (no DOM rebuild = no flicker)
        await updateCardsInPlace(state.cards);
      } else {
        // Fallback: shuffle existing cards locally
        if (state.cards.length > 0) {
          state.cards = shuffleArray(state.cards);
          await updateCardsInPlace(state.cards);
        }
      }

      setPromptOfTheDay(pickPromptEntry(promptTypeForActiveFilter()));
    } finally {
      // Allow next shuffle after a small delay (prevents spam)
      setTimeout(() => {
        isShuffling = false;
      }, 150);
    }
  }

  function animateCards() {
    const cards = overlayEl?.querySelectorAll('.inspire-card');
    cards?.forEach((card, i) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(20px)';
      setTimeout(() => {
        card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        card.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, i * 30);
    });
  }

  async function applyFilter(filterId) {
    state.activeFilter = filterId;

    // Update filter button states
    overlayEl?.querySelectorAll('.inspire-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filterId);
    });

    // Ensure pool is loaded for filtering
    await ensurePoolLoaded();

    // Filter from the pool (no network call)
    if (INSPIRE_POOL && INSPIRE_POOL.length > 0) {
      let filtered = [...INSPIRE_POOL];

      if (filterId === 'models') {
        filtered = filtered.filter(c => c.type === 'model');
      } else if (filterId === 'images') {
        filtered = filtered.filter(c => c.type === 'image');
      } else if (filterId === 'videos') {
        filtered = filtered.filter(c => c.type === 'video');
      } else if (filterId === 'trending') {
        filtered = filtered.filter(c => c.tags?.includes('trending'));
      }

      // Update state.cards with filtered results
      state.cards = filtered.slice(0, DISPLAY_LIMIT);
    }

    // Re-render (renderGrid also applies activeFilter)
    renderGrid();
  }

  function findPromptInputByType(type) {
    const target = workspaceTargetForType(type);
    for (const selector of target.inputSelectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return document.querySelector('#modelPrompt, #imagePrompt, #videoTextPrompt, #videoMotion, #texturePrompt, textarea[name="prompt"]');
  }

  function openWorkspacePanel(type) {
    const normalizedType = normalizePromptType(type);
    const target = workspaceTargetForType(normalizedType);
    const panelBtn = document.querySelector(`[data-panel="${target.panel}"]`);
    if (panelBtn) {
      panelBtn.click();
    }

    if (normalizedType === 'video') {
      const videoModeValue = document.getElementById('videoModeValue');
      if (videoModeValue) {
        videoModeValue.value = 'text2video';
      }

      document.querySelectorAll('.video-mode-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-mode') === 'text2video');
      });

      document.getElementById('text2videoContent')?.classList.remove('hidden');
      document.getElementById('image2videoContent')?.classList.add('hidden');
    }
  }

  function fillPromptInput(promptInput, prompt) {
    if (!promptInput) return;
    promptInput.value = prompt;
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    promptInput.dispatchEvent(new Event('change', { bubbles: true }));
    promptInput.focus();
    promptInput.classList.add('inspire-filled');
    setTimeout(() => promptInput.classList.remove('inspire-filled'), 1000);
  }

  function usePrompt(promptOrEntry, fallbackType = 'model') {
    const promptEntry = normalizePromptEntry(promptOrEntry, fallbackType);
    openWorkspacePanel(promptEntry.type);
    fillPromptInput(findPromptInputByType(promptEntry.type), promptEntry.prompt);

    closeInspire({ isManual: false });
    window.dispatchEvent(new CustomEvent('inspire:prompt-used', {
      detail: {
        prompt: promptEntry.prompt,
        type: promptEntry.type,
        title: promptEntry.title
      }
    }));
  }

  // =========================================================================
  // EVENT HANDLERS
  // =========================================================================

  function handleCardClick(e) {
    const card = e.target.closest('.inspire-card');
    if (!card) return;

    const actionBtn = e.target.closest('.inspire-card__action-btn');
    const cardData = state.cards.find(c => c.id === card.dataset.id);

    if (actionBtn && cardData) {
      e.stopPropagation();
      if (actionBtn.dataset.action === 'use') {
        usePrompt({
          prompt: cardData.prompt,
          type: cardData.type,
          title: cardData.title || '',
          providerHint: cardData.providerHint || ''
        }, cardData.type);
      }
      return;
    }

    // Click on card itself: load content into viewer based on type
    if (cardData) {
      loadContentIntoViewer(cardData);
    }
  }

  /**
   * Load content from Inspire card into the appropriate viewer
   * @param {Object} cardData - The card data with type, thumbnail, glb_url, video_url, image_url
   */
  function loadContentIntoViewer(cardData) {
    const type = cardData.type;
    console.log('[Inspire] Loading content into viewer:', type, cardData.id);

    // Close Inspire panel (not manual - programmatic close after selection)
    closeInspire({ isManual: false });

    // Small delay to let the panel close animation start
    requestAnimationFrame(() => {
      if (type === 'model') {
        loadModelIntoViewer(cardData);
      } else if (type === 'video') {
        loadVideoIntoViewer(cardData);
      } else if (type === 'image') {
        loadImageIntoViewer(cardData);
      }
    });

    window.dispatchEvent(new CustomEvent('inspire:content-loaded', {
      detail: { type, id: cardData.id }
    }));
  }

  /**
   * Load a 3D model into the viewer.
   * Uses the existing Three.js viewer if available, or falls back to <model-viewer>.
   */
  function loadModelIntoViewer(cardData) {
    // Get URLs - check multiple possible field names from API
    const thumbnailUrl = cardData.thumb_preview || cardData.thumbnail || cardData.thumb_url;
    const glbUrl = cardData.glb_url || cardData.glb_proxy || cardData.model_url || cardData.url;

    console.log('[Inspire] Loading model:', { id: cardData.id, glbUrl, thumbnailUrl, hasViewer: !!window.timrx3D });

    // Switch to model panel first
    const modelRailBtn = document.querySelector('[data-panel="model"]');
    if (modelRailBtn) modelRailBtn.click();

    // Try to load 3D model if we have a GLB URL
    if (glbUrl) {
      loadModelWithViewer(cardData, glbUrl, thumbnailUrl);
    } else if (thumbnailUrl) {
      // No GLB URL - show thumbnail as preview
      console.log('[Inspire] No GLB URL, showing thumbnail preview');
      showModelAsThumbnail(cardData, thumbnailUrl);
    } else {
      // No URLs at all - just use the prompt
      console.warn('[Inspire] No GLB URL or thumbnail for model:', cardData.id);
      usePrompt(cardData.prompt);
    }
  }

  /**
   * Load model using the existing Three.js scene directly.
   * This works even if window.Viewer isn't exposed.
   */
  async function loadModelWithViewer(cardData, glbUrl, thumbnailUrl) {
    // Method 1: Use window.Viewer if available
    if (window.Viewer?.loadGlbFromUrl) {
      try {
        console.log('[Inspire] Loading via window.Viewer.loadGlbFromUrl');
        await window.Viewer.loadGlbFromUrl(glbUrl);
        console.log('[Inspire] Model loaded via Viewer');
        if (cardData.prompt) usePrompt(cardData.prompt, 'model');
        return;
      } catch (err) {
        console.error('[Inspire] Viewer.loadGlbFromUrl failed:', err);
      }
    }

    // Method 2: Use window.loadGlbFromUrl directly
    if (typeof window.loadGlbFromUrl === 'function') {
      try {
        console.log('[Inspire] Loading via window.loadGlbFromUrl');
        await window.loadGlbFromUrl(glbUrl);
        console.log('[Inspire] Model loaded via loadGlbFromUrl');
        if (cardData.prompt) usePrompt(cardData.prompt, 'model');
        return;
      } catch (err) {
        console.error('[Inspire] loadGlbFromUrl failed:', err);
      }
    }

    // Method 3: Load directly using Three.js and timrx3D scene
    if (window.timrx3D?.scene && window.THREE?.GLTFLoader) {
      try {
        console.log('[Inspire] Loading directly via THREE.GLTFLoader');
        await loadGlbDirectly(glbUrl, cardData);
        console.log('[Inspire] Model loaded directly into scene');
        if (cardData.prompt) usePrompt(cardData.prompt, 'model');
        return;
      } catch (err) {
        console.error('[Inspire] Direct GLTFLoader failed:', err);
      }
    }

    // All methods failed - show thumbnail
    console.warn('[Inspire] No viewer available, showing thumbnail. State:', {
      'window.Viewer': !!window.Viewer,
      'window.loadGlbFromUrl': typeof window.loadGlbFromUrl,
      'window.timrx3D': !!window.timrx3D,
      'THREE.GLTFLoader': !!window.THREE?.GLTFLoader
    });
    showModelAsThumbnail(cardData, thumbnailUrl);
  }

  /**
   * Load GLB directly into the Three.js scene using timrx3D.
   * Fallback when window.Viewer isn't exposed.
   */
  async function loadGlbDirectly(glbUrl, cardData) {
    const { scene, camera } = window.timrx3D;
    const THREE = window.THREE;

    if (!scene || !THREE?.GLTFLoader) {
      throw new Error('Three.js scene or GLTFLoader not available');
    }

    // Clear ALL existing models (both from Inspire and from viewer.js/history)
    clearAllModelsFromScene(scene, THREE);

    // Hide placeholder cube if it exists
    if (window.placeholderCube) {
      window.placeholderCube.visible = false;
    }

    // Load the GLB
    const loader = new THREE.GLTFLoader();
    loader.setCrossOrigin('anonymous');

    return new Promise((resolve, reject) => {
      loader.load(
        glbUrl,
        (gltf) => {
          const model = gltf.scene;
          model.name = 'inspireModel';
          model.userData.isInspireModel = true; // Mark for identification

          // Center the model on XZ plane, ground on Y
          const box = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());

          model.position.x = -center.x;
          model.position.z = -center.z;
          model.position.y = -box.min.y - 0.5; // Ground on grid (grid y = -0.5)

          scene.add(model);

          // Store reference globally so viewer.js can clear it
          window.inspireCurrentModel = model;

          // Calculate camera position to frame the model nicely
          const maxDim = Math.max(size.x, size.y, size.z);
          const fov = camera.fov * (Math.PI / 180);
          const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.8;

          // Position camera at an angle looking at model center (grounded on grid at -0.5)
          const modelCenter = new THREE.Vector3(0, (size.y / 2) - 0.5, 0);
          camera.position.set(
            cameraDistance * 0.6,
            cameraDistance * 0.4,
            cameraDistance * 0.6
          );
          camera.lookAt(modelCenter);
          camera.updateProjectionMatrix();

          // Update orbit controls
          if (window.timrxControls) {
            window.timrxControls.target.copy(modelCenter);
            window.timrxControls.update();
          }

          // Show viewer toolbar if available
          const toolbar = document.getElementById('viewerToolbar');
          if (toolbar) toolbar.classList.add('visible');

          // Hide placeholder
          const placeholder = document.getElementById('viewerPlaceholder');
          if (placeholder) placeholder.style.display = 'none';

          resolve();
        },
        undefined,
        (err) => {
          console.error('[Inspire] GLTFLoader error:', err);
          reject(err);
        }
      );
    });
  }

  /**
   * Clear all loaded models from the scene (both Inspire and viewer.js models).
   */
  function clearAllModelsFromScene(scene, THREE) {
    const modelsToRemove = [];

    // Find all models to remove (skip lights, cameras, helpers, grid)
    scene.traverse((obj) => {
      // Check if it's a model we should remove
      if (obj.name === 'inspireModel' ||
          obj.userData?.isInspireModel ||
          obj.userData?.isLoadedModel ||
          (obj.type === 'Group' && obj.parent === scene && !obj.isLight && !obj.isCamera)) {
        // Don't remove grid helpers, lights, or the placeholder cube
        if (!obj.isGridHelper && !obj.isLight && !obj.userData?.isPlaceholder) {
          modelsToRemove.push(obj);
        }
      }
    });

    // Remove and dispose each model
    modelsToRemove.forEach(model => {
      scene.remove(model);
      model.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    });

    // Also clear viewer.js's currentModel reference if it exists
    if (window.inspireCurrentModel) {
      window.inspireCurrentModel = null;
    }

    console.log(`[Inspire] Cleared ${modelsToRemove.length} model(s) from scene`);
  }

  /**
   * Show model thumbnail as an image (fallback when 3D viewer unavailable)
   */
  function showModelAsThumbnail(cardData, thumbnailUrl) {
    // Switch to image panel to show the thumbnail
    const imageRailBtn = document.querySelector('[data-panel="image"]');
    if (imageRailBtn) imageRailBtn.click();

    // Show thumbnail in image viewer
    const imageEl = document.getElementById('generatedImage');
    if (imageEl) {
      imageEl.src = thumbnailUrl;
      imageEl.classList.remove('hidden');
      imageEl.alt = cardData.title || 'Model Preview';
    }

    // Update title if available
    const viewerTitle = document.getElementById('viewerTitle');
    if (viewerTitle) {
      viewerTitle.textContent = cardData.title || '3D Model Preview';
    }

    // Fill the prompt so user can generate similar
    if (cardData.prompt) {
      usePrompt(cardData.prompt, 'model');
    }
  }

  /**
   * Load a video into the video viewer
   */
  function loadVideoIntoViewer(cardData) {
    // Switch to video panel
    const videoRailBtn = document.querySelector('[data-panel="video"]');
    if (videoRailBtn) videoRailBtn.click();

    const videoUrl = cardData.video_url || cardData.url;

    if (!videoUrl) {
      console.warn('[Inspire] No video URL found:', cardData.id);
      usePrompt(cardData.prompt, 'video');
      return;
    }

    // Use the Viewer module if available
    if (window.Viewer?.showVideoInViewer) {
      window.Viewer.showVideoInViewer(videoUrl, {
        title: cardData.title || 'Inspire Video',
        hint: cardData.prompt || 'From Inspire gallery',
        autoplay: true
      });
    } else {
      // Fallback: try to find video element directly
      const videoEl = document.getElementById('generatedVideo');
      if (videoEl) {
        videoEl.src = videoUrl;
        videoEl.classList.remove('hidden');
        videoEl.load();
        videoEl.play().catch(() => {});
      }
    }
  }

  /**
   * Load an image into the image viewer
   */
  function loadImageIntoViewer(cardData) {
    // Switch to image panel
    const imageRailBtn = document.querySelector('[data-panel="image"]');
    if (imageRailBtn) imageRailBtn.click();

    const imageUrl = cardData.thumb_refined || cardData.image_url || cardData.thumbnail || cardData.thumb_url;

    if (!imageUrl) {
      console.warn('[Inspire] No image URL found:', cardData.id);
      usePrompt(cardData.prompt, 'image');
      return;
    }

    // Use the Viewer module if available
    if (window.Viewer?.showImageInViewer) {
      window.Viewer.showImageInViewer(imageUrl);
    } else {
      // Fallback: try to find image element directly
      const imgEl = document.getElementById('generatedImage');
      const placeholder = document.getElementById('imagePlaceholder');
      if (imgEl) {
        imgEl.src = imageUrl;
        imgEl.classList.remove('hidden');
      }
      if (placeholder) {
        placeholder.classList.add('hidden');
      }
    }
  }

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  function createOverlay() {
    document.getElementById('inspireOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'inspire-overlay';
    overlay.id = 'inspireOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Inspiration gallery');

    // Positioning
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '60px',
      left: 'calc(12px + 44px + 12px + clamp(265px, 21vw, 345px) + 12px)',
      right: '12px',
      bottom: '12px',
      zIndex: '50000',
      background: 'rgba(8, 8, 12, 0.98)',
      borderRadius: '16px',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      boxShadow: '0 25px 80px rgba(0, 0, 0, 0.6)',
      overflowY: 'auto',
      display: 'none',
      flexDirection: 'column',
      opacity: '0',
      transform: 'translateY(10px)',
      transition: 'opacity 0.25s ease, transform 0.25s ease'
    });

    // Get initial POTD from cache or fallback
    const potd = normalizePromptEntry(memoryCache.promptOfTheDay || pickPromptEntry(promptTypeForActiveFilter()));
    const potdTarget = workspaceTargetForType(potd.type);

    overlay.innerHTML = `
      <header class="inspire-header">
        <div class="inspire-header__left">
          <div class="inspire-header__icon">${ICONS.sparkle}</div>
          <div class="inspire-header__title">
            <h2>Get Inspired</h2>
            <p>Discover amazing creations</p>
          </div>
        </div>
        <div class="inspire-header__actions">
          <button class="inspire-shuffle-btn" id="inspireShuffleBtn" type="button">
            ${ICONS.shuffle}<span>Surprise Me</span>
          </button>
          <button class="inspire-close-btn" id="inspireCloseBtn" type="button" aria-label="Close">
            ${ICONS.close}
          </button>
        </div>
      </header>

      <div class="inspire-content">
        <div class="inspire-potd">
          <div class="inspire-potd__badge">${ICONS.star}</div>
          <div class="inspire-potd__content">
            <div class="inspire-potd__meta">
              <div class="inspire-potd__label">Prompt of the Day</div>
              <div class="inspire-potd__target ${potd.type}" id="inspirePotdTarget">${potdTarget.label}</div>
            </div>
            <p class="inspire-potd__prompt">${potd.prompt}</p>
            <p class="inspire-potd__hint" id="inspirePotdHint">${potd.providerHint || potd.hint || ''}</p>
          </div>
          <button class="inspire-potd__cta" data-action="use-potd">
            ${ICONS.use}<span id="inspirePotdCtaLabel">${potdTarget.cta}</span>
          </button>
        </div>

        <div class="inspire-filters" id="inspireFilters">${renderFilters()}</div>

        <section class="inspire-section">
          <div class="inspire-section__header">
            <h3 class="inspire-section__title">Explore</h3>
          </div>
          <div class="inspire-grid" id="inspireGrid"></div>
        </section>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function bindEvents() {
    if (!overlayEl || boundListeners) return;
    boundListeners = true;

    // Close button (manual close)
    overlayEl.querySelector('#inspireCloseBtn')?.addEventListener('click', () => {
      closeInspire({ isManual: true });
    });

    // Shuffle button
    overlayEl.querySelector('#inspireShuffleBtn')?.addEventListener('click', shuffleCards);

    // Backdrop click (manual close)
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) {
        closeInspire({ isManual: true });
      }
    });

    // Card clicks (delegated)
    overlayEl.querySelector('#inspireGrid')?.addEventListener('click', handleCardClick);

    // POTD button
    overlayEl.querySelector('[data-action="use-potd"]')?.addEventListener('click', () => {
      usePrompt(memoryCache.promptOfTheDay || pickPromptEntry(promptTypeForActiveFilter()));
    });

    // Filter buttons (delegated)
    overlayEl.querySelector('#inspireFilters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.inspire-filter-btn');
      if (btn) applyFilter(btn.dataset.filter);
    });

    // Hover thumbnail swap (all devices - animations run by default,
    // hover swap is additive for desktop users)
    const grid = overlayEl.querySelector('#inspireGrid');
    if (grid) {
      grid.addEventListener('mouseenter', handleCardHoverIn, true);
      grid.addEventListener('mouseleave', handleCardHoverOut, true);
    }

    // Keyboard - ESC to close (manual)
    document.addEventListener('keydown', (e) => {
      if (state.isOpen && e.key === 'Escape') {
        e.preventDefault();
        closeInspire({ isManual: true });
      }
    });

    // External trigger button (toggle)
    document.getElementById('inspireTriggerBtn')?.addEventListener('click', toggleInspire);

    // =========================================================================
    // CLOSE TRIGGERS - Close Inspire when specific actions occur
    // =========================================================================

    // Close on ANY Generate button click
    document.addEventListener('click', (e) => {
      if (!state.isOpen) return;

      const generateBtn = e.target.closest(
        '#generateModelBtn, #generateImageBtn, #generateVideoBtn, ' +
        '#applyRemeshBtn, #generateTextureBtn, ' +
        '[data-action="generate"], button[id*="generate"]'
      );

      if (generateBtn) {
        console.log('[Inspire] Closing: Generate button clicked');
        closeInspire({ isManual: false });
      }
    });

    // Close when navbar/menu is clicked
    // Use capture phase to catch clicks before stopPropagation() in initExpandedView
    document.addEventListener('click', (e) => {
      if (!state.isOpen) return;

      // Check for nav dropdown triggers, ws-nav links, and expanded view triggers
      const navTrigger = e.target.closest(
        '[data-nav-toggle], ' +
        '.ws-nav__menu-btn, [data-menu-toggle], ' +
        '.ws-nav-link, .ws-nav a, .ws-nav button, ' +
        '.ws-dropdown-item, ' +
        '[data-open-tutorials], [data-open-community], [data-open-converter], [data-open-about], [data-open-docs]'
      );

      if (navTrigger) {
        console.log('[Inspire] Closing: Nav element clicked');
        closeInspire({ isManual: false });
      }
    }, { capture: true });

    // Close when a generation process starts (listen for custom events)
    window.addEventListener('generation:start', () => {
      if (state.isOpen) {
        console.log('[Inspire] Closing: Generation started');
        closeInspire({ isManual: false });
      }
    });

    // Close when user switches workspace panels (rail buttons)
    document.addEventListener('click', (e) => {
      if (!state.isOpen) return;

      const railBtn = e.target.closest('.rail-btn');
      if (railBtn) {
        console.log('[Inspire] Closing: Workspace panel switched');
        closeInspire({ isManual: false });
      }
    });
  }

  // =========================================================================
  // HOVER THUMBNAIL SWAP (desktop only)
  // =========================================================================

  async function handleCardHoverIn(e) {
    const card = e.target.closest('.inspire-card.has-refine');
    if (!card) return;

    const img = card.querySelector('.inspire-card__image');
    const refined = card.dataset.thumbRefined;

    if (img && refined) {
      // Store current src for revert
      if (!img.dataset.originalSrc) {
        img.dataset.originalSrc = img.src;
      }

      // Lazy-load the refined <img> layer on first hover (data-src → src).
      // This defers ~50% of image bandwidth until user actually interacts.
      const refinedImg = card.querySelector('.inspire-card__image-refined');
      if (refinedImg && refinedImg.dataset.src && !refinedImg.src) {
        refinedImg.src = refinedImg.dataset.src;
        delete refinedImg.dataset.src;
      }

      // Preload refined image before swapping to prevent flash
      await preloadImage(refined);
      // Only swap if still hovering (check card is still hovered)
      if (card.matches(':hover')) {
        img.src = refined;
      }
    }
  }

  async function handleCardHoverOut(e) {
    const card = e.target.closest('.inspire-card.has-refine');
    if (!card) return;

    const img = card.querySelector('.inspire-card__image');
    const preview = card.dataset.thumbPreview;

    if (img && preview) {
      // Preview should already be cached, but preload just in case
      await preloadImage(preview);
      img.src = preview;
    }
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Load localStorage cache first for instant display
    loadCachedContent();

    // Create overlay
    overlayEl = createOverlay();

    // Set initial inert state (hidden)
    if (overlayEl) {
      overlayEl.inert = true;
    }

    bindEvents();

    // Track if we have content ready for instant display
    let hasContentReady = false;

    // Render cached content immediately for instant display
    if (memoryCache.cards?.length > 0) {
      state.cards = memoryCache.cards.slice(0, DISPLAY_LIMIT);
      memoryCache.promptOfTheDay = normalizePromptEntry(memoryCache.promptOfTheDay || pickPromptEntry(promptTypeForActiveFilter()));
      // Also populate pool from cache for instant shuffles
      INSPIRE_POOL = [...memoryCache.cards];
      INSPIRE_POOL_TS = memoryCache.timestamp || 0;
      renderGrid();
      hasContentReady = true;
      console.log('[Inspire] Rendered cached content');
    }

    // Load the full pool AFTER critical startup (auth/history/wallet/jobs)
    // completes. main.js dispatches 'timrx:startup-complete' when Phase 3
    // finishes. We wait for that signal (with a 6s fallback if it never
    // fires) plus a short additional delay so inspire doesn't immediately
    // compete with the first user interaction.
    const poolLoader = new Promise(resolve => {
      let resolved = false;
      const go = () => { if (!resolved) { resolved = true; resolve(); } };
      window.addEventListener('timrx:startup-complete', () => setTimeout(go, 1500), { once: true });
      setTimeout(go, 8000); // fallback if startup-complete never fires
    }).then(() => ensurePoolLoaded());
    const poolLoadPromise = poolLoader.then(success => {
      if (success && INSPIRE_POOL.length > 0) {
        // If no cards were rendered yet, show from pool
        if (state.cards.length === 0) {
          state.cards = shuffleArray(INSPIRE_POOL).slice(0, DISPLAY_LIMIT);
          renderGrid();
        }
        // Update POTD display
        updatePOTDDisplay();
        return true;
      }
      return false;
    });

    if (!hasContentReady) {
      updateLoadingState();
      hydrateFeed({ forceRefresh: false }).catch((err) => {
        console.warn('[Inspire] Initial feed hydrate failed:', err?.message || err);
      });
    }

    console.log('[Inspire] Initialized');

    // =========================================================================
    // SESSION-SCOPED AUTO-OPEN
    // =========================================================================
    // Auto-open ONLY if:
    // 1. Not already shown this session (sessionStorage check)
    // 2. User hasn't manually closed previously
    // 3. This is a fresh workspace load (not a reload or re-render)

    if (!hasShownThisSession() && !state.userManuallyClosed) {
      console.log('[Inspire] Auto-opening (first time this session)');
      markAutoOpenDone();

      if (hasContentReady) {
        // Cache exists - open after short delay for smooth UX
        setTimeout(() => {
          openInspire({ isAuto: true });
        }, CONFIG.AUTO_OPEN_DELAY);
      } else {
        // No cache - wait for pool to load, then open
        // This ensures content is ready when panel opens
        poolLoadPromise.then(success => {
          if (success) {
            setTimeout(() => {
              openInspire({ isAuto: true });
            }, 100); // Shorter delay since we already waited for fetch
          }
        });
      }
    } else {
      console.log('[Inspire] Skipping auto-open (already shown this session or user closed)');
    }
  }

  function updatePOTDDisplay() {
    if (!overlayEl) return;

    const promptEntry = normalizePromptEntry(memoryCache.promptOfTheDay || pickPromptEntry(promptTypeForActiveFilter()));
    const potdEl = overlayEl.querySelector('.inspire-potd__prompt');
    const targetEl = overlayEl.querySelector('#inspirePotdTarget');
    const hintEl = overlayEl.querySelector('#inspirePotdHint');
    const ctaLabelEl = overlayEl.querySelector('#inspirePotdCtaLabel');
    const target = workspaceTargetForType(promptEntry.type);

    if (potdEl) {
      potdEl.textContent = promptEntry.prompt;
    }
    if (targetEl) {
      targetEl.className = `inspire-potd__target ${promptEntry.type}`;
      targetEl.textContent = target.label;
    }
    if (hintEl) {
      hintEl.textContent = promptEntry.providerHint || promptEntry.hint || '';
      hintEl.style.display = hintEl.textContent ? '' : 'none';
    }
    if (ctaLabelEl) {
      ctaLabelEl.textContent = target.cta;
    }
  }

  // =========================================================================
  // CSS FOR IS-OPEN STATE
  // =========================================================================

  // Add CSS for open state transition
  const style = document.createElement('style');
  style.textContent = `
    .inspire-overlay.is-open {
      opacity: 1 !important;
      transform: translateY(0) !important;
    }
  `;
  document.head.appendChild(style);

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  window.TimrXInspire = {
    init,
    open: () => openInspire({ isAuto: false }),
    openVideos: () => { openInspire({ isAuto: false }); applyFilter('videos'); },
    close: () => closeInspire({ isManual: true }),
    toggle: toggleInspire,
    shuffle: shuffleCards,
    isOpen: () => state.isOpen,
    usePrompt,
    refresh: () => fetchInspireContent({ forceRefresh: true }),
    // Additional methods for external control
    loadContent: loadContentIntoViewer,
    resetSession: () => {
      // Reset session state (useful for testing)
      state.userManuallyClosed = false;
      state.hasAutoOpenedThisSession = false;
      try {
        sessionStorage.removeItem(CONFIG.SESSION_KEY);
      } catch (e) {}
    }
  };

  // Allow external cache invalidation (e.g. after history deletion)
  window.addEventListener('inspire:invalidate', () => {
    INSPIRE_POOL = null;
    INSPIRE_POOL_TS = 0;
    memoryCache = { promptOfTheDay: null, cards: [], timestamp: 0 };
    try { localStorage.removeItem(CONFIG.CACHE_KEY); } catch (_) { /* ok */ }
    console.log('[Inspire] Cache invalidated by external event');
  });

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

})();
