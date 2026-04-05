/**
 * viewer.js
 * Interacts with Three.js. Assumes 3dprint-app.js has already created the scene,
 * and this module simply hooks into it to load models and move the camera.
 *
 * IMPORTANT: All functions guard against missing WebGL/scene/renderer to prevent crashes.
 */

import { byId, log, isTimrxS3Url, getLoadableModelUrl } from './config.js';
import { setHistoryActiveModelId, resetModelVersionStack } from './state.js';

let scene, camera, renderer, controls;
let viewerPlaceholder = null;
let currentModel = null;
let demoCube, grid;

// Animation playback state
let _mixer = null;       // THREE.AnimationMixer for the current model
let _clock = null;       // THREE.Clock for delta time

/**
 * Compute bounding box from visible mesh geometry only.
 */
function getVisualBounds(root) {
    const box = new THREE.Box3();
    let hasSkinned = false;
    root.updateMatrixWorld(true);
    root.traverse(child => {
        if (!child.geometry) return;
        if (!child.visible) return;
        // SkinnedMesh geometry.boundingBox is in bind-pose space, NOT deformed
        // pose. Skip them from manual BB computation — we'll use setFromObject
        // which handles skinning correctly.
        if (child.isSkinnedMesh) {
            hasSkinned = true;
            return;
        }
        child.geometry.computeBoundingBox();
        const b = child.geometry.boundingBox.clone();
        b.applyMatrix4(child.matrixWorld);
        if (!b.isEmpty()) box.union(b);
    });
    // For rigged/skinned models, use THREE's built-in which accounts for bone transforms
    if (hasSkinned || box.isEmpty()) {
        return new THREE.Box3().setFromObject(root);
    }
    return box;
}

/**
 * Check if the 3D viewer is available and ready.
 * @returns {boolean} True if viewer can be used.
 */
function isViewerReady() {
    // Check global availability flag (set by 3dprint-app.js WebGL detection)
    if (window.timrxViewerAvailable === false) {
        return false;
    }
    // Check if scene and renderer exist
    return !!(scene && renderer);
}

/**
 * Show a toast message when viewer is unavailable.
 * @param {string} action - What the user tried to do.
 */
function showViewerUnavailableMessage(action) {
    log(`[Viewer] Cannot ${action}: WebGL/3D viewer not available`);

    // Try to show a toast if available
    if (window.showToast) {
        window.showToast('3D preview unavailable. You can still generate and download models.', 'info');
    }
}

export function initViewer() {
    // Check if WebGL is available first
    if (window.timrxViewerAvailable === false) {
        log('[Viewer] WebGL not available, skipping init');
        return;
    }

    // 3dprint-app.js creates window.timrx3D. We hook into it.
    if (!window.timrx3D) {
        log('[Viewer] Waiting for main viewer...');
        return;
    }

    // Check if scene exists (bootThreeViewer might have failed)
    if (!window.timrx3D.scene) {
        log('[Viewer] timrx3D.scene is missing, viewer may have failed to initialize');
        return;
    }

    viewerPlaceholder = byId('viewerPlaceholder');
    scene = window.timrx3D.scene;
    camera = window.timrx3D.camera;
    renderer = window.timrx3D.renderer;
    // window.timrxControls is created by 3dprint-app.js
    controls = window.timrxControls;

    // Find existing helpers (guard against missing scene)
    if (scene) {
        scene.traverse((obj) => {
            if (obj.isGridHelper) grid = obj;
            if (obj.userData?.isPlaceholder) demoCube = obj;
        });
    }

    // Fallback if demoCube wasn't found in traverse
    if (!demoCube && window.placeholderCube) demoCube = window.placeholderCube;

    updatePlaceholder();
    log('[Viewer] Initialized successfully');
}

function updatePlaceholder() {
    if (!viewerPlaceholder) return;
    viewerPlaceholder.style.display = currentModel ? 'none' : 'block';
}

export function clearModel() {
    // Guard: Check if scene is available
    if (!scene) {
        log('[Viewer] clearModel: scene not available');
        currentModel = null;
        return;
    }

    // Stop any playing animation
    if (_mixer) {
        _mixer.stopAllAction();
        _mixer.uncacheRoot(_mixer.getRoot());
        _mixer = null;
    }
    window._timrxMixer = null;

    // Clear viewer.js's own model
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                else o.material.dispose();
            }
        });
        currentModel = null;
        window._timrxCurrentModel = null;
    }

    // Also clear any Inspire-loaded model to prevent stacking
    if (window.inspireCurrentModel) {
        scene.remove(window.inspireCurrentModel);
        window.inspireCurrentModel.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                else o.material.dispose();
            }
        });
        window.inspireCurrentModel = null;
        log('[Viewer] Cleared Inspire model');
    }

    if (demoCube) demoCube.visible = true;
    updatePlaceholder();
    byId('viewerToolbar')?.classList.remove('visible');
}

export async function loadModelWithFallback(primaryUrl, fallbackUrl) {
    // Guard: Check if viewer is available
    if (!isViewerReady()) {
        showViewerUnavailableMessage('load model');
        throw new Error('3D viewer not available (WebGL disabled)');
    }

    try {
        await loadGlbFromUrl(primaryUrl);
    } catch (err) {
        if (fallbackUrl) await loadGlbFromUrl(fallbackUrl);
        else throw err;
    }
}

/**
 * Check if the 3D viewer is available (exported for external use).
 * @returns {boolean}
 */
export function checkViewerAvailable() {
    return isViewerReady();
}

export async function loadGlbFromUrl(url) {
    if (!(window.THREE && THREE.GLTFLoader)) throw new Error('GLTFLoader missing');

    // Guard: Check if viewer is available
    if (!isViewerReady()) {
        showViewerUnavailableMessage('load model');
        throw new Error('3D viewer not available (WebGL disabled)');
    }

    // Defensive check: pre-validate URL returns binary/model data, not HTML
    try {
        const fetchOpts = { method: 'HEAD', mode: 'cors' };
        if (!isTimrxS3Url(url)) fetchOpts.credentials = 'include';
        const headRes = await fetch(url, fetchOpts);
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

    const loader = new THREE.GLTFLoader();
    loader.setCrossOrigin('anonymous');

    clearModel();

    return new Promise((resolve, reject) => {
        loader.load(url, (gltf) => {
            currentModel = gltf.scene;
            window._timrxCurrentModel = currentModel;

            // Double-check scene is still valid before adding
            if (!scene) {
                reject(new Error('Scene became unavailable'));
                return;
            }

            scene.add(currentModel);

            // Center model using mesh-only bounds (avoids skeleton distortion)
            // Ground on grid (grid y = -0.5)
            const box = getVisualBounds(currentModel);
            const center = box.getCenter(new THREE.Vector3());
            currentModel.position.set(0, 0, 0);
            currentModel.position.x = -center.x;
            currentModel.position.z = -center.z;
            currentModel.position.y = -box.min.y - 0.5;

            if (demoCube) demoCube.visible = false;

            // Play animation clips if present (rigged/animated GLBs from Meshy)
            if (gltf.animations && gltf.animations.length > 0) {
                _mixer = new THREE.AnimationMixer(currentModel);
                _clock = _clock || new THREE.Clock();
                _clock.start();
                gltf.animations.forEach(clip => {
                    const action = _mixer.clipAction(clip);
                    action.play();
                });
                // Expose mixer globally so the render loop in 3dprint-app.js can update it
                window._timrxMixer = _mixer;
                window._timrxClock = _clock;
                log('[Viewer] Playing', gltf.animations.length, 'animation clip(s)');
            } else {
                window._timrxMixer = null;
            }

            fitCameraToObject(currentModel);
            currentModel.updateMatrixWorld(true);
            controls?.update?.();
            renderer?.render?.(scene, camera);
            byId('viewerToolbar')?.classList.add('visible');
            updatePlaceholder();
            resolve();
        }, undefined, (err) => {
            // Clean up any partially-allocated Three.js resources (geometries,
            // materials, textures) from a failed load to prevent VRAM leaks.
            clearModel();
            reject(err);
        });
    });
}

function fitCameraToObject(object, offset = 0.78) {
    const box = getVisualBounds(object);
    const boxSize = box.getSize(new THREE.Vector3());
    const size = boxSize.length();
    const center = box.getCenter(new THREE.Vector3());
    const target = center.clone();

    // Bias the target slightly upward so tall rigged characters keep their head
    // and shoulders comfortably in frame when the camera is fitted.
    if (boxSize.y > 0) {
        target.y += boxSize.y * 0.06;
    }

    if (controls) {
        controls.maxDistance = size * 12;
        controls.target.copy(target);
        controls.update();
    }

    camera.near = size / 100;
    camera.far = size * 100;
    camera.updateProjectionMatrix();

    // Detect humanoid-proportioned models (tall and narrow — height > 1.5x width)
    // and position the camera in FRONT of the model, slightly elevated.
    // glTF/Meshy convention: characters face -Z. Camera at +Z looks at the front.
    const isHumanoid = boxSize.y > boxSize.x * 1.5 && boxSize.y > boxSize.z * 1.5;
    const direction = isHumanoid
        ? new THREE.Vector3(0, 0.22, 1).normalize()   // +Z = front of -Z-facing model
        : new THREE.Vector3(1, 1, 1).normalize();     // generic diagonal
    camera.position.copy(target).add(direction.multiplyScalar(size / offset));
    if (isHumanoid) {
        log('[Viewer] Humanoid camera: front-facing +Z');
    }
}

export function showImageInViewer(url) {
    // Hide 3D, Show Image Logic
    const modelV = byId('model3dViewer');
    const imageV = byId('imageViewer');
    const videoV = byId('videoViewer');
    const genImg = byId('generatedImage');
    const ph = byId('imagePlaceholder');
    const fitToggle = byId('imageFitToggle');

    if (modelV) modelV.classList.add('hidden');
    if (videoV) videoV.classList.add('hidden');
    if (imageV) imageV.classList.remove('hidden');

    if (genImg) {
        genImg.src = url;
        genImg.classList.remove('hidden');
        // Reset to Fit mode when showing new image
        genImg.classList.remove('fill-mode');
    }
    if (ph) ph.classList.add('hidden');

    // Show the Fit/Fill toggle and reset to Fit mode
    if (fitToggle) {
        fitToggle.classList.remove('hidden', 'is-fill');
        const label = fitToggle.querySelector('span');
        if (label) label.textContent = 'Fit';
    }

    log('[Viewer] Showing image:', url);
}

/**
 * Capture a thumbnail screenshot from the current 3D viewer state.
 * Returns a data URL (image/png) or null if capture fails.
 * @param {number} [size=256] — output image dimension (square)
 */
export function captureViewerThumbnail(size = 256) {
    if (!isViewerReady() || !renderer || !scene || !camera) return null;
    try {
        // Force a render to ensure current frame is fresh
        renderer.render(scene, camera);
        // Read from the WebGL canvas
        const srcCanvas = renderer.domElement;
        // Scale down to thumbnail size
        const thumb = document.createElement('canvas');
        thumb.width = size;
        thumb.height = size;
        const ctx = thumb.getContext('2d');
        if (!ctx) return null;
        // Center-crop: take the largest square from the source
        const srcW = srcCanvas.width;
        const srcH = srcCanvas.height;
        const cropSize = Math.min(srcW, srcH);
        const sx = (srcW - cropSize) / 2;
        const sy = (srcH - cropSize) / 2;
        ctx.drawImage(srcCanvas, sx, sy, cropSize, cropSize, 0, 0, size, size);
        return thumb.toDataURL('image/png');
    } catch (e) {
        console.warn('[Viewer] Thumbnail capture failed:', e);
        return null;
    }
}

/**
 * Initialize the image Fit/Fill toggle
 */
export function initImageFitToggle() {
    const fitToggle = byId('imageFitToggle');
    const genImg = byId('generatedImage');

    if (!fitToggle || !genImg) return;

    fitToggle.addEventListener('click', () => {
        const isFillMode = genImg.classList.toggle('fill-mode');
        fitToggle.classList.toggle('is-fill', isFillMode);

        const label = fitToggle.querySelector('span');
        if (label) {
            label.textContent = isFillMode ? 'Fill' : 'Fit';
        }

        log('[Viewer] Image mode:', isFillMode ? 'Fill' : 'Fit');
    });

    log('[Viewer] Image Fit/Fill toggle initialized');
}

/**
 * Clear the image viewer
 */
export function clearImageViewer() {
    const genImg = byId('generatedImage');
    const imageV = byId('imageViewer');
    const ph = byId('imagePlaceholder');
    const fitToggle = byId('imageFitToggle');

    if (genImg) {
        genImg.src = '';
        genImg.classList.add('hidden');
        genImg.classList.remove('fill-mode');
    }
    if (ph) ph.classList.remove('hidden');
    if (imageV) imageV.classList.add('hidden');
    if (fitToggle) {
        fitToggle.classList.add('hidden');
        fitToggle.classList.remove('is-fill');
    }
}

/**
 * Show a video in the viewer panel
 * @param {string} videoUrl - URL of the video to display
 * @param {object} meta - Optional metadata { title, hint, autoplay }
 */
export function showVideoInViewer(videoUrl, meta = {}) {
    const modelV = byId('model3dViewer');
    const imageV = byId('imageViewer');
    const videoV = byId('videoViewer');
    const genVideo = byId('generatedVideo');
    const videoPh = byId('videoPlaceholder');
    const viewerTitle = byId('viewerTitle');
    const genHint = byId('genHint');

    // Hide other viewers, show video viewer
    if (modelV) modelV.classList.add('hidden');
    if (imageV) imageV.classList.add('hidden');
    if (videoV) videoV.classList.remove('hidden');

    // Update title and hint
    if (viewerTitle) viewerTitle.textContent = meta.title || 'Video Preview';
    if (genHint) genHint.textContent = meta.hint || 'Generated video is displayed.';

    // Show video element, hide placeholder
    if (genVideo) {
        genVideo.src = videoUrl;
        genVideo.classList.remove('hidden');
        genVideo.load();
        // Auto-play if desired
        if (meta.autoplay) {
            genVideo.play().catch(err => {
                console.warn('[Viewer] Autoplay blocked:', err);
            });
        }
    }
    if (videoPh) videoPh.classList.add('hidden');

    log('[Viewer] Showing video:', videoUrl);
}

/**
 * Clear the video viewer
 */
export function clearVideoViewer() {
    const genVideo = byId('generatedVideo');
    const videoV = byId('videoViewer');
    const videoPh = byId('videoPlaceholder');

    if (genVideo) {
        genVideo.pause();
        genVideo.src = '';
        genVideo.classList.add('hidden');
    }
    if (videoPh) videoPh.classList.remove('hidden');
    if (videoV) videoV.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════
// GROUPED MULTI-MODEL VIEWER
// ═══════════════════════════════════════════════════════════════

(function () {
  "use strict";

  const LAYOUTS = {
    2: [
      { x: 0,   y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
    3: [
      { x: 0,    y: 0.5, w: 0.5,  h: 0.5 },
      { x: 0.5,  y: 0.5, w: 0.5,  h: 0.5 },
      { x: 0.125, y: 0,  w: 0.75, h: 0.5 },
    ],
    4: [
      { x: 0,   y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0,   y: 0,   w: 0.5, h: 0.5 },
      { x: 0.5, y: 0,   w: 0.5, h: 0.5 },
    ],
  };

  const _state = {
    mode: "empty",      // empty | single | grouped | focus
    groupId: null,
    viewports: [],      // { scene, camera, controls, model, overlay, label, mixer, clock, item }
    focusIndex: -1,
    renderRequested: false,
    animationActive: false,
  };

  function _getRenderer() {
    return window.timrxRenderer || null;
  }

  function _getCanvas() {
    const r = _getRenderer();
    return r ? r.domElement : null;
  }

  function _getContainer() {
    const canvas = _getCanvas();
    return canvas ? canvas.parentElement : null;
  }

  function _addLights(scene) {
    const THREE = window.THREE;
    if (!THREE) return;
    scene.background = new THREE.Color(0x2a2a2e);
    const amb = new THREE.AmbientLight(0xffffff, 0.6);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.4);
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(5, 8, 5);
    const fill = new THREE.DirectionalLight(0xffffff, 1.5);
    fill.position.set(-4, 4, 6);
    const rim = new THREE.DirectionalLight(0xadd8ff, 1.0);
    rim.position.set(-3, 6, -6);
    const bottom = new THREE.DirectionalLight(0xffffff, 0.8);
    bottom.position.set(0, -5, 2);
    [amb, hemi, key, fill, rim, bottom].forEach(l => scene.add(l));

    // Grid
    const grid = new THREE.GridHelper(10, 10, 0xffffff, 0xffffff);
    grid.material.transparent = true;
    grid.material.opacity = 0.25;
    grid.position.y = -0.5;
    scene.add(grid);
  }

  function _fitCamera(camera, controls, model) {
    const THREE = window.THREE;
    if (!THREE || !model) return;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const isHumanoid = size.y > size.x * 1.5 && size.y > size.z * 1.5;
    const dir = isHumanoid
      ? new THREE.Vector3(0, 0.22, 1).normalize()
      : new THREE.Vector3(1, 1, 1).normalize();
    const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
    camera.position.copy(center).add(dir.multiplyScalar(dist * 1.4));
    camera.near = maxDim / 100;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.maxDistance = maxDim * 12;
    controls.update();
  }

  function _requestRender() {
    if (_state.renderRequested) return;
    _state.renderRequested = true;
    requestAnimationFrame(_renderFrame);
  }

  function _clearViewportModel(vp) {
    const THREE = window.THREE;
    if (!vp || !THREE || !vp.model) return;
    vp.model.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          if (m.map) m.map.dispose();
          if (m.normalMap) m.normalMap.dispose();
          if (m.roughnessMap) m.roughnessMap.dispose();
          if (m.metalnessMap) m.metalnessMap.dispose();
          if (m.emissiveMap) m.emissiveMap.dispose();
          if (m.aoMap) m.aoMap.dispose();
          m.dispose();
        });
      }
    });
    vp.scene.remove(vp.model);
    vp.model = null;
    if (vp.mixer) {
      vp.mixer.stopAllAction();
      vp.mixer.uncacheRoot(vp.mixer.getRoot());
      vp.mixer = null;
    }
    vp.clock = null;
  }

  function _syncViewportDisplay(vp, index) {
    if (!vp) return;
    const item = vp.item || {};
    const rawUrl = item.glb_url || item.glb_proxy || (item.payload && item.payload.glb_url);
    const pct = Number(item.progress_pct);
    const hasPct = Number.isFinite(pct) && pct > 0;
    const status = String(item.status || '').toLowerCase();
    const pending = !rawUrl && status !== "finished";

    if (vp.label) {
      if (vp.model) {
        vp.label.textContent = "Variant " + (index + 1);
      } else if (pending) {
        vp.label.textContent = "Variant " + (index + 1) + " — generating";
      } else if (!rawUrl) {
        vp.label.textContent = "Variant " + (index + 1) + " — waiting";
      } else {
        vp.label.textContent = "Variant " + (index + 1);
      }
      vp.label.classList.toggle("error", status === "failed" || status === "error");
    }

    if (vp.loader) {
      if (vp.model) {
        vp.loader.style.display = "none";
      } else {
        vp.loader.style.display = "";
        if (status === "failed" || status === "error") {
          vp.loader.textContent = item.error_message || "Failed to load";
          vp.loader.classList.add("error");
        } else if (hasPct) {
          vp.loader.textContent = Math.round(pct) + "%";
          vp.loader.classList.remove("error");
        } else {
          vp.loader.textContent = item.status_label || "Generating…";
          vp.loader.classList.remove("error");
        }
      }
    }
  }

  function _renderFrame() {
    _state.renderRequested = false;
    if (_state.mode === "grouped") {
      _renderGrouped();
    } else if (_state.mode === "focus") {
      _renderFocused();
    }
    // If animations are active, keep the loop going
    if (_state.animationActive) {
      _state.renderRequested = true;
      requestAnimationFrame(_renderFrame);
    }
  }

  function _renderGrouped() {
    const renderer = _getRenderer();
    if (!renderer) return;
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const count = _state.viewports.length;
    const layout = LAYOUTS[Math.min(count, 4)];
    if (!layout) return;

    renderer.setScissorTest(true);
    renderer.autoClear = false;
    renderer.clear();

    let hasAnimation = false;

    for (let i = 0; i < count; i++) {
      const vp = _state.viewports[i];
      const lp = layout[i];
      if (!lp) continue;

      const x = Math.floor(lp.x * width);
      const y = Math.floor(lp.y * height);
      const w = Math.floor(lp.w * width);
      const h = Math.floor(lp.h * height);

      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);

      vp.camera.aspect = w / h;
      vp.camera.updateProjectionMatrix();
      vp.controls.update();

      if (vp.mixer) {
        if (!vp.clock) vp.clock = new THREE.Clock();
        vp.mixer.update(vp.clock.getDelta());
        hasAnimation = true;
      }

      renderer.render(vp.scene, vp.camera);
    }

    renderer.setScissorTest(false);
    renderer.autoClear = true;

    _state.animationActive = hasAnimation;
  }

  function _renderFocused() {
    const renderer = _getRenderer();
    if (!renderer) return;
    const vp = _state.viewports[_state.focusIndex];
    if (!vp) return;
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    renderer.setViewport(0, 0, width, height);
    vp.camera.aspect = width / height;
    vp.camera.updateProjectionMatrix();
    vp.controls.update();

    if (vp.mixer) {
      if (!vp.clock) vp.clock = new THREE.Clock();
      vp.mixer.update(vp.clock.getDelta());
    }

    renderer.render(vp.scene, vp.camera);
  }

  async function openGroupedViewer(groupId, items) {
    const THREE = window.THREE;
    const renderer = _getRenderer();
    if (!THREE || !renderer) {
      console.warn("[GroupedViewer] Three.js or renderer not available. THREE:", !!THREE, "renderer:", !!renderer, "timrxRenderer:", !!window.timrxRenderer);
      // Try to restore the UI so user isn't stuck with a blank viewer
      _restoreSingleModelUI();
      return;
    }

    const container = _getContainer();
    if (!container) {
      console.warn("[GroupedViewer] Canvas container not found. Canvas:", !!_getCanvas());
      _restoreSingleModelUI();
      return;
    }

    console.log("[GroupedViewer] Opening:", groupId, "items:", items.length,
      "renderer:", !!renderer, "container:", container.id || container.className,
      "containerSize:", container.clientWidth + "x" + container.clientHeight,
      "itemUrls:", items.map(i => !!(i.glb_url || i.glb_proxy)).join(","));

    // Dispose existing grouped view
    disposeGroupedView();

    // Hide single-model view elements
    const placeholder = document.getElementById("viewerPlaceholder");
    if (placeholder) placeholder.style.display = "none";

    // Hide upload button, gear, and toolbar — not relevant in grouped mode
    const uploadBtn = document.getElementById("openUploadModalTop");
    const gearBtn = document.getElementById("viewerGear");
    const toolbar = document.getElementById("viewerToolbar");
    if (uploadBtn) uploadBtn.style.display = "none";
    if (gearBtn) gearBtn.style.display = "none";
    if (toolbar) toolbar.classList.remove("visible");

    // Hide the regular header text (we'll show our own centered banner)
    const overlayHead = document.querySelector(".viewer-overlay-head");
    if (overlayHead) overlayHead.style.display = "none";

    // Add centered selection banner above all viewports
    let banner = container.querySelector(".viewer-grouped-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "viewer-grouped-banner";
      banner.innerHTML = `
        <h3>Select a model</h3>
        <p>Click a variant to continue with refine, texture, remesh, or export.</p>
      `;
      container.appendChild(banner);
    }
    banner.style.display = "";

    _state.mode = "grouped";
    _state.groupId = groupId;
    _state.viewports = [];

    const rect = container.getBoundingClientRect();
    const count = Math.min(items.length, 4);
    const layout = LAYOUTS[count];
    if (!layout) return;

    // Create back button (hidden until focus mode)
    let backBtn = container.querySelector(".viewer-back-to-group");
    if (!backBtn) {
      backBtn = document.createElement("button");
      backBtn.className = "viewer-back-to-group";
      backBtn.textContent = "\u2190 Back to group";
      backBtn.style.display = "none";
      backBtn.addEventListener("click", function () {
        backToGroupedView();
      });
      container.appendChild(backBtn);
    }

    for (let i = 0; i < count; i++) {
      const scene = new THREE.Scene();
      _addLights(scene);

      const lp = layout[i];
      const vpW = rect.width * lp.w;
      const vpH = rect.height * lp.h;
      const camera = new THREE.PerspectiveCamera(42, vpW / vpH, 0.1, 1000);
      camera.position.set(3, 2.5, 4);

      // Overlay div for OrbitControls
      const overlay = document.createElement("div");
      overlay.className = "viewer-viewport-overlay";
      overlay.style.position = "absolute";
      // CSS coordinates: top-left origin (flip y from WebGL convention)
      overlay.style.left = (lp.x * 100) + "%";
      overlay.style.bottom = (lp.y * 100) + "%";
      overlay.style.width = (lp.w * 100) + "%";
      overlay.style.height = (lp.h * 100) + "%";
      overlay.style.cursor = "grab";
      overlay.style.zIndex = "2";
      overlay.style.touchAction = "none";
      overlay.dataset.viewportIndex = i;
      container.appendChild(overlay);

      // Controls
      const controls = new THREE.OrbitControls(camera, overlay);
      controls.enableDamping = true;
      controls.target.set(0, 0.2, 0);
      controls.addEventListener("change", _requestRender);

      // Label
      const label = document.createElement("div");
      label.className = "viewer-viewport-label";
      label.textContent = "Variant " + (i + 1);
      overlay.appendChild(label);

      // Loading indicator
      const loader = document.createElement("div");
      loader.className = "viewer-viewport-loader";
      loader.textContent = "Loading\u2026";
      overlay.appendChild(loader);

      // Single-click: open this model in the main single-model viewer
      overlay.addEventListener("click", function (e) {
        // Ignore if drag/orbit happened (movement since mousedown)
        if (overlay._wasDragging) { overlay._wasDragging = false; return; }
        e.stopPropagation();
        const clickedItem = _state.viewports[i]?.item || items[i];
        if (!clickedItem) return;
        const glbUrl = clickedItem.glb_proxy || clickedItem.glb_url;
        if (!glbUrl) return;
        // Dispose grouped view and load this model in the normal viewer
        disposeGroupedView();
        // Restore single-model UI elements
        _restoreSingleModelUI();
        // Use module-scoped isTimrxS3Url and getLoadableModelUrl
        const loadUrl = isTimrxS3Url(clickedItem.glb_url) ? clickedItem.glb_url : (clickedItem.glb_proxy || getLoadableModelUrl(clickedItem.glb_url));
        setHistoryActiveModelId(clickedItem.id);
        resetModelVersionStack({
          id: clickedItem.id,
          glb_url: loadUrl,
          thumbnail_url: clickedItem.thumbnail_url || "",
          stage: clickedItem.stage || "preview",
          prompt: clickedItem.prompt || ""
        });
        const actionBar = document.getElementById("viewerActionBar");
        if (actionBar) actionBar.classList.add("hidden");
        const primary = loadUrl;
        const fallback = (clickedItem.glb_url && clickedItem.glb_url !== primary) ? clickedItem.glb_url : null;
        // loadModelWithFallback is in the same module scope (viewer.js)
        loadModelWithFallback(primary, fallback);
        const genHint = document.getElementById("genHint");
        if (genHint) genHint.textContent = "Loading model…";
      });

      // Track dragging to distinguish click from orbit
      overlay.addEventListener("mousedown", function () { overlay._wasDragging = false; });
      overlay.addEventListener("mousemove", function () { overlay._wasDragging = true; });

      // Double-click to focus (expand one viewport to fullscreen within grouped view)
      overlay.addEventListener("dblclick", function () {
        focusModel(i);
      });

      const vp = {
        scene, camera, controls, overlay, label, loader,
        model: null, mixer: null, clock: null,
        item: items[i],
      };
      _state.viewports.push(vp);
      _syncViewportDisplay(vp, i);
    }

    _requestRender();

    // Load models sequentially to avoid overwhelming the server
    for (let i = 0; i < count; i++) {
      // Bail if user navigated away from grouped view during loading
      if (_state.mode !== "grouped" || _state.groupId !== groupId) break;
      await _loadModelIntoViewport(i, items[i]);
    }
  }

  // Shared GLTFLoader + DRACO instance for grouped viewer (avoids re-creating per model)
  var _groupedLoader = null;
  function _getGroupedLoader() {
    var THREE = window.THREE;
    if (!THREE || !THREE.GLTFLoader) return null;
    if (!_groupedLoader) {
      _groupedLoader = new THREE.GLTFLoader();
      _groupedLoader.setCrossOrigin('anonymous');
      if (THREE.DRACOLoader) {
        var draco = new THREE.DRACOLoader();
        draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        _groupedLoader.setDRACOLoader(draco);
      }
    }
    return _groupedLoader;
  }

  async function _loadModelIntoViewport(index, item) {
    const THREE = window.THREE;
    const vp = _state.viewports[index];
    if (!vp || !THREE) return;

    vp.item = { ...(vp.item || {}), ...(item || {}) };
    _syncViewportDisplay(vp, index);

    const rawUrl = vp.item.glb_url || vp.item.glb_proxy || (vp.item.payload && vp.item.payload.glb_url);
    if (!rawUrl) {
      _requestRender();
      return;
    }

    try {
      _clearViewportModel(vp);

      // Resolve URL using same logic as main viewer: prefer S3 direct, else proxy
      const resolvedUrl = isTimrxS3Url(rawUrl) ? rawUrl : (vp.item.glb_proxy || getLoadableModelUrl(rawUrl));

      const loader = _getGroupedLoader();
      if (!loader) throw new Error("GLTFLoader not available");

      const gltf = await new Promise(function (resolve, reject) {
        loader.load(resolvedUrl,
          function (g) { resolve(g); },
          undefined,
          function (err) { reject(err); }
        );
      });

      const model = gltf.scene;

      // Center and ground model
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.set(-center.x, -box.min.y - 0.5, -center.z);
      // Grid is at y=-0.5, so ground the model there

      vp.scene.add(model);
      vp.model = model;

      // Fit camera
      _fitCamera(vp.camera, vp.controls, model);

      // Animations
      if (gltf.animations && gltf.animations.length > 0) {
        vp.mixer = new THREE.AnimationMixer(model);
        vp.clock = new THREE.Clock();
        gltf.animations.forEach(function (clip) {
          vp.mixer.clipAction(clip).play();
        });
        _state.animationActive = true;
      }

      // Hide loader, update label
      _syncViewportDisplay(vp, index);

      _requestRender();
    } catch (err) {
      console.error("[GroupedViewer] Failed to load model " + index + ":", err);
      vp.item = { ...(vp.item || {}), status: "failed", error_message: err?.message || "Failed to load" };
      _syncViewportDisplay(vp, index);
    }
  }

  function reserveGroupedViewer(groupId, itemsOrCount) {
    const count = Array.isArray(itemsOrCount)
      ? Math.max(1, Math.min(itemsOrCount.length, 4))
      : Math.max(1, Math.min(parseInt(itemsOrCount, 10) || 1, 4));
    const items = Array.isArray(itemsOrCount)
      ? itemsOrCount.slice(0, 4)
      : Array.from({ length: count }, function (_, index) {
          return {
            id: groupId + ":" + (index + 1),
            batch_group_id: groupId,
            batch_count: count,
            batch_slot: index + 1,
            status: "generating",
            status_label: "Generating…",
            progress_pct: 0,
          };
        });
    openGroupedViewer(groupId, items);
    return true;
  }

  function upsertGroupedItem(groupId, item) {
    if (!groupId || !item) return false;
    const count = Math.max(1, Math.min(parseInt(item.batch_count, 10) || _state.viewports.length || 1, 4));
    const slotIndex = Math.max(0, Math.min(count - 1, (parseInt(item.batch_slot, 10) || 1) - 1));

    if (_state.groupId !== groupId || !_state.viewports.length) {
      const placeholders = Array.from({ length: count }, function (_, index) {
        if (index === slotIndex) return item;
        return {
          id: groupId + ":" + (index + 1),
          batch_group_id: groupId,
          batch_count: count,
          batch_slot: index + 1,
          status: "generating",
          status_label: "Generating…",
          progress_pct: 0,
        };
      });
      openGroupedViewer(groupId, placeholders);
      return true;
    }

    const vp = _state.viewports[slotIndex];
    if (!vp) return false;

    const prevUrl = vp.item?.glb_url || vp.item?.glb_proxy || (vp.item?.payload && vp.item.payload.glb_url);
    const nextItem = { ...(vp.item || {}), ...item };
    const nextUrl = nextItem.glb_url || nextItem.glb_proxy || (nextItem.payload && nextItem.payload.glb_url);
    vp.item = nextItem;
    _syncViewportDisplay(vp, slotIndex);

    if (nextUrl && (!vp.model || nextUrl !== prevUrl)) {
      _loadModelIntoViewport(slotIndex, nextItem);
    } else {
      _requestRender();
    }
    return true;
  }

  function focusModel(index) {
    if (index < 0 || index >= _state.viewports.length) return;
    _state.mode = "focus";
    _state.focusIndex = index;

    const count = _state.viewports.length;
    const layout = LAYOUTS[Math.min(count, 4)];

    // Show only focused overlay, fullscreen
    _state.viewports.forEach(function (vp, i) {
      if (i === index) {
        vp.overlay.style.left = "0";
        vp.overlay.style.bottom = "0";
        vp.overlay.style.width = "100%";
        vp.overlay.style.height = "100%";
        vp.overlay.style.display = "block";
        vp.label.textContent = "Variant " + (i + 1) + " (focused)";
      } else {
        vp.overlay.style.display = "none";
      }
    });

    // Show back button
    const container = _getContainer();
    if (container) {
      const btn = container.querySelector(".viewer-back-to-group");
      if (btn) btn.style.display = "block";
    }

    _requestRender();
  }

  function backToGroupedView() {
    _state.mode = "grouped";
    _state.focusIndex = -1;

    const count = _state.viewports.length;
    const layout = LAYOUTS[Math.min(count, 4)];

    _state.viewports.forEach(function (vp, i) {
      const lp = layout[i];
      if (!lp) return;
      vp.overlay.style.display = "block";
      vp.overlay.style.left = (lp.x * 100) + "%";
      vp.overlay.style.bottom = (lp.y * 100) + "%";
      vp.overlay.style.width = (lp.w * 100) + "%";
      vp.overlay.style.height = (lp.h * 100) + "%";
      vp.label.textContent = "Variant " + (i + 1);
      vp.label.classList.remove("error");
    });

    // Hide back button
    const container = _getContainer();
    if (container) {
      const btn = container.querySelector(".viewer-back-to-group");
      if (btn) btn.style.display = "none";
    }

    _requestRender();
  }

  function _restoreSingleModelUI() {
    const ph = document.getElementById("viewerPlaceholder");
    if (ph) ph.style.display = "";
    const uploadBtn = document.getElementById("openUploadModalTop");
    const gearBtn = document.getElementById("viewerGear");
    if (uploadBtn) uploadBtn.style.display = "";
    if (gearBtn) gearBtn.style.display = "";
    // Restore the regular header
    const overlayHead = document.querySelector(".viewer-overlay-head");
    if (overlayHead) overlayHead.style.display = "";
    // Remove grouped banner
    const container = _getContainer();
    if (container) {
      const banner = container.querySelector(".viewer-grouped-banner");
      if (banner) banner.style.display = "none";
    }
  }

  function disposeGroupedView() {
    const THREE = window.THREE;
    _state.viewports.forEach(function (vp) {
      if (vp.model && THREE) {
        vp.model.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(function (m) {
              if (m.map) m.map.dispose();
              if (m.normalMap) m.normalMap.dispose();
              if (m.roughnessMap) m.roughnessMap.dispose();
              if (m.metalnessMap) m.metalnessMap.dispose();
              if (m.emissiveMap) m.emissiveMap.dispose();
              if (m.aoMap) m.aoMap.dispose();
              m.dispose();
            });
          }
        });
        vp.scene.remove(vp.model);
      }
      if (vp.mixer) {
        vp.mixer.stopAllAction();
        vp.mixer.uncacheRoot(vp.mixer.getRoot());
      }
      if (vp.controls) vp.controls.dispose();
      if (vp.overlay) vp.overlay.remove();
    });

    _state.viewports = [];
    _state.mode = "empty";
    _state.groupId = null;
    _state.focusIndex = -1;
    _state.animationActive = false;

    // Reset renderer viewport/scissor to full canvas so the main viewer
    // isn't stuck rendering into the last grouped-view quadrant.
    var renderer = window.timrxRenderer;
    if (renderer) {
      var canvas = renderer.domElement;
      if (canvas) {
        var w = canvas.clientWidth || canvas.width;
        var h = canvas.clientHeight || canvas.height;
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        renderer.setScissor(0, 0, w, h);
        renderer.autoClear = true;
        renderer.clear();
      }
    }

    // Remove back button
    const container = _getContainer();
    if (container) {
      const btn = container.querySelector(".viewer-back-to-group");
      if (btn) btn.style.display = "none";
    }
  }

  function handleResize() {
    if (_state.mode !== "grouped" && _state.mode !== "focus") return;
    _requestRender();
  }

  function getState() {
    return { mode: _state.mode, groupId: _state.groupId, focusIndex: _state.focusIndex, viewportCount: _state.viewports.length };
  }

  function isGroupedActive() {
    return _state.mode === "grouped" || _state.mode === "focus";
  }

  // Expose API
  window.GroupedViewer = {
    open: openGroupedViewer,
    reserve: reserveGroupedViewer,
    upsertItem: upsertGroupedItem,
    focus: focusModel,
    backToGroup: backToGroupedView,
    dispose: disposeGroupedView,
    resize: handleResize,
    requestRender: _requestRender,
    getState: getState,
    isActive: isGroupedActive,
  };

  // Also expose as the function the history panel calls
  window.openGroupedViewer = openGroupedViewer;

  // Listen for resize
  window.addEventListener("resize", handleResize);
})();
