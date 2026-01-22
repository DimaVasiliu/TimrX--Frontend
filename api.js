/**
 * api.js
 * Handles all fetch calls to the backend, job polling, and orchestrates the other modules
 * (updates State, tells Viewer to load, tells History to refresh).
 * Uses window globals (no ES modules).
 */

(function() {
  'use strict';

  // Get dependencies from window globals
  const {
    BACKEND,
    CHAT_API,
    normalizeEpochMs,
    log,
    byId,
    fileToDataURL,
    createBatchGroupId,
    apiFetch
  } = window.TimrX;

  // Lazy getters for modules that may load after this file
  function getState() { return window.State || {}; }
  function getViewer() { return window.Viewer || {}; }
  function getUI() { return window.UI || {}; }
  function getHistory() { return window.History || {}; }

  // ============================================================================
  // LOCKS & STATE
  // ============================================================================
  let startLock = false;
  let postProcessLock = false;

  // Track jobs that have already had credits refreshed on completion/failure
  // Prevents multiple refresh calls for the same job
  const creditsRefreshedJobs = new Set();

  // ============================================================================
  // CREDITS HELPERS
  // ============================================================================

  /**
   * Check if user has enough credits for an action (pre-flight check)
   * Uses effective available (accounting for existing reservations)
   * @returns {boolean} true if can proceed, false if insufficient
   */
  function checkCreditsFor(action, count = 1) {
    if (!window.WorkspaceCredits) return true; // Skip if credits system not loaded
    if (!window.WorkspaceCredits.isLoaded()) return true; // Skip if not yet loaded

    // Use effective available (accounts for existing reservations)
    const hasCredits = window.WorkspaceCredits.hasEffectiveCreditsFor
      ? window.WorkspaceCredits.hasEffectiveCreditsFor(action, count)
      : window.WorkspaceCredits.hasCreditsFor(action);

    if (!hasCredits) {
      window.WorkspaceCredits.showInsufficientCreditsMessage(action);
      return false;
    }
    return true;
  }

  /**
   * Reserve credits BEFORE making API call (optimistic reservation)
   * Shows "Reserving credits..." status and immediately reduces available
   *
   * @param {string} action - The action key (e.g., 'text-to-3d', 'image-to-3d')
   * @param {number} count - Number of items (default 1, for batch operations)
   * @returns {{ reservationId: string, amount: number, insufficient?: boolean }}
   */
  function reserveCreditsForAction(action, count = 1) {
    if (!window.WorkspaceCredits?.reserveCredits) {
      log('[Credits] reserveCredits not available');
      return { reservationId: null, amount: 0 };
    }

    const result = window.WorkspaceCredits.reserveCredits(action, count);
    if (result.insufficient) {
      window.WorkspaceCredits.showInsufficientCreditsMessage(action);
    }
    return result;
  }

  /**
   * Confirm reservation after successful job start
   * Converts reservation to actual deduction
   *
   * @param {string} reservationId - The reservation ID from reserveCreditsForAction
   * @param {string} jobId - The job ID from backend
   */
  function confirmCreditsReservation(reservationId, jobId) {
    if (!window.WorkspaceCredits?.confirmReservation || !reservationId) {
      // Fallback to old deduction if reservation system not available
      return;
    }

    window.WorkspaceCredits.confirmReservation(reservationId, jobId);
    log('[Credits] Confirmed reservation:', { reservationId, jobId });

    // Refresh in background to reconcile with server
    refreshCreditsInBackground();
  }

  /**
   * Release reservation if job fails to start
   *
   * @param {string} reservationId - The reservation ID from reserveCreditsForAction
   */
  function releaseCreditsReservation(reservationId) {
    if (!window.WorkspaceCredits?.releaseReservation || !reservationId) {
      return;
    }

    window.WorkspaceCredits.releaseReservation(reservationId);
    log('[Credits] Released reservation:', reservationId);
  }

  /**
   * Apply credits deduction AFTER successful job start (legacy)
   * Call this only after receiving a valid job_id from backend
   *
   * @param {string} action - The action key (e.g., 'text-to-3d', 'image-to-3d')
   * @param {string} jobId - The job ID from the backend response
   * @param {number} count - Number of items (default 1, for batch operations)
   */
  function applyCreditsDeduction(action, jobId, count = 1) {
    if (!window.WorkspaceCredits?.applyDelta) {
      log('[Credits] applyDelta not available');
      return;
    }

    const cost = window.WorkspaceCredits.getActionCost(action) * count;
    if (cost > 0) {
      window.WorkspaceCredits.applyDelta(-cost, action, jobId);
      log('[Credits] Applied deduction:', { action, jobId, cost, count });

      // Refresh in background to reconcile with server
      refreshCreditsInBackground();
    }
  }

  /**
   * Refresh credits from server in background (non-blocking)
   */
  function refreshCreditsInBackground() {
    if (window.WorkspaceCredits?.refreshCredits) {
      // Fire and forget - don't await
      window.WorkspaceCredits.refreshCredits().catch(err => {
        log('[Credits] Background refresh failed:', err);
      });
    }
  }

  /**
   * Handle API response errors, specifically 402 insufficient credits
   * @returns {boolean} true if error was handled (should stop), false to continue with normal error
   */
  function handleApiError(response, action, reservationId = null) {
    if (response.status === 402) {
      log('[Credits] 402 Insufficient credits for:', action);
      // Release any reservation on 402
      if (reservationId) {
        releaseCreditsReservation(reservationId);
      }
      if (window.WorkspaceCredits) {
        window.WorkspaceCredits.showInsufficientCreditsMessage(action);
      } else {
        alert('Insufficient credits. Please purchase more credits to continue.');
      }
      return true;
    }
    return false;
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Prefer HTTP URLs over data URIs when multiple are available
   */
  function preferHttpUrl(urlLike) {
    if (Array.isArray(urlLike)) {
      const http = urlLike.find(u => typeof u === 'string' && /^https?:/i.test(u));
      return http || urlLike[0] || '';
    }
    if (typeof urlLike !== 'string') return '';
    return urlLike;
  }

  /**
   * Update the progress display on a history thumbnail
   * Handles both regular view (history-thumb) and expanded/gallery view (expanded-thumb)
   */
  function updateThumbnailProgress(jobId, pct) {
    // Find processing elements in both regular and expanded views
    const selectors = [
      `.history-thumb__processing[data-job-id="${jobId}"]`,
      `.expanded-thumb__processing[data-job-id="${jobId}"]`
    ];

    selectors.forEach(selector => {
      const processingEl = document.querySelector(selector);
      if (!processingEl) return;

      // Find child elements using class that ends with the suffix (works for both prefixes)
      const pctEl = processingEl.querySelector('[class*="__processing-pct"]');
      const fillEl = processingEl.querySelector('[class*="__progress-fill"]');
      const barEl = processingEl.querySelector('[class*="__progress-bar"]');

      // Remove indeterminate state when we have actual progress
      if (pct > 0) {
        if (pctEl) {
          pctEl.classList.remove('history-thumb__processing-pct--indeterminate');
          pctEl.classList.remove('expanded-thumb__processing-pct--indeterminate');
        }
        if (barEl) {
          barEl.classList.remove('history-thumb__progress-bar--indeterminate');
          barEl.classList.remove('expanded-thumb__progress-bar--indeterminate');
        }
      }

      if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
      if (fillEl) fillEl.style.width = `${pct}%`;
    });
  }

  /**
   * Generate a prompt fingerprint for lineage grouping
   */
  function promptFingerprint(input = '') {
    const normalized = (input || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) return '';
    return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
  }

  /**
   * Get the currently active history item
   */
  function getActiveHistoryItem() {
    const State = getState();
    const history = State.getHistory ? State.getHistory() : [];
    if (!history.length) return null;
    if (State.historyActiveModelId) {
      const active = history.find((x) => x && x.id === State.historyActiveModelId);
      if (active) return active;
    }
    return history[0] || null;
  }

  /**
   * Build source object for Meshy API from a history item
   */
  function buildMeshySourceFromItem(item = {}) {
    if (!item) return {};
    const taskId = item.id || item.preview_task_id || item.preview_task || item.source_task_id;
    const modelUrl = item.glb_url || item.glb_proxy;
    if (modelUrl) return { model_url: modelUrl };
    if (taskId) return { input_task_id: taskId };
    return {};
  }

  /**
   * Get remesh form values from the UI
   */
  function getRemeshFormValues() {
    const polyInput = byId('targetPolyCount');
    const modeInput = byId('remeshMode');
    let target_polycount = parseInt(polyInput?.value || '0', 10);
    if (!Number.isFinite(target_polycount) || target_polycount <= 0) target_polycount = 45000;
    const remeshMode = (modeInput?.value || '').toLowerCase();
    const topology = remeshMode.includes('quad') ? 'quad' : 'triangle';
    return {
      target_polycount,
      topology,
      target_formats: ['glb']
    };
  }

  /**
   * Get texture form values from the UI
   */
  function getTextureFormValues() {
    const prompt = (byId('texturePrompt')?.value || '').trim();
    const textureType = (byId('textureType')?.value || 'pbr-all').toLowerCase();
    const seamlessInput = byId('seamless');
    const seamless = seamlessInput ? !!seamlessInput.checked : true;
    const enable_pbr = textureType === 'pbr-all';
    return {
      text_style_prompt: prompt,
      enable_pbr,
      enable_original_uv: seamless,
      ai_model: 'latest'
    };
  }

  /**
   * Get rig form values from the UI
   */
  async function getRigFormValues() {
    const heightInput = byId('rigHeight');
    let height_meters = parseFloat(heightInput?.value || '1.7');
    if (!Number.isFinite(height_meters) || height_meters <= 0) height_meters = 1.7;
    let texture_image_url = '';
    const texFile = byId('rigTextureUpload')?.files?.[0];
    if (texFile) {
      texture_image_url = await fileToDataURL(texFile);
    }
    return { height_meters, texture_image_url };
  }

  /**
   * Add a generating placeholder to history
   */
  function addGeneratingPlaceholder(jobId, meta = {}) {
    const State = getState();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    if (State.historyHasJobId && State.historyHasJobId(jobId)) {
      State.updateHistoryItem(jobId, {
        status: meta.status_label?.includes('Refin') ? 'refining' : meta.status_label?.includes('Remesh') ? 'remeshing' : meta.stage === 'texture' ? 'texturing' : meta.stage === 'rig' ? 'rigging' : meta.type === 'image' ? 'generating' : 'generating',
        status_label: meta.status_label || 'Generating...',
        stage: meta.stage || 'preview',
        prompt: meta.prompt || '',
        root_prompt: meta.root_prompt || meta.prompt || '',
        title: meta.prompt ? meta.prompt.slice(0, 50) + (meta.prompt.length > 50 ? '...' : '') : meta.status_label || 'Generating...',
        thumbnail_url: meta.thumbnail_url || '',
        type: meta.type || 'model'
      });
      return;
    }
    const isRefine = meta.status_label?.includes('Refin');
    const isRemesh = meta.status_label?.includes('Remesh');
    let statusType = isRefine ? 'refining' : isRemesh ? 'remeshing' : 'generating';
    if (meta.stage === 'texture') statusType = 'texturing';
    if (meta.stage === 'rig') statusType = 'rigging';
    if (meta.type === 'image') statusType = 'generating';
    const stage = meta.stage || (isRefine ? 'refine' : isRemesh ? 'remesh' : 'preview');

    const placeholder = {
      id: jobId,
      type: meta.type || 'model',
      status: statusType,
      status_label: meta.status_label || 'Generating...',
      created_at: Date.now(),
      prompt: meta.prompt || '',
      root_prompt: meta.root_prompt || meta.prompt || '',
      title: meta.prompt ? meta.prompt.slice(0, 50) + (meta.prompt.length > 50 ? '...' : '') : meta.status_label || 'Generating...',
      art_style: meta.art_style || 'realistic',
      model: meta.model || 'latest',
      license: meta.license || 'private',
      batch_count: meta.batch_count || 1,
      batch_slot: meta.batch_slot || 1,
      batch_group_id: meta.batch_group_id || null,
      stage,
      thumbnail_url: meta.thumbnail_url || '',
      glb_url: '',
      glb_proxy: '',
      lineage_root_id: meta.lineage_origin_id || meta.batch_group_id || jobId
    };

    if (State.addHistoryItem) State.addHistoryItem(placeholder);
    if (State.historyFreshThumbs) State.historyFreshThumbs.add(jobId);
    renderHistory();
  }

  // ============================================================================
  // JOB WATCHERS
  // ============================================================================

  /**
   * Watch a text-to-3D job until completion
   */
  function watchJob(job_id) {
    const State = getState();
    const Viewer = getViewer();
    const UI = getUI();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    if (State.watchers && State.watchers.has(job_id)) return;

    let aborted = false;
    const ctl = { abort() { aborted = true; } };
    if (State.watchers) State.watchers.set(job_id, ctl);

    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };

    const poll = async (delay = 900) => {
      if (aborted) return;
      try {
        const result = await apiFetch(`/api/text-to-3d/status/${job_id}`);
        if (result.status === 404) {
          if (State.removeActiveJob) State.removeActiveJob(job_id);
          prog.clear();
          return;
        }
        const st = result.data;

        if (st.message) prog.label(st.message);
        if (typeof st.pct === 'number') {
          const pct = Math.min(98, Math.max(0, st.pct));
          prog.jump(pct);
          updateThumbnailProgress(job_id, pct);
        }

        if (st.status === 'done' && st.glb_url) {
          const pendingMeta = State.getPendingMeta ? State.getPendingMeta() : {};
          const meta = pendingMeta[job_id] || {};
          if (State.removeActiveJob) State.removeActiveJob(job_id);

          // Update wallet - use returned data or refresh from API (once per job)
          if (!creditsRefreshedJobs.has(job_id)) {
            creditsRefreshedJobs.add(job_id);
            if (st.wallet && window.WorkspaceCredits?.updateWallet) {
              window.WorkspaceCredits.updateWallet(st.wallet);
            } else {
              refreshCreditsInBackground(); // Fallback: refresh from API
            }
          }

          const glbProxy = `${BACKEND}/api/proxy-glb?u=${encodeURIComponent(st.glb_url)}`;
          log('Job done:', { st, glbProxy });

          const title = shortTitle(meta);
          const stage = st.stage || 'preview';
          const previewTaskIdForHistory =
            st.preview_task_id || (stage === 'preview' ? job_id : (meta.preview_task_id || null));
          const lineageOverride = meta.lineage_origin_id || null;
          const rootPrompt = meta.root_prompt || meta.prompt || '';
          const promptHash = promptFingerprint(rootPrompt);
          const lineageRootId = lineageOverride || previewTaskIdForHistory || job_id;

          const historyData = {
            id: job_id,
            type: 'model',
            status: 'finished',
            created_at: normalizeEpochMs(st.created_at),
            prompt: meta.prompt || '',
            root_prompt: rootPrompt,
            prompt_fingerprint: promptHash,
            title,
            art_style: meta.art_style || 'realistic',
            model: meta.model || 'latest',
            license: meta.license || 'private',
            symmetry_mode: meta.symmetry_mode || 'auto',
            is_a_t_pose: !!meta.is_a_t_pose,
            batch_count: Math.max(1, parseInt(meta.batch_count, 10) || 1),
            batch_slot: meta.batch_slot || 1,
            batch_group_id: meta.batch_group_id || null,
            stage,
            thumbnail_url: st.thumbnail_url || '',
            glb_url: st.glb_url,
            glb_proxy: glbProxy,
            preview_task_id: previewTaskIdForHistory,
            lineage_root_id: lineageRootId
          };

          if (State.historyHasJobId && State.historyHasJobId(job_id)) {
            State.updateHistoryItem(job_id, historyData);
          } else if (State.addHistoryItem) {
            State.addHistoryItem(historyData);
          }

          if (State.historyState) State.historyState.page = 1;
          if (State.historyFreshThumbs) State.historyFreshThumbs.add(job_id);
          setTimeout(() => {
            if (State.historyFreshThumbs) State.historyFreshThumbs.delete(job_id);
            renderHistory();
          }, 1800);
          if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(job_id);
          renderHistory();

          prog.jump(99, 'Downloading model...');
          if (Viewer.loadModelWithFallback) {
            await Viewer.loadModelWithFallback(glbProxy, st.glb_url);
          }
          prog.done(st.stage === 'refine' ? 'Loaded refined model.' : 'Loaded preview model.');
          return;
        }

        if (st.status === 'failed') {
          if (State.removeActiveJob) State.removeActiveJob(job_id);
          // Refresh credits (once per job) to show released credits
          if (!creditsRefreshedJobs.has(job_id)) {
            creditsRefreshedJobs.add(job_id);
            refreshCreditsInBackground();
          }
          prog.fail(st.message || 'Job failed');
          alert(st.message || 'Job failed');
          return;
        }

        setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
      } catch {
        setTimeout(() => poll(1500), 1500);
      }
    };
    poll();
  }

  /**
   * Watch a Meshy task (remesh, texture, rig, image3d)
   */
  function watchMeshyTask(job_id, kind = 'remesh') {
    const State = getState();
    const Viewer = getViewer();
    const UI = getUI();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    if (State.watchers && State.watchers.has(job_id)) return;
    let aborted = false;
    const ctl = { abort() { aborted = true; } };
    if (State.watchers) State.watchers.set(job_id, ctl);

    const endpoint = kind === 'texture'
      ? '/api/mesh/retexture'
      : kind === 'rig'
        ? '/api/mesh/rigging'
        : kind === 'image3d'
          ? '/api/image-to-3d/status'
          : '/api/mesh/remesh';

    const stageLabel = kind === 'texture'
      ? 'Texturing'
      : kind === 'rig'
        ? 'Rigging'
        : kind === 'image3d'
          ? 'Image to 3D'
          : 'Remeshing';

    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };

    // For image3d, simulate progress since Meshy API doesn't return real progress
    const startTime = Date.now();
    const estimatedDuration = kind === 'image3d' ? 120000 : 60000; // 2 mins for image3d, 1 min for others
    let simulatedPct = 0;

    const poll = async (delay = 900) => {
      if (aborted) return;
      try {
        const result = await apiFetch(`${endpoint}/${job_id}`);
        if (result.status === 404) {
          if (State.removeActiveJob) State.removeActiveJob(job_id);
          prog.clear();
          return;
        }
        const st = result.data;

        // Use real progress if available, otherwise simulate for image3d
        if (typeof st.pct === 'number' && st.pct > 0) {
          const pct = Math.min(98, Math.max(0, st.pct));
          prog.jump(pct);
          updateThumbnailProgress(job_id, pct);
        } else if (kind === 'image3d' && st.status !== 'done' && st.status !== 'failed') {
          // Simulate progress for image3d (asymptotic approach to 95%)
          const elapsed = Date.now() - startTime;
          simulatedPct = Math.min(95, Math.floor(95 * (1 - Math.exp(-elapsed / estimatedDuration))));
          prog.jump(simulatedPct);
          updateThumbnailProgress(job_id, simulatedPct);
        }

        if (st.status === 'done') {
          const pendingMeta = State.getPendingMeta ? State.getPendingMeta() : {};
          const meta = pendingMeta[job_id] || {};
          if (State.removeActiveJob) State.removeActiveJob(job_id);

          // Update wallet - use returned data or refresh from API (once per job)
          if (!creditsRefreshedJobs.has(job_id)) {
            creditsRefreshedJobs.add(job_id);
            if (st.wallet && window.WorkspaceCredits?.updateWallet) {
              window.WorkspaceCredits.updateWallet(st.wallet);
            } else {
              refreshCreditsInBackground(); // Fallback: refresh from API
            }
          }

          const glbDirect = st.glb_url
            || st.rigged_character_glb_url
            || (st.model_urls && st.model_urls.glb)
            || '';
          const glbProxy = glbDirect ? `${BACKEND}/api/proxy-glb?u=${encodeURIComponent(glbDirect)}` : '';
          const historyArr = State.getHistory ? State.getHistory() : [];
          const existingItem = historyArr.find((x) => x.id === job_id) || {};
          const existingPrompt = existingItem.prompt || '';
          const existingRootPrompt = existingItem.root_prompt || '';
          const existingTitle = existingItem.title || '';
          const promptFromStatus = st.prompt || st.root_prompt || '';
          const promptCandidate = meta.prompt || promptFromStatus || existingPrompt || '';
          const rootPromptCandidate = meta.root_prompt || st.root_prompt || meta.prompt || promptFromStatus || existingRootPrompt || '';
          let titleCandidate = shortTitle(meta);
          if (!titleCandidate || titleCandidate === '(untitled)') {
            const promptForTitle = promptCandidate || rootPromptCandidate || '';
            titleCandidate = promptForTitle ? shortTitle(promptForTitle) : '';
          }
          if (!titleCandidate || titleCandidate === '(untitled)') {
            titleCandidate = existingTitle && existingTitle !== '(untitled)' ? existingTitle : '';
          }
          const fingerprintSource = rootPromptCandidate || promptCandidate || existingRootPrompt || existingPrompt || '';
          const lineageRootId = meta.lineage_origin_id || meta.lineage_root_id || meta.preview_task_id || job_id;

          const historyData = {
            id: job_id,
            type: 'model',
            status: 'finished',
            created_at: normalizeEpochMs(st.created_at),
            art_style: meta.art_style || 'realistic',
            model: meta.model || 'latest',
            license: meta.license || 'private',
            stage: kind,
            thumbnail_url: st.thumbnail_url || meta.thumbnail_url || '',
            glb_url: glbDirect,
            glb_proxy: glbProxy,
            preview_task_id: meta.preview_task_id || null,
            lineage_root_id: lineageRootId,
            texture_urls: st.texture_urls || [],
            model_urls: st.model_urls || {},
            rigged_character_glb_url: st.rigged_character_glb_url,
            rigged_character_fbx_url: st.rigged_character_fbx_url,
            basic_animations: st.basic_animations || []
          };
          if (promptCandidate) historyData.prompt = promptCandidate;
          if (rootPromptCandidate) historyData.root_prompt = rootPromptCandidate;
          if (titleCandidate) historyData.title = titleCandidate;
          if (fingerprintSource) historyData.prompt_fingerprint = promptFingerprint(fingerprintSource);

          if (State.historyHasJobId && State.historyHasJobId(job_id)) State.updateHistoryItem(job_id, historyData);
          else if (State.addHistoryItem) State.addHistoryItem(historyData);

          if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(job_id);
          if (State.historyFreshThumbs) State.historyFreshThumbs.add(job_id);
          setTimeout(() => {
            if (State.historyFreshThumbs) State.historyFreshThumbs.delete(job_id);
            renderHistory();
          }, 1800);
          renderHistory();

          if (glbDirect) {
            prog.jump(99, 'Downloading model...');
            if (Viewer.loadModelWithFallback) {
              await Viewer.loadModelWithFallback(glbProxy || glbDirect, glbDirect);
            }
            prog.done(`${stageLabel} complete.`);
          } else {
            prog.done(`${stageLabel} complete.`);
          }
          return;
        }

        if (st.status === 'failed') {
          if (State.removeActiveJob) State.removeActiveJob(job_id);
          // Refresh credits (once per job) to show released credits
          if (!creditsRefreshedJobs.has(job_id)) {
            creditsRefreshedJobs.add(job_id);
            refreshCreditsInBackground();
          }
          prog.fail(st.message || `${stageLabel} failed`);
          alert(st.message || `${stageLabel} failed`);
          return;
        }

        setTimeout(() => poll(Math.min(4000, delay * 1.2)), delay);
      } catch {
        setTimeout(() => poll(1500), 1500);
      }
    };
    poll();
  }

  // ============================================================================
  // MESHY TASK STARTER (shared)
  // ============================================================================

  /**
   * Begin a Meshy task (remesh, texture, rig)
   */
  async function beginMeshyTask(kind, payload, meta = {}) {
    const State = getState();
    const UI = getUI();

    // Check credits before proceeding
    if (!checkCreditsFor(kind)) {
      return;
    }

    const endpoint = kind === 'texture'
      ? '/api/mesh/retexture'
      : kind === 'rig'
        ? '/api/mesh/rigging'
        : '/api/mesh/remesh';
    const statusLabel = kind === 'texture' ? 'Texturing...' : kind === 'rig' ? 'Rigging...' : 'Remeshing...';
    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };

    // Reserve credits BEFORE API call
    prog.label('Reserving credits...');
    const reservation = reserveCreditsForAction(kind, 1);
    if (reservation.insufficient) {
      return; // Insufficient credits modal shown
    }

    prog.label(statusLabel);

    let result;
    try {
      result = await apiFetch(endpoint, {
        method: 'POST',
        body: payload
      });
    } catch (err) {
      releaseCreditsReservation(reservation.reservationId);
      throw err;
    }

    if (!result.ok) {
      if (handleApiError(result, kind, reservation.reservationId)) return;
      releaseCreditsReservation(reservation.reservationId);
      throw new Error(result.error || `HTTP ${result.status}`);
    }
    const data = result.data;
    const { job_id } = data;

    if (!job_id) {
      releaseCreditsReservation(reservation.reservationId);
      throw new Error('No job id returned');
    }

    // Confirm reservation now that we have a job_id
    confirmCreditsReservation(reservation.reservationId, job_id);

    if (State.addActiveJob) State.addActiveJob(job_id);
    if (State.savePendingMeta) State.savePendingMeta(job_id, { ...meta, stage: kind, source_model_id: meta.source_model_id || meta.id });
    addGeneratingPlaceholder(job_id, { ...meta, status_label: statusLabel, stage: kind });
    watchMeshyTask(job_id, kind);
  }

  // ============================================================================
  // GENERATION TRIGGERS
  // ============================================================================

  /**
   * Start text-to-3D generation
   */
  async function onGenerateClick() {
    if (startLock) return;

    const State = getState();
    const UI = getUI();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};

    // Get batch count first for credit check
    const batchRaw = parseInt(byId('modelBatchCount')?.value || '1', 10);
    const batchCount = Math.min(4, Math.max(1, Number.isFinite(batchRaw) ? batchRaw : 1));

    // Check credits for entire batch before proceeding
    if (!checkCreditsFor('text-to-3d', batchCount)) {
      return;
    }

    startLock = true;

    const allGenBtns = document.querySelectorAll('button[id*="generate"]');
    allGenBtns.forEach(btn => btn.setAttribute('disabled', ''));

    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };

    // Track reservations for cleanup on failure
    const reservations = [];

    try {
      let promptTextarea = byId('modelPrompt') || byId('imagePrompt') || byId('texturePrompt') || byId('videoMotion');

      if (byId('text3d') && byId('image3d')) {
        const text3dTab = byId('text3d');
        const image3dTab = byId('image3d');
        if (text3dTab && !text3dTab.classList.contains('hidden')) {
          promptTextarea = byId('modelPrompt');
        } else if (image3dTab && !image3dTab.classList.contains('hidden')) {
          promptTextarea = null;
        }
      }

      const prompt = (promptTextarea?.value || '').trim();
      if (!prompt) {
        prog.clear();
        alert('Please type a prompt describing what you want to generate.');
        return;
      }

      const art_style = byId('modelArtStyle')?.value || byId('artStyle')?.value || 'realistic';
      const model = byId('modelAIModel')?.value || byId('modelSelect')?.value || 'latest';
      const license = (byId('modelLicense')?.value || 'private').trim() || 'private';
      const symmetry = (byId('modelSymmetry')?.value || 'auto').trim() || 'auto';
      const isPose = !!byId('modelPoseToggle')?.checked;
      const batchGroupId = createBatchGroupId();

      log('Generating with:', { prompt, art_style, model, batchCount, symmetry, isPose, license });

      const queueOne = async (slot) => {
        // Reserve credits for this job BEFORE API call
        prog.label(batchCount > 1
          ? `Reserving credits for preview ${slot + 1}/${batchCount}...`
          : 'Reserving credits...');

        const reservation = reserveCreditsForAction('text-to-3d', 1);
        if (reservation.insufficient) {
          return null; // Insufficient credits modal shown
        }
        reservations.push(reservation);

        prog.label(batchCount > 1
          ? `Generating preview ${slot + 1}/${batchCount}...`
          : 'Generating...');

        const payload = {
          prompt,
          art_style,
          model,
          symmetry_mode: symmetry,
          is_a_t_pose: isPose,
          license,
          batch_count: batchCount,
          batch_slot: slot + 1,
          batch_group_id: batchGroupId,
          refine: false
        };

        const result = await apiFetch('/api/text-to-3d/start', {
          method: 'POST',
          body: payload
        });

        if (!result.ok) {
          if (handleApiError(result, 'text-to-3d', reservation.reservationId)) return null;
          // Release reservation on other errors
          releaseCreditsReservation(reservation.reservationId);
          throw new Error(result.error || `HTTP ${result.status}`);
        }
        const data = result.data;
        const { job_id } = data;

        if (!job_id) {
          releaseCreditsReservation(reservation.reservationId);
          throw new Error('No job id returned');
        }

        // Confirm reservation now that we have a job_id
        confirmCreditsReservation(reservation.reservationId, job_id);

        if (State.addActiveJob) State.addActiveJob(job_id);
        const jobMeta = {
          prompt,
          art_style,
          model,
          root_prompt: prompt,
          license,
          symmetry_mode: symmetry,
          is_a_t_pose: isPose,
          batch_count: batchCount,
          batch_slot: slot + 1,
          batch_group_id: batchGroupId
        };
        if (State.savePendingMeta) State.savePendingMeta(job_id, jobMeta);
        addGeneratingPlaceholder(job_id, jobMeta);
        watchJob(job_id);
        return job_id;
      };

      for (let i = 0; i < batchCount; i++) {
        const result = await queueOne(i);
        if (result === null) return; // 402 error handled or insufficient credits
      }

    } catch (err) {
      console.error(err);
      prog.fail(err?.message || String(err));
      alert(`Generation failed: ${err?.message || err}`);
      // Release any remaining reservations on error
      reservations.forEach(r => {
        if (r.reservationId) releaseCreditsReservation(r.reservationId);
      });
    } finally {
      startLock = false;
      const allGenBtns = document.querySelectorAll('button[id*="generate"]');
      allGenBtns.forEach(btn => btn.removeAttribute('disabled'));
    }
  }

  /**
   * Start OpenAI image generation
   */
  async function startOpenAIImageGeneration() {
    if (startLock) return;

    const State = getState();
    const Viewer = getViewer();
    const UI = getUI();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return typeof x === 'string' ? x.slice(0,50) : x?.prompt?.slice(0,50) || '(untitled)'; };

    // Check credits before proceeding
    if (!checkCreditsFor('text-to-image')) {
      return;
    }

    startLock = true;

    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };
    let promptRaw = (byId('imagePrompt')?.value || '').trim();
    if (!promptRaw) promptRaw = 'Generated image';
    const resolution = byId('imageResolution')?.value || '1024x1024';
    const model = 'gpt-image-1';

    // Reserve credits BEFORE API call
    prog.label('Reserving credits...');
    const reservation = reserveCreditsForAction('text-to-image', 1);
    if (reservation.insufficient) {
      startLock = false;
      return; // Insufficient credits modal shown
    }

    if (State.historyState) {
      State.historyState.filter = 'image';
      State.historyState.page = 1;
    }
    renderHistory();

    const tempId = (crypto?.randomUUID ? crypto.randomUUID() : `openai-temp-${Date.now()}`);
    const placeholder = {
      id: tempId,
      type: 'image',
      status: 'generating',
      status_label: 'Generating image...',
      created_at: Date.now(),
      prompt: promptRaw,
      title: shortTitle(promptRaw),
      image_url: '',
      thumbnail_url: '',
      stage: 'image'
    };
    if (State.addHistoryItem) State.addHistoryItem(placeholder);
    if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(tempId);
    renderHistory();

    try {
      prog.label('Generating image...');
      const result = await apiFetch('/api/image/openai', {
        method: 'POST',
        body: {
          prompt: promptRaw,
          size: resolution,
          model,
          client_id: tempId
        }
      });

      if (!result.ok) {
        if (handleApiError(result, 'text-to-image', reservation.reservationId)) {
          // Clean up placeholder on credits error
          const historyArr = State.getHistory ? State.getHistory() : [];
          const arr = historyArr.filter((x) => x.id !== tempId);
          if (State.saveHistory) State.saveHistory(arr);
          renderHistory();
          return;
        }
        releaseCreditsReservation(reservation.reservationId);
        throw new Error(result.error || `OpenAI HTTP ${result.status}`);
      }
      const data = result.data;
      const imageUrl = preferHttpUrl(data.image_urls || data.image_url || null);
      if (!imageUrl) {
        releaseCreditsReservation(reservation.reservationId);
        throw new Error('OpenAI did not return an image URL');
      }

      // Confirm reservation now that image is generated
      confirmCreditsReservation(reservation.reservationId, tempId);

      const historyData = {
        id: tempId,
        type: 'image',
        status: 'finished',
        created_at: Date.now(),
        prompt: promptRaw,
        title: shortTitle(promptRaw),
        image_url: imageUrl,
        thumbnail_url: imageUrl,
        stage: 'image'
      };

      if (State.historyHasJobId && State.historyHasJobId(tempId)) {
        State.updateHistoryItem(tempId, historyData);
      } else if (State.addHistoryItem) {
        State.addHistoryItem(historyData);
      }

      if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(tempId);
      renderHistory();
      setTimeout(() => renderHistory(), 100);

      if (Viewer.showImageInViewer) Viewer.showImageInViewer(imageUrl);
      prog.done('Image ready.');
    } catch (err) {
      console.error('[OpenAI] Error:', err);
      prog.fail(err?.message || 'Image generation failed');
      alert(err?.message || 'Image generation failed.');
      // Clean up placeholder on error
      const historyArr = State.getHistory ? State.getHistory() : [];
      const arr = historyArr.filter((x) => x.id !== tempId);
      if (State.saveHistory) State.saveHistory(arr);
      renderHistory();
    } finally {
      startLock = false;
    }
  }

  /**
   * Start image generation by selected provider
   */
  async function startImageGenerationByProvider() {
    const State = getState();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};

    const provider = (byId('imageAIProvider')?.value || 'openai').toLowerCase();
    if (State.historyState) {
      State.historyState.filter = 'image';
      State.historyState.page = 1;
    }
    renderHistory();

    if (provider === 'openai') {
      await startOpenAIImageGeneration();
    } else {
      alert('Selected image provider is not yet available.');
    }
  }

  /**
   * Start image-to-3D from a history item
   */
  async function startImageTo3DFromHistory(item) {
    if (!item || !item.image_url) {
      alert('No image found to convert to 3D.');
      return;
    }

    const State = getState();
    const UI = getUI();

    // Check credits before proceeding
    if (!checkCreditsFor('image-to-3d')) {
      return;
    }

    const prompt = item.prompt || item.title || 'Image to 3D';
    const meta = {
      prompt: `(image2-3d) ${prompt}`,
      root_prompt: prompt,
      art_style: 'realistic',
      model: 'latest',
      stage: 'image3d',
      thumbnail_url: item.thumbnail_url || item.image_url || ''
    };

    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };

    // Reserve credits BEFORE API call
    prog.label('Reserving credits...');
    const reservation = reserveCreditsForAction('image-to-3d', 1);
    if (reservation.insufficient) {
      return; // Insufficient credits modal shown
    }

    prog.label('Starting image to 3D...');
    try {
      const result = await apiFetch('/api/image-to-3d/start', {
        method: 'POST',
        body: { image_url: item.image_url, prompt }
      });

      if (!result.ok) {
        if (handleApiError(result, 'image-to-3d', reservation.reservationId)) return;
        releaseCreditsReservation(reservation.reservationId);
        throw new Error(result.error || `HTTP ${result.status}`);
      }
      const data = result.data;
      const { job_id } = data;

      if (!job_id) {
        releaseCreditsReservation(reservation.reservationId);
        throw new Error('No job id returned');
      }

      // Confirm reservation now that we have a job_id
      confirmCreditsReservation(reservation.reservationId, job_id);

      if (State.addActiveJob) State.addActiveJob(job_id);
      if (State.savePendingMeta) State.savePendingMeta(job_id, { ...meta, type: 'model' });
      addGeneratingPlaceholder(job_id, { ...meta, status_label: 'Generating from image...', type: 'model' });
      watchMeshyTask(job_id, 'image3d');
    } catch (err) {
      prog.fail(err?.message || 'Image to 3D failed');
      alert(err?.message || 'Image to 3D failed');
    }
  }

  // ============================================================================
  // POST-PROCESS FROM HISTORY (Refine)
  // ============================================================================

  /**
   * Refine a preview model
   */
  async function onPostProcessFromHistory(item, type) {
    if (postProcessLock) return;
    if (!item) return;

    const State = getState();
    const UI = getUI();

    // Check credits before proceeding (remesh check happens in beginMeshyTask)
    if (type === 'refine' && !checkCreditsFor('refine')) {
      return;
    }

    postProcessLock = true;
    const prog = UI.makeProgressDriver ? UI.makeProgressDriver() : { label: function(){}, jump: function(){}, clear: function(){}, done: function(){}, fail: function(){} };

    // For remesh, delegate to the function that uses beginMeshyTask
    if (type === 'remesh') {
      try {
        await startRemeshFromHistory(item);
      } finally {
        postProcessLock = false;
      }
      return;
    }

    if (type !== 'refine') {
      postProcessLock = false;
      throw new Error('Unknown post-process type');
    }

    // Reserve credits BEFORE API call
    prog.label('Reserving credits...');
    const reservation = reserveCreditsForAction('refine', 1);
    if (reservation.insufficient) {
      postProcessLock = false;
      return; // Insufficient credits modal shown
    }

    prog.label('Starting refine...');

    try {
      const previewTaskIdFromItem = item.preview_task_id || (item.stage === 'preview' ? item.id : null);
      const previewTaskId = previewTaskIdFromItem;

      if (!previewTaskId) {
        releaseCreditsReservation(reservation.reservationId);
        throw new Error("Cannot refine: preview task id is missing and this card isn't a preview.");
      }

      const result = await apiFetch('/api/text-to-3d/refine', {
        method: 'POST',
        body: {
          preview_task_id: previewTaskId,
          model: item.model || 'meshy-6',
          enable_pbr: true
        }
      });

      if (!result.ok) {
        if (handleApiError(result, 'refine', reservation.reservationId)) return;
        releaseCreditsReservation(reservation.reservationId);
        throw new Error(result.error || `HTTP ${result.status}`);
      }
      const data = result.data;
      const { job_id } = data;

      if (!job_id) {
        releaseCreditsReservation(reservation.reservationId);
        throw new Error(`No job id returned for ${type}`);
      }

      // Confirm reservation now that we have a job_id
      confirmCreditsReservation(reservation.reservationId, job_id);

      if (State.addActiveJob) State.addActiveJob(job_id);
      const jobMeta = {
        prompt: `(${type}) ${item.prompt || item.title}`,
        art_style: item.art_style || 'realistic',
        model: item.model || 'latest',
        preview_task_id: previewTaskId || previewTaskIdFromItem || null,
        root_prompt: item.root_prompt || item.prompt || item.title || '',
        lineage_origin_id: item.lineage_root_id || item.id || null,
        license: item.license || 'private',
        symmetry_mode: item.symmetry_mode || 'auto',
        is_a_t_pose: !!item.is_a_t_pose,
        batch_count: 1,
        batch_group_id: item.lineage_root_id || item.id
      };
      if (State.savePendingMeta) State.savePendingMeta(job_id, jobMeta);
      addGeneratingPlaceholder(job_id, {
        ...jobMeta,
        status_label: 'Refining...'
      });
      watchJob(job_id);
    } catch (e) {
      prog.fail(`${type} failed`);
      console.error(e);
      alert(e.message || `${type} failed`);
    } finally {
      postProcessLock = false;
    }
  }

  // ============================================================================
  // PANEL-BASED OPERATIONS (Remesh, Texture, Rig)
  // ============================================================================

  /**
   * Start remesh from the panel UI
   */
  async function startRemeshFromPanel() {
    if (startLock) return;
    const History = getHistory();
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    const choice = byId('remeshModelSelect')?.value || 'current';
    const baseItem = choice === 'current' ? getActiveHistoryItem() : null;

    if (choice === 'current' && !baseItem) {
      alert('Load or generate a model before remeshing.');
      return;
    }

    let source = {};
    let labelPrompt = '';
    if (choice === 'upload') {
      const file = byId('remeshModelUpload')?.files?.[0];
      if (!file) { alert('Please choose a model to remesh.'); return; }
      const dataUrl = await fileToDataURL(file);
      source = { model_url: dataUrl };
      labelPrompt = `Remesh ${file.name}`;
    } else if (baseItem) {
      source = buildMeshySourceFromItem(baseItem);
      labelPrompt = `Remesh ${shortTitle(baseItem)}`;
    }

    const remeshValues = getRemeshFormValues();
    const meta = {
      prompt: labelPrompt || remeshValues.text_style_prompt || 'Remesh',
      root_prompt: baseItem?.root_prompt || baseItem?.prompt || '',
      art_style: baseItem?.art_style || 'realistic',
      model: baseItem?.model || 'latest',
      license: baseItem?.license || 'private',
      lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
      source_model_id: baseItem?.id || null
    };

    try {
      await beginMeshyTask('remesh', { ...source, ...remeshValues }, meta);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Remesh failed.');
    }
  }

  /**
   * Start texture from the panel UI
   */
  async function startTextureFromPanel() {
    if (startLock) return;
    const History = getHistory();
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    const choice = byId('textureModelSelect')?.value || 'current';
    const baseItem = choice === 'current' ? getActiveHistoryItem() : null;
    if (choice === 'current' && !baseItem) {
      alert('Load or generate a model before texturing.');
      return;
    }

    let source = {};
    let labelPrompt = '';
    if (choice === 'upload') {
      const file = byId('textureModelUpload')?.files?.[0];
      if (!file) { alert('Please choose a model to texture.'); return; }
      const dataUrl = await fileToDataURL(file);
      source = { model_url: dataUrl };
      labelPrompt = `Texture ${file.name}`;
    } else if (baseItem) {
      source = buildMeshySourceFromItem(baseItem);
      labelPrompt = `Texture ${shortTitle(baseItem)}`;
    }

    const texValues = getTextureFormValues();
    if (!texValues.text_style_prompt) {
      alert('Please describe the texture you want.');
      return;
    }

    const meta = {
      prompt: texValues.text_style_prompt,
      root_prompt: baseItem?.root_prompt || baseItem?.prompt || texValues.text_style_prompt,
      art_style: baseItem?.art_style || 'realistic',
      model: baseItem?.model || 'latest',
      license: baseItem?.license || 'private',
      lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
      source_model_id: baseItem?.id || null,
      thumbnail_url: baseItem?.thumbnail_url || ''
    };

    try {
      await beginMeshyTask('texture', { ...source, ...texValues }, meta);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Texture generation failed.');
    }
  }

  /**
   * Start rig from the panel UI
   */
  async function startRigFromPanel() {
    if (startLock) return;
    const State = getState();
    const History = getHistory();
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    const choice = byId('rigModelSelect')?.value || 'current';
    const baseItem = choice === 'current' ? getActiveHistoryItem() : null;
    if (choice === 'current' && !baseItem) {
      alert('Load or generate a humanoid model before rigging.');
      return;
    }

    let source = {};
    let labelPrompt = '';
    if (choice === 'upload') {
      const file = byId('rigModelUpload')?.files?.[0];
      if (!file) { alert('Please choose a humanoid GLB/GLTF to rig.'); return; }
      const dataUrl = await fileToDataURL(file);
      source = { model_url: dataUrl };
      labelPrompt = `Rig ${file.name}`;
    } else if (baseItem) {
      source = buildMeshySourceFromItem(baseItem);
      labelPrompt = `Rig ${shortTitle(baseItem)}`;
    }

    const rigValues = await getRigFormValues();
    const meta = {
      prompt: labelPrompt || 'Rig character',
      root_prompt: baseItem?.root_prompt || baseItem?.prompt || labelPrompt,
      art_style: baseItem?.art_style || 'realistic',
      model: baseItem?.model || 'latest',
      license: baseItem?.license || 'private',
      lineage_origin_id: baseItem?.lineage_root_id || baseItem?.id || null,
      source_model_id: baseItem?.id || null,
      thumbnail_url: baseItem?.thumbnail_url || ''
    };

    try {
      await beginMeshyTask('rig', { ...source, ...rigValues }, meta);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Rigging failed.');
    }
  }

  // ============================================================================
  // HISTORY-BASED OPERATIONS (Remesh, Texture, Rig)
  // ============================================================================

  /**
   * Start remesh from a history item
   */
  async function startRemeshFromHistory(item) {
    if (!item) return;
    const State = getState();
    const History = getHistory();
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(item.id);
    const source = buildMeshySourceFromItem(item);
    const remeshValues = getRemeshFormValues();
    const meta = {
      prompt: `Remesh ${shortTitle(item)}`,
      root_prompt: item.root_prompt || item.prompt || '',
      art_style: item.art_style || 'realistic',
      model: item.model || 'latest',
      license: item.license || 'private',
      lineage_origin_id: item.lineage_root_id || item.id,
      source_model_id: item.id,
      thumbnail_url: item.thumbnail_url || ''
    };
    try {
      await beginMeshyTask('remesh', { ...source, ...remeshValues }, meta);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Remesh failed.');
    }
  }

  /**
   * Start texture from a history item
   */
  async function startTextureFromHistory(item) {
    if (!item) return;
    const State = getState();
    const History = getHistory();
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(item.id);
    const source = buildMeshySourceFromItem(item);
    const texValues = getTextureFormValues();
    if (!texValues.text_style_prompt) {
      texValues.text_style_prompt = item.prompt || `Texture ${shortTitle(item)}`;
    }
    const meta = {
      prompt: texValues.text_style_prompt || `Texture ${shortTitle(item)}`,
      root_prompt: item.root_prompt || item.prompt || texValues.text_style_prompt || '',
      art_style: item.art_style || 'realistic',
      model: item.model || 'latest',
      license: item.license || 'private',
      lineage_origin_id: item.lineage_root_id || item.id,
      source_model_id: item.id,
      thumbnail_url: item.thumbnail_url || ''
    };
    try {
      await beginMeshyTask('texture', { ...source, ...texValues }, meta);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Texture generation failed.');
    }
  }

  /**
   * Start rig from a history item
   */
  async function startRigFromHistory(item) {
    if (!item) return;
    const State = getState();
    const History = getHistory();
    const shortTitle = History.shortTitle || window.shortTitle || function(x) { return x?.prompt?.slice(0,50) || '(untitled)'; };

    if (State.setHistoryActiveModelId) State.setHistoryActiveModelId(item.id);
    const source = buildMeshySourceFromItem(item);
    const rigValues = await getRigFormValues();
    const meta = {
      prompt: `Rig ${shortTitle(item)}`,
      root_prompt: item.root_prompt || item.prompt || '',
      art_style: item.art_style || 'realistic',
      model: item.model || 'latest',
      license: item.license || 'private',
      lineage_origin_id: item.lineage_root_id || item.id,
      source_model_id: item.id,
      thumbnail_url: item.thumbnail_url || ''
    };
    try {
      await beginMeshyTask('rig', { ...source, ...rigValues }, meta);
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Rigging failed.');
    }
  }

  // ============================================================================
  // RESUME PENDING JOBS ON PAGE LOAD
  // ============================================================================

  /**
   * Fetch backend job IDs to verify active jobs
   */
  async function fetchBackendJobIds() {
    try {
      const result = await apiFetch('/api/text-to-3d/list');
      if (!result.ok) return null;
      const payload = result.data;
      if (!Array.isArray(payload)) return [];
      return payload
        .map((entry) => {
          if (!entry) return null;
          if (typeof entry === 'string') return entry.trim();
          if (typeof entry === 'object') return entry.job_id || entry.id || null;
          return null;
        })
        .filter(Boolean);
    } catch (err) {
      console.warn('Failed to fetch backend job list:', err);
      return null;
    }
  }

  /**
   * Resume watching any jobs that were in progress
   */
  async function resumePendingJobs(options = {}) {
    const { skipEmptyUI = false } = options;
    const State = getState();
    const UI = getUI();
    const History = getHistory();
    const renderHistory = History.renderHistory || window.renderHistory || function() {};

    let pendingMeta = State.getPendingMeta ? State.getPendingMeta() : {};
    let ids = State.getActiveJobs ? State.getActiveJobs() : [];
    if (!ids.length) {
      const history = State.getHistory ? State.getHistory() : [];
      const resumable = history.filter(item => {
        if (!item || !item.id) return false;
        const status = (item.status || '').toLowerCase();
        if (status && status !== 'finished' && status !== 'failed') return true;
        return false;
      });
      ids = resumable.map(item => item.id);
      ids.forEach(id => { if (State.addActiveJob) State.addActiveJob(id); });
      resumable.forEach(item => {
        if (!pendingMeta[item.id]) {
          if (State.savePendingMeta) {
            State.savePendingMeta(item.id, {
              stage: item.stage || (item.type === 'image' ? 'image' : 'remesh'),
              type: item.type || 'model',
              prompt: item.prompt || '',
              root_prompt: item.root_prompt || item.prompt || '',
              title: item.title || '',
              thumbnail_url: item.thumbnail_url || ''
            });
          }
        }
      });
      pendingMeta = State.getPendingMeta ? State.getPendingMeta() : {};
    }
    if (ids.length) {
      const history = State.getHistory ? State.getHistory() : [];
      ids.forEach((id) => {
        const meta = pendingMeta?.[id];
        if (meta && meta.stage) return;
        const item = history.find(entry => entry && entry.id === id);
        if (!item) return;
        if (State.savePendingMeta) {
          State.savePendingMeta(id, {
            stage: item.stage || (item.type === 'image' ? 'image' : 'remesh'),
            type: item.type || 'model',
            prompt: item.prompt || '',
            root_prompt: item.root_prompt || item.prompt || '',
            title: item.title || '',
            thumbnail_url: item.thumbnail_url || ''
          });
        }
      });
      pendingMeta = State.getPendingMeta ? State.getPendingMeta() : {};
    }
    if (!ids.length) {
      if (!skipEmptyUI && UI.showOutputEmpty) UI.showOutputEmpty();
      return;
    }
    const meshIds = [];
    const imageIds = [];
    const textIds = [];

    ids.forEach((id) => {
      const stage = pendingMeta?.[id]?.stage;
      if (stage === 'remesh' || stage === 'texture' || stage === 'rig' || stage === 'image3d') {
        meshIds.push(id);
      } else if (stage === 'image') {
        imageIds.push(id);
      } else {
        textIds.push(id);
      }
    });

    // Verify text-to-3d jobs still exist on backend
    if (textIds.length) {
      const remoteIds = await fetchBackendJobIds();
      if (remoteIds !== null) {
        const validIds = textIds.filter(id => remoteIds.includes(id));
        const staleIds = textIds.filter(id => !remoteIds.includes(id));
        staleIds.forEach(id => { if (State.removeActiveJob) State.removeActiveJob(id); });
        textIds.length = 0;
        textIds.push(...validIds);
      }
    }

    // OpenAI image jobs are synchronous (no polling) - if we refresh mid-request,
    // they can't be resumed. Mark them as failed and clean up.
    if (imageIds.length) {
      log(`[Resume] Cleaning up ${imageIds.length} stale image job(s) - cannot resume synchronous requests`);
      imageIds.forEach(id => {
        if (State.removeActiveJob) State.removeActiveJob(id);
        // Mark as failed in history so user knows it didn't complete
        if (State.historyHasJobId && State.historyHasJobId(id)) {
          State.updateHistoryItem(id, {
            status: 'failed',
            status_label: 'Interrupted - please retry'
          });
        }
      });
      renderHistory();
    }

    const allToResume = [...meshIds, ...textIds];
    if (!allToResume.length) {
      if (!skipEmptyUI && UI.showOutputEmpty) UI.showOutputEmpty();
      return;
    }

    log(`Resuming ${allToResume.length} pending job(s)`);

    for (const id of meshIds) {
      const stage = pendingMeta[id]?.stage || 'remesh';
      watchMeshyTask(id, stage);
    }

    for (const id of textIds) {
      watchJob(id);
    }
  }

  // ============================================================================
  // EXPOSE GLOBALLY
  // ============================================================================
  window.API = {
    watchJob,
    watchMeshyTask,
    onGenerateClick,
    startOpenAIImageGeneration,
    startImageGenerationByProvider,
    startImageTo3DFromHistory,
    onPostProcessFromHistory,
    startRemeshFromPanel,
    startTextureFromPanel,
    startRigFromPanel,
    startRemeshFromHistory,
    startTextureFromHistory,
    startRigFromHistory,
    resumePendingJobs,
    getActiveHistoryItem
  };

  // Backward compatibility - expose individual functions globally
  window.watchJob = watchJob;
  window.watchMeshyTask = watchMeshyTask;
  window.startTextureFromHistory = startTextureFromHistory;
  window.startRemeshFromHistory = startRemeshFromHistory;
  window.startRigFromHistory = startRigFromHistory;
  window.startImageTo3DFromHistory = startImageTo3DFromHistory;
  window.onGenerateClick = onGenerateClick;
  window.getActiveHistoryItem = getActiveHistoryItem;

})();
