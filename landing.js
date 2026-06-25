(function(){
  'use strict';
  if(window.location.protocol==='file:'){
    const previews={'/':'index.html','/hub':'hub.html','/3dprint':'3dprint.html','/ai-tools':'ai-tools.html','/ai-image-generator':'ai-image-generator.html','/ai-video-generator':'ai-video-generator.html','/ai-3d-generator':'ai-3d-generator.html','/text-to-3d':'text-to-3d.html','/image-to-3d':'image-to-3d.html','/converter':'converter.html','/stl-library':'stl-library.html','/print-on-demand':'print-on-demand.html','/blogs':'blogs.html','/company':'company.html','/terms':'terms.html','/privacy':'privacy.html','/cookies':'cookies.html','/dima-vasiliu':'dima-vasiliu.html'};
    document.querySelectorAll('a[href^="/"]').forEach(link=>{const raw=link.getAttribute('href');const match=raw.match(/^([^?#]+)(.*)$/);const preview=match&&previews[match[1]];if(preview)link.setAttribute('href',preview+match[2])});
  }
  const legacySection={works:'works',services:'services',contact:'contact'}[window.location.hash.slice(1)];
  if(legacySection){window.location.replace(`${window.location.protocol==='file:'?'dima-vasiliu.html':'/dima-vasiliu'}#${legacySection}`);return}
  const header=document.querySelector('[data-header]');
  const menuButton=document.querySelector('.menu-button');
  const mobileNav=document.getElementById('mobileNav');
  const setHeader=()=>header?.classList.toggle('is-scrolled',window.scrollY>18);
  setHeader();window.addEventListener('scroll',setHeader,{passive:true});
  function closeMenu(){if(!menuButton||!mobileNav)return;menuButton.setAttribute('aria-expanded','false');menuButton.setAttribute('aria-label','Open menu');mobileNav.hidden=true;document.body.classList.remove('menu-open')}
  menuButton?.addEventListener('click',()=>{const open=menuButton.getAttribute('aria-expanded')==='true';if(open){closeMenu();return}menuButton.setAttribute('aria-expanded','true');menuButton.setAttribute('aria-label','Close menu');mobileNav.hidden=false;document.body.classList.add('menu-open')});
  mobileNav?.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu()});
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealItems=document.querySelectorAll('.reveal');
  if(reduced||!('IntersectionObserver'in window)){revealItems.forEach(item=>item.classList.add('is-visible'))}else{const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target)}}),{threshold:.12,rootMargin:'0px 0px -30px'});revealItems.forEach(item=>observer.observe(item))}
  document.querySelectorAll('[data-track]').forEach(link=>link.addEventListener('click',()=>{window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:'cta_click',cta_name:link.dataset.track,cta_url:link.getAttribute('href'),page_type:'platform_landing'})}));
  document.querySelectorAll('[data-year]').forEach(node=>{node.textContent=String(new Date().getFullYear())});
})();
