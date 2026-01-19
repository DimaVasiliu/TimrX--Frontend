/* =========================================================
   TimrX — App script
   - GSAP scroll & hover motion
   - Brand swap on scroll
   - Works & Services animations
   - Hero intro choreography
   - Chat + Contact helpers
   - App3D viewer UI + background FX
   ========================================================= */
   (() => {
    /* ------------------------------
       0) Setup & helpers
       ------------------------------ */
  
    // Is GSAP available? If yes, register ScrollTrigger once.
    const hasGSAP = !!window.gsap && !!window.ScrollTrigger;
    if (hasGSAP) {
      gsap.registerPlugin(ScrollTrigger);
    }
  
    // Small DOM helper
    const byId = (id) => document.getElementById(id);
  
    // Placeholder toggle for the 3D viewer (kept for completeness)
    let viewerPlaceholder;
    function updatePlaceholder(visible = true) {
      const el = viewerPlaceholder;
      if (!el) return;
      requestAnimationFrame(() => (el.style.opacity = visible ? 0.9 : 0));
    }
  
    /* ------------------------------
       1) Brand swap on scroll
       - Locks brand width so nav doesn't shift
       - Swaps "TimrX" → "Dima Vasiliu" after hero
       ------------------------------ */
    (function brandSwap() {
      const brand = byId('brand');
      const tim   = byId('brandTim');
      const dima  = byId('brandDima');
      const hero  = byId('hero');
      if (!brand || !tim || !dima || !hero) return;
  
      function lockBrandWidth() {
        brand.style.width = Math.max(tim.offsetWidth, dima.offsetWidth) + 'px';
      }
      function swap(toDima) {
        // true = show “Dima Vasiliu”; false = show “TimrX”
        tim.classList.toggle('out',  toDima);
        dima.classList.toggle('out', !toDima);
      }
  
      window.addEventListener('load', lockBrandWidth);
      window.addEventListener('resize', lockBrandWidth);
      document.fonts?.ready.then(lockBrandWidth);
  
      if (hasGSAP) {
        ScrollTrigger.create({
          trigger: hero,
          start: 'bottom top+=10%',
          onEnter:     () => swap(true),
          onLeaveBack: () => swap(false),
        });
        const past = hero.getBoundingClientRect().bottom <= window.innerHeight * 0.9;
        swap(past);
      } else {
        // Simple fallback if GSAP isn't present
        const io = new IntersectionObserver(
          ([e]) => swap(!e.isIntersecting),
          { rootMargin: '10% 0px 0px 0px', threshold: 0 }
        );
        io.observe(hero);
      }
    })();
  
/* ------------------------------
   2) ABOUT section motion (revamped)
   - Title rises from bottom on scroll
   - Left note + right cards slide in
   - Stats count up when visible
   ------------------------------ */
   (function aboutMotion() {
    const hasGSAP = !!window.gsap && !!window.ScrollTrigger;
    const title = document.getElementById('aboutTitle');
    const plates = document.querySelectorAll('.about-plate');
    const leftNote = document.querySelector('.about-left-note');
    const statsWrap = document.getElementById('aboutStats');
    const statNums = statsWrap ? [...statsWrap.querySelectorAll('.stat-number')] : [];
  
    // helper: count up once
    let counted = false;
    function runCounters() {
      if (counted || !statNums.length) return;
      counted = true;
      statNums.forEach(el => {
        const target = Number(el.getAttribute('data-count') || 0);
        const dur = 900; // ms
        const t0 = performance.now();
        function tick(t){
          const k = Math.min(1, (t - t0) / dur);
          const val = Math.floor(target * (0.1 + 0.9 * (k*k*(3 - 2*k)))); // smoothstep-ish
          el.textContent = val.toLocaleString();
          if (k < 1) requestAnimationFrame(tick);
          else el.textContent = target.toLocaleString();
        }
        requestAnimationFrame(tick);
      });
    }
  
    if (hasGSAP) {
      gsap.registerPlugin(ScrollTrigger);
  
      // Title: from bottom (we keep initial CSS transform/opacity on .about-title)
      gsap.to('.about-title', {
        y: 0, opacity: 1,
        ease: 'power3.out', duration: 0.9,
        scrollTrigger: { trigger: '#about', start: 'top 78%' }
      });
  
      // Kicker fade-in
      gsap.fromTo('.about-kicker', { autoAlpha: 0, y: 10 }, {
        autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out',
        scrollTrigger: { trigger: '#about', start: 'top 82%' }
      });
  
      // Left note + right plates
      gsap.fromTo(leftNote, { autoAlpha: 0, x: -16 }, {
        autoAlpha: 0.5, x: 0, duration: 0.6, ease: 'power2.out',
        scrollTrigger: { trigger: '#about', start: 'top 82%' }
      });
  
      gsap.from(plates, {
        autoAlpha: 0, x: 18, duration: 0.6, ease: 'power2.out', stagger: 0.08,
        scrollTrigger: { trigger: '#about', start: 'top 78%' }
      });
  
      // Stats (fade up + count)
      gsap.from('#about .about-stats .stat-item', {
        autoAlpha: 0, y: 14, duration: 0.5, ease: 'power2.out', stagger: 0.06,
        scrollTrigger: {
          trigger: statsWrap || '#about',
          start: 'top 78%',
          onEnter: runCounters,
        }
      });
    } else {
      // Fallback: minimal IO animations + counters
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            title && (title.style.cssText += 'opacity:1;transform:translateY(0)');
            leftNote && (leftNote.style.cssText += 'opacity:.5;transform:none');
            plates.forEach(p => (p.style.opacity = 1, p.style.transform = 'none'));
            runCounters();
          }
        });
      }, { rootMargin: '0px 0px -20% 0px', threshold: 0.1 });
      document.getElementById('about') && io.observe(document.getElementById('about'));
    }
  })();

    /* ------------------------------
       3) BLOGS section motion (enhanced compact header + cards)
       ------------------------------ */
    (function blogsMotion() {
      if (!hasGSAP) return;

      // Left column: Badge slides in from left with scale
      gsap.set('.blogs-badge', { autoAlpha: 0, x: -20, scale: 0.9 });
      gsap.to('.blogs-badge', {
        autoAlpha: 1, x: 0, scale: 1,
        duration: 0.6, ease: 'back.out(1.7)',
        scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
      });

      // Title fades up with powerful entrance
      gsap.set('.blogs-title', { autoAlpha: 0, y: 30 });
      gsap.to('.blogs-title', {
        autoAlpha: 1, y: 0,
        duration: 0.8, ease: 'power3.out',
        scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
      });

      // Subtitle fades in smoothly
      gsap.set('.blogs-sub', { autoAlpha: 0, y: 20 });
      gsap.to('.blogs-sub', {
        autoAlpha: 1, y: 0,
        duration: 0.7, delay: 0.2, ease: 'power2.out',
        scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
      });

      // Right column: Tagline slides from right with fade
      gsap.set('.blogs-tagline', { autoAlpha: 0, x: 30 });
      gsap.to('.blogs-tagline', {
        autoAlpha: 1, x: 0,
        duration: 0.6, delay: 0.3, ease: 'power2.out',
        scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
      });

      // Stats box: scale + fade from right
      gsap.set('.blogs-stats', { autoAlpha: 0, x: 40, scale: 0.95 });
      gsap.to('.blogs-stats', {
        autoAlpha: 1, x: 0, scale: 1,
        duration: 0.7, delay: 0.45, ease: 'back.out(1.4)',
        scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
      });

      // Individual stat items cascade in
      gsap.utils.toArray('.blogs-stats .stat-item').forEach((el, i) => {
        gsap.set(el, { autoAlpha: 0, x: 20 });
        gsap.to(el, {
          autoAlpha: 1, x: 0,
          duration: 0.5, delay: 0.6 + (i * 0.1), ease: 'power2.out',
          scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
        });
      });

      // View all button bounces in
      gsap.set('.blogs-view-all', { autoAlpha: 0, y: 20 });
      gsap.to('.blogs-view-all', {
        autoAlpha: 1, y: 0,
        duration: 0.6, delay: 0.9, ease: 'back.out(2)',
        scrollTrigger: { trigger: '#blogs', start: 'top 75%' }
      });

      // Blog cards: enhanced stagger with scale
      gsap.utils.toArray('.blog-card').forEach((el, i) => {
        gsap.set(el, { autoAlpha: 0, y: 30, scale: 0.95 });
        gsap.to(el, {
          autoAlpha: 1, y: 0, scale: 1,
          duration: 0.6, delay: i * 0.08, ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 85%' }
        });

        // Add subtle hover lift effect via GSAP
        el.addEventListener('mouseenter', () => {
          gsap.to(el, { y: -8, duration: 0.4, ease: 'power2.out' });
        });
        el.addEventListener('mouseleave', () => {
          gsap.to(el, { y: 0, duration: 0.4, ease: 'power2.out' });
        });
      });
    })();

    /* ------------------------------
       4) WORKS grid
       - Staggered entrance on scroll
       - Subtle 3D tilt on hover
       - Auto-zoom nudge for tall images
       ------------------------------ */
    (function worksGrid() {
      // Entrance + tilt
      if (hasGSAP) {
        gsap.utils.toArray('.work').forEach((el, i) => {
          // entrance
          gsap.from(el, {
            opacity: 0,
            y: 18,
            duration: 0.55,
            delay: i * 0.03,
            ease: 'power2.out',
            scrollTrigger: { trigger: el, start: 'top 85%' }
          });
  
          // pointer tilt (gentle)
          const max = 6; // degrees
          function onMove(e) {
            const r = el.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width  - 0.5;
            const y = (e.clientY - r.top)  / r.height - 0.5;
            el.style.transform = `translateY(-4px) rotateX(${y*max}deg) rotateY(${-x*max}deg)`;
          }
          function onLeave() { el.style.transform = ''; }
          el.addEventListener('pointermove', onMove);
          el.addEventListener('pointerleave', onLeave);
        });
      }
  
      // Auto-zoom nudge for portrait-ish images so they don't look smaller
      document.querySelectorAll('.work .thumb img').forEach((img) => {
        if (img.complete) tune(); else img.addEventListener('load', tune, { once: true });
        function tune(){
          const r = img.naturalWidth / img.naturalHeight;
          const base = parseFloat(getComputedStyle(img).getPropertyValue('--zoom')) || 1.10;
          const bump = r < 1.5 ? 0.03 : 0.00; // small bump for tall images
          img.style.setProperty('--zoom', (base + bump).toFixed(2));
        }
      });
    })();
  
    /* ------------------------------
       4) SERVICES grid
       - Staggered entrance
       - Micro tilt on hover (lighter than Works)
       ------------------------------ */
    (function servicesGrid() {
      if (!hasGSAP) return;
  
      gsap.utils.toArray('.service-card').forEach((el, i) => {
        // entrance
        gsap.from(el, {
          opacity: 0,
          y: 16,
          duration: 0.5,
          delay: i * 0.04,
          ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 88%' }
        });
  
        // micro tilt
        const max = 4;
        function onMove(e) {
          const r = el.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width  - 0.5;
          const y = (e.clientY - r.top)  / r.height - 0.5;
          el.style.transform = `translateY(-4px) rotateX(${y*max}deg) rotateY(${-x*max}deg)`;
        }
        function onLeave(){ el.style.transform = ''; }
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerleave', onLeave);
      });
    })();

    // CONTACT: reveal info cards + form fields
    (function contactMotion(){
      if (!window.gsap || !window.ScrollTrigger) return;

      // left side
      gsap.from('.contact-info .info-card', {
        opacity: 0, y: 14, duration: 0.45, ease: 'power2.out',
        stagger: 0.08,
        scrollTrigger: { trigger: '.contact-info', start: 'top 85%' }
      });

      // right side (form fields)
      gsap.from('#contactForm .field, #contactForm .chips, #contactForm .submit', {
        opacity: 0, y: 14, duration: 0.45, ease: 'power2.out',
        stagger: 0.06,
        scrollTrigger: { trigger: '#contactForm', start: 'top 85%' }
      });
    })();

    gsap.utils.toArray('.info-card').forEach(el=>{
      const k = 3; // degrees
      function move(e){
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left)/r.width - .5;
        const y = (e.clientY - r.top)/r.height - .5;
        el.style.transform = `translateY(-2px) rotateX(${y*k}deg) rotateY(${-x*k}deg)`;
      }
      function leave(){ el.style.transform = ''; }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerleave', leave);
    });

    // CONTACT: cap badges + form reveal
    (function contactCapMotion(){
      if (!window.gsap || !window.ScrollTrigger) return;

      // badges
      gsap.from('.contact-badges .kbadge', {
        opacity:0, y:8, duration:.35, ease:'power2.out',
        stagger:.06, scrollTrigger:{ trigger:'.contact-badges', start:'top 90%' }
      });

      // form card slight lift
      gsap.from('.contact-card', {
        opacity:0, y:14, duration:.45, ease:'power2.out',
        scrollTrigger:{ trigger:'.contact-card', start:'top 88%' }
      });
    })();
  
    /* ------------------------------
       5) HERO intro choreography
       - Runs on window load so fonts/images are ready
       ------------------------------ */
    window.addEventListener('load', () => {
      if (!hasGSAP) return;
  
      gsap.set('.hero-photo .portrait', { autoAlpha: 0, y: 20 });
      gsap.set('#heroTitle',            { autoAlpha: 0, y: 30 });
      gsap.set('.hero-list',            { autoAlpha: 0, y: 20 });
      gsap.set('.hero-list li',         { autoAlpha: 0, y: 10 });
      gsap.set('.hero-cta .btn',        { autoAlpha: 0, y: 8  });
  
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      tl.to('.hero-photo .portrait', { autoAlpha: 1, y: 0, duration: 0.7 })
        .to('#heroTitle',            { autoAlpha: 1, y: 0, duration: 0.6 }, '-=0.2')
        .to('.hero-list',            { autoAlpha: 1, y: 0, duration: 0.5 }, '-=0.3')
        .to('.hero-list li',         { autoAlpha: 1, y: 0, duration: 0.45, stagger: 0.06 }, '-=0.1')
        .to('.hero-cta .btn',        { autoAlpha: 1, y: 0, duration: 0.40, stagger: 0.06 }, '-=0.2');
  
      window.ScrollTrigger?.refresh();
    });
  
    /* ------------------------------
       6) Budget chips UI (toggles radio visually)
       ------------------------------ */
    (function budgetChips() {
      const wrap = byId('budgetChips');
      if (!wrap) return;
      wrap.addEventListener('click', (e) => {
        const lab = e.target.closest('.chip'); 
        if (!lab) return;
        wrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        lab.classList.add('active');
        lab.querySelector('input').checked = true;
      });
    })();
  
    /* ------------------------------
       7) Contact form front-end feedback
       ------------------------------ */
    (function contactForm() {
      const form = byId('contactForm');
      if (!form) return;
  
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const data = new FormData(form);
        if (!data.get('budget') || !data.get('name') || !data.get('email') || !data.get('message')) {
          return note('Please fill the required fields (budget, name, email, message).');
        }
        note("Thanks — I'll reply within 24–48h.");
        form.reset();
        byId('budgetChips')?.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      });
  
      function note(msg) {
        const n = byId('formNote');
        if (n) n.textContent = msg;
      }
    })();
  
/* ------------------------------
   8) Chat widget (final)
   - streaming when API is up
   - auto-fallback to JSON
   - final fallback to local canned answers
   - FAQ suggestions under input
   ------------------------------ */
/* ------------------------------
   8) Chat widget (Nova — hardened)
   ------------------------------ */
   (function chatNova(){
    const chatToggle = document.getElementById('chatToggle');
    const chatPanel  = document.getElementById('chatPanel');
    const chatClose  = document.getElementById('chatClose');
    const chatSend   = document.getElementById('chatSend');
    const chatInput  = document.getElementById('chatInput');
    const chatBody   = document.getElementById('chatBody');
  
    if (!chatToggle || !chatPanel) return;
  
    // One-time hello flash (optional)
    chatToggle.classList.add('is-attract');
    setTimeout(() => chatToggle.classList.remove('is-attract'), 1200);
  
    // --- FAQ suggestions strip (auto-created above input bar)
    let suggest = document.getElementById('chatSuggest');
    if (!suggest) {
      suggest = document.createElement('div');
      suggest.id = 'chatSuggest';
      suggest.className = 'chat-suggest';
      const bar = chatPanel.querySelector('.chat-inputbar');
      if (bar && bar.parentNode) bar.parentNode.insertBefore(suggest, bar);
    }
    suggest.innerHTML = '<div class="hint">Suggestions</div><div class="list"></div>';
    const suggestList = suggest.querySelector('.list');
  
    // Debounced FAQ fetch
    let debounceId = null;
    let faqAbort = { aborted:false };
    const hideSuggest = () => { suggest.style.display = 'none'; suggestList.innerHTML=''; };
    const showSuggest = () => { suggest.style.display = 'block'; };

    // Smooth, reliable "stick to bottom"
    function scrollToBottom() {
      // do it twice with rAF to catch layout reflows during streaming
      requestAnimationFrame(() => {
        chatBody.scrollTop = chatBody.scrollHeight;
        requestAnimationFrame(() => {
          chatBody.scrollTop = chatBody.scrollHeight;
        });
      });
    }
  
    function renderSuggest(items){
      if (!items || !items.length) { hideSuggest(); return; }
      suggestList.innerHTML = '';
      for (const it of items){
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'item';
        b.title = it.a || it.q;
        b.textContent = it.q;
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation(); // prevent outside-closer from firing
          chatInput.value = it.q;
          hideSuggest();
          sendMsg();
        });
        suggestList.appendChild(b);
      }
      showSuggest();
    }
  
    async function querySuggest(q){
      faqAbort.aborted = true; faqAbort = { aborted:false };
      const token = faqAbort;
      try{
        const list = await (window.timrxFaqSearch?.(q) ?? Promise.resolve([]));
        if (token.aborted) return;
        renderSuggest(list);
      } catch { hideSuggest(); }
    }
  
    chatInput?.addEventListener('input', () => {
      const v = (chatInput.value || '').trim();
      if (v.length < 3) return hideSuggest();
      clearTimeout(debounceId);
      debounceId = setTimeout(() => querySuggest(v), 220);
    });
  
    // --- Open/Close (Esc, safe outside, debounce)
    const isOpen = () => chatPanel.style.display === 'grid';
  
    function openChat(){
      firstOpen = true;
      chatPanel.style.display = 'grid';
      chatInput?.focus();
      scrollToBottom();
    }
    function closeChat(){
      chatPanel.style.display = 'none';
      chatToggle.setAttribute('aria-expanded', 'false');
      hideSuggest();
    }
  
    // Toggle debounce to avoid double toggles on fast taps
    let toggleLock = false;
    function safeToggle(){
      if (toggleLock) return;
      toggleLock = true;
      isOpen() ? closeChat() : openChat();
      setTimeout(()=>{ toggleLock = false; }, 180);
    }
    chatToggle.addEventListener('click', (e) => { e.preventDefault(); safeToggle(); });
  
    chatClose?.addEventListener('click', (e)=>{ e.preventDefault(); closeChat(); });
  
    document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeChat(); });
  
    // Safe outside close using mousedown/touchstart + composedPath
    const outsideStart = (e) => {
      if (!isOpen()) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const hitPanel  = path.includes(chatPanel)  || chatPanel.contains(e.target);
      const hitToggle = path.includes(chatToggle) || chatToggle.contains(e.target);
      if (!hitPanel && !hitToggle) closeChat();
    };
    document.addEventListener('mousedown', outsideStart, true);
    document.addEventListener('touchstart', outsideStart, { passive:true, capture:true });
  
    // Also stop events at the panel root so nothing bubbles up to document
    ['mousedown','touchstart'].forEach(evt => {
      chatPanel.addEventListener(evt, (e) => e.stopPropagation(), true);
    });
  
    // --- Quick replies (single delegated listener + stopPropagation)
    document.querySelector('.chat-quick')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.q'); if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      chatInput.value = btn.textContent.trim();
      sendMsg();
    });
  
    // Enter to send (Shift+Enter = newline)
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); sendMsg(); return; }
      if (e.key === 'Escape') hideSuggest();
    }, true);
  // Make sure Send works even if something else captures/bubbles
    chatSend?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); sendMsg(); }, true);
  
    // --- Conversation + bubbles
    const convo = [];
    function addBubble(text, me=false){
      const d = document.createElement('div');
      d.className = 'msg' + (me ? ' me' : '');
      d.textContent = text;
      chatBody.appendChild(d);
      scrollToBottom();
      return d;
    }
    function addTyping(){
      const d = document.createElement('div');
      d.className = 'msg typing';
      d.innerHTML = '<span class="d"></span><span class="d"></span><span class="d"></span>';
      chatBody.appendChild(d);
      scrollToBottom();
      return d;
    }
  
    // --- Send & stream
    async function sendMsg(){
      const v = (chatInput.value || '').trim();
      if (!v) return;
  
      hideSuggest();
      addBubble(v, true);
      convo.push({ role: 'user', content: v });
      chatInput.value = '';
  
      const typing = addTyping();
  
      try{
        let bot = null;
        const final = await (window.timrxAsk?.(convo, (streamText) => {
          if (!bot){
            bot = document.createElement('div');
            bot.className = 'msg';
            typing.replaceWith(bot);
          }
          bot.textContent = streamText;
          scrollToBottom();             // <--
        }) ?? Promise.resolve('Assistant is not ready.'));
  
        if (!bot){
          bot = document.createElement('div');
          bot.className = 'msg';
          typing.replaceWith(bot);
        }
        bot.textContent = final;
        convo.push({ role: 'assistant', content: final });
        scrollToBottom();               
      } catch (e){
        console.error('chat error', e);
        const err = document.createElement('div');
        err.className = 'msg';
        err.textContent = 'Sorry—something went wrong. Please try again.';
        typing.replaceWith(err);
      }
    }
  
    // Optional: open chat from [data-open-chat]
    document.querySelectorAll('[data-open-chat]').forEach(a=>{
      a.addEventListener('click', (e)=>{ e.preventDefault(); safeToggle(); });
    });
  
    // --- Attention: orbit ping every ~12s until first open
    let firstOpen = false;
    let attractTimer = setInterval(() => {
      if (isOpen()) firstOpen = true;
      if (firstOpen) { clearInterval(attractTimer); return; }
      chatToggle.classList.add('is-attract');
      setTimeout(() => chatToggle.classList.remove('is-attract'), 1800);
    }, 12000);
  })();
  
    /* ------------------------------
       9) Viewer settings pill (auto-rotate toggle)
       ------------------------------ */
    (function viewerSettings() {
      const gear         = byId('viewerGear');
      const rotateCard   = byId('viewerRotateCard');
      const rotateToggle = byId('rotateToggle');
  
      // Open / close pill
      gear?.addEventListener('click', () => {
        if (!rotateCard) return;
        if (window.viewerControls) rotateToggle.checked = !!window.viewerControls.autoRotate;
        rotateCard.classList.toggle('hidden');
      });
  
      // Toggle auto-rotate and hide pill
      rotateToggle?.addEventListener('change', (e) => {
        if (window.viewerControls) window.viewerControls.autoRotate = !!e.target.checked;
        requestAnimationFrame(() => rotateCard?.classList.add('hidden'));
      });
  
      // Close on outside click or Esc
      document.addEventListener('click', (e) => {
        if (!rotateCard || rotateCard.classList.contains('hidden')) return;
        const insidePill = rotateCard.contains(e.target);
        const onGear     = gear?.contains(e.target);
        if (!insidePill && !onGear) rotateCard.classList.add('hidden');
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') rotateCard?.classList.add('hidden');
      });
    })();
  
    /* ------------------------------
       10) App3D background FX (parallax glows)
       ------------------------------ */
    (function app3dFx() {
      const host   = document.querySelector('.app3d-grid');
      const canvas = byId('app3dFx');
      if (!host || !canvas) return;
  
      const ctx = canvas.getContext('2d', { alpha: true });
      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      let W = 0, H = 0, t = 0;
  
      // Tunables for the ambient glow particles
      const FX = {
        COUNT: 96,
        SPEED: 1.35,
        PARALLAX: 52,
        COLUMN_PARALLAX: 14,
        RMIN: 80,
        RMAX: 220,
        EASE: 0.15
      };
  
      const palette = [
        'rgba(96,165,250,0.15)',   // sky
        'rgba(167,139,250,0.16)',  // violet
        'rgba(52,211,153,0.14)',   // teal
        'rgba(245,158,11,0.12)'    // amber
      ];
  
      const dots = [];
      let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
  
      function rand(a,b){ return a + Math.random()*(b-a); }
  
      // Resize canvas to the host bounds (retina aware)
      function resize(){
        const r = host.getBoundingClientRect();
        W = Math.max(1, (r.width  * dpr)|0);
        H = Math.max(1, (r.height * dpr)|0);
        canvas.width = W; canvas.height = H;
        canvas.style.width  = r.width  + 'px';
        canvas.style.height = r.height + 'px';
      }
  
      // (Re)generate particles
      function make(){
        dots.length = 0;
        for(let i=0;i<FX.COUNT;i++){
          const z = rand(0.35, 1); // “depth”: near = 1, far = 0.35
          dots.push({
            x: rand(0, W),
            y: rand(0, H),
            r: rand(FX.RMIN, FX.RMAX) * dpr * z,
            s: rand(.6, 1.6),
            wobble: rand(1.1, 2.0),
            z,
            hue: palette[(Math.random()*palette.length)|0],
            phase: rand(0, Math.PI*2)
          });
        }
      }
  
      // Draw loop
      function draw(){
        t += 0.009 * FX.SPEED;
        mouseX += (targetX - mouseX) * FX.EASE;
        mouseY += (targetY - mouseY) * FX.EASE;
  
        ctx.clearRect(0,0,W,H);
        ctx.globalCompositeOperation = 'lighter';
  
        for(const p of dots){
          const amp = (70 + 90*(1-p.z)) * dpr;
          const ox = Math.sin(t*p.s + p.phase) * p.wobble * amp;
          const oy = Math.cos(t*p.s*0.9 + p.phase*1.3) * p.wobble * amp*0.7;
  
          const px = (p.x + ox) + mouseX * (FX.PARALLAX * p.z) * dpr;
          const py = (p.y + oy) + mouseY * (FX.PARALLAX * p.z) * dpr;
  
          const grd = ctx.createRadialGradient(px, py, 0, px, py, p.r);
          grd.addColorStop(0, p.hue);
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(px, py, p.r, 0, Math.PI*2);
          ctx.fill();
        }
        requestAnimationFrame(draw);
      }
  
      // Pointer parallax + slight column parallax for the two main columns
      function onMove(e){
        const r = host.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width  - 0.5;
        const y = (e.clientY - r.top)  / r.height - 0.5;
        targetX = x; targetY = y;
  
        const left  = host.querySelector('.viewer-canvas-wrapper');
        const right = host.querySelector('.app3d-copy');
        const k = FX.COLUMN_PARALLAX;
        if (left)  left.style.transform  = `translate3d(${-x*k}px, ${-y*k}px, 0)`;
        if (right) right.style.transform = `translate3d(${ x*k}px, ${ y*k}px, 0)`;
      }
      function onLeave(){ targetX = targetY = 0; }
  
      // Init
      resize(); make(); draw();
      window.addEventListener('resize', () => { dpr = Math.min(window.devicePixelRatio||1, 2); resize(); make(); });
      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerleave', onLeave);
    })();

               /* NAV top-sheet controller (minimal) */
(() => {
  const burger = document.getElementById('navBurger');
  const sheet  = document.getElementById('navSheet');
  const dim    = document.getElementById('navDim');
  if (!burger || !sheet || !dim) return;

  const open = () => {
    sheet.hidden = false; dim.hidden = false;
    requestAnimationFrame(() => {
      sheet.classList.add('open');
      burger.setAttribute('aria-expanded','true');
      document.body.style.overflow = 'hidden';
    });
  };
  const close = () => {
    sheet.classList.remove('open');
    burger.setAttribute('aria-expanded','false');
    document.body.style.overflow = '';
    sheet.addEventListener('transitionend', () => {
      if (!sheet.classList.contains('open')) sheet.hidden = true;
    }, { once:true });
    dim.hidden = true;
  };

  burger.addEventListener('click', () => {
    (sheet.hidden || !sheet.classList.contains('open')) ? open() : close();
  });
  dim.addEventListener('click', close);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // close on any menu link click
  sheet.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) close();
  });
})();
  
  })(); // end IIFE

  // Give hash targets focus after smooth scroll (accessibility nicety)
  (function anchorFocus(){
    document.querySelectorAll('a[href^="#"]').forEach(a=>{
      a.addEventListener('click', (e)=>{
        const id = a.getAttribute('href').slice(1);
        if (!id) return;
        const t = document.getElementById(id);
        if (!t) return;
        // allow native smooth-scroll via CSS to run
        setTimeout(()=>{ 
          t.setAttribute('tabindex','-1'); 
          t.focus({ preventScroll:true });
        }, 350);
      });
    });
  })();

      // Enable/disable global click lock
    window.enablePageLock = function(){
      document.documentElement.classList.add('locked');
    };
    window.disablePageLock = function(){
      document.documentElement.classList.remove('locked');
    };

    // ESC to unlock (safety)
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') window.disablePageLock();
    });

    (function(){
      const now = new Date().getFullYear();
      const el = document.getElementById('year');
      if (el) el.textContent = now;
    })();
