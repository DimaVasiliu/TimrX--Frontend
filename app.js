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
function timrxLocalRouter(q) {
  const text = (q || '').toLowerCase();
  if (text.includes('service') || text.includes('offer'))
    return 'I build modern, motion-first websites (GSAP/Three.js), 3D tools & prints, and platform-native shorts.';
  if (text.includes('3d') && (text.includes('start') || text.includes('project')))
    return 'To start a 3D project: share a reference + size + use (web/print) + budget (chips in Contact). I’ll scope it.';
  if (text.includes('budget') || text.includes('price'))
    return 'Typical ranges: £100–£500 (simple landing page), £500–£1.5k (landing + extras), £1.5–3k (site/3D), £3–7k+ (full stack). Use the budget chips and message me.';
  if (text.includes('email') || text.includes('contact'))
    return 'Use the Contact form below or email me — I usually reply within 24–48h.';
  return 'I can help with About, Works, Services, Blogs, and Contact. Ask away or jump to CONTACT.';
}

/** 4) ask(): STREAM → JSON → local fallback */
async function timrxAsk(messages, onStreamToken) {
  // (A) try streaming first
  try {
    const res = await fetch(`${TIMRX_API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0.3 })
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
      body: JSON.stringify({ messages, temperature: 0.3 })
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

/* ========= FAQ search helper (API + offline fallback) ========= */
const TIMRX_FAQ_LOCAL = [
  { q: "What services do you offer?" },
  { q: "What are your usual budgets?" },
  { q: "How fast can we start?" },
  { q: "Do you support e-commerce or CMS?" },
  { q: "Which 3D formats do you use?" },
  { q: "Can you make print-ready models?" },
  { q: "How does the process work?" },
  { q: "What do you need from me to start?" },
  { q: "Do you do consultations or audits?" },
  { q: "Where can I see examples?" },
];

async function timrxFaqSearch(q) {
  const query = (q || "").trim();
  if (query.length < 3) return [];

  // 1) Try the API
  try {
    const base = window.TIMRX_API_BASE || TIMRX_API_BASE; // <-- unified
    const url = `${base}/api/faq/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const ctx = (data.context || '');
      const items = [];
      const lines = ctx.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i].trim();
        if (L.startsWith('- Q:')) {
          const qText = L.replace(/^- Q:\s*/, '').trim();
          let aText = '';
          const next = (lines[i + 1] || '').trim();
          if (next.startsWith('A:')) aText = next.replace(/^A:\s*/, '').trim();
          items.push({ q: qText, a: aText });
        }
      }
      if (items.length) return items.slice(0, 5);
    }
  } catch (e) { /* fall through */ }

  // 2) Local fallback (client-side fuzzy filter)
  const norm = query.toLowerCase();
  return TIMRX_FAQ_LOCAL.filter(it => it.q.toLowerCase().includes(norm)).slice(0, 5);
}

window.timrxFaqSearch = timrxFaqSearch;
