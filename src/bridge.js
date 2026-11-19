(function () {
  "use strict";

  var MAP_PORT = "map-view";
  var mapPort = null;

  try {
    document.documentElement.setAttribute("data-to-coords-maps", chrome.runtime.getURL("maps/"));
  } catch (e) {}

  // After the extension is reloaded this copy of the script is cut off from it: every
  // chrome.runtime call throws. Say so on the page instead of failing silently.
  var staleShown = false;

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function showStale() {
    if (staleShown) return;
    staleShown = true;
    try { console.warn("[toCoords] расширение обновлено — перезагрузи вкладку (F5)"); } catch (e) {}
    try {
      var box = document.createElement("div");
      box.textContent = "TO Coords обновлён — перезагрузи вкладку (F5), чтобы карта заработала";
      box.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "background:#202124;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:6px;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none";
      (document.body || document.documentElement).appendChild(box);
      setTimeout(function () { box.remove(); }, 15000);
    } catch (e2) {}
  }

  function toExtension(msg, callback) {
    if (!alive()) { showStale(); return false; }
    try {
      if (callback) chrome.runtime.sendMessage(msg, callback);
      else chrome.runtime.sendMessage(msg);
      return true;
    } catch (e) {
      showStale();
      return false;
    }
  }

  function toPage(msg) {
    msg.type = "TOC_IN";
    window.postMessage(msg, "*");
  }

  chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== MAP_PORT) return;
    if (mapPort) {
      try { mapPort.postMessage({ kind: "replaced" }); } catch (e) {}
      try { mapPort.disconnect(); } catch (e2) {}
    }
    mapPort = port;
    toPage({ kind: "connected" });
    port.onMessage.addListener(function (msg) {
      if (msg && msg.kind === "command") toPage({ kind: "command", command: msg.command });
    });
    port.onDisconnect.addListener(function () {
      if (!alive()) showStale();
      if (mapPort !== port) return;
      mapPort = null;
      toPage({ kind: "disconnected" });
    });
  });

  function relayNative(data) {
    function reply(result) {
      window.postMessage({ type: "TO_COORDS_NATIVE_RESULT", id: data.id, result: result }, "*");
    }
    var sent = toExtension({ action: "native", payload: data.payload }, function (res) {
      var err = chrome.runtime.lastError;
      reply(err ? { ok: false, error: err.message } : (res || { ok: false, error: "empty" }));
    });
    if (!sent) reply({ ok: false, error: "extension reloaded" });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;
    var data = event.data;
    if (data.type === "TO_COORDS_NATIVE") {
      relayNative(data);
    } else if (data.type === "TOC_OUT") {
      if (data.kind === "open") toExtension({ action: "openMapWindow" });
      else if (mapPort) {
        try { mapPort.postMessage(data); } catch (e) {}
      }
    }
  });
})();
