(function (root) {
  "use strict";

  var TABS = [
    { id: "chat", label: "Чат", type: "feed", counted: true },
    { id: "players", label: "Игроки", type: "tables" },
    { id: "log", label: "Лог", type: "feed", newestFirst: true },
    { id: "damage", label: "Урон", type: "feed", newestFirst: true }
  ];
  var PATH_COLORS = { magnum: "#ffb000", grenade: "#9be15d" };
  var BAR_COLORS = { reload: "#ffb000", overdrive: "#b06bff" };
  var PARKOUR_ONLY = "parkour only";
  var MAP_OPTIONS = { orientation: null, hiddenBoxes: "grenade|aiming|foam|smoke", unitWidth: 3.5 };
  var PLAYER_COLUMNS = ["Игрок", "Пушка", "Корпус", "Очки", "У", "С"];

  function num(v, digits) {
    return typeof v === "number" && isFinite(v) ? v.toFixed(digits || 0) : null;
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

  function turnText(deg) {
    var s = num(Math.abs(deg));
    if (s == null) return null;
    return s === "0" ? "0°" : s + "° " + (deg > 0 ? "вправо" : "влево");
  }

  function speedText(s) {
    if (!s) return "";
    var now = num(s.now), max = num(s.max);
    if (now == null && max == null) return "";
    return "  " + (now == null ? "" : now) + (max == null ? "" : (now == null ? "" : " / ") + max) + " °/с";
  }

  function reloadRow(reload) {
    if (reload && typeof reload.total === "number" && reload.total > 0) {
      return { text: (num(reload.left, 1) || "0.0") + " / " + num(reload.total, 1) + " с", bar: 1 - (reload.left || 0) / reload.total };
    }
    if (reload && typeof reload.frac === "number") return { text: Math.round(reload.frac * 100) + "%", bar: reload.frac };
    return { text: null };
  }

  function overdriveRow(o) {
    if (!o) return null;
    if (o.active) return { text: "активен", bar: 1 };
    if (o.ready) return { text: "готов", bar: 1 };
    return typeof o.frac === "number" ? { text: Math.floor(o.frac * 100) + "%", bar: o.frac } : null;
  }

  function countText(n) {
    if (n == null) return "∞";
    return n >= 10000 ? Math.floor(n / 1000) + "k" : String(n);
  }

  function suppliesText(list) {
    if (!list || !list.length) return null;
    return list.map(function (s) {
      var text = s.name + " " + countText(s.count);
      if (s.active > 0.05) text += " · " + num(s.active) + "с";
      if (s.cooldown > 0.05) text += " (" + num(s.cooldown) + "с)";
      return text;
    }).join("   ");
  }

  function infoRows(raw) {
    var me = raw.me, t = raw.tank || {}, rows = [], reload = reloadRow(t.reload), overdrive = overdriveRow(t.overdrive);
    function add(label, text, extra) {
      var row = { label: label, text: text };
      if (extra) for (var k in extra) row[k] = extra[k];
      rows.push(row);
    }
    if (t.mapName) add("Карта", t.mapName);
    if (t.hull || t.turret) add("Танк", [t.hull, t.turret].filter(Boolean).join(" · "));
    add("X Y Z", me ? [num(me.x, 1), num(me.y, 1), num(me.z, 1) || "—"].join("  ") : null);
    add("Скорость", raw.speedKmh != null ? Math.round(raw.speedKmh) + " км/ч" : null);
    add("Корпус", me ? compass(me.heading) : null);
    if (turnText(t.turretDeg) != null) add("Башня", turnText(t.turretDeg) + speedText(t.turretSpeed));
    if (num(t.elevationDeg) != null) add("Наклон", num(t.elevationDeg) + "°" + speedText(t.elevationSpeed));
    add("Перезарядка", reload.text, { bar: reload.bar, barColor: BAR_COLORS.reload });
    if (overdrive) add("Овердрайв", overdrive.text, { bar: overdrive.bar, barColor: BAR_COLORS.overdrive });
    if (suppliesText(t.supplies)) add("Припасы", suppliesText(t.supplies), { wide: true });
    add("До кика", clock(t.idleKick));
    return rows;
  }

  function summary(raw) {
    var me = raw.me;
    if (!me) return "";
    return "X " + me.x.toFixed(1) + "  Y " + me.y.toFixed(1) + "  Z " + (me.z == null ? "—" : me.z.toFixed(1)) +
      (raw.speedKmh == null ? "" : "  " + Math.round(raw.speedKmh) + " км/ч");
  }

  function controls(parkour) {
    var on = !!(parkour && parkour.active), hint = on ? null : PARKOUR_ONLY;
    return [
      { id: "camera", type: "stepper", label: "Камера", enabled: on, hint: hint },
      { id: "bushes", type: "switch", label: "Скрыть кусты", value: !!(parkour && parkour.bushesHidden), enabled: on, hint: hint }
    ];
  }

  function banner(raw) {
    if (!raw.paused) return null;
    var left = raw.tank && clock(raw.tank.idleKick);
    return { title: "Пауза", text: left ? "до кика " + left : "" };
  }

  function path(aim, color) {
    return aim ? { pts: aim.pts, end: aim.land, color: color } : null;
  }

  function frame(raw) {
    var units = (raw.tanks || []).map(function (t) {
      return { x: t.x, y: t.y, z: t.z, side: t.side, dir: t.hd, hp: t.hp };
    }).concat((raw.carriers || []).map(function (c) {
      return { x: c.x, y: c.y, z: c.z, side: c.side, dir: c.hd, hp: c.hp, carrying: c.flagSide };
    }));
    var flags = (raw.bases || []).map(function (b) {
      return { x: b.x, y: b.y, side: b.side, state: b.taken ? "taken" : "home" };
    }).concat((raw.dropped || []).map(function (d) {
      return { x: d.x, y: d.y, side: d.side, state: "loose" };
    }));
    var points = (raw.cps || []).map(function (c) {
      return { x: c.x, y: c.y, label: c.letter, live: c.live, owner: c.owner, progressSide: c.ring, progress: c.frac, active: c.active };
    });
    var me = raw.me;
    return {
      self: me ? { x: me.x, y: me.y, z: me.z, heading: me.heading, aim: raw.ray, hp: me.hp, dead: !!me.dead } : null,
      units: units,
      flags: flags,
      points: points,
      marks: (raw.dead || []).map(function (d) { return { x: d.x, y: d.y, side: d.side, icon: "skull" }; }),
      paths: [path(raw.aim, PATH_COLORS.magnum), path(raw.grenadeAim, PATH_COLORS.grenade)].filter(Boolean),
      info: infoRows(raw),
      banner: banner(raw),
      summary: summary(raw),
      status: raw.status,
      controls: controls(raw.parkour)
    };
  }

  function chatFeed(log) {
    return log.map(function (m) {
      var parts = m.system ? [{ text: m.text }] : [
        { text: m.team ? "команде" : "всем", style: m.team ? "tag-green" : "tag" },
        { text: m.author + ":", side: m.side, style: "name", mine: m.me },
        { text: m.text }
      ];
      return { id: m.id, time: m.time, mine: !!m.me, style: m.system ? "quiet" : (m.team ? "highlight" : null), parts: parts };
    });
  }

  function playerPart(p) {
    return { text: (p && p.name) || "?", side: (p && p.side) || "unknown", style: "name", mine: !!(p && p.me) };
  }

  function logFeed(kills) {
    return kills.map(function (k) {
      var selfKill = !k.killer || (k.victim && k.killer.name === k.victim.name);
      var parts = selfKill
        ? [{ text: "самоуничтожение:", style: "muted" }, playerPart(k.victim)]
        : [playerPart(k.killer), { text: k.weapon ? "— " + k.weapon + " →" : "→", style: "muted" }, playerPart(k.victim)];
      return { id: k.id, time: k.time, parts: parts };
    });
  }

  function damageFeed(log) {
    return log.map(function (d) {
      var parts = [{ text: "−" + d.amount, style: "number" + (d.critical ? " warn" : "") }, playerPart(d.target)];
      if (d.critical) parts.push({ text: "крит", style: "tag-orange" });
      if (d.fatal) parts.push({ text: "добил", style: "tag-red" });
      return { id: d.id, time: d.time, parts: parts };
    });
  }

  function damageEmpty(stats) {
    if (!stats) return "Попаданий пока нет.";
    return "Попаданий пока нет. Слежу за танками: " + stats.watched + " из " + stats.tanks +
      ". Если в настройках игры выключен показ урона, сервер не присылает попадания.";
  }

  function playerTables(teams) {
    return teams.map(function (team) {
      return {
        title: team.name, side: team.side, columns: PLAYER_COLUMNS,
        rows: team.players.map(function (p) {
          return { mine: p.me, cells: [p.rank != null ? p.name + " · " + p.rank : p.name, p.turret, p.hull, p.score, p.kills, p.deaths] };
        })
      };
    });
  }

  root.TOC = root.TOC || {};
  root.TOC.viewModel = {
    tabs: TABS, mapOptions: MAP_OPTIONS, frame: frame,
    chatFeed: chatFeed, logFeed: logFeed, damageFeed: damageFeed, damageEmpty: damageEmpty,
    playerTables: playerTables, playersEmpty: "Нет данных — зайди в бой"
  };
})(window);
