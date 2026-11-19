/*
 * Screen-fixed overlays on the map: damage numbers popping up in the top-right
 * corner and my supplies (cooldowns, active effects) in the bottom-right corner.
 *
 * pops:     [{ text, style, name, at }]                 style: hit | crit | kill (name: victim); at: ms (Date.now clock)
 * boxes:    drawBox(ctx, x, y, { type, falling })      type: FIRST_AID | DOUBLE_ARMOR | DOUBLE_DAMAGE | NITRO | CRYSTAL | GOLD
 * supplies: [{ id, count, cooldown, active }]           id: FIRST_AID | DOUBLE_ARMOR | ...; count null = unlimited;
 *                                                       cooldown, active: seconds left
 */
(function (root) {
  "use strict";

  function isFiniteNum(n) { return typeof n === "number" && isFinite(n); }

  // ---- damage numbers -------------------------------------------------------

  var POP_MS = 2000;
  var KILL_MS = 3000;
  var POP_ROWS = 6;
  var POP_STYLE = {
    hit: { color: "#ffe14d", size: 20 },
    crit: { color: "#ff9a2e", size: 24 },
    fatal: { color: "#ff4040", size: 28 }
  };
  var KILL = { color: "#ff4040", fill: "#3a0d0d", name: "#ffd2d2", height: 32 };
  var FONT = "ui-sans-serif, system-ui, sans-serif";

  function popLife(p) { return p.style === "kill" ? KILL_MS : POP_MS; }

  function drawSkullIcon(ctx, x, y, c) {
    ctx.beginPath();
    ctx.arc(x, y - 2, 7, Math.PI * 0.85, Math.PI * 2.15);
    ctx.lineTo(x + 4.5, y + 7);
    ctx.lineTo(x - 4.5, y + 7);
    ctx.closePath();
    ctx.fillStyle = c;
    ctx.fill();
    ctx.fillStyle = KILL.fill;
    ctx.beginPath(); ctx.arc(x - 2.8, y - 1.5, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 2.8, y - 1.5, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(x - 0.6, y + 3, 1.2, 4);
  }

  // A killing hit: red plate with a skull, the damage and the victim's nickname,
  // right edge at x, top at y. Returns its height.
  function drawKillPlate(ctx, x, y, p, t) {
    var num = String(p.text), name = p.name ? String(p.name) : "", pad = 8, h = KILL.height;
    ctx.font = "900 22px " + FONT;
    var numW = ctx.measureText(num).width;
    ctx.font = "500 12px " + FONT;
    var nameW = name ? ctx.measureText(name).width + 6 : 0;
    var w = pad + 18 + 6 + numW + nameW + pad, left = x - w;
    var grow = t < 0.05 ? 1 + 0.5 * (1 - t / 0.05) : 1;
    ctx.save();
    ctx.translate(x, y + h / 2);
    ctx.scale(grow, grow);
    ctx.translate(-x, -(y + h / 2));
    roundRect(ctx, left, y, w, h, 7);
    ctx.fillStyle = KILL.fill;
    ctx.shadowColor = KILL.color;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = KILL.color;
    ctx.stroke();
    ctx.shadowBlur = 0;
    drawSkullIcon(ctx, left + pad + 9, y + h / 2, KILL.color);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "900 22px " + FONT;
    ctx.fillStyle = KILL.color;
    ctx.fillText(num, left + pad + 24, y + h / 2 + 1);
    if (name) {
      ctx.font = "500 12px " + FONT;
      ctx.fillStyle = KILL.name;
      ctx.fillText(name, left + pad + 24 + numW + 6, y + h / 2 + 1);
    }
    ctx.restore();
    return h;
  }

  // Newest on top; each number pops in big, settles, drifts up a little and fades.
  // A kill shows as a plate (see drawKillPlate) and stays a second longer.
  // Returns true while anything is on screen, so the window keeps drawing.
  function drawPops(ctx, W, pops, now, top) {
    var live = (pops || []).filter(function (p) { return isFiniteNum(p.at) && now - p.at >= 0 && now - p.at < popLife(p); });
    if (!live.length) return false;
    live.sort(function (a, b) { return b.at - a.at; });
    var y = top, x = W - 12;
    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    live.slice(0, POP_ROWS).forEach(function (p) {
      var t = (now - p.at) / popLife(p);
      ctx.globalAlpha = t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;
      if (p.style === "kill") {
        y += drawKillPlate(ctx, x, y, p, t) + 5;
        return;
      }
      var st = POP_STYLE[p.style] || POP_STYLE.hit;
      var grow = t < 0.06 ? 1 + 0.8 * (1 - t / 0.06) : 1, ty = y - 8 * t;
      ctx.font = "900 " + Math.round(st.size * grow) + "px " + FONT;
      ctx.shadowColor = "transparent";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(0,0,0,0.95)";
      ctx.strokeText(p.text, x, ty);
      ctx.shadowColor = st.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = st.color;
      ctx.fillText(p.text, x, ty);
      y += st.size + 4;
    });
    ctx.restore();
    return true;
  }

  // ---- supplies ---------------------------------------------------------------

  var SLOT = 30;
  var GAP = 4;

  function outline(ctx) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.fill();
    ctx.stroke();
  }

  function iconCross(ctx, x, y, c) {
    ctx.beginPath();
    ctx.moveTo(x - 2.5, y - 8); ctx.lineTo(x + 2.5, y - 8); ctx.lineTo(x + 2.5, y - 2.5); ctx.lineTo(x + 8, y - 2.5);
    ctx.lineTo(x + 8, y + 2.5); ctx.lineTo(x + 2.5, y + 2.5); ctx.lineTo(x + 2.5, y + 8); ctx.lineTo(x - 2.5, y + 8);
    ctx.lineTo(x - 2.5, y + 2.5); ctx.lineTo(x - 8, y + 2.5); ctx.lineTo(x - 8, y - 2.5); ctx.lineTo(x - 2.5, y - 2.5);
    ctx.closePath();
    ctx.fillStyle = c;
    outline(ctx);
  }

  function iconShield(ctx, x, y, c) {
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 8); ctx.lineTo(x + 7, y - 8); ctx.lineTo(x + 7, y - 1);
    ctx.quadraticCurveTo(x + 7, y + 6, x, y + 9);
    ctx.quadraticCurveTo(x - 7, y + 6, x - 7, y - 1);
    ctx.closePath();
    ctx.fillStyle = c;
    outline(ctx);
  }

  function iconBurst(ctx, x, y, c) {
    ctx.beginPath();
    for (var i = 0; i < 16; i++) {
      var a = i * Math.PI / 8 - Math.PI / 2, r = i % 2 ? 4 : 9;
      if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = c;
    outline(ctx);
  }

  function iconBolt(ctx, x, y, c) {
    ctx.beginPath();
    ctx.moveTo(x + 2, y - 9); ctx.lineTo(x - 6, y + 1); ctx.lineTo(x - 1, y + 1);
    ctx.lineTo(x - 3, y + 9); ctx.lineTo(x + 6, y - 2); ctx.lineTo(x + 1, y - 2);
    ctx.closePath();
    ctx.fillStyle = c;
    outline(ctx);
  }

  function iconMine(ctx, x, y, c) {
    ctx.beginPath();
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2 + Math.PI / 4;
      ctx.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      ctx.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = c;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = c;
    outline(ctx);
  }

  function iconGrenade(ctx, x, y, c) {
    ctx.beginPath();
    ctx.rect(x - 2, y - 9, 4, 4);
    ctx.fillStyle = c;
    outline(ctx);
    ctx.beginPath();
    ctx.arc(x, y + 2, 7, 0, Math.PI * 2);
    outline(ctx);
  }

  function iconBox(ctx, x, y, c) {
    ctx.beginPath();
    ctx.rect(x - 7, y - 7, 14, 14);
    ctx.fillStyle = c;
    outline(ctx);
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function iconRadiation(ctx, x, y, c) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = c;
    outline(ctx);
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    for (var i = 0; i < 3; i++) {
      var a = i * Math.PI * 2 / 3 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, 7, a - 0.5, a + 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  function iconDiamond(ctx, x, y, c) {
    ctx.beginPath();
    ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y - 2); ctx.lineTo(x, y + 9); ctx.lineTo(x - 7, y - 2);
    ctx.closePath();
    ctx.fillStyle = c;
    outline(ctx);
  }

  var SUPPLY_LOOK = {
    FIRST_AID: { color: "#4cd964", icon: iconCross },
    DOUBLE_ARMOR: { color: "#3ba7ff", icon: iconShield },
    DOUBLE_DAMAGE: { color: "#ff4d4d", icon: iconBurst },
    NITRO: { color: "#ffcc00", icon: iconBolt },
    MINE: { color: "#c08cff", icon: iconMine },
    GRENADE: { color: "#9be15d", icon: iconGrenade },
    GOLD_BOX: { color: "#ffd700", icon: iconBox },
    NUCLEAR: { color: "#ff7a00", icon: iconRadiation },
    CRYSTAL: { color: "#7fe3ff", icon: iconDiamond },
    GOLD: { color: "#ffd700", icon: iconBox }
  };

  // ---- supply boxes on the map --------------------------------------------------

  var BOX_PX = 18;

  function drawParachute(ctx, x, y) {
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = "#e8edf2";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y - 4, 8, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 8, y - 4); ctx.lineTo(x - 3, y + 6);
    ctx.moveTo(x + 8, y - 4); ctx.lineTo(x + 3, y + 6);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 6);
    ctx.strokeStyle = "#e8edf2";
    ctx.stroke();
    ctx.restore();
  }

  // A box: a square in its type's colour with the type's icon. While it falls it is
  // see-through, hangs from a parachute and its landing spot is ringed with dashes.
  function drawBox(ctx, x, y, b) {
    var look = SUPPLY_LOOK[b.type] || { color: "#c8c8c8", icon: null }, h = BOX_PX / 2;
    ctx.save();
    if (b.falling) {
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = look.color;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha *= 0.6;
    }
    roundRect(ctx, x - h, y - h, BOX_PX, BOX_PX, 4);
    ctx.fillStyle = look.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.stroke();
    if (look.icon) {
      ctx.translate(x, y);
      ctx.scale(0.6, 0.6);
      look.icon(ctx, 0, 0, "#16181a");
    }
    ctx.restore();
    if (b.falling) drawParachute(ctx, x, y - h - 8);
  }

  // The page sends only time left; the full length of a cooldown or effect is the
  // largest time left seen since it started.
  function createSupplyTimers() {
    return { cooldown: {}, active: {} };
  }

  function longest(store, id, left) {
    if (!(left > 0.05)) { delete store[id]; return 0; }
    store[id] = Math.max(store[id] || 0, left);
    return store[id];
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function countText(n) {
    if (n == null) return "∞";
    return n >= 10000 ? Math.floor(n / 1000) + "k" : String(n);
  }

  // Ready: bright icon. Active: glowing frame in the supply's colour, a bar draining
  // along the bottom and the seconds left. Cooldown: dim icon under a dark sweep that
  // shrinks as it comes back, with the seconds left in the middle.
  function drawSlot(ctx, x, y, s, timers, now) {
    var look = SUPPLY_LOOK[s.id] || { color: "#d0d4d8", icon: null }, c = look.color;
    var actTotal = longest(timers.active, s.id, s.active), cdTotal = longest(timers.cooldown, s.id, s.cooldown);
    var active = actTotal > 0, cooling = !active && cdTotal > 0, empty = s.count === 0 && !active && !cooling;
    var cx = x + SLOT / 2, cy = y + SLOT / 2;
    ctx.save();
    roundRect(ctx, x, y, SLOT, SLOT, 5);
    ctx.fillStyle = "rgba(16,18,20,0.85)";
    ctx.fill();
    if (active) {
      ctx.shadowColor = c;
      ctx.shadowBlur = 10 + 5 * Math.sin(now / 160);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = c;
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.stroke();
    }
    ctx.globalAlpha = cooling || empty ? 0.35 : 1;
    if (look.icon) look.icon(ctx, cx, cy, c);
    else {
      ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = c;
      ctx.fillText(String(s.label || s.id || "?").slice(0, 3), cx, cy);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    if (cooling) {
      var frac = Math.max(0, Math.min(1, s.cooldown / cdTotal));
      ctx.save();
      roundRect(ctx, x, y, SLOT, SLOT, 5);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, SLOT, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fill();
      ctx.restore();
      ctx.font = "bold 12px ui-sans-serif, system-ui, sans-serif";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.strokeText(String(Math.ceil(s.cooldown)), cx, cy);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(Math.ceil(s.cooldown)), cx, cy);
    }
    if (active) {
      var left = Math.max(0, Math.min(1, s.active / actTotal));
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x + 3, y + SLOT - 6, SLOT - 6, 3);
      ctx.fillStyle = c;
      ctx.fillRect(x + 3, y + SLOT - 6, (SLOT - 6) * left, 3);
      ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.strokeText(String(Math.ceil(s.active)), x + 3, y + 2);
      ctx.fillStyle = c;
      ctx.fillText(String(Math.ceil(s.active)), x + 3, y + 2);
    }
    ctx.font = "bold 8px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(countText(s.count), x + SLOT - 2, y + SLOT - (active ? 6 : 1));
    ctx.fillStyle = "#e8edf2";
    ctx.fillText(countText(s.count), x + SLOT - 2, y + SLOT - (active ? 6 : 1));
    ctx.restore();
  }

  // One row of slots in the bottom-right corner, its bottom edge at `bottom`.
  function drawSupplies(ctx, W, bottom, supplies, timers, now) {
    var list = supplies || [];
    if (!list.length) return;
    now = isFiniteNum(now) ? now : Date.now();
    var x = W - 8 - list.length * SLOT - (list.length - 1) * GAP, y = bottom - SLOT;
    list.forEach(function (s, i) { drawSlot(ctx, x + i * (SLOT + GAP), y, s, timers || createSupplyTimers(), now); });
  }

  root.View = root.View || {};
  root.View.hud = { drawPops: drawPops, drawSupplies: drawSupplies, createSupplyTimers: createSupplyTimers, drawBox: drawBox };
})(window);
