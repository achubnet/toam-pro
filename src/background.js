(function () {
  "use strict";

  var NATIVE_HOST = "com.tocoords.maps";
  var MAP_WINDOW = { width: 560, height: 680 };

  function callNative(payload, sendResponse) {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, payload || {}, function (response) {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse(response || { ok: false, error: "empty" });
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  }

  function openMapWindow(tabId) {
    if (tabId == null) return;
    chrome.windows.create({
      url: chrome.runtime.getURL("src/window/window.html?tab=" + tabId),
      type: "popup",
      width: MAP_WINDOW.width,
      height: MAP_WINDOW.height
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.action === "native") {
      callNative(msg.payload, sendResponse);
      return true;
    }
    if (msg.action === "openMapWindow") {
      openMapWindow(msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id));
    }
  });
})();
