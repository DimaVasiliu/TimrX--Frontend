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
const pills = [...slider.querySelectorAll('.pill')];
let i = 0; let timer = null;
function cycle(){ pills.forEach(p=>p.classList.remove('active')); pills[i%pills.length].classList.add('active'); i++; }
function start(){ timer = setInterval(cycle, 2400); }
function stop(){ clearInterval(timer); }
pills.forEach(p=> p.addEventListener('click', ()=>{ location.hash = p.dataset.to || '#features'; }));
start();

// Modals
const loginOpen = document.getElementById('loginOpen');
const signupOpen = document.getElementById('signupOpen');
const loginModal = document.getElementById('loginModal');
const signupModal = document.getElementById('signupModal');
const loginClose = document.getElementById('loginClose');
const signupClose = document.getElementById('signupClose');
loginOpen?.addEventListener('click', (e)=>{ e.preventDefault(); loginModal.classList.add('open'); });
signupOpen?.addEventListener('click', (e)=>{ e.preventDefault(); signupModal.classList.add('open'); });
loginClose?.addEventListener('click', (e)=>{ e.preventDefault(); loginModal.classList.remove('open'); });
signupClose?.addEventListener('click', (e)=>{ e.preventDefault(); signupModal.classList.remove('open'); });
[loginModal, signupModal].forEach(m=> m?.addEventListener('click', (e)=>{ if(e.target===m) m.classList.remove('open'); }));

// =================== MODALS (drop-in) ===================
(function(){
    const qs  = (s, r=document) => r.querySelector(s);
    const qsa = (s, r=document) => [...r.querySelectorAll(s)];
  
    const modals = {
      login:  qs('#loginModal'),
      signup: qs('#signupModal'),
    };
  
    let lastFocus = null;
    let trapPrev = null;
  
    function openModal(which){
      const m = modals[which];
      if (!m) return;
  
      // close others first
      qsa('.modal.open').forEach(x => x !== m && closeModal(x));
  
      lastFocus = document.activeElement;
      m.classList.add('open');
      m.setAttribute('aria-hidden','false');
      trapFocus(m);
  
      const first = qs('input,button,[href],[tabindex]:not([tabindex="-1"])', m);
      if (first) first.focus();
    }
  
    function closeModal(m){
      if (!m) return;
      m.classList.remove('open');
      m.setAttribute('aria-hidden','true');
      releaseFocus();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
  
    // Backdrop click (ignore clicks inside the card)
    qsa('.modal').forEach(m=>{
      m.addEventListener('mousedown', (e)=>{
        const card = qs('.card', m);
        if (!card.contains(e.target)) closeModal(m);
      });
    });
  
    // Close buttons (X + primary CTA)
    qs('#loginClose')?.addEventListener('click', e=>{ e.preventDefault(); closeModal(modals.login); });
    qs('#signupClose')?.addEventListener('click', e=>{ e.preventDefault(); closeModal(modals.signup); });
    qs('#loginCloseX')?.addEventListener('click', e=>{ e.preventDefault(); closeModal(modals.login); });
    qs('#signupCloseX')?.addEventListener('click', e=>{ e.preventDefault(); closeModal(modals.signup); });
  
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
  
    // One-time auto-open (signup) per visitor
    (function openOnce(){
      const KEY = 'tx_seen_modal_v1';
      if (localStorage.getItem(KEY)) return;
      const go = () => {
        const trigger = document.querySelector('[data-open="signup"]') || document.querySelector('[data-open="login"]');
        if (trigger){
          trigger.dispatchEvent(new Event('click', { bubbles:true, cancelable:true }));
          localStorage.setItem(KEY, '1');
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, {once:true});
      else go();
    })();
  
    // Optional: stub for OAuth buttons
    document.querySelectorAll('.oauth-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> alert('OAuth flow goes here.'));
    });
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

// Burger menu login/signup handlers
(function() {
  const burgerLogin = document.getElementById('burgerLogin');
  const burgerSignup = document.getElementById('burgerSignup');
  const loginModal = document.getElementById('loginModal');
  const signupModal = document.getElementById('signupModal');

  burgerLogin?.addEventListener('click', (e) => {
    e.preventDefault();
    loginModal?.classList.add('open');
    // Close burger menu
    document.getElementById('burgerMenu')?.classList.remove('active');
    document.getElementById('burgerOverlay')?.classList.remove('active');
    document.getElementById('burgerBtn')?.classList.remove('active');
  });

  burgerSignup?.addEventListener('click', (e) => {
    e.preventDefault();
    signupModal?.classList.add('open');
    // Close burger menu
    document.getElementById('burgerMenu')?.classList.remove('active');
    document.getElementById('burgerOverlay')?.classList.remove('active');
    document.getElementById('burgerBtn')?.classList.remove('active');
  });
})();

// Brand swap animation (TimrX <-> Dima Vasiliu)
(function brandSwap() {
  const brand = document.getElementById('brand');
  const tim = document.getElementById('brandTim');
  const dima = document.getElementById('brandDima');
  const hero = document.querySelector('header');

  if (!brand || !tim || !dima || !hero) return;

  function lockBrandWidth() {
    brand.style.width = Math.max(tim.offsetWidth, dima.offsetWidth) + 'px';
  }

  function swap(toDima) {
    tim.classList.toggle('out', toDima);
    dima.classList.toggle('out', !toDima);
  }

  window.addEventListener('load', lockBrandWidth);
  window.addEventListener('resize', lockBrandWidth);
  document.fonts?.ready.then(lockBrandWidth);

  // Simple scroll-based swap (no GSAP needed)
  let swapped = false;
  window.addEventListener('scroll', () => {
    const heroBottom = hero.getBoundingClientRect().bottom;
    const shouldSwap = heroBottom <= window.innerHeight * 0.1;

    if (shouldSwap && !swapped) {
      swap(true);
      swapped = true;
    } else if (!shouldSwap && swapped) {
      swap(false);
      swapped = false;
    }
  });

  // Check initial state
  const heroBottom = hero.getBoundingClientRect().bottom;
  if (heroBottom <= window.innerHeight * 0.1) {
    swap(true);
    swapped = true;
  }
})();

// =================== COMMUNITY RESOURCE MODALS ===================
(function() {
  const tabs = document.querySelectorAll('.resource-tab[data-modal]');

  if (!tabs.length) return;

  // Open modal when tab is clicked
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const modalId = tab.dataset.modal;
      const modal = document.getElementById(modalId);
      if (modal) {
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      }
    });
  });

  // Close modal handlers
  function closeResourceModal(modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // Close button click
  document.querySelectorAll('.resource-modal [data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.resource-modal');
      if (modal) closeResourceModal(modal);
    });
  });

  // Backdrop click closes modal
  document.querySelectorAll('.resource-modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeResourceModal(modal);
    });
  });

  // ESC key closes any open resource modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openModal = document.querySelector('.resource-modal.open');
      if (openModal) closeResourceModal(openModal);
    }
  });

  // Copy button functionality for code snippets
  const copyBtns = document.querySelectorAll('.copy-btn');

  copyBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.copy;
      const codeEl = document.getElementById(targetId);

      if (!codeEl) return;

      const code = codeEl.textContent;

      try {
        await navigator.clipboard.writeText(code);
        btn.classList.add('copied');
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';

        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
        }, 2000);
      } catch (err) {
        console.warn('Copy failed:', err);
      }
    });
  });
})();
