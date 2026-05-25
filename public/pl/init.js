// Set up the Plausible queue and direct future calls to the first-party /pl/event endpoint.
// This must load BEFORE the Plausible per-site script (which reads window.plausible.o.endpoint).
(function () {
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };
  window.plausible.init = window.plausible.init || function (options) {
    window.plausible.o = options || {};
  };
  window.plausible.init({ endpoint: "/pl/event" });
})();
