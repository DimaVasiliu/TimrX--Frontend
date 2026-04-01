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
let _isRestoreFlow = false;  // true when email belongs to another identity
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

function openAuthModal(options = {}) {
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

function closeAuthModal() {
  const backdrop = _el('authBackdrop');
  const card = _el('authCard');
  if (backdrop) backdrop.classList.remove('visible');
  if (card) { card.classList.remove('expanded'); card.classList.add('collapsed'); }
  _clearResendTimer();
  if (_options.onClose && _currentStep !== 'welcome' && _currentStep !== 'welcome-back') {
    _options.onClose();
  }
}

function isAuthenticated() {
  if (_identityCache?.email_verified) return true;
  try {
    const stamp = localStorage.getItem('timrx_auth_stamp');
    if (stamp) { return !!JSON.parse(stamp).emailVerified; }
  } catch { /* ignore */ }
  return false;
}

// Expose on window so non-module scripts (credits.js) can access without dynamic import
window.TimrXAuth = { openAuthModal, closeAuthModal, isAuthenticated };

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
          <div class="secure-input-group">
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
      <div id="authStep3a" class="auth-step secure-state auth-welcome-step" style="display:none;text-align:center">
        <div class="auth-welcome-glow"></div>
        <div class="auth-welcome-badge">
          <i class="fa-solid fa-gift"></i>
        </div>
        <h3 class="auth-welcome-title">Welcome to TimrX!</h3>
        <div class="auth-credits-grant">
          <span class="auth-credits-number" id="authCreditsCounter">50</span>
          <span class="auth-credits-label">free credits added</span>
        </div>
        <p class="secure-subtitle" style="margin-top:12px;opacity:.5;font-size:12px">Start generating AI images, 3D models & videos</p>
        <div class="secure-actions" style="flex-direction:column;gap:8px;align-items:center;margin-top:16px">
          <button type="button" id="authGoWorkspace" class="btn auth-action-btn">Start Creating</button>
          <button type="button" id="authBrowsePlans" class="btn ghost small">Browse Plans</button>
        </div>
      </div>

      <!-- Step 3B: Welcome Back (session switched) -->
      <div id="authStep3b" class="auth-step secure-state auth-welcome-step" style="display:none;text-align:center">
        <div class="auth-welcome-glow"></div>
        <div class="auth-welcome-badge auth-wb-badge">
          <i class="fa-solid fa-hand-peace"></i>
        </div>
        <h3 class="auth-welcome-title">Welcome back!</h3>
        <p class="secure-subtitle" id="authWbEmail" style="margin-bottom:8px"></p>
        <div class="auth-credits-grant auth-credits-balance">
          <span class="auth-credits-number" id="authWbBalance">0</span>
          <span class="auth-credits-label">credits</span>
        </div>
        <div class="secure-actions" style="flex-direction:column;gap:8px;align-items:center;margin-top:16px">
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
          <button type="button" id="authLogoutBtn" class="auth-logout-btn">Log out</button>
        </div>
      </div>

    </div>
  `;
  // Append to <html> to escape any transformed parents that break position:fixed
  document.documentElement.insertAdjacentHTML('beforeend', html);

  // Self-contained CSS — works on any page (hub, 3dprint, etc.)
  const style = document.createElement('style');
  style.textContent = `
    /* ── Auth modal positioning (must be self-contained for 3dprint) ── */
    #authBackdrop {
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.6);
      -webkit-backdrop-filter: blur(4px);
      backdrop-filter: blur(4px);
      z-index: 999998;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.25s ease, visibility 0.25s ease;
    }
    #authBackdrop.visible {
      opacity: 1;
      visibility: visible;
    }
    #authCard {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.95);
      width: calc(100% - 32px);
      max-width: 460px;
      max-height: calc(100vh - 48px);
      overflow-y: auto;
      padding: 28px 24px;
      background: #141414;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px;
      text-align: center;
      z-index: 999999;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.25s ease, visibility 0.25s ease, transform 0.25s ease;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    #authCard.collapsed {
      opacity: 0;
      visibility: hidden;
      transform: translate(-50%, -50%) scale(0.95);
      pointer-events: none;
    }
    #authCard.expanded {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, -50%) scale(1);
      pointer-events: auto;
    }
    #authCard .secure-modal-close {
      position: absolute;
      top: 12px; right: 12px;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      color: #888;
      font-size: 16px;
      cursor: pointer;
      transition: background .15s, color .15s;
    }
    #authCard .secure-modal-close:hover {
      background: rgba(255,255,255,.1);
      color: #fff;
    }
    #authCard .secure-icon {
      width: 48px; height: 48px;
      margin: 0 auto 16px;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, rgba(255,255,255,.08), rgba(255,255,255,.02));
      border-radius: 50%;
      font-size: 24px;
      color: #e2e8f0;
    }
    #authCard h3 {
      margin: 0 0 8px;
      font-size: 20px;
      font-weight: 700;
      color: #e2e8f0;
    }
    #authCard .secure-subtitle {
      margin: 0 0 16px;
      font-size: 14px;
      color: #888;
    }
    #authCard .secure-error { margin: 0; font-size: 13px; color: #ef4444; min-height: 0; }
    #authCard .secure-error:empty { display: none; }
    #authCard .secure-message { margin: 0; font-size: 13px; color: #4ade80; min-height: 0; }
    #authCard .secure-message:empty { display: none; }
    #authCard .secure-form {
      display: flex; flex-direction: column; gap: 8px;
    }
    #authCard .secure-input-group {
      display: flex; gap: 10px; max-width: 340px; margin: 0 auto;
    }
    #authCard .secure-input-group input {
      flex: 1; min-width: 0;
      padding: 12px 16px;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 15px;
      outline: none;
      transition: border-color .2s, background .2s;
    }
    #authCard .secure-input-group input:focus {
      border-color: rgba(255,255,255,.3);
      background: rgba(255,255,255,.08);
    }
    #authCard .secure-input-group input::placeholder { color: #555; }
    #authCard .code-input-group input {
      text-align: center; letter-spacing: 4px;
      font-size: 20px; font-weight: 600; max-width: 220px;
    }
    #authCard .secure-actions {
      display: flex; gap: 12px; justify-content: center; margin-top: 8px;
    }
    #authCard .btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 18px; border-radius: 999px;
      font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
      font-size: 12px; cursor: pointer;
      transition: all .2s; border: 1px solid rgba(255,255,255,.15);
      background: transparent; color: #ccc;
    }
    #authCard .btn:hover { background: rgba(255,255,255,.08); color: #fff; }
    #authCard .btn.small { padding: 8px 14px; font-size: 11px; }
    #authCard .btn:disabled { opacity: .45; cursor: not-allowed; }

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
    #authCard .secure-input-group input {
      width: 100%;
    }

    /* ── Welcome / Welcome Back step ── */
    #authCard .auth-welcome-step {
      position: relative;
      overflow: hidden;
    }
    #authCard .auth-welcome-glow {
      position: absolute;
      top: -40px; left: 50%;
      transform: translateX(-50%);
      width: 200px; height: 200px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,255,255,.06) 0%, transparent 70%);
      pointer-events: none;
      animation: authPulseGlow 3s ease-in-out infinite;
    }
    @keyframes authPulseGlow {
      0%, 100% { opacity: .5; transform: translateX(-50%) scale(1); }
      50% { opacity: 1; transform: translateX(-50%) scale(1.15); }
    }
    #authCard .auth-welcome-badge {
      width: 56px; height: 56px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(255,255,255,.10) 0%, rgba(255,255,255,.03) 100%);
      border: 1px solid rgba(255,255,255,.10);
      display: flex; align-items: center; justify-content: center;
      font-size: 24px;
      color: #e2e8f0;
      margin: 0 auto 16px;
      animation: authBadgePop .4s cubic-bezier(.34,1.56,.64,1) both;
    }
    @keyframes authBadgePop {
      from { transform: scale(0) rotate(-20deg); opacity: 0; }
      to { transform: scale(1) rotate(0deg); opacity: 1; }
    }
    #authCard .auth-welcome-title {
      font-size: 22px;
      font-weight: 700;
      color: #f1f5f9;
      margin: 0 0 14px;
      animation: authFadeUp .5s ease both .15s;
    }
    @keyframes authFadeUp {
      from { transform: translateY(8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    #authCard .auth-credits-grant {
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 12px;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.08);
      animation: authFadeUp .5s ease both .3s;
    }
    #authCard .auth-credits-number {
      font-size: 32px;
      font-weight: 800;
      color: #f1f5f9;
      font-variant-numeric: tabular-nums;
      letter-spacing: -.02em;
    }
    #authCard .auth-credits-label {
      font-size: 13px;
      color: #94a3b8;
      font-weight: 500;
    }

    /* Logout button — subtle, bottom of account view */
    #authCard .auth-logout-btn {
      background: none;
      border: none;
      color: #ef4444;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 6px;
      transition: background .15s, color .15s;
      margin-top: 4px;
    }
    #authCard .auth-logout-btn:hover {
      background: rgba(239,68,68,.1);
      color: #f87171;
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

  _el('authWbGoWorkspace').addEventListener('click', () => { window.location.href = '/3dprint?refresh=1'; });
  _el('authWbBrowsePlans').addEventListener('click', () => { closeAuthModal(); window.location.reload(); });

  _el('authSwitchAccount').addEventListener('click', () => {
    _pendingEmail = '';
    _showStep('email');
  });

  _el('authLogoutBtn').addEventListener('click', _handleLogout);
}

async function _handleLogout() {
  _setLoading('authLogoutBtn', true, 'Logging out\u2026');
  try {
    await api('/api/me/logout', { method: 'POST' });
  } catch { /* ignore errors — clear local state regardless */ }

  // Clear all local auth state
  window.TimrXApi?.clearAllUserCaches?.();
  window.TimrXApi?.clearConfirmedIdentity?.();
  try { localStorage.removeItem('timrx_auth_stamp'); } catch {}

  // Reload the page to get a fresh anonymous session
  window.location.reload();
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
  _isRestoreFlow = false;

  try {
    // Step 1: Try to attach email to current identity
    const res = await api('/api/auth/email/attach', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });

    const data = res.data || {};

    if (data.hint === 'account_switch_required' || data.merge_disabled) {
      // Email belongs to another account — use restore flow to send the code
      _isRestoreFlow = true;
      const restoreRes = await api('/api/auth/restore/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      if (restoreRes.data?.ok || restoreRes.ok) {
        _pendingEmail = email;
        _showStep('code');
      } else {
        _setText('authEmailError', restoreRes.data?.error?.message || 'Failed to send code. Please try again.');
      }
    } else if (data.ok || res.ok) {
      // Email attached to current identity — code was sent by attach endpoint
      _pendingEmail = email;
      _showStep('code');
    } else {
      _setText('authEmailError', data.error?.message || data.message || 'Failed to send code. Please try again.');
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
    // Use restore/redeem for accounts that belong to another identity,
    // email/verify for same-identity verification
    const verifyUrl = _isRestoreFlow ? '/api/auth/restore/redeem' : '/api/auth/email/verify';
    const res = await api(verifyUrl, {
      method: 'POST',
      body: JSON.stringify({ email: _pendingEmail, code }),
    });

    const data = res.data || {};

    if (data.ok || data.verified) {
      _clearResendTimer();
      window.TimrXApi?.clearConfirmedIdentity?.();

      // restore/redeem always switches identity; email/verify may or may not
      const switched = _isRestoreFlow || data.identity_changed || data.switched || false;
      const identityId = data.identity_id || data.me?.identity_id || '';

      if (switched) {
        window.TimrXApi?.clearAllUserCaches?.();
        // restore/redeem includes wallet inline; email/verify needs a fetch
        const inlineWallet = data.wallet;
        const walletData = inlineWallet || await _fetchWallet();
        _setText('authWbEmail', _pendingEmail);
        const balance = walletData?.balance ?? walletData?.available ?? 0;
        _setText('authWbBalance', balance.toLocaleString());
        _showStep('welcome-back');
        _animateCounter('authWbBalance', balance);

        window.dispatchEvent(new CustomEvent('timrx:auth:switched', {
          detail: { email: _pendingEmail, identityId },
        }));
      } else {
        await _fetchWallet();
        const creditsGranted = data.welcome_bonus_credits || 50;
        _showStep('welcome');
        _animateCounter('authCreditsCounter', creditsGranted);

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

  // Use the same endpoint that originally sent the code
  const resendUrl = _isRestoreFlow ? '/api/auth/restore/request' : '/api/auth/email/attach';
  try {
    const res = await api(resendUrl, {
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
  // Read the credits pill already on the page (most reliable, already formatted)
  const creditsEl = document.getElementById('creditsValue') || document.getElementById('workspaceCredits');
  const pillText = creditsEl?.textContent?.replace(/,/g, '').trim();
  const pillBalance = pillText ? parseInt(pillText, 10) : NaN;

  const wallet = await _fetchWallet();
  const apiBal = wallet?.balance ?? wallet?.available ?? 0;
  const video = wallet?.video_balance ?? 0;

  // Use pill value if available and higher (avoids stale/partial API response)
  const balance = (!isNaN(pillBalance) && pillBalance > apiBal) ? pillBalance : apiBal;

  let text = `${balance.toLocaleString()} credits`;
  if (video > 0) text += ` + ${video.toLocaleString()} video credits`;
  _setText(elementId, text);
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function _animateCounter(elementId, target) {
  const el = _el(elementId);
  if (!el || target <= 0) return;
  const duration = 800;
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const val = Math.round(from + (target - from) * eased);
    el.textContent = val.toLocaleString();
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function _el(id) { return document.getElementById(id); }

function _setText(id, text) {
  const el = _el(id);
  if (el) el.textContent = text;
}

function _setLoading(btnId, loading, loadingText) {
  const btn = _el(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = loadingText || 'Please wait\u2026';
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
