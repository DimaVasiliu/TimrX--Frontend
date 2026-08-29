// =================== NAV DROPDOWNS (stable hover/click/keyboard) ===================
(function(){
  const items = [...document.querySelectorAll('.menu > li')];

  // small enter/leave delay to prevent flicker when moving into the panel
  const OPEN_DELAY  = 60;
  const CLOSE_DELAY = 160;

  items.forEach(li=>{
    const btn  = li.querySelector(':scope > button');
    const key  = btn?.dataset.open;
    const drop = document.querySelector(`[data-drop="${key}"]`);
    if (!btn || !drop) return;

    let openTimer = null, closeTimer = null;

    function open(){
      clearTimeout(closeTimer);
      if (li.classList.contains('open')) return;
      openTimer = setTimeout(()=>{
        // close others
        items.forEach(x=> x !== li && x.classList.remove('open'));
        li.classList.add('open');
        btn.setAttribute('aria-expanded','true');
      }, OPEN_DELAY);
    }
    function close(){
      clearTimeout(openTimer);
      closeTimer = setTimeout(()=>{
        li.classList.remove('open');
        btn.setAttribute('aria-expanded','false');
      }, CLOSE_DELAY);
    }

    // Mouse
    btn.addEventListener('mouseenter', open);
    drop.addEventListener('mouseenter', ()=>{ clearTimeout(closeTimer); });
    li.addEventListener('mouseleave', close);

    // Click toggles (touch-friendly)
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      if (li.classList.contains('open')) close();
      else open();
    });

    // Keyboard: open on focus, close on Shift+Tab out
    btn.addEventListener('focus', open);
    drop.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape'){ li.classList.remove('open'); btn.focus(); }
    });

    // ARIA
    btn.setAttribute('aria-haspopup','true');
    btn.setAttribute('aria-expanded','false');
    drop.setAttribute('role','menu');
  });

  // Click anywhere outside closes all
  document.addEventListener('mousedown', (e)=>{
    const hit = e.target.closest('.menu > li');
    if (!hit) items.forEach(li=> li.classList.remove('open'));
  }, {capture:true});
})();

// Simple auto-cycling hero slider
const slider = document.getElementById('slider');
if (slider) {
  const pills = [...slider.querySelectorAll('.pill')];
  let i = 0; let timer = null;
  function cycle(){ if (!pills.length) return; pills.forEach(p=>p.classList.remove('active')); pills[i%pills.length].classList.add('active'); i++; }
  function start(){ timer = setInterval(cycle, 2400); }
  function stop(){ clearInterval(timer); }
  pills.forEach(p=> p.addEventListener('click', ()=>{ stop(); pills.forEach(x=>x.classList.remove('active')); p.classList.add('active'); }));
  start();
}

// Modals (legacy login/signup removed — auth now handled by auth-modal.js)

// =================== MODALS (drop-in) ===================
(function(){
  const qs  = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => [...r.querySelectorAll(s)];

  const modals = {};

  let lastFocus = null;
  let trapPrev = null;

  function openModal(which){
    const m = modals[which];
    if (!m) return;

    // close others first
    qsa('.modal.open').forEach(x => x !== m && closeModal(x));

    lastFocus = document.activeElement;
    m.classList.add('open');
    m.inert = false;
    trapFocus(m);

    const first = qs('input,button,[href],[tabindex]:not([tabindex="-1"])', m);
    if (first) first.focus();
  }

  function closeModal(m){
    if (!m) return;
    // CRITICAL: Move focus OUT before making inert to avoid accessibility warning
    releaseFocus();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    m.classList.remove('open');
    m.inert = true;
  }

  // Backdrop click (ignore clicks inside the card)
  qsa('.modal').forEach(m=>{
    m.addEventListener('mousedown', (e)=>{
      const card = qs('.card, .modal-content', m);
      if (!card) return;
      if (!card.contains(e.target)) closeModal(m);
    });
  });

  // Close buttons (generic modals — login/signup modals removed)

  // Any element with data-open="login" or "signup" will switch appropriately
  qsa('[data-open]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.preventDefault();
      const target = el.getAttribute('data-open'); // "login" | "signup"
      const current = el.closest('.modal.open');
      if (current) closeModal(current);
      if (target === 'login' || target === 'signup') openModal(target);
    });
  });

  // ESC closes any open modal
  document.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape') qsa('.modal.open').forEach(closeModal);
  });

  // Focus trap
  function trapFocus(container){
    releaseFocus();
    trapPrev = (e)=>{
      if (e.key !== 'Tab') return;
      const focusables = qsa('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', container)
        .filter(el => !el.hasAttribute('disabled'));
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    };
    container.addEventListener('keydown', trapPrev);
  }
  function releaseFocus(){
    qsa('.modal').forEach(m=> m.removeEventListener('keydown', trapPrev || (()=>{})));
    trapPrev = null;
  }

  // Legacy auto-open signup removed — auth now handled by auth-modal.js

  // Optional: stub for OAuth buttons
  document.querySelectorAll('.oauth-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> alert('OAuth flow goes here.'));
  });
})();

// Dashboard shortcuts delegate to the existing money-management controls.
(function(){
  const manageBtn = document.getElementById('dashboardManageBillingBtn');
  const billingAction = document.getElementById('dashboardBillingAction');

  function openBilling() {
    const subscriptionPill = document.getElementById('subscriptionStatusPill');
    if (subscriptionPill && !subscriptionPill.classList.contains('hidden')) {
      subscriptionPill.click();
      return;
    }
    const pricing = document.getElementById('pricing');
    if (pricing) pricing.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  manageBtn?.addEventListener('click', openBilling);
  billingAction?.addEventListener('click', openBilling);
})();

// Dashboard account, credit and billing summary. Display-only: credits.js remains
// the single owner of wallet, auth, checkout and subscription state.
(function(){
  const generalOut = document.getElementById('dashboardCreditsValue');
  const videoOut = document.getElementById('dashboardVideoCreditsValue');
  const planOut = document.getElementById('dashboardPlanValue');
  const accountBtn = document.getElementById('dashboardAccountBtn');
  const nextStep = document.getElementById('dashboardNextStep');
  const nextLabel = document.getElementById('dashboardNextStepLabel');
  const nextTitle = document.getElementById('dashboardNextStepTitle');
  const nextBtn = document.getElementById('dashboardNextStepBtn');
  const billingState = document.getElementById('dashboardBillingState');
  const billingTitle = document.getElementById('dashboardBillingTitle');
  const billingCopy = document.getElementById('dashboardBillingCopy');
  const billingAction = document.getElementById('dashboardBillingAction');
  const imageEstimate = document.getElementById('dashboardImageEstimate');
  const modelEstimate = document.getElementById('dashboardModelEstimate');
  const videoEstimate = document.getElementById('dashboardVideoEstimate');

  if (!generalOut && !videoOut && !planOut && !nextStep && !billingState) return;

  const state = {
    general: null,
    video: null,
    email: '',
    verified: false,
    subscriptionStatus: '',
    subscriptionText: '',
    hasSubscription: false
  };

  let observer = null;
  let tries = 0;

  function toNumber(text) {
    const n = parseInt(String(text || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(value) {
    return Number.isFinite(value) ? value.toLocaleString() : '--';
  }

  function scrollToPricing() {
    document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openAccount() {
    const account = document.getElementById('accountStatusBtn');
    const signIn = document.getElementById('signInBtn');
    if (account) account.click();
    else signIn?.click();
  }

  function openBilling() {
    const subscriptionPill = document.getElementById('subscriptionStatusPill');
    if (subscriptionPill && !subscriptionPill.classList.contains('hidden')) subscriptionPill.click();
    else scrollToPricing();
  }

  function runAction(action) {
    if (action === 'account') openAccount();
    else if (action === 'billing') openBilling();
    else if (action === 'pricing') scrollToPricing();
    else window.location.href = '/3dprint?refresh=1';
  }

  function setAction(action, label, title, buttonText) {
    if (nextLabel) nextLabel.textContent = label;
    if (nextTitle) nextTitle.textContent = title;
    if (nextBtn) {
      nextBtn.textContent = buttonText;
      nextBtn.dataset.action = action;
    }
  }

  function updateEstimates() {
    const general = Number.isFinite(state.general) ? state.general : 0;
    const video = Number.isFinite(state.video) ? state.video : 0;
    const set = (el, count) => {
      if (!el) return;
      el.textContent = fmt(count);
      // Mark the whole row, so a balance that buys nothing reads as a state
      // rather than a bare 0 sitting next to two healthy numbers.
      el.closest('.dashboard-estimate')?.classList.toggle('is-empty', count <= 0);
    };
    set(imageEstimate, Math.floor(general / 2));
    set(modelEstimate, Math.floor(general / 10));
    set(videoEstimate, Math.floor(general / 8));
  }

  function updateNextStep() {
    const total = (Number.isFinite(state.general) ? state.general : 0) + (Number.isFinite(state.video) ? state.video : 0);
    if (state.subscriptionStatus === 'past_due' || state.subscriptionStatus === 'suspended') {
      setAction('billing', 'Payment attention needed', 'Resolve billing to resume subscription credit refills.', 'Manage billing');
    } else if (!state.verified) {
      setAction('account', 'Recommended next step', 'Sign in to sync credits, checkout and creation history.', 'Sign in');
    } else if (total <= 0) {
      setAction('pricing', 'Balance is empty', 'Choose a credit pack or subscription before starting a new generation.', 'Buy credits');
    } else if (total < 10) {
      setAction('pricing', 'Balance is low', 'Top up before starting larger 3D or video jobs.', 'Top up');
    } else {
      setAction('workspace', 'Ready to create', 'Open the workspace with your current credit balance.', 'Open workspace');
    }
  }

  function updateBillingFromPill() {
    const sub = document.getElementById('subscriptionStatusPill');
    const visible = sub && !sub.classList.contains('hidden');
    state.hasSubscription = Boolean(visible);
    state.subscriptionText = visible ? sub.textContent.replace(/\s+/g, ' ').trim() : '';
    state.subscriptionStatus = '';

    if (visible) {
      const match = Array.from(sub.classList).find(cls => cls.indexOf('status-') === 0);
      state.subscriptionStatus = match ? match.replace('status-', '') : '';
    }

    if (planOut) planOut.textContent = state.subscriptionText || 'Free';
    if (!billingState || !billingTitle || !billingCopy || !billingAction) return;

    billingState.classList.remove('is-good', 'is-warning');
    if (!visible) {
      billingTitle.textContent = 'No subscription detected';
      billingCopy.textContent = 'Use one-time credits or choose a monthly plan below.';
      billingAction.textContent = 'Browse plans';
    } else if (state.subscriptionStatus === 'active') {
      billingState.classList.add('is-good');
      billingTitle.textContent = 'Subscription active';
      billingCopy.textContent = state.subscriptionText || 'Monthly credits are enabled.';
      billingAction.textContent = 'Manage';
    } else if (state.subscriptionStatus === 'past_due' || state.subscriptionStatus === 'suspended') {
      billingState.classList.add('is-warning');
      billingTitle.textContent = state.subscriptionStatus === 'past_due' ? 'Payment failed' : 'Subscription suspended';
      billingCopy.textContent = state.subscriptionText || 'Billing needs attention before credits can resume.';
      billingAction.textContent = 'Recover';
    } else {
      billingState.classList.add('is-warning');
      billingTitle.textContent = 'Subscription pending';
      billingCopy.textContent = state.subscriptionText || 'Payment confirmation is still syncing.';
      billingAction.textContent = 'Manage';
    }
  }

  function sync(){
    const general = document.getElementById('hoverGeneralValue') || document.getElementById('creditsValue');
    const video = document.getElementById('hoverVideoValue');
    const sub = document.getElementById('subscriptionStatusPill');
    const generalValue = toNumber(general?.textContent);
    const videoValue = toNumber(video?.textContent);
    if (generalValue !== null) state.general = generalValue;
    if (videoValue !== null) state.video = videoValue;
    if (generalOut && general && general.textContent.trim()) generalOut.textContent = general.textContent.trim();
    if (videoOut && video && video.textContent.trim()) videoOut.textContent = video.textContent.trim();
    updateBillingFromPill();
    updateEstimates();
    updateNextStep();
    // Attach per element, not once for the whole set. credits.js injects the
    // subscription pill asynchronously, so on most loads `sub` is still null at
    // the first sync — the old single-shot guard latched on to the credits
    // element, never observed the pill, and the billing card stayed on
    // "No subscription detected" for the entire session even while the PLAN row
    // above it read "Active".
    if (!observer) observer = new MutationObserver(sync);
    [general, video, sub].filter(Boolean).forEach((el) => {
      if (el.dataset.dashObserved === '1') return;
      el.dataset.dashObserved = '1';
      observer.observe(el, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['class'] });
    });
    // Keep polling until the pill exists, not just until the credits do.
    if (!sub && tries < 40) window.setTimeout(sync, 250);
    tries += 1;
  }

  accountBtn?.addEventListener('click', openAccount);
  nextBtn?.addEventListener('click', () => runAction(nextBtn.dataset.action || 'account'));
  window.addEventListener('timrx:wallet', (event) => {
    const wallet = event.detail || {};
    state.general = Number(wallet.available ?? state.general ?? 0);
    state.video = Number(wallet.videoAvailable ?? state.video ?? 0);
    state.email = wallet.email || state.email;
    state.verified = Boolean(wallet.emailVerified);
    if (generalOut) generalOut.textContent = fmt(state.general);
    if (videoOut) videoOut.textContent = fmt(state.video);
    // Billing was missing here. A wallet refresh is exactly the moment the
    // subscription pill lands, so this is the callback that has to re-read it.
    updateBillingFromPill();
    updateEstimates();
    updateNextStep();
  });
  window.addEventListener('timrx:auth:verified', () => {
    state.verified = true;
    updateNextStep();
  });
  window.addEventListener('timrx:auth:switched', (event) => {
    state.email = event.detail?.email || state.email;
    state.verified = true;
    updateNextStep();
  });

  sync();
})();

// Usage / transaction history. Read-only dashboard surface for credit trust.
(function(){
  const API_BASE = window.TIMRX_3D_API_BASE || 'https://3d.timrx.live';
  const activityList = document.getElementById('dashboardActivityList');
  const usageBtn = document.getElementById('dashboardUsageBtn');
  const usageInlineBtn = document.getElementById('dashboardUsageInlineBtn');
  const modal = document.getElementById('usageHistoryModal');
  const closeBtn = document.getElementById('usageHistoryClose');
  const refreshBtn = document.getElementById('usageHistoryRefreshBtn');
  const modalList = document.getElementById('usageHistoryList');
  const availableOut = document.getElementById('usageAvailableCredits');
  const reservedOut = document.getElementById('usageReservedCredits');
  const balanceOut = document.getElementById('usageBalanceCredits');

  if (!activityList && !modal) return;

  let lastCompactLoad = 0;
  let fullLoadInFlight = null;

  function fmtCredits(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : '--';
  }

  function formatAmount(item) {
    const amount = Number(item?.amount_credits || 0);
    if (item?.kind === 'reservation' || item?.status === 'held') return `${fmtCredits(Math.abs(amount))} held`;
    if (amount > 0) return `+${fmtCredits(amount)}`;
    if (amount < 0) return `-${fmtCredits(Math.abs(amount))}`;
    return '0';
  }

  function amountClass(item) {
    const amount = Number(item?.amount_credits || 0);
    if (item?.kind === 'reservation' || item?.status === 'held') return 'is-held';
    if (amount > 0) return 'is-positive';
    if (amount < 0) return 'is-negative';
    return '';
  }

  function iconClass(item) {
    const kind = item?.kind;
    if (kind === 'purchase' || kind === 'credit') return 'fa-circle-plus';
    if (kind === 'refund' || kind === 'release') return 'fa-rotate-left';
    if (kind === 'reservation') return 'fa-hourglass-half';
    if (kind === 'charge') return 'fa-receipt';
    return 'fa-clock-rotate-left';
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function setEmpty(target, message) {
    if (!target) return;
    target.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'usage-history-empty';
    empty.textContent = message;
    target.appendChild(empty);
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.className = 'usage-history-row';

    const icon = document.createElement('span');
    icon.className = 'usage-history-icon';
    const iconNode = document.createElement('i');
    iconNode.className = `fa-solid ${iconClass(item)}`;
    iconNode.setAttribute('aria-hidden', 'true');
    icon.appendChild(iconNode);

    const main = document.createElement('div');
    main.className = 'usage-history-main';

    const title = document.createElement('div');
    title.className = 'usage-history-title';
    const titleText = document.createElement('span');
    titleText.textContent = item?.title || 'Credit activity';
    title.appendChild(titleText);
    if (item?.status) {
      const chip = document.createElement('span');
      chip.className = 'usage-history-chip';
      chip.textContent = String(item.status).replace(/_/g, ' ');
      title.appendChild(chip);
    }

    const detail = document.createElement('div');
    detail.className = 'usage-history-detail';
    detail.textContent = item?.detail || item?.action_code || item?.entry_type || '';

    const date = document.createElement('div');
    date.className = 'usage-history-date';
    date.textContent = formatDate(item?.created_at);

    main.appendChild(title);
    if (detail.textContent) main.appendChild(detail);
    if (date.textContent) main.appendChild(date);

    const amount = document.createElement('strong');
    amount.className = `usage-history-amount ${amountClass(item)}`.trim();
    amount.textContent = formatAmount(item);

    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(amount);
    return row;
  }

  function renderCompact(items, emptyMessage = 'No activity yet') {
    if (!activityList) return;
    activityList.textContent = '';
    if (!items.length) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = 'Usage history';
      const value = document.createElement('strong');
      value.textContent = emptyMessage;
      item.appendChild(label);
      item.appendChild(value);
      activityList.appendChild(item);
      return;
    }
    items.slice(0, 3).forEach((entry) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = entry.title || 'Credit activity';
      const detail = document.createElement('em');
      detail.textContent = entry.detail || formatDate(entry.created_at);
      label.appendChild(detail);
      const value = document.createElement('strong');
      value.className = amountClass(entry);
      value.textContent = formatAmount(entry);
      row.appendChild(label);
      row.appendChild(value);
      activityList.appendChild(row);
    });
  }

  function renderModal(data) {
    const summary = data?.summary || {};
    if (availableOut) availableOut.textContent = fmtCredits(summary.available_credits);
    if (reservedOut) reservedOut.textContent = fmtCredits(summary.reserved_credits);
    if (balanceOut) balanceOut.textContent = fmtCredits(summary.balance_credits);
    if (!modalList) return;
    modalList.textContent = '';
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      setEmpty(modalList, 'No credit activity yet.');
      return;
    }
    items.forEach((item) => modalList.appendChild(buildRow(item)));
  }

  async function fetchActivity(limit) {
    const response = await fetch(`${API_BASE}/api/billing/activity?limit=${limit}`, {
      method: 'GET',
      credentials: 'include',
      mode: 'cors',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      const code = data?.error?.code || data?.error || response.status;
      throw new Error(String(code));
    }
    return data;
  }

  async function loadCompact(force = false) {
    if (!force && Date.now() - lastCompactLoad < 15000) return;
    lastCompactLoad = Date.now();
    try {
      const data = await fetchActivity(3);
      renderCompact(data.items || []);
    } catch (err) {
      if (String(err.message).includes('UNAUTHORIZED') || String(err.message).includes('401')) {
        renderCompact([], 'Sign in to load');
      } else if (activityList) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = 'Usage history';
        const value = document.createElement('strong');
        value.textContent = 'Unavailable';
        item.appendChild(label);
        item.appendChild(value);
        activityList.textContent = '';
        activityList.appendChild(item);
      }
    }
  }

  async function loadFull(force = false) {
    if (fullLoadInFlight && !force) return fullLoadInFlight;
    if (modalList) setEmpty(modalList, 'Loading usage history...');
    fullLoadInFlight = fetchActivity(80)
      .then((data) => {
        renderModal(data);
        renderCompact(data.items || []);
      })
      .catch((err) => {
        const message = String(err.message).includes('UNAUTHORIZED') || String(err.message).includes('401')
          ? 'Sign in to view credit usage history.'
          : 'Usage history is unavailable right now.';
        setEmpty(modalList, message);
      })
      .finally(() => {
        fullLoadInFlight = null;
      });
    return fullLoadInFlight;
  }

  function openUsageModal() {
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    loadFull(true);
  }

  function closeUsageModal() {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  usageBtn?.addEventListener('click', openUsageModal);
  usageInlineBtn?.addEventListener('click', openUsageModal);
  closeBtn?.addEventListener('click', closeUsageModal);
  refreshBtn?.addEventListener('click', () => loadFull(true));
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeUsageModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal?.classList.contains('open')) closeUsageModal();
  });

  window.addEventListener('timrx:wallet', () => loadCompact(true));
  window.addEventListener('timrx:auth:verified', () => loadCompact(true));
  window.addEventListener('timrx:auth:switched', () => loadCompact(true));
  window.setTimeout(() => loadCompact(), 1200);
})();


// ===== Floating sprites randomizer =====
(function(){
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce) return;

  const floaters = document.querySelectorAll('.floater.auto');
  const jitter = (min,max)=> Math.random()*(max-min)+min;

  floaters.forEach((el, idx)=>{
    // randomize start positions a bit so every load feels fresh
    const top = jitter(12, 74);     // viewport %
    const left = jitter(6, 84);     // viewport %
    el.style.top  = `${top}%`;
    el.style.left = `${left}%`;

    // vary animation timings so they de-sync
    el.style.animationDuration =
      `${jitter(6.5,9)}s, ${jitter(18,26)}s, ${jitter(28,44)}s`;
    el.style.animationDelay =
      `${jitter(-2,2)}s, ${jitter(-6,2)}s, ${jitter(-8,2)}s`;
  });
})();

// Chaotic floater timing randomizer (keeps lanes, varies tempo)
(function(){
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  const rand = (min, max) => (Math.random() * (max - min) + min).toFixed(2);

  document.querySelectorAll('.hero-fx .floater.auto').forEach(el => {
    // Only adjust if not set inline
    if (!el.style.getPropertyValue('--t')) {
      el.style.setProperty('--t', `${rand(10, 20)}s`);
    }
    if (!el.style.getPropertyValue('--delay')) {
      el.style.setProperty('--delay', `${rand(-6, 2)}s`);
    }
  });
})();

// If the browser can't do WebGL, replace 3D floaters with their posters.
(function(){
function webglOK(){
  try{
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  }catch(_){ return false; }
}
if (!webglOK()) {
  document.querySelectorAll('model-viewer.floater-3d').forEach(el=>{
    const img = document.createElement('img');
    img.className = 'floater ' + [...el.classList].filter(c=>c!=='floater-3d').join(' ');
    img.src = el.getAttribute('poster') || 'img/floater-bust.png'; // change to per-asset poster if you want
    img.alt = '';
    img.style.top = el.style.top;
    img.style.left = el.style.left;
    el.replaceWith(img);
  });
  return;
}

// On small screens keep only one 3D floater (save battery)
if (window.matchMedia('(max-width: 820px)').matches) {
  const all = [...document.querySelectorAll('model-viewer.floater-3d')];
  all.slice(1).forEach(el=> el.remove());
}
})();

    (function(){
      const now = new Date().getFullYear();
      const el = document.getElementById('year');
      if (el) el.textContent = now;
    })();


// Magnetized particles + click ripple for the white strip (chips ignored)
/* ultra-robust magnet dust + ripple (no ResizeObserver, frame-synced sizing) */
/* magnet dust + ripple — FIXED seeding & even spread */
(function initStripParticles_FinalFix() {
  function start() {
    const strip  = document.getElementById('usecases-strip');
    if (!strip) return;
    const canvas = strip.querySelector('.strip-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });

    // ---------- sizing ----------
    let dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    let lastW = 0, lastH = 0;           // css px
    let firstSized = false;             // becomes true once canvas has non-zero pixels
    const parts = [];
    const palette = [
      'rgba(40,40,40,0.40)','rgba(72,66,58,0.38)','rgba(90,82,72,0.35)','rgba(26,26,26,0.42)'
    ];
    const rnd = (a,b)=> a + Math.random()*(b-a);

    function targetCount(){
      const area = canvas.width * canvas.height;
      return Math.max(240, Math.min(1400, Math.floor(area / 400)));
    }
    function spawnOne(x, y){
      if (x == null) x = Math.random()*canvas.width;
      if (y == null) y = Math.random()*canvas.height;
      return {
        x, y, hx:x, hy:y,
        vx:rnd(-0.25,0.25), vy:rnd(-0.25,0.25),
        r: rnd(0.9, 2.3) * (dpr*0.9),
        c: palette[(Math.random()*palette.length)|0]
      };
    }
    function scatterHomes() {
      // redistribute across full canvas + zero velocities
      for (const p of parts) {
        p.x = p.hx = Math.random()*canvas.width;
        p.y = p.hy = Math.random()*canvas.height;
        p.vx = p.vy = 0;
      }
    }
    function rebalance(){
      const want = targetCount();
      if (want > parts.length) { for (let i=parts.length;i<want;i++) parts.push(spawnOne()); }
      else if (want < parts.length) { parts.length = want; }
      for (const p of parts) {
        p.hx = Math.min(Math.max(p.hx,0), canvas.width);
        p.hy = Math.min(Math.max(p.hy,0), canvas.height);
        p.r  = Math.min(Math.max(p.r, 0.8*dpr), 2.6*dpr);
      }
    }

    function ensureSize() {
      dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const w = Math.max(1, Math.floor(strip.clientWidth));
      const h = Math.max(1, Math.floor(strip.clientHeight));
      const sizeChanged = (w !== lastW || h !== lastH);
      if (sizeChanged || canvas.width === 0 || canvas.height === 0) {
        const prevW = lastW, prevH = lastH;
        lastW = w; lastH = h;
        canvas.width  = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
        canvas.style.width  = w + 'px';
        canvas.style.height = h + 'px';

        if (!firstSized) {
          // first real size → seed AFTER canvas has pixels
          firstSized = true;
          const N = targetCount();
          parts.length = 0;
          for (let i=0;i<N;i++) parts.push(spawnOne());
        } else {
          // big resize → keep density and re-spread homes
          const big =
            prevW === 0 || prevH === 0 ||
            Math.abs(w - prevW)/Math.max(1,prevW) > 0.2 ||
            Math.abs(h - prevH)/Math.max(1,prevH) > 0.2;
          rebalance();
          if (big) scatterHomes();
        }
      }
      return canvas.width > 0 && canvas.height > 0;
    }

    // ---------- interaction / ripple (unchanged) ----------
    const pointer = { x:0, y:0, active:false };
    const INFLUENCE = ()=> 160*dpr;
    const STRENGTH  = 0.09, FRICTION = 0.90, HOME_PULL = 0.008, NOISE = 0.25;
    const inBg = (e)=> !e.target.closest('.strip-list') && strip.contains(e.target);

    strip.addEventListener('mousemove', (e)=>{
      if (!inBg(e)) { pointer.active=false; return; }
      const r = strip.getBoundingClientRect();
      pointer.x = (e.clientX - r.left) * dpr;
      pointer.y = (e.clientY - r.top)  * dpr;
      pointer.active = true;
    }, {passive:true});
    strip.addEventListener('mouseleave', ()=>{ pointer.active=false; }, {passive:true});

    const ripples = [];
    const easeOutCubic = t=> 1 - Math.pow(1-t,3);
    strip.addEventListener('pointerdown', (e)=>{
      if (!inBg(e)) return;
      const r = strip.getBoundingClientRect();
      ripples.push({
        x: (e.clientX - r.left) * dpr,
        y: (e.clientY - r.top)  * dpr,
        t: 0, life: 900,
        maxR: Math.hypot(canvas.width, canvas.height) * 0.65,
        band: 44*dpr, power: 0.95,
        mode: e.altKey ? 'repel' : 'attract'
      });
    });

    // ---------- loop ----------
    function frame(){
      if (!ensureSize()) { requestAnimationFrame(frame); return; }

      // fade toward white (motion smear)
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0,0,canvas.width,canvas.height);

      // ripples
      for (let i=ripples.length-1;i>=0;i--){
        const rp = ripples[i];
        rp.t += 16;
        const k = Math.min(1, rp.t / rp.life);
        rp.radius = easeOutCubic(k) * rp.maxR;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(60,60,70,0.24)';
        ctx.lineWidth = Math.max(1, Math.min(6, rp.radius*0.006));
        ctx.arc(rp.x, rp.y, rp.radius, 0, Math.PI*2);
        ctx.stroke();
        if (k>=1) ripples.splice(i,1);
      }

      // particles
      for (const p of parts){
        // noise
        p.vx += (Math.random()-0.5)*NOISE;
        p.vy += (Math.random()-0.5)*NOISE;

        if (pointer.active){
          const dx = pointer.x - p.x, dy = pointer.y - p.y;
          const inf = INFLUENCE(); const d2 = dx*dx + dy*dy;
          if (d2 < inf*inf){
            const d = Math.sqrt(d2)||1, m = (1 - d/inf) * STRENGTH;
            p.vx += (dx/d)*m; p.vy += (dy/d)*m;
          }
        } else {
          p.vx += (p.hx - p.x) * HOME_PULL;
          p.vy += (p.hy - p.y) * HOME_PULL;
        }

        for (const rp of ripples){
          const dx = p.x - rp.x, dy = p.y - rp.y;
          const dist = Math.hypot(dx,dy)||1;
          const dr = Math.abs(dist - rp.radius);
          if (dr < rp.band){
            const fall = 1 - (dr / rp.band);
            let dirX = dx/dist, dirY = dy/dist; // outward
            if (rp.mode === 'attract'){
              const sign = dist < rp.radius ? -1 : 1;
              dirX *= sign; dirY *= sign;
            }
            const imp = rp.power * fall * 0.18;
            p.vx += dirX * imp; p.vy += dirY * imp;
          }
        }

        p.vx *= FRICTION; p.vy *= FRICTION;
        p.x += p.vx;       p.y += p.vy;

        ctx.beginPath(); ctx.fillStyle = p.c;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();

        ctx.beginPath(); ctx.globalAlpha = 0.32;
        ctx.arc(p.x - p.vx*2.2, p.y - p.vy*2.2, Math.max(0.6, p.r*0.9), 0, Math.PI*2);
        ctx.fill(); ctx.globalAlpha = 1;
      }

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once:true });
  } else {
    start();
  }
})();


/* ================================================================ */
/* Hero model — gentle left/right orbit swing                       */
/* ================================================================ */
(function heroModelSwing() {
var mv = document.querySelector('.hero-figure');
if (!mv) return;
var SWING = 35;
var SPEED = 0.00025;
var start = performance.now();
function tick(t) {
  var angle = Math.sin((t - start) * SPEED) * SWING;
  mv.setAttribute('camera-orbit', angle + 'deg 80deg 120%');
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
})();

// =================== MOBILE NAV HIDE ON SCROLL ===================
(function(){
if (window.innerWidth > 768) return;
var nav = document.querySelector('.nav');
if (!nav) return;
var lastY = window.scrollY;
var hidden = false;
nav.style.transition = 'transform 0.3s ease';
window.addEventListener('scroll', function(){
  var y = window.scrollY;
  if (y > lastY && y > 60 && !hidden) {
    nav.style.transform = 'translateY(-100%)';
    hidden = true;
  } else if (y < lastY && hidden) {
    nav.style.transform = 'translateY(0)';
    hidden = false;
  }
  lastY = y;
}, {passive: true});
})();
