/**
 * viewer.js
 * Interacts with Three.js. Assumes 3dprint-app.js has already created the scene,
 * and this module simply hooks into it to load models and move the camera.
 * Uses window.TimrX globals (no ES modules).
 */

(function() {
  'use strict';

  const { byId, log } = window.TimrX;

  let scene, camera, renderer, controls;
  let viewerPlaceholder = null;
  let currentModel = null;
  let demoCube, grid;

  function initViewer() {
    if (!window.timrx3D) {
      log('Waiting for main viewer...');
      return;
    }

    viewerPlaceholder = byId('viewerPlaceholder');
    scene = window.timrx3D.scene;
    camera = window.timrx3D.camera;
    renderer = window.timrx3D.renderer;
    controls = window.timrxControls;

    scene?.traverse((obj) => {
      if (obj.isGridHelper) grid = obj;
      if (obj.userData?.isPlaceholder) demoCube = obj;
    });

    if (!demoCube && window.placeholderCube) demoCube = window.placeholderCube;

    updatePlaceholder();
  }

  function updatePlaceholder() {
    if (!viewerPlaceholder) return;
    viewerPlaceholder.style.display = currentModel ? 'none' : 'block';
  }

  function clearModel() {
    if (!currentModel) return;
    scene.remove(currentModel);

    currentModel.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });

    currentModel = null;
    if (demoCube) demoCube.visible = true;
    updatePlaceholder();
    byId('viewerToolbar')?.classList.remove('visible');
  }

  async function loadModelWithFallback(primaryUrl, fallbackUrl) {
    try {
      await loadGlbFromUrl(primaryUrl);
    } catch (err) {
      if (fallbackUrl) await loadGlbFromUrl(fallbackUrl);
      else throw err;
    }
  }

  async function loadGlbFromUrl(url) {
    if (!(window.THREE && THREE.GLTFLoader)) throw new Error('GLTFLoader missing');

    const loader = new THREE.GLTFLoader();
    loader.setCrossOrigin('anonymous');

    clearModel();

    return new Promise((resolve, reject) => {
      loader.load(url, (gltf) => {
        currentModel = gltf.scene;
        scene.add(currentModel);

        const box = new THREE.Box3().setFromObject(currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const min = box.min;
        currentModel.position.x += -center.x;
        currentModel.position.z += -center.z;
        currentModel.position.y += -min.y;

        if (demoCube) demoCube.visible = false;

        fitCameraToObject(currentModel);
        byId('viewerToolbar')?.classList.add('visible');
        updatePlaceholder();
        resolve();
      }, undefined, reject);
    });
  }

  function fitCameraToObject(object, offset = 0.7) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());

    if (controls) {
      controls.maxDistance = size * 10;
      controls.target.copy(center);
      controls.update();
    }

    camera.near = size / 100;
    camera.far = size * 100;
    camera.updateProjectionMatrix();

    const direction = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(size / offset));
  }

  function showImageInViewer(url) {
    const modelV = byId('model3dViewer');
    const imageV = byId('imageViewer');
    const videoV = byId('videoViewer');
    const genImg = byId('generatedImage');
    const ph = byId('imagePlaceholder');

    if (modelV) modelV.classList.add('hidden');
    if (videoV) videoV.classList.add('hidden');
    if (imageV) imageV.classList.remove('hidden');

    if (genImg) {
      genImg.src = url;
      genImg.classList.remove('hidden');
    }
    if (ph) ph.classList.add('hidden');
  }

  // Expose globally
  window.Viewer = {
    initViewer,
    clearModel,
    loadModelWithFallback,
    loadGlbFromUrl,
    showImageInViewer,
  };

})();
