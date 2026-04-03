/**
 * viewer.js
 * Interacts with Three.js. Assumes 3dprint-app.js has already created the scene,
 * and this module simply hooks into it to load models and move the camera.
 *
 * IMPORTANT: All functions guard against missing WebGL/scene/renderer to prevent crashes.
 */

import { byId, log, isTimrxS3Url } from './config.js';

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
