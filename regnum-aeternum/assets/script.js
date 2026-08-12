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
// Cycles five slogans continuously: each slides in left-to-right,
// holds for 10 seconds, then continues left-to-right off-screen
// while the next enters.
(function () {
  var container = document.getElementById('hero-slogans');
  if (!container) return;

  var slogans = container.querySelectorAll('.hero__slogan');
  if (!slogans.length) return;

  var current = 0;
  var total = slogans.length;
  var HOLD = 10000;   // ms each slogan stays visible
  var TRANSITION = 850; // ms for the slide (matches CSS 0.8s + buffer)
  var timer = null;

  // Make the first slogan visible on load.
  slogans[0].classList.add('hero__slogan--active');

  function advance() {
    var prev = current;
    current = (current + 1) % total;

    // Exit current slogan: continue left-to-right off the right side
    slogans[prev].classList.add('hero__slogan--exit');
    slogans[prev].classList.remove('hero__slogan--active');

    // Enter next slogan: slide in left-to-right from the left side
    slogans[current].classList.add('hero__slogan--active');

    // After the slide finishes, strip --exit so the element snaps
    // back to its off-screen-left start position for the next cycle.
    var exiting = slogans[prev];
    setTimeout(function () {
      exiting.classList.remove('hero__slogan--exit');
    }, TRANSITION);
  }

  // Start cycling.
  timer = setInterval(advance, HOLD);

  // Pause while the tab is hidden to save CPU.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(timer);
      timer = null;
    } else if (!timer) {
      timer = setInterval(advance, HOLD);
    }
  });
})();
