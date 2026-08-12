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

// ---------- Hero slogan cycler ----------
// Replaces the static "Regnum quod non cadit" with five slogans that
// cycle continuously: each slides in from the right, holds, then slides
// out to the left while the next enters.
(function () {
  var container = document.getElementById('hero-slogans');
  if (!container) return;

  var slogans = container.querySelectorAll('.hero__slogan');
  if (!slogans.length) return;

  var current = 0;
  var total = slogans.length;
  var interval = 5000; // ms per slogan
  var timer = null;

  // Make the first slogan visible on load (equivalent to --active).
  slogans[0].classList.add('hero__slogan--active');

  function advance() {
    var prev = current;
    current = (current + 1) % total;

    // Exit the current slogan to the left
    slogans[prev].classList.add('hero__slogan--exit');
    slogans[prev].classList.remove('hero__slogan--active');

    // Bring the next slogan in from the right
    slogans[current].classList.add('hero__slogan--active');

    // Clean up after the transition so the exiting slogan
    // resets to its off-screen-right position for the next cycle.
    var exiting = slogans[prev];
    setTimeout(function () {
      exiting.classList.remove('hero__slogan--exit');
    }, 750);
  }

  // Start the cycle.
  timer = setInterval(advance, interval);

  // Pause while the tab is hidden to save CPU.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(timer);
      timer = null;
    } else if (!timer) {
      timer = setInterval(advance, interval);
    }
  });
})();
