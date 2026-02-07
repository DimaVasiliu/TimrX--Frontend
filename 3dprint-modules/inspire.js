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
  // CURATED FALLBACK PROMPTS
  // =========================================================================

  const CREATIVE_PROMPTS = [
    "A mystical forest guardian made of twisted ancient vines and glowing mushrooms, ethereal atmosphere",
    "Crystal dragon with iridescent scales perched on a volcanic rock formation, magma glow",
    "Cyberpunk street food vendor stall with holographic menu, neon signs, steam rising",
    "Robot samurai in meditation pose, cherry blossoms, zen garden background",
    "Underwater temple ruins with coral growing through marble columns",
    "Floating sky island with waterfalls cascading into clouds, tiny village on top",
    "Biomechanical heart with organic tubes and metallic chambers, pulsing energy",
    "Space station observation deck overlooking Saturn's rings",
    "Wizard's study filled with floating books, glowing potions, telescope",
    "Steampunk owl messenger with brass wings and clockwork eyes",
    "Ancient treasure chest overflowing with glowing magical artifacts",
    "Japanese temple at sunset with cherry blossoms and lanterns, koi pond"
  ];

  // =========================================================================
  // MOCK FEED GENERATOR (fallback when API + cache both fail)
  // =========================================================================

  function generateMockFeed(count = 12) {
    const types = ['model', 'model', 'image', 'image', 'video'];
    const sizes = ['sm', 'sm', 'md', 'md', 'lg'];
    const cards = [];

    for (let i = 0; i < count; i++) {
      const type = types[i % types.length];
      const prompt = CREATIVE_PROMPTS[i % CREATIVE_PROMPTS.length];
      cards.push({
        id: `ins-mock-${i}`,
        type: type,
        prompt: prompt,
        title: prompt.slice(0, 50),
        thumbnail: '', // Will be filtered out, but shows empty state is intentional
        size: sizes[i % sizes.length],
        tags: ['community'],
        created_at: new Date().toISOString()
      });
    }

    return {
      promptOfTheDay: {
        prompt: CREATIVE_PROMPTS[Math.floor(Math.random() * CREATIVE_PROMPTS.length)],
        category: 'creative'
      },
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
          thumbnail: card.thumb_url || card.thumbnail || card.thumbnail_url || ''
        })).filter(card => card.thumbnail);

        INSPIRE_POOL = cards;
        INSPIRE_POOL_TS = Date.now();

        // Also update memoryCache for POTD
        if (result.data.prompt_of_the_day) {
          memoryCache.promptOfTheDay = result.data.prompt_of_the_day;
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

        // Normalize card format (backend uses thumb_url, we also support thumbnail)
        const cards = (data.cards || []).map(card => ({
          ...card,
          thumbnail: card.thumb_url || card.thumbnail || card.thumbnail_url || ''
        })).filter(card => card.thumbnail); // Only cards with valid thumbnails

        // Update state and cache
        memoryCache.promptOfTheDay = data.prompt_of_the_day;
        memoryCache.cards = cards;
        state.cards = [...cards];

        saveCacheContent({
          promptOfTheDay: data.prompt_of_the_day,
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
      memoryCache.promptOfTheDay = mock.promptOfTheDay;
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

  function getRandomPrompt() {
    return CREATIVE_PROMPTS[Math.floor(Math.random() * CREATIVE_PROMPTS.length)];
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

  function renderCard(card) {
    const tags = card.tags || ['community'];
    const tagsHTML = tags.map(tag =>
      `<span class="inspire-card__tag ${tag}">${tag.replace('-', ' ')}</span>`
    ).join('');

    const typeIcon = ICONS[card.type] || ICONS.model;
    // Use normalized thumbnail fields (thumb_preview preferred, fallback to legacy)
    const thumbPreview = card.thumb_preview || card.thumbnail || card.thumb_url || '';
    const thumbRefined = card.thumb_refined || '';  // May be empty
    const hasRefine = card.has_refine || (thumbRefined && thumbRefined !== thumbPreview);
    const prompt = card.prompt || card.title || 'Untitled creation';
    const aspect = card.aspect || 'square';

    // Pure thumbnail-based cards - NO WebGL, NO Three.js
    // Store both thumbnail URLs in data attributes for hover swap
    return `
      <article class="inspire-card ${aspect}${hasRefine ? ' has-refine' : ''}"
               data-id="${card.id}"
               data-type="${card.type}"
               data-thumb-preview="${thumbPreview}"
               data-thumb-refined="${thumbRefined}">
        <div class="inspire-card__media">
          <img class="inspire-card__image"
               src="${thumbPreview}"
               alt="${prompt}"
               loading="lazy"
               decoding="async"/>
          ${card.type === 'video' ? '<div class="inspire-card__video-badge">&#9658;</div>' : ''}
          ${hasRefine ? '<div class="inspire-card__refine-badge" title="Refined version available">&#10024;</div>' : ''}
        </div>
        <div class="inspire-card__type-badge ${card.type}">${typeIcon}<span>${card.type}</span></div>
        <div class="inspire-card__actions">
          <button class="inspire-card__action-btn" data-action="use" title="Use Prompt">${ICONS.use}</button>
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
      el.dataset.type = card.type;
      el.dataset.thumbPreview = card.thumb_preview || card.thumbnail || card.thumb_url || '';
      el.dataset.thumbRefined = card.thumb_refined || '';

      // Update class for aspect ratio and refine badge
      const aspect = card.aspect || 'square';
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
        const typeIcon = ICONS[card.type] || ICONS.model;
        typeBadge.className = `inspire-card__type-badge ${card.type}`;
        typeBadge.innerHTML = `${typeIcon}<span>${card.type}</span>`;
      }

      // Update tags
      const metaEl = el.querySelector('.inspire-card__meta');
      if (metaEl) {
        const tags = card.tags || ['community'];
        metaEl.innerHTML = tags.map(tag =>
          `<span class="inspire-card__tag ${tag}">${tag.replace('-', ' ')}</span>`
        ).join('');
      }

      // Update video badge visibility
      const videoBadge = el.querySelector('.inspire-card__video-badge');
      if (videoBadge) {
        videoBadge.style.display = card.type === 'video' ? '' : 'none';
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

      // Update POTD with random prompt
      const potdEl = overlayEl?.querySelector('.inspire-potd__prompt');
      if (potdEl) {
        potdEl.textContent = getRandomPrompt();
      }
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

  function usePrompt(prompt) {
    // Find active prompt input
    const promptInput = document.querySelector(
      '#modelPrompt, #imagePrompt, #texturePrompt, #videoTextPrompt, textarea[name="prompt"]'
    );

    if (promptInput) {
      promptInput.value = prompt;
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.focus();

      // Visual feedback
      promptInput.classList.add('inspire-filled');
      setTimeout(() => promptInput.classList.remove('inspire-filled'), 1000);
    }

    closeInspire();
    window.dispatchEvent(new CustomEvent('inspire:prompt-used', { detail: { prompt } }));
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
        usePrompt(cardData.prompt);
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
   * Load a 3D model - show thumbnail preview and fill prompt
   * Simple approach: display the model thumbnail and let user generate similar
   */
  function loadModelIntoViewer(cardData) {
    // Get the thumbnail URL for preview
    const thumbnailUrl = cardData.thumb_preview || cardData.thumbnail || cardData.thumb_url;
    const glbUrl = cardData.glb_url || cardData.glb_proxy || cardData.model_url;

    // Try to load 3D model if viewer is available
    if (glbUrl && window.timrx3D) {
      // Switch to model panel
      const modelRailBtn = document.querySelector('[data-panel="model"]');
      if (modelRailBtn) modelRailBtn.click();

      // Try different loader methods
      const tryLoadModel = async () => {
        // Method 1: Check for exposed loadGlbFromUrl
        if (typeof window.loadGlbFromUrl === 'function') {
          return window.loadGlbFromUrl(glbUrl);
        }
        // Method 2: Check Viewer module
        if (window.Viewer?.loadGlbFromUrl) {
          return window.Viewer.loadGlbFromUrl(glbUrl);
        }
        // Method 3: Check for showModelInViewer
        if (window.Viewer?.showModelInViewer) {
          return window.Viewer.showModelInViewer(glbUrl, { title: cardData.title });
        }
        // Method 4: Try importing viewer module dynamically
        try {
          const viewerModule = await import('./viewer.js').catch(() => null) ||
                               await import('../viewer.js').catch(() => null) ||
                               await import('../js/viewer.js').catch(() => null);
          if (viewerModule?.loadGlbFromUrl) {
            return viewerModule.loadGlbFromUrl(glbUrl);
          }
        } catch (e) { /* ignore */ }
        throw new Error('No viewer available');
      };

      tryLoadModel()
        .then(() => {
          console.log('[Inspire] Model loaded successfully');
          // Also fill the prompt for reference
          if (cardData.prompt) usePrompt(cardData.prompt);
        })
        .catch(err => {
          console.warn('[Inspire] Model loading failed, showing thumbnail:', err.message);
          // Fall back to showing thumbnail as image
          showModelAsThumbnail(cardData, thumbnailUrl);
        });
    } else if (thumbnailUrl) {
      // No 3D viewer available - show thumbnail as image preview
      showModelAsThumbnail(cardData, thumbnailUrl);
    } else {
      // No thumbnail either - just use the prompt
      console.warn('[Inspire] No GLB URL or thumbnail for model:', cardData.id);
      usePrompt(cardData.prompt);
    }
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
      usePrompt(cardData.prompt);
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
      usePrompt(cardData.prompt);
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

    const imageUrl = cardData.image_url || cardData.thumbnail || cardData.thumb_url;

    if (!imageUrl) {
      console.warn('[Inspire] No image URL found:', cardData.id);
      usePrompt(cardData.prompt);
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
    const potd = memoryCache.promptOfTheDay || { prompt: getRandomPrompt(), category: 'creative' };

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
            <div class="inspire-potd__label">Prompt of the Day</div>
            <p class="inspire-potd__prompt">${potd.prompt}</p>
          </div>
          <button class="inspire-potd__cta" data-action="use-potd">
            ${ICONS.use}<span>Try it</span>
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
      const potdEl = overlayEl.querySelector('.inspire-potd__prompt');
      const prompt = potdEl?.textContent || getRandomPrompt();
      usePrompt(prompt);
    });

    // Filter buttons (delegated)
    overlayEl.querySelector('#inspireFilters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.inspire-filter-btn');
      if (btn) applyFilter(btn.dataset.filter);
    });

    // Hover thumbnail swap (desktop only - no hover on touch)
    const grid = overlayEl.querySelector('#inspireGrid');
    if (grid && !('ontouchstart' in window)) {
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
        '#applyRemeshBtn, #generateTextureBtn, #applyRigBtn, ' +
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
        '[data-open-tutorials], [data-open-user-stories], [data-open-converter], [data-open-about]'
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
      // Also populate pool from cache for instant shuffles
      INSPIRE_POOL = [...memoryCache.cards];
      INSPIRE_POOL_TS = memoryCache.timestamp || 0;
      renderGrid();
      hasContentReady = true;
      console.log('[Inspire] Rendered cached content');
    }

    // Load the full pool (await if no cache, so auto-open has content)
    const poolLoadPromise = ensurePoolLoaded().then(success => {
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

    const potdEl = overlayEl.querySelector('.inspire-potd__prompt');
    if (potdEl && memoryCache.promptOfTheDay?.prompt) {
      potdEl.textContent = memoryCache.promptOfTheDay.prompt;
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

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

})();
