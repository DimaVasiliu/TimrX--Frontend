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
    if (hasGSAP && !ScrollTrigger.__timrx) {
      gsap.registerPlugin(ScrollTrigger);
      ScrollTrigger.__timrx = true; // guard against duplicate registration
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
    const aboutSection = document.getElementById('about');
    if (!aboutSection) return;
    const title = document.getElementById('aboutTitle');
    const plates = aboutSection.querySelectorAll('.about-plate');
    const leftNote = aboutSection.querySelector('.about-left-note');
    const statsWrap = document.getElementById('aboutStats');
    const yearBadge = statsWrap ? statsWrap.querySelector('.about-year') : null;
    if (yearBadge) {
      const startYear = Number(yearBadge.getAttribute('data-start-year') || 0);
      if (startYear) {
        const years = Math.max(1, new Date().getFullYear() - startYear);
        yearBadge.textContent = `${years}Y+`;
      }
    }

  
    if (hasGSAP) {
      // Title: from bottom (we keep initial CSS transform/opacity on .about-title)
      if (title) {
        gsap.to(title, {
          y: 0, opacity: 1,
          ease: 'power3.out', duration: 0.9,
          scrollTrigger: { trigger: aboutSection, start: 'top 78%' }
        });
      }

      // Kicker fade-in
      const aboutKicker = document.querySelector('.about-kicker');
      if (aboutKicker) {
        gsap.fromTo(aboutKicker, { autoAlpha: 0, y: 10 }, {
          autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out',
          immediateRender: false,
          scrollTrigger: { trigger: aboutSection, start: 'top 82%', toggleActions: 'play none none none' }
        });
      }

      // Left note + right plates
      if (leftNote) {
        gsap.fromTo(leftNote, { autoAlpha: 0, x: -16 }, {
          autoAlpha: 0.5, x: 0, duration: 0.6, ease: 'power2.out',
          immediateRender: false,
          scrollTrigger: { trigger: aboutSection, start: 'top 82%', toggleActions: 'play none none none' }
        });
      }

      if (plates.length) {
        gsap.from(plates, {
          autoAlpha: 0, x: 18, duration: 0.6, ease: 'power2.out', stagger: 0.08,
          immediateRender: false,
          scrollTrigger: { trigger: aboutSection, start: 'top 78%', toggleActions: 'play none none none' }
        });
      }

      // Stats (fade up)
      const statItems = statsWrap ? statsWrap.querySelectorAll('.stat-item') : [];
      if (statItems.length) {
        gsap.from(statItems, {
          autoAlpha: 0, y: 14, duration: 0.5, ease: 'power2.out', stagger: 0.06,
          immediateRender: false,
          scrollTrigger: {
            trigger: statsWrap,
            start: 'top 78%',
            toggleActions: 'play none none none'
          }
        });
      }
    } else {
      // Fallback: minimal IO animations
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            title && (title.style.cssText += 'opacity:1;transform:translateY(0)');
            leftNote && (leftNote.style.cssText += 'opacity:.5;transform:none');
            plates.forEach(p => (p.style.opacity = 1, p.style.transform = 'none'));
          }
        });
      }, { rootMargin: '0px 0px -20% 0px', threshold: 0.1 });
      io.observe(aboutSection);
    }
  })();

    /* ------------------------------
       3) BLOGS section motion (enhanced compact header + cards)
       ------------------------------ */
    (function blogsMotion() {
      if (!hasGSAP) return;
      const blogs = document.getElementById('blogs');
      if (!blogs) return;

      // Left column: Badge slides in from left with scale
      const blogsBadge = blogs.querySelector('.blogs-badge');
      if (blogsBadge) {
        gsap.set(blogsBadge, { autoAlpha: 0, x: -20, scale: 0.9 });
        gsap.to(blogsBadge, {
          autoAlpha: 1, x: 0, scale: 1,
          duration: 0.6, ease: 'back.out(1.7)',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      }

      // Title fades up with powerful entrance
      const blogsTitle = blogs.querySelector('.blogs-title');
      if (blogsTitle) {
        gsap.set(blogsTitle, { autoAlpha: 0, y: 30 });
        gsap.to(blogsTitle, {
          autoAlpha: 1, y: 0,
          duration: 0.8, ease: 'power3.out',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      }

      // Subtitle fades in smoothly
      const blogsSub = blogs.querySelector('.blogs-sub');
      if (blogsSub) {
        gsap.set(blogsSub, { autoAlpha: 0, y: 20 });
        gsap.to(blogsSub, {
          autoAlpha: 1, y: 0,
          duration: 0.7, delay: 0.2, ease: 'power2.out',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      }

      // Right column: Tagline slides from right with fade
      const blogsTagline = blogs.querySelector('.blogs-tagline');
      if (blogsTagline) {
        gsap.set(blogsTagline, { autoAlpha: 0, x: 30 });
        gsap.to(blogsTagline, {
          autoAlpha: 1, x: 0,
          duration: 0.6, delay: 0.3, ease: 'power2.out',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      }

      // Stats box: scale + fade from right
      const blogsStats = blogs.querySelector('.blogs-stats');
      if (blogsStats) {
        gsap.set(blogsStats, { autoAlpha: 0, x: 40, scale: 0.95 });
        gsap.to(blogsStats, {
          autoAlpha: 1, x: 0, scale: 1,
          duration: 0.7, delay: 0.45, ease: 'back.out(1.4)',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      }

      // Individual stat items cascade in
      gsap.utils.toArray(blogs.querySelectorAll('.blogs-stats .stat-item')).forEach((el, i) => {
        gsap.set(el, { autoAlpha: 0, x: 20 });
        gsap.to(el, {
          autoAlpha: 1, x: 0,
          duration: 0.5, delay: 0.6 + (i * 0.1), ease: 'power2.out',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      });

      // View all button bounces in
      const blogsViewAll = blogs.querySelector('.blogs-view-all');
      if (blogsViewAll) {
        gsap.set(blogsViewAll, { autoAlpha: 0, y: 20 });
        gsap.to(blogsViewAll, {
          autoAlpha: 1, y: 0,
          duration: 0.6, delay: 0.9, ease: 'back.out(2)',
          scrollTrigger: { trigger: blogs, start: 'top 75%' }
        });
      }

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
       - Section reveal
       - Orbit motion + ambient float
       - Flip cards + pointer tilt
       ------------------------------ */
    (function worksGrid() {
      const works = document.getElementById('works');
      if (!works) return;

      const rows = Array.from(works.querySelectorAll('.work-row'));
      const orbit = works.querySelector('.works-orbit');

      if (hasGSAP) {
        gsap.from(works.querySelectorAll('.works-head .title-xl, .works-head .works-sub, .works-meta .meta-pill'), {
          opacity: 0,
          y: 16,
          duration: 0.6,
          ease: 'power2.out',
          stagger: 0.08,
          scrollTrigger: { trigger: works, start: 'top 78%' }
        });

        if (orbit) {
          gsap.from(orbit, {
            opacity: 0,
            scale: 0.7,
            rotate: -8,
            duration: 0.7,
            ease: 'back.out(1.6)',
            scrollTrigger: { trigger: works, start: 'top 78%' }
          });

          gsap.to('.orbit-ring', { rotation: 360, duration: 22, repeat: -1, ease: 'none', transformOrigin: '50% 50%' });
        }

        gsap.from(rows, {
          opacity: 0,
          y: 18,
          duration: 0.55,
          ease: 'power2.out',
          stagger: 0.1,
          scrollTrigger: { trigger: '.works-list', start: 'top 82%' }
        });
      }

      // Accordion toggle — one open at a time
      rows.forEach((row) => {
        row.addEventListener('click', () => {
          const isOpen = row.classList.contains('is-open');
          rows.forEach((r) => r.classList.remove('is-open'));
          if (!isOpen) row.classList.add('is-open');
        });
      });
    })();
  
    /* ------------------------------
       4) SERVICES grid
       - Staggered entrance
       - Micro tilt on hover (lighter than Works)
       ------------------------------ */
    (function servicesGrid() {
      if (!hasGSAP) return;
      const services = document.getElementById('services');
      const orbit = services ? services.querySelector('.services-orbit') : null;

      if (services) {
        gsap.from(services.querySelectorAll('.title-xl, .services-sub'), {
          opacity: 0,
          y: 14,
          duration: 0.6,
          ease: 'power2.out',
          stagger: 0.08,
          scrollTrigger: { trigger: services, start: 'top 82%' }
        });
      }

      if (orbit) {
        gsap.from(orbit, {
          opacity: 0,
          scale: 0.7,
          rotate: -6,
          duration: 0.7,
          ease: 'back.out(1.6)',
          scrollTrigger: { trigger: services, start: 'top 82%' }
        });

        gsap.to(orbit, { y: -8, duration: 3.2, repeat: -1, yoyo: true, ease: 'sine.inOut' });
      }

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

      const contactInfoCards = gsap.utils.toArray('.contact-info .contact-info-card');
      const contactFormFields = gsap.utils.toArray('#contactForm .contact-field, #contactForm .contact-chips, #contactForm .contact-submit-btn');

      // left side - info cards (only animate if elements exist)
      if (contactInfoCards.length) {
        gsap.from(contactInfoCards, {
          opacity: 0, y: 14, duration: 0.45, ease: 'power2.out',
          stagger: 0.08,
          immediateRender: false,
          scrollTrigger: { trigger: '.contact-info', start: 'top 85%', toggleActions: 'play none none none' }
        });
      }

      // right side (form fields)
      if (contactFormFields.length) {
        gsap.from(contactFormFields, {
          opacity: 0, y: 14, duration: 0.45, ease: 'power2.out',
          stagger: 0.06,
          immediateRender: false,
          scrollTrigger: { trigger: '#contactForm', start: 'top 85%', toggleActions: 'play none none none' }
        });
      }
    })();

    // Contact card hover effect (vanilla JS, no GSAP dependency)
    (function contactHover(){
      document.querySelectorAll('.contact-info-card').forEach(el=>{
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
    })();

    // CONTACT: cap badges + form reveal
    (function contactCapMotion(){
      if (!window.gsap || !window.ScrollTrigger) return;

      const badges = gsap.utils.toArray('.contact-badges .kbadge');
      const formCard = document.querySelector('.contact-form-card');

      // badges
      if (badges.length) {
        gsap.from(badges, {
          opacity:0, y:8, duration:.35, ease:'power2.out',
          stagger:.06,
          immediateRender: false,
          scrollTrigger:{ trigger:'.contact-badges', start:'top 90%', toggleActions: 'play none none none' }
        });
      }

      // form card slight lift
      if (formCard) {
        gsap.from(formCard, {
          opacity:0, y:14, duration:.45, ease:'power2.out',
          immediateRender: false,
          scrollTrigger:{ trigger:'.contact-form-card', start:'top 88%', toggleActions: 'play none none none' }
        });
      }
    })();
  
    /* ------------------------------
       5) HERO intro choreography
       - Runs on window load so fonts/images are ready
       ------------------------------ */
    window.addEventListener('load', () => {
      if (!hasGSAP) return;

      // Wait for fonts + next frame so layout is fully stable before GSAP measures
      Promise.resolve(document.fonts && document.fonts.ready).then(() => {
        requestAnimationFrame(() => {
          const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
          tl.from('.hero-photo .portrait', { autoAlpha: 0.6, y: 20, duration: 0.7 })
            .from('#heroTitle',            { y: 26, duration: 0.45 }, '-=0.25')
            .from('.hero-list',            { y: 18, duration: 0.4 }, '-=0.28')
            .from('.hero-list li',         { y: 8, duration: 0.3, stagger: 0.05 }, '-=0.18')
            .from('.hero-cta .btn',        { y: 8, duration: 0.3, stagger: 0.05 }, '-=0.18');

          // Single refresh after everything is stable
          ScrollTrigger.refresh();
        });
      });
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
       7) Contact form submission
       ------------------------------ */
    (function contactForm() {
      const form = byId('contactForm');
      if (!form) return;

      const submitBtn = form.querySelector('.contact-submit-btn');
      const API_URL = 'https://3d.timrx.live/api/contact/submit';

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = new FormData(form);

        // Validate required fields
        if (!data.get('budget') || !data.get('name') || !data.get('email') || !data.get('message')) {
          return note('Please fill the required fields (budget, name, email, message).', true);
        }

        // Validate email format
        const email = data.get('email');
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return note('Please enter a valid email address.', true);
        }

        // Disable button and show loading state
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.innerHTML = 'Sending... <span style="display:inline-block;animation:spin 1s linear infinite;">⟳</span>';
        }

        try {
          const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: data.get('name'),
              email: data.get('email'),
              subject: data.get('subject') || '',
              budget: data.get('budget'),
              message: data.get('message')
            })
          });

          const result = await response.json();

          if (result.ok) {
            note(result.message || "Thanks — I'll reply within 24–48h.", false);
            form.reset();
            byId('budgetChips')?.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
            // Also reset contact-chip styling
            form.querySelectorAll('.contact-chip').forEach((c) => {
              c.style.background = '#f5f5f5';
              c.style.color = '#0b0b0b';
              c.style.borderColor = 'transparent';
            });
          } else {
            note(result.error?.message || 'Something went wrong. Please try again.', true);
          }
        } catch (err) {
          console.error('[Contact] Submit error:', err);
          note('Network error. Please try again or email directly.', true);
        } finally {
          // Re-enable button
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Send message <span style="transition:transform 0.2s;">→</span>';
          }
        }
      });

      function note(msg, isError = false) {
        const n = byId('formNote');
        if (n) {
          n.textContent = msg;
          n.style.color = isError ? '#dc3545' : '#28a745';
        }
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

    // --- Greeting bubble (appears once after 4s, dismissed on click or chat open)
    (function greetingBubble(){
      var KEY = 'timrx_chat_greeted';
      if (sessionStorage.getItem(KEY)) return;

      var bubble = document.createElement('div');
      bubble.className = 'chat-greeting';
      bubble.textContent = 'Hey! Need help? Ask me anything.';
      document.body.appendChild(bubble);

      var showTimer = setTimeout(function(){ bubble.classList.add('is-visible'); }, 4000);
      var hideTimer = setTimeout(function(){ dismiss(); }, 12000);

      function dismiss(){
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        bubble.classList.remove('is-visible');
        sessionStorage.setItem(KEY, '1');
        setTimeout(function(){ bubble.remove(); }, 350);
      }

      bubble.addEventListener('click', function(){
        dismiss();
        chatToggle.click();
      });

      // Also dismiss when chat opens
      var origOpen = chatToggle.getAttribute('aria-expanded');
      new MutationObserver(function(muts){
        if (chatToggle.getAttribute('aria-expanded') === 'true') dismiss();
      }).observe(chatToggle, { attributes: true, attributeFilter: ['aria-expanded'] });
    })();
  
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
      chatPanel.style.display = 'grid';
      chatToggle.setAttribute('aria-expanded', 'true');
      chatInput?.focus();
      scrollToBottom();
    }
    function closeChat(){
      chatPanel.style.display = 'none';
      chatToggle.setAttribute('aria-expanded', 'false');
      hideSuggest();
      chatPanel.style.bottom = '';  // reset keyboard offset
    }

    // --- Mobile keyboard handler: lift panel above software keyboard
    if (window.visualViewport && window.matchMedia('(max-width:560px)').matches) {
      const vv = window.visualViewport;
      const onVVResize = () => {
        if (!isOpen()) return;
        // offsetTop = how far the visual viewport top is from the layout viewport top
        // When keyboard opens, vv.height shrinks; the gap is the keyboard height
        const kbHeight = window.innerHeight - vv.height - vv.offsetTop;
        chatPanel.style.bottom = kbHeight > 40 ? (kbHeight + 6) + 'px' : '';
      };
      vv.addEventListener('resize', onVVResize);
      vv.addEventListener('scroll', onVVResize);
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
      // Skip on mobile — saves 96 animated particles + rAF loop
      if (window.innerWidth < 900) return;
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
