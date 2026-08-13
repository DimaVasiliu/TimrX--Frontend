(function(){
  'use strict';

  const form=document.getElementById('heroAssistantForm');
  const input=document.getElementById('heroAssistantInput');
  const answer=document.getElementById('heroAssistantAnswer');
  const headline=document.querySelector('[data-hero-headline]');
  const subcopy=document.querySelector('[data-hero-subcopy]');
  if(!form||!input||!answer)return;

  const isFile=window.location.protocol==='file:';
  const routes={'/':'index.html','/3dprint':'3dprint.html','/hub':'hub.html','/ai-tools':'ai-tools.html','/ai-image-generator':'ai-image-generator.html','/ai-video-generator':'ai-video-generator.html','/ai-3d-generator':'ai-3d-generator.html','/ai-game-assets':'ai-game-assets.html','/text-to-3d':'text-to-3d.html','/image-to-3d':'image-to-3d.html','/converter':'converter.html','/stl-library':'stl-library.html','/blogs':'blogs.html','/print-on-demand':'print-on-demand.html'};
  const trialStorageKey='timrx_homepage_free_generation_used';
  const apiBase=(window.TIMRX_3D_API_BASE||(window.TIMRX_ENV&&window.TIMRX_ENV.threedApiBase)||'https://3d.timrx.live').replace(/\/+$/,'');
  const turnstileSiteKey=(window.TIMRX_TURNSTILE_SITE_KEY||(window.TIMRX_ENV&&window.TIMRX_ENV.turnstileSiteKey)||'0x4AAAAAADrAmfltMdgMr9lE').trim();
  let currentPoll=null;
  const requestKeys=new Map();
  let turnstileWidgetId=null;
  let turnstileAction='';
  let turnstileContainer=null;
  const desktopPlaceholder=input.getAttribute('placeholder')||'Ask a question or describe what to create…';
  const mobilePlaceholder='Describe what to create…';

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
  function ensureTurnstileContainer(){
    if(turnstileContainer&&document.body.contains(turnstileContainer))return turnstileContainer;
    turnstileWidgetId=null;
    turnstileContainer=document.createElement('div');
    turnstileContainer.className='turnstile-holder';
    turnstileContainer.setAttribute('aria-label','Human verification');
    return turnstileContainer;
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
  function waitForTurnstile(timeoutMs=8000){
    if(window.turnstile&&typeof window.turnstile.render==='function')return Promise.resolve(window.turnstile);
    return new Promise((resolve,reject)=>{
      const started=Date.now();
      const timer=window.setInterval(()=>{
        if(window.turnstile&&typeof window.turnstile.render==='function'){
          window.clearInterval(timer);
          resolve(window.turnstile);
          return;
        }
        if(Date.now()-started>timeoutMs){
          window.clearInterval(timer);
          reject(new Error('turnstile_unavailable'));
        }
      },80);
    });
  }
  async function getTurnstileToken(action='free_generation'){
    if(isFile)return '';
    if(!turnstileSiteKey)throw new Error('turnstile_site_key_missing');
    const turnstile=await waitForTurnstile();
    const container=ensureTurnstileContainer();
    const verificationHost=action==='chat_assistant'?(document.querySelector('.chat-main')||answer):answer;
    if(!verificationHost.contains(container))verificationHost.appendChild(container);
    return new Promise((resolve,reject)=>{
      let settled=false;
      const done=(fn,value)=>{
        if(settled)return;
        settled=true;
        window.clearTimeout(timeout);
        fn(value);
      };
      const timeout=window.setTimeout(()=>done(reject,new Error('turnstile_timeout')),60000);
      const options={
        sitekey:turnstileSiteKey,
        size:'flexible',
        theme:'dark',
        appearance:action==='chat_assistant'?'interaction-only':'always',
        action,
        callback:token=>done(resolve,token),
        'error-callback':()=>done(reject,new Error('turnstile_error')),
        'expired-callback':()=>done(reject,new Error('turnstile_expired')),
        'timeout-callback':()=>done(reject,new Error('turnstile_timeout'))
      };
      try{
        if(turnstileAction&&turnstileAction!==action&&turnstileWidgetId!==null){
          try{turnstile.remove(turnstileWidgetId);}catch(error){}
          turnstileWidgetId=null;
          turnstileContainer.replaceChildren();
        }
        turnstileAction=action;
        if(turnstileWidgetId===null||turnstileWidgetId===undefined){
          turnstileWidgetId=turnstile.render(container,options);
        }else{
          turnstile.reset(turnstileWidgetId);
        }
      }catch(error){
        done(reject,error);
      }
    });
  }
  function resetTurnstile(){
    try{
      if(window.turnstile&&turnstileWidgetId!==null&&turnstileWidgetId!==undefined)window.turnstile.reset(turnstileWidgetId);
    }catch(error){}
  }
  window.TimrXHumanVerification={getToken:getTurnstileToken,reset:resetTurnstile};
  let answerDismissTimer=null;
  function closeAnswer(){if(answerDismissTimer){clearTimeout(answerDismissTimer);answerDismissTimer=null;}answer.hidden=true;answer.classList.remove('is-thinking');answer.replaceChildren();}
  function setAnswer(state,title,body,actions=''){
    if(answerDismissTimer){clearTimeout(answerDismissTimer);answerDismissTimer=null;}
    answer.hidden=false;
    answer.classList.toggle('is-thinking',state==='thinking');
    answer.replaceChildren();
    const close=node('button','assistant-answer-close','×');
    close.type='button';
    close.setAttribute('aria-label','Dismiss');
    close.addEventListener('click',closeAnswer);
    answer.appendChild(close);
    answer.appendChild(node('span','assistant-answer-kicker',title));
    answer.appendChild(node('p','',body));
    appendTrustedMarkup(answer,actions);
    // Auto-dismiss only on a successful result; keep errors/upsells/progress sticky.
    if(state==='ready'){answerDismissTimer=setTimeout(closeAnswer,7000);}
  }
  function blockMarkup(){
    return `<div class="assistant-actions">
      <a class="assistant-route" href="${href('/3dprint')}" data-hero-route data-upgrade-action="signup">Sign Up <span>→</span></a>
      <a class="assistant-route assistant-route-muted" href="${href('/hub#pricing')}" data-hero-route data-upgrade-action="buy_credits">Buy Credits</a>
      <a class="assistant-route assistant-route-muted" href="${href('/3dprint')}" data-hero-route>Open workspace</a>
    </div><p class="assistant-trust">Your first generation is saved. Sign up to continue creating and keep your results.</p>`;
  }
  function markLocalTrialUsed(type){try{localStorage.setItem(trialStorageKey+':'+type,'1')}catch(err){}}
  function generationLabel(type){return type==='3d'?'3D model':type==='video'?'video':'image'}
  function detectImageSize(q){
    if(/\b(4k|4096|uhd)\b/.test(q))return'4K';
    if(/\b(2k|2048|quad\s?hd|qhd)\b/.test(q))return'2K';
    if(/\b(1k|1024|standard)\b/.test(q))return'1K';
    return'';
  }
  function detectAspectRatio(q){
    const ratio=q.match(/\b(21:9|16:9|9:16|4:3|3:4|1:1)\b/);
    if(ratio)return ratio[1];
    if(/\b(square|avatar|profile)\b/.test(q))return'1:1';
    if(/\b(vertical|portrait|story|shorts|tiktok|reel)\b/.test(q))return'9:16';
    if(/\b(landscape|wide|cinematic|youtube|banner)\b/.test(q))return'16:9';
    return'';
  }
  function detectDuration(q){
    const match=q.match(/\b(\d{1,2})\s*(?:s|sec|secs|second|seconds)\b/);
    return match?Math.max(1,Math.min(30,parseInt(match[1],10))):null;
  }
  function detectProvider(q,type){
    if(type==='image'){
      if(/\b(nano\s?banana|nanobanana|piapi)\b/.test(q))return'nano_banana';
      if(/\b(google\s+nano|gemini\s+nano)\b/.test(q))return'google_nano';
      if(/\b(gemini|google)\b/.test(q))return'google';
      if(/\b(openai|gpt[-\s]?image|gpt|dall[-\s]?e|dalle)\b/.test(q))return'openai';
      if(/\b(flux|bfl)\b/.test(q))return'flux_pro';
      if(/\b(ideogram)\b/.test(q))return'ideogram_v3';
      if(/\b(recraft|svg|vector)\b/.test(q))return'recraft_v4';
    }
    if(type==='video'){
      if(/\b(veo|vertex|google\s+video|google\s+veo)\b/.test(q))return'vertex';
      if(/\b(fal\s+seedance|seedance\s*1\.?5|fal)\b/.test(q))return'fal_seedance';
      if(/\b(seedance|seedance\s*2|seedance\s*2\.?5)\b/.test(q))return'seedance';
    }
    return'';
  }
  function detectSeedanceTier(q){
    if(/\b(seedance\s*2\.?5|2\.5|v25|unlimited)\b/.test(q))return'v25';
    if(/\b(quality|pro|best|cinematic)\b/.test(q))return'quality';
    if(/\b(mini|cheap|cheapest|draft)\b/.test(q))return'mini';
    if(/\b(fast|quick)\b/.test(q))return'fast';
    return'';
  }
  function parseGenerationIntent(prompt){
    const q=String(prompt||'').toLowerCase();
    const explicitImage=/\b(image|picture|photo|photograph|poster|render|visual|mockup|logo|illustration|artwork|wallpaper|cover|thumbnail|campaign\s+visual|product\s+visual)\b/.test(q);
    const explicitVideo=/\b(video|animate|animation|cinematic|clip|short|reel|movie|motion|text[-\s]?to[-\s]?video|veo|seedance)\b/.test(q);
    const directVideo=/\b(video|animate|animation|clip|reel|movie|text[-\s]?to[-\s]?video|image[-\s]?to[-\s]?video|veo|seedance)\b/.test(q);
    const explicit3d=/\b(3d\s+model|three[-\s]?d\s+model|text[-\s]?to[-\s]?3d|stl|obj|glb|3mf|printable|print[-\s]?ready|mesh|remesh|low[-\s]?poly|figurine|miniature|turntable\s+model)\b/.test(q);
    const objectHints=/\b(keychain|collectible|toy|product|shoe|bottle|chair|robot)\b/.test(q);
    let type='image';
    if(directVideo)type='video';
    else if(explicitImage)type='image';
    else if(explicitVideo)type='video';
    else if(explicit3d)type='3d';
    else if(objectHints&&/\b(print|stl|mesh|model|3d)\b/.test(q))type='3d';
    const provider=detectProvider(q,type);
    const aspect=detectAspectRatio(q);
    const intent={requested_type:type,type};
    if(provider)intent.provider=provider;
    if(aspect)intent.aspect_ratio=aspect;
    if(type==='image'){
      const imageSize=detectImageSize(q);
      if(imageSize)intent.image_size=imageSize;
    }
    if(type==='video'){
      const duration=detectDuration(q);
      const resolution=detectImageSize(q);
      const tier=detectSeedanceTier(q);
      if(duration)intent.duration_seconds=duration;
      if(resolution)intent.resolution=resolution.toLowerCase();
      if(tier)intent.seedance_tier=tier;
    }
    return intent;
  }
  function detectType(prompt){
    return parseGenerationIntent(prompt).requested_type;
  }
  function intentSearchParams(intent){
    const params=new URLSearchParams();
    Object.entries(intent||{}).forEach(([key,value])=>{if(value!==undefined&&value!==null&&value!=='')params.set(key,value)});
    return params.toString();
  }
  function providerLabel(provider){
    return {
      nano_banana:'Nano Banana',
      google_nano:'Google Nano',
      google:'Gemini',
      openai:'GPT Image',
      flux_pro:'FLUX',
      ideogram_v3:'Ideogram',
      recraft_v4:'Recraft',
      vertex:'Veo',
      seedance:'Seedance',
      fal_seedance:'Seedance 1.5',
      meshy:'Meshy'
    }[provider]||provider||'';
  }
  function describeIntent(intent){
    const type=intent.requested_type||'image';
    const bits=[];
    if(intent.provider)bits.push(providerLabel(intent.provider));
    if(type==='image'&&intent.image_size)bits.push(intent.image_size);
    if(type==='video'&&intent.resolution)bits.push(intent.resolution.toUpperCase());
    if(type==='video'&&intent.duration_seconds)bits.push(intent.duration_seconds+'s');
    if(intent.aspect_ratio)bits.push(intent.aspect_ratio);
    return bits.length?bits.join(' ')+' '+generationLabel(type):generationLabel(type);
  }
  function requiresUpload(prompt){
    return /\b(image to 3d|photo to 3d|picture to 3d|turn an image into 3d|upload image|from an image)\b/i.test(String(prompt||''));
  }
  function guideUploadFlow(prompt){
    input.value=prompt;
    setAnswer('guide','Upload needed','To turn an image into 3D, open the workspace and upload your image. The homepage free prompt can start text-based image, video, or 3D generations.',`<a class="assistant-route" href="${href('/image-to-3d')}" data-hero-route>Open Image to 3D <span>→</span></a><a class="assistant-route assistant-route-muted" href="${href('/3dprint')}" data-hero-route>Open workspace</a>`);
    track('homepage_prompt_started',{prompt_length:String(prompt||'').length,generation_type:'image_to_3d_upload_required',blocked_reason:'upload_required'});
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
    const meta=resultMeta(data,type);
    if(meta.childElementCount)shell.appendChild(meta);
    if(type==='video'){
      const video=safeUrl(pickFirst(data,['video_url','output_url','url','download_url']),{allowBlob:true});
      shell.appendChild(node('p','',data.prompt||'Generated from your homepage prompt.'));
      if(video){
        const stage=node('div','generation-preview-stage');
        const preview=node('video','generation-video');
        preview.src=video;
        preview.controls=true;
        preview.autoplay=true;
        preview.muted=true;
        preview.loop=true;
        preview.playsInline=true;
        stage.appendChild(preview);
        shell.appendChild(stage);
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
        const stage=node('div','generation-preview-stage generation-preview-stage-model');
        const viewer=node('model-viewer','generation-model');
        viewer.setAttribute('src',glb);
        viewer.setAttribute('camera-controls','');
        viewer.setAttribute('auto-rotate','');
        viewer.setAttribute('interaction-prompt','none');
        viewer.setAttribute('camera-orbit','20deg 70deg auto');
        viewer.setAttribute('field-of-view','30deg');
        viewer.setAttribute('exposure','1');
        viewer.setAttribute('shadow-intensity','.65');
        if(thumb)viewer.setAttribute('poster',thumb);
        stage.appendChild(viewer);
        stage.appendChild(node('span','generation-viewer-hint','Drag to orbit'));
        shell.appendChild(stage);
      }else if(thumb){
        const stage=node('div','generation-preview-stage');
        const img=node('img','generation-image');
        img.src=thumb;
        img.alt='Generated 3D model preview';
        stage.appendChild(img);
        shell.appendChild(stage);
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
      const stage=node('div','generation-preview-stage');
      const img=node('img','generation-image');
      img.src=image;
      img.alt='Generated TimrX image';
      stage.appendChild(img);
      shell.appendChild(stage);
    }else{
      shell.appendChild(node('div','generation-empty','Image is ready in your workspace.'));
    }
    shell.appendChild(downloadLinks([image],'image'));
    shell.appendChild(resultActions('/3dprint','Open Workspace'));
    openModal(shell);
  }
  function resultMeta(data,type){
    const meta=node('div','generation-meta');
    const settings=data.settings||{};
    const provider=data.provider||settings.provider;
    const size=data.image_size||settings.image_size;
    const resolution=data.resolution||settings.resolution;
    const aspect=data.aspect_ratio||settings.aspect_ratio;
    const duration=data.duration_seconds||settings.duration_seconds;
    const tier=data.seedance_tier||settings.seedance_tier;
    [
      provider&&providerLabel(provider),
      type==='image'&&size,
      type==='video'&&resolution&&String(resolution).toUpperCase(),
      type==='video'&&duration&&(duration+'s'),
      type==='video'&&tier&&('Tier '+tier),
      aspect
    ].filter(Boolean).forEach(value=>meta.appendChild(node('span','',value)));
    return meta;
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
          setAnswer('ready','Generation complete',`Your ${generationLabel(data.generation_type||type)} is ready.`, `<a class="assistant-route" href="#" data-open-latest-result>View result <span>→</span></a>${blockMarkup()}`);
          answer.querySelector('[data-open-latest-result]')?.addEventListener('click',event=>{event.preventDefault();renderResult(data);});
          renderResult(data);
          track('homepage_generation_completed',{generation_type:data.generation_type||type});
          track('homepage_free_trial_used',{generation_type:data.generation_type||type});
          return;
        }
        if(status==='failed'){
          setAnswer('error','Generation failed',data.message||data.error||'The provider could not finish this generation. Open the workspace or try again with credits.',blockMarkup());
          track('homepage_generation_failed',{generation_type:data.generation_type||type,error:data.error||''});
          return;
        }
        if(Date.now()-started>timeoutMs){
          setAnswer('timeout','Still processing','This is taking longer than expected. You can check the result in the workspace or retry status in a moment.',`<a class="assistant-route" href="${href('/3dprint')}" data-hero-route>Open workspace <span>→</span></a><button type="button" class="assistant-route assistant-route-button" data-retry-status>Retry status</button>`);
          answer.querySelector('[data-retry-status]')?.addEventListener('click',()=>poll(jobId,type));
          track('homepage_generation_failed',{generation_type:data.generation_type||type,error:'poll_timeout'});
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
    const intent=parseGenerationIntent(clean);
    const requestedType=intent.requested_type;
    const requestKey=requestKeys.get(clean)||((window.crypto&&crypto.randomUUID)?crypto.randomUUID():'hp-'+Date.now()+'-'+Math.random().toString(16).slice(2));
    requestKeys.set(clean,requestKey);
    track('homepage_prompt_started',{prompt_length:clean.length,generation_type:requestedType,provider:intent.provider||''});
    track('homepage_generation_type',{generation_type:requestedType});
    setAnswer('thinking','Preparing generation',`Preparing ${describeIntent(intent)}.`);
    try{
      const preflight=await apiJson('/api/_mod/homepage/preflight?'+intentSearchParams(intent));
      if(!preflight.ok||preflight.mode==='blocked'){
        setAnswer('blocked','Credits required',preflight.message||`Your free ${generationLabel(requestedType)} has been used and your balance is too low.`,blockMarkup());
        track('homepage_generation_blocked',{generation_type:requestedType,reason:preflight.error||'no_entitlement_or_credits'});
        return;
      }
      let turnstileToken='';
      if(preflight.challenge_required){
        setAnswer('thinking','Human check',`Verify once to claim your free ${preflight.free_offer||generationLabel(requestedType)}.`);
        turnstileToken=await getTurnstileToken();
      }
      setAnswer('thinking','Preparing generation',preflight.mode==='free'?`Claiming your free ${preflight.free_offer||generationLabel(requestedType)}.`:`Reserving ${preflight.required_credits} credits.`);
      const data=await apiJson('/api/_mod/homepage/generate',{method:'POST',headers:{'Idempotency-Key':requestKey},body:{prompt:clean,...intent,source:'homepage_command',idempotency_key:requestKey,turnstile_token:turnstileToken}});
      resetTurnstile();
      if(data.ok&&data.job_id){
        const type=data.generation_type||requestedType;
        if(!data.paid_mode)markLocalTrialUsed(type);
        setAnswer('thinking','Generation started',data.estimated_message||`Creating your ${generationLabel(type)} now.`);
        track('homepage_generation_started',{generation_type:type,paid_mode:!!data.paid_mode});
        poll(data.job_id,type);
        return;
      }
      if(data.error==='active_trial'&&data.job_id){
        setAnswer('thinking','Generation already running','Your homepage generation is already processing.');
        poll(data.job_id,data.generation_type||requestedType);
        return;
      }
      if(data.error==='free_trial_used'||data.error==='active_trial'||data.http_status===402){
        markLocalTrialUsed(requestedType);
        setAnswer('blocked','Continue with credits',data.message||'Homepage starter generation is not available right now. Create an account or add credits to keep creating.',blockMarkup());
        track('homepage_free_trial_used',{reason:data.error||'free_trial_used'});
        return;
      }
      if(data.error==='turnstile_required'||data.http_status===403){
        setAnswer('error','Human verification needed',data.message||'Please verify you are human to use your free generation.',`<button type="button" class="assistant-route assistant-route-button" data-retry-generation>Try verification again</button>`);
        answer.querySelector('[data-retry-generation]')?.addEventListener('click',()=>startGeneration(clean));
        track('homepage_generation_error',{error:data.error||'turnstile_required'});
        return;
      }
      setAnswer('error','Could not start generation',data.message||data.error||'Open the workspace to continue with credits.',`<a class="assistant-route" href="${href('/3dprint')}">Open workspace <span>→</span></a>`);
      track('homepage_generation_error',{error:data.error||String(data.http_status||'unknown')});
    }catch(err){
      resetTurnstile();
      if(String(err&&err.message||'').startsWith('turnstile_')){
        setAnswer('error','Human verification needed','The verification check did not complete. Check content blockers or your connection, then try again.',`<button type="button" class="assistant-route assistant-route-button" data-retry-generation>Try verification again</button>`);
        answer.querySelector('[data-retry-generation]')?.addEventListener('click',()=>startGeneration(clean));
        track('homepage_generation_error',{error:err.message});
        return;
      }
      const localHint=apiBase.includes('localhost')||apiBase.includes('127.0.0.1')?' Make sure the local 3D backend is running on the configured API port.':'';
      setAnswer('error','Generation service unavailable','The homepage generator could not reach the TimrX generation backend.'+localHint,`<a class="assistant-route" href="${href('/3dprint')}">Open workspace <span>→</span></a>`);
      track('homepage_generation_network_error',{message:err&&err.message||'network_error'});
    }
  }
  function syncDock(){document.body.classList.toggle('hero-command-docked',window.scrollY>Math.max(260,window.innerHeight*.42))}
  function syncPromptPlaceholder(){
    input.setAttribute('placeholder',window.innerWidth<=760?mobilePlaceholder:desktopPlaceholder);
  }
  function initDynamicHeadline(){
    if(!headline)return;
    const desktopPhrases=['Product Mockups.','Printable 3D Models.','Cinematic Videos.','Game Assets.','Product Visuals.','Multi-Colour Models.','STL Files.','Anything.'];
    const mobilePhrases=['Mockups.','3D Models.','Videos.','Game Assets.','Product Visuals.','STL Files.','Anything.'];
    const mobileQuery=window.matchMedia('(max-width: 599px)');
    const reducedQuery=window.matchMedia('(prefers-reduced-motion: reduce)');
    const getPhrases=()=>mobileQuery.matches?mobilePhrases:desktopPhrases;
    if(reducedQuery.matches){headline.textContent=getPhrases()[0];return}
    let index=0,text=getPhrases()[index],char=text.length,deleting=true,timer=0,runId=0;
    const typeDelay=68,deleteDelay=34,holdDelay=1850,swapDelay=260;
    function queue(fn,delay){timer=window.setTimeout(fn,delay)}
    function start(){
      runId+=1;
      window.clearTimeout(timer);
      const phrases=getPhrases();
      index=0;text=phrases[index];char=text.length;deleting=true;
      headline.textContent=text;
      const id=runId;
      queue(()=>tick(id),holdDelay);
    }
    function tick(id){
      if(id!==runId)return;
      const phrases=getPhrases();
      if(index>=phrases.length)index=0;
      text=phrases[index];
      if(deleting){
        char=Math.max(0,char-1);headline.textContent=text.slice(0,char);
        if(char===0){deleting=false;index=(index+1)%phrases.length;queue(()=>tick(id),swapDelay);return}
        queue(()=>tick(id),deleteDelay);return;
      }
      text=phrases[index];char=Math.min(text.length,char+1);headline.textContent=text.slice(0,char);
      if(char===text.length){deleting=true;queue(()=>tick(id),holdDelay);return}
      queue(()=>tick(id),typeDelay);
    }
    start();
    if(typeof mobileQuery.addEventListener==='function')mobileQuery.addEventListener('change',start);
    else if(typeof mobileQuery.addListener==='function')mobileQuery.addListener(start);
  }
  function initDynamicSubcopy(){
    if(!subcopy)return;
    const lines=[
      'Generate images, videos and printable 3D models from prompts or uploads.',
      'Refine, convert, export or print from one guided workspace.'
    ];
    const fullText=lines.join(' ');
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){subcopy.textContent=fullText;return}
    subcopy.classList.add('is-typing');
    subcopy.textContent='';
    let line=0,char=0;
    function type(){
      const current=lines[line]||'';
      const before=lines.slice(0,line).join(' ');
      char=Math.min(current.length,char+1);
      subcopy.textContent=(before?before+' ':'')+current.slice(0,char);
      if(char<current.length){window.setTimeout(type,22);return}
      if(line<lines.length-1){line++;char=0;window.setTimeout(type,360);return}
      subcopy.classList.remove('is-typing');
      subcopy.classList.add('is-typed');
    }
    window.setTimeout(type,520);
  }

  document.querySelectorAll('[data-hero-prompt]').forEach(button=>button.addEventListener('click',()=>{const prompt=button.dataset.heroPrompt||button.textContent;track('assistant_prompt_chip_click',{prompt_length:String(prompt||'').length});if(button.dataset.requiresUpload){guideUploadFlow(prompt);return}startGeneration(prompt)}));
  input.addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.isComposing||event.shiftKey||event.metaKey||event.ctrlKey||event.altKey)return;
    event.preventDefault();
    startGeneration(input.value);
  });
  form.addEventListener('submit',event=>{event.preventDefault();startGeneration(input.value)});
  function askAssistant(question){
    const text=String(question||(input&&input.value)||'').trim();
    track('hero_ask_assistant',{prompt_length:text.length});
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
  window.addEventListener('resize',()=>{syncDock();syncPromptPlaceholder()},{passive:true});
  /* The result panel only appears in response to a Generate/Ask action — never unsolicited on load. */
  initDynamicHeadline();
  initDynamicSubcopy();
  syncPromptPlaceholder();
  syncDock();
})();
