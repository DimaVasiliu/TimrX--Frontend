/**
 * community-gallery.js
 * Community Creations Gallery — loads posts from /api/_mod/community/feed,
 * renders a filterable 6-column card grid with reactions and tip functionality.
 */

(function () {
  'use strict';

  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  const PAGE_SIZE = 18;
  const REACTIONS = ['heart', 'fire', 'star', 'clap', 'wow'];
  const REACTION_EMOJI = { heart: '❤️', fire: '🔥', star: '⭐', clap: '👏', wow: '😮' };
  const TIP_AMOUNTS = [5, 10, 25, 50];

  // State
  let currentFilter = 'all';
  let currentOffset = 0;
  let isLoading = false;

  // Track current user's reactions per post (postId → reaction string)
  const userReactions = new Map();

  // DOM refs (resolved on init)
  let grid, skeleton, emptyState, loadMoreWrap, loadMoreBtn, filterBar;

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

  // Derive gen_type CSS modifier class: model | image | video | animated
  function genTypeCls(genType) {
    if (!genType) return 'model';
    const t = genType.toLowerCase();
    if (t.includes('video')) return 'video';
    if (t.includes('animated') || t.includes('rigged')) return 'animated';
    if (t.includes('3d')) return 'model';
    return 'image';
  }

  // ─── Card rendering ───────────────────────────────────────────────────────

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
    container.querySelectorAll('video.ccg-card__image').forEach(vid => {
      if (vid.dataset.ccgObserved) return;
      vid.dataset.ccgObserved = '1';
      if (videoObserver) {
        videoObserver.observe(vid);
      } else {
        // Fallback: hover play for browsers without IntersectionObserver
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

      // Start paused — show poster only
      mv.pause();

      const card = mv.closest('.ccg-card');
      if (!card) return;

      card.addEventListener('mouseenter', () => {
        mv.play();
      });

      card.addEventListener('mouseleave', () => {
        mv.pause();
      });
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

      const card = grid.querySelector(`.ccg-card[data-post-id="${postId}"]`);
      if (!card) return;
      const prev = userReactions.get(postId);
      userReactions.set(postId, reaction);

      card.querySelectorAll('.ccg-reaction').forEach(btn => {
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
    posts.forEach(p => {
      const wrap = document.createElement('div');
      wrap.innerHTML = buildCard(p);
      frag.appendChild(wrap.firstElementChild);
    });
    grid.appendChild(frag);
    wireVideoAutoplay(grid);
    wireImageReveal(grid);
    wireModelViewerHover(grid);
  }

  /** Fade in images once loaded (adds .ccg-loaded class) */
  function wireImageReveal(container) {
    container.querySelectorAll('img.ccg-card__image').forEach(img => {
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

      currentOffset = offset + (data.posts?.length || 0);

      hideSkeleton();

      if (!append && (!data.posts || data.posts.length === 0)) {
        emptyState.hidden = false;
        loadMoreWrap.hidden = true;
        return;
      }

      renderPosts(data.posts || [], append);
      emptyState.hidden = true;
      loadMoreWrap.hidden = !data.has_more;
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

  // ─── Grid event delegation ────────────────────────────────────────────────

  function wireGrid() {
    if (!grid) return;
    grid.addEventListener('click', e => {
      const reactionBtn = e.target.closest('.ccg-reaction[data-reaction]');
      if (reactionBtn) {
        const postId = reactionBtn.dataset.postId;
        const reaction = reactionBtn.dataset.reaction;
        if (postId && reaction) react(postId, reaction);
        return;
      }
      const tipBtn = e.target.closest('.ccg-card__tip-btn[data-post-id]');
      if (tipBtn) {
        const postId = tipBtn.dataset.postId;
        const creator = tipBtn.dataset.creator || 'Creator';
        if (postId) openTipModal(postId, creator);
        return;
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
    load('all', 0, false);
  }

  function init() {
    grid = document.getElementById('ccgGrid');
    skeleton = document.getElementById('ccgSkeleton');
    emptyState = document.getElementById('ccgEmpty');
    loadMoreWrap = document.getElementById('ccgLoadMoreWrap');
    loadMoreBtn = document.getElementById('ccgLoadMore');
    filterBar = document.querySelector('.ccg-filter-bar');

    if (!grid) return;

    wireFilters();
    wireLoadMore();
    wireGrid();

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

  // ─── Public API ───────────────────────────────────────────────────────────

  window.CommunityGallery = { init, openShareModal };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
