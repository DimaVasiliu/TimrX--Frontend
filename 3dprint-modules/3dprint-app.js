/* ============================================================================
   TimrX 3D Print Workspace
   - Rail panel switching (Image / Model / Remesh / Texture / Rig / Animate / Video)
   - Left panel content injection (cards per tool)
   - Three.js viewer bootstrap + resize (model/remesh/texture)
   - Upload Modal (centered overlay, ESC/backdrop close, body scroll lock)
   - GLB/GLTF loader + auto center/scale + controls target
   ============================================================================ */

   function initTimrxWorkspace() {
    'use strict';

    /* -------------------------------------------------------------------------
     * QUICK DOM HOOKS
     * ---------------------------------------------------------------------- */
    const workspaceRoot = document.querySelector('.timrx-3dprint');
    if (!workspaceRoot) return;

    // Queried from the document: the mode switch now lives in the header,
    // outside .timrx-3dprint. Scoping to workspaceRoot would return an empty
    // list and silently disable every mode button.
    const railButtons   = document.querySelectorAll('.rail-btn');
    // Queried from the document, not workspaceRoot: the model/video choice
    // trays now live beside the command bar at body level, outside .timrx-3dprint.
    const modelFeatureButtons = document.querySelectorAll('.model-feature-btn');
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

    const DEFAULT_IMAGE_PROMPT_PLACEHOLDER = 'A futuristic cityscape at sunset with flying cars...';
    const DEFAULT_IMAGE_PROMPT_HINT = 'Be detailed and specific for best results';
    const RECRAFT_STYLEABLE_OPERATIONS = new Set(['generate', 'image_to_image', 'inpaint', 'replace_background', 'generate_background']);
    const RECRAFT_V3_RASTER_STYLE_GROUPS = [
      {
        label: 'Default',
        options: [
          { value: '', label: 'Default (Recraft V3 Raw)' },
          { value: 'Recraft V3 Raw', label: 'Recraft V3 Raw' },
        ],
      },
      {
        label: 'Photorealistic',
        options: [
          { value: 'Photorealism', label: 'Photorealism' },
          { value: 'Enterprise', label: 'Enterprise' },
          { value: 'Natural light', label: 'Natural light' },
          { value: 'Studio photo', label: 'Studio photo' },
          { value: 'HDR', label: 'HDR' },
          { value: 'Hard flash', label: 'Hard flash' },
          { value: 'Motion blur', label: 'Motion blur' },
          { value: 'Black & white', label: 'Black & white' },
          { value: 'Evening light', label: 'Evening light' },
          { value: 'Product photo', label: 'Product photo' },
          { value: 'Real-Life Glow', label: 'Real-Life Glow' },
          { value: 'Urban Drama', label: 'Urban Drama' },
        ],
      },
      {
        label: 'Illustration',
        options: [
          { value: 'Illustration', label: 'Illustration' },
          { value: 'Hand-drawn', label: 'Hand-drawn' },
          { value: 'Grain', label: 'Grain' },
          { value: 'Bold Sketch', label: 'Bold Sketch' },
          { value: 'Pencil sketch', label: 'Pencil sketch' },
          { value: 'Retro Pop', label: 'Retro Pop' },
          { value: 'Clay', label: 'Clay' },
          { value: 'Risograph', label: 'Risograph' },
          { value: 'Color engraving', label: 'Color engraving' },
          { value: 'Pixel art', label: 'Pixel art' },
          { value: 'Child book', label: 'Child book' },
          { value: 'Cover', label: 'Cover' },
          { value: 'Digital engraving', label: 'Digital engraving' },
          { value: 'Expressionism', label: 'Expressionism' },
          { value: 'Neon Calm', label: 'Neon Calm' },
          { value: 'Noir', label: 'Noir' },
          { value: 'Pastel gradient', label: 'Pastel gradient' },
          { value: 'Pop art', label: 'Pop art' },
          { value: 'Street art', label: 'Street art' },
          { value: 'Urban Glow', label: 'Urban Glow' },
          { value: 'Young adult book', label: 'Young adult book' },
        ],
      },
      {
        label: 'Emblems',
        options: [
          { value: 'Prestige Emblem', label: 'Prestige Emblem' },
          { value: 'Pop Graphic', label: 'Pop Graphic' },
          { value: 'Stamp', label: 'Stamp' },
          { value: 'Punk Graphic', label: 'Punk Graphic' },
          { value: 'Vintage Emblem', label: 'Vintage Emblem' },
        ],
      },
    ];
    const RECRAFT_V3_VECTOR_STYLE_GROUPS = [
      {
        label: 'Default',
        options: [
          { value: '', label: 'Default (Vector art)' },
          { value: 'Vector art', label: 'Vector art' },
        ],
      },
      {
        label: 'Vector',
        options: [
          { value: 'Line art', label: 'Line art' },
          { value: 'Linocut', label: 'Linocut' },
          { value: 'Color blobs', label: 'Color blobs' },
          { value: 'Engraving', label: 'Engraving' },
          { value: 'Bold stroke', label: 'Bold stroke' },
          { value: 'Chemistry', label: 'Chemistry' },
          { value: 'Colored stencil', label: 'Colored stencil' },
          { value: 'Editorial', label: 'Editorial' },
          { value: 'Cutout', label: 'Cutout' },
          { value: 'Marker outline', label: 'Marker outline' },
          { value: 'Mosaic', label: 'Mosaic' },
          { value: 'Naivector', label: 'Naivector' },
          { value: 'Roundish flat', label: 'Roundish flat' },
          { value: 'Segmented Colors', label: 'Segmented Colors' },
          { value: 'Sharp contrast', label: 'Sharp contrast' },
          { value: 'Thin', label: 'Thin' },
          { value: 'Vector Photo', label: 'Vector Photo' },
          { value: 'Vivid shapes', label: 'Vivid shapes' },
          { value: 'Seamless Vector', label: 'Seamless Vector' },
        ],
      },
    ];
    const buildFieldHelp = (content) => `
      <span class="field-help" tabindex="0" aria-label="More information">
        <span class="field-help__icon" aria-hidden="true">?</span>
        <span class="field-help__bubble">${content}</span>
      </span>
    `;

    // ── Persistent rig state (survives tab switches) ──
    // Single source of truth for the RIG panel.
    // Populated by preflight checks, wizard steps, and rig completion.
    const _timrxRigState = {
      // Source model
      source_type: null,          // 'current' | 'upload' | 'history'
      source_model_id: null,      // History item ID of source model
      source_task_id: null,       // Upstream Meshy task ID of source
      source_url: null,           // Model URL (S3 or Meshy)
      source_title: '',           // Display name of source
      source_thumbnail: null,     // Thumbnail URL

      // Preflight results
      preflight_done: false,      // Whether preflight was run
      face_count: null,           // Face count from preflight
      vertex_count: null,         // Vertex count from preflight
      is_riggable: null,          // true/false/null (unknown)
      preflight_limited: false,   // Uploads can only be partially validated pre-submit
      preflight_reason: null,     // Why not riggable (human-readable)
      recommended_action: null,   // 'proceed' | 'remesh_first' | 'unsupported'
      needs_remesh: false,        // Shorthand: face count exceeds limit

      // Wizard
      height_meters: 1.7,        // Character height
      uses_texture_image: false, // Optional PNG base texture guidance

      // Rig result
      rig_task_id: null,          // Meshy rig task ID after completion
      rig_glb_url: null,          // Rigged model GLB URL
      rig_fbx_url: null,          // Rigged model FBX URL
      rig_thumbnail: null,        // Rigged model thumbnail
      basic_animations: null,     // Array of built-in animation objects
      rig_complete: false,        // Whether rig is done
    };
    window._timrxRigState = _timrxRigState;

    // ── Persistent animation state (survives tab switches) ──
    // Single source of truth for the ANIMATE panel.
    // Populated by _handleRigComplete, history selection, or upload.
    const _timrxAnimState = {
      source_type: null,      // 'rig' | 'history' | 'upload'
      model_id: null,         // DB model ID (for history items)
      rig_task_id: null,      // Meshy rig task ID (required for animation API)
      model_url: null,        // GLB URL for preview
      title: '',              // Display name
      thumbnail_url: null,    // Thumbnail data URL or remote URL
      is_rigged: false,       // Whether model has a rig
      selected_action_id: null,      // Currently selected animation action_id
      selected_animation: null,      // Full animation object from library
      post_process_type: '',
      target_fps: '30',
    };
    window._timrxAnimState = _timrxAnimState;

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
        <div class="card image-gen-card">
          <h3>Generate Image</h3>
          <label for="imagePrompt" class="field-label-with-help">
            <span>Describe Your Image</span>
            ${buildFieldHelp('Raster: describe the subject, setting, materials, lighting, and camera feel.<br>SVG: ask for logos, icons, flat shapes, clean outlines, and limited colors.<br>Edit modes: describe only what should change from the uploaded source.')}
          </label>
          <textarea id="imagePrompt" placeholder="${DEFAULT_IMAGE_PROMPT_PLACEHOLDER}"></textarea>
          <div class="enhance-row">
            <span class="field-hint" id="imagePromptHint">${DEFAULT_IMAGE_PROMPT_HINT}</span>
            <button type="button" class="enhance-btn" data-enhance-mode="image" data-enhance-target="#imagePrompt" title="Make this prompt clearer and more detailed">
              <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
              <span class="enhance-btn-label">Enhance</span>
            </button>
          </div>
          <div class="enhance-feedback hidden" data-enhance-feedback="image"></div>

          <div class="card-divider"></div>
          <div class="image-settings-grid">
            <div class="inline-field">
              <label for="imageAIProvider">Provider</label>
              <select id="imageAIProvider">
                <option value="nano_banana" selected>Nano Banana</option>
                <option value="nano_banana_pro">Nano Banana Pro</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google Imagen</option>
                <option value="google_nano">Google Nano</option>
                <option value="flux_pro">FLUX.2</option>
                <option value="ideogram_v3">Ideogram</option>
                <option value="recraft_v4">Recraft</option>
              </select>
            </div>

            <div class="inline-field hidden" id="imageOperationRow">
              <label for="imageOperation">Mode</label>
              <select id="imageOperation">
                <option value="generate" selected>Generate</option>
              </select>
            </div>

            <div class="inline-field hidden" id="imageModelVariantRow">
              <label for="imageModelVariant" class="field-label-with-help">
                <span>Model</span>
                ${buildFieldHelp('Choose the provider model family. In Recraft, V4 is prompt-led for clean generation, while V3 unlocks curated styles, negative prompt, and edit tools.')}
              </label>
              <select id="imageModelVariant">
                <option value="">Default</option>
              </select>
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

            <!-- Quality (controls resolution per provider) -->
            <div class="inline-field" id="imageQualityRow">
              <label for="imageQuality">Quality</label>
              <select id="imageQuality">
                <option value="standard" selected>Standard (4c)</option>
                <option value="high">2K (8c)</option>
              </select>
            </div>

            <div class="inline-field hidden" id="imageOutputModeRow">
              <label for="imageOutputMode" class="field-label-with-help">
                <span>Output</span>
                ${buildFieldHelp('Raster is best for photos, scenes, packaging, and detailed illustrations.<br>SVG is best for logos, icons, decals, badges, and flat vector artwork that must scale cleanly.')}
              </label>
              <select id="imageOutputMode">
                <option value="raster" selected>Raster</option>
                <option value="vector_svg">SVG</option>
              </select>
            </div>
          </div>
          <div class="provider-lock-hint hidden" id="imageProviderLockHint">
            <i class="fa-solid fa-lock"></i> <span id="imageProviderLockText">Provider locked while generating.</span>
          </div>
          <div class="image-settings-meta">
            <span class="field-hint" id="imageShapeHint">Shape controls layout, not quality.</span>
            <span class="field-hint" id="imageQualityHint">Standard 4c · 2K 8c</span>
            <span class="field-hint hidden" id="imageOutputModeHint">Vector output is only available with Recraft V4.</span>
          </div>
          <div class="premium-quality-hint" id="premiumQualityHint"></div>

          <div class="card-divider"></div>

          <div class="image-assets-stack">
            <div class="image-asset-group hidden" id="imageSourceAssetGroup">
              <div class="image-asset-header">
                <label for="imageSourceUpload">Source Image</label>
                <span class="image-asset-badge">Optional</span>
              </div>
              <div class="image-upload-control">
                <input id="imageSourceUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg,image/webp">
                <label class="image-upload-trigger" for="imageSourceUpload">
                  <span class="image-upload-trigger__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M12 16V5"></path>
                      <path d="M8 9l4-4 4 4"></path>
                      <path d="M4 19h16"></path>
                    </svg>
                  </span>
                  <span class="image-upload-trigger__text">
                    <strong>Upload</strong>
                    <small>PNG, JPG or WebP</small>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="imageSourceUploadStatus">No source selected</div>
                <button type="button" class="image-upload-clear hidden" id="imageSourceUploadClear">Clear</button>
              </div>
              <div class="image-upload-list hidden" id="imageSourceUploadList"></div>
              <span class="field-hint" id="imageSourceUploadHint">Shown for edit, remix, reframe, upscale, and utility modes.</span>
            </div>

            <div class="image-asset-group hidden" id="imageMaskAssetGroup">
              <div class="image-asset-header">
                <label for="imageMaskUpload">Mask Image</label>
                <span class="image-asset-badge">Optional</span>
              </div>
              <div class="image-upload-control">
                <input id="imageMaskUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg,image/webp">
                <label class="image-upload-trigger" for="imageMaskUpload">
                  <span class="image-upload-trigger__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M12 16V5"></path>
                      <path d="M8 9l4-4 4 4"></path>
                      <path d="M4 19h16"></path>
                    </svg>
                  </span>
                  <span class="image-upload-trigger__text">
                    <strong>Upload</strong>
                    <small>High-contrast PNG, JPG or WebP</small>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="imageMaskUploadStatus">No mask selected</div>
                <button type="button" class="image-upload-clear hidden" id="imageMaskUploadClear">Clear</button>
              </div>
              <div class="image-upload-list hidden" id="imageMaskUploadList"></div>
              <span class="field-hint" id="imageMaskUploadHint">White changes, black protects.</span>
            </div>

            <div class="image-asset-group hidden" id="imageReferenceAssetGroup">
              <div class="image-asset-header">
                <label for="imageReferenceUpload">Reference Images</label>
                <div class="image-asset-header-meta">
                  <span class="image-asset-cap">Up to 8</span>
                  <span class="image-asset-badge">Optional</span>
                </div>
              </div>
              <div class="image-upload-control">
                <input id="imageReferenceUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg,image/webp" multiple>
                <label class="image-upload-trigger" for="imageReferenceUpload">
                  <span class="image-upload-trigger__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="4" y="5" width="6" height="6" rx="1"></rect>
                      <rect x="14" y="5" width="6" height="6" rx="1"></rect>
                      <path d="M4 16h16"></path>
                      <path d="M9 16v3"></path>
                      <path d="M15 16v3"></path>
                    </svg>
                  </span>
                  <span class="image-upload-trigger__text">
                    <strong>Add</strong>
                    <small>Add up to 8 reference images</small>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="imageReferenceUploadStatus">No references selected</div>
                <button type="button" class="image-upload-clear hidden" id="imageReferenceUploadClear">Clear</button>
              </div>
              <div class="image-upload-list hidden" id="imageReferenceUploadList"></div>
              <span class="field-hint" id="imageReferenceUploadHint">Add up to 8 references to guide composition, style, pose, or materials.</span>
            </div>

            <div class="image-asset-group hidden" id="imageStyleReferenceAssetGroup">
              <div class="image-asset-header">
                <label for="imageStyleReferenceUpload">Style References</label>
                <span class="image-asset-badge">Optional</span>
              </div>
              <div class="image-upload-control">
                <input id="imageStyleReferenceUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg,image/webp" multiple>
                <label class="image-upload-trigger" for="imageStyleReferenceUpload">
                  <span class="image-upload-trigger__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="8" cy="8" r="3"></circle>
                      <circle cx="16" cy="8" r="3"></circle>
                      <path d="M4 18c1.2-2.7 3-4 4-4s2.8 1.3 4 4"></path>
                      <path d="M12 18c1.2-2.7 3-4 4-4s2.8 1.3 4 4"></path>
                    </svg>
                  </span>
                  <span class="image-upload-trigger__text">
                    <strong>Add</strong>
                    <small>Guide the visual style</small>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="imageStyleReferenceUploadStatus">No style refs selected</div>
                <button type="button" class="image-upload-clear hidden" id="imageStyleReferenceUploadClear">Clear</button>
              </div>
              <div class="image-upload-list hidden" id="imageStyleReferenceUploadList"></div>
              <span class="field-hint" id="imageStyleReferenceUploadHint">Optional Ideogram style guides.</span>
            </div>

            <div class="image-asset-group hidden" id="imageCharacterReferenceAssetGroup">
              <div class="image-asset-header">
                <label for="imageCharacterReferenceUpload">Character Reference</label>
                <span class="image-asset-badge">Optional</span>
              </div>
              <div class="image-upload-control">
                <input id="imageCharacterReferenceUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg,image/webp">
                <label class="image-upload-trigger" for="imageCharacterReferenceUpload">
                  <span class="image-upload-trigger__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="12" cy="8" r="3"></circle>
                      <path d="M6 19c1.5-3.2 3.8-4.8 6-4.8S16.5 15.8 18 19"></path>
                    </svg>
                  </span>
                  <span class="image-upload-trigger__text">
                    <strong>Upload</strong>
                    <small>Keep one character consistent</small>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="imageCharacterReferenceUploadStatus">No character selected</div>
                <button type="button" class="image-upload-clear hidden" id="imageCharacterReferenceUploadClear">Clear</button>
              </div>
              <div class="image-upload-list hidden" id="imageCharacterReferenceUploadList"></div>
              <span class="field-hint" id="imageCharacterReferenceUploadHint">Use one image to keep a character consistent.</span>
            </div>

            <div class="image-asset-group hidden" id="imageCharacterMaskAssetGroup">
              <div class="image-asset-header">
                <label for="imageCharacterMaskUpload">Character Mask</label>
                <span class="image-asset-badge">Optional</span>
              </div>
              <div class="image-upload-control">
                <input id="imageCharacterMaskUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg,image/webp">
                <label class="image-upload-trigger" for="imageCharacterMaskUpload">
                  <span class="image-upload-trigger__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M12 4l7 4v4c0 4.5-2.8 7.7-7 8-4.2-.3-7-3.5-7-8V8l7-4z"></path>
                      <path d="M9 12l2 2 4-4"></path>
                    </svg>
                  </span>
                  <span class="image-upload-trigger__text">
                    <strong>Upload</strong>
                    <small>Optional mask for the character reference</small>
                  </span>
                </label>
                <div class="image-upload-status is-empty" id="imageCharacterMaskUploadStatus">No mask selected</div>
                <button type="button" class="image-upload-clear hidden" id="imageCharacterMaskUploadClear">Clear</button>
              </div>
              <div class="image-upload-list hidden" id="imageCharacterMaskUploadList"></div>
              <span class="field-hint" id="imageCharacterMaskUploadHint">Optional mask for the character reference.</span>
            </div>
          </div>

          <details id="imageAdvancedDetails" class="advanced-toggles image-advanced-panel">
            <summary class="image-advanced-summary">
              <span class="image-advanced-summary__title">Advanced Options</span>
              <span class="image-advanced-summary__chevron" aria-hidden="true">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M5 7.5L10 12.5L15 7.5"></path>
                </svg>
              </span>
            </summary>
            <div class="image-advanced-body">
            <div class="hidden image-advanced-wide" id="imageNegativePromptGroup">
                <label for="imageNegativePrompt" class="field-label-with-help">
                  <span>Negative Prompt</span>
                  ${buildFieldHelp('Describe what to avoid, such as blurry faces, extra limbs, messy text, or clutter.<br>For Recraft, this only works on V3 and V3 Vector generation/edit modes. Leave it empty on V4.')}
                </label>
                <textarea id="imageNegativePrompt" rows="2" placeholder="Things to avoid in the image"></textarea>
              </div>

              <div class="inline-field hidden" id="imageRenderingSpeedRow">
                <label for="imageRenderingSpeed">Speed</label>
                <select id="imageRenderingSpeed">
                  <option value="FLASH">Flash</option>
                  <option value="TURBO">Turbo</option>
                  <option value="DEFAULT" selected>Default</option>
                  <option value="QUALITY">Quality</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageMagicPromptRow">
                <label for="imageMagicPrompt">Magic Prompt</label>
                <select id="imageMagicPrompt">
                  <option value="AUTO" selected>Auto</option>
                  <option value="ON">On</option>
                  <option value="OFF">Off</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageStyleTypeRow">
                <label for="imageStyleType">Style Type</label>
                <select id="imageStyleType">
                  <option value="">Default</option>
                  <option value="AUTO">Auto</option>
                  <option value="GENERAL">General</option>
                  <option value="REALISTIC">Realistic</option>
                  <option value="DESIGN">Design</option>
                  <option value="FICTION">Fiction</option>
                </select>
              </div>

              <div class="hidden" id="imageStylePresetGroup">
                <label for="imageStylePreset">Style Preset</label>
                <input id="imageStylePreset" type="text" placeholder="Enter an official provider style preset">
              </div>

              <div class="hidden" id="imageStyleNameGroup">
                <label for="imageStyleName" class="field-label-with-help">
                  <span>Recraft Style</span>
                  ${buildFieldHelp('Pick a curated Recraft style that is valid for the selected V3 model.<br>Raster styles are for PNG/JPG-style images. Vector styles are for SVG illustrations and icons.<br>V4 models do not support curated styles.')}
                </label>
                <select id="imageStyleName">
                  <option value="">Default</option>
                </select>
              </div>

              <div class="hidden" id="imageStyleIdGroup">
                <label for="imageStyleId" class="field-label-with-help">
                  <span>Style ID</span>
                  ${buildFieldHelp('Paste a custom Recraft style ID from the Recraft Styles panel if you want to use your own saved style.<br>Use either the curated style dropdown or a style ID, not both.')}
                </label>
                <input id="imageStyleId" type="text" placeholder="Custom provider style ID">
              </div>

              <div class="hidden" id="imageStyleCodesGroup">
                <label for="imageStyleCodes">Style Codes</label>
                <input id="imageStyleCodes" type="text" placeholder="Comma-separated 8-char style codes">
              </div>

              <div class="hidden" id="imageColorPaletteNameGroup">
                <label for="imageColorPaletteName">Palette Name</label>
                <input id="imageColorPaletteName" type="text" placeholder="Named palette preset">
              </div>

              <div class="hidden" id="imageColorPaletteMembersGroup">
                <label for="imageColorPaletteMembers">Palette Colors</label>
                <input id="imageColorPaletteMembers" type="text" placeholder="#FFAA00,#2244DD or #FFAA00:0.7">
              </div>

              <div class="inline-field hidden" id="imageSeedRow">
                <label for="imageSeed">Seed</label>
                <input id="imageSeed" type="number" min="0" step="1" placeholder="Optional">
              </div>

              <div class="inline-field hidden" id="imageImageWeightRow">
                <label for="imageImageWeight">Image Weight</label>
                <input id="imageImageWeight" type="number" min="1" max="100" step="1" value="50">
              </div>

              <div class="inline-field hidden" id="imageStrengthRow">
                <label for="imageStrength">Strength</label>
                <input id="imageStrength" type="number" min="0" max="1" step="0.05" value="0.35">
              </div>

              <div class="inline-field hidden" id="imagePromptUpsamplingRow">
                <label for="imagePromptUpsampling">Upsampling</label>
                <select id="imagePromptUpsampling">
                  <option value="on" selected>On</option>
                  <option value="off">Off</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageGuidanceRow">
                <label for="imageGuidance">Guidance</label>
                <input id="imageGuidance" type="number" min="1.5" max="10" step="0.1" placeholder="5">
              </div>

              <div class="inline-field hidden" id="imageStepsRow">
                <label for="imageSteps">Steps</label>
                <input id="imageSteps" type="number" min="1" max="50" step="1" placeholder="50">
              </div>

              <div class="inline-field hidden" id="imageSafetyToleranceRow">
                <label for="imageSafetyTolerance">Safety</label>
                <input id="imageSafetyTolerance" type="number" min="0" max="5" step="1" value="2">
              </div>

              <div class="inline-field hidden" id="imageOutputFormatRow">
                <label for="imageOutputFormat">Format</label>
                <select id="imageOutputFormat">
                  <option value="jpeg" selected>JPEG</option>
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageTransparentBackgroundRow">
                <label for="imageTransparentBackground">Transparent</label>
                <select id="imageTransparentBackground">
                  <option value="off" selected>Off</option>
                  <option value="on">On</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageUpscaleDetailRow">
                <label for="imageUpscaleDetail">Upscale Detail</label>
                <input id="imageUpscaleDetail" type="number" min="0" max="100" step="1" value="50">
              </div>

              <div class="inline-field hidden" id="imageUpscaleResemblanceRow">
                <label for="imageUpscaleResemblance">Resemblance</label>
                <input id="imageUpscaleResemblance" type="number" min="0" max="100" step="1" value="50">
              </div>

              <div class="hidden" id="imageBackgroundColorGroup">
                <label for="imageBackgroundColor">Background Color</label>
                <input id="imageBackgroundColor" type="text" placeholder="#FFFFFF">
              </div>

              <div class="hidden" id="imagePreferredColorsGroup">
                <label for="imagePreferredColors">Preferred Colors</label>
                <input id="imagePreferredColors" type="text" placeholder="#E60023,#1D4ED8">
              </div>

              <div class="inline-field hidden" id="imageArtisticLevelRow">
                <label for="imageArtisticLevel">Artistic Level</label>
                <input id="imageArtisticLevel" type="number" min="0" max="5" step="1" placeholder="0-5">
              </div>

              <div class="inline-field hidden" id="imageNoTextRow">
                <label for="imageNoText">No Text</label>
                <select id="imageNoText">
                  <option value="off" selected>Off</option>
                  <option value="on">On</option>
                </select>
              </div>

              <div class="hidden image-advanced-wide" id="imageTextLayoutGroup">
                <label for="imageTextLayout" class="field-label-with-help">
                  <span>Text Layout</span>
                  ${buildFieldHelp('Optional JSON layout for placing text in the image. This is mainly for Recraft V3 / V3 Vector text-aware generation.<br>Use it only if you know the provider schema.')}
                </label>
                <textarea id="imageTextLayout" rows="3" placeholder='[{"text":"SALE","bbox":[[0.1,0.1],[0.8,0.1],[0.8,0.3],[0.1,0.3]]}]'></textarea>
              </div>

              <div class="inline-field hidden" id="imageSvgCompressionRow">
                <label for="imageSvgCompression">SVG Compression</label>
                <select id="imageSvgCompression">
                  <option value="off" selected>Off</option>
                  <option value="on">On</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageLimitShapesRow">
                <label for="imageLimitShapes">Limit Shapes</label>
                <select id="imageLimitShapes">
                  <option value="off" selected>Off</option>
                  <option value="on">On</option>
                </select>
              </div>

              <div class="inline-field hidden" id="imageMaxShapesRow">
                <label for="imageMaxShapes">Max Shapes</label>
                <input id="imageMaxShapes" type="number" min="1" step="1" placeholder="Optional">
              </div>
            </div>
          </details>

          <div class="provider-hint" id="imageProviderHint"></div>
        </div>

        <div class="card gen-footer-card image-gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time" id="imageGenTime">45 sec</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits" id="imageCreditsDisplay"><i class="fa-solid fa-coins"></i> 7</span>
          </div>
          <button type="button" id="generateImageBtn" class="gen-btn" title="7 credits" data-provider="nano_banana">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21"/></svg>
            Generate <span class="btn-cost-badge">7 cr</span>
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
            <div class="negative-prompt-field">
              <label for="modelNegativePrompt">Avoid <span class="field-optional">(optional)</span></label>
              <textarea id="modelNegativePrompt" class="negative-prompt-input" maxlength="240" placeholder="blurry forms, extra limbs, warped hands, text, logos, thin fragile parts"></textarea>
              <span class="field-hint">Meshy 5/6 do not use a native negative-prompt field, so TimrX folds this into the prompt as “Avoid”.</span>
            </div>
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
                <img id="modelImagePreview" class="video-preview-img" alt="Preview" width="280" height="280" loading="lazy" decoding="async"/>
                <div class="video-preview-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <path d="M21 15l-5-5L5 21"/>
                  </svg>
                </div>
              </div>
            </div>
            <div class="negative-prompt-field">
              <label for="image3dNegativePrompt">Avoid <span class="field-optional">(optional)</span></label>
              <textarea id="image3dNegativePrompt" class="negative-prompt-input negative-prompt-input--compact" maxlength="240" placeholder="unwanted text, logos, noisy surfaces, extra parts"></textarea>
              <span class="field-hint">Used as an avoid instruction when the provider accepts text guidance.</span>
            </div>
          </div>

          <div class="tab-content hidden" id="multiimage3d">
            <div class="inline-field" style="margin-bottom:10px">
              <label for="multiImageModelName" style="font-size:12px">Name</label>
              <input type="text" id="multiImageModelName" placeholder="My Multi-View Model" style="width:100%;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:7px;color:#fff;font-size:12px" />
            </div>
            <label class="video-section-label">Upload 1–4 Reference Images <span class="info-dot" title="Meshy 7 / Latest treats the first image as the primary front view. The order of the other images does not matter.">i</span></label>
            <div id="multiImageGrid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px;max-width:240px;margin-left:auto;margin-right:auto">
              <div class="multi-img-slot" data-slot="0">
                <div class="video-drop-zone" id="multiImgDrop0" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#c9b47a;margin-top:3px;font-weight:600">Image 1 · Front</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
              <div class="multi-img-slot" data-slot="1">
                <div class="video-drop-zone" id="multiImgDrop1" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#888;margin-top:3px">Image 2 · optional</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
              <div class="multi-img-slot" data-slot="2">
                <div class="video-drop-zone" id="multiImgDrop2" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#888;margin-top:3px">Image 3 · optional</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
              <div class="multi-img-slot" data-slot="3">
                <div class="video-drop-zone" id="multiImgDrop3" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#888;margin-top:3px">Image 4 · optional</span>
                  <input type="file" class="multi-img-input" accept="image/*" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
            </div>
            <span class="field-hint"><strong>Image 1 is the primary front view</strong> — Meshy 7 / Latest builds the model around it. Images 2–4 are optional extra angles of the same object, in any order.</span>
            <span class="field-hint" style="color:#b08a3e;font-size:10px;margin-top:2px">Images are sent as data URLs — keep each file under 5 MB for reliable uploads</span>
            <div id="multiImageCount" style="font-size:11px;color:#666;margin-top:4px">0 / 4 images selected</div>
            <div class="negative-prompt-field">
              <label for="multiImageNegativePrompt">Avoid <span class="field-optional">(optional)</span></label>
              <textarea id="multiImageNegativePrompt" class="negative-prompt-input negative-prompt-input--compact" maxlength="240" placeholder="background clutter, duplicated parts, text, logos"></textarea>
            </div>
          </div>

          <div class="card-divider"></div>

          <div class="field-row-grid">
            <div class="field-row">
              <span class="field-label-inline">AI Model <span class="info-dot" title="Select the AI model version">ⓘ</span></span>
              <select id="modelAIModel" class="field-select-inline">
                <option value="latest" selected>Latest</option>
                <option value="meshy-7">Meshy 7</option>
                <option value="meshy-t2">Smart Topology T2</option>
                <option value="meshy-t1">Smart Topology T1</option>
                <option value="meshy-6">Meshy 6</option>
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
                <option value="smart-topology">Smart Topology</option>
                <option value="lowpoly">Low Poly</option>
              </select>
            </div>
          </div>

          <div class="field-row-grid field-row-grid--meshy-api" style="margin-top:12px">
            <div class="field-row">
              <span class="field-label-inline">Texture Resolution</span>
              <select id="modelTextureResolution" class="field-select-inline">
                <option value="2k" selected>2K</option>
                <option value="4k">4K</option>
                <option value="8k">8K</option>
              </select>
            </div>

            <div class="field-row">
              <span class="field-label-inline">Ultra Geometry</span>
              <label class="toggle-switch">
                <input type="checkbox" id="modelUltraMode">
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="field-row">
              <span class="field-label-inline">Transparent Thumbnail</span>
              <label class="toggle-switch">
                <input type="checkbox" id="modelAlphaThumbnail">
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="field-row">
              <span class="field-label-inline">Multi-view Thumbnails</span>
              <label class="toggle-switch">
                <input type="checkbox" id="modelMultiViewThumbnails">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <details class="advanced-toggles" style="margin-top:8px">
            <summary style="font-size:11px;color:#888;cursor:pointer;user-select:none">Advanced Preview Settings</summary>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:12px">
              <div class="field-row-grid field-row-grid--toggles">
                <div class="field-row">
                  <span class="field-label-inline">Auto-remesh Output <span class="info-dot" title="When enabled, Meshy rebuilds the mesh topology during preview generation. Leave off to get the raw high-detail mesh, then use the Remesh panel for controlled print prep.">i</span></span>
                  <label class="toggle-switch">
                    <input type="checkbox" id="modelShouldRemesh">
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="field-row">
                  <span class="field-label-inline">Content Moderation <span class="info-dot" id="modelModerationInfo" title="Text-to-3D always runs Meshy content moderation. Image flows let you choose.">i</span></span>
                  <label class="toggle-switch">
                    <input type="checkbox" id="modelModeration">
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="field-row">
                  <span class="field-label-inline">Auto Size</span>
                  <label class="toggle-switch">
                    <input type="checkbox" id="modelAutoSize">
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>

              <div id="modelRemeshSettings" class="model-preview-advanced-group" style="display:none">
                <div class="inline-field">
                  <label for="modelTopology">Topology</label>
                  <select id="modelTopology">
                    <option value="triangle" selected>Triangle</option>
                    <option value="quad">Quad</option>
                  </select>
                </div>
                <div class="inline-field">
                  <label for="modelDecimationMode">Decimation <span class="info-dot" title="Adaptive decimation picks the polycount for you. When set, Meshy ignores Target Polycount.">i</span></label>
                  <select id="modelDecimationMode">
                    <option value="" selected>Off — use polycount</option>
                    <option value="1">Adaptive — Ultra</option>
                    <option value="2">Adaptive — High</option>
                    <option value="3">Adaptive — Medium</option>
                    <option value="4">Adaptive — Low</option>
                  </select>
                </div>
                <div class="inline-field">
                  <label for="modelTargetPolycount">Target Polycount</label>
                  <input type="number" id="modelTargetPolycount" value="30000" min="100" max="300000" step="1000">
                </div>
              </div>

              <div id="modelAutoSizeSettings" class="model-preview-advanced-group" style="display:none">
                <div class="inline-field">
                  <label for="modelOriginAt">Origin</label>
                  <select id="modelOriginAt">
                    <option value="bottom" selected>Bottom</option>
                    <option value="center">Center</option>
                  </select>
                </div>
              </div>

              <div class="texture-format-group" style="margin-top:0">
                <span class="field-label-inline">Additional Export Formats</span>
                <div class="texture-format-grid" id="modelTargetFormats">
                  <label class="texture-format-option">
                    <input type="checkbox" value="obj">
                    <span class="texture-format-chip">OBJ</span>
                  </label>
                  <label class="texture-format-option">
                    <input type="checkbox" value="fbx">
                    <span class="texture-format-chip">FBX</span>
                  </label>
                  <label class="texture-format-option">
                    <input type="checkbox" value="stl">
                    <span class="texture-format-chip">STL</span>
                  </label>
                  <label class="texture-format-option">
                    <input type="checkbox" value="usdz">
                    <span class="texture-format-chip">USDZ</span>
                  </label>
                  <label class="texture-format-option">
                    <input type="checkbox" value="3mf">
                    <span class="texture-format-chip">3MF</span>
                  </label>
                </div>
                <p class="field-hint texture-setting-note">GLB stays enabled for in-app preview. Add extra formats only when needed. 3MF is recommended for color 3D printing.</p>
              </div>

              <p class="field-hint texture-setting-note" id="modelPreviewAdvancedNote">Turn on auto-remesh if you want Meshy to apply topology cleanup during preview generation. For print workflows, it is usually better to leave this off and use the dedicated Remesh panel after refining, which gives you more control over the result.</p>
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
            Generate <span class="btn-cost-badge">20 cr</span>
          </button>
        </div>
      `,

      remesh: `
        <div class="card">
          <h3>Prepare for Print</h3>
          <p class="card-desc" style="margin:0 0 10px;font-size:12px;color:rgba(255,255,255,.55);line-height:1.5">
            Remeshing rebuilds the mesh topology to fix common AI-generation artifacts:
            open edges, non-manifold faces, and irregular polygon distribution.
            This is the most important step before exporting for 3D printing.
          </p>

          <div class="remesh-model-state" id="remeshModelState" style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);font-size:12px;color:rgba(255,255,255,.6)">
            <span style="font-weight:600;color:rgba(255,255,255,.8)">Model state:</span>
            <span id="remeshModelStateLabel" style="margin-left:4px">No model loaded</span>
          </div>

          <h4 style="margin:0 0 6px;font-size:12px;font-weight:600;color:rgba(255,255,255,.7);letter-spacing:.02em">Source</h4>
          <div class="inline-field">
            <label for="remeshModelSelect">Model</label>
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
              <span style="font-size:11px;color:#666">GLB, OBJ, FBX, STL, GLTF</span>
              <input type="file" id="remeshModelUpload" accept=".obj,.fbx,.stl,.gltf,.glb" hidden />
            </div>
            <div id="remeshModelFileName" style="display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,.05);border-radius:7px;font-size:12px;color:#ccc"></div>
          </div>

          <div class="card-divider"></div>

          <h4 style="margin:0 0 8px;font-size:12px;font-weight:600;color:rgba(255,255,255,.7);letter-spacing:.02em">Remesh Preset</h4>
          <div class="remesh-presets" id="remeshPresets">
            <button type="button" class="remesh-preset is-active" data-preset="print-ready" data-poly="50000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.72 13.829a5.25 5.25 0 01-.905-2.578L4.5 10.5l1.315-.751A5.25 5.25 0 016.72 7.171L8 6l.754 1.321a5.25 5.25 0 012.578.905L12.5 9.5l-1.168.674a5.25 5.25 0 01-.905 2.578L9.5 14l-.754-1.321a5.25 5.25 0 01-2.026.15z"/><path d="M15 4l.5 1a3.5 3.5 0 001.5 1.5l1 .5-1 .5a3.5 3.5 0 00-1.5 1.5L15 10l-.5-1a3.5 3.5 0 00-1.5-1.5L12 7l1-.5a3.5 3.5 0 001.5-1.5L15 4z"/><path d="M6 14v4a2 2 0 002 2h8a2 2 0 002-2v-4"/></svg>
              <span class="remesh-preset__name">Print Ready</span>
              <span class="remesh-preset__desc">50K tris — watertight mesh for FDM/resin slicers</span>
            </button>
            <button type="button" class="remesh-preset" data-preset="miniature" data-poly="80000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a4 4 0 014 4v1h2a1 1 0 011 1v2a1 1 0 01-1 1h-1v5l1 4H6l1-4v-5H6a1 1 0 01-1-1V8a1 1 0 011-1h2V6a4 4 0 014-4z"/></svg>
              <span class="remesh-preset__name">Figurine / Mini</span>
              <span class="remesh-preset__desc">80K tris — preserves fine detail for small resin prints</span>
            </button>
            <button type="button" class="remesh-preset" data-preset="high-detail" data-poly="100000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/><path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"/></svg>
              <span class="remesh-preset__name">High Detail</span>
              <span class="remesh-preset__desc">100K tris — maximum fidelity for large display pieces</span>
            </button>
            <button type="button" class="remesh-preset" data-preset="game-asset" data-poly="10000" data-topo="triangle">
              <svg class="remesh-preset__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875S10.5 3.089 10.5 4.125c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.95 3.064 2.109 4.112A6.002 6.002 0 0012 12a6.002 6.002 0 013.461-1.458 6.998 6.998 0 002.109-4.112 48.39 48.39 0 01-4.163.3.64.64 0 01-.657-.643z"/><path d="M3 18h18M5.25 18v-3h13.5v3"/></svg>
              <span class="remesh-preset__name">Game / Low-Poly</span>
              <span class="remesh-preset__desc">10K tris — optimized for real-time rendering, not print</span>
            </button>
          </div>

          <div class="remesh-guidance" style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(var(--accent-purple-rgb, 184, 167, 122),.06);border:1px solid rgba(var(--accent-purple-rgb, 184, 167, 122),.12);font-size:11px;line-height:1.55;color:rgba(255,255,255,.55)">
            <strong style="color:rgba(255,255,255,.75);display:block;margin-bottom:4px">Recommended workflow for printing:</strong>
            1. Generate your model (Text or Image to 3D)<br>
            2. Refine it (adds high-quality textures + improves geometry)<br>
            3. Remesh with <strong>Print Ready</strong> preset (fixes topology for slicing)<br>
            4. Run <strong>Print Check</strong> in the viewer toolbar to verify<br>
            5. Export STL from the Print Check panel
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
              <label for="remeshResizeHeight">Resize Height (m)</label>
              <input type="number" id="remeshResizeHeight" min="0" step="0.01" placeholder="0 = keep original">
            </div>
            <div class="inline-field">
              <label for="remeshOriginAt">Origin</label>
              <select id="remeshOriginAt">
                <option value="" selected>Keep Original</option>
                <option value="bottom">Bottom (recommended for print)</option>
                <option value="center">Center</option>
              </select>
            </div>
            <div class="texture-format-group">
              <span class="field-label-inline">Additional Export Formats</span>
              <div class="texture-format-grid" id="remeshTargetFormats">
                <label class="texture-format-option">
                  <input type="checkbox" value="obj">
                  <span class="texture-format-chip">OBJ</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="fbx">
                  <span class="texture-format-chip">FBX</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="stl" checked>
                  <span class="texture-format-chip">STL</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="usdz">
                  <span class="texture-format-chip">USDZ</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="blend">
                  <span class="texture-format-chip">BLEND</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="3mf">
                  <span class="texture-format-chip">3MF</span>
                </label>
              </div>
              <p class="field-hint texture-setting-note">GLB is always included for in-app preview. STL for 3D printing. 3MF for color printing. OBJ/FBX for editing. USDZ for AR.</p>
            </div>
            <div class="field-row">
              <span class="field-label-inline">Format Only (skip remesh)</span>
              <label class="toggle-switch">
                <input type="checkbox" id="remeshConvertFormatOnly">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <p class="field-hint texture-setting-note" id="remeshConvertOnlyNote">When enabled, Meshy exports the selected formats without changing topology, origin, or size. Use this to convert an already-clean mesh to different file formats.</p>
          </div>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits" id="remeshCreditsDisplay"><i class="fa-solid fa-coins"></i> 5</span>
          </div>
          <button type="button" id="applyRemeshBtn" class="gen-btn" title="5 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/></svg>
            Remesh <span class="btn-cost-badge">5 cr</span>
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

          <div class="card-divider"></div>
          <textarea id="texturePrompt" placeholder="Rusty metal with scratches and weathering..."></textarea>
          <div class="enhance-row">
            <span class="field-hint">Describe material, surface, and color, or pair the model with a style image</span>
            <button type="button" class="enhance-btn" data-enhance-mode="texture" data-enhance-target="#texturePrompt" title="Make this prompt clearer and more detailed">
              <svg class="enhance-btn-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
              <span class="enhance-btn-label">Enhance</span>
            </button>
          </div>
          <div class="enhance-feedback hidden" data-enhance-feedback="texture"></div>
          <div class="negative-prompt-field">
            <label for="textureNegativePrompt">Avoid in texture <span class="field-optional">(optional)</span></label>
            <textarea id="textureNegativePrompt" class="negative-prompt-input negative-prompt-input--compact" maxlength="240" placeholder="plastic shine, dirt, scratches, logos, text, seams"></textarea>
            <span class="field-hint">Works best with a text texture prompt. Image-only texture references remain image-guided.</span>
          </div>

          <div class="texture-style-block">
            <div class="image-upload-control">
              <input id="textureStyleImageUpload" class="visually-hidden image-upload-input" type="file" accept="image/png,image/jpeg">
              <label class="image-upload-trigger" for="textureStyleImageUpload">
                <span class="image-upload-trigger__text">
                  <strong>Add style image</strong>
                </span>
              </label>
              <div class="image-upload-status is-empty" id="textureStyleImageStatus">Optional JPG or PNG reference</div>
              <button type="button" class="image-upload-clear hidden" id="textureStyleImageClear">Clear</button>
            </div>
            <div class="image-upload-list image-upload-list--preview hidden" id="textureStyleImagePreview"></div>
            <div class="inline-field texture-style-url-row">
              <label for="textureStyleImageUrl">Or paste image URL</label>
              <input type="text" id="textureStyleImageUrl" placeholder="https://example.com/material-reference.jpg">
            </div>
            <p class="field-hint texture-setting-note">If both text and image are set, Meshy uses the image reference to guide the retexture.</p>
          </div>

          <div class="texture-style-block" id="textureMultiviewBlock" style="display:none">
            <span class="field-label-inline">Multiview Style Images <span class="info-dot" title="Meshy 7 / Latest can texture from up to 4 photos of the same object. The first image is the primary front view; the other angles can be in any order.">i</span></span>
            <div id="textureMultiviewGrid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:8px auto;max-width:240px">
              <div class="multi-img-slot" data-slot="0">
                <div class="video-drop-zone" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#c9b47a;margin-top:3px;font-weight:600">Style 1 · Front</span>
                  <input type="file" class="multi-img-input" accept="image/png,image/jpeg" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
              <div class="multi-img-slot" data-slot="1">
                <div class="video-drop-zone" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#888;margin-top:3px">Style 2 · optional</span>
                  <input type="file" class="multi-img-input" accept="image/png,image/jpeg" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
              <div class="multi-img-slot" data-slot="2">
                <div class="video-drop-zone" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#888;margin-top:3px">Style 3 · optional</span>
                  <input type="file" class="multi-img-input" accept="image/png,image/jpeg" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
              <div class="multi-img-slot" data-slot="3">
                <div class="video-drop-zone" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:18px;height:18px;opacity:.4"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  <span style="font-size:10px;color:#888;margin-top:3px">Style 4 · optional</span>
                  <input type="file" class="multi-img-input" accept="image/png,image/jpeg" hidden />
                </div>
                <img class="multi-img-preview" width="120" height="120" loading="lazy" decoding="async" style="display:none;width:100%;aspect-ratio:1;object-fit:contain;border-radius:7px;background:rgba(0,0,0,0.3)" />
              </div>
            </div>
            <div class="inline-field texture-style-url-row">
              <label for="textureMultiviewUrls">Or paste image URLs</label>
              <input type="text" id="textureMultiviewUrls" placeholder="https://a.jpg, https://b.jpg">
            </div>
            <div id="textureMultiviewCount" style="font-size:11px;color:#666;margin-top:4px">0 / 4 style views selected</div>
            <p class="field-hint texture-setting-note" id="textureMultiviewNote">Multiview replaces the text prompt and the single style image — when views are set, Meshy textures from them alone.</p>
          </div>

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

          <div class="card-divider"></div>

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
              <label for="textureAiModel">Meshy Model</label>
              <select id="textureAiModel">
                <option value="latest" selected>Latest (Meshy 7)</option>
                <option value="meshy-7">Meshy 7</option>
                <option value="meshy-6">Meshy 6</option>
                <option value="meshy-5">Meshy 5</option>
              </select>
            </div>
            <div class="inline-field">
              <label for="textureResolution">Texture Resolution</label>
              <select id="textureResolution">
                <option value="2k" selected>2K</option>
                <option value="4k">4K</option>
                <option value="8k">8K</option>
              </select>
            </div>
            <div class="field-row">
              <span class="field-label-inline">Remove Lighting</span>
              <label class="toggle-switch">
                <input type="checkbox" id="textureRemoveLighting" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <p class="field-hint texture-setting-note" id="textureRemoveLightingNote">Cleaner base color textures for custom lighting setups. Only available on Meshy 6.</p>
            <label style="margin-top:8px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px">
              <input type="checkbox" id="seamless" checked>
              <span>Preserve Original UV</span>
            </label>
            <div class="texture-format-group">
              <span class="field-label-inline">Additional Export Formats</span>
              <div class="texture-format-grid" id="textureTargetFormats">
                <label class="texture-format-option">
                  <input type="checkbox" value="obj" checked>
                  <span class="texture-format-chip">OBJ</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="fbx" checked>
                  <span class="texture-format-chip">FBX</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="stl" checked>
                  <span class="texture-format-chip">STL</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="usdz" checked>
                  <span class="texture-format-chip">USDZ</span>
                </label>
                <label class="texture-format-option">
                  <input type="checkbox" value="3mf">
                  <span class="texture-format-chip">3MF</span>
                </label>
              </div>
              <p class="field-hint texture-setting-note">GLB stays enabled for in-app preview. Add extra formats only when you need export-ready variants. 3MF is ideal for color printing.</p>
            </div>
          </div>
        </div>

        <div class="card gen-footer-card">
          <div class="gen-meta">
            <span class="gen-time">1.5 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 10</span>
          </div>
          <button type="button" id="generateTextureBtn" class="gen-btn" title="10 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
            Texture <span class="btn-cost-badge">10 cr</span>
          </button>
        </div>
      `,

      rig: `
        <!-- Preflight: Model readiness check -->
        <div id="rigPreflightCard" class="card">
          <h3>Humanoid Rig</h3>

          <!-- Preflight status area (shown after check runs) -->
          <div id="rigPreflightResult" style="display:none">
            <div id="rigPreflightInfo" style="padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px"></div>
          </div>

          <!-- Face count warning + remesh CTA -->
          <div id="rigFaceCountWarning" style="display:none;margin-bottom:10px">
            <div style="padding:10px;background:rgba(255,80,80,.08);border-radius:6px;border-left:3px solid rgba(255,80,80,.5)">
              <p id="rigFaceCountMsg" style="margin:0 0 8px;font-size:12px;color:#ff6b6b;font-weight:500"></p>
              <button type="button" id="rigRemeshCTA" class="gen-btn gen-btn--rail" style="width:100%;font-size:12px;padding:8px">
                <i class="fa-solid fa-cubes" style="font-size:10px;margin-right:4px"></i> Optimize for Rigging (Remesh)
              </button>
            </div>
          </div>

          <!-- Already rigged notice -->
          <div id="rigAlreadyRiggedNotice" style="display:none;padding:8px 10px;background:rgba(100,180,255,.08);border-radius:6px;border-left:3px solid rgba(100,180,255,.4);font-size:11px;color:#88b8ff;margin-bottom:10px">
            This model appears to be already rigged. You can still re-rig if needed.
          </div>

          <!-- Requirements checklist -->
          <div style="padding:8px 0;font-size:12px;color:#aaa;line-height:1.6">
            <p style="margin:0 0 6px;color:#e0e0e0;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.7">Requirements</p>
            <ul style="margin:0;padding-left:18px;list-style:disc;font-size:11px">
              <li>Humanoid / bipedal character</li>
              <li>Clear limbs separated from body</li>
              <li>Textured preferred for quality</li>
              <li>Under 300K faces</li>
            </ul>
          </div>

          <button type="button" id="rigPreflightBtn" class="gen-btn gen-btn--rail" style="margin-top:8px;width:100%;font-size:12px">
            <i class="fa-solid fa-magnifying-glass-chart" style="font-size:10px;margin-right:4px"></i> Check Model Readiness
          </button>
        </div>

        <!-- Step 1 — Alignment guidance -->
        <div id="rigWizardStep1" class="card" style="display:none">
          <h3>Alignment Guidance</h3>
          <div style="padding:8px 10px;background:rgba(100,180,255,.06);border-radius:6px;border-left:3px solid rgba(100,180,255,.3);margin-bottom:10px">
            <p style="margin:0;font-size:11px;color:#88b8ff;line-height:1.5">
              For best results, center your character, face them to the front, and adjust to appropriate height.
            </p>
          </div>
          <div style="font-size:12px;color:#aaa;line-height:1.6">
            <ul style="margin:0;padding-left:18px;list-style:disc">
              <li><strong>Centered</strong> at origin (0,0,0)</li>
              <li><strong>Facing forward</strong> along the default axis</li>
              <li><strong>Standing upright</strong> in a neutral T-pose or A-pose</li>
              <li><strong>Feet on ground plane</strong> (Y=0)</li>
            </ul>
          </div>

          <div class="inline-field" style="margin-top:12px">
            <label for="rigHeight">Rig Skeleton Height (meters)</label>
            <input type="number" id="rigHeight" value="1.7" min="0.1" max="5.0" step="0.1">
          </div>
          <span class="field-hint">Height used for skeleton rigging only — does NOT affect print dimensions. Set print size in the Print Check panel.</span>

          <div class="inline-field" style="margin-top:10px">
            <label for="rigModelSelect">Source</label>
            <select id="rigModelSelect">
              <option value="current" selected>Current Model</option>
              <option value="upload">Upload New Model</option>
            </select>
          </div>

          <div id="rigModelUploadSection" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)">
            <label for="rigModelUpload" style="font-size:12px">Upload 3D Model (GLB only)</label>
            <div id="rigModelDrop" style="border:2px dashed rgba(255,255,255,.15);border-radius:7px;padding:14px;text-align:center;cursor:pointer;transition:border-color .2s ease;margin-top:5px">
              <svg style="width:24px;height:24px;margin:0 auto 6px;opacity:.3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p style="margin:0;font-size:11px;color:#ccc">Click or drop GLB file</p>
              <input type="file" id="rigModelUpload" accept=".glb" hidden />
            </div>
            <div id="rigModelFileName" style="display:none;margin-top:8px;padding:8px;background:rgba(255,255,255,.05);border-radius:6px;font-size:11px;color:#ccc"></div>
          </div>

          <div class="texture-style-block" style="margin-top:12px">
            <div class="image-upload-control">
              <input id="rigTextureImageUpload" class="visually-hidden image-upload-input" type="file" accept="image/png">
              <label class="image-upload-trigger" for="rigTextureImageUpload">
                <span class="image-upload-trigger__text">
                  <strong>Add base texture image</strong>
                </span>
              </label>
              <div class="image-upload-status is-empty" id="rigTextureImageStatus">Optional PNG for UV-based base color guidance</div>
              <button type="button" class="image-upload-clear hidden" id="rigTextureImageClear">Clear</button>
            </div>
            <div class="image-upload-list image-upload-list--preview hidden" id="rigTextureImagePreview"></div>
            <div class="inline-field texture-style-url-row">
              <label for="rigTextureImageUrl">Or paste PNG URL</label>
              <input type="text" id="rigTextureImageUrl" placeholder="https://example.com/base-color.png">
            </div>
            <p class="field-hint texture-setting-note">Use this when your GLB has weak or missing embedded textures. Meshy only supports PNG for rig texture guidance.</p>
          </div>
        </div>

        <!-- Step 2 — Submit -->
        <div id="rigWizardStep2" class="card gen-footer-card" style="display:none">
          <div id="rigPreflightSummary" style="display:none;margin-bottom:10px;padding:8px 10px;border-radius:6px;font-size:11px"></div>
          <div class="gen-meta">
            <span class="gen-time">2 min</span>
            <span class="gen-divider">|</span>
            <span class="gen-credits"><i class="fa-solid fa-coins"></i> 5</span>
          </div>
          <button type="button" id="startRigBtn" class="gen-btn gen-btn--rail" title="5 credits">
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 014 4v1h2a1 1 0 011 1v2a1 1 0 01-1 1h-1v5l1 4H6l1-4v-5H6a1 1 0 01-1-1V8a1 1 0 011-1h2V6a4 4 0 014-4z"/></svg>
            Start Rigging <span class="btn-cost-badge">5 cr</span>
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

          <div class="card" style="text-align:center;padding:16px">
            <p style="margin:0 0 12px;font-size:12px;color:#aaa">Apply custom animations from the full library</p>
            <button type="button" id="goToAnimateBtn" class="gen-btn gen-btn--rail" style="width:100%">
              <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              Go to Animate
            </button>
          </div>
        </div>
      `,

      animate: `
        <!-- Selected Model Card -->
        <div class="card" id="animModelCard">
          <h3>Animate Model</h3>
          <div id="animModelInfo" style="display:none">
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
              <img id="animModelThumb" src="" alt="" width="48" height="48" loading="lazy" decoding="async" style="width:48px;height:48px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.05);display:none">
              <div style="flex:1;min-width:0">
                <div id="animModelTitle" style="font-size:13px;font-weight:600;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Rigged Model</div>
                <div id="animModelBadge" style="display:inline-block;margin-top:4px;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;background:rgba(80,200,120,.12);color:#50c878">Rigged model loaded</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" id="animPreviewBtn" class="gen-btn gen-btn--rail" style="flex:1;padding:6px 10px;font-size:11px" title="Preview in viewer">
                <i class="fa-solid fa-eye" style="font-size:10px"></i> Preview
              </button>
              <button type="button" id="animClearBtn" class="gen-btn gen-btn--rail" style="flex:0;padding:6px 10px;font-size:11px;opacity:.7" title="Clear selection">
                <i class="fa-solid fa-xmark" style="font-size:10px"></i>
              </button>
            </div>
          </div>
          <div id="animModelEmpty">
            <p style="font-size:12px;color:#888;margin:0 0 12px;line-height:1.5">No rigged model selected. Choose a source:</p>
            <div style="display:flex;flex-direction:column;gap:6px">
              <button type="button" id="animLoadLatestBtn" class="gen-btn gen-btn--rail" style="width:100%;font-size:12px;padding:8px 12px">
                <i class="fa-solid fa-clock-rotate-left" style="font-size:10px;margin-right:4px"></i> Load Latest Rigged Model
              </button>
              <button type="button" id="animFromHistoryBtn" class="gen-btn gen-btn--rail" style="width:100%;font-size:12px;padding:8px 12px">
                <i class="fa-solid fa-list" style="font-size:10px;margin-right:4px"></i> Choose from History
              </button>
            </div>
          </div>
          <div id="animNotRiggedWarning" style="display:none;margin-top:10px;padding:8px 10px;background:rgba(255,200,50,.08);border-radius:6px;border-left:3px solid rgba(255,200,50,.4);font-size:11px;color:#cca030">
            This model does not appear to contain a rig. Please rig it first.
          </div>
        </div>

        <!-- Quick Animations -->
        <div class="card" id="animQuickSection" style="display:none">
          <h3>Quick Animations</h3>
          <div id="animQuickChips" style="display:flex;gap:6px;flex-wrap:wrap"></div>
        </div>

        <!-- Animation Library -->
        <div class="card" id="animLibrarySection" style="display:none">
          <h3>Animation Library</h3>
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <input type="text" id="animLibrarySearch2" placeholder="Search animations..." style="flex:1;min-width:140px;padding:7px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font-size:12px">
            <select id="animLibraryCategory2" style="padding:7px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font-size:12px">
              <option value="">All Categories</option>
              <option value="DailyActions">Daily Actions</option>
              <option value="WalkAndRun">Walk & Run</option>
              <option value="Dancing">Dancing</option>
              <option value="BodyMovements">Body Movements</option>
              <option value="Fighting">Fighting</option>
            </select>
          </div>
          <div id="animLibraryGrid2" style="max-height:320px;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;padding-right:4px"></div>
          <div id="animLibraryEmpty2" style="display:none;text-align:center;padding:20px;color:#666;font-size:12px">No animations found</div>

          <input type="hidden" id="animActionId2" value="">

          <button type="button" class="remesh-advanced-toggle" id="animAdvancedToggle">
            <span>Advanced Output</span>
            <svg class="remesh-advanced-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="remesh-advanced remesh-advanced--collapsed" id="animAdvanced">
            <div class="inline-field">
              <label for="animPostProcessType">Post-process</label>
              <select id="animPostProcessType">
                <option value="" selected>None</option>
                <option value="change_fps">Change FPS</option>
                <option value="fbx2usdz">Convert FBX to USDZ</option>
                <option value="extract_armature">Extract Armature</option>
              </select>
            </div>
            <div class="inline-field" id="animTargetFpsRow" style="display:none">
              <label for="animTargetFps">Target FPS</label>
              <select id="animTargetFps">
                <option value="24">24</option>
                <option value="25">25</option>
                <option value="30" selected>30</option>
                <option value="60">60</option>
              </select>
            </div>
            <p class="field-hint texture-setting-note" id="animPostProcessNote">Keep the default GLB / FBX animation outputs, or ask Meshy for one extra processed derivative per run.</p>
          </div>

          <div class="gen-footer-card" style="margin-top:12px">
            <div class="gen-meta">
              <span class="gen-time">1 min</span>
              <span class="gen-divider">|</span>
              <span class="gen-credits"><i class="fa-solid fa-coins"></i> 3</span>
            </div>
            <button type="button" id="applyAnimationBtn2" class="gen-btn gen-btn--rail anim-btn-inactive" title="3 credits">
              <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              Apply Animation <span class="btn-cost-badge">3 cr</span>
            </button>
          </div>
        </div>

        <!-- Animation Results -->
        <div id="animResultsSection2" style="display:none">
          <div class="card">
            <h3>Animation Result</h3>
            <div id="animDownloadLinks2" style="display:flex;gap:8px;flex-wrap:wrap"></div>
            <button type="button" id="animReanimateBtn" class="gen-btn gen-btn--rail" style="width:100%;margin-top:10px;font-size:12px">
              <i class="fa-solid fa-rotate" style="font-size:10px;margin-right:4px"></i> Apply Another Animation
            </button>
          </div>
        </div>
      `,

      video: `
      <input type="hidden" id="videoModeValue" value="text2video" />
      <input type="hidden" id="videoAIProvider" value="vertex" />
      <input type="hidden" id="videoMotionPreset" value="" />
      <input type="hidden" id="seedanceTier" value="fast" />
      <!-- PiAPI Seedance 2 "audio" flag. Soundtrack generation is on by default. -->
      <input type="hidden" id="seedanceAudio" value="true" />

      <!-- Main video card: input + settings + templates + gallery -->
      <div class="card video-main-card">

      <!-- Text-to-Video: Prompt input -->
      <div class="video-mode-content video-input-section" id="text2videoContent">
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
      <!-- Image-to-Video: one image strip. The mode follows the image count —
           1 = animate, 2 = first→last frame, 3+ = multi-reference (Seedance).
           This replaces the old Animate / Transition / Morph sub-mode switcher and
           its four separate drop zones, which asked the user to pick a mode before
           they had even chosen their images. -->
      <div class="video-mode-content video-input-section hidden" id="image2videoContent">
        <input type="hidden" id="videoImgModeValue" value="animate_image" />

        <div class="vimg-head">
          <label class="video-section-label" for="videoImageInput">Images</label>
          <span class="vimg-mode-badge" id="vimgModeBadge">Add an image</span>
        </div>

        <div class="vimg-strip" id="videoImageStrip">
          <button type="button" class="vimg-add" id="vimgAddBtn" aria-label="Add image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            <span>Add image</span>
          </button>
          <input type="file" id="videoImageInput" accept="image/jpeg,image/png,image/webp" multiple hidden />
        </div>

        <span class="vimg-hint" id="vimgHint">Drop an image here, or click to browse. JPG, PNG or WEBP.</span>

        <div class="vs-section vs-animation-prompt-section">
          <label for="videoAnimationPrompt" class="vs-label" id="vimgPromptLabel">Motion Prompt</label>
          <textarea id="videoAnimationPrompt" rows="3" placeholder="Describe what should happen in the scene.
Example: The man slowly looks up, wind moves his jacket, subtle cinematic motion."></textarea>
        </div>
      </div>

      <!-- Reference-Guided Video (Seedance omni_reference): image refs public; video/audio gated -->
      <div class="video-mode-content video-input-section hidden" id="referenceVideoContent">
        <div class="ref-intro">
          <strong>Reference-Guided Video</strong> — guide the scene with reference images. Video and audio references are premium beta options.
          Address references in your prompt with <code>@image1</code>, <code>@video1</code>, <code>@audio1</code>.
        </div>

        <div class="ref-upload-grid">
          <div class="ref-upload-col">
            <label class="video-section-label">Images <span class="vs-optional">(refs)</span></label>
            <button type="button" class="ref-add-btn" id="refAddImageBtn">+ Add image</button>
            <input type="file" id="refImageInput" accept="image/png,image/jpeg,image/webp,image/bmp" multiple hidden />
            <div class="ref-chip-list" id="refImageList"></div>
          </div>
          <div class="ref-upload-col">
            <label class="video-section-label">Videos <span class="vs-optional">(refs)</span></label>
            <button type="button" class="ref-add-btn" id="refAddVideoBtn">+ Add video</button>
            <input type="file" id="refVideoInput" accept="video/mp4,video/quicktime" multiple hidden />
            <div class="ref-chip-list" id="refVideoList"></div>
          </div>
          <div class="ref-upload-col">
            <label class="video-section-label">Audio <span class="vs-optional">(refs)</span></label>
            <button type="button" class="ref-add-btn" id="refAddAudioBtn">+ Add audio</button>
            <input type="file" id="refAudioInput" accept="audio/mpeg,audio/wav,audio/x-wav" multiple hidden />
            <div class="ref-chip-list" id="refAudioList"></div>
          </div>
        </div>

        <div class="vs-section" style="margin-top:10px">
          <label for="videoReferencePrompt" class="vs-label">Prompt</label>
          <div class="ref-mention-row" id="refMentionRow"></div>
          <textarea id="videoReferencePrompt" rows="3" placeholder="Describe the video. Insert references with @image1, @video1, @audio1.
Example: Use @image1 as the subject and create a smooth product-style camera move."></textarea>
        </div>

        <div class="ref-cost-warning hidden" id="refCostWarning"></div>
      </div>

      <div class="card-divider"></div>

      <!-- Video Settings -->
      <div class="video-settings-section">
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

      <!-- Compact utility row: Templates + Gallery -->
      <div class="video-utils-row">
        <div class="video-templates-section">
          <button type="button" class="vs-motion-trigger" id="videoTemplatesTrigger">
            <span class="vs-label">Prompt Templates</span>
            <svg class="vs-motion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div id="videoTemplatesPanel" class="vs-presets vs-presets--collapsed"></div>
        </div>
        <button type="button" class="video-gallery-btn video-gallery-btn--compact" id="videoGalleryBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><path d="M10 8l6 4-6 4V8z"/></svg>
          Gallery
        </button>
      </div>

      </div><!-- /video-main-card -->

      <!-- Credit Estimate + Generate Buttons -->
      <div class="card gen-footer-card video-gen-footer">
        <div class="gen-meta">
          <span class="gen-time" id="videoGenTime">~2 min</span>
          <span class="gen-divider">|</span>
          <span class="gen-credits" id="videoCreditsDisplay"><i class="fa-solid fa-coins"></i> 70</span>
        </div>
        <div class="gen-btn-row">
          <button type="button" id="previewVideoBtn" class="gen-btn gen-btn--preview" title="Quick preview (~10 credits)" disabled style="display:none">
            Preview
          </button>
          <button type="button" id="generateVideoBtn" class="gen-btn" title="96 credits" data-base-credits="96" data-video-mode="text2video" data-provider="vertex" disabled>
            <svg class="gen-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            Generate <span class="btn-cost-badge">96 cr</span>
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
      // Reorganise into the sheet's three zones. Runs AFTER binding so that
      // listeners attached above travel with the nodes — this moves elements,
      // it never recreates them, so every id and handler survives.
      organiseSheet(panelType);
      // Update credit badges for newly rendered buttons
      if (window.WorkspaceCredits?.updateButtonCosts) {
        window.WorkspaceCredits.updateButtonCosts();
      }
    }

    /* -------------------------------------------------------------------------
     * SHEET ORGANISER
     * -------------------------------------------------------------------------
     * The panel templates emit one long vertical stack. The sheet needs three
     * zones, and the settings zone needs to be sectioned so that only one group
     * is on screen at a time — otherwise the content is taller than the sheet
     * and everything scrolls, which is what made the old panel hard to read.
     *
     * This walks the rendered output and re-parents it. Nothing is cloned or
     * re-serialised: `appendChild` moves the live node, so the ~300 ids and all
     * the listeners bound a moment ago stay intact.
     * ---------------------------------------------------------------------- */
    function organiseSheet(panelType) {
      if (!leftStack || leftStack.querySelector('.ws-pages')) return;

      const make = (tag, cls) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        return n;
      };

      /* Deterministic assignment. The previous version chunked blocks by field
         count and named panes from whatever label it found first, which could
         produce a page holding no fields at all (rig and animate opened on an
         empty page). Each block is now classified by what it *is*. */
      const PAGES = [
        { key: 'prompt',   title: 'Prompt',   hint: 'What you want to make' },
        { key: 'settings', title: 'Settings', hint: 'How it gets made' },
        { key: 'output',   title: 'Output',   hint: 'Cost, formats and generate' },
      ];

      /* A block is "prompt" if it carries a prompt field or a reference
         upload. The earlier rule also demanded the block hold no <select>,
         which threw the whole image panel onto Settings and left its first
         page blank — imagePrompt lives beside the provider dropdowns. */
      const isPrompt = (el) =>
        el.classList.contains('tab-content') ||
        el.matches('.negative-prompt-field, .video-image-grid, .video-input-section, #multiImageGrid') ||
        // matches() as well as querySelector(): some templates emit the
        // textarea and its <label> as direct children of the card, so after
        // the card is flattened the element IS the block, not its ancestor.
        el.matches('textarea[id*="rompt" i], label[for*="rompt" i], .enhance-row') ||
        !!el.querySelector('textarea[id*="rompt" i], label[for*="rompt" i]') ||
        el.matches('.video-drop-zone, .drop-zone') ||
        !!el.querySelector('.video-drop-zone, .drop-zone, input[type="file"]');

      /* The commit control is identified by id, not by class. rig and animate
         have no .gen-footer-card and mark EVERY button .gen-btn--rail, so both
         class-based rules were wrong: one dragged inline "remesh this first"
         CTAs onto Output, the other left the real Generate on Settings.
         These seven ids are the set main.js delegates on. */
      const COMMIT_IDS = ['generateModelBtn', 'generateImageBtn', 'generateVideoBtn',
                          'applyRemeshBtn', 'generateTextureBtn', 'startRigBtn',
                          'applyAnimationBtn2'];
      const commitSel = COMMIT_IDS.map((i) => '#' + i).join(',');

      const isOutput = (el) =>
        el.classList.contains('gen-footer-card') ||
        el.matches('.video-utils-row, .video-templates-section, .texture-format-group') ||
        !!el.querySelector(commitSel + ', .texture-format-grid') ||
        COMMIT_IDS.includes(el.id);

      // Flatten wrappers that exist only to group (cards, the video body).
      const expand = (el) =>
        (el.classList.contains('card') && !el.classList.contains('gen-footer-card')) ||
        el.classList.contains('video-main-card')
          ? Array.from(el.children).flatMap(expand)
          : [el];

      const bucket = { prompt: [], settings: [], output: [] };
      let modeStrip = null;

      Array.from(leftStack.children).flatMap(expand).forEach((el) => {
        if (el.querySelector && el.querySelector('.tab-btn') && !el.classList.contains('tab-content')) {
          el.classList.add('ws-modes');
          modeStrip = el;
          return;
        }
        if (el.classList.contains('card-divider')) { el.remove(); return; }
        if (el.tagName === 'DETAILS') {
          // Advanced blocks are settings; unwrap so they are not double-nested.
          Array.from(el.children)
            .filter((n) => n.tagName !== 'SUMMARY')
            .forEach((n) => bucket.settings.push(n));
          el.remove();
          return;
        }
        if (isOutput(el))  { bucket.output.push(el);  return; }
        if (isPrompt(el))  { bucket.prompt.push(el);  return; }
        bucket.settings.push(el);
      });

      /* Templates emit <label for="x"> and #x as separate siblings. In a
         two-column grid that puts the label in one cell and its control in the
         next, or forces the label full-width and leaves a hole beside the
         control. Bind each pair into one block so the grid can lay out real
         fields instead of loose fragments. */
      Object.keys(bucket).forEach((key) => {
        const out = [];
        for (let i = 0; i < bucket[key].length; i++) {
          const node = bucket[key][i];
          const forId = node.tagName === 'LABEL' && node.getAttribute('for');
          const next = bucket[key][i + 1];
          if (forId && next && next.id === forId) {
            const pair = document.createElement('div');
            pair.className = 'ws-field';
            pair.appendChild(node);
            pair.appendChild(next);
            // a trailing hint belongs to the same field
            const after = bucket[key][i + 2];
            if (after && after.classList?.contains('field-hint')) { pair.appendChild(after); i++; }
            out.push(pair);
            i++;
            continue;
          }
          out.push(node);
        }
        bucket[key] = out;
      });

      Array.from(leftStack.children).forEach((c) => c.remove());

      /* Drop pages with nothing in them rather than showing a blank step:
         remesh, rig and animate have no prompt at all — they act on a model
         that already exists — so they run as a two-step flow. */
      const live = PAGES.filter((pg) => bucket[pg.key].length || (pg.key === 'prompt' && modeStrip));
      if (live[0] && live[0].key === 'prompt' &&
          !bucket.prompt.some((n) =>
            n.matches?.('textarea[id*="rompt" i]') || n.querySelector?.('textarea[id*="rompt" i]'))) {
        live[0] = { key: 'prompt', title: 'Source', hint: 'What this runs on' };
      }

      const shell = make('div', 'ws-pages');
      const track = make('div', 'ws-pages__track');

      live.forEach((page, i) => {
        const sec = make('section', 'ws-page' + (i === 0 ? ' is-active' : ''));
        sec.dataset.page = page.key;
        sec.setAttribute('role', 'tabpanel');
        sec.setAttribute('aria-label', page.title);

        const head = make('div', 'ws-page__head');
        const h = make('h3', 'ws-page__title'); h.textContent = page.title;
        const sub = make('p', 'ws-page__hint'); sub.textContent = page.hint;
        head.appendChild(h); head.appendChild(sub);
        sec.appendChild(head);

        if (page.key === 'prompt' && modeStrip) sec.appendChild(modeStrip);

        const body = make('div', 'ws-page__body');
        bucket[page.key].forEach((n) => body.appendChild(n));
        // Sparseness is decided here, not in CSS: the natural selector would be
        // .ws-page:has(.ws-page__body:not(:has(> :nth-child(3)))), but :has()
        // cannot be nested inside :has(), so that rule parses as invalid and is
        // dropped silently. A class is unambiguous.
        if (bucket[page.key].length < 3) sec.classList.add('ws-page--sparse');

        sec.appendChild(body);
        track.appendChild(sec);
      });

      shell.appendChild(track);
      shell.appendChild(buildPager(shell, live));
      leftStack.appendChild(shell);
    }

    /** Footer navigation: Back · dots · Next, with the last step committing. */
    function buildPager(shell, PAGES) {
      const nav = document.createElement('div');
      nav.className = 'ws-pager';

      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'ws-pager__btn ws-pager__btn--back';
      back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg><span>Back</span>';

      const dots = document.createElement('div');
      dots.className = 'ws-pager__dots';
      dots.setAttribute('role', 'tablist');

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'ws-pager__btn ws-pager__btn--next';
      next.innerHTML = '<span>Next</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

      let index = 0;
      const pages = () => Array.from(shell.querySelectorAll('.ws-page'));

      function go(i) {
        const list = pages();
        index = Math.max(0, Math.min(list.length - 1, i));
        list.forEach((s, n) => s.classList.toggle('is-active', n === index));
        Array.from(dots.children).forEach((d, n) => {
          d.classList.toggle('is-active', n === index);
          d.setAttribute('aria-selected', n === index ? 'true' : 'false');
        });
        back.disabled = index === 0;
        next.disabled = index === list.length - 1;
        nav.dataset.step = String(index + 1);
      }

      PAGES.forEach((page, i) => {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'ws-pager__dot' + (i === 0 ? ' is-active' : '');
        d.setAttribute('role', 'tab');
        d.setAttribute('aria-label', page.title);
        d.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        d.innerHTML = '<span>' + page.title + '</span>';
        d.addEventListener('click', () => go(i));
        dots.appendChild(d);
      });

      back.addEventListener('click', () => go(index - 1));
      next.addEventListener('click', () => go(index + 1));

      nav.appendChild(back);
      nav.appendChild(dots);
      nav.appendChild(next);
      go(0);
      return nav;
    }

    /* -------------------------------------------------------------------------
     * THREE.JS VIEWER: bootstrap + resize (lazy)
     * Exposes window.timrx3D = { scene, camera, renderer, resize }
     * ---------------------------------------------------------------------- */
    /**
     * Ensures the Three.js viewer exists and is properly sized.
     */
    function requestThreeViewerLoad() {
      if (window.THREE) return Promise.resolve(window.THREE);
      if (typeof window.loadTimrxThree === 'function') return window.loadTimrxThree();
      return Promise.resolve(null);
    }

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

      if (window.THREE) {
        bootThreeViewer();
        return;
      }
      window.addEventListener('three-ready', bootThreeViewer, { once: true });
      requestThreeViewerLoad().catch((err) => {
        console.warn('[Viewer] Failed to lazy-load Three.js:', err);
        showWebGLFallback();
      });
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
      scene.background = new THREE.Color(0x1a1a1e);

      const camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, 0.1, 1000);
      camera.position.set(3.5, 2.0, 5.0);

      function getViewerSceneProfile(r) {
        const width = Math.max(r.width || 0, 1);
        const height = Math.max(r.height || 0, 1);
        const aspect = width / height;
        const isShortLandscape = height <= 640 && width >= 900;
        const isTabletLandscape = width >= 1024 && height <= 800;
        const scaleBoost = isShortLandscape ? 1.42 : isTabletLandscape ? 1.28 : width >= 1280 ? 1.2 : width >= 1024 ? 1.12 : 1;
        const cameraFov = isShortLandscape ? 34 : isTabletLandscape ? 36 : 38;
        const cameraPosition = isShortLandscape
          ? [2.8, 1.6, 3.8]
          : isTabletLandscape
            ? [3.2, 1.8, 4.2]
            : aspect > 1.8
              ? [3.4, 1.9, 4.6]
              : [3.5, 2.0, 5.0];

        return { scaleBoost, cameraFov, cameraPosition };
      }

      function applyViewerSceneProfile(r) {
        const profile = getViewerSceneProfile(r);
        camera.fov = profile.cameraFov;
        camera.position.set(...profile.cameraPosition);
        camera.lookAt(0, 0.2, 0);

        if (grid) {
          grid.scale.setScalar(profile.scaleBoost);
          grid.position.y = -0.5;
        }

        if (placeholderCube) {
          placeholderCube.scale.setScalar(profile.scaleBoost);
          placeholderCube.position.y = 0.1 + ((profile.scaleBoost - 1) * 0.12);
        }
      }

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
      renderer.toneMappingExposure = 1.15;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      // Expose renderer globally for grouped viewer
      window.timrxRenderer = renderer;

      const grid = new THREE.GridHelper(10, 10, 0xffffff, 0xffffff);
      grid.position.y = -0.5;
      grid.material.opacity = 0.18;
      grid.material.transparent = true;
      grid.isGridHelper = true;
      grid.userData.keepAlive = true;
      scene.add(grid);

      // Ambient light for base illumination
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
      ambientLight.userData.keepAlive = true;
      scene.add(ambientLight);

      // Hemisphere light (sky/ground) for natural fill
      const hemiLight = new THREE.HemisphereLight(0xffffff, 0x666666, 0.9);
      hemiLight.userData.keepAlive = true;
      scene.add(hemiLight);

      // Key light (main light source — warm-neutral)
      const keyLight = new THREE.DirectionalLight(0xfff5e6, 2.0);
      keyLight.position.set(5, 10, 6);
      keyLight.castShadow = false;
      keyLight.userData.keepAlive = true;
      scene.add(keyLight);

      // Fill light (softens shadows from front-left)
      const fillLight = new THREE.DirectionalLight(0xffffff, 1.0);
      fillLight.position.set(-4, 4, 6);
      fillLight.userData.keepAlive = true;
      scene.add(fillLight);

      // Rim/back light (creates edge definition — cool blue)
      const rimLight = new THREE.DirectionalLight(0x9ec5e6, 0.7);
      rimLight.position.set(-3, 6, -6);
      rimLight.userData.keepAlive = true;
      scene.add(rimLight);

      // Bottom fill light (subtle — illuminates underside)
      const bottomLight = new THREE.DirectionalLight(0xffffff, 0.4);
      bottomLight.position.set(0, -4, 2);
      bottomLight.userData.keepAlive = true;
      scene.add(bottomLight);

      // Placeholder: Rubik's Cube style 3x3x3 grid
      placeholderCube = new THREE.Group();
      placeholderCube.userData.isPlaceholder = true;
      placeholderCube.userData.keepAlive = true;

      const cubeSize = 0.28;
      const gap = 0.03;
      const step = cubeSize + gap;
      const offset = -step; // center the 3x3x3 grid

      const rubikColors = [
        0xe84040, // red
        0xf5a623, // orange
        0x2d8cf0, // blue
        0x4caf50, // green
        0xf5df4d, // yellow
        0xffffff, // white
      ];

      for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
          for (let z = 0; z < 3; z++) {
            const geo = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
            const materials = [
              new THREE.MeshStandardMaterial({ color: x === 2 ? rubikColors[0] : 0x111111, roughness: 0.4, metalness: 0.1 }), // +X red
              new THREE.MeshStandardMaterial({ color: x === 0 ? rubikColors[1] : 0x111111, roughness: 0.4, metalness: 0.1 }), // -X orange
              new THREE.MeshStandardMaterial({ color: y === 2 ? rubikColors[5] : 0x111111, roughness: 0.4, metalness: 0.1 }), // +Y white
              new THREE.MeshStandardMaterial({ color: y === 0 ? rubikColors[4] : 0x111111, roughness: 0.4, metalness: 0.1 }), // -Y yellow
              new THREE.MeshStandardMaterial({ color: z === 2 ? rubikColors[2] : 0x111111, roughness: 0.4, metalness: 0.1 }), // +Z blue
              new THREE.MeshStandardMaterial({ color: z === 0 ? rubikColors[3] : 0x111111, roughness: 0.4, metalness: 0.1 }), // -Z green
            ];
            const mini = new THREE.Mesh(geo, materials);
            mini.position.set(
              offset + x * step,
              offset + y * step,
              offset + z * step
            );
            placeholderCube.add(mini);
          }
        }
      }

      placeholderCube.position.y = 0.1;
      scene.add(placeholderCube);
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
        applyViewerSceneProfile(r);
        camera.aspect = r.width / r.height;
        camera.updateProjectionMatrix();
        renderer.setSize(r.width, r.height, false);
        if (window.timrxControls) {
          window.timrxControls.target.set(0, 0.2, 0);
          window.timrxControls.update();
        }
        if (window.GroupedViewer) window.GroupedViewer.resize();
      }
      applyViewerSceneProfile(rect);
      window.addEventListener('resize', onResize);

      /**
       * Renders the scene on every animation frame.
       */
      function animate() {
        requestAnimationFrame(animate);
        // Skip main render loop when grouped viewer is handling rendering
        if (window.GroupedViewer && window.GroupedViewer.isActive()) {
          return;
        }
        if (rotationState.enabled && placeholderCube && placeholderCube.visible) {
          placeholderCube.rotation.y += rotationState.speed;
        }
        // Update animation mixer for rigged/animated models
        if (window._timrxMixer && window._timrxClock) {
          window._timrxMixer.update(window._timrxClock.getDelta());
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
        // model / remesh / texture / rig / animate use the 3D viewer
        model3dWrap.classList.remove('hidden');
        if (panelType === 'rig') {
          viewerTitle.textContent = 'Rig Preview';
          genHint.textContent = 'Your rigged model will appear here.';
        } else if (panelType === 'animate') {
          viewerTitle.textContent = 'Animation Preview';
          genHint.textContent = 'Your animated model will appear here.';
        } else {
          viewerTitle.textContent = '3D Preview';
          genHint.textContent = 'Your 3D model will appear here.';
        }
        ensureThreeViewer();              // ensure canvas has a real size & renderer exists
        setTimeout(ensureThreeViewer, 0); // safety after layout paint
      }
    }

    /**
     * Loads a GLB/GLTF/STL model into the viewer, re-centers it, and fits the camera.
     * @param {File} file - The uploaded model file.
     * @param {string} modelName - Friendly name shown in logs.
     */
    function load3DModel(file, modelName) {
      // Guard: Check WebGL availability first
      if (!webglAvailable) {
        console.warn('[Viewer] Cannot load model: WebGL not available');
        return Promise.reject(new Error('WebGL not available'));
      }

      ensureThreeViewer();

      // Create a blob URL from the local file and load it through the
      // proper viewer module (viewer.js). This ensures correct camera
      // fitting, placeholder hiding, animation playback, and model
      // tracking — all of which the old inline GLTFLoader.parse path skipped.
      const blobUrl = URL.createObjectURL(file);

      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      const loadViaViewer = ext === '.stl'
        ? window.TimrXViewer?.loadStlFromUrl
        : (window.TimrXViewer?.loadGlbFromUrl || window.loadGlbFromUrl);
      if (!loadViaViewer) {
        console.error('[Viewer] No viewer load function available');
        URL.revokeObjectURL(blobUrl);
        return Promise.reject(new Error('No viewer load function available'));
      }

      if (genHint) genHint.textContent = 'Loading model...';

      return Promise.resolve(loadViaViewer(blobUrl))
        .then(() => {
          const openedTitle = modelName || file.name;
          window._timrxViewerUploadSource = {
            kind: 'upload',
            title: openedTitle,
            fileName: file.name,
            format: ext.replace('.', ''),
          };
          if (viewerTitle) viewerTitle.textContent = openedTitle;
          if (genHint) genHint.textContent = `Loaded: ${openedTitle}`;
          const modelViewer = document.getElementById('model3dViewer');
          if (modelViewer) {
            let info = modelViewer.querySelector('.af-viewer-info');
            if (!info) {
              info = document.createElement('div');
              info.className = 'af-viewer-info';
              modelViewer.appendChild(info);
            }
            info.textContent = '';
            const type = document.createElement('span');
            type.className = 'af-viewer-info__type';
            type.textContent = 'Uploaded model';
            const title = document.createElement('strong');
            title.textContent = openedTitle;
            const detail = document.createElement('p');
            detail.textContent = `${ext.replace('.', '').toUpperCase()} file opened in the 3D viewer.`;
            info.append(type, title, detail);
          }
          console.log('[Viewer] Local model loaded:', openedTitle);
        })
        .catch((err) => {
          console.error('[Viewer] Error loading local model:', err);
          if (genHint) genHint.textContent = 'Failed to load model. Check the file and try again.';
          if (typeof window.showToast === 'function') {
            window.showToast('Failed to load model. Please check the file format and try again.', 'error');
          }
          throw err;
        })
        .finally(() => {
          URL.revokeObjectURL(blobUrl);
        });
    }

    /**
     * Wires up the tab controls and upload helpers within the left stack.
     */
    function initPanelInteractions() {
      // Tabs for model → (Text to 3D / Image to 3D)
      const tabButtons  = leftStack.querySelectorAll('.tab-btn');
      const tabContents = leftStack.querySelectorAll('.tab-content');
      const getActiveModelTab = () => leftStack.querySelector('.tab-content.active')?.id || 'text3d';
      const getModelGenerationCost = () => {
        const activeTab = getActiveModelTab();
        const isImageFlow = activeTab === 'image3d' || activeTab === 'multiimage3d';
        if (!isImageFlow) return 20;
        let cost = 30;
        if ((leftStack.querySelector('#modelTextureResolution')?.value || '2k').toLowerCase() === '8k') {
          cost += 5;
        }
        if (activeTab === 'image3d' && leftStack.querySelector('#modelUltraMode')?.checked) {
          cost += 5;
        }
        return cost;
      };
      const syncModelGenerationControls = () => {
        const activeTab = getActiveModelTab();
        const isTextFlow = activeTab === 'text3d';
        const isSingleImageFlow = activeTab === 'image3d';
        const isImageFlow = activeTab === 'image3d' || activeTab === 'multiimage3d';
        const aiModel = leftStack.querySelector('#modelAIModel');
        const modelType = leftStack.querySelector('#modelModelType');
        const textureResolution = leftStack.querySelector('#modelTextureResolution');
        const ultraMode = leftStack.querySelector('#modelUltraMode');
        const multiViewThumbnails = leftStack.querySelector('#modelMultiViewThumbnails');
        const alphaThumbnail = leftStack.querySelector('#modelAlphaThumbnail');
        const modelCredits = leftStack.querySelector('#modelCreditsDisplay');
        const generateBtn = leftStack.querySelector('#generateModelBtn');
        const smartTopology = isSingleImageFlow && (modelType?.value || '').toLowerCase() === 'smart-topology';

        if (modelType && !isSingleImageFlow && modelType.value === 'smart-topology') {
          modelType.value = 'standard';
        }

        if (aiModel) {
          const smartOptions = new Set(['meshy-t1', 'meshy-t2']);
          aiModel.querySelectorAll('option').forEach((option) => {
            if (option.value === 'meshy-7') option.disabled = isTextFlow;
            if (smartOptions.has(option.value)) option.disabled = !smartTopology;
            if (!smartOptions.has(option.value) && smartTopology) option.disabled = true;
          });
          if (smartTopology && !smartOptions.has(aiModel.value)) aiModel.value = 'meshy-t2';
          if (!smartTopology && smartOptions.has(aiModel.value)) aiModel.value = 'latest';
          if (isTextFlow && aiModel.value === 'meshy-7') aiModel.value = 'latest';
        }

        const modelValue = aiModel?.value || 'latest';
        const isMeshy5 = modelValue === 'meshy-5';
        if (textureResolution) {
          textureResolution.querySelectorAll('option').forEach((option) => {
            option.disabled = isMeshy5 && (option.value === '4k' || option.value === '8k');
          });
          if (isMeshy5 && (textureResolution.value === '4k' || textureResolution.value === '8k')) {
            textureResolution.value = '2k';
          }
          textureResolution.disabled = isTextFlow;
        }

        // Meshy documents ultra_mode for Image-to-3D with ai_model meshy-7/latest
        // and standard geometry only — low-poly and smart-topology do not take it.
        const modelTypeValue = (modelType?.value || '').toLowerCase();
        const isStandardGeometry = modelTypeValue === '' || modelTypeValue === 'standard';
        const supportsUltra = isSingleImageFlow && isStandardGeometry && ['latest', 'meshy-7'].includes(modelValue);
        if (ultraMode) {
          ultraMode.disabled = !supportsUltra;
          if (!supportsUltra) ultraMode.checked = false;
        }

        // Text-to-3D always sends moderation: true, so the toggle must not
        // pretend otherwise. Image flows still honour the user's choice, which
        // is parked while the text tab forces the switch on.
        const moderation = leftStack.querySelector('#modelModeration');
        if (moderation) {
          if (isTextFlow) {
            if (!moderation.disabled) moderation.dataset.userChoice = moderation.checked ? '1' : '0';
            moderation.checked = true;
            moderation.disabled = true;
            moderation.title = 'Always on for Text-to-3D';
          } else {
            if (moderation.disabled && moderation.dataset.userChoice !== undefined) {
              moderation.checked = moderation.dataset.userChoice === '1';
            }
            moderation.disabled = false;
            moderation.title = '';
          }
        }
        if (multiViewThumbnails) {
          multiViewThumbnails.disabled = !isImageFlow;
          if (!isImageFlow) multiViewThumbnails.checked = false;
        }
        if (alphaThumbnail) alphaThumbnail.disabled = false;

        const cost = getModelGenerationCost();
        if (modelCredits) modelCredits.innerHTML = `<i class="fa-solid fa-coins"></i> ${cost}`;
        if (generateBtn) {
          generateBtn.title = `${cost} credits`;
          const costBadge = generateBtn.querySelector('.btn-cost-badge');
          if (costBadge) costBadge.textContent = `${cost} cr`;
          generateBtn.dataset.currentAction = isImageFlow ? 'image-to-3d' : 'text-to-3d';
        }

        if (window.WorkspaceCredits?.updateButtonCosts) {
          window.WorkspaceCredits.updateButtonCosts();
        }
      };

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

          syncModelGenerationControls();
        });
      });

      // Image-to-3D: upload & preview
      const modelImageDrop   = leftStack.querySelector('#modelImageDrop');
      const modelImageUpload = leftStack.querySelector('#modelImageUpload');
      const modelImagePreview= leftStack.querySelector('#modelImagePreview');

      if (modelImageDrop && modelImageUpload && modelImagePreview) {
        modelImageDrop.addEventListener('click', () => modelImageUpload.click());
        modelImageUpload.addEventListener('change', async function () {
          if (this.files && this.files[0]) {
            try {
              modelImagePreview.src = await readFileAsDataUrl(this.files[0]);
            } catch (err) {
              console.warn('[Image Upload] Invalid source image:', err);
              this.value = '';
              modelImagePreview.src = '';
              showImageUploadError(err?.message || 'Invalid image file.');
            }
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
        const updateMultiImageCount = () => {
          const count = multiImageGrid.querySelectorAll('.multi-img-preview[style*="display: block"], .multi-img-preview[style*="display:block"]').length;
          const countEl = leftStack.querySelector('#multiImageCount');
          if (countEl) countEl.textContent = `${count} / 4 images selected`;
        };
        slots.forEach(slot => {
          const dropZone = slot.querySelector('.video-drop-zone');
          const fileInput = slot.querySelector('.multi-img-input');
          const preview = slot.querySelector('.multi-img-preview');

          if (dropZone && fileInput && preview) {
            dropZone.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', async function () {
              if (this.files && this.files[0]) {
                try {
                  preview.src = await readFileAsDataUrl(this.files[0]);
                  preview.style.display = 'block';
                  dropZone.style.display = 'none';
                  updateMultiImageCount();
                } catch (err) {
                  console.warn('[Image Upload] Invalid multi-image slot file:', err);
                  this.value = '';
                  preview.style.display = 'none';
                  preview.src = '';
                  dropZone.style.display = '';
                  updateMultiImageCount();
                  showImageUploadError(err?.message || 'Invalid image file.');
                }
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
              updateMultiImageCount();
            });
          }
        });
      }

      // Video: image upload & preview
      // ── Unified image references ────────────────────────────────────────
      // One list drives every image mode. Downstream code still reads
      // #videoImgModeValue, which we derive from the image count:
      //   1 image  -> animate_image
      //   2 images -> image_transition (first frame -> last frame)
      //   3+       -> reference_images (Seedance only)
      // Images are downscaled in the browser before upload: a 12MP phone photo is
      // ~8MB as a data URL, and nine of those would blow past the request limit
      // long before the provider ever saw them.
      const VIMG_MAX_EDGE = 2048;
      const VIMG_JPEG_QUALITY = 0.9;
      const videoImageRefs = [];
      window.VideoImageRefs = videoImageRefs;

      function vimgProviderMax() {
        // Reads the DOM rather than closing over `videoAIProvider` /
        // `videoReferencePolicy`: those are `const`s declared further down this
        // scope, so touching them from a listener that fires early would hit the
        // temporal dead zone.
        const provider = leftStack.querySelector('#videoAIProvider')?.value || 'vertex';
        // Only Seedance takes more than a first/last pair.
        if (provider !== 'seedance') return 2;
        const limits = (typeof videoReferencePolicy !== 'undefined' && videoReferencePolicy?.limits)
          ? videoReferencePolicy.limits
          : null;
        return Math.max(2, (limits && limits.max_image_refs) || 6);
      }

      function vimgDeriveMode() {
        if (videoImageRefs.length >= 3) return 'reference_images';
        if (videoImageRefs.length === 2) return 'image_transition';
        return 'animate_image';
      }

      // Downscale + re-encode in a canvas. Keeps PNG for images with alpha so we
      // don't flatten transparency to black.
      function vimgProcessFile(file) {
        return new Promise((resolve, reject) => {
          if (!file || !String(file.type || '').toLowerCase().startsWith('image/')) {
            reject(new Error('Please choose an image file.'));
            return;
          }
          const objectUrl = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            try {
              const scale = Math.min(1, VIMG_MAX_EDGE / Math.max(img.width, img.height));
              const w = Math.max(1, Math.round(img.width * scale));
              const h = Math.max(1, Math.round(img.height * scale));
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, w, h);
              const keepAlpha = /png|webp/i.test(file.type);
              const dataUrl = keepAlpha
                ? canvas.toDataURL('image/png')
                : canvas.toDataURL('image/jpeg', VIMG_JPEG_QUALITY);
              resolve({ dataUrl, name: file.name || 'image', width: w, height: h });
            } catch (err) {
              reject(new Error('That image could not be processed.'));
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Invalid image file. Use JPG, PNG or WEBP.'));
          };
          img.src = objectUrl;
        });
      }

      function vimgRender() {
        const strip = leftStack.querySelector('#videoImageStrip');
        const addBtn = leftStack.querySelector('#vimgAddBtn');
        const badge = leftStack.querySelector('#vimgModeBadge');
        const hint = leftStack.querySelector('#vimgHint');
        const promptLabel = leftStack.querySelector('#vimgPromptLabel');
        if (!strip || !addBtn) return;

        strip.querySelectorAll('.vimg-item').forEach(el => el.remove());

        const max = vimgProviderMax();
        const mode = vimgDeriveMode();
        const modeValue = leftStack.querySelector('#videoImgModeValue');
        if (modeValue) modeValue.value = mode;

        videoImageRefs.forEach((ref, i) => {
          const item = document.createElement('div');
          item.className = 'vimg-item';
          let roleLabel = '';
          if (videoImageRefs.length === 2) roleLabel = i === 0 ? 'First frame' : 'Last frame';
          else if (videoImageRefs.length >= 3) roleLabel = '@image' + (i + 1);
          item.innerHTML =
            '<img src="' + ref.dataUrl + '" alt="" />' +
            (roleLabel ? '<span class="vimg-role">' + roleLabel + '</span>' : '') +
            '<button type="button" class="vimg-remove" data-idx="' + i + '" aria-label="Remove image">&times;</button>';
          strip.insertBefore(item, addBtn);
        });

        addBtn.classList.toggle('hidden', videoImageRefs.length >= max);

        const n = videoImageRefs.length;
        if (badge) {
          badge.textContent =
            n === 0 ? 'Add an image' :
            n === 1 ? 'Animate one image' :
            n === 2 ? 'First → last frame' :
            n + ' references';
        }
        if (hint) {
          hint.textContent =
            n === 0 ? 'Drop an image here, or click to browse. JPG, PNG or WEBP.' :
            n === 1 ? (max > 2
                        ? 'Add a second image to morph between two frames, or more to guide the scene.'
                        : 'Add a second image to create a first-to-last frame transition.') :
            n === 2 ? 'The video starts on the first image and ends on the second.' :
                      'Reference these in your prompt with @image1, @image2, …';
        }
        if (promptLabel) {
          promptLabel.textContent =
            n === 2 ? 'Transition Prompt' : n >= 3 ? 'Scene Prompt' : 'Motion Prompt';
        }

        if (typeof validateVideoForm === 'function') validateVideoForm();
        if (typeof updateVideoFooter === 'function') updateVideoFooter();
      }
      window.VideoImageRefs.render = vimgRender;

      async function vimgAddFiles(fileList) {
        const files = Array.from(fileList || []);
        const max = vimgProviderMax();
        for (const file of files) {
          if (videoImageRefs.length >= max) {
            showImageUploadError(
              max === 2
                ? 'This engine takes at most 2 images (a first and last frame).'
                : 'You can add up to ' + max + ' images.'
            );
            break;
          }
          try {
            videoImageRefs.push(await vimgProcessFile(file));
          } catch (err) {
            showImageUploadError(err?.message || 'Invalid image file.');
          }
        }
        vimgRender();
      }

      (function wireImageStrip() {
        const strip = leftStack.querySelector('#videoImageStrip');
        const addBtn = leftStack.querySelector('#vimgAddBtn');
        const input = leftStack.querySelector('#videoImageInput');
        if (!strip || !addBtn || !input) return;

        addBtn.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { vimgAddFiles(input.files); input.value = ''; });

        strip.addEventListener('click', (e) => {
          const rm = e.target.closest('.vimg-remove');
          if (!rm) return;
          const idx = parseInt(rm.dataset.idx, 10);
          if (idx >= 0) { videoImageRefs.splice(idx, 1); vimgRender(); }
        });

        ['dragenter', 'dragover'].forEach(ev =>
          strip.addEventListener(ev, (e) => { e.preventDefault(); strip.classList.add('is-drop'); }));
        ['dragleave', 'drop'].forEach(ev =>
          strip.addEventListener(ev, () => strip.classList.remove('is-drop')));
        strip.addEventListener('drop', (e) => {
          e.preventDefault();
          if (e.dataTransfer?.files?.length) vimgAddFiles(e.dataTransfer.files);
        });
      })();

      // One prompt box now serves every image mode; its label changes with the
      // image count (Motion / Transition / Scene).
      const animPromptEl = leftStack.querySelector('#videoAnimationPrompt');
      if (animPromptEl) {
        animPromptEl.addEventListener('input', validateVideoForm);
      }

      // ========================================
      // VIDEO: Mode Switching & Credits Logic
      // ========================================
      const videoModeSwitcher = document.getElementById('videoModeSwitcher');
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

      document.querySelectorAll('#videoModeSwitcher .video-mode-btn').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.mode === (videoModeValue?.value || 'text2video'));
      });
      document.querySelectorAll('#videoProviderSwitcher .video-provider-btn').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.provider === (videoAIProvider?.value || 'vertex'));
      });

      // ========================================
      // VIDEO: Pricing Constants (Veo only - resolution + duration based)
      // ========================================
      // Fallback credits by resolution and duration (used if backend unavailable)
      // Actual costs are fetched from backend via WorkspaceCredits
      // Mapping: Standard (HD) = 720p, Pro (Full HD) = 1080p
      // Vertex Veo 3.1: 12 c/s (margin-stabilized). All modes equalized.
      const VIDEO_CREDIT_RULES_FALLBACK = {
        '720p':  { 4: 48, 6: 72, 8: 96 },    // Standard (HD) — 12 c/s
        '1080p': { 8: 120 },                  // Pro (Full HD) - requires 8s
        '4k':    { 8: 156 }                   // Ultra (4K) - requires 8s
      };

      // Image-to-Video fallback costs — EQUALIZED with text-to-video (no premium)
      const VIDEO_IMAGE_CREDIT_RULES_FALLBACK = {
        '720p':  { 4: 48, 6: 72, 8: 96 },
        '1080p': { 8: 120 },
        '4k':    { 8: 156 }
      };
      // Seedance 2 GA credit costs — explicit lookup (DB is authoritative).
      // Mini = cheapest / fastest (480p, 720p). Fast = drafts / social (480p, 720p).
      // Quality = cinematic (adds 1080p premium).
      // Must mirror backend pricing_service.SEEDANCE_CREDIT_COSTS and migrations 068/076.
      const SEEDANCE_COSTS = {
        // Seedance 2.5 (PiAPI `seedance-2.5`) — a newer model, not a 2.0 speed tier.
        // PiAPI cut the list price ~50% at GA (Aug 2026): $0.15/s 480p, $0.35/s 720p.
        // Same 120 credits-per-$/s ratio, so credits halved with it (migration 081).
        v25: {
          '480p': { 5: 90,  10: 180, 15: 270, 20: 360, 25: 450, 30: 540 },
          '720p': { 5: 210, 10: 420, 15: 630, 20: 840, 25: 1050, 30: 1260 },
        },
        // PiAPI seedance-2-mini is 12.5% cheaper upstream than Fast at every
        // resolution, so Mini is priced at 87.5% of Fast. No 1080p on this tier.
        mini: {
          '480p': { 5: 70,  10: 140, 15: 210 },
          '720p': { 5: 105, 10: 210, 15: 315 },
        },
        fast: {
          '480p': { 5: 80,  10: 160, 15: 240 },
          '720p': { 5: 120, 10: 240, 15: 360 },
        },
        quality: {
          '480p': { 5: 100, 10: 200, 15: 300 },
          '720p': { 5: 160, 10: 320, 15: 480 },
          // 1080p bumped 20% (migration 069) to protect net margin vs PiAPI's $0.50/s cost.
          '1080p': { 5: 300, 10: 600, 15: 900 },
        },
      };
      // Approximate CPS at 480p baseline — used only when no exact match (DB authoritative).
      const SEEDANCE_CPS = { mini: 14, fast: 16, quality: 20, v25: 18 };
      // Per-tier allowed resolutions (UI must not present invalid combos like Fast 1080p).
      const SEEDANCE_RESOLUTIONS = {
        mini:    ['480p', '720p'],
        fast:    ['480p', '720p'],
        quality: ['480p', '720p', '1080p'],
        v25:     ['480p', '720p'],
      };
      // PiAPI's own per-tier default resolution — Mini defaults to 720p, not 480p.
      const SEEDANCE_DEFAULT_RESOLUTION = { mini: '720p', fast: '480p', quality: '480p', v25: '720p' };
      // Canonical tier → PiAPI task_type. The backend re-derives this, but sending it
      // keeps the request self-describing and matches what the API logs show.
      const SEEDANCE_TASK_TYPES = {
        mini:    'seedance-2-mini',
        fast:    'seedance-2-fast',
        quality: 'seedance-2',
        v25:     'seedance-2.5',
      };
      // PiAPI caps the prompt at 4000 characters across every Seedance task type.
      const SEEDANCE_MAX_PROMPT_CHARS = 4000;
      const DEFAULT_REFERENCE_POLICY = {
        tier: 'public',
        image_refs: true,
        video_refs: false,
        audio_refs: false,
        quality_1080p: false,
        audio_output: true,
        limits: {
          // PiAPI accepts at most 9 combined references in omni_reference mode.
          max_total_refs: 8,
          max_image_refs: 6,
          max_video_refs: 2,
          max_audio_refs: 1,
          max_image_mb: 10,
          max_video_mb: 30,
          max_audio_mb: 15,
          max_total_upload_mb: 75,
          max_input_video_seconds: 15.4,
          max_audio_seconds: 15,
          input_retention_hours: 24,
          failed_input_retention_hours: 6,
        },
      };
      let videoReferencePolicy = { ...DEFAULT_REFERENCE_POLICY, limits: { ...DEFAULT_REFERENCE_POLICY.limits } };
      // fal Seedance 1.5 Pro — BUDGET tier (8–9 c/s)
      const FAL_SEEDANCE_COSTS = { 5: 45, 10: 80, 12: 95 };
      const FAL_SEEDANCE_CPS = 8;
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
          label: 'Cinematic',
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
          showStyle: 'text2video',  // style only affects text-to-video (backend prompt enrichment)
          styleLabel: 'Style Preset',
          showQuality: true,
          showMotion: true,
          showTier: false,
          showLoop: true,
          hint: '720p is the most reliable. Pro and 4K require 8s duration and are more likely to time out.',
          timeEstimate: (s) => VIDEO_TIME_ESTIMATE[s.resolution] || '~2 min',
        },
        fal_seedance: {
          label: 'Legacy',
          capabilities: { textToVideo: true, imageAnimate: true, imageTransition: true, animationPrompt: true, referenceVideo: false },
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
          showStyle: true,  // style appended to prompt client-side for all modes
          styleLabel: 'Style Hint',
          showQuality: false,
          showMotion: false,
          showTier: false,
          showLoop: false,
          hint: 'Legacy engine. Kept available for existing workflows, but no longer the recommended option.',
          timeEstimate: () => '~1\u20133 min',
        },
        seedance: {
          label: 'Mini / Fast / Quality',
          // Seedance 2 GA via PiAPI: native first_last_frames replaces the legacy "experimental morph" hack.
          // referenceVideo \u2192 omni_reference mode (mixed image/video/audio references).
          capabilities: { textToVideo: true, imageAnimate: true, imageTransition: true, animationPrompt: true, referenceVideo: true },
          durations: [
            { value: '5', text: '5 sec', selected: true },
            { value: '10', text: '10 sec' },
            { value: '15', text: '15 sec' },
          ],
          // Seedance 2 GA aspects: 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, auto.
          aspects: [
            { value: '16:9', text: '16:9 Landscape', selected: true },
            { value: '9:16', text: '9:16 Portrait (TikTok / Reels)' },
            { value: '21:9', text: '21:9 Ultrawide / Cinematic' },
            { value: '4:3', text: '4:3 Standard' },
            { value: '3:4', text: '3:4 Tall' },
            { value: '1:1', text: '1:1 Square' },
            { value: 'auto', text: 'Auto \u2014 match input' },
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
          showStyle: true,  // style appended to prompt client-side for all modes
          styleLabel: 'Style Hint',
          showQuality: false,         // handled by dedicated seedance resolution selector
          showMotion: false,
          showTier: true,             // Mini / Fast / Quality
          showSeedanceResolution: true,
          showAudioToggle: true,      // PiAPI `audio` flag \u2014 soundtrack on/off
          showLoop: false,
          hint: 'Mini is the cheapest and fastest. Fast for drafts/social. Quality unlocks 1080p. Seedance 2.5 is the newest model with the best motion, at a premium rate and 720p max. Queue times vary with demand.',
          timeEstimate: (s) => {
            if (s.seedanceTier === 'quality') return '~2\u201310 min';
            if (s.seedanceTier === 'mini') return '~30 s\u20132 min';
            return '~1\u20133 min';
          },
        },
      };

      /**
       * Get current video settings from UI
       * @returns {Object} Video settings object
       */
      function getVideoSettingsFromUI() {
        const provider = videoAIProvider?.value || 'vertex';
        const isSeedance = provider === 'seedance';
        const isSeedanceFamily = isSeedance || provider === 'fal_seedance';
        const durationRaw = videoDuration?.value || (isSeedanceFamily ? '5' : '4');
        const resolutionRaw = videoQuality?.value || '720p';
        const aspectRaw = videoAspectRatio?.value || 'landscape';

        const seedanceTierInput = leftStack.querySelector('#seedanceTier');
        let seedanceTier = isSeedance ? (seedanceTierInput?.value || 'fast') : null;
        // Snap legacy `preview` to canonical `quality`.
        if (seedanceTier === 'preview') seedanceTier = 'quality';

        // Seedance owns its own resolution selector (480p/720p/1080p, tier-aware).
        // Snap to a valid resolution for the current tier (Mini and Fast cap at 720p).
        // The per-tier fallback matters: PiAPI defaults Mini to 720p, not 480p.
        let seedanceResolution = '480p';
        if (isSeedance) {
          const tierDefault = SEEDANCE_DEFAULT_RESOLUTION[seedanceTier] || '480p';
          const resSel = leftStack.querySelector('#seedanceResolutionSelect');
          const raw = (resSel?.value || tierDefault).toLowerCase();
          const allowed = SEEDANCE_RESOLUTIONS[seedanceTier] || ['480p'];
          seedanceResolution = allowed.includes(raw) ? raw : tierDefault;
        }

        // Soundtrack toggle (PiAPI `audio`). Defaults to on, matching PiAPI.
        const seedanceAudioInput = leftStack.querySelector('#seedanceAudio');
        const seedanceAudio = isSeedance
          ? (seedanceAudioInput ? seedanceAudioInput.value !== 'false' : true)
          : null;

        const settings = {
          provider: provider,
          durationSec: parseInt(durationRaw, 10) || (isSeedanceFamily ? 5 : 4),
          resolution: isSeedance
            ? seedanceResolution
            : (provider === 'fal_seedance' ? '720p' : resolutionRaw),
          quality: resolutionRaw,
          aspect: aspectRaw,
          // Seedance aspects come in already canonical (16:9, 9:16, 21:9, 1:1, 4:3, 3:4, auto).
          // Vertex still uses the legacy landscape/portrait alias map.
          aspectRatio: isSeedance
            ? (aspectRaw || '16:9')
            : (VIDEO_ASPECT_MAP[aspectRaw] || aspectRaw || '16:9'),
          fps: 24,
          loop: videoLoop?.checked ?? true,
          mode: videoModeValue?.value || 'text2video',
          seedanceTier: seedanceTier,
          // GA task type strings — legacy *-preview names still accepted upstream.
          seedanceVariant: isSeedance ? (SEEDANCE_TASK_TYPES[seedanceTier] || null) : null,
          seedanceAudio: seedanceAudio,
        };


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

        // Seedance (PiAPI): tier + resolution lookup. Fast lacks 1080p — snap to 720p.
        if (provider === 'seedance') {
          let tier = (settings.seedanceTier || 'fast');
          if (tier === 'preview') tier = 'quality';
          const seedanceRes = (resolution || SEEDANCE_DEFAULT_RESOLUTION[tier] || '480p').toLowerCase();
          const tierCosts = SEEDANCE_COSTS[tier] || {};
          let resCosts = tierCosts[seedanceRes];
          // Mini and Fast have no 1080p — the backend snaps such a request down to
          // 720p, so quote the 720p price rather than falling through to CPS.
          if (!resCosts && seedanceRes === '1080p') {
            resCosts = tierCosts['720p'];
          }
          if (resCosts && resCosts[duration] !== undefined) {
            cost = resCosts[duration];
            source = `seedance-${tier}-${seedanceRes}`;
          } else {
            // Try backend-fetched cost table via canonical action code
            if (window.WorkspaceCredits?.getVideoActionCode) {
              const ac = window.WorkspaceCredits.getVideoActionCode(
                mode, duration, seedanceRes, 'seedance', tier
              );
              const lookup = window.WorkspaceCredits.resolveCost?.(ac);
              if (typeof lookup === 'number' && lookup > 0) {
                cost = lookup;
                source = `seedance-${tier}-${seedanceRes}-backend`;
              }
            }
          if ((cost === null || cost === undefined) && resCosts && resCosts[5] !== undefined) {
              // Derive from the tier's own 5s row at THIS resolution — the flat
              // CPS table is a 480p baseline and would underquote 720p by ~2x.
              cost = Math.round((resCosts[5] / 5) * duration);
              source = `seedance-${tier}-${seedanceRes}-derived`;
            }
          if (cost === null || cost === undefined) {
              cost = (SEEDANCE_CPS[tier] || 16) * duration;
              source = `seedance-${tier}-cps`;
            }
          }
          if (mode === 'reference_video') {
            const ref = window.VideoReferenceState?.getPayload?.();
            const inputVideoSeconds = Math.max(0, Number(ref?.input_video_seconds || 0));
            if (inputVideoSeconds > 0) {
              cost += Math.ceil((cost / Math.max(1, duration)) * 0.5 * inputVideoSeconds);
              source += '+reference-video';
            }
          }
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
            cost = 96;  // Vertex 8s 720p base (12 c/s)
            source = 'fallback-default';
          }
        }

        // DEBUG: Log credit computation

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
       * Rebuild the Seedance resolution <select> options based on the active tier.
       * Mini and Fast expose 480p/720p, Quality adds 1080p. Snaps the current
       * selection to a valid resolution if the tier change made it invalid, falling
       * back to the tier's own default (720p for Mini, 480p elsewhere) rather than a
       * hardcoded 480p.
       */

        // Seedance durations are tier-dependent: 2.0 tiers cap at 15s; 2.5 takes
        // 4-30s — VERIFIED against the live API 2026-08-12 (the earlier "30s
        // fails" was a prompt byte-length bug, fixed in seedance_service.py).
        // DB rows for 20/25/30s: migration 082.
        const V25_DURATIONS = [5, 10, 15, 20, 25, 30];
        function updateSeedanceDurationOptions() {
          const durationSelect = leftStack.querySelector('#videoDuration');
          const tierInput = leftStack.querySelector('#seedanceTier');
          if (!durationSelect || !tierInput) return;
          const provider = videoAIProvider?.value
            || window.GenerationState?.getProvider?.('video') || '';
          if (provider !== 'seedance') return;
          const isV25 = tierInput.value === 'v25';
          const values = isV25 ? V25_DURATIONS : [5, 10, 15];
          const current = parseInt(durationSelect.value, 10) || 5;
          durationSelect.innerHTML = values.map(v =>
            '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + v + ' sec</option>'
          ).join('');
          if (!values.includes(current)) durationSelect.value = String(values[values.length - 1]);
        }

      function updateSeedanceResolutionOptions() {
        const wrap = leftStack.querySelector('#seedanceResolutionWrap');
        if (!wrap || wrap.classList.contains('hidden')) return;
        const sel = wrap.querySelector('#seedanceResolutionSelect');
        if (!sel) return;

        const tierInput = leftStack.querySelector('#seedanceTier');
        let tier = (tierInput && tierInput.value) || 'fast';
        if (tier === 'preview') tier = 'quality';

        let allowed = SEEDANCE_RESOLUTIONS[tier] || ['480p'];
        const mode = videoModeValue?.value || 'text2video';
        if (mode === 'reference_video' && !videoReferencePolicy.quality_1080p) {
          allowed = allowed.filter(r => r !== '1080p');
        }
        const labels = {
          '480p': '480p — Draft',
          '720p': '720p — Standard',
          '1080p': '1080p — Cinematic (Premium)',
        };
        const tierDefault = SEEDANCE_DEFAULT_RESOLUTION[tier] || '480p';
        const fallback = allowed.includes(tierDefault) ? tierDefault : allowed[0];
        const previous = (sel.value || '').toLowerCase();
        const next = allowed.includes(previous) ? previous : fallback;
        sel.innerHTML = allowed.map(r => `<option value="${r}"${r === next ? ' selected' : ''}>${labels[r] || r}</option>`).join('');
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
        } else if (mode === 'reference_video') {
          const ref = window.VideoReferenceState?.getPayload?.();
          const refPrompt = ref?.prompt || '';
          const hasAllowedRef = !!ref && (
            (ref.image_urls?.length || 0) > 0 ||
            (videoReferencePolicy.video_refs && (ref.video_urls?.length || 0) > 0) ||
            (videoReferencePolicy.audio_refs && (ref.audio_urls?.length || 0) > 0)
          );
          isValid = hasAllowedRef && refPrompt.trim().length > 0;
        } else {
          // Image-to-Video: one rule for every image count. At least one image,
          // plus a prompt whenever the images alone don't describe the intent
          // (Seedance needs motion direction; two frames need to know what happens
          // between them; 3+ references need a scene description to bind them).
          const currentProvider = document.getElementById('videoAIProvider')?.value || '';
          const isSeedance = currentProvider === 'seedance' || currentProvider === 'fal_seedance';
          const imageCount = (window.VideoImageRefs || []).length;
          const imgPrompt = document.getElementById('videoAnimationPrompt')?.value?.trim() || '';
          const promptRequired = isSeedance || imageCount >= 2;
          isValid = imageCount > 0 && (!promptRequired || imgPrompt.length > 0);
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
          btn.onclick = function() {
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
            const refContent = leftStack.querySelector('#referenceVideoContent');
            if (refContent) refContent.classList.toggle('hidden', mode !== 'reference_video');

            // Update style row visibility (Vertex hides style in image mode)
            const currentProvider = videoAIProvider?.value || 'vertex';
            const provCfg = VIDEO_PROVIDER_CONFIG[currentProvider];
            const styleRowEl = leftStack.querySelector('.video-style-row');
            if (styleRowEl && provCfg) {
              const showStyle = provCfg.showStyle === true
                || (provCfg.showStyle === 'text2video' && mode === 'text2video');
              styleRowEl.classList.toggle('hidden', !showStyle);
            }

            // Re-validate form
            updateSeedanceResolutionOptions();
            updateVideoFooter();
            validateVideoForm();

            console.log('[Video] Mode switched to:', mode);
          };
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

        // Duration, aspect — rebuild from config
        if (videoDuration) videoDuration.innerHTML = buildOptionsHTML(cfg.durations);
        if (videoAspectRatio) videoAspectRatio.innerHTML = buildOptionsHTML(cfg.aspects);

        // Style row — visibility depends on provider's showStyle flag.
        // showStyle: true = always show, 'text2video' = show only in text mode, false = hide.
        const currentVideoMode = leftStack.querySelector('#videoModeValue')?.value || 'text2video';
        const styleVisible = cfg.showStyle === true
          || (cfg.showStyle === 'text2video' && currentVideoMode === 'text2video');
        if (styleRow) styleRow.classList.toggle('hidden', !styleVisible);
        if (stylePreset && cfg.styles) stylePreset.innerHTML = buildOptionsHTML(cfg.styles);
        // Update style label to reflect provider mechanism
        const styleLabel = styleRow?.querySelector('label[for="videoStylePreset"]');
        if (styleLabel && cfg.styleLabel) styleLabel.textContent = cfg.styleLabel;

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
            tierWrap.innerHTML = '<label for="seedanceTierSelect">Speed</label><select id="seedanceTierSelect"><option value="mini">Mini — cheapest, fastest (~30 s\u20132 min)</option><option value="fast" selected>Fast — drafts &amp; social (~1\u20133 min)</option><option value="quality">Quality — cinematic detail (~2\u201310 min)</option><option value="v25">Seedance 2.5 — newest model, up to 30s (~7\u201330 min)</option></select>';
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
              // Tier change can invalidate the resolution (Mini/Fast have no 1080p)
              // and the duration (only 2.5 goes past 15s) — re-render both.
              updateSeedanceResolutionOptions();
              updateSeedanceDurationOptions();
              updateVideoFooter();
            });
          }
          // Reset tier — canonicalise legacy `preview` to `quality`.
          const seedanceTierInput = leftStack.querySelector('#seedanceTier');
          if (seedanceTierInput) {
            if (seedanceTierInput.value === 'preview') seedanceTierInput.value = 'quality';
            if (!SEEDANCE_RESOLUTIONS[seedanceTierInput.value]) seedanceTierInput.value = 'fast';
          }
          if (tierSelect) tierSelect.value = (seedanceTierInput && seedanceTierInput.value) || 'fast';
        } else if (tierWrap) {
          tierWrap.classList.add('hidden');
        }

        // Resolution selector (Seedance only) — tier-aware. Mini/Fast: 480p/720p, Quality: + 1080p.
        let seedanceResWrap = leftStack.querySelector('#seedanceResolutionWrap');
        if (cfg.showSeedanceResolution) {
          if (!seedanceResWrap) {
            seedanceResWrap = document.createElement('div');
            seedanceResWrap.id = 'seedanceResolutionWrap';
            seedanceResWrap.className = 'vs-setting';
            seedanceResWrap.innerHTML = '<label for="seedanceResolutionSelect">Resolution</label><select id="seedanceResolutionSelect"></select>';
            const tierSetting = leftStack.querySelector('#seedanceTierWrap');
            if (tierSetting) tierSetting.after(seedanceResWrap);
            else {
              const durationSetting = videoDuration && videoDuration.closest('.vs-setting');
              if (durationSetting) durationSetting.after(seedanceResWrap);
            }
            const _seedanceResSelect = seedanceResWrap.querySelector('#seedanceResolutionSelect');
            if (_seedanceResSelect && !_seedanceResSelect._seedanceResWired) {
              _seedanceResSelect._seedanceResWired = true;
              _seedanceResSelect.addEventListener('change', () => updateVideoFooter());
            }
          }
          seedanceResWrap.classList.remove('hidden');
          updateSeedanceResolutionOptions();
          updateSeedanceDurationOptions();
        } else if (seedanceResWrap) {
          seedanceResWrap.classList.add('hidden');
        }

        // PiAPI caps Seedance prompts at 4000 characters and 400s past that, so cap
        // the inputs client-side rather than letting the request fail upstream.
        // (The service also truncates defensively.)
        if (cfg.showTier) {
          ['#videoTextPrompt', '#videoAnimationPrompt', '#videoReferencePrompt'].forEach(sel => {
            const el = leftStack.querySelector(sel);
            if (el) el.setAttribute('maxlength', String(SEEDANCE_MAX_PROMPT_CHARS));
          });
        }

        // Soundtrack toggle (Seedance only) — PiAPI's `audio` flag. Seedance 2
        // generates a soundtrack by default; this lets the user ask for silence.
        // Turning it off does not change the credit cost.
        let seedanceAudioWrap = leftStack.querySelector('#seedanceAudioWrap');
        if (cfg.showAudioToggle) {
          if (!seedanceAudioWrap) {
            seedanceAudioWrap = document.createElement('div');
            seedanceAudioWrap.id = 'seedanceAudioWrap';
            seedanceAudioWrap.className = 'vs-setting vs-setting-toggle';
            seedanceAudioWrap.innerHTML =
              '<label>Soundtrack</label>' +
              '<button type="button" id="seedanceAudioBtn" class="vs-toggle-btn is-active" ' +
              'aria-pressed="true" title="Generate a soundtrack with the video">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' +
              '</svg><span>Audio on</span></button>';
            const resSetting = leftStack.querySelector('#seedanceResolutionWrap');
            if (resSetting) resSetting.after(seedanceAudioWrap);
            else {
              const durationSetting = videoDuration && videoDuration.closest('.vs-setting');
              if (durationSetting) durationSetting.after(seedanceAudioWrap);
            }
          }
          seedanceAudioWrap.classList.remove('hidden');

          const audioBtn = seedanceAudioWrap.querySelector('#seedanceAudioBtn');
          const audioInput = leftStack.querySelector('#seedanceAudio');
          if (audioBtn && !audioBtn._seedanceAudioWired) {
            audioBtn._seedanceAudioWired = true;
            audioBtn.addEventListener('click', () => {
              const nowOn = !(audioInput && audioInput.value !== 'false');
              if (audioInput) audioInput.value = nowOn ? 'true' : 'false';
              audioBtn.classList.toggle('is-active', nowOn);
              audioBtn.setAttribute('aria-pressed', String(nowOn));
              const lbl = audioBtn.querySelector('span');
              if (lbl) lbl.textContent = nowOn ? 'Audio on' : 'Silent';
            });
          }
          // Reflect current state (the panel can re-render on provider switch).
          if (audioBtn && audioInput) {
            const isOn = audioInput.value !== 'false';
            audioBtn.classList.toggle('is-active', isOn);
            audioBtn.setAttribute('aria-pressed', String(isOn));
            const lbl = audioBtn.querySelector('span');
            if (lbl) lbl.textContent = isOn ? 'Audio on' : 'Silent';
          }
        } else if (seedanceAudioWrap) {
          seedanceAudioWrap.classList.add('hidden');
        }

        // Loop/Playback toggle (Veo only — Seedance doesn't support loop)
        const loopSetting = leftStack.querySelector('#videoLoopBtn')?.closest('.vs-setting-toggle');
        if (loopSetting) loopSetting.classList.toggle('hidden', cfg.showLoop === false);

        // The image sub-mode switcher is gone: mode follows the image count, so
        // there is nothing to toggle here. What still varies per provider is how
        // many images are allowed, which vimgRender() reads from the live provider.
        // Trim any images the newly-selected provider can't accept (e.g. switching
        // from Seedance with 5 references over to Veo, which takes at most 2).
        const caps = cfg.capabilities || {};
        const refs = window.VideoImageRefs;
        if (Array.isArray(refs)) {
          const allowed = (videoAIProvider?.value === 'seedance')
            ? Math.max(2, (videoReferencePolicy?.limits?.max_image_refs) || 6)
            : 2;
          if (refs.length > allowed) {
            refs.splice(allowed);
            if (window.UI?.toast) {
              UI.toast(`This engine takes at most ${allowed} images — extra references were removed.`, 'info');
            }
          }
        }
        if (typeof vimgRender === 'function') vimgRender();

        // Custom motion textarea — shared by both providers
        const customMotionSection = leftStack.querySelector('.vs-custom-section');
        if (customMotionSection) customMotionSection.classList.remove('hidden');

        // Reference Video mode button — Seedance 2.0 only (omni_reference).
        const refModeBtn = document.getElementById('videoReferenceModeBtn');
        const hasReferenceVideo = !!caps.referenceVideo;
        if (refModeBtn) refModeBtn.classList.toggle('hidden', !hasReferenceVideo);
        // If we're leaving a provider that supported Reference Video while that mode
        // is active, fall back to text2video so the user isn't stuck on a dead panel.
        const modeValEl = leftStack.querySelector('#videoModeValue');
        if (!hasReferenceVideo && modeValEl && modeValEl.value === 'reference_video') {
          const textBtn = videoModeSwitcher?.querySelector('[data-mode="text2video"]');
          if (textBtn) textBtn.click();
        }

        // Hint text
        if (resolutionHint) resolutionHint.textContent = cfg.hint;
      }

      // Video provider switcher (main + experimental — mutually exclusive)
      const videoProviderSwitcher = document.getElementById('videoProviderSwitcher');
      const allProviderBtns = document.querySelectorAll('#videoProviderSwitcher .video-provider-btn');

      function selectProvider(provider, clickedBtn) {
        if (clickedBtn?.disabled) {
          const label = clickedBtn.querySelector('.vpb-tag')?.textContent || clickedBtn.textContent || provider;
          if (window.UI?.toast) {
            UI.toast(`${label.trim()} is currently unavailable. Check provider configuration.`, 'info');
          }
          return;
        }
        allProviderBtns.forEach(b => b.classList.remove('is-active'));
        if (clickedBtn) clickedBtn.classList.add('is-active');
        if (videoAIProvider) videoAIProvider.value = provider;

        applyProviderConfig(provider);
        updateDurationOptions();
        updateVideoFooter();
        validateVideoForm();

        console.log('[Video] Provider switched to:', provider);
      }

      allProviderBtns.forEach(btn => {
        btn.onclick = function () {
          selectProvider(this.dataset.provider, this);
        };
      });

      // ── Reference Video (Seedance 2.0 omni_reference) wiring ──────────────
      // Self-contained: manages its own upload/chip/mention/surcharge state and
      // exposes window.VideoReferenceState for api.startVideoGeneration().
      function initReferenceVideoMode() {
        const refContent = leftStack.querySelector('#referenceVideoContent');
        if (!refContent || refContent._refWired) return;
        refContent._refWired = true;

        const state = { images: [], videos: [], audios: [] };
        window.VideoReferenceState = state;

        const promptEl = leftStack.querySelector('#videoReferencePrompt');
        const mentionRow = leftStack.querySelector('#refMentionRow');
        const costWarn = leftStack.querySelector('#refCostWarning');
        const refIntro = leftStack.querySelector('#referenceVideoContent .ref-intro');

        const getRefLimits = () => videoReferencePolicy?.limits || DEFAULT_REFERENCE_POLICY.limits;
        const maxForKind = (kind) => {
          const limits = getRefLimits();
          if (kind === 'image') return limits.max_image_refs;
          if (kind === 'video') return limits.max_video_refs;
          if (kind === 'audio') return limits.max_audio_refs;
          return limits.max_total_refs;
        };
        const mbLimitForKind = (kind) => {
          const limits = getRefLimits();
          if (kind === 'image') return limits.max_image_mb;
          if (kind === 'video') return limits.max_video_mb;
          if (kind === 'audio') return limits.max_audio_mb;
          return limits.max_total_upload_mb;
        };
        const isKindEnabled = (kind) => {
          if (kind === 'image') return !!videoReferencePolicy.image_refs;
          if (kind === 'video') return !!videoReferencePolicy.video_refs;
          if (kind === 'audio') return !!videoReferencePolicy.audio_refs;
          return false;
        };
        const totalPayloadBytes = () => ['images', 'videos', 'audios'].reduce(
          (sum, key) => sum + state[key].reduce((s, item) => s + (item.bytes || 0), 0),
          0
        );
        const toastRefError = (message) => {
          if (window.UI?.toast) UI.toast(message, 'error');
          else console.warn('[Reference-Guided]', message);
        };

        function applyReferencePolicyUI() {
          const limits = getRefLimits();
          if (!isKindEnabled('video') && state.videos.length) state.videos = [];
          if (!isKindEnabled('audio') && state.audios.length) state.audios = [];
          if (refIntro) {
            refIntro.innerHTML =
              `<strong>Reference-Guided Video</strong> — add up to <strong>${limits.max_image_refs}</strong> image references. ` +
              `Video and audio references are ${videoReferencePolicy.video_refs || videoReferencePolicy.audio_refs ? 'available as premium options' : 'private beta options'}. ` +
              `Reference inputs are retained for about <strong>${limits.input_retention_hours}h</strong>.`;
          }
          [
            ['refAddImageBtn', 'image'],
            ['refAddVideoBtn', 'video'],
            ['refAddAudioBtn', 'audio'],
          ].forEach(([btnId, kind]) => {
            const btn = leftStack.querySelector('#' + btnId);
            if (!btn) return;
            const enabled = isKindEnabled(kind);
            btn.disabled = !enabled;
            btn.title = enabled
              ? `${maxForKind(kind)} ${kind} reference${maxForKind(kind) === 1 ? '' : 's'}, ${mbLimitForKind(kind)} MB each`
              : `${kind[0].toUpperCase() + kind.slice(1)} references are private beta`;
            btn.classList.toggle('is-disabled', !enabled);
          });
          renderChips('video');
          renderChips('audio');
          renderMentions();
        }
        window.VideoReferenceState.applyPolicy = applyReferencePolicyUI;

        const readAsDataURL = (file) => new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(file);
        });

        // Probe media duration (video/audio) from a data URL.
        const probeDuration = (dataUrl, kind) => new Promise((resolve) => {
          try {
            const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
            el.preload = 'metadata';
            el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
            el.onerror = () => resolve(0);
            el.src = dataUrl;
          } catch (_e) { resolve(0); }
        });

        const totalRefs = () => state.images.length + state.videos.length + state.audios.length;
        const totalInputVideoSeconds = () => state.videos.reduce((s, v) => s + (v.duration || 0), 0);
        const totalAudioSeconds = () => state.audios.reduce((s, a) => s + (a.duration || 0), 0);

        function seedanceCps() {
          let tier = (leftStack.querySelector('#seedanceTier')?.value) || 'fast';
          if (tier === 'preview') tier = 'quality';
          // SEEDANCE_CPS is defined in this scope (mini:14, fast:16, quality:20), 480p baseline.
          return (typeof SEEDANCE_CPS !== 'undefined' && SEEDANCE_CPS[tier]) ? SEEDANCE_CPS[tier] : 16;
        }

        function seedanceBaseCreditsForCurrentOptions() {
          let tier = (leftStack.querySelector('#seedanceTier')?.value) || 'fast';
          if (tier === 'preview') tier = 'quality';
          const duration = parseInt(videoDuration?.value || '5', 10) || 5;
          // Read Seedance's own resolution select. This used to read #videoQuality,
          // which is Veo's control (720p/1080p/4k) and is hidden for Seedance — so
          // the surcharge estimate was quoted against the wrong price row.
          const tierDefault = (typeof SEEDANCE_DEFAULT_RESOLUTION !== 'undefined'
            && SEEDANCE_DEFAULT_RESOLUTION[tier]) || '480p';
          const resolution = (leftStack.querySelector('#seedanceResolutionSelect')?.value || tierDefault).toLowerCase();
          const tierCosts = (typeof SEEDANCE_COSTS !== 'undefined' && SEEDANCE_COSTS[tier]) ? SEEDANCE_COSTS[tier] : {};
          let resCosts = tierCosts[resolution];
          // Mini and Fast have no 1080p — quote the 720p row they snap down to.
          if (!resCosts && resolution === '1080p') {
            resCosts = tierCosts['720p'];
          }
          if (resCosts && resCosts[duration] != null) return resCosts[duration];
          return seedanceCps() * duration;
        }

        function renderChips(kind) {
          const map = { image: 'refImageList', video: 'refVideoList', audio: 'refAudioList' };
          const listEl = leftStack.querySelector('#' + map[kind]);
          if (!listEl) return;
          const arr = state[kind + 's'];
          listEl.innerHTML = arr.map((item, i) => {
            const dur = item.duration ? ` · ${item.duration.toFixed(1)}s` : '';
            const safeName = (item.name || `${kind}${i + 1}`).replace(/[<>&]/g, '');
            return `<span class="ref-chip" data-kind="${kind}" data-idx="${i}">@${kind}${i + 1} <span class="ref-chip-name">${safeName}${dur}</span> <button type="button" class="ref-chip-remove" data-kind="${kind}" data-idx="${i}" aria-label="Remove">×</button></span>`;
          }).join('');
        }

        function renderMentions() {
          if (!mentionRow) return;
          const chips = [];
          state.images.forEach((_, i) => chips.push(`@image${i + 1}`));
          state.videos.forEach((_, i) => chips.push(`@video${i + 1}`));
          state.audios.forEach((_, i) => chips.push(`@audio${i + 1}`));
          mentionRow.innerHTML = chips.map(c =>
            `<button type="button" class="ref-mention-chip" data-token="${c}">${c}</button>`
          ).join('');
        }

        function updateCostWarning() {
          if (!costWarn) return;
          const vSec = totalInputVideoSeconds();
          if (vSec <= 0) { costWarn.classList.add('hidden'); costWarn.innerHTML = ''; return; }
          const duration = parseInt(videoDuration?.value || '5', 10) || 5;
          const baseCredits = seedanceBaseCreditsForCurrentOptions();
          const extraCredits = Math.ceil((baseCredits / Math.max(1, duration)) * 0.5 * vSec);
          costWarn.classList.remove('hidden');
          costWarn.innerHTML =
            `<strong>Heads up:</strong> reference videos add to the cost. PiAPI bills an extra ` +
            `half the per-second rate for each second of input video — about <strong>${vSec.toFixed(1)}s</strong> here ` +
            `(≈ <strong>${extraCredits}</strong> extra credits at the current tier). Audio + image references don't add a surcharge.`;
        }

        function refreshAll(kind) {
          if (kind) renderChips(kind);
          renderMentions();
          updateCostWarning();
          if (typeof validateVideoForm === 'function') validateVideoForm();
        }

        async function addFiles(kind, fileList) {
          if (!isKindEnabled(kind)) {
            toastRefError(`${kind[0].toUpperCase() + kind.slice(1)} references are not enabled for this account.`);
            return;
          }
          const files = Array.from(fileList || []);
          for (const file of files) {
            const limits = getRefLimits();
            if (totalRefs() >= limits.max_total_refs) {
              toastRefError(`Reference-Guided accepts at most ${limits.max_total_refs} references`);
              break;
            }
            if (state[kind + 's'].length >= maxForKind(kind)) {
              toastRefError(`${kind[0].toUpperCase() + kind.slice(1)} references accept at most ${maxForKind(kind)} item(s)`);
              break;
            }
            if (file.size > mbLimitForKind(kind) * 1024 * 1024) {
              toastRefError(`${file.name} is too large. ${kind} references are limited to ${mbLimitForKind(kind)} MB each.`);
              continue;
            }
            if (totalPayloadBytes() + file.size > limits.max_total_upload_mb * 1024 * 1024) {
              toastRefError(`Total reference upload payload is limited to ${limits.max_total_upload_mb} MB.`);
              break;
            }
            try {
              // Images go through the same downscale/re-encode step the main image
              // strip uses, so a phone photo doesn't ship 8MB of base64 per
              // reference. Video and audio are read as-is (re-encoding them in the
              // browser isn't practical) and are size-capped above instead.
              let dataUrl;
              let entryBytes = file.size;
              if (kind === 'image') {
                const processed = await vimgProcessFile(file);
                dataUrl = processed.dataUrl;
                entryBytes = Math.round(dataUrl.length * 0.75);
              } else {
                dataUrl = await readAsDataURL(file);
              }
              const entry = { dataUrl, name: file.name, bytes: entryBytes };
              if (kind === 'video' || kind === 'audio') {
                entry.duration = await probeDuration(dataUrl, kind);
              }
              if (kind === 'video' && (totalInputVideoSeconds() + (entry.duration || 0)) > limits.max_input_video_seconds) {
                toastRefError(`Reference videos can total at most ${limits.max_input_video_seconds}s.`);
                continue;
              }
              if (kind === 'audio' && (totalAudioSeconds() + (entry.duration || 0)) > limits.max_audio_seconds) {
                toastRefError(`Audio references can total at most ${limits.max_audio_seconds}s.`);
                continue;
              }
              state[kind + 's'].push(entry);
            } catch (_e) { /* skip unreadable file */ }
          }
          refreshAll(kind);
        }

        // Wire add buttons → hidden file inputs
        [['refAddImageBtn', 'refImageInput', 'image'],
         ['refAddVideoBtn', 'refVideoInput', 'video'],
         ['refAddAudioBtn', 'refAudioInput', 'audio']].forEach(([btnId, inputId, kind]) => {
          const btn = leftStack.querySelector('#' + btnId);
          const input = leftStack.querySelector('#' + inputId);
          if (btn && input) {
            btn.addEventListener('click', () => input.click());
            input.addEventListener('change', () => { addFiles(kind, input.files); input.value = ''; });
          }
        });

        // Chip remove (event delegation)
        refContent.addEventListener('click', (e) => {
          const rm = e.target.closest('.ref-chip-remove');
          if (rm) {
            const kind = rm.dataset.kind; const idx = parseInt(rm.dataset.idx, 10);
            if (state[kind + 's'] && idx >= 0) { state[kind + 's'].splice(idx, 1); refreshAll(kind); }
            return;
          }
          const mention = e.target.closest('.ref-mention-chip');
          if (mention && promptEl) {
            const token = mention.dataset.token + ' ';
            const start = promptEl.selectionStart ?? promptEl.value.length;
            const end = promptEl.selectionEnd ?? promptEl.value.length;
            promptEl.value = promptEl.value.slice(0, start) + token + promptEl.value.slice(end);
            promptEl.focus();
            const pos = start + token.length;
            promptEl.setSelectionRange(pos, pos);
          }
        });

        // Recompute surcharge when tier changes (cps differs by tier).
        const tierInput = leftStack.querySelector('#seedanceTier');
        if (tierInput) tierInput.addEventListener('change', updateCostWarning);
        [videoDuration, videoQuality].forEach(el => {
          if (el) el.addEventListener('change', updateCostWarning);
        });
        if (promptEl) promptEl.addEventListener('input', validateVideoForm);

        // Expose a payload builder for the API layer.
        window.VideoReferenceState.getPayload = function () {
          return {
            image_urls: state.images.map(x => x.dataUrl),
            video_urls: isKindEnabled('video') ? state.videos.map(x => x.dataUrl) : [],
            audio_urls: isKindEnabled('audio') ? state.audios.map(x => x.dataUrl) : [],
            input_video_seconds: isKindEnabled('video') ? totalInputVideoSeconds() : 0,
            prompt: (promptEl?.value || '').trim(),
            total_refs: totalRefs(),
          };
        };
        applyReferencePolicyUI();
      }
      initReferenceVideoMode();

      async function syncVideoProviderCatalog() {
        if (!window.TimrXApi?.apiFetch) return;
        try {
          const result = await window.TimrXApi.apiFetch('/api/video/providers');
          if (!result?.ok || !result.data) return;

          const enabled = new Set(Array.isArray(result.data.enabled_providers) ? result.data.enabled_providers : []);
          if (enabled.size) {
            allProviderBtns.forEach(btn => {
              const providerKey = btn.dataset.provider;
              const providerMeta = result.data.providers?.[providerKey] || {};
              const isKnownProvider = Object.prototype.hasOwnProperty.call(result.data.providers || {}, providerKey);
              const isEnabled = enabled.has(providerKey) || providerMeta.enabled === true;
              btn.hidden = false;
              btn.classList.remove('hidden');
              btn.disabled = !isEnabled;
              btn.classList.toggle('is-unavailable', !isEnabled);
              btn.setAttribute('aria-disabled', String(!isEnabled));
              btn.title = isEnabled
                ? `${providerMeta.provider_label || providerMeta.label || providerKey} is available`
                : `${providerMeta.provider_label || providerMeta.label || providerKey} is configured in the UI but disabled on the server`;
              if (!isKnownProvider) {
                btn.title = `${providerKey} is not present in the server provider catalog`;
              }
            });
            const current = videoAIProvider?.value || 'vertex';
            if (!enabled.has(current)) {
              const fallback = result.data.default_provider || enabled.values().next().value;
              const fallbackBtn = Array.from(allProviderBtns).find(btn => btn.dataset.provider === fallback);
              if (fallbackBtn) selectProvider(fallback, fallbackBtn);
            }
          }

          const seedanceCatalog = result.data.providers?.seedance || {};

          // Server is authoritative on per-tier resolutions and their defaults —
          // adopt them so a PiAPI-side change doesn't need a frontend deploy.
          if (seedanceCatalog.resolutions && typeof seedanceCatalog.resolutions === 'object') {
            Object.entries(seedanceCatalog.resolutions).forEach(([tier, list]) => {
              if (Array.isArray(list) && list.length) SEEDANCE_RESOLUTIONS[tier] = list.slice();
            });
          }
          if (seedanceCatalog.default_resolution && typeof seedanceCatalog.default_resolution === 'object') {
            Object.entries(seedanceCatalog.default_resolution).forEach(([tier, res]) => {
              if (res) SEEDANCE_DEFAULT_RESOLUTION[tier] = String(res).toLowerCase();
            });
          }

          const seedancePolicy = seedanceCatalog.reference_guided;
          if (seedancePolicy?.limits) {
            videoReferencePolicy = {
              ...DEFAULT_REFERENCE_POLICY,
              ...seedancePolicy,
              limits: { ...DEFAULT_REFERENCE_POLICY.limits, ...seedancePolicy.limits },
            };
            // PiAPI's absolute ceiling for omni_reference. Never let a policy value
            // promise more references than the upstream API will accept.
            const hardMax = Number(seedanceCatalog.max_references) || 9;
            const L = videoReferencePolicy.limits;
            L.max_total_refs = Math.min(L.max_total_refs, hardMax);
            L.max_image_refs = Math.min(L.max_image_refs, hardMax);
            L.max_video_refs = Math.min(L.max_video_refs, hardMax);

            window.VideoReferenceState?.applyPolicy?.();
            updateSeedanceResolutionOptions();
            updateVideoFooter();
            validateVideoForm();
          }
        } catch (err) {
          console.warn('[Video Provider UI] Failed to fetch video provider catalog:', err);
        }
      }
      syncVideoProviderCatalog();

      // Wire up video credits calculation on any option change
      [videoDuration, videoQuality, videoAspectRatio, videoLoop].forEach(el => {
        if (el) {
          el.addEventListener('change', () => {
            updateVideoFooter();
          });
        }
      });

      // When resolution changes, update valid duration options
      if (videoQuality) {
        videoQuality.addEventListener('change', () => {
          updateDurationOptions();
          updateVideoFooter();
        });
      }

      // When duration changes, also update footer
      if (videoDuration) {
        videoDuration.addEventListener('change', () => {
          updateVideoFooter();
        });
      }

      // Initialize duration options based on default resolution
      updateDurationOptions();

      // Wire up form validation on input changes
      if (videoTextPrompt) {
        videoTextPrompt.addEventListener('input', validateVideoForm);
      }
      // NOTE: an `if (videoSource) { ... }` block sat here referencing an
      // identifier that was never declared and an element id that exists
      // nowhere in the project. It threw a ReferenceError on every video-panel
      // render, which aborted the rest of initPanelInteractions() — motion
      // presets, prompt templates and the gallery button never bound — and
      // aborted activateWorkspacePanel() before switchViewer() could run.
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
      const imageOperation = leftStack.querySelector('#imageOperation');
      const imageOperationRow = leftStack.querySelector('#imageOperationRow');
      const imageModelVariant = leftStack.querySelector('#imageModelVariant');
      const imageModelVariantRow = leftStack.querySelector('#imageModelVariantRow');
      const imageShapeRow = leftStack.querySelector('#imageShapeRow');
      const imageShape = leftStack.querySelector('#imageShape');
      const imageQualityRow = leftStack.querySelector('#imageQualityRow');
      const imageQuality = leftStack.querySelector('#imageQuality');
      const imageOutputMode = leftStack.querySelector('#imageOutputMode');
      const imageOutputModeRow = leftStack.querySelector('#imageOutputModeRow');
      const imageOutputModeHint = leftStack.querySelector('#imageOutputModeHint');
      const imageProviderHint = leftStack.querySelector('#imageProviderHint');
      const imagePrompt = leftStack.querySelector('#imagePrompt');
      const imagePromptHint = leftStack.querySelector('#imagePromptHint');
      const imageSourceAssetGroup = leftStack.querySelector('#imageSourceAssetGroup');
      const imageSourceUpload = leftStack.querySelector('#imageSourceUpload');
      const imageSourceUploadStatus = leftStack.querySelector('#imageSourceUploadStatus');
      const imageSourceUploadList = leftStack.querySelector('#imageSourceUploadList');
      const imageSourceUploadClear = leftStack.querySelector('#imageSourceUploadClear');
      const imageSourceUploadHint = leftStack.querySelector('#imageSourceUploadHint');
      const imageMaskAssetGroup = leftStack.querySelector('#imageMaskAssetGroup');
      const imageMaskUpload = leftStack.querySelector('#imageMaskUpload');
      const imageMaskUploadStatus = leftStack.querySelector('#imageMaskUploadStatus');
      const imageMaskUploadList = leftStack.querySelector('#imageMaskUploadList');
      const imageMaskUploadClear = leftStack.querySelector('#imageMaskUploadClear');
      const imageMaskUploadHint = leftStack.querySelector('#imageMaskUploadHint');
      const imageReferenceAssetGroup = leftStack.querySelector('#imageReferenceAssetGroup');
      const imageReferenceUpload = leftStack.querySelector('#imageReferenceUpload');
      const imageReferenceUploadStatus = leftStack.querySelector('#imageReferenceUploadStatus');
      const imageReferenceUploadList = leftStack.querySelector('#imageReferenceUploadList');
      const imageReferenceUploadClear = leftStack.querySelector('#imageReferenceUploadClear');
      const imageReferenceUploadHint = leftStack.querySelector('#imageReferenceUploadHint');
      const imageStyleReferenceAssetGroup = leftStack.querySelector('#imageStyleReferenceAssetGroup');
      const imageStyleReferenceUpload = leftStack.querySelector('#imageStyleReferenceUpload');
      const imageStyleReferenceUploadStatus = leftStack.querySelector('#imageStyleReferenceUploadStatus');
      const imageStyleReferenceUploadList = leftStack.querySelector('#imageStyleReferenceUploadList');
      const imageStyleReferenceUploadClear = leftStack.querySelector('#imageStyleReferenceUploadClear');
      const imageStyleReferenceUploadHint = leftStack.querySelector('#imageStyleReferenceUploadHint');
      const imageCharacterReferenceAssetGroup = leftStack.querySelector('#imageCharacterReferenceAssetGroup');
      const imageCharacterReferenceUpload = leftStack.querySelector('#imageCharacterReferenceUpload');
      const imageCharacterReferenceUploadStatus = leftStack.querySelector('#imageCharacterReferenceUploadStatus');
      const imageCharacterReferenceUploadList = leftStack.querySelector('#imageCharacterReferenceUploadList');
      const imageCharacterReferenceUploadClear = leftStack.querySelector('#imageCharacterReferenceUploadClear');
      const imageCharacterReferenceUploadHint = leftStack.querySelector('#imageCharacterReferenceUploadHint');
      const imageCharacterMaskAssetGroup = leftStack.querySelector('#imageCharacterMaskAssetGroup');
      const imageCharacterMaskUpload = leftStack.querySelector('#imageCharacterMaskUpload');
      const imageCharacterMaskUploadStatus = leftStack.querySelector('#imageCharacterMaskUploadStatus');
      const imageCharacterMaskUploadList = leftStack.querySelector('#imageCharacterMaskUploadList');
      const imageCharacterMaskUploadClear = leftStack.querySelector('#imageCharacterMaskUploadClear');
      const imageCharacterMaskUploadHint = leftStack.querySelector('#imageCharacterMaskUploadHint');
      const imageUploadClearButtons = leftStack.querySelectorAll('.image-upload-clear');
      const imageAdvancedDetails = leftStack.querySelector('#imageAdvancedDetails');
      const imageNegativePromptGroup = leftStack.querySelector('#imageNegativePromptGroup');
      const imageNegativePrompt = leftStack.querySelector('#imageNegativePrompt');
      const imageRenderingSpeedRow = leftStack.querySelector('#imageRenderingSpeedRow');
      const imageRenderingSpeed = leftStack.querySelector('#imageRenderingSpeed');
      const imageMagicPromptRow = leftStack.querySelector('#imageMagicPromptRow');
      const imageMagicPrompt = leftStack.querySelector('#imageMagicPrompt');
      const imageStyleTypeRow = leftStack.querySelector('#imageStyleTypeRow');
      const imageStyleType = leftStack.querySelector('#imageStyleType');
      const imageStylePresetGroup = leftStack.querySelector('#imageStylePresetGroup');
      const imageStylePreset = leftStack.querySelector('#imageStylePreset');
      const imageStyleNameGroup = leftStack.querySelector('#imageStyleNameGroup');
      const imageStyleName = leftStack.querySelector('#imageStyleName');
      const imageStyleIdGroup = leftStack.querySelector('#imageStyleIdGroup');
      const imageStyleId = leftStack.querySelector('#imageStyleId');
      const imageStyleCodesGroup = leftStack.querySelector('#imageStyleCodesGroup');
      const imageStyleCodes = leftStack.querySelector('#imageStyleCodes');
      const imageColorPaletteNameGroup = leftStack.querySelector('#imageColorPaletteNameGroup');
      const imageColorPaletteName = leftStack.querySelector('#imageColorPaletteName');
      const imageColorPaletteMembersGroup = leftStack.querySelector('#imageColorPaletteMembersGroup');
      const imageColorPaletteMembers = leftStack.querySelector('#imageColorPaletteMembers');
      const imageSeedRow = leftStack.querySelector('#imageSeedRow');
      const imageSeed = leftStack.querySelector('#imageSeed');
      const imageImageWeightRow = leftStack.querySelector('#imageImageWeightRow');
      const imageImageWeight = leftStack.querySelector('#imageImageWeight');
      const imageStrengthRow = leftStack.querySelector('#imageStrengthRow');
      const imageStrength = leftStack.querySelector('#imageStrength');
      const imagePromptUpsamplingRow = leftStack.querySelector('#imagePromptUpsamplingRow');
      const imagePromptUpsampling = leftStack.querySelector('#imagePromptUpsampling');
      const imageGuidanceRow = leftStack.querySelector('#imageGuidanceRow');
      const imageGuidance = leftStack.querySelector('#imageGuidance');
      const imageStepsRow = leftStack.querySelector('#imageStepsRow');
      const imageSteps = leftStack.querySelector('#imageSteps');
      const imageSafetyToleranceRow = leftStack.querySelector('#imageSafetyToleranceRow');
      const imageSafetyTolerance = leftStack.querySelector('#imageSafetyTolerance');
      const imageOutputFormatRow = leftStack.querySelector('#imageOutputFormatRow');
      const imageOutputFormat = leftStack.querySelector('#imageOutputFormat');
      const imageTransparentBackgroundRow = leftStack.querySelector('#imageTransparentBackgroundRow');
      const imageTransparentBackground = leftStack.querySelector('#imageTransparentBackground');
      const imageUpscaleDetailRow = leftStack.querySelector('#imageUpscaleDetailRow');
      const imageUpscaleDetail = leftStack.querySelector('#imageUpscaleDetail');
      const imageUpscaleResemblanceRow = leftStack.querySelector('#imageUpscaleResemblanceRow');
      const imageUpscaleResemblance = leftStack.querySelector('#imageUpscaleResemblance');
      const imageBackgroundColorGroup = leftStack.querySelector('#imageBackgroundColorGroup');
      const imageBackgroundColor = leftStack.querySelector('#imageBackgroundColor');
      const imagePreferredColorsGroup = leftStack.querySelector('#imagePreferredColorsGroup');
      const imagePreferredColors = leftStack.querySelector('#imagePreferredColors');
      const imageArtisticLevelRow = leftStack.querySelector('#imageArtisticLevelRow');
      const imageArtisticLevel = leftStack.querySelector('#imageArtisticLevel');
      const imageNoTextRow = leftStack.querySelector('#imageNoTextRow');
      const imageNoText = leftStack.querySelector('#imageNoText');
      const imageTextLayoutGroup = leftStack.querySelector('#imageTextLayoutGroup');
      const imageTextLayout = leftStack.querySelector('#imageTextLayout');
      const imageSvgCompressionRow = leftStack.querySelector('#imageSvgCompressionRow');
      const imageSvgCompression = leftStack.querySelector('#imageSvgCompression');
      const imageLimitShapesRow = leftStack.querySelector('#imageLimitShapesRow');
      const imageLimitShapes = leftStack.querySelector('#imageLimitShapes');
      const imageMaxShapesRow = leftStack.querySelector('#imageMaxShapesRow');
      const imageMaxShapes = leftStack.querySelector('#imageMaxShapes');
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
        if (imageOperation) imageOperation.disabled = true;
        if (imageModelVariant) imageModelVariant.disabled = true;
        if (imageShape) imageShape.disabled = true;
        if (imageQuality) imageQuality.disabled = true;
        if (imageOutputMode) imageOutputMode.disabled = true;
        if (imagePrompt) imagePrompt.disabled = true;
        [imageSourceUpload, imageMaskUpload, imageReferenceUpload, imageStyleReferenceUpload, imageCharacterReferenceUpload, imageCharacterMaskUpload]
          .forEach((el) => { if (el) el.disabled = true; });
        imageUploadClearButtons.forEach((el) => {
          el.dataset.forceDisabled = 'true';
          el.disabled = true;
        });
        [imageNegativePrompt, imageRenderingSpeed, imageMagicPrompt, imageStyleType, imageStylePreset, imageStyleName, imageStyleId,
          imageStyleCodes, imageColorPaletteName, imageColorPaletteMembers, imageSeed, imageImageWeight, imageStrength,
          imagePromptUpsampling, imageGuidance, imageSteps, imageSafetyTolerance, imageOutputFormat, imageTransparentBackground,
          imageUpscaleDetail, imageUpscaleResemblance, imageBackgroundColor, imagePreferredColors, imageArtisticLevel,
          imageNoText, imageTextLayout, imageSvgCompression, imageLimitShapes, imageMaxShapes]
          .forEach((el) => { if (el) el.disabled = true; });

        // Show lock hint with provider name
        if (imageProviderLockHint) {
          imageProviderLockHint.classList.remove('hidden');
        }
        if (imageProviderLockText) {
          imageProviderLockText.textContent = `Provider locked: ${caps?.name || provider}`;
        }

        refreshImageAssetGroups();
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
        if (imageOperation) imageOperation.disabled = false;
        if (imageModelVariant) imageModelVariant.disabled = false;
        if (imageShape) imageShape.disabled = false;
        if (imageQuality) imageQuality.disabled = false;
        if (imageOutputMode) imageOutputMode.disabled = false;
        if (imagePrompt) imagePrompt.disabled = false;
        [imageSourceUpload, imageMaskUpload, imageReferenceUpload, imageStyleReferenceUpload, imageCharacterReferenceUpload, imageCharacterMaskUpload]
          .forEach((el) => { if (el) el.disabled = false; });
        imageUploadClearButtons.forEach((el) => {
          delete el.dataset.forceDisabled;
          el.disabled = false;
        });
        [imageNegativePrompt, imageRenderingSpeed, imageMagicPrompt, imageStyleType, imageStylePreset, imageStyleName, imageStyleId,
          imageStyleCodes, imageColorPaletteName, imageColorPaletteMembers, imageSeed, imageImageWeight, imageStrength,
          imagePromptUpsampling, imageGuidance, imageSteps, imageSafetyTolerance, imageOutputFormat, imageTransparentBackground,
          imageUpscaleDetail, imageUpscaleResemblance, imageBackgroundColor, imagePreferredColors, imageArtisticLevel,
          imageNoText, imageTextLayout, imageSvgCompression, imageLimitShapes, imageMaxShapes]
          .forEach((el) => { if (el) el.disabled = false; });

        // Hide lock hint
        if (imageProviderLockHint) {
          imageProviderLockHint.classList.add('hidden');
        }

        refreshImageAssetGroups();
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
       * Check if image generation is in flight.
       * Uses the unified isGenerating() which covers both submit lock
       * (request in progress) and UI lock (job in progress).
       */
      function isImageGenerating() {
        return window.GenerationState?.isGenerating?.() || false;
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
          ...snapshot.settings,
          // Map to provider-specific format
          aspectRatio: caps?.shapeMap?.[snapshot.settings.shape] || '1024x1024',
          qualityValue: caps?.qualityMap?.[snapshot.settings.quality] || 'standard',
          credits: snapshot.credits
        };
      }

      // Expose settings getter globally
      window.ImageJobControl.getSettings = getImageSettings;

      function showImageUploadError(message) {
        if (window.showToast) {
          window.showToast(message, 'error');
          return;
        }
        alert(message);
      }

      function validateImageFile(file) {
        return new Promise((resolve, reject) => {
          if (!file) {
            reject(new Error('No image file selected.'));
            return;
          }
          if (file.type && !String(file.type).toLowerCase().startsWith('image/')) {
            reject(new Error('Please select a real image file.'));
            return;
          }

          const objectUrl = URL.createObjectURL(file);
          const img = new Image();
          const cleanup = () => URL.revokeObjectURL(objectUrl);

          img.onload = () => {
            cleanup();
            resolve(file);
          };
          img.onerror = () => {
            cleanup();
            reject(new Error('Invalid image file. Please choose a real PNG, JPG, WEBP, or GIF image.'));
          };
          img.src = objectUrl;
        });
      }

      async function readFileAsDataUrl(file) {
        await validateImageFile(file);
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }

      function toggleHidden(el, hidden) {
        if (!el) return;
        el.classList.toggle('hidden', !!hidden);
      }

      function normalizeUploadNames(names) {
        return Array.isArray(names) ? names.filter(Boolean) : (names ? [names] : []);
      }

      function normalizeUploadAssets(assets) {
        return Array.isArray(assets) ? assets.filter(Boolean) : (assets ? [assets] : []);
      }

      function truncateUploadName(name) {
        return name && name.length > 28 ? `${name.slice(0, 25)}...` : name;
      }

      function renderImageUploadGroup(groupEl, statusEl, listEl, clearBtn, names, emptyText, required = false, options = {}) {
        const clean = normalizeUploadNames(names);
        const cleanAssets = normalizeUploadAssets(options.assets);
        const listMode = options.listMode || 'chips';
        const previewMode = listMode === 'thumbs';
        const maxCount = Number.isFinite(options.maxCount) ? options.maxCount : null;
        const badgeEl = groupEl?.querySelector('.image-asset-badge');

        groupEl?.classList.toggle('is-required', required);
        groupEl?.classList.toggle('has-selection', clean.length > 0);

        if (badgeEl) {
          if (required) {
            badgeEl.textContent = 'Required';
            badgeEl.classList.add('is-required');
            badgeEl.classList.remove('is-ready');
          } else if (clean.length) {
            badgeEl.textContent = clean.length > 1 ? `${clean.length} Files` : 'Ready';
            badgeEl.classList.remove('is-required');
            badgeEl.classList.add('is-ready');
          } else {
            badgeEl.textContent = 'Optional';
            badgeEl.classList.remove('is-required');
            badgeEl.classList.remove('is-ready');
          }
        }

        if (statusEl) {
          statusEl.textContent = clean.length === 0
            ? emptyText
            : (previewMode
              ? (clean.length === 1 ? '1 selected' : (maxCount ? `${clean.length} of ${maxCount} selected` : `${clean.length} selected`))
              : (clean.length === 1
                ? truncateUploadName(clean[0])
                : (maxCount ? `${clean.length} of ${maxCount} selected` : `${clean.length} selected`)));
          statusEl.classList.toggle('is-empty', clean.length === 0);
          statusEl.title = clean.length ? clean.join(', ') : emptyText;
        }

        if (listEl) {
          listEl.innerHTML = '';
          listEl.classList.toggle('image-upload-list--preview', previewMode && cleanAssets.length > 0);
          if (previewMode && cleanAssets.length > 0) {
            cleanAssets.forEach((asset, index) => {
              const tile = document.createElement('figure');
              tile.className = 'image-upload-preview';

              const preview = document.createElement('img');
              preview.className = 'image-upload-preview__image';
              preview.src = asset;
              preview.alt = clean[index] || `Reference ${index + 1}`;
              tile.appendChild(preview);

              const caption = document.createElement('figcaption');
              caption.className = 'image-upload-preview__caption';
              caption.textContent = truncateUploadName(clean[index] || `Reference ${index + 1}`);
              tile.appendChild(caption);

              listEl.appendChild(tile);
            });
            listEl.classList.remove('hidden');
          } else if (clean.length > 1) {
            const visibleNames = clean.slice(0, 2);
            visibleNames.forEach((name) => {
              const chip = document.createElement('span');
              chip.className = 'image-upload-chip';
              chip.textContent = truncateUploadName(name);
              listEl.appendChild(chip);
            });
            if (clean.length > visibleNames.length) {
              const extraChip = document.createElement('span');
              extraChip.className = 'image-upload-chip image-upload-chip--muted';
              extraChip.textContent = `+${clean.length - visibleNames.length} more`;
              listEl.appendChild(extraChip);
            }
            listEl.classList.remove('hidden');
          } else {
            listEl.classList.remove('image-upload-list--preview');
            listEl.classList.add('hidden');
          }
        }

        if (clearBtn) {
          clearBtn.classList.toggle('hidden', clean.length === 0);
          clearBtn.disabled = clean.length === 0 || !!clearBtn.dataset.forceDisabled;
        }
      }

      function getImageCaps() {
        const provider = window.GenerationState?.getProvider?.('image') || imageAIProvider?.value || 'nano_banana';
        return window.GenerationState?.getProviderCapabilities?.('image', provider) || null;
      }

      function getImageOperationSpec(caps, operation) {
        return (caps?.operations || []).find((item) => item?.value === operation) || null;
      }

      function getAllowedModelVariants(caps, operation) {
        return Array.isArray(caps?.modelVariants)
          ? caps.modelVariants.filter((item) => !Array.isArray(item?.operations) || item.operations.includes(operation))
          : [];
      }

      function isRecraftV3Model(modelVariant) {
        return /^recraftv3(?:_vector)?$/i.test(String(modelVariant || '').trim());
      }

      function isRecraftVectorModel(modelVariant, operation) {
        return operation === 'vectorize' || /vector/i.test(String(modelVariant || '').trim());
      }

      function recraftSupportsStyles(modelVariant, operation) {
        return isRecraftV3Model(modelVariant) && RECRAFT_STYLEABLE_OPERATIONS.has(operation);
      }

      function recraftSupportsNegativePrompt(modelVariant, operation) {
        return isRecraftV3Model(modelVariant) && RECRAFT_STYLEABLE_OPERATIONS.has(operation);
      }

      function recraftSupportsTextLayout(modelVariant, operation) {
        return isRecraftV3Model(modelVariant) && RECRAFT_STYLEABLE_OPERATIONS.has(operation);
      }

      function getRecraftStyleGroups(modelVariant, operation) {
        if (!recraftSupportsStyles(modelVariant, operation)) return [];
        return isRecraftVectorModel(modelVariant, operation)
          ? RECRAFT_V3_VECTOR_STYLE_GROUPS
          : RECRAFT_V3_RASTER_STYLE_GROUPS;
      }

      function populateRecraftStyleOptions(snapshot) {
        if (!imageStyleName) return;
        const settings = snapshot?.settings || {};
        const groups = getRecraftStyleGroups(settings.modelVariant, settings.operation || 'generate');
        const currentValue = String(settings.style || imageStyleName.value || '').trim();
        imageStyleName.innerHTML = '';

        if (!groups.length) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'Default';
          imageStyleName.appendChild(opt);
          imageStyleName.value = '';
          return;
        }

        groups.forEach((group) => {
          const optgroup = document.createElement('optgroup');
          optgroup.label = group.label;
          (group.options || []).forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.value;
            opt.textContent = item.label;
            optgroup.appendChild(opt);
          });
          imageStyleName.appendChild(optgroup);
        });

        imageStyleName.value = Array.from(imageStyleName.options).some((opt) => opt.value === currentValue)
          ? currentValue
          : '';
      }

      function updateRecraftWorkspaceGuide(snapshot) {
        if (!imagePrompt || !imagePromptHint || !imageProviderHint) return;
        const caps = snapshot?.capabilities || {};
        const settings = snapshot?.settings || {};
        const providerHint = caps?.hint || '';

        if (snapshot?.provider !== 'recraft_v4') {
          imagePrompt.placeholder = DEFAULT_IMAGE_PROMPT_PLACEHOLDER;
          imagePromptHint.textContent = DEFAULT_IMAGE_PROMPT_HINT;
          imageProviderHint.textContent = providerHint;
          imageProviderHint.style.display = providerHint ? 'block' : 'none';
          return;
        }

        const operation = settings.operation || 'generate';
        const modelVariant = settings.modelVariant || (settings.outputMode === 'vector_svg' ? 'recraftv4_vector' : 'recraftv4');
        const isV3 = isRecraftV3Model(modelVariant);
        const isVector = isRecraftVectorModel(modelVariant, operation);
        const supportsStyles = recraftSupportsStyles(modelVariant, operation);
        const supportsNegativePrompt = recraftSupportsNegativePrompt(modelVariant, operation);
        const tips = ['<strong>Recraft workflow</strong>', '<ul>'];

        if (operation === 'generate') {
          if (isVector) {
            imagePrompt.placeholder = 'Minimal coffee roaster logo, flat orange and charcoal shapes, centered badge, clean SVG';
            imagePromptHint.textContent = isV3
              ? 'For SVG, ask for icons, logos, flat shapes, limited colors, and clean outlines. V3 Vector also supports curated vector styles.'
              : 'For SVG, ask for icons, logos, flat shapes, limited colors, and clean outlines. V4 Vector is prompt-only.';
            tips.push(`<li>Selected model: <code>${modelVariant}</code></li>`);
            tips.push('<li>Use SVG for logos, icons, stickers, decals, and flat illustrations.</li>');
            tips.push(`<li>${supportsStyles ? 'Use the Recraft Style dropdown for V3 Vector styles such as Vector art, Line art, or Engraving.' : 'V4 vector models do not support curated styles.'}</li>`);
            tips.push('<li>Avoid photo language like bokeh, skin pores, camera lenses, or ultra-detailed texture when you want clean vectors.</li>');
          } else {
            imagePrompt.placeholder = isV3
              ? 'Premium skincare bottle on warm stone pedestal, studio photo, soft shadows, clean product shot'
              : 'Premium skincare bottle on warm stone pedestal, soft studio lighting, matte packaging, clean product photo';
            imagePromptHint.textContent = 'For raster, describe the subject, scene, materials, lighting, lens feel, and mood. Product, lifestyle, and concept prompts all work well here.';
            tips.push(`<li>Selected model: <code>${modelVariant}</code></li>`);
            tips.push('<li>Raster is best for photos, posters, packaging, and detailed illustrations.</li>');
            tips.push(`<li>${supportsStyles ? 'Use the Recraft Style dropdown for V3 Raster looks such as Photorealism, Illustration, Product photo, or Punk Graphic.' : 'V4 raster models do not support curated styles. Direct the look with your prompt plus color controls.'}</li>`);
            tips.push(`<li>${supportsNegativePrompt ? 'Negative Prompt is available here if you want to exclude clutter, extra limbs, blur, or messy text.' : 'Leave Negative Prompt empty on V4 generate models.'}</li>`);
          }
        } else if (operation === 'image_to_image') {
          imagePrompt.placeholder = 'Keep the same subject, change the label to matte black and add soft studio lighting';
          imagePromptHint.textContent = 'Upload a source image, then describe only what should change. Lower strength stays closer to the original.';
          tips.push('<li>Image to Image is V3-only.</li>');
          tips.push('<li>Styles and Negative Prompt both work here.</li>');
          tips.push('<li>Use Strength to control how far the new result can drift from the source.</li>');
        } else if (operation === 'inpaint') {
          imagePrompt.placeholder = 'Replace the masked area with a gold emblem';
          imagePromptHint.textContent = 'Upload a source image and mask. White mask areas change, black areas stay.';
          tips.push('<li>Inpaint is V3-only.</li>');
          tips.push('<li>Use a clean black-and-white mask with the same dimensions as the source.</li>');
          tips.push('<li>Describe only the masked replacement, not the entire image.</li>');
        } else if (operation === 'replace_background') {
          imagePrompt.placeholder = 'Minimal beige studio backdrop with soft gradient light';
          imagePromptHint.textContent = 'Upload a source image and describe only the new background.';
          tips.push('<li>Replace Background is V3-only.</li>');
          tips.push('<li>The subject is preserved while only the background is regenerated.</li>');
        } else if (operation === 'generate_background') {
          imagePrompt.placeholder = 'Luxury marble bathroom interior with soft daylight';
          imagePromptHint.textContent = 'Upload a source image plus mask, then describe the background to generate around the kept subject.';
          tips.push('<li>Generate Background is V3-only.</li>');
          tips.push('<li>White mask areas are regenerated; black regions stay intact.</li>');
        } else if (operation === 'vectorize') {
          imagePrompt.placeholder = 'Prompt not used for Vectorize';
          imagePromptHint.textContent = 'Upload a clean PNG, JPG, or WEBP. Vectorize converts it to SVG and ignores styles plus negative prompt.';
          tips.push('<li>Vectorize is best for existing logos, badges, decals, and flat art you want converted to SVG.</li>');
          tips.push('<li>Cleaner source art produces cleaner SVG paths.</li>');
        } else if (operation === 'remove_background') {
          imagePrompt.placeholder = 'Prompt not used for Remove Background';
          imagePromptHint.textContent = 'Upload a source image and Recraft will cut the background away.';
          tips.push('<li>Remove Background keeps the foreground subject and strips the background.</li>');
        } else if (operation === 'crisp_upscale') {
          imagePrompt.placeholder = 'Prompt not used for Crisp Upscale';
          imagePromptHint.textContent = 'Upload a source image to sharpen and upscale it without changing the composition.';
          tips.push('<li>Crisp Upscale prioritizes sharper detail with minimal reinterpretation.</li>');
        } else if (operation === 'creative_upscale') {
          imagePrompt.placeholder = 'Prompt not used for Creative Upscale';
          imagePromptHint.textContent = 'Upload a source image to upscale it while letting Recraft refine small details and faces.';
          tips.push('<li>Creative Upscale can alter fine detail more aggressively than Crisp Upscale.</li>');
        } else if (operation === 'erase_region') {
          imagePrompt.placeholder = 'Prompt not used for Erase Region';
          imagePromptHint.textContent = 'Upload a source image and mask. White mask areas are erased, black areas are preserved.';
          tips.push('<li>Erase Region removes masked content without using a text prompt.</li>');
        } else if (operation === 'remix') {
          imagePrompt.placeholder = 'Prompt optional for Remix';
          imagePromptHint.textContent = 'Upload a source image to create a variation. Recraft reinterprets it without curated styles.';
          tips.push('<li>Remix creates a variation of the uploaded image.</li>');
          tips.push('<li>Curated styles and negative prompt are not used here.</li>');
        } else {
          imagePrompt.placeholder = DEFAULT_IMAGE_PROMPT_PLACEHOLDER;
          imagePromptHint.textContent = DEFAULT_IMAGE_PROMPT_HINT;
          tips.push(`<li>${providerHint}</li>`);
        }

        tips.push('</ul>');
        imageProviderHint.innerHTML = tips.join('');
        imageProviderHint.style.display = 'block';
      }

      function refreshImageAssetGroups(snapshot = window.GenerationState.getGenerationSnapshot('image')) {
        const caps = snapshot?.capabilities || {};
        const settings = snapshot?.settings || {};
        const opSpec = getImageOperationSpec(caps, settings.operation || 'generate');
        const requiresSource = !!opSpec?.requiresSource;
        const requiresMask = !!opSpec?.requiresMask;

        // Provider-specific upload hints so each tab clearly explains
        // what the reference image will do for that model.
        const provider = snapshot?.provider;
        const PROVIDER_SOURCE_HINTS = {
          openai: 'Drop an image — gpt-image will edit it based on your prompt. PNG / JPG / WebP.',
          google: 'Drop an image — Vertex AI Imagen will use it as your reference (image-to-image edit).',
          google_nano: 'Drop an image — Gemini 2.5 Flash Image will edit it natively. Describe the change in your prompt.',
          nano_banana: 'Drop a reference image — Nano Banana 2 will steer its 1K/2K/4K generation off it.',
          nano_banana_pro: 'Drop up to 4 references — Nano Banana Pro keeps subjects consistent across them.',
          flux_pro: 'Shown for edit, remix, reframe, upscale, and utility modes.',
          ideogram_v3: 'Source image for remix / edit / reframe operations.',
          recraft_v4: 'Source image for image-to-image, inpaint, background ops, and vectorize.'
        };
        const PROVIDER_REF_HINTS = {
          openai: (n) => `Up to ${n} reference images — gpt-image will blend them based on your prompt.`,
          google: (n) => `Up to ${n} references — primary becomes the base; extras act as subject guides.`,
          google_nano: (n) => `Up to ${n} references — Gemini will weave them into the result.`,
          nano_banana: () => 'Single reference image — Nano Banana 2 uses one reference at a time.',
          nano_banana_pro: (n) => `Up to ${n} references — Pro holds character and product consistency across them.`,
          flux_pro: (n) => `Add up to ${n} references to guide composition, style, pose, or materials.`,
          ideogram_v3: () => 'Up to 8 style references.',
          recraft_v4: () => 'Reference image for image-to-image and related operations.'
        };

        const sourceHint = PROVIDER_SOURCE_HINTS[provider]
          || 'Shown for edit, remix, reframe, upscale, and utility modes.';
        if (imageSourceUploadHint) imageSourceUploadHint.textContent = sourceHint;
        if (imageMaskUploadHint) imageMaskUploadHint.textContent = 'White changes, black protects.';
        if (imageReferenceUploadHint) {
          const maxRefs = caps?.maxReferenceImages || 8;
          const refHintFn = PROVIDER_REF_HINTS[provider];
          imageReferenceUploadHint.textContent = refHintFn
            ? refHintFn(maxRefs)
            : `Add up to ${maxRefs} references to guide composition, style, pose, or materials.`;
        }
        if (imageStyleReferenceUploadHint) imageStyleReferenceUploadHint.textContent = 'Optional Ideogram style guides.';
        if (imageCharacterReferenceUploadHint) imageCharacterReferenceUploadHint.textContent = 'Use one image to keep a character consistent.';
        if (imageCharacterMaskUploadHint) imageCharacterMaskUploadHint.textContent = 'Optional mask for the character reference.';

        renderImageUploadGroup(
          imageSourceAssetGroup,
          imageSourceUploadStatus,
          imageSourceUploadList,
          imageSourceUploadClear,
          settings.sourceImageName,
          'No source selected',
          requiresSource,
          {
            assets: settings.sourceImage,
            listMode: 'thumbs',
          }
        );
        renderImageUploadGroup(
          imageMaskAssetGroup,
          imageMaskUploadStatus,
          imageMaskUploadList,
          imageMaskUploadClear,
          settings.maskImageName,
          'No mask selected',
          requiresMask,
          {
            assets: settings.maskImage,
            listMode: 'thumbs',
          }
        );
        renderImageUploadGroup(
          imageReferenceAssetGroup,
          imageReferenceUploadStatus,
          imageReferenceUploadList,
          imageReferenceUploadClear,
          settings.referenceImageNames,
          'No references selected',
          false,
          {
            assets: settings.referenceImages,
            listMode: 'thumbs',
            maxCount: caps?.maxReferenceImages || 8,
          }
        );
        renderImageUploadGroup(
          imageStyleReferenceAssetGroup,
          imageStyleReferenceUploadStatus,
          imageStyleReferenceUploadList,
          imageStyleReferenceUploadClear,
          settings.styleReferenceNames,
          'No style refs selected',
          false,
          {
            assets: settings.styleReferenceImages,
            listMode: 'thumbs',
          }
        );
        renderImageUploadGroup(
          imageCharacterReferenceAssetGroup,
          imageCharacterReferenceUploadStatus,
          imageCharacterReferenceUploadList,
          imageCharacterReferenceUploadClear,
          settings.characterReferenceNames,
          'No character selected',
          false,
          {
            assets: settings.characterReferenceImages,
            listMode: 'thumbs',
          }
        );
        renderImageUploadGroup(
          imageCharacterMaskAssetGroup,
          imageCharacterMaskUploadStatus,
          imageCharacterMaskUploadList,
          imageCharacterMaskUploadClear,
          settings.characterReferenceMaskNames,
          'No mask selected',
          false,
          {
            assets: settings.characterReferenceMasks,
            listMode: 'thumbs',
          }
        );
      }

      function syncImageAdvancedFromUI() {
        const set = (key, value) => window.GenerationState.setSetting('image', key, value);
        if (imageOperation) set('operation', imageOperation.value || 'generate');
        if (imageModelVariant) set('modelVariant', imageModelVariant.value || '');
        if (imageNegativePrompt) set('negativePrompt', imageNegativePrompt.value || '');
        if (imageRenderingSpeed) set('renderingSpeed', imageRenderingSpeed.value || 'DEFAULT');
        if (imageMagicPrompt) set('magicPrompt', imageMagicPrompt.value || 'AUTO');
        if (imageStyleType) set('styleType', imageStyleType.value || '');
        if (imageStylePreset) set('stylePreset', imageStylePreset.value || '');
        if (imageStyleName) set('style', imageStyleName.value || '');
        if (imageStyleId) set('styleId', imageStyleId.value || '');
        if (imageStyleCodes) set('styleCodes', imageStyleCodes.value || '');
        if (imageColorPaletteName) set('colorPaletteName', imageColorPaletteName.value || '');
        if (imageColorPaletteMembers) set('colorPaletteMembers', imageColorPaletteMembers.value || '');
        if (imageSeed) set('seed', imageSeed.value || '');
        if (imageImageWeight) set('imageWeight', imageImageWeight.value || '50');
        if (imageStrength) set('strength', imageStrength.value || '0.35');
        if (imagePromptUpsampling) set('promptUpsampling', imagePromptUpsampling.value !== 'off');
        if (imageGuidance) set('guidance', imageGuidance.value || '');
        if (imageSteps) set('steps', imageSteps.value || '');
        if (imageSafetyTolerance) set('safetyTolerance', imageSafetyTolerance.value || '2');
        if (imageOutputFormat) set('outputFormat', imageOutputFormat.value || 'jpeg');
        if (imageTransparentBackground) set('transparentBackground', imageTransparentBackground.value === 'on');
        if (imageUpscaleDetail) set('detail', imageUpscaleDetail.value || '50');
        if (imageUpscaleResemblance) set('resemblance', imageUpscaleResemblance.value || '50');
        if (imageBackgroundColor) set('backgroundColor', imageBackgroundColor.value || '');
        if (imagePreferredColors) set('preferredColors', imagePreferredColors.value || '');
        if (imageArtisticLevel) set('artisticLevel', imageArtisticLevel.value || '');
        if (imageNoText) set('noText', imageNoText.value === 'on');
        if (imageTextLayout) set('textLayout', imageTextLayout.value || '');
        if (imageSvgCompression) set('svgCompression', imageSvgCompression.value === 'on');
        if (imageLimitShapes) set('limitNumShapes', imageLimitShapes.value === 'on');
        if (imageMaxShapes) set('maxNumShapes', imageMaxShapes.value || '');
      }

      function populateImageOperationOptions(caps) {
        if (!imageOperation || !imageOperationRow) return;
        const operations = caps?.operations || [{ value: 'generate', label: 'Generate' }];
        const currentValue = imageOperation.value;
        imageOperation.innerHTML = '';
        operations.forEach((item) => {
          const opt = document.createElement('option');
          opt.value = item.value;
          opt.textContent = item.label;
          imageOperation.appendChild(opt);
        });
        imageOperation.value = operations.some((item) => item.value === currentValue)
          ? currentValue
          : (caps?.defaultOperation || operations[0]?.value || 'generate');
        toggleHidden(imageOperationRow, operations.length <= 1);
        if (window.GenerationState?.getSettings?.('image')?.operation !== imageOperation.value) {
          window.GenerationState.setSetting('image', 'operation', imageOperation.value);
        }
      }

      function populateImageModelVariantOptions(caps) {
        if (!imageModelVariant || !imageModelVariantRow) return;
        const currentOperation = window.GenerationState?.getSettings?.('image')?.operation || imageOperation?.value || 'generate';
        const variants = getAllowedModelVariants(caps, currentOperation);
        const currentValue = imageModelVariant.value;
        imageModelVariant.innerHTML = '';
        variants.forEach((item) => {
          const opt = document.createElement('option');
          opt.value = item.value;
          opt.textContent = item.label;
          imageModelVariant.appendChild(opt);
        });
        imageModelVariant.value = variants.some((item) => item.value === currentValue)
          ? currentValue
          : (variants[0]?.value || '');
        toggleHidden(imageModelVariantRow, variants.length <= 1);
        if (window.GenerationState?.getSettings?.('image')?.modelVariant !== imageModelVariant.value) {
          window.GenerationState.setSetting('image', 'modelVariant', imageModelVariant.value);
        }
      }

      function updateImageAdvancedUI() {
        const initialSnapshot = window.GenerationState.getGenerationSnapshot('image');
        const initialCaps = initialSnapshot.capabilities || {};
        const initialSettings = initialSnapshot.settings || {};
        const initialOperation = initialSettings.operation || 'generate';
        const opSpec = getImageOperationSpec(initialCaps, initialOperation);
        const requiresSource = !!opSpec?.requiresSource;
        const requiresMask = !!opSpec?.requiresMask;
        const usesShape = !['upscale', 'remove_background', 'crisp_upscale', 'creative_upscale', 'erase_region', 'vectorize'].includes(initialOperation);

        populateImageOperationOptions(initialCaps);
        populateImageModelVariantOptions(initialCaps);

        const snapshot = window.GenerationState.getGenerationSnapshot('image');
        const caps = snapshot.capabilities || {};
        const settings = snapshot.settings || {};
        const effectiveSupportsStyle = snapshot.provider === 'recraft_v4'
          ? recraftSupportsStyles(settings.modelVariant, settings.operation || 'generate')
          : !!caps?.supportsStyleName;
        const effectiveSupportsStyleId = snapshot.provider === 'recraft_v4'
          ? recraftSupportsStyles(settings.modelVariant, settings.operation || 'generate')
          : !!caps?.supportsStyleId;
        const effectiveSupportsNegativePrompt = snapshot.provider === 'recraft_v4'
          ? recraftSupportsNegativePrompt(settings.modelVariant, settings.operation || 'generate')
          : !!caps?.supportsNegativePrompt;
        const effectiveSupportsTextLayout = snapshot.provider === 'recraft_v4'
          ? recraftSupportsTextLayout(settings.modelVariant, settings.operation || 'generate')
          : !!caps?.supportsTextLayout;

        populateRecraftStyleOptions(snapshot);

        if (snapshot.provider === 'recraft_v4') {
          const shouldUseVector = settings.operation === 'vectorize' || /vector/i.test(settings.modelVariant || '');
          const desiredOutputMode = shouldUseVector ? 'vector_svg' : (settings.outputMode || 'raster');
          if (desiredOutputMode !== settings.outputMode) {
            window.GenerationState.setSetting('image', 'outputMode', desiredOutputMode);
          }
          if (imageOutputMode && imageOutputMode.value !== desiredOutputMode) {
            imageOutputMode.value = desiredOutputMode;
          }
        }

        toggleHidden(imageShapeRow, !usesShape);
        const showQuality = Array.isArray(caps?.qualities) && caps.qualities.length > 1;
        toggleHidden(imageQualityRow, !showQuality);

        toggleHidden(imageSourceAssetGroup, !caps?.supportsSourceImage && !requiresSource);
        toggleHidden(imageMaskAssetGroup, !(caps?.supportsMaskImage || requiresMask));
        toggleHidden(imageReferenceAssetGroup, !caps?.supportsReferenceImages);
        toggleHidden(imageStyleReferenceAssetGroup, !caps?.supportsStyleReferenceImages);
        toggleHidden(imageCharacterReferenceAssetGroup, !caps?.supportsCharacterReferenceImages);
        toggleHidden(imageCharacterMaskAssetGroup, !caps?.supportsCharacterReferenceImages);
        toggleHidden(imageNegativePromptGroup, !effectiveSupportsNegativePrompt);
        toggleHidden(imageRenderingSpeedRow, !caps?.supportsRenderingSpeed);
        toggleHidden(imageMagicPromptRow, !caps?.supportsMagicPrompt);
        toggleHidden(imageStyleTypeRow, !caps?.supportsStyleType);
        toggleHidden(imageStylePresetGroup, !caps?.supportsStylePreset);
        toggleHidden(imageStyleNameGroup, !effectiveSupportsStyle);
        toggleHidden(imageStyleIdGroup, !effectiveSupportsStyleId);
        toggleHidden(imageStyleCodesGroup, !caps?.supportsStyleCodes);
        toggleHidden(imageColorPaletteNameGroup, !caps?.supportsColorPalette);
        toggleHidden(imageColorPaletteMembersGroup, !caps?.supportsColorPalette);
        toggleHidden(imageSeedRow, !caps?.supportsSeed);
        toggleHidden(imageImageWeightRow, !(caps?.supportsImageWeight && settings.operation === 'remix'));
        toggleHidden(imageStrengthRow, !(caps?.supportsStrength && settings.operation === 'image_to_image'));
        toggleHidden(imagePromptUpsamplingRow, !caps?.supportsPromptUpsampling);
        toggleHidden(imageGuidanceRow, !(caps?.supportsGuidance && settings.modelVariant === 'flex'));
        toggleHidden(imageStepsRow, !(caps?.supportsSteps && settings.modelVariant === 'flex'));
        toggleHidden(imageSafetyToleranceRow, !caps?.supportsSafetyTolerance);
        toggleHidden(imageOutputFormatRow, !caps?.supportsOutputFormat);
        toggleHidden(imageTransparentBackgroundRow, !caps?.supportsTransparentBackground);
        toggleHidden(imageUpscaleDetailRow, !(caps?.supportsUpscaleTuning && settings.operation === 'upscale'));
        toggleHidden(imageUpscaleResemblanceRow, !(caps?.supportsUpscaleTuning && settings.operation === 'upscale'));
        toggleHidden(imageBackgroundColorGroup, !caps?.supportsBackgroundColor);
        toggleHidden(imagePreferredColorsGroup, !caps?.supportsPreferredColors);
        toggleHidden(imageArtisticLevelRow, !caps?.supportsArtisticLevel);
        toggleHidden(imageNoTextRow, !caps?.supportsNoText);
        toggleHidden(imageTextLayoutGroup, !effectiveSupportsTextLayout);
        toggleHidden(imageSvgCompressionRow, !(caps?.supportsSvgShapeControls && settings.operation === 'vectorize'));
        toggleHidden(imageLimitShapesRow, !(caps?.supportsSvgShapeControls && settings.operation === 'vectorize'));
        toggleHidden(imageMaxShapesRow, !(caps?.supportsSvgShapeControls && settings.operation === 'vectorize'));

        updateRecraftWorkspaceGuide(snapshot);
        refreshImageAssetGroups(snapshot);

        if (imageAdvancedDetails) {
          const anyAdvancedVisible = [
            imageNegativePromptGroup, imageRenderingSpeedRow, imageMagicPromptRow, imageStyleTypeRow, imageStylePresetGroup,
            imageStyleNameGroup, imageStyleIdGroup, imageStyleCodesGroup, imageColorPaletteNameGroup, imageColorPaletteMembersGroup,
            imageSeedRow, imageImageWeightRow, imageStrengthRow, imagePromptUpsamplingRow, imageGuidanceRow, imageStepsRow,
            imageSafetyToleranceRow, imageOutputFormatRow, imageTransparentBackgroundRow, imageUpscaleDetailRow,
            imageUpscaleResemblanceRow, imageBackgroundColorGroup, imagePreferredColorsGroup, imageArtisticLevelRow,
            imageNoTextRow, imageTextLayoutGroup, imageSvgCompressionRow, imageLimitShapesRow, imageMaxShapesRow
          ].some((el) => el && !el.classList.contains('hidden'));
          toggleHidden(imageAdvancedDetails, !anyAdvancedVisible);
        }
      }

      async function bindSingleImageUpload(input, clearBtn, settingKey, nameKey) {
        if (!input) return;
        const clearSelection = () => {
          input.value = '';
          window.GenerationState.setSetting('image', settingKey, '');
          window.GenerationState.setSetting('image', nameKey, '');
          refreshImageAssetGroups();
          validateImageForm();
        };
        clearBtn?.addEventListener('click', clearSelection);
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) {
            clearSelection();
            return;
          }
          try {
            const dataUrl = await readFileAsDataUrl(file);
            window.GenerationState.setSetting('image', settingKey, dataUrl);
            window.GenerationState.setSetting('image', nameKey, file.name);
            refreshImageAssetGroups();
          } catch (err) {
            console.warn('[Image Upload] Failed to read file:', err);
            clearSelection();
            showImageUploadError(err?.message || 'Invalid image file.');
          }
          validateImageForm();
        });
      }

      async function bindMultiImageUpload(input, clearBtn, settingKey, nameKey) {
        if (!input) return;
        const getMaxAllowed = () => {
          if (settingKey === 'referenceImages') {
            return getImageCaps()?.maxReferenceImages || 8;
          }
          return null;
        };
        const clearSelection = () => {
          input.value = '';
          window.GenerationState.setSetting('image', settingKey, []);
          window.GenerationState.setSetting('image', nameKey, []);
          refreshImageAssetGroups();
          validateImageForm();
        };
        clearBtn?.addEventListener('click', clearSelection);
        input.addEventListener('change', async () => {
          const files = Array.from(input.files || []);
          if (!files.length) {
            clearSelection();
            return;
          }
          try {
            const dataUrls = await Promise.all(files.map((file) => readFileAsDataUrl(file)));
            const snapshot = window.GenerationState.getGenerationSnapshot('image');
            const existingAssets = normalizeUploadAssets(snapshot?.settings?.[settingKey]);
            const existingNames = normalizeUploadNames(snapshot?.settings?.[nameKey]);
            const maxAllowed = getMaxAllowed();

            let nextAssets = existingAssets.concat(dataUrls);
            let nextNames = existingNames.concat(files.map((file) => file.name));

            if (maxAllowed && nextAssets.length > maxAllowed) {
              nextAssets = nextAssets.slice(0, maxAllowed);
              nextNames = nextNames.slice(0, maxAllowed);
            }

            window.GenerationState.setSetting('image', settingKey, nextAssets);
            window.GenerationState.setSetting('image', nameKey, nextNames);
            input.value = '';
            refreshImageAssetGroups();
          } catch (err) {
            console.warn('[Image Upload] Failed to read files:', err);
            input.value = '';
            showImageUploadError(err?.message || 'Invalid image file.');
          }
          validateImageForm();
        });
      }

      /**
       * Update image credits display using GenerationState
       */
      function updateImageCreditsDisplay() {
        const snapshot = window.GenerationState.getGenerationSnapshot('image');
        const caps = snapshot.capabilities;
        const currentQuality = snapshot.settings?.quality || 'standard';
        const currentOutputMode = snapshot.settings?.outputMode || 'raster';

        if (imageCreditsDisplay) {
          imageCreditsDisplay.innerHTML = `<i class="fa-solid fa-coins"></i> ${snapshot.credits}`;
          // Premium glow on credits badge when 4K is selected
          imageCreditsDisplay.classList.toggle('premium-glow', currentQuality === '4k' || currentOutputMode === 'vector_svg');
        }
        if (imageGenTime) {
          imageGenTime.textContent = caps?.genTime || '30 sec';
        }
        if (generateImageBtn) {
          generateImageBtn.title = `${snapshot.credits} credits`;
          generateImageBtn.dataset.provider = snapshot.provider;
          generateImageBtn.dataset.baseCredits = snapshot.credits;
        }

        // Rebuild shape dropdown from provider capabilities — nano banana tiers
        // expose PiAPI's extra ratios (21:9 wide, 3:2 classic, 4:5 tall) that the
        // other providers don't support.
        if (imageShape && Array.isArray(caps?.shapes) && caps.shapes.length) {
          const SHAPE_OPTION_LABELS = {
            square:    '1:1 Square',
            portrait:  '9:16 Portrait',
            landscape: '16:9 Landscape',
            wide:      '21:9 Wide',
            classic:   '3:2 Classic',
            tall:      '4:5 Tall (Social)',
          };
          const currentShape = imageShape.value;
          imageShape.innerHTML = '';
          caps.shapes.forEach((shapeValue) => {
            const opt = document.createElement('option');
            opt.value = shapeValue;
            opt.textContent = SHAPE_OPTION_LABELS[shapeValue] || shapeValue;
            imageShape.appendChild(opt);
          });
          if (caps.shapes.includes(currentShape)) {
            imageShape.value = currentShape;
          } else {
            imageShape.value = caps.defaultShape || caps.shapes[0];
            window.GenerationState.setSetting('image', 'shape', imageShape.value);
          }
        }

        // Rebuild quality dropdown fully from provider capabilities (no stale options)
        if (caps?.creditsByQuality && imageQuality) {
          const supportedQualities = caps.qualities || ['standard'];
          const currentVal = imageQuality.value;
          const cbq = caps.creditsByQuality;

          // Clear and rebuild all options from scratch
          imageQuality.innerHTML = '';

          supportedQualities.forEach((qualityValue) => {
            const opt = document.createElement('option');
            opt.value = qualityValue;
            if (qualityValue === '4k') {
              opt.textContent = `\u2728 4K Ultra (${cbq[qualityValue] ?? 18}c)`;
            } else if (qualityValue === 'high') {
              opt.textContent = `2K (${cbq[qualityValue] ?? 8}c)`;
            } else {
              opt.textContent = `Standard (${cbq[qualityValue] ?? cbq.standard ?? 4}c)`;
            }
            imageQuality.appendChild(opt);
          });

          imageQuality.disabled = supportedQualities.length <= 1;

          if (supportedQualities.includes(currentVal)) {
            imageQuality.value = currentVal;
          } else {
            imageQuality.value = caps.defaultQuality || supportedQualities[0] || 'standard';
            window.GenerationState.setSetting('image', 'quality', imageQuality.value);
          }

          // Update hint text
          const hintEl = document.getElementById('imageQualityHint');
          if (hintEl) {
            const parts = [];
            if (supportedQualities.includes('standard')) parts.push(`Standard ${cbq.standard ?? snapshot.credits}c`);
            if (supportedQualities.includes('high')) parts.push(`2K ${cbq.high ?? 8}c`);
            if (supportedQualities.includes('4k')) parts.push(`4K ${cbq['4k'] ?? 18}c`);
            if (!parts.length) parts.push(`Standard ${snapshot.credits}c`);
            let hint = parts.join(' \u00b7 ');
            if (caps.creditsByOutputMode?.vector_svg != null) {
              hint += ` \u00b7 SVG ${caps.creditsByOutputMode.vector_svg}c`;
            }
            hintEl.textContent = hint;
          }

          // Premium helper text — only visible for Nano Banana
          const premiumHint = document.getElementById('premiumQualityHint');
          if (premiumHint) {
            if (supportedQualities.includes('4k')) {
              premiumHint.innerHTML = '<i class="fa-solid fa-gem"></i> 4K Ultra offers the highest detail and best final image quality.';
              premiumHint.style.display = '';
            } else {
              premiumHint.innerHTML = '';
              premiumHint.style.display = 'none';
            }
          }
        }

        if (imageOutputMode && imageOutputModeRow) {
          const supportedOutputModes = caps?.outputModes || ['raster'];
          const currentValue = imageOutputMode.value;
          imageOutputMode.innerHTML = '';
          supportedOutputModes.forEach((modeValue) => {
            const opt = document.createElement('option');
            opt.value = modeValue;
            const credits = caps?.creditsByOutputMode?.[modeValue];
            if (modeValue === 'vector_svg') {
              opt.textContent = credits != null ? `SVG Vector (${credits}c)` : 'SVG Vector';
            } else {
              opt.textContent = credits != null ? `Raster (${credits}c)` : 'Raster';
            }
            imageOutputMode.appendChild(opt);
          });
          imageOutputMode.value = supportedOutputModes.includes(currentValue)
            ? currentValue
            : (caps?.defaultOutputMode || supportedOutputModes[0] || 'raster');
          imageOutputMode.disabled = supportedOutputModes.length <= 1;
          imageOutputModeRow.classList.toggle('hidden', supportedOutputModes.length <= 1);
          if (imageOutputModeHint) {
            imageOutputModeHint.classList.toggle('hidden', supportedOutputModes.length <= 1);
            imageOutputModeHint.textContent = supportedOutputModes.includes('vector_svg')
              ? 'Raster works with downstream image tools. SVG is ideal for logos and vector design.'
              : 'Vector output is only available with Recraft V4.';
          }
          if (snapshot.settings?.outputMode !== imageOutputMode.value) {
            window.GenerationState.setSetting('image', 'outputMode', imageOutputMode.value);
          }
        }

        updateImageAdvancedUI();

        // Trigger workspace credits update if available
        if (window.WorkspaceCredits?.updateButtonCosts) {
          window.WorkspaceCredits.updateButtonCosts();
        }
      }

      async function syncEnabledImageProviders() {
        if (!imageAIProvider || !window.TimrXApi?.apiFetch) return;

        try {
          const result = await window.TimrXApi.apiFetch('/api/image/providers');
          if (!result?.ok) return;

          const enabledProviders = Array.isArray(result.data?.enabled_providers)
            ? result.data.enabled_providers.filter(Boolean)
            : [];
          if (!enabledProviders.length) return;

          const enabledSet = new Set(enabledProviders);
          Array.from(imageAIProvider.options).forEach((option) => {
            if (!enabledSet.has(option.value)) {
              option.remove();
            }
          });

          const fallbackProvider = result.data?.default_provider || imageAIProvider.options[0]?.value || null;
          if (!fallbackProvider) return;

          const currentStateProvider = window.GenerationState?.getProvider?.('image');
          const targetProvider = enabledSet.has(currentStateProvider)
            ? currentStateProvider
            : (enabledSet.has(imageAIProvider.value) ? imageAIProvider.value : fallbackProvider);

          if (targetProvider && imageAIProvider.value !== targetProvider) {
            imageAIProvider.value = targetProvider;
          }
          if (targetProvider && currentStateProvider !== targetProvider) {
            window.GenerationState.setProvider('image', targetProvider, 'init');
          }
        } catch (err) {
          console.warn('[Provider UI] Failed to fetch image provider catalog:', err);
        }
      }

      /**
       * Update image options based on selected provider
       * This is the ONLY place that should call GenerationState.setProvider() for images.
       * @param {string} source - 'user' (dropdown change) | 'init' (initial load)
       */
      function updateImageProviderOptions(source = 'user') {
        if (!imageAIProvider) return;

        const provider = imageAIProvider.value || 'nano_banana';
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
          imageAIProvider.value = previousProvider || 'nano_banana';
          console.warn('[Provider UI] Reverted dropdown - provider change was blocked');
        }

        // Provider-specific hints
        const currentProvider = window.GenerationState?.getProvider?.('image') || provider;
        const hint = window.GenerationState?.getProviderCapabilities?.('image', currentProvider)?.hint || '';
        if (imageProviderHint) {
          imageProviderHint.textContent = hint;
          imageProviderHint.style.display = hint ? 'block' : 'none';
        }

        // Update credits display
        syncImageAdvancedFromUI();
        updateImageCreditsDisplay();
        validateImageForm();
      }

      /**
       * Validate image form and enable/disable Generate button
       */
      function validateImageForm() {
        if (!generateImageBtn) return;

        const prompt = imagePrompt?.value?.trim() || '';
        const snapshot = window.GenerationState.getGenerationSnapshot('image');
        const caps = snapshot.capabilities || {};
        const opSpec = getImageOperationSpec(caps, snapshot.settings?.operation || 'generate');
        const requiresPrompt = !['reframe', 'upscale', 'remove_background', 'crisp_upscale', 'creative_upscale', 'erase_region', 'vectorize', 'remix'].includes(snapshot.settings?.operation || 'generate')
          || snapshot.settings?.operation === 'remix';
        const requiresSource = !!opSpec?.requiresSource;
        const requiresMask = !!opSpec?.requiresMask;
        const hasSource = !!snapshot.settings?.sourceImage;
        const hasMask = !!snapshot.settings?.maskImage;
        const isValid = (!requiresPrompt || prompt.length > 0) && (!requiresSource || hasSource) && (!requiresMask || hasMask);

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
        void (async () => {
          await syncEnabledImageProviders();
          const currentProvider = window.GenerationState?.getProvider?.('image');
          const hasCurrentProviderOption = Array.from(imageAIProvider.options).some((opt) => opt.value === currentProvider);
          if (currentProvider && hasCurrentProviderOption && imageAIProvider.value !== currentProvider) {
            imageAIProvider.value = currentProvider;
          }
          updateImageProviderOptions('init');
        })();
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
            const hint = window.GenerationState?.getProviderCapabilities?.('image', newProvider)?.hint || '';
            if (imageProviderHint) {
              imageProviderHint.textContent = hint;
              imageProviderHint.style.display = hint ? 'block' : 'none';
            }
            // Update credits display for new provider
            updateImageCreditsDisplay();
            validateImageForm();
          }
        });
      }

      if (imageOperation) {
        imageOperation.addEventListener('change', () => {
          window.GenerationState.setSetting('image', 'operation', imageOperation.value || 'generate');
          updateImageAdvancedUI();
          updateImageCreditsDisplay();
          validateImageForm();
        });
      }

      if (imageModelVariant) {
        imageModelVariant.addEventListener('change', () => {
          window.GenerationState.setSetting('image', 'modelVariant', imageModelVariant.value || '');
          updateImageAdvancedUI();
          updateImageCreditsDisplay();
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

      if (imageOutputMode) {
        imageOutputMode.addEventListener('change', () => {
          const outputMode = imageOutputMode.value || 'raster';
          window.GenerationState.setSetting('image', 'outputMode', outputMode);
          updateImageCreditsDisplay();
        });
        const initialOutputMode = imageOutputMode.value || 'raster';
        window.GenerationState.setSetting('image', 'outputMode', initialOutputMode);
      }

      const syncFieldsOnInput = [
        imageNegativePrompt, imageRenderingSpeed, imageMagicPrompt, imageStyleType, imageStylePreset, imageStyleName,
        imageStyleId, imageStyleCodes, imageColorPaletteName, imageColorPaletteMembers, imageSeed, imageImageWeight,
        imageStrength, imagePromptUpsampling, imageGuidance, imageSteps, imageSafetyTolerance, imageOutputFormat,
        imageTransparentBackground, imageUpscaleDetail, imageUpscaleResemblance, imageBackgroundColor, imagePreferredColors,
        imageArtisticLevel, imageNoText, imageTextLayout, imageSvgCompression, imageLimitShapes, imageMaxShapes
      ].filter(Boolean);
      syncFieldsOnInput.forEach((el) => {
        el.addEventListener('input', syncImageAdvancedFromUI);
        el.addEventListener('change', () => {
          syncImageAdvancedFromUI();
          updateImageAdvancedUI();
          validateImageForm();
        });
      });

      if (imageStyleName && imageStyleId) {
        imageStyleName.addEventListener('change', () => {
          if (imageStyleName.value) {
            imageStyleId.value = '';
          }
          syncImageAdvancedFromUI();
          updateImageAdvancedUI();
        });

        imageStyleId.addEventListener('input', () => {
          if (imageStyleId.value) {
            imageStyleName.value = '';
          }
          syncImageAdvancedFromUI();
          updateImageAdvancedUI();
        });
      }

      void bindSingleImageUpload(
        imageSourceUpload,
        imageSourceUploadClear,
        'sourceImage',
        'sourceImageName'
      );
      void bindSingleImageUpload(
        imageMaskUpload,
        imageMaskUploadClear,
        'maskImage',
        'maskImageName'
      );
      void bindMultiImageUpload(
        imageReferenceUpload,
        imageReferenceUploadClear,
        'referenceImages',
        'referenceImageNames'
      );
      void bindMultiImageUpload(
        imageStyleReferenceUpload,
        imageStyleReferenceUploadClear,
        'styleReferenceImages',
        'styleReferenceNames'
      );
      void bindSingleImageUpload(
        imageCharacterReferenceUpload,
        imageCharacterReferenceUploadClear,
        'characterReferenceImages',
        'characterReferenceNames'
      );
      void bindSingleImageUpload(
        imageCharacterMaskUpload,
        imageCharacterMaskUploadClear,
        'characterReferenceMasks',
        'characterReferenceMaskNames'
      );

      // Wire up form validation
      if (imagePrompt) {
        imagePrompt.addEventListener('input', () => {
          window.GenerationState.setSetting('image', 'prompt', imagePrompt.value || '');
          validateImageForm();
        });
        window.GenerationState.setSetting('image', 'prompt', imagePrompt.value || '');
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

      const textureStyleImageUpload = leftStack.querySelector('#textureStyleImageUpload');
      const textureStyleImageStatus = leftStack.querySelector('#textureStyleImageStatus');
      const textureStyleImageClear = leftStack.querySelector('#textureStyleImageClear');
      const textureStyleImagePreview = leftStack.querySelector('#textureStyleImagePreview');
      const textureStyleImageUrl = leftStack.querySelector('#textureStyleImageUrl');
      const textureAiModel = leftStack.querySelector('#textureAiModel');
      const textureResolution = leftStack.querySelector('#textureResolution');
      const textureRemoveLighting = leftStack.querySelector('#textureRemoveLighting');
      const textureRemoveLightingNote = leftStack.querySelector('#textureRemoveLightingNote');

      const syncTextureStylePreview = () => {
        const file = textureStyleImageUpload?.files?.[0] || null;
        if (textureStyleImageStatus) {
          textureStyleImageStatus.textContent = file
            ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)`
            : 'Optional JPG or PNG reference';
          textureStyleImageStatus.classList.toggle('is-empty', !file);
        }
        if (textureStyleImageClear) {
          textureStyleImageClear.classList.toggle('hidden', !file);
        }
        if (!textureStyleImagePreview) return;
        if (!file) {
          textureStyleImagePreview.classList.add('hidden');
          textureStyleImagePreview.innerHTML = '';
          return;
        }
        const objectUrl = URL.createObjectURL(file);
        textureStyleImagePreview.innerHTML = `
          <figure class="image-upload-preview">
            <img class="image-upload-preview__image" src="${objectUrl}" alt="Texture style reference preview" width="280" height="280" loading="lazy" decoding="async">
            <figcaption class="image-upload-preview__caption">${file.name}</figcaption>
          </figure>
        `;
        textureStyleImagePreview.classList.remove('hidden');
        const img = textureStyleImagePreview.querySelector('img');
        if (img) {
          img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
          img.addEventListener('error', () => URL.revokeObjectURL(objectUrl), { once: true });
        }
      };

      if (textureStyleImageUpload) {
        textureStyleImageUpload.addEventListener('change', () => {
          if (textureStyleImageUpload.files?.[0] && textureStyleImageUrl) {
            textureStyleImageUrl.value = '';
          }
          syncTextureStylePreview();
        });
      }
      if (textureStyleImageClear) {
        textureStyleImageClear.addEventListener('click', () => {
          if (textureStyleImageUpload) textureStyleImageUpload.value = '';
          syncTextureStylePreview();
        });
      }

      // ── Retexture multiview style views (Meshy 7 / latest only) ──
      const textureMultiviewBlock = leftStack.querySelector('#textureMultiviewBlock');
      const textureMultiviewGrid = leftStack.querySelector('#textureMultiviewGrid');
      const textureMultiviewUrls = leftStack.querySelector('#textureMultiviewUrls');
      const textureMultiviewCount = leftStack.querySelector('#textureMultiviewCount');

      const countMultiviewImages = () => {
        const slotted = textureMultiviewGrid
          ? Array.from(textureMultiviewGrid.querySelectorAll('.multi-img-preview'))
              .filter((img) => img.style.display !== 'none' && img.src).length
          : 0;
        const pasted = (textureMultiviewUrls?.value || '')
          .split(/[\s,]+/).map((v) => v.trim()).filter(Boolean).length;
        return Math.min(4, slotted + pasted);
      };

      const syncTextureMultiviewCount = () => {
        if (textureMultiviewCount) {
          textureMultiviewCount.textContent = `${countMultiviewImages()} / 4 style views selected`;
        }
      };

      if (textureMultiviewGrid) {
        textureMultiviewGrid.querySelectorAll('.multi-img-slot').forEach((slot) => {
          const dropZone = slot.querySelector('.video-drop-zone');
          const fileInput = slot.querySelector('.multi-img-input');
          const preview = slot.querySelector('.multi-img-preview');
          if (!dropZone || !fileInput || !preview) return;

          dropZone.addEventListener('click', () => fileInput.click());
          fileInput.addEventListener('change', async function () {
            if (!this.files || !this.files[0]) return;
            try {
              preview.src = await readFileAsDataUrl(this.files[0]);
              preview.style.display = 'block';
              dropZone.style.display = 'none';
            } catch (err) {
              console.warn('[Texture] Invalid multiview style image:', err);
              this.value = '';
              preview.style.display = 'none';
              preview.src = '';
              dropZone.style.display = '';
              showImageUploadError(err?.message || 'Invalid image file.');
            }
            syncTextureMultiviewCount();
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
          // Click a filled slot to clear it
          preview.addEventListener('click', () => {
            preview.style.display = 'none';
            preview.src = '';
            dropZone.style.display = '';
            fileInput.value = '';
            syncTextureMultiviewCount();
          });
        });
      }
      textureMultiviewUrls?.addEventListener('input', syncTextureMultiviewCount);
      syncTextureMultiviewCount();

      const syncTextureLightingSupport = () => {
        if (!textureAiModel) return;
        const isMeshy5 = textureAiModel.value === 'meshy-5';
        const supportsRemoveLighting = textureAiModel.value === 'meshy-6';
        // Meshy documents multiview_image_urls for meshy-7 / latest only.
        const supportsMultiview = ['latest', 'meshy-7'].includes(textureAiModel.value);
        if (textureMultiviewBlock) {
          textureMultiviewBlock.style.display = supportsMultiview ? '' : 'none';
        }
        if (textureRemoveLighting) {
          textureRemoveLighting.disabled = !supportsRemoveLighting;
          if (!supportsRemoveLighting) textureRemoveLighting.checked = false;
        }
        if (textureResolution) {
          textureResolution.querySelectorAll('option').forEach((option) => {
            option.disabled = isMeshy5 && (option.value === '4k' || option.value === '8k');
          });
          if (isMeshy5 && (textureResolution.value === '4k' || textureResolution.value === '8k')) {
            textureResolution.value = '2k';
          }
        }
        if (textureRemoveLightingNote) {
          textureRemoveLightingNote.textContent = supportsRemoveLighting
            ? 'Cleaner base color textures for custom lighting setups. Only available on Meshy 6.'
            : 'Remove Lighting is only available on Meshy 6 and will stay off for this model.';
        }
      };

      if (textureAiModel) {
        textureAiModel.addEventListener('change', syncTextureLightingSupport);
        textureResolution?.addEventListener('change', syncTextureLightingSupport);
        syncTextureLightingSupport();
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

      // ─── Rig Wizard: preflight → alignment → submit ───
      const rigPreflightCard = leftStack.querySelector('#rigPreflightCard');
      const rigStep1 = leftStack.querySelector('#rigWizardStep1');
      const rigStep2 = leftStack.querySelector('#rigWizardStep2');

      // Preflight button — runs backend check, then shows alignment step
      const rigPreflightBtn = leftStack.querySelector('#rigPreflightBtn');
      if (rigPreflightBtn) {
        rigPreflightBtn.addEventListener('click', async () => {
          rigPreflightBtn.disabled = true;
          rigPreflightBtn.textContent = 'Checking...';
          try {
            await window._runRigPreflight?.();
          } finally {
            rigPreflightBtn.disabled = false;
            rigPreflightBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass-chart" style="font-size:10px;margin-right:4px"></i> Check Model Readiness';
          }
        });
      }

      // Remesh CTA in preflight card
      const rigRemeshCTA = leftStack.querySelector('#rigRemeshCTA');
      if (rigRemeshCTA) {
        rigRemeshCTA.addEventListener('click', () => {
          // Switch to remesh panel
          const remeshBtn = document.querySelector('.rail-btn[data-panel="remesh"]');
          if (remeshBtn) remeshBtn.click();
        });
      }

      // If rig state says preflight was already done and passed, show steps
      if (_timrxRigState.preflight_done && _timrxRigState.is_riggable !== false) {
        if (rigStep1) rigStep1.style.display = '';
        if (rigStep2) rigStep2.style.display = '';
      }

      // Rig upload toggle
      const rigModelSelect   = leftStack.querySelector('#rigModelSelect');
      const rigUploadSection = leftStack.querySelector('#rigModelUploadSection');
      const rigModelDrop     = leftStack.querySelector('#rigModelDrop');
      const rigModelUpload   = leftStack.querySelector('#rigModelUpload');
      const rigModelFileName = leftStack.querySelector('#rigModelFileName');
      const rigTextureImageUpload = leftStack.querySelector('#rigTextureImageUpload');
      const rigTextureImageUrl = leftStack.querySelector('#rigTextureImageUrl');
      const rigTextureImageStatus = leftStack.querySelector('#rigTextureImageStatus');
      const rigTextureImageClear = leftStack.querySelector('#rigTextureImageClear');
      const rigTextureImagePreview = leftStack.querySelector('#rigTextureImagePreview');

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

      const syncRigTexturePreview = () => {
        const file = rigTextureImageUpload?.files?.[0] || null;
        if (rigTextureImageStatus) {
          rigTextureImageStatus.textContent = file
            ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)`
            : 'Optional PNG for UV-based base color guidance';
          rigTextureImageStatus.classList.toggle('is-empty', !file);
        }
        if (rigTextureImageClear) rigTextureImageClear.classList.toggle('hidden', !file);
        if (!rigTextureImagePreview) return;
        if (!file) {
          rigTextureImagePreview.classList.add('hidden');
          rigTextureImagePreview.innerHTML = '';
          return;
        }
        const objectUrl = URL.createObjectURL(file);
        rigTextureImagePreview.innerHTML = `
          <figure class="image-upload-preview">
            <img class="image-upload-preview__image" src="${objectUrl}" alt="Rig texture preview" width="280" height="280" loading="lazy" decoding="async">
            <figcaption class="image-upload-preview__caption">${file.name}</figcaption>
          </figure>
        `;
        rigTextureImagePreview.classList.remove('hidden');
        const img = rigTextureImagePreview.querySelector('img');
        if (img) {
          img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
          img.addEventListener('error', () => URL.revokeObjectURL(objectUrl), { once: true });
        }
      };

      if (rigTextureImageUpload) {
        rigTextureImageUpload.addEventListener('change', () => {
          if (rigTextureImageUpload.files?.[0] && rigTextureImageUrl) rigTextureImageUrl.value = '';
          syncRigTexturePreview();
        });
      }
      if (rigTextureImageClear) {
        rigTextureImageClear.addEventListener('click', () => {
          if (rigTextureImageUpload) rigTextureImageUpload.value = '';
          syncRigTexturePreview();
        });
      }

      // ─── "Go to Animate" button in rig results ───
      const goToAnimateBtn = leftStack.querySelector('#goToAnimateBtn');
      if (goToAnimateBtn) {
        goToAnimateBtn.addEventListener('click', () => {
          // Switch to animate panel via rail button click
          const animRailBtn = document.querySelector('.rail-btn[data-panel="animate"]');
          if (animRailBtn) animRailBtn.click();
        });
      }

      // ─── ANIMATE panel: model card, library, apply ───
      _wireAnimatePanel();
      // Expose animation library loader globally so _handleRigComplete can trigger it.
      window._loadAnimLibrary = _loadAnimLibraryGlobal;
      window._renderAnimLibrary = _renderAnimLibraryInPanel;

      // Remesh preset cards
      const remeshPresetsWrap = leftStack.querySelector('#remeshPresets');
      const remeshAdvancedToggle = leftStack.querySelector('#remeshAdvancedToggle');
      const remeshAdvanced = leftStack.querySelector('#remeshAdvanced');
      const remeshFormatContainer = leftStack.querySelector('#remeshTargetFormats');
      const remeshConvertFormatOnly = leftStack.querySelector('#remeshConvertFormatOnly');
      const remeshResizeHeight = leftStack.querySelector('#remeshResizeHeight');
      const remeshOriginAt = leftStack.querySelector('#remeshOriginAt');
      const remeshPolyInput = leftStack.querySelector('#targetPolyCount');

      const syncRemeshPresetDefaults = (card) => {
        if (!card) return;
        if (remeshPolyInput) remeshPolyInput.value = card.dataset.poly || '50000';
        if (remeshFormatContainer) {
          const stlInput = remeshFormatContainer.querySelector('input[value="stl"]');
          const printPresets = ['print-ready', 'miniature', 'high-detail'];
          if (stlInput) stlInput.checked = printPresets.includes(card.dataset.preset);
        }
      };

      const syncRemeshAdvancedState = () => {
        const convertOnly = !!remeshConvertFormatOnly?.checked;
        [remeshPolyInput, remeshResizeHeight, remeshOriginAt].forEach((el) => {
          if (!el) return;
          el.disabled = convertOnly;
        });
        // Format Only routes to Meshy Convert (1 credit), not Remesh (5).
        const action = convertOnly ? 'convert' : 'remesh';
        const fallbackCost = convertOnly ? 1 : 5;
        const cost = window.WorkspaceCredits?.getActionCost?.(action) || fallbackCost;
        const actionLabel = convertOnly ? 'Convert' : 'Remesh';
        const remeshCredits = leftStack.querySelector('#remeshCreditsDisplay');
        const applyRemeshBtn = leftStack.querySelector('#applyRemeshBtn');
        if (remeshCredits) remeshCredits.innerHTML = `<i class="fa-solid fa-coins"></i> ${cost}`;
        if (applyRemeshBtn) {
          // Tells the credits module which action to price this button with,
          // so a later cost refresh doesn't restore the remesh cost.
          applyRemeshBtn.dataset.currentAction = action;
          applyRemeshBtn.title = `${cost} credits`;
          const costBadge = applyRemeshBtn.querySelector('.btn-cost-badge');
          if (costBadge) costBadge.textContent = `${cost} cr`;
          const textNode = Array.from(applyRemeshBtn.childNodes)
            .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
          if (textNode) textNode.textContent = `\n            ${actionLabel} `;
        }
        window.WorkspaceCredits?.updateButtonCosts?.();
      };

      if (remeshPresetsWrap) {
        remeshPresetsWrap.addEventListener('click', (e) => {
          const card = e.target.closest('.remesh-preset');
          if (!card) return;
          remeshPresetsWrap.querySelectorAll('.remesh-preset').forEach(c => c.classList.remove('is-active'));
          card.classList.add('is-active');
          syncRemeshPresetDefaults(card);
        });

        const initialPreset = remeshPresetsWrap.querySelector('.remesh-preset.is-active') || remeshPresetsWrap.querySelector('.remesh-preset');
        syncRemeshPresetDefaults(initialPreset);
      }

      // ── Update remesh model-state label when active item changes ────
      const updateRemeshStateLabel = () => {
        const label = document.getElementById('remeshModelStateLabel');
        if (!label) return;
        const item = window.getActiveHistoryItem?.();
        if (!item) { label.textContent = 'No model loaded'; return; }
        const stage = String(item.stage || item.payload?.stage || '').toLowerCase();
        const stageMap = {
          preview: 'Preview mesh \u2014 Refine first for best print results',
          refine: 'Refined mesh \u2014 good base for remeshing',
          retexture: 'Retextured mesh \u2014 remesh after texture changes',
          remesh: 'Already remeshed \u2014 re-remesh only if settings need changing',
          image3d: 'Image-to-3D mesh \u2014 remeshing recommended before print',
        };
        label.textContent = stageMap[stage] || ('Stage: ' + (stage || 'unknown'));
      };
      // Run once now and again whenever the user switches rail panels
      // (the leftStack innerHTML is replaced, so re-query each time via ID)
      updateRemeshStateLabel();
      window._updateRemeshStateLabel = updateRemeshStateLabel;

      if (remeshAdvancedToggle && remeshAdvanced) {
        remeshAdvancedToggle.addEventListener('click', () => {
          const collapsed = remeshAdvanced.classList.toggle('remesh-advanced--collapsed');
          remeshAdvancedToggle.classList.toggle('is-open', !collapsed);
        });
      }

      if (remeshConvertFormatOnly) {
        remeshConvertFormatOnly.addEventListener('change', syncRemeshAdvancedState);
        syncRemeshAdvancedState();
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

      const aiModelSelect = leftStack.querySelector('#modelAIModel');
      const modelTypeSelect = leftStack.querySelector('#modelModelType');
      const modelShouldRemesh = leftStack.querySelector('#modelShouldRemesh');
      const modelRemeshSettings = leftStack.querySelector('#modelRemeshSettings');
      const modelDecimationMode = leftStack.querySelector('#modelDecimationMode');
      const modelTargetPolycount = leftStack.querySelector('#modelTargetPolycount');
      const modelModeration = leftStack.querySelector('#modelModeration');
      const modelAutoSize = leftStack.querySelector('#modelAutoSize');
      const modelAutoSizeSettings = leftStack.querySelector('#modelAutoSizeSettings');
      const modelOriginAt = leftStack.querySelector('#modelOriginAt');
      const modelPreviewAdvancedNote = leftStack.querySelector('#modelPreviewAdvancedNote');
      const modelTextureResolution = leftStack.querySelector('#modelTextureResolution');
      const modelUltraMode = leftStack.querySelector('#modelUltraMode');
      const modelAlphaThumbnail = leftStack.querySelector('#modelAlphaThumbnail');
      const modelMultiViewThumbnails = leftStack.querySelector('#modelMultiViewThumbnails');

      const syncPreviewAdvancedControls = () => {
        const isLowPoly = (modelTypeSelect?.value || '').toLowerCase() === 'lowpoly';
        if (modelShouldRemesh) {
          if (isLowPoly) modelShouldRemesh.checked = false;
          modelShouldRemesh.disabled = isLowPoly;
        }

        const remeshEnabled = !!modelShouldRemesh?.checked && !isLowPoly;
        if (modelRemeshSettings) {
          modelRemeshSettings.style.display = remeshEnabled ? 'grid' : 'none';
          modelRemeshSettings.querySelectorAll('input, select').forEach((el) => {
            el.disabled = !remeshEnabled;
          });
        }

        // Adaptive decimation replaces the manual polycount — Meshy ignores
        // target_polycount whenever decimation_mode is set.
        const decimationActive = remeshEnabled && !!modelDecimationMode?.value;
        if (modelTargetPolycount) {
          modelTargetPolycount.disabled = !remeshEnabled || decimationActive;
          modelTargetPolycount.title = decimationActive
            ? 'Ignored while adaptive decimation is selected'
            : '';
        }

        const autoSizeEnabled = !!modelAutoSize?.checked;
        if (modelAutoSizeSettings) {
          modelAutoSizeSettings.style.display = autoSizeEnabled ? 'grid' : 'none';
          modelAutoSizeSettings.querySelectorAll('input, select').forEach((el) => {
            el.disabled = !autoSizeEnabled;
          });
        }
        if (autoSizeEnabled && modelOriginAt && !modelOriginAt.value) {
          modelOriginAt.value = 'bottom';
        }

        if (modelPreviewAdvancedNote) {
          if (isLowPoly) {
            modelPreviewAdvancedNote.textContent = 'Low Poly preview ignores Meshy remesh controls and returns simplified geometry directly.';
          } else if (decimationActive) {
            modelPreviewAdvancedNote.textContent = 'Adaptive decimation lets Meshy choose the polycount for this level, so Target Polycount is ignored.';
          } else if (remeshEnabled) {
            modelPreviewAdvancedNote.textContent = 'Auto-remesh lets preview honor topology and target polycount before the refine stage.';
          } else {
            modelPreviewAdvancedNote.textContent = 'Turn on auto-remesh if you want Meshy preview to honor topology and target polycount.';
          }
        }
      };

      const syncAllModelControls = () => {
        syncPreviewAdvancedControls();
        syncModelGenerationControls();
      };
      aiModelSelect?.addEventListener('change', syncAllModelControls);
      modelTypeSelect?.addEventListener('change', syncAllModelControls);
      modelShouldRemesh?.addEventListener('change', syncAllModelControls);
      modelDecimationMode?.addEventListener('change', syncAllModelControls);
      modelAutoSize?.addEventListener('change', syncAllModelControls);
      modelModeration?.addEventListener('change', syncAllModelControls);
      modelTextureResolution?.addEventListener('change', syncAllModelControls);
      modelUltraMode?.addEventListener('change', syncAllModelControls);
      modelAlphaThumbnail?.addEventListener('change', syncAllModelControls);
      modelMultiViewThumbnails?.addEventListener('change', syncAllModelControls);
      syncPreviewAdvancedControls();
      syncModelGenerationControls();

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
      /* Relocated 2026-08-11: these previously ran at IIFE parse time, before
         bootstrapInitialPanel() injected any panel — both queries returned
         null, so the enhance provider hint never updated and Re-roll was
         permanently inert. Re-bound on every panel render. */
    var _providerSelect = leftStack.querySelector('#videoAIProvider');
    if (_providerSelect) {
      _providerSelect.addEventListener('change', updateEnhanceProviderHint);
      // Set initial hint
      updateEnhanceProviderHint();
    }
    var _rerollBtn = leftStack.querySelector('#enhanceRerollBtn');
    if (_rerollBtn) {
      _rerollBtn.addEventListener('click', function(e) {
        e.preventDefault();
        // Find the video enhance button and trigger enhance again
        var enhanceBtn = leftStack.querySelector('.enhance-btn[data-enhance-mode="video"]');
        if (enhanceBtn) enhanceBtn.click();
      });
    }

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
          // Mode follows the image count, same rule the rest of the panel uses.
          const imageCount = (window.VideoImageRefs || []).length;
          enhanceMode = imageCount >= 2 ? 'image_transition' : 'animate_image';
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
/* moved into initPromptEnhanceButtons() 2026-08-11 — bound at parse time this
       queried an empty #leftStack and never fired */

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
/* moved into initPromptEnhanceButtons() 2026-08-11 */

    /* -----------------------------------------------------------------------
     * ANIMATE PANEL: persistent library + model card wiring
     * The animation library is loaded ONCE and cached in module scope so it
     * survives tab switches (the DOM is rebuilt each time, but data persists).
     * --------------------------------------------------------------------- */
    let _animLibrary = [];
    let _animLibraryLoaded = false;

    // Quick-animation presets (subset of library for one-click access)
    const QUICK_ANIMS = [
      { label: 'Idle', search: 'idle' },
      { label: 'Walk', search: 'walk' },
      { label: 'Run', search: 'run' },
      { label: 'Jump', search: 'jump' },
      { label: 'Punch', search: 'punch' },
      { label: 'Dance', search: 'dance' },
    ];

    async function _loadAnimLibraryGlobal() {
      if (_animLibraryLoaded) return;
      console.log('[AnimLibrary] Loading animation library...');
      try {
        const result = await window.TimrXApi.apiFetch('/api/_mod/rig/animations/library');
        console.log('[AnimLibrary] Fetch result: ok=' + result.ok + ' items=' + (result.data?.items?.length ?? 0));
        if (result.ok && result.data?.items) {
          _animLibrary = result.data.items;
          _animLibraryLoaded = true;
          _renderAnimLibraryInPanel();
          _renderQuickAnims();
        } else {
          console.warn('[AnimLibrary] Bad response:', result.status, result.error);
        }
      } catch (e) {
        console.warn('[AnimLibrary] Failed to load:', e);
      }
    }

    function _renderAnimLibraryInPanel() {
      const animGrid = leftStack.querySelector('#animLibraryGrid2');
      if (!animGrid) return; // animate panel not currently mounted
      const animSearch = leftStack.querySelector('#animLibrarySearch2');
      const animCategory = leftStack.querySelector('#animLibraryCategory2');
      const animEmpty = leftStack.querySelector('#animLibraryEmpty2');
      const animActionIdInput = leftStack.querySelector('#animActionId2');
      const applyAnimBtn = leftStack.querySelector('#applyAnimationBtn2');

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

        // Restore selection from persistent state
        const selectedId = _timrxAnimState.selected_action_id;
        if (selectedId != null && String(anim.action_id) === String(selectedId)) {
          card.style.borderColor = 'rgba(100,180,255,.5)';
          card.style.background = 'rgba(100,180,255,.08)';
        }

        card.addEventListener('click', () => {
          animGrid.querySelectorAll('.anim-lib-card').forEach(c => {
            c.style.borderColor = 'rgba(255,255,255,.08)';
            c.style.background = 'rgba(255,255,255,.03)';
          });
          card.style.borderColor = 'rgba(100,180,255,.5)';
          card.style.background = 'rgba(100,180,255,.08)';
          if (animActionIdInput) animActionIdInput.value = anim.action_id;
          // Persist in state
          _timrxAnimState.selected_action_id = anim.action_id;
          _timrxAnimState.selected_animation = anim;
          if (applyAnimBtn && _timrxAnimState.is_rigged) {
            applyAnimBtn.classList.remove('anim-btn-inactive');
          }
        });

        animGrid.appendChild(card);
      });
    }

    function _renderQuickAnims() {
      const container = leftStack.querySelector('#animQuickChips');
      if (!container) return;
      container.innerHTML = '';
      QUICK_ANIMS.forEach(qa => {
        const match = _animLibrary.find(a =>
          a.enabled !== false && (a.name || '').toLowerCase().includes(qa.search)
        );
        if (!match) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'material-chip';
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:6px 12px;font-size:12px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#ccc;transition:all .15s';
        chip.textContent = qa.label;
        chip.dataset.actionId = match.action_id;
        chip.addEventListener('click', () => {
          // Select this animation in state
          _timrxAnimState.selected_action_id = match.action_id;
          _timrxAnimState.selected_animation = match;
          // Update hidden input + enable button
          const actionInput = leftStack.querySelector('#animActionId2');
          const applyBtn = leftStack.querySelector('#applyAnimationBtn2');
          if (actionInput) actionInput.value = match.action_id;
          if (applyBtn && _timrxAnimState.is_rigged) applyBtn.classList.remove('anim-btn-inactive');
          // Visual feedback on quick chips
          container.querySelectorAll('.material-chip').forEach(c => {
            c.style.borderColor = 'rgba(255,255,255,.1)';
            c.style.background = 'rgba(255,255,255,.04)';
          });
          chip.style.borderColor = 'rgba(100,180,255,.5)';
          chip.style.background = 'rgba(100,180,255,.08)';
          // Also highlight in library grid if visible
          _renderAnimLibraryInPanel();
        });
        container.appendChild(chip);
      });
    }

    /** Sync the animate panel UI with current _timrxAnimState */
    function _syncAnimatePanelUI() {
      const modelInfo = leftStack.querySelector('#animModelInfo');
      const modelEmpty = leftStack.querySelector('#animModelEmpty');
      const notRiggedWarning = leftStack.querySelector('#animNotRiggedWarning');
      const quickSection = leftStack.querySelector('#animQuickSection');
      const librarySection = leftStack.querySelector('#animLibrarySection');
      const applyBtn = leftStack.querySelector('#applyAnimationBtn2');
      const thumbEl = leftStack.querySelector('#animModelThumb');
      const titleEl = leftStack.querySelector('#animModelTitle');
      const badgeEl = leftStack.querySelector('#animModelBadge');

      const hasModel = !!(_timrxAnimState.rig_task_id || _timrxAnimState.model_url);

      console.log('[Animate] syncUI: hasModel=' + hasModel + ' is_rigged=' + _timrxAnimState.is_rigged + ' rig_task_id=' + (_timrxAnimState.rig_task_id || 'none') + ' selected_action=' + (_timrxAnimState.selected_action_id || 'none') + ' applyBtn=' + (applyBtn ? 'found' : 'missing'));

      if (hasModel) {
        if (modelInfo) modelInfo.style.display = '';
        if (modelEmpty) modelEmpty.style.display = 'none';
        if (titleEl) titleEl.textContent = _timrxAnimState.title || 'Rigged Model';
        if (thumbEl && _timrxAnimState.thumbnail_url) {
          thumbEl.src = _timrxAnimState.thumbnail_url;
          thumbEl.style.display = '';
        } else if (thumbEl) {
          thumbEl.style.display = 'none';
        }
        if (_timrxAnimState.is_rigged) {
          if (badgeEl) { badgeEl.textContent = 'Rigged model loaded'; badgeEl.style.color = '#50c878'; badgeEl.style.background = 'rgba(80,200,120,.12)'; }
          if (notRiggedWarning) notRiggedWarning.style.display = 'none';
          if (quickSection) quickSection.style.display = '';
          if (librarySection) librarySection.style.display = '';
          if (applyBtn) applyBtn.classList.toggle('anim-btn-inactive', !_timrxAnimState.selected_action_id);
        } else {
          if (badgeEl) { badgeEl.textContent = 'Not rigged'; badgeEl.style.color = '#cca030'; badgeEl.style.background = 'rgba(255,200,50,.08)'; }
          if (notRiggedWarning) notRiggedWarning.style.display = '';
          if (quickSection) quickSection.style.display = 'none';
          if (librarySection) librarySection.style.display = 'none';
          if (applyBtn) applyBtn.classList.add('anim-btn-inactive');
        }
      } else {
        if (modelInfo) modelInfo.style.display = 'none';
        if (modelEmpty) modelEmpty.style.display = '';
        if (notRiggedWarning) notRiggedWarning.style.display = 'none';
        if (quickSection) quickSection.style.display = 'none';
        if (librarySection) librarySection.style.display = 'none';
        if (applyBtn) applyBtn.classList.add('anim-btn-inactive');
      }
    }

    /** Simple toast/alert fallback — uses showToast if available, else alert */
    function _toast(msg) {
      if (window.showToast) { window.showToast(msg, 'info'); return; }
      // Inline toast: create a temporary notification div
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,.95);color:#e0e0e0;padding:10px 20px;border-radius:8px;font-size:13px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:400px;text-align:center;animation:fadeIn .2s ease';
      document.body.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 400); }, 3500);
    }

    /** Read history items from the canonical localStorage cache.
     *  state.js uses 'meshy_history_cache' — must match exactly. */
    function _getHistoryFromCache() {
      try {
        const raw = localStorage.getItem('meshy_history_cache');
        if (!raw) return [];
        const items = JSON.parse(raw);
        return Array.isArray(items) ? items : [];
      } catch (e) {
        console.warn('[Animate] Failed to read history cache:', e);
        return [];
      }
    }

    /** Check if a history item is a finished rigged model */
    function _isRiggedItem(it) {
      if (it.status !== 'finished') return false;
      const stage = (it.stage || '').toLowerCase();
      if (stage === 'rig') return true;
      // Also check payload.stage for DB-synced items
      const payloadStage = (it.payload?.stage || '').toLowerCase();
      return payloadStage === 'rig';
    }

    /** Find the most recent rigged model from history */
    function _findLatestRiggedFromHistory() {
      const items = _getHistoryFromCache();
      const rigged = items.filter(_isRiggedItem)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      console.log('[Animate] findLatest: total=' + items.length + ' rigged=' + rigged.length);
      return rigged[0] || null;
    }

    /** Find ALL rigged models from history */
    function _findAllRiggedFromHistory() {
      const items = _getHistoryFromCache();
      const rigged = items.filter(_isRiggedItem)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      console.log('[Animate] findAll: total=' + items.length + ' rigged=' + rigged.length);
      return rigged;
    }

    /** Show a picker modal/dropdown for rigged models from history */
    function _showRiggedModelPicker(items) {
      // Remove existing picker if any
      const existing = document.getElementById('riggedModelPicker');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'riggedModelPicker';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;display:flex;align-items:center;justify-content:center';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      const panel = document.createElement('div');
      panel.style.cssText = 'background:#1a1a1a;border-radius:12px;padding:20px;max-width:400px;width:90%;max-height:60vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,.5)';

      const title = document.createElement('h3');
      title.textContent = 'Select Rigged Model';
      title.style.cssText = 'margin:0 0 12px;font-size:14px;color:#e0e0e0';
      panel.appendChild(title);

      items.slice(0, 20).forEach(item => {
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.03);color:#ccc;font-size:12px;cursor:pointer;margin-bottom:6px;text-align:left;transition:background .15s';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(100,180,255,.08)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'rgba(255,255,255,.03)'; });

        if (item.thumbnail_url) {
          const thumb = document.createElement('img');
          thumb.src = item.thumbnail_url;
          thumb.style.cssText = 'width:40px;height:40px;border-radius:6px;object-fit:cover;background:#222;flex-shrink:0';
          thumb.onerror = () => { thumb.style.display = 'none'; };
          row.appendChild(thumb);
        }

        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;overflow:hidden';
        const nameEl = document.createElement('div');
        nameEl.textContent = item.title || item.prompt || 'Rigged Model';
        nameEl.style.cssText = 'font-weight:500;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        const dateEl = document.createElement('div');
        const d = item.created_at ? new Date(item.created_at) : null;
        dateEl.textContent = d ? d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
        dateEl.style.cssText = 'font-size:10px;color:#666;margin-top:2px';
        info.appendChild(nameEl);
        info.appendChild(dateEl);
        row.appendChild(info);

        row.addEventListener('click', () => {
          _timrxAnimState.source_type = 'history';
          _timrxAnimState.rig_task_id = item.id;
          _timrxAnimState.model_id = item.id;
          _timrxAnimState.is_rigged = true;
          _timrxAnimState.title = item.title || item.prompt || 'Rigged Model';
          _timrxAnimState.model_url = item.glb_url || item.glb_proxy || null;
          _timrxAnimState.thumbnail_url = item.thumbnail_url || null;
          overlay.remove();
          _syncAnimatePanelUI();
          _loadAnimLibraryGlobal();
          // Load in viewer
          if (_timrxAnimState.model_url && window.TimrXViewer?.loadModelWithFallback) {
            const proxy = window.TimrXApi?.getLoadableModelUrl?.(_timrxAnimState.model_url) || _timrxAnimState.model_url;
            window.TimrXViewer.loadModelWithFallback(proxy, _timrxAnimState.model_url).catch(() => {});
          }
        });

        panel.appendChild(row);
      });

      if (items.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No rigged models found in history.';
        empty.style.cssText = 'color:#666;font-size:12px;text-align:center;padding:20px 0';
        panel.appendChild(empty);
      }

      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    }

    /** Wire all interactive elements inside the animate panel */
    function _wireAnimatePanel() {
      // Model card buttons
      const previewBtn = leftStack.querySelector('#animPreviewBtn');
      const clearBtn = leftStack.querySelector('#animClearBtn');
      const loadLatestBtn = leftStack.querySelector('#animLoadLatestBtn');
      const fromHistoryBtn = leftStack.querySelector('#animFromHistoryBtn');
      const reanimateBtn = leftStack.querySelector('#animReanimateBtn');
      const animAdvancedToggle = leftStack.querySelector('#animAdvancedToggle');
      const animAdvanced = leftStack.querySelector('#animAdvanced');
      const animPostProcessType = leftStack.querySelector('#animPostProcessType');
      const animTargetFpsRow = leftStack.querySelector('#animTargetFpsRow');
      const animPostProcessNote = leftStack.querySelector('#animPostProcessNote');

      const syncAnimPostProcessState = () => {
        const type = animPostProcessType?.value || '';
        if (animTargetFpsRow) animTargetFpsRow.style.display = type === 'change_fps' ? '' : 'none';
        if (animPostProcessNote) {
          animPostProcessNote.textContent = type === 'change_fps'
            ? 'Meshy keeps the base GLB / FBX outputs and adds one extra FPS-adjusted FBX variant.'
            : type === 'fbx2usdz'
              ? 'Meshy keeps the base GLB / FBX outputs and adds one USDZ conversion for AR / Apple preview.'
              : type === 'extract_armature'
                ? 'Meshy keeps the base GLB / FBX outputs and adds an armature-only FBX for downstream DCC work.'
                : 'Keep the default GLB / FBX animation outputs, or ask Meshy for one extra processed derivative per run.';
        }
      };

      if (animAdvancedToggle && animAdvanced) {
        animAdvancedToggle.addEventListener('click', () => {
          const collapsed = animAdvanced.classList.toggle('remesh-advanced--collapsed');
          animAdvancedToggle.classList.toggle('is-open', !collapsed);
        });
      }
      if (animPostProcessType) {
        if (_timrxAnimState.post_process_type) {
          animPostProcessType.value = _timrxAnimState.post_process_type;
        }
        animPostProcessType.addEventListener('change', () => {
          _timrxAnimState.post_process_type = animPostProcessType.value || '';
          syncAnimPostProcessState();
        });
      }
      const animTargetFps = leftStack.querySelector('#animTargetFps');
      if (animTargetFps) {
        if (_timrxAnimState.target_fps) {
          animTargetFps.value = String(_timrxAnimState.target_fps);
        }
        animTargetFps.addEventListener('change', () => {
          _timrxAnimState.target_fps = animTargetFps.value || '30';
        });
      }
      if (animPostProcessType) {
        syncAnimPostProcessState();
      }

      if (previewBtn) {
        previewBtn.addEventListener('click', () => {
          const url = _timrxAnimState.model_url;
          if (url && window.TimrXViewer?.loadModelWithFallback) {
            const proxy = window.TimrXApi?.getLoadableModelUrl?.(url) || url;
            window.TimrXViewer.loadModelWithFallback(proxy, url).catch(err => {
              console.warn('[Animate] Preview failed:', err);
            });
          }
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          Object.assign(_timrxAnimState, {
            source_type: null, model_id: null, rig_task_id: null,
            model_url: null, title: '', thumbnail_url: null,
            is_rigged: false, selected_action_id: null, selected_animation: null,
          });
          _syncAnimatePanelUI();
        });
      }

      if (loadLatestBtn) {
        loadLatestBtn.addEventListener('click', () => {
          // Try session-level state first (set by _handleRigComplete)
          if (window._lastRigTaskId) {
            _timrxAnimState.source_type = 'rig';
            _timrxAnimState.rig_task_id = window._lastRigTaskId;
            _timrxAnimState.is_rigged = true;
            _timrxAnimState.title = window._lastRigTitle || 'Latest Rigged Model';
            _timrxAnimState.model_url = window._lastRigGlbUrl || null;
            _timrxAnimState.thumbnail_url = window._lastRigThumbnail || null;
            _syncAnimatePanelUI();
            _loadAnimLibraryGlobal();
            return;
          }
          // Fallback: scan localStorage history for most recent rigged model
          const riggedItem = _findLatestRiggedFromHistory();
          if (riggedItem) {
            _timrxAnimState.source_type = 'history';
            _timrxAnimState.rig_task_id = riggedItem.id;
            _timrxAnimState.model_id = riggedItem.id;
            _timrxAnimState.is_rigged = true;
            _timrxAnimState.title = riggedItem.title || riggedItem.prompt || 'Rigged Model';
            _timrxAnimState.model_url = riggedItem.glb_url || riggedItem.glb_proxy || null;
            _timrxAnimState.thumbnail_url = riggedItem.thumbnail_url || null;
            _syncAnimatePanelUI();
            _loadAnimLibraryGlobal();
            // Also load in viewer if possible
            if (_timrxAnimState.model_url && window.TimrXViewer?.loadModelWithFallback) {
              const proxy = window.TimrXApi?.getLoadableModelUrl?.(_timrxAnimState.model_url) || _timrxAnimState.model_url;
              window.TimrXViewer.loadModelWithFallback(proxy, _timrxAnimState.model_url).catch(() => {});
            }
            return;
          }
          _toast('No rigged model found. Please rig a model first using the RIG panel.');
        });
      }

      if (fromHistoryBtn) {
        fromHistoryBtn.addEventListener('click', () => {
          // Build a picker of rigged models from history
          const riggedItems = _findAllRiggedFromHistory();
          if (riggedItems.length === 0) {
            _toast('No rigged models in history. Rig a model first using the RIG panel.');
            return;
          }
          _showRiggedModelPicker(riggedItems);
        });
      }

      if (reanimateBtn) {
        reanimateBtn.addEventListener('click', () => {
          // Hide results, reset selection
          const resultsSection = leftStack.querySelector('#animResultsSection2');
          if (resultsSection) resultsSection.style.display = 'none';
          _timrxAnimState.selected_action_id = null;
          _timrxAnimState.selected_animation = null;
          _syncAnimatePanelUI();
          _renderAnimLibraryInPanel();
          _renderQuickAnims();
        });
      }

      // Library search/filter
      const animSearch = leftStack.querySelector('#animLibrarySearch2');
      const animCategory = leftStack.querySelector('#animLibraryCategory2');
      if (animSearch) animSearch.addEventListener('input', _renderAnimLibraryInPanel);
      if (animCategory) animCategory.addEventListener('change', _renderAnimLibraryInPanel);

      // Sync UI with current state (survives tab switch)
      _syncAnimatePanelUI();

      // Render library if already loaded
      if (_animLibraryLoaded) {
        _renderAnimLibraryInPanel();
        _renderQuickAnims();
      } else if (_timrxAnimState.is_rigged) {
        // Auto-load library when animate panel opened with a rigged model
        _loadAnimLibraryGlobal();
      }
    }

    // Expose _syncAnimatePanelUI globally for api.js to call after state updates
    window._syncAnimatePanelUI = _syncAnimatePanelUI;

    /**
     * Registers click handlers for the rail buttons.
     */
    function attachRailButtonHandlers() {
      const railLabels = {
        image: 'AI Image generation',
        model: '3D Model generation',
        remesh: 'Remesh 3D model',
        texture: 'Texture 3D model',
        rig: 'Rig 3D model',
        animate: 'Animate 3D model',
        video: 'AI Video generation',
      };
      railButtons.forEach((btn) => {
        const panel = btn.getAttribute('data-panel');
        if (panel && railLabels[panel] && !btn.getAttribute('aria-label')) {
          btn.setAttribute('aria-label', railLabels[panel]);
        }
        btn.addEventListener('click', handleRailButtonClick);
      });
      modelFeatureButtons.forEach((btn) => {
        btn.addEventListener('click', handleModelFeatureClick);
      });
    }

    function isModelPanel(panelType) {
      return ['model', 'remesh', 'texture', 'rig', 'animate'].includes(panelType);
    }

    function syncCreationDock(panelType, targetButton) {
      const activePrimaryPanel = isModelPanel(panelType) ? 'model' : panelType;
      railButtons.forEach((button) => {
        const isActive = button === targetButton || button.getAttribute('data-panel') === activePrimaryPanel;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      modelFeatureButtons.forEach((button) => {
        const isActive = button.getAttribute('data-model-panel') === panelType;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      // Drives the tray above the command bar: present only in model mode.
      // css/nav.css owns the reveal, the stagger and the layout clearance.
      document.body.classList.toggle('ws-model-mode', isModelPanel(panelType));
      document.body.classList.toggle('ws-video-mode', panelType === 'video');

      // Position the sliding indicator behind the active mode.
      const primary = isModelPanel(panelType) ? 'model' : panelType;
      const sw = document.querySelector('.ws-modes-switch');
      if (sw) sw.setAttribute('data-mode', primary);

      updateSheetHeading(panelType);
    }

    /* ------------------------------------------------------------------------
       CONTROL SHEET
       ------------------------------------------------------------------------
       The tool panel is closed until a creation mode is chosen, so the
       workspace opens with the viewport clear. Picking a mode opens it; picking
       the mode already on screen closes it again.
       --------------------------------------------------------------------- */
    const SHEET_HEADINGS = {
      model:   ['Model',   'Describe it, tune it, generate it'],
      image:   ['Image',   'Prompt, references and provider settings'],
      video:   ['Video',   'Motion, duration and provider settings'],
      remesh:  ['Remesh',  'Rebuild topology for print or edit'],
      texture: ['Texture', 'Generate PBR surfaces for the active model'],
      rig:     ['Rig',     'Add a skeleton so the model can move'],
      animate: ['Animate', 'Apply motion to the rigged model'],
    };

    function updateSheetHeading(panelType) {
      const [title, sub] = SHEET_HEADINGS[panelType] || SHEET_HEADINGS.model;
      const t = document.getElementById('wsSheetTitle');
      const s = document.getElementById('wsSheetSub');
      if (t) t.textContent = title;
      if (s) s.textContent = sub;
      updateSheetModeSwitch(panelType);
    }

    function updateSheetModeSwitch(panelType) {
      const primaryPanel = isModelPanel(panelType) ? 'model' : panelType;
      document.querySelectorAll('[data-sheet-panel]').forEach((btn) => {
        const active = btn.getAttribute('data-sheet-panel') === primaryPanel;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function setSheetOpen(open) {
      document.body.classList.toggle('ws-panel-open', !!open);
      const sheet = document.getElementById('ws-left-panel');
      if (sheet) sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    function getActiveSheetPanel() {
      const activeModelTool = document.querySelector('.model-feature-btn.is-active[data-model-panel]');
      const activeRail = document.querySelector('.rail-btn.is-active[data-panel]');
      const panelType =
        activeModelTool?.getAttribute('data-model-panel') ||
        activeRail?.getAttribute('data-panel') ||
        'model';
      return panelContent[panelType] ? panelType : 'model';
    }

    function sheetHasControls() {
      if (!leftStack) return false;
      if (!leftStack.children.length) return false;
      if (!leftStack.querySelector('.ws-pages')) return true;
      return !!leftStack.querySelector(
        '.ws-page__body > *, .ws-modes, .tab-btn, textarea, input, select, .gen-btn'
      );
    }

    function ensureSheetContent(panelType) {
      if (sheetHasControls()) return;
      const targetPanel = panelContent[panelType] ? panelType : getActiveSheetPanel();
      const primaryPanel = isModelPanel(targetPanel) ? 'model' : targetPanel;
      const targetButton = document.querySelector('.rail-btn[data-panel="' + primaryPanel + '"]');
      activateWorkspacePanel(targetPanel, targetButton);
    }

    window.TimrXSheet = {
      open:   (panelType) => {
        ensureSheetContent(panelType);
        setSheetOpen(true);
      },
      close:  () => setSheetOpen(false),
      isOpen: () => document.body.classList.contains('ws-panel-open'),
      ensureContent: ensureSheetContent,
    };

    (function bindSheet() {
      const closeBtn = document.getElementById('wsSheetClose');
      if (closeBtn) closeBtn.addEventListener('click', () => setSheetOpen(false));

      document.addEventListener('keydown', (e) => {
        // Escape belongs to the palette first; only close the sheet when the
        // palette is not the thing on screen.
        if (e.key !== 'Escape') return;
        if (document.body.classList.contains('ws-cmd-open')) return;
        if (window.TimrXSheet.isOpen()) setSheetOpen(false);
      });

      /* Click-away.
         Anything that drives the sheet has to be exempt, or the press that
         opens it would immediately close it again:
           .rail-btn      mode switch — its own handler toggles the sheet
           .ws-tray       model tool tray — switches tools inside the sheet
           .ws-cmd-*      command bar and palette — the palette hides the sheet
                          on its own and restores it on close
         pointerdown rather than click so the sheet dismisses on press, and so a
         drag that starts inside and ends outside does not count as an outside
         hit. */
      const KEEPS_SHEET_OPEN = [
        '#ws-left-panel',      // the sheet itself
        '.ws-cmd',             // command palette
        '[data-open-assets]',
        '[data-open-3d-viewer]',
        '[data-sheet-panel]',
        // Catch-all for any control that drives panel state but lives outside
        // the sheet. Three such trays exist today and each one was added in a
        // separate pass; keying off the attributes they already carry means a
        // fourth will not silently dismiss the panel it is meant to configure.
        '[data-panel]',
        '[data-model-panel]',
        '[data-mode]',
      ].join(',');

      document.addEventListener('pointerdown', (e) => {
        if (!window.TimrXSheet.isOpen()) return;
        if (e.target.closest && e.target.closest(KEEPS_SHEET_OPEN)) return;
        setSheetOpen(false);
      });
    })();

    document.addEventListener('click', (event) => {
      const modeButton = event.target.closest?.('[data-sheet-panel]');
      if (!modeButton) return;
      const panelType = modeButton.getAttribute('data-sheet-panel');
      const targetButton = document.querySelector('.rail-btn[data-panel="' + panelType + '"]');
      activateWorkspacePanel(panelType, targetButton);
      window.TimrXSheet.open(panelType);
    });

    function activateWorkspacePanel(panelType, targetButton) {
      if (!panelType) return;
      syncCreationDock(panelType, targetButton);

      // ── Clear transient generation state on rail switch ──
      // Prevents stale lock/provider/mode from bleeding into the next panel.
      // Does NOT clear per-mode settings, active job polling, or recovery data.
      if (window.GenerationState?.resetTransientGenerationState) {
        window.GenerationState.resetTransientGenerationState();
      }
      // Release image UI lock if it was held (e.g. user navigated away mid-generation)
      if (window.ImageJobControl?.unlock && window.GenerationState?.isLocked?.() === false) {
        window.ImageJobControl.unlock();
      }

      updateLeftPanel(panelType);
      switchViewer(panelType);
      if (isModelPanel(panelType)) {
        ensureThreeViewer();
      }

      // Refresh remesh model-state label when switching to that panel
      if (panelType === 'remesh' && window._updateRemeshStateLabel) {
        window._updateRemeshStateLabel();
      }
    }

    /**
     * Handles tool switching when a rail button is pressed.
     * @param {MouseEvent} event - Click event from the rail button.
     */
    function handleRailButtonClick(event) {
      const targetButton = event.currentTarget;
      const panelType = targetButton.getAttribute('data-panel');
      // Pressing the mode already on screen closes the sheet again, so the
      // same button both summons and dismisses its controls.
      const samePanel = targetButton.classList.contains('is-active');
      if (samePanel && window.TimrXSheet.isOpen()) {
        window.TimrXSheet.close();
        return;
      }
      activateWorkspacePanel(panelType, targetButton);
      window.TimrXSheet.open();
    }

    function handleModelFeatureClick(event) {
      const targetButton = event.currentTarget;
      const panelType = targetButton.getAttribute('data-model-panel');
      const sameTool = targetButton.classList.contains('is-active');
      if (sameTool && window.TimrXSheet.isOpen()) {
        window.TimrXSheet.close();
        return;
      }
      activateWorkspacePanel(panelType, document.querySelector('.rail-btn[data-panel="model"]'));
      window.TimrXSheet.open();
    }

    window.TimrXWorkspace = Object.assign(window.TimrXWorkspace || {}, {
      activatePanel: function(panelType, opts) {
        const primaryPanel = isModelPanel(panelType) ? 'model' : panelType;
        const targetButton = document.querySelector('.rail-btn[data-panel="' + primaryPanel + '"]');
        activateWorkspacePanel(panelType, targetButton);
        // Restoring state on load must leave the sheet closed; an explicit
        // request (command palette, community remix) should open it.
        if (!opts || opts.reveal !== false) window.TimrXSheet.open();
      },
      isModelPanel: isModelPanel
    });

    function consumePendingCommunityRemix() {
      try {
        const raw = sessionStorage.getItem('timrx_pending_community_remix');
        if (!raw) return null;
        sessionStorage.removeItem('timrx_pending_community_remix');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
      } catch (_) {
        try { sessionStorage.removeItem('timrx_pending_community_remix'); } catch (_) {}
        return null;
      }
    }

    function applyPendingCommunityRemix() {
      const pending = consumePendingCommunityRemix();
      if (!pending || !pending.prompt) return;

      const targetPanel = ['model', 'image', 'video'].includes(pending.panel) ? pending.panel : 'model';
      const promptIdMap = {
        model: 'modelPrompt',
        image: 'imagePrompt',
        video: 'videoTextPrompt',
      };

      const activatePanelAndFill = () => {
        const textarea = document.getElementById(promptIdMap[targetPanel] || 'modelPrompt');
        if (!textarea) return;
        textarea.value = pending.prompt;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      };

      const targetBtn = document.querySelector('.rail-btn[data-panel="' + targetPanel + '"]');
      if (targetBtn && !targetBtn.classList.contains('is-active')) {
        targetBtn.click();
      } else if (isModelPanel(targetPanel) && targetPanel !== 'model') {
        const modelFeatureBtn = document.querySelector('.model-feature-btn[data-model-panel="' + targetPanel + '"]');
        if (modelFeatureBtn) modelFeatureBtn.click();
      }

      requestAnimationFrame(() => {
        setTimeout(activatePanelAndFill, 120);
      });
    }

    /**
     * Applies the markup-defined active rail button on initial load.
     */
    function bootstrapInitialPanel() {
      // Support ?panel=image|model|video|remesh|texture|rig|animate from URL
      const urlPanel = new URLSearchParams(window.location.search).get('panel');
      let targetBtn;
      if (urlPanel) {
        targetBtn = document.querySelector('.rail-btn[data-panel="' + urlPanel + '"]');
        if (!targetBtn && isModelPanel(urlPanel)) {
          targetBtn = document.querySelector('.rail-btn[data-panel="model"]');
        }
      }
      if (!targetBtn) {
        targetBtn = document.querySelector('.rail-btn.is-active');
      }
      if (!targetBtn) return;

      var initialPanel = urlPanel && isModelPanel(urlPanel) ? urlPanel : targetBtn.getAttribute('data-panel');

      // The image/video panel init paths call window.GenerationState (assigned
      // by the js/main.js module graph, which loads after this classic script).
      // On a ?panel= deep link we can get here first — wait for the state
      // module instead of crashing initPanelInteractions. The default model
      // panel has no such dependency and activates immediately as before.
      var needsState = initialPanel !== 'model' && !isModelPanel(initialPanel);
      var activate = function () {
        activateWorkspacePanel(initialPanel, targetBtn);
        applyPendingCommunityRemix();
      };
      if (needsState && !window.GenerationState) {
        var tries = 0;
        (function waitForState() {
          if (window.GenerationState || tries++ > 40) { activate(); return; }
          setTimeout(waitForState, 150);
        })();
      } else {
        activate();
      }
    }

    function initFieldHelpTooltips() { /* handled by standalone IIFE at end of file */ }

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
      uploadModal.inert = false;
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
      uploadModal.inert = true;
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

      if (continueUploadBtn) {
        continueUploadBtn.disabled = true;
        continueUploadBtn.dataset.originalText = continueUploadBtn.textContent || 'Load Model';
        continueUploadBtn.textContent = 'Loading...';
      }

      load3DModel(selectedFile, modelName)
        .then(() => closeModal())
        .catch(() => {})
        .finally(() => {
          if (continueUploadBtn) {
            continueUploadBtn.disabled = false;
            continueUploadBtn.textContent = continueUploadBtn.dataset.originalText || 'Load Model';
            delete continueUploadBtn.dataset.originalText;
          }
        });
    }

    /**
     * Closes the modal when clicking the backdrop.
     * @param {MouseEvent} event - Click event fired on the modal container.
     */
    function handleBackdropClick(event) {
      if (event.target === uploadModal || event.target?.classList?.contains('modal-backdrop')) closeModal();
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
      modelDrop.classList.add('is-dragover');
    }

    /**
     * Removes drop zone highlight styles.
     */
    function handleDropZoneLeave() {
      if (!modelDrop) return;
      modelDrop.classList.remove('is-dragover');
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
     * @param {File} file - Uploaded GLB/GLTF/STL file.
     */
    function handleFileSelect(file) {
      const maxSize = 50 * 1024 * 1024;
      const valid   = ['.glb', '.gltf', '.stl'];
      const validMime = ['model/gltf-binary', 'model/gltf+json', 'model/stl', 'application/sla', 'application/vnd.ms-pki.stl', 'application/octet-stream', ''];
      const ext     = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

      if (!valid.includes(ext) || (file.type && !validMime.includes(file.type.toLowerCase()))) {
        if (modelFileHint) {
          modelFileHint.textContent = 'Invalid file format. Please upload a GLB, GLTF, or STL file.';
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
      if (modelDrop) modelDrop.classList.add('is-selected');
      if (modelFileHint) {
        modelFileHint.textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        modelFileHint.style.color = 'var(--accent-blue-soft, #a5ded9)';
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
      if (modelDrop) modelDrop.classList.remove('is-selected', 'is-dragover');
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
    initFieldHelpTooltips();
    bootstrapInitialPanel();

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTimrxWorkspace, { once: true });
} else {
  initTimrxWorkspace();
}

/* =============================================================================
   WORKSPACE HEADER DROPDOWN (separate from workspace - runs independently)
   ============================================================================= */
(function initWsDropdown() {
  const dropdown = document.querySelector('.ws-dropdown');
  if (!dropdown) return;

  const toggle = dropdown.querySelector('.ws-dropdown-toggle');
  const menu = dropdown.querySelector('.ws-dropdown-menu');
  if (!toggle || !menu) return;

  // Move menu to body so it escapes the header stacking context
  // and always renders above expansion views.
  document.body.appendChild(menu);

  function positionMenu() {
    const rect = toggle.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 10) + 'px';
    menu.style.left = (rect.left + rect.width / 2) + 'px';
    menu.style.transform = 'translateX(-50%)';
    menu.style.zIndex = '200000';
  }

  function open() {
    positionMenu();
    dropdown.classList.add('open');
    menu.style.display = 'block';
    toggle.setAttribute('aria-expanded', 'true');
  }

  function close() {
    dropdown.classList.remove('open');
    menu.style.display = '';
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
    if (!dropdown.contains(e.target) && !menu.contains(e.target)) {
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

/* =============================================================================
   FIELD-HELP TOOLTIPS — standalone, runs independently of workspace IIFE
   Fixed-position tooltip avoids overflow:hidden clipping in parent containers.
   ============================================================================= */
(function () {
  'use strict';
  // Wait for body to be ready
  function boot() {
    var tooltip = document.createElement('div');
    tooltip.className = 'field-help-tooltip';
    document.body.appendChild(tooltip);

    var hideTimer = null;
    var activeHelp = null;

    function show(helpEl) {
      if (activeHelp === helpEl) return;
      clearTimeout(hideTimer);
      activeHelp = helpEl;

      var bubble = helpEl.querySelector('.field-help__bubble');
      if (!bubble) { console.warn('[FieldHelp] No bubble found in', helpEl); return; }
      var html = bubble.innerHTML;
      if (!html || !html.trim()) { console.warn('[FieldHelp] Empty bubble'); return; }

      tooltip.innerHTML = html;

      var rect = helpEl.getBoundingClientRect();
      var panel = helpEl.closest('.card') || helpEl.closest('#leftStack') || helpEl.closest('.ws-left');
      var pLeft = panel ? panel.getBoundingClientRect().left : 16;
      var pWidth = panel ? panel.getBoundingClientRect().width : (window.innerWidth - 32);

      var tw = Math.min(280, window.innerWidth - 32);
      var left = pLeft + (pWidth - tw) / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));

      // Reset positioning
      tooltip.style.cssText =
        'position:fixed;z-index:10000;' +
        'left:' + left + 'px;' +
        'width:' + tw + 'px;' +
        'top:' + (rect.bottom + 10) + 'px;';

      // Flip above if overflows bottom
      if (rect.bottom + 150 > window.innerHeight) {
        tooltip.style.top = 'auto';
        tooltip.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
      }

      // Force layout then show
      void tooltip.offsetHeight;
      tooltip.classList.add('is-visible');
    }

    function hide() {
      hideTimer = setTimeout(function () {
        tooltip.classList.remove('is-visible');
        activeHelp = null;
      }, 120);
    }

    document.addEventListener('mouseover', function (e) {
      var h = e.target.closest('.field-help');
      if (h) show(h);
    });
    document.addEventListener('mouseout', function (e) {
      var h = e.target.closest('.field-help');
      if (h && (!e.relatedTarget || !h.contains(e.relatedTarget))) hide();
    });
    document.addEventListener('click', function (e) {
      var h = e.target.closest('.field-help');
      if (h) { e.preventDefault(); activeHelp === h ? hide() : show(h); }
      else if (activeHelp) hide();
    });

    console.log('[FieldHelp] Tooltip system initialized');
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
