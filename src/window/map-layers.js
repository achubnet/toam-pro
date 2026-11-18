(function (root) {
  "use strict";

  var geometry = root.TOC.geometry;
  var isFiniteNum = geometry.isFiniteNum;
  var rotateEuler = geometry.rotateEuler;
  var collectBounds = geometry.collectBounds;
  var COS35 = Math.cos(35 * Math.PI / 180);
  var TANK_WIDTH_M = 3.5;
  var ORIENT = { flipX: false, flipY: false, rotate: 0 };

  function setOrientation(o) {
    ORIENT = { flipX: !!(o && o.flipX), flipY: !!(o && o.flipY), rotate: (o && Number(o.rotate)) || 0 };
  }

  function heightFill(z, zmin, zmax) {
    var t = (z - zmin) / Math.max(0.001, zmax - zmin);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return "rgb(" + Math.round(92 + t * 118) + "," + Math.round(90 + t * 108) + "," + Math.round(74 + t * 82) + ")";
  }

  function mapWorldToOff(x, y, b) {
    var rx = x, ry = y;
    if (ORIENT.flipX) rx = b.xmin + b.xmax - rx;
    if (ORIENT.flipY) ry = b.ymin + b.ymax - ry;
    var cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2;
    var rot = (ORIENT.rotate || 0) * Math.PI / 180;
    if (rot) {
      var dx = rx - cx, dy = ry - cy, c = Math.cos(rot), s = Math.sin(rot);
      rx = cx + dx * c - dy * s;
      ry = cy + dx * s + dy * c;
    }
    return { x: (rx - b.xmin) * b.scale, y: (b.ymax - ry) * b.scale };
  }

  function triNormalZ(w) {
      var ax = w[0].x, ay = w[0].y, az = w[0].z || 0;
      var bx = w[1].x, by = w[1].y, bz = w[1].z || 0;
      var cx = w[2].x, cy = w[2].y, cz = w[2].z || 0;
      var nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      var nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      var ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      return nz / nlen;
    }

  function planeCorners(pl) {
    if (!pl || !pl.position) return null;
    var hx = (pl.length || 0) / 2, hy = (pl.width || 0) / 2;
    var e = pl.rotation || { x: 0, y: 0, z: 0 };
    var i, sx, sy, v, signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]], out = [];
    var n = rotateEuler({ x: 0, y: 0, z: 1 }, e);
    if (!n || Math.abs(n.z) < 0.45) return null;
    for (i = 0; i < 4; i++) {
      sx = signs[i][0];
      sy = signs[i][1];
      v = rotateEuler({ x: sx * hx, y: sy * hy, z: 0 }, e);
      out.push({ x: pl.position.x + v.x, y: pl.position.y + v.y, z: pl.position.z + v.z });
    }
    return out;
  }

  function helperBoxName(name) {
    if (!name || typeof name !== "string") return false;
    return /grenade|aiming|foam|smoke/i.test(name);
  }

  function convexHullXY(points) {
    var pts = [], i, j, seen = {};
    for (i = 0; i < points.length; i++) {
      if (!points[i] || !isFiniteNum(points[i].x)) continue;
      j = Math.round(points[i].x * 100) + "," + Math.round(points[i].y * 100);
      if (seen[j]) continue;
      seen[j] = 1;
      pts.push({ x: points[i].x, y: points[i].y });
    }
    pts.sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });
    if (pts.length <= 2) return pts;
    function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lower = [], upper = [];
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function boxZExtent(box) {
    var cs = box && box.corners, zs, i, ze, z;
    if (cs && cs.length >= 2) {
      zs = [];
      for (i = 0; i < cs.length; i++) zs.push(cs[i].z || 0);
      return { ze: Math.max.apply(null, zs) - Math.min.apply(null, zs), z0: Math.min.apply(null, zs), z1: Math.max.apply(null, zs), zavg: zs.reduce(function (a, b) { return a + b; }, 0) / zs.length };
    }
    ze = Math.abs((box && box.size && box.size.z) || 0);
    z = (box && box.position && box.position.z) || 0;
    return { ze: ze, z0: z - ze / 2, z1: z + ze / 2, zavg: z };
  }

  function classifyMapBox(box) {
    if (helperBoxName(box && box.name)) return "skip";
    var sz = box && box.size;
    if (!sz) return "skip";
    var dims = [Math.abs(sz.x || 0), Math.abs(sz.y || 0), Math.abs(sz.z || 0)];
    var maxd = Math.max(dims[0], dims[1], dims[2]);
    var horiz = dims.slice().sort(function (a, b) { return a - b; });
    var foot = horiz[1] * horiz[2];
    var minHoriz = horiz[0];
    if (maxd < 0.4 && foot < 0.25) return "skip";
    var ext = boxZExtent(box);
    var ze = ext.ze;
    if (ze < 0.7 && horiz[2] >= 2) return "slab";
    if (minHoriz >= 1.5 && ze >= 0.7 && foot < 60) return "tall";
    if (ze >= 1.5) return "tall";
    if (ze < 1.2 && horiz[2] >= 2) return "slab";
    if (ze < 2 && foot >= 16) return "slab";
    if (ze <= 0.6) return "slab";
    return "prop";
  }

  function polyAreaXY(pts) {
    if (!pts || pts.length < 3) return 0;
    var s = 0, i, a, b;
    for (i = 0; i < pts.length; i++) {
      a = pts[i];
      b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function projectWallLine(pts) {
    if (!pts || pts.length < 2) return null;
    var best = 0, a = pts[0], b = pts[pts.length - 1], i, j, d;
    for (i = 0; i < pts.length; i++) {
      for (j = i + 1; j < pts.length; j++) {
        d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (d > best) { best = d; a = pts[i]; b = pts[j]; }
      }
    }
    if (best < 0.4) return null;
    return { a: { x: a.x, y: a.y, z: a.z || 0 }, b: { x: b.x, y: b.y, z: b.z || 0 }, len: best };
  }

  function boxCornersOrMake(box) {
    if (box.corners && box.corners.length >= 4) return box.corners;
    if (!box.position || !box.size) return null;
    var hx = Math.abs(box.size.x) / 2, hy = Math.abs(box.size.y) / 2, hz = Math.abs(box.size.z) / 2;
    var rot = box.rotation || { x: 0, y: 0, z: 0 }, pos = box.position, out = [], sx, sy, sz, v;
    for (sx = -1; sx <= 1; sx += 2)
      for (sy = -1; sy <= 1; sy += 2)
        for (sz = -1; sz <= 1; sz += 2) {
          v = rotateEuler({ x: sx * hx, y: sy * hy, z: sz * hz }, rot);
          out.push({ x: pos.x + v.x, y: pos.y + v.y, z: pos.z + v.z });
        }
    return out;
  }

  function planeCornersAny(pl) {
    if (!pl || !pl.position) return null;
    var hx = (pl.length || 0) / 2, hy = (pl.width || 0) / 2;
    var e = pl.rotation || { x: 0, y: 0, z: 0 };
    var n = rotateEuler({ x: 0, y: 0, z: 1 }, e);
    var i, sx, sy, v, signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]], out = [];
    for (i = 0; i < 4; i++) {
      sx = signs[i][0];
      sy = signs[i][1];
      v = rotateEuler({ x: sx * hx, y: sy * hy, z: 0 }, e);
      out.push({ x: pl.position.x + v.x, y: pl.position.y + v.y, z: pl.position.z + v.z });
    }
    return { pts: out, nz: n ? Math.abs(n.z) : 1 };
  }

  function polyAvgZ(pts) {
    var s = 0, i;
    for (i = 0; i < pts.length; i++) s += pts[i].z || 0;
    return s / pts.length;
  }

  function edgeKeyXY(a, b, step) {
    step = step || 0.12;
    function q(p) { return (Math.round(p.x / step)) + "," + (Math.round(p.y / step)); }
    var ka = q(a), kb = q(b);
    return ka < kb ? ka + "|" + kb : kb + "|" + ka;
  }

  function tightWorldBounds(surfaces, fallback) {
    var pts = [], i, j, f, cs;
    function add(p) {
      if (p && isFiniteNum(p.x) && isFiniteNum(p.y)) pts.push(p);
    }
    if (surfaces) {
      for (i = 0; i < (surfaces.floors || []).length; i++) {
        f = surfaces.floors[i].pts || [];
        for (j = 0; j < f.length; j++) add(f[j]);
      }
      for (i = 0; i < (surfaces.tall || []).length; i++) {
        cs = surfaces.tall[i].corners || [];
        for (j = 0; j < cs.length; j++) add(cs[j]);
      }
      for (i = 0; i < (surfaces.props || []).length; i++) {
        cs = surfaces.props[i].corners || [];
        for (j = 0; j < cs.length; j++) add(cs[j]);
      }
      for (i = 0; i < (surfaces.slopes || []).length; i++) {
        f = surfaces.slopes[i].pts || [];
        for (j = 0; j < f.length; j++) add(f[j]);
      }
      for (i = 0; i < (surfaces.walls || []).length; i++) {
        add(surfaces.walls[i].a);
        add(surfaces.walls[i].b);
      }
    }
    if (pts.length < 3) return fallback || null;
    var xs = pts.map(function (p) { return p.x; }).sort(function (a, b) { return a - b; });
    var ys = pts.map(function (p) { return p.y; }).sort(function (a, b) { return a - b; });
    var zs = pts.map(function (p) { return p.z || 0; }).sort(function (a, b) { return a - b; });
    var mx = xs[xs.length >> 1], my = ys[ys.length >> 1];
    var keep = pts.filter(function (p) { return Math.hypot(p.x - mx, p.y - my) < 400; });
    if (keep.length >= 3) {
      xs = keep.map(function (p) { return p.x; }).sort(function (a, b) { return a - b; });
      ys = keep.map(function (p) { return p.y; }).sort(function (a, b) { return a - b; });
      zs = keep.map(function (p) { return p.z || 0; }).sort(function (a, b) { return a - b; });
    }
    return {
      min: { x: xs[0], y: ys[0], z: zs[0] },
      max: { x: xs[xs.length - 1], y: ys[ys.length - 1], z: zs[zs.length - 1] }
    };
  }

  function collectMinimapSurfaces(data) {
    var floors = [], slopes = [], walls = [], tall = [], props = [];
    var stats = {
      boxes: 0, planes: 0, tris: 0,
      floors: 0, slopes: 0, walls: 0, tall: 0, props: 0, slabs: 0, skipped: 0,
      planeFloor: 0, planeSlope: 0, planeWall: 0,
      triFloor: 0, triSlope: 0, triWall: 0
    };
    function addWall(pts) {
      var line = projectWallLine(pts);
      if (line) walls.push(line);
    }
    function addPoly(pts, nz) {
      if (!pts || pts.length < 2) return;
      if (nz >= COS35) {
        floors.push({ pts: pts, z: polyAvgZ(pts), nz: nz });
        return "floor";
      }
      addWall(pts);
      if (nz >= 0.08 && polyAreaXY(pts) >= 0.4) {
        slopes.push({ pts: pts, z: polyAvgZ(pts), nz: nz });
        return "slope";
      }
      return "wall";
    }
    var geom = data && data.collision;
    if (!geom) return { floors: floors, slopes: slopes, walls: walls, tall: tall, props: props, stats: stats };
    var i, t, w, nz, box, kind, cs, rec, pc, ext, cls;
    var tris = geom.triangles || [];
    stats.tris = tris.length;
    for (i = 0; i < tris.length; i++) {
      t = tris[i];
      w = t.world || [t.v0, t.v1, t.v2];
      if (!w || !w[0] || !w[1] || !w[2]) continue;
      nz = Math.abs(triNormalZ(w));
      cls = addPoly(w, nz);
      if (cls === "floor") stats.triFloor++;
      else if (cls === "slope") stats.triSlope++;
      else if (cls === "wall") stats.triWall++;
    }
    var planes = geom.planes || [];
    stats.planes = planes.length;
    for (i = 0; i < planes.length; i++) {
      pc = planeCornersAny(planes[i]);
      if (!pc) continue;
      cls = addPoly(pc.pts, pc.nz);
      if (cls === "floor") stats.planeFloor++;
      else if (cls === "slope") stats.planeSlope++;
      else if (cls === "wall") stats.planeWall++;
    }
    var boxes = geom.boxes || [];
    stats.boxes = boxes.length;
    for (i = 0; i < boxes.length; i++) {
      box = boxes[i];
      kind = classifyMapBox(box);
      cs = boxCornersOrMake(box);
      if (!cs || kind === "skip") { stats.skipped++; continue; }
      ext = boxZExtent(box);
      rec = { corners: cs, ext: ext };
      if (kind === "tall") tall.push(rec);
      else if (kind === "prop") props.push(rec);
      else if (kind === "slab") {
        floors.push({ pts: convexHullXY(cs), z: ext.zavg, nz: 1 });
        stats.slabs++;
      }
    }
    stats.floors = floors.length;
    stats.slopes = slopes.length;
    stats.walls = walls.length;
    stats.tall = tall.length;
    stats.props = props.length;
    return { floors: floors, slopes: slopes, walls: walls, tall: tall, props: props, stats: stats };
  }

  function silhouetteEdges(floors, zfloor) {
    var acc = {}, i, f, n, a, b, k, items, zs, nzs, j, ln;
    for (i = 0; i < floors.length; i++) {
      f = floors[i];
      n = f.pts.length;
      for (j = 0; j < n; j++) {
        a = f.pts[j];
        b = f.pts[(j + 1) % n];
        k = edgeKeyXY(a, b);
        if (!acc[k]) acc[k] = [];
        acc[k].push({ z: f.z, a: a, b: b, nz: f.nz });
      }
    }
    var out = [];
    for (k in acc) {
      if (!acc.hasOwnProperty(k)) continue;
      items = acc[k];
      zs = []; nzs = [];
      for (i = 0; i < items.length; i++) { zs.push(items[i].z); nzs.push(items[i].nz); }
      a = items[0].a; b = items[0].b;
      ln = Math.hypot(a.x - b.x, a.y - b.y);
      if (items.length >= 2) {
        if (Math.max.apply(null, zs) - Math.min.apply(null, zs) >= 1.5 && Math.min.apply(null, nzs) >= 0.85 && ln >= 1.2) {
          out.push({ a: a, b: b, kind: "drop" });
        }
      } else if (items[0].z >= zfloor + 2 && items[0].nz >= 0.9 && ln >= 1.2) {
        out.push({ a: a, b: b, kind: "rim" });
      }
    }
    return out;
  }

  function buildDriveMask(data, surfaces) {
    var bounds = data.bounds || collectBounds(data);
    if (!bounds || !bounds.min) return null;
    var pad = 4;
    var minx = bounds.min.x - pad, miny = bounds.min.y - pad;
    var maxx = bounds.max.x + pad, maxy = bounds.max.y + pad;
    var cell = 1;
    var w = Math.ceil((maxx - minx) / cell), h = Math.ceil((maxy - miny) / cell);
    if (w * h > 800 * 800) {
      cell = Math.max((maxx - minx) / 800, (maxy - miny) / 800);
      w = Math.ceil((maxx - minx) / cell);
      h = Math.ceil((maxy - miny) / cell);
    }
    var n = w * h;
    var height = new Float32Array(n);
    var kind = new Uint8Array(n);
    var blocked = new Uint8Array(n);
    var i;
    for (i = 0; i < n; i++) height[i] = NaN;

    function at(ix, iy) { return iy * w + ix; }

    function fillTri(a, b, c, asWall) {
      var nx = triNormalZ([a, b, c]);
      var nz = Math.abs(nx);
      var minTX = Math.min(a.x, b.x, c.x), maxTX = Math.max(a.x, b.x, c.x);
      var minTY = Math.min(a.y, b.y, c.y), maxTY = Math.max(a.y, b.y, c.y);
      var x0 = Math.floor((minTX - minx) / cell), x1 = Math.ceil((maxTX - minx) / cell);
      var y0 = Math.floor((minTY - miny) / cell), y1 = Math.ceil((maxTY - miny) / cell);
      var area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(area) < 1e-9) return;
      var ix, iy, px, py, w0, w1, w2, z, id, isWall;
      isWall = asWall || nz < COS35;
      for (iy = y0; iy <= y1; iy++) {
        for (ix = x0; ix <= x1; ix++) {
          if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
          px = minx + (ix + 0.5) * cell;
          py = miny + (iy + 0.5) * cell;
          w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
          w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
          w2 = 1 - w0 - w1;
          if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
          z = w0 * a.z + w1 * b.z + w2 * c.z;
          id = at(ix, iy);
          if (isWall) {
            blocked[id] = 1;
            kind[id] = 3;
          } else if (kind[id] !== 3) {
            kind[id] = nz < 0.97 ? 2 : 1;
          }
          if (!isFinite(height[id]) || z > height[id]) height[id] = z;
        }
      }
    }

    function fillPoly(pts, asWall) {
      var j;
      if (!pts || pts.length < 3) return;
      for (j = 1; j < pts.length - 1; j++) fillTri(pts[0], pts[j], pts[j + 1], asWall);
    }

    var floors = surfaces.floors, tall = surfaces.tall, slopes = surfaces.slopes || [];
    for (i = 0; i < floors.length; i++) fillPoly(floors[i].pts, false);
    for (i = 0; i < slopes.length; i++) fillPoly(slopes[i].pts, true);
    for (i = 0; i < tall.length; i++) {
      if (tall[i].ext.ze < 0.5) continue;
      fillPoly(convexHullXY(tall[i].corners), true);
    }

    var rad = Math.ceil((TANK_WIDTH_M / 2) / cell);
    var blocked2 = new Uint8Array(n);
    blocked2.set(blocked);
    var ix, iy, dx, dy, jx, jy;
    for (iy = 0; iy < h; iy++) {
      for (ix = 0; ix < w; ix++) {
        if (!blocked[at(ix, iy)]) continue;
        for (dy = -rad; dy <= rad; dy++) {
          for (dx = -rad; dx <= rad; dx++) {
            if (dx * dx + dy * dy > rad * rad + 0.25) continue;
            jx = ix + dx; jy = iy + dy;
            if (jx >= 0 && jy >= 0 && jx < w && jy < h) blocked2[at(jx, jy)] = 1;
          }
        }
      }
    }

    var walk = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if ((kind[i] === 1 || kind[i] === 2) && !blocked2[i] && isFinite(height[i])) walk[i] = 1;
    }

    var ramps = [], z, zz, zmin, zmax, ox, oy;
    for (iy = 0; iy < h; iy++) {
      for (ix = 0; ix < w; ix++) {
        i = at(ix, iy);
        if (!walk[i] || kind[i] !== 2) continue;
        z = height[i];
        [[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(function (d) {
          jx = ix + d[0]; jy = iy + d[1];
          if (jx < 0 || jy < 0 || jx >= w || jy >= h) return;
          if (!walk[at(jx, jy)]) return;
          zz = height[at(jx, jy)] - z;
          if (zz < 0.45 || zz > 0.7) return;
          zmin = z; zmax = z;
          for (oy = -2; oy <= 2; oy++) {
            for (ox = -2; ox <= 2; ox++) {
              if (ix + ox < 0 || iy + oy < 0 || ix + ox >= w || iy + oy >= h) continue;
              if (!walk[at(ix + ox, iy + oy)]) continue;
              zz = height[at(ix + ox, iy + oy)];
              if (zz < zmin) zmin = zz;
              if (zz > zmax) zmax = zz;
            }
          }
          if (zmax - zmin >= 2.0) ramps.push({ ix: ix, iy: iy, dx: d[0], dy: d[1] });
        });
      }
    }

    return { w: w, h: h, cell: cell, minx: minx, miny: miny, walk: walk, blocked: blocked2, height: height, kind: kind, ramps: ramps, id: null };
  }

  function paintDriveCanvas(mask, bmap, w, h) {
    var cnv = document.createElement("canvas");
    cnv.width = w;
    cnv.height = h;
    var ctx = cnv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!mask) return cnv;
    var cell = mask.cell, ix, iy, i, x0, y0, p0, p1, x2, y2;
    function toOff(x, y) { return mapWorldToOff(x, y, bmap); }
    for (iy = 0; iy < mask.h; iy++) {
      for (ix = 0; ix < mask.w; ix++) {
        i = iy * mask.w + ix;
        x0 = mask.minx + ix * cell;
        y0 = mask.miny + iy * cell;
        p0 = toOff(x0, y0 + cell);
        p1 = toOff(x0 + cell, y0);
        if (mask.walk[i]) ctx.fillStyle = "rgb(210,208,196)";
        else ctx.fillStyle = ((ix + iy) % 3 === 0) ? "rgb(40,40,38)" : "rgb(32,32,30)";
        ctx.fillRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.max(1, Math.abs(p1.x - p0.x)), Math.max(1, Math.abs(p1.y - p0.y)));
      }
    }
    ctx.strokeStyle = "rgb(40,90,200)";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    for (i = 0; i < mask.ramps.length; i++) {
      ix = mask.ramps[i].ix; iy = mask.ramps[i].iy;
      x0 = mask.minx + (ix + 0.5) * cell;
      y0 = mask.miny + (iy + 0.5) * cell;
      x2 = x0 + mask.ramps[i].dx * cell * 0.85;
      y2 = y0 + mask.ramps[i].dy * cell * 0.85;
      p0 = toOff(x0, y0); p1 = toOff(x2, y2);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    return cnv;
  }

  function buildMapLayers(data, log) {
    log = log || function () {};
    if (!data || !data.collision) return false;
    var bounds = data.bounds || collectBounds(data);
    if (!bounds || !bounds.min) return false;
    var surfaces = collectMinimapSurfaces(data);
    var floors = surfaces.floors, tall = surfaces.tall, props = surfaces.props;
    var slopes = surfaces.slopes || [], walls = surfaces.walls || [], surfStats = surfaces.stats || {};
    var tight = tightWorldBounds(surfaces, bounds);
    if (tight && tight.min) bounds = tight;
    var zs = [], i, f;
    for (i = 0; i < floors.length; i++) zs.push(floors[i].z);
    zs.sort(function (a, b) { return a - b; });
    var zmin = zs.length > 10 ? zs[Math.floor(zs.length * 0.02)] : (zs[0] || 0);
    var zmax = zs.length > 10 ? zs[Math.floor(zs.length * 0.92)] : (zs[zs.length - 1] || 8);
    if (zmax - zmin < 1) zmax = zmin + 4;
    var zfloor = zs.length > 10 ? zs[Math.floor(zs.length * 0.15)] : zmin;
    var pad = 5;
    var xmin = bounds.min.x - pad, xmax = bounds.max.x + pad;
    var ymin = bounds.min.y - pad, ymax = bounds.max.y + pad;
    var spanX = Math.max(1, xmax - xmin), spanY = Math.max(1, ymax - ymin);
    var long = Math.max(spanX, spanY);
    var px = 1400;
    var scale = px / long;
    var w = Math.max(32, Math.round(spanX * scale));
    var h = Math.max(32, Math.round(spanY * scale));
    var bmap = { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax, scale: scale };
    var fillC = document.createElement("canvas");
    fillC.width = w; fillC.height = h;
    var ctx = fillC.getContext("2d");
    ctx.fillStyle = "#121210";
    ctx.fillRect(0, 0, w, h);
    floors.sort(function (a, b) { return a.z - b.z; });
    var k, p0, p1, pts;
    for (i = 0; i < floors.length; i++) {
      f = floors[i];
      if (!f.pts || f.pts.length < 3) continue;
      ctx.beginPath();
      p0 = mapWorldToOff(f.pts[0].x, f.pts[0].y, bmap);
      ctx.moveTo(p0.x, p0.y);
      for (k = 1; k < f.pts.length; k++) {
        p1 = mapWorldToOff(f.pts[k].x, f.pts[k].y, bmap);
        ctx.lineTo(p1.x, p1.y);
      }
      ctx.closePath();
      ctx.fillStyle = heightFill(f.z, zmin, zmax);
      ctx.fill();
    }
    for (i = 0; i < props.length; i++) {
      pts = convexHullXY(props[i].corners);
      if (pts.length < 3) continue;
      ctx.beginPath();
      p0 = mapWorldToOff(pts[0].x, pts[0].y, bmap);
      ctx.moveTo(p0.x, p0.y);
      for (k = 1; k < pts.length; k++) {
        p1 = mapWorldToOff(pts[k].x, pts[k].y, bmap);
        ctx.lineTo(p1.x, p1.y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(168,168,160,0.8)";
      ctx.fill();
    }
    function paintHatchPoly(target, pts, fill, hatch) {
      if (!pts || pts.length < 3) return;
      var k, p0, p1, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, xx, yy;
      target.beginPath();
      p0 = mapWorldToOff(pts[0].x, pts[0].y, bmap);
      target.moveTo(p0.x, p0.y);
      minx = maxx = p0.x; miny = maxy = p0.y;
      for (k = 1; k < pts.length; k++) {
        p1 = mapWorldToOff(pts[k].x, pts[k].y, bmap);
        target.lineTo(p1.x, p1.y);
        if (p1.x < minx) minx = p1.x; if (p1.x > maxx) maxx = p1.x;
        if (p1.y < miny) miny = p1.y; if (p1.y > maxy) maxy = p1.y;
      }
      target.closePath();
      target.fillStyle = fill;
      target.fill();
      target.save();
      target.clip();
      target.strokeStyle = hatch;
      target.lineWidth = 1.6;
      var x, span = (maxx - minx) + (maxy - miny) + 8;
      for (x = minx - (maxy - miny); x < maxx + span; x += 7) {
        target.beginPath();
        target.moveTo(x, miny);
        target.lineTo(x + (maxy - miny), maxy);
        target.stroke();
      }
      target.restore();
      target.strokeStyle = "rgba(210,80,20,0.95)";
      target.lineWidth = 1.8;
      target.stroke();
    }
    for (i = 0; i < slopes.length; i++) paintHatchPoly(ctx, slopes[i].pts, "rgba(220,110,30,0.42)", "rgba(255,170,70,0.9)");

    var outC = document.createElement("canvas");
    outC.width = w; outC.height = h;
    var octx = outC.getContext("2d");
    octx.strokeStyle = "#000000";
    octx.lineWidth = 2.75;
    octx.lineJoin = "round";
    octx.lineCap = "round";
    var edges = silhouetteEdges(floors, zfloor), e;
    function strokeSeg(a, b) {
      var qa = mapWorldToOff(a.x, a.y, bmap), qb = mapWorldToOff(b.x, b.y, bmap);
      octx.beginPath();
      octx.moveTo(qa.x, qa.y);
      octx.lineTo(qb.x, qb.y);
      octx.stroke();
    }
    for (i = 0; i < edges.length; i++) strokeSeg(edges[i].a, edges[i].b);
    for (i = 0; i < tall.length; i++) {
      pts = convexHullXY(tall[i].corners);
      if (pts.length < 3) continue;
      octx.beginPath();
      p0 = mapWorldToOff(pts[0].x, pts[0].y, bmap);
      octx.moveTo(p0.x, p0.y);
      for (k = 1; k < pts.length; k++) {
        p1 = mapWorldToOff(pts[k].x, pts[k].y, bmap);
        octx.lineTo(p1.x, p1.y);
      }
      octx.closePath();
      octx.fillStyle = "rgba(0,0,0,0.55)";
      octx.fill();
      octx.stroke();
    }
    octx.strokeStyle = "#000000";
    octx.lineWidth = 3.4;
    octx.lineCap = "round";
    for (i = 0; i < walls.length; i++) strokeSeg(walls[i].a, walls[i].b);
    for (i = 0; i < slopes.length; i++) {
      var sl = projectWallLine(slopes[i].pts);
      if (sl) strokeSeg(sl.a, sl.b);
    }

    var splitZ = 2.4;
    var raised = [];
    for (i = 0; i < floors.length; i++) if (floors[i].z > 0.8) raised.push(floors[i].z);
    raised.sort(function (a, b) { return a - b; });
    if (raised.length) {
      splitZ = raised[Math.min(raised.length - 1, Math.floor(raised.length * 0.55))];
      if (splitZ < 1.6) splitZ = 1.6;
    }
    var lowC = document.createElement("canvas");
    var highC = document.createElement("canvas");
    lowC.width = w; lowC.height = h;
    highC.width = w; highC.height = h;
    var lctx = lowC.getContext("2d");
    var hctx = highC.getContext("2d");
    function paintLayer(target, pred, dashed) {
      var j, item, q0, q1, kk;
      for (j = 0; j < floors.length; j++) {
        item = floors[j];
        if (!pred(item.z) || item.pts.length < 3) continue;
        target.beginPath();
        q0 = mapWorldToOff(item.pts[0].x, item.pts[0].y, bmap);
        target.moveTo(q0.x, q0.y);
        for (kk = 1; kk < item.pts.length; kk++) {
          q1 = mapWorldToOff(item.pts[kk].x, item.pts[kk].y, bmap);
          target.lineTo(q1.x, q1.y);
        }
        target.closePath();
        target.fillStyle = heightFill(item.z, zmin, zmax);
        target.globalAlpha = dashed ? 0.55 : 1;
        target.fill();
        if (dashed) {
          target.setLineDash([6, 5]);
          target.strokeStyle = "rgba(230,220,180,0.85)";
          target.lineWidth = 2;
          target.stroke();
          target.setLineDash([]);
        }
        target.globalAlpha = 1;
      }
    }
    paintLayer(lctx, function (z) { return z < splitZ; }, false);
    paintLayer(hctx, function (z) { return z >= splitZ; }, true);

    var mask = null;
    try { mask = buildDriveMask(data, surfaces); } catch (eD) { mask = null; log("drive mask error: " + (eD && eD.message || eD)); }
    var driveC = null;
    try { driveC = paintDriveCanvas(mask, bmap, w, h); } catch (eD2) { driveC = null; }

    log("map built" +
      " floors=" + floors.length +
      " slopes=" + slopes.length +
      " walls=" + walls.length +
      " tall=" + tall.length +
      " props=" + props.length +
      " slabs=" + (surfStats.slabs || 0) +
      " skip=" + (surfStats.skipped || 0) +
      " planes=" + (surfStats.planeFloor || 0) + "/" + (surfStats.planeSlope || 0) + "/" + (surfStats.planeWall || 0) +
      " tris=" + (surfStats.triFloor || 0) + "/" + (surfStats.triSlope || 0) + "/" + (surfStats.triWall || 0) +
      " edges=" + edges.length + (mask ? " drive=" + mask.w + "x" + mask.h : ""));
    return {
      offscreen: fillC, outlines: outC, driveCanvas: driveC, driveMask: mask,
      layerLow: lowC, layerHigh: highC, splitZ: splitZ, bounds: bmap, scale: scale, stats: surfStats
    };
  }

  root.TOC.layers = { build: buildMapLayers, worldToPicture: mapWorldToOff, setOrientation: setOrientation };
})(window);
