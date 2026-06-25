(function(){
  'use strict';

  const form=document.getElementById('heroAssistantForm');
  const input=document.getElementById('heroAssistantInput');
  const answer=document.getElementById('heroAssistantAnswer');
  const headline=document.querySelector('[data-hero-headline]');
  if(!form||!input||!answer)return;

  const isFile=window.location.protocol==='file:';
  const routes={'/':'index.html','/3dprint':'3dprint.html','/hub':'hub.html','/ai-tools':'ai-tools.html','/ai-image-generator':'ai-image-generator.html','/ai-video-generator':'ai-video-generator.html','/ai-3d-generator':'ai-3d-generator.html','/ai-game-assets':'ai-game-assets.html','/text-to-3d':'text-to-3d.html','/image-to-3d':'image-to-3d.html','/converter':'converter.html','/stl-library':'stl-library.html','/blogs':'blogs.html','/print-on-demand':'print-on-demand.html'};
  const trialStorageKey='timrx_homepage_free_generation_used';
  const apiBase=(window.TIMRX_3D_API_BASE||(window.TIMRX_ENV&&window.TIMRX_ENV.threedApiBase)||'https://3d.timrx.live').replace(/\/+$/,'');
  let currentPoll=null;
  const requestKeys=new Map();

  function href(path){if(!isFile)return path;const match=String(path).match(/^([^?#]+)(.*)$/);return match&&routes[match[1]]?routes[match[1]]+match[2]:path}
  function safeUrl(value,{allowBlob=false}={}){
    if(!value||typeof value!=='string')return'';
    try{
      const url=new URL(value,window.location.origin);
      const sameOrigin=url.origin===window.location.origin;
      if(url.protocol==='https:'||sameOrigin||(allowBlob&&url.protocol==='blob:'))return url.href;
    }catch(err){}
    return'';
  }
  function node(tag,className,text){
    const el=document.createElement(tag);
    if(className)el.className=className;
    if(text!==undefined&&text!==null)el.textContent=String(text);
    return el;
  }
  function appendTrustedMarkup(parent,markup){
    if(!markup)return;
    if(markup instanceof Node){parent.appendChild(markup);return;}
    const template=document.createElement('template');
    template.innerHTML=String(markup);
    parent.appendChild(template.content);
  }
  function track(name,extra={}){
    window.dataLayer=window.dataLayer||[];
    const payload={interaction_name:name,page_type:'platform_landing',...extra};
    window.dataLayer.push({event:name,...payload});
    window.dataLayer.push({event:'hero_assistant_interaction',...payload});
    window.dataLayer.push({event:'cta_click',cta_name:name,cta_url:extra.assistant_route||extra.tool_href||'',page_type:'platform_landing',source:'hero_generation_gateway'});
  }
  function getCookie(name){const match=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)'));return match?decodeURIComponent(match[1]):''}
  async function ensureCsrf(){
    if(window.TimrXApi&&typeof window.TimrXApi.ensureCsrfToken==='function'){
      return window.TimrXApi.ensureCsrfToken();
    }
    let token=getCookie('timrx_csrf');
    if(token)return token;
    try{await fetch(apiBase+'/api/me',{method:'GET',credentials:'include',mode:'cors',headers:{Accept:'application/json'}}).then(r=>r.text()).catch(()=>{});}catch(err){}
    return getCookie('timrx_csrf');
  }
  async function apiJson(path,options={}){
    const method=options.method||'GET';
    const headers=new Headers(options.headers||{Accept:'application/json'});
    if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    if(['POST','PUT','PATCH','DELETE'].includes(method.toUpperCase())){
      const token=await ensureCsrf();
      if(token)headers.set('X-CSRF-Token',token);
    }
    const response=await fetch(apiBase+path,{method,credentials:'include',mode:'cors',headers,body:options.body?JSON.stringify(options.body):undefined});
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{};}catch(err){data={ok:false,error:'invalid_json',message:'The generation service returned an invalid response.'};}
    if(!response.ok&&data.ok!==false)data.ok=false;
    data.http_status=response.status;
    return data;
  }
  function setAnswer(state,title,body,actions=''){
    answer.hidden=false;
    answer.classList.toggle('is-thinking',state==='thinking');
    answer.replaceChildren();
    answer.appendChild(node('span','assistant-answer-kicker',title));
    answer.appendChild(node('p','',body));
    appendTrustedMarkup(answer,actions);
  }
  function blockMarkup(){
    return `<div class="assistant-actions">
      <a class="assistant-route" href="${href('/3dprint')}" data-hero-route data-upgrade-action="signup">Sign Up <span>→</span></a>
      <a class="assistant-route assistant-route-muted" href="${href('/hub#pricing')}" data-hero-route data-upgrade-action="buy_credits">Buy Credits</a>
      <a class="assistant-route assistant-route-muted" href="${href('/3dprint')}" data-hero-route>Open workspace</a>
    </div><p class="assistant-trust">Your first generation is saved. Sign up to continue creating and keep your results.</p>`;
  }
  function localTrialUsed(){try{return localStorage.getItem(trialStorageKey)==='1'}catch(err){return false}}
  function markLocalTrialUsed(){try{localStorage.setItem(trialStorageKey,'1')}catch(err){}}
  function generationLabel(type){return type==='3d'?'3D model':type==='video'?'video':'image'}
  function detectType(prompt){
    const q=String(prompt||'').toLowerCase();
    if(/\b(3d|three[-\s]?d|model|stl|obj|glb|3mf|print|printable|figurine|miniature|keychain|collectible|toy|mesh)\b/.test(q))return'3d';
    if(/\b(video|animate|animation|cinematic|clip|short|reel|movie|motion)\b/.test(q))return'video';
    return'image';
  }
  function requiresUpload(prompt){
    return /\b(image to 3d|photo to 3d|picture to 3d|turn an image into 3d|upload image|from an image)\b/i.test(String(prompt||''));
  }
  function guideUploadFlow(prompt){
    input.value=prompt;
    setAnswer('guide','Upload needed','To turn an image into 3D, open the workspace and upload your image. The homepage free prompt can start text-based image, video, or 3D generations.',`<a class="assistant-route" href="${href('/image-to-3d')}" data-hero-route>Open Image to 3D <span>→</span></a><a class="assistant-route assistant-route-muted" href="${href('/3dprint')}" data-hero-route>Open workspace</a>`);
    track('homepage_prompt_started',{assistant_query:prompt,generation_type:'image_to_3d_upload_required',blocked_reason:'upload_required'});
  }

  function ensureModal(){
    let modal=document.querySelector('[data-generation-modal]');
    if(modal)return modal;
    modal=document.createElement('div');
    modal.className='generation-modal';
    modal.setAttribute('data-generation-modal','');
    modal.hidden=true;
    modal.innerHTML=`<div class="generation-modal-backdrop" data-modal-close></div>
      <section class="generation-modal-panel" role="dialog" aria-modal="true" aria-labelledby="generationModalTitle">
        <button class="generation-modal-close" type="button" aria-label="Close result" data-modal-close>×</button>
        <div class="generation-modal-content" data-modal-content></div>
      </section>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',event=>{if(event.target.closest('[data-modal-close]'))closeModal();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!modal.hidden)closeModal();});
    return modal;
  }
  function openModal(content){
    const modal=ensureModal();
    const target=modal.querySelector('[data-modal-content]');
    target.replaceChildren();
    if(content instanceof Node)target.appendChild(content);
    else target.appendChild(node('div','generation-empty','Result preview is available in your workspace.'));
    modal.hidden=false;
    document.body.classList.add('generation-modal-open');
  }
  function closeModal(){
    const modal=document.querySelector('[data-generation-modal]');
    if(!modal)return;
    modal.hidden=true;
    document.body.classList.remove('generation-modal-open');
  }
  function filenameFor(url,type,index){
    let ext='';
    try{const path=new URL(url,window.location.href).pathname;const m=path.match(/\.([a-z0-9]{2,5})$/i);if(m)ext=m[1].toLowerCase();}catch(err){}
    if(!ext)ext=type==='video'?'mp4':type==='3d'?'glb':'png';
    return 'timrx-'+(type||'asset')+(index?'-'+(index+1):'')+'.'+ext;
  }
  async function downloadAsset(url,filename){
    try{
      const res=await fetch(url,{mode:'cors',credentials:'omit'});
      if(!res.ok)throw new Error('http '+res.status);
      const blob=await res.blob();
      const obj=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=obj;a.download=filename||'timrx-asset';
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(obj),5000);
      return true;
    }catch(err){
      try{window.open(url,'_blank','noopener');}catch(e){}
      return false;
    }
  }
  function downloadLinks(urls,type){
    const clean=urls.map(url=>safeUrl(url,{allowBlob:true})).filter(Boolean).filter((value,index,array)=>array.indexOf(value)===index);
    const wrap=node('div','generation-downloads');
    const label=type==='video'?'Download Video':type==='image'?'Download Image':'Download';
    clean.forEach((url,index)=>{
      const link=node('a','button button-ghost',label+(clean.length>1?' '+(index+1):''));
      link.href=url;
      link.download=filenameFor(url,type,index);
      link.rel='noopener';
      link.dataset.resultDownload='';
      link.dataset.generationType=type||'asset';
      link.addEventListener('click',ev=>{ev.preventDefault();downloadAsset(url,filenameFor(url,type,index));});
      wrap.appendChild(link);
    });
    return wrap;
  }
  function pickFirst(data,keys){
    for(const key of keys){const value=data&&data[key];if(typeof value==='string'&&value)return value;if(Array.isArray(value)&&value[0])return value[0];}
    return '';
  }
  function collectModelUrls(data){
    const keys=['glb_url','model_url','stl_url','obj_url','fbx_url','usdz_url','three_mf_url','threeMF_url','download_url'];
    const urls=[];
    keys.forEach(key=>{if(typeof data[key]==='string')urls.push(data[key]);});
    ['urls','model_urls','download_urls','exports'].forEach(key=>{
      const value=data[key];
      if(Array.isArray(value))value.forEach(item=>{if(typeof item==='string')urls.push(item);else if(item&&item.url)urls.push(item.url);});
      else if(value&&typeof value==='object')Object.values(value).forEach(item=>{if(typeof item==='string')urls.push(item);else if(item&&item.url)urls.push(item.url);});
    });
    return urls;
  }
  function maybeLoadModelViewer(){
    if(customElements.get('model-viewer'))return;
    if(document.querySelector('script[data-model-viewer]'))return;
    const script=document.createElement('script');
    script.type='module';
    script.src='https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';
    script.dataset.modelViewer='true';
    document.head.appendChild(script);
  }
  function renderResult(data){
    const type=data.generation_type||'image';
    const title=`Your ${generationLabel(type)} is ready`;
    const shell=document.createDocumentFragment();
    shell.appendChild(node('span','section-index','TIMRX RESULT'));
    const heading=node('h2','',title);
    heading.id='generationModalTitle';
    shell.appendChild(heading);
    if(type==='video'){
      const video=safeUrl(pickFirst(data,['video_url','output_url','url','download_url']),{allowBlob:true});
      shell.appendChild(node('p','',data.prompt||'Generated from your homepage prompt.'));
      if(video){
        const preview=node('video','generation-video');
        preview.src=video;
        preview.controls=true;
        preview.playsInline=true;
        shell.appendChild(preview);
      }else{
        shell.appendChild(node('div','generation-empty','Video is ready in your workspace.'));
      }
      shell.appendChild(downloadLinks([video],'video'));
      shell.appendChild(resultActions('/ai-video-generator','Open Video Workspace'));
      openModal(shell);
      return;
    }
    if(type==='3d'){
      const urls=collectModelUrls(data);
      const glb=safeUrl(pickFirst(data,['glb_url','model_url'])||urls.find(url=>/\.glb(\?|$)/i.test(url)),{allowBlob:true});
      const thumb=safeUrl(pickFirst(data,['thumbnail_url','preview_url','image_url']),{allowBlob:true});
      if(glb)maybeLoadModelViewer();
      shell.appendChild(node('p','','Preview, download, or continue refining in the workspace.'));
      if(glb){
        const viewer=node('model-viewer','generation-model');
        viewer.setAttribute('src',glb);
        viewer.setAttribute('camera-controls','');
        viewer.setAttribute('auto-rotate','');
        viewer.setAttribute('exposure','1');
        viewer.setAttribute('shadow-intensity','.65');
        shell.appendChild(viewer);
      }else if(thumb){
        const img=node('img','generation-image');
        img.src=thumb;
        img.alt='Generated 3D model preview';
        shell.appendChild(img);
      }else{
        shell.appendChild(node('div','generation-empty','3D model is ready in your workspace.'));
      }
      if(!urls.length&&data.downloads_message)shell.appendChild(node('p','generation-preparing',data.downloads_message));
      shell.appendChild(downloadLinks(urls,'3d'));
      shell.appendChild(resultActions('/3dprint','Open 3D Workspace'));
      openModal(shell);
      return;
    }
    const image=safeUrl(pickFirst(data,['image_url','thumbnail_url','url','download_url'])||pickFirst({image_urls:data.image_urls},['image_urls']),{allowBlob:true});
    shell.appendChild(node('p','','Download it or open the workspace to keep creating.'));
    if(image){
      const img=node('img','generation-image');
      img.src=image;
      img.alt='Generated TimrX image';
      shell.appendChild(img);
    }else{
      shell.appendChild(node('div','generation-empty','Image is ready in your workspace.'));
    }
    shell.appendChild(downloadLinks([image],'image'));
    shell.appendChild(resultActions('/3dprint','Open Workspace'));
    openModal(shell);
  }
  function resultActions(primaryHref,primaryText){
    const actions=node('div','generation-actions');
    const primary=node('a','button button-primary',primaryText+' →');
    primary.href=href(primaryHref);
    const credits=node('a','button button-ghost','Create More With Credits');
    credits.href=href('/hub#pricing');
    credits.dataset.upgradeAction='buy_credits';
    actions.append(primary,credits);
    return actions;
  }
  function poll(jobId,type){
    if(currentPoll)window.clearTimeout(currentPoll);
    const started=Date.now();
    let attempts=0;
    const timeoutMs=8*60*1000;
    const tick=async()=>{
      try{
        attempts+=1;
        const data=await apiJson('/api/_mod/homepage/status/'+encodeURIComponent(jobId)+(type?'?type='+encodeURIComponent(type):''),{method:'GET'});
        const status=String(data.status||'').toLowerCase();
        if(status==='done'){
          markLocalTrialUsed();
          setAnswer('ready','Generation complete',`Your ${generationLabel(data.generation_type||type)} is ready.`, `<a class="assistant-route" href="#" data-open-latest-result>View result <span>→</span></a>${blockMarkup()}`);
          answer.querySelector('[data-open-latest-result]')?.addEventListener('click',event=>{event.preventDefault();renderResult(data);});
          renderResult(data);
          track('homepage_generation_completed',{generation_type:data.generation_type||type,job_id:jobId});
          track('homepage_free_trial_used',{generation_type:data.generation_type||type,job_id:jobId});
          return;
        }
        if(status==='failed'){
          setAnswer('error','Generation failed',data.message||data.error||'The provider could not finish this generation. Open the workspace or try again with credits.',blockMarkup());
          track('homepage_generation_failed',{generation_type:data.generation_type||type,job_id:jobId,error:data.error||''});
          return;
        }
        if(Date.now()-started>timeoutMs){
          setAnswer('timeout','Still processing','This is taking longer than expected. You can check the result in the workspace or retry status in a moment.',`<a class="assistant-route" href="${href('/3dprint')}" data-hero-route>Open workspace <span>→</span></a><button type="button" class="assistant-route assistant-route-button" data-retry-status>Retry status</button>`);
          answer.querySelector('[data-retry-status]')?.addEventListener('click',()=>poll(jobId,type));
          track('homepage_generation_failed',{generation_type:data.generation_type||type,job_id:jobId,error:'poll_timeout'});
          return;
        }
        const elapsed=Math.round((Date.now()-started)/1000);
        const progress=typeof data.progress==='number'?` ${data.progress}%`:'';
        setAnswer('thinking','Generating',`${data.message||`Your ${generationLabel(data.generation_type||type)} is still processing`}${progress}${elapsed>8?' — larger assets can take a few minutes':''}.`);
        const delay=attempts<4?1400:attempts<10?2600:attempts<24?5000:9000;
        currentPoll=window.setTimeout(tick,delay);
      }catch(err){
        setAnswer('error','Connection interrupted','The generation started, but polling was interrupted. Open the workspace to check your result.',`<a class="assistant-route" href="${href('/3dprint')}">Open workspace <span>→</span></a><button type="button" class="assistant-route assistant-route-button" data-retry-status>Retry status</button>`);
        answer.querySelector('[data-retry-status]')?.addEventListener('click',()=>poll(jobId,type));
      }
    };
    tick();
  }
  async function startGeneration(prompt){
    const clean=String(prompt||'').trim();
    if(!clean)return;
    if(requiresUpload(clean)){guideUploadFlow(clean);return}
    input.value=clean;
    const requestedType=detectType(clean);
    const requestKey=requestKeys.get(clean)||((window.crypto&&crypto.randomUUID)?crypto.randomUUID():'hp-'+Date.now()+'-'+Math.random().toString(16).slice(2));
    requestKeys.set(clean,requestKey);
    track('homepage_prompt_started',{assistant_query:clean,generation_type:requestedType});
    track('homepage_generation_type',{generation_type:requestedType});
    setAnswer('thinking','Preparing generation',`Choosing the cheapest suitable ${generationLabel(requestedType)} route.`);
    try{
      const data=await apiJson('/api/_mod/homepage/generate',{method:'POST',headers:{'Idempotency-Key':requestKey},body:{prompt:clean,requested_type:'auto',source:'homepage_chat',idempotency_key:requestKey}});
      if(data.ok&&data.job_id){
        markLocalTrialUsed();
        const type=data.generation_type||requestedType;
        setAnswer('thinking','Generation started',data.estimated_message||`Creating your ${generationLabel(type)} now.`);
        track('homepage_generation_started',{generation_type:type,job_id:data.job_id,paid_mode:!!data.paid_mode});
        poll(data.job_id,type);
        return;
      }
      if(data.error==='active_trial'&&data.job_id){
        setAnswer('thinking','Generation already running','Your free homepage generation is already processing.');
        poll(data.job_id,data.generation_type||requestedType);
        return;
      }
      if(data.error==='free_trial_used'||data.error==='active_trial'||data.http_status===402){
        markLocalTrialUsed();
        setAnswer('blocked','Free generation used',data.message||'Your one free homepage generation has been used. Sign up or buy credits to keep creating.',blockMarkup());
        track('homepage_free_trial_used',{reason:data.error||'free_trial_used'});
        return;
      }
      setAnswer('error','Could not start generation',data.message||data.error||'Open the workspace to continue with credits.',`<a class="assistant-route" href="${href('/3dprint')}">Open workspace <span>→</span></a>`);
      track('homepage_generation_error',{error:data.error||String(data.http_status||'unknown')});
    }catch(err){
      const localHint=apiBase.includes('localhost')||apiBase.includes('127.0.0.1')?' Make sure the local 3D backend is running on the configured API port.':'';
      setAnswer('error','Generation service unavailable','The homepage generator could not reach the TimrX generation backend.'+localHint,`<a class="assistant-route" href="${href('/3dprint')}">Open workspace <span>→</span></a>`);
      track('homepage_generation_network_error',{message:err&&err.message||'network_error'});
    }
  }
  function syncDock(){document.body.classList.toggle('hero-command-docked',window.scrollY>Math.max(260,window.innerHeight*.42))}
  function initDynamicHeadline(){
    if(!headline)return;
    const phrases=['Product Mockups.','Printable 3D Models.','Cinematic Videos.','Game Assets.','Product Visuals.','Multi-Colour Models.','STL Files.','Anything.'];
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){headline.textContent=phrases[0];return}
    let index=0,text=phrases[index],char=text.length,deleting=true;
    const typeDelay=68,deleteDelay=34,holdDelay=1850,swapDelay=260;
    headline.textContent=text;
    function tick(){
      text=phrases[index];
      if(deleting){
        char=Math.max(0,char-1);headline.textContent=text.slice(0,char);
        if(char===0){deleting=false;index=(index+1)%phrases.length;window.setTimeout(tick,swapDelay);return}
        window.setTimeout(tick,deleteDelay);return;
      }
      text=phrases[index];char=Math.min(text.length,char+1);headline.textContent=text.slice(0,char);
      if(char===text.length){deleting=true;window.setTimeout(tick,holdDelay);return}
      window.setTimeout(tick,typeDelay);
    }
    window.setTimeout(tick,holdDelay);
  }

  document.querySelectorAll('[data-hero-prompt]').forEach(button=>button.addEventListener('click',()=>{const prompt=button.dataset.heroPrompt||button.textContent;track('assistant_prompt_chip_click',{assistant_query:prompt});if(button.dataset.requiresUpload){guideUploadFlow(prompt);return}startGeneration(prompt)}));
  form.addEventListener('submit',event=>{event.preventDefault();startGeneration(input.value)});
  function askAssistant(question){
    const text=String(question||(input&&input.value)||'').trim();
    track('hero_ask_assistant',{assistant_query:text});
    const toggle=document.getElementById('chatToggle');
    const chatInput=document.getElementById('chatInput');
    const chatSend=document.getElementById('chatSend');
    if(!toggle||!chatInput){window.location.href=href('/hub');return;}
    if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();
    window.setTimeout(()=>{
      chatInput.value=text;
      chatInput.dispatchEvent(new Event('input',{bubbles:true}));
      if(text&&chatSend){chatSend.click();}else{try{chatInput.focus({preventScroll:true});}catch(err){chatInput.focus();}}
    },280);
  }
  const askBtn=document.getElementById('heroAskBtn');
  if(askBtn)askBtn.addEventListener('click',()=>askAssistant(input.value));
  document.querySelectorAll('[data-hero-question]').forEach(btn=>btn.addEventListener('click',()=>askAssistant(btn.getAttribute('data-hero-question')||btn.textContent)));
  document.addEventListener('click',event=>{
    const download=event.target.closest('[data-result-download]');
    if(download)track('homepage_result_download_clicked',{generation_type:download.dataset.generationType||'',assistant_route:download.getAttribute('href')});
    const upgrade=event.target.closest('[data-upgrade-action]');
    if(upgrade&&upgrade.dataset.upgradeAction==='signup')track('homepage_signup_clicked_after_trial',{assistant_route:upgrade.getAttribute('href')});
    if(upgrade&&upgrade.dataset.upgradeAction==='buy_credits')track('homepage_buy_credits_clicked_after_trial',{assistant_route:upgrade.getAttribute('href')});
  });
  answer.addEventListener('click',event=>{const link=event.target.closest('[data-hero-route]');if(link)track('assistant_route_click',{assistant_route:link.getAttribute('href')})});
  window.addEventListener('scroll',syncDock,{passive:true});
  window.addEventListener('resize',syncDock,{passive:true});
  if(localTrialUsed())setAnswer('blocked','One free generation included','You can generate once from the homepage. If you already used it, open the workspace or buy credits to keep creating.',blockMarkup());
  initDynamicHeadline();
  syncDock();
})();
