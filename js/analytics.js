/**
 * analytics.js — single entry point for everything that touches `dataLayer`.
 *
 * The GTM container is loaded by an inline snippet in every page's <head>; this
 * module wraps `dataLayer.push` so we get:
 *   - Idempotent firing: localStorage allow-list of already-pushed event_ids.
 *   - Anonymous-first safe: API calls degrade gracefully when there's no session.
 *   - Cross-subdomain dedup: server-issued event_ids match across timrx.live and
 *     3d.timrx.live so a purchase fires exactly once even if the user lands on
 *     a different subdomain after Mollie redirect.
 *   - SPA-replay safe: history navigation never re-fires a server-issued event
 *     because the server acks remove it from the queue.
 *
 * Public API (all functions never throw):
 *   trackEvent(name, params, options?)
 *   trackCheckoutStarted({ plan_code, value, currency })
 *   trackSignupCompleted({ method })            // for client-only edge cases
 *   trackGenerationStarted({ action, value, item_category })
 *   trackGenerationCompleted({ action, value, item_category })
 *   firePendingFromServer()                     // poll + push + ack
 *   primeOnBootstrap()                          // wire into wallet-confirm
 *
 * Server-issued events (purchase, sign_up, email_verified) are pushed
 * automatically by firePendingFromServer — callers don't need to touch them.
 */

import { BACKEND, apiFetch, log } from './config.js';
import { ANALYTICS_DEFAULT_OPT_IN } from './analytics-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// dataLayer plumbing
// ─────────────────────────────────────────────────────────────────────────────

// GTM expects window.dataLayer to be a plain array. The inline GTM snippet in
// every page <head> already creates it, but we guard here too so this module
// can be imported on pages that haven't loaded the snippet yet (no-op safe).
window.dataLayer = window.dataLayer || [];

// Runtime opt-in toggle. Cookie-consent code can flip
// `window.__TIMRX_ANALYTICS_OPT_IN__ = false` to gate every push.
function _isOptedIn() {
  if (typeof window.__TIMRX_ANALYTICS_OPT_IN__ === 'boolean') {
    return window.__TIMRX_ANALYTICS_OPT_IN__;
  }
  return ANALYTICS_DEFAULT_OPT_IN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup ledger (localStorage)
// ─────────────────────────────────────────────────────────────────────────────

const _DEDUP_KEY = 'timrx_fired_events_v1';
const _DEDUP_MAX = 500;   // keep last 500 ids; rolls over FIFO

function _readDedupSet() {
  try {
    const raw = localStorage.getItem(_DEDUP_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) { return new Set(); }
}

function _writeDedupSet(set) {
  try {
    const arr = Array.from(set);
    // FIFO trim
    while (arr.length > _DEDUP_MAX) arr.shift();
    localStorage.setItem(_DEDUP_KEY, JSON.stringify(arr));
  } catch (_) { /* Safari private mode / quota — best effort */ }
}

function _hasBeenFired(eventId) {
  if (!eventId) return false;
  return _readDedupSet().has(eventId);
}

function _markFired(eventId) {
  if (!eventId) return;
  const set = _readDedupSet();
  set.add(eventId);
  _writeDedupSet(set);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: low-level push
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push a single event to the dataLayer.
 *
 * @param {string} name    The event name GTM will trigger on (e.g. 'purchase').
 * @param {object} params  Event payload — fields available as GTM variables.
 * @param {object} [opts]  Optional:
 *                           eventId: stable idempotency key; if it's been pushed before, this call is a no-op.
 *                           ecommerce: pass-through to GA4 ecommerce slot (auto-clears the slot first to avoid bleed).
 * @returns {boolean} true if the push happened, false if deduped/opted-out.
 */
export function trackEvent(name, params = {}, opts = {}) {
  if (!name) return false;
  if (!_isOptedIn()) {
    log('[analytics] opt-out active, skipping', name);
    return false;
  }

  const eventId = opts.eventId || params.event_id || null;
  if (eventId && _hasBeenFired(eventId)) {
    log('[analytics] dedup skip', name, eventId);
    return false;
  }

  // GA4 ecommerce best practice: clear the ecommerce object before pushing a new one.
  if (opts.ecommerce || params.ecommerce) {
    try { window.dataLayer.push({ ecommerce: null }); } catch (_) {}
  }

  const payload = Object.assign(
    { event: name },
    params,
    eventId ? { event_id: eventId } : {}
  );

  try {
    window.dataLayer.push(payload);
    log('[analytics] push', name, payload);
  } catch (e) {
    log('[analytics] push failed (non-fatal):', e?.message || e);
    return false;
  }

  if (eventId) _markFired(eventId);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: typed helpers (kept tiny — they all funnel through trackEvent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fire when the user clicks "Pay now" or otherwise initiates Mollie checkout.
 * Client-only — does not need server dedup. value is informational pre-payment.
 */
export function trackCheckoutStarted({ plan_code, value, currency = 'GBP', credit_type } = {}) {
  return trackEvent('begin_checkout', {
    plan_code,
    credit_type,
    value: typeof value === 'number' ? value : undefined,
    currency,
  });
}

/**
 * Server enqueues a `sign_up` event when an identity verifies email for the
 * first time; this client-side helper is exposed for any future flow that
 * needs to fire `sign_up` outside the magic-link path (e.g. OAuth).
 */
export function trackSignupCompleted({ method = 'unknown' } = {}, eventId = null) {
  return trackEvent('sign_up', { method }, { eventId });
}

export function trackGenerationStarted({ action, value, item_category } = {}) {
  return trackEvent('generation_started', {
    action_code: action,
    value: typeof value === 'number' ? value : undefined,
    item_category,
  });
}

export function trackGenerationCompleted({ action, value, item_category } = {}) {
  return trackEvent('generation_completed', {
    action_code: action,
    value: typeof value === 'number' ? value : undefined,
    item_category,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-issued pending queue: poll + push + ack
// ─────────────────────────────────────────────────────────────────────────────

let _pendingInFlight = null;       // single-flight guard
let _pendingLastFetchTs = 0;
const _PENDING_MIN_INTERVAL_MS = 5000;  // throttle for back-to-back focus events

/**
 * Poll /api/analytics/pending, push each event to dataLayer, then ack so the
 * server stops returning them. Safe to call repeatedly — single-flight + server
 * ack make this idempotent.
 *
 * @returns {Promise<number>} count of events pushed in this call
 */
export async function firePendingFromServer() {
  if (!_isOptedIn()) return 0;
  if (_pendingInFlight) return _pendingInFlight;

  const now = Date.now();
  if (now - _pendingLastFetchTs < _PENDING_MIN_INTERVAL_MS) return 0;
  _pendingLastFetchTs = now;

  _pendingInFlight = (async () => {
    try {
      const res = await apiFetch('/api/analytics/pending', { cache: 'no-store' });
      if (!res.ok || !res.data?.ok) return 0;

      const events = Array.isArray(res.data.events) ? res.data.events : [];
      if (events.length === 0) return 0;

      const ackIds = [];
      for (const evt of events) {
        const name = evt.event_name;
        const eventId = evt.event_id;
        if (!name || !eventId) continue;
        // The server-side event_id already deduped against re-enqueue; the
        // localStorage dedup catches the case where the same browser already
        // pushed it but the ack POST never reached the server.
        const pushed = trackEvent(name, _shapeServerEvent(name, evt.payload || {}), { eventId });
        // Even if dedup skipped, still ack so the queue empties.
        ackIds.push(eventId);
      }

      if (ackIds.length > 0) {
        try {
          await apiFetch('/api/analytics/ack', {
            method: 'POST',
            body: { event_ids: ackIds },
          });
        } catch (e) {
          log('[analytics] ack failed (non-fatal):', e?.message || e);
        }
      }
      return ackIds.length;
    } catch (e) {
      log('[analytics] firePending failed (non-fatal):', e?.message || e);
      return 0;
    } finally {
      _pendingInFlight = null;
    }
  })();

  return _pendingInFlight;
}

/**
 * Shape a server-issued payload for GA4 ecommerce conventions where applicable.
 * Keeps GTM tag configs simple (they can read `transaction_id`, `value`, etc.
 * directly without unwrapping nested objects).
 */
function _shapeServerEvent(name, payload) {
  if (name === 'purchase') {
    // GA4 standard "purchase" event uses `ecommerce` block + flat fields.
    return {
      transaction_id: payload.transaction_id,
      value:          payload.value,
      currency:       payload.currency || 'GBP',
      // Flat extras (also exposed inside ecommerce)
      plan_code:   payload.plan_code,
      credits:     payload.credits,
      credit_type: payload.credit_type,
      ecommerce: {
        transaction_id: payload.transaction_id,
        value:          payload.value,
        currency:       payload.currency || 'GBP',
        items:          Array.isArray(payload.items) ? payload.items : [],
      },
    };
  }
  // sign_up / email_verified / generation_* — pass through as flat fields.
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap glue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wire firePending to the wallet-confirm signal emitted by workspace-credits.js
 * (or whichever module calls `WorkspaceCredits.applyBackendBalance`). Also
 * re-polls on tab visibility so a user who returns from Mollie redirect after
 * the webhook lands fires the conversion as soon as they're back.
 */
export function primeOnBootstrap() {
  // First chance: as soon as identity is server-confirmed.
  const tryFire = () => firePendingFromServer().catch(() => {});

  // Workspace-credits emits this when /api/me succeeds.
  window.addEventListener('timrx:identity:confirmed', tryFire);
  // Fallback: if wallet API confirmed first, fire then too.
  window.addEventListener('timrx:wallet:confirmed', tryFire);

  // Re-fire when tab regains focus (catches "webhook landed while user was away").
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tryFire();
  });

  // First-paint poll — covers users who already have a confirmed session on load.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(tryFire, 800);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(tryFire, 800));
  }
}

// Auto-prime so individual pages can just `import './analytics.js'` and be done.
primeOnBootstrap();

// Expose on window for inline-script callers (Mollie redirect button etc.).
window.TimrXAnalytics = Object.assign(window.TimrXAnalytics || {}, {
  trackEvent,
  trackCheckoutStarted,
  trackSignupCompleted,
  trackGenerationStarted,
  trackGenerationCompleted,
  firePendingFromServer,
});
