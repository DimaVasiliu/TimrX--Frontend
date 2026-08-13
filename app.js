/* ========= TimrX Chat API helper ========= */
const TIMRX_ENV = window.TIMRX_ENV || {};
const TIMRX_API_BASE = TIMRX_ENV.chatApiBase || window.TIMRX_API_BASE || 'https://chat.timrx.live';
window.TIMRX_API_BASE = TIMRX_API_BASE;

/** 3) Local platform knowledge fallback (no API)
 * Keep this product-only. Portfolio/custom-service answers live on /dima-vasiliu.
 */
const TIMRX_FAQ_DEFAULT = [
  {
    q: "What is TimrX?",
    a: "TimrX is a browser-based creative platform for generating images, short videos and 3D models from prompts or uploads. You can refine assets, convert files, export STL/OBJ/GLB/3MF and prepare 3D models for printing from one workspace.",
    keywords: ["timrx", "platform", "what is timrx", "what does timrx do", "what can i create"]
  },
  {
    q: "Who is behind TimrX?",
    a: "TimrX was built by Dima Vasiliu, a London-based full-stack developer focused on motion-first web experiences, 3D workflows, and creative AI products.",
    keywords: ["dima", "founder", "creator", "who built this", "london"]
  },
  {
    q: "What can TimrX do?",
    a: "TimrX offers AI image generation, AI video generation, text-to-3D, image-to-3D, remesh/retopology, retexture, paint, print checks, file conversion, STL library browsing and live FDM print-on-demand ordering from completed workspace models.",
    keywords: ["features", "tools", "services", "workspace", "text to 3d", "image to 3d", "video", "image", "what services"]
  },
  {
    q: "What services does TimrX offer?",
    a: "TimrX services include AI image generation, AI video generation, text-to-3D, image-to-3D, remesh/model cleanup, retexture and paint tools, print checks, file conversion, STL library access, exports to common 3D formats and live FDM print-on-demand ordering/shipping.",
    keywords: ["what services does timrx offer", "services timrx", "platform services", "all services", "what tools are available", "offer"]
  },
  {
    q: "Can this chat generate images, videos, or 3D files for me?",
    a: "The floating chat answers questions and helps you navigate the site. To create assets, use the homepage prompt when available or open the TimrX workspace at /3dprint.",
    keywords: ["chat generate image", "chat generate video", "can you make an image", "can you make a video"]
  },
  {
    q: "What is the TimrX 3D Print Hub?",
    a: "The 3D Print Hub is the main TimrX workspace at /3dprint. It includes text-to-3D, image-to-3D, image/video generation panels, remesh, retexture, paint, print checks, a 3D viewer, history and exports.",
    keywords: ["3d print hub", "hub", "workspace", "3d workspace"]
  },
  {
    q: "Can I generate images?",
    a: "Yes. Use the AI Image Generator at /ai-image-generator or the image panel in /3dprint. Describe the visual you want, generate, then download or keep refining in the workspace.",
    keywords: ["image", "images", "ai image", "picture", "concept art", "product visual", "mockup", "generate image"]
  },
  {
    q: "Can I generate videos?",
    a: "Yes. Use the AI Video Generator at /ai-video-generator or the video panel in /3dprint. It can create short motion clips from prompts or image references depending on the workflow.",
    keywords: ["video", "animation", "ai video", "clip", "motion", "animate", "cinematic", "reel"]
  },
  {
    q: "Can I generate 3D models?",
    a: "Yes. Use Text to 3D at /text-to-3d for prompts, Image to 3D at /image-to-3d for reference images, or the full workspace at /3dprint. After generation, preview the model, refine it, then export for printing, games, AR or further editing.",
    keywords: ["3d", "model", "3d model", "text to 3d", "image to 3d", "photo to 3d", "figurine", "miniature", "keychain"]
  },
  {
    q: "What formats can TimrX export?",
    a: "Depending on the workflow, TimrX supports STL, OBJ, GLB, GLTF, USDZ and 3MF. Use STL/3MF for 3D printing, GLB/GLTF for web and game workflows, and OBJ for broad 3D software compatibility.",
    keywords: ["export", "formats", "glb", "gltf", "stl", "usdz", "obj", "3mf", "file types", "download"]
  },
  {
    q: "Do I need Blender or other software to use TimrX?",
    a: "No. TimrX runs in the browser, so you can generate, preview, refine and export without Blender just to start. You can still export standard files if you want to continue in Blender, Unity, Unreal, a slicer or another tool.",
    keywords: ["blender", "software", "install", "browser"]
  },
  {
    q: "How do credits and pricing work?",
    a: "AI generation and selected refinement tools use credits. The exact credit cost is shown in the workspace before generation, and current packs/pricing are at /hub#pricing. Print orders are priced separately from AI credits.",
    keywords: ["credits", "price", "pricing", "cost", "pay", "plans", "packs", "billing", "subscription", "how much", "deduct", "reserve"]
  },
  {
    q: "Do I get free credits to start?",
    a: "TimrX can offer starter/free credits or controlled free generation depending on the current launch settings. After free access is used, generation requires an account and credits. Check /hub#pricing for the current offer.",
    keywords: ["free", "trial", "free generation", "try", "demo", "starter", "free credits", "signup credits"]
  },
  {
    q: "Can I export models for 3D printing?",
    a: "Yes. Generate or upload a model, run print-prep checks where available, then export STL or 3MF for slicers such as Bambu Studio, Cura or PrusaSlicer. Use 3MF when you need multi-color/material information.",
    keywords: ["3d print", "printing", "stl", "3mf", "print check", "printable", "slicer", "bambu", "cura", "prusa"]
  },
  {
    q: "Can TimrX print and ship my model?",
    a: "Yes. FDM print ordering is live from the TimrX workspace for completed printable models. Generate or upload a model, run Print Check, click Order Print, choose material/color/size/delivery, review the server quote and continue to checkout. Resin ordering is still manual quote for now.",
    keywords: ["print and ship", "shipping", "ship", "order", "order print", "print on demand", "deliver", "delivery", "fulfillment", "physical print", "buy print"]
  },
  {
    q: "How much will a physical 3D print cost?",
    a: "Physical print pricing is separate from AI credits and depends on model dimensions, material, infill, finish, quantity, packaging, delivery speed and destination. Live FDM checkout starts from $19.95 / €17.95 before delivery, and the server recomputes the final quote before payment. A 100mm figurine still needs the order screen or manual quote because volume and material matter more than height alone.",
    keywords: ["physical print cost", "print cost", "shipping cost", "quote print", "100mm", "height", "material", "infill", "resin", "fdm", "pla", "petg", "batman", "figurine cost", "model cost"]
  },
  {
    q: "What materials can TimrX print?",
    a: "The live FDM catalog includes PLA, PLA+ tough, PETG, ABS, TPU flexible and PLA Silk, with a 17-color swatch catalog. Resin materials are on the roadmap but automated resin checkout is disabled for now.",
    keywords: ["materials", "pla", "petg", "resin", "clear resin", "pla cf", "multi color", "multicolor", "ams", "mmu", "filament"]
  },
  {
    q: "Where does TimrX ship?",
    a: "Print checkout supports US, Canada, Great Britain, EU, Australia, Japan and an Other destination bucket. Standard, express and priority delivery are priced from model size, packed weight and destination, with standard delivery included above the market threshold shown at checkout.",
    keywords: ["where ship", "worldwide", "uk", "eu", "usa", "us", "delivery time", "tracked", "shipping time"]
  },
  {
    q: "Can I order an externally-made STL or model?",
    a: "The live order flow is built around models generated or uploaded to TimrX so Print Check and the order pipeline can validate the file. If you already have an STL/GLB and want it printed manually, contact admin@timrx.live for a quote.",
    keywords: ["external model", "own stl", "existing stl", "upload model", "upload stl", "manual quote", "my file", "print my model"]
  },
  {
    q: "What does the File Converter do?",
    a: "The converter at /converter helps convert creative/3D files between formats. Use it when you need files like STL, OBJ, GLB, GLTF, USDZ or 3MF prepared for another app, web viewer, slicer or game workflow.",
    keywords: ["converter", "convert", "file converter", "stl to obj", "obj to glb", "glb to stl", "3mf", "format conversion"]
  },
  {
    q: "What is the STL Library?",
    a: "The STL Library at /stl-library is for browsing printable STL assets/packs. Use it when you want ready-made printable models instead of generating a new model from a prompt or image.",
    keywords: ["stl library", "library", "stl packs", "download stl", "ready made", "printable files", "models library"]
  },
  {
    q: "What is remesh or model cleanup?",
    a: "Remesh/model cleanup rebuilds or optimizes the mesh so generated/scanned models become cleaner, more watertight and easier to print, animate or use in game engines. Open /3d-model-cleanup or the remesh panel in /3dprint.",
    keywords: ["remesh", "retopology", "cleanup", "clean model", "watertight", "holes", "non manifold", "mesh", "optimize"]
  },
  {
    q: "Can I create multi-colour 3D models?",
    a: "Yes. TimrX supports workflows around 3MF and multi-color 3D printing. Use 3MF export for printers/slicers that understand color/material data, especially Bambu AMS or Prusa MMU-style setups.",
    keywords: ["multi color", "multi-colour", "multicolor", "multiple colours", "paint", "3mf", "bambu", "ams", "mmu", "colour model", "color model"]
  },
  {
    q: "Can I use TimrX assets commercially?",
    a: "TimrX is built for creators, games, products, content and prototypes. Usage rights can depend on the provider, plan and asset source, so check the current terms and licensing before using outputs commercially.",
    keywords: ["commercial", "license", "rights", "sell", "game asset", "product", "use in game", "client"]
  },
  {
    q: "How do I get started?",
    a: "For a guided overview, open /hub. To create immediately, open /3dprint. Use /ai-image-generator for images, /ai-video-generator for videos, /text-to-3d for prompts, /image-to-3d for reference images, /converter for file conversion and /print-on-demand for live FDM print ordering.",
    keywords: ["start", "begin", "get started", "where do i start", "open workspace", "try timrx"]
  },
  {
    q: "How do I turn an image into a 3D model?",
    a: "Open Image to 3D at /image-to-3d, upload your image, generate the model, then refine and export. Text to 3D at /text-to-3d does the same from a prompt.",
    keywords: ["image to 3d", "photo to 3d", "picture to 3d", "convert image", "text to 3d", "from image"]
  },
  {
    q: "Which tool should I use?",
    a: "Use /ai-image-generator for images, /ai-video-generator for short videos, /text-to-3d for prompt-based models, /image-to-3d for photo/reference-to-3D, /converter for file conversion, /stl-library for ready STL files, and /3dprint for the full workspace.",
    keywords: ["which tool", "what tool", "where do i", "how do i make", "difference between tools", "best tool", "recommend"]
  }
];

function getTimrxFaqItems() {
  return Array.isArray(window.TIMRX_CHAT_FAQ) && window.TIMRX_CHAT_FAQ.length
    ? window.TIMRX_CHAT_FAQ
    : TIMRX_FAQ_DEFAULT;
}

const TIMRX_PLATFORM_CONTEXT = [
  "You are the TimrX assistant — a concise, friendly product guide for the TimrX creative platform.",
  "Answer questions about TimrX accurately and briefly (2–5 sentences; use short bullet lists when it helps).",
  "Never invent prices, credit amounts, dates, or features not listed here. For exact pricing point users to /hub#pricing.",
  "",
  "ABOUT: TimrX is a browser-based AI creative platform built by Dima Vasiliu, a London-based developer. Everything runs in the browser — no installs, nothing to download. You generate images, short videos and printable 3D models from text prompts or uploaded images, then refine, convert, export, or prepare them for 3D printing.",
  "",
  "WORKSPACE & TOOLS:",
  "- Main workspace: the 3D Print Hub at /3dprint.",
  "- Text to 3D (/text-to-3d) and Image to 3D (/image-to-3d): turn a prompt or a reference image into a 3D model.",
  "- AI Image Generator (/ai-image-generator): create images from text.",
  "- AI Video Generator (/ai-video-generator): create short videos from prompts or images.",
  "- Refinement: remesh/retopology, retexture, paint, auto-rig/animate, and a print check that prepares models for printing.",
  "- File Converter (/converter): convert between 3D and media formats.",
  "- STL Library (/stl-library): ready-made printable models.",
  "- Print on Demand (/print-on-demand): live FDM physical print/order/shipping service from completed printable workspace models. Resin ordering is manual quote / roadmap for now.",
  "",
  "FORMATS: export STL, OBJ, GLB, GLTF, USDZ and 3MF (which ones depend on the workflow).",
  "",
  "PRINTING, ORDERS & SHIPPING:",
  "- TimrX can prepare print-ready files now: generate/upload → print check/remesh → export STL or 3MF, or click Order Print on a completed printable model.",
  "- Physical FDM print-on-demand is live inside the workspace. Do not describe the FDM order flow as upcoming.",
  "- Live FDM materials include PLA, PLA+ tough, PETG, ABS, TPU flexible and PLA Silk. Resin standard/tough/clear is manual quote / roadmap and disabled in automated checkout for now.",
  "- Print order pricing is separate from AI credits and depends on dimensions, material, infill, finish, quantity, packaging, delivery speed and destination. Live FDM checkout starts from $19.95 / €17.95 before delivery. For a specific 100mm figurine or character, explain that height alone is not enough; volume/material/finish/destination determine the quote.",
  "- Print checkout supports US, Canada, Great Britain, EU, Australia, Japan and an Other destination bucket with standard, express and priority delivery tiers.",
  "",
  "CREDITS & GETTING STARTED:",
  "- AI generation and some refinement tools use credits. Start small and top up; pick a credit pack that fits your workflow. Current prices and packs are at /hub#pricing.",
  "- A human-verified visitor may receive one bounded starter generation for each supported service: a Nano Banana 2K image, a five-second Seedance 2 video, and a Meshy 3D model. After a service's starter is used, that service requires enough credits.",
  "- No Blender or advanced 3D skills are needed — generate, inspect, refine and export directly in the browser.",
  "",
  "GUIDANCE: When a user describes what they want to make, recommend the most relevant tool and briefly explain the workflow (prompt/upload → generate → refine → export). For product print/order/shipping questions, answer from the print-on-demand facts above. For exact pricing point users to /hub#pricing for credits or /print-on-demand for physical prints. Do not answer platform questions as if they are Dima portfolio enquiries, and do not send product users to #contact budget chips. Keep a warm, plain tone; avoid heavy markdown."
].join("\n");
function getTimrxSystemPrompt() {
  return (window.TIMRX_CHAT_CONTEXT || TIMRX_PLATFORM_CONTEXT || '').trim();
}

function normalizeTimrxQuery(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenizeTimrxQuery(text) {
  return normalizeTimrxQuery(text).split(/\s+/).filter(t => t.length >= 2);
}

function scoreTimrxFaq(item, query) {
  const normalized = normalizeTimrxQuery(query);
  if (!normalized) return 0;

  const question = normalizeTimrxQuery(item.q);
  const answer = normalizeTimrxQuery(item.a || '');
  const keywords = (item.keywords || []).map(normalizeTimrxQuery).filter(Boolean);
  const queryTokens = tokenizeTimrxQuery(query);
  const itemTokens = new Set([
    ...tokenizeTimrxQuery(item.q),
    ...tokenizeTimrxQuery(item.a || ''),
    ...keywords.flatMap(tokenizeTimrxQuery)
  ]);

  let score = 0;
  if (normalized === question || keywords.includes(normalized)) score += 120;
  if (question.includes(normalized)) score += 70;
  if (keywords.some(keyword => keyword.includes(normalized))) score += 50;
  if (answer.includes(normalized)) score += 20;

  if (queryTokens.length) {
    const overlap = queryTokens.filter(token => itemTokens.has(token)).length;
    score += overlap * 10;
  }

  return score;
}

function findTimrxFaqMatches(query, limit = 5) {
  const normalized = normalizeTimrxQuery(query);
  if (!normalized) return [];
  return getTimrxFaqItems()
    .map(item => ({ ...item, _score: scoreTimrxFaq(item, query) }))
    .filter(item => item._score >= 20)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...item }) => item);
}

function timrxLocalRouter(q) {
  const direct = timrxDirectIntentAnswer(q);
  if (direct) return direct;
  const [best] = findTimrxFaqMatches(q, 1);
  if (best) return best.a;
  return 'I can help with TimrX tools, credits, exports, print-ready workflows, file conversion, STL files and print-on-demand. For the full workspace open /3dprint, or use /hub for the product overview and pricing.';
}

function timrxDirectIntentAnswer(query) {
  const normalized = normalizeTimrxQuery(query);
  if (!normalized) return '';
  const hasPrint = /\b(print|printing|printed|physical|figurine|miniature|model|stl|3d)\b/.test(normalized);
  const hasOrder = /\b(order|buy|purchase|checkout|ship|shipping|deliver|delivery|quote|fulfillment)\b/.test(normalized);
  const hasCost = /\b(cost|price|pricing|quote|how much|pay|fee|fees|100mm|height|material|infill)\b/.test(normalized);
  const hasWhereShip = /\b(where|worldwide|uk|eu|usa|us|america|europe|international|how long|delivery time|shipping time|tracked)\b/.test(normalized)
    && /\b(ship|shipping|deliver|delivery)\b/.test(normalized);

  if ((hasPrint || hasOrder) && hasCost) {
    return "Physical print pricing is separate from AI credits and depends on model dimensions, material, infill, finish, quantity, packaging, delivery speed and destination. Live FDM checkout starts from $19.95 / €17.95 before delivery, and the server recomputes the final quote before payment. For a 100mm character or figurine, height alone is not enough — the order screen or a manual quote needs volume, material, finish and destination.";
  }
  if (hasWhereShip) {
    return "Print checkout supports US, Canada, Great Britain, EU, Australia, Japan and an Other destination bucket. Standard, express and priority delivery are priced from model size, packed weight and destination, with standard delivery included above the market threshold shown at checkout.";
  }
  if (hasOrder || /\b(print on demand|print and ship|order print|shipping)\b/.test(normalized)) {
    return "Yes. FDM print ordering is live from the TimrX workspace for completed printable models. Open /3dprint, generate or upload a model, run Print Check, click Order Print, choose material/color/size/delivery, review the server quote and continue to checkout. Resin ordering is still manual quote for now.";
  }
  return '';
}

function shouldUseLocalTimrxAnswer(query) {
  const normalized = normalizeTimrxQuery(query);
  if (!normalized) return false;
  const platformIntent = [
    'print', 'printing', 'ship', 'shipping', 'deliver', 'delivery', 'order', 'quote',
    'cost', 'price', 'pricing', 'credit', 'credits', 'billing', 'export', 'format',
    'stl', 'obj', 'glb', 'gltf', '3mf', 'usdz', 'converter', 'library', 'remesh',
    'texture', 'paint', 'image', 'video', '3d', 'model', 'workspace', 'tool'
  ];
  return platformIntent.some(term => normalized.includes(term));
}

/** 4) ask(): STREAM → JSON → local fallback */
async function timrxAsk(messages, onStreamToken) {
  const systemPrompt = getTimrxSystemPrompt();
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const directAnswer = timrxDirectIntentAnswer(lastUserMessage);
  if (directAnswer) return directAnswer;
  const [localBest] = findTimrxFaqMatches(lastUserMessage, 1);
  if (localBest && shouldUseLocalTimrxAnswer(lastUserMessage) && scoreTimrxFaq(localBest, lastUserMessage) >= 35) {
    return localBest.a;
  }
  // The server owns its system prompt. Public callers may submit only the
  // user/assistant conversation, which prevents prompt-role injection.
  const outboundMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  let turnstileToken = '';
  if (window.TimrXHumanVerification?.getToken) {
    try {
      turnstileToken = await window.TimrXHumanVerification.getToken('chat_assistant');
    } catch (_) {
      const fallback = timrxLocalRouter(lastUserMessage);
      return `${fallback}\n\nI could not complete human verification for a live assistant response, so I answered from the built-in TimrX guide. You can keep asking, or check content blockers and try again.`;
    }
  }
  // (A) try streaming first
  try {
    const res = await fetch(`${TIMRX_API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: outboundMessages, turnstile_token: turnstileToken })
    });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const frame of chunk.split('\n\n')) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let payload = null;
        try { payload = JSON.parse(raw); } catch {}
        if (payload?.token) {
          acc += payload.token;
          onStreamToken?.(acc);
        }
      }
    }
    if (acc) return acc;
  } catch (_) { /* fall through */ }

  // Turnstile tokens are single-use. Do not replay a consumed token into the
  // JSON fallback; use the local answer if the streaming request fails.
  if (turnstileToken) return timrxLocalRouter(lastUserMessage);

  // (B) non-stream JSON (development only when verification is disabled)
  try {
    const res = await fetch(`${TIMRX_API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: outboundMessages, turnstile_token: turnstileToken })
    });
    if (!res.ok) throw new Error(`json ${res.status}`);
    const data = await res.json();
    if (data?.reply) return data.reply;
  } catch (_) { /* fall through */ }

  // (C) local fallback
  return timrxLocalRouter(lastUserMessage);
}

window.timrxAsk = timrxAsk;

/* ========= FAQ search helper (local-first for speed) ========= */

async function timrxFaqSearch(q) {
  const query = (q || "").trim();
  if (query.length < 5) return [];
  return findTimrxFaqMatches(query, 5);
}

window.timrxFaqSearch = timrxFaqSearch;
