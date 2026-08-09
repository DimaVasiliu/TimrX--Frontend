const BACKEND=window.TIMRX_ENV?.threedApiBase||window.TIMRX_3D_API_BASE||'https://3d.timrx.live';
const CSRF_COOKIE_NAME='timrx_csrf';
const CSRF_HEADER_NAME='X-CSRF-Token';

if(window.location.protocol==='file:'){
  const previews={'/':'index.html','/hub':'hub.html','/3dprint':'3dprint.html','/nia/support':'nia/support.html','/cookies':'cookies.html','/dima-vasiliu':'dima-vasiliu.html'};
  document.querySelectorAll('a[href^="/"]').forEach(link=>{const raw=link.getAttribute('href');const match=raw.match(/^([^?#]+)(.*)$/);const preview=match&&previews[match[1]];if(preview)link.setAttribute('href',preview+match[2])});
}

function getCookie(name){
  const match=document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}=([^;]*)`));
  return match?decodeURIComponent(match[1]):'';
}

async function ensureCsrfToken(){
  const existing=getCookie(CSRF_COOKIE_NAME);
  if(existing)return existing;
  try{
    const response=await fetch(`${BACKEND}/api/me`,{method:'GET',credentials:'include',mode:'cors',headers:{Accept:'application/json'}});
    await response.text().catch(()=>{});
  }catch(error){
    console.warn('[Portfolio contact] CSRF bootstrap unavailable:',error?.message||error);
  }
  return getCookie(CSRF_COOKIE_NAME);
}

async function apiPost(path,body,{timeout=20000}={}){
  const token=await ensureCsrfToken();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const headers={'Content-Type':'application/json',Accept:'application/json'};
    if(token)headers[CSRF_HEADER_NAME]=token;
    const response=await fetch(`${BACKEND}${path}`,{method:'POST',credentials:'include',mode:'cors',headers,body:JSON.stringify(body),signal:controller.signal});
    const data=await response.json().catch(()=>null);
    return{ok:response.ok,status:response.status,data,error:response.ok?null:(typeof data?.error==='string'?data.error:data?.error?.message)||data?.message||`HTTP ${response.status}`};
  }finally{clearTimeout(timer)}
}

/* Mobile menu lives in js/shared/tx-menu.js — shared by every page. */

const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealItems=document.querySelectorAll('.reveal');
if(reduced||!('IntersectionObserver'in window)){revealItems.forEach(item=>item.classList.add('is-visible'))}else{const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target)}}),{threshold:.1,rootMargin:'0px 0px -25px'});revealItems.forEach(item=>observer.observe(item))}
const heroStage=document.querySelector('.hero-stage');
const heroPhoto=document.querySelector('.hero-photo');
const heroNameEl=document.querySelector('.hero-name');
const heroTitleStrip=document.querySelector('.hero-title-strip');
if(heroStage&&heroPhoto&&heroNameEl&&!reduced&&window.matchMedia('(hover:hover) and (pointer:fine)').matches){
  let raf=0,nx=0,ny=0;
  heroStage.addEventListener('pointermove',event=>{
    const rect=heroStage.getBoundingClientRect();
    nx=(event.clientX-rect.left)/rect.width-0.5;
    ny=(event.clientY-rect.top)/rect.height-0.5;
    if(!raf)raf=requestAnimationFrame(()=>{raf=0;
      heroPhoto.style.setProperty('--ppx',(nx*14).toFixed(1)+'px');
      heroPhoto.style.setProperty('--ppy',(ny*14).toFixed(1)+'px');
      heroNameEl.style.setProperty('--npx',(nx*-10).toFixed(1)+'px');
      heroNameEl.style.setProperty('--npy',(ny*-7).toFixed(1)+'px');
      heroTitleStrip?.style.setProperty('--spx',(nx*7).toFixed(1)+'px');
      heroTitleStrip?.style.setProperty('--spy',(ny*5).toFixed(1)+'px');
      heroTitleStrip?.style.setProperty('--mx',((nx+0.5)*100).toFixed(1)+'%');
      heroTitleStrip?.style.setProperty('--my',((ny+0.5)*100).toFixed(1)+'%');
    });
  });
  heroStage.addEventListener('pointerleave',()=>{
    heroPhoto.style.setProperty('--ppx','0px');heroPhoto.style.setProperty('--ppy','0px');
    heroNameEl.style.setProperty('--npx','0px');heroNameEl.style.setProperty('--npy','0px');
    heroTitleStrip?.style.setProperty('--spx','0px');heroTitleStrip?.style.setProperty('--spy','0px');
    heroTitleStrip?.style.setProperty('--mx','52%');heroTitleStrip?.style.setProperty('--my','46%');
  });
}
document.querySelectorAll('[data-experience]').forEach(node=>{node.textContent=`${Math.max(1,new Date().getFullYear()-2022)}+`});
document.querySelectorAll('[data-year]').forEach(node=>{node.textContent=String(new Date().getFullYear())});

const form=document.getElementById('portfolioContactForm');
const note=document.getElementById('portfolioFormNote');
function setNote(message,isError=false){if(!note)return;note.textContent=message;note.classList.toggle('is-error',isError)}
form?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!form.checkValidity()){form.reportValidity();setNote('Please complete all required fields.',true);return}
  const data=new FormData(form);
  if(String(data.get('website')||'').trim()){setNote('Unable to send this request.',true);return}
  const button=form.querySelector('button[type="submit"]');
  button.disabled=true;button.innerHTML='Sending…';setNote('');
  try{
    const response=await apiPost('/api/contact/submit',{name:String(data.get('name')||''),email:String(data.get('email')||''),subject:String(data.get('subject')||''),budget:String(data.get('budget')||''),message:String(data.get('message')||''),website:String(data.get('website')||'')},{timeout:20000,retry:false});
    if(!response.ok)throw new Error(response.error||'Unable to send your message.');
    form.reset();setNote(response.data?.message||'Your message has been sent. I’ll reply within 24–48 hours.');
    window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:'portfolio_contact_submit',form_name:'portfolio_project_enquiry'});
  }catch(error){console.error('[Portfolio contact]',error);setNote(error.message||`Unable to send. Email admin@timrx.live instead.`,true)}finally{button.disabled=false;button.innerHTML='Send project enquiry <span>→</span>'}
});

window.dataLayer=window.dataLayer||[];
window.dataLayer.push({event:'portfolio_page_view',page_type:'personal_portfolio',backend_origin:BACKEND});
