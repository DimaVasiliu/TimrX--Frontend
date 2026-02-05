/**
 * ============================================================================
 * INSPIRE MODULE — Premium Discovery Overlay for TimrX 3D Workspace
 * ============================================================================
 */

(function() {
  'use strict';

  // =========================================================================
  // CONFIGURATION
  // =========================================================================

  const CONFIG = {
    STORAGE_KEY: 'timrx_inspire_shown',
    AUTO_SHOW_ON_LOAD: true,  // Show every time page loads
    API_BASE: '/api/_mod',
    FETCH_LIMIT: 30
  };

  // =========================================================================
  // FALLBACK CONTENT (used when API is unavailable)
  // =========================================================================

  const FALLBACK_CONTENT = {
    promptOfTheDay: {
      prompt: "A mystical forest guardian made of twisted ancient vines and glowing mushrooms, ethereal atmosphere",
      category: "fantasy"
    },
    cards: []
  };

  // =========================================================================
  // DYNAMIC CONTENT (populated from API)
  // =========================================================================

  let INSPIRE_CONTENT = {
    promptOfTheDay: { ...FALLBACK_CONTENT.promptOfTheDay },
    cards: []
  };

  // =========================================================================
  // STATE
  // =========================================================================

  let state = {
    isOpen: false,
    activeFilter: 'all',
    cards: [],
    initialized: false,
    loading: false,
    error: null
  };

  // Direct element reference (not in object to avoid issues)
  let overlayEl = null;

  // =========================================================================
  // API FUNCTIONS
  // =========================================================================

  /**
   * Fallback: fetch from community feed and transform to inspire card format
   */
  async function fetchFromCommunityFeed(limit = 30) {
    const response = await fetch(`${CONFIG.API_BASE}/community/feed?limit=${limit}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Community API HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.ok && data.posts && data.posts.length > 0) {
      // Transform community posts to inspire card format
      const cards = data.posts.map((post, idx) => {
        const sizes = ['lg', 'md', 'sm', 'md', 'sm', 'lg', 'md', 'sm'];
        return {
          id: `ins-c-${post.id}`,
          type: post.asset_type || 'model',
          prompt: post.prompt_public || post.asset?.title || 'Community creation',
          thumbnail: post.asset?.thumbnail_url,
          size: sizes[idx % sizes.length],
          tags: ['community'],
          created_at: post.created_at
        };
      }).filter(card => card.thumbnail); // Only include cards with thumbnails

      if (cards.length > 0) {
        INSPIRE_CONTENT.cards = cards;
        state.cards = [...cards];
        return true;
      }
    }
    return false;
  }

  async function fetchInspireContent(options = {}) {
    const { type = 'all', shuffle = true, limit = CONFIG.FETCH_LIMIT } = options;

    try {
      state.loading = true;
      state.error = null;
      updateLoadingState();

      const params = new URLSearchParams({
        type: type === 'all' ? 'all' : type === 'models' ? 'model' : type === 'images' ? 'image' : type === 'videos' ? 'video' : type,
        shuffle: String(shuffle),
        limit: String(limit)
      });

      const response = await fetch(`${CONFIG.API_BASE}/inspire/feed?${params}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.ok) {
        // Update content from API
        if (data.prompt_of_the_day) {
          INSPIRE_CONTENT.promptOfTheDay = data.prompt_of_the_day;
        }

        if (data.cards && data.cards.length > 0) {
          INSPIRE_CONTENT.cards = data.cards;
          state.cards = [...data.cards];
        }

        console.log(`[Inspire] Loaded ${data.cards?.length || 0} cards from API`);
        return true;
      } else {
        throw new Error(data.error?.message || 'API error');
      }
    } catch (err) {
      console.warn('[Inspire] API fetch failed, trying community fallback:', err.message);
      state.error = err.message;

      // Try community feed as fallback
      try {
        const fallbackSuccess = await fetchFromCommunityFeed(limit);
        if (fallbackSuccess) {
          console.log('[Inspire] Loaded content from community fallback');
          return true;
        }
      } catch (fallbackErr) {
        console.warn('[Inspire] Community fallback also failed:', fallbackErr.message);
      }

      // Use static fallback content if available
      if (FALLBACK_CONTENT.cards.length > 0) {
        INSPIRE_CONTENT.cards = [...FALLBACK_CONTENT.cards];
        state.cards = [...FALLBACK_CONTENT.cards];
      }
      return false;
    } finally {
      state.loading = false;
      updateLoadingState();
    }
  }

  function updateLoadingState() {
    if (!overlayEl) return;

    const grid = overlayEl.querySelector('#inspireGrid');

    if (state.loading) {
      if (grid) grid.innerHTML = `
        <div class="inspire-loading">
          <div class="inspire-loading__spinner"></div>
          <p>Loading inspiration...</p>
        </div>
      `;
    } else if (state.cards.length === 0 && !state.loading) {
      if (grid) grid.innerHTML = `
        <div class="inspire-empty-state">
          <div class="inspire-empty-state__icon">${ICONS.sparkle}</div>
          <h3>No creations yet</h3>
          <p>Be the first to share your amazing creations with the community!</p>
        </div>
      `;
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
  // UTILITY FUNCTIONS
  // =========================================================================

  function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }

  function randomizeCardSizes(cards) {
    const sizes = ['sm', 'md', 'md', 'lg', 'xl'];
    return cards.map(card => ({
      ...card,
      size: sizes[Math.floor(Math.random() * sizes.length)]
    }));
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
    const thumbnailUrl = card.thumbnail || card.thumbnail_url || '';
    const prompt = card.prompt || 'Untitled creation';
    const size = card.size || 'md';
    const author = card.author ? `<span class="inspire-card__author">by ${card.author}</span>` : '';

    return `
      <article class="inspire-card size-${size}" data-id="${card.id}" data-type="${card.type}">
        <div class="inspire-card__media">
          <img class="inspire-card__image" src="${thumbnailUrl}" alt="${prompt}" loading="lazy"/>
          ${card.type === 'video' ? '<div class="inspire-card__video-badge">▶</div>' : ''}
        </div>
        <div class="inspire-card__type-badge ${card.type}">${typeIcon}<span>${card.type}</span></div>
        <div class="inspire-card__actions">
          <button class="inspire-card__action-btn" data-action="view" title="Preview">${ICONS.view}</button>
          <button class="inspire-card__action-btn" data-action="remix" title="Remix">${ICONS.remix}</button>
          <button class="inspire-card__action-btn" data-action="use" title="Use Prompt">${ICONS.use}</button>
        </div>
        <div class="inspire-card__overlay">
          <div class="inspire-card__info">
            <p class="inspire-card__prompt">${prompt}</p>
            <div class="inspire-card__meta">${author}${tagsHTML}</div>
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
    if (state.activeFilter === 'models') {
      filteredCards = filteredCards.filter(c => c.type === 'model');
    } else if (state.activeFilter === 'images') {
      filteredCards = filteredCards.filter(c => c.type === 'image');
    } else if (state.activeFilter === 'videos') {
      filteredCards = filteredCards.filter(c => c.type === 'video');
    } else if (state.activeFilter === 'trending') {
      filteredCards = filteredCards.filter(c => c.tags.includes('trending'));
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
    overlayEl.classList.add('is-open');
    overlayEl.querySelector('#inspireCloseBtn')?.focus();
    window.dispatchEvent(new CustomEvent('inspire:open'));
  }

  function closeInspire() {
    if (!state.isOpen || !overlayEl) return;
    state.isOpen = false;
    document.body.classList.remove('inspire-open');
    overlayEl.style.display = 'none';
    overlayEl.classList.remove('is-open');
    markAsShown();
    window.dispatchEvent(new CustomEvent('inspire:close'));
  }

  function toggleInspire() {
    state.isOpen ? closeInspire() : openInspire();
  }

  async function shuffleCards() {
    // Fetch fresh shuffled content from API
    const success = await fetchInspireContent({ shuffle: true });

    if (!success && INSPIRE_CONTENT.cards.length > 0) {
      // Fallback: shuffle existing cards locally
      state.cards = randomizeCardSizes(shuffleArray(INSPIRE_CONTENT.cards));
    }

    renderGrid();

    // Animate cards entrance
    const cards = overlayEl?.querySelectorAll('.inspire-card');
    cards?.forEach((card, i) => {
      card.style.animation = 'none';
      card.offsetHeight;
      card.style.animation = `cardEnter 0.5s cubic-bezier(0.4, 0, 0.2, 1) ${i * 0.05}s forwards`;
    });
  }

  async function applyFilter(filterId) {
    state.activeFilter = filterId;
    overlayEl?.querySelectorAll('.inspire-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filterId);
    });

    // For trending, filter locally; for types, fetch from API
    if (filterId === 'trending') {
      // Filter locally by trending tag
      state.cards = INSPIRE_CONTENT.cards.filter(c => c.tags?.includes('trending'));
      renderGrid();
    } else if (filterId === 'all') {
      state.cards = [...INSPIRE_CONTENT.cards];
      renderGrid();
    } else {
      // Fetch filtered content from API
      await fetchInspireContent({ type: filterId, shuffle: false });
      renderGrid();
    }
  }

  function usePrompt(prompt) {
    const promptInput = document.querySelector('#modelPromptInput, #promptInput, textarea[name="prompt"]');
    if (promptInput) {
      promptInput.value = prompt;
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.focus();
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
    if (e.target === overlayEl) {
      closeInspire();
    }
  }

  function handleCardClick(e) {
    const card = e.target.closest('.inspire-card');
    if (!card) return;

    const actionBtn = e.target.closest('.inspire-card__action-btn');
    if (actionBtn) {
      e.stopPropagation();
      const cardData = state.cards.find(c => c.id === card.dataset.id);
      if (cardData && actionBtn.dataset.action === 'use') {
        usePrompt(cardData.prompt);
      }
      return;
    }

    const cardData = state.cards.find(c => c.id === card.dataset.id);
    if (cardData) {
      usePrompt(cardData.prompt);
    }
  }

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  function createOverlay() {
    // Remove existing if any
    document.getElementById('inspireOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'inspire-overlay';
    overlay.id = 'inspireOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Inspiration gallery');

    // Force fixed positioning with inline styles
    // Left offset = padding(12) + rail(44) + gap(12) + left-panel(~300px) + gap(12) ≈ 380px
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
      flexDirection: 'column'
    });

    const potd = INSPIRE_CONTENT.promptOfTheDay;

    overlay.innerHTML = `
      <header class="inspire-header">
        <div class="inspire-header__left">
          <div class="inspire-header__icon">${ICONS.sparkle}</div>
          <div class="inspire-header__title">
            <h2>Get Inspired</h2>
            <p>Discover amazing creations and spark your creativity</p>
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

    // Overlay backdrop click
    overlayEl.addEventListener('click', handleOverlayClick);

    // Card clicks
    overlayEl.querySelector('#inspireGrid')?.addEventListener('click', handleCardClick);

    // POTD button
    overlayEl.querySelector('[data-action="use-potd"]')?.addEventListener('click', () => {
      const prompt = INSPIRE_CONTENT.promptOfTheDay?.prompt || FALLBACK_CONTENT.promptOfTheDay.prompt;
      usePrompt(prompt);
    });

    // Filter buttons
    overlayEl.querySelector('#inspireFilters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.inspire-filter-btn');
      if (btn) applyFilter(btn.dataset.filter);
    });

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // Trigger button (in the HTML)
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

    // Create the overlay
    overlayEl = createOverlay();

    // Bind events first
    bindEvents();

    state.initialized = true;
    console.log('[Inspire] Initialized successfully');

    // Fetch content from API
    await fetchInspireContent({ shuffle: true });

    // Update POTD display if we got data from API
    updatePOTDDisplay();

    // Render grid with fetched or fallback content
    renderGrid();

    // Auto-show on page load
    if (CONFIG.AUTO_SHOW_ON_LOAD) {
      setTimeout(openInspire, 800);
    }
  }

  function updatePOTDDisplay() {
    if (!overlayEl) return;

    const potdPrompt = overlayEl.querySelector('.inspire-potd__prompt');
    if (potdPrompt && INSPIRE_CONTENT.promptOfTheDay?.prompt) {
      potdPrompt.textContent = INSPIRE_CONTENT.promptOfTheDay.prompt;
    }
  }

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
    usePrompt
  };

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

})();
