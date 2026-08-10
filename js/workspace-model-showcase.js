/* ==========================================================================
   WORKSPACE MODEL SHOWCASE
   --------------------------------------------------------------------------
   Three.js carousel of real TimrX generations floating above the neural
   background. Interactive layer:

     hover    a prompt bubble rises above the model — the actual prompt that
              made it, tool tag, and interaction hints. Raycast against the
              loaded wrappers, projected to screen space each frame.
     click    active model → inspect mode: drag to orbit (free yaw, clamped
              pitch), wheel to zoom, inertia on release; auto-rotation
              resumes after 3s idle or Esc. Side model → it slides to the
              centre (positions tween now instead of snapping).
     keys     ← / → step the carousel when no input has focus.
     copy     the bubble's "Use prompt" copies the prompt to the clipboard.

   The canvas accepts pointer events only while the showcase is ready and no
   panel/palette/modal owns the screen (CSS gates it), so the workspace
   chrome keeps its hit targets.
   ========================================================================== */
(function () {
  'use strict';

  const FALLBACK_MODEL_ITEMS = [
    { name: 'Fox', url: '3D%20Workspace%20Models/3DWorkspace%20Models.glb',
      prompt: 'A cute stylized fox with a fluffy tail, big expressive eyes, game-ready character', tool: 'TEXT TO 3D' },
    { name: 'Digital Sculpture', url: '3D%20Workspace%20Models/TX-a-full-body-3d-digital-s-102.glb', scale: 0.54, y: -0.82,
      prompt: 'A full body 3D digital sculpture, collectible figure finish', tool: 'TEXT TO 3D' },
    { name: 'Stylized Figure', url: '3D%20Workspace%20Models/TX-a-high-quality-stylized-184.glb', scale: 0.48, y: -0.78,
      prompt: 'A high quality stylized character figure, clean topology', tool: 'TEXT TO 3D' },
    { name: 'Hero Character', url: '3D%20Workspace%20Models/TX-a-high-quality-stylized-505.glb',
      prompt: 'A high quality stylized hero character, production textures', tool: 'TEXT TO 3D' },
    { name: 'Humorous Character', url: '3D%20Workspace%20Models/TX-a-highly-stylized-humoro-111.glb',
      prompt: 'A highly stylized humorous character, exaggerated proportions', tool: 'TEXT TO 3D' },
    { name: 'Dragonborn', url: '3D%20Workspace%20Models/TX-a-male-dragonborn-barbar-235.glb',
      prompt: 'A male dragonborn barbarian, scaled skin, battle-worn armor', tool: 'TEXT TO 3D' },
    { name: 'Elven Ranger', url: '3D%20Workspace%20Models/TX-a-male-fantasy-elven-ran-219.glb',
      prompt: 'A male fantasy elven ranger with bow and forest cloak', tool: 'TEXT TO 3D' },
    { name: 'Dwarven Paladin', url: '3D%20Workspace%20Models/TX-a-stout-dwarven-paladin-510.glb',
      prompt: 'A stout dwarven paladin in ornate blackened plate armor', tool: 'TEXT TO 3D' },
    { name: 'Steampunk Character', url: '3D%20Workspace%20Models/TX-a-victorian-steampunk-re-414.glb', scale: 0.74, y: -0.18,
      prompt: 'A victorian steampunk revolver, brass fittings, walnut grip', tool: 'TEXT TO 3D' },
    { name: 'Small Steampunk', url: '3D%20Workspace%20Models/TX-refine-a-small-steampunk-608.glb',
      prompt: 'A small steampunk automaton with glowing green eyes and a top hat', tool: 'TEXT TO 3D · REFINE' },
  ];

  let MODEL_ITEMS = [...FALLBACK_MODEL_ITEMS];
  const TAU = Math.PI * 2;
  const VISIBLE_RADIUS = 5;
  const MIN_SHOWCASE_MODELS = 4;
  const LIVE_FEED_LIMIT = 10;
  const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let _tweenTarget = null;

  const state = {
    initialized: false,
    ready: false,
    activeIndex: 0,
    targetRotation: -0.32,
    currentRotation: -0.32,
    wheelDelta: 0,
    wheelLockUntil: 0,
    spinGlowTimer: 0,
    clock: null,
    renderer: null,
    camera: null,
    scene: null,
    carousel: null,
    showcase: null,
    canvas: null,
    prevBtn: null,
    nextBtn: null,
    models: new Map(),
    loading: new Set(),
    preloadQueue: [],
    preloadTimer: 0,
    /* interaction */
    raycaster: null,
    pointerNdc: null,
    hoverIndex: -1,
    bubble: null,
    bubbleName: null,
    bubblePrompt: null,
    bubbleTool: null,
    bubbleHint: null,
    bubbleCopy: null,
    bubbleFor: -1,
    copyResetTimer: 0,
    zoomTarget: 0,
    inspect: {
      on: false,
      dragging: false,
      moved: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      velY: 0,
      rotY: 0,
      rotX: 0,
      idleTimer: 0,
    },
  };

  function waitForThree(callback) {
    if (window.THREE && window.THREE.GLTFLoader) { callback(); return; }
    window.addEventListener('three-ready', callback, { once: true });
  }

  /* ----- live community feed (falls back to the local curated set) ------- */

  function backendBase() {
    return (window.TIMRX_3D_API_BASE || window.TimrXApi?.BACKEND || 'https://3d.timrx.live').replace(/\/$/, '');
  }

  function shouldProxyModelUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /assets\.meshy\.ai|meshy\.ai|timrx-3d-models\.s3/i.test(url);
  }

  function loadableModelUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (window.TimrXApi?.getLoadableModelUrl) return window.TimrXApi.getLoadableModelUrl(url);
    if (url.startsWith('/api/')) return `${backendBase()}${url}`;
    if (shouldProxyModelUrl(url)) return `${backendBase()}/api/_mod/proxy-glb?u=${encodeURIComponent(url)}`;
    return url;
  }

  function normalizeFeedModel(item) {
    const url = loadableModelUrl(item.url || item.glb_url || item.glbUrl || item.model_url);
    if (!url) return null;

    return {
      id: item.id || item.post_id || url,
      name: item.name || item.title || 'Community model',
      url,
      source: item.source || 'community',
      thumbnail_url: item.thumbnail_url || item.thumbnail || '',
      prompt: item.prompt || item.description || '',
      tool: (item.tool || item.generation_type || 'community creation').toString().toUpperCase(),
      author: item.author || item.creator || item.username || '',
    };
  }

  async function loadLiveShowcaseModels() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);

    try {
      const params = new URLSearchParams({
        limit: String(LIVE_FEED_LIMIT),
        sort: 'curated',
      });
      const response = await fetch(`${backendBase()}/api/_mod/community/showcase-models?${params}`, {
        credentials: 'include',
        mode: 'cors',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) return false;
      const data = await response.json();
      const liveModels = (data.models || data.items || [])
        .map(normalizeFeedModel)
        .filter(Boolean);

      if (liveModels.length < MIN_SHOWCASE_MODELS) return false;

      MODEL_ITEMS = liveModels.slice(0, LIVE_FEED_LIMIT);
      state.activeIndex = 0;
      state.modelUrl = MODEL_ITEMS[state.activeIndex].url;
      state.showcase.dataset.feed = 'live';
      return true;
    } catch (error) {
      console.warn('TimrX live workspace models unavailable; using local curated models.', error);
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function normalizeRadians(value) {
    if (Math.abs(value) < 1000) return value;
    return value % TAU;
  }

  function circularIndex(index) {
    return (index + MODEL_ITEMS.length) % MODEL_ITEMS.length;
  }

  function signedOffset(index, activeIndex) {
    const total = MODEL_ITEMS.length;
    let offset = index - activeIndex;
    if (offset > total / 2) offset -= total;
    if (offset < -total / 2) offset += total;
    return offset;
  }

  function modelHeightForViewport() {
    if (window.matchMedia('(max-width: 430px)').matches) return 1.76;
    if (window.matchMedia('(max-width: 560px)').matches) return 1.84;
    if (window.matchMedia('(max-width: 900px)').matches) return 2.18;
    return 3.24;
  }

  function baseCameraZ() {
    if (window.matchMedia('(max-width: 430px)').matches) return 12.4;
    if (window.matchMedia('(max-width: 700px)').matches) return 12.0;
    return 22;
  }

  function setRendererSize() {
    if (!state.renderer || !state.camera || !state.canvas) return;
    const rect = state.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
    frameCamera();
    normalizeLoadedModels(window.THREE);
  }

  function frameCamera() {
    if (!state.camera) return;
    const compact = window.matchMedia('(max-width: 700px)').matches;
    state.zoomTarget = baseCameraZ();
    state.camera.position.set(0, 0.08, state.zoomTarget);
    state.camera.lookAt(0, compact ? 0 : 0.02, 0);
  }

  function normalizeModel(root, THREE) {
    if (!root || !THREE) return;
    if (!root.userData.timrxShowcaseBounds) {
      const box = new THREE.Box3().setFromObject(root);
      root.userData.timrxShowcaseBounds = {
        size: box.getSize(new THREE.Vector3()),
        center: box.getCenter(new THREE.Vector3()),
      };
    }
    const { size, center } = root.userData.timrxShowcaseBounds;
    const height = Math.max(size.y, 0.0001);
    const targetHeight = modelHeightForViewport();
    const modelScale = MODEL_ITEMS[root.userData.timrxItemIndex]?.scale || 1;
    const scale = (targetHeight / height) * modelScale;
    root.scale.setScalar(scale);
    root.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  }

  function normalizeLoadedModels(THREE) {
    state.models.forEach((entry) => normalizeModel(entry.root, THREE));
  }

  function tuneMaterials(root, THREE) {
    const tunedMaterials = [];
    root.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = false;
      node.receiveShadow = false;
      if (!node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => {
        if ('metalness' in material) material.metalness = Math.max(material.metalness || 0, 0.2);
        if ('roughness' in material) material.roughness = Math.min(Math.max(material.roughness || 0.42, 0.28), 0.66);
        if ('envMapIntensity' in material) material.envMapIntensity = 1.18;
        if ('emissive' in material && material.emissive instanceof THREE.Color) {
          material.emissive.lerp(new THREE.Color(0x1a0f06), 0.08);
          material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 0.025);
        }
        material.needsUpdate = true;
        tunedMaterials.push(material);
      });
    });
    return Array.from(new Set(tunedMaterials));
  }

  function loadModel(index) {
    const itemIndex = circularIndex(index);
    if (state.models.has(itemIndex) || state.loading.has(itemIndex)) return;
    const THREE = window.THREE;
    if (!THREE || !THREE.GLTFLoader || !state.carousel) return;

    state.loading.add(itemIndex);
    const loader = new THREE.GLTFLoader();
    loader.load(
      MODEL_ITEMS[itemIndex].url,
      (gltf) => {
        const wrapper = new THREE.Group();
        const root = gltf.scene;
        root.userData.timrxItemIndex = itemIndex;
        const materials = tuneMaterials(root, THREE);
        normalizeModel(root, THREE);
        wrapper.add(root);
        wrapper.userData.itemIndex = itemIndex;
        wrapper.visible = false;
        state.carousel.add(wrapper);

        state.models.set(itemIndex, {
          wrapper,
          root,
          materials,
          lastOffset: null,
          settled: false,
          targetPos: new THREE.Vector3(),
          targetScale: 1,
          targetOpacity: 1,
          mixer: gltf.animations && gltf.animations.length ? new THREE.AnimationMixer(root) : null,
        });

        const entry = state.models.get(itemIndex);
        if (entry?.mixer) entry.mixer.clipAction(gltf.animations[0]).play();

        state.loading.delete(itemIndex);
        state.ready = true;
        state.showcase.classList.add('is-ready');
        state.modelUrl = MODEL_ITEMS[state.activeIndex].url;
        window.timrxWorkspaceModelShowcase = state;
        layoutCarousel();
      },
      undefined,
      (error) => {
        state.loading.delete(itemIndex);
        console.warn(`TimrX workspace model could not be loaded: ${MODEL_ITEMS[itemIndex].name}`, error);
        state.loadFailures = (state.loadFailures || 0) + 1;
        recoverIfFeedUnloadable();
      }
    );
  }

  /* If the live feed answered but none of its models actually load (auth-
     gated proxy, expired URLs, CORS), fall back to the bundled local set —
     an empty stage is never the right outcome. */
  function recoverIfFeedUnloadable() {
    if (state.usedFallbackRecovery) return;
    if (state.showcase?.dataset.feed !== 'live') return;
    if (state.models.size > 0) return;
    if ((state.loadFailures || 0) < MODEL_ITEMS.length) return;

    state.usedFallbackRecovery = true;
    console.warn('TimrX live showcase models all failed to load; reverting to local curated models.');
    MODEL_ITEMS = [...FALLBACK_MODEL_ITEMS];
    state.activeIndex = 0;
    state.modelUrl = MODEL_ITEMS[0].url;
    state.showcase.dataset.feed = 'local';
    state.loading.clear();
    state.preloadQueue = [];
    window.clearTimeout(state.preloadTimer);
    loadActiveModel();
    scheduleModelPreload();
  }

  function loadActiveModel() { loadModel(state.activeIndex); }

  function scheduleModelPreload() {
    const active = state.activeIndex;
    const ordered = MODEL_ITEMS
      .map((_, index) => ({ index, distance: Math.abs(signedOffset(index, active)) }))
      .sort((a, b) => a.distance - b.distance)
      .map((item) => item.index);

    state.preloadQueue = ordered.filter((index) => !state.models.has(index) && !state.loading.has(index));
    window.clearTimeout(state.preloadTimer);

    const tick = () => {
      const nextIndex = state.preloadQueue.find((index) => !state.models.has(index) && !state.loading.has(index));
      if (typeof nextIndex === 'undefined') return;
      loadModel(nextIndex);
      state.preloadQueue = state.preloadQueue.filter((index) => index !== nextIndex);
      state.preloadTimer = window.setTimeout(tick, 780);
    };

    state.preloadTimer = window.setTimeout(tick, 520);
  }

  /* Positions/scales are targets; render() eases every wrapper toward them,
     so stepping slides the row instead of teleporting it. */
  function layoutCarousel() {
    const phone = window.matchMedia('(max-width: 560px)').matches;
    const compact = window.matchMedia('(max-width: 700px)').matches;
    /* Wider berth between slots, larger figures, and every model standing on
       the same floor line (feet-aligned from its real bounds, not centred). */
    const stageX = phone
      ? [0, 2.9, 5.7, 8.2, 10.4, 12.2]
      : compact
      ? [0, 3.4, 6.6, 9.4, 11.9, 14.1]
      : [0, 6.1, 11.8, 17.0, 21.8, 26.2];
    const stageZ = [0, -0.02, -0.04, -0.06, -0.08, -0.1];
    const scaleAll = phone ? 1.16 : compact ? 1.18 : 1.52;
    const FLOOR = phone ? -1.12 : compact ? -1.2 : -1.68;

    state.models.forEach((entry, index) => {
      const offset = signedOffset(index, state.activeIndex);
      const abs = Math.abs(offset);
      const visible = abs <= VISIBLE_RADIUS;
      entry.wrapper.visible = visible;
      if (!visible) { entry.settled = false; return; }

      const direction = Math.sign(offset);
      const item = MODEL_ITEMS[index] || {};
      /* The hero steps toward the viewer: zoomed a little and lifted onto
         its own animation (see render()). */
      entry.targetScale = scaleAll * (offset === 0 ? 1.22 : 1);
      const bounds = entry.root.userData.timrxShowcaseBounds;
      const worldHalfH = bounds
        ? (bounds.size.y * entry.root.scale.x * entry.targetScale) / 2
        : modelHeightForViewport() * entry.targetScale * 0.5;
      /* Everyone shares z≈0: a z-step toward the camera would project the
         hero's feet below the row's floor line. Zoom lives in scale only. */
      entry.targetPos.set(
        direction * (stageX[abs] ?? stageX.at(-1)),
        FLOOR + worldHalfH + (item.y || 0),
        stageZ[abs] ?? stageZ.at(-1)
      );
      entry.targetOpacity = Math.max(0.52, 1 - abs * 0.08);
      entry.targetRotY = offset === 0 ? null : -offset * 0.26;
      entry.targetRotZ = offset === 0 ? 0 : -offset * 0.045;

      /* First placement of a freshly loaded wrapper goes directly to its
         target — easing in from the origin would fly it across the stage. */
      if (!entry.settled) {
        entry.wrapper.position.copy(entry.targetPos);
        entry.wrapper.scale.setScalar(entry.targetScale);
        entry.settled = true;
      }

      if (entry.lastOffset !== offset) {
        entry.materials.forEach((material) => {
          material.transparent = abs > 0;
          material.depthWrite = abs === 0;
          material.needsUpdate = true;
        });
        entry.lastOffset = offset;
      }
    });
  }

  function focusIndex(nextIndex) {
    if (!state.ready) return;
    exitInspect(true, 'focus');
    state.activeIndex = circularIndex(nextIndex);
    state.targetRotation = -0.32;
    state.modelUrl = MODEL_ITEMS[state.activeIndex].url;
    loadActiveModel();
    scheduleModelPreload();
    layoutCarousel();
    if (state.bubbleFor !== -1) showBubbleFor(state.hoverIndex);
  }

  function stepCarousel(direction) {
    focusIndex(state.activeIndex + direction);
    state.currentRotation = -0.32;
  }

  /* ----- inspect mode: click the hero, take the camera ------------------- */

  function enterInspect() {
    const active = state.models.get(state.activeIndex);
    if (!active) return;
    state.inspect.on = true;
    state.inspect.rotY = normalizeRadians(state.currentRotation);
    state.inspect.rotX = 0;
    state.inspect.velY = 0;
    state.showcase.classList.add('is-inspecting');
    armInspectIdle();
  }

  function exitInspect(immediate, reason) {
    if (!state.inspect.on) return;
    state.inspect.on = false;
    state.inspect.dragging = false;
    window.clearTimeout(state.inspect.idleTimer);
    state.showcase.classList.remove('is-inspecting', 'is-dragging');
    /* hand the current orientation back to the idle spin so nothing jumps */
    state.currentRotation = state.inspect.rotY;
    state.targetRotation = immediate ? -0.32 : state.inspect.rotY - 0.001;
    window.setTimeout(() => { state.targetRotation = -0.32; }, immediate ? 0 : 1200);
    state.zoomTarget = baseCameraZ();
  }

  function armInspectIdle() {
    window.clearTimeout(state.inspect.idleTimer);
    state.inspect.idleTimer = window.setTimeout(() => exitInspect(false, 'idle'), 3000);
  }

  /* ----- pointer plumbing ------------------------------------------------ */

  function ndcFromEvent(event) {
    const rect = state.canvas.getBoundingClientRect();
    state.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickModel(event) {
    if (!state.raycaster || !state.camera) return -1;
    const THREE = window.THREE;
    ndcFromEvent(event);
    state.raycaster.setFromCamera(state.pointerNdc, state.camera);

    /* Precise pass first. Note: skinned meshes raycast against their BIND
       pose, so an animated character can visually sit where the ray reports
       a miss — the box pass below catches those. */
    const roots = [];
    state.models.forEach((entry) => { if (entry.wrapper.visible) roots.push(entry.wrapper); });
    const hits = state.raycaster.intersectObjects(roots, true);
    if (hits.length) {
      let node = hits[0].object;
      while (node && typeof node.userData.itemIndex === 'undefined') node = node.parent;
      if (node) return node.userData.itemIndex;
    }

    /* Bounding-box pass: cheap analytic box per wrapper from the normalized
       bounds — no geometry traversal. Nearest hit wins. */
    let best = -1;
    let bestZ = Infinity;
    const box = new THREE.Box3();
    const half = new THREE.Vector3();
    state.models.forEach((entry, index) => {
      if (!entry.wrapper.visible) return;
      const bounds = entry.root.userData.timrxShowcaseBounds;
      if (!bounds) return;
      const scale = entry.root.scale.x * entry.wrapper.scale.x;
      half.set(
        Math.max(bounds.size.x * scale * 0.5, 0.35),
        Math.max(bounds.size.y * scale * 0.5, 0.35),
        Math.max(bounds.size.z * scale * 0.5, 0.35)
      );
      box.min.copy(entry.wrapper.position).sub(half);
      box.max.copy(entry.wrapper.position).add(half);
      if (state.raycaster.ray.intersectsBox(box)) {
        const dz = Math.abs(entry.wrapper.position.z - state.camera.position.z);
        if (dz < bestZ) { bestZ = dz; best = index; }
      }
    });
    return best;
  }

  function onPointerMove(event) {
    if (!state.ready) return;

    if (state.inspect.dragging) {
      const dx = event.clientX - state.inspect.lastX;
      const dy = event.clientY - state.inspect.lastY;
      state.inspect.lastX = event.clientX;
      state.inspect.lastY = event.clientY;
      state.inspect.rotY += dx * 0.0085;
      state.inspect.rotX = Math.max(-0.55, Math.min(0.55, state.inspect.rotX + dy * 0.004));
      state.inspect.velY = dx * 0.0085;
      if (Math.abs(dx) + Math.abs(dy) > 2) state.inspect.moved = true;
      armInspectIdle();
      return;
    }

    const hit = pickModel(event);
    if (hit !== state.hoverIndex) {
      state.hoverIndex = hit;
      state.canvas.style.cursor = hit === -1 ? '' : (hit === state.activeIndex ? 'grab' : 'pointer');
      showBubbleFor(hit);
    }
  }

  function onPointerDown(event) {
    if (!state.ready || event.button === 2) return;
    const hit = pickModel(event);
    if (hit === -1) return;

    if (hit === state.activeIndex) {
      if (!state.inspect.on) enterInspect();
      state.inspect.dragging = true;
      state.inspect.moved = false;
      state.inspect.pointerId = event.pointerId;
      state.inspect.lastX = event.clientX;
      state.inspect.lastY = event.clientY;
      state.showcase.classList.add('is-dragging');
      state.canvas.style.cursor = 'grabbing';
      try { state.canvas.setPointerCapture(event.pointerId); } catch (err) { /* older engines */ }
      event.preventDefault();
    }
  }

  function onPointerUp(event) {
    if (state.inspect.dragging && event.pointerId === state.inspect.pointerId) {
      state.inspect.dragging = false;
      state.showcase.classList.remove('is-dragging');
      state.canvas.style.cursor = state.hoverIndex === state.activeIndex ? 'grab' : '';
      try { state.canvas.releasePointerCapture(event.pointerId); } catch (err) { /* noop */ }
      armInspectIdle();
      return;
    }
    /* plain click (no drag): side model → bring it to the centre */
    const hit = pickModel(event);
    if (hit !== -1 && hit !== state.activeIndex) {
      focusIndex(hit);
    }
  }

  function onPointerLeave() {
    if (state.inspect.dragging) return;
    state.hoverIndex = -1;
    state.canvas.style.cursor = '';
    showBubbleFor(-1);
  }

  function onKeyDown(event) {
    if (!state.ready) return;
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable) return;
    if (document.body.classList.contains('ws-cmd-open') || document.body.classList.contains('ws-viewer-open')) return;
    if (event.key === 'ArrowLeft') { stepCarousel(-1); }
    else if (event.key === 'ArrowRight') { stepCarousel(1); }
    else if (event.key === 'Escape' && state.inspect.on) { exitInspect(true, 'esc'); }
  }

  /* ----- prompt bubble --------------------------------------------------- */

  function buildBubble() {
    const bubble = document.createElement('div');
    bubble.className = 'showcase-bubble';
    bubble.setAttribute('aria-hidden', 'true');
    bubble.innerHTML =
      '<span class="showcase-bubble__frame" aria-hidden="true"></span>' +
      '<span class="showcase-bubble__scan" aria-hidden="true"></span>' +
      '<div class="showcase-bubble__body">' +
      '  <div class="showcase-bubble__head">' +
      '    <span class="showcase-bubble__name" data-bubble-name></span>' +
      '    <span class="showcase-bubble__tool" data-bubble-tool></span>' +
      '  </div>' +
      '  <p class="showcase-bubble__prompt" data-bubble-prompt></p>' +
      '  <div class="showcase-bubble__foot">' +
      '    <button type="button" class="showcase-bubble__copy" data-bubble-copy>Use prompt</button>' +
      '    <span class="showcase-bubble__hint" data-bubble-hint></span>' +
      '  </div>' +
      '</div>' +
      '<span class="showcase-bubble__beam" aria-hidden="true"></span>';
    state.showcase.appendChild(bubble);
    state.bubble = bubble;
    state.bubbleName = bubble.querySelector('[data-bubble-name]');
    state.bubblePrompt = bubble.querySelector('[data-bubble-prompt]');
    state.bubbleTool = bubble.querySelector('[data-bubble-tool]');
    state.bubbleHint = bubble.querySelector('[data-bubble-hint]');
    state.bubbleCopy = bubble.querySelector('[data-bubble-copy]');

    state.bubbleCopy.addEventListener('click', (event) => {
      event.stopPropagation();
      const item = MODEL_ITEMS[state.bubbleFor];
      if (!item) return;
      const done = () => {
        state.bubbleCopy.textContent = 'Copied ✓';
        state.bubbleCopy.classList.add('is-copied');
        window.clearTimeout(state.copyResetTimer);
        state.copyResetTimer = window.setTimeout(() => {
          state.bubbleCopy.textContent = 'Use prompt';
          state.bubbleCopy.classList.remove('is-copied');
        }, 1600);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(item.prompt).then(done, done);
      else done();
    });
    /* keep the bubble alive while the pointer is on it */
    bubble.addEventListener('pointerenter', () => bubble.classList.add('is-pinned'));
    bubble.addEventListener('pointerleave', () => bubble.classList.remove('is-pinned'));
  }

  function showBubbleFor(index) {
    if (!state.bubble) return;
    if (index === -1) {
      if (!state.bubble.classList.contains('is-pinned')) {
        state.bubble.classList.remove('is-visible');
        state.bubbleFor = -1;
      }
      return;
    }
    const item = MODEL_ITEMS[index];
    if (!item) return;
    state.bubbleFor = index;
    state.bubbleName.textContent = item.name;
    state.bubbleTool.textContent = item.tool || (item.source === 'community' ? 'COMMUNITY' : 'TEXT TO 3D');
    if (item.prompt) {
      state.bubblePrompt.textContent = '“' + item.prompt + '”';
      state.bubbleCopy.hidden = false;
    } else {
      state.bubblePrompt.textContent = item.author
        ? 'Made by ' + item.author + ' on TimrX'
        : 'Made by the TimrX community';
      state.bubbleCopy.hidden = true;
    }
    state.bubbleHint.textContent = index === state.activeIndex
      ? 'Drag to orbit · Scroll to zoom'
      : 'Click to bring forward';
    state.bubble.classList.add('is-visible');
  }

  function positionBubble(THREE) {
    if (!state.bubble || state.bubbleFor === -1) return;
    const entry = state.models.get(state.bubbleFor);
    if (!entry || !entry.wrapper.visible) { showBubbleFor(-1); return; }

    const top = new THREE.Vector3(
      entry.wrapper.position.x,
      entry.wrapper.position.y + modelHeightForViewport() * entry.targetScale * 0.58,
      entry.wrapper.position.z
    );
    top.project(state.camera);
    const rect = state.canvas.getBoundingClientRect();
    const x = (top.x * 0.5 + 0.5) * rect.width + rect.left;
    const y = (-top.y * 0.5 + 0.5) * rect.height + rect.top;

    const bw = state.bubble.offsetWidth || 280;
    const bh = state.bubble.offsetHeight || 150;
    const clampedX = Math.max(bw / 2 + 12, Math.min(window.innerWidth - bw / 2 - 12, x));
    /* keep the whole card on screen: below the header, above the command bar */
    const anchorY = Math.min(window.innerHeight - 140, Math.max(bh + 88, y - 18));
    state.bubble.style.transform =
      'translate(' + Math.round(clampedX - bw / 2) + 'px, ' + Math.round(anchorY) + 'px) translateY(-100%)';
  }

  /* ----- wheel: browse, or zoom while inspecting ------------------------- */

  function otherSurfaceOwnsScreen() {
    const c = document.body.classList;
    return c.contains('ws-viewer-open') || c.contains('ws-panel-open') || c.contains('ws-cmd-open') ||
           c.contains('assets-modal-open') || c.contains('history-expanded') || c.contains('tutorials-view') ||
           c.contains('community-view') || c.contains('docs-view');
  }

  function onWheel(event) {
    if (!state.ready || otherSurfaceOwnsScreen()) return;

    if (state.inspect.on) {
      state.zoomTarget = Math.max(baseCameraZ() * 0.45, Math.min(baseCameraZ() * 1.25,
        state.zoomTarget + (event.deltaY || 0) * 0.012));
      armInspectIdle();
      return;
    }

    const now = performance.now();
    if (now < state.wheelLockUntil) return;
    state.wheelDelta += event.deltaY || 0;
    if (Math.abs(state.wheelDelta) < 70) return;

    stepCarousel(state.wheelDelta > 0 ? 1 : -1);
    state.wheelDelta = 0;
    state.wheelLockUntil = now + 460;
    state.showcase?.classList.add('is-spinning');
    window.clearTimeout(state.spinGlowTimer);
    state.spinGlowTimer = window.setTimeout(() => {
      state.showcase?.classList.remove('is-spinning');
    }, 260);
  }

  /* ----- render loop ----------------------------------------------------- */

  function render() {
    window.requestAnimationFrame(render);
    if (!state.renderer || !state.scene || !state.camera) return;

    const THREE = window.THREE;
    const delta = state.clock ? state.clock.getDelta() : 0;
    state.models.forEach((entry) => { if (entry.mixer) entry.mixer.update(delta); });

    /* ease every wrapper toward its slot */
    const nowT = performance.now();
    state.models.forEach((entry, index) => {
      if (!entry.wrapper.visible || !entry.settled) return;
      /* The hero animates differently from the row: a slow levitation and a
         barely-there breathing scale, on top of its yaw. Sides stay planted. */
      const isHero = index === state.activeIndex && !REDUCE_MOTION && !state.inspect.on;
      const floatY = isHero ? Math.sin(nowT * 0.0009) * 0.085 : 0;
      const breath = isHero ? 1 + Math.sin(nowT * 0.0011) * 0.012 : 1;
      _tweenTarget.copy(entry.targetPos);
      _tweenTarget.y += floatY;
      entry.wrapper.position.lerp(_tweenTarget, 0.16);
      const s = entry.wrapper.scale.x + (entry.targetScale * breath - entry.wrapper.scale.x) * 0.16;
      entry.wrapper.scale.setScalar(s);
      if (index !== state.activeIndex && entry.targetRotY !== null && typeof entry.targetRotY !== 'undefined') {
        entry.wrapper.rotation.y += (entry.targetRotY - entry.wrapper.rotation.y) * 0.14;
        entry.wrapper.rotation.z += ((entry.targetRotZ || 0) - entry.wrapper.rotation.z) * 0.14;
        entry.wrapper.rotation.x += (0 - entry.wrapper.rotation.x) * 0.14;
      }
      /* fade toward the slot's opacity */
      const first = entry.materials[0];
      if (first && Math.abs((first.opacity ?? 1) - entry.targetOpacity) > 0.012) {
        entry.materials.forEach((material) => {
          material.opacity = (material.opacity ?? 1) + (entry.targetOpacity - (material.opacity ?? 1)) * 0.18;
        });
      }
    });

    const active = state.models.get(state.activeIndex);
    if (active) {
      if (state.inspect.on) {
        if (!state.inspect.dragging && Math.abs(state.inspect.velY) > 0.0004) {
          state.inspect.rotY += state.inspect.velY;   /* inertia */
          state.inspect.velY *= 0.94;
        }
        active.wrapper.rotation.y += (normalizeRadians(state.inspect.rotY) - active.wrapper.rotation.y) * 0.32;
        active.wrapper.rotation.x += (state.inspect.rotX - active.wrapper.rotation.x) * 0.24;
        active.wrapper.rotation.z += (0 - active.wrapper.rotation.z) * 0.2;
      } else {
        state.currentRotation += (state.targetRotation - state.currentRotation) * 0.095;
        active.wrapper.rotation.y = normalizeRadians(state.currentRotation);
        active.wrapper.rotation.x = REDUCE_MOTION ? 0 : Math.sin(performance.now() * 0.00045) * 0.012;
      }
    }

    /* zoom easing (inspect wheel) */
    if (Math.abs(state.camera.position.z - state.zoomTarget) > 0.01) {
      state.camera.position.z += (state.zoomTarget - state.camera.position.z) * 0.12;
    }

    layoutCarousel();
    if (THREE) positionBubble(THREE);
    state.renderer.render(state.scene, state.camera);
  }

  /* ----- boot ------------------------------------------------------------ */

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    state.showcase = document.getElementById('workspaceModelShowcase');
    state.canvas = document.getElementById('workspaceModelCanvas');
    state.prevBtn = document.getElementById('workspaceModelPrev');
    state.nextBtn = document.getElementById('workspaceModelNext');
    if (!state.showcase || !state.canvas) return;

    waitForThree(async () => {
      const THREE = window.THREE;
      if (!THREE || !THREE.GLTFLoader) return;

      state.scene = new THREE.Scene();
      state.carousel = new THREE.Group();
      state.scene.add(state.carousel);
      state.camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
      state.clock = new THREE.Clock();
      state.raycaster = new THREE.Raycaster();
      state.pointerNdc = new THREE.Vector2();
      _tweenTarget = new THREE.Vector3();

      try {
        state.renderer = new THREE.WebGLRenderer({
          canvas: state.canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        });
      } catch (error) {
        console.warn('TimrX workspace model carousel disabled because WebGL is unavailable.', error);
        state.showcase.hidden = true;
        return;
      }

      state.renderer.outputColorSpace = THREE.SRGBColorSpace;
      state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      state.renderer.toneMappingExposure = 1.02;
      state.zoomTarget = baseCameraZ();
      setRendererSize();

      const ambient = new THREE.HemisphereLight(0xf8ead8, 0x0a0806, 1.95);
      const key = new THREE.DirectionalLight(0xffd4a1, 3.7);
      const rim = new THREE.DirectionalLight(0xc7d6e6, 1.78);
      key.position.set(2.6, 3.5, 4.4);
      rim.position.set(-2.8, 2.5, -3.8);
      state.scene.add(ambient, key, rim);

      buildBubble();

      [state.prevBtn, state.nextBtn].forEach((btn, i) => {
        if (!btn) return;
        btn.innerHTML =
          '<span class="showcase-nav__ring" aria-hidden="true"></span>' +
          '<span class="showcase-nav__core" aria-hidden="true"></span>' +
          '<svg class="showcase-nav__glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="' +
          (i === 0 ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5') +
          '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      });
      state.prevBtn?.addEventListener('click', () => stepCarousel(-1));
      state.nextBtn?.addEventListener('click', () => stepCarousel(1));
      window.addEventListener('resize', setRendererSize, { passive: true });
      window.addEventListener('wheel', onWheel, { passive: true });
      window.addEventListener('keydown', onKeyDown);

      state.canvas.addEventListener('pointermove', onPointerMove, { passive: true });
      state.canvas.addEventListener('pointerdown', onPointerDown);
      state.canvas.addEventListener('pointerup', onPointerUp);
      state.canvas.addEventListener('pointerleave', onPointerLeave);

      await loadLiveShowcaseModels();
      loadActiveModel();
      scheduleModelPreload();
      render();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
