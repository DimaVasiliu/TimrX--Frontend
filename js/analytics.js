import { apiFetch, log } from './config.js';
import { ANALYTICS_DEFAULT_OPT_IN } from './analytics-config.js';

window.dataLayer = window.dataLayer || [];

const DEDUP_KEY = 'timrx_fired_events_v1';
const DEDUP_MAX = 500;
const PENDING_MIN_INTERVAL_MS = 5000;

let pendingInFlight = null;
let pendingLastFetchTs = 0;

function isOptedIn() {
  return typeof window.__TIMRX_ANALYTICS_OPT_IN__ === 'boolean'
    ? window.__TIMRX_ANALYTICS_OPT_IN__
    : ANALYTICS_DEFAULT_OPT_IN;
}

function readDedupSet() {
  try {
    const raw = localStorage.getItem(DEDUP_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch (_) {
    return new Set();
  }
}

function writeDedupSet(set) {
  try {
    const values = Array.from(set);
    while (values.length > DEDUP_MAX) values.shift();
    localStorage.setItem(DEDUP_KEY, JSON.stringify(values));
  } catch (_) {
    /* Storage can be blocked; server and GA4 transaction IDs still dedupe. */
  }
}

function hasBeenFired(eventId) {
  return Boolean(eventId) && readDedupSet().has(eventId);
}

function markFired(eventId) {
  if (!eventId) return;
  const set = readDedupSet();
  set.add(eventId);
  writeDedupSet(set);
}

function eventId(prefix, rawId) {
  const id = String(rawId || '').trim();
  return id ? `${prefix}:${id}` : null;
}

export function trackEvent(name, payload = {}, options = {}) {
  if (!name) return false;
  if (!isOptedIn()) {
    log('[analytics] opt-out active, skipping', name);
    return false;
  }

  const id = options.eventId || payload.event_id || null;
  if (id && hasBeenFired(id)) {
    log('[analytics] dedup skip', name, id);
    return false;
  }

  if (options.ecommerce || payload.ecommerce) {
    try {
      window.dataLayer.push({ ecommerce: null });
    } catch (_) {
      /* Non-fatal. */
    }
  }

  const data = Object.assign({ event: name }, payload, id ? { event_id: id } : {});
  try {
    window.dataLayer.push(data);
    log('[analytics] push', name, data);
  } catch (err) {
    log('[analytics] push failed (non-fatal):', err?.message || err);
    return false;
  }

  if (id) markFired(id);
  return true;
}

export function trackCheckoutStarted({
  plan_code,
  value,
  currency = 'USD',
  credit_type,
  event_id,
} = {}) {
  return trackEvent('begin_checkout', {
    plan_code,
    credit_type,
    value: Number.isFinite(Number(value)) ? Number(value) : undefined,
    currency,
  }, { eventId: event_id || null });
}

export function trackSignupCompleted({
  method = 'unknown',
  credits_granted,
} = {}, id = null) {
  return trackEvent('sign_up', {
    method,
    credits_granted: Number.isFinite(Number(credits_granted)) ? Number(credits_granted) : undefined,
  }, { eventId: id });
}

export function trackGenerationStarted({
  action,
  value,
  item_category,
  event_id,
} = {}) {
  return trackEvent('generation_started', {
    action_code: action,
    value: Number.isFinite(Number(value)) ? Number(value) : undefined,
    item_category,
  }, { eventId: event_id || null });
}

export function trackGenerationCompleted({
  action,
  value,
  item_category,
  event_id,
} = {}) {
  return trackEvent('generation_completed', {
    action_code: action,
    value: Number.isFinite(Number(value)) ? Number(value) : undefined,
    item_category,
  }, { eventId: event_id || null });
}

export async function firePendingFromServer({ force = false } = {}) {
  if (!isOptedIn()) return 0;
  if (pendingInFlight) return pendingInFlight;

  const now = Date.now();
  if (!force && now - pendingLastFetchTs < PENDING_MIN_INTERVAL_MS) return 0;
  pendingLastFetchTs = now;

  pendingInFlight = (async () => {
    try {
      const result = await apiFetch('/api/analytics/pending', { cache: 'no-store' });
      if (!result.ok || !result.data?.ok) return 0;

      const events = Array.isArray(result.data.events) ? result.data.events : [];
      if (events.length === 0) return 0;

      const ackIds = [];
      for (const queued of events) {
        const name = queued.event_name;
        const id = queued.event_id;
        if (!name || !id) continue;
        trackEvent(name, shapeServerEvent(name, queued.payload || {}), { eventId: id });
        ackIds.push(id);
      }

      if (ackIds.length > 0) {
        try {
          await apiFetch('/api/analytics/ack', {
            method: 'POST',
            body: { event_ids: ackIds },
          });
        } catch (err) {
          log('[analytics] ack failed (non-fatal):', err?.message || err);
        }
      }

      return ackIds.length;
    } catch (err) {
      log('[analytics] firePending failed (non-fatal):', err?.message || err);
      return 0;
    } finally {
      pendingInFlight = null;
    }
  })();

  return pendingInFlight;
}

function shapeServerEvent(name, payload) {
  if (name !== 'purchase') return payload;

  return {
    transaction_id: payload.transaction_id,
    value: payload.value,
    currency: payload.currency || 'USD',
    plan_code: payload.plan_code,
    credits: payload.credits,
    credit_type: payload.credit_type,
    ecommerce: {
      transaction_id: payload.transaction_id,
      value: payload.value,
      currency: payload.currency || 'USD',
      items: Array.isArray(payload.items) ? payload.items : [],
    },
  };
}

function generationCategory(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('video')) return 'video';
  if (normalized.includes('image')) return 'image';
  if (normalized.includes('texture')) return 'texture';
  if (normalized.includes('rig')) return 'rig';
  if (normalized.includes('remesh') || normalized.includes('evolve')) return 'model';
  return 'model';
}

function actionCost(type) {
  try {
    if (!window.WorkspaceCredits?.getActionCost) return undefined;
    const cost = Number(window.WorkspaceCredits.getActionCost(type));
    return Number.isFinite(cost) ? cost : undefined;
  } catch (_) {
    return undefined;
  }
}

function handleAuthVerified() {
  firePendingFromServer({ force: true }).catch(() => {});
}

function handleGenerationStart(event) {
  const detail = event?.detail || {};
  const action = detail.action || detail.action_code || detail.type || 'unknown';

  trackGenerationStarted({
    action,
    value: detail.value ?? actionCost(action),
    item_category: detail.item_category || generationCategory(action),
    event_id: detail.event_id || eventId('generation_started', detail.job_id || detail.jobId),
  });
}

export function primeOnBootstrap() {
  const fire = () => firePendingFromServer().catch(() => {});

  window.addEventListener('timrx:identity:confirmed', fire);
  window.addEventListener('timrx:wallet:confirmed', fire);
  window.addEventListener('timrx:auth:verified', handleAuthVerified);
  window.addEventListener('generation:start', handleGenerationStart);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fire();
  });
  window.addEventListener('load', () => {
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 1200)))(fire, { timeout: 3500 });
  }, { once: true });
}

primeOnBootstrap();

window.TimrXAnalytics = Object.assign(window.TimrXAnalytics || {}, {
  trackEvent,
  trackCheckoutStarted,
  trackSignupCompleted,
  trackGenerationStarted,
  trackGenerationCompleted,
  firePendingFromServer,
});

if (document.readyState === 'complete') {
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 1200)))(
    () => firePendingFromServer().catch(() => {}),
    { timeout: 3500 },
  );
}
