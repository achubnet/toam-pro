(function () {
  "use strict";
  try {
    document.documentElement.setAttribute("data-to-coords-maps", chrome.runtime.getURL("maps/"));
  } catch (e) {}

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.type !== "TO_COORDS_NATIVE") return;
    chrome.runtime.sendMessage({ action: "native", payload: data.payload }, function (res) {
      var err = chrome.runtime.lastError;
      window.postMessage({
        type: "TO_COORDS_NATIVE_RESULT",
        id: data.id,
        result: err ? { ok: false, error: err.message } : (res || { ok: false, error: "empty" })
      }, "*");
    });
  });
})();
