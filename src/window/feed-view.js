/*
 * entries = [{ id, time, mine, style, parts: [{ text, side, style }] }]
 *   style (entry): highlight | quiet, style (part): tag | tag-green | tag-orange | tag-red | name | number | warn | muted
 */
(function (root) {
  "use strict";

  var MAX_ITEMS = 300;

  function timeText(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, "0"); }).join(":");
  }

  function span(cls, text) {
    var s = document.createElement("span");
    s.className = cls;
    s.textContent = text == null ? "" : String(text);
    return s;
  }

  function item(e) {
    var li = document.createElement("li");
    li.className = "entry" + (e.style ? " " + e.style : "");
    li.appendChild(span("time", timeText(e.time)));
    (e.parts || []).forEach(function (p) {
      var cls = "part" + (p.style ? " " + p.style : "") + (p.side ? " side-" + p.side : "") + (p.mine ? " mine" : "");
      li.appendChild(span(cls, p.text));
    });
    return li;
  }

  function scroller(list) {
    return list.parentNode;
  }

  function render(list, entries, newestFirst) {
    var known = list.known || (list.known = {}), added = [];
    var box = scroller(list), stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
    (entries || []).forEach(function (e) {
      if (known[e.id]) return;
      known[e.id] = true;
      if (newestFirst) list.insertBefore(item(e), list.firstChild);
      else list.appendChild(item(e));
      added.push(e);
    });
    while (list.children.length > MAX_ITEMS) list.removeChild(newestFirst ? list.lastChild : list.firstChild);
    if (added.length && stick && !newestFirst) box.scrollTop = box.scrollHeight;
    return added;
  }

  function clear(list) {
    list.textContent = "";
    list.known = {};
  }

  root.View = root.View || {};
  root.View.feed = { render: render, clear: clear };
})(window);
