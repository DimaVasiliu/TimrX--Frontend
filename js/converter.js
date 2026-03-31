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
    converterModel.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
    if (converterScene) converterScene.remove(converterModel);
    converterModel = null;
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

  // Remove existing model
  if (converterModel) {
    converterScene.remove(converterModel);
    converterModel = null;
  }

  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);

  const loadComplete = (object) => {
    converterModel = object;

    // Center and scale model
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 2 / maxDim;

    object.scale.setScalar(scale);
    object.position.sub(center.multiplyScalar(scale));

    converterScene.add(object);

    // Update stats
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

    URL.revokeObjectURL(url);
  };

  const loadError = (err) => {
    console.error('Failed to load model:', err);
    URL.revokeObjectURL(url);
  };

  // Load based on format
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new THREE.GLTFLoader();
    loader.load(url, (gltf) => loadComplete(gltf.scene), undefined, loadError);
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
    loader.load(url, loadComplete, undefined, loadError);
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
  if (converterModel && converterScene) {
    converterScene.remove(converterModel);
    converterModel = null;
  }
}

// ============================================================================
// EXPORT
// ============================================================================

/**
 * Export the model to the specified format
 */
async function exportModel(format) {
  if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
    if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = '/hub#pricing';
    return;
  }
  if (!converterModel) {
    alert('Please upload a model first');
    return;
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
      if (progressText) progressText.textContent = 'Exporting to STL...';

      const result = exporter.parse(modelToExport, { binary });
      if (binary) {
        blob = new Blob([result], { type: 'application/octet-stream' });
      } else {
        blob = new Blob([result], { type: 'text/plain' });
      }
      filename = baseName + '.stl';
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
