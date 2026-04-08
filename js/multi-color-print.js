/**
 * Multi-Color Print Modal
 *
 * Handles the complete workflow for multi-color 3D printing:
 * - Configuration of color count and level of detail
 * - 3D model viewer (Three.js)
 * - Job submission and polling
 * - Result download
 *
 * Note: Meshy auto-assigns colors during processing. The API only
 * accepts max_colors + max_depth, not specific color choices.
 */

import { BACKEND, apiFetch, getLoadableModelUrl, isTimrxS3Url } from './config.js';

// ============================================================================
// State Management
// ============================================================================

let _state = 'config'; // 'config' | 'processing' | 'done' | 'error'
let _activeJobId = null;
let _maxColors = 4;
let _maxDepth = 4;
let _pollingInterval = null;
let _taskId = null;

// ============================================================================
// Initialization & DOM Creation
// ============================================================================

function _injectStylesOnce() {
  if (document.getElementById('multi-color-print-critical-styles')) return;

  const style = document.createElement('style');
  style.id = 'multi-color-print-critical-styles';
  style.textContent = `
    #multi-color-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      backdrop-filter: blur(4px);
    }

    .multi-color-container {
      width: min(1100px, 90vw);
      height: min(680px, 85vh);
      background: linear-gradient(135deg, rgba(15,15,15,.96), rgba(18,18,20,.97));
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 12px;
      display: flex;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
    }

    .multi-color-viewer {
      flex: 1 1 55%;
      min-width: 0;
      background: rgb(18, 18, 20);
      border-right: 1px solid rgba(255,255,255,.07);
      position: relative;
    }

    .multi-color-controls {
      flex: 0 0 340px;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
    }

    @media (max-width: 768px) {
      .multi-color-container {
        flex-direction: column;
      }
      .multi-color-viewer {
        flex: 0 0 50%;
        border-right: none;
        border-bottom: 1px solid rgba(255,255,255,.07);
      }
      .multi-color-controls {
        flex: 1;
      }
    }
  `;

  document.head.appendChild(style);
}

function _createModal() {
  _injectStylesOnce();

  const overlay = document.createElement('div');
  overlay.id = 'multi-color-modal';

  const container = document.createElement('div');
  container.className = 'multi-color-container';

  // Left: 3D Viewer
  const viewer = document.createElement('div');
  viewer.className = 'multi-color-viewer';
  viewer.id = 'multi-color-viewer-container';

  // Right: Controls
  const controls = document.createElement('div');
  controls.className = 'multi-color-controls';
  controls.id = 'multi-color-controls-panel';

  container.appendChild(viewer);
  container.appendChild(controls);
  overlay.appendChild(container);
  document.body.appendChild(overlay);

  return { overlay, controls };
}

// ============================================================================
// 3D Viewer Setup
// ============================================================================

function _setupThreeJsViewer(glbUrl) {
  const container = document.getElementById('multi-color-viewer-container');
  if (!container) return;

  // Show loading state
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.3);font-size:12px;">Loading model...</div>';

  if (!glbUrl) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.25);font-size:12px;">No model available</div>';
    return;
  }

  container.innerHTML = '';

  const width = container.clientWidth;
  const height = container.clientHeight;

  // Scene
  _scene = new window.THREE.Scene();
  _scene.background = new window.THREE.Color(0x121214);

  // Camera
  _camera = new window.THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  _camera.position.set(0, 0, 2);

  // Renderer
  _renderer = new window.THREE.WebGLRenderer({ antialias: true, alpha: false });
  _renderer.setSize(width, height);
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _renderer.shadowMap.enabled = true;
  _renderer.shadowMap.type = window.THREE.PCFSoftShadowMap;
  _renderer.toneMapping = window.THREE.ACESFilmicToneMapping;
  _renderer.toneMappingExposure = 1.0;
  container.appendChild(_renderer.domElement);

  // Lighting — use RoomEnvironment if available, else fallback to directional lights
  try {
    if (window.THREE.RoomEnvironment && window.THREE.PMREMGenerator) {
      const environment = new window.THREE.RoomEnvironment();
      const pmremGenerator = new window.THREE.PMREMGenerator(_renderer);
      const envMap = pmremGenerator.fromScene(environment).texture;
      _scene.environment = envMap;
      pmremGenerator.dispose();
    }
  } catch (e) {
    console.warn('[MCP Viewer] RoomEnvironment unavailable, using fallback lights');
  }
  // Always add ambient + directional as baseline
  _scene.add(new window.THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new window.THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  _scene.add(dirLight);

  // OrbitControls
  _controls = new window.THREE.OrbitControls(_camera, _renderer.domElement);
  _controls.enableDamping = true;
  _controls.dampingFactor = 0.05;
  _controls.autoRotate = false;
  _controls.autoRotateSpeed = 2;

  // Load GLB model
  const loader = new window.THREE.GLTFLoader();

  const loadUrl = getLoadableModelUrl(glbUrl);

  // Send session cookie through proxy-glb (same as viewer.js)
  // Check loadUrl (the proxy URL), not glbUrl (the raw S3 URL)
  if (!isTimrxS3Url(loadUrl)) {
    loader.setCrossOrigin('use-credentials');
    loader.setWithCredentials(true);
  } else {
    loader.setCrossOrigin('anonymous');
  }

  loader.load(
    loadUrl,
    (gltf) => {
      _model = gltf.scene;
      _scene.add(_model);

      // Auto-fit camera to model
      const box = new window.THREE.Box3().setFromObject(_model);
      const size = box.getSize(new window.THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = _camera.fov * (Math.PI / 180);
      let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
      cameraZ *= 1.5; // add padding

      _camera.position.z = cameraZ;
      _controls.target.copy(box.getCenter(new window.THREE.Vector3()));
      _controls.update();
    },
    undefined,
    (error) => {
      console.error('Error loading model:', error);
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,0.35);font-size:11px;text-align:center;max-width:80%;';
      errDiv.textContent = 'Failed to load model';
      container.appendChild(errDiv);
    }
  );

  // Resize handler
  const _onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w && h && _camera && _renderer) {
      _camera.aspect = w / h;
      _camera.updateProjectionMatrix();
      _renderer.setSize(w, h);
    }
  };
  window.addEventListener('resize', _onResize);
  container._resizeHandler = _onResize;

  // Animation loop
  let _animId = 0;
  const animate = () => {
    _animId = requestAnimationFrame(animate);
    if (_controls) _controls.update();
    if (_renderer && _scene && _camera) _renderer.render(_scene, _camera);
  };
  container._animId = _animId;
  animate();
}

function _disposeThreeJs() {
  const container = document.getElementById('multi-color-viewer-container');
  if (container) {
    if (container._resizeHandler) window.removeEventListener('resize', container._resizeHandler);
    if (container._animId) cancelAnimationFrame(container._animId);
  }
  if (_controls) { _controls.dispose(); _controls = null; }
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  if (_scene) { _scene.clear(); _scene = null; }
  _model = null;
  _camera = null;
}

// ============================================================================
// UI Rendering
// ============================================================================

function _renderControls() {
  const panel = document.getElementById('multi-color-controls-panel');
  if (!panel) return;

  panel.innerHTML = '';

  if (_state === 'config') {
    _renderConfigPanel(panel);
  } else if (_state === 'processing') {
    _renderProcessingPanel(panel);
  } else if (_state === 'done') {
    _renderDonePanel(panel);
  } else if (_state === 'error') {
    _renderErrorPanel(panel);
  }
}

function _renderConfigPanel(panel) {
  const html = `
    <div class="multi-color-header">
      <h2>Multi-Color 3MF</h2>
      <button class="multi-color-close-btn" onclick="window.multiColorPrint?.closeMultiColorModal?.()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="multi-color-section">
      <div class="multi-color-section-header">
        <label class="multi-color-label">Color Count</label>
        <span class="multi-color-badge">${_maxColors}</span>
      </div>
      <input
        type="range"
        min="1"
        max="16"
        value="${_maxColors}"
        class="multi-color-slider"
        id="color-count-slider"
      />
      <div class="multi-color-hint">Number of distinct colors in the output</div>
    </div>

    <div class="multi-color-section">
      <div class="multi-color-section-header">
        <label class="multi-color-label">Level of Detail</label>
        <span class="multi-color-badge">${_maxDepth}</span>
      </div>
      <input
        type="range"
        min="3"
        max="6"
        value="${_maxDepth}"
        class="multi-color-slider"
        id="detail-slider"
      />
      <div class="multi-color-hint">Higher = finer color boundaries, longer processing</div>
    </div>

    <div class="multi-color-info">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0;margin-top:1px;">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>Colors are auto-assigned based on the model's texture. The output is a print-ready 3MF file for multi-color printers.</span>
    </div>

    <div class="multi-color-footer">
      <button class="multi-color-btn multi-color-btn-primary" id="generate-btn">
        Generate 3MF
        <span class="multi-color-badge-cost">10 cr</span>
      </button>
      <button class="multi-color-btn multi-color-btn-secondary" onclick="window.multiColorPrint?.closeMultiColorModal?.()">
        Cancel
      </button>
    </div>
  `;

  panel.innerHTML = html;

  // Attach event listeners -- use 'input' for live badge updates
  const colorSlider = document.getElementById('color-count-slider');
  const detailSlider = document.getElementById('detail-slider');

  colorSlider?.addEventListener('input', (e) => {
    const badge = e.target.closest('.multi-color-section')?.querySelector('.multi-color-badge');
    if (badge) badge.textContent = e.target.value;
  });
  colorSlider?.addEventListener('change', (e) => {
    _maxColors = parseInt(e.target.value);
  });

  detailSlider?.addEventListener('input', (e) => {
    const badge = e.target.closest('.multi-color-section')?.querySelector('.multi-color-badge');
    if (badge) badge.textContent = e.target.value;
  });
  detailSlider?.addEventListener('change', (e) => {
    _maxDepth = parseInt(e.target.value);
  });

  document.getElementById('generate-btn')?.addEventListener('click', _startJob);
}

function _renderProcessingPanel(panel) {
  const html = `
    <div class="multi-color-header">
      <h2>Processing...</h2>
    </div>

    <div class="multi-color-processing">
      <div class="multi-color-spinner"></div>
      <p class="multi-color-processing-text">Preparing your print file</p>
      <p class="multi-color-processing-desc">Converting colors and optimizing mesh for printing...</p>
      <div class="multi-color-progress">
        <div class="multi-color-progress-track">
          <div class="multi-color-progress-fill" style="width:0%"></div>
        </div>
        <span class="multi-color-progress-pct">0%</span>
      </div>
    </div>
  `;

  panel.innerHTML = html;
}

function _renderDonePanel(panel) {
  const html = `
    <div class="multi-color-header">
      <h2>Ready to Download</h2>
    </div>

    <div class="multi-color-success">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="multi-color-success-icon">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <p class="multi-color-success-text">Your multi-color print file is ready!</p>
      <button class="multi-color-btn multi-color-btn-primary" id="download-btn">
        Download 3MF
      </button>
      <button class="multi-color-btn multi-color-btn-secondary" onclick="window.multiColorPrint?.closeMultiColorModal?.()">
        Close
      </button>
    </div>
  `;

  panel.innerHTML = html;

  document.getElementById('download-btn')?.addEventListener('click', _downloadResult);
}

function _renderErrorPanel(panel) {
  const html = `
    <div class="multi-color-header">
      <h2>Error</h2>
    </div>

    <div class="multi-color-error">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="multi-color-error-icon">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <p class="multi-color-error-text">Failed to process multi-color print.</p>
      <button class="multi-color-btn multi-color-btn-primary" id="retry-btn">
        Retry
      </button>
      <button class="multi-color-btn multi-color-btn-secondary" onclick="window.multiColorPrint?.closeMultiColorModal?.()">
        Cancel
      </button>
    </div>
  `;

  panel.innerHTML = html;

  document.getElementById('retry-btn')?.addEventListener('click', () => {
    _state = 'config';
    _renderControls();
  });
}

// ============================================================================
// Job Management
// ============================================================================

let _downloadUrl = null;

async function _startJob() {
  _state = 'processing';
  _renderControls();

  try {
    const res = await apiFetch(`${BACKEND}/api/_mod/print/multi-color`, {
      method: 'POST',
      body: JSON.stringify({
        input_task_id: _taskId,
        max_colors: _maxColors,
        max_depth: _maxDepth,
      }),
    });

    if (!res.ok && !res.data?.ok) {
      const msg = res.data?.message || res.data?.error || res.error || 'Failed to start job';
      throw new Error(msg);
    }

    _activeJobId = res.data?.job_id;
    if (!_activeJobId) throw new Error('No job ID returned');

    // Update wallet display if new_balance is present
    if (res.data?.new_balance != null) {
      const badge = document.querySelector('.credits-balance, .wallet-balance, [data-wallet-balance]');
      if (badge) badge.textContent = res.data.new_balance;
    }

    _pollJob();
  } catch (error) {
    console.error('[MultiColorPrint] start failed:', error);
    _state = 'error';
    _renderControls();
  }
}

function _pollJob() {
  const poll = async () => {
    if (!_activeJobId) return;
    try {
      const res = await apiFetch(`${BACKEND}/api/_mod/print/multi-color/${_activeJobId}`);
      const data = res.data || res;

      if (data.status === 'done') {
        clearInterval(_pollingInterval);
        _pollingInterval = null;
        _downloadUrl = data.three_mf_url || data.model_urls?.['3mf'] || data.glb_url || '';
        _state = 'done';
        _renderControls();
        _refreshHistoryAndWallet();
        return;
      }

      if (data.status === 'failed') {
        clearInterval(_pollingInterval);
        _pollingInterval = null;
        _state = 'error';
        _renderControls();
        return;
      }

      // Update progress bar
      const pct = data.pct || 0;
      const fill = document.querySelector('.multi-color-progress-fill');
      const pctLabel = document.querySelector('.multi-color-progress-pct');
      if (fill) fill.style.width = `${pct}%`;
      if (pctLabel) pctLabel.textContent = `${Math.round(pct)}%`;

      // Show queue position
      if (data.preceding_tasks > 0 && pct === 0) {
        const desc = document.querySelector('.multi-color-processing-desc');
        if (desc) desc.textContent = `Queued - ${data.preceding_tasks} task${data.preceding_tasks > 1 ? 's' : ''} ahead...`;
      }
    } catch (error) {
      console.error('[MultiColorPrint] poll error:', error);
    }
  };

  _pollingInterval = setInterval(poll, 3000);
  setTimeout(poll, 800);
}

function _downloadResult() {
  if (!_downloadUrl) return;
  const link = document.createElement('a');
  link.href = _downloadUrl;
  link.download = 'multi-color-print.3mf';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function _refreshHistoryAndWallet() {
  try {
    const stateModule = await import('./state.js').catch(() => null);
    const historyModule = await import('./history.js?v=20260408a').catch(() => null);
    if (stateModule?.loadHistoryTab) await stateModule.loadHistoryTab('all');
    if (historyModule?.renderHistory) historyModule.renderHistory();
  } catch (_e) {
    console.warn('[MultiColorPrint] history refresh skipped:', _e);
  }
}

// ============================================================================
// Public API
// ============================================================================

export function openMultiColorModal({ taskId, title, thumbnailUrl, glbUrl }) {
  // Reset state
  _state = 'config';
  _activeJobId = null;
  _maxColors = 4;
  _maxDepth = 4;
  _taskId = taskId;
  _pollingInterval = null;

  // Create modal DOM
  const { overlay, controls } = _createModal();

  // Setup 3D viewer
  _setupThreeJsViewer(glbUrl);

  // Render controls
  _renderControls();

  // Close on overlay click (outside modal)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMultiColorModal();
  });

  // Close on Escape key
  const _onEscape = (e) => { if (e.key === 'Escape') closeMultiColorModal(); };
  document.addEventListener('keydown', _onEscape);
  // Store ref so we can remove on cleanup
  overlay._escHandler = _onEscape;

  // Expose functions globally for inline onclick handlers
  window.multiColorPrint = {
    closeMultiColorModal
  };
}

export function closeMultiColorModal() {
  // Cleanup
  if (_pollingInterval) {
    clearInterval(_pollingInterval);
    _pollingInterval = null;
  }

  _disposeThreeJs();

  const modal = document.getElementById('multi-color-modal');
  if (modal) {
    if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal.remove();
  }

  _state = 'config';
  _activeJobId = null;
  _taskId = null;
}
