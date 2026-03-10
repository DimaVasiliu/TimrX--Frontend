/* ============================================================================
   TimrX 3D Print Workspace
   - Rail panel switching (Image / Model / Remesh / Texture / Video)
   - Left panel content injection (cards per tool)
   - Three.js viewer bootstrap + resize (model/remesh/texture)
   - Upload Modal (centered overlay, ESC/backdrop close, body scroll lock)
   - GLB/GLTF loader + auto center/scale + controls target
   ============================================================================ */

   (function initTimrxWorkspace() {
    'use strict';
  
    /* -------------------------------------------------------------------------
     * QUICK DOM HOOKS
     * ---------------------------------------------------------------------- */
    const workspaceRoot = document.querySelector('.timrx-3dprint');
    if (!workspaceRoot) return;
  
    const railButtons   = workspaceRoot.querySelectorAll('.rail-btn');
    const leftStack     = document.getElementById('leftStack');
  
    // Center viewer + titles
    const viewerTitle   = document.getElementById('viewerTitle');
    const genHint       = document.getElementById('genHint');
    const model3dWrap   = document.getElementById('model3dViewer');
    const imageViewer   = document.getElementById('imageViewer');
    const videoViewer   = document.getElementById('videoViewer');
    const viewerCanvas  = document.getElementById('viewerCanvas');
    const viewerEmpty   = document.getElementById('viewerPlaceholder');
    const viewerGear    = document.getElementById('viewerGear');
    const rotateCard    = document.getElementById('viewerRotateCard');
    const rotateToggle  = document.getElementById('rotateToggle');
  
    // Modal elements
    const uploadModal       = document.getElementById('uploadModal');
    const openUploadTopBtn  = document.getElementById('openUploadModalTop');
    const closeUploadBtn    = document.getElementById('closeUpload');
    const cancelUploadBtn   = document.getElementById('cancelUpload');
    const continueUploadBtn = document.getElementById('continueUpload');
    const modelDrop         = document.getElementById('modelDrop');
    const customModelUpload = document.getElementById('customModelUpload');
    const modelFileHint     = document.getElementById('modelFileHint');
    const modelNameInput    = document.getElementById('modelNameInput');
  
    // Short-circuit if the basic workspace shell is missing
    if (!railButtons.length || !leftStack || !viewerCanvas) return;
  
    /* -------------------------------------------------------------------------
     * WORKSPACE STATE
     * ---------------------------------------------------------------------- */
    const rotationState = { enabled: true, speed: 0.004 };
    let threeBooted = false;
    let placeholderCube = null;
    let selectedFile = null;

    /* -------------------------------------------------------------------------
     * WEBGL DETECTION
     * ---------------------------------------------------------------------- */
    /**
     * Detects if WebGL is available in the browser.
     * @returns {boolean} True if WebGL is supported.
     */
    function detectWebGL() {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') ||
                   canvas.getContext('webgl') ||
                   canvas.getContext('experimental-webgl');
        if (gl) {
          // Check for context loss (some devices report WebGL but can't create contexts)
          if (gl.isContextLost && gl.isContextLost()) {
            console.warn('[Viewer] WebGL context is lost');
            return false;
          }
          return true;
        }
        return false;
      } catch (e) {
        console.warn('[Viewer] WebGL detection failed:', e.message);
        return false;
      }
    }

    // Detect WebGL on init and expose globally
    const webglAvailable = detectWebGL();
    window.timrxViewerAvailable = webglAvailable;

    if (!webglAvailable) {
      console.warn('[Viewer] WebGL is not available. 3D preview will be disabled.');
    }
  
    /* -------------------------------------------------------------------------
     * PANEL CONTENT TEMPLATES (left control column)
     * ---------------------------------------------------------------------- */
    const panelContent = {
      image: `
        <div class="card">
          <h3>Generate Image</h3>
          <label for="imagePrompt">Describe Your Image</label>
          <textarea id="imagePrompt" placeholder="A futuristic cityscape at sunset with flying cars..."></textarea>
          <div class="enhance-row">
            <span class="field-hint">Be detailed and specific for best results</span>
            <button type="button" class="enhance-btn" data-enhance-mode="image" data-enhance-target="#imagePrompt" title="Make this prompt clearer and more detailed">
              <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
              <span class="enhance-btn-label">Enhance</span>
            </button>
          </div>
          <div class="enhance-feedback hidden" data-enhance-feedback="image"></div>
        </div>

        <div class="card">
          <h3>Options</h3>
          <div class="inline-field">
            <label for="imageAIProvider">Provider</label>
            <select id="imageAIProvider">
              <option value="openai" selected>OpenAI</option>
              <option value="google">Google (Imagen)</option>
            </select>
          </div>
          <div class="provider-lock-hint hidden" id="imageProviderLockHint">
            <i class="fa-solid fa-lock"></i> <span id="imageProviderLockText">Provider locked while generating.</span>
          </div>

          <!-- Shape (controls aspect ratio only) -->
          <div class="inline-field" id="imageShapeRow">
            <label for="imageShape">Shape</label>
            <select id="imageShape">
              <option value="square" selected>Square</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <span class="field-hint" id="imageShapeHint">Shape controls layout, not quality.</span>

          <!-- Quality (controls resolution per provider) -->
          <div class="inline-field" id="imageQualityRow">
            <label for="imageQuality">Quality</label>
            <select id="imageQuality">
              <option value="standard" selected>Standard (5c)</option>
              <option value="high">2K (7c)</option>
            </select>
          </div>
          <span class="field-hint" id="imageQualityHint">Standard 5c • 2K 7c</span>

          <div class="provider-hint" id="imageProviderHint"></div>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time" id="imageGenTime">30 sec</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits" id="imageCreditsDisplay"><i class="fa-solid fa-coins"></i> 5</span>
          </div>
          <button type="button" id="generateImageBtn" class="gen-btn" title="5 credits" data-provider="openai">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21"/></svg>
            Generate
          </button>
        </div>
      `,
  
      model: `
        <div class="card">
          <div style="display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:8px">
            <button type="button" class="tab-btn active" data-tab="text3d" style="flex:1;background:rgba(255,255,255,.1);border:none;border-radius:6px;padding:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:background .2s ease">
              Text to 3D
            </button>
            <button type="button" class="tab-btn" data-tab="image3d" style="flex:1;background:transparent;border:none;border-radius:6px;padding:8px;color:#888;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s ease">
              Image to 3D
            </button>
          </div>

          <div class="tab-content active" id="text3d">
            <label for="modelPrompt">Describe Your Model</label>
            <textarea id="modelPrompt" placeholder="A futuristic gaming chair with RGB lighting..."></textarea>
            <div class="enhance-row">
              <span class="field-hint">Be specific for better results</span>
              <button type="button" class="enhance-btn" data-enhance-mode="model" data-enhance-target="#modelPrompt" title="Make this prompt clearer and more detailed">
                <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
                <span class="enhance-btn-label">Enhance</span>
              </button>
            </div>
            <div class="enhance-feedback hidden" data-enhance-feedback="model"></div>
          </div>

          <div class="tab-content hidden" id="image3d">
            <div class="inline-field" style="margin-bottom:10px">
              <label for="imageModelName" style="font-size:12px">Name</label>
              <input type="text" id="imageModelName" placeholder="My 3D Model" style="width:100%;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:7px;color:#fff;font-size:12px" />
            </div>
            <label for="modelImageUpload" class="video-section-label">Upload Reference Image</label>
            <div class="video-image-grid compact">
              <div id="modelImageDrop" class="video-drop-zone">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>Upload</span>
                <input type="file" id="modelImageUpload" accept="image/*" hidden />
              </div>
              <div class="video-preview-wrap">
                <img id="modelImagePreview" class="video-preview-img" alt="Preview"/>
                <div class="video-preview-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <path d="M21 15l-5-5L5 21"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card gen-options-card">
          <div class="field-row">
            <span class="field-label-inline">AI Model <span class="info-dot" title="Select the AI model version">ⓘ</span></span>
            <select id="modelAIModel" class="field-select-inline">
              <option value="latest" selected>Meshy 6 Preview</option>
              <option value="meshy-5">Meshy 5</option>
              <option value="meshy-4">Meshy 4</option>
            </select>
          </div>

          <div class="field-row">
            <span class="field-label-inline">A/T Pose <span class="info-dot" title="Generate in A-pose or T-pose for rigging">ⓘ</span></span>
            <label class="toggle-switch">
              <input type="checkbox" id="modelPoseToggle">
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="field-row">
            <span class="field-label-inline">Number of Generations</span>
            <div class="stepper-input">
              <input type="number" id="modelBatchCount" value="1" min="1" max="4">
              <div class="stepper-arrows">
                <button type="button" class="stepper-up" aria-label="Increase">▲</button>
                <button type="button" class="stepper-down" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          <div class="field-group">
            <span class="field-label-inline">License <span class="info-dot" title="Choose license type">ⓘ</span></span>
            <div class="segment-group" data-segment-group data-target="#modelLicense">
              <button type="button" class="segment" data-value="cc-by-4">CC BY 4.0</button>
              <button type="button" class="segment is-active" data-value="private">Private</button>
            </div>
            <input type="hidden" id="modelLicense" value="private">
          </div>

          <div class="field-group">
            <span class="field-label-inline">Symmetry</span>
            <div class="segment-group" data-segment-group data-target="#modelSymmetry">
              <button type="button" class="segment" data-value="off">Off</button>
              <button type="button" class="segment is-active" data-value="auto">Auto</button>
              <button type="button" class="segment" data-value="on">On</button>
            </div>
            <input type="hidden" id="modelSymmetry" value="auto">
          </div>

          <div class="field-row" style="display:none">
            <span class="field-label-inline">Art Style</span>
            <select id="modelArtStyle" class="field-select-inline">
              <option value="realistic" selected>Realistic</option>
              <option value="sculpture">Sculpture</option>
            </select>
          </div>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">1 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits" id="modelCreditsDisplay"><i class="fa-solid fa-coins"></i> 20</span>
          </div>
          <button type="button" id="generateModelBtn" class="gen-btn" title="20 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z"/></svg>
            Generate
          </button>
        </div>
      `,
  
      remesh: `
        <div class="card">
          <h3>Model Selection</h3>
          <div class="inline-field">
            <label for="remeshModelSelect">Source</label>
            <select id="remeshModelSelect">
              <option value="current" selected>Current Model</option>
              <option value="upload">Upload New Model</option>
            </select>
          </div>

          <div id="remeshModelUploadSection" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="remeshModelUpload" style="font-size:12px">Upload 3D Model</label>
            <div id="remeshModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:7px;padding:18px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:5px">
              <svg style="width:30px;height:30px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0 0 3px;font-size:12px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">OBJ, FBX, STL, GLTF</span>
              <input type="file" id="remeshModelUpload" accept=".obj,.fbx,.stl,.gltf,.glb" hidden />
            </div>
            <div id="remeshModelFileName" style="display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,.05);border-radius:7px;font-size:12px;color:#ccc"></div>
          </div>
        </div>

        <div class="card">
          <h3>Remesh Settings</h3>
          <div class="inline-field">
            <label for="targetPolyCount">Poly Count</label>
            <input type="number" id="targetPolyCount" value="10000" min="100" max="1000000" step="1000">
          </div>
          <div class="inline-field">
            <label for="remeshMode">Mode</label>
            <select id="remeshMode">
              <option value="uniform">Uniform</option>
              <option value="adaptive" selected>Adaptive</option>
              <option value="feature-preserving">Feature Preserving</option>
              <option value="quad-based">Quad Based</option>
            </select>
          </div>
          <label style="margin-top:8px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px">
            <input type="checkbox" id="preserveUVs" checked>
            <span>Preserve UV Mapping</span>
          </label>
          <label style="margin-top:5px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px">
            <input type="checkbox" id="preserveBoundaries" checked>
            <span>Preserve Boundaries</span>
          </label>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 10</span>
          </div>
          <button type="button" id="applyRemeshBtn" class="gen-btn" title="10 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/></svg>
            Remesh
          </button>
        </div>
      `,
  
      texture: `
        <div class="card">
          <h3>Target Model</h3>
          <div class="inline-field">
            <label for="textureModelSelect">Target</label>
            <select id="textureModelSelect">
              <option value="current" selected>Current Model</option>
              <option value="upload">Upload New Model</option>
            </select>
          </div>

          <div id="textureModelUploadSection" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="textureModelUpload" style="font-size:12px">Upload 3D Model</label>
            <div id="textureModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:7px;padding:18px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:5px">
              <svg style="width:30px;height:30px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0 0 3px;font-size:12px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">OBJ, FBX, STL, GLTF</span>
              <input type="file" id="textureModelUpload" accept=".obj,.fbx,.stl,.gltf,.glb" hidden />
            </div>
            <div id="textureModelFileName" style="display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,.05);border-radius:7px;font-size:12px;color:#ccc"></div>
          </div>
        </div>

        <div class="card">
          <h3>Texture Settings</h3>
          <label for="texturePrompt" style="font-size:12px">Description</label>
          <textarea id="texturePrompt" placeholder="Rusty metal with scratches and dents..."></textarea>
          <div class="inline-field" style="margin-top:8px">
            <label for="textureResolution">Resolution</label>
            <select id="textureResolution">
              <option value="512x512">512x512</option>
              <option value="1024x1024">1024x1024</option>
              <option value="2048x2048" selected>2048x2048</option>
              <option value="4096x4096">4096x4096</option>
            </select>
          </div>
          <div class="inline-field">
            <label for="textureType">Map Type</label>
            <select id="textureType">
              <option value="pbr-all" selected>PBR (All Maps)</option>
              <option value="diffuse">Diffuse Only</option>
              <option value="normal">Normal Map</option>
              <option value="roughness">Roughness</option>
              <option value="metallic">Metallic</option>
            </select>
          </div>
          <label style="margin-top:8px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px">
            <input type="checkbox" id="seamless" checked>
            <span>Seamless Tiling</span>
          </label>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">1.5 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 15</span>
          </div>
          <button type="button" id="generateTextureBtn" class="gen-btn" title="15 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
            Texture
          </button>
        </div>
      `,

      video: `
      <input type="hidden" id="videoModeValue" value="text2video" />
      <input type="hidden" id="videoAIProvider" value="veo" />
      <input type="hidden" id="videoMotionPreset" value="" />

      <!-- Header: Provider + Mode Selection -->
      <div class="card video-header-card">
        <div class="video-header-row">
          <div class="video-provider-label" id="videoProviderLabel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            <span>Veo 3.1</span>
          </div>
          <div class="video-mode-switcher compact" id="videoModeSwitcher">
            <button type="button" class="video-mode-btn is-active" data-mode="text2video">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10"/></svg>
              Text
            </button>
            <button type="button" class="video-mode-btn" data-mode="image2video">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21"/></svg>
              Image
            </button>
          </div>
        </div>
      </div>

      <!-- Text-to-Video: Prompt input -->
      <div class="card video-mode-content video-input-card" id="text2videoContent">
        <label for="videoTextPrompt" class="video-section-label">Describe your video scene</label>
        <textarea id="videoTextPrompt" rows="3" placeholder="A serene forest with sunlight filtering through the trees..."></textarea>
        <div class="enhance-row">
          <span class="field-hint">Keep prompts simple for best results.</span>
          <button type="button" class="enhance-btn" data-enhance-mode="video" data-enhance-target="#videoTextPrompt" title="Make this prompt clearer and more detailed">
            <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
            <span class="enhance-btn-label">Enhance</span>
          </button>
        </div>
        <div class="enhance-feedback hidden" data-enhance-feedback="video"></div>
        <div class="video-input-footer">
          <div class="inline-field video-style-row">
            <label for="videoStylePreset">Style</label>
            <select id="videoStylePreset">
              <option value="auto" selected>Auto</option>
              <option value="cinematic_realism">Cinematic Realism</option>
              <option value="product_ad">Product Ad</option>
              <option value="anime_motion">Anime Motion</option>
              <option value="documentary">Documentary</option>
              <option value="dreamlike_surreal">Dreamlike Surreal</option>
              <option value="aerial">Aerial</option>
              <option value="timelapse">Timelapse</option>
              <option value="slow_motion">Slow-Mo</option>
              <option value="noir">Noir</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Image-to-Video: Image upload -->
      <div class="card video-mode-content video-input-card hidden" id="image2videoContent">
        <label for="videoSource" class="video-section-label">Reference Image</label>
        <div class="video-image-grid compact">
          <div id="videoImageDrop" class="video-drop-zone">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <span>Upload</span>
            <input type="file" id="videoSource" accept="image/*" hidden />
          </div>
          <div class="video-preview-wrap">
            <img id="videoImagePreview" class="video-preview-img" alt="Preview"/>
            <div class="video-preview-placeholder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <path d="M21 15l-5-5L5 21"/>
              </svg>
            </div>
          </div>
        </div>
        <span class="field-hint">Upload an image to animate. Use motion settings below.</span>
      </div>

      <!-- Video Settings -->
      <div class="card video-settings-card compact">
        <!-- Motion Presets (collapsible) -->
        <div class="vs-section vs-motion-section">
          <button type="button" class="vs-motion-trigger" id="vsMotionTrigger">
            <span class="vs-label">Camera Motion</span>
            <span class="vs-motion-value" id="vsMotionValue">None</span>
            <svg class="vs-motion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div id="videoMotionPresets" class="vs-presets vs-presets--collapsed">
            <button type="button" class="vs-preset is-active" data-preset="">None</button>
            <button type="button" class="vs-preset" data-preset="slow_pan">Pan</button>
            <button type="button" class="vs-preset" data-preset="parallax">Parallax</button>
            <button type="button" class="vs-preset" data-preset="zoom_in">Zoom In</button>
            <button type="button" class="vs-preset" data-preset="zoom_out">Zoom Out</button>
            <button type="button" class="vs-preset" data-preset="orbit">Orbit</button>
            <button type="button" class="vs-preset" data-preset="dolly">Dolly</button>
            <button type="button" class="vs-preset" data-preset="tilt_up">Tilt</button>
          </div>
        </div>

        <!-- Output Settings Grid -->
        <div class="vs-section">
          <span class="vs-label">Output Settings</span>
          <div class="vs-settings-grid">
            <div class="vs-setting">
              <label for="videoDuration">Duration</label>
              <select id="videoDuration">
                <option value="4" selected>4 seconds</option>
                <option value="6">6 seconds</option>
                <option value="8">8 seconds</option>
              </select>
            </div>
            <div class="vs-setting">
              <label for="videoAspectRatio">Aspect Ratio</label>
              <select id="videoAspectRatio">
                <option value="landscape" selected>16:9 Landscape</option>
                <option value="portrait">9:16 Portrait</option>
              </select>
            </div>
            <div class="vs-setting" id="videoQualityWrap">
              <label for="videoQuality">Quality</label>
              <select id="videoQuality">
                <option value="720p" selected>Standard (HD)</option>
                <option value="1080p">Pro (Full HD)</option>
              </select>
            </div>
            <div class="vs-setting vs-setting-toggle">
              <label>Playback</label>
              <button type="button" id="videoLoopBtn" class="vs-toggle-btn is-active" title="Loop playback">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
                <span>Loop</span>
              </button>
              <input type="hidden" id="videoLoop" value="true">
            </div>
          </div>
          <span class="vs-hint" id="videoResolutionHint">Higher quality uses more credits. Pro requires 8s duration.</span>
        </div>

        <!-- Custom Motion -->
        <div class="vs-section vs-custom-section">
          <span class="vs-label">Custom Motion <span class="vs-optional">(optional)</span></span>
          <textarea id="videoMotion" rows="2" placeholder="Describe custom camera motion, e.g. 'slow zoom into the subject'"></textarea>
        </div>
      </div>

      <!-- Generate Button (sticky footer) -->
      <div class="card gen-footer-card video-gen-footer">
        <div class="gen-meta">
          <span class="gen-time" id="videoGenTime">~2 min</span>
          <span class="gen-divider">|</span>
          <span class="gen-credits" id="videoCreditsDisplay"><i class="fa-solid fa-coins"></i> 70</span>
        </div>
        <button type="button" id="generateVideoBtn" class="gen-btn" title="70 credits" data-base-credits="70" data-video-mode="text2video" data-provider="google" disabled>
          <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Generate
        </button>
      </div>
    `
  };

    /**
     * Injects the stack of cards for the selected tool and binds fresh events.
     * @param {string} panelType - Identifier of the tool that should be shown.
     */
    function updateLeftPanel(panelType) {
      const content = panelContent[panelType];
      if (!content) return;
      leftStack.innerHTML = content;
      initPanelInteractions();   // bind events in newly injected content
      bindLeftOpenButton();      // (re)bind optional "New model" button in left panel if you add it
      // Update credit badges for newly rendered buttons
      if (window.WorkspaceCredits?.updateButtonCosts) {
        window.WorkspaceCredits.updateButtonCosts();
      }
    }
  
    /* -------------------------------------------------------------------------
     * THREE.JS VIEWER: bootstrap + resize (lazy)
     * Exposes window.timrx3D = { scene, camera, renderer, resize }
     * ---------------------------------------------------------------------- */
    /**
     * Ensures the Three.js viewer exists and is properly sized.
     */
    function ensureThreeViewer() {
      if (!model3dWrap || !viewerCanvas) return;

      // Skip if WebGL is not available (fallback UI already shown)
      if (!webglAvailable && threeBooted) return;

      if (window.timrx3D && typeof window.timrx3D.resize === 'function') {
        window.timrx3D.resize();
        return;
      }

      if (threeBooted) {
        // Only resize if renderer exists
        if (window.timrx3D?.renderer) {
          const rect = model3dWrap.getBoundingClientRect();
          window.timrx3D.renderer.setSize(rect.width, rect.height, false);
        }
        return;
      }

      if (window.THREE) bootThreeViewer();
      else window.addEventListener('three-ready', bootThreeViewer, { once: true });
    }
  
    /**
     * Shows fallback UI when WebGL is unavailable.
     */
    function showWebGLFallback() {
      if (!model3dWrap) return;

      // Check if fallback already exists
      if (model3dWrap.querySelector('.viewer-fallback')) return;

      // Hide the canvas
      if (viewerCanvas) viewerCanvas.style.display = 'none';
      if (viewerEmpty) viewerEmpty.style.display = 'none';

      // Create fallback message
      const fallback = document.createElement('div');
      fallback.className = 'viewer-fallback';
      fallback.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:20px;text-align:center;">
          <svg style="width:48px;height:48px;opacity:0.3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
          </svg>
          <p style="margin:0;color:rgba(255,255,255,0.6);font-size:14px;max-width:280px;">
            3D preview unavailable (WebGL disabled).<br>
            <span style="font-size:12px;opacity:0.7;">You can still generate and download models.</span>
          </p>
        </div>
      `;
      model3dWrap.appendChild(fallback);

      console.log('[Viewer] Showing WebGL fallback UI');
    }

    /**
     * Boots the Three.js scene, renderer, controls, and animation loop.
     */
    function bootThreeViewer() {
      const THREE = window.THREE;
      if (!THREE || !viewerCanvas) return;

      // Prevent double initialization
      if (threeBooted && window.timrx3D?.renderer) {
        console.log('[Viewer] Already booted, skipping re-init');
        return;
      }

      // Check WebGL availability
      if (!webglAvailable) {
        showWebGLFallback();
        threeBooted = true; // Mark as "booted" so we don't retry
        return;
      }

      const rect = model3dWrap.getBoundingClientRect();

      const scene  = new THREE.Scene();
      scene.background = new THREE.Color(0x2a2a2e);

      const camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 1000);
      camera.position.set(2.5, 2.2, 3.5);

      // Try to create renderer with error handling
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: viewerCanvas, antialias: true });
      } catch (err) {
        console.error('[Viewer] Failed to create WebGLRenderer:', err.message);
        window.timrxViewerAvailable = false;
        showWebGLFallback();
        threeBooted = true;
        return;
      }

      // Check if context was actually created
      if (!renderer.getContext()) {
        console.error('[Viewer] WebGL context not available');
        window.timrxViewerAvailable = false;
        showWebGLFallback();
        threeBooted = true;
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(rect.width, rect.height, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.5;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const grid = new THREE.GridHelper(10, 10, 0xffffff, 0xffffff);
      grid.material.opacity = 0.4;
      grid.material.transparent = true;
      grid.isGridHelper = true;
      grid.userData.keepAlive = true;
      scene.add(grid);

      // Ambient light for base illumination
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
      ambientLight.userData.keepAlive = true;
      scene.add(ambientLight);

      // Hemisphere light (sky/ground) for natural fill
      const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1.4);
      hemiLight.userData.keepAlive = true;
      scene.add(hemiLight);

      // Key light (main light source)
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
      keyLight.position.set(5, 8, 5);
      keyLight.castShadow = false;
      keyLight.userData.keepAlive = true;
      scene.add(keyLight);

      // Fill light (softens shadows from front-left)
      const fillLight = new THREE.DirectionalLight(0xffffff, 1.5);
      fillLight.position.set(-4, 4, 6);
      fillLight.userData.keepAlive = true;
      scene.add(fillLight);

      // Rim/back light (creates edge definition)
      const rimLight = new THREE.DirectionalLight(0xadd8ff, 1.0);
      rimLight.position.set(-3, 6, -6);
      rimLight.userData.keepAlive = true;
      scene.add(rimLight);

      // Bottom fill light (illuminates underside details)
      const bottomLight = new THREE.DirectionalLight(0xffffff, 0.8);
      bottomLight.position.set(0, -4, 2);
      bottomLight.userData.keepAlive = true;
      scene.add(bottomLight);
  
      placeholderCube = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x88c6ff, roughness: 0.6, metalness: 0.0 })
      );
      placeholderCube.position.y = 0.5; // Lift cube above the grid
      placeholderCube.userData.isPlaceholder = true;
      placeholderCube.userData.keepAlive = true;
      scene.add(placeholderCube);

      // Expose globally so 3dscript.js can find it
      window.placeholderCube = placeholderCube;
  
      if (THREE.OrbitControls) {
        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.autoRotate = rotationState.enabled;
        window.timrxControls = controls;
      }
  
      /**
       * Resizes the renderer and camera to fit the viewer wrapper.
       */
      function onResize() {
        const r = model3dWrap.getBoundingClientRect();
        camera.aspect = r.width / r.height;
        camera.updateProjectionMatrix();
        renderer.setSize(r.width, r.height, false);
      }
      window.addEventListener('resize', onResize);
  
      /**
       * Renders the scene on every animation frame.
       */
      function animate() {
        requestAnimationFrame(animate);
        if (rotationState.enabled && placeholderCube && placeholderCube.visible) {
          placeholderCube.rotation.y += rotationState.speed;
        }
        if (window.timrxControls) window.timrxControls.update();
        renderer.render(scene, camera);
      }
      animate();
  
      window.timrx3D = { scene, camera, renderer, resize: onResize };
      threeBooted = true;
      setAutoRotateState(rotationState.enabled);
    }
  
    /**
     * Enables or disables auto-rotation for camera controls and the placeholder cube.
     * @param {boolean} isEnabled - Desired rotation state.
     */
    function setAutoRotateState(isEnabled) {
      rotationState.enabled = !!isEnabled;
      if (window.timrxControls) {
        window.timrxControls.autoRotate = rotationState.enabled;
      }
    }
  
    /**
     * Keeps the viewer toggle UI in sync with the rotation state.
     */
    function syncRotateToggle() {
      if (rotateToggle) rotateToggle.checked = rotationState.enabled;
    }
  
    /**
     * Wires up the gear button and toggle that control cube rotation.
     */
    function initViewerSettings() {
      if (!viewerGear || !rotateCard || !rotateToggle) return;
      syncRotateToggle();
      viewerGear.addEventListener('click', toggleRotateCard);
      rotateToggle.addEventListener('change', handleRotateToggleChange);
      document.addEventListener('click', dismissRotateCardOnClick);
      document.addEventListener('keydown', dismissRotateCardOnEsc);
    }
  
    /**
     * Shows or hides the rotate settings pill.
     */
    function toggleRotateCard() {
      if (!rotateCard) return;
      syncRotateToggle();
      rotateCard.classList.toggle('hidden');
    }
  
    /**
     * Applies the user-selected rotation setting.
     * @param {Event} event - The change event triggered by the checkbox.
     */
    function handleRotateToggleChange(event) {
      setAutoRotateState(!!event.target.checked);
      requestAnimationFrame(() => rotateCard?.classList.add('hidden'));
    }
  
    /**
     * Closes the rotate pill when clicking outside of it.
     * @param {MouseEvent} event - Document click.
     */
    function dismissRotateCardOnClick(event) {
      if (!rotateCard || rotateCard.classList.contains('hidden')) return;
      const clickedInside = rotateCard.contains(event.target);
      const clickedGear   = viewerGear?.contains(event.target);
      if (!clickedInside && !clickedGear) rotateCard.classList.add('hidden');
    }
  
    /**
     * Closes the rotate pill on Escape.
     * @param {KeyboardEvent} event - Document keydown.
     */
    function dismissRotateCardOnEsc(event) {
      if (event.key === 'Escape') rotateCard?.classList.add('hidden');
    }
  
    /**
     * Shows the correct preview pane based on the selected tool.
     * @param {string} panelType - image | video | model | remesh | texture
     */
    function switchViewer(panelType) {
      if (!model3dWrap || !imageViewer || !videoViewer || !viewerTitle || !genHint) return;
  
      // Hide all viewers first
      model3dWrap.classList.add('hidden');
      imageViewer.classList.add('hidden');
      videoViewer.classList.add('hidden');
  
      // Then show the active one
      if (panelType === 'image') {
        imageViewer.classList.remove('hidden');
        viewerTitle.textContent = 'Image Preview';
        genHint.textContent = 'Your generated image will appear here.';
      } else if (panelType === 'video') {
        videoViewer.classList.remove('hidden');
        viewerTitle.textContent = 'Video Preview';
        genHint.textContent = 'Your generated video will appear here.';
      } else {
        // model / remesh / texture use the 3D viewer
        model3dWrap.classList.remove('hidden');
        viewerTitle.textContent = '3D Preview';
        genHint.textContent = 'Your 3D model will appear here.';
        ensureThreeViewer();              // ensure canvas has a real size & renderer exists
        setTimeout(ensureThreeViewer, 0); // safety after layout paint
      }
    }
  
    /**
     * Loads a GLB/GLTF model into the viewer, re-centers it, and fits the camera.
     * @param {File} file - The uploaded GLB/GLTF file.
     * @param {string} modelName - Friendly name shown in logs.
     */
    function load3DModel(file, modelName) {
      // Guard: Check WebGL availability first
      if (!webglAvailable) {
        console.warn('[Viewer] Cannot load model: WebGL not available');
        return;
      }

      if (!window.THREE || !window.THREE.GLTFLoader) {
        console.error('[Viewer] Three.js or GLTFLoader not available');
        return;
      }

      ensureThreeViewer();
      const viewer = window.timrx3D;
      if (!viewer || !viewer.scene) {
        console.error('[Viewer] 3D viewer not initialized');
        return;
      }
  
      const THREE = window.THREE;
      const loader = new THREE.GLTFLoader();
      const reader = new FileReader();
  
      reader.onload = function (e) {
        const arrayBuffer = e.target.result;
  
        loader.parse(arrayBuffer, '', function (gltf) {
          const scene  = viewer.scene;
          const camera = viewer.camera;
  
          const toRemove = [];
          scene.children.forEach((child) => {
            const keepAlive = child.isGridHelper || child.isLight || child.userData?.keepAlive;
            if (!keepAlive && (child.isMesh || child.type === 'Group' || child.type === 'Object3D')) {
              toRemove.push(child);
            }
          });
          toRemove.forEach((obj) => scene.remove(obj));
  
          const model = gltf.scene;
          model.name  = modelName || file.name;
          scene.add(model);
  
          const box    = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          const size   = box.getSize(new THREE.Vector3());
  
          model.position.x = -center.x;
          model.position.y = -center.y;
          model.position.z = -center.z;
  
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const scale  = 2 / maxDim;
          model.scale.set(scale, scale, scale);
  
          camera.position.set(2.5, 2.2, 3.5);
          camera.lookAt(0, 0, 0);
  
          if (window.timrxControls) {
            window.timrxControls.target.set(0, 0, 0);
            window.timrxControls.update();
          }
  
          if (placeholderCube) placeholderCube.visible = false;
          if (viewerEmpty) viewerEmpty.style.display = 'none';
        }, function (error) {
          console.error('Error loading model:', error);
          alert('Failed to load model. Please check the file format and try again.');
        });
      };
  
      reader.readAsArrayBuffer(file);
    }
  
    /**
     * Wires up the tab controls and upload helpers within the left stack.
     */
    function initPanelInteractions() {
      // Tabs for model → (Text to 3D / Image to 3D)
      const tabButtons  = leftStack.querySelectorAll('.tab-btn');
      const tabContents = leftStack.querySelectorAll('.tab-content');
  
      tabButtons.forEach((btn) => {
        btn.addEventListener('click', function () {
          const targetTab = this.getAttribute('data-tab');

          // Button states
          tabButtons.forEach((b) => {
            const isActive = b.getAttribute('data-tab') === targetTab;
            b.classList.toggle('active', isActive);
            b.style.background = isActive ? 'rgba(255,255,255,.1)' : 'transparent';
            b.style.color      = isActive ? '#fff' : '#888';
          });

          // Content visibility
          tabContents.forEach((content) => {
            const isTarget = (content.id === targetTab);
            content.classList.toggle('hidden', !isTarget);
            content.classList.toggle('active',  isTarget);
          });

          // Update credits display based on selected tab
          const modelCredits = leftStack.querySelector('#modelCreditsDisplay');
          const generateBtn = leftStack.querySelector('#generateModelBtn');
          const isImage3d = (targetTab === 'image3d');
          const cost = isImage3d ? 30 : 20;

          if (modelCredits) {
            modelCredits.innerHTML = `<i class="fa-solid fa-coins"></i> ${cost}`;
          }

          if (generateBtn) {
            generateBtn.title = `${cost} credits`;
            // Also update the cost badge if it exists
            let costBadge = generateBtn.querySelector('.btn-cost-badge');
            if (costBadge) {
              costBadge.textContent = cost;
            }
            // Update data attribute for workspace-credits to know current action
            generateBtn.dataset.currentAction = isImage3d ? 'image-to-3d' : 'text-to-3d';
          }

          // Trigger workspace credits update if available
          if (window.WorkspaceCredits?.updateButtonCosts) {
            window.WorkspaceCredits.updateButtonCosts();
          }
        });
      });
  
      // Image-to-3D: upload & preview
      const modelImageDrop   = leftStack.querySelector('#modelImageDrop');
      const modelImageUpload = leftStack.querySelector('#modelImageUpload');
      const modelImagePreview= leftStack.querySelector('#modelImagePreview');
  
      if (modelImageDrop && modelImageUpload && modelImagePreview) {
        modelImageDrop.addEventListener('click', () => modelImageUpload.click());
        modelImageUpload.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const reader = new FileReader();
            reader.onload = (e) => {
              modelImagePreview.src = e.target.result;
            };
            reader.readAsDataURL(this.files[0]);
          }
        });
        modelImageDrop.addEventListener('dragover', (e) => {
          e.preventDefault();
          modelImageDrop.classList.add('drag-over');
        });
        modelImageDrop.addEventListener('dragleave', () => {
          modelImageDrop.classList.remove('drag-over');
        });
        modelImageDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          modelImageDrop.classList.remove('drag-over');
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            modelImageUpload.files = e.dataTransfer.files;
            modelImageUpload.dispatchEvent(new Event('change'));
          }
        });
      }

      // Video: image upload & preview
      const videoImageDrop    = leftStack.querySelector('#videoImageDrop');
      const videoSource       = leftStack.querySelector('#videoSource');
      const videoImagePreview = leftStack.querySelector('#videoImagePreview');

      if (videoImageDrop && videoSource && videoImagePreview) {
        videoImageDrop.addEventListener('click', () => videoSource.click());
        videoSource.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const reader = new FileReader();
            reader.onload = (e) => {
              videoImagePreview.src = e.target.result;
              videoImagePreview.style.display = 'block';
            };
            reader.readAsDataURL(this.files[0]);
          }
        });
        // Drag-n-drop
        videoImageDrop.addEventListener('dragover', (e) => {
          e.preventDefault();
          videoImageDrop.style.borderColor = 'rgba(255,255,255,.3)';
        });
        videoImageDrop.addEventListener('dragleave', () => {
          videoImageDrop.style.borderColor = 'rgba(255,255,255,.15)';
        });
        videoImageDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          videoImageDrop.style.borderColor = 'rgba(255,255,255,.15)';
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            videoSource.files = e.dataTransfer.files;
            videoSource.dispatchEvent(new Event('change'));
          }
        });
      }

      // ========================================
      // VIDEO: Mode Switching & Credits Logic
      // ========================================
      const videoModeSwitcher = leftStack.querySelector('#videoModeSwitcher');
      const videoModeValue = leftStack.querySelector('#videoModeValue');
      const text2videoContent = leftStack.querySelector('#text2videoContent');
      const image2videoContent = leftStack.querySelector('#image2videoContent');
      const videoTextPrompt = leftStack.querySelector('#videoTextPrompt');
      const videoCreditsDisplay = leftStack.querySelector('#videoCreditsDisplay');
      const videoGenTime = leftStack.querySelector('#videoGenTime');
      const generateVideoBtn = leftStack.querySelector('#generateVideoBtn');
      const videoDuration = leftStack.querySelector('#videoDuration');
      const videoFPS = leftStack.querySelector('#videoFPS');
      const videoLoop = leftStack.querySelector('#videoLoop');
      const videoMotion = leftStack.querySelector('#videoMotion');
      const videoAspectRatio = leftStack.querySelector('#videoAspectRatio');
      const videoQuality = leftStack.querySelector('#videoQuality');
      const videoQualityWrap = leftStack.querySelector('#videoQualityWrap');

      // ========================================
      // VIDEO: Pricing Constants (Veo only - resolution + duration based)
      // ========================================
      // Fallback credits by resolution and duration (used if backend unavailable)
      // Actual costs are fetched from backend via WorkspaceCredits
      // Mapping: Standard (HD) = 720p, Pro (Full HD) = 1080p
      const VIDEO_CREDIT_RULES_FALLBACK = {
        '720p':  { 4: 70, 6: 90, 8: 110 },   // Standard (HD)
        '1080p': { 8: 130 }                   // Pro (Full HD) - requires 8s
      };
      // Valid durations per resolution (Veo constraints)
      const VIDEO_VALID_DURATIONS = {
        '720p':  [4, 6, 8],   // Standard: all durations
        '1080p': [8]          // Pro: 8s only
      };
      // Time estimates by quality tier
      const VIDEO_TIME_ESTIMATE = { '720p': '~2 min', '1080p': '~3 min' };
      // UI labels for resolution values
      const VIDEO_QUALITY_LABELS = {
        '720p': 'Standard (HD)',
        '1080p': 'Pro (Full HD)'
      };

      // Map simplified aspect values to API format (no square/1:1 - not supported by Veo)
      const VIDEO_ASPECT_MAP = {
        landscape: '16:9',
        portrait: '9:16'
      };

      /**
       * Get current video settings from UI (Veo only)
       * @returns {Object} Video settings object
       */
      function getVideoSettingsFromUI() {
        const durationRaw = videoDuration?.value || '4';
        const resolutionRaw = videoQuality?.value || '720p';
        const aspectRaw = videoAspectRatio?.value || 'landscape';

        const settings = {
          provider: 'veo',
          durationSec: parseInt(durationRaw, 10) || 4,
          resolution: resolutionRaw,
          quality: resolutionRaw,  // Keep for backwards compatibility
          aspect: aspectRaw,
          aspectRatio: VIDEO_ASPECT_MAP[aspectRaw] || '16:9',
          fps: 24, // Fixed for Veo
          loop: videoLoop?.checked ?? true,
          mode: videoModeValue?.value || 'text2video'
        };

        // DEBUG: Log settings on every read
        console.log('[VIDEO DEBUG] getVideoSettingsFromUI:', {
          durationRaw,
          resolutionRaw,
          durationSec: settings.durationSec,
          resolution: settings.resolution,
          videoDurationElement: videoDuration,
          videoQualityElement: videoQuality
        });

        return settings;
      }

      /**
       * Compute video credits for Veo based on resolution + duration
       * Uses backend-driven costs via WorkspaceCredits, falls back to hardcoded values
       * @param {Object} settings - Video settings from getVideoSettingsFromUI()
       * @returns {number} Total credits (integer)
       */
      function computeVideoCredits(settings) {
        const resolution = settings.resolution || '720p';
        const duration = settings.durationSec || 4;
        const mode = settings.mode || 'text2video';

        let cost = null;
        let source = 'unknown';

        // Try to get cost from backend via WorkspaceCredits
        if (window.WorkspaceCredits?.getVideoCreditCost) {
          cost = window.WorkspaceCredits.getVideoCreditCost(mode, duration, resolution);
          source = 'WorkspaceCredits';
        }

        // Fallback to hardcoded rules if WorkspaceCredits not available or returned null
        if (cost === null || cost === undefined) {
          const resRules = VIDEO_CREDIT_RULES_FALLBACK[resolution];
          if (resRules && resRules[duration] !== undefined) {
            cost = resRules[duration];
            source = 'fallback-exact';
          } else if (resRules && resRules[8] !== undefined) {
            // Duration not valid for resolution, use 8s cost
            cost = resRules[8];
            source = 'fallback-8s';
          } else {
            // Ultimate fallback: minimum 720p 4s cost
            cost = 70;
            source = 'fallback-default';
          }
        }

        // DEBUG: Log credit computation
        console.log('[VIDEO DEBUG] computeVideoCredits:', {
          resolution,
          duration,
          mode,
          cost,
          source,
          fallbackRules: VIDEO_CREDIT_RULES_FALLBACK
        });

        return cost;
      }

      /**
       * Get the video action code for current settings (for API request)
       * @param {Object} settings - Video settings from getVideoSettingsFromUI()
       * @returns {string} Action code like video_text_generate_4s_720p (lowercase canonical)
       */
      function getVideoActionCodeForSettings(settings) {
        const resolution = settings.resolution || '720p';
        const duration = settings.durationSec || 4;
        const mode = settings.mode || 'text2video';

        if (window.WorkspaceCredits?.getVideoActionCode) {
          return window.WorkspaceCredits.getVideoActionCode(mode, duration, resolution);
        }

        // Fallback: build it manually (lowercase canonical format)
        const taskPart = mode === 'text2video' ? 'text_generate' : 'image_animate';
        return `video_${taskPart}_${duration}s_${resolution.toLowerCase()}`;
      }

      /**
       * Check if a duration is valid for the selected resolution
       * @param {string} resolution - '720p' or '1080p'
       * @param {number} duration - Duration in seconds
       * @returns {boolean}
       */
      function isValidDuration(resolution, duration) {
        const validDurations = VIDEO_VALID_DURATIONS[resolution] || [4, 6, 8];
        return validDurations.includes(duration);
      }

      /**
       * Update duration dropdown based on selected resolution/quality tier
       * Disables invalid durations for 1080p/4K (Veo) or validates Luma resolutions
       */
      function updateDurationOptions() {
        if (!videoDuration) return;

        // Veo resolution-based constraints
        const resolution = videoQuality?.value || '720p';
        const validDurations = VIDEO_VALID_DURATIONS[resolution] || [4, 6, 8];
        const qualityLabel = VIDEO_QUALITY_LABELS[resolution] || 'Standard (HD)';

        console.log('[VIDEO DEBUG] updateDurationOptions:', {
          resolution,
          validDurations,
          qualityLabel,
          currentDuration: videoDuration.value
        });

        const currentDuration = parseInt(videoDuration.value, 10);

        // Enable/disable options based on resolution constraints
        Array.from(videoDuration.options).forEach(opt => {
          const dur = parseInt(opt.value, 10);
          const isValid = validDurations.includes(dur);
          opt.disabled = !isValid;

          // Add visual hint for disabled options
          if (!isValid) {
            opt.textContent = `${dur} sec (requires ${qualityLabel})`;
          } else {
            opt.textContent = `${dur} sec`;
          }
        });

        // If current selection is invalid, switch to 8s (or first valid)
        if (!validDurations.includes(currentDuration)) {
          const newDuration = validDurations.includes(8) ? '8' : String(validDurations[0]);
          console.log('[VIDEO DEBUG] Forcing duration to:', newDuration);
          videoDuration.value = newDuration;
        }
      }

      /**
       * Update UI based on selected provider (Veo/Luma/Runway)
       * Shows/hides provider-specific controls
       */
      function updateProviderUI() {
        const provider = videoAIProvider?.value || 'veo';

        if (provider === 'luma') {
          // Show Luma resolution and concepts, hide Veo quality
          if (videoQualityWrap) videoQualityWrap.classList.add('hidden');
          if (lumaQualityWrap) lumaQualityWrap.classList.remove('hidden');
          if (lumaConceptWrap) lumaConceptWrap.classList.remove('hidden');
        } else {
          // Show Veo quality, hide Luma resolution and concepts
          if (videoQualityWrap) videoQualityWrap.classList.remove('hidden');
          if (lumaQualityWrap) lumaQualityWrap.classList.add('hidden');
          if (lumaConceptWrap) lumaConceptWrap.classList.add('hidden');
        }

        // Update duration options for new provider
        updateDurationOptions();
        // Update footer pricing
        updateVideoFooter();
      }

      // Expose video settings and credits calculator globally
      window.VideoJobControl = {
        getSettings: getVideoSettingsFromUI,
        computeCredits: computeVideoCredits,
        isValidDuration: isValidDuration,
        updateDurationOptions: updateDurationOptions,
        // Video credit costs - fetched from backend via WorkspaceCredits, fallback to local constants
        VIDEO_CREDIT_RULES: VIDEO_CREDIT_RULES_FALLBACK,
        VIDEO_VALID_DURATIONS: VIDEO_VALID_DURATIONS
      };

      /**
       * Update the video footer UI (credits display, time estimate, button)
       */
      function updateVideoFooter() {
        console.log('[VIDEO DEBUG] updateVideoFooter called');

        if (!videoCreditsDisplay || !generateVideoBtn) {
          console.warn('[VIDEO DEBUG] Missing elements:', { videoCreditsDisplay, generateVideoBtn });
          return;
        }

        const settings = getVideoSettingsFromUI();
        const totalCredits = computeVideoCredits(settings);

        console.log('[VIDEO DEBUG] Updating UI with credits:', totalCredits);

        // Update credits display
        videoCreditsDisplay.innerHTML = `<i class="fa-solid fa-coins"></i> ${totalCredits}`;

        // Update time estimate based on resolution (Veo only now)
        if (videoGenTime) {
          videoGenTime.textContent = VIDEO_TIME_ESTIMATE[settings.resolution] || '~2 min';
        }

        // Update button attributes
        generateVideoBtn.title = `${totalCredits} credits`;
        generateVideoBtn.dataset.baseCredits = totalCredits;
        generateVideoBtn.dataset.provider = settings.provider || 'veo';
        // Trigger workspace credits update if available
        if (window.WorkspaceCredits?.updateButtonCosts) {
          window.WorkspaceCredits.updateButtonCosts();
        }
      }

      /**
       * Validate video form and enable/disable Generate button
       */
      function validateVideoForm() {
        if (!generateVideoBtn) return;

        const mode = videoModeValue?.value || 'text2video';
        let isValid = false;

        if (mode === 'text2video') {
          // Text-to-Video: require video prompt
          const prompt = videoTextPrompt?.value?.trim() || '';
          isValid = prompt.length > 0;
        } else {
          // Image-to-Video: require uploaded image OR image loaded from history
          const hasFileUpload = videoSource && videoSource.files && videoSource.files.length > 0;
          const previewSrc = videoImagePreview?.src || '';
          const hasPreviewImage = previewSrc.startsWith('data:') || previewSrc.startsWith('http');
          isValid = hasFileUpload || hasPreviewImage;
        }

        // Only manage disabled state for validation - don't override credits check
        const disabledForCredits = generateVideoBtn.getAttribute('data-disabled-reason') === 'insufficient-credits';

        if (!isValid) {
          generateVideoBtn.disabled = true;
          if (!disabledForCredits) {
            generateVideoBtn.setAttribute('data-disabled-reason', 'validation');
          }
        } else if (generateVideoBtn.getAttribute('data-disabled-reason') === 'validation') {
          generateVideoBtn.removeAttribute('data-disabled-reason');
          if (!disabledForCredits) {
            generateVideoBtn.disabled = false;
          }
        }
      }

      // Video mode switcher - single switcher in header
      if (videoModeSwitcher) {
        const modeButtons = videoModeSwitcher.querySelectorAll('.video-mode-btn');
        modeButtons.forEach(btn => {
          btn.addEventListener('click', function() {
            const mode = this.dataset.mode;

            // Update active state
            modeButtons.forEach(b => b.classList.remove('is-active'));
            this.classList.add('is-active');

            // Update hidden input
            if (videoModeValue) videoModeValue.value = mode;
            if (generateVideoBtn) generateVideoBtn.dataset.videoMode = mode;

            // Show/hide content sections
            if (text2videoContent && image2videoContent) {
              text2videoContent.classList.toggle('hidden', mode !== 'text2video');
              image2videoContent.classList.toggle('hidden', mode !== 'image2video');
            }

            // Re-validate form
            validateVideoForm();

            console.log('[Video] Mode switched to:', mode);
          });
        });
      }

      // Video provider switcher
      const videoProviderSwitcher = leftStack.querySelector('#videoProviderSwitcher');
      if (videoProviderSwitcher) {
        const providerButtons = videoProviderSwitcher.querySelectorAll('.video-provider-btn');
        providerButtons.forEach(btn => {
          btn.addEventListener('click', function() {
            const provider = this.dataset.provider;

            // Update active state
            providerButtons.forEach(b => b.classList.remove('is-active'));
            this.classList.add('is-active');

            // Update hidden input
            if (videoAIProvider) videoAIProvider.value = provider;

            // Show/hide quality controls based on provider
            const resolutionHint = leftStack.querySelector('#videoResolutionHint');

            if (provider === 'luma') {
              // Luma: show resolution and concept dropdowns, hide Veo quality
              if (videoQualityWrap) videoQualityWrap.classList.add('hidden');
              if (lumaQualityWrap) lumaQualityWrap.classList.remove('hidden');
              if (lumaConceptWrap) lumaConceptWrap.classList.remove('hidden');

              if (resolutionHint) {
                resolutionHint.textContent = 'Luma Dream Machine - higher resolutions use more credits.';
              }
            } else if (provider === 'runway') {
              // Runway: show resolution dropdown (720p only)
              if (videoQualityWrap) videoQualityWrap.classList.remove('hidden');
              if (lumaQualityWrap) lumaQualityWrap.classList.add('hidden');
              if (lumaConceptWrap) lumaConceptWrap.classList.add('hidden');

              if (videoQuality) {
                const opts = videoQuality.querySelectorAll('option');
                opts.forEach(opt => {
                  const is1080p = opt.value === '1080p';
                  if (is1080p) {
                    opt.disabled = true;
                    opt.style.display = 'none';
                  } else {
                    opt.disabled = false;
                    opt.style.display = '';
                  }
                });

                // Reset to 720p if current selection is not available
                if (videoQuality.value !== '720p') {
                  videoQuality.value = '720p';
                }
              }

              if (resolutionHint) {
                resolutionHint.textContent = 'Runway generates at Standard (HD) quality.';
              }
            } else {
              // Veo: show resolution dropdown with all options
              if (videoQualityWrap) videoQualityWrap.classList.remove('hidden');
              if (lumaQualityWrap) lumaQualityWrap.classList.add('hidden');
              if (lumaConceptWrap) lumaConceptWrap.classList.add('hidden');

              if (videoQuality) {
                const opts = videoQuality.querySelectorAll('option');
                opts.forEach(opt => {
                  opt.disabled = false;
                  opt.style.display = '';
                });
              }

              if (resolutionHint) {
                resolutionHint.textContent = 'Higher quality uses more credits. Pro requires 8s duration.';
              }
            }

            // Update footer and duration options
            updateDurationOptions();
            updateVideoFooter();

            console.log('[Video] Provider switched to:', provider);
          });
        });
      }

      // Wire up video credits calculation on any option change
      [videoDuration, videoQuality, videoAspectRatio, videoLoop].forEach(el => {
        if (el) {
          el.addEventListener('change', () => {
            console.log('[VIDEO DEBUG] Change event on:', el.id, '- value:', el.value);
            updateVideoFooter();
          });
        }
      });

      // When resolution changes, update valid duration options
      if (videoQuality) {
        videoQuality.addEventListener('change', () => {
          console.log('[VIDEO DEBUG] Quality changed to:', videoQuality.value);
          updateDurationOptions();
          updateVideoFooter();
        });
      }

      // When duration changes, also update footer
      if (videoDuration) {
        videoDuration.addEventListener('change', () => {
          console.log('[VIDEO DEBUG] Duration changed to:', videoDuration.value);
          updateVideoFooter();
        });
      }

      // Initialize duration options based on default resolution
      updateDurationOptions();

      // Wire up form validation on input changes
      if (videoTextPrompt) {
        videoTextPrompt.addEventListener('input', validateVideoForm);
      }
      if (videoSource) {
        videoSource.addEventListener('change', () => {
          validateVideoForm();
          updateVideoFooter();
        });
      }
      if (videoMotion) {
        videoMotion.addEventListener('input', validateVideoForm);
      }

      // Motion preset buttons — collapsible trigger + click toggles active state
      const motionPresetContainer = leftStack.querySelector('#videoMotionPresets');
      const motionPresetInput = leftStack.querySelector('#videoMotionPreset');
      const motionTrigger = leftStack.querySelector('#vsMotionTrigger');
      const motionValueLabel = leftStack.querySelector('#vsMotionValue');

      if (motionTrigger && motionPresetContainer) {
        motionTrigger.addEventListener('click', function() {
          motionPresetContainer.classList.toggle('vs-presets--collapsed');
          motionTrigger.classList.toggle('is-open');
        });
      }
      if (motionPresetContainer) {
        motionPresetContainer.querySelectorAll('.vs-preset').forEach(btn => {
          btn.addEventListener('click', function() {
            motionPresetContainer.querySelectorAll('.vs-preset').forEach(b => {
              b.classList.remove('is-active');
            });
            this.classList.add('is-active');
            if (motionPresetInput) motionPresetInput.value = this.dataset.preset || '';
            // Update trigger label and collapse
            if (motionValueLabel) motionValueLabel.textContent = this.textContent.trim();
            motionPresetContainer.classList.add('vs-presets--collapsed');
            if (motionTrigger) motionTrigger.classList.remove('is-open');
          });
        });
      }

      // Loop chip button — toggles active state and hidden input
      const loopBtn = leftStack.querySelector('#videoLoopBtn');
      const loopInput = leftStack.querySelector('#videoLoop');
      if (loopBtn && loopInput) {
        loopBtn.addEventListener('click', function() {
          const isActive = this.classList.toggle('is-active');
          loopInput.value = isActive ? 'true' : 'false';
        });
      }

      // Initial calculation and validation
      updateVideoFooter();
      validateVideoForm();

      // ========================================
      // VIDEO: Generate Button Click Handler
      // Note: Actual API call is handled by main.js via event delegation
      // This handler is for debug logging only
      // ========================================
      if (generateVideoBtn) {
        generateVideoBtn.addEventListener('click', function() {
          const provider = videoAIProvider?.value || 'google';
          const settings = getVideoSettingsFromUI();
          const totalCredits = computeVideoCredits(settings);
          const available = window.WorkspaceCredits?.getCredits?.() || 0;
          console.log('[GEN] mode=video provider=' + provider +
                      ' cost=' + totalCredits + ' available=' + available +
                      ' settings=' + JSON.stringify(settings));
          // Event bubbles to main.js which calls API.startVideoGeneration()
        });
      }

      /**
       * Show a video error message to the user
       * @param {string} message - Error message to display
       */
      function showVideoError(message) {
        // Find or create error container
        let errorEl = leftStack.querySelector('.video-error-message');
        if (!errorEl) {
          errorEl = document.createElement('div');
          errorEl.className = 'video-error-message';
          const footerCard = leftStack.querySelector('.gen-footer-card');
          if (footerCard) {
            footerCard.parentNode.insertBefore(errorEl, footerCard);
          }
        }
        errorEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${message}`;
        errorEl.style.display = 'block';

        // Auto-hide after 8 seconds
        setTimeout(() => {
          if (errorEl) errorEl.style.display = 'none';
        }, 8000);
      }

      // ========================================
      // IMAGE: Provider Switching & Credits Logic
      // ========================================
      const imageAIProvider = leftStack.querySelector('#imageAIProvider');
      const imageShape = leftStack.querySelector('#imageShape');
      const imageQuality = leftStack.querySelector('#imageQuality');
      const imageProviderHint = leftStack.querySelector('#imageProviderHint');
      const imagePrompt = leftStack.querySelector('#imagePrompt');
      const imageCreditsDisplay = leftStack.querySelector('#imageCreditsDisplay');
      const imageGenTime = leftStack.querySelector('#imageGenTime');
      const generateImageBtn = leftStack.querySelector('#generateImageBtn');

      // ========================================
      // IMAGE: Using centralized GenerationState
      // Provider configs come from window.GenerationState.capabilities
      // ========================================

      // ========================================
      // IMAGE JOB STATE: Uses centralized GenerationState
      // ========================================
      const imageProviderLockHint = leftStack.querySelector('#imageProviderLockHint');
      const imageProviderLockText = leftStack.querySelector('#imageProviderLockText');

      /**
       * Lock image UI during generation
       * Uses window.GenerationState for state management
       * @param {string} provider - 'openai' or 'google'
       * @param {object} _settings - (unused, kept for API compat) snapshot of settings
       * @param {string} jobId - the job/temp ID
       * @param {string} reservationId - credits reservation ID
       */
      function lockImageUI(provider, _settings, jobId, reservationId) {
        // Lock the central state
        window.GenerationState.lockGeneration({
          jobId,
          reservationId,
          startedAt: Date.now()
        });

        const caps = window.GenerationState.getProviderCapabilities('image', provider);

        // Disable all image settings inputs
        if (imageAIProvider) imageAIProvider.disabled = true;
        if (imageShape) imageShape.disabled = true;
        if (imageQuality) imageQuality.disabled = true;
        if (imagePrompt) imagePrompt.disabled = true;

        // Show lock hint with provider name
        if (imageProviderLockHint) {
          imageProviderLockHint.classList.remove('hidden');
        }
        if (imageProviderLockText) {
          imageProviderLockText.textContent = `Provider locked: ${caps?.name || provider}`;
        }

        console.log('[GEN] Image UI locked for provider:', provider);
      }

      /**
       * Unlock image UI after generation completes/fails
       */
      function unlockImageUI() {
        // Unlock the central state
        window.GenerationState.unlockGeneration();

        // Re-enable all image settings inputs
        if (imageAIProvider) imageAIProvider.disabled = false;
        if (imageShape) imageShape.disabled = false;
        if (imageQuality) imageQuality.disabled = false;
        if (imagePrompt) imagePrompt.disabled = false;

        // Hide lock hint
        if (imageProviderLockHint) {
          imageProviderLockHint.classList.add('hidden');
        }

        console.log('[GEN] Image UI unlocked');
      }

      /**
       * Get current image generation state (for api.js to check)
       */
      function getImageJobState() {
        const job = window.GenerationState.generation.currentJob;
        return {
          inFlight: window.GenerationState.isLocked(),
          provider: window.GenerationState.getProvider('image'),
          settingsSnapshot: job?.snapshot?.settings || null,
          jobId: job?.jobId || null,
          reservationId: job?.reservationId || null,
          startedAt: job?.startedAt || null
        };
      }

      /**
       * Check if image generation is in flight
       */
      function isImageGenerating() {
        return window.GenerationState.isLocked();
      }

      // Expose job state functions globally for api.js
      window.ImageJobControl = {
        lock: lockImageUI,
        unlock: unlockImageUI,
        getState: getImageJobState,
        isGenerating: isImageGenerating,
        getProviderConfig: (provider) => window.GenerationState.getProviderCapabilities('image', provider)
      };

      /**
       * Get current image settings as a snapshot using GenerationState
       */
      function getImageSettings() {
        const snapshot = window.GenerationState.getGenerationSnapshot('image');
        const caps = snapshot.capabilities;

        return {
          provider: snapshot.provider,
          shape: snapshot.settings.shape,
          quality: snapshot.settings.quality,
          // Map to provider-specific format
          aspectRatio: caps?.shapeMap?.[snapshot.settings.shape] || '1024x1024',
          qualityValue: caps?.qualityMap?.[snapshot.settings.quality] || 'standard',
          credits: snapshot.credits
        };
      }

      // Expose settings getter globally
      window.ImageJobControl.getSettings = getImageSettings;

      /**
       * Update image credits display using GenerationState
       */
      function updateImageCreditsDisplay() {
        const snapshot = window.GenerationState.getGenerationSnapshot('image');
        const caps = snapshot.capabilities;

        if (imageCreditsDisplay) {
          imageCreditsDisplay.innerHTML = `<i class="fa-solid fa-coins"></i> ${snapshot.credits}`;
        }
        if (imageGenTime) {
          imageGenTime.textContent = caps?.genTime || '30 sec';
        }
        if (generateImageBtn) {
          generateImageBtn.title = `${snapshot.credits} credits`;
          generateImageBtn.dataset.provider = snapshot.provider;
          generateImageBtn.dataset.baseCredits = snapshot.credits;  // Enable dynamic credits like video
        }

        // Trigger workspace credits update if available
        if (window.WorkspaceCredits?.updateButtonCosts) {
          window.WorkspaceCredits.updateButtonCosts();
        }
      }

      /**
       * Update image options based on selected provider
       * This is the ONLY place that should call GenerationState.setProvider() for images.
       * @param {string} source - 'user' (dropdown change) | 'init' (initial load)
       */
      function updateImageProviderOptions(source = 'user') {
        if (!imageAIProvider) return;

        const provider = imageAIProvider.value || 'openai';
        const previousProvider = window.GenerationState?.getProvider?.('image');

        // Log dropdown changes for debugging provider conflicts
        if (source === 'user' && previousProvider !== provider) {
          console.log(`[Provider UI] User changed image provider: ${previousProvider} -> ${provider}`);
          console.log(`[Provider UI] ========================================`);
          console.log(`[Provider UI] PROVIDER SWITCH: ${previousProvider} -> ${provider}`);
          console.log(`[Provider UI] Source: ${source}`);
          console.log(`[Provider UI] ========================================`);
        }

        // Sync to GenerationState (this is the ONLY authorized source)
        const success = window.GenerationState.setProvider('image', provider, source);

        if (!success && source === 'user') {
          // Revert dropdown if state change was blocked (e.g., during generation)
          imageAIProvider.value = previousProvider || 'openai';
          console.warn('[Provider UI] Reverted dropdown - provider change was blocked');
        }

        // Google (Imagen) shows hint that style is via prompt
        const currentProvider = window.GenerationState?.getProvider?.('image') || provider;
        const hint = currentProvider === 'google' ? 'Style is controlled via prompt text.' : '';
        if (imageProviderHint) {
          imageProviderHint.textContent = hint;
          imageProviderHint.style.display = hint ? 'block' : 'none';
        }

        // Update credits display
        updateImageCreditsDisplay();
      }

      /**
       * Validate image form and enable/disable Generate button
       */
      function validateImageForm() {
        if (!generateImageBtn) return;

        const prompt = imagePrompt?.value?.trim() || '';
        const isValid = prompt.length > 0;

        // Only manage disabled state for validation - don't override credits check
        const disabledForCredits = generateImageBtn.getAttribute('data-disabled-reason') === 'insufficient-credits';

        if (!isValid) {
          generateImageBtn.disabled = true;
          if (!disabledForCredits) {
            generateImageBtn.setAttribute('data-disabled-reason', 'validation');
          }
        } else if (generateImageBtn.getAttribute('data-disabled-reason') === 'validation') {
          generateImageBtn.removeAttribute('data-disabled-reason');
          if (!disabledForCredits) {
            generateImageBtn.disabled = false;
          }
        }
      }

      // Wire up provider change handler
      if (imageAIProvider) {
        imageAIProvider.addEventListener('change', () => updateImageProviderOptions('user'));
        // Initial setup - sync default UI value to GenerationState (don't override if already set)
        const currentProvider = window.GenerationState?.getProvider?.('image');
        if (currentProvider && imageAIProvider.value !== currentProvider) {
          // Sync UI to match existing state (don't override state)
          imageAIProvider.value = currentProvider;
        }
        updateImageProviderOptions('init');
      }

      // Register provider change callback to handle cleanup when provider switches
      if (window.GenerationState?.onProviderChange) {
        window.GenerationState.onProviderChange((mode, oldProvider, newProvider) => {
          if (mode === 'image') {
            console.log(`[Provider Callback] Image provider changed: ${oldProvider} -> ${newProvider}`);
            // Sync UI dropdown if needed
            if (imageAIProvider && imageAIProvider.value !== newProvider) {
              imageAIProvider.value = newProvider;
            }
            // Update provider hint
            const hint = newProvider === 'google' ? 'Style is controlled via prompt text.' : '';
            if (imageProviderHint) {
              imageProviderHint.textContent = hint;
              imageProviderHint.style.display = hint ? 'block' : 'none';
            }
            // Update credits display for new provider
            updateImageCreditsDisplay();
          }
        });
      }

      // Wire up shape change - sync to GenerationState
      if (imageShape) {
        imageShape.addEventListener('change', () => {
          const shape = imageShape.value || 'square';
          window.GenerationState.setSetting('image', 'shape', shape);
          updateImageCreditsDisplay();
        });
      }

      // Wire up quality change - sync to GenerationState
      if (imageQuality) {
        imageQuality.addEventListener('change', () => {
          const quality = imageQuality.value || 'standard';
          window.GenerationState.setSetting('image', 'quality', quality);
          updateImageCreditsDisplay();
        });
        // Initial setup - sync dropdown value to GenerationState
        const initialQuality = imageQuality.value || 'standard';
        window.GenerationState.setSetting('image', 'quality', initialQuality);
        updateImageCreditsDisplay();
      }

      // Wire up form validation
      if (imagePrompt) {
        imagePrompt.addEventListener('input', validateImageForm);
        validateImageForm();
      }

      // ========================================
      // IMAGE: Generate Button Click Handler
      // Note: Actual API call is handled by main.js via event delegation
      // This handler logs debug info using GenerationState
      // ========================================
      if (generateImageBtn) {
        generateImageBtn.addEventListener('click', function() {
          const snapshot = window.GenerationState.getGenerationSnapshot('image');
          const available = window.WorkspaceCredits?.getCredits?.() || 0;
          console.log('[GEN] mode=image provider=' + snapshot.provider +
                      ' cost=' + snapshot.credits + ' available=' + available +
                      ' settings=' + JSON.stringify(snapshot.settings));
          // Event bubbles to main.js which calls API.startImageGenerationByProvider()
        });
      }

      // Texture model upload section toggle
      const textureModelSelect   = leftStack.querySelector('#textureModelSelect');
      const textureUploadSection = leftStack.querySelector('#textureModelUploadSection');
      const textureModelDrop     = leftStack.querySelector('#textureModelDrop');
      const textureModelUpload   = leftStack.querySelector('#textureModelUpload');
      const textureModelFileName = leftStack.querySelector('#textureModelFileName');
  
      if (textureModelSelect && textureUploadSection) {
        textureModelSelect.addEventListener('change', function () {
          const show = this.value === 'upload';
          textureUploadSection.style.display = show ? 'block' : 'none';
          if (!show && textureModelFileName) textureModelFileName.style.display = 'none';
        });
      }
      if (textureModelDrop && textureModelUpload && textureModelFileName) {
        textureModelDrop.addEventListener('click', () => textureModelUpload.click());
        textureModelUpload.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const f = this.files[0];
            textureModelFileName.textContent = `📦 ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
            textureModelFileName.style.display = 'block';
          }
        });
        textureModelDrop.addEventListener('dragover', (e) => { e.preventDefault(); textureModelDrop.style.borderColor = 'rgba(255,255,255,.3)'; });
        textureModelDrop.addEventListener('dragleave', () => { textureModelDrop.style.borderColor = 'rgba(255,255,255,.15)'; });
        textureModelDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          textureModelDrop.style.borderColor = 'rgba(255,255,255,.15)';
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            textureModelUpload.files = e.dataTransfer.files;
            textureModelUpload.dispatchEvent(new Event('change'));
          }
        });
      }
  
      // Remesh upload toggle
      const remeshModelSelect   = leftStack.querySelector('#remeshModelSelect');
      const remeshUploadSection = leftStack.querySelector('#remeshModelUploadSection');
      const remeshModelDrop     = leftStack.querySelector('#remeshModelDrop');
      const remeshModelUpload   = leftStack.querySelector('#remeshModelUpload');
      const remeshModelFileName = leftStack.querySelector('#remeshModelFileName');
  
      if (remeshModelSelect && remeshUploadSection) {
        remeshModelSelect.addEventListener('change', function () {
          const show = this.value === 'upload';
          remeshUploadSection.style.display = show ? 'block' : 'none';
          if (!show && remeshModelFileName) remeshModelFileName.style.display = 'none';
        });
      }
      if (remeshModelDrop && remeshModelUpload && remeshModelFileName) {
        remeshModelDrop.addEventListener('click', () => remeshModelUpload.click());
        remeshModelUpload.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const f = this.files[0];
            remeshModelFileName.textContent = `📦 ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
            remeshModelFileName.style.display = 'block';
          }
        });
        remeshModelDrop.addEventListener('dragover', (e) => { e.preventDefault(); remeshModelDrop.style.borderColor = 'rgba(255,255,255,.3)'; });
        remeshModelDrop.addEventListener('dragleave', () => { remeshModelDrop.style.borderColor = 'rgba(255,255,255,.15)'; });
        remeshModelDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          remeshModelDrop.style.borderColor = 'rgba(255,255,255,.15)';
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            remeshModelUpload.files = e.dataTransfer.files;
            remeshModelUpload.dispatchEvent(new Event('change'));
          }
        });
      }

      // Chip groups (license, symmetry, etc.)
      const chipGroups = leftStack.querySelectorAll('[data-chip-group]');
      chipGroups.forEach((group) => {
        const targetSelector = group.getAttribute('data-target');
        const targetInput = targetSelector ? leftStack.querySelector(targetSelector) : null;

        const setActive = (btn) => {
          if (!btn) return;
          group.querySelectorAll('[data-value]').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          if (targetInput) targetInput.value = btn.getAttribute('data-value') || '';
        };

        group.addEventListener('click', (event) => {
          const option = event.target.closest('button[data-value]');
          if (!option || !group.contains(option)) return;
          event.preventDefault();
          setActive(option);
        });

        const defaultBtn = group.querySelector('.is-active[data-value]') || group.querySelector('[data-value]');
        setActive(defaultBtn);
      });

      // Segment groups (similar to chip groups but new style)
      const segmentGroups = leftStack.querySelectorAll('[data-segment-group]');
      segmentGroups.forEach((group) => {
        const targetSelector = group.getAttribute('data-target');
        const targetInput = targetSelector ? leftStack.querySelector(targetSelector) : null;

        const setActive = (btn) => {
          if (!btn) return;
          group.querySelectorAll('[data-value]').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          if (targetInput) targetInput.value = btn.getAttribute('data-value') || '';
        };

        group.addEventListener('click', (event) => {
          const option = event.target.closest('button[data-value]');
          if (!option || !group.contains(option)) return;
          event.preventDefault();
          setActive(option);
        });

        const defaultBtn = group.querySelector('.is-active[data-value]') || group.querySelector('[data-value]');
        setActive(defaultBtn);
      });

      // Stepper buttons
      const steppers = leftStack.querySelectorAll('.stepper-input');
      steppers.forEach((stepper) => {
        const input = stepper.querySelector('input[type="number"]');
        const upBtn = stepper.querySelector('.stepper-up');
        const downBtn = stepper.querySelector('.stepper-down');
        if (!input) return;

        const step = () => {
          const min = parseInt(input.min, 10) || 1;
          const max = parseInt(input.max, 10) || 99;
          let val = parseInt(input.value, 10) || min;
          return { min, max, val };
        };

        upBtn?.addEventListener('click', (e) => {
          e.preventDefault();
          const { min, max, val } = step();
          input.value = Math.min(max, val + 1);
          input.dispatchEvent(new Event('change'));
        });

        downBtn?.addEventListener('click', (e) => {
          e.preventDefault();
          const { min, max, val } = step();
          input.value = Math.max(min, val - 1);
          input.dispatchEvent(new Event('change'));
        });
      });

      // AI Model change → update credits display
      const aiModelSelect = leftStack.querySelector('#modelAIModel');
      const modelCreditsDisplay = leftStack.querySelector('#modelCreditsDisplay');
      if (aiModelSelect && modelCreditsDisplay) {
        aiModelSelect.addEventListener('change', function () {
          const value = this.value;
          if (value === 'meshy-5' || value === 'meshy-4') {
            modelCreditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 10';
          } else {
            modelCreditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 20';
          }
        });
      }

      // ========================================
      // PROMPT ENHANCE: Bind enhance buttons
      // ========================================
      initPromptEnhanceButtons();
    }

    // ========================================
    // PROMPT ENHANCE: Shared logic
    // ========================================
    const ENHANCE_API = (window.TIMRX_3D_API_BASE || 'https://3d.timrx.live') + '/api/_mod/prompt-enhance';
    const _enhanceUndoMap = {};  // mode → original prompt for undo

    function initPromptEnhanceButtons() {
      const enhanceBtns = leftStack.querySelectorAll('.enhance-btn[data-enhance-mode]');
      enhanceBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          const mode = btn.getAttribute('data-enhance-mode');
          const targetSel = btn.getAttribute('data-enhance-target');
          if (!mode || !targetSel) return;
          const textarea = leftStack.querySelector(targetSel);
          if (!textarea) return;
          enhancePromptForField(mode, textarea, btn);
        });
      });

      // Keyboard shortcut: Ctrl/Cmd + Shift + E
      document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
          const active = document.activeElement;
          if (!active || active.tagName !== 'TEXTAREA') return;
          // Find the enhance button associated with this textarea
          const card = active.closest('.card');
          if (!card) return;
          const btn = card.querySelector('.enhance-btn[data-enhance-mode]');
          if (!btn) return;
          e.preventDefault();
          btn.click();
        }
      });
    }

    function enhancePromptForField(mode, textarea, btn) {
      const raw = (textarea.value || '').trim();
      const feedbackEl = leftStack.querySelector('[data-enhance-feedback="' + mode + '"]');

      // Empty prompt guard
      if (!raw) {
        showEnhanceFeedback(feedbackEl, 'hint', 'Add a starting idea first.');
        return;
      }

      // Length guard
      if (raw.length > 2000) {
        showEnhanceFeedback(feedbackEl, 'error', 'Prompt is too long (max 2000 chars).');
        return;
      }

      // Set loading state
      setEnhanceButtonState(btn, 'loading');
      showEnhanceFeedback(feedbackEl, 'loading', 'Enhancing\u2026');

      fetch(ENHANCE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prompt: raw, mode: mode }),
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok && data.enhanced_prompt) {
          // Store original for undo
          _enhanceUndoMap[mode] = raw;

          // Update textarea
          textarea.value = data.enhanced_prompt;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          textarea.focus();

          setEnhanceButtonState(btn, 'idle');
          showEnhanceFeedback(feedbackEl, 'undo', 'Enhanced.', function onUndo() {
            textarea.value = _enhanceUndoMap[mode] || raw;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.focus();
            delete _enhanceUndoMap[mode];
            showEnhanceFeedback(feedbackEl, null);
          });
        } else {
          setEnhanceButtonState(btn, 'idle');
          showEnhanceFeedback(feedbackEl, 'error', data.error || 'Enhancement failed.');
        }
      })
      .catch(function() {
        setEnhanceButtonState(btn, 'idle');
        showEnhanceFeedback(feedbackEl, 'error', 'Could not reach server. Try again.');
      });
    }

    function setEnhanceButtonState(btn, state) {
      if (!btn) return;
      var label = btn.querySelector('.enhance-btn-label');
      if (state === 'loading') {
        btn.disabled = true;
        btn.classList.add('is-loading');
        if (label) label.textContent = 'Enhancing\u2026';
      } else {
        btn.disabled = false;
        btn.classList.remove('is-loading');
        if (label) label.textContent = 'Enhance';
      }
    }

    function showEnhanceFeedback(el, type, message, onUndo) {
      if (!el) return;
      if (!type) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
      }
      el.classList.remove('hidden');
      var cls = 'enhance-feedback--' + type;
      el.className = 'enhance-feedback ' + cls;

      if (type === 'undo' && onUndo) {
        el.innerHTML = '<span>' + message + '</span> <button type="button" class="enhance-undo-btn">Undo</button>';
        el.querySelector('.enhance-undo-btn').addEventListener('click', function(e) {
          e.preventDefault();
          onUndo();
        });
        // Auto-hide after 8 seconds
        setTimeout(function() {
          if (el.querySelector('.enhance-undo-btn')) {
            el.classList.add('hidden');
            el.innerHTML = '';
          }
        }, 8000);
      } else {
        el.textContent = message;
        // Auto-hide hints and errors after 4 seconds
        if (type !== 'loading') {
          setTimeout(function() {
            if (el.textContent === message) {
              el.classList.add('hidden');
              el.innerHTML = '';
            }
          }, 4000);
        }
      }
    }

    /**
     * Registers click handlers for the rail buttons.
     */
    function attachRailButtonHandlers() {
      railButtons.forEach((btn) => btn.addEventListener('click', handleRailButtonClick));
    }
  
    /**
     * Handles tool switching when a rail button is pressed.
     * @param {MouseEvent} event - Click event from the rail button.
     */
    function handleRailButtonClick(event) {
      const targetButton = event.currentTarget;
      const panelType = targetButton.getAttribute('data-panel');
  
      railButtons.forEach((button) => {
        const isActive = button === targetButton;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
  
      updateLeftPanel(panelType);
      switchViewer(panelType);
    }
  
    /**
     * Applies the markup-defined active rail button on initial load.
     */
    function bootstrapInitialPanel() {
      // Support ?panel=image|model|video|remesh|texture|animate from URL
      const urlPanel = new URLSearchParams(window.location.search).get('panel');
      let targetBtn;
      if (urlPanel) {
        targetBtn = document.querySelector('.timrx-3dprint .rail-btn[data-panel="' + urlPanel + '"]');
      }
      if (!targetBtn) {
        targetBtn = document.querySelector('.timrx-3dprint .rail-btn.is-active');
      }
      if (!targetBtn) return;

      // Activate the target button
      railButtons.forEach(function(btn) {
        var isTarget = btn === targetBtn;
        btn.classList.toggle('is-active', isTarget);
        btn.setAttribute('aria-pressed', isTarget ? 'true' : 'false');
      });

      var initialPanel = targetBtn.getAttribute('data-panel');
      updateLeftPanel(initialPanel);
      switchViewer(initialPanel);
      ensureThreeViewer();
    }
  
    /**
     * Initializes modal triggers, buttons, and drop-zone behavior.
     */
    function initModal() {
      openUploadTopBtn?.addEventListener('click', openModal);
      closeUploadBtn?.addEventListener('click', closeModal);
      cancelUploadBtn?.addEventListener('click', closeModal);
      continueUploadBtn?.addEventListener('click', handleContinueUpload);
      uploadModal?.addEventListener('click', handleBackdropClick);
      document.addEventListener('keydown', handleModalEscape);
  
      if (modelDrop && customModelUpload) {
        modelDrop.addEventListener('click', () => customModelUpload.click());
        customModelUpload.addEventListener('change', (event) => {
          const file = event.target.files && event.target.files[0];
          if (file) handleFileSelect(file);
        });
        modelDrop.addEventListener('dragover', handleDropZoneHover);
        modelDrop.addEventListener('dragleave', handleDropZoneLeave);
        modelDrop.addEventListener('drop', handleDropZoneDrop);
      }
    }
  
    /**
     * Opens the upload modal and focuses its content.
     */
    function openModal() {
      if (!uploadModal) return;
      uploadModal.classList.add('open');
      document.body.classList.add('has-modal');
      uploadModal.querySelector('.modal-content')?.focus();
    }
  
    /**
     * Closes the modal and resets any temporary state.
     */
    function closeModal() {
      if (!uploadModal) return;
      uploadModal.classList.remove('open');
      document.body.classList.remove('has-modal');
      resetModal();
    }
  
    /**
     * Attaches the optional left-panel "New model" button when present.
     */
    function bindLeftOpenButton() {
      const btn = document.getElementById('openUploadModal');
      if (btn) btn.addEventListener('click', openModal);
    }
  
    /**
     * Validates the form and loads the selected model into the viewer.
     */
    function handleContinueUpload() {
      if (!selectedFile) {
        if (modelFileHint) {
          modelFileHint.textContent = 'Please select a file first';
          modelFileHint.style.color = '#ff6b6b';
        }
        return;
      }
  
      const modelName = modelNameInput ? modelNameInput.value.trim() : '';
      if (!modelName) {
        if (modelFileHint) {
          modelFileHint.textContent = 'Please enter a model name';
          modelFileHint.style.color = '#ff6b6b';
        }
        return;
      }
  
      load3DModel(selectedFile, modelName);
      closeModal();
    }
  
    /**
     * Closes the modal when clicking the backdrop.
     * @param {MouseEvent} event - Click event fired on the modal container.
     */
    function handleBackdropClick(event) {
      if (event.target === uploadModal) closeModal();
    }
  
    /**
     * Provides an Escape-key fallback to close the modal.
     * @param {KeyboardEvent} event - Document keydown.
     */
    function handleModalEscape(event) {
      if (event.key === 'Escape' && uploadModal?.classList.contains('open')) {
        closeModal();
      }
    }
  
    /**
     * Highlights the drop zone while files hover over it.
     * @param {DragEvent} event - Drag event over the drop zone.
     */
    function handleDropZoneHover(event) {
      event.preventDefault();
      if (!modelDrop) return;
      modelDrop.style.borderColor = 'rgba(14, 165, 233, 0.5)';
      modelDrop.style.background  = 'rgba(14, 165, 233, 0.05)';
    }
  
    /**
     * Removes drop zone highlight styles.
     */
    function handleDropZoneLeave() {
      if (!modelDrop) return;
      modelDrop.style.borderColor = '';
      modelDrop.style.background  = '';
    }
  
    /**
     * Accepts dropped files and forwards them to the validator.
     * @param {DragEvent} event - Drop event on the zone.
     */
    function handleDropZoneDrop(event) {
      event.preventDefault();
      handleDropZoneLeave();
      const file = event.dataTransfer?.files && event.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    }
  
    /**
     * Validates the chosen file and updates helper copy.
     * @param {File} file - Uploaded GLB/GLTF file.
     */
    function handleFileSelect(file) {
      const maxSize = 50 * 1024 * 1024;
      const valid   = ['.glb', '.gltf'];
      const ext     = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  
      if (!valid.includes(ext)) {
        if (modelFileHint) {
          modelFileHint.textContent = 'Invalid file format. Please upload a GLB or GLTF file.';
          modelFileHint.style.color = '#ff6b6b';
        }
        return;
      }
  
      if (file.size > maxSize) {
        if (modelFileHint) {
          modelFileHint.textContent = 'File too large. Maximum size is 50MB.';
          modelFileHint.style.color = '#ff6b6b';
        }
        return;
      }
  
      selectedFile = file;
      if (modelFileHint) {
        modelFileHint.textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        modelFileHint.style.color = '#7dd3fc';
      }
      if (modelNameInput && !modelNameInput.value) {
        modelNameInput.value = file.name.replace(/\.[^.]+$/, '');
      }
    }
  
    /**
     * Clears the modal inputs and resets selection state.
     */
    function resetModal() {
      selectedFile = null;
      if (customModelUpload) customModelUpload.value = '';
      if (modelFileHint) {
        modelFileHint.textContent = '';
        modelFileHint.style.color = '';
      }
      if (modelNameInput) modelNameInput.value = '';
    }
  
    attachRailButtonHandlers();
    initViewerSettings();
    initModal();
    bootstrapInitialPanel();

})();

/* =============================================================================
   WORKSPACE HEADER DROPDOWN (separate from workspace - runs independently)
   ============================================================================= */
(function initWsDropdown() {
  const dropdown = document.querySelector('.ws-dropdown');
  if (!dropdown) return;

  const toggle = dropdown.querySelector('.ws-dropdown-toggle');
  const menu = dropdown.querySelector('.ws-dropdown-menu');
  if (!toggle || !menu) return;

  function open() {
    dropdown.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function close() {
    dropdown.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  // Toggle on click
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropdown.classList.contains('open') ? close() : open();
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      close();
    }
  });

  // Close on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  // Close on link click
  menu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', close);
  });
})();
