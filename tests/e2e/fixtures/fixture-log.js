// Shared by the end-to-end fixtures (a plain page script, as a site would have). It keeps window.__log,
// which the tests read and which is saved with a failing test's artifacts, and window.CFS helpers.
(function () {
  "use strict";
  var log = [];
  window.__log = log;

  function describe(node) {
    if (!node) return null;
    if (node.id) return "#" + node.id;
    return node.localName || String(node);
  }

  function getters() {
    var d = document;
    var matched = null;
    try {
      matched = describe(d.querySelector(":fullscreen"));
    } catch (error) {
      matched = "error: " + error;
    }
    return {
      fullscreenElement: describe(d.fullscreenElement),
      webkitFullscreenElement: describe(d.webkitFullscreenElement),
      webkitCurrentFullScreenElement: describe(d.webkitCurrentFullScreenElement),
      fullscreen: d.fullscreen,
      webkitIsFullScreen: d.webkitIsFullScreen,
      matchedFullscreen: matched,
    };
  }

  function push(type, extra) {
    var entry = { type: type, time: Math.round(performance.now()) };
    var values = getters();
    for (var key in values) entry[key] = values[key];
    if (extra) for (var name in extra) entry[name] = extra[name];
    log.push(entry);
    return entry;
  }

  var EVENTS = ["fullscreenchange", "fullscreenerror", "webkitfullscreenchange", "webkitfullscreenerror"];

  function watch() {
    EVENTS.forEach(function (type) {
      document.addEventListener(type, function (event) {
        push(type, { target: describe(event.composedPath()[0]), trusted: event.isTrusted });
      });
    });
    ["keydown", "keyup"].forEach(function (type) {
      // Capture listeners on window and document, as players and pages register them.
      window.addEventListener(type, function (event) { push(type, { key: event.key, at: "window" }); }, true);
      document.addEventListener(type, function (event) { push(type, { key: event.key, at: "document" }); });
    });
    window.addEventListener("resize", function () {
      push("resize", { innerWidth: window.innerWidth, innerHeight: window.innerHeight });
    });
  }

  function settle(type, method, result) {
    if (result && typeof result.then === "function") {
      result.then(
        function () { push("promise", { method: method }); },
        function (error) { push("reject", { method: method, name: error.name, message: error.message }); }
      );
    } else {
      push("returned", { method: method, value: String(result) });
    }
  }

  function request(element, method) {
    method = method || "requestFullscreen";
    push("request", { method: method, target: describe(element) });
    if (typeof element[method] !== "function") {
      push("missing", { method: method });
      return;
    }
    var result;
    try {
      result = element[method]();
    } catch (error) {
      push("throw", { method: method, name: error.name, message: error.message });
      return;
    }
    settle("request", method, result);
  }

  function exit(method) {
    method = method || "exitFullscreen";
    push("exit", { method: method });
    var result;
    try {
      result = document[method]();
    } catch (error) {
      push("throw", { method: method, name: error.name, message: error.message });
      return;
    }
    settle("exit", method, result);
  }

  // A test video without media files: a canvas animation captured as a MediaStream.
  function makeVideo(video, colour) {
    var canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    var g = canvas.getContext("2d");
    var frame = 0;
    function draw() {
      g.fillStyle = colour || "#3060c0";
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = "#ffffff";
      g.fillRect((frame * 8) % 600, 150, 40, 60);
      frame++;
    }
    draw();
    setInterval(draw, 100);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = canvas.captureStream(10);
    var playing = video.play();
    if (playing && playing.catch) playing.catch(function () {});
  }

  window.CFS = { log: push, describe: describe, getters: getters, watch: watch, request: request, exit: exit, makeVideo: makeVideo };
})();
