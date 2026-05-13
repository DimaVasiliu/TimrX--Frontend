/**
 * Multi-Color Paint & Export
 *
 * Client-side model painting + 3MF export. No external API needed.
 * 1. Load GLB model into Three.js viewer
 * 2. User picks filament colors from real Bambu Lab palettes
 * 3. User clicks on model to paint regions (raycaster + flood fill)
 * 4. Export colored model as 3MF (JSZip) — instant, free, offline
 */

import { BACKEND, apiFetch, getLoadableModelUrl, isTimrxS3Url } from './config.js';
import * as State from './state.js?v=20260407e';

// ============================================================================
// Constants
// ============================================================================

const PLA_BASIC = [
  { hex: '#FFFFFF', name: 'White' },
  { hex: '#F5F5F0', name: 'Cool White' },
  { hex: '#D1DBCF', name: 'Jade White' },
  { hex: '#F4EE2A', name: 'Yellow' },
  { hex: '#FDE047', name: 'Lemon Yellow' },
  { hex: '#E8B455', name: 'Savanna Yellow' },
  { hex: '#FAA256', name: 'Mandarin Orange' },
  { hex: '#F97316', name: 'Orange' },
  { hex: '#E63A2E', name: 'Red' },
  { hex: '#C62828', name: 'Scarlet Red' },
  { hex: '#EC4899', name: 'Pink' },
  { hex: '#D946EF', name: 'Magenta' },
  { hex: '#8B5CF6', name: 'Purple' },
  { hex: '#2563EB', name: 'Blue' },
  { hex: '#38BDF8', name: 'Sky Blue' },
  { hex: '#06B6D4', name: 'Cyan' },
  { hex: '#14B8A6', name: 'Teal' },
  { hex: '#047857', name: 'Bambu Green' },
  { hex: '#22C55E', name: 'Green' },
  { hex: '#84CC16', name: 'Lime' },
  { hex: '#D4A017', name: 'Gold' },
  { hex: '#C0C0C0', name: 'Silver' },
  { hex: '#1A1A1A', name: 'Black' },
];
const PLA_MATTE = [
  { hex: '#404040', name: 'Charcoal' },
  { hex: '#FFFFF0', name: 'Ivory White' },
  { hex: '#FFB7C5', name: 'Sakura Pink' },
  { hex: '#C8A2C8', name: 'Lilac Purple' },
  { hex: '#FF8C00', name: 'Mandarin Orange' },
  { hex: '#006400', name: 'Dark Green' },
  { hex: '#6A5ACD', name: 'Slate Blue' },
  { hex: '#DC143C', name: 'Crimson' },
  { hex: '#C2B280', name: 'Sand' },
  { hex: '#8B4513', name: 'Chocolate' },
  { hex: '#2F4F4F', name: 'Dark Slate' },
  { hex: '#B22222', name: 'Firebrick' },
  { hex: '#556B2F', name: 'Olive' },
  { hex: '#483D8B', name: 'Dark Indigo' },
  { hex: '#D2691E', name: 'Copper' },
  { hex: '#808080', name: 'Grey' },
];

const DEFAULT_FILAMENTS = [
  { hex: '#E63A2E', name: 'Red' },
  { hex: '#2563EB', name: 'Blue' },
  { hex: '#22C55E', name: 'Green' },
  { hex: '#F4EE2A', name: 'Yellow' },
];

// Angle threshold in radians for flood-fill (faces within ~30 deg are same region)
const FLOOD_FILL_ANGLE = 0.52;
const BRUSH_MIN_MODEL_RATIO = 0.004;
const BRUSH_MAX_MODEL_RATIO = 0.16;
const BRUSH_DEFAULT_MODEL_RATIO = 0.035;
const BASE_PREVIEW_COLOR = 0.72;

// ============================================================================
// State
// ============================================================================

let _scene = null, _renderer = null, _camera = null, _controls = null;
let _model = null;          // loaded gltf.scene
let _paintMeshes = [];      // flat list of THREE.Mesh with BufferGeometry
let _faceColors = null;     // Int32Array, one slot index per face (-1 = unpainted)
let _faceToMeshIdx = null;  // which mesh each global face belongs to
let _faceOffsets = null;     // cumulative face offsets per mesh
let _totalFaces = 0;

let _filaments = [];        // [{hex, name}]
let _activeSlot = 0;        // which filament is selected for painting
let _brushMode = 'brush';   // 'brush' | 'region' | 'face' | 'eraser'
let _brushRadius = 0.05;    // world-space radius for brush mode (0.01 - 0.5)
let _modelMaxDim = 1;
let _paintEnabled = true;
let _isPainting = false;    // true while mouse held in brush/face/eraser mode

let _raycaster = null;
let _mouse = new (window.THREE?.Vector2 || function(){})();

// Precomputed face centers for brush radius check (per mesh)
let _faceCenters = null; // Float32Array [x,y,z, x,y,z, ...] in world space
let _meshTopology = []; // [{ normals, vertToFaces }] cached per paint mesh

let _taskId = null;
let _modelTitle = '';
let _modelUrl = '';
let _autoPollTimer = null;
let _autoJobId = null;
let _manualRepairHandler = null;
let _manualPrintCheck = { loading: false, result: null, error: '' };
let _exportTargetHeightMm = '';
let _exportWeldToleranceMm = 0.001;
let _exportCenterOnPlate = true;

// ============================================================================
// Modal DOM
// ============================================================================

function _injectStyles() {
  if (document.getElementById('mcp-styles')) return;
  const s = document.createElement('style');
  s.id = 'mcp-styles';
  s.textContent = `
    #multi-color-modal,
    #meshy-mcp-modal {
      position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
      align-items:center;justify-content:center;z-index:99999;backdrop-filter:blur(4px);
    }
    .mcp-container {
      width:min(1200px,92vw);height:min(720px,88vh);background:#0f0f11;
      border:1px solid rgba(255,255,255,.07);border-radius:12px;
      display:flex;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.8);
    }
    .mcp-viewer {
      flex:1 1 60%;min-width:0;background:#121214;position:relative;
      border-right:1px solid rgba(255,255,255,.07);cursor:crosshair;
    }
    .mcp-viewer.orbiting { cursor:grab; }
    .mcp-sidebar {
      flex:0 0 340px;overflow-y:auto;padding:14px;display:flex;
      flex-direction:column;gap:10px;scrollbar-width:thin;
      scrollbar-color:rgba(255,255,255,.12) transparent;
    }
    .mcp-sidebar::-webkit-scrollbar{width:5px;}
    .mcp-sidebar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px;}
    .mcp-header{display:flex;align-items:center;justify-content:space-between;}
    .mcp-header h2{margin:0;font-size:14px;font-weight:700;color:rgba(255,255,255,.95);}
    .mcp-close{width:26px;height:26px;display:flex;align-items:center;justify-content:center;
      background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:6px;
      color:rgba(255,255,255,.5);cursor:pointer;transition:.15s;}
    .mcp-close:hover{background:rgba(255,255,255,.08);color:rgba(255,255,255,.8);}
    .mcp-label{font-size:10px;font-weight:600;color:rgba(255,255,255,.5);
      text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
    .mcp-filaments{display:flex;flex-direction:column;gap:3px;}
    .mcp-filament{display:flex;align-items:center;gap:8px;padding:5px 8px;
      border:1px solid rgba(255,255,255,.06);border-radius:6px;cursor:pointer;
      transition:.15s;user-select:none;}
    .mcp-filament:hover{background:rgba(255,255,255,.03);}
    .mcp-filament.active{border-color:rgba(14,165,233,.5);background:rgba(14,165,233,.06);}
    .mcp-filament-swatch{width:22px;height:22px;border-radius:4px;
      border:1px solid rgba(0,0,0,.3);flex-shrink:0;}
    .mcp-filament-info{flex:1;min-width:0;}
    .mcp-filament-name{font-size:11px;color:rgba(255,255,255,.8);font-weight:500;}
    .mcp-filament-hex{font-size:9px;color:rgba(255,255,255,.35);font-family:monospace;}
    .mcp-filament-rm{width:18px;height:18px;display:flex;align-items:center;
      justify-content:center;border-radius:4px;color:rgba(255,255,255,.25);
      cursor:pointer;transition:.15s;font-size:12px;flex-shrink:0;}
    .mcp-filament-rm:hover{color:#ef4444;background:rgba(239,68,68,.1);}
    .mcp-add-row{display:flex;gap:6px;align-items:center;}
    .mcp-add-btn{flex:1;padding:5px 0;border:1px dashed rgba(255,255,255,.1);
      border-radius:6px;background:none;color:rgba(255,255,255,.4);font-size:10px;
      cursor:pointer;transition:.15s;text-align:center;}
    .mcp-add-btn:hover{border-color:rgba(14,165,233,.3);color:rgba(14,165,233,.7);}
    .mcp-palette{display:flex;flex-direction:column;gap:4px;}
    .mcp-palette-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;}
    .mcp-palette-sw{aspect-ratio:1;border-radius:3px;border:1px solid rgba(0,0,0,.25);
      cursor:pointer;transition:.12s;}
    .mcp-palette-sw:hover{transform:scale(1.12);box-shadow:0 2px 6px rgba(0,0,0,.4);}
    .mcp-palette-sw.selected{outline:2px solid #0ea5e9;outline-offset:1px;}
    .mcp-section{padding:8px;background:rgba(255,255,255,.02);
      border:1px solid rgba(255,255,255,.04);border-radius:8px;}
    .mcp-brush-row{display:flex;gap:4px;}
    .mcp-brush-btn{flex:1;padding:4px 0;border:1px solid rgba(255,255,255,.08);
      border-radius:5px;background:none;color:rgba(255,255,255,.5);font-size:10px;
      cursor:pointer;transition:.15s;text-align:center;}
    .mcp-brush-btn.active{border-color:rgba(14,165,233,.4);color:#0ea5e9;
      background:rgba(14,165,233,.08);}
    #mcp-brush-size::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;
      border-radius:50%;background:linear-gradient(135deg,#0ea5e9,#8b5cf6);border:2px solid #121214;cursor:pointer;}
    #mcp-brush-size::-moz-range-thumb{width:12px;height:12px;border-radius:50%;
      background:linear-gradient(135deg,#0ea5e9,#8b5cf6);border:2px solid #121214;cursor:pointer;}
    .mcp-actions{display:flex;flex-direction:column;gap:6px;margin-top:auto;
      padding-top:10px;border-top:1px solid rgba(255,255,255,.05);}
    .mcp-btn{padding:8px 14px;border-radius:6px;font-size:12px;font-weight:600;
      border:none;cursor:pointer;transition:.2s;display:flex;align-items:center;
      justify-content:center;gap:6px;white-space:nowrap;}
    .mcp-btn-primary{background:linear-gradient(135deg,#0ea5e9,#8b5cf6);color:#fff;
      box-shadow:0 4px 12px rgba(14,165,233,.35);}
    .mcp-btn-primary:hover{box-shadow:0 6px 16px rgba(14,165,233,.45);transform:translateY(-1px);}
    .mcp-btn-secondary{background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.7);}
    .mcp-btn-secondary:hover{background:rgba(255,255,255,.08);color:rgba(255,255,255,.9);}
    .mcp-btn-danger{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);
      color:rgba(239,68,68,.8);}
    .mcp-btn-danger:hover{background:rgba(239,68,68,.15);}
    .mcp-info{display:flex;gap:6px;padding:8px;background:rgba(14,165,233,.04);
      border:1px solid rgba(14,165,233,.08);border-radius:6px;font-size:10px;
      line-height:1.5;color:rgba(255,255,255,.45);}
    .mcp-info svg{color:rgba(14,165,233,.4);flex-shrink:0;margin-top:1px;}
    .mcp-check-card{border-radius:8px;border:1px solid rgba(255,255,255,.06);
      background:rgba(0,0,0,.18);padding:8px;display:flex;flex-direction:column;gap:6px;}
    .mcp-check-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .mcp-score{font-size:18px;font-weight:800;line-height:1;padding:6px 8px;border-radius:7px;
      background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);min-width:48px;text-align:center;}
    .mcp-score.good{background:rgba(34,197,94,.12);color:#22c55e;}
    .mcp-score.warn{background:rgba(245,158,11,.14);color:#f59e0b;}
    .mcp-score.bad{background:rgba(239,68,68,.14);color:#ef4444;}
    .mcp-check-text{font-size:10px;line-height:1.45;color:rgba(255,255,255,.5);}
    .mcp-check-list{display:flex;flex-direction:column;gap:3px;font-size:10px;color:rgba(255,255,255,.48);}
    .mcp-check-row{display:flex;justify-content:space-between;gap:8px;border-top:1px solid rgba(255,255,255,.04);padding-top:3px;}
    .mcp-check-row strong{color:rgba(255,255,255,.7);font-weight:600;}
    .mcp-input-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
    .mcp-field{display:flex;flex-direction:column;gap:3px;}
    .mcp-field span{font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:rgba(255,255,255,.35);}
    .mcp-field input{background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);
      color:rgba(255,255,255,.85);border-radius:6px;padding:6px 7px;font-size:11px;outline:none;}
    .mcp-field input:focus{border-color:rgba(14,165,233,.45);}
    .mcp-check-toggle{display:flex;align-items:center;gap:6px;font-size:10px;color:rgba(255,255,255,.5);}
    .mcp-btn[disabled]{opacity:.5;cursor:not-allowed;transform:none!important;box-shadow:none!important;}
    .mcp-stats{font-size:10px;color:rgba(255,255,255,.3);text-align:center;padding:4px 0;}
    .mcp-viewer-hint{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);
      font-size:10px;color:rgba(255,255,255,.25);pointer-events:none;
      background:rgba(0,0,0,.5);padding:3px 10px;border-radius:4px;}
    @media(max-width:768px){
      .mcp-container{flex-direction:column;}
      .mcp-viewer{flex:0 0 50%;border-right:none;border-bottom:1px solid rgba(255,255,255,.07);}
      .mcp-sidebar{flex:1;padding:10px;}
    }
  `;
  document.head.appendChild(s);
}

function _createModal() {
  _injectStyles();
  const overlay = document.createElement('div');
  overlay.id = 'multi-color-modal';

  overlay.innerHTML = `
    <div class="mcp-container">
      <div class="mcp-viewer" id="mcp-viewer"></div>
      <div class="mcp-sidebar" id="mcp-sidebar"></div>
    </div>`;

  document.body.appendChild(overlay);
  return overlay;
}

function _createAutoModal() {
  _injectStyles();
  const overlay = document.createElement('div');
  overlay.id = 'meshy-mcp-modal';
  overlay.innerHTML = `
    <div class="mcp-container" style="width:min(520px,92vw);height:auto;max-height:88vh;">
      <div class="mcp-sidebar" style="flex:1 1 auto;">
        <div class="mcp-header">
          <h2>Meshy Auto 3MF</h2>
          <div class="mcp-close" id="meshy-mcp-close">&times;</div>
        </div>
        <div class="mcp-section">
          <div class="mcp-label">Color Count</div>
          <input id="meshy-mcp-colors" type="range" min="1" max="16" value="4"
            style="-webkit-appearance:none;width:100%;height:3px;border-radius:2px;background:rgba(255,255,255,.1);outline:none;cursor:pointer;" />
          <div id="meshy-mcp-colors-label" style="font-size:11px;color:rgba(255,255,255,.65);margin-top:6px;">4 colors</div>
        </div>
        <div class="mcp-section">
          <div class="mcp-label">Color Detail</div>
          <input id="meshy-mcp-depth" type="range" min="3" max="6" value="4"
            style="-webkit-appearance:none;width:100%;height:3px;border-radius:2px;background:rgba(255,255,255,.1);outline:none;cursor:pointer;" />
          <div id="meshy-mcp-depth-label" style="font-size:11px;color:rgba(255,255,255,.65);margin-top:6px;">Level 4</div>
        </div>
        <div class="mcp-section" id="meshy-mcp-status" style="font-size:11px;line-height:1.5;color:rgba(255,255,255,.58);">
          Ready to send to Meshy.
        </div>
        <div class="mcp-section" id="meshy-mcp-progress-wrap" style="display:none;">
          <div style="height:5px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;">
            <div id="meshy-mcp-progress" style="height:100%;width:0%;background:linear-gradient(90deg,#0ea5e9,#8b5cf6);transition:width .25s;"></div>
          </div>
        </div>
        <div class="mcp-actions">
          <button class="mcp-btn mcp-btn-primary" id="meshy-mcp-start">Start Meshy 3MF</button>
          <button class="mcp-btn mcp-btn-secondary" id="meshy-mcp-download" style="display:none;">Download 3MF</button>
          <button class="mcp-btn mcp-btn-secondary" id="meshy-mcp-cancel">Close</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// ============================================================================
// 3D Viewer
// ============================================================================

function _createPaintPreviewMaterial(T) {
  return new T.ShaderMaterial({
    vertexColors: true,
    side: T.DoubleSide,
    uniforms: {
      lightDir: { value: new T.Vector3(0.35, 0.75, 0.55).normalize() },
      fillDir: { value: new T.Vector3(-0.65, 0.25, 0.7).normalize() },
    },
    vertexShader: `
      varying vec3 vColor;
      varying vec3 vNormalW;
      void main() {
        vColor = color;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 lightDir;
      uniform vec3 fillDir;
      varying vec3 vColor;
      varying vec3 vNormalW;
      void main() {
        vec3 n = normalize(vNormalW);
        float key = abs(dot(n, lightDir));
        float fill = abs(dot(n, fillDir));
        float shade = 0.46 + key * 0.38 + fill * 0.14;
        vec3 color = clamp(vColor * shade, 0.0, 1.0);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

function _getFacePreviewColor(slotIdx, T, target = new T.Color()) {
  if (slotIdx >= 0 && slotIdx < _filaments.length) {
    return target.set(_filaments[slotIdx].hex);
  }
  return target.setRGB(BASE_PREVIEW_COLOR, BASE_PREVIEW_COLOR, BASE_PREVIEW_COLOR);
}

function _brushRadiusFromSlider(value) {
  const pct = Math.min(100, Math.max(1, Number(value) || 1)) / 100;
  const ratio = BRUSH_MIN_MODEL_RATIO + (BRUSH_MAX_MODEL_RATIO - BRUSH_MIN_MODEL_RATIO) * pct;
  return Math.max(0.0001, _modelMaxDim * ratio);
}

function _brushSliderValue() {
  const denom = Math.max(0.0001, _modelMaxDim);
  const ratio = _brushRadius / denom;
  const pct = (ratio - BRUSH_MIN_MODEL_RATIO) / (BRUSH_MAX_MODEL_RATIO - BRUSH_MIN_MODEL_RATIO);
  return Math.round(Math.min(1, Math.max(0, pct)) * 100);
}

function _formatBrushRadius(radius) {
  if (radius >= 1) return `${radius.toFixed(1)} mm`;
  return `${radius.toFixed(3)}`;
}

function _setupViewer(glbUrl, sourceObject = null) {
  const container = document.getElementById('mcp-viewer');
  if (!container) return;

  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.3);font-size:12px;">Loading model...</div>';
  if (!glbUrl && !sourceObject) { container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.2);font-size:11px;">No model loaded</div>'; return; }

  container.innerHTML = '';
  const T = window.THREE;
  const w = container.clientWidth, h = container.clientHeight;

  _scene = new T.Scene();
  _scene.background = new T.Color(0x121214);
  _camera = new T.PerspectiveCamera(50, w / h, 0.01, 500);
  _camera.position.set(0, 0, 3);

  _renderer = new T.WebGLRenderer({ antialias: true });
  _renderer.setSize(w, h);
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _renderer.toneMapping = T.ACESFilmicToneMapping;
  _renderer.toneMappingExposure = 1.0;
  container.appendChild(_renderer.domElement);

  // Lighting
  try {
    if (T.RoomEnvironment && T.PMREMGenerator) {
      const pmrem = new T.PMREMGenerator(_renderer);
      _scene.environment = pmrem.fromScene(new T.RoomEnvironment()).texture;
      pmrem.dispose();
    }
  } catch (_) {}
  _scene.add(new T.AmbientLight(0xffffff, 0.5));
  _scene.add(new T.HemisphereLight(0xffffff, 0x1f2937, 0.9));
  const dl = new T.DirectionalLight(0xffffff, 0.8);
  dl.position.set(5, 10, 7);
  _scene.add(dl);

  _controls = new T.OrbitControls(_camera, _renderer.domElement);
  _controls.enableDamping = true;
  _controls.dampingFactor = 0.08;

  _raycaster = new T.Raycaster();

  const handleLoadedModel = (model) => {
    _model = model;
    _scene.add(_model);

    // Prepare paint data
    _preparePaintData();
    _framePaintModel(T);
    _brushRadius = _brushRadiusFromSlider(20);
    _renderSidebar();

    // Add click hint
    const hint = document.createElement('div');
    hint.className = 'mcp-viewer-hint';
    hint.textContent = _totalFaces > 0
      ? `Loaded ${_totalFaces.toLocaleString()} faces. Click on the model to paint.`
      : 'Model loaded, but no paintable faces were found.';
    container.appendChild(hint);
    setTimeout(() => hint.style.opacity = '0', 4000);
  };

  const handleLoadError = (err) => {
    console.error('[MCP] Model load error:', err);
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.3);font-size:11px;">Failed to load model</div>';
  };

  if (sourceObject) {
    try {
      handleLoadedModel(sourceObject);
    } catch (err) {
      handleLoadError(err);
    }
  } else {
    const loadUrl = getLoadableModelUrl(glbUrl);
    const ext = (String(loadUrl).split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

    if (ext === 'stl') {
      if (!T.STLLoader) {
        handleLoadError(new Error('STLLoader missing'));
      } else {
        const loader = new T.STLLoader();
        if (!isTimrxS3Url(loadUrl)) { loader.setCrossOrigin('use-credentials'); loader.setWithCredentials?.(true); }
        else { loader.setCrossOrigin('anonymous'); }
        loader.load(loadUrl, (geometry) => {
          geometry.computeVertexNormals();
          const material = new T.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.75, metalness: 0, side: T.DoubleSide });
          const mesh = new T.Mesh(geometry, material);
          const group = new T.Group();
          group.name = _safeFileBase(_modelTitle || 'uploaded_stl');
          group.add(mesh);
          handleLoadedModel(group);
        }, undefined, handleLoadError);
      }
    } else {
      const loader = new T.GLTFLoader();
      if (!isTimrxS3Url(loadUrl)) { loader.setCrossOrigin('use-credentials'); loader.setWithCredentials(true); }
      else { loader.setCrossOrigin('anonymous'); }
      loader.load(loadUrl, (gltf) => handleLoadedModel(gltf.scene), undefined, handleLoadError);
    }
  }

  // Paint handlers — pointerdown/move/up for drag painting
  const canvas = _renderer.domElement;
  canvas.addEventListener('pointerdown', _onPointerDown);
  canvas.addEventListener('pointermove', _onPointerMove);
  canvas.addEventListener('pointerup', _onPointerUp);
  canvas.addEventListener('pointerleave', _onPointerUp);

  // Resize
  const onResize = () => {
    const nw = container.clientWidth, nh = container.clientHeight;
    if (nw && nh && _camera && _renderer) {
      _camera.aspect = nw / nh;
      _camera.updateProjectionMatrix();
      _renderer.setSize(nw, nh);
    }
  };
  window.addEventListener('resize', onResize);
  container._resizeHandler = onResize;

  // Render loop
  const animate = () => {
    container._animId = requestAnimationFrame(animate);
    if (_controls) _controls.update();
    if (_renderer && _scene && _camera) _renderer.render(_scene, _camera);
  };
  animate();
}

let _pDownX = 0, _pDownY = 0;
let _didPaintThisStroke = false;

function _onPointerDown(e) {
  _pDownX = e.clientX; _pDownY = e.clientY;
  _didPaintThisStroke = false;
  if (!_paintEnabled || !_paintMeshes.length) return;

  // In brush/face/eraser mode, start drag-painting immediately
  if (_brushMode === 'brush' || _brushMode === 'face' || _brushMode === 'eraser') {
    _isPainting = true;
    // Disable orbit while painting
    if (_controls) _controls.enabled = false;
    _paintAtEvent(e);
    _didPaintThisStroke = true;
  }
}

function _onPointerMove(e) {
  if (!_isPainting || !_paintEnabled) return;
  // Continuous painting while dragging
  _paintAtEvent(e);
  _didPaintThisStroke = true;
}

function _onPointerUp(e) {
  if (_isPainting) {
    _isPainting = false;
    if (_controls) _controls.enabled = true;
    if (_didPaintThisStroke) { _applyColorsToMeshes(); _updateStats(); }
    return;
  }
  // For region mode, only paint on click (not drag)
  if (_brushMode === 'region') {
    const dx = e.clientX - _pDownX, dy = e.clientY - _pDownY;
    if (Math.sqrt(dx * dx + dy * dy) > 5) return;
    if (!_paintEnabled || !_paintMeshes.length) return;
    _paintAtEvent(e);
    _applyColorsToMeshes();
    _updateStats();
  }
}

// ============================================================================
// Paint Data Preparation
// ============================================================================

function _preparePaintData() {
  const T = window.THREE;
  _paintMeshes = [];
  _meshTopology = [];
  _model.traverse((child) => {
    if (child.isMesh && child.geometry) {
      // Work on a private non-indexed copy. Mutating loader-owned geometry can
      // corrupt later exports because clones share BufferGeometry by reference.
      let geo = child.geometry.clone();
      if (geo.index) {
        geo.computeVertexNormals();
        geo = geo.toNonIndexed();
      }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      child.geometry = geo;
      // Add vertex color attribute (default white)
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      colors.fill(BASE_PREVIEW_COLOR);
      geo.setAttribute('color', new T.BufferAttribute(colors, 3));

      child.material = _createPaintPreviewMaterial(T);

      _paintMeshes.push(child);
    }
  });

  // Build global face index
  _totalFaces = 0;
  _faceOffsets = [];
  for (const mesh of _paintMeshes) {
    _faceOffsets.push(_totalFaces);
    _totalFaces += mesh.geometry.attributes.position.count / 3;
  }
  _faceColors = new Int32Array(_totalFaces).fill(-1); // -1 = unpainted

  // Precompute face centers in world space for brush radius checks
  _faceCenters = new Float32Array(_totalFaces * 3);
  const va = new T.Vector3(), vb = new T.Vector3(), vc = new T.Vector3();

  for (let mi = 0; mi < _paintMeshes.length; mi++) {
    const mesh = _paintMeshes[mi];
    mesh.updateWorldMatrix(true, false);
    const posAttr = mesh.geometry.attributes.position;
    const faceCount = posAttr.count / 3;
    const offset = _faceOffsets[mi];
    const topology = _buildMeshTopology(mesh, faceCount, T);
    _meshTopology[mi] = topology;

    for (let fi = 0; fi < faceCount; fi++) {
      const i3 = fi * 3;
      va.fromBufferAttribute(posAttr, i3).applyMatrix4(mesh.matrixWorld);
      vb.fromBufferAttribute(posAttr, i3 + 1).applyMatrix4(mesh.matrixWorld);
      vc.fromBufferAttribute(posAttr, i3 + 2).applyMatrix4(mesh.matrixWorld);
      const gIdx = (offset + fi) * 3;
      _faceCenters[gIdx]     = (va.x + vb.x + vc.x) / 3;
      _faceCenters[gIdx + 1] = (va.y + vb.y + vc.y) / 3;
      _faceCenters[gIdx + 2] = (va.z + vb.z + vc.z) / 3;
    }
  }

  console.log(`[MCP Paint] Ready: ${_paintMeshes.length} meshes, ${_totalFaces} faces`);
}

function _buildMeshTopology(mesh, faceCount, T) {
  const posAttr = mesh.geometry.attributes.position;
  const normals = new Array(faceCount);
  const vertToFaces = new Map();
  const vA = new T.Vector3(), vB = new T.Vector3(), vC = new T.Vector3();
  const edge1 = new T.Vector3(), edge2 = new T.Vector3(), normal = new T.Vector3();
  const keyScale = 10000;
  const vertKey = (x, y, z) => `${Math.round(x * keyScale)},${Math.round(y * keyScale)},${Math.round(z * keyScale)}`;

  for (let fi = 0; fi < faceCount; fi++) {
    const i3 = fi * 3;
    vA.fromBufferAttribute(posAttr, i3);
    vB.fromBufferAttribute(posAttr, i3 + 1);
    vC.fromBufferAttribute(posAttr, i3 + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    normals[fi] = normal.crossVectors(edge1, edge2).normalize().clone();

    for (let corner = 0; corner < 3; corner++) {
      const idx = i3 + corner;
      const key = vertKey(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));
      let faces = vertToFaces.get(key);
      if (!faces) {
        faces = [];
        vertToFaces.set(key, faces);
      }
      faces.push(fi);
    }
  }

  return { normals, vertToFaces, vertKey };
}

function _framePaintModel(T) {
  if (!_camera || !_controls || !_paintMeshes.length) return;

  const box = new T.Box3();
  const meshBox = new T.Box3();
  let hasBounds = false;

  for (const mesh of _paintMeshes) {
    if (!mesh.geometry?.attributes?.position) continue;
    mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox || mesh.geometry.boundingBox.isEmpty()) continue;
    mesh.updateWorldMatrix(true, false);
    meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    if (!Number.isFinite(meshBox.min.x) || !Number.isFinite(meshBox.max.x)) continue;
    if (!hasBounds) {
      box.copy(meshBox);
      hasBounds = true;
    } else {
      box.union(meshBox);
    }
  }

  if (!hasBounds || box.isEmpty()) {
    console.warn('[MCP Paint] Unable to frame model: invalid bounds');
    return;
  }

  const center = box.getCenter(new T.Vector3());
  const size = box.getSize(new T.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  _modelMaxDim = maxDim;
  const fov = (_camera.fov || 50) * Math.PI / 180;
  const distance = Math.max(maxDim * 1.8, (maxDim / (2 * Math.tan(fov / 2))) * 1.35);

  _camera.near = Math.max(distance / 10000, 0.001);
  _camera.far = Math.max(distance + maxDim * 12, 1000);
  _camera.position.set(center.x, center.y, center.z + distance);
  _camera.lookAt(center);
  _camera.updateProjectionMatrix();

  _controls.target.copy(center);
  _controls.minDistance = Math.max(maxDim * 0.01, 0.001);
  _controls.maxDistance = Math.max(distance * 8, maxDim * 8);
  _controls.update();

  console.debug('[MCP Paint] Framed model', {
    center: center.toArray(),
    size: size.toArray(),
    distance,
    near: _camera.near,
    far: _camera.far,
  });
}

// ============================================================================
// Painting Logic
// ============================================================================

function _paintAtEvent(e) {
  const container = document.getElementById('mcp-viewer');
  if (!container || !_renderer) return;
  const rect = _renderer.domElement.getBoundingClientRect();
  _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  _raycaster.setFromCamera(_mouse, _camera);
  const intersects = _raycaster.intersectObjects(_paintMeshes, false);
  if (!intersects.length) return;

  const hit = intersects[0];
  const meshIdx = _paintMeshes.indexOf(hit.object);
  if (meshIdx < 0) return;

  const localFaceIdx = hit.faceIndex;
  const globalFace = _faceOffsets[meshIdx] + localFaceIdx;
  const hitPoint = hit.point; // world-space hit position

  const colorVal = _brushMode === 'eraser' ? -1 : _activeSlot;

  if (_brushMode === 'face') {
    _paintFace(globalFace, colorVal);
  } else if (_brushMode === 'brush' || _brushMode === 'eraser') {
    _paintBrush(hitPoint, colorVal);
  } else if (_brushMode === 'region') {
    _floodFillRegion(globalFace, colorVal, meshIdx);
  }

  // For drag modes, apply every frame; for region, apply once in _onPointerUp
  if (_isPainting) {
    _applyColorsToMeshes();
    _updateStats();
  }
}

function _paintFace(globalIdx, slotIdx) {
  _faceColors[globalIdx] = slotIdx;
}

function _paintBrush(hitPoint, slotIdx) {
  // Paint all faces whose center is within _brushRadius of hitPoint (world space)
  const r2 = _brushRadius * _brushRadius;
  const hx = hitPoint.x, hy = hitPoint.y, hz = hitPoint.z;

  for (let i = 0; i < _totalFaces; i++) {
    const i3 = i * 3;
    const dx = _faceCenters[i3] - hx;
    const dy = _faceCenters[i3 + 1] - hy;
    const dz = _faceCenters[i3 + 2] - hz;
    if (dx * dx + dy * dy + dz * dz <= r2) {
      _faceColors[i] = slotIdx;
    }
  }
}

function _floodFillRegion(startGlobal, slotIdx, meshIdx) {
  const mesh = _paintMeshes[meshIdx];
  const posAttr = mesh.geometry.attributes.position;
  const faceCount = posAttr.count / 3;
  const offset = _faceOffsets[meshIdx];
  const topology = _meshTopology[meshIdx];
  if (!topology) return;
  const { normals, vertToFaces, vertKey } = topology;

  // Flood fill from start face
  const localStart = startGlobal - offset;
  if (localStart < 0 || localStart >= faceCount) return;
  const visited = new Uint8Array(faceCount);
  const queue = [localStart];
  visited[localStart] = 1;
  const startNormal = normals[localStart];

  while (queue.length > 0) {
    const fi = queue.pop();
    _faceColors[offset + fi] = slotIdx;

    // Find neighbors via shared vertices
    for (let v = 0; v < 3; v++) {
      const idx = fi * 3 + v;
      const key = vertKey(
        posAttr.getX(idx),
        posAttr.getY(idx),
        posAttr.getZ(idx)
      );
      const neighbors = vertToFaces.get(key);
      if (!neighbors) continue;
      for (const ni of neighbors) {
        if (visited[ni]) continue;
        // Check normal similarity
        const angle = normals[ni].angleTo(startNormal);
        if (angle < FLOOD_FILL_ANGLE) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }
  }
}

function _applyColorsToMeshes() {
  const T = window.THREE;
  const tmpColor = new T.Color();

  for (let mi = 0; mi < _paintMeshes.length; mi++) {
    const mesh = _paintMeshes[mi];
    const colorAttr = mesh.geometry.attributes.color;
    const faceCount = colorAttr.count / 3;
    const offset = _faceOffsets[mi];

    for (let fi = 0; fi < faceCount; fi++) {
      const slotIdx = _faceColors[offset + fi];
      _getFacePreviewColor(slotIdx, T, tmpColor);
      const base = fi * 3;
      colorAttr.setXYZ(base, tmpColor.r, tmpColor.g, tmpColor.b);
      colorAttr.setXYZ(base + 1, tmpColor.r, tmpColor.g, tmpColor.b);
      colorAttr.setXYZ(base + 2, tmpColor.r, tmpColor.g, tmpColor.b);
    }
    colorAttr.needsUpdate = true;
  }
}

function _clearAllPaint() {
  if (_faceColors) _faceColors.fill(-1);
  _applyColorsToMeshes();
  _updateStats();
}

// ============================================================================
// Print Export Helpers
// ============================================================================

function _buildPrintableMeshData() {
  const T = window.THREE;
  const allVerts = [];   // flat [x,y,z, ...]
  const allFaces = [];   // {v1,v2,v3, colorSlot}
  const vertexMap = new Map();
  const weldTolerance = Math.min(0.05, Math.max(0.00001, Number(_exportWeldToleranceMm) || 0.001));
  const weldScale = 1 / weldTolerance;
  const vertexKey = (x, y, z) => `${Math.round(x * weldScale)},${Math.round(y * weldScale)},${Math.round(z * weldScale)}`;
  const addVertex = (x, y, z) => {
    const key = vertexKey(x, y, z);
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const idx = allVerts.length / 3;
    allVerts.push(x, y, z);
    vertexMap.set(key, idx);
    return idx;
  };

  for (let mi = 0; mi < _paintMeshes.length; mi++) {
    const mesh = _paintMeshes[mi];
    const posAttr = mesh.geometry.attributes.position;
    const faceCount = posAttr.count / 3;
    const offset = _faceOffsets[mi];
    mesh.updateWorldMatrix(true, false);
    const mat = mesh.matrixWorld;
    const v = new T.Vector3();

    for (let fi = 0; fi < faceCount; fi++) {
      const base = fi * 3;
      v.fromBufferAttribute(posAttr, base).applyMatrix4(mat);
      const v1 = addVertex(v.x, v.y, v.z);
      v.fromBufferAttribute(posAttr, base + 1).applyMatrix4(mat);
      const v2 = addVertex(v.x, v.y, v.z);
      v.fromBufferAttribute(posAttr, base + 2).applyMatrix4(mat);
      const v3 = addVertex(v.x, v.y, v.z);
      if (v1 === v2 || v1 === v3 || v2 === v3) continue;
      allFaces.push({
        v1,
        v2,
        v3,
        colorSlot: _faceColors[offset + fi]
      });
    }
  }

  if (!allFaces.length) {
    throw new Error('No printable triangles found in the painted model.');
  }

  const targetHeight = Number.parseFloat(_exportTargetHeightMm);
  if (Number.isFinite(targetHeight) && targetHeight > 0) {
    let minZScale = Infinity, maxZScale = -Infinity;
    for (let i = 2; i < allVerts.length; i += 3) {
      if (allVerts[i] < minZScale) minZScale = allVerts[i];
      if (allVerts[i] > maxZScale) maxZScale = allVerts[i];
    }
    const currentHeight = maxZScale - minZScale;
    if (currentHeight > 0) {
      const scale = targetHeight / currentHeight;
      for (let i = 0; i < allVerts.length; i++) allVerts[i] *= scale;
    }
  }

  // Keep the exported object centered and sitting on the build plate while
  // preserving its source dimensions unless the user chose a target height.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < allVerts.length; i += 3) {
    const x = allVerts[i], y = allVerts[i + 1], z = allVerts[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  if (_exportCenterOnPlate) {
    for (let i = 0; i < allVerts.length; i += 3) {
      allVerts[i] -= centerX;
      allVerts[i + 1] -= centerY;
      allVerts[i + 2] -= minZ;
    }
  }

  return { allVerts, allFaces };
}

function _validatePrintExportIntent() {
  const score = _manualPrintCheck.result?.score;
  if (Number.isFinite(Number(score)) && Number(score) < 60) {
    return confirm('Print Check says this mesh needs repair before slicing. Export anyway?');
  }
  return true;
}

function _triangleNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

function _vertexAt(allVerts, idx) {
  const i = idx * 3;
  return [allVerts[i], allVerts[i + 1], allVerts[i + 2]];
}

// ============================================================================
// 3MF Export (client-side with JSZip)
// ============================================================================

async function _export3MF() {
  if (!_validatePrintExportIntent()) return;

  // Dynamically load JSZip if not present
  if (!window.JSZip) {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    document.head.appendChild(script);
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load JSZip'));
    });
  }

  const zip = new window.JSZip();
  const _u = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  const { allVerts, allFaces } = _buildPrintableMeshData();

  const usedSlots = [...new Set(allFaces.map(f => f.colorSlot).filter(s => s >= 0))].sort((a, b) => a - b);
  const maxPaintSlot = Math.max(-1, ...usedSlots);
  if (maxPaintSlot > 14) {
    throw new Error('Bambu export supports up to 15 painted colors plus the default base color.');
  }

  // Bambu/Orca color painting stores one intact mesh and writes paint_color on
  // painted triangles. Splitting painted faces into separate meshes creates
  // open, non-manifold surface patches, so do not split by color here.
  const objectId = 1;
  const parentId = 2;
  const parentUuid = _u();
  const objectUuid = _u();
  const filamentColors = [
    '#C8C8C8',
    ..._filaments.slice(0, 15).map(f => _normalizeBambuColor(f.hex)),
  ];

  const vLines = [];
  for (let i = 0; i < allVerts.length; i += 3) {
    vLines.push(`     <vertex x="${allVerts[i].toFixed(6)}" y="${allVerts[i + 1].toFixed(6)}" z="${allVerts[i + 2].toFixed(6)}"/>`);
  }

  const tLines = allFaces.map((face) => {
    const paintSlot = face.colorSlot >= 0 ? face.colorSlot + 2 : 0; // slot 1 is base/default
    const paintAttr = paintSlot > 1 ? ` paint_color="${_bambuPaintCode(paintSlot)}"` : '';
    return `     <triangle v1="${face.v1}" v2="${face.v2}" v3="${face.v3}"${paintAttr}/>`;
  }).join('\n');

  const objectModelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
 xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
 xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
 requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">2</metadata>
 <resources>
  <object id="${objectId}" p:UUID="${objectUuid}" type="model">
   <mesh>
    <vertices>
${vLines.join('\n')}
    </vertices>
    <triangles>
${tLines}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build/>
</model>`;
  zip.file('3D/Objects/object_1.model', objectModelXml);

  // ---- 3D/3dmodel.model ----
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
  requiredextensions="p">
  <metadata name="BambuStudio:3mfVersion">2</metadata>
  <metadata name="Application">BambuStudio-01.10.02.83</metadata>
  <resources>
    <object id="${parentId}" type="model" p:UUID="${parentUuid}">
      <components>
        <component p:path="/3D/Objects/object_1.model" objectid="${objectId}" p:UUID="${_u()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
      </components>
    </object>
  </resources>
  <build p:UUID="${_u()}">
    <item objectid="${parentId}" p:UUID="${_u()}" transform="1 0 0 0 1 0 0 0 1 125 125 0" printable="1"/>
  </build>
</model>`;

  // ---- Metadata/model_settings.config ----
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${parentId}">
    <metadata key="name" value="${_escXml(_modelTitle || 'model')}"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="${allFaces.length}"/>
    <part id="${objectId}" subtype="normal_part">
      <metadata key="name" value="${_escXml(_modelTitle || 'model')}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${_escXml(_safeFileBase(_modelTitle || 'model'))}.glb"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat face_count="${allFaces.length}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="${parentId}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
  <assemble>
  </assemble>
</config>`;

  // Bambu/Orca store project settings as JSON, even though the file extension
  // is .config. These filament arrays are the authoritative slot colors.
  const projectSettings = JSON.stringify({
    filament_colour: filamentColors,
    filament_type: filamentColors.map(() => 'PLA'),
    filament_diameter: filamentColors.map(() => '1.75'),
    filament_density: filamentColors.map(() => '1.24'),
  }, null, 2);

  // ---- Standard 3MF boilerplate ----
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
  <Default Extension="config" ContentType="text/xml" />
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const modelRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  // ---- Pack ZIP ----
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('3D/_rels/3dmodel.model.rels', modelRels);
  zip.file('3D/3dmodel.model', modelXml);
  zip.file('Metadata/model_settings.config', modelSettings);
  zip.file('Metadata/project_settings.config', projectSettings);

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  _downloadBlob(blob, `${_safeFileBase(_modelTitle || 'model')}-multicolor.3mf`);
}

function _exportRepairSTL() {
  const { allVerts, allFaces } = _buildPrintableMeshData();
  const faceCount = allFaces.length;
  const buffer = new ArrayBuffer(84 + faceCount * 50);
  const view = new DataView(buffer);
  const header = `TimrX repair STL - ${_safeFileBase(_modelTitle || 'model')}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, faceCount, true);

  let offset = 84;
  for (const face of allFaces) {
    const a = _vertexAt(allVerts, face.v1);
    const b = _vertexAt(allVerts, face.v2);
    const c = _vertexAt(allVerts, face.v3);
    const n = _triangleNormal(a, b, c);
    for (const value of n) { view.setFloat32(offset, value, true); offset += 4; }
    for (const v of [a, b, c]) {
      view.setFloat32(offset, v[0], true); offset += 4;
      view.setFloat32(offset, v[1], true); offset += 4;
      view.setFloat32(offset, v[2], true); offset += 4;
    }
    view.setUint16(offset, 0, true); offset += 2;
  }

  const blob = new Blob([buffer], { type: 'model/stl' });
  _downloadBlob(blob, `${_safeFileBase(_modelTitle || 'model')}-repair.stl`);
}

async function _exportColoredGLB() {
  if (!_model) return;
  _applyColorsToMeshes();
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const T = window.THREE;
  const exportRoot = _buildMaterialColoredGLBRoot(T);
  const exporter = new GLTFExporter();
  const result = await new Promise((resolve, reject) => {
    exporter.parse(exportRoot, resolve, reject, {
      binary: true,
      onlyVisible: true,
      includeCustomExtensions: false,
    });
  });
  const blob = new Blob([result], { type: 'model/gltf-binary' });
  _downloadBlob(blob, `${_safeFileBase(_modelTitle || 'model')}-painted.glb`);
}

function _buildMaterialColoredGLBRoot(T) {
  const root = new T.Group();
  root.name = _safeFileBase(_modelTitle || 'painted_model');

  const materials = [
    new T.MeshStandardMaterial({ name: 'base_unpainted', color: 0xffffff, roughness: 0.65, metalness: 0 }),
    ..._filaments.map((f, i) => new T.MeshStandardMaterial({
      name: `filament_${i + 1}_${_normalizeBambuColor(f.hex).slice(1)}`,
      color: f.hex,
      roughness: 0.65,
      metalness: 0,
    })),
  ];

  for (let mi = 0; mi < _paintMeshes.length; mi++) {
    const source = _paintMeshes[mi];
    const posAttr = source.geometry.attributes.position;
    const normalAttr = source.geometry.attributes.normal;
    const uvAttr = source.geometry.attributes.uv;
    const faceCount = posAttr.count / 3;
    const faceOffset = _faceOffsets[mi];

    const positions = [];
    const normals = normalAttr ? [] : null;
    const uvs = uvAttr ? [] : null;
    const groups = new Map();

    for (let fi = 0; fi < faceCount; fi++) {
      const slot = _faceColors[faceOffset + fi];
      const materialIndex = slot >= 0 && slot < _filaments.length ? slot + 1 : 0;
      if (!groups.has(materialIndex)) groups.set(materialIndex, []);
      groups.get(materialIndex).push(fi);
    }

    const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    const geometry = new T.BufferGeometry();
    let vertexCursor = 0;

    for (const [materialIndex, faces] of sortedGroups) {
      const start = vertexCursor;
      for (const fi of faces) {
        for (let corner = 0; corner < 3; corner++) {
          const idx = fi * 3 + corner;
          positions.push(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));
          if (normalAttr) normals.push(normalAttr.getX(idx), normalAttr.getY(idx), normalAttr.getZ(idx));
          if (uvAttr) uvs.push(uvAttr.getX(idx), uvAttr.getY(idx));
          vertexCursor++;
        }
      }
      geometry.addGroup(start, vertexCursor - start, materialIndex);
    }

    geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    if (normals) geometry.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
    if (uvs) geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    geometry.computeBoundingSphere();

    const mesh = new T.Mesh(geometry, materials);
    mesh.name = source.name || `painted_mesh_${mi + 1}`;
    mesh.matrix.copy(source.matrixWorld);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    root.add(mesh);
  }

  return root;
}

function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _normalizeBambuColor(hex) {
  const raw = String(hex || '#C8C8C8').trim().replace(/^#/, '');
  const rgb = /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : 'C8C8C8';
  return `#${rgb}`;
}

function _bambuPaintCode(slotNumber) {
  // Bambu/Orca encode painted filament slots as string codes, not raw slot
  // numbers. slotNumber is 1-based; slot 1 is the unpainted base filament.
  const codes = {
    1: '',
    2: '8',
    3: '0C',
    4: '1C',
    5: '2C',
    6: '3C',
    7: '4C',
    8: '5C',
    9: '8C',
    10: '9C',
    11: 'AC',
    12: 'BC',
    13: 'CC',
    14: 'DC',
    15: 'EC',
    16: 'FC',
  };
  return codes[slotNumber] || '';
}

function _safeFileBase(name) {
  return String(name || 'model').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'model';
}

// ============================================================================
// Sidebar UI
// ============================================================================

function _printCheckSummaryHtml() {
  if (_manualPrintCheck.loading) {
    return `<div class="mcp-check-card"><div class="mcp-check-text">Running print analysis...</div></div>`;
  }
  if (_manualPrintCheck.error) {
    return `<div class="mcp-check-card"><div class="mcp-check-text" style="color:#ef4444;">${_escXml(_manualPrintCheck.error)}</div></div>`;
  }
  const data = _manualPrintCheck.result;
  if (!data) {
    return `<div class="mcp-check-card"><div class="mcp-check-text">Run this before painting or exporting. It checks watertightness, face count, invalid faces, dimensions, and print-risk signals.</div></div>`;
  }
  const score = Number(data.score || 0);
  const scoreClass = score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad';
  const c = data.checks || {};
  const dims = Array.isArray(c.bounding_box_mm) ? c.bounding_box_mm.map(v => Number(v).toFixed(1)).join(' x ') + ' mm' : 'Unknown';
  const verdict = score >= 80 ? 'Good for paint/export' : score >= 60 ? 'Usable, repair recommended' : 'Repair before painting';
  return `
    <div class="mcp-check-card">
      <div class="mcp-check-head">
        <div>
          <div class="mcp-label" style="margin:0 0 3px;">Result</div>
          <div class="mcp-check-text">${verdict}</div>
        </div>
        <div class="mcp-score ${scoreClass}">${score}</div>
      </div>
      <div class="mcp-check-list">
        <div class="mcp-check-row"><span>Watertight</span><strong>${c.is_manifold === true ? 'Yes' : c.is_manifold === false ? 'No' : 'Unknown'}</strong></div>
        <div class="mcp-check-row"><span>Faces</span><strong>${c.face_count ? Number(c.face_count).toLocaleString() : 'Unknown'}</strong></div>
        <div class="mcp-check-row"><span>Degenerate</span><strong>${c.degenerate_face_count ? Number(c.degenerate_face_count).toLocaleString() : '0'}</strong></div>
        <div class="mcp-check-row"><span>Size</span><strong>${dims}</strong></div>
      </div>
      ${data.issues?.length ? `<div class="mcp-check-text" style="color:#f59e0b;">${_escXml(data.issues[0])}</div>` : ''}
    </div>`;
}

async function _runManualPrintCheck() {
  if (!_taskId || _manualPrintCheck.loading) return;
  _manualPrintCheck = { loading: true, result: null, error: '' };
  _renderSidebar();
  try {
    const res = await apiFetch(`/api/_mod/print-check/${encodeURIComponent(_taskId)}`, {
      method: 'POST',
      body: { printer_type: 'fdm', model_url: _modelUrl || undefined },
      timeout: 45000,
    });
    if (!res.ok) throw new Error(res.error || `Print check failed (${res.status})`);
    _manualPrintCheck = { loading: false, result: res.data, error: '' };
    const height = res.data?.checks?.bounding_box_mm?.[2];
    if (!_exportTargetHeightMm && Number.isFinite(Number(height)) && Number(height) > 0) {
      _exportTargetHeightMm = String(Math.round(Number(height) * 10) / 10);
    }
  } catch (err) {
    _manualPrintCheck = { loading: false, result: null, error: err?.message || 'Print check failed.' };
  }
  _renderSidebar();
}

async function _startPrintRepair() {
  if (typeof _manualRepairHandler !== 'function') {
    alert('Repair is available from history items after the page finishes loading.');
    return;
  }
  const targetHeight = Number.parseFloat(_exportTargetHeightMm);
  await _manualRepairHandler({
    print_height_mm: Number.isFinite(targetHeight) && targetHeight > 0 ? targetHeight : null,
    target_polycount: 120000,
    target_formats: ['glb', 'stl', '3mf'],
    origin_at: 'bottom',
  });
  if (window.showToast) {
    window.showToast('Print repair started. When the remesh finishes, open Manual Paint on the repaired history item.', 'info');
  }
  closeMultiColorModal();
}

function _renderSidebar() {
  const sb = document.getElementById('mcp-sidebar');
  if (!sb) return;

  const filamentRows = _filaments.map((f, i) => `
    <div class="mcp-filament ${i === _activeSlot ? 'active' : ''}" data-slot="${i}">
      <div class="mcp-filament-swatch" style="background:${f.hex}"></div>
      <div class="mcp-filament-info">
        <div class="mcp-filament-name">${f.name}</div>
        <div class="mcp-filament-hex">${f.hex}</div>
      </div>
      ${_filaments.length > 1 ? `<div class="mcp-filament-rm" data-rm="${i}" title="Remove">&times;</div>` : ''}
    </div>
  `).join('');

  const paintedCount = _faceColors ? Array.from(_faceColors).filter(c => c >= 0).length : 0;
  const pct = _totalFaces > 0 ? Math.round((paintedCount / _totalFaces) * 100) : 0;

  sb.innerHTML = `
    <div class="mcp-header">
      <h2>Paint Model</h2>
      <div class="mcp-close" id="mcp-close-btn">&times;</div>
    </div>

    <div class="mcp-section">
      <div class="mcp-label">Brush Mode</div>
      <div class="mcp-brush-row">
        <button class="mcp-brush-btn ${_brushMode === 'brush' ? 'active' : ''}" data-brush="brush">Brush</button>
        <button class="mcp-brush-btn ${_brushMode === 'region' ? 'active' : ''}" data-brush="region">Region</button>
        <button class="mcp-brush-btn ${_brushMode === 'face' ? 'active' : ''}" data-brush="face">Face</button>
        <button class="mcp-brush-btn ${_brushMode === 'eraser' ? 'active' : ''}" data-brush="eraser" style="${_brushMode === 'eraser' ? 'border-color:rgba(239,68,68,.4);color:#ef4444;background:rgba(239,68,68,.08);' : ''}">Eraser</button>
      </div>
      ${_brushMode === 'brush' || _brushMode === 'eraser' ? `
      <div style="margin-top:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <span style="font-size:9px;color:rgba(255,255,255,.4);">Brush Size</span>
          <span style="font-size:9px;color:rgba(14,165,233,.8);font-weight:600;" id="mcp-brush-val">${_formatBrushRadius(_brushRadius)}</span>
        </div>
        <input type="range" min="1" max="100" value="${_brushSliderValue()}"
          style="-webkit-appearance:none;width:100%;height:3px;border-radius:2px;background:rgba(255,255,255,.1);outline:none;cursor:pointer;"
          id="mcp-brush-size" />
        <div style="display:flex;justify-content:space-between;font-size:8px;color:rgba(255,255,255,.2);margin-top:2px;">
          <span>Fine</span><span>Wide</span>
        </div>
      </div>` : ''}
    </div>

    <div class="mcp-section">
      <div class="mcp-label">Filament Colors (${_filaments.length})</div>
      <div class="mcp-filaments" id="mcp-filament-list">
        ${filamentRows}
      </div>
      <div class="mcp-add-row" style="margin-top:6px;">
        <button class="mcp-add-btn" id="mcp-add-filament">+ Add Filament</button>
      </div>
    </div>

    <div class="mcp-section mcp-palette" id="mcp-palette-section" style="display:none;">
      <div class="mcp-label">Pick Color</div>
      <div class="mcp-label" style="margin-top:4px;">PLA Basic</div>
      <div class="mcp-palette-grid">
        ${PLA_BASIC.map(c => `<div class="mcp-palette-sw" style="background:${c.hex}" data-hex="${c.hex}" data-name="${c.name}" title="${c.name}"></div>`).join('')}
      </div>
      <div class="mcp-label" style="margin-top:6px;">PLA Matte</div>
      <div class="mcp-palette-grid">
        ${PLA_MATTE.map(c => `<div class="mcp-palette-sw" style="background:${c.hex}" data-hex="${c.hex}" data-name="${c.name}" title="${c.name}"></div>`).join('')}
      </div>
    </div>

    <div class="mcp-stats" id="mcp-stats">${pct}% painted (${paintedCount}/${_totalFaces} faces)</div>

    <div class="mcp-section">
      <div class="mcp-label">Print Preflight</div>
      ${_printCheckSummaryHtml()}
      <div class="mcp-brush-row" style="margin-top:6px;">
        <button class="mcp-brush-btn" id="mcp-print-check-btn" ${_manualPrintCheck.loading ? 'disabled' : ''}>${_manualPrintCheck.loading ? 'Checking...' : 'Run Print Check'}</button>
        <button class="mcp-brush-btn" id="mcp-repair-btn">Repair / Remesh</button>
      </div>
    </div>

    <div class="mcp-section">
      <div class="mcp-label">Export Cleanup</div>
      <div class="mcp-input-grid">
        <label class="mcp-field">
          <span>Target height mm</span>
          <input id="mcp-export-height" type="number" min="1" step="0.1" placeholder="Keep size" value="${_escXml(_exportTargetHeightMm)}">
        </label>
        <label class="mcp-field">
          <span>Weld tolerance mm</span>
          <input id="mcp-weld-tolerance" type="number" min="0.00001" max="0.05" step="0.0001" value="${_exportWeldToleranceMm}">
        </label>
      </div>
      <label class="mcp-check-toggle" style="margin-top:7px;">
        <input id="mcp-center-plate" type="checkbox" ${_exportCenterOnPlate ? 'checked' : ''}>
        <span>Center model and place bottom on build plate</span>
      </label>
      <div class="mcp-check-text" style="margin-top:5px;">3MF export welds duplicate vertices and removes zero-area triangles. STL conversion should be used only for geometry repair because STL cannot keep colors.</div>
    </div>

    <div class="mcp-info">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <span>Brush: click &amp; drag to paint. Region: click to flood-fill. Face: single triangle. Eraser: remove paint. Hold drag for continuous painting.</span>
    </div>

    <div class="mcp-actions">
      <button class="mcp-btn mcp-btn-primary" id="mcp-export-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download 3MF
      </button>
      <button class="mcp-btn mcp-btn-secondary" id="mcp-export-glb-btn">
        Download Colored GLB
      </button>
      <button class="mcp-btn mcp-btn-secondary" id="mcp-export-stl-btn">
        Download Repair STL
      </button>
      <button class="mcp-btn mcp-btn-danger" id="mcp-clear-btn">Clear All Paint</button>
      <button class="mcp-btn mcp-btn-secondary" id="mcp-cancel-btn">Close</button>
    </div>
  `;

  // Event listeners
  sb.querySelector('#mcp-close-btn')?.addEventListener('click', closeMultiColorModal);
  sb.querySelector('#mcp-cancel-btn')?.addEventListener('click', closeMultiColorModal);
  sb.querySelector('#mcp-export-btn')?.addEventListener('click', _export3MF);
  sb.querySelector('#mcp-export-glb-btn')?.addEventListener('click', _exportColoredGLB);
  sb.querySelector('#mcp-export-stl-btn')?.addEventListener('click', _exportRepairSTL);
  sb.querySelector('#mcp-clear-btn')?.addEventListener('click', () => { _clearAllPaint(); _renderSidebar(); });
  sb.querySelector('#mcp-print-check-btn')?.addEventListener('click', _runManualPrintCheck);
  sb.querySelector('#mcp-repair-btn')?.addEventListener('click', _startPrintRepair);

  sb.querySelector('#mcp-export-height')?.addEventListener('input', (e) => {
    _exportTargetHeightMm = e.target.value;
  });
  sb.querySelector('#mcp-weld-tolerance')?.addEventListener('input', (e) => {
    const v = Number.parseFloat(e.target.value);
    if (Number.isFinite(v)) _exportWeldToleranceMm = Math.min(0.05, Math.max(0.00001, v));
  });
  sb.querySelector('#mcp-center-plate')?.addEventListener('change', (e) => {
    _exportCenterOnPlate = !!e.target.checked;
  });

  // Filament selection
  sb.querySelectorAll('.mcp-filament').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.mcp-filament-rm')) return;
      _activeSlot = parseInt(el.dataset.slot);
      _renderSidebar();
    });
  });

  // Remove filament
  sb.querySelectorAll('.mcp-filament-rm').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.rm);
      _filaments.splice(idx, 1);
      if (_activeSlot >= _filaments.length) _activeSlot = _filaments.length - 1;
      // Remap face colors
      for (let i = 0; i < _totalFaces; i++) {
        if (_faceColors[i] === idx) _faceColors[i] = -1;
        else if (_faceColors[i] > idx) _faceColors[i]--;
      }
      _applyColorsToMeshes();
      _renderSidebar();
    });
  });

  // Add filament — show palette
  let _paletteMode = 'add'; // 'add' or index for replace
  sb.querySelector('#mcp-add-filament')?.addEventListener('click', () => {
    _paletteMode = 'add';
    const palSec = sb.querySelector('#mcp-palette-section');
    if (palSec) palSec.style.display = palSec.style.display === 'none' ? 'flex' : 'none';
  });

  // Palette swatch click
  sb.querySelectorAll('.mcp-palette-sw').forEach(el => {
    el.addEventListener('click', () => {
      const hex = el.dataset.hex;
      const name = el.dataset.name;
      _filaments.push({ hex, name });
      _activeSlot = _filaments.length - 1;
      _renderSidebar();
    });
  });

  // Brush mode
  sb.querySelectorAll('.mcp-brush-btn').forEach(el => {
    el.addEventListener('click', () => {
      _brushMode = el.dataset.brush;
      _renderSidebar();
    });
  });

  // Brush size slider
  const brushSlider = sb.querySelector('#mcp-brush-size');
  if (brushSlider) {
    brushSlider.addEventListener('input', (e) => {
      _brushRadius = _brushRadiusFromSlider(e.target.value);
      const valEl = sb.querySelector('#mcp-brush-val');
      if (valEl) valEl.textContent = _formatBrushRadius(_brushRadius);
    });
  }
}

function _updateStats() {
  const el = document.getElementById('mcp-stats');
  if (!el) return;
  const paintedCount = _faceColors ? Array.from(_faceColors).filter(c => c >= 0).length : 0;
  const pct = _totalFaces > 0 ? Math.round((paintedCount / _totalFaces) * 100) : 0;
  el.textContent = `${pct}% painted (${paintedCount}/${_totalFaces} faces)`;
}

// ============================================================================
// Cleanup
// ============================================================================

function _dispose() {
  const container = document.getElementById('mcp-viewer');
  if (container) {
    if (container._resizeHandler) window.removeEventListener('resize', container._resizeHandler);
    if (container._animId) cancelAnimationFrame(container._animId);
  }
  if (_renderer?.domElement) {
    _renderer.domElement.removeEventListener('pointerdown', _onPointerDown);
    _renderer.domElement.removeEventListener('pointermove', _onPointerMove);
    _renderer.domElement.removeEventListener('pointerup', _onPointerUp);
    _renderer.domElement.removeEventListener('pointerleave', _onPointerUp);
  }
  _isPainting = false;
  if (_controls) { _controls.dispose(); _controls = null; }
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  if (_scene) { _scene.clear(); _scene = null; }
  _model = null; _camera = null; _raycaster = null;
  _paintMeshes = []; _faceColors = null; _faceOffsets = null; _faceCenters = null; _meshTopology = []; _totalFaces = 0;
  _modelMaxDim = 1;
  _modelUrl = '';
  _manualRepairHandler = null;
}

// ============================================================================
// Public API
// ============================================================================

export function openMultiColorModal({ taskId, title, thumbnailUrl, glbUrl, sourceObject, onRepair } = {}) {
  _taskId = taskId;
  _modelUrl = glbUrl || '';
  _modelTitle = (title || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40) || 'model';
  _filaments = DEFAULT_FILAMENTS.map(f => ({ ...f }));
  _activeSlot = 0;
  _brushMode = 'region';
  _brushRadius = 0.05;
  _modelMaxDim = 1;
  _paintEnabled = true;
  _manualRepairHandler = typeof onRepair === 'function' ? onRepair : null;
  _manualPrintCheck = { loading: false, result: null, error: '' };
  _exportTargetHeightMm = '';
  _exportWeldToleranceMm = 0.001;
  _exportCenterOnPlate = true;

  const overlay = _createModal();
  _setupViewer(glbUrl, sourceObject || null);
  _renderSidebar();

  // Close on overlay click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMultiColorModal(); });
  const onEsc = (e) => { if (e.key === 'Escape') closeMultiColorModal(); };
  document.addEventListener('keydown', onEsc);
  overlay._escHandler = onEsc;

  window.multiColorPrint = { closeMultiColorModal };
}

function _setAutoStatus(message, pct = null) {
  const status = document.getElementById('meshy-mcp-status');
  if (status) status.textContent = message;
  const wrap = document.getElementById('meshy-mcp-progress-wrap');
  const bar = document.getElementById('meshy-mcp-progress');
  if (pct == null) {
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (wrap) wrap.style.display = 'block';
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

function _downloadAuto3mf(url, title) {
  if (!url) return;
  const safeTitle = (title || 'model').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40) || 'model';
  const params = new URLSearchParams({ u: url, download: '1', filename: `${safeTitle}-meshy-auto.3mf` });
  const a = document.createElement('a');
  a.href = `${BACKEND}/api/_mod/proxy-glb?${params.toString()}`;
  a.download = `${safeTitle}-meshy-auto.3mf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function _refreshAfterAutoMcp() {
  try {
    if (window.WorkspaceCredits?.syncWithBackend) window.WorkspaceCredits.syncWithBackend();
    if (window.loadHistoryFromDB) await window.loadHistoryFromDB();
    if (window.renderHistory) window.renderHistory();
  } catch (err) {
    console.warn('[Meshy MCP] Refresh after completion failed:', err);
  }
}

function _pollMeshyAutoJob(jobId, title) {
  if (_autoPollTimer) clearTimeout(_autoPollTimer);
  const poll = async () => {
    try {
      const res = await apiFetch(`/api/_mod/print/multi-color/${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error(res.error || 'Status check failed');
      const st = res.data || {};
      const pct = typeof st.pct === 'number' ? st.pct : (st.status === 'done' ? 100 : 15);
      _setAutoStatus(st.message || (st.status === 'done' ? '3MF ready.' : 'Meshy is preparing the 3MF...'), pct);

      if (st.status === 'done') {
        State.removeActiveJob(jobId);
        const threeMfUrl = st.three_mf_url || st.model_urls?.['3mf'];
        const dl = document.getElementById('meshy-mcp-download');
        if (dl && threeMfUrl) {
          dl.style.display = 'flex';
          dl.onclick = () => _downloadAuto3mf(threeMfUrl, title);
        }
        await _refreshAfterAutoMcp();
        if (window.showToast) window.showToast('Meshy 3MF is ready.', 'success');
        _autoPollTimer = null;
        return;
      }

      if (st.status === 'failed') {
        State.removeActiveJob(jobId);
        _setAutoStatus(st.message || st.error || 'Meshy 3MF failed.', 100);
        if (window.showToast) window.showToast(st.message || 'Meshy 3MF failed.', 'error');
        _autoPollTimer = null;
        return;
      }

      _autoPollTimer = setTimeout(poll, 4000);
    } catch (err) {
      _setAutoStatus(err?.message || 'Status check failed.', null);
      _autoPollTimer = setTimeout(poll, 8000);
    }
  };
  poll();
}

export function openMeshyMultiColorModal({ taskId, title, thumbnailUrl, glbUrl }) {
  _autoJobId = null;
  const overlay = _createAutoModal();
  const colors = overlay.querySelector('#meshy-mcp-colors');
  const depth = overlay.querySelector('#meshy-mcp-depth');
  const colorsLabel = overlay.querySelector('#meshy-mcp-colors-label');
  const depthLabel = overlay.querySelector('#meshy-mcp-depth-label');
  const start = overlay.querySelector('#meshy-mcp-start');

  const syncLabels = () => {
    if (colorsLabel) colorsLabel.textContent = `${colors?.value || 4} colors`;
    if (depthLabel) depthLabel.textContent = `Level ${depth?.value || 4}`;
  };
  colors?.addEventListener('input', syncLabels);
  depth?.addEventListener('input', syncLabels);
  syncLabels();

  start?.addEventListener('click', async () => {
    start.disabled = true;
    _setAutoStatus('Submitting to Meshy...', 2);
    try {
      const payload = {
        input_task_id: taskId || '',
        model_url: glbUrl || '',
        prompt: title || '',
        max_colors: parseInt(colors?.value || '4', 10),
        max_depth: parseInt(depth?.value || '4', 10),
      };
      const res = await apiFetch('/api/_mod/print/multi-color', { method: 'POST', body: payload });
      if (!res.ok) throw new Error(res.error || res.data?.message || 'Could not start Meshy 3MF');
      _autoJobId = res.data?.job_id;
      if (!_autoJobId) throw new Error('Meshy did not return a job ID');
      const jobMeta = {
        stage: 'multi_color_print',
        resume_strategy: 'meshy_multi_color_print',
        type: 'model',
        prompt: title || '',
        root_prompt: title || '',
        title: title || 'Meshy Auto 3MF',
        source_task_id: taskId || '',
        source_model_url: glbUrl || '',
        glb_url: glbUrl || '',
        thumbnail_url: thumbnailUrl || '',
        max_colors: payload.max_colors,
        max_depth: payload.max_depth,
      };
      State.addActiveJob(_autoJobId);
      State.savePendingMeta(_autoJobId, jobMeta);
      if (!State.historyHasJobId(_autoJobId)) {
        State.addHistoryItem({
          id: _autoJobId,
          ...jobMeta,
          status: 'generating',
          status_label: 'Preparing Meshy 3MF...',
          progress_pct: 5,
          created_at: Date.now(),
        });
        window.renderHistory?.();
      }
      _setAutoStatus('Meshy job started...', 5);
      if (window.showToast) window.showToast('Meshy 3MF job started.', 'info');
      _pollMeshyAutoJob(_autoJobId, title);
    } catch (err) {
      start.disabled = false;
      _setAutoStatus(err?.message || 'Could not start Meshy 3MF.', null);
      if (window.showToast) window.showToast(err?.message || 'Could not start Meshy 3MF.', 'error');
    }
  });

  overlay.querySelector('#meshy-mcp-close')?.addEventListener('click', closeMeshyMultiColorModal);
  overlay.querySelector('#meshy-mcp-cancel')?.addEventListener('click', closeMeshyMultiColorModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMeshyMultiColorModal(); });
  const onEsc = (e) => { if (e.key === 'Escape') closeMeshyMultiColorModal(); };
  document.addEventListener('keydown', onEsc);
  overlay._escHandler = onEsc;
}

export function closeMeshyMultiColorModal() {
  if (_autoPollTimer) {
    clearTimeout(_autoPollTimer);
    _autoPollTimer = null;
  }
  if (_autoJobId && State.getActiveJobs().includes(_autoJobId) && !State.watchers.has(_autoJobId)) {
    window.watchMultiColorPrintJob?.(_autoJobId, { isRecovery: true });
  }
  const modal = document.getElementById('meshy-mcp-modal');
  if (modal) {
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal.remove();
  }
}

export function closeMultiColorModal() {
  _dispose();
  const modal = document.getElementById('multi-color-modal');
  if (modal) {
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal.remove();
  }
}
