/**
 * TimrX Apple-Style 2-Line Burger Menu Controller
 * Premium animations with glassmorphism effects
 */

(function() {
  'use strict';

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBurger);
  } else {
    initBurger();
  }

  function initBurger() {
    const burger = document.getElementById('burgerBtn');
    const menu = document.getElementById('burgerMenu');
    const overlay = document.getElementById('burgerOverlay');

    if (!burger || !menu || !overlay) {
      console.warn('TimrX Burger: Menu elements not found on this page');
      return;
    }

    let isOpen = false;

    // Open menu with smooth animations
    function openMenu() {
      isOpen = true;
      menu.classList.add('active');
      overlay.classList.add('active');
      burger.classList.add('active');
      burger.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';

      // Set staggered animation indexes
      const items = menu.querySelectorAll('.burger-menu__item');
      items.forEach((item, index) => {
        item.style.setProperty('--item-index', index);
      });
    }

    // Close menu
    function closeMenu() {
      isOpen = false;
      menu.classList.remove('active');
      overlay.classList.remove('active');
      burger.classList.remove('active');
      burger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    // Toggle menu
    function toggleMenu() {
      if (isOpen) {
        closeMenu();
      } else {
        openMenu();
      }
    }

    // Event listeners
    burger.addEventListener('click', toggleMenu);
    overlay.addEventListener('click', closeMenu);

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) {
        closeMenu();
      }
    });

    // Close menu when clicking on a link
    menu.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.closest('a')) {
        setTimeout(closeMenu, 150); // Slight delay for visual feedback
      }
    });

    // Handle window resize - close menu if resizing to desktop
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth > 980 && isOpen) {
          closeMenu();
        }
      }, 250);
    });

    // Prevent body scroll when menu is open
    function preventScroll(e) {
      if (isOpen && !menu.contains(e.target)) {
        e.preventDefault();
      }
    }

    // Add touch support for mobile
    let touchStartY = 0;
    menu.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    });

    menu.addEventListener('touchmove', (e) => {
      const touchY = e.touches[0].clientY;
      const scrollTop = menu.scrollTop;

      // Prevent overscroll
      if (scrollTop === 0 && touchY > touchStartY) {
        e.preventDefault();
      }
    }, { passive: false });

    console.log('✨ TimrX Burger Menu initialized');
  }
})();
