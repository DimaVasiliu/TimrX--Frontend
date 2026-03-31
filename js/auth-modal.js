/**
 * auth-modal.js — Unified Sign In modal for TimrX.
 *
 * Replaces: Guest Chooser + Secure Credits Card + Restore Account modals.
 * Single flow: email → verify code → welcome / welcome back.
 *
 * Usage:
 *   import { openAuthModal, closeAuthModal, isAuthenticated } from './auth-modal.js';
 *   openAuthModal({ onSuccess: (result) => { ... } });
 *
 * Events dispatched on window:
 *   'timrx:auth:verified'  — after email verification  (detail: { email, identityId, creditsGranted })
 *   'timrx:auth:switched'  — after session/identity switch (detail: { email, identityId })
 */

// ── State ───────────────────────────────────────────────────────────────────
let _currentStep = 'email'; // 'email' | 'code' | 'welcome' | 'welcome-back' | 'account'
let _pendingEmail = '';
let _resendTimer = null;
let _resendCooldown = 0;
let _options = {};          // { onSuccess, onClose, redirectAfter }
let _injected = false;
let _identityCache = null;  // last /api/me response

const RESEND_COOLDOWN_SECONDS = 60;

// ── API helper ──────────────────────────────────────────────────────────────
function api(url, opts = {}) {
  if (window.TimrXApi?.apiFetch) return window.TimrXApi.apiFetch(url, opts);
  // Fallback: direct fetch (shouldn't happen in practice)
  const base = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  return fetch(`${base}${url}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json().then(data => ({ ok: r.ok, status: r.status, data })));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Open the auth modal.
 * @param {Object} options
 * @param {Function} [options.onSuccess] — called after successful verify/switch
 * @param {Function} [options.onClose]   — called if user closes without completing
 * @param {string}   [options.redirectAfter] — URL to navigate to after success
 */
export function openAuthModal(options = {}) {
  _options = options;
  _ensureInjected();

  const modal = document.getElementById('authModal');
  const backdrop = document.getElementById('authModalBackdrop');
  if (!modal) return;

  // Decide which step to show
  _fetchIdentity().then(identity => {
    _identityCache = identity;
    if (identity?.email_verified && identity?.email) {
      _showStep('account');
    } else {
      _showStep('email');
    }
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.add('open');
    // Focus first input
    setTimeout(() => {
      const input = modal.querySelector('.auth-step:not([style*="display: none"]) input');
      input?.focus();
    }, 100);
  });
}

export function closeAuthModal() {
  const modal = document.getElementById('authModal');
  const backdrop = document.getElementById('authModalBackdrop');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (backdrop) backdrop.classList.remove('open');
  _clearResendTimer();
  if (_options.onClose && _currentStep !== 'welcome' && _currentStep !== 'welcome-back') {
    _options.onClose();
  }
}

/**
 * Returns true if the current identity has a verified email.
 */
export function isAuthenticated() {
  if (_identityCache?.email_verified) return true;
  // Fallback: check localStorage stamp
  try {
    const stamp = localStorage.getItem('timrx_auth_stamp');
    if (stamp) {
      const parsed = JSON.parse(stamp);
      return !!parsed.emailVerified;
    }
  } catch { /* ignore */ }
  return false;
}

// ── DOM injection ───────────────────────────────────────────────────────────

function _ensureInjected() {
  if (_injected) return;
  _injected = true;

  const html = `
    <div id="authModalBackdrop" class="auth-modal-backdrop"></div>
    <div id="authModal" class="modal auth-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Sign In">
      <div class="card auth-card">
        <button type="button" class="auth-modal-close" id="authModalClose" aria-label="Close">&times;</button>

        <!-- Step 1: Email -->
        <div id="authStep1" class="auth-step">
          <h2 class="auth-heading">Sign in to TimrX</h2>
          <p class="auth-subtitle">Enter your email to sign in or create an account.</p>
          <div class="auth-field">
            <input type="email" id="authEmailInput" class="auth-input" placeholder="you@example.com"
                   autocomplete="email" required />
          </div>
          <div id="authEmailError" class="auth-error" role="alert"></div>
          <button type="button" id="authContinueBtn" class="btn auth-btn-primary">Continue</button>
        </div>

        <!-- Step 2: Verify Code -->
        <div id="authStep2" class="auth-step" style="display:none">
          <h2 class="auth-heading">Enter verification code</h2>
          <p class="auth-subtitle">We sent a 6-digit code to <strong id="authSentToEmail"></strong></p>
          <div class="auth-field">
            <input type="text" id="authCodeInput" class="auth-input auth-code-input"
                   maxlength="6" inputmode="numeric" pattern="[0-9]*"
                   autocomplete="one-time-code" placeholder="123456" />
          </div>
          <div id="authCodeError" class="auth-error" role="alert"></div>
          <div id="authCodeMessage" class="auth-message"></div>
          <button type="button" id="authVerifyBtn" class="btn auth-btn-primary">Verify</button>
          <div class="auth-links">
            <button type="button" id="authResendBtn" class="btn ghost small" disabled>Resend code (<span id="authResendCountdown">60</span>s)</button>
            <button type="button" id="authChangeEmailBtn" class="btn ghost small">Change email</button>
          </div>
        </div>

        <!-- Step 3A: Welcome (new user) -->
        <div id="authStep3a" class="auth-step" style="display:none">
          <div class="auth-icon-check">&#10003;</div>
          <h2 class="auth-heading">Welcome to TimrX!</h2>
          <p class="auth-subtitle">50 free credits have been added to your account.</p>
          <div class="auth-actions">
            <button type="button" id="authGoWorkspace" class="btn auth-btn-primary">Start Creating</button>
            <button type="button" id="authBrowsePlans" class="btn ghost">Browse Plans</button>
          </div>
        </div>

        <!-- Step 3B: Welcome Back (session switched) -->
        <div id="authStep3b" class="auth-step" style="display:none">
          <div class="auth-icon-check">&#10003;</div>
          <h2 class="auth-heading">Welcome back!</h2>
          <p class="auth-subtitle" id="authWbEmail"></p>
          <p class="auth-balance" id="authWbBalance"></p>
          <div class="auth-actions">
            <button type="button" id="authWbGoWorkspace" class="btn auth-btn-primary">Go to Workspace</button>
            <button type="button" id="authWbBrowsePlans" class="btn ghost">Browse Plans</button>
          </div>
        </div>

        <!-- Step 3C: Already Verified (account view) -->
        <div id="authStep3c" class="auth-step" style="display:none">
          <div class="auth-icon-check">&#10003;</div>
          <h2 class="auth-heading">Your Account</h2>
          <p class="auth-subtitle">Signed in as <strong id="authAccountEmail"></strong></p>
          <p class="auth-balance" id="authAccountBalance"></p>
          <div class="auth-actions">
            <button type="button" id="authSwitchAccount" class="btn ghost small">Switch to a different account</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  // ── Inline styles ──
  const style = document.createElement('style');
  style.textContent = `
    .auth-modal-backdrop {
      display: none;
      position: fixed; inset: 0;
      background: rgba(0,0,0,.55);
      z-index: 9998;
    }
    .auth-modal-backdrop.open { display: block; }
    .auth-modal.open { display: grid; z-index: 9999; }
    .auth-card {
      position: relative;
      max-width: 420px; width: 90vw;
      padding: 2rem 2rem 1.5rem;
      border-radius: 16px;
    }
    .auth-modal-close {
      position: absolute; top: 12px; right: 16px;
      background: none; border: none;
      font-size: 1.5rem; cursor: pointer;
      color: var(--text-secondary, #888);
      line-height: 1;
    }
    .auth-modal-close:hover { color: var(--text-primary, #fff); }
    .auth-heading { margin: 0 0 .25rem; font-size: 1.35rem; }
    .auth-subtitle { margin: 0 0 1.25rem; opacity: .7; font-size: .95rem; line-height: 1.4; }
    .auth-field { margin-bottom: .5rem; }
    .auth-input {
      width: 100%; padding: .65rem .85rem;
      border: 1px solid var(--border, #333);
      border-radius: 8px;
      background: var(--surface, #1a1a1a);
      color: var(--text-primary, #fff);
      font-size: 1rem;
      outline: none;
      box-sizing: border-box;
    }
    .auth-input:focus { border-color: var(--accent, #C97A2B); }
    .auth-code-input {
      text-align: center; letter-spacing: .5em;
      font-size: 1.5rem; font-family: monospace;
    }
    .auth-error {
      color: #e74c3c; font-size: .85rem;
      min-height: 1.2em; margin-bottom: .5rem;
    }
    .auth-message {
      color: var(--accent, #C97A2B); font-size: .85rem;
      min-height: 1.2em; margin-bottom: .5rem;
    }
    .auth-btn-primary {
      width: 100%; padding: .7rem;
      border: none; border-radius: 8px;
      background: var(--accent, #C97A2B);
      color: #fff; font-size: 1rem; font-weight: 600;
      cursor: pointer; margin-top: .25rem;
    }
    .auth-btn-primary:hover { filter: brightness(1.1); }
    .auth-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .auth-links {
      display: flex; justify-content: space-between;
      margin-top: .75rem; gap: .5rem;
    }
    .auth-links .btn { font-size: .82rem; }
    .auth-actions {
      display: flex; flex-direction: column; gap: .5rem;
      margin-top: 1rem;
    }
    .auth-icon-check {
      width: 48px; height: 48px;
      border-radius: 50%;
      background: var(--accent, #C97A2B);
      color: #fff; font-size: 1.5rem;
      display: flex; align-items: center; justify-content: center;
      margin: 0 0 .75rem;
    }
    .auth-balance {
      font-size: 1.1rem; font-weight: 600;
      margin: .25rem 0 0;
    }
  `;
  document.head.appendChild(style);

  // ── Wire up events ──
  _el('authModalClose').addEventListener('click', closeAuthModal);
  _el('authModalBackdrop').addEventListener('click', closeAuthModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _el('authModal')?.classList.contains('open')) closeAuthModal();
  });

  _el('authContinueBtn').addEventListener('click', _handleContinue);
  _el('authEmailInput').addEventListener('keydown', e => { if (e.key === 'Enter') _handleContinue(); });

  _el('authVerifyBtn').addEventListener('click', _handleVerify);
  _el('authCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') _handleVerify(); });

  _el('authResendBtn').addEventListener('click', _handleResend);
  _el('authChangeEmailBtn').addEventListener('click', () => _showStep('email'));

  _el('authGoWorkspace').addEventListener('click', () => { closeAuthModal(); window.location.href = '/3dprint'; });
  _el('authBrowsePlans').addEventListener('click', () => { closeAuthModal(); _scrollToPricing(); });

  _el('authWbGoWorkspace').addEventListener('click', () => { closeAuthModal(); window.location.href = '/3dprint?refresh=1'; });
  _el('authWbBrowsePlans').addEventListener('click', () => { closeAuthModal(); _scrollToPricing(); });

  _el('authSwitchAccount').addEventListener('click', () => _showStep('email'));
}

// ── Step management ─────────────────────────────────────────────────────────

function _showStep(step) {
  _currentStep = step;
  const steps = { email: 'authStep1', code: 'authStep2', welcome: 'authStep3a', 'welcome-back': 'authStep3b', account: 'authStep3c' };

  Object.values(steps).forEach(id => {
    const el = _el(id);
    if (el) el.style.display = 'none';
  });

  const target = _el(steps[step]);
  if (target) target.style.display = '';

  // Clear errors
  _setText('authEmailError', '');
  _setText('authCodeError', '');
  _setText('authCodeMessage', '');

  if (step === 'email') {
    const input = _el('authEmailInput');
    if (input) { input.value = _pendingEmail || ''; setTimeout(() => input.focus(), 50); }
  }
  if (step === 'code') {
    const input = _el('authCodeInput');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
    _setText('authSentToEmail', _pendingEmail);
    _startResendCooldown();
  }
  if (step === 'account') {
    _setText('authAccountEmail', _identityCache?.email || '');
    _fetchWalletAndShow('authAccountBalance');
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function _handleContinue() {
  const input = _el('authEmailInput');
  const email = (input?.value || '').trim();
  if (!email || !email.includes('@')) {
    _setText('authEmailError', 'Please enter a valid email address.');
    return;
  }

  _setText('authEmailError', '');
  _setLoading('authContinueBtn', true);

  try {
    const res = await api('/api/auth/email/attach', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });

    if (res.data?.ok || res.ok) {
      _pendingEmail = email;
      _showStep('code');
    } else {
      _setText('authEmailError', res.data?.error?.message || res.data?.message || 'Failed to send code. Please try again.');
    }
  } catch (err) {
    _setText('authEmailError', 'Network error. Please try again.');
  } finally {
    _setLoading('authContinueBtn', false);
  }
}

async function _handleVerify() {
  const input = _el('authCodeInput');
  const code = (input?.value || '').trim();
  if (!code || code.length !== 6) {
    _setText('authCodeError', 'Please enter the 6-digit code.');
    return;
  }

  _setText('authCodeError', '');
  _setLoading('authVerifyBtn', true);

  try {
    const res = await api('/api/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email: _pendingEmail, code }),
    });

    const data = res.data || {};

    if (data.ok || data.verified) {
      _clearResendTimer();

      // Clear auth caches so fresh identity is loaded
      window.TimrXApi?.clearConfirmedIdentity?.();

      // Determine if this was a session switch (identity changed)
      const switched = data.identity_changed || data.switched || false;
      const identityId = data.identity_id || '';

      if (switched) {
        // Session switched to different identity — full refresh needed
        window.TimrXApi?.clearAllUserCaches?.();
        const walletData = await _fetchWallet();
        _setText('authWbEmail', _pendingEmail);
        const balance = walletData?.balance ?? walletData?.available ?? 0;
        _setText('authWbBalance', `Balance: ${balance} credits`);
        _showStep('welcome-back');

        window.dispatchEvent(new CustomEvent('timrx:auth:switched', {
          detail: { email: _pendingEmail, identityId },
        }));
      } else {
        // Normal verification — same identity
        const walletData = await _fetchWallet();
        const creditsGranted = data.welcome_bonus_credits || 50;
        _showStep('welcome');

        window.dispatchEvent(new CustomEvent('timrx:auth:verified', {
          detail: { email: _pendingEmail, identityId, creditsGranted },
        }));
      }

      // Update identity cache
      _identityCache = await _fetchIdentity();

      // Callback
      if (_options.onSuccess) {
        _options.onSuccess({ email: _pendingEmail, identityId, switched });
      }
    } else {
      const msg = data.error?.message || data.message || 'Invalid code. Please try again.';
      _setText('authCodeError', msg);
      input?.focus();
      input?.select();
    }
  } catch (err) {
    _setText('authCodeError', 'Network error. Please try again.');
  } finally {
    _setLoading('authVerifyBtn', false);
  }
}

async function _handleResend() {
  if (_resendCooldown > 0) return;
  _setText('authCodeMessage', '');
  _setText('authCodeError', '');

  try {
    const res = await api('/api/auth/email/attach', {
      method: 'POST',
      body: JSON.stringify({ email: _pendingEmail }),
    });
    if (res.data?.ok || res.ok) {
      _setText('authCodeMessage', 'Code resent!');
      _startResendCooldown();
    } else {
      _setText('authCodeError', 'Failed to resend. Please try again.');
    }
  } catch {
    _setText('authCodeError', 'Network error.');
  }
}

// ── Resend cooldown ─────────────────────────────────────────────────────────

function _startResendCooldown() {
  _resendCooldown = RESEND_COOLDOWN_SECONDS;
  const btn = _el('authResendBtn');
  const span = _el('authResendCountdown');
  if (btn) btn.disabled = true;

  _clearResendTimer();
  _resendTimer = setInterval(() => {
    _resendCooldown--;
    if (span) span.textContent = _resendCooldown;
    if (_resendCooldown <= 0) {
      _clearResendTimer();
      if (btn) { btn.disabled = false; btn.textContent = 'Resend code'; }
    }
  }, 1000);
}

function _clearResendTimer() {
  if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function _fetchIdentity() {
  try {
    const res = await api('/api/me');
    return res.data || null;
  } catch { return null; }
}

async function _fetchWallet() {
  try {
    const res = await api('/api/credits/wallet');
    return res.data || null;
  } catch { return null; }
}

async function _fetchWalletAndShow(elementId) {
  const wallet = await _fetchWallet();
  const balance = wallet?.balance ?? wallet?.available ?? 0;
  const video = wallet?.video_balance ?? 0;
  let text = `Balance: ${balance} credits`;
  if (video > 0) text += ` + ${video} video credits`;
  _setText(elementId, text);
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function _el(id) { return document.getElementById(id); }

function _setText(id, text) {
  const el = _el(id);
  if (el) el.textContent = text;
}

function _setLoading(btnId, loading) {
  const btn = _el(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Please wait...';
  } else {
    btn.textContent = btn.dataset.originalText || btn.textContent;
  }
}

function _scrollToPricing() {
  const pricing = document.getElementById('pricing');
  if (pricing) {
    pricing.scrollIntoView({ behavior: 'smooth' });
  } else {
    window.location.href = '/hub#pricing';
  }
}
