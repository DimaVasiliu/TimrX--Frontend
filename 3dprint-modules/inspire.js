/**
 * ============================================================================
 * INSPIRE MODULE — Premium Discovery Overlay for TimrX 3D Workspace
 * ============================================================================
 * Production-quality implementation with:
 * - Robust fetch error handling (checks Content-Type before JSON parse)
 * - LocalStorage caching for instant load
 * - Balanced shuffle with server + local fallback
 * - Lazy loading images, no heavy 3D viewers in cards
 */

(function() {
  'use strict';

  // =========================================================================
  // CONFIGURATION
  // =========================================================================

  const CONFIG = {
    STORAGE_KEY: 'timrx_inspire_shown',
    CACHE_KEY: 'timrx_inspire_cache',
    CACHE_TTL: 5 * 60 * 1000, // 5 minutes
    AUTO_SHOW_ON_LOAD: true,
    API_BASE: '/api/_mod',
    FETCH_LIMIT: 24,
    FETCH_TIMEOUT: 8000,
    FETCH_COOLDOWN: 10000, // 10 seconds between failed retries
    MAX_CONSECUTIVE_FAILURES: 3
  };

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
    lastFetchTime: 0
  };

  let overlayEl = null;

  // In-memory cache
  let memoryCache = {
    promptOfTheDay: null,
    cards: [],
    timestamp: 0
  };

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

      const result = await safeFetch(`${CONFIG.API_BASE}/inspire/feed?${params}`);

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

  function markAsShown() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, 'true');
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
    const thumbnailUrl = card.thumbnail || card.thumb_url || '';
    const prompt = card.prompt || card.title || 'Untitled creation';
    const aspect = card.aspect || 'square';

    // No heavy 3D viewers - just thumbnail images
    return `
      <article class="inspire-card ${aspect}" data-id="${card.id}" data-type="${card.type}">
        <div class="inspire-card__media">
          <img class="inspire-card__image" src="${thumbnailUrl}" alt="${prompt}" loading="lazy" decoding="async"/>
          ${card.type === 'video' ? '<div class="inspire-card__video-badge">&#9658;</div>' : ''}
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
  }

  // =========================================================================
  // CORE FUNCTIONS
  // =========================================================================

  function openInspire() {
    if (state.isOpen || !overlayEl) return;

    state.isOpen = true;
    document.body.classList.add('inspire-open');
    overlayEl.style.display = 'flex';

    // Small delay for CSS transition
    requestAnimationFrame(() => {
      overlayEl.classList.add('is-open');
      overlayEl.querySelector('#inspireCloseBtn')?.focus();
    });

    window.dispatchEvent(new CustomEvent('inspire:open'));
  }

  function closeInspire() {
    if (!state.isOpen || !overlayEl) return;

    // Move focus before hiding for accessibility
    const triggerBtn = document.getElementById('inspireTriggerBtn');
    if (triggerBtn) triggerBtn.focus();

    state.isOpen = false;
    document.body.classList.remove('inspire-open');
    overlayEl.classList.remove('is-open');

    // Hide after transition
    setTimeout(() => {
      if (!state.isOpen) {
        overlayEl.style.display = 'none';
      }
    }, 300);

    markAsShown();
    window.dispatchEvent(new CustomEvent('inspire:close'));
  }

  function toggleInspire() {
    state.isOpen ? closeInspire() : openInspire();
  }

  /**
   * Shuffle - feels instant by doing local shuffle first,
   * then fetching fresh content in background
   */
  async function shuffleCards() {
    // Instant feedback: local shuffle
    if (state.cards.length > 0) {
      state.cards = shuffleArray(state.cards);
      renderGrid();
      animateCards();
    }

    // Update POTD with random prompt
    const potdEl = overlayEl?.querySelector('.inspire-potd__prompt');
    if (potdEl) {
      potdEl.textContent = getRandomPrompt();
    }

    // Background refresh from server (non-blocking)
    fetchInspireContent({ shuffle: true, forceRefresh: true }).then(success => {
      if (success) {
        renderGrid();
      }
    });
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

    // For type filters on "all" data, just re-render locally
    if (['all', 'trending'].includes(filterId) || state.cards.length > 0) {
      renderGrid();
      return;
    }

    // Fetch specific type from API if we don't have mixed data
    await fetchInspireContent({ type: filterId, shuffle: false });
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

  function handleKeydown(e) {
    if (state.isOpen && e.key === 'Escape') {
      e.preventDefault();
      closeInspire();
    }
  }

  function handleOverlayClick(e) {
    // Close only if clicking the backdrop, not content
    if (e.target === overlayEl) {
      closeInspire();
    }
  }

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

    // Click on card itself uses prompt
    if (cardData) {
      usePrompt(cardData.prompt);
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
    if (!overlayEl) return;

    // Close button
    overlayEl.querySelector('#inspireCloseBtn')?.addEventListener('click', closeInspire);

    // Shuffle button
    overlayEl.querySelector('#inspireShuffleBtn')?.addEventListener('click', shuffleCards);

    // Backdrop click
    overlayEl.addEventListener('click', handleOverlayClick);

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

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // External trigger button
    document.getElementById('inspireTriggerBtn')?.addEventListener('click', toggleInspire);

    // Auto-close on generate
    document.addEventListener('click', (e) => {
      if (e.target.closest('#generateBtn, [data-action="generate"]') && state.isOpen) {
        closeInspire();
      }
    });
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Load cache first for instant display
    loadCachedContent();

    // Create overlay
    overlayEl = createOverlay();
    bindEvents();

    // Render cached content immediately
    if (memoryCache.cards?.length > 0) {
      state.cards = [...memoryCache.cards];
      renderGrid();
      console.log('[Inspire] Rendered cached content');
    }

    // Fetch fresh content
    await fetchInspireContent({ shuffle: true });

    // Update displays
    updatePOTDDisplay();
    renderGrid();

    console.log('[Inspire] Initialized');

    // Auto-show
    if (CONFIG.AUTO_SHOW_ON_LOAD) {
      setTimeout(openInspire, 600);
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
    open: openInspire,
    close: closeInspire,
    toggle: toggleInspire,
    shuffle: shuffleCards,
    isOpen: () => state.isOpen,
    usePrompt,
    refresh: () => fetchInspireContent({ forceRefresh: true })
  };

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

})();
