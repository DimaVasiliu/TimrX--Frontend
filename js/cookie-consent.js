/* Cookie Consent Banner - TimrX
   Self-contained: injects its own styles + HTML.
   Include once on any page: <script src="js/cookie-consent.js" defer></script>
   Stores preference in localStorage (not a cookie itself). */

(function () {
  'use strict';

  var STORAGE_KEY = 'timrx_cookie_consent';
  var stored;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch (_) { /* Safari: storage blocked */ }

  // Already consented or declined - nothing to show.
  if (stored === 'accepted' || stored === 'declined') return;

  // Keep consent visible without blocking core navigation. The wrapper is
  // click-through; only the consent card itself receives pointer events.
  var style = document.createElement('style');
  style.textContent = [
    '.cc-banner{',
    '  box-sizing:border-box;',
    '  position:fixed;left:0;right:auto;bottom:0;z-index:990;',
    '  width:100vw;max-width:100vw;overflow:hidden;',
    '  display:flex;justify-content:center;align-items:flex-end;',
    '  padding:18px clamp(14px,3vw,28px) calc(18px + env(safe-area-inset-bottom));',
    '  background:linear-gradient(180deg,transparent,rgba(4,7,8,.58));',
    '  opacity:0;animation:ccReveal .42s cubic-bezier(.22,.61,.36,1) .15s forwards;',
    '  isolation:isolate;',
    '  pointer-events:none;',
    '}',
    '.cc-inner{',
    '  box-sizing:border-box;',
    '  width:min(760px,calc(100vw - 28px));margin:0 auto;',
    '  display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px 22px;',
    '  padding:16px 18px;',
    '  background:linear-gradient(145deg,rgba(20,29,31,.96),rgba(10,15,17,.95));',
    '  border:1px solid rgba(127,200,194,.2);border-radius:18px;',
    '  box-shadow:0 18px 54px rgba(0,0,0,.42),inset 0 1px 0 rgba(242,245,243,.07);',
    '  backdrop-filter:blur(14px) saturate(1.05);-webkit-backdrop-filter:blur(14px) saturate(1.05);',
    '  transform:translateY(14px);',
    '  animation:ccPanelIn .48s cubic-bezier(.22,.61,.36,1) .2s forwards;',
    '  pointer-events:auto;',
    '}',
    '.cc-heading{display:grid;gap:8px;}',
    '.cc-eyebrow{',
    '  color:rgba(127,200,194,.88);font-size:11px;font-weight:700;',
    '  letter-spacing:.14em;text-transform:uppercase;',
    '}',
    '.cc-title{',
    '  margin:0;color:#f2f5f3;font-size:clamp(18px,2.2vw,23px);',
    '  font-weight:650;line-height:1.15;letter-spacing:0;',
    '}',
    '.cc-text{',
    '  grid-column:1;margin:0;max-width:62ch;font-size:13.5px;line-height:1.55;',
    '  color:rgba(226,236,237,.68);',
    '  overflow-wrap:anywhere;',
    '}',
    '.cc-text a{color:rgba(127,200,194,.95);text-underline-offset:3px;}',
    '.cc-actions{',
    '  grid-column:2;grid-row:1 / span 2;display:flex;justify-content:flex-end;align-items:center;gap:10px;',
    '}',
    '.cc-btn{',
    '  box-sizing:border-box;',
    '  min-height:42px;padding:10px 18px;border-radius:999px;',
    '  font:600 12px var(--font-ui,Inter,system-ui,sans-serif);',
    '  letter-spacing:.08em;cursor:pointer;border:1px solid transparent;',
    '  transition:color .2s ease,background .2s ease,border-color .2s ease,transform .2s ease;',
    '  text-transform:uppercase;touch-action:manipulation;',
    '}',
    '.cc-btn-accept{background:#7fc8c2;color:#081011;}',
    '.cc-btn-accept:hover{background:#9bd9d2;transform:translateY(-1px);}',
    '.cc-btn-decline{',
    '  background:rgba(226,236,237,.055);color:rgba(226,236,237,.75);',
    '  border-color:rgba(226,236,237,.14);',
    '}',
    '.cc-btn-decline:hover{',
    '  color:#f2f5f3;border-color:rgba(127,200,194,.35);background:rgba(127,200,194,.1);',
    '}',
    '.cc-btn:focus-visible{outline:2px solid rgba(127,200,194,.9);outline-offset:3px;}',
    '@keyframes ccReveal{from{opacity:0}to{opacity:1}}',
    '@keyframes ccPanelIn{',
    '  from{transform:translateY(14px);opacity:0}',
    '  to{transform:translateY(0) scale(1);opacity:1}',
    '}',
    '.cc-banner.cc-hiding{animation:ccFadeOut .28s ease forwards;pointer-events:none;}',
    '@keyframes ccFadeOut{from{opacity:1}to{opacity:0}}',
    '@media(max-width:600px){',
    '  .cc-banner{padding:12px 12px calc(12px + env(safe-area-inset-bottom));}',
    '  .cc-inner{width:calc(100vw - 24px);}',
    '  .cc-inner{grid-template-columns:1fr;gap:14px;padding:16px;border-radius:16px}',
    '  .cc-text,.cc-actions{grid-column:1;grid-row:auto;}',
    '  .cc-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}',
    '  .cc-btn{width:100%;padding-inline:14px}',
    '}',
    '@media(prefers-reduced-motion:reduce){',
    '  .cc-banner,.cc-inner{animation-duration:.01ms;animation-delay:0;}',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  var banner = document.createElement('div');
  banner.className = 'cc-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML =
    '<div class="cc-inner">' +
      '<div class="cc-heading">' +
        '<span class="cc-eyebrow">Privacy controls</span>' +
        '<h2 class="cc-title">Your workspace, your choice</h2>' +
      '</div>' +
      '<p class="cc-text">' +
        'We use third-party services that may collect data. ' +
        '<a href="/cookies">Learn more about our cookie policy</a>' +
      '</p>' +
      '<div class="cc-actions">' +
        '<button class="cc-btn cc-btn-decline" id="ccDecline">Decline</button>' +
        '<button class="cc-btn cc-btn-accept" id="ccAccept">Accept</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(banner);

  document.documentElement.classList.add('cc-consent-open');
  document.body.classList.add('cc-consent-open');

  function dismiss(choice) {
    try { localStorage.setItem(STORAGE_KEY, choice); } catch (_) { /* Safari: storage blocked */ }
    document.documentElement.classList.remove('cc-consent-open');
    document.body.classList.remove('cc-consent-open');
    banner.classList.add('cc-hiding');
    banner.addEventListener('animationend', function () {
      banner.remove();
    });
  }

  document.getElementById('ccAccept').addEventListener('click', function () {
    dismiss('accepted');
  });

  document.getElementById('ccDecline').addEventListener('click', function () {
    dismiss('declined');
  });
})();
