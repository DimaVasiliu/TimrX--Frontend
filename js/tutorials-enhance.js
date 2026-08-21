/* ==========================================================================
   TUTORIALS-ENHANCE.JS (2026-08-21)
   Sidebar scrollspy + track filtering for /tutorials.
   Progressive enhancement only: with JS off the page is a normal document
   with anchor links that still work.
   ========================================================================== */
(function () {
  'use strict';

  var sections = [].slice.call(document.querySelectorAll('.tutorials-section[id]'));
  var links = [].slice.call(document.querySelectorAll('[data-tut-toc]'));
  if (!sections.length || !links.length) return;

  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('data-tut-toc')] = a; });

  /* ---- scrollspy: the section nearest the top of the reading area wins ---- */
  var current = null;
  function setCurrent(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (a) {
      a.classList.toggle('is-current', a.getAttribute('data-tut-toc') === id);
    });
    var active = byId[id];
    if (active && active.scrollIntoView) {
      var box = active.closest('.tut-sidebar__inner');
      /* only auto-scroll the rail while it is a real sticky column */
      if (box && box.scrollHeight > box.clientHeight + 8) {
        var top = active.offsetTop - box.clientHeight / 2 + active.offsetHeight / 2;
        box.scrollTo({ top: top, behavior: 'smooth' });
      }
    }
  }

  /* Deterministic: the active section is the last one whose top has crossed
     the reading line. IntersectionObserver alone went stale between threshold
     crossings and lagged a section behind. */
  var READ_LINE = 140;
  function recompute() {
    var best = sections[0].id, i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (s.classList.contains('is-hidden')) continue;
      if (s.getBoundingClientRect().top - READ_LINE <= 0) best = s.id;
    }
    /* at the very bottom, last visible section wins */
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      for (i = sections.length - 1; i >= 0; i--) {
        if (!sections[i].classList.contains('is-hidden')) { best = sections[i].id; break; }
      }
    }
    setCurrent(best);
  }
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () { recompute(); ticking = false; });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  recompute();

  /* Anchor jumps: images above the target load lazily and grow the document,
     which lands the browser short of the heading. Scroll, then re-assert once
     layout has settled. Also re-run the spy after late loads. */
  function jumpTo(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    [260, 620, 1100].forEach(function (t) {
      setTimeout(function () {
        var top = el.getBoundingClientRect().top - READ_LINE + 52;
        if (Math.abs(top) > 6) window.scrollBy({ top: top, behavior: 'auto' });
        recompute();
      }, t);
    });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (!id || !document.getElementById(id)) return;
    e.preventDefault();
    jumpTo(id);
  });
  window.addEventListener('load', function () { recompute(); setTimeout(recompute, 400); });

  /* ---- track filter: hides sections outside the chosen track ---- */
  var trackBtns = [].slice.call(document.querySelectorAll('[data-tut-track]'));
  trackBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var track = btn.getAttribute('data-tut-track');
      trackBtns.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
      sections.forEach(function (s) {
        var g = s.getAttribute('data-track-group');
        s.classList.toggle('is-hidden', track !== 'all' && g !== track);
      });
      links.forEach(function (a) {
        var g = a.getAttribute('data-track-group');
        a.classList.toggle('is-dimmed', track !== 'all' && g !== track);
      });
    });
  });

  /* ---- header shadow on scroll, same behaviour as the homepage ---- */
  var header = document.querySelector('.site-header[data-header]');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
})();
