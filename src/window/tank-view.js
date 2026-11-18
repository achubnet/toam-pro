/*
 * frame.tank = {
 *   mapName, hull, turret,
 *   turretDeg, turretSpeed: { now, max },       turret relative to hull, + is right, deg and deg/s
 *   elevationDeg, elevationSpeed: { now, max },  only for turrets that tilt
 *   reload: { left, total } | { frac },          seconds, or 0…1 when the duration is unknown
 *   idleKick                                     seconds until kick
 * }
 */
(function (root) {
  "use strict";

  var ROWS = [
    ["map", "Карта"],
    ["kit", "Танк"],
    ["coords", "X Y Z"],
    ["speed", "Скорость"],
    ["hull", "Корпус"],
    ["turret", "Башня"],
    ["elevation", "Наклон"],
    ["reload", "Перезарядка"],
    ["idle", "До кика"]
  ];

  function num(v, digits) {
    return typeof v === "number" && isFinite(v) ? v.toFixed(digits || 0) : null;
  }

  function degrees(v) {
    var s = num(v);
    return s == null ? null : s + "°";
  }

  function turretText(v) {
    var s = num(Math.abs(v));
    if (s == null) return null;
    if (s === "0") return "0°";
    return s + "° " + (v > 0 ? "вправо" : "влево");
  }

  function speed(s) {
    if (!s) return "";
    var now = num(s.now), max = num(s.max);
    if (now == null && max == null) return "";
    return "  " + (now == null ? "" : now) + (max == null ? "" : (now == null ? "" : " / ") + max) + " °/с";
  }

  function clock(sec) {
    if (typeof sec !== "number" || !isFinite(sec)) return null;
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function compass(heading) {
    if (typeof heading !== "number" || !isFinite(heading)) return null;
    var d = 90 - heading * 180 / Math.PI;
    return Math.round(((d % 360) + 360) % 360) + "°";
  }

  function values(frame) {
    var me = frame && frame.me, t = (frame && frame.tank) || {};
    var reload = t.reload, reloadText = null, reloadFrac = null;
    if (reload && typeof reload.total === "number" && reload.total > 0) {
      reloadText = (num(reload.left, 1) || "0.0") + " / " + num(reload.total, 1) + " с";
      reloadFrac = 1 - (reload.left || 0) / reload.total;
    } else if (reload && typeof reload.frac === "number") {
      reloadText = Math.round(reload.frac * 100) + "%";
      reloadFrac = reload.frac;
    }
    return {
      map: t.mapName || null,
      kit: t.hull || t.turret ? [t.hull, t.turret].filter(Boolean).join(" · ") : null,
      coords: me ? [num(me.x, 1), num(me.y, 1), num(me.z, 1) || "—"].join("  ") : null,
      speed: frame && frame.speedKmh != null ? Math.round(frame.speedKmh) + " км/ч" : null,
      hull: me ? compass(me.heading) : null,
      turret: turretText(t.turretDeg) == null ? null : turretText(t.turretDeg) + speed(t.turretSpeed),
      elevation: degrees(t.elevationDeg) == null ? null : degrees(t.elevationDeg) + speed(t.elevationSpeed),
      reload: reloadText,
      reloadFrac: reloadFrac == null ? null : Math.max(0, Math.min(1, reloadFrac)),
      idle: clock(t.idleKick)
    };
  }

  function build(el) {
    var cells = {};
    el.textContent = "";
    ROWS.forEach(function (row) {
      var line = document.createElement("div");
      line.className = "row";
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = row[1];
      var value = document.createElement("span");
      value.className = "value";
      line.appendChild(label);
      line.appendChild(value);
      el.appendChild(line);
      cells[row[0]] = { line: line, value: value };
    });
    var bar = document.createElement("div");
    bar.className = "reload-bar";
    bar.appendChild(document.createElement("div"));
    cells.reload.line.appendChild(bar);
    cells.reloadBar = bar;
    return cells;
  }

  function render(el, frame) {
    if (!el.cells) el.cells = build(el);
    var v = values(frame), key, cell;
    for (var i = 0; i < ROWS.length; i++) {
      key = ROWS[i][0];
      cell = el.cells[key];
      cell.line.hidden = v[key] == null && (key === "elevation" || key === "turret" || key === "map" || key === "kit");
      cell.value.textContent = v[key] == null ? "—" : v[key];
    }
    el.cells.reloadBar.hidden = v.reloadFrac == null;
    if (v.reloadFrac != null) el.cells.reloadBar.firstChild.style.width = Math.round(v.reloadFrac * 100) + "%";
  }

  root.TOC.views = root.TOC.views || {};
  root.TOC.views.tank = { render: render };
})(window);
