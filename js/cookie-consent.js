/* Cookie Consent Banner — TimrX
   Self-contained: injects its own styles + HTML.
   Include once on any page: <script src="js/cookie-consent.js" defer></script>
   Stores preference in localStorage (not a cookie itself). */

   (function () {
    'use strict';
  
    var STORAGE_KEY = 'timrx_cookie_consent';
    var stored;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (_) { /* Safari: storage blocked */ }
  
    // Already consented or declined — nothing to show
    if (stored === 'accepted' || stored === 'declined') return;
  
    // Inject styles
    var style = document.createElement('style');
    style.textContent = [
      '.cc-banner{',
      '  position:fixed;bottom:0;left:0;right:0;z-index:9999;',
      '  background:rgba(12,12,12,0.96);',
      '  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);',
      '  border-top:1px solid rgba(255,255,255,0.06);',
      '  padding:20px var(--gutter,20px);',
      '  transform:translateY(100%);',
      '  animation:ccSlideUp .45s cubic-bezier(.22,.61,.36,1) .5s forwards;',
      '}',
      '.cc-inner{',
      '  max-width:960px;margin:0 auto;',
      '  display:flex;align-items:center;gap:20px;flex-wrap:wrap;',
      '}',
      '.cc-text{',
      '  flex:1;min-width:240px;',
      '  font-size:13px;line-height:1.6;',
      '  color:rgba(255,255,255,0.55);',
      '}',
      '.cc-text a{',
      '  color:rgba(255,255,255,0.75);text-underline-offset:3px;',
      '}',
      '.cc-actions{',
      '  display:flex;gap:8px;flex-shrink:0;',
      '}',
      '.cc-btn{',
      '  padding:9px 20px;border-radius:6px;',
      '  font-size:12px;font-weight:600;letter-spacing:.04em;',
      '  cursor:pointer;border:none;',
      '  transition:all .25s ease;',
      '  text-transform:uppercase;',
      '}',
      '.cc-btn-accept{',
      '  background:rgba(255,255,255,0.9);color:#0b0b0b;',
      '}',
      '.cc-btn-accept:hover{',
      '  background:#fff;transform:translateY(-1px);',
      '}',
      '.cc-btn-decline{',
      '  background:transparent;color:rgba(255,255,255,0.45);',
      '  border:1px solid rgba(255,255,255,0.1);',
      '}',
      '.cc-btn-decline:hover{',
      '  color:rgba(255,255,255,0.7);border-color:rgba(255,255,255,0.2);',
      '}',
      '@keyframes ccSlideUp{',
      '  from{transform:translateY(100%);opacity:0}',
      '  to{transform:translateY(0);opacity:1}',
      '}',
      '.cc-banner.cc-hiding{',
      '  animation:ccSlideDown .3s ease forwards;',
      '}',
      '@keyframes ccSlideDown{',
      '  from{transform:translateY(0);opacity:1}',
      '  to{transform:translateY(100%);opacity:0}',
      '}',
      '@media(max-width:600px){',
      '  .cc-inner{flex-direction:column;text-align:center}',
      '  .cc-actions{width:100%;justify-content:center}',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  
    // Inject banner HTML
    var banner = document.createElement('div');
    banner.className = 'cc-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
      '<div class="cc-inner">' +
        '<p class="cc-text">' +
          'This site uses third-party services (Google Fonts, YouTube) that may collect data. ' +
          '<a href="/cookies">Learn more</a>' +
        '</p>' +
        '<div class="cc-actions">' +
          '<button class="cc-btn cc-btn-decline" id="ccDecline">Decline</button>' +
          '<button class="cc-btn cc-btn-accept" id="ccAccept">Accept</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);
  
    function dismiss(choice) {
      try { localStorage.setItem(STORAGE_KEY, choice); } catch (_) { /* Safari: storage blocked */ }
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
  