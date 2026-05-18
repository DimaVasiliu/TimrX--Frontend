const GENERIC_LABELS = new Set([
  '',
  'untitled',
  '(untitled)',
  'model',
  '3d model',
  'generated model',
  'rigged model',
  'animated model',
  'animation',
  'image',
  'video',
  'asset',
  'download',
  'preview',
]);

const MIME_EXTENSION_MAP = {
  'application/octet-stream': 'glb',
  'application/x-fbx': 'fbx',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'model/gltf+json': 'gltf',
  'model/gltf-binary': 'glb',
  'model/obj': 'obj',
  'model/stl': 'stl',
  'model/vnd.usdz+zip': 'usdz',
  'video/mp4': 'mp4',
};

function normalizeLabel(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isHexLikeId(value = '') {
  return /^[0-9a-f-]{24,}$/i.test(String(value || '').trim());
}

function isMeaningfulLabel(value = '') {
  const normalized = normalizeLabel(value);
  if (!normalized || GENERIC_LABELS.has(normalized)) return false;
  if (isHexLikeId(normalized.replace(/\s+/g, ''))) return false;
  if (/^animation\s*#?\s*\d+$/i.test(normalized)) return false;
  return true;
}

function slugify(value = '', maxLength = 24) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!ascii) return '';
  if (ascii.length <= maxLength) return ascii;
  return ascii.slice(0, maxLength).replace(/-+$/g, '');
}

function fallbackBaseName(type = '') {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (type === 'model') return 'model';
  return 'asset';
}

function extractFilenameFromUrl(url = '') {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    const segment = decodeURIComponent((parsed.pathname || '').split('/').pop() || '');
    return segment || '';
  } catch {
    const clean = String(url || '').split('#')[0].split('?')[0];
    return decodeURIComponent(clean.split('/').pop() || '');
  }
}

function hashString(value = '') {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function inferExtensionFromUrl(url = '') {
  const filename = extractFilenameFromUrl(url);
  const match = filename.match(/\.([a-z0-9]{1,8})$/i);
  return match ? normalizeExtension(match[1]) : '';
}

export function inferExtensionFromMimeType(mimeType = '') {
  return MIME_EXTENSION_MAP[String(mimeType || '').toLowerCase()] || '';
}

export function normalizeExtension(extension = '') {
  return String(extension || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/g, '');
}

export function buildDownloadNumber(options = {}) {
  const basis = [
    options.assetId,
    options.id,
    options.createdAt,
    options.sourceUrl,
    options.filename,
    options.title,
    options.prompt,
    options.type,
  ]
    .filter(Boolean)
    .map((part) => String(part))
    .join('|');

  if (!basis) {
    return String(100 + (Date.now() % 900)).padStart(3, '0');
  }

  return String(100 + (hashString(basis) % 900)).padStart(3, '0');
}

export function buildDownloadFilename(options = {}) {
  const type = String(options.type || 'asset').toLowerCase();
  const extension = normalizeExtension(
    options.extension ||
      inferExtensionFromUrl(options.sourceUrl) ||
      inferExtensionFromMimeType(options.mimeType) ||
      (type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'glb')
  );

  const candidates = [
    options.title,
    options.prompt,
    options.name,
    options.modelName,
    options.jobLabel,
    options.generatedName,
    options.filename,
    extractFilenameFromUrl(options.sourceUrl),
  ];

  const chosen = candidates.find(isMeaningfulLabel) || fallbackBaseName(type);
  const shortName = slugify(chosen, options.maxNameLength || 24) || fallbackBaseName(type);
  const shortNumber = buildDownloadNumber({
    assetId: options.assetId,
    id: options.id,
    createdAt: options.createdAt,
    sourceUrl: options.sourceUrl,
    filename: options.filename,
    title: chosen,
    prompt: options.prompt,
    type,
  });

  return `TX-${shortName}-${shortNumber}.${extension || 'bin'}`;
}

export function buildProxyDownloadUrl(backend, sourceUrl, filename) {
  const params = new URLSearchParams({
    u: sourceUrl,
    download: '1',
  });
  if (filename) params.set('filename', filename);
  return `${backend}/api/_mod/proxy-glb?${params.toString()}`;
}

export function triggerBrowserDownload(href, filename = '') {
  const anchor = document.createElement('a');
  anchor.href = href;
  if (filename) anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
