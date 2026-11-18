(function () {
  "use strict";

  var MAP_PORT = "map-view";
  var mapPort = null;

  try {
    document.documentElement.setAttribute("data-to-coords-maps", chrome.runtime.getURL("maps/"));
  } catch (e) {}

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
      if (mapPort !== port) return;
      mapPort = null;
      toPage({ kind: "disconnected" });
    });
  });

  function relayNative(data) {
    chrome.runtime.sendMessage({ action: "native", payload: data.payload }, function (res) {
      var err = chrome.runtime.lastError;
      window.postMessage({
        type: "TO_COORDS_NATIVE_RESULT",
        id: data.id,
        result: err ? { ok: false, error: err.message } : (res || { ok: false, error: "empty" })
      }, "*");
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;
    var data = event.data;
    if (data.type === "TO_COORDS_NATIVE") {
      relayNative(data);
    } else if (data.type === "TOC_OUT") {
      if (data.kind === "open") chrome.runtime.sendMessage({ action: "openMapWindow" });
      else if (mapPort) {
        try { mapPort.postMessage(data); } catch (e) {}
      }
    }
  });
})();
