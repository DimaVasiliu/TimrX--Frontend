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
let _paintEnabled = true;
let _isPainting = false;    // true while mouse held in brush/face/eraser mode

let _raycaster = null;
let _mouse = new (window.THREE?.Vector2 || function(){})();

// Precomputed face centers for brush radius check (per mesh)
let _faceCenters = null; // Float32Array [x,y,z, x,y,z, ...] in world space

let _taskId = null;
let _modelTitle = '';

// ============================================================================
// Modal DOM
// ============================================================================

function _injectStyles() {
  if (document.getElementById('mcp-styles')) return;
  const s = document.createElement('style');
  s.id = 'mcp-styles';
  s.textContent = `
    #multi-color-modal {
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

// ============================================================================
// 3D Viewer
// ============================================================================

function _setupViewer(glbUrl) {
  const container = document.getElementById('mcp-viewer');
  if (!container) return;

  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.3);font-size:12px;">Loading model...</div>';
  if (!glbUrl) { container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.2);font-size:11px;">No model URL</div>'; return; }

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
  const dl = new T.DirectionalLight(0xffffff, 0.8);
  dl.position.set(5, 10, 7);
  _scene.add(dl);

  _controls = new T.OrbitControls(_camera, _renderer.domElement);
  _controls.enableDamping = true;
  _controls.dampingFactor = 0.08;

  _raycaster = new T.Raycaster();

  // Load model
  const loader = new T.GLTFLoader();
  const loadUrl = getLoadableModelUrl(glbUrl);
  if (!isTimrxS3Url(loadUrl)) { loader.setCrossOrigin('use-credentials'); loader.setWithCredentials(true); }
  else { loader.setCrossOrigin('anonymous'); }

  loader.load(loadUrl, (gltf) => {
    _model = gltf.scene;
    _scene.add(_model);

    // Fit camera
    const box = new T.Box3().setFromObject(_model);
    const center = box.getCenter(new T.Vector3());
    const size = box.getSize(new T.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    _camera.position.copy(center);
    _camera.position.z += maxDim * 1.8;
    _controls.target.copy(center);
    _controls.update();

    // Prepare paint data
    _preparePaintData();
    _renderSidebar();

    // Add click hint
    const hint = document.createElement('div');
    hint.className = 'mcp-viewer-hint';
    hint.textContent = 'Click on the model to paint regions';
    container.appendChild(hint);
    setTimeout(() => hint.style.opacity = '0', 4000);
  }, undefined, (err) => {
    console.error('[MCP] Model load error:', err);
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.3);font-size:11px;">Failed to load model</div>';
  });

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
  _model.traverse((child) => {
    if (child.isMesh && child.geometry) {
      // Ensure non-indexed geometry for per-face vertex colors
      let geo = child.geometry;
      if (geo.index) {
        geo = geo.toNonIndexed();
        child.geometry = geo;
      }
      // Add vertex color attribute (default white)
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      colors.fill(1.0); // white
      geo.setAttribute('color', new T.BufferAttribute(colors, 3));

      // Enable vertex colors on material
      if (Array.isArray(child.material)) {
        child.material = child.material[0]?.clone() || new T.MeshStandardMaterial();
      } else {
        child.material = child.material.clone();
      }
      child.material.vertexColors = true;
      child.material.needsUpdate = true;

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
  const T = window.THREE;

  // Compute face normals
  const normals = [];
  const vA = new T.Vector3(), vB = new T.Vector3(), vC = new T.Vector3();
  const edge1 = new T.Vector3(), edge2 = new T.Vector3(), normal = new T.Vector3();

  for (let i = 0; i < faceCount; i++) {
    const i3 = i * 3;
    vA.fromBufferAttribute(posAttr, i3);
    vB.fromBufferAttribute(posAttr, i3 + 1);
    vC.fromBufferAttribute(posAttr, i3 + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    normal.crossVectors(edge1, edge2).normalize();
    normals.push(normal.clone());
  }

  // Build adjacency by shared vertices (using a spatial hash)
  const vertKey = (x, y, z) => `${(x * 1000)|0},${(y * 1000)|0},${(z * 1000)|0}`;
  const vertToFaces = new Map();

  for (let i = 0; i < faceCount; i++) {
    for (let v = 0; v < 3; v++) {
      const idx = i * 3 + v;
      const key = vertKey(
        posAttr.getX(idx),
        posAttr.getY(idx),
        posAttr.getZ(idx)
      );
      if (!vertToFaces.has(key)) vertToFaces.set(key, []);
      vertToFaces.get(key).push(i);
    }
  }

  // Flood fill from start face
  const localStart = startGlobal - offset;
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
      if (slotIdx >= 0 && slotIdx < _filaments.length) {
        tmpColor.set(_filaments[slotIdx].hex);
      } else {
        tmpColor.set(0xffffff);
      }
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
// 3MF Export (client-side with JSZip)
// ============================================================================

async function _export3MF() {
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
  const T = window.THREE;
  const _u = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });

  // ---- Collect all vertices + face data in world space ----
  // No scale — export raw coordinates. User scales in slicer.
  const allVerts = [];   // flat [x,y,z, ...]
  const allFaces = [];   // {v1,v2,v3, colorSlot}
  let vOff = 0;

  for (let mi = 0; mi < _paintMeshes.length; mi++) {
    const mesh = _paintMeshes[mi];
    const posAttr = mesh.geometry.attributes.position;
    const faceCount = posAttr.count / 3;
    const offset = _faceOffsets[mi];
    mesh.updateWorldMatrix(true, false);
    const mat = mesh.matrixWorld;
    const v = new T.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
      allVerts.push(v.x, v.y, v.z);
    }
    for (let fi = 0; fi < faceCount; fi++) {
      allFaces.push({
        v1: vOff + fi * 3,
        v2: vOff + fi * 3 + 1,
        v3: vOff + fi * 3 + 2,
        colorSlot: _faceColors[offset + fi]
      });
    }
    vOff += posAttr.count;
  }

  // ---- Group faces by color slot → separate volume per color ----
  const groups = new Map();
  for (let i = 0; i < allFaces.length; i++) {
    const s = allFaces[i].colorSlot;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(i);
  }
  const sortedSlots = [...groups.keys()].sort((a, b) => a - b); // -1 first

  // ---- Build sub-object per color group ----
  const objectXmls = [];
  const componentRefs = [];
  const partSettings = [];    // for model_settings.config
  const filamentEntries = []; // for slice_info.config
  let objId = 1;
  let extruderNum = 1;

  for (const slot of sortedSlots) {
    const faceIdxs = groups.get(slot);
    const color = slot >= 0 ? (_filaments[slot] || { hex: '#FFFFFF', name: 'Color' }) : { hex: '#C8C8C8', name: 'Default' };

    // Remap vertices: only include vertices used by this group
    const vertMap = new Map();
    let newIdx = 0;
    const localVerts = [];
    const localTris = [];

    for (const fi of faceIdxs) {
      const face = allFaces[fi];
      const ids = [face.v1, face.v2, face.v3];
      const mapped = [];
      for (const vid of ids) {
        if (!vertMap.has(vid)) {
          vertMap.set(vid, newIdx);
          const i3 = vid * 3;
          localVerts.push(allVerts[i3], allVerts[i3 + 1], allVerts[i3 + 2]);
          newIdx++;
        }
        mapped.push(vertMap.get(vid));
      }
      localTris.push(mapped);
    }

    const vLines = [];
    for (let i = 0; i < localVerts.length; i += 3) {
      vLines.push(`          <vertex x="${localVerts[i].toFixed(6)}" y="${localVerts[i+1].toFixed(6)}" z="${localVerts[i+2].toFixed(6)}" />`);
    }
    const tLines = localTris.map(t =>
      `          <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}" />`
    ).join('\n');

    const uuid = _u();
    objectXmls.push(`    <object id="${objId}" type="model" p:UUID="${uuid}">
      <mesh>
        <vertices>
${vLines.join('\n')}
        </vertices>
        <triangles>
${tLines}
        </triangles>
      </mesh>
    </object>`);

    componentRefs.push(`        <component objectid="${objId}" p:UUID="${_u()}" transform="1 0 0 0 1 0 0 0 1 0 0 0" />`);

    // model_settings.config: map this part to an extruder
    partSettings.push(`    <part id="${objId}" subtype="normal_part">
      <metadata key="name" value="${_escXml(color.name)}"/>
      <metadata key="extruder" value="${extruderNum}"/>
    </part>`);

    // slice_info.config: filament color
    const hexNoHash = color.hex.replace('#', '');
    filamentEntries.push(`    <filament id="${extruderNum}" type="PLA" color="${hexNoHash}FF" used="1"/>`);

    objId++;
    extruderNum++;
  }

  // ---- Parent object with components ----
  const parentId = objId;
  const parentUuid = _u();

  objectXmls.push(`    <object id="${parentId}" type="model" p:UUID="${parentUuid}">
      <components>
${componentRefs.join('\n')}
      </components>
    </object>`);

  // ---- 3D/3dmodel.model ----
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <metadata name="Application">BambuStudio-01.10.02.83</metadata>
  <resources>
${objectXmls.join('\n')}
  </resources>
  <build p:UUID="${_u()}">
    <item objectid="${parentId}" p:UUID="${_u()}" printable="1" />
  </build>
</model>`;

  // ---- Metadata/model_settings.config ----
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${parentId}">
    <metadata key="name" value="${_escXml(_modelTitle || 'model')}"/>
    <metadata key="extruder" value="1"/>
${partSettings.join('\n')}
  </object>
</config>`;

  // ---- Metadata/slice_info.config ----
  const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="locked" value="false"/>
    <instance object_id="${parentId}" instance_id="0" identify_id="0"/>
${filamentEntries.join('\n')}
  </plate>
</config>`;

  // ---- Metadata/project_settings.config (minimal, needed for Bambu recognition) ----
  const projectSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
</config>`;

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

  // ---- Pack ZIP ----
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('3D/3dmodel.model', modelXml);
  zip.file('Metadata/model_settings.config', modelSettings);
  zip.file('Metadata/slice_info.config', sliceInfo);
  zip.file('Metadata/project_settings.config', projectSettings);

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${_modelTitle || 'model'}-multicolor.3mf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================================
// Sidebar UI
// ============================================================================

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
          <span style="font-size:9px;color:rgba(14,165,233,.8);font-weight:600;" id="mcp-brush-val">${_brushRadius.toFixed(2)}</span>
        </div>
        <input type="range" min="1" max="100" value="${Math.round(_brushRadius * 200)}"
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
      <button class="mcp-btn mcp-btn-danger" id="mcp-clear-btn">Clear All Paint</button>
      <button class="mcp-btn mcp-btn-secondary" id="mcp-cancel-btn">Close</button>
    </div>
  `;

  // Event listeners
  sb.querySelector('#mcp-close-btn')?.addEventListener('click', closeMultiColorModal);
  sb.querySelector('#mcp-cancel-btn')?.addEventListener('click', closeMultiColorModal);
  sb.querySelector('#mcp-export-btn')?.addEventListener('click', _export3MF);
  sb.querySelector('#mcp-clear-btn')?.addEventListener('click', () => { _clearAllPaint(); _renderSidebar(); });

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
      _brushRadius = parseInt(e.target.value) / 200; // 0.005 - 0.5
      const valEl = sb.querySelector('#mcp-brush-val');
      if (valEl) valEl.textContent = _brushRadius.toFixed(2);
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
  _paintMeshes = []; _faceColors = null; _faceOffsets = null; _faceCenters = null; _totalFaces = 0;
}

// ============================================================================
// Public API
// ============================================================================

export function openMultiColorModal({ taskId, title, thumbnailUrl, glbUrl }) {
  _taskId = taskId;
  _modelTitle = (title || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40) || 'model';
  _filaments = DEFAULT_FILAMENTS.map(f => ({ ...f }));
  _activeSlot = 0;
  _brushMode = 'region';
  _paintEnabled = true;

  const overlay = _createModal();
  _setupViewer(glbUrl);
  _renderSidebar();

  // Close on overlay click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMultiColorModal(); });
  const onEsc = (e) => { if (e.key === 'Escape') closeMultiColorModal(); };
  document.addEventListener('keydown', onEsc);
  overlay._escHandler = onEsc;

  window.multiColorPrint = { closeMultiColorModal };
}

export function closeMultiColorModal() {
  _dispose();
  const modal = document.getElementById('multi-color-modal');
  if (modal) {
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal.remove();
  }
}
