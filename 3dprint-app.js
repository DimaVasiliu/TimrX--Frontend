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
     * PANEL CONTENT TEMPLATES (left control column)
     * ---------------------------------------------------------------------- */
    const panelContent = {
      image: `
        <div class="card">
          <h3>Generate Image</h3>
          <label for="imagePrompt">Describe Your Image</label>
          <textarea id="imagePrompt" placeholder="A futuristic cityscape at sunset with flying cars..."></textarea>
          <span class="field-hint">Be detailed and specific for best results</span>
        </div>

        <div class="card">
          <h3>Options</h3>
          <label for="imageAIProvider">AI Image Generator</label>
          <select id="imageAIProvider">
            <option value="openai" selected>OpenAI (DALL-E)</option>
          </select>

          <label for="imageStyle" style="margin-top:12px">Art Style</label>
          <select id="imageStyle">
            <option value="realistic" selected>Realistic</option>
            <option value="artistic">Artistic</option>
            <option value="anime">Anime</option>
            <option value="3d-render">3D Render</option>
            <option value="cinematic">Cinematic</option>
          </select>

          <label for="imageResolution" style="margin-top:12px">Resolution</label>
          <select id="imageResolution">
            <option value="512x512">512x512</option>
            <option value="1024x1024" selected>1024x1024</option>
            <option value="1024x1792">1024x1792 (Portrait)</option>
            <option value="1792x1024">1792x1024 (Landscape)</option>
          </select>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">30 sec</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 12</span>
          </div>
          <button type="button" id="generateImageBtn" class="gen-btn">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21"/></svg>
            Generate
          </button>
        </div>
      `,
  
      model: `
        <div class="card">
          <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:8px">
            <button type="button" class="tab-btn active" data-tab="text3d" style="flex:1;background:rgba(255,255,255,.1);border:none;border-radius:6px;padding:10px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:background .2s ease">
              Text to 3D
            </button>
            <button type="button" class="tab-btn" data-tab="image3d" style="flex:1;background:transparent;border:none;border-radius:6px;padding:10px;color:#888;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s ease">
              Image to 3D
            </button>
          </div>

          <div class="tab-content active" id="text3d">
            <label for="modelPrompt">Describe Your Model</label>
            <textarea id="modelPrompt" placeholder="A futuristic gaming chair with RGB lighting..."></textarea>
            <span class="field-hint">Be specific for better results</span>
          </div>

          <div class="tab-content hidden" id="image3d">
            <div class="field-group" style="margin-bottom:14px">
              <label for="imageModelName" style="display:block;font-size:12px;font-weight:600;color:rgba(255,255,255,.7);margin-bottom:6px">Model Name</label>
              <input type="text" id="imageModelName" placeholder="My 3D Model" style="width:100%;padding:10px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;color:#fff;font-size:13px;transition:border-color .2s ease" />
            </div>
            <label for="modelImageUpload" style="display:block;font-size:12px;font-weight:600;color:rgba(255,255,255,.7);margin-bottom:6px">Upload Reference Image</label>
            <div id="modelImageDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s ease">
              <svg style="width:32px;height:32px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0 0 4px;font-size:13px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">PNG, JPG, WEBP</span>
              <input type="file" id="modelImageUpload" accept="image/*" hidden />
            </div>
            <img id="modelImagePreview" style="display:none;width:100%;border-radius:8px;margin-top:12px" alt="Preview"/>
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
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 20</span>
          </div>
          <button type="button" id="generateModelBtn" class="gen-btn">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z"/></svg>
            Generate
          </button>
        </div>
      `,
  
      remesh: `
        <div class="card">
          <h3>Model Selection</h3>
          <label for="remeshModelSelect">Select Model to Remesh</label>
          <select id="remeshModelSelect">
            <option value="current" selected>Current Model</option>
            <option value="upload">Upload New Model</option>
          </select>

          <div id="remeshModelUploadSection" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="remeshModelUpload">Upload 3D Model</label>
            <div id="remeshModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:8px">
              <svg style="width:32px;height:32px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0 0 4px;font-size:13px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">OBJ, FBX, STL, GLTF</span>
              <input type="file" id="remeshModelUpload" accept=".obj,.fbx,.stl,.gltf,.glb" hidden />
            </div>
            <div id="remeshModelFileName" style="display:none;margin-top:12px;padding:10px;background:rgba(255,255,255,.05);border-radius:6px;font-size:13px;color:#ccc"></div>
          </div>
        </div>

        <div class="card">
          <h3>Remesh Settings</h3>
          <label for="targetPolyCount">Target Poly Count</label>
          <input type="number" id="targetPolyCount" value="10000" min="100" max="1000000" step="1000">
          <span class="field-hint">Lower = faster, higher = more detail</span>

          <label for="remeshMode" style="margin-top:12px">Remesh Mode</label>
          <select id="remeshMode">
            <option value="uniform">Uniform</option>
            <option value="adaptive" selected>Adaptive</option>
            <option value="feature-preserving">Feature Preserving</option>
            <option value="quad-based">Quad Based</option>
          </select>

          <label style="margin-top:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="preserveUVs" checked>
            <span>Preserve UV Mapping</span>
          </label>

          <label style="margin-top:8px;display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="preserveBoundaries" checked>
            <span>Preserve Boundaries</span>
          </label>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 5</span>
          </div>
          <button type="button" id="applyRemeshBtn" class="gen-btn">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/></svg>
            Remesh
          </button>
        </div>
      `,
  
      texture: `
        <div class="card">
          <h3>Target Model</h3>
          <label for="textureModelSelect">Apply Texture To</label>
          <select id="textureModelSelect">
            <option value="current" selected>Current Model</option>
            <option value="upload">Upload New Model</option>
          </select>

          <div id="textureModelUploadSection" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="textureModelUpload">Upload 3D Model</label>
            <div id="textureModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:8px">
              <svg style="width:32px;height:32px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0 0 4px;font-size:13px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">OBJ, FBX, STL, GLTF</span>
              <input type="file" id="textureModelUpload" accept=".obj,.fbx,.stl,.gltf,.glb" hidden />
            </div>
            <div id="textureModelFileName" style="display:none;margin-top:12px;padding:10px;background:rgba(255,255,255,.05);border-radius:6px;font-size:13px;color:#ccc"></div>
          </div>
        </div>

        <div class="card">
          <h3>Texture Settings</h3>
          <label for="texturePrompt">Texture Description</label>
          <textarea id="texturePrompt" placeholder="Rusty metal with scratches and dents..."></textarea>
          <span class="field-hint">Describe material properties and surface details</span>

          <label for="textureResolution" style="margin-top:12px">Resolution</label>
          <select id="textureResolution">
            <option value="512x512">512x512</option>
            <option value="1024x1024">1024x1024</option>
            <option value="2048x2048" selected>2048x2048</option>
            <option value="4096x4096">4096x4096</option>
          </select>

          <label for="textureType" style="margin-top:12px">Map Type</label>
          <select id="textureType">
            <option value="pbr-all" selected>PBR (All Maps)</option>
            <option value="diffuse">Diffuse Only</option>
            <option value="normal">Normal Map</option>
            <option value="roughness">Roughness</option>
            <option value="metallic">Metallic</option>
          </select>

          <label style="margin-top:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="seamless" checked>
            <span>Seamless Tiling</span>
          </label>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">1.5 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 10</span>
          </div>
          <button type="button" id="generateTextureBtn" class="gen-btn">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
            Texture
          </button>
        </div>
      `,

      rig: `
        <div class="card">
          <h3>Rig Target</h3>
          <label for="rigModelSelect">Apply Rig To</label>
          <select id="rigModelSelect">
            <option value="current" selected>Current Model</option>
            <option value="upload">Upload New Model</option>
          </select>

          <div id="rigModelUploadSection" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="rigModelUpload">Upload Humanoid GLB/GLTF</label>
            <div id="rigModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:8px">
              <svg style="width:32px;height:32px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <circle cx="12" cy="6" r="2.4" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v6l-4 6m4-6l4 6M8 12l4 3 4-3" />
              </svg>
              <p style="margin:0 0 4px;font-size:13px;color:#ccc">Click or Drag & Drop</p>
              <span style="font-size:11px;color:#666">GLB, GLTF (textured)</span>
              <input type="file" id="rigModelUpload" accept=".gltf,.glb" hidden />
            </div>
            <div id="rigModelFileName" style="display:none;margin-top:12px;padding:10px;background:rgba(255,255,255,.05);border-radius:6px;font-size:13px;color:#ccc"></div>
          </div>
        </div>

        <div class="card">
          <h3>Rig Settings</h3>
          <label for="rigHeight">Character Height (m)</label>
          <input type="number" id="rigHeight" value="1.7" min="0.5" max="3" step="0.1">
          <span class="field-hint">Used to scale animation root motion</span>

          <label for="rigTextureUpload" style="margin-top:12px">Override Texture (optional)</label>
          <div id="rigTextureDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:8px;padding:16px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:8px">
            <p style="margin:0 0 4px;font-size:13px;color:#ccc">Click or drop PNG</p>
            <span style="font-size:11px;color:#666">PNG only</span>
            <input type="file" id="rigTextureUpload" accept="image/png" hidden />
          </div>
          <div id="rigTextureFileName" style="display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,.05);border-radius:6px;font-size:13px;color:#ccc"></div>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 10</span>
          </div>
          <button type="button" id="applyRigBtn" class="gen-btn">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="2"/><path d="M12 7v6l-4 6m4-6l4 6M8 10l4 3 4-3"/></svg>
            Rig
          </button>
        </div>
      `,
  
      video: `
        <div class="card">
          <h3>Source Image</h3>
          <label for="videoSource" style="display:block;font-size:12px;font-weight:600;color:rgba(255,255,255,.7);margin-bottom:6px">Upload Reference Image</label>
          <div id="videoImageDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s ease">
            <svg style="width:32px;height:32px;margin:0 auto 8px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p style="margin:0 0 4px;font-size:13px;color:#ccc">Click or Drag & Drop</p>
            <span style="font-size:11px;color:#666">PNG, JPG, WEBP up to 10MB</span>
            <input type="file" id="videoSource" accept="image/*" hidden />
          </div>
          <img id="videoImagePreview" style="display:none;width:100%;border-radius:8px;margin-top:12px" alt="Preview"/>
        </div>

        <div class="card">
          <h3>Video Settings</h3>
          <label for="videoMotion">Motion Description</label>
          <textarea id="videoMotion" placeholder="Camera slowly zooms in while rotating..."></textarea>
          <span class="field-hint">Describe camera movements and scene dynamics</span>

          <label for="videoDuration" style="margin-top:12px">Duration</label>
          <select id="videoDuration">
            <option value="2">2 seconds</option>
            <option value="4" selected>4 seconds</option>
            <option value="6">6 seconds</option>
            <option value="8">8 seconds</option>
          </select>

          <label for="videoFPS" style="margin-top:12px">Frame Rate</label>
          <select id="videoFPS">
            <option value="24" selected>24 FPS (Cinematic)</option>
            <option value="30">30 FPS (Standard)</option>
            <option value="60">60 FPS (Smooth)</option>
          </select>

          <label style="margin-top:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="videoLoop" checked>
            <span>Loop Seamlessly</span>
          </label>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">3 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 15</span>
          </div>
          <button type="button" id="generateVideoBtn" class="gen-btn">
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
  
      if (window.timrx3D && typeof window.timrx3D.resize === 'function') {
        window.timrx3D.resize();
        return;
      }
  
      if (threeBooted) {
        const rect = model3dWrap.getBoundingClientRect();
        window.timrx3D?.renderer?.setSize(rect.width, rect.height, false);
        return;
      }
  
      if (window.THREE) bootThreeViewer();
      else window.addEventListener('three-ready', bootThreeViewer, { once: true });
    }
  
    /**
     * Boots the Three.js scene, renderer, controls, and animation loop.
     */
    function bootThreeViewer() {
      const THREE = window.THREE;
      if (!THREE || !viewerCanvas) return;
  
      const rect = model3dWrap.getBoundingClientRect();
  
      const scene  = new THREE.Scene();
      scene.background = new THREE.Color(0x2a2a2e);

      const camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 1000);
      camera.position.set(2.5, 2.2, 3.5);

      const renderer = new THREE.WebGLRenderer({ canvas: viewerCanvas, antialias: true });
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
      if (!window.THREE || !window.THREE.GLTFLoader) {
        console.error('Three.js or GLTFLoader not available');
        return;
      }
  
      ensureThreeViewer();
      const viewer = window.timrx3D;
      if (!viewer || !viewer.scene) {
        console.error('3D viewer not initialized');
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
          const creditsDisplay = leftStack.querySelector('.gen-credits');
          if (creditsDisplay) {
            if (targetTab === 'image3d') {
              // Image-to-3D costs 30 credits
              creditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 30';
            } else {
              // Text-to-3D costs 20 credits
              creditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 20';
            }
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
              modelImagePreview.style.display = 'block';
            };
            reader.readAsDataURL(this.files[0]);
          }
        });
        // Drag-n-drop
        modelImageDrop.addEventListener('dragover', (e) => {
          e.preventDefault();
          modelImageDrop.style.borderColor = 'rgba(255,255,255,.3)';
        });
        modelImageDrop.addEventListener('dragleave', () => {
          modelImageDrop.style.borderColor = 'rgba(255,255,255,.15)';
        });
        modelImageDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          modelImageDrop.style.borderColor = 'rgba(255,255,255,.15)';
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

      // Rig upload toggles
      const rigModelSelect   = leftStack.querySelector('#rigModelSelect');
      const rigUploadSection = leftStack.querySelector('#rigModelUploadSection');
      const rigModelDrop     = leftStack.querySelector('#rigModelDrop');
      const rigModelUpload   = leftStack.querySelector('#rigModelUpload');
      const rigModelFileName = leftStack.querySelector('#rigModelFileName');
      const rigTexDrop       = leftStack.querySelector('#rigTextureDrop');
      const rigTexUpload     = leftStack.querySelector('#rigTextureUpload');
      const rigTexFileName   = leftStack.querySelector('#rigTextureFileName');

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
            rigModelFileName.textContent = `📦 ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
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

      if (rigTexDrop && rigTexUpload && rigTexFileName) {
        rigTexDrop.addEventListener('click', () => rigTexUpload.click());
        rigTexUpload.addEventListener('change', function () {
          if (this.files && this.files[0]) {
            const f = this.files[0];
            rigTexFileName.textContent = `🖼 ${f.name}`;
            rigTexFileName.style.display = 'block';
          }
        });
        rigTexDrop.addEventListener('dragover', (e) => { e.preventDefault(); rigTexDrop.style.borderColor = 'rgba(255,255,255,.3)'; });
        rigTexDrop.addEventListener('dragleave', () => { rigTexDrop.style.borderColor = 'rgba(255,255,255,.15)'; });
        rigTexDrop.addEventListener('drop', (e) => {
          e.preventDefault();
          rigTexDrop.style.borderColor = 'rgba(255,255,255,.15)';
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            rigTexUpload.files = e.dataTransfer.files;
            rigTexUpload.dispatchEvent(new Event('change'));
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
      const creditsDisplay = leftStack.querySelector('.gen-credits');
      if (aiModelSelect && creditsDisplay) {
        aiModelSelect.addEventListener('change', function () {
          const value = this.value;
          if (value === 'meshy-5' || value === 'meshy-4') {
            creditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 10';
          } else {
            creditsDisplay.innerHTML = '<i class="fa-solid fa-coins"></i> 20';
          }
        });
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
      const activeBtn = document.querySelector('.timrx-3dprint .rail-btn.is-active');
      if (!activeBtn) return;
      const initialPanel = activeBtn.getAttribute('data-panel');
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
