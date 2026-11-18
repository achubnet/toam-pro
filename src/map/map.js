(function () {
  "use strict";

  var TAB_ID = Number(new URLSearchParams(location.search).get("tab"));
  var RECONNECT_MS = 1000;

  var canvas = document.getElementById("map");
  var info = document.getElementById("info");
  var statusLine = document.getElementById("status");
  var bushesButton = document.querySelector('[data-action="bushes"]');
  var parkourButtons = document.querySelectorAll("[data-parkour] button");

  var renderer = TOC.renderer.create();
  var view = loadView();
  var frame = null;
  var port = null;
  var replaced = false;
  var dirty = true;

  function loadView() {
    var v = { zoom: 2, follow: true, drive: false };
    try {
      var saved = JSON.parse(localStorage.getItem("toc.view") || "null");
      if (saved && saved.zoom > 0) v.zoom = saved.zoom;
    } catch (e) {}
    return v;
  }

  function saveView() {
    try { localStorage.setItem("toc.view", JSON.stringify({ zoom: view.zoom })); } catch (e) {}
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

  function updatePanel() {
    var parkour = (frame && frame.parkour) || {};
    for (var i = 0; i < parkourButtons.length; i++) parkourButtons[i].disabled = !parkour.active;
    bushesButton.textContent = parkour.bushesHidden ? "Кусты: скрыты" : "Кусты: видны";
    var me = frame && frame.me;
    info.textContent = me
      ? "X " + me.x.toFixed(1) + "  Y " + me.y.toFixed(1) + "  Z " + (me.z == null ? "—" : me.z.toFixed(1)) +
        (frame.speedKmh == null ? "" : "  " + Math.round(frame.speedKmh) + " км/ч")
      : "";
    statusLine.textContent = (frame && frame.status) || "";
  }

  document.getElementById("panel").addEventListener("click", function (e) {
    var action = e.target && e.target.getAttribute("data-action");
    if (action === "map-in") zoomBy(1.25);
    else if (action === "map-out") zoomBy(0.8);
    else if (action === "camera-farther") send({ name: "camera", factor: 1.15 });
    else if (action === "camera-closer") send({ name: "camera", factor: 1 / 1.15 });
    else if (action === "bushes") send({ name: "bushes", hide: !(frame && frame.parkour && frame.parkour.bushesHidden) });
  });

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

  updatePanel();
  connect();
  loop();
})();
