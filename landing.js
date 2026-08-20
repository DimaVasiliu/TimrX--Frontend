(function(){
  'use strict';
  if(window.location.protocol==='file:'){
    const previews={'/':'index.html','/hub':'hub.html','/3dprint':'3dprint.html','/ai-tools':'ai-tools.html','/ai-image-generator':'ai-image-generator.html','/ai-video-generator':'ai-video-generator.html','/ai-3d-generator':'ai-3d-generator.html','/text-to-3d':'text-to-3d.html','/image-to-3d':'image-to-3d.html','/tutorials':'tutorials.html','/community':'community.html','/docs':'docs.html','/prompts':'prompts.html','/converter':'converter.html','/stl-library':'stl-library.html','/print-on-demand':'print-on-demand.html','/blogs':'blogs.html','/company':'company.html','/terms':'terms.html','/privacy':'privacy.html','/cookies':'cookies.html','/dima-vasiliu':'dima-vasiliu.html'};
    document.querySelectorAll('a[href^="/"]').forEach(link=>{const raw=link.getAttribute('href');const match=raw.match(/^([^?#]+)(.*)$/);const preview=match&&previews[match[1]];if(preview)link.setAttribute('href',preview+match[2])});
  }
  const legacySection={works:'works',services:'services',contact:'contact'}[window.location.hash.slice(1)];
  if(legacySection){window.location.replace(`${window.location.protocol==='file:'?'dima-vasiliu.html':'/dima-vasiliu'}#${legacySection}`);return}
  const header=document.querySelector('[data-header]');
  /* Mobile menu lives in js/shared/tx-menu.js — shared by every page. */
  const setHeader=()=>header?.classList.toggle('is-scrolled',window.scrollY>18);
  setHeader();window.addEventListener('scroll',setHeader,{passive:true});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealItems=document.querySelectorAll('.reveal');
  if(reduced||!('IntersectionObserver'in window)){revealItems.forEach(item=>item.classList.add('is-visible'))}else{const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target)}}),{threshold:.12,rootMargin:'0px 0px -30px'});revealItems.forEach(item=>observer.observe(item))}
  document.querySelectorAll('[data-track]').forEach(link=>link.addEventListener('click',()=>{window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:'cta_click',cta_name:link.dataset.track,cta_url:link.getAttribute('href'),page_type:'platform_landing'})}));
  document.querySelectorAll('[data-year]').forEach(node=>{node.textContent=String(new Date().getFullYear())});

  (function initPromptRecipes(){
    const recipes=[...document.querySelectorAll('[data-prompt-recipe]')];
    if(!recipes.length)return;
    const input=document.getElementById('heroAssistantInput');
    const route=document.querySelector('[data-hero-route]');
    let activeIndex=Math.max(0,recipes.findIndex(card=>card.classList.contains('is-active')));
    let timer=null;
    const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function recipePayload(card){
      return {
        source:'homepage_recipe',
        label:card.dataset.recipeLabel||card.textContent.trim(),
        output:card.dataset.recipeOutput||'',
        panel:card.dataset.recipePanel||'model',
        tab:card.dataset.recipeTab||'',
        prompt:card.dataset.recipePrompt||'',
        created_at:new Date().toISOString()
      };
    }
    function setActive(index,fill){
      if(!recipes.length)return;
      activeIndex=((index%recipes.length)+recipes.length)%recipes.length;
      recipes.forEach((card,i)=>card.classList.toggle('is-active',i===activeIndex));
      const card=recipes[activeIndex];
      const payload=recipePayload(card);
      if(fill&&input&&payload.prompt){
        input.value=payload.prompt;
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }
      if(route)route.href=card.getAttribute('href')||'/3dprint';
    }
    function storeRecipe(card){
      const payload=recipePayload(card);
      try{sessionStorage.setItem('timrx_pending_homepage_recipe',JSON.stringify(payload));}catch(_){}
      if(input&&payload.prompt){
        input.value=payload.prompt;
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }
      window.dataLayer=window.dataLayer||[];
      window.dataLayer.push({event:'homepage_recipe_selected',recipe_name:payload.label,recipe_panel:payload.panel,recipe_output:payload.output,page_type:'platform_landing'});
    }
    function start(){
      if(reducedMotion||recipes.length<2)return;
      stop();
      timer=window.setInterval(()=>setActive(activeIndex+1,true),4200);
    }
    function stop(){if(timer){window.clearInterval(timer);timer=null;}}
    /* 2026-08-20: auto-rotation retired — the bloom is hover/focus only.
       No card starts active, nothing cycles; leaving a card clears it. */
    function clearActive(){recipes.forEach(card=>card.classList.remove('is-active'));}
    recipes.forEach((card,index)=>{
      card.addEventListener('mouseenter',()=>{stop();setActive(index,true)});
      card.addEventListener('focus',()=>{stop();setActive(index,true)});
      card.addEventListener('mouseleave',clearActive);
      card.addEventListener('blur',clearActive);
      card.addEventListener('click',()=>{setActive(index,true);storeRecipe(card);});
    });
    clearActive();
  })();

	  const communityGrid=document.getElementById('homeCommunityGrid');
	  const communityShuffle=document.getElementById('homeCommunityShuffle');
	  const communityStatus=document.getElementById('homeCommunityStatus');
	  if(communityGrid){
	    let showcasePool=[];
	    let shuffleTimer=null;
	    let isHovering=false;
	    const visibleCount=12;
	    const escapeHtml=str=>String(str||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
	    const truncate=(str,max)=>{const s=String(str||'').trim();return s.length>max?s.slice(0,max).trim()+'…':s};
	    const thumb=item=>{const asset=item.asset||{};return asset.image_url||asset.thumbnail_url||item.image_url||item.thumbnail_url||''};
	    const typeLabel=item=>{const type=String(item.gen_type||item.asset_type||'creation').toLowerCase();if(type.includes('video'))return'AI VIDEO';if(type.includes('image'))return'AI IMAGE';if(type.includes('animate'))return'ANIMATED';if(type.includes('3d')||type.includes('model'))return'TEXT TO 3D';return'CREATION'};
	    const typeClass=item=>{const type=String(item.gen_type||item.asset_type||'creation').toLowerCase();if(type.includes('video'))return'is-video';if(type.includes('image'))return'is-image';if(type.includes('animate'))return'is-animated';return'is-model'};
	    const timeAgo=value=>{if(!value)return'Recently';const then=new Date(value).getTime();if(!then)return'Recently';const diff=Math.max(0,Date.now()-then),minute=60000,hour=60*minute,day=24*hour;if(diff<hour)return Math.max(1,Math.round(diff/minute))+'m ago';if(diff<day)return Math.max(1,Math.round(diff/hour))+'h ago';if(diff<day*7)return Math.max(1,Math.round(diff/day))+'d ago';return Math.max(1,Math.round(diff/(day*7)))+'w ago'};
	    const initials=name=>String(name||'CR').split(/\s+/).slice(0,2).map(part=>part.charAt(0).toUpperCase()).join('')||'CR';
	    const reactions=item=>Object.keys(item.reactions||{}).reduce((sum,key)=>sum+(Number(item.reactions[key])||0),0);
	    const setStatus=text=>{if(communityStatus)communityStatus.lastChild.nodeValue=' '+text};
	    const curatedModelTerms=/\b(animal|architecture|astronaut|automaton|bear|bird|building|castle|cat|character|creature|dinosaur|dog|dragon|drone|fantasy|figurine|fox|furniture|helmet|knight|lantern|machine|mascot|mech|miniature|monster|orc|owl|prop|robot|rover|sculpture|spaceship|statue|sword|temple|tree|vehicle|warrior|weapon|wolf|wyrm)\b/i;
	    const privateModelTerms=/\b(boy|face|family photo|female|girl|group photo|human|man|male|my face|people|person|photo of me|portrait|real person|selfie|woman)\b/i;
	    function curateHomepagePosts(items){
	      const seen=new Set();
	      return items.filter(item=>{
	        const media=String(thumb(item)||'').split('?')[0].split('#')[0].replace(/\/+$/,'').toLowerCase();
	        if(!media||seen.has(media))return false;
	        const type=String(item.gen_type||item.asset_type||'').toLowerCase();
	        if(type.includes('image to 3d'))return false;
	        if(type.includes('3d')||type.includes('model')){
	          const text=[item.asset&&item.asset.title,item.title,item.prompt_public,item.prompt].filter(Boolean).join(' ');
	          if(privateModelTerms.test(text)||!curatedModelTerms.test(text))return false;
	        }
	        seen.add(media);
	        return true;
	      });
	    }
	    function pick(items,count){
	      const pool=items.slice();
	      for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}
	      return pool.slice(0,count);
	    }
    function card(item,index){
      const image=thumb(item);
      if(!image)return'';
	      const title=escapeHtml(truncate((item.asset&&item.asset.title)||item.title||item.prompt_public||item.prompt||'Untitled creation',62));
	      const excerpt=escapeHtml(truncate(item.prompt_public||item.prompt||'Open this creation to inspect the prompt, media, and creator details.',90));
	      const creatorRaw=item.display_name||item.creator_name||'Creator';
	      const tips=Number(item.tip_total)||0;
	      const href='/community?post='+encodeURIComponent(item.id||'');
	      return '<a class="ls-card '+typeClass(item)+'" href="'+href+'" data-track="community_card" style="--ls-index:'+index+'">'+
	        '<div class="ls-card-media">'+
	          '<img src="'+escapeHtml(image)+'" alt="'+title+'" width="270" height="214" loading="lazy" decoding="async" onerror="var c=this.closest(\'.ls-card\');if(c)c.style.display=\'none\';">'+
	          '<div class="ls-card-topline"><span class="ls-card-badge">'+escapeHtml(typeLabel(item))+'</span><span class="ls-card-time">'+escapeHtml(timeAgo(item.created_at))+'</span></div>'+
          '<div class="ls-card-hover"><span>Open creation</span><span aria-hidden="true">↗</span></div>'+
	        '</div>'+
	        '<div class="ls-card-info"><strong>'+title+'</strong><p class="ls-card-excerpt">'+excerpt+'</p>'+
	          '<div class="ls-card-bottom"><div class="ls-card-author"><span class="ls-card-avatar">'+escapeHtml(initials(creatorRaw))+'</span><span>by '+escapeHtml(creatorRaw)+'</span></div>'+
	          '<div class="ls-card-stats"><span aria-label="Reactions">♥ '+reactions(item)+'</span><span aria-label="Comments">◐ '+(Number(item.comment_count)||0)+'</span><span aria-label="Tips">◆ '+tips+'</span></div></div>'+
	        '</div></a>';
	    }
	    function render(items,refreshing){
	      if(refreshing)communityGrid.classList.add('is-refreshing');
	      communityGrid.innerHTML=items.length?items.map(card).join(''):'<div class="ls-empty">Community creations loading soon.</div>';
	      window.requestAnimationFrame(()=>communityGrid.classList.remove('is-refreshing'));
	    }
	    function shuffle(){if(showcasePool.length){render(pick(showcasePool,Math.min(visibleCount,showcasePool.length)),true);setStatus('Fresh picks loaded')}}
	    function restartShuffleTimer(){
	      if(shuffleTimer)window.clearInterval(shuffleTimer);
	      if(reduced||showcasePool.length<=visibleCount)return;
	      shuffleTimer=window.setInterval(()=>{if(document.hidden||isHovering)return;shuffle();setStatus('Auto-refreshed community picks')},12000);
	    }
	    communityGrid.addEventListener('mouseenter',()=>{isHovering=true});
	    communityGrid.addEventListener('mouseleave',()=>{isHovering=false});
	    communityShuffle?.addEventListener('click',()=>{shuffle();restartShuffleTimer()});
	    communityGrid.addEventListener('click',event=>{
	      const link=event.target.closest('[data-track]');
	      if(!link)return;
	      window.dataLayer=window.dataLayer||[];
	      window.dataLayer.push({event:'cta_click',cta_name:link.dataset.track,cta_url:link.getAttribute('href'),page_type:'platform_landing'});
	    });
	    fetch('https://3d.timrx.live/api/_mod/community/feed?limit=48&sort=popular',{credentials:'include'})
	      .then(response=>response.ok?response.json():null)
	      .then(data=>{const items=curateHomepagePosts(((data&&(data.items||data.posts))||data||[]).filter(item=>thumb(item)));showcasePool=items;if(!items.length){render([],false);setStatus('Curated community picks loading soon');return}render(pick(items,Math.min(visibleCount,items.length)),false);setStatus(items.length+' curated creations live');restartShuffleTimer()})
	      .catch(()=>{communityGrid.innerHTML='<div class="ls-empty">Community creations loading soon.</div>';setStatus('Community feed loading soon')});
	  }
	  (function initResourceModals(){
	    const tabs=document.querySelectorAll('.resource-tab[data-modal]');
	    if(!tabs.length)return;
	    let lastFocus=null;
	    const focusable='button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';
	    function openModal(modal){
	      if(!modal)return;
	      lastFocus=document.activeElement;
	      modal.classList.add('open');
	      modal.removeAttribute('inert');
	      modal.setAttribute('aria-hidden','false');
	      document.body.classList.add('resource-modal-open');
	      requestAnimationFrame(()=>modal.querySelector(focusable)?.focus());
	    }
	    function closeModal(modal){
	      if(!modal)return;
	      if(modal.contains(document.activeElement))(lastFocus||document.body).focus();
	      modal.classList.remove('open');
	      modal.setAttribute('inert','');
	      modal.setAttribute('aria-hidden','true');
	      document.body.classList.remove('resource-modal-open');
	    }
	    tabs.forEach(tab=>{
	      tab.addEventListener('click',()=>{
	        const modal=document.getElementById(tab.dataset.modal);
	        openModal(modal);
	        window.dataLayer=window.dataLayer||[];
	        window.dataLayer.push({event:'cta_click',cta_name:'community_resource_'+tab.dataset.modal,cta_url:'#'+tab.dataset.modal,page_type:'platform_landing'});
	      });
	    });
	    document.querySelectorAll('.resource-modal [data-close-modal]').forEach(btn=>{
	      btn.addEventListener('click',()=>closeModal(btn.closest('.resource-modal')));
	    });
	    document.querySelectorAll('.resource-modal').forEach(modal=>{
	      modal.addEventListener('mousedown',event=>{
	        const card=modal.querySelector('.resource-modal-card');
	        if(card&&!card.contains(event.target))closeModal(modal);
	      });
	    });
	    document.addEventListener('keydown',event=>{
	      if(event.key==='Escape')closeModal(document.querySelector('.resource-modal.open'));
	    });
	    document.querySelectorAll('.copy-btn[data-copy]').forEach(btn=>{
	      btn.addEventListener('click',async()=>{
	        const codeEl=document.getElementById(btn.dataset.copy);
	        if(!codeEl)return;
	        try{
	          await navigator.clipboard.writeText(codeEl.textContent||'');
	          btn.classList.add('copied');
	          btn.innerHTML='<i class="fa-solid fa-check" aria-hidden="true"></i>';
	          window.setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='<i class="fa-solid fa-copy" aria-hidden="true"></i>';},2000);
	        }catch(error){
	          console.warn('Copy failed:',error);
	        }
	      });
	    });
	  })();
	  const demo=document.getElementById('demo');
	  if(demo){
	    const chips=demo.querySelectorAll('.demo-chip');
	    const promptText=document.getElementById('demoPromptText');
	    const viewer=document.getElementById('demoModelViewer');
	    let activeTimer=null;
	    function writePrompt(value){
	      const prompt=String(value||'');
	      if(!promptText)return;
	      if(activeTimer)window.clearInterval(activeTimer);
	      if(reduced){promptText.textContent=prompt;return}
	      promptText.textContent='';
	      let i=0;
	      activeTimer=window.setInterval(()=>{
	        if(i<prompt.length){promptText.textContent+=prompt.charAt(i);i++;return}
	        window.clearInterval(activeTimer);
	        activeTimer=null;
	      },20);
	    }
	    chips.forEach(chip=>{
	      chip.addEventListener('click',()=>{
	        chips.forEach(item=>item.classList.remove('active'));
	        chip.classList.add('active');
	        const model=chip.getAttribute('data-model');
	        if(model&&viewer)viewer.setAttribute('src',model);
	        writePrompt(chip.getAttribute('data-prompt'));
	        window.dataLayer=window.dataLayer||[];
	        window.dataLayer.push({event:'cta_click',cta_name:'demo_prompt_example',cta_url:model||'',page_type:'platform_landing'});
	      });
	    });
	  }
	})();

/* CORNER RECIPES (2026-08-20): on wide screens the recipe cards pin to the
   hero's four corners (index-palette.css). They can only anchor to .hero if
   the section is its direct child — the markup nests it inside
   .hero-command-wrap (position:relative), which would hijack the absolute
   positioning. Re-parent at runtime instead of editing markup; listeners on
   the cards survive the move. Reversible on resize. */
(function(){
  var sec = document.querySelector('.prompt-recipes');
  var hero = document.querySelector('.hero-minimal') || document.querySelector('.hero');
  if (!sec || !hero) return;
  var home = sec.parentElement, marker = document.createComment('prompt-recipes-home');
  home.insertBefore(marker, sec);
  function place(){
    if (window.innerWidth >= 1240) {
      if (sec.parentElement !== hero) hero.appendChild(sec);
    } else if (sec.parentElement !== home) {
      home.insertBefore(sec, marker.nextSibling);
    }
  }
  place();
  window.addEventListener('resize', place, { passive: true });
})();
