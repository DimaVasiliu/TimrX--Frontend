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
      {src:'vid/image-to-3d/toy-robot.glb',poster:'vid/image-to-3d/toy-robot.png',fit:'product',title:'Toy robot'},
      {src:'vid/image-to-3d/ceramic-mug.glb',poster:'vid/image-to-3d/ceramic-mug.png',fit:'product',title:'Ceramic mug'},
      {src:'vid/image-to-3d/running-shoe.glb',poster:'vid/image-to-3d/running-shoe.png',fit:'wide',title:'Running shoe'},
      {src:'vid/text-to-3d/sci-fi-blaster.glb',fit:'wide',title:'Sci-fi blaster'},
      {src:'vid/text-to-3d/steampunk-robot.glb',fit:'character',title:'Steampunk robot'},
      {src:'vid/text-to-3d/low-poly-castle.glb',fit:'wide',title:'Low poly castle'},
      {src:'vid/image-to-3d/vintage-camera.glb',poster:'vid/image-to-3d/vintage-camera.png',fit:'wide',title:'Vintage camera'}
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

  function asArray(data){
    if(Array.isArray(data))return data;
    if(Array.isArray(data&&data.posts))return data.posts;
    if(Array.isArray(data&&data.items))return data.items;
    if(Array.isArray(data&&data.results))return data.results;
    if(Array.isArray(data&&data.data))return data.data;
    return [];
  }

  function firstString(){
    for(var i=0;i<arguments.length;i++){
      var value=arguments[i];
      if(typeof value==='string'&&value.trim())return value.trim();
    }
    return '';
  }

  function readPath(source,path){
    if(!source)return '';
    var parts=path.split('.');
    var value=source;
    for(var i=0;i<parts.length;i++){
      if(value==null)return '';
      value=value[parts[i]];
    }
    return value;
  }

  function fileLooksLikeModel(url){
    return /\.glb(\?|#|$)|\.gltf(\?|#|$)|\/models?\//i.test(url||'');
  }

  function inferModelFit(item){
    var text=String((item&&item.title)||'').toLowerCase();
    if(/shoe|camera|blaster|castle|ship|car|vehicle|tool|prop|mug/.test(text))return 'wide';
    if(/robot|character|miniature|figure|person|creature|warrior/.test(text))return 'character';
    return 'balanced';
  }

  function dedupeItems(items){
    var seen={};
    return items.filter(function(item){
      var key=(item&&item.src||'').replace(/\?.*$/,'');
      if(!key||seen[key])return false;
      seen[key]=true;
      return true;
    });
  }

  function normalizeFeed(data,type){
    return dedupeItems(asArray(data).map(function(post){
      var asset=post.asset||post||{};
      var title=firstString(asset.title,post.title,post.prompt_public,asset.prompt);
      var poster=firstString(
        asset.thumbnail_url,
        asset.poster,
        asset.poster_url,
        asset.preview_url,
        asset.image_url,
        post.thumbnail_url,
        post.preview_url
      );
      if(type==='video'){
        return {src:firstString(asset.video_url,asset.media_url,post.video_url),poster:poster,title:title};
      }
      if(type==='model'){
        var modelUrl=firstString(
          asset.animation_glb_url,
          asset.glb_url,
          asset.gltf_url,
          asset.model_url,
          asset.modelUrl,
          asset.download_url,
          asset.file_url,
          asset.media_url,
          readPath(asset,'outputs.glb_url'),
          readPath(asset,'outputs.model_url'),
          readPath(asset,'result.glb_url'),
          readPath(post,'outputs.glb_url'),
          readPath(post,'result.glb_url')
        );
        if(modelUrl&&!fileLooksLikeModel(modelUrl))modelUrl='';
        return {src:loadableModelUrl(modelUrl),poster:poster,title:title,fit:inferModelFit({title:title})};
      }
      return {src:firstString(asset.image_url,asset.thumbnail_url,post.image_url,post.thumbnail_url),poster:poster,title:title};
    }).filter(function(item){return !!item.src;})).slice(0,type==='model'?1:6);
  }

  function fetchFeed(type){
    var controller='AbortController'in window?new AbortController():null;
    var timer=controller?setTimeout(function(){controller.abort();},3200):null;
    var limit=type==='model'?36:18;
    var url=apiBase()+'/api/_mod/community/feed?limit='+limit+'&offset=0&type='+encodeURIComponent(type)+'&sort=newest';
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
    items=dedupeItems(items).slice(0,1);
    if(stage._heroTimer)window.clearInterval(stage._heroTimer);
    if(!stage._heroModelLoadBound){
      if(poster){poster.addEventListener('error',function(){poster.hidden=true;});}
      viewer.addEventListener('load',function(){
        stage.classList.add('is-model-loaded');
      });
      viewer.addEventListener('error',function(){
        stage.classList.remove('is-model-loaded');
      });
      stage._heroModelLoadBound=true;
    }
    var index=0;
    function show(nextIndex){
      index=nextIndex%items.length;
      var item=items[index];
      if(!item||!item.src)return;
      stage.classList.add('is-swapping');
      window.setTimeout(function(){
        var fit=item.fit||inferModelFit(item);
        stage.classList.remove('is-model-loaded');
        stage.classList.add('has-model-source');
        stage.setAttribute('data-model-fit',fit);
        stage.setAttribute('data-model-index',String(index+1));
        stage.setAttribute('data-model-count',String(items.length));
        viewer.removeAttribute('poster');
        viewer.setAttribute('src',item.src);
        if(poster){
          poster.hidden=true;
          poster.removeAttribute('src');
        }
        var chip=stage.querySelector('.hero-media-chip');
        if(chip)chip.textContent=items.length>1?'Live orbit '+(index+1)+'/'+items.length:'Live orbit';
        stage.classList.remove('is-swapping');
      },220);
    }
    show(0);
  }

  setVideoItems(fallback.video);
  setImageItems(fallback.image);
  setModelItems(fallback.model.slice(0,1));

  Promise.all([fetchFeed('video'),fetchFeed('image'),fetchFeed('model')]).then(function(results){
    if(results[0].length)setVideoItems(results[0]);
    if(results[1].length)setImageItems(results[1]);
    if(results[2].length)setModelItems(results[2]);
  });
})();
