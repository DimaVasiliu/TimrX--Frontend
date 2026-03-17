/**
 * community-gallery.js
 * Community Creations Gallery — loads posts from /api/_mod/community/feed,
 * renders a filterable card grid, and handles "Share to Community" modal.
 */

(function () {
    'use strict';
  
    const API_BASE = window.API_BASE || '';
    const FEED_URL = `${API_BASE}/api/_mod/community/feed`;
    const SHARE_URL = `${API_BASE}/api/_mod/community/share`;
    const PAGE_SIZE = 16;
  
    // State
    let currentFilter = 'all';
    let currentOffset = 0;
    let totalPosts = 0;
    let isLoading = false;
  
    // DOM refs (resolved on init)
    let grid, skeleton, emptyState, loadMoreWrap, loadMoreBtn, filterBar;
  
    // ─── Utilities ────────────────────────────────────────────────────────────
  
    function getInitials(displayName) {
      if (!displayName) return '?';
      const words = displayName.trim().replace(/[._\-]/g, ' ').split(/\s+/).filter(Boolean);
      if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
      return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    }
  
    // Deterministic colour from string — picks from a palette of 8
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
  
    const TYPE_META = {
      model:   { label: '3D',  cls: 'ccg-badge--model' },
      image:   { label: 'IMG', cls: 'ccg-badge--image' },
      video:   { label: 'VID', cls: 'ccg-badge--video' },
    };
  
    function sanitize(str) {
      const d = document.createElement('div');
      d.textContent = str || '';
      return d.innerHTML;
    }
  
    // ─── Card rendering ───────────────────────────────────────────────────────
  
    function buildCard(post) {
      const type = post.asset_type || 'model';
      const asset = post.asset || {};
      const thumb = asset.thumbnail_url || '';
      const title = sanitize(asset.title || post.prompt_public || '');
      const prompt = post.show_prompt && post.prompt_public ? sanitize(post.prompt_public) : '';
      const name = sanitize(post.display_name || 'Anonymous');
      const initials = getInitials(post.display_name || 'Anonymous');
      const color = avatarColor(post.display_name || '');
      const ago = timeAgo(post.created_at);
      const meta = TYPE_META[type] || TYPE_META.model;
      const isVideo = type === 'video' && asset.video_url;
  
      const thumbEl = isVideo
        ? `<video class="ccg-card__thumb" src="${sanitize(asset.video_url)}" muted loop playsinline preload="none" poster="${sanitize(thumb)}"></video>`
        : thumb
          ? `<img class="ccg-card__thumb" src="${sanitize(thumb)}" alt="${title}" loading="lazy" decoding="async">`
          : `<div class="ccg-card__thumb ccg-card__thumb--placeholder"></div>`;
  
      return `
        <article class="ccg-card" data-post-id="${sanitize(post.id)}" data-type="${type}">
          <div class="ccg-card__media">
            ${thumbEl}
            <span class="ccg-badge ${meta.cls}">${meta.label}</span>
            ${prompt ? `<div class="ccg-card__overlay"><p>${prompt}</p></div>` : ''}
          </div>
          <div class="ccg-card__footer">
            <div class="ccg-card__avatar" style="background:${color}" aria-hidden="true">${initials}</div>
            <div class="ccg-card__meta">
              <span class="ccg-card__name">${name}</span>
              <span class="ccg-card__time">${ago}</span>
            </div>
          </div>
        </article>`;
    }
  
    // ─── Video hover play ─────────────────────────────────────────────────────
  
    function wireVideoHover(container) {
      container.querySelectorAll('.ccg-card__thumb[src]').forEach(vid => {
        if (vid.tagName !== 'VIDEO') return;
        vid.addEventListener('mouseenter', () => vid.play().catch(() => {}));
        vid.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });
      });
    }
  
    // ─── Data fetching ────────────────────────────────────────────────────────
  
    async function fetchPage(filter, offset) {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
      if (filter && filter !== 'all') params.set('type', filter);
      const res = await fetch(`${FEED_URL}?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Feed error ${res.status}`);
      return res.json();
    }
  
    // ─── Render ───────────────────────────────────────────────────────────────
  
    function hideSkeleton() {
      if (skeleton) { skeleton.hidden = true; skeleton.setAttribute('aria-hidden', 'true'); }
    }
  
    function renderPosts(posts, append) {
      hideSkeleton();
      if (!append) {
        // Remove all existing cards (keep skeleton node)
        Array.from(grid.querySelectorAll('.ccg-card')).forEach(n => n.remove());
      }
      const frag = document.createDocumentFragment();
      posts.forEach(p => {
        const wrap = document.createElement('div');
        wrap.innerHTML = buildCard(p);
        frag.appendChild(wrap.firstElementChild);
      });
      grid.appendChild(frag);
      wireVideoHover(grid);
    }
  
    async function load(filter, offset, append) {
      if (isLoading) return;
      isLoading = true;
      if (loadMoreBtn) loadMoreBtn.disabled = true;
  
      try {
        if (!append) {
          hideSkeleton();
          if (skeleton) skeleton.hidden = false;
          emptyState.hidden = true;
          loadMoreWrap.hidden = true;
        }
  
        const data = await fetchPage(filter, offset);
        if (!data.ok) throw new Error(data.error?.message || 'Feed failed');
  
        totalPosts = data.total || 0;
        currentOffset = offset + (data.posts?.length || 0);
  
        if (!append && (!data.posts || data.posts.length === 0)) {
          hideSkeleton();
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
        emptyState.hidden = false;
        loadMoreWrap.hidden = true;
      } finally {
        isLoading = false;
        if (loadMoreBtn) loadMoreBtn.disabled = false;
      }
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
      // Remove any existing modal
      document.getElementById('ccgShareModal')?.remove();
  
      const defaultName = getDisplayNameFromUser();
      // All history items are shared via history_item_id (the backend resolves the subtype)
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
  
      document.body.appendChild(modal);
  
      // Wire prompt preview toggle
      const showPromptCheck = modal.querySelector('#ccgShareShowPrompt');
      const promptPreviewEl = modal.querySelector('#ccgSharePromptPreview');
      if (showPromptCheck && promptPreviewEl) {
        showPromptCheck.addEventListener('change', () => {
          promptPreviewEl.hidden = !showPromptCheck.checked;
        });
      }
  
      // Close handlers
      const close = () => modal.remove();
      modal.querySelector('.ccg-share-modal__backdrop').addEventListener('click', close);
      modal.querySelector('.ccg-share-modal__close').addEventListener('click', close);
      modal.querySelector('.ccg-share-modal__cancel').addEventListener('click', close);
  
      // Submit
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
          const res = await fetch(SHARE_URL, {
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
            // Refresh gallery if visible
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
  
      // Focus name input
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
  
      if (!grid) return; // Gallery section not present
  
      wireFilters();
      wireLoadMore();
  
      // Load when community-view class is added to body (the nav system adds it when user opens Community)
      // Using MutationObserver because the gallery container has hidden+inert so IntersectionObserver won't fire
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
  
    // Auto-init when DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
  