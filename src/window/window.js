(function () {
  "use strict";

  var TAB_ID = Number(new URLSearchParams(location.search).get("tab"));
  var RECONNECT_MS = 1000;
  var PARKOUR_ONLY = "parkour only";

  var canvas = document.getElementById("map");
  var info = document.getElementById("info");
  var statusLine = document.getElementById("status");
  var parkourControls = document.querySelectorAll("[data-parkour-only]");
  var tankInfo = document.getElementById("tank-info");
  var lists = {
    chat: document.getElementById("chat"),
    players: document.getElementById("players"),
    kills: document.getElementById("kills")
  };
  var switches = {
    bushes: document.querySelector('[data-switch="bushes"]'),
    health: document.querySelector('[data-switch="health"]'),
    tank: document.querySelector('[data-switch="tank"]'),
    control: document.querySelector('[data-switch="control"]')
  };
  var unread = { chat: 0, kills: 0 };

  var renderer = TOC.renderer.create();
  var view = loadView();
  var frame = null;
  var port = null;
  var replaced = false;
  var dirty = true;
  var heldKeys = {};

  function loadView() {
    var v = { zoom: 2, follow: true, drive: false, health: false, tank: false, control: false, tab: "map" };
    try {
      var saved = JSON.parse(localStorage.getItem("toc.view") || "null") || {};
      if (saved.zoom > 0) v.zoom = saved.zoom;
      v.health = !!saved.health;
      v.tank = !!saved.tank;
      v.control = !!saved.control;
      if (saved.tab) v.tab = saved.tab;
    } catch (e) {}
    return v;
  }

  function saveView() {
    try {
      localStorage.setItem("toc.view", JSON.stringify({
        zoom: view.zoom, health: view.health, tank: view.tank, control: view.control, tab: view.tab
      }));
    } catch (e) {}
  }

  function showTab(name) {
    if (!document.querySelector('section[data-tab="' + name + '"]')) name = "map";
    view.tab = name;
    saveView();
    var all = document.querySelectorAll("[data-tab]");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("active", all[i].getAttribute("data-tab") === name);
    if (unread[name] != null) setUnread(name, 0);
    dirty = true;
  }

  function setUnread(name, count) {
    unread[name] = count;
    var badge = document.querySelector('[data-badge="' + name + '"]');
    if (badge) badge.textContent = count ? String(count) : "";
  }

  function noteNew(name, added) {
    if (added && view.tab !== name) setUnread(name, unread[name] + added);
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
      if (view.tank) TOC.views.tank.render(tankInfo, frame);
    } else if (msg.kind === "battle") {
      TOC.views.chat.clear(lists.chat);
      TOC.views.kills.clear(lists.kills);
      setUnread("chat", 0);
      setUnread("kills", 0);
    } else if (msg.kind === "chat") {
      noteNew("chat", TOC.views.chat.render(lists.chat, msg.messages));
    } else if (msg.kind === "kills") {
      noteNew("kills", TOC.views.kills.render(lists.kills, msg.kills));
    } else if (msg.kind === "players") {
      TOC.views.players.render(lists.players, msg.teams);
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

  function applySwitches() {
    switches.health.checked = view.health;
    switches.tank.checked = view.tank;
    tankInfo.hidden = !view.tank;
    if (view.tank) TOC.views.tank.render(tankInfo, frame);
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
  switches.tank.addEventListener("change", function () {
    view.tank = switches.tank.checked;
    saveView();
    applySwitches();
  });
  document.getElementById("tabs").addEventListener("click", function (e) {
    var tab = e.target.closest("[data-tab]");
    if (tab) showTab(tab.getAttribute("data-tab"));
  });
  switches.control.addEventListener("change", function () {
    view.control = switches.control.checked;
    saveView();
    applySwitches();
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
    if (!w || !h) return;
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    dirty = true;
  }

  function loop() {
    requestAnimationFrame(loop);
    if (view.tab !== "map") return;
    fitCanvas();
    if (!dirty) return;
    dirty = false;
    renderer.draw(canvas, frame, view);
  }

  showTab(view.tab);
  TOC.views.players.render(lists.players, []);
  applySwitches();
  updatePanel();
  connect();
  loop();
})();
