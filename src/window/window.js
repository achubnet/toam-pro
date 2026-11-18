(function () {
  "use strict";

  var TAB_ID = Number(new URLSearchParams(location.search).get("tab"));
  var RECONNECT_MS = 1000;
  var PARKOUR_ONLY = "parkour only";
  var VIEW_SWITCHES = ["rotate", "heights", "roofs", "health", "tank", "control"];

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
  var switches = {};
  Array.prototype.forEach.call(document.querySelectorAll("[data-switch]"), function (el) {
    switches[el.getAttribute("data-switch")] = el;
  });
  var feeds = {
    chat: { render: TOC.views.chat.render, clear: TOC.views.chat.clear, list: lists.chat, lastId: 0, seenId: 0, unread: 0 },
    kills: { render: TOC.views.kills.render, clear: TOC.views.kills.clear, list: lists.kills, lastId: 0, seenId: 0, unread: 0 }
  };
  var battleKey = null;

  var renderer = TOC.renderer.create();
  var view = loadView();
  var frame = null;
  var port = null;
  var replaced = false;
  var dirty = true;
  var heldKeys = {};

  function loadView() {
    var v = { zoom: 2, follow: true, drive: false, tab: "map" }, saved = {};
    try { saved = JSON.parse(localStorage.getItem("toc.view") || "null") || {}; } catch (e) {}
    if (saved.zoom > 0) v.zoom = saved.zoom;
    if (saved.tab) v.tab = saved.tab;
    VIEW_SWITCHES.forEach(function (key) { v[key] = !!saved[key]; });
    return v;
  }

  function saveView() {
    var data = { zoom: view.zoom, tab: view.tab };
    VIEW_SWITCHES.forEach(function (key) { data[key] = view[key]; });
    try { localStorage.setItem("toc.view", JSON.stringify(data)); } catch (e) {}
  }

  function loadSeen(key) {
    try {
      var saved = JSON.parse(localStorage.getItem("toc.seen") || "null");
      return saved && saved.key === key ? saved : null;
    } catch (e) { return null; }
  }

  function saveSeen() {
    var data = { key: battleKey, chat: feeds.chat.seenId, kills: feeds.kills.seenId };
    try { localStorage.setItem("toc.seen", JSON.stringify(data)); } catch (e) {}
  }

  function showBadge(name) {
    var badge = document.querySelector('[data-badge="' + name + '"]');
    if (badge) badge.textContent = feeds[name].unread ? String(feeds[name].unread) : "";
  }

  function markSeen(name) {
    var feed = feeds[name];
    feed.unread = 0;
    showBadge(name);
    if (feed.seenId === feed.lastId) return;
    feed.seenId = feed.lastId;
    saveSeen();
  }

  function startBattle(msg) {
    battleKey = msg.session + ":" + msg.id;
    var seen = loadSeen(battleKey) || {};
    Object.keys(feeds).forEach(function (name) {
      var feed = feeds[name];
      feed.clear(feed.list);
      feed.lastId = 0;
      feed.seenId = seen[name] || 0;
      feed.unread = 0;
      showBadge(name);
    });
  }

  function addToFeed(name, items) {
    var feed = feeds[name], added = feed.render(feed.list, items);
    added.forEach(function (item) {
      feed.lastId = Math.max(feed.lastId, item.id);
      if (item.id > feed.seenId && !item.me) feed.unread++;
    });
    if (view.tab === name) markSeen(name);
    else showBadge(name);
  }

  function showTab(name) {
    if (!document.querySelector('section[data-tab="' + name + '"]')) name = "map";
    view.tab = name;
    saveView();
    var all = document.querySelectorAll("[data-tab]");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("active", all[i].getAttribute("data-tab") === name);
    if (feeds[name]) markSeen(name);
    dirty = true;
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
      startBattle(msg);
    } else if (msg.kind === "chat") {
      addToFeed("chat", msg.messages);
    } else if (msg.kind === "kills") {
      addToFeed("kills", msg.kills);
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
    VIEW_SWITCHES.forEach(function (key) { switches[key].checked = view[key]; });
    tankInfo.hidden = !view.tank;
    if (view.tank) TOC.views.tank.render(tankInfo, frame);
    document.body.classList.toggle("control", view.control);
    if (!view.control) releaseKeys();
    dirty = true;
  }

  document.getElementById("panel").addEventListener("click", function (e) {
    var action = e.target && e.target.getAttribute("data-action");
    if (action === "map-in") zoomBy(1.25);
    else if (action === "map-out") zoomBy(0.8);
    else if (action === "camera-farther") send({ name: "camera", factor: 1.15 });
    else if (action === "camera-closer") send({ name: "camera", factor: 1 / 1.15 });
  });

  document.getElementById("panel").addEventListener("change", function (e) {
    var key = e.target && e.target.getAttribute("data-switch");
    if (key === "bushes") {
      send({ name: "bushes", hide: e.target.checked });
    } else if (VIEW_SWITCHES.indexOf(key) >= 0) {
      view[key] = e.target.checked;
      saveView();
      applySwitches();
    }
  });
  document.getElementById("tabs").addEventListener("click", function (e) {
    var tab = e.target.closest("[data-tab]");
    if (tab) showTab(tab.getAttribute("data-tab"));
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
