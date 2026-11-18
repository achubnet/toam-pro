/*
 * frame = {
 *   me: { x, y, z, heading, hp } | null,         hp: { now, max } | null
 *   ray: { dx, dy, dist } | null,
 *   tanks: [{ x, y, z, side, hd, hp }],            side: ally | enemy | unknown, hd: {x, y} | null
 *   carriers: [{ x, y, side, flagSide, hd, hp }],
 *   bases: [{ x, y, side, taken }],                side: ally | enemy | red | blue | neutral
 *   dropped: [{ x, y, side }],
 *   cps: [{ x, y, letter, live, owner, ring, frac, active }],
 *   aim: { pts: [[x, y], ...], land: [x, y] | null } | null
 * }
 * view = { zoom, follow, drive, health }
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

  function rayDistToRect(px, py, dx, dy, left, right, bottom, top) {
    var tMin = Infinity, t, y, x, eps = 1e-9;
    if (Math.abs(dx) > eps) {
      t = (left - px) / dx;
      if (t > 0) { y = py + t * dy; if (y >= bottom && y <= top && t < tMin) tMin = t; }
      t = (right - px) / dx;
      if (t > 0) { y = py + t * dy; if (y >= bottom && y <= top && t < tMin) tMin = t; }
    }
    if (Math.abs(dy) > eps) {
      t = (bottom - py) / dy;
      if (t > 0) { x = px + t * dx; if (x >= left && x <= right && t < tMin) tMin = t; }
      t = (top - py) / dy;
      if (t > 0) { x = px + t * dx; if (x >= left && x <= right && t < tMin) tMin = t; }
    }
    return isFinite(tMin) ? tMin : 0;
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

  function drawTanks(ctx, toScreen, W, H, tanks, meZ, showHealth) {
    var i, t, p, col, dz;
    ctx.save();
    for (i = 0; i < (tanks || []).length; i++) {
      t = tanks[i];
      p = toScreen(t.x, t.y);
      if (offView(p, W, H, 10)) continue;
      col = sideColor(t.side, SIDE.unknown);
      if (t.hd) {
        drawArrow(ctx, p.x, p.y, t.hd.x, -t.hd.y, col, "rgba(0,0,0,0.85)", 0.85);
      } else {
        ctx.fillStyle = col;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      dz = meZ != null && isFiniteNum(t.z) ? t.z - meZ : 0;
      if (Math.abs(dz) > 4.8) {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        if (dz > 0) { ctx.moveTo(p.x - 3, p.y - 7); ctx.lineTo(p.x + 3, p.y - 7); ctx.lineTo(p.x, p.y - 11); }
        else { ctx.moveTo(p.x - 3, p.y + 7); ctx.lineTo(p.x + 3, p.y + 7); ctx.lineTo(p.x, p.y + 11); }
        ctx.closePath();
        ctx.fill();
      }
      if (showHealth) drawHealth(ctx, p.x + 9, p.y + 8, t.hp);
    }
    ctx.restore();
  }

  function drawCarriers(ctx, toScreen, W, H, carriers, showHealth) {
    var i, c, p, col;
    for (i = 0; i < (carriers || []).length; i++) {
      c = carriers[i];
      p = toScreen(c.x, c.y);
      if (offView(p, W, H, 30)) continue;
      col = sideColor(c.side, SIDE.unknown);
      if (c.hd) {
        drawArrow(ctx, p.x, p.y, c.hd.x, -c.hd.y, col, "rgba(0,0,0,0.85)", 0.95);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 1.5;
        ctx.fill(); ctx.stroke();
      }
      drawBlinkingFlag(ctx, p.x + 6, p.y - 4, sideColor(c.flagSide, SIDE.neutral));
      if (showHealth) drawHealth(ctx, p.x + 9, p.y + 8, c.hp);
    }
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

  function drawFrame(canvas, f, view, L) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var me = f.me && isFiniteNum(f.me.x) ? f.me : null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#141412";
    ctx.fillRect(0, 0, W, H);
    var b = L && L.bounds, off = L && L.offscreen;
    var viewM = 1, cx = 0, cy = 0, metresW, metresH, levelLabel = "", spanX, spanY;
    if (off && b) {
      var zoom = Math.max(0.25, view.zoom || 1);
      spanX = b.xmax - b.xmin; spanY = b.ymax - b.ymin;
      var fit = Math.min(W / spanX, H / spanY);
      viewM = fit * zoom;
      if (view.follow !== false && zoom > 1.001 && me) {
        cx = me.x;
        cy = me.y;
      } else {
        cx = (b.xmin + b.xmax) / 2;
        cy = (b.ymin + b.ymax) / 2;
      }
      metresW = W / viewM;
      metresH = H / viewM;
      var src = layers.worldToPicture(cx - metresW / 2, cy + metresH / 2, b);
      var srcW = metresW * b.scale, srcH = metresH * b.scale;
      try {
        ctx.imageSmoothingEnabled = true;
        var tankZ = me && isFiniteNum(me.z) ? me.z : null;
        var onHigh = tankZ != null && tankZ >= (L.splitZ || 2.4) - 0.35;
        if (view.drive && L.driveCanvas) {
          ctx.drawImage(L.driveCanvas, src.x, src.y, srcW, srcH, 0, 0, W, H);
        } else if (L.layerLow && L.layerHigh) {
          ctx.globalAlpha = onHigh ? 0.35 : 1;
          ctx.drawImage(L.layerLow, src.x, src.y, srcW, srcH, 0, 0, W, H);
          ctx.globalAlpha = onHigh ? 1 : 0.42;
          ctx.drawImage(L.layerHigh, src.x, src.y, srcW, srcH, 0, 0, W, H);
          ctx.globalAlpha = 1;
        } else {
          ctx.drawImage(off, src.x, src.y, srcW, srcH, 0, 0, W, H);
        }
        if (L.outlines) ctx.drawImage(L.outlines, src.x, src.y, srcW, srcH, 0, 0, W, H);
        levelLabel = onHigh ? "верх" : (tankZ == null ? "" : "низ");
      } catch (e2) {
        ctx.globalAlpha = 1;
        ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, W, H);
        if (L.outlines) ctx.drawImage(L.outlines, 0, 0, off.width, off.height, 0, 0, W, H);
        viewM = Math.min(W / spanX, H / spanY);
        cx = (b.xmin + b.xmax) / 2;
        cy = (b.ymin + b.ymax) / 2;
      }
    }
    function toScreen(x, y) {
      if (!b) return { x: W / 2, y: H / 2 };
      return { x: W / 2 + (x - cx) * viewM, y: H / 2 - (y - cy) * viewM };
    }
    try { drawObjectives(ctx, toScreen, W, H, f); } catch (eObj) {}
    try { drawTanks(ctx, toScreen, W, H, f.tanks, me && isFiniteNum(me.z) ? me.z : null, view.health); } catch (eT) {}
    try { drawCarriers(ctx, toScreen, W, H, f.carriers, view.health); } catch (eC) {}
    try { drawAim(ctx, toScreen, f.aim); } catch (eA) {}
    if (me && !isFiniteNum(me.heading)) {
      try {
        var pd = toScreen(me.x, me.y);
        ctx.beginPath();
        ctx.arc(pd.x, pd.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fill();
      } catch (eDot) {}
    }
    if (me && isFiniteNum(me.heading)) try {
      var hx = Math.cos(me.heading), hy = Math.sin(me.heading);
      var p = toScreen(me.x, me.y);
      var ray = f.ray || {};
      var yawX = isFiniteNum(ray.dx) ? ray.dx : hx, yawY = isFiniteNum(ray.dy) ? ray.dy : hy;
      var blen = Math.sqrt(yawX * yawX + yawY * yawY) || 1;
      yawX /= blen; yawY /= blen;
      var rayM = isFiniteNum(ray.dist) && ray.dist > 0 ? ray.dist : null;
      if (rayM == null) {
        var left = cx - (metresW || 0) / 2, right = cx + (metresW || 0) / 2;
        var bottom = cy - (metresH || 0) / 2, top = cy + (metresH || 0) / 2;
        if (!isFinite(left) && b) { left = b.xmin; right = b.xmax; bottom = b.ymin; top = b.ymax; }
        rayM = rayDistToRect(me.x, me.y, yawX, yawY, left, right, bottom, top);
        if (!rayM || rayM < 1) rayM = 200;
      }
      var end = toScreen(me.x + yawX * rayM, me.y + yawY * rayM);
      ctx.strokeStyle = "#ffcc33";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      drawSelfArrow(ctx, p.x, p.y, hx, -hy);
    } catch (eSelf) {}
    if (me && view.health) try {
      var ph = toScreen(me.x, me.y);
      drawHealth(ctx, ph.x + 11, ph.y + 10, me.hp);
    } catch (eHp) {}
    if (b && viewM) {
      var barM = niceMetres((W / viewM));
      var barPx = barM * viewM;
      var bx = 8, by = H - 12;
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
