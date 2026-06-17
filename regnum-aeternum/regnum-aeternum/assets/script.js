// Regnum Aeternum — civic portal interactions
// Minimal by design: a single scroll-reveal for the office directory.
// Content is visible without this script; it only adds the motion.

(function () {
  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || !('IntersectionObserver' in window)) return;

  var items = document.querySelectorAll('.reveal');
  items.forEach(function (el) { el.classList.add('pre'); });

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry, i) {
      if (entry.isIntersecting) {
        setTimeout(function () {
          entry.target.classList.add('is-visible');
        }, i * 60);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  items.forEach(function (el) { observer.observe(el); });
})();
