/*
 * frame = {
 *   me: { x, y, z, heading, hp } | null,         hp: { now, max } | null
 *   ray: { dx, dy, dist } | null,
 *   tanks: [{ x, y, z, side, hd, hp }],            side: ally | enemy | unknown, hd: {x, y} | null
 *   carriers: [{ x, y, z, side, flagSide, hd, hp }],
 *   bases: [{ x, y, side, taken }],                side: ally | enemy | red | blue | neutral
 *   dropped: [{ x, y, side }],
 *   cps: [{ x, y, letter, live, owner, ring, frac, active }],
 *   aim: { pts: [[x, y], ...], land: [x, y] | null } | null
 * }
 * view = { zoom, follow, drive, health, heights, roofs, rotate }
 */
(function (root) {
  "use strict";

  var layers = root.TOC.layers;
  var isFiniteNum = root.TOC.geometry.isFiniteNum;

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

  function drawHealth(ctx, x, y, hp) {
    if (!hp || !isFiniteNum(hp.now)) return;
    ctx.save();
    ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(String(hp.now), x, y);
    ctx.fillStyle = healthColor(hp.max > 0 ? hp.now / hp.max : 1);
    ctx.fillText(String(hp.now), x, y);
    ctx.restore();
  }

  function offView(p, W, H, m) {
    return p.x < -m || p.y < -m || p.x > W + m || p.y > H + m;
  }

  function baseColor(side) {
    return side === "neutral" || !SIDE[side] ? "#c9c14a" : SIDE[side];
  }

  function drawBases(ctx, toScreen, W, H, bases) {
    var i, o, p, blinkOn = (Date.now() / 180) % 2 < 1;
    for (i = 0; i < (bases || []).length; i++) {
      o = bases[i];
      p = toScreen(o.x, o.y);
      if (offView(p, W, H, 24)) continue;
      ctx.save();
      if (o.taken) {
        ctx.globalAlpha = blinkOn ? 1 : 0.28;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawFlagIcon(ctx, p.x - 4, p.y + 8, baseColor(o.side), 1, "#ffffff");
      ctx.restore();
    }
  }

  function drawCp(ctx, p, c) {
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
      ctx.fillText(c.letter || "?", p.x, p.y + 0.5);
      return;
    }
    var r = 9, ring = r + 4.5, frac = Math.max(0, Math.min(1, c.frac || 0));
    ctx.globalAlpha = c.active === false ? 0.45 : 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ring, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 5.5;
    ctx.stroke();
    if (frac > 0.005) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      ctx.strokeStyle = sideColor(c.ring, SIDE.neutral);
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
    ctx.fillText(c.letter || "?", p.x, p.y + 0.5);
    ctx.globalAlpha = 1;
  }

  function drawObjectives(ctx, toScreen, W, H, f) {
    var i, p, d;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
    drawBases(ctx, toScreen, W, H, f.bases);
    for (i = 0; i < (f.cps || []).length; i++) {
      p = toScreen(f.cps[i].x, f.cps[i].y);
      if (offView(p, W, H, 20)) continue;
      drawCp(ctx, p, f.cps[i]);
    }
    for (i = 0; i < (f.dropped || []).length; i++) {
      d = f.dropped[i];
      p = toScreen(d.x, d.y);
      if (offView(p, W, H, 20)) continue;
      drawFlagIcon(ctx, p.x - 4, p.y + 8, sideColor(d.side, SIDE.neutral), 1, "#ffd400");
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

  function drawTankMarker(ctx, vt, t, p, col, k) {
    if (t.hd) {
      var d = vt.dir(t.hd.x, t.hd.y);
      drawArrow(ctx, p.x, p.y, d.x, d.y, col, "rgba(0,0,0,0.85)", k);
    } else {
      drawDot(ctx, p.x, p.y, 5 * k / 0.85, col);
    }
  }

  function drawTankExtras(ctx, t, p, o) {
    if (o.heights && o.meZ != null && isFiniteNum(t.z)) drawHeightMark(ctx, p.x, p.y, t.z - o.meZ);
    if (o.health) drawHealth(ctx, p.x + 9, p.y + 8, t.hp);
  }

  function drawTanks(ctx, vt, W, H, tanks, o) {
    var i, t, p;
    ctx.save();
    for (i = 0; i < (tanks || []).length; i++) {
      t = tanks[i];
      p = vt.toScreen(t.x, t.y);
      if (offView(p, W, H, 10)) continue;
      ctx.globalAlpha = o.covered(t) ? COVERED_ALPHA : 1;
      drawTankMarker(ctx, vt, t, p, sideColor(t.side, SIDE.unknown), 0.85);
      ctx.globalAlpha = 1;
      drawTankExtras(ctx, t, p, o);
    }
    ctx.restore();
  }

  function drawCarriers(ctx, vt, W, H, carriers, o) {
    var i, c, p;
    for (i = 0; i < (carriers || []).length; i++) {
      c = carriers[i];
      p = vt.toScreen(c.x, c.y);
      if (offView(p, W, H, 30)) continue;
      ctx.save();
      ctx.globalAlpha = o.covered(c) ? COVERED_ALPHA : 1;
      drawTankMarker(ctx, vt, c, p, sideColor(c.side, SIDE.unknown), 0.95);
      ctx.restore();
      drawBlinkingFlag(ctx, p.x + 6, p.y - 4, sideColor(c.flagSide, SIDE.neutral));
      drawTankExtras(ctx, c, p, o);
    }
  }

  function drawSelf(ctx, vt, f, me, W, H, viewM, o) {
    var p = vt.toScreen(me.x, me.y);
    ctx.save();
    ctx.globalAlpha = o.covered(me) ? COVERED_ALPHA : 1;
    if (!isFiniteNum(me.heading)) {
      drawDot(ctx, p.x, p.y, 6, "#ffffff");
    } else {
      var hx = Math.cos(me.heading), hy = Math.sin(me.heading), ray = f.ray || {};
      var yawX = isFiniteNum(ray.dx) ? ray.dx : hx, yawY = isFiniteNum(ray.dy) ? ray.dy : hy;
      var len = Math.sqrt(yawX * yawX + yawY * yawY) || 1;
      var rayM = isFiniteNum(ray.dist) && ray.dist > 0 ? ray.dist : Math.sqrt(W * W + H * H) / 2 / viewM;
      var end = vt.toScreen(me.x + yawX / len * rayM, me.y + yawY / len * rayM);
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
    if (o.health) drawHealth(ctx, p.x + 11, p.y + 10, me.hp);
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

  function drawAim(ctx, toScreen, aim) {
    if (!aim) return;
    var i, p, pts = aim.pts || [];
    ctx.save();
    ctx.fillStyle = "#ffb000";
    for (i = 0; i < pts.length; i++) {
      p = toScreen(pts[i][0], pts[i][1]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (aim.land) {
      p = toScreen(aim.land[0], aim.land[1]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffb000";
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

  function facingAngle(f, me) {
    var ray = f.ray || {};
    if (isFiniteNum(ray.dx) && isFiniteNum(ray.dy) && (ray.dx || ray.dy)) return Math.atan2(ray.dy, ray.dx);
    return isFiniteNum(me.heading) ? me.heading : null;
  }

  function drawPicture(ctx, L, view, me, W, H, cx, cy, viewM, rot) {
    var b = L.bounds, k = viewM / b.scale, c = layers.worldToPicture(cx, cy, b);
    var reach = Math.sqrt(W * W + H * H) / 2 / k;
    var tankZ = me && isFiniteNum(me.z) ? me.z : null;
    var onHigh = tankZ != null && tankZ >= (L.splitZ || 2.4) - 0.35;
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
    return onHigh ? "верх" : (tankZ == null ? "" : "низ");
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
    var me = f.me && isFiniteNum(f.me.x) ? f.me : null;
    var b = L && L.offscreen && L.bounds, viewM = 1, cx = 0, cy = 0, rot = 0, levelLabel = "";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#141412";
    ctx.fillRect(0, 0, W, H);
    if (b) {
      var zoom = Math.max(0.25, view.zoom || 1);
      viewM = Math.min(W / (b.xmax - b.xmin), H / (b.ymax - b.ymin)) * zoom;
      var follow = me && (view.rotate || (view.follow !== false && zoom > 1.001));
      cx = follow ? me.x : (b.xmin + b.xmax) / 2;
      cy = follow ? me.y : (b.ymin + b.ymax) / 2;
      if (view.rotate && me) {
        var facing = facingAngle(f, me);
        if (facing != null) rot = Math.PI / 2 - facing;
      }
      try { levelLabel = drawPicture(ctx, L, view, me, W, H, cx, cy, viewM, rot); } catch (eP) {}
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
      meZ: me && isFiniteNum(me.z) ? me.z : null,
      heights: !!view.heights,
      health: !!view.health,
      covered: function (o) { return !!roofs && layers.roofAbove(roofs, o.x, o.y, o.z); }
    };
    try { drawObjectives(ctx, vt.toScreen, W, H, f); } catch (eObj) {}
    try { drawTanks(ctx, vt, W, H, f.tanks, opts); } catch (eT) {}
    try { drawCarriers(ctx, vt, W, H, f.carriers, opts); } catch (eC) {}
    try { drawAim(ctx, vt.toScreen, f.aim); } catch (eA) {}
    if (me) try { drawSelf(ctx, vt, f, me, W, H, viewM, opts); } catch (eSelf) {}
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
      setMap: function (id, data, orientation, log) {
        if (!data || !data.collision) return false;
        if (picture && mapId === id) return true;
        layers.setOrientation(orientation);
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

  root.TOC.renderer = { create: createRenderer };
})(window);
