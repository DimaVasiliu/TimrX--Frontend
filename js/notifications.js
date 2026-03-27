/**
 * notifications.js
 * Notification Center for TimrX workspace.
 *
 * Responsibilities:
 * - Poll unread count every 30s (with single-flight guard)
 * - Render bell badge with count
 * - Render dropdown panel (paginated, filtered by tab)
 * - Mark read (single + all)
 * - Deep-link navigation on click
 * - Mobile menu badge sync
 */

import { BACKEND, log, apiFetch } from './config.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const POLL_INTERVAL_MS = 30_000;     // 30s between unread-count polls
const DROPDOWN_PAGE_SIZE = 15;
const CATEGORIES = ['all', 'credit', 'tip', 'job', 'account', 'system'];

// Category labels for tabs
const CATEGORY_LABELS = {
  all: 'All',
  credit: 'Credits',
  tip: 'Tips',
  job: 'Jobs',
  account: 'Account',
  system: 'System',
};

// ============================================================================
// STATE
// ============================================================================

let unreadCount = 0;
let notifications = [];
let currentCategory = 'all';
let currentOffset = 0;
let isDropdownOpen = false;
let pollTimer = null;
let fetchInFlight = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the notification system.
 * Call after DOM is ready and identity is bootstrapped.
 */
export function initNotifications() {
  console.log('[Notifications] Setting up bell listener...');
  setupBellListener();
  setupOutsideClickClose();
  setupMobileBellListener();
  console.log('[Notifications] Bell listener attached');

  // Initial fetch (non-blocking — must not break init)
  fetchUnreadCount().catch(() => {});

  // Start polling
  startPolling();

  console.log('[Notifications] Initialized');
}

// ============================================================================
// POLLING
// ============================================================================

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchUnreadCount() {
  // Single-flight guard
  if (fetchInFlight) return;

  try {
    fetchInFlight = true;
    const res = await apiFetch(`${BACKEND}/api/_mod/notifications/unread-count`);
    if (res && res.ok && res.data) {
      const prev = unreadCount;
      unreadCount = res.data.count || 0;
      updateBadge();

      // If count increased, pulse the bell
      if (unreadCount > prev && prev >= 0) {
        pulseBell();
      }
    }
  } catch (e) {
    // Silent fail — badge just won't update
  } finally {
    fetchInFlight = null;
  }
}

// ============================================================================
// BADGE UI
// ============================================================================

function updateBadge() {
  const badge = document.getElementById('notifBadge');
  const bell = document.getElementById('notificationBell');
  const mobileBadge = document.getElementById('mobileNotifBadge');

  if (badge) {
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      badge.hidden = false;
      bell?.classList.add('has-unread');
    } else {
      badge.hidden = true;
      bell?.classList.remove('has-unread');
    }
  }

  // Sync mobile menu badge
  if (mobileBadge) {
    if (unreadCount > 0) {
      mobileBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      mobileBadge.hidden = false;
    } else {
      mobileBadge.hidden = true;
    }
  }
}

function pulseBell() {
  const bell = document.getElementById('notificationBell');
  if (!bell) return;
  bell.classList.remove('notif-pulse');
  // Force reflow to restart animation
  void bell.offsetWidth;
  bell.classList.add('notif-pulse');
  setTimeout(() => bell.classList.remove('notif-pulse'), 2500);
}

// ============================================================================
// DROPDOWN PANEL
// ============================================================================

function setupBellListener() {
  const bell = document.getElementById('notificationBell');
  if (bell) {
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[Notifications] Bell clicked');
      toggleDropdown();
    });
    console.log('[Notifications] Bell listener attached to #notificationBell');
  } else {
    // Bell not in DOM yet — use delegated listener on body
    console.warn('[Notifications] #notificationBell not found, using delegation');
    document.addEventListener('click', (e) => {
      const bellEl = e.target.closest('#notificationBell');
      if (bellEl) {
        e.stopPropagation();
        console.log('[Notifications] Bell clicked (delegated)');
        toggleDropdown();
      }
    });
  }
}

function setupMobileBellListener() {
  const mobileBtn = document.getElementById('mobileNotifBtn');
  mobileBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close mobile menu, open notification panel
    const mobileMenu = document.getElementById('wsMobileMenu');
    if (mobileMenu) {
      mobileMenu.style.display = 'none';
      mobileMenu.setAttribute('aria-hidden', 'true');
    }
    const burger = document.getElementById('wsBurger');
    burger?.classList.remove('is-open');
    toggleDropdown();
  });
}

function setupOutsideClickClose() {
  document.addEventListener('click', (e) => {
    if (!isDropdownOpen) return;
    const panel = document.getElementById('notifDropdown');
    const bell = document.getElementById('notificationBell');
    // Don't close if click is on bell or inside panel
    if (e.target.closest('#notificationBell')) return;
    if (panel && panel.contains(e.target)) return;
    closeDropdown();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDropdownOpen) {
      closeDropdown();
    }
  });
}

function toggleDropdown() {
  if (isDropdownOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

/**
 * Position the dropdown using fixed coordinates so it sits
 * directly below the bell icon, with the panel extending to the left.
 */
function positionDropdown(panel, bell) {
  if (!bell || !panel) return;
  const rect = bell.getBoundingClientRect();
  const panelWidth = 340;
  // Right edge of panel aligns with the right edge of the bell + small offset
  const rightEdge = rect.right + 8;
  let left = rightEdge - panelWidth;
  // Don't overflow left edge of viewport
  if (left < 8) left = 8;
  panel.style.top = `${rect.bottom + 8}px`;
  panel.style.left = `${left}px`;
}

function openDropdown() {
  isDropdownOpen = true;
  currentCategory = 'all';
  currentOffset = 0;

  const bell = document.getElementById('notificationBell');
  bell?.classList.add('is-active');

  // Create or show panel
  let panel = document.getElementById('notifDropdown');
  if (!panel) {
    panel = createDropdownPanel();
    document.body.appendChild(panel);
  }

  // Position fixed directly under the bell, extending to the left
  positionDropdown(panel, bell);

  // Force browser to paint the hidden state first (required for transition)
  void panel.offsetHeight;

  // Show panel — inline ALL critical styles so it works even if CSS fails
  panel.classList.add('is-open');
  Object.assign(panel.style, {
    position:       'fixed',
    display:        'flex',
    flexDirection:  'column',
    opacity:        '1',
    pointerEvents:  'auto',
    width:          '340px',
    maxHeight:      '65vh',
    zIndex:         '999999',
    background:     'rgba(14,14,14,0.94)',
    border:         '1px solid rgba(255,255,255,0.08)',
    borderRadius:   '12px',
    boxShadow:      '0 20px 50px rgba(0,0,0,0.55)',
    overflow:       'hidden',
    transform:      'translateY(0)',
  });
  panel.setAttribute('aria-hidden', 'false');

  // Render empty state right away, then fetch in background
  renderNotifications();

  // Fetch real data (non-blocking)
  fetchNotifications().then(() => {
    renderNotifications();
  }).catch(e => {
    console.warn('[Notifications] Fetch failed:', e);
  });
}

function closeDropdown() {
  isDropdownOpen = false;
  const panel = document.getElementById('notifDropdown');
  const bell = document.getElementById('notificationBell');
  bell?.classList.remove('is-active');

  if (panel) {
    panel.classList.remove('is-open');
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    panel.style.transform = 'translateY(-4px)';
    panel.setAttribute('aria-hidden', 'true');
    // Hide after transition completes
    setTimeout(() => {
      if (!isDropdownOpen) panel.style.display = 'none';
    }, 200);
  }
}

// ============================================================================
// DROPDOWN RENDERING
// ============================================================================

function createDropdownPanel() {
  const panel = document.createElement('div');
  panel.id = 'notifDropdown';
  panel.className = 'notif-dropdown';
  panel.style.display = 'none';          // hidden until openDropdown()
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Notifications');
  panel.setAttribute('aria-hidden', 'true');

  panel.innerHTML = `
    <div class="notif-dropdown-header">
      <span class="notif-dropdown-title">Notifications</span>
      <button type="button" class="notif-mark-all" id="notifMarkAllBtn" title="Mark all as read">
        <i class="fa-solid fa-check-double"></i>
      </button>
    </div>
    <div class="notif-tabs" id="notifTabs"></div>
    <div class="notif-list" id="notifList"></div>
    <div class="notif-footer">
      <button type="button" class="notif-load-more" id="notifLoadMore" hidden>Load more</button>
    </div>
  `;

  // Wire up mark-all button
  panel.querySelector('#notifMarkAllBtn')?.addEventListener('click', handleMarkAllRead);

  // Wire up load more
  panel.querySelector('#notifLoadMore')?.addEventListener('click', handleLoadMore);

  // Render tabs
  renderTabs(panel.querySelector('#notifTabs'));

  return panel;
}

function renderTabs(container) {
  if (!container) return;
  container.innerHTML = '';

  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `notif-tab${cat === currentCategory ? ' is-active' : ''}`;
    btn.textContent = CATEGORY_LABELS[cat] || cat;
    btn.dataset.category = cat;
    btn.addEventListener('click', () => switchTab(cat));
    container.appendChild(btn);
  });
}

async function switchTab(category) {
  currentCategory = category;
  currentOffset = 0;
  notifications = [];

  // Update tab styling
  document.querySelectorAll('.notif-tab').forEach(t => {
    t.classList.toggle('is-active', t.dataset.category === category);
  });

  await fetchNotifications();
  renderNotifications();
}

function renderNotifications() {
  const list = document.getElementById('notifList');
  if (!list) return;

  if (notifications.length === 0) {
    list.innerHTML = `
      <div class="notif-empty">
        <i class="fa-regular fa-bell-slash"></i>
        <span>You're all caught up!</span>
      </div>
    `;
    const loadMore = document.getElementById('notifLoadMore');
    if (loadMore) loadMore.hidden = true;
    return;
  }

  list.innerHTML = '';
  notifications.forEach(n => {
    const item = createNotificationItem(n);
    list.appendChild(item);
  });

  // Show/hide load more
  const loadMore = document.getElementById('notifLoadMore');
  if (loadMore) {
    loadMore.hidden = notifications.length < DROPDOWN_PAGE_SIZE;
  }
}

function createNotificationItem(n) {
  const item = document.createElement('div');
  item.className = `notif-item${n.is_read ? '' : ' is-unread'}`;
  item.dataset.id = n.id;

  const iconClass = n.icon || 'fa-bell';
  const timeAgo = formatTimeAgo(n.created_at);

  item.innerHTML = `
    <div class="notif-item-icon">
      <i class="fa-solid ${iconClass}"></i>
    </div>
    <div class="notif-item-content">
      <div class="notif-item-title">${escapeHtml(n.title)}</div>
      ${n.body ? `<div class="notif-item-body">${escapeHtml(n.body)}</div>` : ''}
      <div class="notif-item-time">${timeAgo}</div>
    </div>
    ${!n.is_read ? '<div class="notif-item-dot"></div>' : ''}
  `;

  item.addEventListener('click', () => handleNotificationClick(n));
  return item;
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleNotificationClick(n) {
  // Mark as read
  if (!n.is_read) {
    try {
      await apiFetch(`${BACKEND}/api/_mod/notifications/${n.id}/read`, { method: 'POST' });
      n.is_read = true;
      unreadCount = Math.max(0, unreadCount - 1);
      updateBadge();
      renderNotifications();
    } catch (e) { /* silent */ }
  }

  // Navigate if link provided
  if (n.link) {
    closeDropdown();
    // Extract hash from links like "/3dprint#community" when already on 3dprint
    const hashMatch = n.link.match(/#(.+)$/);
    const hash = hashMatch ? hashMatch[1] : null;

    if (hash) {
      // Try to open the corresponding expanded view via trigger button
      const trigger = document.querySelector(`[data-open-${hash}]`);
      if (trigger) {
        trigger.click();
        return;
      }
    }

    if (n.link.startsWith('/') || n.link.startsWith('http')) {
      window.location.href = n.link;
    } else if (n.link.startsWith('#')) {
      window.location.hash = n.link;
    }
  }
}

async function handleMarkAllRead() {
  try {
    const res = await apiFetch(`${BACKEND}/api/_mod/notifications/read-all`, { method: 'POST' });
    if (res && res.ok) {
      unreadCount = 0;
      updateBadge();
      notifications.forEach(n => { n.is_read = true; });
      renderNotifications();
    }
  } catch (e) {
    log('[Notifications] mark-all-read failed:', e);
  }
}

async function handleLoadMore() {
  currentOffset += DROPDOWN_PAGE_SIZE;
  await fetchNotifications(true);
  renderNotifications();
}

// ============================================================================
// DATA FETCHING
// ============================================================================

async function fetchNotifications(append = false) {
  try {
    const params = new URLSearchParams({
      limit: String(DROPDOWN_PAGE_SIZE),
      offset: String(currentOffset),
    });
    if (currentCategory !== 'all') {
      params.set('category', currentCategory);
    }

    const res = await apiFetch(`${BACKEND}/api/_mod/notifications?${params}`);
    if (res && res.ok && res.data) {
      if (append) {
        notifications = [...notifications, ...(res.data.notifications || [])];
      } else {
        notifications = res.data.notifications || [];
      }
    }
  } catch (e) {
    log('[Notifications] fetch failed:', e);
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// EXPORTS
// ============================================================================

export function getUnreadCount() {
  return unreadCount;
}

export { fetchUnreadCount, closeDropdown };
