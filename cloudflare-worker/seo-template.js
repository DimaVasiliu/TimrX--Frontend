/**
 * Renders a full HTML page for a programmatic SEO landing page.
 * Matches the TimrX dark-theme design system.
 */

export function renderSeoPage(page) {
  const fullUrl = `https://timrx.live${page.basePath}/${page.slug}`;
  const encodedPrompt = encodeURIComponent(page.prompt);

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
      "name":"TimrX AI 3D Generator",
      "applicationCategory":"DesignApplication",
      "url":"https://timrx.live/3dprint"
    }
  }
  </script>

  <style>
    :root{--bg:#0b0b0b;--ink:#f5f5f5;--muted:#a9a9a9;--line:#1d1d1d;--panel:#0e0e0e;--maxw:1280px;--gutter:28px;--navH:70px}
    *{box-sizing:border-box;margin:0}
    html{scroll-behavior:smooth}
    body{background:var(--bg);color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}
    .container{max-width:var(--maxw);margin:0 auto;padding:0 var(--gutter)}

    /* Nav */
    .nav{position:fixed;inset:0 0 auto 0;height:var(--navH);z-index:1000;background:linear-gradient(180deg,rgba(11,11,11,.96),rgba(11,11,11,.75) 75%,rgba(11,11,11,0));backdrop-filter:saturate(120%) blur(8px);border-bottom:1px solid var(--line)}
    .nav-inner{height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 20px;max-width:none}
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

    /* CTA */
    .seo-cta{text-align:center;padding:60px 0;margin:40px 0;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
    .seo-cta h2{font-size:28px;font-weight:900;margin-bottom:8px}
    .seo-cta p{color:var(--muted);margin-bottom:24px}

    /* Footer */
    .seo-footer{padding:40px 0;border-top:1px solid var(--line);margin-top:60px;text-align:center;color:var(--muted);font-size:13px}
    .seo-footer a{text-decoration:underline;text-underline-offset:3px}
    .seo-footer a:hover{color:var(--ink)}

    @media(max-width:768px){
      .nav-pills{display:none}
      .info-grid{grid-template-columns:1fr}
      .related-grid{grid-template-columns:1fr 1fr}
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
      <div class="seo-hero-watermark" aria-hidden="true">3D</div>
      <div class="seo-pill">${page.category} &middot; AI Generator</div>
      <h1>${page.h1}</h1>
      <p>${page.desc}</p>

      <div class="prompt-card">
        <div class="prompt-label">Example Prompt</div>
        <div class="prompt-text">&ldquo;${page.prompt}&rdquo;</div>
        <div class="prompt-actions">
          <a href="/3dprint?panel=model&prompt=${encodedPrompt}" class="btn">Try This Prompt &rarr;</a>
          <a href="/prompts" class="btn ghost">Browse All Prompts</a>
        </div>
      </div>
    </div>
  </section>

  <section class="container">
    <div class="info-grid">
      <div class="info-card">
        <h3>How It Works</h3>
        <p>Type a text description or upload a reference image. The AI generates a detailed 3D model in 3-5 minutes that you can preview, refine, and export.</p>
      </div>
      <div class="info-card">
        <h3>Export Formats</h3>
        <p>Download your model as GLB or GLTF — compatible with Blender, Unity, Unreal Engine, and all major 3D printing slicers.</p>
      </div>
      <div class="info-card">
        <h3>Print-Ready</h3>
        <p>Use the built-in Remesh tool for watertight topology, then run Print Check to validate your model for FDM or resin printing.</p>
      </div>
    </div>
  </section>

  <section class="container">
    <div class="seo-cta">
      <h2>Start Creating Now</h2>
      <p>50 free credits on signup. No software to install. Generate your first 3D model in minutes.</p>
      <a href="/3dprint?panel=model" class="btn">Open Workspace &rarr;</a>
    </div>
  </section>

  <section class="container">
    <div class="related">
      <h2>Explore More</h2>
      <div class="related-grid">
        <a href="/3d-models/dragon" class="related-link">Dragon 3D Models<small>Fantasy creatures and drakes</small></a>
        <a href="/3d-models/robot" class="related-link">Robot 3D Models<small>Mechs, androids, and bots</small></a>
        <a href="/3d-models/character" class="related-link">Character 3D Models<small>Heroes, NPCs, and figurines</small></a>
        <a href="/3d-models/vehicle" class="related-link">Vehicle 3D Models<small>Cars, ships, and aircraft</small></a>
        <a href="/3d-models/animal" class="related-link">Animal 3D Models<small>Wildlife and mythical beasts</small></a>
        <a href="/3d-models/architecture" class="related-link">Architecture 3D Models<small>Buildings, temples, and ruins</small></a>
        <a href="/text-to-3d/sword" class="related-link">Text to 3D Sword<small>Weapons and props</small></a>
        <a href="/text-to-3d/castle" class="related-link">Text to 3D Castle<small>Fortresses and citadels</small></a>
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
</body>
</html>`;
}
