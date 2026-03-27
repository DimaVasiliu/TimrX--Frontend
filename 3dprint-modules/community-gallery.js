/**
 * community-gallery.js — v3 Awe Redesign
 * Community Creations Gallery — loads posts from /api/_mod/community/feed,
 * renders a masonry grid with search, sort, reactions, tipping, featured
 * carousel, creator spotlight, activity ticker, and expanded detail view.
 */

(function () {
  'use strict';

  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  const PAGE_SIZE = 18;
  const FEATURED_SIZE = 8;
  const REACTIONS = ['heart', 'fire', 'star', 'clap', 'wow'];
  const REACTION_EMOJI = { heart: '❤️', fire: '🔥', star: '⭐', clap: '👏', wow: '😮' };
  const TIP_AMOUNTS = [5, 10, 25, 50];

  // Content types excluded from public community display.
  const EXCLUDED_DISPLAY_TYPES = ['animated'];

  function isExcludedPost(post) {
    return EXCLUDED_DISPLAY_TYPES.includes(genTypeCls(post.gen_type));
  }

  // State
  let currentFilter = 'all';
  let currentSort = 'newest';
  let currentSearch = '';
  let currentOffset = 0;
  let isLoading = false;
  let featuredPosts = [];
  let allPostsCache = [];

  // Track current user's reactions per post (postId → reaction string)
  const userReactions = new Map();

  // DOM refs (resolved on init)
  let grid, skeleton, emptyState, loadMoreWrap, loadMoreBtn, filterBar;
  let featuredTrack, featuredPrev, featuredNext, featuredSection;
  let detailEl, detailBackdrop, detailClose, detailMedia, detailInfo;
  let searchInput, sortSelect, tickerTrack, spotlightTrack, spotlightSection;
  let heroFloaters, fabBtn;

  // Search debounce
  let searchTimer = null;

  // ─── Utilities ────────────────────────────────────────────────────────────

  function getInitials(displayName) {
    if (!displayName) return '?';
    const words = displayName.trim().replace(/[._\-]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  const AVATAR_PALETTE = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
    '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
  ];
  function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  }

  function timeAgo(isoDate) {
    if (!isoDate) return '';
    const diff = (Date.now() - new Date(isoDate).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    return `${Math.floor(diff / 86400 / 30)}mo ago`;
  }

  function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function genTypeCls(genType) {
    if (!genType) return 'model';
    const t = genType.toLowerCase();
    if (t.includes('video')) return 'video';
    if (t.includes('animated') || t.includes('rigged')) return 'animated';
    if (t.includes('3d')) return 'model';
    return 'image';
  }

  // ─── Card rendering — Masonry (no fixed aspect ratio) ────────────────────

  function buildCard(post) {
    const asset = post.asset || {};
    const thumb = asset.thumbnail_url || '';
    const prompt = post.show_prompt && post.prompt_public ? sanitize(post.prompt_public) : '';
    const name = sanitize(post.display_name || 'Anonymous');
    const initials = getInitials(post.display_name || 'Anonymous');
    const color = avatarColor(post.display_name || '');
    const ago = timeAgo(post.created_at);
    const genType = post.gen_type || '';
    const typeCls = genTypeCls(genType);
    const isVideo = (post.asset_type === 'video') && asset.video_url;
    const isAnimated = !!asset.animation_glb_url;
    const postId = sanitize(post.id);
    const reactions = post.reactions || {};

    let thumbEl;
    if (isAnimated) {
      thumbEl = `<model-viewer class="ccg-card__model-viewer" src="${sanitize(asset.animation_glb_url)}" animation-name="" camera-controls="false" interaction-prompt="none" auto-rotate rotation-per-second="30deg" shadow-intensity="0.4" exposure="1.1" environment-image="neutral" poster="${sanitize(thumb)}" loading="lazy" reveal="auto"></model-viewer>`;
    } else if (isVideo) {
      thumbEl = `<video class="ccg-card__image" src="${sanitize(asset.video_url)}" muted loop playsinline autoplay preload="metadata" poster="${sanitize(thumb)}"></video>`;
    } else if (thumb) {
      thumbEl = `<img class="ccg-card__image" src="${sanitize(thumb)}" alt="" loading="lazy" decoding="async">`;
    } else {
      thumbEl = `<div class="ccg-card__image ccg-card__image--placeholder"></div>`;
    }

    const reactionsHtml = REACTIONS.map(r => {
      const count = reactions[r] || 0;
      return `<button class="ccg-reaction" data-post-id="${postId}" data-reaction="${r}" title="${r}" type="button">${REACTION_EMOJI[r]}<span class="ccg-reaction__count">${count || ''}</span></button>`;
    }).join('');

    return `
      <article class="ccg-card" data-post-id="${postId}" data-type="${sanitize(post.asset_type || 'model')}">
        <div class="ccg-card__media">
          ${thumbEl}
          ${genType ? `<div class="ccg-card__type-badge ${typeCls}">${sanitize(genType)}</div>` : ''}
          <button class="ccg-card__bookmark" data-post-id="${postId}" type="button" title="Save" aria-label="Bookmark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
          </button>
          <div class="ccg-card__overlay">
            <div class="ccg-card__info">
              ${prompt ? `<p class="ccg-card__prompt">${prompt}</p>` : ''}
            </div>
          </div>
        </div>
        <div class="ccg-card__footer">
          <div class="ccg-card__author-row">
            <div class="ccg-card__avatar" style="background:${color}" aria-hidden="true">${initials}</div>
            <div class="ccg-card__meta">
              <span class="ccg-card__name">${name}</span>
              <span class="ccg-card__time">${ago}</span>
            </div>
            <button class="ccg-card__tip-btn" data-post-id="${postId}" data-creator="${name}" type="button" title="Tip creator">💎</button>
          </div>
          <div class="ccg-card__reactions">
            ${reactionsHtml}
          </div>
        </div>
      </article>`;
  }

  // ─── Video autoplay on visibility ────────────────────────────────────────

  const videoObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const vid = entry.target;
          if (entry.isIntersecting) {
            vid.play().catch(() => {});
          } else {
            vid.pause();
          }
        });
      }, { threshold: 0.25 })
    : null;

  function wireVideoAutoplay(container) {
    container.querySelectorAll('video.ccg-card__image, video.ccg-featured__card-media').forEach(vid => {
      if (vid.dataset.ccgObserved) return;
      vid.dataset.ccgObserved = '1';
      if (videoObserver) {
        videoObserver.observe(vid);
      } else {
        vid.addEventListener('mouseenter', () => vid.play().catch(() => {}));
        vid.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });
      }
    });
  }

  // ─── Animated model hover play ───────────────────────────────────────────

  function wireModelViewerHover(container) {
    container.querySelectorAll('model-viewer.ccg-card__model-viewer').forEach(mv => {
      if (mv.dataset.ccgHoverWired) return;
      mv.dataset.ccgHoverWired = '1';

      mv.pause();

      const card = mv.closest('.ccg-card') || mv.closest('.ccg-featured__card');
      if (!card) return;

      card.addEventListener('mouseenter', () => { mv.play(); });
      card.addEventListener('mouseleave', () => { mv.pause(); });
    });
  }

  // ─── Reactions ────────────────────────────────────────────────────────────

  async function react(postId, reaction) {
    try {
      const res = await fetch(`${API_BASE}/api/_mod/community/post/${postId}/react`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'React failed');

      const prev = userReactions.get(postId);
      userReactions.set(postId, reaction);

      document.querySelectorAll(`.ccg-reaction[data-post-id="${postId}"]`).forEach(btn => {
        const r = btn.dataset.reaction;
        const countEl = btn.querySelector('.ccg-reaction__count');
        const isActive = r === reaction;
        const wasPrev = r === prev;
        btn.classList.toggle('ccg-reaction--active', isActive);
        if (countEl) {
          let n = parseInt(countEl.textContent, 10) || 0;
          if (isActive && !wasPrev) n++;
          if (wasPrev && !isActive) n = Math.max(0, n - 1);
          countEl.textContent = n || '';
        }
      });
    } catch (err) {
      console.warn('[CommunityGallery] react error:', err);
    }
  }

  // ─── Tip modal ────────────────────────────────────────────────────────────

  function openTipModal(postId, creatorName) {
    document.getElementById('ccgTipModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'ccgTipModal';
    modal.className = 'ccg-tip-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Tip Creator');
    modal.innerHTML = `
      <div class="ccg-tip-modal__backdrop"></div>
      <div class="ccg-tip-modal__box">
        <header class="ccg-tip-modal__header">
          <h2>Tip ${sanitize(creatorName)}</h2>
          <button class="ccg-tip-modal__close" type="button" aria-label="Close">&times;</button>
        </header>
        <div class="ccg-tip-modal__body">
          <p class="ccg-tip-modal__subtitle">Send credits to show your appreciation</p>
          <div class="ccg-tip-modal__amounts">
            ${TIP_AMOUNTS.map(a => `<button class="ccg-tip-amount" data-amount="${a}" type="button">${a} 💎</button>`).join('')}
          </div>
        </div>
        <footer class="ccg-tip-modal__footer">
          <button class="ccg-tip-modal__cancel" type="button">Cancel</button>
          <button class="ccg-tip-modal__submit" type="button" id="ccgTipSubmit" disabled>Send Tip</button>
        </footer>
        <p class="ccg-tip-modal__status" id="ccgTipStatus" aria-live="polite"></p>
      </div>`;

    document.documentElement.appendChild(modal);

    let selectedAmount = null;
    const submitBtn = modal.querySelector('#ccgTipSubmit');
    const statusEl = modal.querySelector('#ccgTipStatus');

    modal.querySelectorAll('.ccg-tip-amount').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.ccg-tip-amount').forEach(b => b.classList.remove('ccg-tip-amount--active'));
        btn.classList.add('ccg-tip-amount--active');
        selectedAmount = parseInt(btn.dataset.amount, 10);
        submitBtn.disabled = false;
      });
    });

    const close = () => modal.remove();
    modal.querySelector('.ccg-tip-modal__backdrop').addEventListener('click', close);
    modal.querySelector('.ccg-tip-modal__close').addEventListener('click', close);
    modal.querySelector('.ccg-tip-modal__cancel').addEventListener('click', close);

    submitBtn.addEventListener('click', async () => {
      if (!selectedAmount) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      statusEl.textContent = '';
      statusEl.className = 'ccg-tip-modal__status';

      try {
        const res = await fetch(`${API_BASE}/api/_mod/community/tip`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ post_id: postId, amount: selectedAmount }),
        });
        const data = await res.json();
        if (data.ok) {
          statusEl.textContent = `✓ Sent ${selectedAmount} credits!`;
          statusEl.className = 'ccg-tip-modal__status ccg-tip-modal__status--ok';
          submitBtn.textContent = 'Done';
          setTimeout(close, 1400);
        } else {
          throw new Error(data.error?.message || 'Tip failed');
        }
      } catch (err) {
        statusEl.textContent = err.message || 'Something went wrong.';
        statusEl.className = 'ccg-tip-modal__status ccg-tip-modal__status--error';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Tip';
      }
    });
  }

  // ─── Data fetching ────────────────────────────────────────────────────────

  async function fetchPage(filter, offset) {
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
    if (filter && filter !== 'all') params.set('type', filter);
    if (currentSort && currentSort !== 'newest') params.set('sort', currentSort);
    if (currentSearch) params.set('q', currentSearch);
    const res = await fetch(`${API_BASE}/api/_mod/community/feed?${params}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Feed error ${res.status}`);
    return res.json();
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  function hideSkeleton() {
    if (skeleton) { skeleton.hidden = true; skeleton.setAttribute('aria-hidden', 'true'); }
  }

  function clearCards() {
    Array.from(grid.querySelectorAll('.ccg-card')).forEach(n => n.remove());
  }

  function renderPosts(posts, append) {
    hideSkeleton();
    if (!append) clearCards();
    const frag = document.createDocumentFragment();
    posts.filter(p => !isExcludedPost(p)).forEach(p => {
      const wrap = document.createElement('div');
      wrap.innerHTML = buildCard(p);
      frag.appendChild(wrap.firstElementChild);
    });
    grid.appendChild(frag);
    wireVideoAutoplay(grid);
    wireImageReveal(grid);
    wireModelViewerHover(grid);
  }

  /** Fade in images once loaded */
  function wireImageReveal(container) {
    container.querySelectorAll('img.ccg-card__image, img.ccg-featured__card-media').forEach(img => {
      if (img.dataset.ccgRevealed) return;
      img.dataset.ccgRevealed = '1';
      if (img.complete && img.naturalWidth) {
        img.classList.add('ccg-loaded');
      } else {
        img.addEventListener('load', () => img.classList.add('ccg-loaded'), { once: true });
        img.addEventListener('error', () => img.classList.add('ccg-loaded'), { once: true });
      }
    });
  }

  async function load(filter, offset, append) {
    if (isLoading) return;
    isLoading = true;
    if (loadMoreBtn) loadMoreBtn.disabled = true;

    try {
      if (!append) {
        clearCards();
        hideSkeleton();
        if (skeleton) skeleton.hidden = false;
        emptyState.hidden = true;
        loadMoreWrap.hidden = true;
      }

      const data = await fetchPage(filter, offset);
      if (!data.ok) throw new Error(data.error?.message || 'Feed failed');

      const posts = data.posts || [];
      currentOffset = offset + posts.length;

      // Cache posts for detail view lookup
      if (!append) allPostsCache = [];
      posts.forEach(p => {
        if (!allPostsCache.find(c => c.id === p.id)) allPostsCache.push(p);
      });

      hideSkeleton();

      if (!append && posts.length === 0) {
        emptyState.hidden = false;
        loadMoreWrap.hidden = true;
        return;
      }

      renderPosts(posts, append);
      emptyState.hidden = true;
      loadMoreWrap.hidden = !data.has_more;

      // Update hero stats from API response or fallback
      if (!append) {
        if (data.stats) {
          updateHeroStats(data.stats);
        } else if (!_statsLoaded) {
          // API didn't include stats — try dedicated endpoint, then compute from cache
          fetchAndUpdateStats();
        }
      }
    } catch (err) {
      console.warn('[CommunityGallery] load error:', err);
      hideSkeleton();
      clearCards();
      emptyState.hidden = false;
      loadMoreWrap.hidden = true;
    } finally {
      isLoading = false;
      if (loadMoreBtn) loadMoreBtn.disabled = false;
    }
  }

  // ─── Hero stats ────────────────────────────────────────────────────────────

  let _statsLoaded = false;

  function updateHeroStats(stats) {
    const creationsEl = document.getElementById('ccgStatCreations');
    const creatorsEl = document.getElementById('ccgStatCreators');
    const reactionsEl = document.getElementById('ccgStatReactions');

    if (creationsEl && stats.total_posts != null) {
      animateCounter(creationsEl, stats.total_posts);
    }
    if (creatorsEl && stats.total_creators != null) {
      animateCounter(creatorsEl, stats.total_creators);
    }
    if (reactionsEl && stats.total_reactions != null) {
      animateCounter(reactionsEl, stats.total_reactions);
    }
    _statsLoaded = true;
  }

  /**
   * Compute stats from the locally cached posts when the API doesn't
   * include a stats object. This is a best-effort fallback — the numbers
   * reflect only the posts that have been loaded so far.
   */
  function computeStatsFromCache() {
    const posts = allPostsCache;
    if (!posts.length) return null;
    const creatorSet = new Set();
    let totalReactions = 0;
    posts.forEach(p => {
      if (p.display_name) creatorSet.add(p.display_name);
      else if (p.user_id) creatorSet.add(p.user_id);
      // Sum all reaction counts on each post
      if (p.reactions && typeof p.reactions === 'object') {
        Object.values(p.reactions).forEach(v => { totalReactions += (Number(v) || 0); });
      } else if (typeof p.reaction_count === 'number') {
        totalReactions += p.reaction_count;
      }
    });
    return {
      total_posts: posts.length,
      total_creators: creatorSet.size,
      total_reactions: totalReactions
    };
  }

  /**
   * Try to fetch stats from the dedicated endpoint.
   * Falls back to computing from cache if the endpoint doesn't exist.
   */
  async function fetchAndUpdateStats() {
    if (_statsLoaded) return;
    try {
      const res = await fetch(`${API_BASE}/api/_mod/community/stats`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.total_posts != null || data.stats)) {
          updateHeroStats(data.stats || data);
          return;
        }
      }
    } catch (e) {
      // Endpoint may not exist — that's fine
    }
    // Fallback: compute from whatever posts we have cached
    const computed = computeStatsFromCache();
    if (computed) updateHeroStats(computed);
  }

  function animateCounter(el, target) {
    if (target == null || isNaN(target)) return;
    const duration = 1200;
    const start = performance.now();
    const from = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
    if (from === target) return; // no change
    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const current = Math.round(from + (target - from) * eased);
      el.textContent = current.toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ─── Activity Ticker ──────────────────────────────────────────────────────

  function populateTicker(posts) {
    if (!tickerTrack) return;
    const recent = posts.slice(0, 12);
    if (recent.length === 0) {
      const tickerEl = document.getElementById('ccgTicker');
      if (tickerEl) tickerEl.hidden = true;
      return;
    }

    const items = recent.map(p => {
      const name = sanitize(p.display_name || 'Someone');
      const type = genTypeCls(p.gen_type);
      const typeLabel = { model: 'a 3D model', image: 'an image', video: 'a video', animated: 'an animation' }[type] || 'a creation';
      return `<span class="ccg-ticker__item"><span class="ccg-ticker__dot"></span><strong>${name}</strong> shared ${typeLabel} · ${timeAgo(p.created_at)}</span>`;
    }).join('');

    // Double items for seamless infinite scroll
    tickerTrack.innerHTML = items + items;
  }

  // ─── Creator Spotlight — Organic floating bubble marquee ────────────────────

  const SPOTLIGHT_SHAPES = [
    'circle', 'circle-lg', 'pill', 'square', 'hex', 'tall', 'wide', 'diamond'
  ];

  // Filler names used when real creators are fewer than 50
  const SPOTLIGHT_FILLER_NAMES = [
    'PixelForge', 'NovaPrint', '3DWizard', 'MeshMaster', 'VoxelKing',
    'LayerCraft', 'PrintNinja', 'PolyGuru', 'FilaFlow', 'ResinRider',
    'NozzleNerd', 'ExtrudeX', 'SliceQueen', 'BuildBot', 'PrintPunk',
    'ModelMaverick', 'SolidState', 'DesignDojo', 'InfillPro', 'SupportStar',
    'BedLevelBoss', 'GCodeGhost', 'HotEndHero', 'RaftRunner', 'BrimBandit',
    'SkirtSage', 'TowerTitan', 'BridgeBuilder', 'OozeMaster', 'RetractKing',
    'CoolDown', 'HeatCreep', 'ZHopper', 'WarpGuard', 'AdhesionAce',
    'CaliCube', 'BenchyBoss', 'StrungOut', 'LayerOne', 'DualDrive',
    'DirectFeed', 'BowdenBeast', 'TempTower', 'FlowRate', 'SpeedDemon',
    'QualityFirst', 'DraftMode', 'UltraFine', 'TreeSupport', 'OrganicMesh',
  ];

  /** Seeded PRNG so the shuffle is stable within a 3-hour window */
  function spotlightSeed() {
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    return Math.floor(Date.now() / THREE_HOURS_MS);
  }

  function seededShuffle(arr, seed) {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 16807 + 0) % 2147483647;           // Park-Miller LCG
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function populateSpotlight(posts) {
    if (!spotlightTrack || !spotlightSection) return;

    // 1. Aggregate real creators from posts
    const creatorMap = new Map();
    posts.forEach(p => {
      const name = p.display_name || 'Anonymous';
      if (!creatorMap.has(name)) {
        creatorMap.set(name, { name, count: 0, real: true });
      }
      creatorMap.get(name).count++;
    });

    let pool = Array.from(creatorMap.values())
      .filter(c => c.count >= 1)
      .sort((a, b) => b.count - a.count);

    // 2. Pad to 50 with filler names (count shown as random 1-12)
    const existingNames = new Set(pool.map(c => c.name.toLowerCase()));
    const seed = spotlightSeed();
    let fillerSeed = seed;
    for (const fName of SPOTLIGHT_FILLER_NAMES) {
      if (pool.length >= 50) break;
      if (existingNames.has(fName.toLowerCase())) continue;
      fillerSeed = (fillerSeed * 16807) % 2147483647;
      pool.push({ name: fName, count: 1 + (fillerSeed % 12), real: false });
    }

    // 3. Deterministic shuffle that changes every 3 hours
    pool = seededShuffle(pool, seed).slice(0, 50);

    if (pool.length < 2) {
      spotlightSection.hidden = true;
      return;
    }

    // 4. Assign a shape to each card (deterministic per name so it feels consistent)
    function shapeFor(name, idx) {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      return SPOTLIGHT_SHAPES[(h + idx) % SPOTLIGHT_SHAPES.length];
    }

    // 5. Build card HTML
    function cardHTML(c, idx) {
      const shape = shapeFor(c.name, idx);
      const initials = getInitials(c.name);
      const color = avatarColor(c.name);
      const delay = ((idx * 0.37) % 3).toFixed(2);   // stagger bounce/float
      const needsMeta = shape === 'pill' || shape === 'wide';
      const nameEl = `<span class="ccg-spotlight__name">${sanitize(c.name)}</span>`;
      const countEl = `<span class="ccg-spotlight__count">${c.count} creation${c.count !== 1 ? 's' : ''}</span>`;

      if (needsMeta) {
        return `<div class="ccg-spotlight__card ccg-spotlight__card--${shape}" style="animation-delay:${delay}s">
          <div class="ccg-spotlight__avatar" style="background:${color}">${initials}</div>
          <div class="ccg-spotlight__meta">${nameEl}${countEl}</div>
        </div>`;
      }
      return `<div class="ccg-spotlight__card ccg-spotlight__card--${shape}" style="animation-delay:${delay}s">
        <div class="ccg-spotlight__avatar" style="background:${color}">${initials}</div>
        ${nameEl}${countEl}
      </div>`;
    }

    const cards = pool.map((c, i) => cardHTML(c, i)).join('');

    // 6. Double the cards for seamless infinite marquee
    const beltHTML = `<div class="ccg-spotlight__belt">${cards}${cards}</div>`;
    spotlightTrack.innerHTML = beltHTML;

    // 7. Calculate marquee duration based on card count (≈1.2s per card)
    const duration = Math.max(40, pool.length * 1.2);
    spotlightTrack.querySelector('.ccg-spotlight__belt')
      .style.setProperty('--marquee-duration', duration + 's');
    // Also set on the belt element directly for the animation
    spotlightTrack.querySelector('.ccg-spotlight__belt')
      .style.animationDuration = duration + 's';

    spotlightSection.hidden = false;
  }

  // ─── Hero Floating Thumbnails ──────────────────────────────────────────────

  function populateHeroFloaters(posts) {
    if (!heroFloaters) return;
    const thumbPosts = posts.filter(p => p.asset?.thumbnail_url).slice(0, 4);
    if (thumbPosts.length === 0) return;

    heroFloaters.innerHTML = thumbPosts.map(p =>
      `<div class="community-hero-floater"><img src="${sanitize(p.asset.thumbnail_url)}" alt="" loading="lazy" decoding="async"></div>`
    ).join('');
  }

  // ─── Grid event delegation ────────────────────────────────────────────────

  function wireGrid() {
    if (!grid) return;
    grid.addEventListener('click', e => {
      // Bookmark
      const bookmarkBtn = e.target.closest('.ccg-card__bookmark');
      if (bookmarkBtn) {
        e.stopPropagation();
        bookmarkBtn.classList.toggle('ccg-card__bookmark--saved');
        return;
      }
      // Reactions
      const reactionBtn = e.target.closest('.ccg-reaction[data-reaction]');
      if (reactionBtn) {
        e.stopPropagation();
        const postId = reactionBtn.dataset.postId;
        const reaction = reactionBtn.dataset.reaction;
        if (postId && reaction) react(postId, reaction);
        return;
      }
      // Tip
      const tipBtn = e.target.closest('.ccg-card__tip-btn[data-post-id]');
      if (tipBtn) {
        e.stopPropagation();
        const postId = tipBtn.dataset.postId;
        const creator = tipBtn.dataset.creator || 'Creator';
        if (postId) openTipModal(postId, creator);
        return;
      }
      // Card click → open detail view
      const card = e.target.closest('.ccg-card[data-post-id]');
      if (card) {
        const postId = card.dataset.postId;
        const post = allPostsCache.find(p => String(p.id) === String(postId));
        if (post) openDetailView(post);
      }
    });
  }

  // ─── Filter tabs ──────────────────────────────────────────────────────────

  function wireFilters() {
    if (!filterBar) return;
    filterBar.addEventListener('click', e => {
      const tab = e.target.closest('[data-ccg-filter]');
      if (!tab) return;
      const filter = tab.dataset.ccgFilter;
      if (filter === currentFilter) return;
      filterBar.querySelectorAll('[data-ccg-filter]').forEach(t => {
        t.classList.toggle('ccg-filter-tab--active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      currentFilter = filter;
      currentOffset = 0;
      load(currentFilter, 0, false);
    });
  }

  function wireLoadMore() {
    if (!loadMoreBtn) return;
    loadMoreBtn.addEventListener('click', () => {
      load(currentFilter, currentOffset, true);
    });
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  function wireSearch() {
    if (!searchInput) return;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        currentSearch = searchInput.value.trim();
        currentOffset = 0;
        load(currentFilter, 0, false);
      }, 400);
    });
  }

  // ─── Sort ──────────────────────────────────────────────────────────────────

  function wireSort() {
    if (!sortSelect) return;
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      currentOffset = 0;
      load(currentFilter, 0, false);
    });
  }

  // ─── Featured Carousel ────────────────────────────────────────────────────

  function buildFeaturedCard(post) {
    const asset = post.asset || {};
    const thumb = asset.thumbnail_url || '';
    const name = sanitize(post.display_name || 'Anonymous');
    const genType = post.gen_type || '';
    const typeCls = genTypeCls(genType);
    const isVideo = (post.asset_type === 'video') && asset.video_url;
    const postId = sanitize(post.id);
    const prompt = post.show_prompt && post.prompt_public ? sanitize(post.prompt_public) : '';

    let mediaEl;
    if (isVideo) {
      mediaEl = `<video class="ccg-featured__card-media" src="${sanitize(asset.video_url)}" muted loop playsinline preload="metadata" poster="${sanitize(thumb)}"></video>`;
    } else if (thumb) {
      mediaEl = `<img class="ccg-featured__card-media" src="${sanitize(thumb)}" alt="" loading="lazy" decoding="async">`;
    } else {
      mediaEl = `<div class="ccg-featured__card-media" style="background:linear-gradient(135deg,#0e0e14,#161622);width:100%;height:100%"></div>`;
    }

    return `
      <div class="ccg-featured__card" data-post-id="${postId}">
        ${mediaEl}
        ${genType ? `<div class="ccg-featured__card-badge ${typeCls}">${sanitize(genType)}</div>` : ''}
        <div class="ccg-featured__card-overlay">
          ${prompt ? `<p class="ccg-featured__card-title">${prompt}</p>` : ''}
          <p class="ccg-featured__card-author">${name}</p>
        </div>
      </div>`;
  }

  function wireFeaturedNav() {
    if (!featuredTrack || !featuredPrev || !featuredNext) return;

    const scrollAmount = () => {
      const card = featuredTrack.querySelector('.ccg-featured__card');
      return card ? card.offsetWidth + 14 : 320;
    };

    featuredPrev.addEventListener('click', () => {
      featuredTrack.scrollBy({ left: -scrollAmount(), behavior: 'smooth' });
    });
    featuredNext.addEventListener('click', () => {
      featuredTrack.scrollBy({ left: scrollAmount(), behavior: 'smooth' });
    });
  }

  // ─── Detail View ──────────────────────────────────────────────────────────

  function openDetailView(post) {
    if (!detailEl || !detailMedia || !detailInfo) return;

    const asset = post.asset || {};
    const thumb = asset.thumbnail_url || '';
    const name = sanitize(post.display_name || 'Anonymous');
    const initials = getInitials(post.display_name || 'Anonymous');
    const color = avatarColor(post.display_name || '');
    const ago = timeAgo(post.created_at);
    const genType = post.gen_type || '';
    const typeCls = genTypeCls(genType);
    const isVideo = (post.asset_type === 'video') && asset.video_url;
    const isAnimated = !!asset.animation_glb_url;
    const postId = sanitize(post.id);
    const prompt = post.show_prompt && post.prompt_public ? sanitize(post.prompt_public) : '';
    const reactions = post.reactions || {};

    // Media
    let mediaHtml;
    if (isAnimated && asset.animation_glb_url) {
      mediaHtml = `<model-viewer src="${sanitize(asset.animation_glb_url)}" camera-controls auto-rotate shadow-intensity="0.5" exposure="1.1" environment-image="neutral" poster="${sanitize(thumb)}" style="width:100%;height:100%;display:block;background:#0a0a0a"></model-viewer>`;
    } else if (isVideo) {
      mediaHtml = `<video src="${sanitize(asset.video_url)}" controls muted loop playsinline autoplay poster="${sanitize(thumb)}" style="width:100%;height:100%;object-fit:contain"></video>`;
    } else if (thumb) {
      mediaHtml = `<img src="${sanitize(thumb)}" alt="" style="width:100%;height:100%;object-fit:contain">`;
    } else {
      mediaHtml = `<div style="width:100%;height:100%;background:linear-gradient(135deg,#0e0e14,#161622)"></div>`;
    }
    detailMedia.innerHTML = mediaHtml;

    // Reactions HTML
    const reactionsHtml = REACTIONS.map(r => {
      const count = reactions[r] || 0;
      return `<button class="ccg-reaction" data-post-id="${postId}" data-reaction="${r}" title="${r}" type="button">${REACTION_EMOJI[r]}<span class="ccg-reaction__count">${count || ''}</span></button>`;
    }).join('');

    // Store current post ref for remix
    detailEl._currentPost = post;

    // Build prompt section or empty-state fallback
    const promptBlock = prompt
      ? `<div class="ccg-detail__prompt-section">
           <span class="ccg-detail__prompt-label">Prompt</span>
           <p class="ccg-detail__prompt-text">${prompt}</p>
         </div>`
      : `<p class="ccg-detail__no-prompt">Prompt not shared by creator</p>`;

    // Info panel
    detailInfo.innerHTML = `
      <div class="ccg-detail__creator">
        <div class="ccg-detail__avatar" style="background:${color}">${initials}</div>
        <div class="ccg-detail__creator-meta">
          <span class="ccg-detail__creator-name">${name}</span>
          <span class="ccg-detail__creator-time">${ago}</span>
        </div>
      </div>
      ${genType ? `<div class="ccg-detail__type ${typeCls}">${sanitize(genType)}</div>` : ''}
      ${promptBlock}
      <div class="ccg-detail__reactions">
        ${reactionsHtml}
      </div>
      <div class="ccg-detail__actions">
        <button class="ccg-detail__action-btn" data-post-id="${postId}" data-creator="${name}" data-action="tip" type="button">💎 Tip</button>
        <button class="ccg-detail__action-btn ccg-detail__action-btn--remix" data-action="remix" type="button"${prompt ? '' : ' disabled title="No prompt available"'}>Remix</button>
      </div>`;

    // Show
    detailEl.hidden = false;
    detailEl.classList.add('ccg-detail--open');
    detailEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Wire detail interactions
    wireDetailInteractions();
  }

  function closeDetailView() {
    if (!detailEl) return;
    detailEl.classList.remove('ccg-detail--open');
    detailEl.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      detailEl.hidden = true;
      if (detailMedia) detailMedia.innerHTML = '';
      if (detailInfo) detailInfo.innerHTML = '';
    }, 300);
    if (document.body.classList.contains('community-view')) {
      document.body.style.overflow = '';
    }
  }

  function wireDetailInteractions() {
    if (!detailInfo) return;

    detailInfo.querySelectorAll('.ccg-reaction[data-reaction]').forEach(btn => {
      btn.addEventListener('click', () => {
        const postId = btn.dataset.postId;
        const reaction = btn.dataset.reaction;
        if (postId && reaction) react(postId, reaction);
      });
    });

    const tipBtn = detailInfo.querySelector('[data-action="tip"]');
    if (tipBtn) {
      tipBtn.addEventListener('click', () => {
        const postId = tipBtn.dataset.postId;
        const creator = tipBtn.dataset.creator || 'Creator';
        if (postId) openTipModal(postId, creator);
      });
    }

    const remixBtn = detailInfo.querySelector('[data-action="remix"]');
    if (remixBtn && !remixBtn.disabled) {
      remixBtn.addEventListener('click', () => {
        const post = detailEl?._currentPost;
        if (!post) return;
        handleRemix(post);
      });
    }
  }

  // ─── Remix flow ────────────────────────────────────────────────────────────

  function handleRemix(post) {
    const prompt = post.prompt_public || post.prompt || '';
    if (!prompt) return;

    const genCls = genTypeCls(post.gen_type);
    const modeMap = { model: 'model', image: 'image', video: 'video', animated: 'model' };
    const targetPanel = modeMap[genCls] || 'model';

    const promptIdMap = {
      model: 'modelPrompt',
      image: 'imagePrompt',
      video: 'videoTextPrompt',
    };
    const targetPromptId = promptIdMap[targetPanel] || 'modelPrompt';

    closeDetailView();

    const exitBtn = document.getElementById('communityExit');
    if (exitBtn) exitBtn.click();

    setTimeout(() => {
      const railBtn = document.querySelector(`.rail-btn[data-panel="${targetPanel}"]`);
      if (railBtn) railBtn.click();

      setTimeout(() => {
        const textarea = document.getElementById(targetPromptId);
        if (textarea) {
          textarea.value = prompt;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        }
      }, 150);
    }, 250);
  }

  function wireDetailView() {
    if (!detailEl) return;

    if (detailBackdrop) {
      detailBackdrop.addEventListener('click', closeDetailView);
    }
    if (detailClose) {
      detailClose.addEventListener('click', closeDetailView);
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && detailEl.classList.contains('ccg-detail--open')) {
        closeDetailView();
      }
    });
  }

  // ─── Hero CTA wiring ─────────────────────────────────────────────────────

  function wireHeroCTAs() {
    const scrollBtn = document.querySelector('[data-ccg-scroll="gallery"]');
    if (scrollBtn) {
      scrollBtn.addEventListener('click', () => {
        const section = document.getElementById('communityCreationsSection');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    const backBtn = document.getElementById('communityBackToWorkspace');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        const exitBtn = document.getElementById('communityExit');
        if (exitBtn) exitBtn.click();
      });
    }
  }

  // ─── FAB — Quick Share ─────────────────────────────────────────────────────

  function wireFAB() {
    if (!fabBtn) return;
    fabBtn.addEventListener('click', () => {
      // Return to workspace to share from there
      const exitBtn = document.getElementById('communityExit');
      if (exitBtn) exitBtn.click();
    });
  }

  // ─── Share modal ──────────────────────────────────────────────────────────

  function getDisplayNameFromUser() {
    try {
      const user = window.__timrxUser || window.__me;
      if (user && user.email) {
        const local = user.email.split('@')[0];
        return local.replace(/[._\-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
      }
    } catch (_) {}
    return '';
  }

  function openShareModal(item) {
    document.getElementById('ccgShareModal')?.remove();

    const defaultName = getDisplayNameFromUser();
    const assetType = 'history';
    const assetId = item.id;
    const promptPreview = sanitize((item.prompt || '').slice(0, 200));

    const modal = document.createElement('div');
    modal.id = 'ccgShareModal';
    modal.className = 'ccg-share-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Share to Community');
    modal.innerHTML = `
      <div class="ccg-share-modal__backdrop"></div>
      <div class="ccg-share-modal__box">
        <header class="ccg-share-modal__header">
          <h2>Share to Community</h2>
          <button class="ccg-share-modal__close" type="button" aria-label="Close">&times;</button>
        </header>
        ${item.thumbnail_url ? `<img class="ccg-share-modal__thumb" src="${sanitize(item.thumbnail_url)}" alt="Preview">` : ''}
        <div class="ccg-share-modal__body">
          <label class="ccg-share-modal__label" for="ccgShareName">Display name</label>
          <input class="ccg-share-modal__input" id="ccgShareName" type="text" maxlength="60"
            value="${sanitize(defaultName)}" placeholder="How you appear in the gallery" autocomplete="off">

          <label class="ccg-share-modal__check-row">
            <input type="checkbox" id="ccgShareShowPrompt">
            <span>Show prompt publicly</span>
          </label>
          ${promptPreview ? `<p class="ccg-share-modal__prompt-preview" id="ccgSharePromptPreview" hidden>${promptPreview}</p>` : ''}
        </div>
        <footer class="ccg-share-modal__footer">
          <button class="ccg-share-modal__cancel" type="button">Cancel</button>
          <button class="ccg-share-modal__submit" type="button" id="ccgShareSubmit">Share</button>
        </footer>
        <p class="ccg-share-modal__status" id="ccgShareStatus" aria-live="polite"></p>
      </div>`;

    document.documentElement.appendChild(modal);

    const showPromptCheck = modal.querySelector('#ccgShareShowPrompt');
    const promptPreviewEl = modal.querySelector('#ccgSharePromptPreview');
    if (showPromptCheck && promptPreviewEl) {
      showPromptCheck.addEventListener('change', () => {
        promptPreviewEl.hidden = !showPromptCheck.checked;
      });
    }

    const glCanvas = document.getElementById('viewerCanvas');
    if (glCanvas) glCanvas.style.visibility = 'hidden';

    const close = () => {
      if (glCanvas) glCanvas.style.visibility = '';
      modal.remove();
    };
    modal.querySelector('.ccg-share-modal__backdrop').addEventListener('click', close);
    modal.querySelector('.ccg-share-modal__close').addEventListener('click', close);
    modal.querySelector('.ccg-share-modal__cancel').addEventListener('click', close);

    modal.querySelector('#ccgShareSubmit').addEventListener('click', async () => {
      const nameInput = modal.querySelector('#ccgShareName');
      const statusEl = modal.querySelector('#ccgShareStatus');
      const submitBtn = modal.querySelector('#ccgShareSubmit');
      const displayName = nameInput.value.trim();

      if (!displayName) {
        nameInput.focus();
        statusEl.textContent = 'Please enter a display name.';
        statusEl.className = 'ccg-share-modal__status ccg-share-modal__status--error';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sharing…';
      statusEl.textContent = '';

      try {
        const res = await fetch(`${API_BASE}/api/_mod/community/share`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            asset_type: assetType,
            asset_id: assetId,
            display_name: displayName,
            prompt_public: item.prompt || null,
            show_prompt: showPromptCheck ? showPromptCheck.checked : false,
          }),
        });
        const data = await res.json();

        if (data.ok) {
          statusEl.textContent = '✓ Shared to Community!';
          statusEl.className = 'ccg-share-modal__status ccg-share-modal__status--ok';
          submitBtn.textContent = 'Done';
          setTimeout(close, 1400);
          if (document.body.classList.contains('community-view')) {
            currentOffset = 0;
            load(currentFilter, 0, false);
          }
        } else {
          throw new Error(data.error?.message || 'Share failed');
        }
      } catch (err) {
        statusEl.textContent = err.message || 'Something went wrong.';
        statusEl.className = 'ccg-share-modal__status ccg-share-modal__status--error';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Share';
      }
    });

    requestAnimationFrame(() => modal.querySelector('#ccgShareName')?.focus());
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  let _loaded = false;

  function loadOnce() {
    if (_loaded) return;
    _loaded = true;
    // Single fetch for featured carousel, main grid, ticker, and spotlight.
    load('all', 0, false).then(() => {
      // Populate featured from cached posts
      if (featuredTrack && allPostsCache.length > 0) {
        featuredPosts = allPostsCache.slice(0, FEATURED_SIZE).filter(p => !isExcludedPost(p));
        if (featuredPosts.length > 0) {
          featuredTrack.innerHTML = featuredPosts.map(p => buildFeaturedCard(p)).join('');
          wireVideoAutoplay(featuredTrack);
          wireImageReveal(featuredTrack);
          if (featuredSection) featuredSection.hidden = false;
          featuredTrack.addEventListener('click', e => {
            const card = e.target.closest('.ccg-featured__card[data-post-id]');
            if (!card) return;
            const postId = card.dataset.postId;
            const post = featuredPosts.find(p => String(p.id) === postId);
            if (post) openDetailView(post);
          });
        } else if (featuredSection) {
          featuredSection.hidden = true;
        }
      }

      // Populate new v3 features
      populateTicker(allPostsCache);
      populateSpotlight(allPostsCache);
      populateHeroFloaters(allPostsCache);

    }).catch(() => {
      // Fallback
      console.warn('[CommunityGallery] initial load failed');
    });
  }

  function init() {
    // Main grid refs
    grid = document.getElementById('ccgGrid');
    skeleton = document.getElementById('ccgSkeleton');
    emptyState = document.getElementById('ccgEmpty');
    loadMoreWrap = document.getElementById('ccgLoadMoreWrap');
    loadMoreBtn = document.getElementById('ccgLoadMore');
    filterBar = document.querySelector('.ccg-filter-bar');

    // Featured refs
    featuredSection = document.getElementById('ccgFeatured');
    featuredTrack = document.getElementById('ccgFeaturedTrack');
    featuredPrev = document.getElementById('ccgFeaturedPrev');
    featuredNext = document.getElementById('ccgFeaturedNext');

    // Detail view refs
    detailEl = document.getElementById('ccgDetail');
    detailBackdrop = document.getElementById('ccgDetailBackdrop');
    detailClose = document.getElementById('ccgDetailClose');
    detailMedia = document.getElementById('ccgDetailMedia');
    detailInfo = document.getElementById('ccgDetailInfo');

    // v3 new refs
    searchInput = document.getElementById('ccgSearchInput');
    sortSelect = document.getElementById('ccgSortSelect');
    tickerTrack = document.getElementById('ccgTickerTrack');
    spotlightTrack = document.getElementById('ccgSpotlightTrack');
    spotlightSection = document.getElementById('ccgSpotlight');
    heroFloaters = document.getElementById('ccgHeroFloaters');
    fabBtn = document.getElementById('ccgFab');

    if (!grid) return;

    wireFilters();
    wireLoadMore();
    wireGrid();
    wireFeaturedNav();
    wireDetailView();
    wireHeroCTAs();
    wireSearch();
    wireSort();
    wireFAB();

    if (document.body.classList.contains('community-view')) {
      loadOnce();
    } else {
      const mo = new MutationObserver(() => {
        if (document.body.classList.contains('community-view')) {
          mo.disconnect();
          loadOnce();
        }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // ─── Deep-link: open a specific post by ID ─────────────────────────────

  async function openPostById(postId) {
    if (!postId) return;
    // Try cache first
    let post = allPostsCache.find(p => String(p.id) === String(postId));
    if (post) { openDetailView(post); return; }

    // Not cached — fetch the feed (which populates cache) then retry
    try {
      const res = await fetch(`${API_BASE}/api/_mod/community/feed?limit=50&offset=0`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        (data.posts || []).forEach(p => {
          if (!allPostsCache.find(c => c.id === p.id)) allPostsCache.push(p);
        });
        post = allPostsCache.find(p => String(p.id) === String(postId));
        if (post) { openDetailView(post); return; }
      }
    } catch (_) { /* silent */ }

    // Post not in feed (deleted / too old) — still scroll to community
    const section = document.getElementById('communityCreationsSection');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.CommunityGallery = { init, openShareModal, openPostById };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
