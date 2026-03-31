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
let _currentStep = 'email';
let _pendingEmail = '';
let _resendTimer = null;
let _resendCooldown = 0;
let _options = {};
let _injected = false;
let _identityCache = null;

const RESEND_COOLDOWN_SECONDS = 60;

// ── API helper ──────────────────────────────────────────────────────────────
function api(url, opts = {}) {
  if (window.TimrXApi?.apiFetch) return window.TimrXApi.apiFetch(url, opts);
  const base = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  return fetch(`${base}${url}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json().then(data => ({ ok: r.ok, status: r.status, data })));
}

// ── Public API ──────────────────────────────────────────────────────────────

export function openAuthModal(options = {}) {
  _options = options;
  _ensureInjected();

  const backdrop = _el('authBackdrop');
  const card = _el('authCard');
  if (!backdrop || !card) return;

  _fetchIdentity().then(identity => {
    _identityCache = identity;
    if (identity?.email_verified && identity?.email) {
      _showStep('account');
    } else {
      _showStep('email');
    }
    backdrop.classList.add('visible');
    card.classList.remove('collapsed');
    card.classList.add('expanded');
    setTimeout(() => {
      const input = card.querySelector('.auth-step:not([style*="display: none"]) input');
      input?.focus();
    }, 120);
  });
}

export function closeAuthModal() {
  const backdrop = _el('authBackdrop');
  const card = _el('authCard');
  if (backdrop) backdrop.classList.remove('visible');
  if (card) { card.classList.remove('expanded'); card.classList.add('collapsed'); }
  _clearResendTimer();
  if (_options.onClose && _currentStep !== 'welcome' && _currentStep !== 'welcome-back') {
    _options.onClose();
  }
}

export function isAuthenticated() {
  if (_identityCache?.email_verified) return true;
  try {
    const stamp = localStorage.getItem('timrx_auth_stamp');
    if (stamp) { return !!JSON.parse(stamp).emailVerified; }
  } catch { /* ignore */ }
  return false;
}

// ── DOM injection ───────────────────────────────────────────────────────────

function _ensureInjected() {
  if (_injected) return;
  _injected = true;

  const html = `
    <div id="authBackdrop" class="secure-modal-backdrop"></div>
    <div id="authCard" class="secure-credits-card collapsed" role="dialog" aria-modal="true" aria-label="Sign In">

      <button type="button" class="secure-modal-close" id="authClose" aria-label="Close">
        <i class="fa-solid fa-xmark"></i>
      </button>

      <!-- Step 1: Email -->
      <div id="authStep1" class="auth-step secure-state" style="text-align:center">
        <div class="secure-icon"><i class="fa-solid fa-envelope"></i></div>
        <h3>Sign in to TimrX</h3>
        <p class="secure-subtitle">Enter your email to sign in or create an account</p>
        <div class="secure-form">
          <div class="secure-input-group" style="max-width:100%">
            <input type="email" id="authEmailInput" placeholder="you@example.com"
                   autocomplete="email" required />
          </div>
          <p id="authEmailError" class="secure-error"></p>
          <button type="button" id="authContinueBtn" class="btn auth-action-btn" style="margin-top:4px">Continue</button>
        </div>
      </div>

      <!-- Step 2: Verify Code -->
      <div id="authStep2" class="auth-step secure-state" style="display:none;text-align:center">
        <div class="secure-icon"><i class="fa-solid fa-key"></i></div>
        <h3>Enter verification code</h3>
        <p class="secure-subtitle">We sent a 6-digit code to <strong id="authSentToEmail"></strong></p>
        <div class="secure-form">
          <div class="secure-input-group code-input-group" style="max-width:100%;justify-content:center">
            <input type="text" id="authCodeInput"
                   maxlength="6" inputmode="numeric" pattern="[0-9]*"
                   autocomplete="one-time-code" placeholder="000000" />
          </div>
          <p id="authCodeError" class="secure-error"></p>
          <p id="authCodeMessage" class="secure-message"></p>
          <button type="button" id="authVerifyBtn" class="btn auth-action-btn">Verify</button>
          <div class="secure-actions" style="margin-top:10px">
            <button type="button" id="authResendBtn" class="btn ghost small" disabled>Resend (<span id="authResendCountdown">60</span>s)</button>
            <button type="button" id="authChangeEmailBtn" class="btn ghost small">Change email</button>
          </div>
        </div>
      </div>

      <!-- Step 3A: Welcome (new user) -->
      <div id="authStep3a" class="auth-step secure-state" style="display:none;text-align:center">
        <div class="secure-icon" style="color:#4ade80"><i class="fa-solid fa-circle-check"></i></div>
        <h3>Welcome to TimrX!</h3>
        <p class="secure-subtitle">50 free credits have been added to your account</p>
        <div class="secure-actions" style="flex-direction:column;gap:8px;align-items:center;margin-top:12px">
          <button type="button" id="authGoWorkspace" class="btn auth-action-btn">Start Creating</button>
          <button type="button" id="authBrowsePlans" class="btn ghost small">Browse Plans</button>
        </div>
      </div>

      <!-- Step 3B: Welcome Back (session switched) -->
      <div id="authStep3b" class="auth-step secure-state" style="display:none;text-align:center">
        <div class="secure-icon" style="color:#4ade80"><i class="fa-solid fa-circle-check"></i></div>
        <h3>Welcome back!</h3>
        <p class="secure-subtitle" id="authWbEmail"></p>
        <p id="authWbBalance" style="font-size:16px;font-weight:700;color:var(--ink);margin:4px 0 0"></p>
        <div class="secure-actions" style="flex-direction:column;gap:8px;align-items:center;margin-top:12px">
          <button type="button" id="authWbGoWorkspace" class="btn auth-action-btn">Go to Workspace</button>
          <button type="button" id="authWbBrowsePlans" class="btn ghost small">Browse Plans</button>
        </div>
      </div>

      <!-- Step 3C: Already Verified (account view) -->
      <div id="authStep3c" class="auth-step secure-state" style="display:none;text-align:center">
        <div class="secure-icon" style="color:#4ade80"><i class="fa-solid fa-circle-check"></i></div>
        <h3>Your Account</h3>
        <p class="secure-subtitle"><i class="fa-circle-check fa-solid" style="color:#4ade80;margin-right:4px"></i> Signed in as <strong id="authAccountEmail"></strong></p>
        <p id="authAccountBalance" style="font-size:16px;font-weight:700;color:var(--ink);margin:4px 0 0"></p>
        <div class="secure-actions" style="flex-direction:column;gap:8px;align-items:center;margin-top:16px">
          <button type="button" id="authSwitchAccount" class="btn ghost small">Switch to a different account</button>
        </div>
      </div>

    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  // Minimal CSS — only what hub.css secure-credits styles don't already cover
  const style = document.createElement('style');
  style.textContent = `
    /* Auth modal — primary action button (matches checkout-btn pattern) */
    #authCard .btn.auth-action-btn {
      background: #fff;
      color: #0b0b0b;
      border-color: #fff;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: .04em;
      padding: 12px 28px;
      width: auto;
      align-self: center;
    }
    #authCard .btn.auth-action-btn:hover {
      background: #7dd3fc;
      border-color: #7dd3fc;
      color: #0b0b0b;
      box-shadow: 0 8px 24px rgba(125,211,252,.3);
    }
    #authCard .btn.auth-action-btn:disabled {
      background: rgba(255,255,255,.3);
      border-color: transparent;
      color: rgba(0,0,0,.5);
      cursor: not-allowed;
      transform: none;
    }
    #authCard .btn.auth-action-btn:disabled:hover {
      background: rgba(255,255,255,.3);
      box-shadow: none;
      transform: none;
    }

    /* Code input — wider centered field */
    #authCard .code-input-group input {
      max-width: 220px;
    }

    /* Error/success text — match existing secure-error/secure-message */
    #authCard .secure-error:empty,
    #authCard .secure-message:empty {
      display: none;
    }

    /* Form layout */
    #authCard .secure-form {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    #authCard .secure-input-group {
      width: 100%;
    }
    #authCard .secure-input-group input {
      width: 100%;
    }
  `;
  document.head.appendChild(style);

  // ── Events ──
  _el('authClose').addEventListener('click', closeAuthModal);
  _el('authBackdrop').addEventListener('click', closeAuthModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _el('authCard')?.classList.contains('expanded')) closeAuthModal();
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

  _el('authSwitchAccount').addEventListener('click', () => {
    _pendingEmail = '';
    _showStep('email');
  });
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
      window.TimrXApi?.clearConfirmedIdentity?.();

      const switched = data.identity_changed || data.switched || false;
      const identityId = data.identity_id || '';

      if (switched) {
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
        await _fetchWallet();
        const creditsGranted = data.welcome_bonus_credits || 50;
        _showStep('welcome');

        window.dispatchEvent(new CustomEvent('timrx:auth:verified', {
          detail: { email: _pendingEmail, identityId, creditsGranted },
        }));
      }

      _identityCache = await _fetchIdentity();

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
      _setText('authCodeMessage', 'New code sent!');
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
  let text = `${balance} credits`;
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
    btn.textContent = 'Please wait\u2026';
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
