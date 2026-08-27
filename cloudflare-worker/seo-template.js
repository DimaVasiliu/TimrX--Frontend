/**
 * Renders a full HTML page for a programmatic SEO landing page.
 * Matches the TimrX dark-theme design system.
 */

export function renderSeoPage(page) {
  const fullUrl = `https://timrx.live${page.basePath}/${page.slug}`;
  const isConverter = page.kind === 'converter';
  const isAviConverter = isConverter && page.slug === 'avi-to-mp4';
  const encodedPrompt = encodeURIComponent(page.prompt || '');
  const ctaUrl = page.ctaUrl || `/3dprint?panel=model&prompt=${encodedPrompt}`;
  const ctaLabel = page.ctaLabel || 'Try This Prompt';
  const secondaryCtaUrl = isConverter ? '/converter' : '/prompts';
  const secondaryCtaLabel = isConverter ? 'Browse All Converters' : 'Browse All Prompts';
  const appName = isConverter ? 'TimrX File Converter' : 'TimrX AI 3D Generator';
  const appCategory = isConverter ? 'UtilitiesApplication' : 'DesignApplication';
  const appUrl = isConverter ? 'https://timrx.live/converter' : 'https://timrx.live/3dprint';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${page.title} — TimrX</title>
  <meta name="description" content="${page.desc}"/>
  <meta name="keywords" content="${page.keywords}"/>
  <meta name="author" content="Dima Vasiliu"/>
  <meta name="robots" content="index, follow, max-image-preview:large"/>
  <link rel="canonical" href="${fullUrl}"/>
  <link rel="alternate" hreflang="en-gb" href="${fullUrl}"/>
  <link rel="alternate" hreflang="x-default" href="${fullUrl}"/>
  <link rel="icon" type="image/png" href="/img/logo.png"/>
  <meta name="theme-color" content="#0b0b0b"/>
  <meta property="og:type" content="website"/>
  <meta property="og:url" content="${fullUrl}"/>
  <meta property="og:title" content="${page.title}"/>
  <meta property="og:description" content="${page.desc}"/>
  <meta property="og:image" content="https://timrx.live/img/OG_APP.png"/>
  <meta property="og:site_name" content="TimrX"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${page.title}"/>
  <meta name="twitter:description" content="${page.desc}"/>
  <meta name="twitter:image" content="https://timrx.live/img/OG_APP.png"/>

  <script type="application/ld+json">
  {
    "@context":"https://schema.org",
    "@type":"WebPage",
    "name":"${page.title}",
    "description":"${page.desc}",
    "url":"${fullUrl}",
    "breadcrumb":{
      "@type":"BreadcrumbList",
      "itemListElement":[
        {"@type":"ListItem","position":1,"name":"TimrX","item":"https://timrx.live"},
        {"@type":"ListItem","position":2,"name":"Hub","item":"https://timrx.live/hub"},
        {"@type":"ListItem","position":3,"name":"${page.h1}","item":"${fullUrl}"}
      ]
    },
    "mainEntity":{
      "@type":"SoftwareApplication",
      "name":"${appName}",
      "applicationCategory":"${appCategory}",
      "url":"${appUrl}"
    }
  }
  </script>

  ${!isConverter ? `<script type="application/ld+json">
  {
    "@context":"https://schema.org",
    "@type":"VideoObject",
    "name":"This AI Tool Creates Printable 3D Models",
    "description":"Official TimrX walkthrough showing how AI generates printable 3D models from prompts — from idea to print-ready output in minutes.",
    "thumbnailUrl":["https://i.ytimg.com/vi/vnuoZ2xV_Ss/maxresdefault.jpg"],
    "uploadDate":"2026-05-19",
    "embedUrl":"https://www.youtube.com/embed/vnuoZ2xV_Ss?start=33",
    "contentUrl":"https://www.youtube.com/watch?v=vnuoZ2xV_Ss&t=33s",
    "publisher":{"@type":"Organization","name":"TimrX","url":"https://timrx.live"}
  }
  </script>` : ''}

  ${(page.faq && page.faq.length) ? `<script type="application/ld+json">
  {
    "@context":"https://schema.org",
    "@type":"FAQPage",
    "mainEntity":[${page.faq.map(f => `
      {"@type":"Question","name":"${f.q.replace(/"/g, '\\"')}","acceptedAnswer":{"@type":"Answer","text":"${f.a.replace(/"/g, '\\"')}"}}`).join(',')}
    ]
  }
  </script>` : ''}

  <style>
    :root{--bg:#0b0b0b;--ink:#f5f5f5;--muted:#a9a9a9;--line:#1d1d1d;--panel:#0e0e0e;--maxw:1280px;--gutter:28px;--navH:70px}
    *{box-sizing:border-box;margin:0}
    html{scroll-behavior:smooth}
    body{background:var(--bg);color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}
    .container{max-width:var(--maxw);margin:0 auto;padding:0 var(--gutter)}

    /* Nav */
    .nav{position:fixed;inset:0 0 auto 0;height:var(--navH);z-index:1000;background:linear-gradient(180deg,rgba(11,11,11,.96),rgba(11,11,11,.75) 75%,rgba(11,11,11,0));backdrop-filter:saturate(120%) blur(8px);border-bottom:1px solid var(--line)}
    .nav-inner{height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 var(--gutter);max-width:var(--maxw);margin:0 auto;width:100%}
    .brand{display:inline-flex;align-items:center;font-weight:900;font-size:clamp(16px,1.25vw,22px);gap:4px}
    .b-tim{color:#f5f5f5}.b-x{background:linear-gradient(90deg,#0ea5e9,#7dd3fc);-webkit-background-clip:text;background-clip:text;color:transparent}
    .nav-pills{display:flex;gap:6px}
    .nav-pill{padding:8px 14px;border-radius:999px;font-size:13px;font-weight:600;color:var(--muted);transition:all .2s}
    .nav-pill:hover{color:var(--ink);background:rgba(255,255,255,.06)}
    .nav-pill--accent{border:1px solid var(--ink);color:var(--ink);font-weight:800}
    .logo-img{width:40px;height:40px;object-fit:contain}

    /* Breadcrumb */
    .breadcrumb{padding-top:calc(var(--navH) + 24px);font-size:13px;color:var(--muted)}
    .breadcrumb a:hover{color:var(--ink)}
    .breadcrumb span{margin:0 8px;opacity:.4}

    /* Hero */
    .seo-hero{padding:60px 0 80px;position:relative;overflow:hidden}
    .seo-hero-watermark{position:absolute;top:50%;right:0;transform:translateY(-50%);font-size:clamp(80px,14vw,220px);font-weight:900;color:rgba(255,255,255,.02);pointer-events:none;letter-spacing:-.04em}
    .seo-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--line);border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:20px}
    .seo-hero h1{font-size:clamp(32px,5vw,56px);font-weight:900;letter-spacing:-.03em;line-height:1.1;margin-bottom:16px}
    .seo-hero p{font-size:17px;line-height:1.7;color:var(--muted);max-width:680px;margin-bottom:32px}

    /* Prompt card */
    .prompt-card{padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--panel);margin-bottom:40px}
    .prompt-label{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
    .prompt-text{font-size:18px;line-height:1.6;font-style:italic;color:#ccc;margin-bottom:24px}
    .prompt-actions{display:flex;gap:12px;flex-wrap:wrap}

    /* Buttons */
    .btn{display:inline-flex;align-items:center;gap:10px;padding:12px 20px;border-radius:999px;border:1px solid var(--ink);font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:13px;transition:all .3s}
    .btn:hover{background:var(--ink);color:var(--bg);transform:translateY(-2px)}
    .btn.ghost{border-color:#2a2a2a;color:#e7e7e7}
    .btn.ghost:hover{background:rgba(255,255,255,.08);color:#fff;border-color:#fff}

    /* Info grid */
    .info-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;margin:40px 0}
    .info-card{padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
    .info-card h3{font-size:16px;font-weight:800;margin-bottom:8px}
    .info-card p{font-size:14px;color:var(--muted);line-height:1.7}

    /* Related */
    .related{margin:60px 0;padding-top:40px;border-top:1px solid var(--line)}
    .related h2{font-size:24px;font-weight:800;margin-bottom:24px}
    .related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
    .related-link{display:block;padding:16px 20px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-weight:600;transition:all .2s}
    .related-link:hover{border-color:rgba(14,165,233,.4);background:rgba(14,165,233,.04)}
    .related-link small{display:block;color:var(--muted);font-weight:400;margin-top:4px;font-size:12px}

    /* Section headings */
    .info-grid h2, .seo-faq h2, .more-prompts h2{font-size:24px;font-weight:800;margin-bottom:20px;grid-column:1/-1}

    /* FAQ */
    .seo-faq{margin:40px 0}
    .seo-faq details{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-bottom:12px;overflow:hidden}
    .seo-faq summary{padding:16px 20px;font-weight:700;font-size:15px;cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .seo-faq summary::-webkit-details-marker{display:none}
    .seo-faq summary::after{content:'+';font-size:20px;font-weight:300;color:var(--muted);transition:transform .2s}
    .seo-faq details[open] summary::after{content:'\u2212'}
    .seo-faq details p{padding:0 20px 16px;font-size:14px;line-height:1.7;color:var(--muted)}

    /* More prompts */
    .more-prompts{margin:40px 0;text-align:center}
    .more-prompts h2{font-size:24px;font-weight:800;margin-bottom:20px}
    .more-prompts ul{list-style:none;padding:0;display:grid;gap:10px;max-width:880px;margin:0 auto;text-align:left}
    .more-prompts li{padding:14px 20px;border:1px solid var(--line);border-radius:10px;font-size:14px;color:#ccc;font-style:italic;background:var(--panel);transition:border-color .2s}
    .more-prompts li:hover{border-color:rgba(14,165,233,.4)}

    /* FAQ centered for readability */
    .seo-faq{max-width:880px;margin-left:auto;margin-right:auto}

    /* Demo video */
    .seo-video{margin:24px 0 64px;text-align:center}
    .seo-video h2{font-size:28px;font-weight:800;margin-bottom:8px;letter-spacing:-.01em}
    .seo-video-sub{font-size:14px;color:var(--muted);margin-bottom:24px}
    .seo-video-card{border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden;max-width:960px;margin-left:auto;margin-right:auto;text-align:left;box-shadow:0 8px 32px rgba(0,0,0,.35)}
    .seo-video-frame{position:relative;aspect-ratio:16/9;background:#000}
    .seo-video-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
    .seo-video-meta{padding:18px 24px;font-size:14px;color:var(--muted);line-height:1.6;border-top:1px solid var(--line)}
    .seo-video-meta strong{color:var(--ink)}
    .seo-video-meta a{text-decoration:underline;text-underline-offset:3px}
    .seo-video-meta a:hover{color:var(--ink)}

    /* CTA */
    .seo-cta{text-align:center;padding:60px 0;margin:40px 0;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
    .seo-cta h2{font-size:28px;font-weight:900;margin-bottom:8px}
    .seo-cta p{color:var(--muted);margin-bottom:24px}

    /* Footer */
    .seo-footer{padding:40px 0;border-top:1px solid var(--line);margin-top:60px;text-align:center;color:var(--muted);font-size:13px}
    .seo-footer a{text-decoration:underline;text-underline-offset:3px}
    .seo-footer a:hover{color:var(--ink)}
    .avi-tool{margin:-36px auto 56px}
    .avi-tool-card{display:grid;gap:18px;padding:20px;border:1px solid #263958;border-radius:16px;background:linear-gradient(135deg,rgba(20,28,42,.96),rgba(20,18,34,.96));box-shadow:0 24px 70px rgba(0,0,0,.35)}
    .avi-drop{min-height:210px;display:grid;place-items:center;text-align:center;border:1px dashed rgba(139,184,255,.42);border-radius:12px;background:rgba(255,255,255,.035);cursor:pointer;transition:border-color .16s,background .16s}
    .avi-drop.is-dragging{border-color:#69a7ff;background:rgba(75,141,255,.12)}
    .avi-drop strong{display:block;margin-bottom:8px;font-size:22px}
    .avi-drop span,.avi-meta{color:#aeb7c8;font-size:14px}
    .avi-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .avi-btn{min-height:46px;padding:0 18px;border:1px solid rgba(255,255,255,.16);border-radius:10px;background:#f4f6fb;color:#07080a;font-weight:900;cursor:pointer}
    .avi-btn:disabled{opacity:.55;cursor:not-allowed}
    .avi-btn.secondary{background:rgba(255,255,255,.06);color:#d8dde7}
    .avi-status{min-height:24px;color:#aeb5c2;font-size:14px}
    .avi-status.is-error{color:#ff8b8b}.avi-status.is-success{color:#72e39c}

    @media(max-width:768px){
      .nav-pills{display:none}
      .info-grid{grid-template-columns:1fr}
      .related-grid{grid-template-columns:1fr 1fr}
      .avi-actions{align-items:stretch;flex-direction:column}
      .avi-btn{width:100%}
    }
    @media(max-width:480px){
      .related-grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <a href="/hub" class="brand">
        <img src="/img/logo.png" alt="TimrX" class="logo-img" width="40" height="40">
        <span class="b-tim">Timr</span><span class="b-x">X</span>
      </a>
      <div class="nav-pills">
        <a href="/hub" class="nav-pill">Hub</a>
        <a href="/tutorials" class="nav-pill">Tutorials</a>
        <a href="/community" class="nav-pill">Community</a>
        <a href="/prompts" class="nav-pill">Prompts</a>
        <a href="/docs" class="nav-pill">Docs</a>
        <a href="/blogs" class="nav-pill">Blogs</a>
        <a href="/3dprint" class="nav-pill nav-pill--accent">Open Workspace</a>
      </div>
    </div>
  </nav>

  <div class="container">
    <div class="breadcrumb">
      <a href="/">Home</a><span>/</span>
      <a href="/hub">Hub</a><span>/</span>
      <span>${page.h1}</span>
    </div>
  </div>

  <section class="seo-hero">
    <div class="container">
      <div class="seo-hero-watermark" aria-hidden="true">${page.watermark || '3D'}</div>
      <div class="seo-pill">${page.category} &middot; ${isConverter ? 'Free Tool' : 'AI Generator'}</div>
      <h1>${page.h1}</h1>
      <p>${page.desc}</p>

      <div class="prompt-card">
        <div class="prompt-label">${isConverter ? 'Tool Workflow' : 'Example Prompt'}</div>
        <div class="prompt-text">&ldquo;${page.prompt}&rdquo;</div>
        <div class="prompt-actions">
          <a href="${ctaUrl}" class="btn">${ctaLabel} &rarr;</a>
          <a href="${secondaryCtaUrl}" class="btn ghost">${secondaryCtaLabel}</a>
        </div>
      </div>
    </div>
  </section>

  ${isAviConverter ? renderAviToMp4Tool() : ''}

  ${!isConverter ? `<section class="container seo-video">
    <h2>See TimrX in Action</h2>
    <p class="seo-video-sub">Watch the full AI 3D model workflow — prompt to print-ready file.</p>
    <div class="seo-video-card">
      <div class="seo-video-frame">
        <iframe src="https://www.youtube.com/embed/vnuoZ2xV_Ss?start=33" title="This AI Tool Creates Printable 3D Models — TimrX walkthrough" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
      </div>
      <div class="seo-video-meta">
        <strong>Watch:</strong> See how AI generates ${page.h1.toLowerCase()} and other printable 3D models in TimrX — from prompt to print-ready file. Channel: <a href="https://www.youtube.com/@TimrX-Studio" rel="noopener">@TimrX-Studio</a>.
      </div>
    </div>
  </section>` : ''}

  <section class="container">
    <div class="info-grid">
      <h2>${isConverter ? 'How the Converter Works' : 'How TimrX Works'}</h2>
      <div class="info-card">
        <h3>1. ${isConverter ? 'Upload' : 'Generate'}</h3>
        <p>${isConverter ? 'Choose the source file for the converter workflow. 3D file conversion runs in the browser, while AVI to MP4 uses temporary server-side processing.' : 'Type a text description or upload a reference image. The AI generates a detailed 3D model in 3-5 minutes that you can preview, refine, and export.'}</p>
      </div>
      <div class="info-card">
        <h3>2. ${isConverter ? 'Convert' : 'Export'}</h3>
        <p>${isConverter ? 'Pick the target format and let TimrX prepare the output for download.' : 'Download your model as GLB or GLTF — compatible with Blender, Unity, Unreal Engine, and all major 3D printing slicers.'}</p>
      </div>
      <div class="info-card">
        <h3>3. ${isConverter ? 'Download' : 'Print-Ready'}</h3>
        <p>${isConverter ? 'Download the converted file immediately. Temporary video conversion files are removed after the response completes.' : 'Use the built-in Remesh tool for watertight topology, then run Print Check to validate your model for FDM or resin printing.'}</p>
      </div>
    </div>
  </section>

  ${(page.tips && page.tips.length) ? `<section class="container">
    <div class="info-grid">
      <h2>${isConverter ? `Tips for ${page.h1}` : `Prompt Tips for ${page.h1}`}</h2>
      ${page.tips.map(tip => `<div class="info-card"><p>${tip}</p></div>`).join('\n      ')}
    </div>
  </section>` : ''}

  ${(page.useCases && page.useCases.length) ? `<section class="container">
    <div class="info-grid">
      <h2>Use Cases</h2>
      ${page.useCases.map(uc => `<div class="info-card"><h3>${uc.title}</h3><p>${uc.desc}</p></div>`).join('\n      ')}
    </div>
  </section>` : ''}

  ${(page.relatedPrompts && page.relatedPrompts.length) ? `<section class="container more-prompts">
    <h2>${isConverter ? 'Related Converter Searches' : 'More Prompts to Try'}</h2>
    <ul>
      ${page.relatedPrompts.map(p => `<li>${p}</li>`).join('\n      ')}
    </ul>
  </section>` : ''}

  ${(page.faq && page.faq.length) ? `<section class="container seo-faq">
    <h2>Frequently Asked Questions</h2>
    ${page.faq.map(f => `<details><summary>${f.q}</summary><p>${f.a}</p></details>`).join('\n    ')}
  </section>` : ''}

  <section class="container">
    <div class="seo-cta">
      <h2>${isConverter ? 'Open the Free Converter' : 'Start Creating Now'}</h2>
      <p>${isConverter ? 'Convert files directly in TimrX with a focused browser workflow.' : '15 free credits on signup. No software to install. Generate your first 3D model in minutes.'}</p>
      <a href="${isConverter ? ctaUrl : '/3dprint?panel=model'}" class="btn">${isConverter ? ctaLabel : 'Open Workspace'} &rarr;</a>
    </div>
  </section>

  <section class="container">
    <div class="related">
      <h2>Explore More</h2>
      <div class="related-grid">
        ${isConverter ? `
        <a href="/converters/avi-to-mp4" class="related-link">AVI to MP4 Converter<small>Free video conversion</small></a>
        <a href="/converters/glb-to-stl" class="related-link">GLB to STL Converter<small>3D print geometry export</small></a>
        <a href="/converters/glb-to-obj" class="related-link">GLB to OBJ Converter<small>Model editing workflows</small></a>
        <a href="/converters/obj-to-stl" class="related-link">OBJ to STL Converter<small>Slicer-ready mesh export</small></a>
        <a href="/converters/fbx-to-glb" class="related-link">FBX to GLB Converter<small>Web-ready 3D assets</small></a>
        <a href="/converters/gltf-to-glb" class="related-link">GLTF to GLB Converter<small>Single-file 3D delivery</small></a>
        ` : `
        <a href="/3d-models/dragon" class="related-link">Dragon 3D Models<small>Fantasy creatures and drakes</small></a>
        <a href="/3d-models/robot" class="related-link">Robot 3D Models<small>Mechs, androids, and bots</small></a>
        <a href="/3d-models/character" class="related-link">Character 3D Models<small>Heroes, NPCs, and figurines</small></a>
        <a href="/3d-models/vehicle" class="related-link">Vehicle 3D Models<small>Cars, ships, and aircraft</small></a>
        <a href="/3d-models/animal" class="related-link">Animal 3D Models<small>Wildlife and mythical beasts</small></a>
        <a href="/3d-models/architecture" class="related-link">Architecture 3D Models<small>Buildings, temples, and ruins</small></a>
        <a href="/text-to-3d/sword" class="related-link">Text to 3D Sword<small>Weapons and props</small></a>
        <a href="/text-to-3d/castle" class="related-link">Text to 3D Castle<small>Fortresses and citadels</small></a>`}
      </div>
    </div>
  </section>

  <footer class="seo-footer">
    <div class="container">
      <p>&copy; ${new Date().getFullYear()} TimrX / Dima Vasiliu &middot; <a href="/hub">Hub</a> &middot; <a href="/tutorials">Tutorials</a> &middot; <a href="/community">Community</a> &middot; <a href="/prompts">Prompts</a> &middot; <a href="/docs">Docs</a> &middot; <a href="/blogs">Blog</a></p>
    </div>
  </footer>

  <script src="/js/auth-modal.js" defer></script>
  <script src="/js/credits.js" defer></script>
  ${isAviConverter ? renderAviToMp4Script() : ''}
</body>
</html>`;
}

function renderAviToMp4Tool() {
  return `<section class="container avi-tool" id="aviToMp4Tool">
    <div class="avi-tool-card">
      <label class="avi-drop" id="aviDrop">
        <input id="aviInput" type="file" accept=".avi,video/avi,video/x-msvideo" hidden>
        <span>
          <strong id="aviDropTitle">Drop an AVI file here</strong>
          <span>or click to choose a file. The converted MP4 downloads immediately.</span>
        </span>
      </label>
      <div class="avi-actions">
        <button class="avi-btn" id="aviConvertBtn" type="button" disabled>Convert to MP4</button>
        <button class="avi-btn secondary" id="aviClearBtn" type="button">Clear</button>
        <span class="avi-meta" id="aviFileMeta">No file selected</span>
      </div>
      <div class="avi-status" id="aviStatusText" role="status" aria-live="polite"></div>
    </div>
  </section>`;
}

function renderAviToMp4Script() {
  return `<script type="module">
    import { BACKEND, fetchWithCsrf } from '/js/config.js';
    const drop = document.getElementById('aviDrop');
    const input = document.getElementById('aviInput');
    const convertBtn = document.getElementById('aviConvertBtn');
    const clearBtn = document.getElementById('aviClearBtn');
    const fileMeta = document.getElementById('aviFileMeta');
    const statusText = document.getElementById('aviStatusText');
    const dropTitle = document.getElementById('aviDropTitle');
    let selectedFile = null;
    function setStatus(message, type) {
      statusText.textContent = message || '';
      statusText.className = 'avi-status' + (type ? ' is-' + type : '');
    }
    function setFile(file) {
      selectedFile = file || null;
      if (!selectedFile) {
        input.value = '';
        convertBtn.disabled = true;
        fileMeta.textContent = 'No file selected';
        dropTitle.textContent = 'Drop an AVI file here';
        setStatus('');
        return;
      }
      const name = selectedFile.name || '';
      if (!name.toLowerCase().endsWith('.avi')) {
        setFile(null);
        setStatus('Choose a file ending in .avi.', 'error');
        return;
      }
      convertBtn.disabled = false;
      dropTitle.textContent = name;
      fileMeta.textContent = (selectedFile.size / 1024 / 1024).toFixed(1) + ' MB';
      setStatus('Ready to convert.');
    }
    input.addEventListener('change', () => setFile(input.files && input.files[0] ? input.files[0] : null));
    clearBtn.addEventListener('click', () => setFile(null));
    ['dragenter','dragover'].forEach(type => drop.addEventListener(type, event => {
      event.preventDefault();
      drop.classList.add('is-dragging');
    }));
    ['dragleave','drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('is-dragging')));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      setFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0] ? event.dataTransfer.files[0] : null);
    });
    convertBtn.addEventListener('click', async () => {
      if (!selectedFile) return;
      convertBtn.disabled = true;
      clearBtn.disabled = true;
      setStatus('Uploading and converting. Keep this tab open.');
      const form = new FormData();
      form.append('file', selectedFile, selectedFile.name);
      try {
        const response = await fetchWithCsrf(BACKEND + '/api/_mod/video/convert/avi-to-mp4', {
          method: 'POST',
          body: form,
          credentials: 'include',
          mode: 'cors'
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
          let message = 'Conversion failed (' + response.status + ').';
          if (contentType.includes('application/json')) {
            const data = await response.json().catch(() => null);
            message = (data && (data.message || data.error)) || message;
          }
          throw new Error(message);
        }
        const blob = await response.blob();
        const base = selectedFile.name.replace(/\\.[^.]+$/, '') || 'timrx-video';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = base + '.mp4';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setStatus('MP4 downloaded. Temporary files will be removed by the server.', 'success');
      } catch (error) {
        setStatus((error && error.message) || 'Conversion failed.', 'error');
      } finally {
        convertBtn.disabled = !selectedFile;
        clearBtn.disabled = false;
      }
    });
  </script>`;
}
