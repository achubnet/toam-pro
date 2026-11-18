(function () {
  "use strict";

  var TAB_ID = Number(new URLSearchParams(location.search).get("tab"));
  var RECONNECT_MS = 1000;
  var PARKOUR_ONLY = "parkour only";

  var canvas = document.getElementById("map");
  var info = document.getElementById("info");
  var statusLine = document.getElementById("status");
  var parkourControls = document.querySelectorAll("[data-parkour-only]");
  var switches = {
    bushes: document.querySelector('[data-switch="bushes"]'),
    health: document.querySelector('[data-switch="health"]'),
    control: document.querySelector('[data-switch="control"]')
  };

  var renderer = TOC.renderer.create();
  var view = loadView();
  var frame = null;
  var port = null;
  var replaced = false;
  var dirty = true;
  var heldKeys = {};

  function loadView() {
    var v = { zoom: 2, follow: true, drive: false, health: false, control: false };
    try {
      var saved = JSON.parse(localStorage.getItem("toc.view") || "null") || {};
      if (saved.zoom > 0) v.zoom = saved.zoom;
      v.health = !!saved.health;
      v.control = !!saved.control;
    } catch (e) {}
    return v;
  }

  function saveView() {
    try {
      localStorage.setItem("toc.view", JSON.stringify({ zoom: view.zoom, health: view.health, control: view.control }));
    } catch (e) {}
  }

  function zoomBy(factor) {
    view.zoom = Math.max(0.5, Math.min(16, view.zoom * factor));
    saveView();
    dirty = true;
  }

  function connect() {
    if (replaced || !(TAB_ID >= 0)) return;
    try { port = chrome.tabs.connect(TAB_ID, { name: "toc-map" }); } catch (e) { port = null; }
    if (!port) {
      setTimeout(connect, RECONNECT_MS);
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(function () {
      void chrome.runtime.lastError;
      port = null;
      heldKeys = {};
      if (replaced) return;
      statusLine.textContent = "нет связи с игрой…";
      setTimeout(connect, RECONNECT_MS);
    });
  }

  function send(command) {
    if (!port) return;
    try { port.postMessage({ kind: "command", command: command }); } catch (e) {}
  }

  function onMessage(msg) {
    if (!msg) return;
    if (msg.kind === "map") {
      renderer.setMap(msg.id, msg.data, msg.orientation);
      dirty = true;
    } else if (msg.kind === "frame") {
      frame = msg.frame;
      dirty = true;
      updatePanel();
    } else if (msg.kind === "zoom") {
      zoomBy(msg.factor);
    } else if (msg.kind === "replaced") {
      replaced = true;
      window.close();
    }
  }

  function setParkourOnly(el, enabled) {
    if (el.disabled === !enabled) return;
    el.disabled = !enabled;
    var holder = el.closest(".switch") || el;
    if (enabled) {
      if (holder.hasAttribute("data-title")) holder.title = holder.getAttribute("data-title");
      else holder.removeAttribute("title");
    } else {
      if (holder.title && holder.title !== PARKOUR_ONLY) holder.setAttribute("data-title", holder.title);
      holder.title = PARKOUR_ONLY;
    }
  }

  function updatePanel() {
    var parkour = (frame && frame.parkour) || {};
    for (var i = 0; i < parkourControls.length; i++) setParkourOnly(parkourControls[i], !!parkour.active);
    switches.bushes.checked = !!parkour.bushesHidden;
    var me = frame && frame.me;
    info.textContent = me
      ? "X " + me.x.toFixed(1) + "  Y " + me.y.toFixed(1) + "  Z " + (me.z == null ? "—" : me.z.toFixed(1)) +
        (frame.speedKmh == null ? "" : "  " + Math.round(frame.speedKmh) + " км/ч")
      : "";
    statusLine.textContent = (frame && frame.status) || "";
  }

  function applyControl() {
    switches.health.checked = view.health;
    switches.control.checked = view.control;
    document.body.classList.toggle("control", view.control);
    if (!view.control) releaseKeys();
  }

  document.getElementById("panel").addEventListener("click", function (e) {
    var action = e.target && e.target.getAttribute("data-action");
    if (action === "map-in") zoomBy(1.25);
    else if (action === "map-out") zoomBy(0.8);
    else if (action === "camera-farther") send({ name: "camera", factor: 1.15 });
    else if (action === "camera-closer") send({ name: "camera", factor: 1 / 1.15 });
  });

  switches.bushes.addEventListener("change", function () {
    send({ name: "bushes", hide: switches.bushes.checked });
  });
  switches.health.addEventListener("change", function () {
    view.health = switches.health.checked;
    saveView();
    dirty = true;
  });
  switches.control.addEventListener("change", function () {
    view.control = switches.control.checked;
    saveView();
    applyControl();
  });

  function keyCommand(type, e) {
    return {
      name: "key", type: type, code: e.code, key: e.key, keyCode: e.keyCode,
      shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey
    };
  }

  function releaseKeys() {
    for (var code in heldKeys) send(heldKeys[code]);
    heldKeys = {};
  }

  window.addEventListener("keydown", function (e) {
    if (!view.control || e.isComposing || e.metaKey) return;
    e.preventDefault();
    if (e.repeat && heldKeys[e.code]) return;
    send(keyCommand("keydown", e));
    heldKeys[e.code] = keyCommand("keyup", e);
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!view.control || e.isComposing) return;
    e.preventDefault();
    send(keyCommand("keyup", e));
    delete heldKeys[e.code];
  }, true);

  window.addEventListener("blur", releaseKeys);

  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    zoomBy(e.deltaY > 0 ? 1 / 1.15 : 1.15);
  }, { passive: false });

  function fitCanvas() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    dirty = true;
  }

  function loop() {
    requestAnimationFrame(loop);
    fitCanvas();
    if (!dirty) return;
    dirty = false;
    renderer.draw(canvas, frame, view);
  }

  applyControl();
  updatePanel();
  connect();
  loop();
})();
