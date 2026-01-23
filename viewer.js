// Sets up and controls the 3D model viewer experience in the frontend.

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let demoCube = null;
let viewerPlaceholder = null;
let currentModel = null;

function getDomRefs() {
  return {
    modelViewer: document.getElementById('model3dViewer'),
    imageViewer: document.getElementById('imageViewer'),
    videoViewer: document.getElementById('videoViewer'),
    generatedImage: document.getElementById('generatedImage'),
    imagePlaceholder: document.getElementById('imagePlaceholder'),
    viewerTitle: document.getElementById('viewerTitle'),
    genHint: document.getElementById('genHint')
  };
}

function ensureViewerRefs() {
  if (scene && camera && renderer && controls) return true;

  if (!window.timrx3D) {
    console.warn('[Viewer] window.timrx3D not found; viewer not initialized.');
    return false;
  }

  viewerPlaceholder = viewerPlaceholder || document.getElementById('viewerPlaceholder');
  scene = window.timrx3D.scene;
  camera = window.timrx3D.camera;
  renderer = window.timrx3D.renderer;
  controls = window.timrxControls || window.timrx3D.controls || window.timrx3D.viewerControls || null;

  // Optional cube/placeholder reference
  if (scene) {
    scene.traverse((obj) => {
      if (obj.userData?.isPlaceholder) demoCube = demoCube || obj;
    });
  }
  if (!demoCube && window.placeholderCube) demoCube = window.placeholderCube;

  const ready = !!(scene && camera && renderer);
  if (!ready) console.warn('[Viewer] Viewer refs missing scene/camera/renderer.');
  return ready;
}

function updatePlaceholder() {
  if (!viewerPlaceholder) return;
  viewerPlaceholder.style.display = currentModel ? 'none' : 'block';
}

function toggleViewerToolbar(show) {
  const toolbar = document.getElementById('viewerToolbar');
  if (!toolbar) return;
  toolbar.classList.toggle('visible', !!show);
}

function clearModel() {
  if (!scene || !currentModel) {
    currentModel = null;
    updatePlaceholder();
    return;
  }
  scene.remove(currentModel);
  currentModel.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
  currentModel = null;
  if (demoCube) demoCube.visible = true;
  updatePlaceholder();
  toggleViewerToolbar(false);
}

function fitCameraToObject(object, offset = 1.35) {
  if (!camera || !controls || !object) return;
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());

  controls.maxDistance = size * 2;
  camera.near = Math.max(0.01, size / 100);
  camera.far = size * 100;
  camera.updateProjectionMatrix();

  camera.position.copy(center);
  camera.position.x += size / offset;
  camera.position.y += size / offset;
  camera.position.z += size / offset;
  controls.target.copy(center);
  controls.update();
}

function boostPBR(object, intensity = 1.2) {
  if (!object) return;
  object.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if ('envMapIntensity' in m) m.envMapIntensity = intensity;
        m.needsUpdate = true;
      });
    }
  });
}

function placeOnGrid(obj) {
  if (!obj || !window.THREE) return;
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const min = box.min;
  obj.position.x += -center.x;
  obj.position.z += -center.z;
  obj.position.y += -min.y;
}

async function loadGlbFromUrl(url) {
  if (!(window.THREE && THREE.GLTFLoader)) {
    throw new Error('GLTFLoader not loaded');
  }
  if (!ensureViewerRefs()) {
    throw new Error('Viewer not ready');
  }
  if (viewerPlaceholder) viewerPlaceholder.style.display = 'none';

  // Defensive check: pre-validate URL returns binary/model data, not HTML
  try {
    const headRes = await fetch(url, { method: 'HEAD', mode: 'cors' });
    const contentType = headRes.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const err = new Error(`Model URL returned HTML (likely 404 or redirect): ${url}`);
      err.isHtmlResponse = true;
      console.error('[Viewer]', err.message);
      throw err;
    }
    if (!headRes.ok) {
      const err = new Error(`Model URL returned ${headRes.status}: ${url}`);
      console.error('[Viewer]', err.message);
      throw err;
    }
  } catch (prefetchErr) {
    if (prefetchErr.isHtmlResponse) throw prefetchErr;
    // HEAD failed (CORS?), continue and let GLTFLoader handle it
    console.warn('[Viewer] HEAD prefetch failed, continuing:', prefetchErr.message);
  }

  const gltfLoader = new THREE.GLTFLoader();
  if (gltfLoader.setCrossOrigin) gltfLoader.setCrossOrigin('anonymous');

  clearModel();

  await new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        currentModel = gltf.scene;
        currentModel.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        scene.add(currentModel);
        placeOnGrid(currentModel);
        boostPBR(currentModel, 1.2);
        if (demoCube) demoCube.visible = false;
        fitCameraToObject(currentModel);
        updatePlaceholder();
        toggleViewerToolbar(true);
        resolve();
      },
      undefined,
      (err) => {
        console.error('[Viewer] GLB load error from', url, err);
        if (viewerPlaceholder) viewerPlaceholder.style.display = 'block';
        toggleViewerToolbar(false);
        reject(err);
      }
    );
  });
}

async function loadModelWithFallback(primaryUrl, fallbackUrl = null) {
  try {
    await loadGlbFromUrl(primaryUrl);
  } catch (err) {
    if (!fallbackUrl) throw err;
    console.warn('[Viewer] Primary load failed, trying fallback:', fallbackUrl);
    await loadGlbFromUrl(fallbackUrl);
  }
}

export async function showModelInViewer(glbUrl, meta = {}) {
  if (!glbUrl) {
    console.warn('[Viewer] Missing model URL; clearing viewer.');
    clearViewer();
    return;
  }

  const { modelViewer, imageViewer, videoViewer, viewerTitle, genHint } = getDomRefs();
  if (modelViewer) modelViewer.classList.remove('hidden');
  if (imageViewer) imageViewer.classList.add('hidden');
  if (videoViewer) videoViewer.classList.add('hidden');
  if (viewerTitle) viewerTitle.textContent = meta.title || '3D Model Viewer';
  if (genHint && meta.hint) genHint.textContent = meta.hint;

  try {
    await loadModelWithFallback(glbUrl, meta.fallbackUrl);
    if (genHint && meta.loadedHint) genHint.textContent = meta.loadedHint;
  } catch (err) {
    console.error('[Viewer] Failed to show model in viewer:', err);
  }
}

export function showImageInViewer(imageUrl, meta = {}) {
  if (!imageUrl) {
    console.warn('[Viewer] Missing image URL; nothing to display.');
    return;
  }

  const {
    modelViewer,
    imageViewer,
    videoViewer,
    generatedImage,
    imagePlaceholder,
    viewerTitle,
    genHint
  } = getDomRefs();

  if (modelViewer) modelViewer.classList.add('hidden');
  if (videoViewer) videoViewer.classList.add('hidden');
  if (imageViewer) imageViewer.classList.remove('hidden');
  if (viewerTitle) viewerTitle.textContent = meta.title || 'Image Preview';
  if (genHint) genHint.textContent = meta.hint || 'Generated image is displayed.';
  if (generatedImage) {
    generatedImage.src = imageUrl;
    generatedImage.classList.remove('hidden');
  }
  if (imagePlaceholder) imagePlaceholder.classList.add('hidden');
  toggleViewerToolbar(false);
}

export function clearViewer() {
  const { generatedImage, imageViewer, modelViewer, viewerTitle, imagePlaceholder } = getDomRefs();
  clearModel();
  if (generatedImage) {
    generatedImage.src = '';
    generatedImage.classList.add('hidden');
  }
  if (imagePlaceholder) imagePlaceholder.classList.remove('hidden');
  if (imageViewer) imageViewer.classList.add('hidden');
  if (modelViewer) modelViewer.classList.remove('hidden');
  if (viewerTitle) viewerTitle.textContent = 'Viewer';
  toggleViewerToolbar(false);
}

export function setViewerControlsEnabled(enabled = true) {
  if (!ensureViewerRefs() || !controls) return false;
  controls.enabled = !!enabled;
  return true;
}

export async function showLocalModel(file, meta = {}) {
  if (!(file instanceof File) && !(file instanceof Blob)) {
    console.warn('[Viewer] showLocalModel called with non-file input');
    return;
  }
  if (!ensureViewerRefs()) {
    throw new Error('Viewer not ready');
  }
  if (viewerPlaceholder) viewerPlaceholder.style.display = 'none';

  const url = URL.createObjectURL(file);
  const gltfLoader = new THREE.GLTFLoader();
  clearModel();

  await new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        currentModel = gltf.scene;
        scene.add(currentModel);
        placeOnGrid(currentModel);
        boostPBR(currentModel, 1.2);
        if (demoCube) demoCube.visible = false;
        fitCameraToObject(currentModel);
        updatePlaceholder();
        toggleViewerToolbar(true);
        resolve();
      },
      undefined,
      (err) => {
        console.error('[Viewer] GLB load error from local file', err);
        if (viewerPlaceholder) viewerPlaceholder.style.display = 'block';
        toggleViewerToolbar(false);
        reject(err);
      }
    );
  });

  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const { modelViewer, imageViewer, videoViewer, viewerTitle, genHint } = getDomRefs();
  if (modelViewer) modelViewer.classList.remove('hidden');
  if (imageViewer) imageViewer.classList.add('hidden');
  if (videoViewer) videoViewer.classList.add('hidden');
  if (viewerTitle) viewerTitle.textContent = meta.title || '3D Model Viewer';
  if (genHint && meta.hint) genHint.textContent = meta.hint;
}
