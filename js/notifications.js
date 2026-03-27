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
export async function initNotifications() {
  setupBellListener();
  setupOutsideClickClose();
  setupMobileBellListener();

  // Initial fetch
  await fetchUnreadCount();

  // Start polling
  startPolling();

  log('[Notifications] Initialized');
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
    if (res && res.ok) {
      const prev = unreadCount;
      unreadCount = res.count || 0;
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
  bell?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });
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
    if (panel && !panel.contains(e.target) && e.target !== bell && !bell?.contains(e.target)) {
      closeDropdown();
    }
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

async function openDropdown() {
  isDropdownOpen = true;
  currentCategory = 'all';
  currentOffset = 0;

  const bell = document.getElementById('notificationBell');
  bell?.classList.add('is-active');

  // Create or show panel
  let panel = document.getElementById('notifDropdown');
  if (!panel) {
    panel = createDropdownPanel();
    // Position relative to bell
    const bellRect = bell?.getBoundingClientRect();
    if (bellRect) {
      const credits = document.getElementById('workspaceCreditsGroup');
      if (credits) {
        credits.appendChild(panel);
      } else {
        document.body.appendChild(panel);
      }
    } else {
      document.body.appendChild(panel);
    }
  }

  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');

  // Fetch notifications
  await fetchNotifications();
  renderNotifications();
}

function closeDropdown() {
  isDropdownOpen = false;
  const panel = document.getElementById('notifDropdown');
  const bell = document.getElementById('notificationBell');
  bell?.classList.remove('is-active');

  if (panel) {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
  }
}

// ============================================================================
// DROPDOWN RENDERING
// ============================================================================

function createDropdownPanel() {
  const panel = document.createElement('div');
  panel.id = 'notifDropdown';
  panel.className = 'notif-dropdown';
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
    if (n.link.startsWith('/') || n.link.startsWith('http')) {
      window.location.href = n.link;
    } else if (n.link.startsWith('#')) {
      // Handle hash navigation (e.g. #history, #community)
      const target = n.link.replace('#', '');
      const trigger = document.querySelector(`[data-open-${target}]`);
      if (trigger) {
        trigger.click();
      } else {
        window.location.hash = n.link;
      }
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
    if (res && res.ok) {
      if (append) {
        notifications = [...notifications, ...(res.notifications || [])];
      } else {
        notifications = res.notifications || [];
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
