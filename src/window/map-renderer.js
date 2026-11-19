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

  function drawSelfArrow(ctx, x, y, dx, dy) {
    drawArrow(ctx, x, y, dx, dy, "#ffffff", "#000000", 1);
  }

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

  function drawHealth(ctx, x, y, hp) {
    if (!hp || !isFiniteNum(hp.now)) return;
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

  function drawName(ctx, x, y, name, color) {
    ctx.save();
    ctx.font = "7px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(name, x, y);
    ctx.fillStyle = color;
    ctx.fillText(name, x, y);
    ctx.restore();
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

  function drawMarks(ctx, vt, W, H, marks) {
    for (var i = 0; i < (marks || []).length; i++) {
      var m = marks[i], draw = MARK_ICONS[m.icon], p = vt.toScreen(m.x, m.y);
      if (!draw || offView(p, W, H, 10)) continue;
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
    var i, u, p;
    for (i = 0; i < (units || []).length; i++) {
      u = units[i];
      p = vt.toScreen(u.x, u.y);
      if (offView(p, W, H, 30)) continue;
      ctx.save();
      ctx.globalAlpha = o.covered(u) ? COVERED_ALPHA : 1;
      drawUnitMarker(ctx, vt, u, p, sideColor(u.side, SIDE.unknown), u.carrying ? 0.95 : 0.85);
      ctx.restore();
      if (u.carrying) drawBlinkingFlag(ctx, p.x + 6, p.y - 4, sideColor(u.carrying, SIDE.neutral));
      if (o.heights && o.selfZ != null && isFiniteNum(u.z)) drawHeightMark(ctx, p.x, p.y, u.z - o.selfZ);
      if (o.health) drawHealth(ctx, p.x + 9, p.y + 8, u.hp);
      if (o.names && u.name) drawName(ctx, p.x, p.y + (o.health && u.hp ? 22 : 14), u.name, sideColor(u.side, SIDE.unknown));
    }
  }

  function drawSelf(ctx, vt, self, W, H, viewM, o) {
    var p = vt.toScreen(self.x, self.y);
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
      drawSelfArrow(ctx, p.x, p.y, d.x, d.y);
    }
    ctx.restore();
    if (o.health && !self.dead) drawHealth(ctx, p.x + 11, p.y + 8, self.hp);
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

  function drawFrame(canvas, f, view, L) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var self = f.self && isFiniteNum(f.self.x) ? f.self : null;
    var b = L && L.offscreen && L.bounds, viewM = 1, cx = 0, cy = 0, rot = 0, levelLabel = "";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#141412";
    ctx.fillRect(0, 0, W, H);
    if (b) {
      var zoom = Math.max(0.25, view.zoom || 1);
      viewM = Math.min(W / (b.xmax - b.xmin), H / (b.ymax - b.ymin)) * zoom;
      var follow = self && (view.rotate || (view.follow !== false && zoom > 1.001));
      cx = follow ? self.x : (b.xmin + b.xmax) / 2;
      cy = follow ? self.y : (b.ymin + b.ymax) / 2;
      if (view.rotate && self) {
        var facing = facingAngle(self);
        if (facing != null) rot = Math.PI / 2 - facing;
      }
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
    try { drawMarks(ctx, vt, W, H, f.marks); } catch (eM) {}
    try { drawUnits(ctx, vt, W, H, f.units, opts); } catch (eU) {}
    (f.paths || []).forEach(function (path) {
      try { drawPath(ctx, vt.toScreen, path); } catch (eP) {}
    });
    if (self) try { drawSelf(ctx, vt, self, W, H, viewM, opts); } catch (eSelf) {}
    if (b) drawScaleBar(ctx, W, H, viewM);
    if (rot) drawNorth(ctx, vt, W);
    if (levelLabel) {
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#e8edf2";
      ctx.fillText("этаж: " + levelLabel, W - 70, H - 8);
    }
    return { levelLabel: levelLabel };
  }

  function createRenderer() {
    var picture = null, mapId = null;
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
      clear: function () { picture = null; mapId = null; },
      mapId: function () { return mapId; },
      draw: function (canvas, frame, view) {
        return drawFrame(canvas, frame || {}, view || {}, picture);
      }
    };
  }

  root.View.renderer = { create: createRenderer };
})(window);
