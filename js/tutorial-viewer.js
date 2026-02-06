/**
 * tutorial-viewer.js
 * Lightweight 3D model viewer for tutorial sections.
 * Uses the same Three.js instance as the main app to avoid duplicate loading.
 */

import { onThreeReady, log } from './config.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ROTATION_SPEED = 0.5; // radians per second (~30deg/s)
const CAMERA_DISTANCE_FACTOR = 2.5;
const EXPOSURE = 0.35;

// ============================================================================
// STATE
// ============================================================================

const viewers = new Map(); // id -> { scene, camera, renderer, model, container, isRefined }
let animationId = null;
let lastTime = 0;

// ============================================================================
// VIEWER CREATION
// ============================================================================

/**
 * Initialize a tutorial viewer in the given container
 * @param {HTMLElement} container - Container element with data-src, data-preview, data-refined
 */
function createViewer(container) {
  if (!window.THREE) {
    log('[TutorialViewer] THREE not ready');
    return null;
  }

  const id = container.id || `tutorial-viewer-${viewers.size}`;
  const src = container.dataset.src || container.dataset.preview;

  if (!src) {
    log('[TutorialViewer] No src specified for', id);
    return null;
  }

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  container.appendChild(canvas);

  // Scene setup
  const scene = new THREE.Scene();

  // Camera
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(0, 0, 5);

  // Renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;

  // Lighting - simple studio setup
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(5, 5, 5);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-5, 0, 5);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
  rimLight.position.set(0, 5, -5);
  scene.add(rimLight);

  // Store viewer state
  const viewer = {
    id,
    container,
    canvas,
    scene,
    camera,
    renderer,
    model: null,
    isRefined: false,
    isVisible: false,
    previewSrc: container.dataset.preview || src,
    refinedSrc: container.dataset.refined || null,
    rotation: 0
  };

  viewers.set(id, viewer);

  // Load initial model
  loadModel(viewer, src);

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width > 0 && height > 0) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
  });
  resizeObserver.observe(container);

  // Intersection observer for visibility-based animation
  const intersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      viewer.isVisible = entry.isIntersecting;
    });
  }, { threshold: 0.1 });
  intersectionObserver.observe(container);

  // Click handler for toggle (if has refined version)
  if (viewer.refinedSrc) {
    container.style.cursor = 'pointer';
    container.addEventListener('click', () => toggleRefined(viewer));
  }

  return viewer;
}

/**
 * Load a GLB model into the viewer
 */
function loadModel(viewer, url) {
  if (!window.THREE?.GLTFLoader) {
    log('[TutorialViewer] GLTFLoader not available');
    return;
  }

  const loader = new THREE.GLTFLoader();

  // Remove existing model
  if (viewer.model) {
    viewer.scene.remove(viewer.model);
    viewer.model.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    viewer.model = null;
  }

  loader.load(
    url,
    (gltf) => {
      const model = gltf.scene;
      viewer.model = model;
      viewer.scene.add(model);

      // Center and scale model
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);

      // Center the model
      model.position.x = -center.x;
      model.position.y = -center.y;
      model.position.z = -center.z;

      // Position camera based on model size
      const distance = maxDim * CAMERA_DISTANCE_FACTOR;
      viewer.camera.position.set(0, maxDim * 0.3, distance);
      viewer.camera.lookAt(0, 0, 0);

      log('[TutorialViewer] Loaded:', url);
    },
    undefined,
    (error) => {
      console.error('[TutorialViewer] Load error:', url, error);
    }
  );
}

/**
 * Toggle between preview and refined model
 */
function toggleRefined(viewer) {
  if (!viewer.refinedSrc) return;

  viewer.isRefined = !viewer.isRefined;
  const newSrc = viewer.isRefined ? viewer.refinedSrc : viewer.previewSrc;
  loadModel(viewer, newSrc);

  // Update hint if present
  const hint = viewer.container.parentElement?.querySelector('.model-toggle-hint');
  if (hint) {
    hint.classList.toggle('refined', viewer.isRefined);
    // The hint text is set via data attributes
    const previewHint = viewer.container.dataset.previewHint || 'Click model to view refined version';
    const refinedHint = viewer.container.dataset.refinedHint || 'Click model to view preview version';
    hint.textContent = viewer.isRefined ? refinedHint : previewHint;
  }
}

// ============================================================================
// ANIMATION LOOP
// ============================================================================

function animate(time) {
  animationId = requestAnimationFrame(animate);

  const delta = (time - lastTime) / 1000;
  lastTime = time;

  if (delta > 0.1) return; // Skip large deltas (tab was inactive)

  viewers.forEach(viewer => {
    if (!viewer.isVisible || !viewer.model) return;

    // Auto-rotate
    viewer.rotation += ROTATION_SPEED * delta;
    viewer.model.rotation.y = viewer.rotation;

    // Render
    viewer.renderer.render(viewer.scene, viewer.camera);
  });
}

function startAnimation() {
  if (animationId) return;
  lastTime = performance.now();
  animationId = requestAnimationFrame(animate);
  log('[TutorialViewer] Animation started');
}

function stopAnimation() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
    log('[TutorialViewer] Animation stopped');
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize all tutorial viewers on the page
 */
export function initTutorialViewers() {
  onThreeReady(() => {
    log('[TutorialViewer] Initializing...');

    // Find all tutorial viewer containers
    const containers = document.querySelectorAll('.tutorial-3d-viewer');

    if (containers.length === 0) {
      log('[TutorialViewer] No viewers found');
      return;
    }

    containers.forEach(container => {
      createViewer(container);
    });

    log('[TutorialViewer] Created', viewers.size, 'viewers');

    // Start animation loop
    startAnimation();

    // Pause when page is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopAnimation();
      } else {
        startAnimation();
      }
    });
  });
}

/**
 * Get a viewer by ID
 */
export function getViewer(id) {
  return viewers.get(id);
}

/**
 * Manually toggle a viewer's refined state
 */
export function toggleViewerRefined(id) {
  const viewer = viewers.get(id);
  if (viewer) {
    toggleRefined(viewer);
  }
}

// Auto-init on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTutorialViewers);
} else {
  initTutorialViewers();
}
