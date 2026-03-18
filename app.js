/* ========= TimrX Chat API helper (fixed) ========= */

/** 1) Deployed + local URLs */
const TIMRX_API_RENDER = 'https://chat.timrx.live';
const TIMRX_API_LOCAL  = 'http://localhost:8000'; // if you run locally

/** 2) Pick the best available API automatically */
let TIMRX_API_BASE = TIMRX_API_RENDER;

async function pingApi(url, path = '/api/health', ms = 1200) { // <-- fixed path
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url + path, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

(async () => {
  const host = location.hostname;
  const localHost = host === 'localhost' || host === '127.0.0.1';
  if (localHost && await pingApi(TIMRX_API_LOCAL)) {
    TIMRX_API_BASE = TIMRX_API_LOCAL;
  } else if (await pingApi(TIMRX_API_RENDER)) {
    TIMRX_API_BASE = TIMRX_API_RENDER;
  }
  // publish the chosen base so FAQ + other code can use it
  window.TIMRX_API_BASE = TIMRX_API_BASE; // <-- make it global
  console.log('TimrX API →', TIMRX_API_BASE);
})();

/** 3) Local “house style” fallback (no API) */
const TIMRX_FAQ_LOCAL = [
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
    a: "No. This chat answers questions and helps you navigate the site. Media generation happens in the TimrX workspace at /hub, not inside the chat itself.",
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
    a: "Typical custom project ranges are £100–£500, £500–£1.5k, £1.5k–£3k, and £3k–£7k+. For a real quote, use the budget chips in #contact.",
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
  }
];

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
  return TIMRX_FAQ_LOCAL
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
  // (A) try streaming first
  try {
    const res = await fetch(`${TIMRX_API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0.25 })
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
      body: JSON.stringify({ messages, temperature: 0.25 })
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
