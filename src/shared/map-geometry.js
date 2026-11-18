(function (root) {
  "use strict";

  function isFiniteNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function rotateEuler(v, e) {
    if (!v) return v;
    if (!e) return { x: v.x, y: v.y, z: v.z };
    var cx = Math.cos(e.x), sx = Math.sin(e.x);
    var cy = Math.cos(e.y), sy = Math.sin(e.y);
    var cz = Math.cos(e.z), sz = Math.sin(e.z);
    var y1 = v.y * cx - v.z * sx, z1 = v.y * sx + v.z * cx;
    var x2 = v.x * cy + z1 * sy, z2 = -v.x * sy + z1 * cy;
    return { x: x2 * cz - y1 * sz, y: x2 * sz + y1 * cz, z: z2 };
  }

  function add3(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }

  function collectBounds(data) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    function acc(v) {
      if (!v || !isFiniteNum(v.x)) return;
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
    function accBox(b) {
      if (!b || !b.position || !b.size) return acc(b && b.position);
      var hx = Math.abs(b.size.x) / 2, hy = Math.abs(b.size.y) / 2, hz = Math.abs(b.size.z) / 2;
      var sx, sy, sz, c;
      for (sx = -1; sx <= 1; sx += 2)
        for (sy = -1; sy <= 1; sy += 2)
          for (sz = -1; sz <= 1; sz += 2) {
            c = rotateEuler({ x: sx * hx, y: sy * hy, z: sz * hz }, b.rotation);
            acc(add3(b.position, c));
          }
    }
    var i, g, list, item;
    function walkGeom(g) {
      if (!g) return;
      for (i = 0; i < g.boxes.length; i++) accBox(g.boxes[i]);
      for (i = 0; i < g.planes.length; i++) acc(g.planes[i].position);
      for (i = 0; i < g.triangles.length; i++) {
        item = g.triangles[i];
        if (item.world) { acc(item.world[0]); acc(item.world[1]); acc(item.world[2]); }
      }
    }
    walkGeom(data.collision);
    walkGeom(data.collisionOutside);
    for (i = 0; i < data.props.length; i++) acc(data.props[i].position);
    for (i = 0; i < data.spawns.length; i++) acc(data.spawns[i].position);
    for (i = 0; i < data.bases.length; i++) acc(data.bases[i].position);
    if (data.objectives) {
      for (i = 0; i < data.objectives.length; i++) acc(data.objectives[i].position);
    }
    if (!isFinite(minX)) return null;
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
  }

  root.TOC = root.TOC || {};
  root.TOC.geometry = { rotateEuler: rotateEuler, add3: add3, collectBounds: collectBounds, isFiniteNum: isFiniteNum };
})(window);
