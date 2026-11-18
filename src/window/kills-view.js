/*
 * kills = [{ id, time, killer: { name, side }, victim: { name, side }, weapon }]
 *   killer is null for self-destruction
 */
(function (root) {
  "use strict";

  var MAX_ITEMS = 200;

  function timeText(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" +
      String(d.getSeconds()).padStart(2, "0");
  }

  function player(p) {
    var s = document.createElement("span");
    s.className = "player " + ((p && p.side) || "unknown") + (p && p.me ? " me" : "");
    s.textContent = (p && p.name) || "?";
    return s;
  }

  function item(k) {
    var li = document.createElement("li");
    var time = document.createElement("span");
    time.className = "time";
    time.textContent = timeText(k.time);
    li.appendChild(time);
    if (k.killer && k.killer.name !== (k.victim && k.victim.name)) {
      li.appendChild(player(k.killer));
      var weapon = document.createElement("span");
      weapon.className = "weapon";
      weapon.textContent = k.weapon ? "— " + k.weapon + " →" : "→";
      li.appendChild(weapon);
    } else {
      var self = document.createElement("span");
      self.className = "weapon";
      self.textContent = "самоуничтожение:";
      li.appendChild(self);
    }
    li.appendChild(player(k.victim));
    return li;
  }

  function render(list, kills) {
    var known = list.known || (list.known = {});
    var added = 0;
    (kills || []).forEach(function (k) {
      if (known[k.id]) return;
      known[k.id] = true;
      list.insertBefore(item(k), list.firstChild);
      added++;
    });
    while (list.children.length > MAX_ITEMS) list.removeChild(list.lastChild);
    return added;
  }

  function clear(list) {
    list.textContent = "";
    list.known = {};
  }

  root.TOC.views = root.TOC.views || {};
  root.TOC.views.kills = { render: render, clear: clear };
})(window);
