/*
 * chat = [{ id, time, author, side, text, team, system }]
 *   side: ally | enemy | null, team: message only for own team, time: ms
 */
(function (root) {
  "use strict";

  var MAX_ITEMS = 300;

  function timeText(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function span(cls, text) {
    var s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function item(m) {
    var li = document.createElement("li");
    li.className = "msg" + (m.system ? " system" : (m.team ? " team" : " all"));
    li.appendChild(span("time", timeText(m.time)));
    if (!m.system) {
      li.appendChild(span("tag", m.team ? "команде" : "всем"));
      li.appendChild(span("author " + (m.side || "unknown"), m.author || "?"));
    }
    li.appendChild(span("text", m.text || ""));
    return li;
  }

  function render(list, messages) {
    var known = list.known || (list.known = {});
    var stick = list.parentNode.scrollTop + list.parentNode.clientHeight >= list.parentNode.scrollHeight - 8;
    var added = [];
    (messages || []).forEach(function (m) {
      if (known[m.id]) return;
      known[m.id] = true;
      list.appendChild(item(m));
      added.push(m);
    });
    while (list.children.length > MAX_ITEMS) list.removeChild(list.firstChild);
    if (added.length && stick) list.parentNode.scrollTop = list.parentNode.scrollHeight;
    return added;
  }

  function clear(list) {
    list.textContent = "";
    list.known = {};
  }

  root.TOC.views = root.TOC.views || {};
  root.TOC.views.chat = { render: render, clear: clear };
})(window);
