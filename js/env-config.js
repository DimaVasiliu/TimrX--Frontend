/**
 * TimrX frontend runtime environment resolver.
 *
 * Modes:
 * - production: fixed live domains, ignores localStorage overrides
 * - staging: same-origin blog API, overridable chat/3D endpoints
 * - local: localhost service defaults with optional overrides
 *
 * Supported overrides:
 * - query: ?timrx_env=local|staging|production
 * - localStorage:
 *   - TIMRX_ENV
 *   - TIMRX_BLOGS_API_BASE (legacy BLOGS_API_BASE also supported)
 *   - TIMRX_CHAT_API_BASE
 *   - TIMRX_3D_API_BASE
 */
(function () {
  const PROD_SITE_ORIGIN = 'https://timrx.live';
  const PROD_CHAT_API = 'https://chat.timrx.live';
  const PROD_3D_API = 'https://3d.timrx.live';
  const LOCAL_BLOG_API = 'http://localhost:5050';
  const LOCAL_CHAT_API = 'http://localhost:8000';
  const LOCAL_3D_API = 'http://localhost:5001';
  const VALID_MODES = new Set(['production', 'staging', 'local']);

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  function normalizeUrl(value, fallback) {
    const raw = (value || '').trim();
    if (!raw) return fallback;
    return raw.replace(/\/+$/, '');
  }

  const host = (window.location.hostname || '').toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  const inferredMode = isLocalHost
    ? 'local'
    : /(staging|preview|dev|test)/.test(host)
      ? 'staging'
      : 'production';

  const requestedMode = (params.get('timrx_env') || readStorage('TIMRX_ENV') || inferredMode).trim().toLowerCase();
  const mode = VALID_MODES.has(requestedMode) ? requestedMode : inferredMode;
  const allowOverrides = mode !== 'production';

  const defaults = {
    production: {
      siteOrigin: PROD_SITE_ORIGIN,
      blogApiBase: PROD_SITE_ORIGIN,
      chatApiBase: PROD_CHAT_API,
      threedApiBase: PROD_3D_API,
    },
    staging: {
      siteOrigin: normalizeUrl(window.location.origin, PROD_SITE_ORIGIN),
      blogApiBase: normalizeUrl(window.location.origin, PROD_SITE_ORIGIN),
      chatApiBase: PROD_CHAT_API,
      threedApiBase: PROD_3D_API,
    },
    local: {
      siteOrigin: normalizeUrl(window.location.origin, PROD_SITE_ORIGIN),
      blogApiBase: LOCAL_BLOG_API,
      chatApiBase: LOCAL_CHAT_API,
      threedApiBase: LOCAL_3D_API,
    },
  };

  const base = defaults[mode];
  const blogOverride = params.get('timrx_blogs_api_base') || readStorage('TIMRX_BLOGS_API_BASE') || readStorage('BLOGS_API_BASE');
  const chatOverride = params.get('timrx_chat_api_base') || readStorage('TIMRX_CHAT_API_BASE');
  const threedOverride = params.get('timrx_3d_api_base') || readStorage('TIMRX_3D_API_BASE');

  const config = Object.freeze({
    mode,
    isLocalHost,
    allowLocalOverrides: allowOverrides,
    siteOrigin: normalizeUrl(base.siteOrigin, PROD_SITE_ORIGIN),
    blogApiBase: normalizeUrl(allowOverrides ? blogOverride : '', base.blogApiBase),
    chatApiBase: normalizeUrl(allowOverrides ? chatOverride : '', base.chatApiBase),
    threedApiBase: normalizeUrl(allowOverrides ? threedOverride : '', base.threedApiBase),
  });

  window.TIMRX_ENV = config;
  window.TIMRX_SITE_ORIGIN = config.siteOrigin;
  window.TIMRX_BLOGS_API_BASE = config.blogApiBase;
  window.TIMRX_API_BASE = config.chatApiBase;
  window.TIMRX_3D_API_BASE = config.threedApiBase;

  // Anti-tamper / self-XSS warning for anyone opening the developer console.
  try {
    var stop = 'color:#e24b4a;font-size:42px;font-weight:800;line-height:1.2';
    var head = 'color:#f4f1ea;font-size:15px;font-weight:700;line-height:1.6';
    var body = 'color:#a39b8f;font-size:13px;line-height:1.6';
    console.log('%c⛔  STOP', stop);
    console.log('%cThis console is intended for developers only.', head);
    console.log(
      '%cDo NOT paste or run any code here. Tampering with TimrX, your account, or other users — or running code that someone sent you — is unauthorized, may be unlawful, and is a well-known scam ("self-XSS"). If someone told you to paste something into this window, close this tab.',
      body
    );
  } catch (e) {}
})();
