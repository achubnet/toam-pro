(function () {
  "use strict";
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.action !== "native") return;
    try {
      chrome.runtime.sendNativeMessage("com.tocoords.maps", msg.payload || {}, function (response) {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response || { ok: false, error: "empty" });
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return true;
  });
})();
