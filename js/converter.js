/**
 * converter.js
 * Self-contained logic for the file converter tool (drag-and-drop 3D format converter).
 * Supports: GLB, GLTF, OBJ, STL, FBX import and GLB, GLTF, OBJ, STL export.
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
    alert(`File is ${sizeMB.toFixed(0)} MB — too large for browser-based conversion.\n\nMaximum recommended size: ${MAX_SIZE_MB} MB.\nUse Blender or another desktop tool for files this large.`);
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

  if (dropZone) dropZone.classList.add('hidden');
  if (fileInfo) fileInfo.classList.remove('hidden');

  if (fileName) fileName.textContent = file.name;
  if (fileFormat) fileFormat.textContent = file.name.split('.').pop().toUpperCase();
  if (fileSize) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    fileSize.textContent = sizeMB + ' MB';
  }

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
    alert('Please upload a model first');
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

      // ── CRITICAL: Undo viewport display scale, apply real-world mm scale ──
      const displayScale = converterModel.userData.displayScale || 1;
      const mmScale = converterModel.userData.mmScale || 1;

      // User-specified target height (if set)
      const targetHeightInput = getEl('converterTargetHeight');
      const targetHeight = targetHeightInput ? parseFloat(targetHeightInput.value) : 0;

      let exportScale;
      if (targetHeight > 0) {
          // User wants a specific height in mm
          const originalHeightMM = converterModel.userData.realSizeMM?.y || 1;
          exportScale = (targetHeight / originalHeightMM) * mmScale / displayScale;
      } else {
          // Default: undo display scale, apply mm conversion
          exportScale = mmScale / displayScale;
      }

      // Clone for export so we don't mutate the preview
      const exportClone = modelToExport.clone();
      exportClone.scale.setScalar(exportScale);
      exportClone.updateMatrixWorld(true);

      const result = exporter.parse(exportClone, { binary });
      if (binary) {
        blob = new Blob([result], { type: 'application/octet-stream' });
      } else {
        blob = new Blob([result], { type: 'text/plain' });
      }
      filename = baseName + '.stl';
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

    // Target print height: only for STL
    if (targetHeightRow) targetHeightRow.style.display = (format === 'stl') ? '' : 'none';
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
