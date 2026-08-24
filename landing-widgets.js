(function(){
  'use strict';

  const env = window.TIMRX_ENV || {};
  const blogBase = (env.blogApiBase || window.TIMRX_BLOGS_API_BASE || window.location.origin).replace(/\/$/, '');
  const isFile = window.location.protocol === 'file:';
  const localMap = {'/blogs':'blogs.html','/read':'blogs.html','/3dprint':'3dprint.html','/hub':'hub.html','/ai-tools':'ai-tools.html','/converter':'converter.html','/stl-library':'stl-library.html','/dima-vasiliu':'dima-vasiliu.html'};

  function localHref(href){
    if(!isFile) return href;
    try{
      const url = new URL(href, window.location.href);
      const mapped = localMap[url.pathname];
      return mapped ? `${mapped}${url.search}${url.hash}` : href;
    }catch{ return href; }
  }

  function esc(value){
    return String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function readTime(post){
    return post.minutes || Math.max(3, Math.round(((post.excerpt || '') + (post.title || '')).length / 62));
  }

  function postDate(post){
    if(!post.created_at) return 'Recent';
    const date = new Date(post.created_at);
    return Number.isNaN(date.getTime()) ? 'Recent' : date.toLocaleDateString('en-GB', { month:'short', year:'numeric' });
  }

  function renderPost(post, opts){
    const featured = opts && opts.featured;
    const tag = (post.tags || '').split(',').map(t => t.trim()).filter(Boolean)[0] || 'TimrX';
    const fallbackCover = 'https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=1400&auto=format&fit=crop';
    const href = localHref(`/blog/${encodeURIComponent(post.slug || '')}`);
    const coverAlt = post.cover_alt || post.title || `${tag} article cover image`;
    if(featured){
      return `<a class="insight-card insight-card--featured reveal is-visible" href="${href}">
        <div class="insight-thumb"><img src="${esc(post.cover_url || fallbackCover)}" alt="${esc(coverAlt)}" loading="lazy" decoding="async"><span class="insight-pill">${esc(tag)}</span><span class="insight-flag">Featured</span></div>
        <div class="insight-body"><h3>${esc(post.title || 'Untitled article')}</h3><p>${esc(post.excerpt || 'Read the latest TimrX update.')}</p><div class="insight-meta">${esc(postDate(post))} · ${readTime(post)} min<span class="insight-cta">Read article <span aria-hidden="true">→</span></span></div></div>
      </a>`;
    }
    return `<a class="insight-row reveal is-visible" href="${href}">
      <span class="insight-row-thumb"><img src="${esc(post.cover_url || fallbackCover)}" alt="${esc(coverAlt)}" loading="lazy" decoding="async"></span>
      <span class="insight-row-body"><span class="insight-row-tag">${esc(tag)}</span><strong>${esc(post.title || 'Untitled article')}</strong><span class="insight-row-meta">${esc(postDate(post))} · ${readTime(post)} min</span></span>
      <span class="insight-row-arrow" aria-hidden="true">→</span>
    </a>`;
  }

  function renderFeed(posts){
    const featured = renderPost(posts[0], {featured:true});
    const rest = posts.slice(1, 5);
    const side = rest.length
      ? `<div class="insight-side"><span class="insight-side-cap">More from the blog</span>${rest.map(p => renderPost(p)).join('')}<a class="insight-side-all" href="${localHref('/blogs')}">View all posts <span aria-hidden="true">→</span></a></div>`
      : '';
    return featured + side;
  }

  async function loadBlogFeed(){
    const grid = document.querySelector('[data-blog-feed]');
    if(!grid) return;
    try{
      const response = await fetch(`${blogBase}/api/posts?page=1&size=5`, { cache:'no-store' });
      if(!response.ok) throw new Error(`Blog API ${response.status}`);
      const data = await response.json();
      const posts = data.items || data.posts || [];
      if(!posts.length) throw new Error('No posts returned');
      grid.classList.add('insight-grid--split');
      grid.innerHTML = renderFeed(posts.slice(0, 5));
    }catch(error){
      grid.classList.add('insight-grid--split');
      grid.innerHTML = renderFeed([
        {slug:'timrx-ai-generation-hub',title:'Build faster creative workflows with TimrX',excerpt:'How image, video and 3D generation fit together in one browser workspace.',tags:'TimrX,Workflow'},
        {slug:'prompt-to-print-workflow',title:'From prompt to print-ready model',excerpt:'A practical path from text or image prompts to usable STL, OBJ, GLB and 3MF exports.',tags:'3D Printing'},
        {slug:'creative-technology-notes',title:'Creative technology notes from Dima',excerpt:'Design, engineering and 3D workflow lessons from building production web products.',tags:'Founder'},
        {slug:'rendering-3d-in-the-browser',title:'Rendering 3D in the browser: a technical teardown',excerpt:'How TimrX renders complex GLB and OBJ files with Three.js.',tags:'3D Rendering'},
        {slug:'ai-models-production-ready',title:'Why most AI 3D models are not production-ready',excerpt:'What real-world workflows demand and how browser tools help.',tags:'Production'}
      ]);
    }
  }

  function createChat(){
    const config = window.TIMRX_CHAT_WIDGET || {};
    if(document.getElementById('chatToggle')) return;
    const prompts = config.prompts || [];
    const button = document.createElement('button');
    button.id = 'chatToggle';
    button.className = 'chat-toggle';
    button.type = 'button';
    button.setAttribute('aria-label', config.closedLabel || 'Open chat');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '✦';
    const backdrop = document.createElement('div');
    backdrop.id = 'chatBackdrop';
    backdrop.className = 'chat-backdrop';
    backdrop.hidden = true;
    const panel = document.createElement('section');
    panel.id = 'chatPanel';
    panel.className = 'chat-panel';
    panel.hidden = true;
    panel.setAttribute('aria-hidden','true');
    panel.setAttribute('aria-label', config.title || 'TimrX assistant');
    panel.innerHTML = `<header class="chat-head"><div class="chat-title"><span class="chat-kicker">${esc(config.kicker || 'Assistant')}</span><strong>${esc(config.title || 'TimrX Chat')}</strong><span>${esc(config.subtitle || 'Ask a question and get a focused answer.')}</span></div><button class="chat-close" id="chatClose" type="button" aria-label="Close chat">×</button></header>
      <div class="chat-layout"><aside class="chat-aside"><div class="chat-spotlight"><h3>${esc(config.spotlightTitle || 'How I can help')}</h3><p>${esc(config.spotlightCopy || 'Ask about TimrX tools, workflows, pricing or next steps.')}</p></div><div class="chat-quick">${prompts.map(p => `<button type="button" data-chat-prompt="${esc(p.prompt || p)}">${esc(p.label || p)}</button>`).join('')}</div></aside>
      <div class="chat-main"><div class="chat-body" id="chatBody"><div class="chat-welcome"><h3>${esc(config.welcomeTitle || 'Ask a focused question.')}</h3><p>${esc(config.welcomeCopy || 'Use the suggested prompts or type your own question.')}</p></div></div><div class="chat-suggestions" aria-label="Suggested questions">${prompts.map(p => `<button class="chat-suggestion" type="button" data-chat-prompt="${esc(p.prompt || p)}">${esc(p.label || p)}</button>`).join('')}</div><form class="chat-inputbar" id="chatForm"><textarea id="chatInput" rows="2" placeholder="${esc(config.placeholder || 'Ask about TimrX…')}" autocomplete="off" autocapitalize="sentences"></textarea><button class="chat-send" id="chatSend" type="submit" aria-label="Send message"><span>Send</span> →</button></form></div></div>`;
    document.body.append(button, backdrop, panel);

    const close = panel.querySelector('#chatClose');
    const input = panel.querySelector('#chatInput');
    const form = panel.querySelector('#chatForm');
    const body = panel.querySelector('#chatBody');
    const sendButton = panel.querySelector('#chatSend');
    const history = [];
    let closingTimer = null;
    let fitTimerA = null;
    let fitTimerB = null;
    let isSending = false;
    const mobileChatQuery = window.matchMedia('(max-width: 820px)');
    const coarsePointerQuery = window.matchMedia('(pointer: coarse)');

    function shouldAutoFocusChat(){
      return !mobileChatQuery.matches && !coarsePointerQuery.matches;
    }

    function clearViewportVars(){
      ['--chat-visual-width','--chat-visual-height','--chat-visual-top','--chat-visual-left','--chat-keyboard-offset'].forEach(prop => panel.style.removeProperty(prop));
      panel.classList.remove('has-keyboard');
    }

    function scheduleFitPanel(){
      if(panel.hidden) return;
      fitPanelToViewport();
      clearTimeout(fitTimerA);
      clearTimeout(fitTimerB);
      fitTimerA = setTimeout(fitPanelToViewport, 140);
      fitTimerB = setTimeout(fitPanelToViewport, 420);
    }

    function setOpen(open){
      clearTimeout(closingTimer);
      button.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-hidden', String(!open));
      document.body.classList.toggle('chat-open', open);
      if(open){
        panel.hidden = false; backdrop.hidden = false;
        requestAnimationFrame(()=>{
          panel.classList.add('is-open');
          backdrop.classList.add('is-open');
          scheduleFitPanel();
        });
        setTimeout(()=>{
          if(shouldAutoFocusChat()) input.focus({preventScroll:true});
          scheduleFitPanel();
        }, 80);
      }else{
        clearTimeout(fitTimerA);
        clearTimeout(fitTimerB);
        panel.classList.remove('is-open'); backdrop.classList.remove('is-open');
        clearViewportVars();
        closingTimer = setTimeout(()=>{panel.hidden = true; backdrop.hidden = true}, 240);
      }
    }
    function fitPanelToViewport(){
      if(panel.hidden) return;
      const viewport = window.visualViewport;
      const root = document.documentElement;
      const layoutHeight = Math.round(window.innerHeight || root.clientHeight || 0);
      const layoutWidth = Math.round(window.innerWidth || root.clientWidth || 0);
      if(!viewport){
        panel.style.setProperty('--chat-visual-width', `${layoutWidth}px`);
        panel.style.setProperty('--chat-visual-height', `${layoutHeight}px`);
        panel.style.setProperty('--chat-visual-top', '0px');
        panel.style.setProperty('--chat-visual-left', '0px');
        panel.style.setProperty('--chat-keyboard-offset', '0px');
        panel.classList.remove('has-keyboard');
        return;
      }
      const visualWidth = Math.max(1, Math.round(viewport.width || layoutWidth));
      const visualHeight = Math.max(1, Math.round(viewport.height || layoutHeight));
      const visualTop = Math.max(0, Math.round(viewport.offsetTop || 0));
      const visualLeft = Math.max(0, Math.round(viewport.offsetLeft || 0));
      const keyboardOffset = Math.max(0, Math.round(layoutHeight - visualHeight - visualTop));
      const focused = document.activeElement === input;
      const compactViewport = mobileChatQuery.matches && layoutHeight > 0 && visualHeight < layoutHeight * 0.82;
      panel.style.setProperty('--chat-visual-width', `${visualWidth}px`);
      panel.style.setProperty('--chat-visual-height', `${visualHeight}px`);
      panel.style.setProperty('--chat-visual-top', `${visualTop}px`);
      panel.style.setProperty('--chat-visual-left', `${visualLeft}px`);
      panel.style.setProperty('--chat-keyboard-offset', `${Math.min(keyboardOffset, 440)}px`);
      panel.classList.toggle('has-keyboard', focused && (keyboardOffset > 72 || compactViewport));
    }
    function scroll(){requestAnimationFrame(()=>{body.scrollTop = body.scrollHeight})}
    function formatChat(text){
      var safe = String(text == null ? '' : text).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
      safe = safe.replace(/\b\/(3dprint|hub|ai-tools|ai-image-generator|ai-video-generator|text-to-3d|image-to-3d|converter|stl-library|print-on-demand|pricing|docs|dima-vasiliu)(#[a-z0-9_-]+)?\b/gi, '<a href="/$1$2">/$1$2</a>');
      safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      var lines = safe.split(/\n/), out = [], list = [];
      function flush(){ if(list.length){ out.push('<ul>' + list.map(function(li){ return '<li>' + li + '</li>'; }).join('') + '</ul>'); list = []; } }
      lines.forEach(function(ln){
        var m = ln.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
        if(m){ list.push(m[1]); } else { flush(); if(ln.trim()){ out.push('<p>' + ln + '</p>'); } }
      });
      flush();
      return out.join('') || safe;
    }
    function addMessage(text, mine){
      const node = document.createElement('div');
      node.className = `chat-message${mine ? ' me' : ''}`;
      if(mine){ node.textContent = text; } else { node.innerHTML = formatChat(text); }
      body.appendChild(node);
      scroll();
      return node;
    }
    function addTyping(){
      const node = document.createElement('div');
      node.className = 'chat-message typing';
      node.innerHTML = '<span></span><span></span><span></span>';
      body.appendChild(node);
      scroll();
      return node;
    }
    async function send(text){
      if(isSending) return;
      const question = String(text || input.value || '').trim();
      if(!question) return;
      isSending = true;
      if(sendButton) sendButton.disabled = true;
      panel.classList.add('has-conversation');
      addMessage(question, true);
      history.push({role:'user', content:question});
      input.value = '';
      input.style.height = '';
      const typing = addTyping();
      try{
        let answerNode = null;
        const answer = await (window.timrxAsk?.(history, partial => {
          if(!answerNode){
            answerNode = document.createElement('div');
            answerNode.className = 'chat-message';
            typing.replaceWith(answerNode);
          }
          answerNode.innerHTML = formatChat(partial);
          scroll();
        }) || Promise.resolve('The assistant is not ready yet. Try again in a moment.'));
        if(!answerNode){
          answerNode = document.createElement('div');
          answerNode.className = 'chat-message';
          typing.replaceWith(answerNode);
        }
        answerNode.innerHTML = formatChat(answer);
        history.push({role:'assistant', content:answer});
        scroll();
      }catch(error){
        typing.replaceWith(addMessage('Something went wrong. Please try again or use the page links.', false));
      }finally{
        isSending = false;
        if(sendButton) sendButton.disabled = false;
        scheduleFitPanel();
      }
    }
    button.addEventListener('click',()=>setOpen(true));
    close.addEventListener('click',()=>setOpen(false));
    backdrop.addEventListener('click',()=>setOpen(false));
    document.addEventListener('keydown', event => { if(event.key === 'Escape') setOpen(false); });
    panel.addEventListener('click', event => {
      const prompt = event.target.closest('[data-chat-prompt]');
      if(prompt){ send(prompt.getAttribute('data-chat-prompt') || prompt.textContent); }
    });
    form.addEventListener('submit', event => { event.preventDefault(); send(); });
    input.addEventListener('keydown', event => { if(event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); send(); } });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
    });
    input.addEventListener('focus', scheduleFitPanel);
    input.addEventListener('blur', () => setTimeout(scheduleFitPanel, 120));
    window.addEventListener('resize', scheduleFitPanel);
    window.addEventListener('orientationchange', () => setTimeout(scheduleFitPanel, 220));
    window.visualViewport?.addEventListener('resize', scheduleFitPanel);
    window.visualViewport?.addEventListener('scroll', scheduleFitPanel);
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadBlogFeed();
    createChat();
  });
})();
