(function () {
  "use strict";

  var SOURCE_TAB = Number(new URLSearchParams(location.search).get("tab"));
  var PORT_NAME = "map-view";
  var RECONNECT_MS = 1000;
  var VIEW_SWITCHES = ["rotate", "heights", "roofs", "health", "info", "keys"];

  var canvas = document.getElementById("map");
  var infoBox = document.getElementById("info");
  var banner = document.getElementById("banner");
  var summaryLine = document.getElementById("summary");
  var statusLine = document.getElementById("status");
  var controlsBox = document.getElementById("controls");
  var tabsNav = document.getElementById("tabs");
  var pages = document.getElementById("pages");
  var switches = {};
  Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (el) {
    switches[el.getAttribute("data-view")] = el;
  });

  var renderer = View.renderer.create();
  var view = loadView();
  var frame = null;
  var port = null;
  var replaced = false;
  var dirty = true;
  var heldKeys = {};
  var tabs = {};
  var sessionKey = null;
  var controlsKey = "";

  function loadView() {
    var v = { zoom: 2, follow: true, drive: false, tab: "map" }, saved = {};
    try { saved = JSON.parse(localStorage.getItem("view") || "null") || {}; } catch (e) {}
    if (saved.zoom > 0) v.zoom = saved.zoom;
    if (saved.tab) v.tab = saved.tab;
    VIEW_SWITCHES.forEach(function (key) { v[key] = !!saved[key]; });
    return v;
  }

  function saveView() {
    var data = { zoom: view.zoom, tab: view.tab };
    VIEW_SWITCHES.forEach(function (key) { data[key] = view[key]; });
    try { localStorage.setItem("view", JSON.stringify(data)); } catch (e) {}
  }

  function loadSeen(key) {
    try {
      var saved = JSON.parse(localStorage.getItem("seen") || "null");
      return saved && saved.key === key ? saved.ids || {} : {};
    } catch (e) { return {}; }
  }

  function saveSeen() {
    var ids = {};
    Object.keys(tabs).forEach(function (id) { if (tabs[id].def.counted) ids[id] = tabs[id].seenId; });
    try { localStorage.setItem("seen", JSON.stringify({ key: sessionKey, ids: ids })); } catch (e) {}
  }

  function showBadge(id) {
    var tab = tabs[id];
    if (tab && tab.badge) tab.badge.textContent = tab.unread ? String(tab.unread) : "";
  }

  function markSeen(id) {
    var tab = tabs[id];
    if (!tab || !tab.def.counted) return;
    tab.unread = 0;
    showBadge(id);
    if (tab.seenId === tab.lastId) return;
    tab.seenId = tab.lastId;
    saveSeen();
  }

  function showTab(id) {
    if (!pages.querySelector('section[data-tab="' + id + '"]')) id = "map";
    view.tab = id;
    saveView();
    var all = document.querySelectorAll("[data-tab]");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("active", all[i].getAttribute("data-tab") === id);
    markSeen(id);
    dirty = true;
  }

  function createTab(def) {
    var button = document.createElement("button"), section = document.createElement("section"), tab = { def: def };
    button.setAttribute("data-tab", def.id);
    button.textContent = def.label + " ";
    if (def.counted) {
      tab.badge = document.createElement("span");
      tab.badge.className = "badge";
      button.appendChild(tab.badge);
    }
    section.className = "tab list";
    section.setAttribute("data-tab", def.id);
    tab.empty = document.createElement("p");
    tab.empty.className = "empty";
    section.appendChild(tab.empty);
    tab.body = document.createElement(def.type === "tables" ? "div" : "ol");
    tab.body.className = def.type === "tables" ? "tables" : "feed";
    section.appendChild(tab.body);
    tabsNav.appendChild(button);
    pages.appendChild(section);
    tab.button = button;
    tab.section = section;
    tab.lastId = 0;
    tab.seenId = 0;
    tab.unread = 0;
    return tab;
  }

  function defineTabs(defs) {
    var wanted = {};
    (defs || []).forEach(function (def) { wanted[def.id] = true; });
    Object.keys(tabs).forEach(function (id) {
      if (wanted[id]) return;
      tabs[id].button.remove();
      tabs[id].section.remove();
      delete tabs[id];
    });
    (defs || []).forEach(function (def) {
      if (!tabs[def.id]) tabs[def.id] = createTab(def);
    });
    showTab(view.tab);
  }

  function startSession(key) {
    sessionKey = key;
    var seen = loadSeen(key);
    Object.keys(tabs).forEach(function (id) {
      var tab = tabs[id];
      if (tab.def.type === "feed") View.feed.clear(tab.body);
      tab.lastId = 0;
      tab.seenId = seen[id] || 0;
      tab.unread = 0;
      showBadge(id);
    });
  }

  function showEmpty(tab, text, hasItems) {
    tab.empty.textContent = text || "";
    tab.empty.hidden = hasItems || !text;
  }

  function addFeed(id, entries, empty) {
    var tab = tabs[id];
    if (!tab) return;
    var added = View.feed.render(tab.body, entries, !!tab.def.newestFirst);
    showEmpty(tab, empty, tab.body.children.length > 0);
    if (!tab.def.counted) return;
    added.forEach(function (e) {
      tab.lastId = Math.max(tab.lastId, e.id);
      if (e.id > tab.seenId && !e.mine) tab.unread++;
    });
    if (view.tab === id) markSeen(id);
    else showBadge(id);
  }

  function showTables(id, tables, empty) {
    var tab = tabs[id];
    if (!tab) return;
    View.tables.render(tab.body, tables, null);
    showEmpty(tab, empty, !!(tables && tables.length));
  }

  function zoomBy(factor) {
    view.zoom = Math.max(0.5, Math.min(16, view.zoom * factor));
    saveView();
    dirty = true;
  }

  function connect() {
    if (replaced || !(SOURCE_TAB >= 0)) return;
    try { port = chrome.tabs.connect(SOURCE_TAB, { name: PORT_NAME }); } catch (e) { port = null; }
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
      statusLine.textContent = "нет связи…";
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
      renderer.setMap(msg.id, msg.data, msg.options);
      dirty = true;
    } else if (msg.kind === "frame") {
      frame = msg.frame;
      dirty = true;
      updatePanel();
    } else if (msg.kind === "tabs") {
      defineTabs(msg.tabs);
    } else if (msg.kind === "session") {
      startSession(msg.id);
    } else if (msg.kind === "feed") {
      addFeed(msg.id, msg.entries, msg.empty);
    } else if (msg.kind === "tables") {
      showTables(msg.id, msg.tables, msg.empty);
    } else if (msg.kind === "zoom") {
      zoomBy(msg.factor);
    } else if (msg.kind === "replaced") {
      replaced = true;
      window.close();
    }
  }

  function controlElement(c) {
    var holder, input;
    if (c.type === "switch") {
      holder = document.createElement("label");
      holder.className = "switch";
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!c.value;
      input.disabled = c.enabled === false;
      input.setAttribute("data-control", c.id);
      var text = document.createElement("span");
      text.textContent = c.label;
      holder.appendChild(input);
      holder.appendChild(text);
    } else {
      holder = document.createElement("div");
      holder.className = "group";
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = c.label;
      holder.appendChild(label);
      [[-1, "−"], [1, "+"]].forEach(function (step) {
        var b = document.createElement("button");
        b.textContent = step[1];
        b.disabled = c.enabled === false;
        b.setAttribute("data-control", c.id);
        b.setAttribute("data-step", step[0]);
        if (c.hint) b.title = c.hint;
        holder.appendChild(b);
      });
    }
    if (c.hint) holder.title = c.hint;
    return holder;
  }

  function renderControls(list) {
    var key = JSON.stringify(list || []);
    if (key === controlsKey) return;
    controlsKey = key;
    controlsBox.textContent = "";
    (list || []).forEach(function (c) { controlsBox.appendChild(controlElement(c)); });
  }

  function updatePanel() {
    var f = frame || {};
    renderControls(f.controls);
    summaryLine.textContent = f.summary || "";
    statusLine.textContent = f.status || "";
    banner.hidden = !f.banner;
    if (f.banner) {
      banner.firstChild.textContent = f.banner.title || "";
      banner.lastChild.textContent = f.banner.text || "";
    }
    if (view.info) View.info.render(infoBox, f.info);
  }

  function applySwitches() {
    VIEW_SWITCHES.forEach(function (key) { switches[key].checked = view[key]; });
    infoBox.hidden = !view.info;
    if (view.info) View.info.render(infoBox, frame && frame.info);
    document.body.classList.toggle("keys", view.keys);
    if (!view.keys) releaseKeys();
    dirty = true;
  }

  document.getElementById("panel").addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-zoom")) zoomBy(Number(t.getAttribute("data-zoom")));
    else if (t.hasAttribute("data-control")) send({ name: "control", id: t.getAttribute("data-control"), value: Number(t.getAttribute("data-step")) });
  });

  document.getElementById("panel").addEventListener("change", function (e) {
    var t = e.target, key = t.getAttribute("data-view");
    if (t.hasAttribute("data-control")) {
      send({ name: "control", id: t.getAttribute("data-control"), value: t.checked });
    } else if (VIEW_SWITCHES.indexOf(key) >= 0) {
      view[key] = t.checked;
      saveView();
      applySwitches();
    }
  });

  tabsNav.addEventListener("click", function (e) {
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
    if (!view.keys || e.isComposing || e.metaKey) return;
    e.preventDefault();
    if (e.repeat && heldKeys[e.code]) return;
    send(keyCommand("keydown", e));
    heldKeys[e.code] = keyCommand("keyup", e);
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!view.keys || e.isComposing) return;
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
  applySwitches();
  updatePanel();
  connect();
  loop();
})();
