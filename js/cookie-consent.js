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

  // The consent surface is intentionally modal: the page stays visible behind
  // it, but cannot be used until the visitor makes a choice.
  var style = document.createElement('style');
  style.textContent = [
    'html.cc-consent-open,body.cc-consent-open{overflow:hidden!important;}',
    '.cc-banner{',
    '  position:fixed;inset:0;z-index:2147483647;',
    '  display:grid;place-items:center;',
    '  padding:clamp(18px,4vw,48px);',
    '  background:rgba(4,7,8,.74);',
    '  backdrop-filter:blur(16px) saturate(.88);-webkit-backdrop-filter:blur(16px) saturate(.88);',
    '  opacity:0;animation:ccReveal .42s cubic-bezier(.22,.61,.36,1) .15s forwards;',
    '  isolation:isolate;',
    '}',
    '.cc-inner{',
    '  width:min(100%,620px);margin:0 auto;',
    '  display:grid;gap:24px;padding:clamp(24px,4vw,38px);',
    '  background:linear-gradient(145deg,rgba(20,29,31,.98),rgba(10,15,17,.98));',
    '  border:1px solid rgba(127,200,194,.22);border-radius:20px;',
    '  box-shadow:0 30px 90px rgba(0,0,0,.58),inset 0 1px 0 rgba(242,245,243,.07);',
    '  transform:translateY(12px) scale(.98);',
    '  animation:ccPanelIn .48s cubic-bezier(.22,.61,.36,1) .2s forwards;',
    '}',
    '.cc-heading{display:grid;gap:8px;}',
    '.cc-eyebrow{',
    '  color:rgba(127,200,194,.88);font-size:11px;font-weight:700;',
    '  letter-spacing:.14em;text-transform:uppercase;',
    '}',
    '.cc-title{',
    '  margin:0;color:#f2f5f3;font-size:clamp(22px,3vw,30px);',
    '  font-weight:650;line-height:1.15;letter-spacing:0;',
    '}',
    '.cc-text{',
    '  margin:0;max-width:52ch;font-size:14px;line-height:1.65;',
    '  color:rgba(226,236,237,.68);',
    '}',
    '.cc-text a{color:rgba(127,200,194,.95);text-underline-offset:3px;}',
    '.cc-actions{',
    '  display:flex;justify-content:flex-end;align-items:center;gap:10px;padding-top:4px;',
    '}',
    '.cc-btn{',
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
    '  from{transform:translateY(12px) scale(.98);opacity:0}',
    '  to{transform:translateY(0) scale(1);opacity:1}',
    '}',
    '.cc-banner.cc-hiding{animation:ccFadeOut .28s ease forwards;pointer-events:none;}',
    '@keyframes ccFadeOut{from{opacity:1}to{opacity:0}}',
    '@media(max-width:600px){',
    '  .cc-inner{gap:20px;padding:24px;border-radius:16px}',
    '  .cc-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}',
    '  .cc-btn{width:100%}',
    '}',
    '@media(prefers-reduced-motion:reduce){',
    '  .cc-banner,.cc-inner{animation-duration:.01ms;animation-delay:0;}',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  var banner = document.createElement('div');
  banner.className = 'cc-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-modal', 'true');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML =
    '<div class="cc-inner">' +
      '<div class="cc-heading">' +
        '<span class="cc-eyebrow">Privacy controls</span>' +
        '<h2 class="cc-title">Your workspace, your choice</h2>' +
      '</div>' +
      '<p class="cc-text">' +
        'This site uses third-party services (Google Fonts, YouTube) that may collect data. ' +
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
  Array.prototype.forEach.call(document.body.children, function (element) {
    if (element !== banner) {
      element.inert = true;
      element.setAttribute('data-cc-inert', '');
    }
  });

  function dismiss(choice) {
    try { localStorage.setItem(STORAGE_KEY, choice); } catch (_) { /* Safari: storage blocked */ }
    document.documentElement.classList.remove('cc-consent-open');
    document.body.classList.remove('cc-consent-open');
    Array.prototype.forEach.call(document.querySelectorAll('[data-cc-inert]'), function (element) {
      element.inert = false;
      element.removeAttribute('data-cc-inert');
    });
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
