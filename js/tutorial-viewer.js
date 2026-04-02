/**
 * tutorial-viewer.js
 * Restores the standalone tutorial model interactions using inline model-viewer
 * stages instead of the older custom Three.js viewer.
 */

(function () {
  'use strict';

  const VIEWER_SELECTOR = '.tutorial-3d-viewer';
  const EXTERNAL_TARGET_SELECTOR = '[data-target-viewer][data-target-state]';
  const SWAP_CLASS = 'is-swapping';
  const SWAP_DURATION_MS = 220;
  const viewers = new Map();

  function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readDatasetValue(dataset, key, fallback = '') {
    return dataset[key] || fallback;
  }

  function stateMeta(container, key) {
    const dataset = container.dataset;
    const fallbackLabel = key === 'model' ? 'Model' : capitalize(key);
    const fallbackTitle = key === 'reference' ? 'Source image' : `${fallbackLabel} result`;

    return {
      key,
      label: readDatasetValue(dataset, `${key}Label`, fallbackLabel),
      title: readDatasetValue(dataset, `${key}Title`, fallbackTitle),
      copy: readDatasetValue(dataset, `${key}Copy`, '')
    };
  }

  function buildStates(container) {
    const dataset = container.dataset;
    const states = [];
    const hasReference = Boolean(dataset.referenceImage);
    const hasPreview = Boolean(dataset.preview);
    const hasRefined = Boolean(dataset.refined);

    if (hasReference) {
      const meta = stateMeta(container, 'reference');
      states.push({
        ...meta,
        type: 'image',
        src: dataset.referenceImage
      });
    }

    if (hasPreview) {
      const meta = stateMeta(container, 'preview');
      states.push({
        ...meta,
        type: 'model',
        src: dataset.preview,
        poster: hasReference ? dataset.referenceImage : ''
      });
    } else if (dataset.src) {
      const modelKey = hasReference ? 'model' : 'preview';
      const meta = stateMeta(container, modelKey);
      states.push({
        ...meta,
        type: 'model',
        src: dataset.src,
        poster: hasReference ? dataset.referenceImage : ''
      });
    }

    if (hasRefined) {
      const meta = stateMeta(container, 'refined');
      states.push({
        ...meta,
        type: 'model',
        src: dataset.refined,
        poster: hasReference ? dataset.referenceImage : ''
      });
    }

    const activeKey = hasReference && !hasPreview && !hasRefined ? 'model' : states[0]?.key;

    return {
      states,
      activeKey
    };
  }

  function getState(entry, key) {
    return entry.states.find((state) => state.key === key) || entry.states[0] || null;
  }

  function getNextState(entry) {
    if (entry.states.length < 2) return null;
    const index = entry.states.findIndex((state) => state.key === entry.activeKey);
    return entry.states[(index + 1) % entry.states.length] || entry.states[0];
  }

  function getHintForState(entry) {
    const activeKey = entry.activeKey;
    const dataset = entry.container.dataset;

    const directHint = dataset[`${activeKey}Hint`];
    if (directHint) return directHint;

    if (activeKey === 'model' && dataset.previewHint) {
      return dataset.previewHint;
    }

    const nextState = getNextState(entry);
    if (!nextState) return '';

    if (nextState.type === 'image') {
      return 'Click stage to inspect the source image';
    }

    if (activeKey === 'reference') {
      return `Click stage to return to ${nextState.label.toLowerCase()}`;
    }

    return `Click stage to view ${nextState.label.toLowerCase()}`;
  }

  function getSwapCopy(entry) {
    const hint = getHintForState(entry);
    return hint || 'Interactive model walkthrough';
  }

  function renderMedia(state) {
    if (!state) return '';

    if (state.type === 'image') {
      return `<img src="${escapeHtml(state.src)}" alt="${escapeHtml(state.title)}" loading="lazy">`;
    }

    const posterAttr = state.poster ? ` poster="${escapeHtml(state.poster)}"` : '';

    return `<model-viewer src="${escapeHtml(state.src)}"${posterAttr} disable-pan disable-zoom interaction-prompt="none" auto-rotate rotation-per-second="18deg" shadow-intensity="0.55" exposure="1.04" environment-image="neutral" loading="lazy" reveal="auto"></model-viewer>`;
  }

  function renderViewer(entry) {
    const container = entry.container;
    const activeState = getState(entry, entry.activeKey);
    const stageLabelBase = container.getAttribute('aria-label') || activeState?.title || 'Tutorial model preview';
    const nextState = getNextState(entry);
    const interactive = entry.states.length > 1;

    const tabsHtml = entry.states
      .map((state) => {
        const isActive = state.key === entry.activeKey;
        return `<button type="button" class="tutorial-inline-model__tab${isActive ? ' is-active' : ''}" data-state-key="${escapeHtml(state.key)}" aria-pressed="${isActive ? 'true' : 'false'}">${escapeHtml(state.label)}</button>`;
      })
      .join('');

    container.innerHTML = `
      <div class="tutorial-inline-model" data-active-state="${escapeHtml(entry.activeKey)}">
        <div class="tutorial-inline-model__head">
          <div class="tutorial-inline-model__tabs">${tabsHtml}</div>
          <div class="tutorial-inline-model__swap">${escapeHtml(getSwapCopy(entry))}</div>
        </div>
        <div class="tutorial-inline-model__frame">
          <div class="tutorial-inline-model__stage" role="${interactive ? 'button' : 'img'}" tabindex="${interactive ? '0' : '-1'}" aria-label="${escapeHtml(stageLabelBase)}">
            <div class="tutorial-inline-model__media">
              <div class="tutorial-inline-model__media-inner">
                ${renderMedia(activeState)}
              </div>
            </div>
            <div class="tutorial-inline-model__shade"></div>
            <div class="tutorial-inline-model__caption">
              <span class="tutorial-inline-model__badge" data-state="${escapeHtml(activeState.key)}">${escapeHtml(activeState.label)}</span>
              <strong class="tutorial-inline-model__title">${escapeHtml(activeState.title)}</strong>
              <p class="tutorial-inline-model__copy">${escapeHtml(activeState.copy)}</p>
            </div>
          </div>
        </div>
      </div>
    `;

    const shell = container.querySelector('.tutorial-inline-model');
    const stage = container.querySelector('.tutorial-inline-model__stage');

    container.querySelectorAll('.tutorial-inline-model__tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        setViewerState(entry.id, tab.dataset.stateKey, { animate: true });
      });
    });

    if (interactive && stage) {
      stage.addEventListener('click', () => {
        cycleViewer(entry.id);
      });
      stage.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          cycleViewer(entry.id);
        }
      });
    }

    clearTimeout(entry.swapTimer);
    if (entry.shouldAnimate && shell) {
      shell.classList.add(SWAP_CLASS);
      entry.swapTimer = window.setTimeout(() => {
        shell.classList.remove(SWAP_CLASS);
      }, SWAP_DURATION_MS);
    }
    entry.shouldAnimate = false;

    updateHint(entry);
    syncExternalTargets(entry.id, entry.activeKey);
  }

  function updateHint(entry) {
    if (!entry.hintEl) return;
    entry.hintEl.textContent = getHintForState(entry);
    entry.hintEl.classList.toggle('refined', entry.activeKey === 'refined');
  }

  function syncExternalTargets(id, activeKey) {
    document.querySelectorAll(`${EXTERNAL_TARGET_SELECTOR}[data-target-viewer="${id}"]`).forEach((element) => {
      const isActive = element.dataset.targetState === activeKey;
      element.classList.toggle('is-view-active', isActive);
      if (element.getAttribute('role') === 'button') {
        element.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      }
    });
  }

  function setViewerState(id, nextKey, options = {}) {
    const entry = viewers.get(id);
    if (!entry) return;

    const nextState = getState(entry, nextKey);
    if (!nextState) return;

    if (entry.activeKey === nextState.key && !options.force) {
      syncExternalTargets(id, entry.activeKey);
      updateHint(entry);
      return;
    }

    entry.activeKey = nextState.key;
    entry.shouldAnimate = options.animate !== false;
    renderViewer(entry);
  }

  function cycleViewer(id) {
    const entry = viewers.get(id);
    if (!entry || entry.states.length < 2) return;

    const nextState = getNextState(entry);
    if (!nextState) return;
    setViewerState(id, nextState.key, { animate: true });
  }

  function bindExternalTargets() {
    document.querySelectorAll(EXTERNAL_TARGET_SELECTOR).forEach((element) => {
      if (element.dataset.tutorialViewerBound === 'true') return;
      element.dataset.tutorialViewerBound = 'true';

      const activate = () => {
        setViewerState(element.dataset.targetViewer, element.dataset.targetState, { animate: true });
      };

      element.addEventListener('click', activate);
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    });
  }

  function createEntry(container) {
    const id = container.id || `tutorial-viewer-${viewers.size + 1}`;
    container.id = id;

    const { states, activeKey } = buildStates(container);
    if (!states.length) return null;

    return {
      id,
      container,
      states,
      activeKey,
      hintEl: container.parentElement?.querySelector('.model-toggle-hint') || null,
      shouldAnimate: false,
      swapTimer: null
    };
  }

  function initTutorialViewers() {
    const containers = document.querySelectorAll(VIEWER_SELECTOR);
    if (!containers.length) return;

    viewers.clear();

    containers.forEach((container) => {
      const entry = createEntry(container);
      if (!entry) return;
      viewers.set(entry.id, entry);
      renderViewer(entry);
    });

    bindExternalTargets();
  }

  window.TutorialViewers = {
    init: initTutorialViewers,
    setState: setViewerState,
    nextState: cycleViewer
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTutorialViewers, { once: true });
  } else {
    initTutorialViewers();
  }
})();
