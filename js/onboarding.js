/**
 * TimrX Onboarding Module
 * Self-contained guided tour system for first-time users
 * Hooks into auth system and provides 4-step spotlight tour
 */

(function() {
  'use strict';

  // Theme configuration
  const THEME = {
    bg: '#0b0b0b',
    text: '#f5f5f5',
    muted: '#a9a9a9',
    accentGradient: 'linear-gradient(90deg, #0ea5e9, #7dd3fc)',
    cardBg: '#141414',
    border: '#1d1d1d',
    borderRadius: '12px',
    font: 'Inter, system-ui, -apple-system, sans-serif'
  };

  // Storage key
  const STORAGE_KEY = 'timrx_onboarded';
  const ONBOARDING_ACTIVE_KEY = 'timrx_onboarding_active';

  // Step definitions
  const STEPS = [
    {
      id: 'choose-tool',
      title: 'Choose Your Tool',
      body: 'Start by selecting a creation mode. Text to 3D, Image to 3D, or explore other tools like Remesh and Texture.',
      selector: '.left-rail, .rail-btn',
      position: 'right',
      icon: 'cube',
      actionText: 'Next',
      action: null
    },
    {
      id: 'describe-vision',
      title: 'Describe Your Vision',
      body: 'Type a detailed prompt describing what you want to create. Be specific about materials, style, and mood for best results.',
      selector: '#promptTextarea, .prompt-area',
      position: 'above',
      icon: 'pencil',
      actionText: 'Next',
      action: () => {
        const textarea = document.querySelector('#promptTextarea, .prompt-area');
        if (textarea && !textarea.value) {
          textarea.value = 'A crystal dragon with iridescent scales, perched on volcanic rock';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      prefill: 'A crystal dragon with iridescent scales, perched on volcanic rock'
    },
    {
      id: 'generate',
      title: 'Hit Generate',
      body: 'Click Generate to start creating. Your first 3D model takes about 3-5 minutes. You have 50 free credits to experiment with.',
      selector: '#generateBtn, .generate-btn, button:contains("Generate")',
      position: 'above',
      icon: 'sparkles',
      actionText: 'Next',
      action: null
    },
    {
      id: 'explore-more',
      title: "You're Ready!",
      body: 'Explore Tutorials for guides, Community for inspiration, and Prompts for ideas. Welcome to TimrX!',
      selector: '.workspace-tabs, [role="tablist"], .bottom-nav',
      position: 'above',
      icon: 'rocket',
      actionText: 'Got it!',
      action: null,
      links: [
        { text: 'Tutorials', url: '/tutorials' },
        { text: 'Community', url: '/community' },
        { text: 'Prompts', url: '/prompts' }
      ]
    }
  ];

  // SVG Icons
  const ICONS = {
    cube: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><polyline points="12 22.08 12 12"/></svg>`,
    pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
    rocket: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74.5 5 -2c.5 .5 1 .972 1.5 1.5c1.5 1.5 3 3 5.5 3s4 -.5 6 -1.5c.5 -1 1 -1.5 1.5 -1.5"/><path d="M15 6c0 -1 4 -3.5 4 -3.5s3.5 4 3.5 4M9 5.5c-1 .5 -3 1.5 -4 2.5M9 9l1.5 2"/><path d="M21 15a3 3 0 1 1 -6 0 3 3 0 0 1 6 0z"/></svg>`
  };

  // State management
  let state = {
    currentStep: 0,
    isActive: false,
    targetElement: null,
    overlay: null,
    spotlight: null,
    tooltip: null,
    focusedElements: []
  };

  /**
   * Inject CSS styles into the document
   */
  function injectStyles() {
    if (document.getElementById('timrx-onboarding-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'timrx-onboarding-styles';
    style.textContent = `
      /* Onboarding Container */
      .timrx-onboarding-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 9998;
        opacity: 0;
        animation: fadeIn 300ms ease forwards;
      }

      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .timrx-onboarding-overlay.fade-out {
        animation: fadeOut 300ms ease forwards;
      }

      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }

      /* Spotlight element */
      .timrx-spotlight {
        position: fixed;
        border-radius: 12px;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.7);
        transition: all 300ms ease;
        z-index: 9999;
        pointer-events: none;
      }

      .timrx-spotlight.hidden {
        display: none;
      }

      /* Tooltip */
      .timrx-tooltip {
        position: fixed;
        background: ${THEME.cardBg};
        border: 1px solid ${THEME.border};
        border-radius: ${THEME.borderRadius};
        color: ${THEME.text};
        font-family: ${THEME.font};
        font-size: 14px;
        line-height: 1.5;
        z-index: 10000;
        max-width: 340px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        opacity: 0;
        animation: slideIn 300ms ease forwards;
        padding: 0;
        overflow: hidden;
      }

      @media (max-width: 768px) {
        .timrx-tooltip {
          max-width: 300px;
        }
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .timrx-tooltip.slide-out {
        animation: slideOut 300ms ease forwards;
      }

      @keyframes slideOut {
        from {
          opacity: 1;
          transform: translateY(0);
        }
        to {
          opacity: 0;
          transform: translateY(10px);
        }
      }

      /* Tooltip header with icon */
      .timrx-tooltip-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px;
        background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(125, 211, 252, 0.1));
        border-bottom: 1px solid ${THEME.border};
      }

      .timrx-tooltip-icon {
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        color: #0ea5e9;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .timrx-tooltip-icon svg {
        width: 100%;
        height: 100%;
      }

      .timrx-tooltip-title {
        font-size: 16px;
        font-weight: 600;
        color: ${THEME.text};
        margin: 0;
      }

      /* Tooltip body */
      .timrx-tooltip-body {
        padding: 16px;
      }

      .timrx-tooltip-text {
        margin: 0 0 16px 0;
        color: ${THEME.text};
        font-size: 14px;
        line-height: 1.6;
      }

      .timrx-tooltip-links {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 12px;
      }

      .timrx-tooltip-link {
        display: inline-block;
        padding: 8px 12px;
        background: rgba(14, 165, 233, 0.1);
        color: #0ea5e9;
        text-decoration: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        transition: all 200ms ease;
        cursor: pointer;
      }

      .timrx-tooltip-link:hover {
        background: rgba(14, 165, 233, 0.2);
        text-decoration: underline;
      }

      /* Tooltip footer */
      .timrx-tooltip-footer {
        padding: 12px 16px;
        border-top: 1px solid ${THEME.border};
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
      }

      /* Step counter and progress */
      .timrx-step-info {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: ${THEME.muted};
      }

      .timrx-progress-dots {
        display: flex;
        gap: 4px;
      }

      .timrx-progress-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: ${THEME.border};
        transition: all 200ms ease;
      }

      .timrx-progress-dot.active {
        background: #0ea5e9;
        width: 12px;
        border-radius: 3px;
      }

      /* Buttons */
      .timrx-button-group {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .timrx-btn {
        padding: 8px 16px;
        border: none;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
        transition: all 200ms ease;
        font-family: ${THEME.font};
      }

      .timrx-btn-primary {
        background: ${THEME.text};
        color: ${THEME.bg};
      }

      .timrx-btn-primary:hover {
        background: #fff;
        box-shadow: 0 4px 12px rgba(245, 245, 245, 0.2);
      }

      .timrx-btn-primary:active {
        transform: scale(0.98);
      }

      .timrx-btn-skip {
        background: none;
        color: ${THEME.muted};
        text-decoration: underline;
        padding: 0;
        font-weight: 500;
        font-size: 12px;
      }

      .timrx-btn-skip:hover {
        color: ${THEME.text};
      }

      /* Tooltip arrow */
      .timrx-tooltip::before {
        content: '';
        position: absolute;
        width: 0;
        height: 0;
        border-style: solid;
      }

      .timrx-tooltip.arrow-top::before {
        bottom: -8px;
        left: 50%;
        transform: translateX(-50%);
        border-width: 8px 8px 0 8px;
        border-color: ${THEME.cardBg} transparent transparent transparent;
      }

      .timrx-tooltip.arrow-bottom::before {
        top: -8px;
        left: 50%;
        transform: translateX(-50%);
        border-width: 0 8px 8px 8px;
        border-color: transparent transparent ${THEME.cardBg} transparent;
      }

      .timrx-tooltip.arrow-left::before {
        right: -8px;
        top: 50%;
        transform: translateY(-50%);
        border-width: 8px 0 8px 8px;
        border-color: transparent transparent transparent ${THEME.cardBg};
      }

      .timrx-tooltip.arrow-right::before {
        left: -8px;
        top: 50%;
        transform: translateY(-50%);
        border-width: 8px 8px 8px 0;
        border-color: transparent ${THEME.cardBg} transparent transparent;
      }

      /* Accessibility */
      .timrx-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }

      /* Mobile responsive */
      @media (max-width: 768px) {
        .timrx-tooltip {
          max-width: 90vw;
          margin: 0 5vw;
        }

        .timrx-btn {
          padding: 10px 18px;
          font-size: 14px;
        }

        .timrx-button-group {
          width: 100%;
          justify-content: space-between;
        }

        .timrx-tooltip-footer {
          flex-direction: column;
          align-items: stretch;
        }

        .timrx-btn-primary {
          width: 100%;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Create SVG icon element
   */
  function createIcon(iconName) {
    const div = document.createElement('div');
    div.className = 'timrx-tooltip-icon';
    div.innerHTML = ICONS[iconName] || ICONS.cube;
    return div;
  }

  /**
   * Find target element by selector
   */
  function findTargetElement(selector) {
    if (!selector) return null;

    const selectors = selector.split(',').map(s => s.trim());

    for (const sel of selectors) {
      try {
        if (sel.includes(':contains(')) {
          // Custom :contains selector for button text
          const text = sel.match(/:contains\("([^"]+)"\)/)?.[1];
          if (text) {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              if (btn.textContent.includes(text)) {
                return btn;
              }
            }
          }
        } else {
          const el = document.querySelector(sel);
          if (el && isElementVisible(el)) {
            return el;
          }
        }
      } catch (e) {
        // Invalid selector, continue
      }
    }

    return null;
  }

  /**
   * Check if element is visible in viewport
   */
  function isElementVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
  }

  /**
   * Get element position relative to viewport
   */
  function getElementPosition(el) {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      bottom: rect.bottom + window.scrollY,
      right: rect.right + window.scrollX,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2
    };
  }

  /**
   * Calculate tooltip position
   */
  function calculateTooltipPosition(targetPos, tooltipSize, position, isMobile) {
    const padding = 16;
    const gap = 12;
    let top, left, arrowClass;

    if (isMobile) {
      // Mobile: center below spotlight
      left = Math.max(
        (window.innerWidth - tooltipSize.width) / 2,
        0
      );
      top = targetPos.bottom - window.scrollY + gap;
      arrowClass = 'arrow-top';
    } else {
      switch (position) {
        case 'right':
          left = targetPos.right - window.scrollX + gap;
          top = targetPos.top - window.scrollY + (targetPos.height - tooltipSize.height) / 2;
          arrowClass = 'arrow-left';
          break;

        case 'left':
          left = targetPos.left - window.scrollX - tooltipSize.width - gap;
          top = targetPos.top - window.scrollY + (targetPos.height - tooltipSize.height) / 2;
          arrowClass = 'arrow-right';
          break;

        case 'below':
          left = targetPos.left - window.scrollX + (targetPos.width - tooltipSize.width) / 2;
          top = targetPos.bottom - window.scrollY + gap;
          arrowClass = 'arrow-top';
          break;

        case 'above':
        default:
          left = targetPos.left - window.scrollX + (targetPos.width - tooltipSize.width) / 2;
          top = targetPos.top - window.scrollY - tooltipSize.height - gap;
          arrowClass = 'arrow-bottom';
          break;
      }
    }

    // Adjust if overflow
    if (left + tooltipSize.width > window.innerWidth - padding) {
      left = window.innerWidth - tooltipSize.width - padding;
    }
    if (left < padding) {
      left = padding;
    }

    if (top < padding) {
      top = targetPos.bottom - window.scrollY + gap;
      arrowClass = 'arrow-top';
    }

    return { top, left, arrowClass };
  }

  /**
   * Create tooltip element
   */
  function createTooltip(step) {
    const tooltip = document.createElement('div');
    tooltip.className = 'timrx-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-live', 'polite');

    const header = document.createElement('div');
    header.className = 'timrx-tooltip-header';
    header.appendChild(createIcon(step.icon));

    const title = document.createElement('h3');
    title.className = 'timrx-tooltip-title';
    title.textContent = step.title;
    header.appendChild(title);

    const body = document.createElement('div');
    body.className = 'timrx-tooltip-body';

    const text = document.createElement('p');
    text.className = 'timrx-tooltip-text';
    text.textContent = step.body;
    body.appendChild(text);

    // Add links if present
    if (step.links && step.links.length > 0) {
      const linksContainer = document.createElement('div');
      linksContainer.className = 'timrx-tooltip-links';

      step.links.forEach(link => {
        const linkEl = document.createElement('a');
        linkEl.href = link.url;
        linkEl.className = 'timrx-tooltip-link';
        linkEl.textContent = link.text;
        linkEl.setAttribute('aria-label', `Navigate to ${link.text}`);
        linksContainer.appendChild(linkEl);
      });

      body.appendChild(linksContainer);
    }

    tooltip.appendChild(header);
    tooltip.appendChild(body);

    // Footer with step counter and buttons
    const footer = document.createElement('div');
    footer.className = 'timrx-tooltip-footer';

    const stepInfo = document.createElement('div');
    stepInfo.className = 'timrx-step-info';
    stepInfo.setAttribute('aria-label', `Step ${state.currentStep + 1} of ${STEPS.length}`);

    const stepText = document.createElement('span');
    stepText.textContent = `Step ${state.currentStep + 1} of ${STEPS.length}`;
    stepInfo.appendChild(stepText);

    const dots = document.createElement('div');
    dots.className = 'timrx-progress-dots';
    for (let i = 0; i < STEPS.length; i++) {
      const dot = document.createElement('div');
      dot.className = `timrx-progress-dot ${i === state.currentStep ? 'active' : ''}`;
      dot.setAttribute('aria-hidden', 'true');
      dots.appendChild(dot);
    }
    stepInfo.appendChild(dots);
    footer.appendChild(stepInfo);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'timrx-button-group';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'timrx-btn-skip';
    skipBtn.textContent = 'Skip tour';
    skipBtn.setAttribute('aria-label', 'Skip the onboarding tour');
    skipBtn.addEventListener('click', skip);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'timrx-btn timrx-btn-primary';
    nextBtn.textContent = step.actionText;
    nextBtn.setAttribute('aria-label', step.actionText);
    nextBtn.addEventListener('click', () => {
      if (step.action) {
        try {
          step.action();
        } catch (e) {
          console.warn('[TimrX Onboarding] Action failed:', e);
        }
      }
      next();
    });

    buttonGroup.appendChild(skipBtn);
    buttonGroup.appendChild(nextBtn);
    footer.appendChild(buttonGroup);

    tooltip.appendChild(footer);

    return tooltip;
  }

  /**
   * Update spotlight position
   */
  function updateSpotlight(targetElement) {
    if (!targetElement) {
      if (state.spotlight) {
        state.spotlight.classList.add('hidden');
      }
      return;
    }

    const rect = targetElement.getBoundingClientRect();
    const padding = 8;

    if (!state.spotlight) {
      state.spotlight = document.createElement('div');
      state.spotlight.className = 'timrx-spotlight';
      document.body.appendChild(state.spotlight);
    }

    state.spotlight.classList.remove('hidden');
    state.spotlight.style.top = (rect.top + window.scrollY - padding) + 'px';
    state.spotlight.style.left = (rect.left + window.scrollX - padding) + 'px';
    state.spotlight.style.width = (rect.width + padding * 2) + 'px';
    state.spotlight.style.height = (rect.height + padding * 2) + 'px';
  }

  /**
   * Render current step
   */
  function renderStep(step) {
    // Remove old tooltip
    if (state.tooltip) {
      state.tooltip.classList.add('slide-out');
      setTimeout(() => {
        if (state.tooltip && state.tooltip.parentNode) {
          state.tooltip.parentNode.removeChild(state.tooltip);
        }
        state.tooltip = null;
      }, 300);
    }

    // Find target element
    state.targetElement = findTargetElement(step.selector);

    // Update spotlight
    updateSpotlight(state.targetElement);

    // Create and position tooltip
    const tooltip = createTooltip(step);
    document.body.appendChild(tooltip);

    // Measure tooltip
    setTimeout(() => {
      if (!tooltip.parentNode) return;

      const tooltipRect = tooltip.getBoundingClientRect();
      const isMobile = window.innerWidth < 768;
      let targetPos;

      if (state.targetElement) {
        targetPos = getElementPosition(state.targetElement);
      } else {
        // Fallback: center of screen
        targetPos = {
          top: window.innerHeight / 2,
          left: window.innerWidth / 2,
          width: 0,
          height: 0
        };
      }

      const tooltipSize = {
        width: tooltipRect.width,
        height: tooltipRect.height
      };

      const pos = calculateTooltipPosition(targetPos, tooltipSize, step.position, isMobile);

      tooltip.style.top = pos.top + 'px';
      tooltip.style.left = pos.left + 'px';
      tooltip.classList.add(pos.arrowClass);

      state.tooltip = tooltip;

      // Announce to screen readers
      const ariaLive = document.createElement('div');
      ariaLive.className = 'timrx-sr-only';
      ariaLive.setAttribute('aria-live', 'polite');
      ariaLive.setAttribute('aria-atomic', 'true');
      ariaLive.textContent = `Step ${state.currentStep + 1}. ${step.title}. ${step.body}`;
      tooltip.appendChild(ariaLive);

      // Focus first interactive element in tooltip
      const focusableElements = tooltip.querySelectorAll('button, a, [tabindex]:not([tabindex="-1"])');
      if (focusableElements.length > 0) {
        focusableElements[focusableElements.length - 1].focus();
      }
    }, 0);
  }

  /**
   * Handle Escape key
   */
  function handleEscapeKey(event) {
    if (event.key === 'Escape') {
      skip();
    }
  }

  /**
   * Move to next step
   */
  function next() {
    state.currentStep++;

    if (state.currentStep >= STEPS.length) {
      finish();
    } else {
      renderStep(STEPS[state.currentStep]);
    }
  }

  /**
   * Skip tour
   */
  function skip() {
    if (!state.isActive) return;

    const overlay = document.querySelector('.timrx-onboarding-overlay');
    if (overlay) {
      overlay.classList.add('fade-out');
    }

    if (state.tooltip) {
      state.tooltip.classList.add('slide-out');
    }

    setTimeout(() => {
      cleanup();
      try { localStorage.setItem(STORAGE_KEY, '1'); localStorage.removeItem(ONBOARDING_ACTIVE_KEY); } catch (_) {}
    }, 300);
  }

  /**
   * Finish tour
   */
  function finish() {
    skip();
  }

  /**
   * Clean up all DOM elements
   */
  function cleanup() {
    state.isActive = false;

    // Remove overlay
    if (state.overlay && state.overlay.parentNode) {
      state.overlay.parentNode.removeChild(state.overlay);
    }

    // Remove spotlight
    if (state.spotlight && state.spotlight.parentNode) {
      state.spotlight.parentNode.removeChild(state.spotlight);
    }

    // Remove tooltip
    if (state.tooltip && state.tooltip.parentNode) {
      state.tooltip.parentNode.removeChild(state.tooltip);
    }

    // Remove event listeners
    document.removeEventListener('keydown', handleEscapeKey);
    window.removeEventListener('resize', handleResize);

    state = {
      ...state,
      targetElement: null,
      overlay: null,
      spotlight: null,
      tooltip: null
    };
  }

  /**
   * Handle window resize
   */
  function handleResize() {
    if (!state.isActive) return;

    if (state.targetElement) {
      updateSpotlight(state.targetElement);
    }

    if (state.tooltip) {
      const step = STEPS[state.currentStep];
      if (!step) return;

      const tooltipRect = state.tooltip.getBoundingClientRect();
      const isMobile = window.innerWidth < 768;
      const targetPos = state.targetElement ? getElementPosition(state.targetElement) : {
        top: window.innerHeight / 2,
        left: window.innerWidth / 2,
        width: 0,
        height: 0
      };

      const tooltipSize = {
        width: tooltipRect.width,
        height: tooltipRect.height
      };

      const pos = calculateTooltipPosition(targetPos, tooltipSize, step.position, isMobile);

      state.tooltip.style.top = pos.top + 'px';
      state.tooltip.style.left = pos.left + 'px';
    }
  }

  /**
   * Start the tour
   */
  function start() {
    if (state.isActive) return;

    try { localStorage.setItem(ONBOARDING_ACTIVE_KEY, '1'); } catch (_) {}
    state.isActive = true;
    state.currentStep = 0;

    // Inject styles if not already done
    injectStyles();

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'timrx-onboarding-overlay';
    document.body.appendChild(overlay);
    state.overlay = overlay;

    // Add event listeners
    document.addEventListener('keydown', handleEscapeKey);
    window.addEventListener('resize', handleResize);

    // Start tour
    renderStep(STEPS[0]);
  }

  /**
   * Reset onboarding state
   */
  function reset() {
    cleanup();
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(ONBOARDING_ACTIVE_KEY); } catch (_) {}
  }

  /**
   * Handle auth verified event
   */
  function handleAuthVerified() {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
      if (localStorage.getItem(ONBOARDING_ACTIVE_KEY)) return;
    } catch (_) { return; /* Safari: storage blocked — skip onboarding */ }

    // Start tour after delay
    setTimeout(() => {
      start();
    }, 1500);
  }

  /**
   * Initialize
   */
  function init() {
    // Listen for auth verification
    window.addEventListener('timrx:auth:verified', handleAuthVerified);

    // Expose public API
    window.TimrXOnboarding = {
      start,
      skip,
      reset
    };

    // Auto-start if not onboarded and in development/test
    if (window.location.hash === '#timrx-onboarding-debug') {
      reset();
      start();
    }
  }

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
