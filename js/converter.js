/**
 * converter.js
 * Self-contained logic for the file converter tool (drag-and-drop 3D format converter).
 * Supports: GLB, GLTF, OBJ, STL, 3MF, FBX import and GLB, GLTF, OBJ, STL, 3MF, USDZ export.
 */

// ============================================================================
// MODULE STATE
// ============================================================================
let converterScene = null;
let converterCamera = null;
let converterRenderer = null;
let converterControls = null;
let converterModel = null;
let converterAnimationId = null;
let originalFile = null;

// ============================================================================
// HELPERS
// ============================================================================
const getEl = (id) => document.getElementById(id);

function notifyConverter(message, type = 'error') {
  if (window.showToast) {
    window.showToast(message, type);
    return;
  }
  if (document.body) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.setAttribute('role', 'status');
    toast.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:99999',
      `background:${type === 'success' ? '#14351f' : '#2b1414'}`,
      'color:#fff',
      'padding:12px 16px',
      'border:1px solid rgba(255,255,255,.14)',
      'border-radius:8px',
      'box-shadow:0 10px 24px rgba(0,0,0,.35)',
      'font-size:14px',
      'max-width:min(360px, calc(100vw - 40px))'
    ].join(';');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  } else {
    console.error(message);
  }
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function compactFileName(name, maxLength = 40) {
  if (!name || name.length <= maxLength) return name;

  const extensionIndex = name.lastIndexOf('.');
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : '';
  const baseName = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const reserved = extension.length + 1;
  const budget = Math.max(10, maxLength - reserved);
  const head = Math.ceil(budget * 0.58);
  const tail = Math.max(4, budget - head);

  return `${baseName.slice(0, head)}…${baseName.slice(-tail)}${extension}`;
}

/**
 * Dispose all textures on a material.
 */
function _disposeTextures(material) {
    const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'envMap', 'lightMap'];
    for (const key of maps) {
        if (material[key]) {
            material[key].dispose();
        }
    }
}

/**
 * Remove a model from the scene and free all GPU resources.
 */
function _disposeModel(model, scene) {
    if (!model) return;
    model.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(m => { _disposeTextures(m); m.dispose(); });
            } else {
                _disposeTextures(obj.material);
                obj.material.dispose();
            }
        }
    });
    if (scene) scene.remove(model);
}

// ============================================================================
// PREVIEW MANAGEMENT
// ============================================================================

/**
 * Dispose of converter preview resources
 */
function disposeConverterPreview() {
  if (converterAnimationId) {
    cancelAnimationFrame(converterAnimationId);
    converterAnimationId = null;
  }
  if (converterModel) {
    _disposeModel(converterModel, converterScene);
    converterModel = null;
  }
  // Disconnect resize observer
  const canvas = converterRenderer?.domElement;
  if (canvas?._converterResizeObserver) {
    canvas._converterResizeObserver.disconnect();
    canvas._converterResizeObserver = null;
  }
  if (converterRenderer) {
    converterRenderer.dispose();
    converterRenderer = null;
  }
  if (converterControls) {
    converterControls.dispose();
    converterControls = null;
  }
  converterScene = null;
  converterCamera = null;
}

/**
 * Initialize the converter preview canvas
 */
function initConverterPreview(canvas) {
  if (!canvas || !window.THREE) return;

  const width = canvas.clientWidth || 400;
  const height = canvas.clientHeight || 300;

  converterScene = new THREE.Scene();
  converterScene.background = new THREE.Color(0x1a1a1f);

  converterCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  converterCamera.position.set(2, 1.5, 2);

  converterRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  converterRenderer.setSize(width, height);
  converterRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  converterControls = new THREE.OrbitControls(converterCamera, canvas);
  converterControls.enableDamping = true;
  converterControls.dampingFactor = 0.05;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  converterScene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 7);
  converterScene.add(directionalLight);

  // ── Handle canvas resize ──
  const resizeObserver = new ResizeObserver(() => {
    if (!converterRenderer || !converterCamera) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    converterCamera.aspect = w / h;
    converterCamera.updateProjectionMatrix();
    converterRenderer.setSize(w, h, false);
  });
  resizeObserver.observe(canvas.parentElement || canvas);

  // Store reference for cleanup
  canvas._converterResizeObserver = resizeObserver;

  // Animation loop
  function animate() {
    converterAnimationId = requestAnimationFrame(animate);
    converterControls.update();
    converterRenderer.render(converterScene, converterCamera);
  }
  animate();
}

/**
 * Load a model file into the preview
 */
function loadModelToPreview(file) {
  const canvas = getEl('converterPreviewCanvas');
  if (!canvas) return;

  // Initialize preview if not already
  if (!converterScene) {
    initConverterPreview(canvas);
  }

  // Remove and DISPOSE existing model to free GPU memory
  _disposeModel(converterModel, converterScene);
  converterModel = null;

  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);

  const loadComplete = (object) => {
    converterModel = object;

    // ── Compute and STORE original real-world dimensions ──
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // Store original dimensions before any scaling
    // These are in the file's native units (glTF = meters, STL = mm typically)
    object.userData.originalSize = { x: size.x, y: size.y, z: size.z };
    object.userData.originalCenter = { x: center.x, y: center.y, z: center.z };

    // ── Detect unit system ──
    // Heuristic: if ALL dimensions < 10, the model is likely in meters (glTF/Meshy convention)
    // Multiply by 1000 to get millimeters for print context
    const maxOriginal = Math.max(size.x, size.y, size.z);
    let detectedUnit = 'mm'; // assume mm by default
    let mmScale = 1.0;

    if (maxOriginal > 0 && maxOriginal < 10) {
        // Model is likely in meters (glTF standard). Convert to mm.
        detectedUnit = 'm';
        mmScale = 1000.0;
    } else if (maxOriginal >= 10 && maxOriginal < 100) {
        // Could be centimeters
        detectedUnit = 'cm';
        mmScale = 10.0;
    }
    // else: assume already in mm

    object.userData.detectedUnit = detectedUnit;
    object.userData.mmScale = mmScale;
    object.userData.realSizeMM = {
        x: parseFloat((size.x * mmScale).toFixed(2)),
        y: parseFloat((size.y * mmScale).toFixed(2)),
        z: parseFloat((size.z * mmScale).toFixed(2)),
    };

    // ── Display scale (viewport only — NOT persisted to export) ──
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const displayScale = 2 / maxDim;
    object.userData.displayScale = displayScale;

    object.scale.setScalar(displayScale);
    object.position.sub(center.clone().multiplyScalar(displayScale));

    converterScene.add(object);

    // ── Update stats ──
    let vertices = 0, faces = 0;
    object.traverse((child) => {
        if (child.isMesh && child.geometry) {
            const geo = child.geometry;
            vertices += geo.attributes.position ? geo.attributes.position.count : 0;
            faces += geo.index ? geo.index.count / 3 : (geo.attributes.position ? geo.attributes.position.count / 3 : 0);
        }
    });

    const verticesEl = getEl('converterVertices');
    const facesEl = getEl('converterFaces');
    if (verticesEl) verticesEl.textContent = vertices.toLocaleString();
    if (facesEl) facesEl.textContent = Math.round(faces).toLocaleString();

    // ── Count materials and textures ──
    const materialSet = new Set();
    let textureCount = 0;
    const textureSet = new Set();

    object.traverse((child) => {
        if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
                materialSet.add(mat.uuid);
                const texMaps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap'];
                texMaps.forEach(key => {
                    if (mat[key] && !textureSet.has(mat[key].uuid)) {
                        textureSet.add(mat[key].uuid);
                        textureCount++;
                    }
                });
            });
        }
    });

    const materialsEl = getEl('converterMaterials');
    const texturesEl = getEl('converterTextures');
    const animationsEl = getEl('converterAnimations');
    if (materialsEl) materialsEl.textContent = materialSet.size.toLocaleString();
    if (texturesEl) texturesEl.textContent = textureCount > 0 ? textureCount.toLocaleString() : 'None';
    if (animationsEl) animationsEl.textContent = '—'; // Will be set by loader callback

    // ── Show real-world dimensions ──
    const dimEl = getEl('converterDimensions');
    if (dimEl) {
        const rs = object.userData.realSizeMM;
        dimEl.textContent = `${rs.x} × ${rs.y} × ${rs.z} mm`;
        dimEl.title = `Detected source unit: ${detectedUnit}`;
    }

    URL.revokeObjectURL(url);
  };

  const loadError = (err) => {
    console.error('Failed to load model:', err);
    URL.revokeObjectURL(url);

    // Show error state to user
    const fileInfo = getEl('converterFileInfo');
    const dropZone = getEl('converterDropZone');

    // Reset to drop zone with error message
    if (fileInfo) fileInfo.classList.add('hidden');
    if (dropZone) {
        dropZone.classList.remove('hidden');
        // Temporarily show error in the drop zone
        const content = dropZone.querySelector('.converter-upload-content');
        if (content) {
            const originalHTML = content.innerHTML;
            content.innerHTML = `
                <svg class="converter-upload-icon" viewBox="0 0 64 64" fill="none" stroke="#f87171" stroke-width="2" style="opacity:1">
                    <circle cx="32" cy="32" r="24"/>
                    <path d="M22 22l20 20M42 22l-20 20" stroke-linecap="round"/>
                </svg>
                <h2 style="color:#f87171">Failed to load model</h2>
                <p>The file could not be parsed. It may be corrupted or in an unsupported variant.</p>
                <span class="converter-formats-hint">Click or drop another file to try again</span>
            `;
            // Restore original content after 5 seconds
            setTimeout(() => { content.innerHTML = originalHTML; }, 5000);
        }
    }

    originalFile = null;
  };

  // Load based on format
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new THREE.GLTFLoader();
    loader.load(url, (gltf) => {
        loadComplete(gltf.scene);
        // Update animation count after load
        const animEl = getEl('converterAnimations');
        if (animEl) {
            animEl.textContent = gltf.animations?.length
                ? `${gltf.animations.length} clip${gltf.animations.length > 1 ? 's' : ''}`
                : 'None';
        }
    }, undefined, loadError);
  } else if (ext === 'obj') {
    const loader = new THREE.OBJLoader();
    loader.load(url, loadComplete, undefined, loadError);
  } else if (ext === 'stl') {
    const loader = new THREE.STLLoader();
    loader.load(url, (geometry) => {
      const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
      const mesh = new THREE.Mesh(geometry, material);
      loadComplete(mesh);
    }, undefined, loadError);
  } else if (ext === '3mf') {
    const loader = new THREE.ThreeMFLoader();
    loader.load(url, (object) => {
      loadComplete(object);
    }, undefined, loadError);
  } else if (ext === 'fbx') {
    const loader = new THREE.FBXLoader();
    loader.load(url, (fbxScene) => {
        loadComplete(fbxScene);
        const animEl = getEl('converterAnimations');
        if (animEl) {
            animEl.textContent = fbxScene.animations?.length
                ? `${fbxScene.animations.length} clip${fbxScene.animations.length > 1 ? 's' : ''}`
                : 'None';
        }
    }, undefined, loadError);
  }
}

// ============================================================================
// FILE HANDLING
// ============================================================================

/**
 * Handle file upload
 */
function handleFileUpload(file) {
  if (!file) return;

  // ── File size validation ──
  const MAX_SIZE_MB = 150;
  const WARN_SIZE_MB = 50;
  const sizeMB = file.size / (1024 * 1024);

  if (sizeMB > MAX_SIZE_MB) {
    notifyConverter(`File is ${sizeMB.toFixed(0)} MB — too large for browser-based conversion. Maximum recommended size: ${MAX_SIZE_MB} MB. Use Blender or another desktop tool for files this large.`);
    return;
  }

  if (sizeMB > WARN_SIZE_MB) {
    const proceed = confirm(
      `File is ${sizeMB.toFixed(0)} MB — this may take a while and could slow your browser.\n\nContinue?`
    );
    if (!proceed) return;
  }

  originalFile = file;

  // Update UI
  const dropZone = getEl('converterDropZone');
  const fileInfo = getEl('converterFileInfo');
  const fileName = getEl('converterFileName');
  const fileFormat = getEl('converterFileFormat');
  const fileSize = getEl('converterFileSize');
  const fileFormatPill = getEl('converterFileFormatPill');
  const fileSizePill = getEl('converterFileSizePill');
  const extension = file.name.split('.').pop().toUpperCase();
  const prettySize = formatFileSize(file.size);

  if (dropZone) dropZone.classList.add('hidden');
  if (fileInfo) fileInfo.classList.remove('hidden');

  if (fileName) {
    fileName.textContent = compactFileName(file.name);
    fileName.title = file.name;
  }
  if (fileFormat) fileFormat.textContent = extension;
  if (fileSize) fileSize.textContent = prettySize;
  if (fileFormatPill) fileFormatPill.textContent = extension;
  if (fileSizePill) fileSizePill.textContent = prettySize;

  // Load preview
  loadModelToPreview(file);
}

/**
 * Reset the upload state
 */
function resetUpload() {
  const dropZone = getEl('converterDropZone');
  const fileInfo = getEl('converterFileInfo');

  if (dropZone) dropZone.classList.remove('hidden');
  if (fileInfo) fileInfo.classList.add('hidden');

  originalFile = null;

  // Clean up preview but keep scene
  _disposeModel(converterModel, converterScene);
  converterModel = null;
}

let crc32Table = null;

function getCrc32Table() {
  if (crc32Table) return crc32Table;
  crc32Table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[n] = c >>> 0;
  }
  return crc32Table;
}

function crc32(bytes) {
  const table = getCrc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concatUint8(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

function createStoreZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach(({ path, content }) => {
    const nameBytes = encoder.encode(path);
    const dataBytes = typeof content === 'string' ? encoder.encode(content) : content;
    const checksum = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, dataBytes.length);
    writeU32(localView, 22, dataBytes.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, dataBytes.length);
    writeU32(centralView, 24, dataBytes.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  });

  const centralStart = offset;
  const centralDirectory = concatUint8(centralParts);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, files.length);
  writeU16(endView, 10, files.length);
  writeU32(endView, 12, centralDirectory.length);
  writeU32(endView, 16, centralStart);
  writeU16(endView, 20, 0);

  return concatUint8([...localParts, centralDirectory, endRecord]);
}

function collectGeometryFor3MF(root) {
  const vertices = [];
  const triangles = [];
  let vertexOffset = 0;
  const v = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    const geo = child.geometry;
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
      vertices.push(v.x, v.y, v.z);
    }

    if (geo.index) {
      const idx = geo.index.array;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        triangles.push(vertexOffset + idx[i], vertexOffset + idx[i + 1], vertexOffset + idx[i + 2]);
      }
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) {
        triangles.push(vertexOffset + i, vertexOffset + i + 1, vertexOffset + i + 2);
      }
    }
    vertexOffset += pos.count;
  });

  return { vertices, triangles };
}

function cloneForPrintExport(modelToExport) {
  const mmScale = converterModel.userData.mmScale || 1;
  const targetHeightInput = getEl('converterTargetHeight');
  const targetHeight = targetHeightInput ? parseFloat(targetHeightInput.value) : 0;
  const originalSize = converterModel.userData.originalSize || {};
  const originalCenter = converterModel.userData.originalCenter || { x: 0, y: 0, z: 0 };
  let exportScale = mmScale;

  if (targetHeight > 0 && originalSize.y > 0) {
    exportScale = targetHeight / originalSize.y;
  }

  const exportClone = modelToExport.clone();
  exportClone.scale.setScalar(exportScale);
  exportClone.position.set(
    -originalCenter.x * exportScale,
    -originalCenter.y * exportScale,
    -originalCenter.z * exportScale
  );
  exportClone.updateMatrixWorld(true);
  return exportClone;
}

async function exportBasic3MF(root) {
  const { vertices, triangles } = collectGeometryFor3MF(root);
  if (!vertices.length || !triangles.length) throw new Error('No mesh geometry found for 3MF export');

  const vLines = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vLines.push(`     <vertex x="${vertices[i].toFixed(6)}" y="${vertices[i + 1].toFixed(6)}" z="${vertices[i + 2].toFixed(6)}"/>`);
  }
  const tLines = [];
  for (let i = 0; i < triangles.length; i += 3) {
    tLines.push(`     <triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);
  }

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
 xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">TimrX Converter</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
${vLines.join('\n')}
    </vertices>
    <triangles>
${tLines.join('\n')}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" printable="1"/>
 </build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const zipBytes = createStoreZip([
    { path: '[Content_Types].xml', content: contentTypes },
    { path: '_rels/.rels', content: rels },
    { path: '3D/3dmodel.model', content: modelXml }
  ]);

  return new Blob([zipBytes], { type: 'model/3mf' });
}

// ============================================================================
// EXPORT
// ============================================================================

/**
 * Export the model to the specified format
 */
async function exportModel(format) {
  const canDownload = typeof window.WorkspaceCredits?.canDownloadAssets === 'function'
    ? window.WorkspaceCredits.canDownloadAssets()
    : true;

  if (!canDownload) {
    if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = '/hub#pricing';
    return;
  }
  if (!converterModel) {
    notifyConverter('Please upload a model first');
    return;
  }

  // ── Format-specific warnings ──
  const selectedFormat = document.querySelector('input[name="exportFormat"]:checked')?.value || format;

  if (selectedFormat === 'obj') {
    // Check if model has textures
    let hasTextures = false;
    converterModel.traverse((child) => {
        if (child.isMesh && child.material) {
            const mat = Array.isArray(child.material) ? child.material[0] : child.material;
            if (mat && (mat.map || mat.normalMap || mat.roughnessMap)) {
                hasTextures = true;
            }
        }
    });
    if (hasTextures) {
        const proceed = confirm(
            'OBJ format does not preserve textures or materials.\n\n' +
            'Your model has textures that will be lost in the export.\n' +
            'Use GLB format to keep full material fidelity.\n\n' +
            'Continue with OBJ export anyway?'
        );
        if (!proceed) return;
    }
  }

  if (selectedFormat === 'stl') {
    let hasTextures = false;
    converterModel.traverse((child) => {
        if (child.isMesh && child.material) {
            const mat = Array.isArray(child.material) ? child.material[0] : child.material;
            if (mat && mat.map) hasTextures = true;
        }
    });
    if (hasTextures) {
        // Not a blocking warning — just inform
        console.info('[Converter] Note: STL format does not support textures. Geometry only will be exported.');
    }
  }

  const progress = getEl('converterProgress');
  const progressFill = getEl('converterProgressFill');
  const progressText = getEl('converterProgressText');

  if (progress) progress.classList.remove('hidden');
  if (progressFill) progressFill.style.width = '10%';
  if (progressText) progressText.textContent = 'Preparing export...';

  try {
    let blob, filename;
    const baseName = originalFile ? originalFile.name.replace(/\.[^/.]+$/, '') : 'model';
    const flipAxis = getEl('converterFlipAxis')?.checked;

    // Clone model if we need to flip axis
    let modelToExport = converterModel;
    if (flipAxis) {
      modelToExport = converterModel.clone();
      modelToExport.rotation.x = -Math.PI / 2;
    }

    if (progressFill) progressFill.style.width = '30%';
    if (progressText) progressText.textContent = 'Processing geometry...';

    await new Promise(r => setTimeout(r, 100)); // Let UI update

    if (format === 'glb' || format === 'gltf') {
      const exporter = new THREE.GLTFExporter();
      const includeTextures = getEl('converterIncludeTextures')?.checked !== false;

      const options = {
        binary: format === 'glb',
        embedImages: includeTextures
      };

      if (progressFill) progressFill.style.width = '50%';
      if (progressText) progressText.textContent = 'Exporting to ' + format.toUpperCase() + '...';

      const result = await new Promise((resolve, reject) => {
        exporter.parse(modelToExport, resolve, reject, options);
      });

      if (format === 'glb') {
        blob = new Blob([result], { type: 'model/gltf-binary' });
        filename = baseName + '.glb';
      } else {
        blob = new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
        filename = baseName + '.gltf';
      }
    } else if (format === 'obj') {
      const exporter = new THREE.OBJExporter();

      if (progressFill) progressFill.style.width = '50%';
      if (progressText) progressText.textContent = 'Exporting to OBJ...';

      const result = exporter.parse(modelToExport);
      blob = new Blob([result], { type: 'text/plain' });
      filename = baseName + '.obj';
    } else if (format === 'stl') {
      const exporter = new THREE.STLExporter();
      const binary = getEl('converterBinaryStl')?.checked !== false;

      if (progressFill) progressFill.style.width = '50%';
      if (progressText) progressText.textContent = 'Exporting to STL (print-ready)...';

      const exportClone = cloneForPrintExport(modelToExport);
      const result = exporter.parse(exportClone, { binary });
      if (binary) {
        blob = new Blob([result], { type: 'application/octet-stream' });
      } else {
        blob = new Blob([result], { type: 'text/plain' });
      }
      filename = baseName + '.stl';
    } else if (format === '3mf') {
      if (progressFill) progressFill.style.width = '50%';
      if (progressText) progressText.textContent = 'Exporting to 3MF (print-ready)...';

      const exportClone = cloneForPrintExport(modelToExport);
      blob = await exportBasic3MF(exportClone);
      filename = baseName + '.3mf';
    } else if (format === 'usdz') {
      if (!THREE.USDZExporter) {
        throw new Error('USDZExporter not available');
      }
      const exporter = new THREE.USDZExporter();

      if (progressFill) progressFill.style.width = '50%';
      if (progressText) progressText.textContent = 'Exporting to USDZ...';

      const result = await exporter.parse(modelToExport);
      blob = new Blob([result], { type: 'model/vnd.usdz+zip' });
      filename = baseName + '.usdz';
    }

    if (progressFill) progressFill.style.width = '90%';
    if (progressText) progressText.textContent = 'Preparing download...';

    await new Promise(r => setTimeout(r, 100));

    // Download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.textContent = 'Download complete!';

    setTimeout(() => {
      if (progress) progress.classList.add('hidden');
      if (progressFill) progressFill.style.width = '0%';
    }, 1500);

  } catch (err) {
    console.error('Export failed:', err);
    if (progressText) progressText.textContent = 'Export failed: ' + err.message;
    setTimeout(() => {
      if (progress) progress.classList.add('hidden');
    }, 3000);
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the converter module
 */
export function init() {
  // File input (open/close is handled by HTML inline script)
  const dropZone = getEl('converterDropZone');
  const fileInput = getEl('converterFileInput');

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) handleFileUpload(file);
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleFileUpload(file);
    });
  }

  // Change file button
  const changeFileBtn = getEl('converterChangeFile');
  if (changeFileBtn) {
    changeFileBtn.addEventListener('click', () => {
      resetUpload();
      fileInput?.click();
    });
  }

  // Advanced options toggle
  const advancedToggle = getEl('converterAdvancedToggle');
  const advancedOptions = getEl('converterAdvancedOptions');
  if (advancedToggle && advancedOptions) {
    advancedToggle.addEventListener('click', () => {
      advancedToggle.classList.toggle('open');
      advancedOptions.classList.toggle('hidden');
    });
  }

  // Export button
  const exportBtn = getEl('converterExportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const format = document.querySelector('input[name="exportFormat"]:checked')?.value || 'glb';
      exportModel(format);
    });
  }

  // ── Live dimension update when target height changes ──
  const targetHeightInput = getEl('converterTargetHeight');
  const dimEl = getEl('converterDimensions');

  if (targetHeightInput && dimEl) {
    targetHeightInput.addEventListener('input', () => {
        if (!converterModel || !converterModel.userData.realSizeMM) return;

        const rs = converterModel.userData.realSizeMM;
        const targetH = parseFloat(targetHeightInput.value);

        if (targetH > 0 && rs.y > 0) {
            const ratio = targetH / rs.y;
            const sx = (rs.x * ratio).toFixed(1);
            const sy = targetH.toFixed(1);
            const sz = (rs.z * ratio).toFixed(1);
            dimEl.textContent = `${sx} × ${sy} × ${sz} mm (scaled)`;
            dimEl.style.color = '#38bdf8';
        } else {
            // Revert to original dimensions
            dimEl.textContent = `${rs.x} × ${rs.y} × ${rs.z} mm`;
            dimEl.style.color = '';
        }
    });
  }

  // ── Wireframe toggle ──
  const wireframeToggle = getEl('converterWireframe');
  if (wireframeToggle) {
    wireframeToggle.addEventListener('change', () => {
        if (!converterModel) return;
        const enabled = wireframeToggle.checked;
        converterModel.traverse((child) => {
            if (child.isMesh && child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => { m.wireframe = enabled; });
                } else {
                    child.material.wireframe = enabled;
                }
            }
        });
    });
  }

  // ── Background toggle ──
  const bgToggle = getEl('converterBgToggle');
  if (bgToggle) {
    let isDark = true;
    bgToggle.addEventListener('click', () => {
        if (!converterScene) return;
        isDark = !isDark;
        converterScene.background = new THREE.Color(isDark ? 0x1a1a1f : 0xe8e8e8);
        bgToggle.title = isDark ? 'Switch to light background' : 'Switch to dark background';
    });
  }

  // ── Show/hide format-specific options ──
  const formatRadios = document.querySelectorAll('input[name="exportFormat"]');
  const textureRow = getEl('converterIncludeTextures')?.closest('.converter-option-row');
  const binaryStlRow = getEl('converterBinaryStl')?.closest('.converter-option-row');
  const targetHeightRow = getEl('converterTargetHeightRow');

  function updateFormatOptions() {
    const format = document.querySelector('input[name="exportFormat"]:checked')?.value || 'glb';

    // Texture option: only for GLB/GLTF
    if (textureRow) textureRow.style.display = (format === 'glb' || format === 'gltf') ? '' : 'none';

    // Binary STL: only for STL
    if (binaryStlRow) binaryStlRow.style.display = (format === 'stl') ? '' : 'none';

    // Target print height: print formats that use real-world millimeter scale.
    if (targetHeightRow) targetHeightRow.style.display = (format === 'stl' || format === '3mf') ? '' : 'none';
  }

  formatRadios.forEach(radio => radio.addEventListener('change', updateFormatOptions));
  updateFormatOptions(); // Set initial state
}

/**
 * Clean up converter resources (call when closing)
 */
export function dispose() {
  disposeConverterPreview();
  originalFile = null;
}

// Export for use in other modules
export { exportModel, handleFileUpload, resetUpload };
