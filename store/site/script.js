// Store links, the size switcher, the hero video's play/pause and the scroll fade-ins. Nothing is sent anywhere.
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  // Fill these in when the listings are published; until then the buttons say it's coming.
  var STORES = {
    chrome: { url: "", name: "Chrome", get: "Add to Chrome", other: "Also for Chrome" },
    edge: { url: "", name: "Microsoft Edge", get: "Get it for Microsoft Edge", other: "Also for Microsoft Edge" },
  };

  var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  var isEdge = brands.some(function (b) { return /Edge/.test(b.brand); }) || /Edg\//.test(navigator.userAgent);
  var mobile = /Android|iPhone|iPad|Mobile/.test(navigator.userAgent);
  var mine = isEdge ? STORES.edge : STORES.chrome;
  var theirs = isEdge ? STORES.chrome : STORES.edge;
  var published = Boolean(STORES.chrome.url && STORES.edge.url);

  document.querySelectorAll("[data-get]").forEach(function (a) {
    var small = a.classList.contains("button-small");
    if (!published) {
      a.textContent = small ? "Coming soon" : "Coming soon to Chrome and Edge";
      a.setAttribute("aria-disabled", "true");
      a.removeAttribute("href");
    } else if (mobile && !small) {
      a.textContent = "For Chrome and Edge on a computer";
      a.setAttribute("aria-disabled", "true");
      a.removeAttribute("href");
    } else {
      a.textContent = small ? (isEdge ? "Get" : "Add to Chrome") : mine.get;
      a.href = mine.url;
    }
  });
  document.querySelectorAll("[data-other]").forEach(function (a) {
    if (!published || mobile) { a.textContent = ""; return; }
    a.textContent = theirs.other;
    a.href = theirs.url;
  });

  // Size switcher: one picture at a time; without JS all three show, stacked.
  var buttons = document.querySelectorAll("[data-size]");
  var panels = document.querySelectorAll("[data-size-panel]");
  function show(size) {
    buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.size === size)); });
    panels.forEach(function (p) { p.hidden = p.dataset.sizePanel !== size; });
  }
  buttons.forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.size); }); });
  show("fill");

  // Hero video: plays while on screen, never with reduced motion, and the button pauses it.
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll(".play-toggle").forEach(function (toggle) {
    var video = document.getElementById(toggle.dataset.video);
    var userPaused = reduce;
    function sync() {
      toggle.classList.toggle("paused", video.paused);
      toggle.setAttribute("aria-label", video.paused ? "Play the video" : "Pause the video");
    }
    toggle.addEventListener("click", function () {
      userPaused = !video.paused;
      if (video.paused) video.play(); else video.pause();
    });
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    sync();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !userPaused) video.play().catch(function () {});
          else if (!e.isIntersecting) video.pause();
        });
      }, { threshold: 0.35 }).observe(video);
    }
  });

  // Fade-ins: each .reveal rises into place the first time it comes on screen (styles.css turns this off for
  // reduced motion). Without IntersectionObserver everything just shows.
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }
})();
