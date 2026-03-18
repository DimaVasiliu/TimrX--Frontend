/* ============================================================================
   TimrX 3D Print Workspace
   - Rail panel switching (Image / Model / Remesh / Texture / Rig / Video)
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
              <option value="standard" selected>Standard (10c)</option>
              <option value="high">2K (15c)</option>
            </select>
          </div>
          <span class="field-hint" id="imageQualityHint">Standard 10c • 2K 15c</span>

          <div class="provider-hint" id="imageProviderHint"></div>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time" id="imageGenTime">30 sec</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits" id="imageCreditsDisplay"><i class="fa-solid fa-coins"></i> 10</span>
          </div>
          <button type="button" id="generateImageBtn" class="gen-btn" title="10 credits" data-provider="openai">
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
            <button type="button" class="tab-btn" data-tab="multiimage3d" style="flex:1;background:transparent;border:none;border-radius:6px;padding:8px;color:#888;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s ease">
              Multi-Image
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

          <div class="tab-content hidden" id="multiimage3d">
            <div class="inline-field" style="margin-bottom:10px">
              <label for="multiImageModelName" style="font-size:12px">Name</label>
              <input type="text" id="multiImageModelName" placeholder="My Multi-View Model" style="width:100%;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:7px;color:#fff;font-size:12px" />
            </div>
            <label class="video-section-label">Upload 1–4 Reference Images</label>
            <div id="multiImageGrid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px">
              <div class="multi-img-slot" data-slot="0">
                <div class="video-drop-zone" id="multiImgDrop0" style="height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:20px;height:20px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:11px;color:#888;margin-top:4px">Image 1</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" style="display:none;width:100%;height:90px;object-fit:cover;border-radius:7px" />
              </div>
              <div class="multi-img-slot" data-slot="1">
                <div class="video-drop-zone" id="multiImgDrop1" style="height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:20px;height:20px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:11px;color:#888;margin-top:4px">Image 2</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" style="display:none;width:100%;height:90px;object-fit:cover;border-radius:7px" />
              </div>
              <div class="multi-img-slot" data-slot="2">
                <div class="video-drop-zone" id="multiImgDrop2" style="height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:20px;height:20px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:11px;color:#888;margin-top:4px">Image 3</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" style="display:none;width:100%;height:90px;object-fit:cover;border-radius:7px" />
              </div>
              <div class="multi-img-slot" data-slot="3">
                <div class="video-drop-zone" id="multiImgDrop3" style="height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:20px;height:20px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:11px;color:#888;margin-top:4px">Image 4</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" style="display:none;width:100%;height:90px;object-fit:cover;border-radius:7px" />
              </div>
            </div>
            <span class="field-hint">Upload 1–4 images of the same object from different angles for best results</span>
            <span class="field-hint" style="color:#b08a3e;font-size:10px;margin-top:2px">Images are sent as data URLs — keep each file under 5 MB for reliable uploads</span>
            <div id="multiImageCount" style="font-size:11px;color:#666;margin-top:4px">0 / 4 images selected</div>
          </div>
        </div>

        <div class="card gen-options-card">
          <div class="field-row">
            <span class="field-label-inline">AI Model <span class="info-dot" title="Select the AI model version">ⓘ</span></span>
            <select id="modelAIModel" class="field-select-inline">
              <option value="latest" selected>Meshy 6</option>
              <option value="meshy-5">Meshy 5</option>
            </select>
          </div>

          <div class="field-row">
            <span class="field-label-inline">Pose Mode <span class="info-dot" title="Generate in a specific pose for rigging">ⓘ</span></span>
            <select id="modelPoseMode" class="field-select-inline">
              <option value="" selected>None</option>
              <option value="a-pose">A-Pose</option>
              <option value="t-pose">T-Pose</option>
            </select>
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

          <div class="field-row">
            <span class="field-label-inline">Model Type <span class="info-dot" title="Standard for detailed models, Low Poly for simplified geometry">ⓘ</span></span>
            <select id="modelModelType" class="field-select-inline">
              <option value="" selected>Default</option>
              <option value="standard">Standard</option>
              <option value="lowpoly">Low Poly</option>
            </select>
          </div>

          <details class="advanced-toggles" style="margin-top:8px">
            <summary style="font-size:11px;color:#888;cursor:pointer;user-select:none">Advanced Options</summary>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#ccc;cursor:pointer">
                <input type="checkbox" id="modelShouldRemesh" style="accent-color:#6366f1">
                Auto-remesh output
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#ccc;cursor:pointer">
                <input type="checkbox" id="modelShouldTexture" checked style="accent-color:#6366f1">
                Generate textures
              </label>
            </div>
          </details>

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
          <h3>Remesh Preset</h3>
          <div class="remesh-presets" id="remeshPresets">
            <button type="button" class="remesh-preset is-active" data-preset="print-ready" data-poly="50000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.72 13.829a5.25 5.25 0 01-.905-2.578L4.5 10.5l1.315-.751A5.25 5.25 0 016.72 7.171L8 6l.754 1.321a5.25 5.25 0 012.578.905L12.5 9.5l-1.168.674a5.25 5.25 0 01-.905 2.578L9.5 14l-.754-1.321a5.25 5.25 0 01-2.026.15z"/><path d="M15 4l.5 1a3.5 3.5 0 001.5 1.5l1 .5-1 .5a3.5 3.5 0 00-1.5 1.5L15 10l-.5-1a3.5 3.5 0 00-1.5-1.5L12 7l1-.5a3.5 3.5 0 001.5-1.5L15 4z"/><path d="M6 14v4a2 2 0 002 2h8a2 2 0 002-2v-4"/></svg>
              <span class="remesh-preset__name">Print Ready</span>
              <span class="remesh-preset__desc">50K polys - optimized for 3D printing</span>
            </button>
            <button type="button" class="remesh-preset" data-preset="game-asset" data-poly="10000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875S10.5 3.089 10.5 4.125c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.95 3.064 2.109 4.112A6.002 6.002 0 0112 12a6.002 6.002 0 013.461-1.458 6.998 6.998 0 002.109-4.112 48.39 48.39 0 01-4.163.3.64.64 0 01-.657-.643z"/><path d="M3 18h18M5.25 18v-3h13.5v3"/></svg>
              <span class="remesh-preset__name">Game Asset</span>
              <span class="remesh-preset__desc">10K polys - low-poly for real-time</span>
            </button>
            <button type="button" class="remesh-preset" data-preset="high-detail" data-poly="100000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/><path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"/></svg>
              <span class="remesh-preset__name">High Detail</span>
              <span class="remesh-preset__desc">100K polys - maximum fidelity</span>
            </button>
            <button type="button" class="remesh-preset" data-preset="quad-clean" data-poly="30000" data-topo="quad">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              <span class="remesh-preset__name">Quad Clean</span>
              <span class="remesh-preset__desc">30K quads - clean topology for animation</span>
            </button>
          </div>

          <button type="button" class="remesh-advanced-toggle" id="remeshAdvancedToggle">
            <span>Advanced Settings</span>
            <svg class="remesh-advanced-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="remesh-advanced remesh-advanced--collapsed" id="remeshAdvanced">
            <div class="inline-field">
              <label for="targetPolyCount">Poly Count</label>
              <input type="number" id="targetPolyCount" value="50000" min="100" max="1000000" step="1000">
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
          </div>
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
          <h3>Texture Description</h3>
          <textarea id="texturePrompt" placeholder="Rusty metal with scratches and weathering..."></textarea>
          <div class="enhance-row">
            <span class="field-hint">Describe material, surface, and color</span>
            <button type="button" class="enhance-btn" data-enhance-mode="texture" data-enhance-target="#texturePrompt" title="Make this prompt clearer and more detailed">
              <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
              <span class="enhance-btn-label">Enhance</span>
            </button>
          </div>
          <div class="enhance-feedback hidden" data-enhance-feedback="texture"></div>

          <div class="material-chips" id="materialChips">
            <button type="button" class="material-chip" data-material="Rusty weathered metal with scratches, oxidation, and patina">Rusty Metal</button>
            <button type="button" class="material-chip" data-material="Polished natural wood grain with warm tones and subtle varnish">Polished Wood</button>
            <button type="button" class="material-chip" data-material="Rough carved stone with moss accents and natural texture">Stone</button>
            <button type="button" class="material-chip" data-material="Soft woven fabric with visible thread pattern and gentle folds">Fabric</button>
            <button type="button" class="material-chip" data-material="Smooth glossy plastic with subtle surface imperfections">Plastic</button>
            <button type="button" class="material-chip" data-material="Transparent glass with refractive edges, caustics, and slight tint">Glass</button>
            <button type="button" class="material-chip" data-material="Matte carbon fiber weave with subtle reflective highlights">Carbon Fiber</button>
            <button type="button" class="material-chip" data-material="Glazed ceramic with smooth finish and subtle crackle pattern">Ceramic</button>
          </div>
        </div>

        <div class="card">
          <div class="field-row">
            <span class="field-label-inline">PBR Maps</span>
            <label class="toggle-switch">
              <input type="checkbox" id="texturePBRToggle" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <input type="hidden" id="textureType" value="pbr-all">

          <button type="button" class="remesh-advanced-toggle" id="textureAdvancedToggle">
            <span>Advanced Settings</span>
            <svg class="remesh-advanced-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="remesh-advanced remesh-advanced--collapsed" id="textureAdvanced">
            <div class="inline-field">
              <label for="textureResolution">Resolution</label>
              <select id="textureResolution">
                <option value="1024x1024">1024x1024</option>
                <option value="2048x2048" selected>2048x2048</option>
                <option value="4096x4096">4096x4096</option>
              </select>
            </div>
            <label style="margin-top:8px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px">
              <input type="checkbox" id="seamless" checked>
              <span>Preserve Original UV</span>
            </label>
          </div>
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

      rig: `
        <!-- Rig Wizard: Step 1 — Eligibility -->
        <div id="rigWizardStep1" class="card">
          <h3>Humanoid Rig Wizard</h3>
          <div style="padding:8px 0;font-size:12px;color:#aaa;line-height:1.6">
            <p style="margin:0 0 8px;color:#e0e0e0;font-weight:500">Before rigging, confirm your model meets these requirements:</p>
            <ul style="margin:0;padding-left:18px;list-style:disc">
              <li><strong>Humanoid / bipedal</strong> — standard body with head, torso, 2 arms, 2 legs</li>
              <li><strong>Clear limbs</strong> — arms and legs clearly separated from body</li>
              <li><strong>Textured preferred</strong> — untextured meshes may produce lower quality rigs</li>
              <li><strong>Under 300K faces</strong> — use Remesh first if your model exceeds this</li>
            </ul>
            <p style="margin:10px 0 0;padding:8px 10px;background:rgba(255,200,50,.08);border-radius:6px;border-left:3px solid rgba(255,200,50,.4);font-size:11px;color:#cca030">
              Non-humanoid models (animals, vehicles, objects) are not supported for auto-rigging.
            </p>
          </div>
          <button type="button" id="rigWizardNext1" class="gen-btn gen-btn--rail" style="margin-top:10px;width:100%">
            My model is humanoid — Continue
          </button>
        </div>

        <!-- Rig Wizard: Step 2 — Alignment guidance (UI only) -->
        <div id="rigWizardStep2" class="card" style="display:none">
          <h3>Alignment Guidance</h3>
          <div style="padding:8px 0;font-size:12px;color:#aaa;line-height:1.6">
            <p style="margin:0 0 8px;color:#e0e0e0;font-weight:500">For best results, ensure your model is:</p>
            <ul style="margin:0;padding-left:18px;list-style:disc">
              <li><strong>Centered</strong> at origin (0,0,0)</li>
              <li><strong>Facing forward</strong> along the default axis (typically -Z or +Z)</li>
              <li><strong>Standing upright</strong> in a neutral T-pose or A-pose</li>
              <li><strong>Feet on ground plane</strong> (Y=0)</li>
            </ul>
            <p style="margin:10px 0 0;font-size:11px;color:#888">
              These are visual guidelines — no alignment data is sent to the rigging service.
            </p>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;width:100%">
            <button type="button" id="rigWizardBack2" class="gen-btn gen-btn--rail" style="flex:0 0 60px;padding:8px 12px;font-size:12px">Back</button>
            <button type="button" id="rigWizardNext2" class="gen-btn gen-btn--rail" style="flex:1;min-width:0;padding:8px 12px;font-size:12px">Continue</button>
          </div>
        </div>

        <!-- Rig Wizard: Step 3 — Source + Height -->
        <div id="rigWizardStep3" class="card" style="display:none">
          <h3>Model & Settings</h3>
          <div class="inline-field">
            <label for="rigModelSelect">Source</label>
            <select id="rigModelSelect">
              <option value="current" selected>Current Model</option>
              <option value="upload">Upload New Model</option>
            </select>
          </div>

          <div id="rigModelUploadSection" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="rigModelUpload" style="font-size:12px">Upload 3D Model (GLB only)</label>
            <div id="rigModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:7px;padding:18px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:5px">
              <svg style="width:30px;height:30px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0 0 3px;font-size:12px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">GLB format (required by Meshy)</span>
              <input type="file" id="rigModelUpload" accept=".glb" hidden />
            </div>
            <div id="rigModelFileName" style="display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,.05);border-radius:7px;font-size:12px;color:#ccc"></div>
          </div>

          <div class="inline-field" style="margin-top:12px">
            <label for="rigHeight">Height (meters)</label>
            <input type="number" id="rigHeight" value="1.7" min="0.1" max="5.0" step="0.1">
          </div>
          <span class="field-hint">Approximate height of the character model (default 1.7m)</span>

          <div style="display:flex;gap:8px;margin-top:12px;width:100%">
            <button type="button" id="rigWizardBack3" class="gen-btn gen-btn--rail" style="flex:0 0 60px;padding:8px 12px;font-size:12px">Back</button>
          </div>
        </div>

        <!-- Rig Wizard: Step 4 — Submit -->
        <div id="rigWizardStep4" class="card gen-footer-card" style="display:none">
          <div class="gen-meta">
            <span class="gen-time">2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 15</span>
          </div>
          <button type="button" id="startRigBtn" class="gen-btn gen-btn--rail" title="15 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 014 4v1h2a1 1 0 011 1v2a1 1 0 01-1 1h-1v5l1 4H6l1-4v-5H6a1 1 0 01-1-1V8a1 1 0 011-1h2V6a4 4 0 014-4z"/></svg>
            Start Rigging
          </button>
        </div>

        <!-- Rig Results (shown after successful rig) -->
        <div id="rigResultsSection" style="display:none">
          <div class="card">
            <h3>Rigged Model</h3>
            <div id="rigDownloadLinks" style="display:flex;gap:8px;flex-wrap:wrap"></div>
          </div>

          <div class="card">
            <h3>Built-in Animations</h3>
            <div id="rigBuiltinAnimations" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"></div>
          </div>

          <!-- Animation Library -->
          <div class="card">
            <h3>Animation Library</h3>
            <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
              <input type="text" id="animLibrarySearch" placeholder="Search animations..." style="flex:1;min-width:140px;padding:7px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font-size:12px">
              <select id="animLibraryCategory" style="padding:7px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font-size:12px">
                <option value="">All Categories</option>
                <option value="DailyActions">Daily Actions</option>
                <option value="WalkAndRun">Walk & Run</option>
                <option value="Dancing">Dancing</option>
                <option value="BodyMovements">Body Movements</option>
                <option value="Fighting">Fighting</option>
              </select>
            </div>
            <div id="animLibraryGrid" style="max-height:280px;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;padding-right:4px"></div>
            <div id="animLibraryEmpty" style="display:none;text-align:center;padding:20px;color:#666;font-size:12px">No animations found</div>

            <input type="hidden" id="rigAnimationActionId" value="">

            <div class="gen-footer-card" style="margin-top:12px">
              <div class="gen-meta">
                <span class="gen-time">1 min</span>
                <span class="gen-divider">|</span>
                <span class="gen-credits"><i class="fa-solid fa-coins"></i> 10</span>
              </div>
              <button type="button" id="applyAnimationBtn" class="gen-btn gen-btn--rail" title="10 credits" disabled>
                <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Apply Animation
              </button>
            </div>
          </div>

          <div id="animResultsSection" style="display:none">
            <div class="card">
              <h3>Animation Result</h3>
              <div id="animDownloadLinks" style="display:flex;gap:8px;flex-wrap:wrap"></div>
            </div>
          </div>
        </div>
      `,

      video: `
      <input type="hidden" id="videoModeValue" value="text2video" />
      <input type="hidden" id="videoAIProvider" value="vertex" />
      <input type="hidden" id="videoMotionPreset" value="" />
      <input type="hidden" id="seedanceTier" value="fast" />

      <!-- Header: Provider + Mode Selection -->
      <div class="card video-header-card">
        <div class="video-header-row">
          <div class="video-provider-switcher" id="videoProviderSwitcher">
            <button type="button" class="video-provider-btn is-active" data-provider="vertex"><span class="vpb-name">Veo 3.1</span><span class="vpb-tag">Google &middot; Premium</span></button>
            <button type="button" class="video-provider-btn" data-provider="fal_seedance"><span class="vpb-name">Seedance</span><span class="vpb-tag">Fast &amp; Flexible</span></button>
            <button type="button" class="video-provider-btn video-provider-btn--legacy video-provider-btn--stacked" data-provider="seedance">
              <span class="vpb-name">Seedance 2.0</span>
              <span class="vpb-tag">PiAPI &middot; Fast / Preview</span>
            </button>
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
          <span class="field-hint enhance-provider-hint" id="enhanceProviderHint">Keep prompts simple for best results.</span>
          <button type="button" class="enhance-btn" data-enhance-mode="video" data-enhance-target="#videoTextPrompt" title="Instantly enhance with smart local engine">
            <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
            <span class="enhance-btn-label">Enhance</span>
          </button>
          <button type="button" class="enhance-reroll-btn hidden" id="enhanceRerollBtn" title="Re-roll enhancement with new variation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          </button>
        </div>
        <div class="enhance-feedback hidden" data-enhance-feedback="video"></div>
        <div class="enhance-score-bar hidden" id="enhanceScoreBar">
          <div class="enhance-score-fill" id="enhanceScoreFill"></div>
          <span class="enhance-score-label" id="enhanceScoreLabel"></span>
        </div>
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

      <!-- Image-to-Video: Dual-mode (Animate / Transition) -->
      <div class="card video-mode-content video-input-card hidden" id="image2videoContent">

        <!-- Image sub-mode switcher (hidden by default for Veo, shown for Seedance) -->
        <div class="video-img-mode-switcher hidden" id="videoImgModeSwitcher">
          <button type="button" class="video-img-mode-btn is-active" data-img-mode="animate_image">Animate from Image</button>
          <button type="button" class="video-img-mode-btn" data-img-mode="image_transition">Transition Between Two Images</button>
          <button type="button" class="video-img-mode-btn" data-img-mode="experimental_morph" id="experimentalMorphBtn" style="display:none">Morph (Beta)</button>
        </div>
        <input type="hidden" id="videoImgModeValue" value="animate_image" />

        <!-- ── MODE 1: Animate Image ── -->
        <div class="video-img-mode-content" id="animateImageContent">
          <span class="field-hint" style="margin-bottom:8px">Bring a single image to life with motion and camera direction.</span>

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

          <div class="vs-section vs-animation-prompt-section hidden">
            <label for="videoAnimationPrompt" class="vs-label">Animation Prompt</label>
            <textarea id="videoAnimationPrompt" rows="3" placeholder="Describe what should happen in the scene.
Example: The man slowly looks up, wind moves his jacket, subtle cinematic motion."></textarea>
          </div>
        </div>

        <!-- ── MODE 2: Image Transition ── -->
        <div class="video-img-mode-content hidden" id="imageTransitionContent">
          <span class="field-hint" style="margin-bottom:8px">Create a cinematic transition between two images. The video smoothly interpolates from the first frame to the last frame. Available on Veo and Seedance.</span>

          <div class="video-transition-grid">
            <div class="video-transition-col">
              <label class="video-section-label">Start Image</label>
              <div id="videoStartImageDrop" class="video-drop-zone">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>Upload</span>
                <input type="file" id="videoStartImageSource" accept="image/*" hidden />
              </div>
              <div class="video-preview-wrap">
                <img id="videoStartImagePreview" class="video-preview-img" alt="Start"/>
                <div class="video-preview-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <path d="M21 15l-5-5L5 21"/>
                  </svg>
                </div>
              </div>
            </div>

            <div class="video-transition-arrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </div>

            <div class="video-transition-col">
              <label class="video-section-label">End Image</label>
              <div id="videoEndImageDrop" class="video-drop-zone">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>Upload</span>
                <input type="file" id="videoEndImageSource" accept="image/*" hidden />
              </div>
              <div class="video-preview-wrap">
                <img id="videoEndImagePreview" class="video-preview-img" alt="End"/>
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

          <div class="vs-section vs-animation-prompt-section">
            <label for="videoTransitionPrompt" class="vs-label">Transition Prompt</label>
            <textarea id="videoTransitionPrompt" rows="3" placeholder="Describe how image one should transform into image two.
Example: The calm expression slowly turns into anger while the camera pushes in."></textarea>
          </div>
        </div>

        <!-- ── MODE 3: Experimental Morph (Beta) ── -->
        <div class="video-img-mode-content hidden" id="experimentalMorphContent">
          <div class="field-hint" style="margin-bottom:8px;padding:8px 10px;background:rgba(255,190,60,0.12);border-radius:6px;border-left:3px solid #ffbe3c;font-size:12px;line-height:1.4">
            <strong>Experimental Morph (Beta)</strong><br>
            Uses two reference images where available. Results may not behave like exact first-to-last-frame interpolation. This feature is experimental and may produce unexpected results.
          </div>

          <div class="video-transition-grid">
            <div class="video-transition-col">
              <label class="video-section-label">Image 1</label>
              <div id="morphStartImageDrop" class="video-drop-zone">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>Upload</span>
                <input type="file" id="morphStartImageSource" accept="image/*" hidden />
              </div>
              <div class="video-preview-wrap">
                <img id="morphStartImagePreview" class="video-preview-img" alt="Image 1"/>
                <div class="video-preview-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <path d="M21 15l-5-5L5 21"/>
                  </svg>
                </div>
              </div>
            </div>

            <div class="video-transition-arrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </div>

            <div class="video-transition-col">
              <label class="video-section-label">Image 2</label>
              <div id="morphEndImageDrop" class="video-drop-zone">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>Upload</span>
                <input type="file" id="morphEndImageSource" accept="image/*" hidden />
              </div>
              <div class="video-preview-wrap">
                <img id="morphEndImagePreview" class="video-preview-img" alt="Image 2"/>
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

          <div class="vs-section vs-animation-prompt-section">
            <label for="morphPrompt" class="vs-label">Morph Prompt</label>
            <textarea id="morphPrompt" rows="3" placeholder="Describe how the two images should blend or morph together.
Example: Smooth morphing transition with cinematic camera movement."></textarea>
          </div>
        </div>

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
              <button type="button" id="videoLoopBtn" class="vs-toggle-btn" title="Loop playback">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
                <span>Loop</span>
              </button>
              <input type="hidden" id="videoLoop" value="false">
            </div>
          </div>
          <span class="vs-hint" id="videoResolutionHint">Higher quality uses more credits. Pro and 4K require 8s duration.</span>
        </div>

        <!-- Camera Motion (optional) -->
        <div class="vs-section vs-custom-section">
          <span class="vs-label">Camera Motion <span class="vs-optional">(optional)</span></span>
          <textarea id="videoMotion" rows="2" placeholder="slow cinematic zoom in, camera orbit around subject, handheld camera movement, dolly forward"></textarea>
        </div>
      </div>

      <!-- Video Templates (Part 14) — dynamically rendered from VIDEO_TEMPLATE_CATEGORIES -->
      <div class="card video-templates-card">
        <button type="button" class="vs-motion-trigger" id="videoTemplatesTrigger">
          <span class="vs-label">Prompt Templates</span>
          <svg class="vs-motion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div id="videoTemplatesPanel" class="vs-presets vs-presets--collapsed"></div>
      </div>

      <!-- Video Gallery shortcut -->
      <button type="button" class="video-gallery-btn" id="videoGalleryBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><path d="M10 8l6 4-6 4V8z"/></svg>
        Browse Video Gallery
      </button>

      <!-- Credit Estimate + Generate Buttons -->
      <div class="card gen-footer-card video-gen-footer">
        <div class="gen-meta">
          <span class="gen-time" id="videoGenTime">~2 min</span>
          <span class="gen-divider">|</span>
          <span class="gen-credits" id="videoCreditsDisplay"><i class="fa-solid fa-coins"></i> 70</span>
        </div>
        <div class="gen-btn-row">
          <button type="button" id="previewVideoBtn" class="gen-btn gen-btn--preview" title="Quick preview (~10 credits)" disabled>
            Preview
          </button>
          <button type="button" id="generateVideoBtn" class="gen-btn" title="75 credits" data-base-credits="75" data-video-mode="text2video" data-provider="vertex" disabled>
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            Generate
          </button>
        </div>
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
      camera.position.set(3.1, 2.7, 4.4);

      // Try to create renderer with error handling
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: viewerCanvas, antialias: true, preserveDrawingBuffer: true });
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
  
          camera.position.set(3.1, 2.7, 4.4);
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
          const isMultiImage = (targetTab === 'multiimage3d');
          const cost = (isImage3d || isMultiImage) ? 30 : 20;

          if (modelCredits) {
            modelCredits.innerHTML = `<i class="fa-solid fa-coins"></i> ${cost}`;
          }

          if (generateBtn) {
            generateBtn.title = `${cost} credits`;
            let costBadge = generateBtn.querySelector('.btn-cost-badge');
            if (costBadge) {
              costBadge.textContent = cost;
            }
            // Multi-image uses same cost as image-to-3d (30c); tab detection in onGenerateClick routes to the correct endpoint
            generateBtn.dataset.currentAction = (isMultiImage || isImage3d) ? 'image-to-3d' : 'text-to-3d';
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

      // Multi-Image to 3D: slot uploads
      const multiImageGrid = leftStack.querySelector('#multiImageGrid');
      if (multiImageGrid) {
        const slots = multiImageGrid.querySelectorAll('.multi-img-slot');
        slots.forEach(slot => {
          const dropZone = slot.querySelector('.video-drop-zone');
          const fileInput = slot.querySelector('.multi-img-input');
          const preview = slot.querySelector('.multi-img-preview');

          if (dropZone && fileInput && preview) {
            dropZone.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', function () {
              if (this.files && this.files[0]) {
                const reader = new FileReader();
                reader.onload = (e) => {
                  preview.src = e.target.result;
                  preview.style.display = 'block';
                  dropZone.style.display = 'none';
                  // Update count
                  const count = multiImageGrid.querySelectorAll('.multi-img-preview[style*="display: block"], .multi-img-preview[style*="display:block"]').length;
                  const countEl = leftStack.querySelector('#multiImageCount');
                  if (countEl) countEl.textContent = `${count} / 4 images selected`;
                };
                reader.readAsDataURL(this.files[0]);
              }
            });
            dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'rgba(255,255,255,.3)'; });
            dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
            dropZone.addEventListener('drop', (e) => {
              e.preventDefault();
              dropZone.style.borderColor = '';
              if (e.dataTransfer.files?.[0]) {
                fileInput.files = e.dataTransfer.files;
                fileInput.dispatchEvent(new Event('change'));
              }
            });
            // Click preview to remove
            preview.addEventListener('click', () => {
              preview.style.display = 'none';
              preview.src = '';
              dropZone.style.display = '';
              fileInput.value = '';
              const count = multiImageGrid.querySelectorAll('.multi-img-preview[style*="display: block"], .multi-img-preview[style*="display:block"]').length;
              const countEl = leftStack.querySelector('#multiImageCount');
              if (countEl) countEl.textContent = `${count} / 4 images selected`;
            });
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

      // ── Image sub-mode switcher (Animate / Transition / Morph) ──
      const imgModeSwitcher = leftStack.querySelector('#videoImgModeSwitcher');
      if (imgModeSwitcher) {
        const imgModeBtns = imgModeSwitcher.querySelectorAll('.video-img-mode-btn');
        const imgModeValue = leftStack.querySelector('#videoImgModeValue');
        const animatePanel = leftStack.querySelector('#animateImageContent');
        const transitionPanel = leftStack.querySelector('#imageTransitionContent');
        const morphPanel = leftStack.querySelector('#experimentalMorphContent');

        imgModeBtns.forEach(btn => {
          btn.addEventListener('click', function () {
            const mode = this.dataset.imgMode;
            imgModeBtns.forEach(b => b.classList.remove('is-active'));
            this.classList.add('is-active');
            if (imgModeValue) imgModeValue.value = mode;

            if (animatePanel) animatePanel.classList.toggle('hidden', mode !== 'animate_image');
            if (transitionPanel) transitionPanel.classList.toggle('hidden', mode !== 'image_transition');
            if (morphPanel) morphPanel.classList.toggle('hidden', mode !== 'experimental_morph');

            validateVideoForm();
          });
        });
      }

      // ── Transition mode: Start Image upload ──
      function wireDropZone(dropId, sourceId, previewId) {
        const drop = leftStack.querySelector('#' + dropId);
        const source = leftStack.querySelector('#' + sourceId);
        const preview = leftStack.querySelector('#' + previewId);
        if (!drop || !source || !preview) return;

        drop.addEventListener('click', () => source.click());
        source.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const reader = new FileReader();
            reader.onload = (e) => { preview.src = e.target.result; preview.style.display = 'block'; };
            reader.readAsDataURL(this.files[0]);
            validateVideoForm();
          }
        });
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'rgba(255,255,255,.3)'; });
        drop.addEventListener('dragleave', () => { drop.style.borderColor = 'rgba(255,255,255,.15)'; });
        drop.addEventListener('drop', (e) => {
          e.preventDefault();
          drop.style.borderColor = 'rgba(255,255,255,.15)';
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            source.files = e.dataTransfer.files;
            source.dispatchEvent(new Event('change'));
          }
        });
      }
      wireDropZone('videoStartImageDrop', 'videoStartImageSource', 'videoStartImagePreview');
      wireDropZone('videoEndImageDrop', 'videoEndImageSource', 'videoEndImagePreview');
      // Experimental Morph drop zones
      wireDropZone('morphStartImageDrop', 'morphStartImageSource', 'morphStartImagePreview');
      wireDropZone('morphEndImageDrop', 'morphEndImageSource', 'morphEndImagePreview');

      // Transition prompt validation
      const transitionPromptEl = leftStack.querySelector('#videoTransitionPrompt');
      if (transitionPromptEl) {
        transitionPromptEl.addEventListener('input', validateVideoForm);
      }
      // Morph prompt validation
      const morphPromptEl = leftStack.querySelector('#morphPrompt');
      if (morphPromptEl) {
        morphPromptEl.addEventListener('input', validateVideoForm);
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
      const videoLoop = leftStack.querySelector('#videoLoop');
      const videoMotion = leftStack.querySelector('#videoMotion');
      const videoAspectRatio = leftStack.querySelector('#videoAspectRatio');
      const videoQuality = leftStack.querySelector('#videoQuality');
      const videoQualityWrap = leftStack.querySelector('#videoQualityWrap');
      const videoAIProvider = leftStack.querySelector('#videoAIProvider');

      // ========================================
      // VIDEO: Pricing Constants (Veo only - resolution + duration based)
      // ========================================
      // Fallback credits by resolution and duration (used if backend unavailable)
      // Actual costs are fetched from backend via WorkspaceCredits
      // Mapping: Standard (HD) = 720p, Pro (Full HD) = 1080p
      const VIDEO_CREDIT_RULES_FALLBACK = {
        '720p':  { 4: 75, 6: 100, 8: 125 },  // Standard (HD)
        '1080p': { 8: 150 },                  // Pro (Full HD) - requires 8s
        '4k':    { 8: 200 }                   // Ultra (4K) - requires 8s
      };

      // Image-to-Video fallback costs (premium over text-to-video)
      const VIDEO_IMAGE_CREDIT_RULES_FALLBACK = {
        '720p':  { 4: 110, 6: 140, 8: 170 },
        '1080p': { 8: 200 },
        '4k':    { 8: 250 }
      };
      // Seedance credit costs — explicit lookup tables (DB is authoritative)
      const SEEDANCE_COSTS = {
        fast:    { 5: 80, 10: 150, 15: 225 },
        preview: { 5: 125, 10: 250, 15: 375 }
      };
      // Approximate CPS for fallback only (DB values are authoritative)
      const SEEDANCE_CPS = { fast: 16, preview: 25 };
      // fal Seedance 1.5 Pro — explicit lookup (DB is authoritative)
      const FAL_SEEDANCE_COSTS = { 5: 80, 10: 150, 12: 180 };
      const FAL_SEEDANCE_CPS = 16;
      // Valid durations per resolution (Veo constraints)
      const VIDEO_VALID_DURATIONS = {
        '720p':  [4, 6, 8],   // Standard: all durations
        '1080p': [8],         // Pro: 8s only
        '4k':    [8]          // Ultra: 8s only
      };
      // Time estimates by quality tier
      const VIDEO_TIME_ESTIMATE = { '720p': '~2 min', '1080p': '~3 min', '4k': '~5 min' };
      // UI labels for resolution values
      const VIDEO_QUALITY_LABELS = {
        '720p': 'Standard (HD)',
        '1080p': 'Pro (Full HD)',
        '4k': 'Ultra (4K)'
      };

      // Map simplified aspect values to API format (no square/1:1 - not supported by Veo)
      const VIDEO_ASPECT_MAP = {
        landscape: '16:9',
        portrait: '9:16'
      };

      // ========================================
      // VIDEO_PROVIDER_CONFIG — single source of truth for provider-specific UI
      // ========================================
      const VIDEO_PROVIDER_CONFIG = {
        vertex: {
          label: 'Veo 3.1',
          capabilities: { textToVideo: true, imageAnimate: true, imageTransition: true, animationPrompt: false },
          durations: [
            { value: '4', text: '4 seconds', selected: true },
            { value: '6', text: '6 seconds' },
            { value: '8', text: '8 seconds' },
          ],
          aspects: [
            { value: 'landscape', text: '16:9 Landscape', selected: true },
            { value: 'portrait', text: '9:16 Portrait' },
          ],
          styles: [
            { value: 'auto', text: 'Auto', selected: true },
            { value: 'cinematic_realism', text: 'Cinematic Realism' },
            { value: 'product_ad', text: 'Product Ad' },
            { value: 'anime_motion', text: 'Anime Motion' },
            { value: 'documentary', text: 'Documentary' },
            { value: 'dreamlike_surreal', text: 'Dreamlike Surreal' },
            { value: 'aerial', text: 'Aerial' },
            { value: 'timelapse', text: 'Timelapse' },
            { value: 'slow_motion', text: 'Slow-Mo' },
            { value: 'noir', text: 'Noir' },
          ],
          qualities: [
            { value: '720p', text: 'Standard (HD) — Recommended', selected: true },
            { value: '1080p', text: 'Pro (Full HD) — Slower', riskNote: 'Higher resolutions may take longer and can fail more often.' },
            { value: '4k', text: 'Ultra (4K) — Experimental', experimental: true, riskNote: 'Higher resolutions may take longer and can fail more often.' },
          ],
          showQuality: true,
          showMotion: true,
          showTier: false,
          showLoop: true,
          hint: '720p is the most reliable. Pro and 4K require 8s duration and are more likely to time out.',
          timeEstimate: (s) => VIDEO_TIME_ESTIMATE[s.resolution] || '~2 min',
        },
        fal_seedance: {
          label: 'Seedance',
          capabilities: { textToVideo: true, imageAnimate: true, imageTransition: true, animationPrompt: true },
          durations: [
            { value: '5', text: '5 sec', selected: true },
            { value: '10', text: '10 sec' },
            { value: '12', text: '12 sec' },
          ],
          aspects: [
            { value: '16:9', text: '16:9 Landscape', selected: true },
            { value: '9:16', text: '9:16 Portrait' },
            { value: '1:1', text: '1:1 Square' },
          ],
          styles: [
            { value: 'auto', text: 'Auto', selected: true },
            { value: 'cinematic', text: 'Cinematic' },
            { value: 'realistic', text: 'Realistic' },
            { value: 'anime', text: 'Anime' },
            { value: 'fantasy', text: 'Fantasy' },
            { value: 'cyberpunk', text: 'Cyberpunk' },
            { value: 'cartoon', text: 'Cartoon' },
          ],
          showQuality: false,
          showMotion: false,
          showTier: false,
          showLoop: false,
          hint: 'Fast generation with audio. 5s, 10s, or 12s clips.',
          timeEstimate: () => '~1\u20133 min',
        },
        seedance: {
          label: 'Seedance 2.0',
          capabilities: { textToVideo: true, imageAnimate: true, imageTransition: false, experimentalMorph: true, animationPrompt: true },
          durations: [
            { value: '5', text: '5 sec', selected: true },
            { value: '10', text: '10 sec' },
            { value: '15', text: '15 sec' },
          ],
          aspects: [
            { value: '16:9', text: '16:9 Landscape', selected: true },
            { value: '9:16', text: '9:16 Portrait' },
            { value: '1:1', text: '1:1 Square' },
          ],
          styles: [
            { value: 'auto', text: 'Auto', selected: true },
            { value: 'cinematic', text: 'Cinematic' },
            { value: 'realistic', text: 'Realistic' },
            { value: 'anime', text: 'Anime' },
            { value: 'fantasy', text: 'Fantasy' },
            { value: 'cyberpunk', text: 'Cyberpunk' },
            { value: 'cartoon', text: 'Cartoon' },
          ],
          showQuality: false,
          showMotion: false,
          showTier: true,
          showLoop: false,
          hint: 'Queue times vary with demand. Preview tier may take longer.',
          timeEstimate: (s) => s.seedanceTier === 'preview' ? '~2\u201310 min' : '~1\u20133 min',
        },
      };

      /**
       * Get current video settings from UI
       * @returns {Object} Video settings object
       */
      function getVideoSettingsFromUI() {
        const provider = videoAIProvider?.value || 'vertex';
        const isSeedanceFamily = (provider === 'seedance' || provider === 'fal_seedance');
        const durationRaw = videoDuration?.value || (isSeedanceFamily ? '5' : '4');
        const resolutionRaw = videoQuality?.value || '720p';
        const aspectRaw = videoAspectRatio?.value || 'landscape';

        const seedanceTierInput = leftStack.querySelector('#seedanceTier');
        const seedanceTier = (provider === 'seedance') ? (seedanceTierInput?.value || 'fast') : null;

        const settings = {
          provider: provider,
          durationSec: parseInt(durationRaw, 10) || (isSeedanceFamily ? 5 : 4),
          resolution: isSeedanceFamily ? '720p' : resolutionRaw,
          quality: resolutionRaw,
          aspect: aspectRaw,
          aspectRatio: VIDEO_ASPECT_MAP[aspectRaw] || aspectRaw || '16:9',
          fps: 24,
          loop: videoLoop?.checked ?? true,
          mode: videoModeValue?.value || 'text2video',
          seedanceTier: seedanceTier,
          seedanceVariant: seedanceTier === 'preview' ? 'seedance-2-preview' : (seedanceTier === 'fast' ? 'seedance-2-fast-preview' : null),
        };

        console.log('[VIDEO DEBUG] getVideoSettingsFromUI:', {
          provider,
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
       * Compute video credits for Vertex (Veo) based on resolution + duration
       * Uses backend-driven costs via WorkspaceCredits, falls back to hardcoded values
       * @param {Object} settings - Video settings from getVideoSettingsFromUI()
       * @returns {number} Total credits (integer)
       */
      function computeVideoCredits(settings) {
        const provider = settings.provider || 'vertex';
        const resolution = settings.resolution || '720p';
        const isSeedanceFamily = (provider === 'seedance' || provider === 'fal_seedance');
        const duration = settings.durationSec || (isSeedanceFamily ? 5 : 4);
        const mode = settings.mode || 'text2video';

        let cost = null;
        let source = 'unknown';

        // fal Seedance: prefer explicit lookup, then CPS fallback
        if (provider === 'fal_seedance') {
          cost = (FAL_SEEDANCE_COSTS[duration] !== undefined)
            ? FAL_SEEDANCE_COSTS[duration]
            : FAL_SEEDANCE_CPS * duration;
          source = 'fal_seedance';
        }

        // Seedance (PiAPI): prefer explicit lookup, then CPS fallback
        if (provider === 'seedance') {
          const tier = settings.seedanceTier || 'fast';
          const tierCosts = SEEDANCE_COSTS[tier] || {};
          cost = (tierCosts[duration] !== undefined)
            ? tierCosts[duration]
            : (SEEDANCE_CPS[tier] || 16) * duration;
          source = `seedance-${tier}`;
        }

        // Vertex: Try to get cost from backend via WorkspaceCredits
        if (cost === null && window.WorkspaceCredits?.getVideoCreditCost) {
          cost = window.WorkspaceCredits.getVideoCreditCost(mode, duration, resolution);
          source = 'WorkspaceCredits';
        }

        // Fallback to hardcoded rules if WorkspaceCredits not available or returned null
        if (cost === null || cost === undefined) {
          const isImageMode = mode !== 'text2video';
          const fallbackTable = isImageMode ? VIDEO_IMAGE_CREDIT_RULES_FALLBACK : VIDEO_CREDIT_RULES_FALLBACK;
          const resRules = fallbackTable[resolution];
          if (resRules && resRules[duration] !== undefined) {
            cost = resRules[duration];
            source = 'fallback-exact';
          } else if (resRules && resRules[8] !== undefined) {
            cost = resRules[8];
            source = 'fallback-8s';
          } else {
            cost = isImageMode ? 110 : 75;
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
       * Disables invalid durations for 1080p/4K (Veo)
       */
      function updateDurationOptions() {
        if (!videoDuration) return;

        // Seedance providers have no resolution-based duration constraints
        const provider = videoAIProvider?.value || 'vertex';
        if (provider === 'seedance' || provider === 'fal_seedance') return;

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
            opt.textContent = `${dur} sec (${qualityLabel} requires 8s)`;
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
       * Sync provider UI from the current hidden input value.
       * Uses applyProviderConfig for a single code path.
       */
      function updateProviderUI() {
        const provider = videoAIProvider?.value || 'vertex';
        applyProviderConfig(provider);
        updateDurationOptions();
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
        if (!videoCreditsDisplay || !generateVideoBtn) {
          return;
        }

        const settings = getVideoSettingsFromUI();
        const totalCredits = computeVideoCredits(settings);

        console.log('[VIDEO DEBUG] Updating UI with credits:', totalCredits);

        // Update credits display
        videoCreditsDisplay.innerHTML = `<i class="fa-solid fa-coins"></i> ${totalCredits}`;

        // Update time estimate from provider config
        if (videoGenTime) {
          const cfg = VIDEO_PROVIDER_CONFIG[settings.provider];
          videoGenTime.textContent = cfg?.timeEstimate?.(settings) || '~2 min';
        }

        // Resolution risk warnings for Vertex
        const resHint = leftStack.querySelector('#videoResolutionHint');
        if (resHint && settings.provider === 'vertex') {
          const cfg = VIDEO_PROVIDER_CONFIG[settings.provider];
          const mode = videoModeValue?.value || 'text2video';
          const isTransition = mode === 'image_transition';

          if (settings.resolution === '4k') {
            resHint.textContent = '4K is experimental and may time out. If it fails, retry at 720p.';
            resHint.style.color = '#f59e0b';
          } else if (settings.resolution === '1080p') {
            const extra = isTransition ? ' Image transitions at 1080p have higher timeout risk.' : '';
            resHint.textContent = 'Higher resolutions may take longer and can fail more often.' + extra;
            resHint.style.color = '#f59e0b';
          } else {
            resHint.textContent = cfg?.hint || '';
            resHint.style.color = '';
          }
        }

        // Update button attributes
        generateVideoBtn.title = `${totalCredits} credits`;
        generateVideoBtn.dataset.baseCredits = totalCredits;
        generateVideoBtn.dataset.provider = settings.provider || 'vertex';
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
          // Image-to-Video: validate based on image sub-mode
          const imgMode = document.getElementById('videoImgModeValue')?.value || 'animate_image';
          const currentProvider = document.getElementById('videoAIProvider')?.value || '';
          const isSeedance = currentProvider === 'seedance' || currentProvider === 'fal_seedance';

          if (imgMode === 'image_transition') {
            // Transition: require both images + transition prompt
            const startSrc = document.getElementById('videoStartImagePreview')?.src || '';
            const endSrc = document.getElementById('videoEndImagePreview')?.src || '';
            const hasStart = startSrc.startsWith('data:') || startSrc.startsWith('http');
            const hasEnd = endSrc.startsWith('data:') || endSrc.startsWith('http');
            const transPrompt = document.getElementById('videoTransitionPrompt')?.value?.trim() || '';
            isValid = hasStart && hasEnd && transPrompt.length > 0;
          } else if (imgMode === 'experimental_morph') {
            // Morph (Beta): require both images + morph prompt
            const mStartSrc = document.getElementById('morphStartImagePreview')?.src || '';
            const mEndSrc = document.getElementById('morphEndImagePreview')?.src || '';
            const mHasStart = mStartSrc.startsWith('data:') || mStartSrc.startsWith('http');
            const mHasEnd = mEndSrc.startsWith('data:') || mEndSrc.startsWith('http');
            const mPrompt = document.getElementById('morphPrompt')?.value?.trim() || '';
            isValid = mHasStart && mHasEnd && mPrompt.length > 0;
          } else {
            // Animate: require image + animation prompt (for Seedance)
            const hasFileUpload = videoSource && videoSource.files && videoSource.files.length > 0;
            const previewSrc = videoImagePreview?.src || '';
            const hasPreviewImage = previewSrc.startsWith('data:') || previewSrc.startsWith('http');
            const hasImage = hasFileUpload || hasPreviewImage;
            const animPrompt = document.getElementById('videoAnimationPrompt')?.value?.trim() || '';
            isValid = isSeedance ? (hasImage && animPrompt.length > 0) : hasImage;
          }
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

      // Helper: build <option> HTML from config arrays
      function buildOptionsHTML(items) {
        return items.map(o => `<option value="${o.value}"${o.selected ? ' selected' : ''}>${o.text}</option>`).join('');
      }

      /**
       * Apply VIDEO_PROVIDER_CONFIG to the UI — single code path for provider switching.
       * Fully rebuilds duration, aspect, style, quality, motion, tier controls.
       */
      function applyProviderConfig(provider) {
        const cfg = VIDEO_PROVIDER_CONFIG[provider];
        if (!cfg) return;

        const resolutionHint = leftStack.querySelector('#videoResolutionHint');
        const motionSection = leftStack.querySelector('.vs-motion-section');
        const styleRow = leftStack.querySelector('.video-style-row');
        const stylePreset = leftStack.querySelector('#videoStylePreset');

        // Duration, aspect, style — rebuild from config
        if (videoDuration) videoDuration.innerHTML = buildOptionsHTML(cfg.durations);
        if (videoAspectRatio) videoAspectRatio.innerHTML = buildOptionsHTML(cfg.aspects);
        if (styleRow) styleRow.classList.remove('hidden');
        if (stylePreset) stylePreset.innerHTML = buildOptionsHTML(cfg.styles);

        // Quality wrap (Veo only) — rebuild from config like duration/aspect
        if (videoQualityWrap) videoQualityWrap.classList.toggle('hidden', !cfg.showQuality);
        if (cfg.showQuality && videoQuality && cfg.qualities) {
          videoQuality.innerHTML = buildOptionsHTML(cfg.qualities);
        } else if (cfg.showQuality && videoQuality) {
          videoQuality.querySelectorAll('option').forEach(opt => {
            opt.disabled = false;
            opt.style.display = '';
          });
        }

        // Motion section (Veo only)
        if (motionSection) motionSection.classList.toggle('hidden', !cfg.showMotion);

        // Tier selector (Seedance only)
        let tierWrap = leftStack.querySelector('#seedanceTierWrap');
        if (cfg.showTier) {
          if (!tierWrap) {
            tierWrap = document.createElement('div');
            tierWrap.id = 'seedanceTierWrap';
            tierWrap.className = 'vs-setting';
            tierWrap.innerHTML = '<label for="seedanceTierSelect">Model Tier</label><select id="seedanceTierSelect"><option value="fast" selected>Fast — optimised for speed (~1\u20133 min)</option><option value="preview">Preview — higher quality, longer queue (~2\u20136 min)</option></select>';
            const durationSetting = videoDuration?.closest('.vs-setting');
            if (durationSetting) durationSetting.after(tierWrap);
          }
          tierWrap.classList.remove('hidden');

          const tierSelect = tierWrap.querySelector('#seedanceTierSelect');
          if (tierSelect && !tierSelect._seedanceWired) {
            tierSelect._seedanceWired = true;
            tierSelect.addEventListener('change', () => {
              const seedanceTierInput = leftStack.querySelector('#seedanceTier');
              if (seedanceTierInput) seedanceTierInput.value = tierSelect.value;
              updateVideoFooter();
            });
          }
          // Reset tier
          const seedanceTierInput = leftStack.querySelector('#seedanceTier');
          if (seedanceTierInput) seedanceTierInput.value = 'fast';
          if (tierSelect) tierSelect.value = 'fast';
        } else if (tierWrap) {
          tierWrap.classList.add('hidden');
        }

        // Loop/Playback toggle (Veo only — Seedance doesn't support loop)
        const loopSetting = leftStack.querySelector('#videoLoopBtn')?.closest('.vs-setting-toggle');
        if (loopSetting) loopSetting.classList.toggle('hidden', cfg.showLoop === false);

        // Capability-gated image features: sub-mode switcher, animation prompt, transition panel, morph panel
        const caps = cfg.capabilities || {};
        const hasTransition = !!caps.imageTransition;
        const hasMorph = !!caps.experimentalMorph;
        const hasAnimPrompt = !!caps.animationPrompt;
        const imgModeSwitcher = leftStack.querySelector('#videoImgModeSwitcher');
        const animPromptSection = leftStack.querySelector('#animateImageContent .vs-animation-prompt-section');
        const animatePanel = leftStack.querySelector('#animateImageContent');
        const transitionPanel = leftStack.querySelector('#imageTransitionContent');
        const morphPanel = leftStack.querySelector('#experimentalMorphContent');
        const imgModeValue = leftStack.querySelector('#videoImgModeValue');
        const morphBtn = leftStack.querySelector('#experimentalMorphBtn');
        const transitionBtn = imgModeSwitcher?.querySelector('[data-img-mode="image_transition"]');

        // Show sub-mode switcher when provider supports transition OR morph
        if (imgModeSwitcher) imgModeSwitcher.classList.toggle('hidden', !hasTransition && !hasMorph);
        // Show/hide individual mode buttons based on capability
        if (transitionBtn) transitionBtn.style.display = hasTransition ? '' : 'none';
        if (morphBtn) morphBtn.style.display = hasMorph ? '' : 'none';
        // Animation prompt available for providers that support it (Seedance variants)
        if (animPromptSection) animPromptSection.classList.toggle('hidden', !hasAnimPrompt);

        // Always reset to animate_image mode when switching providers
        // This prevents stale two-image mode surviving a provider switch
        if (imgModeValue) imgModeValue.value = 'animate_image';
        if (animatePanel) animatePanel.classList.remove('hidden');
        if (transitionPanel) transitionPanel.classList.add('hidden');
        if (morphPanel) morphPanel.classList.add('hidden');
        imgModeSwitcher?.querySelectorAll('.video-img-mode-btn').forEach(b => {
          b.classList.toggle('is-active', b.dataset.imgMode === 'animate_image');
        });

        // Custom motion textarea — shared by both providers
        const customMotionSection = leftStack.querySelector('.vs-custom-section');
        if (customMotionSection) customMotionSection.classList.remove('hidden');

        // Hint text
        if (resolutionHint) resolutionHint.textContent = cfg.hint;
      }

      // Video provider switcher (main + experimental — mutually exclusive)
      const videoProviderSwitcher = leftStack.querySelector('#videoProviderSwitcher');
      const allProviderBtns = leftStack.querySelectorAll('#videoProviderSwitcher .video-provider-btn');

      function selectProvider(provider, clickedBtn) {
        allProviderBtns.forEach(b => b.classList.remove('is-active'));
        clickedBtn.classList.add('is-active');
        if (videoAIProvider) videoAIProvider.value = provider;

        applyProviderConfig(provider);
        updateDurationOptions();
        updateVideoFooter();
        validateVideoForm();

        console.log('[Video] Provider switched to:', provider);
      }

      allProviderBtns.forEach(btn => {
        btn.addEventListener('click', function () {
          selectProvider(this.dataset.provider, this);
        });
      });

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
      const videoAnimationPrompt = leftStack.querySelector('#videoAnimationPrompt');
      if (videoAnimationPrompt) {
        videoAnimationPrompt.addEventListener('input', validateVideoForm);
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

      // Apply provider config for default provider on init (unhides sub-mode switcher etc.)
      updateProviderUI();
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
          const provider = videoAIProvider?.value || 'vertex';
          const settings = getVideoSettingsFromUI();
          const totalCredits = computeVideoCredits(settings);
          const available = window.WorkspaceCredits?.getCredits?.() || 0;
          console.log('[GEN] mode=video provider=' + provider +
                      ' cost=' + totalCredits + ' available=' + available +
                      ' settings=' + JSON.stringify(settings));
          // Event bubbles to main.js which calls API.startVideoGeneration()
        });
      }

      // ========================================
      // VIDEO: Prompt Templates (Part 14)
      // ========================================
      // ── Video Prompt Templates with randomization ──────────────────
      // Each template has variation pools. _pickRandom selects one from each
      // pool so repeated clicks produce different prompts.
      function _pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

      function _buildTemplatePrompt(tpl) {
        let prompt = tpl.base;
        if (tpl.camera) prompt += ' ' + _pickRandom(tpl.camera) + '.';
        if (tpl.lighting) prompt += ' ' + _pickRandom(tpl.lighting) + '.';
        if (tpl.environment) prompt += ' ' + _pickRandom(tpl.environment) + '.';
        if (tpl.style) prompt += ' ' + _pickRandom(tpl.style) + '.';
        return prompt;
      }

      const VIDEO_TEMPLATE_CATEGORIES = {
        cinematic: {
          label: 'Cinematic',
          templates: {
            orbit:       { name: 'Cinematic Orbit',   base: 'Cinematic orbit around the subject, camera circling slowly with shallow depth of field',
                           camera: ['gentle clockwise orbit', 'slow counter-clockwise arc', 'sweeping half-circle tracking shot'],
                           lighting: ['dramatic side-lighting with deep shadows', 'soft golden backlighting', 'moody contrast with rim light'] },
            slow_reveal: { name: 'Slow Reveal',        base: 'Subject partially hidden, camera slowly reveals the full scene',
                           camera: ['slow dolly forward', 'gentle upward crane', 'lateral tracking reveal'],
                           lighting: ['soft diffused light building gradually', 'dramatic chiaroscuro', 'warm amber glow emerging'] },
            hero_shot:   { name: 'Hero Shot',          base: 'Low-angle hero shot, powerful and commanding presence',
                           camera: ['low-angle push-in', 'slight upward tilt with slow zoom', 'dramatic dutch angle approach'],
                           lighting: ['bold rim lighting from behind', 'golden hour backlight', 'high-contrast studio spotlight'] },
            tracking:    { name: 'Tracking Shot',      base: 'Camera tracks alongside the subject, smooth parallel movement',
                           camera: ['lateral tracking at eye level', 'following behind at shoulder height', 'leading from front'],
                           lighting: ['natural ambient daylight', 'streetlight pools at night', 'overcast soft light'] },
            epic_wide:   { name: 'Epic Wide Shot',     base: 'Vast establishing shot, subject small in the frame against a grand landscape',
                           camera: ['slow aerial descent', 'static wide with subtle drift', 'extremely slow zoom in'],
                           lighting: ['golden hour warmth', 'dramatic storm light breaking through clouds', 'cold blue twilight'] },
            dolly_zoom:  { name: 'Dolly Zoom',         base: 'Vertigo-style dolly zoom creating surreal depth distortion',
                           camera: ['slow dolly back with zoom in', 'dolly forward with zoom out', 'subtle push-pull effect'],
                           lighting: ['harsh direct spotlight', 'neon-tinged atmosphere', 'natural overcast'] },
          }
        },
        product: {
          label: 'Product',
          templates: {
            product_reveal: { name: 'Product Reveal',    base: 'Smooth 360-degree rotation on a clean backdrop, premium commercial quality',
                              camera: ['slow full rotation', 'half-turn with pause on details', 'gentle rocking motion'],
                              lighting: ['clean studio three-point lighting', 'soft gradient backdrop glow', 'dramatic single-source accent'] },
            luxury_ad:      { name: 'Luxury Commercial', base: 'Premium luxury showcase with elegant motion and refined aesthetics',
                              camera: ['ultra-slow gliding orbit', 'gentle rise revealing the product', 'smooth dolly across surface detail'],
                              lighting: ['warm golden key light', 'cool metallic reflections', 'soft diffused editorial lighting'] },
            minimal_studio: { name: 'Minimal Studio',   base: 'Clean minimalist shot, sharp focus, no distractions',
                              camera: ['slow rotation on turntable', 'static with subtle breathing motion', 'gentle arc from front to profile'],
                              lighting: ['even soft-box diffusion', 'single dramatic side light', 'bright high-key lighting'] },
            tech_showcase:  { name: 'Tech Showcase',     base: 'Modern technology product with futuristic presentation',
                              camera: ['dynamic orbit with speed ramp', 'macro detail pan then pull back', 'smooth 360 rotation'],
                              lighting: ['cool blue LED accents', 'holographic rim glow', 'clean daylight balanced lighting'] },
            unboxing:       { name: 'Unboxing Reveal',   base: 'Product emerging from packaging, sense of discovery',
                              camera: ['overhead looking down', 'eye-level slow approach', 'gentle crane from box to product'],
                              lighting: ['warm inviting glow', 'soft ambient with product spotlight', 'natural window light'] },
          }
        },
        action: {
          label: 'Action',
          templates: {
            cyberpunk:       { name: 'Cyberpunk Action',     base: 'High-energy scene in a neon-lit cyberpunk city',
                               camera: ['fast tracking through neon streets', 'sweeping crane over rooftops', 'first-person dash through alley'],
                               lighting: ['pulsing neon pink and blue', 'rain-reflected city lights', 'holographic advertisement glow'] },
            anime_combat:    { name: 'Anime Combat',         base: 'Dynamic anime-style action with bold stylization and speed lines',
                               camera: ['dramatic zoom with speed lines', 'rotating impact shot', 'sweeping arc around fighters'],
                               lighting: ['vibrant saturated cel-shaded lighting', 'dramatic backlight silhouette', 'energy glow illumination'],
                               style: ['anime cel-shaded aesthetic', 'bold graphic novel style', 'vivid manga-inspired colors'] },
            scifi_chase:     { name: 'Sci-Fi Chase',         base: 'Fast pursuit through a science fiction environment',
                               camera: ['side tracking alongside vehicles', 'overhead chase perspective', 'cockpit POV with motion blur'],
                               lighting: ['engine thrust glow', 'passing starlight streaks', 'emergency red alert lighting'] },
            slow_mo_impact:  { name: 'Slow Motion Impact',   base: 'Ultra slow-motion capture of a dramatic moment, fine details visible',
                               camera: ['close-up tracking the action', 'wide shot with time dilation', 'macro detail of impact point'],
                               lighting: ['flash-freeze strobe light', 'backlit particles suspended in air', 'natural light with motion blur dissolve'] },
            martial_arts:    { name: 'Martial Arts',         base: 'Fluid martial arts movement with cinematic choreography',
                               camera: ['circling the fighter slowly', 'low-angle upward during leap', 'over-shoulder tracking'],
                               lighting: ['warm dojo lantern light', 'dramatic single spotlight', 'outdoor golden hour'] },
          }
        },
        camera: {
          label: 'Camera',
          templates: {
            flythrough:   { name: 'Camera Flythrough',  base: 'Smooth aerial camera flying through an expansive environment',
                            camera: ['slow forward glide through scene', 'weaving between structures', 'ascending reveal'],
                            lighting: ['golden hour with long shadows', 'misty diffused morning light', 'dramatic sunset'] },
            drone:        { name: 'Drone Shot',          base: 'High-altitude aerial perspective sweeping across landscape',
                            camera: ['slow descending approach', 'lateral sweep across terrain', 'spiraling downward reveal'],
                            lighting: ['midday overhead sun', 'dramatic cloud shadows on ground', 'warm late afternoon light'] },
            first_person: { name: 'First Person POV',    base: 'Immersive first-person perspective moving through a scene',
                            camera: ['walking pace forward movement', 'running through environment', 'slow cautious exploration'],
                            lighting: ['natural environment lighting', 'flashlight beam in darkness', 'bright daylight from ahead'] },
            timelapse:    { name: 'Time Lapse',          base: 'Accelerated passage of time, fixed camera position',
                            camera: ['static tripod', 'very slow pan across scene', 'gentle zoom out over time'],
                            lighting: ['sunrise to sunset cycle', 'clouds racing overhead casting shadows', 'city lights switching on at dusk'] },
            crane:        { name: 'Crane Shot',          base: 'Dramatic vertical camera movement rising or descending',
                            camera: ['ascending from ground to bird\'s eye', 'descending from sky to subject', 'rising over obstacle to reveal vista'],
                            lighting: ['looking up into bright sky', 'descending into warm interior', 'sunset horizon at peak height'] },
          }
        },
        fantasy: {
          label: 'Fantasy',
          templates: {
            magic_scene:  { name: 'Magic Scene',          base: 'Mystical magical moment with ethereal visual effects',
                            camera: ['slow orbit around magical focal point', 'rising with ascending energy', 'gentle push into enchanted object'],
                            lighting: ['glowing arcane energy', 'bioluminescent ambient light', 'aurora-like shifting colors'] },
            mythical:     { name: 'Mythical Creature',    base: 'Majestic mythical creature in its natural habitat',
                            camera: ['slow reveal from shadow', 'wide establishing then zoom', 'tracking alongside flight path'],
                            lighting: ['ethereal backlight through mist', 'dramatic storm light', 'warm firelight from below'] },
            dreamscape:   { name: 'Dreamlike World',      base: 'Surreal dreamlike environment with impossible geometry',
                            camera: ['floating drift through space', 'slow rotation in zero gravity', 'gentle descent through layers'],
                            lighting: ['soft ethereal glow', 'prismatic light refractions', 'warm golden haze throughout'] },
            underwater:   { name: 'Underwater Realm',     base: 'Deep underwater scene with aquatic atmosphere',
                            camera: ['slow gliding descent', 'forward swim through coral reef', 'gentle upward look toward surface light'],
                            lighting: ['caustic light patterns from surface', 'bioluminescent creature glow', 'deep blue ambient'] },
            enchanted:    { name: 'Enchanted Forest',     base: 'Magical forest with supernatural elements and ancient trees',
                            camera: ['slow winding path through trees', 'ascending through canopy', 'gentle pan across clearing'],
                            lighting: ['dappled sunlight through leaves', 'firefly and fairy light', 'misty morning glow'] },
          }
        },
        nature: {
          label: 'Nature',
          templates: {
            golden_hour:  { name: 'Golden Hour Landscape', base: 'Stunning landscape bathed in warm golden hour light',
                            camera: ['slow panoramic sweep', 'gentle push toward horizon', 'rising drone reveal'],
                            lighting: ['warm amber low sun', 'soft pink clouds', 'long golden shadows across terrain'] },
            storm:        { name: 'Storm Drama',           base: 'Dramatic weather event with powerful atmosphere',
                            camera: ['static wide with subtle shake', 'slow zoom into storm center', 'tracking along cloud front'],
                            lighting: ['lightning flash illumination', 'dark brooding overcast', 'break in clouds with god rays'] },
            ocean:        { name: 'Ocean Waves',           base: 'Mesmerizing ocean wave patterns and water motion',
                            camera: ['eye-level at water surface', 'overhead looking down at wave patterns', 'slow tracking along shoreline'],
                            lighting: ['sunset reflections on water', 'bright tropical midday', 'moody overcast grey'] },
          }
        },
        abstract: {
          label: 'Abstract',
          templates: {
            particles:    { name: 'Particle Flow',        base: 'Abstract flowing particles and energy visualization in dark space',
                            camera: ['slow drift through particle cloud', 'orbiting the flow center', 'macro zoom into particle stream'],
                            lighting: ['self-illuminated particles', 'gradient color shifting', 'pulsing rhythmic glow'] },
            geometric:    { name: 'Geometric Motion',     base: 'Abstract geometric shapes in choreographed motion',
                            camera: ['orbit around geometric assembly', 'slow zoom through structure', 'static with shapes in motion'],
                            lighting: ['clean rim light on edges', 'prismatic refractions', 'monochromatic dramatic lighting'] },
            fluid_art:    { name: 'Fluid Art',            base: 'Flowing liquid colors and organic abstract motion',
                            camera: ['macro extreme close-up', 'slow pull-back revealing pattern', 'gentle drift across surface'],
                            lighting: ['backlit translucent colors', 'surface reflections', 'self-luminous pigments'] },
          }
        },
      };

      // Legacy flat lookup for backward compat
      const VIDEO_TEMPLATES = {};
      for (const [, cat] of Object.entries(VIDEO_TEMPLATE_CATEGORIES)) {
        for (const [key, tpl] of Object.entries(cat.templates)) {
          VIDEO_TEMPLATES[key] = tpl;
        }
      }

      const templatesTrigger = leftStack.querySelector('#videoTemplatesTrigger');
      const templatesPanel = leftStack.querySelector('#videoTemplatesPanel');
      if (templatesTrigger && templatesPanel) {
        // Dynamically render categorized template buttons
        let panelHTML = '';
        for (const [, cat] of Object.entries(VIDEO_TEMPLATE_CATEGORIES)) {
          panelHTML += `<div class="vs-preset-category-label">${cat.label}</div>`;
          for (const [key, tpl] of Object.entries(cat.templates)) {
            panelHTML += `<button type="button" class="vs-preset video-template-btn" data-template="${key}">${tpl.name}</button>`;
          }
        }
        templatesPanel.innerHTML = panelHTML;

        templatesTrigger.addEventListener('click', () => {
          templatesPanel.classList.toggle('vs-presets--collapsed');
          templatesTrigger.classList.toggle('is-open');
        });
        templatesPanel.querySelectorAll('.video-template-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const key = btn.dataset.template;
            const tpl = VIDEO_TEMPLATES[key];
            if (tpl && videoTextPrompt) {
              // _buildTemplatePrompt picks random variations each click
              videoTextPrompt.value = _buildTemplatePrompt(tpl);
              videoTextPrompt.dispatchEvent(new Event('input', { bubbles: true }));
            }
            templatesPanel.classList.add('vs-presets--collapsed');
            if (templatesTrigger) templatesTrigger.classList.remove('is-open');
          });
        });
      }

      // ========================================
      // VIDEO: Preview Button (Part 13)
      // ========================================
      const previewVideoBtn = leftStack.querySelector('#previewVideoBtn');
      if (previewVideoBtn) {
        previewVideoBtn.addEventListener('click', function() {
          // Force shortest duration + cheapest provider for preview
          if (videoDuration) videoDuration.value = videoDuration.options[0]?.value || '4';
          if (videoQuality) videoQuality.value = '720p';
          updateVideoFooter();
          // Trigger the normal generate flow
          if (generateVideoBtn) generateVideoBtn.click();
        });
        // Enable/disable preview button alongside generate button
        const origValidate = validateVideoForm;
        validateVideoForm = function() {
          origValidate();
          if (previewVideoBtn) previewVideoBtn.disabled = generateVideoBtn?.disabled ?? true;
        };
      }

      // ========================================
      // VIDEO: Gallery Button (Part 17)
      // ========================================
      const videoGalleryBtn = leftStack.querySelector('#videoGalleryBtn');
      if (videoGalleryBtn) {
        videoGalleryBtn.addEventListener('click', () => {
          if (window.TimrXInspire?.openVideos) {
            window.TimrXInspire.openVideos();
          } else if (window.TimrXInspire?.open) {
            window.TimrXInspire.open();
          }
        });
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

      // ─── Rig Wizard step navigation ───
      const rigStep1 = leftStack.querySelector('#rigWizardStep1');
      const rigStep2 = leftStack.querySelector('#rigWizardStep2');
      const rigStep3 = leftStack.querySelector('#rigWizardStep3');
      const rigStep4 = leftStack.querySelector('#rigWizardStep4');

      const showRigStep = (step) => {
        [rigStep1, rigStep2, rigStep3, rigStep4].forEach(s => { if (s) s.style.display = 'none'; });
        if (step) step.style.display = '';
        // Show submit button alongside step 3
        if (step === rigStep3 && rigStep4) rigStep4.style.display = '';
      };

      const rigNext1 = leftStack.querySelector('#rigWizardNext1');
      const rigBack2 = leftStack.querySelector('#rigWizardBack2');
      const rigNext2 = leftStack.querySelector('#rigWizardNext2');
      const rigBack3 = leftStack.querySelector('#rigWizardBack3');

      if (rigNext1) rigNext1.addEventListener('click', () => showRigStep(rigStep2));
      if (rigBack2) rigBack2.addEventListener('click', () => showRigStep(rigStep1));
      if (rigNext2) rigNext2.addEventListener('click', () => showRigStep(rigStep3));
      if (rigBack3) rigBack3.addEventListener('click', () => showRigStep(rigStep2));

      // Rig upload toggle
      const rigModelSelect   = leftStack.querySelector('#rigModelSelect');
      const rigUploadSection = leftStack.querySelector('#rigModelUploadSection');
      const rigModelDrop     = leftStack.querySelector('#rigModelDrop');
      const rigModelUpload   = leftStack.querySelector('#rigModelUpload');
      const rigModelFileName = leftStack.querySelector('#rigModelFileName');

      if (rigModelSelect && rigUploadSection) {
        rigModelSelect.addEventListener('change', function () {
          const show = this.value === 'upload';
          rigUploadSection.style.display = show ? 'block' : 'none';
          if (!show && rigModelFileName) rigModelFileName.style.display = 'none';
        });
      }
      if (rigModelDrop && rigModelUpload && rigModelFileName) {
        rigModelDrop.addEventListener('click', () => rigModelUpload.click());
        rigModelUpload.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const f = this.files[0];
            rigModelFileName.textContent = `\u{1F4E6} ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
            rigModelFileName.style.display = 'block';
          }
        });
        rigModelDrop.addEventListener('dragover', (e) => { e.preventDefault(); rigModelDrop.style.borderColor = 'rgba(255,255,255,.3)'; });
        rigModelDrop.addEventListener('dragleave', () => { rigModelDrop.style.borderColor = 'rgba(255,255,255,.15)'; });
        rigModelDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          rigModelDrop.style.borderColor = 'rgba(255,255,255,.15)';
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            rigModelUpload.files = e.dataTransfer.files;
            rigModelUpload.dispatchEvent(new Event('change'));
          }
        });
      }

      // ─── Animation Library: search, filter, selection ───
      const animSearch = leftStack.querySelector('#animLibrarySearch');
      const animCategory = leftStack.querySelector('#animLibraryCategory');
      const animGrid = leftStack.querySelector('#animLibraryGrid');
      const animEmpty = leftStack.querySelector('#animLibraryEmpty');
      const animActionIdInput = leftStack.querySelector('#rigAnimationActionId');
      const applyAnimBtn = leftStack.querySelector('#applyAnimationBtn');

      // Animation library state
      let _animLibrary = [];
      let _animLibraryLoaded = false;

      const loadAnimLibrary = async () => {
        if (_animLibraryLoaded) return;
        try {
          const resp = await fetch('/api/_mod/rig/animations/library');
          const data = await resp.json();
          if (data.ok && data.items) {
            _animLibrary = data.items;
            _animLibraryLoaded = true;
            renderAnimLibrary();
          }
        } catch (e) {
          console.warn('[AnimLibrary] Failed to load:', e);
        }
      };

      const renderAnimLibrary = () => {
        if (!animGrid) return;
        const search = (animSearch?.value || '').toLowerCase();
        const cat = animCategory?.value || '';
        let items = _animLibrary.filter(a => a.enabled !== false);
        if (cat) items = items.filter(a => a.category === cat);
        if (search) {
          items = items.filter(a =>
            (a.name || '').toLowerCase().includes(search) ||
            (a.category || '').toLowerCase().includes(search) ||
            (a.subcategory || '').toLowerCase().includes(search) ||
            (a.tags || []).some(t => t.toLowerCase().includes(search))
          );
        }
        items.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

        animGrid.innerHTML = '';
        if (items.length === 0) {
          if (animEmpty) animEmpty.style.display = 'block';
          return;
        }
        if (animEmpty) animEmpty.style.display = 'none';

        items.forEach(anim => {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'material-chip anim-lib-card';
          card.dataset.actionId = anim.action_id;
          card.style.cssText = 'display:flex;flex-direction:column;align-items:center;padding:8px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);cursor:pointer;transition:all .15s;text-align:center;font-size:11px;color:#ccc;min-height:48px;justify-content:center';
          card.innerHTML = '<span style="font-weight:500;color:#e0e0e0;font-size:11px;line-height:1.3">' + (anim.name || 'Animation') + '</span>'
            + '<span style="font-size:10px;color:#666;margin-top:2px">' + (anim.subcategory || anim.category || '') + '</span>';

          const selectedId = animActionIdInput?.value;
          if (selectedId && String(anim.action_id) === selectedId) {
            card.style.borderColor = 'rgba(100,180,255,.5)';
            card.style.background = 'rgba(100,180,255,.08)';
          }

          card.addEventListener('click', () => {
            // Deselect all
            animGrid.querySelectorAll('.anim-lib-card').forEach(c => {
              c.style.borderColor = 'rgba(255,255,255,.08)';
              c.style.background = 'rgba(255,255,255,.03)';
            });
            // Select this one
            card.style.borderColor = 'rgba(100,180,255,.5)';
            card.style.background = 'rgba(100,180,255,.08)';
            if (animActionIdInput) animActionIdInput.value = anim.action_id;
            if (applyAnimBtn) {
              applyAnimBtn.disabled = false;
              applyAnimBtn.dataset.riggingTaskId = applyAnimBtn.dataset.riggingTaskId || '';
            }
          });

          animGrid.appendChild(card);
        });
      };

      if (animSearch) animSearch.addEventListener('input', renderAnimLibrary);
      if (animCategory) animCategory.addEventListener('change', renderAnimLibrary);

      // Expose animation library loader globally so _handleRigComplete can trigger it.
      // The MutationObserver approach breaks when tabs are switched (DOM is rebuilt,
      // observer is orphaned on the old detached node).
      window._loadAnimLibrary = loadAnimLibrary;
      window._renderAnimLibrary = renderAnimLibrary;

      // Remesh preset cards
      const remeshPresetsWrap = leftStack.querySelector('#remeshPresets');
      const remeshAdvancedToggle = leftStack.querySelector('#remeshAdvancedToggle');
      const remeshAdvanced = leftStack.querySelector('#remeshAdvanced');

      if (remeshPresetsWrap) {
        remeshPresetsWrap.addEventListener('click', (e) => {
          const card = e.target.closest('.remesh-preset');
          if (!card) return;
          remeshPresetsWrap.querySelectorAll('.remesh-preset').forEach(c => c.classList.remove('is-active'));
          card.classList.add('is-active');
          // Sync hidden form fields
          const polyInput = leftStack.querySelector('#targetPolyCount');
          const modeInput = leftStack.querySelector('#remeshMode');
          if (polyInput) polyInput.value = card.dataset.poly || '50000';
          if (modeInput) modeInput.value = card.dataset.topo === 'quad' ? 'quad-based' : 'adaptive';
        });
      }

      if (remeshAdvancedToggle && remeshAdvanced) {
        remeshAdvancedToggle.addEventListener('click', () => {
          const collapsed = remeshAdvanced.classList.toggle('remesh-advanced--collapsed');
          remeshAdvancedToggle.classList.toggle('is-open', !collapsed);
        });
      }

      // Material chips for texture panel
      const materialChipsWrap = leftStack.querySelector('#materialChips');
      if (materialChipsWrap) {
        materialChipsWrap.addEventListener('click', (e) => {
          const chip = e.target.closest('.material-chip');
          if (!chip) return;
          const prompt = leftStack.querySelector('#texturePrompt');
          if (prompt) {
            prompt.value = chip.dataset.material || '';
            prompt.dispatchEvent(new Event('input', { bubbles: true }));
          }
          // Visual: highlight selected chip
          materialChipsWrap.querySelectorAll('.material-chip').forEach(c => c.classList.remove('is-active'));
          chip.classList.add('is-active');
        });
      }

      // PBR toggle syncs hidden textureType field
      const pbrToggle = leftStack.querySelector('#texturePBRToggle');
      const textureTypeHidden = leftStack.querySelector('#textureType');
      if (pbrToggle && textureTypeHidden) {
        pbrToggle.addEventListener('change', () => {
          textureTypeHidden.value = pbrToggle.checked ? 'pbr-all' : 'diffuse';
        });
      }

      // Texture advanced toggle (reuses remesh-advanced CSS classes)
      const textureAdvancedToggle = leftStack.querySelector('#textureAdvancedToggle');
      const textureAdvanced = leftStack.querySelector('#textureAdvanced');
      if (textureAdvancedToggle && textureAdvanced) {
        textureAdvancedToggle.addEventListener('click', () => {
          const collapsed = textureAdvanced.classList.toggle('remesh-advanced--collapsed');
          textureAdvancedToggle.classList.toggle('is-open', !collapsed);
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
          if (value === 'meshy-5') {
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

      // ── Video mode: use LOCAL smart enhancer (no server call) ──
      if (mode === 'video' && window.TimrxPromptEnhancer) {
        setEnhanceButtonState(btn, 'loading');

        const provider = leftStack.querySelector('#videoAIProvider')?.value || 'vertex';
        const videoModeVal = leftStack.querySelector('#videoModeValue')?.value || 'text2video';

        // Detect generation mode for mode-aware enhancement
        var enhanceMode = 'text_to_video';
        if (videoModeVal === 'image2video') {
          // Check if end-image is present (= transition) or just single image (= animate)
          const endPreview = document.getElementById('videoEndImagePreview');
          const hasEndImage = endPreview && endPreview.src && !endPreview.src.endsWith('#');
          enhanceMode = hasEndImage ? 'image_transition' : 'animate_image';
        }

        // Run local enhancement (instant, no network)
        const result = window.TimrxPromptEnhancer.enhance(raw, {
          provider: provider,
          mode: enhanceMode,
        });

        if (result.enhanced) {
          _enhanceUndoMap[mode] = raw;
          textarea.value = result.enhanced;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          textarea.focus();

          setEnhanceButtonState(btn, 'idle');

          // Build feedback with score badge
          var feedbackMsg = 'Enhanced';
          if (result.score && result.score.grade) {
            feedbackMsg += ' \u00B7 ' + result.scoreLabel;
          }

          // Show score bar and re-roll button
          updateEnhanceScoreBar(result.score);
          var rerollBtn = leftStack.querySelector('#enhanceRerollBtn');
          if (rerollBtn) rerollBtn.classList.remove('hidden');

          showEnhanceFeedback(feedbackEl, 'undo', feedbackMsg, function onUndo() {
            textarea.value = _enhanceUndoMap[mode] || raw;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.focus();
            delete _enhanceUndoMap[mode];
            showEnhanceFeedback(feedbackEl, null);
            // Hide score bar and re-roll on undo
            updateEnhanceScoreBar(null);
            if (rerollBtn) rerollBtn.classList.add('hidden');
          });

          // Show safety warnings if any
          if (result.safety && result.safety.length > 0) {
            console.log('[Enhance] Safety softening applied:', result.safety);
          }
        } else {
          setEnhanceButtonState(btn, 'idle');
          showEnhanceFeedback(feedbackEl, 'error', 'Enhancement failed.');
        }
        return;
      }

      // ── Non-video modes: use server-side LLM enhancement ──
      setEnhanceButtonState(btn, 'loading');
      showEnhanceFeedback(feedbackEl, 'loading', 'Enhancing\u2026');

      const enhanceBody = { prompt: raw, mode: mode };

      fetch(ENHANCE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(enhanceBody),
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok && data.enhanced_prompt) {
          _enhanceUndoMap[mode] = raw;
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

    // ========================================
    // ENHANCE: Provider hints + score bar + re-roll
    // ========================================

    // Provider hint messages shown near the enhance button
    var _PROVIDER_HINTS = {
      vertex:       'Veo works best with clean, simple descriptions.',
      seedance:     'Seedance handles dynamic action and bold prompts well.',
      fal_seedance: 'fal works best with short, punchy prompts (1\u20132 sentences).',
    };

    function updateEnhanceProviderHint() {
      var hint = leftStack.querySelector('#enhanceProviderHint');
      if (!hint) return;
      var provider = leftStack.querySelector('#videoAIProvider')?.value || 'vertex';
      hint.textContent = _PROVIDER_HINTS[provider] || _PROVIDER_HINTS.vertex;
    }

    // Update hint when provider changes
    var _providerSelect = leftStack.querySelector('#videoAIProvider');
    if (_providerSelect) {
      _providerSelect.addEventListener('change', updateEnhanceProviderHint);
      // Set initial hint
      updateEnhanceProviderHint();
    }

    // Score bar: show prompt quality after enhancement
    function updateEnhanceScoreBar(scoreResult) {
      var bar = leftStack.querySelector('#enhanceScoreBar');
      var fill = leftStack.querySelector('#enhanceScoreFill');
      var label = leftStack.querySelector('#enhanceScoreLabel');
      if (!bar || !fill || !label) return;

      if (!scoreResult || !scoreResult.score) {
        bar.classList.add('hidden');
        return;
      }

      bar.classList.remove('hidden');
      var pct = Math.min(100, Math.max(0, scoreResult.score));
      fill.style.width = pct + '%';

      // Color based on grade
      var color = '#888';
      if (pct >= 80) color = '#4caf50';
      else if (pct >= 60) color = '#8bc34a';
      else if (pct >= 40) color = '#ffc107';
      else if (pct >= 20) color = '#ff9800';
      else color = '#f44336';
      fill.style.backgroundColor = color;

      label.textContent = scoreResult.grade ? (scoreResult.score + ' \u2014 ' + scoreResult.grade) : (scoreResult.score + '');
    }

    // Re-roll button: re-enhances with fresh randomization
    var _rerollBtn = leftStack.querySelector('#enhanceRerollBtn');
    if (_rerollBtn) {
      _rerollBtn.addEventListener('click', function(e) {
        e.preventDefault();
        // Find the video enhance button and trigger enhance again
        var enhanceBtn = leftStack.querySelector('.enhance-btn[data-enhance-mode="video"]');
        if (enhanceBtn) enhanceBtn.click();
      });
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
      // Support ?panel=image|model|video|remesh|texture|rig|animate from URL
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
