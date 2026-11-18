document.getElementById("open-map").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab) return;
    chrome.runtime.sendMessage({ action: "openMapWindow", tabId: tab.id });
    window.close();
  });
});
