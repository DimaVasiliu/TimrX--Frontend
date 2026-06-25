/* ========= TimrX Chat API helper ========= */
const TIMRX_ENV = window.TIMRX_ENV || {};
const TIMRX_API_BASE = TIMRX_ENV.chatApiBase || window.TIMRX_API_BASE || 'https://chat.timrx.live';
window.TIMRX_API_BASE = TIMRX_API_BASE;

/** 3) Local “house style” fallback (no API) */
const TIMRX_FAQ_DEFAULT = [
  {
    q: "What is TimrX?",
    a: "TimrX is an AI creative platform built by Dima Vasiliu. In the workspace you can generate 3D models, images, and videos directly in the browser.",
    keywords: ["timrx", "platform", "what is timrx", "what does timrx do"]
  },
  {
    q: "Who is behind TimrX?",
    a: "TimrX was built by Dima Vasiliu, a London-based full-stack developer focused on motion-first web experiences, 3D workflows, and creative AI products.",
    keywords: ["dima", "founder", "creator", "who built this", "london"]
  },
  {
    q: "What can TimrX do?",
    a: "TimrX offers text-to-3D, image-to-3D, AI image generation, AI video generation, remesh, texture, a real-time 3D viewer, and export workflows in one workspace.",
    keywords: ["features", "tools", "workspace", "text to 3d", "image to 3d", "video", "image"]
  },
  {
    q: "Can this chat generate images, videos, or 3D files for me?",
    a: "The floating chat answers questions and helps you navigate the site. To create assets, use the homepage prompt when available or open the TimrX workspace at /3dprint.",
    keywords: ["chat generate image", "chat generate video", "can you make an image", "can you make a video"]
  },
  {
    q: "What is the TimrX 3D Print Hub?",
    a: "The 3D Print Hub is the TimrX workspace for generating and refining 3D assets. It includes text-to-3D, image-to-3D, remesh, texture tools, a viewer, exports, and history.",
    keywords: ["3d print hub", "hub", "workspace", "3d workspace"]
  },
  {
    q: "What formats can TimrX export?",
    a: "TimrX supports common formats including GLB, GLTF, STL, and USDZ depending on the workflow.",
    keywords: ["export", "formats", "glb", "gltf", "stl", "usdz"]
  },
  {
    q: "Do I need Blender or other software to use TimrX?",
    a: "No. TimrX is browser-based for the core workflow, so you can generate, preview, refine, and export without needing Blender just to start.",
    keywords: ["blender", "software", "install", "browser"]
  },
  {
    q: "What services does Dima offer?",
    a: "Dima offers web/UI design, motion development, Three.js viewers, 3D modeling and print workflows, plus short-form video editing. For custom work, use #services or #contact.",
    keywords: ["services", "offer", "web", "motion", "three.js", "3d", "shorts"]
  },
  {
    q: "Can you build websites and motion-heavy interfaces too?",
    a: "Yes. That includes modern websites, motion-led UI, interactive 3D viewers, and product experiences.",
    keywords: ["website", "landing page", "motion", "gsap", "ui", "ux"]
  },
  {
    q: "Can you help with 3D printing or print-ready files?",
    a: "Yes. TimrX supports print-focused 3D workflows, and Dima also offers custom 3D modeling and print-prep service work.",
    keywords: ["3d printing", "print ready", "print prep", "stl", "slicer"]
  },
  {
    q: "Can you edit Shorts or social videos?",
    a: "Yes, as a service. Dima can help with short-form edits, pacing, packaging, and platform-native video work.",
    keywords: ["shorts", "reels", "tiktok", "video editing"]
  },
  {
    q: "What are your usual budgets?",
    a: "Typical custom project ranges are $100–$500, $500–$1.5k, $1.5k–$3k, and $3k–$7k+. For a real quote, use the budget chips in #contact.",
    keywords: ["budget", "price", "pricing", "rates", "quote"]
  },
  {
    q: "How fast can you reply or start?",
    a: "Dima usually replies within 24–48 hours. Service work typically starts within 1–2 weeks depending on scope.",
    keywords: ["reply", "response", "start", "timeline", "availability"]
  },
  {
    q: "Do you work only in London, or also remote?",
    a: "Dima is based in London and works remotely or hybrid. TimrX as a platform is browser-based, so people can use it from anywhere.",
    keywords: ["london", "remote", "hybrid", "worldwide", "ship"]
  },
  {
    q: "Where can I see examples or learn more?",
    a: "Use #works for featured projects, #blogs for articles, and /hub for the live TimrX workspace. For custom work, head to #contact.",
    keywords: ["examples", "portfolio", "works", "blog", "docs", "learn more"]
  },
  {
    q: "How do I get started?",
    a: "If you want to use the platform, go to /hub. If you want custom work, use #contact with a short brief, your deadline, a couple of references, and a budget range.",
    keywords: ["start", "contact", "begin", "brief", "what do you need"]
  },
  {
    q: "Which file formats can I export?",
    a: "Depending on the workflow you can export STL, OBJ, GLB, GLTF, USDZ and 3MF. The File Converter at /converter handles conversions between formats.",
    keywords: ["formats", "export", "stl", "obj", "glb", "gltf", "usdz", "3mf", "file types"]
  },
  {
    q: "Can I export models for 3D printing?",
    a: "Yes. Run the print check to prepare a model, then export STL or 3MF. You can also order a physical print via Print on Demand at /print-on-demand.",
    keywords: ["3d print", "printing", "stl", "3mf", "print check", "printable", "slicer"]
  },
  {
    q: "How do credits and pricing work?",
    a: "AI generation and some refinement tools use credits — start small and top up with a pack that fits your workflow. For current prices and packs, see /hub#pricing.",
    keywords: ["credits", "price", "pricing", "cost", "pay", "plans", "packs", "billing", "subscription"]
  },
  {
    q: "Is there a free trial?",
    a: "TimrX may offer controlled starter access, but public generation uses credits. Open /hub#pricing for current credit packs or /3dprint to start in the workspace.",
    keywords: ["free", "trial", "free generation", "try", "demo", "starter"]
  },
  {
    q: "Do I need Blender or 3D skills?",
    a: "No. TimrX runs entirely in the browser — generate, inspect, refine and export without any 3D software or experience.",
    keywords: ["blender", "skills", "experience", "beginner", "no software", "install", "download"]
  },
  {
    q: "How do I turn an image into a 3D model?",
    a: "Open Image to 3D at /image-to-3d, upload your image, generate the model, then refine and export. Text to 3D at /text-to-3d does the same from a prompt.",
    keywords: ["image to 3d", "photo to 3d", "picture to 3d", "convert image", "text to 3d", "from image"]
  },
  {
    q: "Can I generate videos?",
    a: "Yes. The AI Video Generator at /ai-video-generator creates short videos from a prompt or an image.",
    keywords: ["video", "animation", "ai video", "clip", "motion", "animate"]
  },
  {
    q: "Which tool should I use?",
    a: "Images: /ai-image-generator. Short videos: /ai-video-generator. 3D from text: /text-to-3d. 3D from an image: /image-to-3d. Convert files: /converter. The full workspace is /3dprint.",
    keywords: ["which tool", "what tool", "where do i", "how do i make", "difference between tools", "best tool"]
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
  "- Refinement: remesh, retexture, auto-rig/animate, and a print check that prepares models for printing.",
  "- File Converter (/converter): convert between 3D and media formats.",
  "- STL Library (/stl-library): ready-made printable models. Print on Demand (/print-on-demand): order physical prints.",
  "",
  "FORMATS: export STL, OBJ, GLB, GLTF, USDZ and 3MF (which ones depend on the workflow).",
  "",
  "CREDITS & GETTING STARTED:",
  "- AI generation and some refinement tools use credits. Start small and top up; pick a credit pack that fits your workflow. Current prices and packs are at /hub#pricing.",
  "- Public generation is credit-based. If controlled starter access is enabled, the homepage prompt will guide users; otherwise it routes them to the workspace and pricing.",
  "- No Blender or advanced 3D skills are needed — generate, inspect, refine and export directly in the browser.",
  "",
  "GUIDANCE: When a user describes what they want to make, recommend the most relevant tool and briefly explain the workflow (prompt/upload → generate → refine → export). For account, billing, or custom-work questions you can't answer from the above, suggest opening the workspace at /3dprint or the pricing page at /hub#pricing. Keep a warm, plain tone; avoid heavy markdown."
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
  const [best] = findTimrxFaqMatches(q, 1);
  if (best) return best.a;
  return 'I can help with TimrX, the 3D Print Hub, Dima, services, examples, and contact. If you want to use the platform, open /hub. If you want custom work, use #contact.';
}

/** 4) ask(): STREAM → JSON → local fallback */
async function timrxAsk(messages, onStreamToken) {
  const systemPrompt = getTimrxSystemPrompt();
  const outboundMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages.filter(m => m.role !== 'system')]
    : messages;
  // (A) try streaming first
  try {
    const res = await fetch(`${TIMRX_API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: outboundMessages, temperature: 0.25 })
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

  // (B) non-stream JSON
  try {
    const res = await fetch(`${TIMRX_API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: outboundMessages, temperature: 0.25 })
    });
    if (!res.ok) throw new Error(`json ${res.status}`);
    const data = await res.json();
    if (data?.reply) return data.reply;
  } catch (_) { /* fall through */ }

  // (C) local fallback
  const last = [...messages].reverse().find(m => m.role === 'user');
  return timrxLocalRouter(last?.content || '');
}

window.timrxAsk = timrxAsk;

/* ========= FAQ search helper (local-first for speed) ========= */

async function timrxFaqSearch(q) {
  const query = (q || "").trim();
  if (query.length < 5) return [];
  return findTimrxFaqMatches(query, 5);
}

window.timrxFaqSearch = timrxFaqSearch;
