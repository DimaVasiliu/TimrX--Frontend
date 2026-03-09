/**
 * viewer.js
 * Interacts with Three.js. Assumes 3dprint-app.js has already created the scene,
 * and this module simply hooks into it to load models and move the camera.
 *
 * IMPORTANT: All functions guard against missing WebGL/scene/renderer to prevent crashes.
 */

import { byId, log } from './config.js';

let scene, camera, renderer, controls;
let viewerPlaceholder = null;
let currentModel = null;
let demoCube, grid;

// Animation playback state
let mixer = null;
let animationClock = null;
let currentAnimations = [];
let animFrameId = null;

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

    const loader = new THREE.GLTFLoader();
    loader.setCrossOrigin('anonymous');

    clearModel();

    return new Promise((resolve, reject) => {
        loader.load(url, (gltf) => {
            currentModel = gltf.scene;

            // Double-check scene is still valid before adding
            if (!scene) {
                reject(new Error('Scene became unavailable'));
                return;
            }

            scene.add(currentModel);

            // Center model
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

    // Move camera to a nice angle
    const direction = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(size / offset));
}

// ---- Animation playback ----

export function stopAnimation() {
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    if (mixer) {
        currentAnimations.forEach(a => a.stop());
        currentAnimations = [];
        mixer = null;
    }
    animationClock = null;
    const ctrl = byId('animationPlaybackControls');
    if (ctrl) ctrl.style.display = 'none';
}

export async function loadAnimatedModel(primaryUrl, fallbackUrl) {
    if (!isViewerReady()) {
        showViewerUnavailableMessage('load animated model');
        throw new Error('3D viewer not available (WebGL disabled)');
    }
    try {
        await loadAnimatedGlb(primaryUrl);
    } catch (err) {
        if (fallbackUrl) await loadAnimatedGlb(fallbackUrl);
        else throw err;
    }
}

async function loadAnimatedGlb(url) {
    if (!(window.THREE && THREE.GLTFLoader)) throw new Error('GLTFLoader missing');

    const loader = new THREE.GLTFLoader();
    loader.setCrossOrigin('anonymous');

    stopAnimation();
    clearModel();

    return new Promise((resolve, reject) => {
        loader.load(url, (gltf) => {
            currentModel = gltf.scene;
            if (!scene) { reject(new Error('Scene unavailable')); return; }

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

            // Set up animation if clips exist
            if (gltf.animations && gltf.animations.length > 0) {
                mixer = new THREE.AnimationMixer(currentModel);
                animationClock = new THREE.Clock();
                currentAnimations = [];

                gltf.animations.forEach(clip => {
                    const action = mixer.clipAction(clip);
                    action.play();
                    currentAnimations.push(action);
                });

                const ctrl = byId('animationPlaybackControls');
                if (ctrl) ctrl.style.display = '';

                function animateLoop() {
                    if (!mixer) return;
                    animFrameId = requestAnimationFrame(animateLoop);
                    const delta = animationClock.getDelta();
                    mixer.update(delta);
                    if (renderer) renderer.render(scene, camera);
                }
                animateLoop();
            }

            resolve();
        }, undefined, reject);
    });
}

export function toggleAnimationPlayback() {
    if (!mixer || currentAnimations.length === 0) return;
    const paused = !currentAnimations[0].paused;
    currentAnimations.forEach(a => { a.paused = paused; });
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
