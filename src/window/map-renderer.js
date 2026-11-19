/*
 * frame = {
 *   self: { x, y, z, heading, aim: { dx, dy, dist }, hp, dead } | null,   hp: { now, max } | null
 *   units: [{ x, y, z, side, dir: { x, y } | null, hp, carrying }],      carrying: side of a carried flag
 *   flags: [{ x, y, side, state }],                                       state: home | taken | loose
 *   points: [{ x, y, label, live, owner, progressSide, progress, active }],
 *   marks: [{ x, y, side, icon, alpha }],                                 icon: hazard | skull
 *   paths: [{ pts: [[x, y], ...], end: [x, y] | null, color }]
 * }
 * side: ally | enemy | red | blue | neutral | unknown
 * view = { zoom, follow, drive, health, heights, roofs, rotate }
 */
(function (root) {
  "use strict";

  var layers = root.View.layers;
  var isFiniteNum = root.MapGeometry.isFiniteNum;

  var SIDE = {
    ally: "#1e6bff", enemy: "#ff2a2a", red: "#ff2a2a", blue: "#1e6bff",
    neutral: "#8a8a8a", unknown: "#c8c8c8"
  };

  function niceMetres(span) {
    var steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
    var i, target = span * 0.28;
    for (i = 0; i < steps.length; i++) if (steps[i] >= target) return steps[i];
    return 1000;
  }

  function drawArrow(ctx, x, y, dx, dy, fill, stroke, k) {
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    var nx = -dy, ny = dx, L = 11 * k, B = 7 * k, T = 4 * k;
    ctx.beginPath();
    ctx.moveTo(x + dx * L, y + dy * L);
    ctx.lineTo(x - dx * L * 0.7 + nx * B, y - dy * L * 0.7 + ny * B);
    ctx.lineTo(x - dx * T, y - dy * T);
    ctx.lineTo(x - dx * L * 0.7 - nx * B, y - dy * L * 0.7 - ny * B);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();
  }

  function sideColor(side, fallback) {
    return SIDE[side] || fallback || SIDE.unknown;
  }

  function drawSelfArrow(ctx, x, y, dx, dy, k) {
    drawArrow(ctx, x, y, dx, dy, "#ffffff", "#000000", k || 1);
  }

  // The Juggernaut's marker is twice as big; labels around it move out to match.
  var BIG_SCALE = 2;
  function unitScale(u) { return u && u.big ? BIG_SCALE : 1; }

  function drawFlagIcon(ctx, x, y, color, k, outline) {
    var top = y - 20 * k, w = 14 * k, h = 10 * k;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x, top);
    ctx.strokeStyle = "#000"; ctx.lineWidth = 4 * k; ctx.stroke();
    ctx.strokeStyle = outline; ctx.lineWidth = 2 * k; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.bezierCurveTo(x + w * 0.35, top - 3 * k, x + w * 0.65, top + 3 * k, x + w, top);
    ctx.lineTo(x + w, top + h);
    ctx.bezierCurveTo(x + w * 0.65, top + h + 3 * k, x + w * 0.35, top + h - 3 * k, x, top + h);
    ctx.closePath();
    ctx.strokeStyle = "#000"; ctx.lineWidth = 3 * k; ctx.stroke();
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = outline; ctx.lineWidth = 1.2 * k; ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.2 * k, 0, Math.PI * 2);
    ctx.fillStyle = outline; ctx.fill();
    ctx.restore();
  }

  function drawBlinkingFlag(ctx, x, y, color) {
    ctx.save();
    ctx.globalAlpha = Math.floor(Date.now() / 250) % 2 === 0 ? 1 : 0.3;
    drawFlagIcon(ctx, x, y, color, 0.85, "#ffd400");
    ctx.restore();
  }

  function healthColor(frac) {
    if (frac > 0.6) return "#7dff7a";
    if (frac > 0.3) return "#ffd84a";
    return "#ff6b5a";
  }

  var HEALTH_BAR_W = 22;

  function hasHealth(hp) {
    return !!hp && isFiniteNum(hp.now) && hp.now > 0;
  }

  function drawHealth(ctx, x, y, hp) {
    if (!hasHealth(hp)) return;
    var frac = hp.max > 0 ? Math.max(0, Math.min(1, hp.now / hp.max)) : 1, color = healthColor(frac);
    ctx.save();
    ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(String(hp.now), x, y);
    ctx.fillStyle = color;
    ctx.fillText(String(hp.now), x, y);
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillRect(x - 1, y + 5, HEALTH_BAR_W + 2, 5);
    ctx.fillStyle = "#3a3f44";
    ctx.fillRect(x, y + 6, HEALTH_BAR_W, 3);
    ctx.fillStyle = color;
    ctx.fillRect(x, y + 6, Math.round(HEALTH_BAR_W * frac), 3);
    ctx.restore();
  }

  // Team colours, made very light so the names stand out on the map.
  var NAME_COLORS = {
    ally: "#c9dcff", blue: "#c9dcff", enemy: "#ffcaca", red: "#ffcaca",
    neutral: "#eef2f6", unknown: "#eef2f6"
  };
  var HIT_COLOR = "#ffd400";
  var HIT_BLINK_MS = 200;
  var HIT_BLINKS = 3;

  // True during the three yellow blinks after this player hit us.
  function hitBlinkOn(u) {
    if (!isFiniteNum(u.hitAt)) return false;
    var t = Date.now() - u.hitAt;
    return t >= 0 && t < HIT_BLINK_MS * 2 * HIT_BLINKS && Math.floor(t / HIT_BLINK_MS) % 2 === 0;
  }

  // The tank that killed me: arrow turns yellow and pulses with a glow for 5 seconds.
  var KILLER_GLOW_MS = 5000;
  function killerGlow(u) {
    if (!isFiniteNum(u.killedMeAt)) return 0;
    var t = Date.now() - u.killedMeAt;
    if (t < 0 || t >= KILLER_GLOW_MS) return 0;
    return 10 + 8 * (0.5 + 0.5 * Math.cos(t / 1000 * Math.PI * 3));
  }

  function nameColor(u) {
    return hitBlinkOn(u) ? HIT_COLOR : (NAME_COLORS[u.side] || NAME_COLORS.unknown);
  }

  // Frame around the shooter: thick yellow line with a strong glow, drawn twice so
  // the glow stacks up and is seen at a glance.
  var HIT_GLOW_PX = 18;
  function drawHitFrame(ctx, x, y, s) {
    var r = 14 * (s || 1);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = 6;
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = "rgba(255,212,0,0.18)";
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.shadowColor = HIT_COLOR;
    ctx.shadowBlur = HIT_GLOW_PX;
    ctx.strokeStyle = HIT_COLOR;
    ctx.lineWidth = 3;
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }

  function drawName(ctx, x, y, name, color, underline) {
    ctx.save();
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(name, x, y);
    ctx.fillStyle = color;
    ctx.fillText(name, x, y);
    if (underline) {
      var half = ctx.measureText(name).width / 2, ly = y + 11;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - half, ly);
      ctx.lineTo(x + half, ly);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.stroke();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = underline;
      ctx.stroke();
    }
    ctx.restore();
  }

  // My Magnum shell in flight: a glowing dot moving along its path, with the rest
  // of the path ahead and the landing spot. pts: [[x, y, ms after the shot], ...].
  function shellAt(pts, t) {
    var i, a, b, k;
    if (t <= pts[0][2]) return { x: pts[0][0], y: pts[0][1], i: 0 };
    for (i = 1; i < pts.length; i++) {
      if (t > pts[i][2]) continue;
      a = pts[i - 1]; b = pts[i];
      k = b[2] > a[2] ? (t - a[2]) / (b[2] - a[2]) : 1;
      return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, i: i };
    }
    a = pts[pts.length - 1];
    return { x: a[0], y: a[1], i: pts.length };
  }

  // On landing the shell turns red for half a second, then it is gone.
  var SHELL_BURST_MS = 500;
  var SHELL_BURST_COLOR = "#ff2a2a";

  function drawShellBurst(ctx, p, t) {
    var k = t / SHELL_BURST_MS, r = 5 + 5 * k;
    ctx.save();
    ctx.globalAlpha = 1 - 0.5 * k;
    ctx.shadowColor = SHELL_BURST_COLOR;
    ctx.shadowBlur = 16;
    ctx.fillStyle = SHELL_BURST_COLOR;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Returns true while the shell is still flying or bursting, so the window keeps drawing.
  function drawShell(ctx, toScreen, shell, now) {
    var pts = shell && shell.pts;
    if (!pts || pts.length < 2 || !isFiniteNum(shell.firedAt)) return false;
    var t = now - shell.firedAt, end = pts[pts.length - 1], color = shell.color || "#ffb000";
    if (t < 0 || t > end[2] + SHELL_BURST_MS) return false;
    if (t > end[2]) {
      drawShellBurst(ctx, toScreen(end[0], end[1]), t - end[2]);
      return true;
    }
    var at = shellAt(pts, t), p = toScreen(at.x, at.y), e = toScreen(end[0], end[1]), i, q;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (i = at.i; i < pts.length; i++) { q = toScreen(pts[i][0], pts[i][1]); ctx.lineTo(q.x, q.y); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(e.x, e.y, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#fff6d6";
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    return true;
  }

  function drawSkull(ctx, x, y, color) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - 2, 6.5, Math.PI * 0.85, Math.PI * 2.15);
    ctx.lineTo(x + 4, y + 3);
    ctx.lineTo(x + 4, y + 6.5);
    ctx.lineTo(x - 4, y + 6.5);
    ctx.lineTo(x - 4, y + 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.beginPath();
    ctx.arc(x - 2.5, y - 1.5, 1.9, 0, Math.PI * 2);
    ctx.arc(x + 2.5, y - 1.5, 1.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y + 0.8);
    ctx.lineTo(x - 1, y + 2.6);
    ctx.lineTo(x + 1, y + 2.6);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x - 1.6, y + 4, 0.9, 2.5);
    ctx.fillRect(x + 0.7, y + 4, 0.9, 2.5);
    ctx.restore();
  }

  function drawHazard(ctx, x, y, color) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();
    ctx.restore();
  }

  var MARK_ICONS = { skull: drawSkull, hazard: drawHazard };
  // Marks drawn over the tank arrows rather than under them.
  var MARKS_ON_TOP = { skull: true };

  function drawMarks(ctx, vt, W, H, marks, onTop) {
    for (var i = 0; i < (marks || []).length; i++) {
      var m = marks[i], draw = MARK_ICONS[m.icon], p = vt.toScreen(m.x, m.y);
      if (!draw || !!MARKS_ON_TOP[m.icon] !== onTop || offView(p, W, H, 10)) continue;
      ctx.save();
      ctx.globalAlpha = typeof m.alpha === "number" ? m.alpha : 1;
      draw(ctx, p.x, p.y, sideColor(m.side, SIDE.unknown));
      ctx.restore();
    }
  }

  function offView(p, W, H, m) {
    return p.x < -m || p.y < -m || p.x > W + m || p.y > H + m;
  }

  function flagColor(side) {
    return side === "neutral" || !SIDE[side] ? "#c9c14a" : SIDE[side];
  }

  function drawFlags(ctx, toScreen, W, H, flags) {
    var i, o, p, blinkOn = (Date.now() / 180) % 2 < 1;
    for (i = 0; i < (flags || []).length; i++) {
      o = flags[i];
      p = toScreen(o.x, o.y);
      if (offView(p, W, H, 24)) continue;
      ctx.save();
      if (o.state === "taken") {
        ctx.globalAlpha = blinkOn ? 1 : 0.28;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawFlagIcon(ctx, p.x - 4, p.y + 8, flagColor(o.side), 1, o.state === "loose" ? "#ffd400" : "#ffffff");
      ctx.restore();
    }
  }

  function drawPoint(ctx, p, c) {
    var TAU = Math.PI * 2;
    if (!c.live) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, TAU);
      ctx.fillStyle = "rgba(20,20,20,0.75)";
      ctx.strokeStyle = "#ffe56a";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffe56a";
      ctx.fillText(c.label || "?", p.x, p.y + 0.5);
      return;
    }
    var r = 9, ring = r + 4.5, frac = Math.max(0, Math.min(1, c.progress || 0));
    ctx.globalAlpha = c.active === false ? 0.45 : 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ring, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 5.5;
    ctx.stroke();
    if (frac > 0.005) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      ctx.strokeStyle = sideColor(c.progressSide, SIDE.neutral);
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fillStyle = sideColor(c.owner, SIDE.neutral);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(c.label || "?", p.x, p.y + 0.5);
    ctx.globalAlpha = 1;
  }

  function drawObjectives(ctx, toScreen, W, H, f) {
    var i, p;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
    drawFlags(ctx, toScreen, W, H, f.flags);
    for (i = 0; i < (f.points || []).length; i++) {
      p = toScreen(f.points[i].x, f.points[i].y);
      if (offView(p, W, H, 20)) continue;
      drawPoint(ctx, p, f.points[i]);
    }
    ctx.restore();
  }

  var COVERED_ALPHA = 0.35;
  var SAME_LEVEL_M = 1;

  function drawHeightMark(ctx, x, y, dz) {
    if (!isFiniteNum(dz) || Math.abs(dz) <= SAME_LEVEL_M) return;
    var size = 2.5 + Math.min(Math.abs(dz), 20) * 0.35, up = dz > 0;
    var base = up ? y - 9 : y + 9, tip = up ? base - size * 1.3 : base + size * 1.3;
    ctx.beginPath();
    ctx.moveTo(x - size, base);
    ctx.lineTo(x + size, base);
    ctx.lineTo(x, tip);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = "#ffffff";
    ctx.stroke();
    ctx.fill();
  }

  function drawDot(ctx, x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }

  function drawUnitMarker(ctx, vt, u, p, col, k) {
    if (u.dir) {
      var d = vt.dir(u.dir.x, u.dir.y);
      drawArrow(ctx, p.x, p.y, d.x, d.y, col, "rgba(0,0,0,0.85)", k);
    } else {
      drawDot(ctx, p.x, p.y, 5 * k / 0.85, col);
    }
  }

  function drawUnits(ctx, vt, W, H, units, o) {
    var i, u, p, s, glow;
    for (i = 0; i < (units || []).length; i++) {
      u = units[i];
      p = vt.toScreen(u.x, u.y);
      s = unitScale(u);
      if (offView(p, W, H, 30 * s)) continue;
      glow = killerGlow(u);
      ctx.save();
      ctx.globalAlpha = o.covered(u) && !glow ? COVERED_ALPHA : 1;
      if (glow) { ctx.shadowColor = HIT_COLOR; ctx.shadowBlur = glow; }
      drawUnitMarker(ctx, vt, u, p, glow ? HIT_COLOR : sideColor(u.side, SIDE.unknown), (u.carrying ? 0.95 : 0.85) * s);
      ctx.restore();
      if (hitBlinkOn(u)) drawHitFrame(ctx, p.x, p.y, s);
      if (u.carrying) drawBlinkingFlag(ctx, p.x + 6, p.y - 4, sideColor(u.carrying, SIDE.neutral));
      if (o.heights && o.selfZ != null && isFiniteNum(u.z)) drawHeightMark(ctx, p.x, p.y, u.z - o.selfZ);
      if (o.health) drawHealth(ctx, p.x + 9 * s, p.y + 8 * s, u.hp);
      if (o.names && u.name) drawName(ctx, p.x, p.y + 8 * (s - 1) + (o.health && hasHealth(u.hp) ? 22 : 14), u.name, nameColor(u), u.underline);
    }
  }

  function drawSelf(ctx, vt, self, W, H, viewM, o) {
    var p = vt.toScreen(self.x, self.y), s = unitScale(self);
    ctx.save();
    ctx.globalAlpha = o.covered(self) ? COVERED_ALPHA : 1;
    if (self.dead) {
      drawSkull(ctx, p.x, p.y, "#ffffff");
    } else if (!isFiniteNum(self.heading)) {
      drawDot(ctx, p.x, p.y, 6, "#ffffff");
    } else {
      var hx = Math.cos(self.heading), hy = Math.sin(self.heading), aim = self.aim || {};
      var ax = isFiniteNum(aim.dx) ? aim.dx : hx, ay = isFiniteNum(aim.dy) ? aim.dy : hy;
      var len = Math.sqrt(ax * ax + ay * ay) || 1;
      var reach = isFiniteNum(aim.dist) && aim.dist > 0 ? aim.dist : Math.sqrt(W * W + H * H) / 2 / viewM;
      var end = vt.toScreen(self.x + ax / len * reach, self.y + ay / len * reach);
      ctx.strokeStyle = "#ffcc33";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      var d = vt.dir(hx, hy);
      drawSelfArrow(ctx, p.x, p.y, d.x, d.y, s);
    }
    ctx.restore();
    if (o.health && !self.dead) drawHealth(ctx, p.x + 11 * s, p.y + 8 * s, self.hp);
  }

  function drawNorth(ctx, vt, W) {
    var d = vt.dir(0, 1), x = W - 20, y = 20;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(16,18,20,0.75)";
    ctx.fill();
    drawArrow(ctx, x - d.x * 2, y - d.y * 2, d.x, d.y, "#ff5a4f", "rgba(0,0,0,0.85)", 0.6);
    ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e8edf2";
    ctx.fillText("N", x - d.x * 9, y - d.y * 9);
    ctx.restore();
  }

  function drawPath(ctx, toScreen, path) {
    if (!path) return;
    var i, p, pts = path.pts || [], color = path.color || "#ffb000";
    ctx.save();
    ctx.fillStyle = color;
    for (i = 0; i < pts.length; i++) {
      p = toScreen(pts[i][0], pts[i][1]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (path.end) {
      p = toScreen(path.end[0], path.end[1]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 12, p.y); ctx.lineTo(p.x - 4, p.y);
      ctx.moveTo(p.x + 4, p.y); ctx.lineTo(p.x + 12, p.y);
      ctx.moveTo(p.x, p.y - 12); ctx.lineTo(p.x, p.y - 4);
      ctx.moveTo(p.x, p.y + 4); ctx.lineTo(p.x, p.y + 12);
      ctx.stroke();
    }
    ctx.restore();
  }

  function facingAngle(self) {
    var aim = self.aim || {};
    if (isFiniteNum(aim.dx) && isFiniteNum(aim.dy) && (aim.dx || aim.dy)) return Math.atan2(aim.dy, aim.dx);
    return isFiniteNum(self.heading) ? self.heading : null;
  }

  // Frames arrive ~30 times a second. Between them keep moving and turning at the
  // last measured rate: prediction rather than smoothing, so the view never lags.
  var AHEAD_MAX_MS = 80;
  var MAX_SPEED_M_PER_MS = 0.06;
  var MAX_TURN_RAD_PER_MS = 0.01;

  function wrapAngle(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  function createMotion() {
    return { t: null, x: 0, y: 0, a: null, vx: 0, vy: 0, w: 0 };
  }

  // m: motion state kept between draws; t: when the page sampled this frame.
  function predictMotion(m, self, t, now) {
    var a = facingAngle(self), dt;
    if (!isFiniteNum(t)) return { x: self.x, y: self.y, facing: a, moving: false };
    if (m.t !== t) {
      dt = m.t == null ? 0 : t - m.t;
      if (dt > 0 && dt < 400) {
        m.vx = (self.x - m.x) / dt;
        m.vy = (self.y - m.y) / dt;
        if (Math.sqrt(m.vx * m.vx + m.vy * m.vy) > MAX_SPEED_M_PER_MS) { m.vx = 0; m.vy = 0; }
        m.w = a != null && m.a != null ? wrapAngle(a - m.a) / dt : 0;
        if (Math.abs(m.w) > MAX_TURN_RAD_PER_MS) m.w = 0;
      } else {
        m.vx = 0; m.vy = 0; m.w = 0;
      }
      m.t = t; m.x = self.x; m.y = self.y; m.a = a;
    }
    var ahead = Math.max(0, Math.min(AHEAD_MAX_MS, now - t));
    return {
      x: self.x + m.vx * ahead, y: self.y + m.vy * ahead,
      facing: a == null ? null : a + m.w * ahead,
      moving: !!(m.vx || m.vy || m.w) && now - t < AHEAD_MAX_MS
    };
  }

  function movedTo(o, x, y) {
    var c = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
    c.x = x;
    c.y = y;
    return c;
  }

  function clampSpan(v, lo, hi) {
    return lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
  }

  // Centre on the tank, but near the edge of the map slide the view inwards so the
  // window shows map instead of the void past its edge. The tank always stays in sight.
  function fitCenter(self, b, W, H, viewM, rot) {
    var cosR = Math.cos(rot), sinR = Math.sin(rot), ac = Math.abs(cosR), as = Math.abs(sinR);
    var ex = (W / 2 * ac + H / 2 * as) / viewM, ey = (W / 2 * as + H / 2 * ac) / viewM;
    var x = clampSpan(self.x, b.xmin + ex, b.xmax - ex), y = clampSpan(self.y, b.ymin + ey, b.ymax - ey);
    var margin = Math.max(30, 0.1 * Math.min(W, H));
    var rx = self.x - x, ry = self.y - y;
    var u = (rx * cosR - ry * sinR) * viewM, v = (rx * sinR + ry * cosR) * viewM;
    var mu = Math.max(0, W / 2 - margin), mv = Math.max(0, H / 2 - margin);
    var u2 = Math.max(-mu, Math.min(mu, u)), v2 = Math.max(-mv, Math.min(mv, v));
    if (u2 === u && v2 === v) return { x: x, y: y };
    return { x: self.x - (u2 * cosR + v2 * sinR) / viewM, y: self.y - (v2 * cosR - u2 * sinR) / viewM };
  }

  function drawPicture(ctx, L, view, self, W, H, cx, cy, viewM, rot) {
    var b = L.bounds, k = viewM / b.scale, c = layers.worldToPicture(cx, cy, b);
    var reach = Math.sqrt(W * W + H * H) / 2 / k;
    var selfZ = self && isFiniteNum(self.z) ? self.z : null;
    var onHigh = selfZ != null && selfZ >= (L.splitZ || 2.4) - 0.35;
    function blit(img, alpha) {
      if (!img) return;
      var x0 = Math.max(0, c.x - reach), y0 = Math.max(0, c.y - reach);
      var x1 = Math.min(img.width, c.x + reach), y1 = Math.min(img.height, c.y + reach);
      if (x1 <= x0 || y1 <= y0) return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-rot);
    ctx.scale(k, k);
    ctx.translate(-c.x, -c.y);
    ctx.imageSmoothingEnabled = true;
    if (view.drive && L.driveCanvas) {
      blit(L.driveCanvas, 1);
    } else if (L.layerLow && L.layerHigh) {
      blit(L.layerLow, onHigh ? 0.35 : 1);
      blit(L.layerHigh, onHigh ? 1 : 0.42);
    } else {
      blit(L.offscreen, 1);
    }
    blit(L.outlines, 1);
    ctx.restore();
    return onHigh ? "верх" : (selfZ == null ? "" : "низ");
  }

  function drawScaleBar(ctx, W, H, viewM) {
    var barM = niceMetres(W / viewM), barPx = barM * viewM, bx = 8, by = H - 12;
    ctx.strokeStyle = "#e8edf2";
    ctx.fillStyle = "#e8edf2";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 3);
    ctx.lineTo(bx, by + 3);
    ctx.moveTo(bx + barPx, by - 3);
    ctx.lineTo(bx + barPx, by + 3);
    ctx.stroke();
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(barM + " м", bx, by - 5);
  }

  function drawFrame(canvas, f, view, L, motion) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var self = f.self && isFiniteNum(f.self.x) ? f.self : null;
    var pred = self && motion ? predictMotion(motion, self, f.time, Date.now()) : null;
    if (pred) self = movedTo(self, pred.x, pred.y);
    var b = L && L.offscreen && L.bounds, viewM = 1, cx = 0, cy = 0, rot = 0, levelLabel = "";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#141412";
    ctx.fillRect(0, 0, W, H);
    if (b) {
      var zoom = Math.max(0.25, view.zoom || 1);
      viewM = Math.min(W / (b.xmax - b.xmin), H / (b.ymax - b.ymin)) * zoom;
      var follow = self && (view.rotate || (view.follow !== false && zoom > 1.001));
      if (view.rotate && self) {
        var facing = pred ? pred.facing : facingAngle(self);
        if (facing != null) rot = Math.PI / 2 - facing;
      }
      var center = follow ? fitCenter(self, b, W, H, viewM, rot) : { x: (b.xmin + b.xmax) / 2, y: (b.ymin + b.ymax) / 2 };
      cx = center.x;
      cy = center.y;
      try { levelLabel = drawPicture(ctx, L, view, self, W, H, cx, cy, viewM, rot); } catch (eP) {}
    }
    var cosR = Math.cos(rot), sinR = Math.sin(rot);
    var vt = {
      toScreen: function (x, y) {
        if (!b) return { x: W / 2, y: H / 2 };
        var rx = x - cx, ry = y - cy;
        return { x: W / 2 + (rx * cosR - ry * sinR) * viewM, y: H / 2 - (rx * sinR + ry * cosR) * viewM };
      },
      dir: function (dx, dy) {
        return { x: dx * cosR - dy * sinR, y: -(dx * sinR + dy * cosR) };
      }
    };
    var roofs = view.roofs && L && L.roofs;
    var opts = {
      selfZ: self && isFiniteNum(self.z) ? self.z : null,
      heights: !!view.heights,
      health: !!view.health,
      names: !!view.names,
      covered: function (o) { return !!roofs && layers.roofAbove(roofs, o.x, o.y, o.z); }
    };
    try { drawObjectives(ctx, vt.toScreen, W, H, f); } catch (eObj) {}
    try { drawMarks(ctx, vt, W, H, f.marks, false); } catch (eM) {}
    try { drawUnits(ctx, vt, W, H, f.units, opts); } catch (eU) {}
    try { drawMarks(ctx, vt, W, H, f.marks, true); } catch (eMT) {}
    (f.paths || []).forEach(function (path) {
      try { drawPath(ctx, vt.toScreen, path); } catch (eP) {}
    });
    var shellFlying = false, drawNow = Date.now();
    (f.shells || []).forEach(function (sh) {
      try { if (drawShell(ctx, vt.toScreen, sh, drawNow)) shellFlying = true; } catch (eSh) {}
    });
    if (self) try { drawSelf(ctx, vt, self, W, H, viewM, opts); } catch (eSelf) {}
    if (b) drawScaleBar(ctx, W, H, viewM);
    if (rot) drawNorth(ctx, vt, W);
    if (levelLabel) {
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#e8edf2";
      ctx.fillText("этаж: " + levelLabel, W - 70, H - 8);
    }
    return { levelLabel: levelLabel, moving: !!(pred && pred.moving) || shellFlying };
  }

  function createRenderer() {
    var picture = null, mapId = null, motion = createMotion();
    return {
      setMap: function (id, data, options, log) {
        if (!data || !data.collision) return false;
        if (picture && mapId === id) return true;
        layers.configure(options);
        var built = null;
        try { built = layers.build(data, log); } catch (e) { if (log) log("map build error: " + (e && e.message || e)); }
        if (!built) return false;
        picture = built;
        mapId = id;
        return true;
      },
      clear: function () { picture = null; mapId = null; motion = createMotion(); },
      mapId: function () { return mapId; },
      draw: function (canvas, frame, view) {
        return drawFrame(canvas, frame || {}, view || {}, picture, motion);
      }
    };
  }

  root.View.renderer = { create: createRenderer };
})(window);
