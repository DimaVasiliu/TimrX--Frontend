/**
 * ============================================================================
 * TUTORIALS MODULE — Thumbnail-Based Tutorial Gallery for TimrX 3D Workspace
 * ============================================================================
 * Lightweight implementation with:
 * - NO WebGL/Three.js renderers in tutorial cards
 * - Lazy loading images for performance
 * - Click-to-load into main workspace viewer (reuses Inspire pattern)
 * - Backend fetch with local fallback
 */

(function() {
  'use strict';

  // =========================================================================
  // CONFIGURATION
  // =========================================================================

  const BACKEND = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';

  const CONFIG = {
    CACHE_KEY: 'timrx_tutorials_cache',
    CACHE_TTL: 30 * 60 * 1000, // 30 minutes
    API_MISSING_KEY: 'timrx_tutorials_api_missing_until', // 24h skip on 404
    API_MISSING_TTL: 24 * 60 * 60 * 1000, // 24 hours
    API_BASE: `${BACKEND}/api/_mod`,
    FETCH_LIMIT: 12,
    FETCH_TIMEOUT: 8000
  };

  // =========================================================================
  // LOCAL TUTORIAL ITEMS (fallback when API unavailable)
  // =========================================================================

  const LOCAL_TUTORIALS = [
    {
      id: 'tut-text-to-3d',
      type: 'model',
      title: 'Text to 3D Generation',
      description: 'Create 3D models from text prompts using AI. Best practices for prompt crafting.',
      glb_url: '3dprint-modules/3dmodels/undead_creature_preview.glb',
      glb_refined: '3dprint-modules/3dmodels/undead_creature_refined.glb',
      prompt: 'Undead creature with dark fantasy style, detailed bones and torn cloth',
      category: 'generation',
      badge: 'refined',
      tags: ['text-to-3d', 'beginner']
    },
    {
      id: 'tut-image-to-3d',
      type: 'model',
      title: 'Image to 3D Conversion',
      description: 'Convert reference images and artwork into 3D models.',
      thumbnail: '3dprint-modules/3dmodels/dogimg.png',
      glb_url: '3dprint-modules/3dmodels/dog3d.glb',
      prompt: 'Friendly cartoon dog, stylized 3D character',
      category: 'generation',
      badge: 'textured',
      tags: ['image-to-3d', 'beginner']
    },
    {
      id: 'tut-remesh',
      type: 'model',
      title: 'Remesh for 3D Printing',
      description: 'Fix topology issues and prepare models for successful prints.',
      glb_url: '3dprint-modules/3dmodels/character_preview.glb',
      glb_refined: '3dprint-modules/3dmodels/character_remeshed.glb',
      prompt: 'Clean topology mesh ready for 3D printing',
      category: 'post-processing',
      badge: 'refined',
      tags: ['remesh', 'printing', 'intermediate']
    },
    {
      id: 'tut-texture',
      type: 'model',
      title: 'AI Texture Generation',
      description: 'Apply realistic PBR textures to your models using text or image prompts.',
      glb_url: '3dprint-modules/3dmodels/lamp.glb',
      prompt: 'Weathered stone texture with moss, ancient ruins style',
      category: 'post-processing',
      badge: 'textured',
      tags: ['texture', 'pbr', 'intermediate']
    },
    {
      id: 'tut-astro',
      type: 'model',
      title: 'Detailed Character Model',
      description: 'High-detail character model showcasing AI 3D generation capabilities.',
      glb_url: '3dprint-modules/3dmodels/astro.glb',
      prompt: 'Detailed astronaut character, sci-fi style',
      category: 'generation',
      badge: 'textured',
      tags: ['character', 'detailed', 'intermediate']
    }
  ];

  // =========================================================================
  // STATE
  // =========================================================================

  let state = {
    items: [],
    initialized: false,
    loading: false
  };

  let memoryCache = {
    items: [],
    timestamp: 0
  };

  // =========================================================================
  // ICONS
  // =========================================================================

  const ICONS = {
    model: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>`,
    image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
    video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><path d="M10 8l6 4-6 4V8z"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
  };

  // =========================================================================
  // CACHE UTILITIES
  // =========================================================================

  function loadCachedContent() {
    try {
      const cached = localStorage.getItem(CONFIG.CACHE_KEY);
      if (!cached) return null;
      const data = JSON.parse(cached);
      memoryCache = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  function saveCacheContent(data) {
    try {
      const cacheData = { ...data, timestamp: Date.now() };
      memoryCache = cacheData;
      localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(cacheData));
    } catch (e) {}
  }

  function isCacheFresh() {
    return memoryCache.timestamp && (Date.now() - memoryCache.timestamp < CONFIG.CACHE_TTL);
  }

  /**
   * Check if API is known to be missing (404) and we should skip fetching.
   * @returns {boolean} True if we should skip the API call.
   */
  function isApiKnownMissing() {
    try {
      const missingUntil = localStorage.getItem(CONFIG.API_MISSING_KEY);
      if (!missingUntil) return false;
      const until = parseInt(missingUntil, 10);
      if (isNaN(until)) return false;
      return Date.now() < until;
    } catch (e) {
      return false;
    }
  }

  /**
   * Mark API as missing for 24 hours (on 404 response).
   */
  function markApiMissing() {
    try {
      const until = Date.now() + CONFIG.API_MISSING_TTL;
      localStorage.setItem(CONFIG.API_MISSING_KEY, String(until));
    } catch (e) {}
  }

  /**
   * Clear the API missing flag (if API becomes available).
   */
  function clearApiMissing() {
    try {
      localStorage.removeItem(CONFIG.API_MISSING_KEY);
    } catch (e) {}
  }

  // =========================================================================
  // API FETCH
  // =========================================================================

  async function fetchTutorials(options = {}) {
    const { forceRefresh = false } = options;

    // Use cache if fresh
    if (!forceRefresh && isCacheFresh() && memoryCache.items?.length > 0) {
      console.log('[Tutorials] Using cached content');
      state.items = [...memoryCache.items];
      return true;
    }

    // Skip API if known to be missing (404 within last 24h)
    if (!forceRefresh && isApiKnownMissing()) {
      console.log('[Tutorials] API endpoint unavailable, using local fallback');
      state.items = [...LOCAL_TUTORIALS];
      return true;
    }

    try {
      state.loading = true;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

      const url = `${CONFIG.API_BASE}/tutorials/feed?limit=${CONFIG.FETCH_LIMIT}`;

      const response = await fetch(url, {
        signal: controller.signal,
        credentials: 'include'
      });

      clearTimeout(timeout);

      if (!response.ok) {
        // Mark as missing for 24h on 404/410
        if (response.status === 404 || response.status === 410) {
          markApiMissing();
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Response is not JSON');
      }

      const data = await response.json();

      if (data.ok && data.items?.length > 0) {
        // API is working, clear any missing flag
        clearApiMissing();

        // Normalize items
        const items = data.items.map(item => ({
          ...item,
          thumbnail: item.thumb_url || item.thumbnail || item.image_url || ''
        })).filter(item => item.thumbnail);

        state.items = items;
        saveCacheContent({ items });
        console.log(`[Tutorials] Loaded ${items.length} items from API`);
        return true;
      } else {
        throw new Error('No items in response');
      }

    } catch (err) {
      // Only log if not already known missing (avoid spam)
      if (!isApiKnownMissing()) {
        console.log('[Tutorials] API unavailable, using local fallback');
      }

      // Use local fallback
      state.items = [...LOCAL_TUTORIALS];
      return true;

    } finally {
      state.loading = false;
    }
  }

  // =========================================================================
  // RENDER FUNCTIONS
  // =========================================================================

  /**
   * Render a single tutorial card (thumbnail-based, NO WebGL)
   */
  function renderTutorialCard(item) {
    const typeIcon = ICONS[item.type] || ICONS.model;
    const categoryLabel = item.category || 'tutorial';

    return `
      <article class="tutorial-card"
               data-id="${item.id}"
               data-type="${item.type}"
               tabindex="0"
               role="button"
               aria-label="View ${item.title}">
        <div class="tutorial-card__media">
          <img class="tutorial-card__thumb"
               src="${item.thumbnail}"
               alt="${item.title}"
               loading="lazy"
               decoding="async"
               onerror="this.style.display='none'"/>
          <div class="tutorial-card__play-overlay">
            ${ICONS.eye}
            <span>View</span>
          </div>
          ${item.type === 'video' ? '<div class="tutorial-card__video-badge">' + ICONS.play + '</div>' : ''}
        </div>
        <div class="tutorial-card__content">
          <div class="tutorial-card__type">${typeIcon}<span>${item.type}</span></div>
          <h4 class="tutorial-card__title">${item.title}</h4>
          ${item.description ? `<p class="tutorial-card__desc">${item.description}</p>` : ''}
          <div class="tutorial-card__category">${categoryLabel}</div>
        </div>
      </article>
    `;
  }

  /**
   * Render a Meshy-style model showcase card with hover animation
   * Supports: sprite sheets, turntable videos, or static images
   */
  function renderModelShowcaseCard(item) {
    const badgeType = item.badge || 'preview';
    const badgeText = badgeType.charAt(0).toUpperCase() + badgeType.slice(1);
    const glbUrl = item.glb_url || '';

    return `
      <article class="tutorials-model-card"
               data-id="${item.id}"
               data-glb="${glbUrl}"
               data-refined="${item.glb_refined || ''}"
               tabindex="0"
               role="button"
               aria-label="View ${item.title}">
        <div class="tutorials-model-card__thumb">
          ${glbUrl ? `
          <model-viewer
            src="${glbUrl}"
            alt="${item.title}"
            auto-rotate
            rotation-per-second="30deg"
            camera-controls
            touch-action="pan-y"
            shadow-intensity="0.4"
            exposure="0.8"
            loading="lazy"
            style="width:100%;height:100%;background:transparent;">
          </model-viewer>
          ` : (item.thumbnail ? `
          <img class="tutorials-model-card__poster"
               src="${item.thumbnail}"
               alt="${item.title}"
               loading="lazy"
               decoding="async"
               onerror="this.style.display='none'"/>
          ` : '')}
          <span class="tutorials-model-card__badge tutorials-model-card__badge--${badgeType}">${badgeText}</span>
          <div class="tutorials-model-card__overlay">
            ${ICONS.eye}
            <span>View in Workspace</span>
          </div>
        </div>
        <div class="tutorials-model-card__content">
          <h4 class="tutorials-model-card__title">${item.title}</h4>
          ${item.description ? `<div class="tutorials-model-card__meta"><span>${item.category || 'Model'}</span></div>` : ''}
        </div>
      </article>
    `;
  }

  /**
   * Render a grid of Meshy-style model showcase cards
   */
  function renderModelShowcaseGrid(containerId, filterFn = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let items = [...state.items].filter(item => item.type === 'model');
    if (filterFn) {
      items = items.filter(filterFn);
    }

    if (items.length === 0) {
      container.innerHTML = `
        <div class="tutorial-empty">
          <p>No models available yet.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `<div class="tutorials-model-showcase">${items.map(renderModelShowcaseCard).join('')}</div>`;

    // Bind hover and click events
    bindModelCardEvents();
  }

  /**
   * Render tutorial cards into a container
   */
  function renderTutorialGrid(containerId, filterFn = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let items = [...state.items];
    if (filterFn) {
      items = items.filter(filterFn);
    }

    if (items.length === 0) {
      container.innerHTML = `
        <div class="tutorial-empty">
          <p>No tutorials available yet.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = items.map(renderTutorialCard).join('');

    // Bind click handlers
    container.querySelectorAll('.tutorial-card').forEach(card => {
      card.addEventListener('click', handleCardClick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick(e);
        }
      });
    });
  }

  // =========================================================================
  // VIEWER INTEGRATION (reuses Inspire's pattern)
  // =========================================================================

  /**
   * Handle card click - load content into main workspace viewer
   */
  function handleCardClick(e) {
    const card = e.target.closest('.tutorial-card');
    if (!card) return;

    const itemData = state.items.find(item => item.id === card.dataset.id);
    if (!itemData) return;

    loadContentIntoViewer(itemData);
  }

  /**
   * Load tutorial content into the main workspace viewer
   * Reuses the same pattern as Inspire module
   */
  function loadContentIntoViewer(itemData) {
    const type = itemData.type;
    console.log('[Tutorials] Loading content into viewer:', type, itemData.id);

    // Close tutorials expanded view if open
    closeTutorialsView();

    // Small delay to let close animation start
    requestAnimationFrame(() => {
      if (type === 'model') {
        loadModelIntoViewer(itemData);
      } else if (type === 'video') {
        loadVideoIntoViewer(itemData);
      } else if (type === 'image') {
        loadImageIntoViewer(itemData);
      }
    });

    window.dispatchEvent(new CustomEvent('tutorials:content-loaded', {
      detail: { type, id: itemData.id }
    }));
  }

  /**
   * Load a 3D model into the main viewer
   */
  function loadModelIntoViewer(itemData) {
    const glbUrl = itemData.glb_url || itemData.model_url;
    const thumbnailUrl = itemData.thumbnail;

    // Switch to model panel
    const modelRailBtn = document.querySelector('[data-panel="model"]');
    if (modelRailBtn) modelRailBtn.click();

    // Try to load 3D model using available methods
    if (glbUrl) {
      const tryLoadModel = async () => {
        if (typeof window.loadGlbFromUrl === 'function') {
          return window.loadGlbFromUrl(glbUrl);
        }
        if (window.Viewer?.loadGlbFromUrl) {
          return window.Viewer.loadGlbFromUrl(glbUrl);
        }
        if (window.Viewer?.showModelInViewer) {
          return window.Viewer.showModelInViewer(glbUrl, { title: itemData.title });
        }
        throw new Error('No viewer available');
      };

      tryLoadModel()
        .then(() => {
          console.log('[Tutorials] Model loaded successfully');
          if (itemData.prompt) fillPrompt(itemData.prompt);
        })
        .catch(err => {
          console.warn('[Tutorials] Model loading failed, showing thumbnail:', err.message);
          showAsThumbnail(itemData, thumbnailUrl);
        });
    } else if (thumbnailUrl) {
      showAsThumbnail(itemData, thumbnailUrl);
    }
  }

  /**
   * Show content as thumbnail image (fallback)
   */
  function showAsThumbnail(itemData, thumbnailUrl) {
    const imageRailBtn = document.querySelector('[data-panel="image"]');
    if (imageRailBtn) imageRailBtn.click();

    const imageEl = document.getElementById('generatedImage');
    if (imageEl) {
      imageEl.src = thumbnailUrl;
      imageEl.classList.remove('hidden');
      imageEl.alt = itemData.title || 'Tutorial Preview';
    }

    const viewerTitle = document.getElementById('viewerTitle');
    if (viewerTitle) {
      viewerTitle.textContent = itemData.title || 'Tutorial Preview';
    }

    if (itemData.prompt) fillPrompt(itemData.prompt);
  }

  /**
   * Load video into viewer
   */
  function loadVideoIntoViewer(itemData) {
    const videoRailBtn = document.querySelector('[data-panel="video"]');
    if (videoRailBtn) videoRailBtn.click();

    const videoUrl = itemData.video_url || itemData.url;
    if (!videoUrl) {
      console.warn('[Tutorials] No video URL found');
      return;
    }

    if (window.Viewer?.showVideoInViewer) {
      window.Viewer.showVideoInViewer(videoUrl, {
        title: itemData.title || 'Tutorial Video',
        autoplay: true
      });
    } else {
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
   * Load image into viewer
   */
  function loadImageIntoViewer(itemData) {
    const imageRailBtn = document.querySelector('[data-panel="image"]');
    if (imageRailBtn) imageRailBtn.click();

    const imageUrl = itemData.image_url || itemData.thumbnail;
    if (!imageUrl) {
      console.warn('[Tutorials] No image URL found');
      return;
    }

    if (window.Viewer?.showImageInViewer) {
      window.Viewer.showImageInViewer(imageUrl);
    } else {
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

  /**
   * Fill prompt input with tutorial prompt
   */
  function fillPrompt(prompt) {
    const promptInput = document.querySelector(
      '#modelPrompt, #imagePrompt, #texturePrompt, #videoTextPrompt, textarea[name="prompt"]'
    );
    if (promptInput) {
      promptInput.value = prompt;
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.focus();
    }
  }

  /**
   * Close tutorials expanded view
   */
  function closeTutorialsView() {
    const tutorialsGallery = document.getElementById('tutorialsGallery');
    if (tutorialsGallery && !tutorialsGallery.hidden) {
      // Use the expanded view close mechanism
      const closeBtn = document.getElementById('tutorialsExit');
      if (closeBtn) closeBtn.click();
    }
  }

  // =========================================================================
  // REPLACE 3D VIEWERS WITH MESHY-STYLE MODEL CARDS
  // =========================================================================

  /**
   * Replace tutorial-3d-viewer elements with Meshy-style animated cards
   * Supports: sprite sheets, turntable videos, or static images
   * Called on init to convert existing viewers
   */
  function convertViewersToThumbnails() {
    const viewers = document.querySelectorAll('.tutorial-3d-viewer');

    viewers.forEach(viewer => {
      const container = viewer.parentElement;
      if (!container) return;

      const id = viewer.id || `tutorial-${Math.random().toString(36).substr(2, 9)}`;
      const previewSrc = viewer.dataset.preview || viewer.dataset.src;
      const refinedSrc = viewer.dataset.refined;
      const label = viewer.getAttribute('aria-label') || 'Tutorial Model';
      const badgeType = refinedSrc ? 'refined' : 'preview';
      const badgeText = refinedSrc ? 'Refined' : 'Preview';

      const cardHTML = `
        <div class="tutorials-model-card"
             data-id="${id}"
             data-preview="${previewSrc || ''}"
             data-refined="${refinedSrc || ''}"
             tabindex="0"
             role="button"
             aria-label="${label}">
          <div class="tutorials-model-card__thumb">
            <model-viewer
              src="${previewSrc}"
              alt="${label}"
              auto-rotate
              rotation-per-second="30deg"
              camera-controls
              touch-action="pan-y"
              shadow-intensity="0.4"
              exposure="0.8"
              loading="lazy"
              style="width:100%;height:100%;background:transparent;">
            </model-viewer>
            <span class="tutorials-model-card__badge tutorials-model-card__badge--${badgeType}">${badgeText}</span>
            <div class="tutorials-model-card__overlay">
              ${ICONS.eye}
              <span>${refinedSrc ? 'Click to toggle version' : 'View in Workspace'}</span>
            </div>
          </div>
          <div class="tutorials-model-card__content">
            <h4 class="tutorials-model-card__title">${label.replace(' - click to toggle versions', '').replace('3D Model', '').trim() || 'Model Preview'}</h4>
          </div>
        </div>
      `;

      viewer.outerHTML = cardHTML;

      const oldHint = container.querySelector('.model-toggle-hint');
      if (oldHint) oldHint.remove();
    });

    // Bind click events for toggling and workspace loading
    bindModelCardEvents();
  }

  /**
   * Bind hover and click events to model cards
   */
  function bindModelCardEvents() {
    document.querySelectorAll('.tutorials-model-card').forEach(card => {
      // Click handler — toggle between preview/refined on the model-viewer
      card.addEventListener('click', () => {
        const mv = card.querySelector('model-viewer');
        const refinedSrc = card.dataset.refined;
        const previewSrc = card.dataset.preview || card.dataset.glb;

        if (mv && refinedSrc) {
          // Toggle between preview and refined
          const isRefined = mv.getAttribute('src') === refinedSrc;
          mv.setAttribute('src', isRefined ? previewSrc : refinedSrc);

          // Update badge text
          const badge = card.querySelector('.tutorials-model-card__badge');
          if (badge) {
            badge.textContent = isRefined ? 'Preview' : 'Refined';
          }
        }
      });

      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          card.click();
        }
      });
    });
  }

  // =========================================================================
  // CSS INJECTION (minimal styles for thumbnail cards)
  // =========================================================================

  function injectStyles() {
    if (document.getElementById('tutorials-module-styles')) return;

    const style = document.createElement('style');
    style.id = 'tutorials-module-styles';
    style.textContent = `
      /* Tutorial Card Styles */
      .tutorial-card,
      .tutorial-model-card {
        position: relative;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        overflow: hidden;
        cursor: pointer;
        transition: transform 0.2s ease, border-color 0.2s ease;
      }
      .tutorial-card:hover,
      .tutorial-card:focus,
      .tutorial-model-card:hover,
      .tutorial-model-card:focus {
        transform: translateY(-2px);
        border-color: rgba(255, 255, 255, 0.15);
        outline: none;
      }
      .tutorial-card:focus-visible,
      .tutorial-model-card:focus-visible {
        box-shadow: 0 0 0 2px var(--accent-blue, #0ea5e9);
      }

      .tutorial-card__media,
      .tutorial-model-card__thumb {
        position: relative;
        aspect-ratio: 16 / 10;
        background: rgba(0, 0, 0, 0.3);
        overflow: hidden;
      }
      .tutorial-card__thumb,
      .tutorial-model-card__thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform 0.3s ease;
      }
      .tutorial-card:hover .tutorial-card__thumb,
      .tutorial-model-card:hover .tutorial-model-card__thumb img {
        transform: scale(1.05);
      }

      .tutorial-card__play-overlay,
      .tutorial-model-card__overlay {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: rgba(0, 0, 0, 0.5);
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      .tutorial-card:hover .tutorial-card__play-overlay,
      .tutorial-model-card:hover .tutorial-model-card__overlay {
        opacity: 1;
      }
      .tutorial-card__play-overlay svg,
      .tutorial-model-card__overlay svg {
        width: 32px;
        height: 32px;
        color: white;
      }
      .tutorial-card__play-overlay span,
      .tutorial-model-card__overlay span {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: white;
      }

      .tutorial-card__content {
        padding: 12px;
      }
      .tutorial-card__type {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: rgba(255, 255, 255, 0.5);
        margin-bottom: 6px;
      }
      .tutorial-card__type svg {
        width: 12px;
        height: 12px;
      }
      .tutorial-card__title {
        font-size: 14px;
        font-weight: 600;
        color: white;
        margin: 0 0 4px;
        line-height: 1.3;
      }
      .tutorial-card__desc {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.6);
        margin: 0 0 8px;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .tutorial-card__category {
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--accent-blue, #0ea5e9);
      }

      .tutorial-card__video-badge {
        position: absolute;
        bottom: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        background: rgba(0, 0, 0, 0.7);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .tutorial-card__video-badge svg {
        width: 14px;
        height: 14px;
        color: white;
        margin-left: 2px;
      }

      .tutorial-model-card__hint {
        display: block;
        padding: 8px 12px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.5);
        text-align: center;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      .tutorial-model-card__placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.4);
        font-size: 14px;
        font-weight: 500;
      }

      .tutorial-empty {
        padding: 40px 20px;
        text-align: center;
        color: rgba(255, 255, 255, 0.5);
      }

      /* Tutorial grid for dynamic content */
      .tutorial-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 16px;
      }
    `;
    document.head.appendChild(style);
  }

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  async function init() {
    if (state.initialized) return;
    state.initialized = true;

    console.log('[Tutorials] Initializing...');

    // Inject styles
    injectStyles();

    // Load cached content first
    loadCachedContent();
    if (memoryCache.items?.length > 0) {
      state.items = [...memoryCache.items];
    } else {
      state.items = [...LOCAL_TUTORIALS];
    }

    // Convert existing 3D viewers to thumbnail cards
    convertViewersToThumbnails();

    // DO NOT fetch from API on boot — the endpoint returns 404 and
    // wastes a request.  Fetch only when the user actually opens the
    // tutorials panel (detected by MutationObserver on body class).
    const _tutContainer = document.getElementById('tutorialsGallery');
    if (document.body.classList.contains('tutorials-view')) {
      fetchTutorials({ forceRefresh: false });
    } else if (_tutContainer) {
      const _mo = new MutationObserver(() => {
        if (document.body.classList.contains('tutorials-view')) {
          _mo.disconnect();
          fetchTutorials({ forceRefresh: false });
        }
      });
      _mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    console.log('[Tutorials] Initialized (API fetch deferred until panel open)');
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  window.TimrXTutorials = {
    init,
    refresh: () => fetchTutorials({ forceRefresh: true }),
    renderGrid: renderTutorialGrid,
    renderModelShowcase: renderModelShowcaseGrid,
    loadContent: loadContentIntoViewer,
    getItems: () => [...state.items]
  };

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 150);
  }

})();
