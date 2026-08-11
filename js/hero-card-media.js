(function(){
  var deck=document.querySelector('[data-hero-card-deck]');
  if(!deck)return;

  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fallback={
    video:[
      {src:'vid/hero-2.mp4',poster:'img/video-posters/hero-2.jpg'},
      {src:'vid/hero-1.mp4',poster:'img/video-posters/hero-1.jpg'},
      {src:'vid/hero-3.mp4',poster:'img/video-posters/hero-3.jpg'},
      {src:'vid/vid2.mp4',poster:'img/video-posters/vid2.jpg'}
    ],
    image:[
      {src:'img/AI-img-gen-1.png'},
      {src:'img/AI-img-gen-2.png'},
      {src:'img/AI-img-gen-3.png'},
      {src:'img/AI-img-gen-4.png'},
      {src:'img/AI-img-gen-5.png'}
    ],
    model:[
      {src:'vid/models/mod5.glb',poster:'img/model-posters/mod5.png'},
      {src:'vid/models/mod1.glb',poster:'img/model-posters/mod1.png'},
      {src:'vid/models/mod2.glb',poster:'img/model-posters/mod2.png'},
      {src:'vid/models/mod3.glb',poster:'img/model-posters/mod3.png'}
    ]
  };

  function apiBase(){
    var env=window.TIMRX_ENV||{};
    return String(env.threedApiBase||window.TIMRX_3D_API_BASE||'https://3d.timrx.live').replace(/\/+$/,'');
  }

  function isRemote(url){
    return /^https?:\/\//i.test(url||'');
  }

  function shouldProxyModel(url){
    if(!isRemote(url))return false;
    return /assets\.meshy\.ai|meshy\.ai|amazonaws\.com|\.s3[.-]/i.test(url);
  }

  function loadableModelUrl(url){
    if(!url)return '';
    if(window.TimrXApi&&typeof window.TimrXApi.getLoadableModelUrl==='function'){
      return window.TimrXApi.getLoadableModelUrl(url);
    }
    return shouldProxyModel(url)?apiBase()+'/api/_mod/proxy-glb?u='+encodeURIComponent(url):url;
  }

  function normalizeFeed(data,type){
    var posts=Array.isArray(data&&data.posts)?data.posts:[];
    return posts.map(function(post){
      var asset=post.asset||{};
      if(type==='video'){
        return {src:asset.video_url||asset.media_url||'',poster:asset.thumbnail_url||'',title:asset.title||post.prompt_public||''};
      }
      if(type==='model'){
        return {src:loadableModelUrl(asset.animation_glb_url||asset.glb_url||''),poster:asset.thumbnail_url||'',title:asset.title||post.prompt_public||''};
      }
      return {src:asset.image_url||asset.thumbnail_url||'',poster:asset.thumbnail_url||'',title:asset.title||post.prompt_public||''};
    }).filter(function(item){return !!item.src;}).slice(0,6);
  }

  function fetchFeed(type){
    var controller='AbortController'in window?new AbortController():null;
    var timer=controller?setTimeout(function(){controller.abort();},3200):null;
    var url=apiBase()+'/api/_mod/community/feed?limit=12&offset=0&type='+encodeURIComponent(type)+'&sort=newest';
    return fetch(url,{
      method:'GET',
      mode:'cors',
      credentials:'include',
      cache:'no-store',
      signal:controller&&controller.signal,
      headers:{Accept:'application/json'}
    }).then(function(res){
      if(timer)clearTimeout(timer);
      if(!res.ok)throw new Error('feed_'+type+'_'+res.status);
      return res.json();
    }).then(function(data){
      return normalizeFeed(data,type);
    }).catch(function(){
      if(timer)clearTimeout(timer);
      return [];
    });
  }

  function setVideoItems(items){
    var stage=deck.querySelector('[data-hero-media="video"]');
    var video=stage&&stage.querySelector('video');
    if(!video||!items.length)return;
    if(stage._heroTimer)window.clearInterval(stage._heroTimer);
    var index=0;
    function show(nextIndex){
      index=nextIndex%items.length;
      var item=items[index];
      if(!item||!item.src)return;
      stage.classList.add('is-swapping');
      window.setTimeout(function(){
        video.poster=item.poster||video.poster||'';
        if(video.currentSrc!==item.src&&video.src!==item.src){
          video.src=item.src;
          video.load();
        }
        video.play&&video.play().catch(function(){});
        stage.querySelectorAll('.hero-media-dots i').forEach(function(dot,i){
          dot.classList.toggle('is-active',i===index%3);
        });
        stage.classList.remove('is-swapping');
      },160);
    }
    show(0);
    if(!reduced&&items.length>1)stage._heroTimer=window.setInterval(function(){show(index+1);},7200);
  }

  function setImageItems(items){
    var stage=deck.querySelector('[data-hero-media="image"]');
    if(!stage||!items.length)return;
    if(stage._heroTimer)window.clearInterval(stage._heroTimer);
    var imgs=Array.prototype.slice.call(stage.querySelectorAll('img'));
    while(imgs.length<Math.min(items.length,4)){
      var img=document.createElement('img');
      img.alt='';
      img.loading='lazy';
      img.decoding='async';
      stage.insertBefore(img,stage.firstChild);
      imgs.unshift(img);
    }
    imgs.forEach(function(img,i){
      var item=items[i%items.length];
      img.src=item.src;
      img.classList.toggle('is-active',i===0);
    });
    var index=0;
    if(!reduced&&items.length>1)stage._heroTimer=window.setInterval(function(){
      index=(index+1)%imgs.length;
      imgs.forEach(function(img,i){img.classList.toggle('is-active',i===index);});
    },5200);
  }

  function setModelItems(items){
    var stage=deck.querySelector('[data-hero-media="model"]');
    var viewer=stage&&stage.querySelector('model-viewer');
    var poster=stage&&stage.querySelector('.hero-model-poster');
    if(!viewer||!items.length)return;
    if(stage._heroTimer)window.clearInterval(stage._heroTimer);
    var index=0;
    function show(nextIndex){
      index=nextIndex%items.length;
      var item=items[index];
      if(!item||!item.src)return;
      stage.classList.add('is-swapping');
      window.setTimeout(function(){
        viewer.setAttribute('poster',item.poster||'');
        viewer.setAttribute('src',item.src);
        if(poster&&item.poster)poster.src=item.poster;
        stage.classList.remove('is-swapping');
      },220);
    }
    show(0);
    if(!reduced&&items.length>1)stage._heroTimer=window.setInterval(function(){show(index+1);},8800);
  }

  setVideoItems(fallback.video);
  setImageItems(fallback.image);
  setModelItems(fallback.model);

  Promise.all([fetchFeed('video'),fetchFeed('image'),fetchFeed('model')]).then(function(results){
    if(results[0].length)setVideoItems(results[0]);
    if(results[1].length)setImageItems(results[1]);
    if(results[2].length)setModelItems(results[2]);
  });
})();
