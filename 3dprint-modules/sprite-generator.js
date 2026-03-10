/**
 * ============================================================================
 * SPRITE GENERATOR - Capture rotation frames from GLB models
 * ============================================================================
 *
 * This utility captures frames from a rotating 3D model and generates:
 * - A horizontal sprite sheet (all frames in one row)
 * - Individual frame images (optional)
 *
 * USAGE:
 * 1. Open 3dprint.html in a browser
 * 2. Open browser console
 * 3. Run: await SpriteGenerator.generate('path/to/model.glb', { frames: 24 })
 * 4. Sprite sheet will auto-download
 *
 * Or use the UI:
 * SpriteGenerator.showUI()
 */

(function() {
  'use strict';

  const CONFIG = {
    DEFAULT_FRAMES: 24,        // Number of frames for full rotation
    DEFAULT_SIZE: 400,         // Frame size in pixels (square)
    BACKGROUND: '#0d0d0d',     // Background color (or 'transparent')
    EXPOSURE: 0.4,
    CAMERA_DISTANCE: 2.8,
    OUTPUT_FORMAT: 'png',      // 'png' or 'webp'
    OUTPUT_QUALITY: 0.92       // For webp
  };

  // =========================================================================
  // THREE.JS RENDERER SETUP
  // =========================================================================

  let renderer = null;
  let scene = null;
  let camera = null;
  let currentModel = null;

  function initRenderer(size) {
    if (renderer) {
      renderer.dispose();
    }

    // Create offscreen canvas
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    // Scene
    scene = new THREE.Scene();
    if (CONFIG.BACKGROUND === 'transparent') {
      scene.background = null;
    } else {
      scene.background = new THREE.Color(CONFIG.BACKGROUND);
    }

    // Camera
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(0, 0, CONFIG.CAMERA_DISTANCE);

    // Renderer
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: CONFIG.BACKGROUND === 'transparent',
      preserveDrawingBuffer: true
    });
    renderer.setSize(size, size);
    renderer.setPixelRatio(1); // Fixed for consistent output
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CONFIG.EXPOSURE;

    // Lighting - studio setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(5, 5, 5);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-5, 2, 3);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
    rimLight.position.set(0, 3, -5);
    scene.add(rimLight);

    const bottomLight = new THREE.DirectionalLight(0xffffff, 0.15);
    bottomLight.position.set(0, -3, 0);
    scene.add(bottomLight);

    return { canvas, renderer, scene, camera };
  }

  // =========================================================================
  // MODEL LOADING
  // =========================================================================

  async function loadModel(url) {
    return new Promise((resolve, reject) => {
      if (!window.THREE?.GLTFLoader) {
        reject(new Error('GLTFLoader not available. Make sure Three.js is loaded.'));
        return;
      }

      const loader = new THREE.GLTFLoader();

      // Add DRACOLoader if available
      if (window.THREE?.DRACOLoader) {
        const dracoLoader = new THREE.DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        loader.setDRACOLoader(dracoLoader);
      }

      loader.load(
        url,
        (gltf) => {
          const model = gltf.scene;

          // Center and scale model
          const box = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);

          // Center
          model.position.x = -center.x;
          model.position.y = -center.y;
          model.position.z = -center.z;

          // Scale to fit
          const scale = 1.8 / maxDim;
          model.scale.setScalar(scale);

          resolve(model);
        },
        undefined,
        (error) => reject(error)
      );
    });
  }

  // =========================================================================
  // FRAME CAPTURE
  // =========================================================================

  function captureFrame(canvas) {
    return canvas.toDataURL(
      CONFIG.OUTPUT_FORMAT === 'webp' ? 'image/webp' : 'image/png',
      CONFIG.OUTPUT_QUALITY
    );
  }

  async function captureRotationFrames(model, options = {}) {
    const {
      frames = CONFIG.DEFAULT_FRAMES,
      size = CONFIG.DEFAULT_SIZE,
      startAngle = 0,
      onProgress = null
    } = options;

    const { canvas } = initRenderer(size);

    // Remove old model, add new
    if (currentModel) {
      scene.remove(currentModel);
    }
    currentModel = model;
    scene.add(model);

    // Position camera based on model
    camera.position.set(0, size * 0.0003, CONFIG.CAMERA_DISTANCE);
    camera.lookAt(0, 0, 0);

    const capturedFrames = [];
    const angleStep = (Math.PI * 2) / frames;

    for (let i = 0; i < frames; i++) {
      const angle = startAngle + (i * angleStep);
      model.rotation.y = angle;

      renderer.render(scene, camera);

      const frameData = captureFrame(canvas);
      capturedFrames.push(frameData);

      if (onProgress) {
        onProgress(i + 1, frames);
      }

      // Small delay to prevent blocking
      await new Promise(r => setTimeout(r, 10));
    }

    return capturedFrames;
  }

  // =========================================================================
  // SPRITE SHEET GENERATION
  // =========================================================================

  async function createSpriteSheet(frames, options = {}) {
    const {
      size = CONFIG.DEFAULT_FRAMES,
      layout = 'horizontal' // 'horizontal' or 'grid'
    } = options;

    const frameCount = frames.length;

    // Calculate dimensions
    let cols, rows;
    if (layout === 'horizontal') {
      cols = frameCount;
      rows = 1;
    } else {
      // Grid layout (square-ish)
      cols = Math.ceil(Math.sqrt(frameCount));
      rows = Math.ceil(frameCount / cols);
    }

    // Get actual frame dimensions from first frame
    const firstFrame = await loadImage(frames[0]);
    const frameWidth = firstFrame.width;
    const frameHeight = firstFrame.height;

    // Create sprite sheet canvas
    const canvas = document.createElement('canvas');
    canvas.width = cols * frameWidth;
    canvas.height = rows * frameHeight;
    const ctx = canvas.getContext('2d');

    // Draw each frame
    for (let i = 0; i < frameCount; i++) {
      const img = await loadImage(frames[i]);
      const col = i % cols;
      const row = Math.floor(i / cols);
      ctx.drawImage(img, col * frameWidth, row * frameHeight);
    }

    return canvas.toDataURL('image/png');
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // =========================================================================
  // FILE DOWNLOAD
  // =========================================================================

  function downloadDataUrl(dataUrl, filename) {
    if (!window.WorkspaceCredits?.canDownloadAssets?.()) {
      if (confirm('You need credits to download assets.\n\nWould you like to get credits?')) window.location.href = 'hub.html#pricing';
      return;
    }
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function getFilenameFromUrl(url) {
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace(/\.(glb|gltf)$/i, '');
  }

  // =========================================================================
  // MAIN API
  // =========================================================================

  async function generate(modelUrl, options = {}) {
    const {
      frames = CONFIG.DEFAULT_FRAMES,
      size = CONFIG.DEFAULT_SIZE,
      download = true,
      downloadIndividual = false,
      onProgress = null
    } = options;

    console.log(`[SpriteGenerator] Loading model: ${modelUrl}`);

    try {
      const model = await loadModel(modelUrl);
      console.log(`[SpriteGenerator] Model loaded. Capturing ${frames} frames...`);

      const capturedFrames = await captureRotationFrames(model, {
        frames,
        size,
        onProgress: (current, total) => {
          console.log(`[SpriteGenerator] Frame ${current}/${total}`);
          if (onProgress) onProgress(current, total);
        }
      });

      console.log(`[SpriteGenerator] Creating sprite sheet...`);
      const spriteSheet = await createSpriteSheet(capturedFrames, { size, layout: 'horizontal' });

      const baseName = getFilenameFromUrl(modelUrl);

      if (download) {
        downloadDataUrl(spriteSheet, `${baseName}_sprite_${frames}f.png`);
        console.log(`[SpriteGenerator] Downloaded: ${baseName}_sprite_${frames}f.png`);
      }

      if (downloadIndividual) {
        for (let i = 0; i < capturedFrames.length; i++) {
          downloadDataUrl(capturedFrames[i], `${baseName}_frame_${String(i).padStart(2, '0')}.png`);
        }
        console.log(`[SpriteGenerator] Downloaded ${capturedFrames.length} individual frames`);
      }

      // Cleanup
      if (currentModel) {
        scene.remove(currentModel);
        currentModel = null;
      }

      return {
        spriteSheet,
        frames: capturedFrames,
        frameCount: frames,
        frameSize: size
      };

    } catch (error) {
      console.error('[SpriteGenerator] Error:', error);
      throw error;
    }
  }

  // =========================================================================
  // BATCH PROCESSING
  // =========================================================================

  async function generateBatch(modelUrls, options = {}) {
    const results = [];

    for (let i = 0; i < modelUrls.length; i++) {
      console.log(`[SpriteGenerator] Processing ${i + 1}/${modelUrls.length}: ${modelUrls[i]}`);
      try {
        const result = await generate(modelUrls[i], options);
        results.push({ url: modelUrls[i], success: true, result });
      } catch (error) {
        results.push({ url: modelUrls[i], success: false, error: error.message });
      }
    }

    console.log('[SpriteGenerator] Batch complete');
    return results;
  }

  // =========================================================================
  // UI OVERLAY (optional)
  // =========================================================================

  function showUI() {
    // Remove existing UI
    const existing = document.getElementById('sprite-generator-ui');
    if (existing) existing.remove();

    const ui = document.createElement('div');
    ui.id = 'sprite-generator-ui';
    ui.innerHTML = `
      <style>
        #sprite-generator-ui {
          position: fixed;
          top: 20px;
          right: 20px;
          width: 320px;
          background: rgba(15, 15, 15, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 20px;
          z-index: 99999;
          font-family: system-ui, sans-serif;
          color: #fff;
          backdrop-filter: blur(10px);
        }
        #sprite-generator-ui h3 {
          margin: 0 0 16px;
          font-size: 14px;
          font-weight: 600;
          color: #fff;
        }
        #sprite-generator-ui label {
          display: block;
          margin-bottom: 6px;
          font-size: 11px;
          font-weight: 500;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        #sprite-generator-ui input[type="text"],
        #sprite-generator-ui input[type="number"] {
          width: 100%;
          padding: 10px 12px;
          background: rgba(0, 0, 0, 0.4);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          color: #fff;
          font-size: 13px;
          margin-bottom: 12px;
          box-sizing: border-box;
        }
        #sprite-generator-ui input:focus {
          outline: none;
          border-color: #0ea5e9;
        }
        #sprite-generator-ui .row {
          display: flex;
          gap: 12px;
        }
        #sprite-generator-ui .row > div {
          flex: 1;
        }
        #sprite-generator-ui button {
          width: 100%;
          padding: 12px;
          background: linear-gradient(135deg, #0ea5e9, #8b5cf6);
          border: none;
          border-radius: 8px;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, opacity 0.2s;
        }
        #sprite-generator-ui button:hover {
          transform: scale(1.02);
        }
        #sprite-generator-ui button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
        }
        #sprite-generator-ui .close {
          position: absolute;
          top: 12px;
          right: 12px;
          width: 24px;
          height: 24px;
          background: none;
          border: none;
          color: #666;
          font-size: 18px;
          cursor: pointer;
          padding: 0;
        }
        #sprite-generator-ui .close:hover {
          color: #fff;
        }
        #sprite-generator-ui .progress {
          margin-top: 12px;
          padding: 10px;
          background: rgba(0, 0, 0, 0.3);
          border-radius: 8px;
          font-size: 12px;
          color: #888;
          display: none;
        }
        #sprite-generator-ui .progress.active {
          display: block;
        }
        #sprite-generator-ui .progress-bar {
          height: 4px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
          margin-top: 8px;
          overflow: hidden;
        }
        #sprite-generator-ui .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #0ea5e9, #8b5cf6);
          width: 0%;
          transition: width 0.2s;
        }
      </style>
      <button class="close" onclick="this.parentElement.remove()">×</button>
      <h3>Sprite Sheet Generator</h3>
      <label>GLB Model URL</label>
      <input type="text" id="sg-url" placeholder="3dprint-modules/3dmodels/model.glb" />
      <div class="row">
        <div>
          <label>Frames</label>
          <input type="number" id="sg-frames" value="24" min="8" max="60" />
        </div>
        <div>
          <label>Size (px)</label>
          <input type="number" id="sg-size" value="400" min="200" max="800" />
        </div>
      </div>
      <button id="sg-generate">Generate Sprite Sheet</button>
      <div class="progress" id="sg-progress">
        <span id="sg-status">Initializing...</span>
        <div class="progress-bar">
          <div class="progress-fill" id="sg-fill"></div>
        </div>
      </div>
    `;
    document.body.appendChild(ui);

    // Bind generate button
    document.getElementById('sg-generate').addEventListener('click', async () => {
      const url = document.getElementById('sg-url').value.trim();
      const frames = parseInt(document.getElementById('sg-frames').value, 10);
      const size = parseInt(document.getElementById('sg-size').value, 10);

      if (!url) {
        alert('Please enter a model URL');
        return;
      }

      const btn = document.getElementById('sg-generate');
      const progress = document.getElementById('sg-progress');
      const status = document.getElementById('sg-status');
      const fill = document.getElementById('sg-fill');

      btn.disabled = true;
      progress.classList.add('active');

      try {
        await generate(url, {
          frames,
          size,
          onProgress: (current, total) => {
            const pct = Math.round((current / total) * 100);
            status.textContent = `Capturing frame ${current}/${total}...`;
            fill.style.width = `${pct}%`;
          }
        });
        status.textContent = 'Done! Sprite sheet downloaded.';
        fill.style.width = '100%';
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
        fill.style.background = '#ef4444';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // =========================================================================
  // EXPORT
  // =========================================================================

  window.SpriteGenerator = {
    generate,
    generateBatch,
    showUI,
    CONFIG
  };

  console.log('[SpriteGenerator] Ready. Use SpriteGenerator.showUI() or SpriteGenerator.generate(url)');

})();
