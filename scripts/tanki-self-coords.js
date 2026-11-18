/**
 *
 *   toCoords.me()        → { x, y, z, heading, headingDeg, ready }  // metres
 *   toCoords.speed()     → { kmh, mps, ready, source }
 *   toCoords.ahead()     → { hull:{type,name,dist}, barrel:{type,name,dist} }
 *   toCoords.rayDebug()  → raw hull+barrel rays (no other players' data)
 *   toCoords.status()    → hooks / why something is empty
 *   toCoords.exportMap() → downloads tanki-map-<name>.json (static geometry only)
 *   toCoords.minimap(true|false|{zoom,follow,flipX,flipY,rotate})
 *   toCoords.pickMapFolder() / grantMapFolder() / loadMapFile() / saveMap(force)
 *   toCoords.scan() / debug() / stop()
 *   Hotkey M toggles the in-game minimap.
 *
 * Open map-view.html and load the JSON for a top-down map and A* route.
 * Maps are cached in the chosen folder (and IndexedDB) and reused next battle.
 *
 * Engine units are centimetres. The game itself shows speed as 0.01 * units/s
 * (m/s). Positions like (7871, -7483, 78) are ~79 m, -75 m, 0.78 m.
 * Hull ray is horizontal (static only). Barrel/дуло ray follows the local
 * weapon muzzle direction in 3D (including elevation), never an aim-target
 * or another player. Tank hits are ignored (static behind, or nothing).
 * Distances in metres (engine units × 0.01, once).
 */
(function () {
  "use strict";

  if (window.toCoords && typeof window.toCoords.stop === "function") {
    try { window.toCoords.stop(); } catch (e) {}
  }

  // Kill-switches to isolate side effects on the game (bisect shooting bugs).
  // localStorage "toCoords.off" = comma list; read once at document_start.
  //   cn        Function.prototype.callableName + Object.defineProperty hooks
  //   listeners EventTarget.addEventListener wrapper
  //   wrapPoint wrapping the game's initPoint / initNewStylePoint callbacks
  //   pos       calling the game's getLocalTankPosition / isLocalTankAlive
  //   scan      heap scans (map, radar, muzzle discovery)
  //   camera    parkour camera distance (Shift + / -)
  //   trees     hiding trees / bushes in parkour
  //   all       everything above
  var OFF_KEYS = ["cn", "listeners", "wrapPoint", "pos", "scan", "camera", "trees"];
  var OFF = {};
  try {
    (localStorage.getItem("toCoords.off") || "").split(/[\s,]+/).forEach(function (k) {
      if (k === "all") OFF_KEYS.forEach(function (x) { OFF[x] = true; });
      else if (OFF_KEYS.indexOf(k) >= 0) OFF[k] = true;
    });
  } catch (eOff) {}
  function offList() { return OFF_KEYS.filter(function (k) { return OFF[k]; }); }
  if (offList().length) {
    try { console.log("[toCoords] выключено (toCoords.off): " + offList().join(", ")); } catch (eOffLog) {}
  }

  var OVERLAY_ID = "to-coords-overlay";
  // Official tank-velocity overlay: display = 0.01 * engineSpeed.
  var UNIT = 0.01;
  var RAY_MAX_M = 100;
  var RAY_MAX = RAY_MAX_M / UNIT;
  var ORIGIN_UP = 1.0 / UNIT;   // 1 m above hull origin
  var ORIGIN_FWD = 0.8 / UNIT;  // 80 cm along the ray, just outside the hull
  var MIN_HIT_M = 3;
  var MIN_HIT = MIN_HIT_M / UNIT; // ignore own hull / ground under the tank
  var MOUNT_MATCH_M = 5;
  var MOUNT_MATCH = MOUNT_MATCH_M / UNIT;
  var SPEED_WINDOW_MS = 500;
  var MAX_MPS = 40; // reject outliers (tanks are ~3–15 m/s)
  var RAY_INTERVAL_MS = 250;
  var INTERESTING = {
    getLocalTankPosition: 1,
    isLocalTankAlive: 1,
    showPositionLocalTank: 1,
    fillPhysicsState: 1,
    setPhysicsTransform: 1,
    updatePhysicsState: 1,
    onTankPositionQuery: 1,
    onLocalTankFirstSpawn: 1,
    onTankPossessed: 1,
    onSpawn: 1,
    updateInput: 1,
    initPoint: 1,
    initNewStylePoint: 1
  };

  var hooks = {
    getLocalTankPosition: null,
    isLocalTankAlive: null,
    showPositionLocalTank: null,
    fillPhysicsState: null,
    physicsBody: null,
    physicsWorld: null,
    camera: null,
    battleMap: null,
    mapName: null,
    radarSystem: null
  };
  var radarScanRuns = 0;
  var RADAR_SCAN_MAX_RUNS = 360; // ~90 s of light scanning per battle
  var bodyCandidates = [];
  var mountCandidates = [];
  var foundCallables = {};
  var scanStats = { runs: 0, visited: 0, lastMs: 0, lastError: null };
  var lastMeEngine = null; // engine units
  var lastMe = null;       // metres, for API/overlay
  var lastQuat = null;
  var lastHeading = null;
  var lastHeadingSource = null;
  var lastSource = null;
  var lastPosRef = null;   // real Vector3, for cloning ray origin/dir
  var running = true;
  var rafId = 0;
  var overlay = null;
  var debugOn = false;
  var debugLog = [];
  try {
    var _prevLog = JSON.parse(localStorage.getItem("toCoords.debugLog") || "[]");
    if (_prevLog && _prevLog.length) debugLog = _prevLog.slice(-200);
  } catch (eLog0) {}
  var startedAt = Date.now();
  window.__toCoordsT0 = performance.now();
  var nextScanAt = 0;
  var nextMountScanAt = 0;
  var nextRayAt = 0;
  var lastAhead = {
    hull: { type: null, name: null, dist: null },
    barrel: { type: null, name: null, dist: null }
  };
  var lastBarrelSource = null;
  var lastRayError = null;
  var lastRayDebug = null;
  var speedSamples = [];
  var speedState = {
    mps: null,
    kmh: null,
    source: null
  };

  var logKinds = {};
  var logSaveTimer = 0;
  function persistDebugLog() {
    logSaveTimer = 0;
    try { localStorage.setItem("toCoords.debugLog", JSON.stringify(debugLog.slice(-250))); } catch (e) {}
  }
  function logDebug(msg) {
    msg = String(msg);
    // Same kind of message (digits ignored) at most once per 2 s; console only for the first 3 of a kind unless debug is on.
    var kind = msg.replace(/[-\d.]+/g, "#").slice(0, 60);
    var now = Date.now();
    var k = logKinds[kind] || (logKinds[kind] = { n: 0, at: 0, dropped: 0 });
    if (now - k.at < 2000) { k.dropped++; return; }
    k.n++;
    k.at = now;
    var line = new Date(now).toISOString() + " " + msg + (k.dropped ? " (+" + k.dropped + " skipped)" : "");
    k.dropped = 0;
    if (debugLog.length >= 250) debugLog.shift();
    debugLog.push(line);
    if (debugOn || k.n <= 3) {
      try { console.log("[toCoords]", line); } catch (e0) {}
    }
    try {
      if (!logSaveTimer) logSaveTimer = setTimeout(persistDebugLog, 3000);
    } catch (e2) {}
  }

  // callableName hook, v2. The game tags some functions (fn.callableName = "x").
  // The first such assignment becomes an ordinary own data property — exactly
  // what the game gets without us — and only functions we care about are queued.
  // Nothing of ours runs inside the game's code; the queue is read in our frame.
  var cnQueue = [];
  function installCallableNameHook() {
    if (Function.prototype.__toCoordsCN) {
      logDebug("callableName hook already present");
      return;
    }
    var dp = Object.defineProperty;
    var has = Object.prototype.hasOwnProperty;
    try {
      dp(Function.prototype, "callableName", {
        configurable: true,
        enumerable: false,
        get: function () { return undefined; },
        set: function (v) {
          try { dp(this, "callableName", { value: v, writable: true, enumerable: true, configurable: true }); } catch (e) {}
          if (typeof v === "string" && has.call(INTERESTING, v) && cnQueue.length < 500) cnQueue.push(this);
        }
      });
      dp(Function.prototype, "__toCoordsCN", { value: true });
      logDebug("callableName hook v2 installed");
    } catch (e) {
      logDebug("callableName hook failed: " + (e && e.message || e));
    }
  }
  function drainCallableQueue() {
    var n = 0;
    while (cnQueue.length && n++ < 100) {
      try { recordCallable(cnQueue.shift()); } catch (e) {}
    }
  }
  if (!OFF.cn) installCallableNameHook();
  logDebug("session start hooks=" + (hooks.getLocalTankPosition ? "pos" : "no-pos"));

  function isVec3String(s) {
    return typeof s === "string" && s.indexOf("Vector3 (") === 0;
  }
  function isQuatString(s) {
    return typeof s === "string" && s.indexOf("Quaternion(") === 0;
  }
  function isFiniteNum(v) {
    return typeof v === "number" && isFinite(v);
  }
  function toM(n) { return n * UNIT; }
  function radToDeg(r) {
    return r == null ? null : (r * 180) / Math.PI;
  }
  function safeCall(fn, args) {
    try { return fn.apply(null, args || []); }
    catch (e) { return { __error: e }; }
  }

  function parseVector3(obj) {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return null;
    var s;
    try { s = obj.toString(); } catch (e) { s = ""; }
    if (isVec3String(s)) {
      var m = /^Vector3 \((.+), (.+), (.+)\)$/.exec(s);
      if (!m) return null;
      var x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
      return { x: x, y: y, z: z, ref: obj };
    }
    if (isFiniteNum(obj.f20_1) && isFiniteNum(obj.g20_1) && isFiniteNum(obj.h20_1)) {
      return { x: obj.f20_1, y: obj.g20_1, z: obj.h20_1, ref: obj };
    }
    return null;
  }

  function parseQuaternion(obj) {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return null;
    var w, x, y, z;
    if (isFiniteNum(obj.i23_1) && isFiniteNum(obj.j23_1) && isFiniteNum(obj.k23_1) && isFiniteNum(obj.l23_1)) {
      w = obj.i23_1; x = obj.j23_1; y = obj.k23_1; z = obj.l23_1;
    } else {
      var s;
      try { s = obj.toString(); } catch (e) { return null; }
      if (!isQuatString(s)) return null;
      var m = /^Quaternion\((.+), (.+), (.+), (.+)\)$/.exec(s);
      if (!m) return null;
      w = Number(m[1]); x = Number(m[2]); y = Number(m[3]); z = Number(m[4]);
    }
    if (![w, x, y, z].every(isFinite)) return null;
    return { w: w, x: x, y: y, z: z, ref: obj };
  }

  function quatToHeading(q) {
    var f = quatForwardXY(q);
    if (!f) return null;
    return Math.atan2(f.y, f.x);
  }

  function bodyAngularAbs(body) {
    try {
      var w = body && body.v9i_1 && body.v9i_1.h9j_1;
      if (!w) return 0;
      if (isFiniteNum(w.h20_1)) {
        return Math.sqrt((w.f20_1 || 0) * (w.f20_1 || 0) + (w.g20_1 || 0) * (w.g20_1 || 0) + (w.h20_1 || 0) * (w.h20_1 || 0));
      }
      if (isFiniteNum(w.z) || isFiniteNum(w.x)) {
        return Math.sqrt((w.x || 0) * (w.x || 0) + (w.y || 0) * (w.y || 0) + (w.z || 0) * (w.z || 0));
      }
    } catch (e) {}
    return 0;
  }

  function bodyHeadingInfo(body) {
    try {
      if (!body || !body.v9i_1) return null;
      var q = parseQuaternion(body.v9i_1.g9j_1);
      if (!q) return null;
      var f = quatForwardXY(q);
      if (!f) return null;
      return {
        body: body,
        quat: q,
        heading: Math.atan2(f.y, f.x),
        forward: f,
        ang: bodyAngularAbs(body),
        vel: parseVector3(body.v9i_1.f9j_1)
      };
    } catch (e) { return null; }
  }

  // Bodies to look for our hull in: scanned candidates + every body of every
  // physics world we know (a battle can have several). Refreshed 4x a second.
  var hullPoolCache = [], hullPoolAt = 0;
  function hullPool() {
    var now = performance.now();
    if (now - hullPoolAt < 250) return hullPoolCache;
    hullPoolAt = now;
    var out = bodyCandidates.slice(), seen = new Set(out), worlds = worldCandidates.slice(), i, j, list;
    if (hooks.physicsWorld && worlds.indexOf(hooks.physicsWorld) < 0) worlds.push(hooks.physicsWorld);
    for (i = 0; i < worlds.length; i++) {
      try { list = bodiesOfWorld(worlds[i]); } catch (e) { list = []; }
      for (j = 0; j < list.length && out.length < 600; j++) {
        if (!seen.has(list[j])) { seen.add(list[j]); out.push(list[j]); }
      }
    }
    hullPoolCache = out;
    return out;
  }

  function pickLocalHull(enginePos) {
    var nearby = [], i, p, d, info, pool = hullPool();
    if (enginePos) {
      for (i = 0; i < pool.length; i++) {
        p = bodyPos(pool[i]);
        if (!p) continue;
        d = Math.abs(p.x - enginePos.x) + Math.abs(p.y - enginePos.y) + Math.abs(p.z - enginePos.z);
        if (d > 400) continue;
        info = bodyHeadingInfo(pool[i]);
        if (!info) continue;
        info.dist = d;
        nearby.push(info);
      }
    }
    if (!nearby.length) {
      var matched = matchLocalBody(enginePos);
      return matched ? bodyHeadingInfo(matched) : null;
    }
    // Nearest body is our hull. Keep the previous one while it is still close,
    // so the marker never jumps to an ally / bonus box passing by.
    nearby.sort(function (a, b) { return a.dist - b.dist; });
    for (i = 0; i < nearby.length; i++) {
      if (nearby[i].body === hooks.physicsBody && nearby[i].dist <= nearby[0].dist + 60) {
        var keep = nearby[i];
        nearby.splice(i, 1);
        nearby.unshift(keep);
        break;
      }
    }
    hooks.physicsBody = nearby[0].body;
    try {
      if (nearby[0].body.b9i_1 && nearby[0].body.b9i_1.zz0_1 && typeof nearby[0].body.b9i_1.zz0_1.z9l === "function") {
        hooks.physicsWorld = nearby[0].body.b9i_1.zz0_1;
        attachCameraFromWorld(hooks.physicsWorld);
      }
    } catch (e) {}
    return nearby[0];
  }

  function headingFromVelocity(vel) {
    if (!vel || !isFiniteNum(vel.x) || !isFiniteNum(vel.y)) return null;
    if (vel.x * vel.x + vel.y * vel.y < 2500) return null;
    return Math.atan2(vel.y, vel.x);
  }

  // Hull forward = local +Y, as in the game (barrel dir = mount matrix * (0,1,0)).
  // Never switch to the X axis: on a slope that turned the marker sideways.
  function quatForwardXY(q) {
    if (!q) return null;
    var w = q.w, x = q.x, y = q.y, z = q.z;
    var fx = 2 * (x * y - w * z);       // local Y axis in world
    var fy = 1 - 2 * (x * x + z * z);
    var fz = 2 * (y * z + w * x);
    var len = Math.sqrt(fx * fx + fy * fy);
    if (len < 0.15) {
      // Nose straight up/down: the local up axis (Z) points back/forward.
      var zx = 2 * (x * z + w * y), zy = 2 * (y * z - w * x);
      var sgn = fz > 0 ? -1 : 1;
      fx = sgn * zx; fy = sgn * zy;
      len = Math.sqrt(fx * fx + fy * fy);
    }
    if (len < 1e-5) return null;
    return { x: fx / len, y: fy / len, z: 0 };
  }

  function headingFromDelta(a, b) {
    if (!a || !b) return null;
    var dx = b.x - a.x, dy = b.y - a.y;
    if (dx * dx + dy * dy < 25) return null; // < 5 cm, ignore
    return Math.atan2(dy, dx);
  }

  function readPositionFromHook() {
    // Own tank body via the follow camera (camera.lzs_1 = our tank physics,
    // .mzq_1 / fbk() = body). Works in battles where the mine system never
    // created getLocalTankPosition (no supplies), and reads only our own tank.
    var own = ownBodyFromCamera();
    if (!OFF.pos && own && own.v9i_1) {
      var ov = parseVector3(own.v9i_1.i9j_1);
      if (ov) {
        lastSource = "followCamera.body";
        lastPosRef = ov.ref || lastPosRef;
        ov._quat = parseQuaternion(own.v9i_1.g9j_1);
        ov._vel = parseVector3(own.v9i_1.f9j_1);
        return ov;
      }
    }
    if (!OFF.pos && typeof hooks.getLocalTankPosition === "function") {
      var r = safeCall(hooks.getLocalTankPosition);
      if (r && !r.__error) {
        var v = parseVector3(r);
        if (v) {
          lastSource = "getLocalTankPosition";
          lastPosRef = v.ref || lastPosRef;
          return v;
        }
      }
    }
    if (!OFF.pos && typeof hooks.showPositionLocalTank === "function") {
      var captured = null;
      var fake = {
        z2i: function (msg) { captured = msg; },
        toString: function () { return "toCoordsConsole"; }
      };
      var sr = safeCall(hooks.showPositionLocalTank, [fake]);
      if (!sr || !sr.__error && typeof captured === "string") {
        var m = /Vector3 \((.+), (.+), (.+)\)/.exec(captured || "");
        if (m) {
          lastSource = "showPositionLocalTank";
          return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), ref: null };
        }
      }
    }
    var matched = matchLocalBody(lastMeEngine);
    if (matched && matched.v9i_1) {
      var pv = parseVector3(matched.v9i_1.i9j_1);
      if (pv) {
        lastSource = "physicsBody.v9i_1";
        lastPosRef = pv.ref || lastPosRef;
        pv._quat = parseQuaternion(matched.v9i_1.g9j_1);
        pv._vel = parseVector3(matched.v9i_1.f9j_1);
        return pv;
      }
    }
    return null;
  }

  function ownBodyFromCamera() {
    try {
      var tp = followCam && followCam.lzs_1;
      if (!tp) return null;
      var b = tp.mzq_1 || (typeof tp.fbk === "function" ? tp.fbk() : null);
      return b && b.v9i_1 ? b : null;
    } catch (e) { return null; }
  }

  function isLocalAlive() {
    if (OFF.pos || typeof hooks.isLocalTankAlive !== "function") return null;
    var r = safeCall(hooks.isLocalTankAlive);
    if (r && r.__error) return null;
    return !!r;
  }

  /* ---------- match the local tank's physics body ---------- */

  function bodyPos(body) {
    try {
      if (!body || !body.v9i_1) return null;
      return parseVector3(body.v9i_1.i9j_1);
    } catch (e) { return null; }
  }

  function matchLocalBody(enginePos) {
    if (!enginePos) return hooks.physicsBody;
    var best = null, bestD = 1e15, i, p, d;
    for (i = 0; i < bodyCandidates.length; i++) {
      p = bodyPos(bodyCandidates[i]);
      if (!p) continue;
      d = Math.abs(p.x - enginePos.x) + Math.abs(p.y - enginePos.y) + Math.abs(p.z - enginePos.z);
      if (d < bestD) { bestD = d; best = bodyCandidates[i]; }
    }
    // 3 m tolerance (300 engine units)
    if (best && bestD < 300) {
      hooks.physicsBody = best;
      try {
        if (best.b9i_1 && best.b9i_1.zz0_1 && typeof best.b9i_1.zz0_1.z9l === "function") {
          hooks.physicsWorld = best.b9i_1.zz0_1;
          attachCameraFromWorld(hooks.physicsWorld);
        }
      } catch (e) {}
      return best;
    }
    return hooks.physicsBody;
  }

  function readBodyVelMps(body) {
    try {
      if (!body || !body.v9i_1) return null;
      var v = parseVector3(body.v9i_1.f9j_1);
      if (!v) return null;
      return Math.sqrt(v.x * v.x + v.y * v.y) * UNIT;
    } catch (e) { return null; }
  }

  /* ---------- speed: body velocity preferred, else 0.5s window ---------- */

  function updateSpeed(enginePos, now, body) {
    var bodyMps = readBodyVelMps(body);
    if (bodyMps != null && bodyMps <= MAX_MPS) {
      var a = 0.35;
      if (speedState.source !== "bodyVel" || speedState.mps == null) speedState.mps = bodyMps;
      else speedState.mps = speedState.mps * (1 - a) + bodyMps * a;
      if (speedState.mps < 0.15) speedState.mps = 0;
      speedState.kmh = speedState.mps * 3.6;
      speedState.source = "bodyVel";
    }

    speedSamples.push({ t: now, x: enginePos.x, y: enginePos.y });
    var cutoff = now - SPEED_WINDOW_MS;
    while (speedSamples.length > 2 && speedSamples[0].t < cutoff) speedSamples.shift();

    if (bodyMps != null && bodyMps <= MAX_MPS) return;

    if (speedSamples.length < 2) return;
    var first = speedSamples[0], last = speedSamples[speedSamples.length - 1];
    var dt = (last.t - first.t) / 1000;
    if (dt < 0.2) return;
    // reject a window that contains a huge jump (respawn / interpolation)
    var i, d, inst, prev = first, worst = 0;
    for (i = 1; i < speedSamples.length; i++) {
      d = Math.hypot(speedSamples[i].x - prev.x, speedSamples[i].y - prev.y) * UNIT;
      inst = d / Math.max(0.001, (speedSamples[i].t - prev.t) / 1000);
      if (inst > worst) worst = inst;
      prev = speedSamples[i];
    }
    if (worst > MAX_MPS) return;
    var distM = Math.hypot(last.x - first.x, last.y - first.y) * UNIT;
    var mps = distM / dt;
    if (mps > MAX_MPS) return;
    if (speedState.mps == null || speedState.source !== "window") speedState.mps = mps;
    else speedState.mps = speedState.mps * 0.5 + mps * 0.5;
    if (speedState.mps < 0.15) speedState.mps = 0;
    speedState.kmh = speedState.mps * 3.6;
    speedState.source = "window";
  }

  /* ---------- static-only raycast ---------- */

  var TANKISH_NAME = /hull|turret|chassis|tank|cannon|weapon|barrel/i;

  // Game's own static filter: only bodies with no ECS world link (b9i_1).
  // Do not also require missing v9i_1 — static props can still have a transform.
  function staticOnlyFilter(body) {
    try {
      if (!body) return false;
      if (body.b9i_1 != null) return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  var STATIC_FILTER = { m9r: staticOnlyFilter };
  // When false, never call the game's physics raycast (b9m/z9l); use our own JS ray on map geometry.
  var engineRaysOn = false;
  try { if (localStorage.getItem("toCoords.engineRays") === "1") engineRaysOn = true; } catch (eER) {}

  function looksLikeName(s) {
    return typeof s === "string" && s.length >= 2 && s.length < 80 &&
      /[A-Za-zА-Яа-я_]/.test(s) &&
      !/^(true|false|null|undefined)$/i.test(s);
  }

  function nameFromValue(v) {
    if (looksLikeName(v) && !TANKISH_NAME.test(v)) return v;
    if (!v || (typeof v !== "object" && typeof v !== "function")) return null;
    var s;
    try { s = String(v); } catch (e) { return null; }
    var m = /Prop\(name=([^,)]+)/.exec(s) ||
      /propName=([^,)]+)/.exec(s) ||
      /groupName=([^,)]+)/.exec(s);
    if (m && looksLikeName(m[1]) && m[1] !== "null" && !TANKISH_NAME.test(m[1])) return m[1];
    return null;
  }

  function nameFromHit(shape) {
    if (!shape) return null;
    var body = null;
    try { body = shape.r9j_1 || null; } catch (e) { body = null; }
    var cands = [];
    try { cands.push(nameFromValue(shape.n9j_1), nameFromValue(shape.q9j_1)); } catch (e) {}
    if (body) {
      try { cands.push(nameFromValue(body.n9j_1), nameFromValue(body.q9j_1), nameFromValue(body)); } catch (e) {}
    }
    for (var i = 0; i < cands.length; i++) if (cands[i]) return cands[i];
    return null;
  }

  function isTankishHit(hit) {
    try {
      var shape = hit && hit.i9q_1;
      if (!shape) return false;
      var body = shape.r9j_1 || null;
      if (body && body.b9i_1 != null) return true;
      var raw = [];
      try { raw.push(shape.n9j_1, shape.q9j_1); } catch (e) {}
      if (body) {
        try { raw.push(body.n9j_1, body.q9j_1); } catch (e) {}
      }
      for (var i = 0; i < raw.length; i++) {
        if (typeof raw[i] === "string" && TANKISH_NAME.test(raw[i])) return true;
      }
      return false;
    } catch (e) {
      return true;
    }
  }

  function classifyHit(normalZ, name) {
    var type, az = Math.abs(normalZ);
    if (az > 0.7) type = "пол/склон";
    else type = "стена";
    return { type: type, name: name || null };
  }

  function makeGameVec(x, y, z) {
    var v = null;
    if (lastPosRef && typeof lastPosRef.d21 === "function") {
      try { v = lastPosRef.d21(); } catch (e) { v = null; }
    }
    if (v && isFiniteNum(v.f20_1)) {
      v.f20_1 = x; v.g20_1 = y; v.h20_1 = z;
      if (typeof v.n23 === "function") {
        try { v.n23(x, y, z); } catch (e) {}
      }
      return v;
    }
    return { f20_1: x, g20_1: y, h20_1: z };
  }

  function makeHitResult() {
    var normal = {
      f20_1: 0, g20_1: 0, h20_1: 0,
      n23: function (x, y, z) { this.f20_1 = x; this.g20_1 = y; this.h20_1 = z; },
      k26: function (o) {
        if (!o) return;
        this.f20_1 = o.f20_1; this.g20_1 = o.g20_1; this.h20_1 = o.h20_1;
      }
    };
    var point = {
      f20_1: 0, g20_1: 0, h20_1: 0,
      u27: function (origin, dist, dir) {
        this.f20_1 = origin.f20_1 + dist * dir.f20_1;
        this.g20_1 = origin.g20_1 + dist * dir.g20_1;
        this.h20_1 = origin.h20_1 + dist * dir.h20_1;
      }
    };
    return {
      l9q_1: 0,
      i9q_1: null,
      k9q_1: normal,
      j9q_1: point,
      m9q_1: 0,
      o9q_1: 0,
      p9q_1: 0,
      n9q_1: 0,
      h9s: function (o) {
        if (!o) return;
        this.l9q_1 = o.l9q_1;
        this.i9q_1 = o.i9q_1;
        this.m9q_1 = o.m9q_1;
        if (o.k9q_1) this.k9q_1.k26(o.k9q_1);
        if (o.j9q_1) {
          this.j9q_1.f20_1 = o.j9q_1.f20_1;
          this.j9q_1.g20_1 = o.j9q_1.g20_1;
          this.j9q_1.h20_1 = o.j9q_1.h20_1;
        }
      },
      d3: function () {},
      d21: function () { return this; }
    };
  }

  function horizontalDir(x, y) {
    var len = Math.sqrt(x * x + y * y);
    if (!isFinite(len) || len < 1e-5) return null;
    return { x: x / len, y: y / len, z: 0 };
  }

  function normalizeDir(x, y, z) {
    var len = Math.sqrt(x * x + y * y + z * z);
    if (!isFinite(len) || len < 1e-5) return null;
    return { x: x / len, y: y / len, z: z / len };
  }

  function hullForward(engineMe) {
    var f = quatForwardXY(lastQuat);
    if (f) return f;
    if (engineMe && engineMe.heading != null) {
      return { x: Math.cos(engineMe.heading), y: Math.sin(engineMe.heading), z: 0 };
    }
    return null;
  }

  function attachCameraFromWorld(world) {
    try {
      var cam = world && world.yyw_1;
      if (cam && cam.u35_1 && isFiniteNum(cam.u35_1.h20_1)) {
        hooks.camera = cam;
      }
    } catch (e) {}
  }

  // Follow-cam pitch looks down at the tank, not along the barrel — yaw only.
  function dirFromCamera() {
    var cam = hooks.camera;
    if (!cam) {
      attachCameraFromWorld(hooks.physicsWorld);
      cam = hooks.camera;
    }
    if (!cam || !cam.u35_1) return null;
    var yaw = cam.u35_1.h20_1;
    if (!isFiniteNum(yaw)) return null;
    return { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 };
  }

  function looksLikeMuzzleSocket(s) {
    try {
      return !!(s && s.tzk_1 && isFiniteNum(s.tzk_1.f20_1) &&
        s.wzk_1 && isFiniteNum(s.wzk_1.f20_1) && isFiniteNum(s.wzk_1.g20_1) &&
        isFiniteNum(s.wzk_1.h20_1));
    } catch (e) {
      return false;
    }
  }

  function rememberMount(obj) {
    try {
      if (!(obj && obj.pzr_1 && typeof obj.pzr_1.r24 === "function")) return;
      if (!obj.vzr_1 || typeof obj.vzr_1.length !== "number") return;
      if (mountCandidates.indexOf(obj) >= 0) return;
      if (mountCandidates.length > 40) mountCandidates.shift();
      mountCandidates.push(obj);
    } catch (e) {}
  }

  function dirFromMountMatrix(mount) {
    if (!mount || !mount.pzr_1 || typeof mount.pzr_1.r24 !== "function") return null;
    var localY = makeGameVec(0, 1, 0);
    var out = makeGameVec(0, 0, 0);
    try {
      mount.pzr_1.r24(localY, out);
    } catch (e) {
      return null;
    }
    return normalizeDir(out.f20_1, out.g20_1, out.h20_1);
  }

  // Local mount only (muzzle near OUR hull). Direction is official
  // barrelDirectionProvider vector wzk_1 — 3D, includes elevation.
  // Never reads an aim-target / other player.
  function dirFromLocalMount(engineMe) {
    if (!engineMe || !mountCandidates.length) return null;
    var bestSock = null, bestMount = null, bestD = Infinity, i, j, m, socks, s, dx, dy, dz, d2, dir;
    for (i = 0; i < mountCandidates.length; i++) {
      m = mountCandidates[i];
      socks = m.vzr_1;
      if (!socks) continue;
      for (j = 0; j < socks.length; j++) {
        s = socks[j];
        if (!looksLikeMuzzleSocket(s)) continue;
        dx = s.tzk_1.f20_1 - engineMe.x;
        dy = s.tzk_1.g20_1 - engineMe.y;
        dz = s.tzk_1.h20_1 - engineMe.z;
        d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          bestSock = s;
          bestMount = m;
        }
      }
    }
    if (!bestSock || bestD > MOUNT_MATCH * MOUNT_MATCH) return null;
    dir = normalizeDir(bestSock.wzk_1.f20_1, bestSock.wzk_1.g20_1, bestSock.wzk_1.h20_1);
    if (!dir) dir = dirFromMountMatrix(bestMount);
    if (!dir) return null;
    return {
      dir: dir,
      origin: {
        x: bestSock.tzk_1.f20_1,
        y: bestSock.tzk_1.g20_1,
        z: bestSock.tzk_1.h20_1
      }
    };
  }

  function barrelForward(engineMe) {
    var found = dirFromLocalMount(engineMe);
    if (found) return { dir: found.dir, origin: found.origin, source: "barrel" };
    var dir = dirFromCamera();
    if (dir) return { dir: dir, origin: null, source: "camera" };
    dir = hullForward(engineMe);
    if (dir) return { dir: dir, origin: null, source: "hullFallback" };
    return null;
  }

  function emptyAhead() {
    return { type: null, name: null, dist: null };
  }

  function emptyPair() {
    return { hull: emptyAhead(), barrel: emptyAhead() };
  }

  function callZ9l(world, origin, dir, maxDist, mask, hit, filter) {
    return world.z9l(origin, dir, maxDist, mask, hit, filter);
  }

  function interpretHit(ok, hit, dbg, engineMe, ox, oy, oz, fwd, traveled) {
    dbg.z9lResult = !!ok;
    if (hit) {
      dbg.hitDistEngine = isFiniteNum(hit.l9q_1) ? hit.l9q_1 + traveled : null;
      dbg.hitDistM = dbg.hitDistEngine != null ? toM(dbg.hitDistEngine) : null;
      dbg.hitNormalZ = hit.k9q_1 ? hit.k9q_1.h20_1 : null;
      try { dbg.hitShapeName = hit.i9q_1 ? (hit.i9q_1.n9j_1 || null) : null; } catch (e) { dbg.hitShapeName = null; }
    }
    if (!ok) return emptyAhead();
    if (isTankishHit(hit)) {
      dbg.rejectedAsTank = true;
      return emptyAhead();
    }
    dbg.rejectedAsTank = false;
    var dist = hit.l9q_1;
    if (!isFiniteNum(dist) || dist < 0 || dist > RAY_MAX * 1.05) return emptyAhead();
    var hx = ox + fwd.x * dist;
    var hy = oy + fwd.y * dist;
    var hz = oz + fwd.z * dist;
    var nz = hit.k9q_1 ? hit.k9q_1.h20_1 : 0;
    if (!isFiniteNum(nz)) nz = 0;
    var cls = classifyHit(nz, nameFromHit(hit.i9q_1));
    return { type: cls.type, name: cls.name, dist: toM(dist + traveled) };
  }

  function rayDebugBase(engineMe) {
    return {
      unitToMeter: UNIT,
      heading: engineMe && engineMe.heading,
      headingDeg: engineMe && radToDeg(engineMe.heading),
      headingSource: lastHeadingSource,
      hasQuat: !!lastQuat,
      worldFound: !!(hooks.physicsWorld && typeof hooks.physicsWorld.z9l === "function"),
      z9lArity: hooks.physicsWorld && hooks.physicsWorld.z9l && hooks.physicsWorld.z9l.length,
      bodyMatched: !!hooks.physicsBody,
      cameraFound: !!hooks.camera,
      mountsFound: mountCandidates.length,
      clonedVec: !!(lastPosRef && typeof lastPosRef.d21 === "function"),
      maxDistEngine: RAY_MAX,
      maxDistM: RAY_MAX_M,
      minHitEngine: MIN_HIT,
      minHitM: MIN_HIT_M,
      originUpM: ORIGIN_UP * UNIT,
      error: null,
      attempt: null,
      z9lResult: null,
      rejectedAsTank: null,
      ignoredTooClose: null,
      skippedTankHits: 0
    };
  }

  var STATIC_MASK = 16; // official static-geometry group used by oz5().b9m(..., 16, hit)
  var staticPrimCache = { at: 0, prims: null, debug: null };

  function getCollisionWorlds() {
    var out = [], seen = [];
    function add(o) {
      if (!o || (typeof o !== "object" && typeof o !== "function")) return;
      if (seen.indexOf(o) >= 0) return;
      seen.push(o);
      out.push(o);
      if (seen.length > 30) return;
      try { if (o.zyv_1) add(o.zyv_1); } catch (e) {}
      try { if (o.g9m_1) add(o.g9m_1); } catch (e2) {}
      try { if (o.zz0_1) add(o.zz0_1); } catch (e3) {}
      try { if (o.c9i_1) add(o.c9i_1); } catch (e4) {}
    }
    add(hooks.physicsWorld);
    add(hooks.physicsBody);
    try { if (hooks.physicsBody && hooks.physicsBody.b9i_1) add(hooks.physicsBody.b9i_1); } catch (e5) {}
    return out;
  }

  function worldHasFn(name) {
    var worlds = getCollisionWorlds(), i;
    for (i = 0; i < worlds.length; i++) {
      try { if (typeof worlds[i][name] === "function") return true; } catch (e) {}
    }
    return false;
  }

  function listAllBodies() {
    var bodies = [], seen = [];
    function consider(b) {
      if (!b || seen.indexOf(b) >= 0) return;
      try {
        if (!(b.v9i_1 || b.o9i_1)) return;
      } catch (e) { return; }
      seen.push(b);
      bodies.push(b);
    }
    function considerList(list) {
      var arr = iterList(list), i;
      for (i = 0; i < arr.length; i++) consider(arr[i]);
    }
    var worlds = getCollisionWorlds(), i, w;
    for (i = 0; i < worlds.length; i++) {
      w = worlds[i];
      try { considerList(w.q9m_1); } catch (e) {}
      try { if (w.zyv_1) considerList(w.zyv_1.q9m_1); } catch (e2) {}
      try { if (w.g9m_1) considerList(w.g9m_1.q9m_1); } catch (e3) {}
    }
    for (i = 0; i < bodyCandidates.length; i++) consider(bodyCandidates[i]);
    return bodies;
  }

  function bodiesOfWorld(world) {
    var bodies = [], seen = [];
    function consider(b) {
      if (!b || seen.indexOf(b) >= 0) return;
      try { if (!(b.v9i_1 || b.o9i_1)) return; } catch (e) { return; }
      seen.push(b);
      bodies.push(b);
    }
    function considerList(list) {
      var arr = iterList(list), i;
      for (i = 0; i < arr.length; i++) consider(arr[i]);
    }
    if (!world) return bodies;
    try { considerList(world.q9m_1); } catch (e) {}
    try { if (world.zyv_1) considerList(world.zyv_1.q9m_1); } catch (e2) {}
    try { if (world.g9m_1) considerList(world.g9m_1.q9m_1); } catch (e3) {}
    return bodies;
  }

  function worldHasBody(world, body) {
    if (!world || !body) return false;
    return bodiesOfWorld(world).indexOf(body) >= 0;
  }

  function isStaticBody(b) {
    if (!b || b === hooks.physicsBody) return false;
    try {
      if (b.b9i_1 != null) return false;
    } catch (e) { return false; }
    try {
      var raw = [b.n9j_1, b.q9j_1];
      var i;
      for (i = 0; i < raw.length; i++) {
        if (typeof raw[i] === "string" && TANKISH_NAME.test(raw[i])) return false;
      }
    } catch (e2) {}
    return true;
  }

  function readShapeName(shape) {
    try {
      var n = shape && shape.n9j_1;
      if (typeof n === "string" && n && !TANKISH_NAME.test(n)) return n;
    } catch (e) {}
    return null;
  }

  function matFromTransform(tr) {
    if (!tr || !isFiniteNum(tr.g22_1)) return null;
    return {
      g22: tr.g22_1, h22: tr.h22_1, i22: tr.i22_1,
      j22: tr.j22_1, k22: tr.k22_1, l22: tr.l22_1,
      m22: tr.m22_1, n22: tr.n22_1, o22: tr.o22_1
    };
  }

  function posFromTransform(tr) {
    if (!tr || !isFiniteNum(tr.y23_1)) return null;
    return { x: tr.y23_1, y: tr.z23_1, z: tr.a24_1 };
  }

  function matToEuler(m) {
    if (!m) return { x: 0, y: 0, z: 0 };
    // Inverse of rotateEuler: Rz * Ry * Rx, columns are world images of local axes.
    var r00 = m.g22, r10 = m.h22, r20 = m.i22;
    var r01 = m.j22, r11 = m.k22, r21 = m.l22;
    var r02 = m.m22, r12 = m.n22, r22 = m.o22;
    var sy = -r20;
    if (sy > 1) sy = 1; if (sy < -1) sy = -1;
    var y = Math.asin(sy);
    var x, z;
    if (Math.abs(sy) < 0.99999) {
      x = Math.atan2(r21, r22);
      z = Math.atan2(r01, r00);
    } else {
      x = Math.atan2(-r12, r11);
      z = 0;
    }
    return { x: x, y: y, z: z };
  }

  function transformLocal(pos, m, v) {
    if (!pos || !m || !v) return v;
    return {
      x: pos.x + m.g22 * v.x + m.j22 * v.y + m.m22 * v.z,
      y: pos.y + m.h22 * v.x + m.k22 * v.y + m.n22 * v.z,
      z: pos.z + m.i22 * v.x + m.l22 * v.y + m.o22 * v.z
    };
  }

  var IDENTITY_MAT = { g22: 1, h22: 0, i22: 0, j22: 0, k22: 1, l22: 0, m22: 0, n22: 0, o22: 1 };

  function isExportableStaticShape(shape) {
    if (!shape) return false;
    try {
      var body = shape.r9j_1;
      if (body && (body === hooks.physicsBody || body.b9i_1 != null)) return false;
    } catch (e) { return false; }
    try {
      var n = shape.n9j_1;
      if (typeof n === "string" && TANKISH_NAME.test(n)) return false;
    } catch (e2) {}
    return true;
  }

  function collectionLen(v) {
    try {
      if (v == null) return 0;
      if (typeof v.e1 === "function") return v.e1();
      if (typeof v.length === "number") return v.length;
    } catch (e) {}
    return null;
  }

  function addUniqueShape(shape, into, seen) {
    if (!shape || seen.has(shape)) return;
    if (!isExportableStaticShape(shape)) return;
    seen.add(shape);
    into.push(shape);
  }

  // Shapes live in the static grid/kd-tree that b9m(mask 16) walks (zi.j9o).
  function collectShapesFromAccel(world, into, seen, stats) {
    if (!world) return;
    try {
      var grid = world.w9n_1;
      if (grid && grid.l9p_1 && typeof grid.l9p_1.length === "number") {
        var cells = grid.l9p_1, ci, cell, list, si, filled = 0;
        stats.grids.push({
          cells: cells.length,
          cellSize: grid.k9p_1 || null,
          nx: grid.n9p_1 || null,
          ny: grid.o9p_1 || null,
          nz: grid.p9p_1 || null
        });
        for (ci = 0; ci < cells.length; ci++) {
          cell = cells[ci];
          if (!cell || !cell.f9q_1) continue;
          list = iterList(cell.f9q_1);
          if (list.length) filled++;
          for (si = 0; si < list.length; si++) addUniqueShape(list[si], into, seen);
        }
        stats.grids[stats.grids.length - 1].filledCells = filled;
      }
    } catch (e) {
      stats.gridErrors = (stats.gridErrors || 0) + 1;
    }
    try {
      var treeSeen = new Set();
      function walkTree(node, depth) {
        if (!node || depth > 48) return;
        if (treeSeen.has(node)) return;
        treeSeen.add(node);
        try {
          if (node.w9q_1) {
            var leaf = iterList(node.w9q_1), li;
            stats.treeLeaves++;
            for (li = 0; li < leaf.length; li++) addUniqueShape(leaf[li], into, seen);
          }
        } catch (e2) {}
        try { if (node.s9q_1) walkTree(node.s9q_1, depth + 1); } catch (e3) {}
        try { if (node.t9q_1) walkTree(node.t9q_1, depth + 1); } catch (e4) {}
      }
      if (world.v9n_1) {
        stats.trees++;
        walkTree(world.v9n_1, 0);
      }
    } catch (e5) {
      stats.treeErrors = (stats.treeErrors || 0) + 1;
    }
  }

  function collectStaticShapes() {
    var into = [], seen = new Set();
    var stats = { grids: [], trees: 0, treeLeaves: 0, gridErrors: 0, treeErrors: 0 };
    var worlds = getCollisionWorlds(), i, w;
    for (i = 0; i < worlds.length; i++) {
      w = worlds[i];
      collectShapesFromAccel(w, into, seen, stats);
      try { if (w.g9m_1) collectShapesFromAccel(w.g9m_1, into, seen, stats); } catch (e) {}
      try { if (w.zyv_1) collectShapesFromAccel(w.zyv_1, into, seen, stats); } catch (e2) {}
    }
    stats.shapeCount = into.length;
    return { shapes: into, stats: stats };
  }

  function extractShapePrim(shape) {
    if (!shape) return null;
    var tr = null, pos = null, mat = null, typ = null;
    try { tr = shape.t9j_1; } catch (e) {}
    try { typ = shape.l9j_1; } catch (e0) {}
    pos = posFromTransform(tr);
    mat = matFromTransform(tr);
    var hasXform = !!(pos && mat);
    if (!pos) pos = { x: 0, y: 0, z: 0 };
    if (!mat) mat = IDENTITY_MAT;
    var name = readShapeName(shape);
    var he, prim, v0, v1, v2, aabb;

    try {
      if (shape.i9u_1 && isFiniteNum(shape.i9u_1.f20_1) && hasXform) {
        he = { x: shape.i9u_1.f20_1, y: shape.i9u_1.g20_1, z: shape.i9u_1.h20_1 };
        prim = {
          kind: "box",
          name: name,
          pos: pos,
          mat: mat,
          he: he,
          euler: matToEuler(mat)
        };
        return prim;
      }
    } catch (e2) {}

    try {
      if (shape.s9v_1 && isFiniteNum(shape.s9v_1.f20_1) && hasXform) {
        prim = {
          kind: "plane",
          name: name,
          pos: pos,
          mat: mat,
          he: { x: shape.s9v_1.f20_1, y: shape.s9v_1.g20_1, z: 0 },
          euler: matToEuler(mat)
        };
        return prim;
      }
    } catch (e3) {}

    try {
      if (shape.k9x_1 && shape.l9x_1 && shape.m9x_1 && isFiniteNum(shape.k9x_1.f20_1) && !shape.i9u_1) {
        v0 = { x: shape.k9x_1.f20_1, y: shape.k9x_1.g20_1, z: isFiniteNum(shape.k9x_1.h20_1) ? shape.k9x_1.h20_1 : 0 };
        v1 = { x: shape.l9x_1.f20_1, y: shape.l9x_1.g20_1, z: isFiniteNum(shape.l9x_1.h20_1) ? shape.l9x_1.h20_1 : 0 };
        v2 = { x: shape.m9x_1.f20_1, y: shape.m9x_1.g20_1, z: isFiniteNum(shape.m9x_1.h20_1) ? shape.m9x_1.h20_1 : 0 };
        prim = {
          kind: "triangle",
          name: name,
          w0: (pos && mat) ? transformLocal(pos, mat, v0) : v0,
          w1: (pos && mat) ? transformLocal(pos, mat, v1) : v1,
          w2: (pos && mat) ? transformLocal(pos, mat, v2) : v2
        };
        return prim;
      }
    } catch (e4) {}

    try {
      if ((typ === 2 || (shape.j9w_1 && isFiniteNum(shape.j9w_1) && !shape.i9u_1))) {
        var rad = isFiniteNum(shape.j9w_1) ? shape.j9w_1 : 0;
        if (rad > 0) {
          return {
            kind: "aabb",
            name: name,
            min: { x: pos.x - rad, y: pos.y - rad, z: pos.z - rad },
            max: { x: pos.x + rad, y: pos.y + rad, z: pos.z + rad }
          };
        }
      }
    } catch (eSph) {}

    try {
      aabb = shape.u9j_1;
      if (aabb && isFiniteNum(aabb.y1z_1) && isFiniteNum(aabb.b20_1)) {
        prim = {
          kind: "aabb",
          name: name,
          min: { x: aabb.y1z_1, y: aabb.z1z_1, z: aabb.a20_1 },
          max: { x: aabb.b20_1, y: aabb.c20_1, z: aabb.d20_1 }
        };
        return prim;
      }
    } catch (e5) {}
    return null;
  }

  function keyArrayLens(obj) {
    var out = {}, keys, i, name, val, len;
    try { keys = Object.getOwnPropertyNames(obj); } catch (e) { return out; }
    for (i = 0; i < keys.length && i < 50; i++) {
      name = keys[i];
      try {
        val = obj[name];
        len = collectionLen(val);
        if (len != null && len > 0) out[name] = len;
      } catch (e2) {}
    }
    return out;
  }

  function describeShape(shape) {
    var info = { type: null, group: null, name: null, ctor: null, keys: [], arrays: {}, has: {} };
    if (!shape) return info;
    try { info.type = shape.l9j_1; } catch (e) {}
    try { info.group = shape.p9j_1; } catch (e2) {}
    try { info.name = typeof shape.n9j_1 === "string" ? shape.n9j_1 : null; } catch (e3) {}
    try { info.ctor = shape.constructor && shape.constructor.name; } catch (e4) {}
    try { info.callableName = shape.callableName || null; } catch (e5) {}
    try { info.keys = Object.getOwnPropertyNames(shape).slice(0, 40); } catch (e6) {}
    info.arrays = keyArrayLens(shape);
    try {
      info.has = {
        i9u_1: !!(shape.i9u_1 && isFiniteNum(shape.i9u_1.f20_1)),
        s9v_1: !!(shape.s9v_1 && isFiniteNum(shape.s9v_1.f20_1)),
        k9x_1: !!(shape.k9x_1 && isFiniteNum(shape.k9x_1.f20_1)),
        t9j_1: !!(shape.t9j_1 && isFiniteNum(shape.t9j_1.g22_1)),
        u9j_1: !!(shape.u9j_1 && isFiniteNum(shape.u9j_1.y1z_1)),
        j9w_1: isFiniteNum(shape.j9w_1)
      };
    } catch (e7) {}
    return info;
  }

  function describeStaticBodies(bodies) {
    var out = [], i, b, shapes, j, rec;
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (!isStaticBody(b)) continue;
      rec = { ctor: null, keys: [], arrays: {}, shapeCount: 0, shapes: [] };
      try { rec.ctor = b.constructor && b.constructor.name; } catch (e) {}
      try { rec.callableName = b.callableName || null; } catch (e2) {}
      try { rec.keys = Object.getOwnPropertyNames(b).slice(0, 50); } catch (e3) {}
      rec.arrays = keyArrayLens(b);
      try { rec.d9i_1 = b.d9i_1; } catch (e4) {}
      try { rec.hasEntity = b.b9i_1 != null; } catch (e5) {}
      try { shapes = iterList(b.o9i_1); } catch (e6) { shapes = []; }
      rec.shapeCount = shapes.length;
      for (j = 0; j < shapes.length && rec.shapes.length < 8; j++) {
        rec.shapes.push(describeShape(shapes[j]));
      }
      out.push(rec);
      if (out.length >= 8) break;
    }
    return out;
  }

    function collectStaticPrimitives(force) {
    var now = performance.now();
    if (!force && staticPrimCache.prims && now - staticPrimCache.at < 2000) {
      return staticPrimCache.prims;
    }
    var boxes = [], planes = [], triangles = [];
    var jsBoxes = [], jsPlanes = [], jsTris = [];
    var bodies = listAllBodies();
    var staticCount = 0, dynamicCount = 0, shapeCount = 0, i, j, b, shapes, sh, prim, item;

    var extractedSeen = new Set();
    function addPrim(shape, prim) {
      if (!prim) return;
      if (shape && extractedSeen.has(shape)) return;
      if (shape) extractedSeen.add(shape);
      shapeCount++;
      if (prim.kind === "box") {
        jsBoxes.push(prim);
        item = primToExportBox(prim);
        if (item) boxes.push(item);
      } else if (prim.kind === "plane") {
        jsPlanes.push(prim);
        item = primToExportPlane(prim);
        if (item) planes.push(item);
      } else if (prim.kind === "triangle") {
        jsTris.push(prim);
        item = primToExportTri(prim);
        if (item) triangles.push(item);
      } else if (prim.kind === "aabb") {
        jsBoxes.push(aabbAsBox(prim));
        item = aabbToExportBox(prim);
        if (item) boxes.push(item);
      }
    }

    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (!isStaticBody(b)) { dynamicCount++; continue; }
      staticCount++;
      shapes = [];
      try { shapes = iterList(b.o9i_1); } catch (e) { shapes = []; }
      for (j = 0; j < shapes.length; j++) {
        sh = shapes[j];
        if (!isExportableStaticShape(sh)) continue;
        addPrim(sh, extractShapePrim(sh));
      }
    }

    var accel = { shapes: [], stats: { grids: [], trees: 0, treeLeaves: 0, gridErrors: 0, treeErrors: 0 } };
    try { accel = collectStaticShapes(); } catch (eAcc) { accel.stats.treeErrors = 1; }
    var accelAdded = 0;
    try {
      for (j = 0; j < accel.shapes.length; j++) {
        sh = accel.shapes[j];
        addPrim(sh, extractShapePrim(sh));
        accelAdded++;
      }
    } catch (ePrims) {}

    var payload = {
      boxes: boxes,
      planes: planes,
      triangles: triangles,
      jsBoxes: jsBoxes,
      jsPlanes: jsPlanes,
      jsTris: jsTris,
      staticBodies: staticCount,
      dynamicBodies: dynamicCount,
      bodyListSize: bodies.length,
      shapeCount: shapeCount,
      accelShapeCount: accel.shapes.length,
      accelStats: accel.stats
    };
    staticPrimCache.prims = payload;
    staticPrimCache.at = now;
    staticPrimCache.debug = {
      staticBodies: staticCount,
      dynamicSkipped: dynamicCount,
      bodyListSize: bodies.length,
      boxes: boxes.length,
      planes: planes.length,
      triangles: triangles.length,
      accelShapes: accel.shapes.length,
      accel: accel.stats,
      worlds: getCollisionWorlds().length,
      hasB9m: worldHasFn("b9m"),
      hasZ9l: worldHasFn("z9l")
    };
    return payload;
  }

  function primToExportBox(p) {
    var corners = [], signs, i, v;
    signs = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
    ];
    for (i = 0; i < 8; i++) {
      v = transformLocal(p.pos, p.mat, { x: signs[i][0] * p.he.x, y: signs[i][1] * p.he.y, z: signs[i][2] * p.he.z });
      corners.push(vecToM(v));
    }
    return {
      type: "box",
      name: p.name,
      position: vecToM(p.pos),
      rotation: p.euler,
      size: vecToM({ x: p.he.x * 2, y: p.he.y * 2, z: p.he.z * 2 }),
      corners: corners
    };
  }

  function primToExportPlane(p) {
    return {
      type: "plane",
      name: p.name,
      position: vecToM(p.pos),
      rotation: p.euler,
      length: toM(p.he.x * 2),
      width: toM(p.he.y * 2)
    };
  }

  function primToExportTri(p) {
    return {
      type: "triangle",
      name: p.name,
      position: null,
      rotation: null,
      v0: vecToM(p.w0),
      v1: vecToM(p.w1),
      v2: vecToM(p.w2),
      world: [vecToM(p.w0), vecToM(p.w1), vecToM(p.w2)]
    };
  }

  function aabbAsBox(p) {
    return {
      kind: "box",
      name: p.name,
      pos: { x: (p.min.x + p.max.x) / 2, y: (p.min.y + p.max.y) / 2, z: (p.min.z + p.max.z) / 2 },
      mat: { g22: 1, h22: 0, i22: 0, j22: 0, k22: 1, l22: 0, m22: 0, n22: 0, o22: 1 },
      he: { x: Math.abs(p.max.x - p.min.x) / 2, y: Math.abs(p.max.y - p.min.y) / 2, z: Math.abs(p.max.z - p.min.z) / 2 },
      euler: { x: 0, y: 0, z: 0 }
    };
  }

  function aabbToExportBox(p) {
    return primToExportBox(aabbAsBox(p));
  }

  function rayVsOBB(ox, oy, oz, dx, dy, dz, pos, he, mat) {
    var sx = ox - pos.x, sy = oy - pos.y, sz = oz - pos.z;
    var g = mat.g22 * sx + mat.h22 * sy + mat.i22 * sz;
    var m = mat.j22 * sx + mat.k22 * sy + mat.l22 * sz;
    var z = mat.m22 * sx + mat.n22 * sy + mat.o22 * sz;
    var b = mat.g22 * dx + mat.h22 * dy + mat.i22 * dz;
    var k = mat.j22 * dx + mat.k22 * dy + mat.l22 * dz;
    var q = mat.m22 * dx + mat.n22 * dy + mat.o22 * dz;
    var tmin = -1, tmax = 1e30, e, u, nx = 0, ny = 0, nz = 0, axis;
    function slab(p, dir, ext, ax, ay, az) {
      if (Math.abs(dir) < 1e-12) {
        if (p < -ext || p > ext) return false;
        return true;
      }
      e = (-ext - p) / dir;
      u = (ext - p) / dir;
      var enter = e, leave = u, enteredNeg = true;
      if (e > u) { enter = u; leave = e; enteredNeg = false; }
      if (enter > tmin) {
        tmin = enter;
        nx = enteredNeg ? -ax : ax;
        ny = enteredNeg ? -ay : ay;
        nz = enteredNeg ? -az : az;
      }
      if (leave < tmax) tmax = leave;
      if (tmax < tmin) return false;
      return true;
    }
    if (!slab(g, b, he.x, mat.g22, mat.h22, mat.i22)) return null;
    if (!slab(m, k, he.y, mat.j22, mat.k22, mat.l22)) return null;
    if (!slab(z, q, he.z, mat.m22, mat.n22, mat.o22)) return null;
    if (tmin < 0) return null;
    var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { dist: tmin, nz: nz / nlen };
  }

  function rayVsTriangle(ox, oy, oz, dx, dy, dz, a, b, c) {
    var eps = 1e-7;
    var ex1x = b.x - a.x, ex1y = b.y - a.y, ex1z = b.z - a.z;
    var ex2x = c.x - a.x, ex2y = c.y - a.y, ex2z = c.z - a.z;
    var px = dy * ex2z - dz * ex2y, py = dz * ex2x - dx * ex2z, pz = dx * ex2y - dy * ex2x;
    var det = ex1x * px + ex1y * py + ex1z * pz;
    if (Math.abs(det) < eps) return null;
    var inv = 1 / det;
    var tx = ox - a.x, ty = oy - a.y, tz = oz - a.z;
    var u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return null;
    var qx = ty * ex1z - tz * ex1y, qy = tz * ex1x - tx * ex1z, qz = tx * ex1y - ty * ex1x;
    var v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return null;
    var dist = (ex2x * qx + ex2y * qy + ex2z * qz) * inv;
    if (dist < 0) return null;
    var nx = ex1y * ex2z - ex1z * ex2y, ny = ex1z * ex2x - ex1x * ex2z, nz = ex1x * ex2y - ex1y * ex2x;
    var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { dist: dist, nz: nz / nlen };
  }

  function rayVsPlaneRect(ox, oy, oz, dx, dy, dz, pos, he, mat) {
    var sx = ox - pos.x, sy = oy - pos.y, sz = oz - pos.z;
    var z = mat.m22 * sx + mat.n22 * sy + mat.o22 * sz;
    var q = mat.m22 * dx + mat.n22 * dy + mat.o22 * dz;
    if (z * q >= 0 || Math.abs(q) < 1e-12) return null;
    var t = -z / q;
    if (t < 0) return null;
    var lx = mat.g22 * sx + mat.h22 * sy + mat.i22 * sz + t * (mat.g22 * dx + mat.h22 * dy + mat.i22 * dz);
    var ly = mat.j22 * sx + mat.k22 * sy + mat.l22 * sz + t * (mat.j22 * dx + mat.k22 * dy + mat.l22 * dz);
    if (Math.abs(lx) > he.x || Math.abs(ly) > he.y) return null;
    var sign = q < 0 ? 1 : -1;
    return { dist: t, nz: sign * mat.o22 };
  }

  function jsRaycast(ox, oy, oz, fwd, maxDist) {
    var data = getJsRayPrims();
    var best = null, i, hit, d;
    var dx = fwd.x, dy = fwd.y, dz = fwd.z || 0;
    for (i = 0; i < data.jsBoxes.length; i++) {
      d = data.jsBoxes[i];
      hit = rayVsOBB(ox, oy, oz, dx, dy, dz, d.pos, d.he, d.mat);
      if (hit && hit.dist >= 0 && hit.dist <= maxDist && (!best || hit.dist < best.dist)) {
        best = { dist: hit.dist, nz: hit.nz, name: d.name, via: "js-box" };
      }
    }
    for (i = 0; i < data.jsPlanes.length; i++) {
      d = data.jsPlanes[i];
      hit = rayVsPlaneRect(ox, oy, oz, dx, dy, dz, d.pos, d.he, d.mat);
      if (hit && hit.dist >= 0 && hit.dist <= maxDist && (!best || hit.dist < best.dist)) {
        best = { dist: hit.dist, nz: hit.nz, name: d.name, via: "js-plane" };
      }
    }
    for (i = 0; i < data.jsTris.length; i++) {
      d = data.jsTris[i];
      hit = rayVsTriangle(ox, oy, oz, dx, dy, dz, d.w0, d.w1, d.w2);
      if (hit && hit.dist >= 0 && hit.dist <= maxDist && (!best || hit.dist < best.dist)) {
        best = { dist: hit.dist, nz: hit.nz, name: d.name, via: "js-tri" };
      }
    }
    return best;
  }

  function jsHitToEngineHit(js) {
    if (!js) return { ok: false, hit: null, via: "js" };
    return {
      ok: true,
      via: js.via,
      hit: {
        l9q_1: js.dist,
        i9q_1: js.name ? { n9j_1: js.name } : null,
        k9q_1: { f20_1: 0, g20_1: 0, h20_1: js.nz }
      }
    };
  }

    function tryEngineCall(world, method, ox, oy, oz, fwd, maxDist, mask, filter, name, dbg) {
    if (!world || typeof world[method] !== "function") {
      return { ok: false, hit: null, skip: true };
    }
    var origin = makeGameVec(ox, oy, oz);
    var dir = makeGameVec(fwd.x, fwd.y, fwd.z || 0);
    var hit = makeHitResult();
    var ok;
    try {
      if (method === "b9m") {
        // Official static ray: b9m(origin, dir, maxDist, mask, hit [, filter])
        ok = filter
          ? world.b9m(origin, dir, maxDist, mask, hit, filter)
          : world.b9m(origin, dir, maxDist, mask, hit);
      } else {
        ok = callZ9l(world, origin, dir, maxDist, mask, hit, filter);
      }
    } catch (e) {
      var err = String(e && e.message || e);
      lastRayError = err;
      if (!dbg.attempts) dbg.attempts = [];
      dbg.attempts.push({ name: name, threw: err });
      dbg.error = err;
      logDebug(method + " " + name + " threw: " + err);
      return { ok: false, hit: null, threw: err };
    }
    var rec = {
      name: name,
      ok: !!ok,
      distEngine: (hit && isFiniteNum(hit.l9q_1)) ? hit.l9q_1 : null,
      distM: (hit && isFiniteNum(hit.l9q_1)) ? toM(hit.l9q_1) : null,
      tankish: !!(ok && isTankishHit(hit))
    };
    if (!dbg.attempts) dbg.attempts = [];
    dbg.attempts.push(rec);
    dbg.attempt = name;
    return { ok: ok, hit: hit, via: name };
  }

  function tryCastAt(world, ox, oy, oz, fwd, maxDist, dbg) {
    var worlds = getCollisionWorlds();
    if (world && worlds.indexOf(world) < 0) worlds.unshift(world);
    var attempts = [
      { method: "b9m", name: "b9m+mask16", mask: STATIC_MASK, filter: null },
      { method: "b9m", name: "b9m+mask16+staticFilter", mask: STATIC_MASK, filter: STATIC_FILTER },
      { method: "z9l", name: "z9l+mask16+staticFilter", mask: STATIC_MASK, filter: STATIC_FILTER },
      { method: "z9l", name: "z9l+wide+staticFilter", mask: 0x7fffffff, filter: STATIC_FILTER },
      { method: "z9l", name: "z9l+wide+noFilter", mask: 0x7fffffff, filter: null }
    ];
    var last = { ok: false, hit: null };
    var w, a, i, j, res;
    dbg.hasB9m = worldHasFn("b9m");
    dbg.hasZ9l = worldHasFn("z9l");
    dbg.worldsTried = engineRaysOn ? worlds.length : 0;
    dbg.engineRays = engineRaysOn;
    for (i = 0; engineRaysOn && i < worlds.length; i++) {
      w = worlds[i];
      for (j = 0; j < attempts.length; j++) {
        a = attempts[j];
        res = tryEngineCall(w, a.method, ox, oy, oz, fwd, maxDist, a.mask, a.filter, a.name + "#" + i, dbg);
        if (res.skip) continue;
        if (res.ok) last = res;
        if (res.ok && res.hit && !isTankishHit(res.hit)) return res;
      }
    }
    var js = null;
    try { js = jsRaycast(ox, oy, oz, fwd, maxDist); } catch (eJs) { dbg.jsError = String(eJs && eJs.message || eJs); }
    if (js) {
      dbg.jsHit = { distM: toM(js.dist), nz: js.nz, via: js.via, name: js.name || null };
      last = jsHitToEngineHit(js);
      dbg.attempt = last.via;
      if (!dbg.attempts) dbg.attempts = [];
      dbg.attempts.push({ name: last.via, ok: true, distEngine: js.dist, distM: toM(js.dist) });
      return last;
    }
    dbg.jsHit = null;
    return last;
  }

  function castOneRay(engineMe, fwd, dbg, originOverride) {
    var world = hooks.physicsWorld;
    if (!engineMe || !fwd) {
      return emptyAhead();
    }
    if (!worldHasFn("z9l") && !worldHasFn("b9m")) {
      dbg.error = dbg.error || "no z9l/b9m on hooked worlds";
    }
    var ox, oy, oz;
    // Always from tank center (hull position), ~1 m up. Never from the muzzle tip:
    // a muzzle origin plus a 3 m "too close" skip makes the ray go through a wall
    // you are already touching.
    ox = engineMe.x;
    oy = engineMe.y;
    oz = engineMe.z + ORIGIN_UP;
    dbg.originEngine = { x: ox, y: oy, z: oz };
    dbg.originFrom = "center";
    dbg.originM = { x: toM(ox), y: toM(oy), z: toM(oz) };
    dbg.dir = fwd;
    dbg.dirPitchDeg = radToDeg(Math.atan2(fwd.z || 0, Math.sqrt(fwd.x * fwd.x + fwd.y * fwd.y)));

    var traveled = 0;
    var remaining = RAY_MAX;
    var skips = 0;
    var result = emptyAhead();
    var last, hx, hy, hz, step, EPS = 10; // 10 cm past a rejected tank hit
    while (remaining > 1 && skips < 5) {
      last = tryCastAt(world, ox, oy, oz, fwd, remaining, dbg);
      result = interpretHit(last.ok, last.hit, dbg, engineMe, ox, oy, oz, fwd, traveled);
      if (result.type != null) return result;
      var canSkip = last.ok && last.hit && isTankishHit(last.hit);
      if (!canSkip) break;
      step = last.hit.l9q_1;
      if (!isFiniteNum(step) || step < 0) break;
      step = step + EPS;
      ox = ox + fwd.x * step;
      oy = oy + fwd.y * step;
      oz = oz + fwd.z * step;
      traveled += step;
      remaining = RAY_MAX - traveled;
      skips++;
      dbg.skippedTankHits = skips;
      dbg.rejectedAsTank = true;
    }
    return result;
  }

  function castAhead(engineMe, recordDebug) {
    var hullDbg = rayDebugBase(engineMe);
    var barrelDbg = rayDebugBase(engineMe);
    if (!engineMe) {
      var empty = emptyPair();
      if (recordDebug) lastRayDebug = { hull: hullDbg, barrel: barrelDbg, barrelSource: lastBarrelSource };
      return empty;
    }

    var hullDir = hullForward(engineMe);
    hullDbg.forward = hullDir;
    var hullHit = emptyAhead();
    if (!hullDir) hullDbg.error = "no hull forward/heading";
    else hullHit = castOneRay(engineMe, hullDir, hullDbg, null);

    var barrelInfo = barrelForward(engineMe);
    lastBarrelSource = barrelInfo ? barrelInfo.source : null;
    barrelDbg.barrelSource = lastBarrelSource;
    barrelDbg.forward = barrelInfo && barrelInfo.dir;
    var barrelHit = emptyAhead();
    if (!barrelInfo) barrelDbg.error = "no barrel/camera/hull direction";
    else barrelHit = castOneRay(engineMe, barrelInfo.dir, barrelDbg, null);

    if (recordDebug) {
      lastRayDebug = {
        unitToMeter: UNIT,
        barrelSource: lastBarrelSource,
        hull: hullDbg,
        barrel: barrelDbg
      };
    }
    return { hull: hullHit, barrel: barrelHit };
  }

  /* ---------- object-graph scan ---------- */

  var SKIP_CTOR = {
    Number: 1, String: 1, Boolean: 1, Symbol: 1, Date: 1, RegExp: 1,
    ArrayBuffer: 1, DataView: 1, Promise: 1, WeakMap: 1, WeakSet: 1,
    Map: 1, Set: 1, Error: 1, Location: 1, History: 1, Navigator: 1,
    Plugin: 1, PluginArray: 1, MimeType: 1, CSSStyleDeclaration: 1,
    Performance: 1, PerformanceNavigation: 1, Crypto: 1, Storage: 1,
    Animation: 1, CSSAnimation: 1, CSSTransition: 1
  };

  function shouldSkip(obj) {
    if (obj == null) return true;
    if (obj === window || obj === document) return false;
    if (obj === window.toCoords) return true;
    try {
      if (typeof Animation !== "undefined" && obj instanceof Animation) return true;
    } catch (e) {}
    try {
      if (typeof Node !== "undefined" && obj instanceof Node) {
        return obj.nodeType !== 1 || (obj.tagName !== "CANVAS" && obj !== document.documentElement && obj !== document.body);
      }
    } catch (e) {}
    if (ArrayBuffer.isView && ArrayBuffer.isView(obj)) return true;
    try {
      var n = obj.constructor && obj.constructor.name;
      if (n && SKIP_CTOR[n]) return true;
      if (n && /^(Int|Uint|Float)(8|16|32|64)/.test(n)) return true;
      if (n && /^WebGL/.test(n)) return true;
    } catch (e) {}
    return false;
  }

  function collectListenerFns(target, out) {
    if (typeof getEventListeners !== "function") return;
    try {
      var evs = getEventListeners(target);
      if (!evs) return;
      Object.keys(evs).forEach(function (type) {
        (evs[type] || []).forEach(function (rec) {
          if (rec && rec.listener) out.push(rec.listener);
        });
      });
    } catch (e) {}
  }

  function recordCallable(fn) {
    var name = fn && fn.callableName;
    if (!name || typeof name !== "string") return;
    if (!foundCallables[name]) foundCallables[name] = 0;
    foundCallables[name]++;
    if (!INTERESTING[name]) return;
    if (hooks[name] === fn) return;
    if (!OFF.wrapPoint && (name === "initPoint" || name === "initNewStylePoint")) fn = wrapPointInitFn(null, name, fn);
    hooks[name] = fn;
    logDebug("hooked " + name + (foundCallables[name] > 1 ? " (replace #" + foundCallables[name] + ")" : " (first)"));
    if (name === "getLocalTankPosition" || name === "isLocalTankAlive") {
      logDebug("pos hook ready: " + name);
    }
  }
  window.__toCoordsOnCallable = recordCallable;

  function harvestCallables(root, budget) {
    if (OFF.scan) return;
    budget = budget || 400;
    var seen = [], q = [root || window], n = 0, i, obj, keys, k, v;
    try { if (typeof kotlin !== "undefined") q.push(kotlin); } catch (eK) {}
    while (q.length && n < budget) {
      obj = q.shift();
      if (!obj || (typeof obj !== "object" && typeof obj !== "function")) continue;
      if (seen.indexOf(obj) >= 0) continue;
      seen.push(obj);
      try { keys = Object.getOwnPropertyNames(obj); } catch (e) { continue; }
      for (i = 0; i < keys.length && n < budget; i++) {
        k = keys[i];
        if (SCAN_SKIP_KEYS[k]) continue;
        try { v = obj[k]; } catch (e2) { continue; }
        n++;
        if (typeof v === "function") {
          try { if (v.callableName) recordCallable(v); } catch (e3) {}
        } else if (v && (typeof v === "object" || typeof v === "function") && seen.length < 250) {
          q.push(v);
        }
      }
    }
    logDebug("harvest scanned " + n + " keys pos=" + isPosHooked());
  }

  function rememberBody(obj) {
    try {
      if (!(obj && obj.v9i_1 && obj.v9i_1.i9j_1 && obj.v9i_1.g9j_1)) return;
      if (!parseVector3(obj.v9i_1.i9j_1) || !parseQuaternion(obj.v9i_1.g9j_1)) return;
      if (bodyCandidates.indexOf(obj) >= 0) return;
      if (bodyCandidates.length > 80) bodyCandidates.shift();
      bodyCandidates.push(obj);
    } catch (e) {}
  }

  function extractWorldFrom(obj) {
    if (!obj) return null;
    try {
      if (obj.b9i_1 && obj.b9i_1.zz0_1 && typeof obj.b9i_1.zz0_1.z9l === "function") return obj.b9i_1.zz0_1;
    } catch (e) {}
    try {
      if (obj.zz0_1 && typeof obj.zz0_1.z9l === "function" && obj.zz0_1.z9l.length >= 5) return obj.zz0_1;
    } catch (e2) {}
    try {
      if (typeof obj.z9l === "function" && obj.z9l.length >= 5 && (obj.q9m_1 || obj.w9n_1)) return obj;
    } catch (e3) {}
    return null;
  }

  function rememberWorld(w) {
    if (!w) return;
    if (worldCandidates.indexOf(w) < 0) {
      worldCandidates.push(w);
      if (worldCandidates.length > 10) worldCandidates.shift();
    }
  }

  function maybePhysicsWorld(obj) {
    try {
      var w = extractWorldFrom(obj);
      if (!w) return;
      rememberWorld(w);
      if (!hooks.physicsWorld && !isRetiredWorld(w)) {
        hooks.physicsWorld = w;
        attachCameraFromWorld(w);
        logDebug("hooked physicsWorld");
        try { maybeStartMapCache(); } catch (eC) {}
      }
    } catch (e) {}
  }

  var mapTeamPoints = [];
  var lastMapExport = null;

  function parseMapVec(obj) {
    if (obj == null) return null;
    if (typeof obj === "number") return null;
    try {
      if (isFiniteNum(obj.f20_1) && isFiniteNum(obj.g20_1) && isFiniteNum(obj.h20_1)) {
        return { x: obj.f20_1, y: obj.g20_1, z: obj.h20_1 };
      }
      if (isFiniteNum(obj.o80_1) && isFiniteNum(obj.p80_1) && isFiniteNum(obj.q80_1)) {
        return { x: obj.o80_1, y: obj.p80_1, z: obj.q80_1 };
      }
      if (isFiniteNum(obj.x) && isFiniteNum(obj.y) && isFiniteNum(obj.z)) {
        return { x: obj.x, y: obj.y, z: obj.z };
      }
    } catch (e) {}
    var p = parseVector3(obj);
    if (p) return { x: p.x, y: p.y, z: p.z };
    return null;
  }

  function vecToM(v) {
    if (!v) return null;
    return { x: toM(v.x), y: toM(v.y), z: toM(v.z) };
  }

  function iterList(list) {
    if (list == null) return [];
    if (Array.isArray(list)) return list;
    try {
      if (typeof list.e1 === "function" && typeof list.g1 === "function") {
        var n = list.e1(), out = [], i;
        if (typeof n !== "number" || n < 0 || n > 200000) return [];
        for (i = 0; i < n; i++) out.push(list.g1(i));
        return out;
      }
    } catch (e) {}
    try {
      if (typeof list.length === "number" && list.length >= 0 && list.length <= 200000 &&
          !isFiniteNum(list.f20_1) && !isFiniteNum(list.o80_1)) {
        var arr = [], j;
        for (j = 0; j < list.length; j++) arr.push(list[j]);
        return arr;
      }
    } catch (e2) {}
    return [];
  }

  function unwrapList(obj, innerKeys) {
    var list = iterList(obj);
    if (list.length) return list;
    if (!obj || typeof obj !== "object") return [];
    var k, inner;
    for (k = 0; k < innerKeys.length; k++) {
      try { inner = obj[innerKeys[k]]; } catch (e) { inner = null; }
      list = iterList(inner);
      if (list.length) return list;
    }
    return [];
  }

  function enumName(v) {
    if (v == null) return null;
    if (typeof v === "string") return v;
    var s;
    try { s = String(v); } catch (e) { return null; }
    if (!s || s === "[object Object]") return null;
    var m = /^([A-Z][A-Z0-9_]+)$/.exec(s);
    if (m) return m[1];
    m = /([A-Z][A-Z0-9_]{1,40})/.exec(s);
    return m ? m[1] : s.slice(0, 40);
  }

  function looksLikeBattleMap(obj) {
    try {
      if (!obj) return false;
      var cg = obj.b7w_1;
      if (cg && (cg.u7w_1 != null || cg.v7w_1 != null || cg.w7w_1 != null) && obj.f7w_1 != null) {
        return true;
      }
      if (typeof obj.g7w === "function" && typeof obj.j7w === "function" && typeof obj.h7w === "function") {
        try {
          if (String(obj).indexOf("BattleMap [") === 0) return true;
        } catch (e) {}
      }
    } catch (e2) {}
    return false;
  }

  function looksLikeCollisionGeometry(obj) {
    try {
      if (!obj) return false;
      if (obj.u7w_1 != null || obj.v7w_1 != null || obj.w7w_1 != null) return true;
      if (typeof obj.x7w === "function" && typeof obj.y7w === "function" && typeof obj.z7w === "function") {
        try { return String(obj).indexOf("CollisionGeometry [") === 0; } catch (e) {}
      }
    } catch (e2) {}
    return false;
  }

  function rememberMapData(obj) {
    try {
      if (looksLikeBattleMap(obj) && !hooks.battleMap) {
        hooks.battleMap = obj;
        logDebug("hooked BattleMap");
      }
      if (!hooks.mapName && typeof obj.ijb_1 === "string" && obj.ijb_1.length > 0 && obj.ijb_1.length < 80 &&
          (typeof obj.nc1 === "function" || obj.cjb_1 != null)) {
        hooks.mapName = obj.ijb_1;
      }
      if (!hooks.mapName && typeof obj.zib_1 === "string" && obj.zib_1.length > 1 && obj.zib_1.length < 80 &&
          typeof obj.d8f === "function") {
        hooks.mapName = obj.zib_1;
      }
      // Static flag bases only (ClientTeamPoint.flagBasePosition). Never live carriers.
      if (obj && obj.xin_1 && parseMapVec(obj.xin_1) && obj.zin_1 != null && obj.oir_1 == null) {
        if (mapTeamPoints.indexOf(obj) < 0 && mapTeamPoints.length < 32) {
          mapTeamPoints.push(obj);
        }
      }
      rememberFlagHud(obj);
      rememberControlPoint(obj);
      rememberBattlefieldCC(obj);
    } catch (e) {}
  }

  function flagStateName(obj) {
    if (!obj) return null;
    try {
      var st = obj.mir_1;
      if (st == null) return null;
      var s = enumName(st) || String(st);
      if (/AT_BASE/.test(s)) return "AT_BASE";
      if (/DROPPED|CARRIED|EXILED|FLYING/.test(s)) return s;
    } catch (e) {}
    return null;
  }

  function rememberFlagHud(obj) {
    // FlagState: read only mir_1 (state). Never kir_1 (carrier) or lir_1 (position).
    if (!obj || obj.mir_1 == null) return;
    if (flagStateName(obj) == null) return;
    if (flagHudObjs.indexOf(obj) < 0 && flagHudObjs.length < 8) flagHudObjs.push(obj);
  }

  function looksLikeClientPointData(obj) {
    if (!obj || typeof obj !== "object") return false;
    try { if (String(obj).indexOf("ClientPointData") === 0) return true; } catch (e) {}
    try {
      // ClientPointData: active xii_1, id yii_1, position aij_1 / n7v(), name m().
      // Never read eij_1 / fij() (tankIds).
      if (typeof obj.xii_1 === "boolean" && obj.yii_1 != null && (obj.aij_1 || typeof obj.n7v === "function")) return true;
    } catch (e2) {}
    return false;
  }

  function looksLikeDominationCC(obj) {
    if (!obj || typeof obj !== "object") return false;
    try { if (String(obj).indexOf("DominationCC") === 0) return true; } catch (e) {}
    try {
      if (obj.mii_1 != null && obj.jii_1 != null && obj.kii_1 != null && typeof obj.pii === "function") return true;
    } catch (e2) {}
    return false;
  }

  function letterFromPointMeta(name, id) {
    var s = name != null ? String(name) : "";
    var m = /\b([A-Ha-h])\b/.exec(s) || /^([A-Ha-h])$/.exec(s);
    if (m) return m[1].toUpperCase();
    if (id != null) {
      s = (id && typeof id.toString === "function") ? String(id.toString()) : String(id);
      m = /^([A-Ha-h])$/.exec(s) || /\b([A-Ha-h])\b/.exec(s);
      if (m) return m[1].toUpperCase();
      if (typeof id === "number" && id >= 0 && id <= 7) return String.fromCharCode(65 + id);
    }
    return null;
  }

  function maybeRefreshObjectives() {
    if (!mapCache.data) return;
    try {
      mapCache.data.objectives = buildObjectives(mapCache.data.bases || [], mapCache.data.spawns || [], mapControlPoints);
      if (mapCache.data.counts) mapCache.data.counts.objectives = mapCache.data.objectives.length;
    } catch (e) {}
  }

  function rememberControlPointAt(pos, letter, name) {
    if (!pos || !isFiniteNum(pos.x) || !isFiniteNum(pos.y)) return false;
    var i;
    for (i = 0; i < mapControlPoints.length; i++) {
      if (Math.abs(mapControlPoints[i].position.x - pos.x) < 0.4 && Math.abs(mapControlPoints[i].position.y - pos.y) < 0.4) {
        if (letter && !mapControlPoints[i].letter) mapControlPoints[i].letter = letter;
        return false;
      }
    }
    if (!letter) letter = String.fromCharCode(65 + mapControlPoints.filter(function (c) { return c.kind !== "flag"; }).length);
    if (mapControlPoints.length >= 16) return false;
    mapControlPoints.push({ position: pos, letter: letter, name: name || letter, kind: "cp" });
    logDebug("cp found " + letter + " at " + (Math.round(pos.x * 10) / 10) + "," + (Math.round(pos.y * 10) / 10) + (name && name !== letter ? " " + name : ""));
    maybeRefreshObjectives();
    return true;
  }

  function rememberControlPoint(obj) {
    if (!obj || typeof obj !== "object") return;
    try { if (obj.oir_1 != null) return; } catch (eSkip) {}
    var i, list, pos, name, id, letter;
    if (looksLikeDominationCC(obj)) {
      list = [];
      try { list = iterList(typeof obj.pii === "function" ? obj.pii() : obj.mii_1); } catch (eL) { list = []; }
      logDebug("DominationCC points=" + list.length);
      for (i = 0; i < list.length; i++) rememberControlPoint(list[i]);
      return;
    }
    if (looksLikeClientPointData(obj)) {
      pos = null;
      try { if (typeof obj.n7v === "function") pos = vecToM(parseMapVec(obj.n7v())); } catch (eP) {}
      if (!pos) { try { pos = vecToM(parseMapVec(obj.aij_1)); } catch (eP2) {} }
      name = "";
      // name via m(); never fij()/eij_1 tankIds
      try { if (typeof obj.m === "function") name = String(obj.m() || ""); } catch (eN) {}
      try { id = obj.yii_1; } catch (eI) { id = null; }
      letter = letterFromPointMeta(name, id);
      rememberControlPointAt(pos, letter, name || letter);
    }
    // No guessing from names: anything with a position and a one-letter name
    // used to become a "control point" (props, spawns...).
  }

  function capturePointFromInitArgs(args) {
    var n = args && (args.length > 1 ? args[1] : args[0]);
    if (!n || typeof n !== "object") return;
    var rec = n.o13j_1 || n.r13j_1;
    if (!rec) return;
    var pos = null, id = null, name = "";
    try { id = rec.yin_1; } catch (e) {}
    try {
      var tr = (typeof rec.aio === "function") ? rec.aio() : rec;
      var raw = (tr && typeof tr.d21 === "function") ? tr.d21() : tr;
      pos = vecToM(parseMapVec(raw));
    } catch (e2) {}
    try { name = id != null && id.toString ? String(id.toString()) : String(id || ""); } catch (e3) { name = String(id || ""); }
    rememberControlPointAt(pos, letterFromPointMeta(name, id), name);
  }

  function wrapPointInitFn(obj, key, fn) {
    if (!fn || fn.__toCoordsCpWrapped) return fn;
    var wrapped = function () {
      try { capturePointFromInitArgs(arguments); } catch (e) {}
      return fn.apply(this, arguments);
    };
    wrapped.callableName = fn.callableName || key;
    wrapped.__toCoordsCpWrapped = true;
    fn.__toCoordsCpWrapped = true;
    if (obj && key) {
      try { obj[key] = wrapped; } catch (e2) {}
    }
    return wrapped;
  }

  function normalizeTeam(team) {
    var t = String(team || "").toUpperCase();
    if (/BLUE|СИН/.test(t)) return "BLUE";
    if (/RED|КРАС/.test(t)) return "RED";
    return t || "NEUTRAL";
  }

  function teamStyle(team) {
    var t = normalizeTeam(team);
    if (t === "BLUE") return { fill: "#2f6dff", stroke: "#9cbcff", key: "BLUE" };
    if (t === "RED") return { fill: "#e03c3c", stroke: "#ff9a9a", key: "RED" };
    return { fill: "#c9c14a", stroke: "#fff38a", key: t };
  }

  function flagTeamOf(obj) {
    try {
      return normalizeTeam(enumName(obj.zin_1) || enumName(obj.win_1) || enumName(obj.teamType) || enumName(obj.team));
    } catch (e) { return null; }
  }

  function updateFlagTakenStates() {
    var next = {}, i, obj, st, team;
    for (i = 0; i < flagHudObjs.length; i++) {
      obj = flagHudObjs[i];
      try {
        st = flagStateName(obj);
        team = flagTeamOf(obj);
        if (!team || !st) continue;
        next[team] = st !== "AT_BASE";
      } catch (e) {}
    }
    flagTaken = next;
  }

  function buildObjectives(bases, spawns, extraPoints) {
    var out = [], used = {}, i, b, s, typ, letter, pos, key, kind, team, item;
    function add(o) {
      if (!o || !o.position || !isFiniteNum(o.position.x) || !isFiniteNum(o.position.y)) return;
      key = o.kind + ":" + (o.team || "") + ":" + roundCm(o.position.x) + ":" + roundCm(o.position.y);
      if (used[key]) return;
      used[key] = 1;
      out.push({
        kind: o.kind,
        team: o.team || null,
        letter: o.letter || (o.kind === "flag" ? "F" : "?"),
        position: { x: o.position.x, y: o.position.y, z: o.position.z || 0 }
      });
    }
    for (i = 0; i < (bases || []).length; i++) {
      b = bases[i];
      if (!b) continue;
      add({ kind: "flag", team: normalizeTeam(b.teamType || b.team), letter: "F", position: b.position });
    }
    for (i = 0; i < (extraPoints || []).length; i++) {
      item = extraPoints[i];
      if (!item) continue;
      add({ kind: "cp", team: null, letter: item.letter || "?", position: item.position });
    }
    out.sort(function (a, b) {
      return String(a.kind).localeCompare(b.kind) || String(a.letter).localeCompare(b.letter) || cmpVec(a.position, b.position);
    });
    return out;
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

  function exportBox(box) {
    var pos = vecToM(parseMapVec(box && (box.n7w_1 || (typeof box.n7v === "function" && box.n7v()))));
    var rot = parseMapVec(box && (box.o7w_1 || (typeof box.q7w === "function" && box.q7w())));
    var sizeRaw = parseMapVec(box && (box.p7w_1 || (typeof box.e1 === "function" && box.e1())));
    if (!pos || !sizeRaw) return null;
    var size = vecToM(sizeRaw);
    return { type: "box", position: pos, rotation: rot, size: size };
  }

  function exportPlane(plane) {
    var pos = vecToM(parseMapVec(plane && (plane.d7x_1 || (typeof plane.n7v === "function" && plane.n7v()))));
    var rot = parseMapVec(plane && (plane.e7x_1 || (typeof plane.q7w === "function" && plane.q7w())));
    if (!pos) return null;
    var length = plane.c7x_1, width = plane.f7x_1;
    return {
      type: "plane",
      position: pos,
      rotation: rot,
      length: isFiniteNum(length) ? toM(length) : null,
      width: isFiniteNum(width) ? toM(width) : null
    };
  }

  function exportTriangle(tri) {
    var pos = vecToM(parseMapVec(tri && (tri.m7x_1 || (typeof tri.n7v === "function" && tri.n7v()))));
    var rot = parseMapVec(tri && (tri.n7x_1 || (typeof tri.q7w === "function" && tri.q7w())));
    var v0 = vecToM(parseMapVec(tri && (tri.o7x_1 || (typeof tri.r7x === "function" && tri.r7x()))));
    var v1 = vecToM(parseMapVec(tri && (tri.p7x_1 || (typeof tri.s7x === "function" && tri.s7x()))));
    var v2 = vecToM(parseMapVec(tri && (tri.q7x_1 || (typeof tri.t7x === "function" && tri.t7x()))));
    if (!v0 || !v1 || !v2) return null;
    var w0 = pos ? add3(pos, rotateEuler(v0, rot)) : v0;
    var w1 = pos ? add3(pos, rotateEuler(v1, rot)) : v1;
    var w2 = pos ? add3(pos, rotateEuler(v2, rot)) : v2;
    return {
      type: "triangle",
      position: pos,
      rotation: rot,
      v0: v0, v1: v1, v2: v2,
      world: [w0, w1, w2]
    };
  }

  function exportCollisionGeometry(cg) {
    var boxes = [], planes = [], triangles = [], i, item;
    if (!cg) return { boxes: boxes, planes: planes, triangles: triangles };
    var boxList = unwrapList(typeof cg.x7w === "function" ? cg.x7w() : cg.u7w_1, ["u7w_1"]);
    var planeList = unwrapList(typeof cg.y7w === "function" ? cg.y7w() : cg.v7w_1, ["v7w_1"]);
    var triList = unwrapList(typeof cg.z7w === "function" ? cg.z7w() : cg.w7w_1, ["w7w_1"]);
    for (i = 0; i < boxList.length; i++) {
      item = exportBox(boxList[i]);
      if (item) boxes.push(item);
    }
    for (i = 0; i < planeList.length; i++) {
      item = exportPlane(planeList[i]);
      if (item) planes.push(item);
    }
    for (i = 0; i < triList.length; i++) {
      item = exportTriangle(triList[i]);
      if (item) triangles.push(item);
    }
    return { boxes: boxes, planes: planes, triangles: triangles };
  }

  function exportProp(prop) {
    if (!prop) return null;
    var name = null, groupName = null, libraryName = null;
    try { name = prop.y7y_1 || (typeof prop.m === "function" ? prop.m() : null); } catch (e) {}
    try { groupName = prop.u7y_1 || null; } catch (e2) {}
    try { libraryName = prop.w7y_1 || (typeof prop.c7v === "function" ? prop.c7v() : null); } catch (e3) {}
    if (typeof name !== "string") name = name != null ? String(name) : null;
    if (name && /hull|turret|chassis|tank|bonus|mine|shell|player/i.test(name)) return null;
    var pos = vecToM(parseMapVec(prop.z7y_1 || (typeof prop.n7v === "function" && prop.n7v())));
    var rot = parseMapVec(prop.a7z_1);
    var scale = parseMapVec(prop.b7z_1);
    if (!pos && !name) return null;
    var size = null;
    if (scale) {
      var looksUnit = Math.abs(scale.x) < 20 && Math.abs(scale.y) < 20 && Math.abs(scale.z) < 20;
      size = looksUnit ? { x: scale.x, y: scale.y, z: scale.z } : vecToM(scale);
    }
    return {
      name: name,
      groupName: typeof groupName === "string" ? groupName : null,
      libraryName: typeof libraryName === "string" ? libraryName : null,
      position: pos,
      rotation: rot,
      scale: scale,
      size: size
    };
  }

  function exportSpawn(sp) {
    if (!sp) return null;
    var pos = vecToM(parseMapVec(sp.m7z_1 || (typeof sp.n7v === "function" && sp.n7v())));
    if (!pos) return null;
    return {
      position: pos,
      rotation: parseMapVec(sp.n7z_1 || (typeof sp.q7w === "function" && sp.q7w())),
      type: enumName(sp.o7z_1)
    };
  }

  function slugName(name) {
    var s = (name || "map").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "");
    return s || "map";
  }

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

  function downloadJson(filename, data) {
    var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1500);
  }

  function buildMapExport() {
    var map = hooks.battleMap;
    var collision = { boxes: [], planes: [], triangles: [] };
    var collisionOutside = { boxes: [], planes: [], triangles: [] };
    var props = [], spawns = [], bases = [];
    var i, item, list, cg, outside, sg;

    var source = "battleMap";
    if (map) {
      try { cg = map.b7w_1 || (typeof map.g7w === "function" && map.g7w()); } catch (e) { cg = null; }
      try { outside = map.c7w_1 || (typeof map.h7w === "function" && map.h7w()); } catch (e2) { outside = null; }
      try { sg = map.f7w_1 || (typeof map.j7w === "function" && map.j7w()); } catch (e3) { sg = null; }
      if (cg) collision = exportCollisionGeometry(cg);
      if (outside) collisionOutside = exportCollisionGeometry(outside);
      list = unwrapList(sg && (typeof sg.u7z === "function" ? sg.u7z() : sg.t7z_1), ["t7z_1"]);
      for (i = 0; i < list.length; i++) {
        item = exportProp(list[i]);
        if (item) props.push(item);
      }
      list = unwrapList(map.e7w_1 && (typeof map.e7w_1.r7z === "function" ? map.e7w_1.r7z() : map.e7w_1.q7z_1), ["q7z_1", "e7w_1"]);
      if (!list.length) list = unwrapList(map.e7w_1, ["q7z_1"]);
      for (i = 0; i < list.length; i++) {
        item = exportSpawn(list[i]);
        if (item) spawns.push(item);
      }
    }

    if (!map || (collision.boxes.length + collision.planes.length + collision.triangles.length) === 0) {
      var phys = collectStaticPrimitives(true);
      if (phys.boxes.length || phys.planes.length || phys.triangles.length) {
        collision = { boxes: phys.boxes, planes: phys.planes, triangles: phys.triangles };
        source = map ? "battleMap+physics" : "physicsWorld";
      }
    }

    for (i = 0; i < mapTeamPoints.length; i++) {
      try {
        item = mapTeamPoints[i];
        if (item.oir_1 != null) continue;
        var pos = vecToM(parseMapVec(item.xin_1));
        if (!pos) continue;
        bases.push({
          position: pos,
          teamType: enumName(item.zin_1),
          id: item.yin_1 != null ? item.yin_1 : null
        });
      } catch (e4) {}
    }

    var objectives = buildObjectives(bases, spawns, mapControlPoints);
    logDebug("objectives n=" + objectives.length + " cp=" + objectives.filter(function (o) { return o.kind === "cp"; }).map(function (o) { return o.letter; }).join(",") + " flags=" + objectives.filter(function (o) { return o.kind === "flag"; }).length + " liveCp=" + mapControlPoints.length);
    var mapName = hooks.mapName || "unknown";
    var payload = {
      format: "tanki-map-v1",
      unitToMeter: UNIT,
      mapName: mapName,
      source: source,
      exportedAt: new Date().toISOString(),
      collision: collision,
      collisionOutside: collisionOutside,
      props: props,
      spawns: spawns,
      bases: bases,
      objectives: objectives,
      bounds: null
    };
    payload.bounds = collectBounds(payload);
    payload.counts = {
      boxes: collision.boxes.length,
      planes: collision.planes.length,
      triangles: collision.triangles.length,
      boxesOutside: collisionOutside.boxes.length,
      planesOutside: collisionOutside.planes.length,
      trianglesOutside: collisionOutside.triangles.length,
      props: props.length,
      spawns: spawns.length,
      bases: bases.length,
      objectives: objectives.length
    };
    return payload;
  }

  function exportMap() {
    if (!hooks.battleMap || !hooks.mapName) {
      try { scanGraph(400); } catch (e) { scanStats.lastError = String(e && e.message || e); }
    }
    var data = buildMapExport();
    var nPrim = (data.counts.boxes + data.counts.planes + data.counts.triangles);
    if (nPrim === 0) {
      var err = {
        ok: false,
        error: "Статику карты не нашла (ни BattleMap, ни тела physicsWorld). Кинь toCoords.mapDebug().",
        mapDebug: mapDebug()
      };
      lastMapExport = err;
      console.warn("[toCoords.exportMap]", err);
      return err;
    }
    var file = "tanki-map-" + slugName(data.mapName) + ".json";
    downloadJson(file, data);
    var result = {
      ok: true,
      file: file,
      mapName: data.mapName,
      source: data.source,
      counts: data.counts,
      bounds: data.bounds,
      note: "Только статика карты, без танков и игроков. Открой map-view.html и загрузи этот JSON."
    };
    lastMapExport = result;
    console.log("[toCoords.exportMap]", result);
    return result;
  }

  function mapDebug() {
    var prims = collectStaticPrimitives(true);
    function sample(list, n) {
      var out = [], i, it, s;
      for (i = 0; i < list.length && out.length < n; i++) {
        it = list[i];
        s = { type: it.type || it.kind };
        if (it.position) s.position = it.position;
        if (it.size) s.size = it.size;
        if (it.name) s.name = it.name;
        if (it.world) s.world0 = it.world[0];
        out.push(s);
      }
      return out;
    }
    var typeHist = {}, groupHist = {}, accelShapes, i, typ;
    try {
      accelShapes = collectStaticShapes();
      for (i = 0; i < accelShapes.shapes.length; i++) {
        typ = String(accelShapes.shapes[i].l9j_1);
        typeHist[typ] = (typeHist[typ] || 0) + 1;
        typ = String(accelShapes.shapes[i].p9j_1);
        groupHist[typ] = (groupHist[typ] || 0) + 1;
      }
    } catch (eAcc) { accelShapes = { shapes: [], stats: { error: String(eAcc && eAcc.message || eAcc) } }; }
    var payload = {
      battleMap: !!hooks.battleMap,
      mapName: hooks.mapName || "unknown",
      worlds: getCollisionWorlds().length,
      hasB9m: worldHasFn("b9m"),
      hasZ9l: worldHasFn("z9l"),
      hasJ9o: worldHasFn("j9o"),
      bodyListSize: prims.bodyListSize,
      staticBodies: prims.staticBodies,
      dynamicSkipped: prims.dynamicBodies,
      staticBodyDetails: (function () { try { return describeStaticBodies(listAllBodies()); } catch (e) { return []; } })(),
      accel: accelShapes.stats,
      accelShapeCount: accelShapes.shapes.length,
      accelTypeHist: typeHist,
      accelGroupHist: groupHist,
      sampleAccelShapes: (function () {
        var out = [], k;
        for (k = 0; k < accelShapes.shapes.length && out.length < 8; k++) out.push(describeShape(accelShapes.shapes[k]));
        return out;
      })(),
      primitives: {
        boxes: prims.boxes.length,
        planes: prims.planes.length,
        triangles: prims.triangles.length
      },
      sampleBoxes: sample(prims.boxes, 5),
      samplePlanes: sample(prims.planes, 3),
      sampleTriangles: sample(prims.triangles, 5),
      note: "Только статика. Тела с ECS-сущностью (танки и т.п.) не входят. Сетка b9m — zi.w9n_1 / v9n_1."
    };
    try {
      if (mapCache.data) payload.minimapSurfaces = collectMinimapSurfaces(mapCache.data).stats;
    } catch (eSurf) { payload.minimapSurfacesError = String(eSurf && eSurf.message || eSurf); }
    payload.controlPoints = mapControlPoints.map(function (c) { return { letter: c.letter, x: c.position && c.position.x, y: c.position && c.position.y }; });
    payload.objectives = (mapCache.data && mapCache.data.objectives) || [];
    console.log("[toCoords.mapDebug]", payload);
    return payload;
  }

  var capturedListeners = [];
  var capturedListenerSet = typeof Set === "function" ? new Set() : null;
  var scanCursor = { queue: null, seen: null };
  var gameReady = false;
  var lastScanResetAt = 0;
  var posMissingSince = 0;
  var burstFramesLeft = 0;
  var lastBurstAt = 0;
  var SCAN_SKIP_KEYS = {
    w9n_1: 1, v9n_1: 1, u9n_1: 1, y9n_1: 1, l9p_1: 1, f9q_1: 1, w9q_1: 1,
    q9m_1: 1, o9i_1: 1, a9o_1: 1, p102_1: 1,
    kir_1: 1, lir_1: 1, flagCarrierId: 1, flagPosition: 1
  };
  var MINIMAP_ID = "to-coords-minimap";
  var MINIMAP_SIZE = 300;
  var COS35 = Math.cos(35 * Math.PI / 180);
  var TANK_WIDTH_M = 3.5;
  var nextMinimapAt = 0;
  var nextLiveWalkAt = 0;
  var nextTreesAt = 0;
  var minimapCostMs = 0; // running average of drawMinimap() time
  function minimapFrame(now) {
    if (!minimap.on || now < nextMinimapAt) return;
    var t0 = performance.now();
    try { drawMinimap(); } catch (eMin) {}
    var dt = performance.now() - t0;
    minimapCostMs = minimapCostMs ? minimapCostMs * 0.9 + dt * 0.1 : dt;
    // every frame while it costs < 3 ms, otherwise 30 / 15 fps
    nextMinimapAt = now + (minimapCostMs < 3 ? 0 : (minimapCostMs < 8 ? 33 : 66));
  }
  var mapCache = {
    data: null,
    jsPrims: null,
    id: null,
    source: null,
    folderHandle: null,
    needFolderClick: false,
    started: false,
    status: "",
    building: false,
    native: null,
    texture: null,
    textureId: null
  };
  var flagHudObjs = [];
  var flagTaken = {};
  var mapControlPoints = [];

  /* ---------- live control points (what the game's CP HUD shows) ----------
   * Runtime point object: name r11f_1, position s11f_1, owner y11f_1
   * (TEAM_A / TEAM_B / NEUTRAL), shown score a11g_1 (-100..100, the sign is the
   * side that is capturing), active d11g_1, battle teams x11f_1 (our team l10b_1).
   * Tank lists / counts on the point are not read. */
  var cpLive = [];
  var cpSign = { pos: "TEAM_B", neg: "TEAM_A" }; // game: score > 0 means TEAM_B
  function looksLikeCpRuntime(obj) {
    try {
      return !!(obj && typeof obj === "object" &&
        typeof obj.a11g_1 === "number" && typeof obj.z11f_1 === "number" && typeof obj.b11g_1 === "number" &&
        obj.y11f_1 && typeof obj.y11f_1 === "object" &&
        typeof obj.r11f_1 === "string" && obj.s11f_1 && typeof obj.s11f_1 === "object");
    } catch (e) { return false; }
  }
  function rememberCpRuntime(obj) {
    if (!looksLikeCpRuntime(obj) || cpLive.indexOf(obj) >= 0 || cpLive.length >= 16) return false;
    cpLive.push(obj);
    logDebug("cp live " + obj.r11f_1 + " (" + cpLive.length + ")");
    // the other points hang off the same battle world: look there right away
    if (!bfsScan.busy) { try { walkBattleWorld(obj.t11f_1, 6); } catch (e) {} }
    return true;
  }
  function enumStr(v) {
    try { return v == null ? "" : String(v); } catch (e) { return ""; }
  }
  function otherTeam(t) { return t === "TEAM_A" ? "TEAM_B" : "TEAM_A"; }
  function cpLiveStates() {
    var out = [], i, pt, pos, owner, score, local, name;
    for (i = 0; i < cpLive.length; i++) {
      pt = cpLive[i];
      if (hooks.physicsWorld && pt.t11f_1 && pt.t11f_1 !== hooks.physicsWorld && pt.t11f_1.zyv_1 !== hooks.physicsWorld) continue;
      pos = null;
      try { pos = vecToM(parseMapVec(pt.s11f_1)); } catch (e) {}
      if (!pos || !isFiniteNum(pos.x)) continue;
      owner = enumStr(pt.y11f_1);
      score = isFiniteNum(pt.a11g_1) ? Math.max(-100, Math.min(100, pt.a11g_1)) : 0;
      // A fully held point tells us which sign belongs to which team.
      if ((owner === "TEAM_A" || owner === "TEAM_B") && Math.abs(score) >= 99.5) {
        if (score > 0) { cpSign.pos = owner; cpSign.neg = otherTeam(owner); }
        else { cpSign.neg = owner; cpSign.pos = otherTeam(owner); }
      }
      local = "";
      try { local = enumStr(pt.x11f_1 && pt.x11f_1.l10b_1); } catch (e2) {}
      name = pt.r11f_1 || "";
      out.push({
        pos: pos,
        letter: letterFromPointMeta(name, null) || (name ? name.charAt(0).toUpperCase() : "?"),
        owner: owner === "TEAM_A" || owner === "TEAM_B" ? owner : null,
        score: score,
        capTeam: score > 0 ? cpSign.pos : (score < 0 ? cpSign.neg : null),
        local: local,
        active: pt.d11g_1 !== false
      });
    }
    return out;
  }
  /* ---------- live CTF flags (what the game's flag markers show) ----------
   * Flag object: state z133_1 (AT_BASE / DROPPED / CARRIED / EXILED / FLYING),
   * team u133_1, battle teams q13b_1 (our team l10b_1), screen marker t13b_1
   * (hOt: position r133_1 = flag + 3 m, rule k133_1(pos) = isFlagMarkerVisible).
   * The marker rule is the game's own: carried/dropped flag farther than 75 m
   * from the camera (or a highlighted carrier). We show a flag only when that
   * rule says the game shows its marker. The carrier id is not read. */
  var flagLive = [];
  function looksLikeFlagObj(obj) {
    try {
      var m = obj && obj.t13b_1;
      return !!(m && typeof m === "object" && m.r133_1 && typeof m.k133_1 === "function" &&
        obj.z133_1 && typeof obj.z133_1 === "object" && obj.u133_1 && typeof obj.u133_1 === "object");
    } catch (e) { return false; }
  }
  function rememberFlagObj(obj) {
    if (!looksLikeFlagObj(obj) || flagLive.indexOf(obj) >= 0 || flagLive.length >= 6) return;
    flagLive.push(obj);
    logDebug("flag live " + enumStr(obj.u133_1) + " " + enumStr(obj.z133_1));
  }
  function flagLiveStates() {
    var out = [], i, f, m, pos, st, shown;
    for (i = 0; i < flagLive.length; i++) {
      f = flagLive[i];
      try {
        if (hooks.physicsWorld && f.v133_1 && f.v133_1 !== hooks.physicsWorld && f.v133_1.zyv_1 !== hooks.physicsWorld) continue;
        m = f.t13b_1;
        st = enumStr(f.z133_1);
        if (st !== "CARRIED" && st !== "DROPPED") continue;
        shown = false;
        try { shown = !!m.k133_1(m.r133_1); } catch (eV) { shown = false; }
        if (!shown) continue;
        pos = vecToM(parseMapVec(m.r133_1));
        if (!pos) continue;
        out.push({ key: f, pos: pos, state: st, team: enumStr(f.u133_1), local: enumStr(f.q13b_1 && f.q13b_1.l10b_1) });
      } catch (e) {}
    }
    return out;
  }

  /* ---------- battle format (parkour) ----------
   * Battle parameters object: typed slots { gzl_1: name, hzl_1: value }, one of
   * them is "parkourMode" (the game's own flag for the parkour format). */
  var battleParams = null;
  function rememberBattleParams(obj) {
    try {
      if (obj && obj.qzd_1 && obj.qzd_1.gzl_1 === "parkourMode" && obj.pzd_1 && obj.pzd_1.gzl_1 === "spectatorMode") {
        if (battleParams !== obj) { battleParams = obj; logDebug("battle params found, parkour=" + obj.qzd_1.hzl_1); }
      }
    } catch (e) {}
  }
  // BattlefieldCC (battle data: customBattleName zib_1, formatName bic_1,
  // parkourMode hic_1, map d8f()) — found by the ordinary scan.
  var battlefieldCC = null;
  function rememberBattlefieldCC(obj) {
    try {
      if (obj && typeof obj.d8f === "function" && typeof obj.hic_1 === "boolean" && "bic_1" in obj && "zib_1" in obj) {
        if (battlefieldCC !== obj) {
          battlefieldCC = obj;
          logDebug("battle data found, format=" + obj.bic_1 + " parkour=" + obj.hic_1);
        }
      }
    } catch (e) {}
  }
  // Battle map component (j8): b103(..., parkourMode, ...) stores it in m102_1
  // (in parkour the game also makes the out-of-map geometry solid).
  var mapComp = null;
  function rememberMapComp(obj) {
    try {
      if (obj && typeof obj.m102_1 === "boolean" && typeof obj.h10y === "function" && obj.p102_1 && obj.o102_1) {
        if (mapComp !== obj) { mapComp = obj; logDebug("battle map component found, parkour=" + obj.m102_1); }
      }
    } catch (e) {}
  }
  function parkourKnown() { return !!(battleParams || battlefieldCC || mapComp); }
  function battleFormatName() {
    try { if (battlefieldCC) return String(battlefieldCC.bic_1); } catch (e) {}
    if (mapComp) return mapComp.m102_1 ? "паркур" : "не паркур";
    if (battleParams) return battleParams.qzd_1 && battleParams.qzd_1.hzl_1 ? "паркур" : "не паркур";
    return "?";
  }
  function isParkour() {
    try { if (battleParams && battleParams.qzd_1 && battleParams.qzd_1.hzl_1 === true) return true; } catch (e) {}
    try { if (battlefieldCC && (battlefieldCC.hic_1 === true || /PARKOUR|ПАРКУР/i.test(String(battlefieldCC.bic_1)))) return true; } catch (e2) {}
    try { if (mapComp && mapComp.m102_1 === true) return true; } catch (e3) {}
    return false;
  }

  /* ---------- parkour: no trees / bushes ----------
   * The map component keeps the vegetation in three lists: s102_1 = flat
   * sprite bushes (lowest "trees quality"), u102_1 / w102_1 = 3D trees. The
   * game's own quality switch shows/hides them with p3k(visible); m3k() reads
   * it. In parkour we hide all three and give the old visibility back after. */
  var treesHidden = []; // { o: object, was: boolean }
  function treeObjects() {
    var out = [], lists, i, j, arr;
    if (!mapComp) return out;
    lists = [mapComp.s102_1, mapComp.u102_1, mapComp.w102_1];
    for (i = 0; i < lists.length; i++) {
      try { arr = iterList(lists[i]); } catch (e) { arr = []; }
      for (j = 0; j < arr.length; j++) {
        if (arr[j] && typeof arr[j].p3k === "function" && typeof arr[j].m3k === "function") out.push(arr[j]);
      }
    }
    return out;
  }
  function restoreTrees() {
    for (var i = 0; i < treesHidden.length; i++) {
      try { treesHidden[i].o.p3k(treesHidden[i].was); } catch (e) {}
    }
    if (treesHidden.length) logDebug("parkour: trees restored (" + treesHidden.length + ")");
    treesHidden = [];
  }
  function applyParkourTrees() {
    if (OFF.trees || !isParkour() || !mapComp) {
      if (treesHidden.length) restoreTrees();
      return;
    }
    var objs = treeObjects(), i, o, known, k, n = 0;
    for (i = 0; i < objs.length; i++) {
      o = objs[i];
      known = false;
      for (k = 0; k < treesHidden.length; k++) if (treesHidden[k].o === o) { known = true; break; }
      try {
        if (!known) treesHidden.push({ o: o, was: !!o.m3k() });
        if (o.m3k()) { o.p3k(false); n++; } // the game may switch them back on (quality change)
      } catch (e) {}
    }
    if (n) logDebug("parkour: trees hidden (" + n + ")");
  }

  // Resumable search for the battle format, a few ms per frame, from the battle
  // world, our tank's entity (via the camera) and the game root, until one of
  // the three sources above turns up.
  var pkSearch = { q: null, seen: null, restarts: 0 };
  function parkourSearchDone() { return parkourKnown() && (!isParkour() || !!mapComp); }
  function parkourSearchStep(budgetMs) {
    if (parkourSearchDone()) { pkSearch.q = null; pkSearch.seen = null; return; }
    var t0 = performance.now(), n = 0, obj, keys, i, v;
    function push(o) {
      if (!o || typeof o !== "object" || pkSearch.seen.has(o)) return;
      pkSearch.seen.add(o);
      pkSearch.q.push(o);
    }
    if (!pkSearch.q || !pkSearch.q.length) {
      if (pkSearch.restarts > 20) return;
      pkSearch.restarts++;
      pkSearch.q = [];
      pkSearch.seen = new Set();
      try { var bw = battleWorld(); if (bw && bw.syw_1) push(bw.syw_1.s2a_1); push(bw); } catch (e0) {}
      push(hooks.physicsWorld);
      try { push(followCam && followCam.yz3_1); } catch (e1) {}
      push(hooks.radarSystem);
      push(hooks.battleMap);
      try { push(window.Launcher); } catch (e2) {}
    }
    while (pkSearch.q.length && n < 4000 && performance.now() - t0 < budgetMs) {
      obj = pkSearch.q.shift();
      n++;
      if (shouldSkip(obj)) continue;
      try { rememberLiveObjects(obj); rememberMapComp(obj); } catch (eV) {}
      if (parkourSearchDone()) { pkSearch.q = null; pkSearch.seen = null; return; }
      if (obj instanceof Map || obj instanceof Set) {
        try { var c = 0; obj.forEach(function (val) { if (c++ < 400) push(val); }); } catch (eM) {}
        continue;
      }
      try { keys = Object.getOwnPropertyNames(obj); } catch (eK) { continue; }
      if (keys.length > 400) continue;
      for (i = 0; i < keys.length; i++) {
        if (SCAN_SKIP_KEYS[keys[i]]) continue;
        try { v = obj[keys[i]]; } catch (eG) { continue; }
        if (v && typeof v === "object") push(v);
      }
    }
  }

  /* ---------- parkour camera (only in the parkour format) ----------
   * Follow camera: spline tzs_1 (W3) with 4 keys wzu_1..zzu_1 { uzu_1: distance,
   * vzu_1: height }, path position qzs_1, tzv(t) recomputes the offset (C3).
   * The multiplier azv_1 is reset by the game (camera reset, free-camera
   * controller), the keys never are: we scale the keys, so the camera moves
   * back along the same line of sight. Shift + "+" / "-". */
  var followCam = null;
  var followCams = [];
  var camKeysOrig = typeof WeakMap === "function" ? new WeakMap() : null;
  var parkourCam = { mult: 1, applied: false };
  try { var _pc = Number(localStorage.getItem("toCoords.parkourCam")); if (_pc >= 0.5 && _pc <= 8) parkourCam.mult = _pc; } catch (ePc) {}
  function camBody(cam) {
    try {
      var tp = cam && cam.lzs_1;
      var b = tp && (tp.mzq_1 || (typeof tp.fbk === "function" ? tp.fbk() : null));
      return b && b.v9i_1 ? b : null;
    } catch (e) { return null; }
  }
  function rememberFollowCam(obj) {
    try {
      if (obj && obj.tzs_1 && typeof obj.tzs_1.azv_1 === "number" && obj.tzs_1.wzu_1 && obj.tzs_1.zzu_1 &&
          typeof obj.qzs_1 === "number" && typeof obj.tzv === "function") {
        if (followCams.indexOf(obj) < 0) {
          followCams.push(obj);
          if (followCams.length > 4) followCams.shift();
          logDebug("follow camera found (" + followCams.length + ")");
        }
        // the one that follows OUR tank
        if (followCam !== obj && (!followCam || !maybeOwnBody(camBody(followCam))) && maybeOwnBody(camBody(obj))) followCam = obj;
      }
    } catch (e) {}
  }
  function camKeys(cam) {
    var sp = cam && cam.tzs_1;
    return sp ? [sp.wzu_1, sp.xzu_1, sp.yzu_1, sp.zzu_1] : [];
  }
  function setCamMult(cam, k) {
    try {
      var keys = camKeys(cam), i, orig;
      if (!keys.length || !keys[0]) return;
      orig = camKeysOrig && camKeysOrig.get(cam.tzs_1);
      if (!orig) {
        if (k === 1) return; // never touched: nothing to restore
        orig = keys.map(function (h) { return { u: h.uzu_1, v: h.vzu_1 }; });
        if (camKeysOrig) camKeysOrig.set(cam.tzs_1, orig);
      }
      if (Math.abs(keys[0].uzu_1 - orig[0].u * k) < 1e-6 && Math.abs(keys[0].vzu_1 - orig[0].v * k) < 1e-6) return;
      for (i = 0; i < keys.length; i++) {
        if (!keys[i] || !orig[i]) continue;
        keys[i].uzu_1 = orig[i].u * k;
        keys[i].vzu_1 = orig[i].v * k;
      }
      cam.tzv(cam.qzs_1); // same path position: only recomputes the offset
    } catch (e) {}
  }
  function applyParkourCam() {
    if (OFF.camera || !followCams.length) return;
    var i, parkour = isParkour();
    if (parkour) {
      for (i = 0; i < followCams.length; i++) {
        if (maybeOwnBody(camBody(followCams[i]))) setCamMult(followCams[i], parkourCam.mult);
      }
      parkourCam.applied = true;
    } else if (parkourCam.applied) {
      for (i = 0; i < followCams.length; i++) setCamMult(followCams[i], 1); // give the game its camera back
      parkourCam.applied = false;
    }
  }
  function bumpParkourCam(factor) {
    parkourCam.mult = Math.max(0.5, Math.min(8, Math.round(parkourCam.mult * factor * 100) / 100));
    try { localStorage.setItem("toCoords.parkourCam", String(parkourCam.mult)); } catch (e) {}
    applyParkourCam();
    logDebug("parkour camera x" + parkourCam.mult);
    minimap.flash = { text: "паркур: камера ×" + parkourCam.mult.toFixed(2), until: Date.now() + 1500 };
  }

  // The battle world (has the controller Map syw_1.s2a_1), from whatever we hold.
  function battleWorld() {
    var c = [hooks.physicsWorld], i, w;
    try { if (hooks.physicsBody && hooks.physicsBody.b9i_1) c.push(hooks.physicsBody.b9i_1.zz0_1); } catch (e) {}
    try { if (hooks.radarSystem && hooks.radarSystem.yz3_1) c.push(hooks.radarSystem.yz3_1.zz0_1); } catch (e2) {}
    for (i = 0; i < mountCandidates.length && i < 4; i++) {
      try { c.push(mountCandidates[i].yz3_1 && mountCandidates[i].yz3_1.zz0_1); } catch (e3) {}
    }
    for (i = 0; i < c.length; i++) {
      w = c[i];
      try { if (w && w.syw_1 && w.syw_1.s2a_1) return w; } catch (e4) {}
    }
    return null;
  }
  function walkBattleWorld(w, budgetMs) {
    if (!w) return;
    var seeds = [];
    try { if (w.syw_1 && w.syw_1.s2a_1) seeds.push(w.syw_1.s2a_1); } catch (e) {}
    seeds.push(w);
    bfsScan(seeds, budgetMs, 3000, rememberLiveObjects);
  }

  /* ---------- Magnum aim (own tank only: what the game draws while aiming) ----------
   * Aim system: state k1ab_1 ("Stopped" / "Started" / "StartedIndicating"),
   * trajectory points o1ab_1 (list, item.b14v_1 = position), count t1ab_1,
   * landing hit s1ab_1 (j9q_1 = point), surface mark i1ab_1 (m3k() = shown),
   * our tank body c1ab_1. It sits in the world's controller Map only while aiming.
   * The game's own enemy-highlight (r1ab_1) is not read. */
  var magnumAim = null;
  // false only when we can tell the body is somewhere else (> 8 m from us)
  function maybeOwnBody(b) {
    if (!b || b === hooks.physicsBody || !lastMeEngine) return true;
    var bp = bodyPos(b);
    if (!bp) return true;
    return Math.abs(bp.x - lastMeEngine.x) + Math.abs(bp.y - lastMeEngine.y) + Math.abs(bp.z - lastMeEngine.z) < 800;
  }
  function rememberMagnumAim(obj) {
    try {
      if (obj && obj.s1ab_1 && obj.s1ab_1.j9q_1 && typeof obj.t1ab_1 === "number" && obj.o1ab_1 && obj.k1ab_1 &&
          obj.i1ab_1 && typeof obj.i1ab_1.m3k === "function" && typeof obj.m1ab_1 === "boolean") {
        if (!maybeOwnBody(obj.c1ab_1)) return; // another tank's
        if (magnumAim !== obj) { magnumAim = obj; logDebug("magnum aim found"); }
      }
    } catch (e) {}
  }
  function magnumAimState() {
    var a = magnumAim;
    if (!a) return null;
    try {
      if (!maybeOwnBody(a.c1ab_1)) { magnumAim = null; return null; }
      if (enumStr(a.k1ab_1) !== "StartedIndicating") return null; // the game is not showing it
      var pts = [], n = Math.min(a.t1ab_1 | 0, 1000), list = a.o1ab_1, i, it, v;
      for (i = 0; i < n; i += 2) {
        it = null;
        try { it = list.g1(i); } catch (eG) { break; }
        v = it && vecToM(parseMapVec(it.b14v_1));
        if (v) pts.push(v);
      }
      var land = null;
      try { if (a.i1ab_1.m3k()) land = vecToM(parseMapVec(a.s1ab_1.j9q_1)); } catch (eL) {}
      return { pts: pts, land: land };
    } catch (e) { return null; }
  }
  function drawMagnumAim(ctx, toScreen) {
    var st = magnumAimState();
    if (!st) return;
    var i, p;
    ctx.save();
    ctx.fillStyle = "#ffb000";
    for (i = 0; i < st.pts.length; i++) {
      p = toScreen(st.pts[i].x, st.pts[i].y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (st.land) {
      p = toScreen(st.land.x, st.land.y);
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

  // Everything that lives in the battle world's controller Map.
  function rememberLiveObjects(obj) {
    rememberCpRuntime(obj);
    rememberFlagObj(obj);
    rememberBattleParams(obj);
    rememberFollowCam(obj);
    rememberMagnumAim(obj);
    rememberBattlefieldCC(obj);
    rememberMapComp(obj);
  }

  // Our team name (TEAM_A / TEAM_B) from any live object that knows it.
  function localTeamName() {
    var i, t;
    for (i = 0; i < flagLive.length; i++) {
      t = enumStr(flagLive[i].q13b_1 && flagLive[i].q13b_1.l10b_1);
      if (t === "TEAM_A" || t === "TEAM_B") return t;
    }
    for (i = 0; i < cpLive.length; i++) {
      t = enumStr(cpLive[i].x11f_1 && cpLive[i].x11f_1.l10b_1);
      if (t === "TEAM_A" || t === "TEAM_B") return t;
    }
    return "";
  }

  // Ours blue, theirs red (like the radar); spectators: TEAM_A red, TEAM_B blue.
  function cpTeamColor(team, local) {
    if (team !== "TEAM_A" && team !== "TEAM_B") return "#8a8a8a";
    if (local === "TEAM_A" || local === "TEAM_B") return team === local ? "#1e6bff" : "#ff2a2a";
    return team === "TEAM_A" ? "#ff2a2a" : "#1e6bff";
  }

  // Small breadth-first walk that also looks inside JS Map / Set values.
  function bfsScan(seeds, budgetMs, maxNodes, visit) {
    if (bfsScan.busy) return;
    bfsScan.busy = true;
    try { bfsScanInner(seeds, budgetMs, maxNodes, visit); } finally { bfsScan.busy = false; }
  }
  function bfsScanInner(seeds, budgetMs, maxNodes, visit) {
    var t0 = performance.now(), q = [], seen = new Set(), n = 0, obj, keys, i, v;
    function push(o) {
      if (!o || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) return;
      seen.add(o);
      q.push(o);
    }
    for (i = 0; i < seeds.length; i++) push(seeds[i]);
    while (q.length && n < maxNodes && performance.now() - t0 < budgetMs) {
      obj = q.shift();
      n++;
      if (shouldSkip(obj)) continue;
      try { visit(obj); } catch (eV) {}
      if (obj instanceof Map || obj instanceof Set) {
        try { var c = 0; obj.forEach(function (val) { if (c++ < 400) push(val); }); } catch (eM) {}
        continue;
      }
      try { keys = Object.getOwnPropertyNames(obj); } catch (eK) { continue; }
      if (keys.length > 400) continue;
      for (i = 0; i < keys.length; i++) {
        if (SCAN_SKIP_KEYS[keys[i]]) continue;
        try { v = obj[keys[i]]; } catch (eG) { continue; }
        if (v && typeof v === "object") push(v);
      }
    }
  }
  var battle = { inBattle: false, id: 0, posGoneSince: 0, worldRef: null, mapName: null };
  var worldCandidates = [];
  // Worlds we already switched away from. Never switch back to them, or two live worlds ping-pong forever.
  var retiredWorlds = typeof WeakSet === "function" ? new WeakSet() : null;
  var retiredWorldList = [];
  function isRetiredWorld(w) {
    return retiredWorlds ? retiredWorlds.has(w) : retiredWorldList.indexOf(w) >= 0;
  }
  function unretireWorld(w) {
    if (!w) return;
    if (retiredWorlds) retiredWorlds.delete(w);
    else { var k = retiredWorldList.indexOf(w); if (k >= 0) retiredWorldList.splice(k, 1); }
  }
  function retireWorld(w) {
    if (!w || isRetiredWorld(w)) return;
    if (retiredWorlds) retiredWorlds.add(w);
    else { retiredWorldList.push(w); if (retiredWorldList.length > 20) retiredWorldList.shift(); }
  }
  var battleWatch = {
    lastCheck: 0, worldRef: null, mapRef: null, bodyRef: null,
    lastPos: null, lastPosChangeAt: 0, lastPhysicsUpdateAt: 0, lastBodySig: null,
    strayedSince: 0, strayed: false, posNullSince: 0, posStale: false, bodiesWorld: null
  };
  var nativeState = { seq: 0, pending: {}, ready: null };
  var minimap = {
    on: true,
    zoom: 2,
    follow: true,
    flipX: false,
    flipY: false,
    rotate: 0,
    left: null,
    top: 8,
    right: 8,
    wrap: null,
    canvas: null,
    statusEl: null,
    offscreen: null,
    bounds: null,
    scale: 1,
    builtFor: null,
    dragging: false,
    dragDx: 0,
    dragDy: 0,
    w: 300,
    h: 300,
    drive: false,
    outlines: null,
    driveCanvas: null,
    driveMask: null,
    resizing: false,
    hover: false
  };
  var MINIMAP_PRESETS = { S: 240, M: 320, L: 440, XL: 640 };
  var MINIMAP_MIN = 200;
  var MINIMAP_MAX = 900;

  function loadMinimapLayout() {
    try {
      var s = JSON.parse(localStorage.getItem("toCoords.minimap") || "null");
      if (!s || typeof s !== "object") return;
      if (isFiniteNum(s.w)) minimap.w = Math.max(MINIMAP_MIN, Math.min(MINIMAP_MAX, s.w));
      if (isFiniteNum(s.h)) minimap.h = Math.max(MINIMAP_MIN, Math.min(MINIMAP_MAX, s.h));
      if (isFiniteNum(s.left)) minimap.left = s.left;
      if (isFiniteNum(s.top)) minimap.top = s.top;
      if (isFiniteNum(s.zoom)) minimap.zoom = s.zoom;
      // follow / drive have no buttons any more: zoomed in = follow the tank,
      // x1 = whole map; drive mode only via toCoords.minimap({drive:true}).
    } catch (e) {}
  }
  function saveMinimapLayout() {
    try {
      localStorage.setItem("toCoords.minimap", JSON.stringify({
        w: minimap.w, h: minimap.h, left: minimap.left, top: minimap.top,
        zoom: minimap.zoom, follow: minimap.follow, drive: !!minimap.drive
      }));
    } catch (e) {}
  }
  loadMinimapLayout();

  function rememberCapturedListener(fn) {
    if (typeof fn !== "function") return;
    try {
      if (capturedListenerSet) {
        if (capturedListenerSet.has(fn)) return;
        capturedListenerSet.add(fn);
      } else if (capturedListeners.indexOf(fn) >= 0) {
        return;
      }
      if (capturedListeners.length > 2500) capturedListeners.shift();
      capturedListeners.push(fn);
    } catch (e) {}
  }

  function installListenerCapture() {
    if (OFF.listeners) return;
    try {
      if (typeof EventTarget === "undefined" || !EventTarget.prototype) return;
      var orig = EventTarget.prototype.addEventListener;
      if (typeof orig !== "function" || orig.__toCoords) return;
      function wrapped(type, listener, options) {
        try {
          var fn = listener;
          if (fn && typeof fn === "object" && typeof fn.handleEvent === "function") fn = fn.handleEvent;
          rememberCapturedListener(fn);
        } catch (e) {}
        return orig.call(this, type, listener, options);
      }
      wrapped.__toCoords = true;
      EventTarget.prototype.addEventListener = wrapped;
    } catch (e2) {}
  }

  function isPosHooked() {
    return !!(hooks.getLocalTankPosition || hooks.showPositionLocalTank || ownBodyFromCamera());
  }

  function matFromEuler(e) {
    var x = rotateEuler({ x: 1, y: 0, z: 0 }, e);
    var y = rotateEuler({ x: 0, y: 1, z: 0 }, e);
    var z = rotateEuler({ x: 0, y: 0, z: 1 }, e);
    return { g22: x.x, h22: x.y, i22: x.z, j22: y.x, k22: y.y, l22: y.z, m22: z.x, n22: z.y, o22: z.z };
  }

  function roundCm(n) {
    if (typeof n !== "number" || !isFinite(n)) return n;
    return Math.round(n * 100) / 100;
  }

  function roundVecCm(v) {
    if (!v || !isFiniteNum(v.x)) return v;
    return { x: roundCm(v.x), y: roundCm(v.y), z: isFiniteNum(v.z) ? roundCm(v.z) : 0 };
  }

  function cmpNum(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function cmpVec(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    return cmpNum(a.x, b.x) || cmpNum(a.y, b.y) || cmpNum(a.z, b.z);
  }

  function stabilizeMapData(data) {
    function stabTri(t) {
      var w = (t.world || [t.v0, t.v1, t.v2]).map(roundVecCm);
      return { type: "triangle", name: t.name || null, position: null, rotation: null, v0: w[0], v1: w[1], v2: w[2], world: w };
    }
    function stabBox(b) {
      var corners = (b.corners || []).map(roundVecCm);
      return {
        type: "box",
        name: b.name || null,
        position: roundVecCm(b.position),
        rotation: b.rotation ? { x: roundCm(b.rotation.x), y: roundCm(b.rotation.y), z: roundCm(b.rotation.z) } : { x: 0, y: 0, z: 0 },
        size: roundVecCm(b.size),
        corners: corners
      };
    }
    function stabPlane(p) {
      return {
        type: "plane",
        name: p.name || null,
        position: roundVecCm(p.position),
        rotation: p.rotation ? { x: roundCm(p.rotation.x), y: roundCm(p.rotation.y), z: roundCm(p.rotation.z) } : { x: 0, y: 0, z: 0 },
        length: roundCm(p.length),
        width: roundCm(p.width)
      };
    }
    function sortTris(a, b) { return cmpVec(a.v0, b.v0) || cmpVec(a.v1, b.v1) || cmpVec(a.v2, b.v2); }
    function sortBoxes(a, b) { return cmpVec(a.position, b.position) || cmpVec(a.size, b.size); }
    function sortPlanes(a, b) { return cmpVec(a.position, b.position) || cmpNum(a.length, b.length) || cmpNum(a.width, b.width); }
    function stabGeom(g) {
      if (!g) return { boxes: [], planes: [], triangles: [] };
      return {
        boxes: (g.boxes || []).map(stabBox).sort(sortBoxes),
        planes: (g.planes || []).map(stabPlane).sort(sortPlanes),
        triangles: (g.triangles || []).map(stabTri).sort(sortTris)
      };
    }
    var collision = stabGeom(data.collision);
    var out = {
      _help: "tanki-map-v1. Coordinates are metres, rounded to 0.01. collision.triangles[].world = three {x,y,z} vertices. collision.boxes[] = position, size, rotation (radians XYZ), corners. collision.planes[] = position, rotation, length, width. objectives[] = static control points (kind=cp) and flag bases (kind=flag, team=RED|BLUE). Static geometry only, no tanks, no flag carriers. Hand-edits in tanki-ext/maps load on the next battle.",
      format: "tanki-map-v1",
      unitToMeter: UNIT,
      mapName: data.mapName || hooks.mapName || "unknown",
      source: data.source || "physicsWorld",
      exportedAt: data.exportedAt || new Date().toISOString(),
      collision: collision,
      collisionOutside: stabGeom(data.collisionOutside),
      props: data.props || [],
      spawns: data.spawns || [],
      bases: data.bases || [],
      objectives: data.objectives || buildObjectives(data.bases || [], data.spawns || [], []),
      bounds: null,
      counts: null
    };
    out.bounds = collectBounds(out);
    if (out.bounds) {
      out.bounds = {
        min: roundVecCm(out.bounds.min),
        max: roundVecCm(out.bounds.max)
      };
    }
    out.counts = {
      boxes: collision.boxes.length,
      planes: collision.planes.length,
      triangles: collision.triangles.length,
      boxesOutside: out.collisionOutside.boxes.length,
      planesOutside: out.collisionOutside.planes.length,
      trianglesOutside: out.collisionOutside.triangles.length,
      props: out.props.length,
      spawns: out.spawns.length,
      bases: out.bases.length,
      objectives: (out.objectives || []).length
    };
    return out;
  }

  function geometryHash(data) {
    var parts = [];
    var b = data && data.bounds;
    var c = data && data.counts;
    if (b && b.min && b.max) {
      parts.push(roundCm(b.min.x), roundCm(b.min.y), roundCm(b.min.z), roundCm(b.max.x), roundCm(b.max.y), roundCm(b.max.z));
    }
    if (c) parts.push(c.boxes || 0, c.planes || 0, c.triangles || 0);
    var tris = data && data.collision && data.collision.triangles || [];
    var i, w, n = Math.min(32, tris.length);
    for (i = 0; i < n; i++) {
      w = tris[i].world || [tris[i].v0, tris[i].v1, tris[i].v2];
      if (!w || !w[0]) continue;
      parts.push(roundCm(w[0].x), roundCm(w[0].y), roundCm(w[0].z));
    }
    var s = parts.join(","), h = 2166136261, ch;
    for (i = 0; i < s.length; i++) {
      ch = s.charCodeAt(i);
      h ^= ch;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function mapFileId(data) {
    var name = (hooks.mapName && hooks.mapName !== "unknown") ? hooks.mapName : (data && data.mapName);
    if (name && name !== "unknown") return slugName(name);
    return "h" + geometryHash(data || {});
  }

  function mapJsonToJsPrims(data) {
    var jsBoxes = [], jsPlanes = [], jsTris = [];
    var g = data && data.collision;
    if (!g) return { jsBoxes: jsBoxes, jsPlanes: jsPlanes, jsTris: jsTris };
    var i, b, p, t, w, pos, mat, he;
    var boxes = g.boxes || [];
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      if (!b || !b.position || !b.size) continue;
      pos = { x: b.position.x / UNIT, y: b.position.y / UNIT, z: b.position.z / UNIT };
      mat = matFromEuler(b.rotation);
      he = { x: (b.size.x / 2) / UNIT, y: (b.size.y / 2) / UNIT, z: (b.size.z / 2) / UNIT };
      jsBoxes.push({ kind: "box", name: b.name, pos: pos, mat: mat, he: he, euler: b.rotation || { x: 0, y: 0, z: 0 } });
    }
    var planes = g.planes || [];
    for (i = 0; i < planes.length; i++) {
      p = planes[i];
      if (!p || !p.position) continue;
      pos = { x: p.position.x / UNIT, y: p.position.y / UNIT, z: p.position.z / UNIT };
      mat = matFromEuler(p.rotation);
      he = { x: ((p.length || 0) / 2) / UNIT, y: ((p.width || 0) / 2) / UNIT, z: 0 };
      jsPlanes.push({ kind: "plane", name: p.name, pos: pos, mat: mat, he: he, euler: p.rotation || { x: 0, y: 0, z: 0 } });
    }
    var tris = g.triangles || [];
    for (i = 0; i < tris.length; i++) {
      t = tris[i];
      w = t && (t.world || [t.v0, t.v1, t.v2]);
      if (!w || !w[0] || !w[1] || !w[2]) continue;
      jsTris.push({
        kind: "triangle",
        name: t.name,
        w0: { x: w[0].x / UNIT, y: w[0].y / UNIT, z: w[0].z / UNIT },
        w1: { x: w[1].x / UNIT, y: w[1].y / UNIT, z: w[1].z / UNIT },
        w2: { x: w[2].x / UNIT, y: w[2].y / UNIT, z: w[2].z / UNIT }
      });
    }
    return { jsBoxes: jsBoxes, jsPlanes: jsPlanes, jsTris: jsTris };
  }

  function applyMapData(data, source) {
    if (!data || !data.collision) return false;
    var stable = stabilizeMapData(data);
    var n = (stable.counts.boxes + stable.counts.planes + stable.counts.triangles);
    if (n === 0) return false;
    mapCache.data = stable;
    mapCache.jsPrims = mapJsonToJsPrims(stable);
    mapCache.id = mapFileId(stable);
    mapCache.source = source || stable.source || "file";
    mapCache.status = (stable.mapName || mapCache.id) + " · " + n;
    minimap.builtFor = null;
    return true;
  }

  function getJsRayPrims() {
    if (mapCache.jsPrims && (mapCache.jsPrims.jsTris.length || mapCache.jsPrims.jsBoxes.length || mapCache.jsPrims.jsPlanes.length)) {
      return {
        jsBoxes: mapCache.jsPrims.jsBoxes,
        jsPlanes: mapCache.jsPrims.jsPlanes,
        jsTris: mapCache.jsPrims.jsTris,
        boxes: (mapCache.data && mapCache.data.collision.boxes) || [],
        planes: (mapCache.data && mapCache.data.collision.planes) || [],
        triangles: (mapCache.data && mapCache.data.collision.triangles) || []
      };
    }
    return collectStaticPrimitives(false);
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") {
        reject(new Error("no indexedDB"));
        return;
      }
      var req = indexedDB.open("toCoords", 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("maps")) db.createObjectStore("maps");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbOp(store, mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var st = tx.objectStore(store);
        var req = fn(st);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbGetMap(id) { return idbOp("maps", "readonly", function (st) { return st.get(id); }); }
  function idbPutMap(id, data) { return idbOp("maps", "readwrite", function (st) { return st.put(data, id); }); }
  function idbGetMeta(key) { return idbOp("meta", "readonly", function (st) { return st.get(key); }); }
  function idbPutMeta(key, val) { return idbOp("meta", "readwrite", function (st) { return st.put(val, key); }); }

  function mapFileName(id) {
    return "tanki-map-" + (id || "map") + ".json";
  }

  function mapPngName(id) {
    return "tanki-map-" + (id || "map") + ".png";
  }

  function installNativeListener() {
    if (installNativeListener.done) return;
    installNativeListener.done = true;
    window.addEventListener("message", function (ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d.type !== "TO_COORDS_NATIVE_RESULT") return;
      var cb = nativeState.pending[d.id];
      if (!cb) return;
      delete nativeState.pending[d.id];
      try { cb(d.result); } catch (e) {}
    });
  }

  function nativeCall(payload) {
    installNativeListener();
    return new Promise(function (resolve) {
      var id = ++nativeState.seq;
      var timer = setTimeout(function () {
        if (!nativeState.pending[id]) return;
        delete nativeState.pending[id];
        resolve({ ok: false, error: "timeout" });
      }, 4000);
      nativeState.pending[id] = function (res) {
        clearTimeout(timer);
        resolve(res || { ok: false, error: "empty" });
      };
      try {
        window.postMessage({ type: "TO_COORDS_NATIVE", id: id, payload: payload || {} }, "*");
      } catch (e) {
        clearTimeout(timer);
        delete nativeState.pending[id];
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function pingNative() {
    return nativeCall({ op: "ping" }).then(function (res) {
      nativeState.ready = !!(res && res.ok);
      if (res && res.ok) mapCache.native = res.mapsDir || true;
      return res;
    }).catch(function () {
      nativeState.ready = false;
      return { ok: false };
    });
  }

  function nativeReadJson(id) {
    return nativeCall({ op: "read", name: mapFileName(id) }).then(function (res) {
      if (!res || !res.ok || !res.text) return null;
      try { return JSON.parse(res.text); } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  function nativeWriteJson(id, data) {
    return nativeCall({ op: "write", name: mapFileName(id), text: JSON.stringify(data, null, 2) });
  }

  function nativeReadPng(id) {
    return nativeCall({ op: "readB64", name: mapPngName(id) }).then(function (res) {
      if (!res || !res.ok || !res.b64) return null;
      return "data:image/png;base64," + res.b64;
    }).catch(function () { return null; });
  }

  function nativeWritePng(id, dataUrl) {
    var m = String(dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return Promise.resolve({ ok: false, error: "bad png" });
    return nativeCall({ op: "writeB64", name: mapPngName(id), b64: m[1] });
  }

  function bundledUrl(name) {
    try {
      var base = document.documentElement.getAttribute("data-to-coords-maps");
      if (!base) return null;
      return base + name;
    } catch (e) { return null; }
  }

  function loadBundledJson(id) {
    var url = bundledUrl(mapFileName(id));
    if (!url) return Promise.resolve(null);
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function loadBundledPng(id) {
    var url = bundledUrl(mapPngName(id));
    if (!url) return Promise.resolve(null);
    return fetch(url).then(function (r) { return r.ok ? r.blob() : null; }).then(function (blob) {
      if (!blob) return null;
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { resolve(null); };
        reader.readAsDataURL(blob);
      });
    }).catch(function () { return null; });
  }

  function loadImageFromUrl(url) {
    if (!url) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  // "Is this picture basically black?" — checked on a 64x64 thumbnail, so we never
  // read back a multi-megapixel canvas (slow, and Chrome warns about it).
  function canvasMostlyEmpty(src) {
    if (!src || !src.width || !src.height) return true;
    try {
      var N = 64;
      var c = document.createElement("canvas");
      c.width = N;
      c.height = N;
      var g = c.getContext("2d", { willReadFrequently: true });
      g.imageSmoothingEnabled = false; // point samples, like the old per-pixel check
      g.drawImage(src, 0, 0, src.width, src.height, 0, 0, N, N);
      var data = g.getImageData(0, 0, N, N).data;
      var lit = 0, i;
      for (i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 90) lit++;
      }
      return (lit / (N * N)) < 0.05;
    } catch (e) { return false; }
  }

  function imageMostlyEmpty(img) {
    return canvasMostlyEmpty(img);
  }

  function attachMapTexture(id) {
    if (!id) return Promise.resolve(null);
    if (mapCache.texture && mapCache.textureId === id) return Promise.resolve(mapCache.texture);
    function take(url) { return loadImageFromUrl(url); }
    return nativeReadPng(id).then(function (url) {
      if (url) return take(url);
      return loadBundledPng(id).then(function (u2) { return u2 ? take(u2) : null; });
    }).then(function (img) {
      if (!img) return null;
      if (imageMostlyEmpty(img)) {
        logDebug("ignore empty cached png for " + id);
        return null;
      }
      mapCache.texture = img;
      mapCache.textureId = id;
      return img;
    }).catch(function () { return null; });
  }

  function maybeSaveOffscreenPng() {
    if (!nativeState.ready || !minimap.offscreen || !mapCache.id) return;
    if (canvasMostlyEmpty(minimap.offscreen)) {
      logDebug("skip png save: offscreen empty");
      return;
    }
    var id = mapCache.id;
    nativeReadPng(id).then(function (existing) {
      if (existing) return;
      try {
        var url = minimap.offscreen.toDataURL("image/png");
        return nativeWritePng(id, url);
      } catch (e) {}
    }).catch(function () {});
  }

  function folderHasPermission(handle) {
    if (!handle || typeof handle.queryPermission !== "function") return Promise.resolve(false);
    return handle.queryPermission({ mode: "readwrite" }).then(function (s) { return s === "granted"; }).catch(function () { return false; });
  }

  function requestFolderPermission(handle) {
    if (!handle || typeof handle.requestPermission !== "function") return Promise.resolve(false);
    return handle.requestPermission({ mode: "readwrite" }).then(function (s) { return s === "granted"; }).catch(function () { return false; });
  }

  function readFolderMap(handle, id) {
    if (!handle || typeof handle.getFileHandle !== "function") return Promise.resolve(null);
    return handle.getFileHandle(mapFileName(id)).then(function (fh) {
      return fh.getFile();
    }).then(function (file) {
      return file.text();
    }).then(function (text) {
      return JSON.parse(text);
    }).catch(function () { return null; });
  }

  function writeFolderMap(handle, id, data) {
    if (!handle || typeof handle.getFileHandle !== "function") return Promise.resolve(false);
    var text = JSON.stringify(data, null, 2);
    return handle.getFileHandle(mapFileName(id), { create: true }).then(function (fh) {
      return fh.createWritable();
    }).then(function (w) {
      return w.write(text).then(function () { return w.close(); });
    }).then(function () { return true; });
  }

  function collectLiveMapData() {
    var data = buildMapExport();
    var n = data && data.counts ? (data.counts.boxes + data.counts.planes + data.counts.triangles) : 0;
    if (!n) return null;
    return stabilizeMapData(data);
  }

  function pickMapFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      mapCache.status = "браузер не умеет папку";
      return Promise.resolve({ ok: false, error: "showDirectoryPicker is not available" });
    }
    return window.showDirectoryPicker({ id: "toCoordsMaps", mode: "readwrite" }).then(function (handle) {
      mapCache.folderHandle = handle;
      mapCache.needFolderClick = false;
      return idbPutMeta("folder", handle).catch(function () {}).then(function () {
        return ensureMapCached(false);
      }).then(function () {
        mapCache.status = "папка: " + (handle.name || "ok");
        return { ok: true, folder: handle.name };
      });
    }).catch(function (e) {
      return { ok: false, error: String(e && e.message || e) };
    });
  }

  function grantMapFolder() {
    if (!mapCache.folderHandle) return pickMapFolder();
    return requestFolderPermission(mapCache.folderHandle).then(function (ok) {
      if (!ok) return pickMapFolder();
      mapCache.needFolderClick = false;
      return ensureMapCached(false);
    });
  }

  function loadMapFile() {
    return new Promise(function (resolve) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.style.display = "none";
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (!file) { resolve({ ok: false, error: "no file" }); return; }
        file.text().then(function (text) {
          var data = JSON.parse(text);
          if (!applyMapData(data, "file:" + file.name)) {
            resolve({ ok: false, error: "empty or invalid map json" });
            return;
          }
          var id = mapCache.id;
          idbPutMap(id, mapCache.data).catch(function () {});
          resolve({ ok: true, id: id, counts: mapCache.data.counts });
        }).catch(function (e) {
          resolve({ ok: false, error: String(e && e.message || e) });
        });
      };
      (document.body || document.documentElement).appendChild(input);
      input.click();
    });
  }

  function saveMap(force) {
    var data = mapCache.data;
    if (!data) {
      try { data = collectLiveMapData(); } catch (e) { data = null; }
      if (data) applyMapData(data, "physicsWorld");
    }
    if (!data) return Promise.resolve({ ok: false, error: "no map data" });
    var id = mapFileId(data);
    mapCache.id = id;
    function writeAll(overwrite) {
      function toIdb() {
        return idbGetMap(id).catch(function () { return null; }).then(function (existing) {
          if (existing && !overwrite) return { ok: true, id: id, skipped: true, source: "idb" };
          return idbPutMap(id, data).then(function () { return { ok: true, id: id, saved: "idb" }; });
        });
      }
      function toFolder(prev) {
        if (!mapCache.folderHandle) return prev;
        return folderHasPermission(mapCache.folderHandle).then(function (ok) {
          if (!ok) return prev;
          return readFolderMap(mapCache.folderHandle, id).then(function (fileData) {
            if (fileData && !overwrite) return { ok: true, id: id, skipped: true, source: "folder" };
            return writeFolderMap(mapCache.folderHandle, id, data).then(function () {
              return { ok: true, id: id, saved: "folder", file: mapFileName(id) };
            });
          });
        }).catch(function () { return prev; });
      }
      function toNative() {
        return nativeReadJson(id).then(function (existing) {
          if (existing && !overwrite) return { ok: true, id: id, skipped: true, source: "native" };
          return nativeWriteJson(id, data).then(function (res) {
            if (res && res.ok) return { ok: true, id: id, saved: "native", file: mapFileName(id) };
            return null;
          });
        }).catch(function () { return null; });
      }
      return (nativeState.ready === false ? Promise.resolve(null) : toNative()).then(function (nat) {
        if (nat && nat.ok) {
          idbPutMap(id, data).catch(function () {});
          maybeSaveOffscreenPng();
          return nat;
        }
        return toIdb().then(toFolder);
      });
    }
    return writeAll(!!force).then(function (res) {
      mapCache.status = (res.skipped ? "уже есть " : "сохранено ") + id;
      return res;
    }).catch(function (e) {
      return { ok: false, error: String(e && e.message || e) };
    });
  }

  function tryLoadById(id) {
    if (!id) return Promise.resolve(null);
    function fromNative() {
      return nativeReadJson(id).then(function (d) { return d ? { data: d, source: "native" } : null; });
    }
    function fromBundled() {
      return loadBundledJson(id).then(function (d) { return d ? { data: d, source: "bundled" } : null; });
    }
    function fromFolder() {
      if (!mapCache.folderHandle) return Promise.resolve(null);
      return folderHasPermission(mapCache.folderHandle).then(function (ok) {
        if (!ok) {
          if (nativeState.ready !== true) mapCache.needFolderClick = true;
          return null;
        }
        return readFolderMap(mapCache.folderHandle, id).then(function (d) {
          return d ? { data: d, source: "folder" } : null;
        });
      });
    }
    function fromIdb() {
      return idbGetMap(id).then(function (d) {
        return d ? { data: d, source: "idb" } : null;
      }).catch(function () { return null; });
    }
    return fromNative().then(function (found) {
      if (found) return found;
      return fromBundled();
    }).then(function (found) {
      if (found) return found;
      return fromFolder();
    }).then(function (found) {
      if (found) return found;
      return fromIdb();
    });
  }

  function ensureMapCached(forceExport) {
    if (mapCache.data && !forceExport) {
      rebuildMinimapOffscreen();
      return Promise.resolve({ ok: true, id: mapCache.id, source: mapCache.source, cached: true });
    }
    mapCache.status = "ищу карту…";
    return idbGetMeta("folder").then(function (handle) {
      if (handle && !mapCache.folderHandle) mapCache.folderHandle = handle;
    }).catch(function () {}).then(function () {
      var nameId = (hooks.mapName && hooks.mapName !== "unknown") ? slugName(hooks.mapName) : null;
      return tryLoadById(nameId);
    }).then(function (found) {
      if (found && applyMapData(found.data, found.source)) {
        return attachMapTexture(mapCache.id).then(function () {
          rebuildMinimapOffscreen();
          return { ok: true, id: mapCache.id, source: found.source };
        });
      }
      var live = null;
      try { live = collectLiveMapData(); } catch (e) { live = null; }
      if (!live) {
        mapCache.status = "карты нет";
        return { ok: false, error: "no map yet" };
      }
      var hashId = "h" + geometryHash(live);
      return tryLoadById(hashId).then(function (found2) {
        if (found2 && applyMapData(found2.data, found2.source)) {
          return attachMapTexture(mapCache.id).then(function () {
            rebuildMinimapOffscreen();
            return { ok: true, id: mapCache.id, source: found2.source };
          });
        }
        applyMapData(live, "physicsWorld");
        return attachMapTexture(mapCache.id).then(function () {
          rebuildMinimapOffscreen();
          return saveMap(false).then(function (res) {
            maybeSaveOffscreenPng();
            return { ok: true, id: mapCache.id, source: "exported", save: res };
          });
        });
      });
    }).catch(function (e) {
      mapCache.status = "ошибка карты";
      return { ok: false, error: String(e && e.message || e) };
    });
  }

  function maybeStartMapCache() {
    if (mapCache.data || mapCache.building) return;
    if (!battle.inBattle && !livePositionOk() && !hooks.physicsWorld && !hooks.battleMap) return;
    if (!hooks.physicsWorld && !hooks.battleMap) return;
    mapCache.building = true;
    setTimeout(function () {
      try {
        ensureMapCached(false).then(function (res) {
          mapCache.building = false;
          if (!res || !res.ok) mapCache.started = false;
          updateMinimapChrome();
        }).catch(function () { mapCache.building = false; });
      } catch (e) { mapCache.building = false; }
    }, 0);
  }

  function heightFill(z, zmin, zmax) {
    var t = (z - zmin) / Math.max(0.001, zmax - zmin);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return "rgb(" + Math.round(92 + t * 118) + "," + Math.round(90 + t * 108) + "," + Math.round(74 + t * 82) + ")";
  }

  function mapWorldToOff(x, y, b) {
    var rx = x, ry = y;
    if (minimap.flipX) rx = b.xmin + b.xmax - rx;
    if (minimap.flipY) ry = b.ymin + b.ymax - ry;
    var cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2;
    var rot = (minimap.rotate || 0) * Math.PI / 180;
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
    // Don't drop a box only because it is short. Skip tiny debris only.
    if (maxd < 0.4 && foot < 0.25) return "skip";
    var ext = boxZExtent(box);
    var ze = ext.ze;
    // Thin floor plates stay slabs.
    if (ze < 0.7 && horiz[2] >= 2) return "slab";
    // Chunky tank-sized blocks (thickness ~ hull) are obstacles, even if not very tall.
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

    return { w: w, h: h, cell: cell, minx: minx, miny: miny, walk: walk, blocked: blocked2, height: height, kind: kind, ramps: ramps, id: mapCache.id };
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

  function rebuildMinimapOffscreen() {
    var data = mapCache.data;
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
    // steep slope outlines already hatched on fill; also mark their long edges
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
    try { mask = buildDriveMask(data, surfaces); } catch (eD) { mask = null; logDebug("drive mask error: " + (eD && eD.message || eD)); }
    var driveC = null;
    try { driveC = paintDriveCanvas(mask, bmap, w, h); } catch (eD2) { driveC = null; }

    minimap.offscreen = fillC;
    minimap.outlines = outC;
    minimap.driveCanvas = driveC;
    minimap.driveMask = mask;
    mapCache.driveMask = mask;
    minimap.layerLow = lowC;
    minimap.layerHigh = highC;
    minimap.splitZ = splitZ;
    minimap.bounds = bmap;
    minimap.scale = scale;
    minimap.builtFor = mapCache.id;
    logDebug("minimap built id=" + mapCache.id +
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
    minimap.lastSurfStats = surfStats;
    return true;
  }


  function niceMetres(span) {
    var steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
    var i, target = span * 0.28;
    for (i = 0; i < steps.length; i++) if (steps[i] >= target) return steps[i];
    return 1000;
  }

  function updateMinimapChrome() {
    if (!minimap.wrap) return;
    function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
    var st = minimap.statusEl;
    if (st && minimap.flash && Date.now() < minimap.flash.until) {
      setText(st, minimap.flash.text);
    } else if (st) {
      if (nativeState.ready) setText(st, mapCache.status || "maps: tanki-ext/maps");
      else if (mapCache.needFolderClick) setText(st, "в консоли toCoords.pickMapFolder() или поставь native-host");
      else setText(st, mapCache.status || "");
    }
  }

  function clampMinimapDim(v) {
    return Math.max(MINIMAP_MIN, Math.min(MINIMAP_MAX, Math.round(v)));
  }

  function bumpMinimapSize(factor) {
    minimap.w = clampMinimapDim((minimap.w || MINIMAP_SIZE) * factor);
    minimap.h = clampMinimapDim((minimap.h || MINIMAP_SIZE) * factor);
    applyMinimapSize();
    saveMinimapLayout();
    try { drawMinimap(); } catch (e) {}
  }

  function applyMinimapPreset(name) {
    var s = MINIMAP_PRESETS[name];
    if (!s) return;
    minimap.w = s;
    minimap.h = s;
    applyMinimapSize();
    saveMinimapLayout();
    try { drawMinimap(); } catch (e) {}
  }

  function applyMinimapSize() {
    var wrap = minimap.wrap || document.getElementById(MINIMAP_ID);
    var cnv = minimap.canvas;
    var w = clampMinimapDim(minimap.w || MINIMAP_SIZE);
    var h = clampMinimapDim(minimap.h || MINIMAP_SIZE);
    minimap.w = w;
    minimap.h = h;
    var sizeKey = w + "x" + h;
    if (wrap && cnv && wrap._toCoordsSize === sizeKey && cnv.width === w && cnv.height === h) return;
    if (wrap) wrap._toCoordsSize = sizeKey;
    if (wrap) {
      wrap.style.width = w + "px";
      wrap.style.height = "auto"; // bar + canvas + status, whatever their height
    }
    if (cnv) {
      if (cnv.width !== w) cnv.width = w;
      if (cnv.height !== h) cnv.height = h;
      cnv.style.width = "100%";
      cnv.style.height = h + "px";
    }
  }

  function ensureMinimap() {
    if (minimap.wrap && minimap.wrap.isConnected && minimap.canvas && minimap.wrap._toCoordsOk) return minimap.wrap;
    var wrap = document.getElementById(MINIMAP_ID);
    if (wrap && (wrap.dataset.v !== "3" || !wrap.querySelector("[data-act=zoomIn]") || !wrap.querySelector("[data-resize=w]"))) {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      wrap = null;
      minimap.wrap = null;
    }
    if (wrap) {
      minimap.wrap = wrap;
      minimap.canvas = wrap.querySelector("canvas");
      minimap.statusEl = wrap.querySelector("[data-role=status]");
      applyMinimapSize();
      wrap._toCoordsOk = true;
      return wrap;
    }
    wrap = document.createElement("div");
    wrap.id = MINIMAP_ID;
    wrap.dataset.v = "3";
    wrap.style.cssText = [
      "position:fixed",
      "top:" + (minimap.top != null ? minimap.top : 8) + "px",
      minimap.left != null ? ("left:" + minimap.left + "px") : "right:8px",
      minimap.left != null ? "right:auto" : "left:auto",
      "z-index:2147483647", "width:" + (minimap.w || MINIMAP_SIZE) + "px",
      "background:rgba(0,0,0,0.72)", "border-radius:4px",
      "box-shadow:0 2px 8px rgba(0,0,0,0.45)", "color:#d6ffd6",
      "font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "user-select:none", "overflow:visible", "touch-action:none",
      "min-width:" + MINIMAP_MIN + "px", "pointer-events:auto"
    ].join(";");
    var bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:move;background:rgba(255,255,255,0.04);pointer-events:auto";
    var title = document.createElement("span");
    title.textContent = "карта";
    title.style.flex = "1";
    function mkBtn(label, act) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.act = act;
      b.textContent = label;
      b.style.cssText = "background:#1a6885;color:#fff;border:0;border-radius:3px;padding:2px 6px;cursor:pointer;font:11px sans-serif";
      return b;
    }
    var btnZoomOut = mkBtn("−", "zoomOut");
    var btnZoomIn = mkBtn("+", "zoomIn");
    btnZoomOut.title = "отдалить (колесо мыши)";
    btnZoomIn.title = "приблизить (колесо мыши)";
    bar.appendChild(title);
    bar.appendChild(btnZoomOut);
    bar.appendChild(btnZoomIn);
    var cnv = document.createElement("canvas");
    cnv.width = minimap.w || MINIMAP_SIZE;
    cnv.height = minimap.h || MINIMAP_SIZE;
    cnv.style.cssText = "display:block;width:100%;height:" + (minimap.h || MINIMAP_SIZE) + "px;background:#141412";
    var status = document.createElement("div");
    status.dataset.role = "status";
    status.style.cssText = "padding:2px 6px 4px;color:#9aaa9a;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    var EDGE = 6, CORNER = 14;
    var handleDefs = {
      n:  ["top:-3px", "left:" + CORNER + "px", "right:" + CORNER + "px", "height:" + EDGE + "px", "cursor:ns-resize"],
      s:  ["bottom:-3px", "left:" + CORNER + "px", "right:" + CORNER + "px", "height:" + EDGE + "px", "cursor:ns-resize"],
      w:  ["left:-3px", "top:" + CORNER + "px", "bottom:" + CORNER + "px", "width:" + EDGE + "px", "cursor:ew-resize"],
      e:  ["right:-3px", "top:" + CORNER + "px", "bottom:" + CORNER + "px", "width:" + EDGE + "px", "cursor:ew-resize"],
      nw: ["top:-3px", "left:-3px", "width:" + CORNER + "px", "height:" + CORNER + "px", "cursor:nwse-resize"],
      ne: ["top:-3px", "right:-3px", "width:" + CORNER + "px", "height:" + CORNER + "px", "cursor:nesw-resize"],
      sw: ["bottom:-3px", "left:-3px", "width:" + CORNER + "px", "height:" + CORNER + "px", "cursor:nesw-resize"],
      se: ["bottom:-3px", "right:-3px", "width:" + CORNER + "px", "height:" + CORNER + "px", "cursor:nwse-resize"]
    };
    var handles = [];
    wrap.appendChild(bar);
    wrap.appendChild(cnv);
    wrap.appendChild(status);
    Object.keys(handleDefs).forEach(function (dir) {
      var h = document.createElement("div");
      h.dataset.resize = dir;
      h.title = "растянуть";
      h.style.cssText = ["position:absolute", "z-index:2", "pointer-events:auto", "touch-action:none", "background:transparent"]
        .concat(handleDefs[dir]).join(";");
      if (dir === "se") {
        // visible grip in the bottom-right corner
        h.style.background = "linear-gradient(135deg,transparent 0 55%,#8fd 55% 62%,transparent 62% 72%,#8fd 72% 79%,transparent 79%)";
      }
      wrap.appendChild(h);
      handles.push(h);
    });
    wrap.style.position = "fixed";
    (document.body || document.documentElement).appendChild(wrap);
    minimap.wrap = wrap;
    minimap.canvas = cnv;
    minimap.statusEl = status;

    // Pin the box by left/top so dragging the left/top edge works even when it was anchored to the right.
    function pinLeftTop() {
      var r = wrap.getBoundingClientRect();
      wrap.style.left = r.left + "px";
      wrap.style.top = r.top + "px";
      wrap.style.right = "auto";
      minimap.left = r.left;
      minimap.top = r.top;
      return r;
    }

    // One gesture at a time: "move" from the title bar, "resize" from an edge/corner.
    var gesture = null;
    function onGestureMove(ev) {
      if (!gesture) return;
      ev.preventDefault();
      ev.stopPropagation();
      var dx = ev.clientX - gesture.x0, dy = ev.clientY - gesture.y0;
      var vw = window.innerWidth || 1e4, vh = window.innerHeight || 1e4;
      if (gesture.kind === "move") {
        var x = Math.max(0, Math.min(vw - 40, gesture.left0 + dx));
        var y = Math.max(0, Math.min(vh - 20, gesture.top0 + dy));
        wrap.style.left = x + "px";
        wrap.style.top = y + "px";
        wrap.style.right = "auto";
        minimap.left = x;
        minimap.top = y;
        return;
      }
      var d = gesture.dir, left = gesture.left0, top = gesture.top0;
      var w = gesture.w0, h = gesture.h0;
      if (d.indexOf("e") >= 0) w = clampMinimapDim(gesture.w0 + dx);
      if (d.indexOf("s") >= 0) h = clampMinimapDim(gesture.h0 + dy);
      if (d.indexOf("w") >= 0) {
        w = clampMinimapDim(gesture.w0 - dx);
        left = gesture.left0 + (gesture.w0 - w);
      }
      if (d.indexOf("n") >= 0) {
        h = clampMinimapDim(gesture.h0 - dy);
        top = gesture.top0 + (gesture.h0 - h);
      }
      if (left < 0) { if (d.indexOf("w") >= 0) w = clampMinimapDim(w + left); left = 0; }
      if (top < 0) { if (d.indexOf("n") >= 0) h = clampMinimapDim(h + top); top = 0; }
      minimap.w = w;
      minimap.h = h;
      minimap.left = left;
      minimap.top = top;
      wrap.style.left = left + "px";
      wrap.style.top = top + "px";
      wrap.style.right = "auto";
      applyMinimapSize();
      try { drawMinimap(); } catch (eRz) {}
    }
    function onGestureEnd(ev) {
      if (!gesture) return;
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      try { if (gesture.el.releasePointerCapture) gesture.el.releasePointerCapture(gesture.pid); } catch (eRel) {}
      gesture = null;
      minimap.dragging = false;
      minimap.resizing = false;
      document.documentElement.style.cursor = "";
      saveMinimapLayout();
    }
    function startGesture(ev, kind, el, dir) {
      if (ev.button !== 0 || gesture) return;
      ev.preventDefault();
      ev.stopPropagation();
      var r = pinLeftTop();
      gesture = {
        kind: kind, dir: dir || "", el: el, pid: ev.pointerId,
        x0: ev.clientX, y0: ev.clientY,
        left0: r.left, top0: r.top,
        w0: minimap.w || MINIMAP_SIZE, h0: minimap.h || MINIMAP_SIZE
      };
      minimap.dragging = kind === "move";
      minimap.resizing = kind === "resize";
      if (kind === "resize") document.documentElement.style.cursor = el.style.cursor;
      try { el.setPointerCapture(ev.pointerId); } catch (eCap) {}
    }
    handles.forEach(function (h) {
      h.addEventListener("pointerdown", function (ev) { startGesture(ev, "resize", h, h.dataset.resize); });
      h.addEventListener("pointermove", onGestureMove);
      h.addEventListener("pointerup", onGestureEnd);
      h.addEventListener("pointercancel", onGestureEnd);
      h.addEventListener("lostpointercapture", function () { onGestureEnd(null); });
    });
    bar.addEventListener("pointerdown", function (ev) {
      if (ev.target && ev.target.tagName === "BUTTON") return;
      startGesture(ev, "move", bar);
    });
    bar.addEventListener("pointermove", onGestureMove);
    bar.addEventListener("pointerup", onGestureEnd);
    bar.addEventListener("pointercancel", onGestureEnd);
    bar.addEventListener("lostpointercapture", function () { onGestureEnd(null); });
    // Fallback if pointer capture is refused: follow the mouse on the window while a gesture is active.
    if (!minimap._gestureWinBound) {
      minimap._gestureWinBound = true;
      window.addEventListener("pointermove", function (ev) { if (minimap._gestureMove) minimap._gestureMove(ev); }, true);
      window.addEventListener("pointerup", function (ev) { if (minimap._gestureEnd) minimap._gestureEnd(ev); }, true);
    }
    minimap._gestureMove = function (ev) { if (gesture && ev.target !== gesture.el) onGestureMove(ev); };
    minimap._gestureEnd = function (ev) { if (gesture && ev.target !== gesture.el) onGestureEnd(ev); };

    wrap.addEventListener("pointerenter", function () { minimap.hover = true; });
    wrap.addEventListener("pointerleave", function () { if (!minimap.resizing && !minimap.dragging) minimap.hover = false; });
    wrap.addEventListener("mouseenter", function () { minimap.hover = true; });
    wrap.addEventListener("mouseleave", function () { if (!minimap.resizing && !minimap.dragging) minimap.hover = false; });
    // Keep clicks on the map away from the game, but in the bubble phase so our own children still get them.
    ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "mousemove", "click", "wheel", "contextmenu"].forEach(function (type) {
      wrap.addEventListener(type, function (ev) { ev.stopPropagation(); });
    });
    btnZoomIn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      bumpMinimapZoom(1.25);
      try { drawMinimap(); } catch (eZ) {}
    });
    btnZoomOut.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      bumpMinimapZoom(1 / 1.25);
      try { drawMinimap(); } catch (eZ2) {}
    });
    cnv.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      bumpMinimapZoom(ev.deltaY > 0 ? 1 / 1.15 : 1.15);
      try { drawMinimap(); } catch (eW) {}
    }, { passive: false });
    updateMinimapChrome();
    wrap._toCoordsOk = true;
    return wrap;
  }

  function setMinimapOn(on) {
    minimap.on = !!on;
    var el = document.getElementById(MINIMAP_ID);
    if (!minimap.on) {
      if (el) el.style.display = "none";
      return;
    }
    ensureMinimap();
    if (minimap.wrap) minimap.wrap.style.display = "block";
    if (!minimap.offscreen) maybeStartMapCache();
  }

  function minimapApi(arg) {
    if (arg === true || arg === false) {
      setMinimapOn(arg);
    } else if (arg && typeof arg === "object") {
      if (arg.zoom != null && isFiniteNum(Number(arg.zoom))) minimap.zoom = Math.max(0.25, Number(arg.zoom));
      if (arg.follow != null) minimap.follow = !!arg.follow;
      if (arg.drive != null) minimap.drive = !!arg.drive;
      if (arg.size != null && MINIMAP_PRESETS[arg.size]) applyMinimapPreset(arg.size);
      if (arg.follow != null || arg.zoom != null) saveMinimapLayout();
      if (arg.flipX != null) minimap.flipX = !!arg.flipX;
      if (arg.flipY != null) minimap.flipY = !!arg.flipY;
      if (arg.rotate != null && isFiniteNum(Number(arg.rotate))) minimap.rotate = Number(arg.rotate);
      if (arg.on != null) setMinimapOn(!!arg.on);
      if (arg.flipX != null || arg.flipY != null || arg.rotate != null) {
        minimap.builtFor = null;
        try { rebuildMinimapOffscreen(); } catch (e) {}
      }
    }
    if (minimap.on) {
      ensureMinimap();
      try { drawMinimap(); } catch (e2) {}
    }
    return {
      on: minimap.on,
      zoom: minimap.zoom,
      follow: minimap.follow,
      flipX: minimap.flipX,
      flipY: minimap.flipY,
      rotate: minimap.rotate,
      mapId: mapCache.id,
      source: mapCache.source,
      status: mapCache.status,
      drive: !!minimap.drive,
      size: { w: minimap.w, h: minimap.h }
    };
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

  function setMinimapZoom(z) {
    z = Number(z);
    if (!isFinite(z)) return;
    if (z < 0.5) z = 0.5;
    if (z > 16) z = 16;
    minimap.zoom = z;
    try { clearTimeout(setMinimapZoom.t); } catch (e) {}
    setMinimapZoom.t = setTimeout(saveMinimapLayout, 400);
  }

  function bumpMinimapZoom(factor) {
    setMinimapZoom((minimap.zoom || 1) * factor);
  }

  // Own tank: fixed-size white arrow along the hull (not the barrel), so it
  // reads the same at any zoom and never looks like another map object.
  function drawSelfArrow(ctx, x, y, dx, dy) {
    drawArrow(ctx, x, y, dx, dy, "#ffffff", "#000000", 1);
  }

  function drawArrow(ctx, x, y, dx, dy, fill, stroke, k) {
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    var nx = -dy, ny = dx, L = 11 * k, B = 7 * k, T = 4 * k;
    ctx.beginPath();
    ctx.moveTo(x + dx * L, y + dy * L);                        // nose
    ctx.lineTo(x - dx * L * 0.7 + nx * B, y - dy * L * 0.7 + ny * B);
    ctx.lineTo(x - dx * T, y - dy * T);                        // notch
    ctx.lineTo(x - dx * L * 0.7 - nx * B, y - dy * L * 0.7 - ny * B);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();
  }

  function drawMinimap() {
    if (!minimap.on) return;
    var wrap = ensureMinimap();
    if (!wrap || !minimap.canvas) return;
    if (mapCache.data && !minimap.offscreen) {
      try { rebuildMinimapOffscreen(); } catch (e) {}
    }
    applyMinimapSize();
    var ctx = minimap.canvas.getContext("2d");
    var W = minimap.canvas.width, H = minimap.canvas.height;
    var S = Math.min(W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#141412";
    ctx.fillRect(0, 0, W, H);
    var b = minimap.bounds;
    var off = minimap.offscreen;
    var viewM = 1, cx, cy, metresW, metresH;
    if (off && b) {
      var zoom = Math.max(0.25, minimap.zoom || 1);
      var spanX = b.xmax - b.xmin, spanY = b.ymax - b.ymin;
      var fit = Math.min(W / spanX, H / spanY);
      viewM = fit * zoom;
      var tank = lastMe;
      if (minimap.follow && zoom > 1.001 && tank && isFiniteNum(tank.x)) {
        cx = tank.x;
        cy = tank.y;
      } else {
        cx = (b.xmin + b.xmax) / 2;
        cy = (b.ymin + b.ymax) / 2;
      }
      metresW = W / viewM;
      metresH = H / viewM;
      var worldL = cx - metresW / 2, worldT = cy + metresH / 2;
      var src = mapWorldToOff(worldL, worldT, b);
      var srcW = metresW * b.scale, srcH = metresH * b.scale;
      try {
        ctx.imageSmoothingEnabled = true;
        var tankZ = lastMe && isFiniteNum(lastMe.z) ? lastMe.z : null;
        var splitZ = minimap.splitZ || 2.4;
        var onHigh = tankZ != null && tankZ >= splitZ - 0.35;
        var low = minimap.layerLow, high = minimap.layerHigh;
        if (minimap.drive && minimap.driveCanvas) {
          ctx.drawImage(minimap.driveCanvas, src.x, src.y, srcW, srcH, 0, 0, W, H);
        } else if (low && high && !mapCache.texture) {
          ctx.globalAlpha = onHigh ? 0.35 : 1;
          ctx.drawImage(low, src.x, src.y, srcW, srcH, 0, 0, W, H);
          ctx.globalAlpha = onHigh ? 1 : 0.42;
          ctx.drawImage(high, src.x, src.y, srcW, srcH, 0, 0, W, H);
          ctx.globalAlpha = 1;
        } else {
          ctx.drawImage(off, src.x, src.y, srcW, srcH, 0, 0, W, H);
        }
        if (minimap.outlines) {
          ctx.drawImage(minimap.outlines, src.x, src.y, srcW, srcH, 0, 0, W, H);
        }
        minimap.levelLabel = onHigh ? "верх" : (tankZ == null ? "" : "низ");
      } catch (e2) {
        ctx.globalAlpha = 1;
        ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, W, H);
        if (minimap.outlines) ctx.drawImage(minimap.outlines, 0, 0, off.width, off.height, 0, 0, W, H);
        viewM = Math.min(W / spanX, H / spanY);
        cx = (b.xmin + b.xmax) / 2;
        cy = (b.ymin + b.ymax) / 2;
      }
    }
    function toScreen(x, y) {
      if (!b) return { x: W / 2, y: H / 2 };
      return { x: W / 2 + (x - cx) * viewM, y: H / 2 - (y - cy) * viewM };
    }
    try { drawObjectives(ctx, toScreen, W, H); } catch (eObj) {}
    try { drawRadarTanks(ctx, toScreen, W, H); } catch (eRadar) {}
    try { drawFlagCarriers(ctx, toScreen, W, H); } catch (eCar) {}
    try { drawMagnumAim(ctx, toScreen); } catch (eMag) {}
    if (lastMe && isFiniteNum(lastMe.x) && !isFiniteNum(lastMe.heading)) {
      // position known, heading not yet (standing still, hull not matched): a dot
      try {
        var pd = toScreen(lastMe.x, lastMe.y);
        ctx.beginPath();
        ctx.arc(pd.x, pd.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fill();
      } catch (eDot) {}
    }
    if (lastMe && isFiniteNum(lastMe.x) && isFiniteNum(lastMe.heading)) try {
      var hx = Math.cos(lastMe.heading), hy = Math.sin(lastMe.heading);
      var px = lastMe.x, py = lastMe.y;
      var p = toScreen(px, py);
      var bdir = lastRayDebug && lastRayDebug.barrel && lastRayDebug.barrel.forward;
      var yawX = bdir && isFiniteNum(bdir.x) ? bdir.x : hx;
      var yawY = bdir && isFiniteNum(bdir.y) ? bdir.y : hy;
      var blen = Math.sqrt(yawX * yawX + yawY * yawY) || 1;
      yawX /= blen;
      yawY /= blen;
      var rayM = null;
      if (lastAhead && lastAhead.barrel && isFiniteNum(lastAhead.barrel.dist) && lastAhead.barrel.dist > 0) {
        rayM = lastAhead.barrel.dist;
      }
      if (rayM == null) {
        var left = cx - (metresW || 0) / 2, right = cx + (metresW || 0) / 2;
        var bottom = cy - (metresH || 0) / 2, top = cy + (metresH || 0) / 2;
        if (!isFinite(left) && b) {
          left = b.xmin; right = b.xmax; bottom = b.ymin; top = b.ymax;
        }
        rayM = rayDistToRect(px, py, yawX, yawY, left, right, bottom, top);
        if (!rayM || rayM < 1) rayM = 200;
      }
      var end = toScreen(px + yawX * rayM, py + yawY * rayM);
      ctx.strokeStyle = "#ffcc33";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      drawSelfArrow(ctx, p.x, p.y, hx, -hy); // screen y grows down
    } catch (eSelf) {}
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
    if (minimap.levelLabel) {
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#e8edf2";
      ctx.fillText("этаж: " + minimap.levelLabel, W - 70, H - 8);
    }
    updateMinimapChrome();
  }

  /* ---------- in-game HUD radar mirror ----------
   * Mirrors ONLY the markers the game's own HUD radar is showing right now
   * (radar system: n11x_1 = list of Entry{t11x_1 entity, u11x_1 marker}).
   * The game adds a marker when a tank is inside RadarCC.enterRange and drops it
   * past exitRange or when the radar is locked, so we show exactly the same set.
   * No other tank positions are read. */
  // Accepts 0xRRGGBB, 0xAARRGGBB, "#rrggbb"/"rgb()" strings, or {r,g,b} (0..1 or 0..255).
  function colorToRgb(v) {
    if (v == null) return null;
    if (typeof v === "number" && isFinite(v)) {
      var n = v >>> 0;
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    if (typeof v === "string") {
      var mh = /^#?([0-9a-f]{6})$/i.exec(v.trim());
      if (mh) return colorToRgb(parseInt(mh[1], 16));
      var mr = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(v);
      if (mr) return { r: +mr[1], g: +mr[2], b: +mr[3] };
      return null;
    }
    if (typeof v === "object") {
      var r = v.r != null ? v.r : v.red, g = v.g != null ? v.g : v.green, b = v.b != null ? v.b : v.blue;
      if (isFiniteNum(r) && isFiniteNum(g) && isFiniteNum(b)) {
        var k = (r <= 1 && g <= 1 && b <= 1) ? 255 : 1;
        return { r: r * k, g: g * k, b: b * k };
      }
      // Minified game Color object (cC(0xRRGGBB)): look at its own numeric fields in declaration order.
      var keys, i, val, nums = [], ints = [];
      try { keys = Object.keys(v); } catch (eK) { keys = []; }
      for (i = 0; i < keys.length; i++) {
        try { val = v[keys[i]]; } catch (eV) { continue; }
        if (!isFiniteNum(val)) continue;
        var rgb24 = (val >>> 0) & 0xFFFFFF;
        if (val > 255 && (rgb24 === 0x33BBFF || rgb24 === 0xFF6666)) return colorToRgb(rgb24);
        if (val > 255 && val === Math.floor(val)) ints.push(val);
        nums.push(val);
      }
      if (nums.length >= 3) {
        var a0 = nums[0], a1 = nums[1], a2 = nums[2];
        if (a0 >= 0 && a1 >= 0 && a2 >= 0 && a0 <= 1 && a1 <= 1 && a2 <= 1) return { r: a0 * 255, g: a1 * 255, b: a2 * 255 };
        if (a0 >= 0 && a1 >= 0 && a2 >= 0 && a0 <= 255 && a1 <= 255 && a2 <= 255) return { r: a0, g: a1, b: a2 };
      }
      if (ints.length) return colorToRgb(ints[0]);
    }
    return null;
  }
  function radarColorIsAlly(v) {
    var c = colorToRgb(v);
    if (!c) return null;
    if (c.b > c.r + 30) return true;
    if (c.r > c.b + 30) return false;
    return null;
  }

  function looksLikeRadarSystem(obj) {
    try {
      var list = obj && obj.n11x_1;
      if (!list || typeof list.e1 !== "function" || typeof list.g1 !== "function") return false;
      if (!obj.o11x_1 || !obj.q11x_1 || !obj.r11x_1 || typeof obj.g11x_1 !== "boolean") return false;
      return true;
    } catch (e) { return false; }
  }

  function rememberRadarSystem(obj) {
    if (hooks.radarSystem || !obj || typeof obj !== "object") return;
    if (!looksLikeRadarSystem(obj)) return;
    hooks.radarSystem = obj;
    logDebug("hooked HUD radar");
  }

  function radarMarkers() {
    var sys = hooks.radarSystem, out = [];
    if (!sys) return out;
    var entries = iterList(sys.n11x_1), i, e, m, pos, col;
    for (i = 0; i < entries.length && i < 64; i++) {
      e = entries[i];
      m = e && e.u11x_1;
      if (!m) continue;
      pos = null;
      try { pos = vecToM(parseMapVec(m.o11w_1 || (typeof m.n7v === "function" && m.n7v()))); } catch (eP) {}
      if (!pos || !isFiniteNum(pos.x) || !isFiniteNum(pos.y)) continue;
      col = null;
      try { col = m.q11w_1 && m.q11w_1.d4q_1; } catch (eC) {}
      // Game tints allies bluish (0x33BBFF) and enemies reddish (0xFF6666); the relation is chosen by the game.
      out.push({ pos: pos, ally: radarColorIsAlly(col), raw: col, key: (e.t11x_1 && typeof e.t11x_1 === "object") ? e.t11x_1 : m });
    }
    return out;
  }

  // Direction of travel of a radar marker, from the positions the game radar
  // itself showed over time (no other data about that tank is read).
  var radarTrack = typeof WeakMap === "function" ? new WeakMap() : null;
  var RADAR_STEP_M = 0.6;      // re-aim after moving this far
  function radarHeading(t, now) {
    if (!radarTrack || !t.key) return null;
    var tr = radarTrack.get(t.key), x = t.pos.x, y = t.pos.y;
    if (!tr) { radarTrack.set(t.key, { ax: x, ay: y, dx: 0, dy: 0, movedAt: 0 }); return null; }
    var mx = x - tr.ax, my = y - tr.ay, d = Math.sqrt(mx * mx + my * my);
    if (d > 40) { tr.ax = x; tr.ay = y; tr.movedAt = 0; return null; } // marker reused / respawn
    if (d >= RADAR_STEP_M) {
      mx /= d; my /= d;
      if (tr.movedAt) { mx = tr.dx * 0.4 + mx * 0.6; my = tr.dy * 0.4 + my * 0.6; }
      var n = Math.sqrt(mx * mx + my * my) || 1;
      tr.dx = mx / n; tr.dy = my / n;
      tr.ax = x; tr.ay = y; tr.movedAt = now;
    }
    // A tank that stopped keeps its last direction of travel; a dot only until
    // the radar has seen it move at least once.
    if (!tr.movedAt) return null;
    return { x: tr.dx, y: tr.dy };
  }

  // Carrier of a flag whose marker the game shows: the tank stays an arrow
  // (its colour = the side carrying), with a blinking flag of the carried team.
  function carriedFlags() {
    return flagLiveStates().filter(function (f) { return f.state === "CARRIED"; });
  }
  function nearCarriedFlag(pos, carried) {
    for (var i = 0; i < carried.length; i++) {
      if (Math.abs(carried[i].pos.x - pos.x) < 4 && Math.abs(carried[i].pos.y - pos.y) < 4) return carried[i];
    }
    return null;
  }
  function drawBlinkingFlag(ctx, x, y, color) {
    var on = Math.floor(Date.now() / 250) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.3;
    ctx.lineJoin = "round";
    // pole
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x, y - 18);
    ctx.strokeStyle = "#000"; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 2; ctx.stroke();
    // cloth
    ctx.beginPath();
    ctx.moveTo(x, y - 18); ctx.lineTo(x + 13, y - 13.5); ctx.lineTo(x, y - 9); ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawFlagCarriers(ctx, toScreen, W, H) {
    var carried = carriedFlags();
    if (!carried.length) return;
    var markers = radarMarkers(), now = Date.now(), i, j, f, p, hd, carrierTeam, local, col;
    for (i = 0; i < carried.length; i++) {
      f = carried[i];
      p = toScreen(f.pos.x, f.pos.y);
      if (p.x < -30 || p.y < -30 || p.x > W + 30 || p.y > H + 30) continue;
      local = f.local || localTeamName();
      carrierTeam = f.team === "TEAM_A" || f.team === "TEAM_B" ? otherTeam(f.team) : "";
      col = carrierTeam ? cpTeamColor(carrierTeam, local) : "#c8c8c8";
      // direction: how the flag marker moves; else the radar marker of the carrier
      hd = radarHeading({ key: f.key, pos: f.pos }, now);
      for (j = 0; !hd && j < markers.length; j++) {
        if (Math.abs(markers[j].pos.x - f.pos.x) < 4 && Math.abs(markers[j].pos.y - f.pos.y) < 4) hd = radarHeading(markers[j], now);
      }
      if (hd) {
        drawArrow(ctx, p.x, p.y, hd.x, -hd.y, col, "rgba(0,0,0,0.85)", 0.95);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 1.5;
        ctx.fill(); ctx.stroke();
      }
      drawBlinkingFlag(ctx, p.x + 6, p.y - 4, cpTeamColor(f.team, local));
    }
  }

  function drawRadarTanks(ctx, toScreen, W, H) {
    var list = radarMarkers();
    if (!list.length) return;
    var carriedNow = carriedFlags();
    var meZ = lastMe && isFiniteNum(lastMe.z) ? lastMe.z : null;
    var now = Date.now();
    var i, t, p, hex, dz, hd;
    ctx.save();
    for (i = 0; i < list.length; i++) {
      t = list[i];
      hd = radarHeading(t, now);
      if (carriedNow.length && nearCarriedFlag(t.pos, carriedNow)) continue; // drawn as the carrier
      p = toScreen(t.pos.x, t.pos.y);
      if (p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) continue;
      hex = t.ally === true ? "#1e6bff" : (t.ally === false ? "#ff2a2a" : "#c8c8c8");
      if (hd) {
        drawArrow(ctx, p.x, p.y, hd.x, -hd.y, hex, "rgba(0,0,0,0.85)", 0.85); // screen y grows down
      } else {
        ctx.fillStyle = hex;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      // same above/below hint as the game radar (4.8 m threshold)
      dz = meZ != null ? t.pos.z - meZ : 0;
      if (Math.abs(dz) > 4.8) {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        if (dz > 0) { ctx.moveTo(p.x - 3, p.y - 7); ctx.lineTo(p.x + 3, p.y - 7); ctx.lineTo(p.x, p.y - 11); }
        else { ctx.moveTo(p.x - 3, p.y + 7); ctx.lineTo(p.x + 3, p.y + 7); ctx.lineTo(p.x, p.y + 11); }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Control point as the game's HUD shows it: filled with the owner's colour,
  // ring = capture progress (|score| / 100) in the colour of the side capturing.
  function drawCpLive(ctx, p, st, letter) {
    var r = 9, ring = r + 4.5, TAU = Math.PI * 2, frac = Math.abs(st.score) / 100;
    ctx.globalAlpha = st.active ? 1 : 0.45;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ring, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 5.5;
    ctx.stroke();
    if (frac > 0.005) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frac) * TAU);
      ctx.strokeStyle = cpTeamColor(st.capTeam, st.local);
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fillStyle = cpTeamColor(st.owner, st.local);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(letter || st.letter || "?", p.x, p.y + 0.5);
    ctx.globalAlpha = 1;
  }

  function drawObjectives(ctx, toScreen, W, H) {
    var live = cpLiveStates(), liveUsed = [];
    function liveAt(pos) {
      var j, d, best = -1, bestD = 9; // within 3 m
      for (j = 0; j < live.length; j++) {
        if (liveUsed[j]) continue;
        d = (live[j].pos.x - pos.x) * (live[j].pos.x - pos.x) + (live[j].pos.y - pos.y) * (live[j].pos.y - pos.y);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best < 0) return null;
      liveUsed[best] = true;
      return live[best];
    }
    // Only what this battle has: flag bases found live (CTF) and control points
    // found live (CP mode). Objectives stored in map files are not drawn: a map
    // file is shared by all modes (its DOM spawn points are not control points).
    var list = [], i0, cp, tp, tpos;
    for (i0 = 0; i0 < mapTeamPoints.length; i0++) {
      tp = mapTeamPoints[i0];
      try {
        if (!tp || tp.oir_1 != null) continue;
        tpos = vecToM(parseMapVec(tp.xin_1));
        if (tpos) list.push({ kind: "flag", team: normalizeTeam(enumName(tp.zin_1)), letter: "F", position: tpos });
      } catch (eTp) {}
    }
    for (i0 = 0; i0 < mapControlPoints.length; i0++) {
      cp = mapControlPoints[i0];
      if (!cp || !cp.position) continue;
      list.push({ kind: "cp", team: null, letter: cp.letter || "?", position: cp.position });
    }
    if (!list.length && !live.length && !flagLive.length) return;
    var now = Date.now();
    var i, o, p, style, taken, blink, r, letter, st;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
    for (i = 0; i < list.length; i++) {
      o = list[i];
      if (!o || !o.position) continue;
      p = toScreen(o.position.x, o.position.y);
      if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
      letter = o.letter || (o.kind === "flag" ? "F" : "?");
      if (o.kind === "flag") {
        style = teamStyle(o.team);
        if (o.team === "TEAM_A" || o.team === "TEAM_B") {
          var fc = cpTeamColor(o.team, localTeamName());
          style = { fill: fc, stroke: "#ffffff", key: o.team };
        }
        taken = !!flagTaken[normalizeTeam(o.team)];
        blink = taken && ((now / 180) % 2 < 1);
        r = 8;
        ctx.globalAlpha = taken && !blink ? 0.28 : 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r - 2);
        ctx.lineTo(p.x + r, p.y + r - 1);
        ctx.lineTo(p.x - r, p.y + r - 1);
        ctx.closePath();
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = taken ? "#fff" : style.stroke;
        ctx.lineWidth = taken ? 2.5 : 1.5;
        ctx.fill();
        ctx.stroke();
        if (taken) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(p.x, p.y + 1, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#fff";
        ctx.fillText(letter, p.x, p.y + 1);
        ctx.globalAlpha = 1;
      } else if ((st = liveAt(o.position))) {
        drawCpLive(ctx, p, st, o.letter && o.letter !== "?" ? o.letter : st.letter);
      } else {
        r = 7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(20,20,20,0.75)";
        ctx.strokeStyle = "#ffe56a";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffe56a";
        ctx.fillText(letter, p.x, p.y + 0.5);
      }
    }
    // flags as the game's markers show them: carrier = yellow ring, dropped = flag
    var fl = flagLiveStates(), fi, fs;
    for (fi = 0; fi < fl.length; fi++) {
      fs = fl[fi];
      p = toScreen(fs.pos.x, fs.pos.y);
      if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
      var fcol = cpTeamColor(fs.team, fs.local);
      if (fs.state === "CARRIED") {
        continue; // drawn by drawFlagCarriers on top of the radar tanks
      } else {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 10); ctx.lineTo(p.x + 8, p.y + 6); ctx.lineTo(p.x - 8, p.y + 6); ctx.closePath();
        ctx.fillStyle = fcol;
        ctx.strokeStyle = "#ffd400";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
    }
    // live points the map file did not know about
    for (i = 0; i < live.length; i++) {
      if (liveUsed[i]) continue;
      p = toScreen(live[i].pos.x, live[i].pos.y);
      if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
      drawCpLive(ctx, p, live[i], live[i].letter);
    }
    ctx.restore();
  }

  function minimapFlash(text) {
    minimap.flash = { text: text, until: Date.now() + 1500 };
    try { updateMinimapChrome(); } catch (e) {}
  }

  function onMinimapHotkey(ev) {
    if (!ev) return;
    var kc = ev.code, plus = kc === "Equal" || kc === "NumpadAdd", minus = kc === "Minus" || kc === "NumpadSubtract";
    var tgt = ev.target, typing = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
    if ((plus || minus) && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.shiftKey) {
        // Shift + / - : camera distance, parkour format only
        if (OFF.camera) { minimapFlash("камера: выключена (toCoords.off)"); return; }
        if (!isParkour()) {
          minimapFlash(parkourKnown() ? "камера: только в паркуре (формат боя: " + battleFormatName() + ")" : "камера: ищу формат боя…");
          return;
        }
        if (!followCam) { minimapFlash("камера: ещё ищу…"); return; }
        bumpParkourCam(plus ? 1.15 : 1 / 1.15);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      // + / - : map zoom (clicks and the wheel do not reach the map while the
      // game holds the mouse, keys always do)
      if (minimap.on) {
        bumpMinimapZoom(plus ? 1.25 : 0.8);
        try { drawMinimap(); } catch (eZk) {}
        minimapFlash("масштаб ×" + (Math.round(minimap.zoom * 100) / 100));
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if ((ev.key === "[" || ev.key === "]" || ev.code === "BracketLeft" || ev.code === "BracketRight") && minimap.on && minimap.hover) {
      bumpMinimapSize(ev.key === "]" || ev.code === "BracketRight" ? 1.25 : 0.8);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (ev.key !== "m" && ev.key !== "M") return;
    setMinimapOn(!minimap.on);
    ev.preventDefault();
    ev.stopPropagation();
  }


  function livePositionOk() {
    try {
      if (typeof readPositionFromHook === "function") {
        var pos = readPositionFromHook();
        return !!(pos && isFiniteNum(pos.x) && isFiniteNum(pos.y));
      }
    } catch (e) {}
    return false;
  }

  function clearInstanceState(dropFns) {
    hooks.physicsBody = null;
    hooks.physicsWorld = null;
    hooks.camera = null;
    hooks.battleMap = null;
    hooks.mapName = null;
    hooks.radarSystem = null;
    radarScanRuns = 0;
    if (dropFns) {
      hooks.getLocalTankPosition = null;
      hooks.isLocalTankAlive = null;
      hooks.showPositionLocalTank = null;
      hooks.fillPhysicsState = null;
    }
    bodyCandidates = [];
    mountCandidates = [];
    mapTeamPoints = [];
    flagHudObjs = [];
    flagTaken = {};
    mapControlPoints = [];
    cpLive = [];
    flagLive = [];
    magnumAim = null;
    battleParams = null;
    battlefieldCC = null;
    if (treesHidden.length) restoreTrees();
    mapComp = null;
    pkSearch.q = null; pkSearch.seen = null; pkSearch.restarts = 0;
    if (parkourCam.applied) { for (var fci = 0; fci < followCams.length; fci++) setCamMult(followCams[fci], 1); }
    followCam = null;
    followCams = [];
    parkourCam.applied = false;
    lastMe = null;
    lastMeEngine = null;
    lastQuat = null;
    lastHeading = null;
    lastHeadingSource = null;
    lastSource = null;
    lastPosRef = null;
    lastRayDebug = null;
    lastHeadingDebug = null;
    lastAhead = { hull: { type: null, name: null, dist: null }, barrel: { type: null, name: null, dist: null } };
    resetMapState();
    resetScanCursor();
  }

  function resetMapState() {
    mapCache.data = null;
    mapCache.jsPrims = null;
    mapCache.id = null;
    mapCache.source = null;
    mapCache.building = false;
    mapCache.started = false;
    mapCache.status = "жду бой";
    mapCache.texture = null;
    mapCache.textureId = null;
    minimap.offscreen = null;
    minimap.layerLow = null;
    minimap.layerHigh = null;
    minimap.splitZ = 0;
    minimap.bounds = null;
    minimap.builtFor = null;
    minimap.levelLabel = "";
  }

  function startScanBurst(why) {
    resetScanCursor();
    nextScanAt = 0;
    burstFramesLeft = 16;
    lastBurstAt = 0;
    posMissingSince = 0;
    lastScanResetAt = 0;
    logDebug("scan burst " + why + " t=" + Math.round(performance.now() - (window.__toCoordsT0 || 0)) + "ms");
  }

  function decideBattleChange(sample) {
    if (!sample) return null;
    // Never reset on a position jump, respawn, teleport, or frozen pos alone.
    // Only a new physicsWorld identity means a different battle.
    if (sample.newerWorld && sample.newerWorld !== sample.world) return "physicsWorld";
    if (sample.world && sample.watchWorld && sample.world !== sample.watchWorld && !isRetiredWorld(sample.world)) return "physicsWorld";
    return null;
  }

  function shouldBroadScan(sample) {
    if (!sample) return false;
    if (sample.posHooked && sample.hasWorld) return false;
    if (!sample.hasWorld && !sample.inBattle && !sample.live) return !!sample.lobbyDue;
    return !sample.posHooked || !sample.hasWorld;
  }

  function pickNewerWorld(old) {
    var i, w, list;
    // Only worlds seen after the current one count as "newer".
    var from = old ? worldCandidates.indexOf(old) : -1;
    for (i = worldCandidates.length - 1; i > from; i--) {
      w = worldCandidates[i];
      if (!w || w === old || isRetiredWorld(w)) continue;
      try { list = bodiesOfWorld(w); } catch (e) { list = []; }
      if (list.length >= 1) return w;
    }
    return null;
  }

  function overlapCount(a, b) {
    if (!a || !b) return 0;
    var n = 0, i;
    for (i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) n++;
    return n;
  }

  function triggerBattleChange(reason) {
    logDebug("battle change: " + reason);
    var newer = pickNewerWorld(hooks.physicsWorld);
    var keepWorld = (reason === "physicsWorld") ? (newer || hooks.physicsWorld) : (newer && newer !== hooks.physicsWorld ? newer : null);
    var dropFns = reason === "pos-frozen";
    if (hooks.physicsWorld && keepWorld !== hooks.physicsWorld) retireWorld(hooks.physicsWorld);
    clearInstanceState(dropFns);
    if (keepWorld) {
      hooks.physicsWorld = keepWorld;
      rememberWorld(keepWorld);
      try { attachCameraFromWorld(keepWorld); } catch (e2) {}
    }
    battleWatch.worldRef = hooks.physicsWorld || null;
    battleWatch.mapRef = null;
    battleWatch.bodyRef = null;
    battleWatch.lastPos = null;
    battleWatch.lastPosChangeAt = 0;
    battleWatch.lastPhysicsUpdateAt = 0;
    battleWatch.lastBodySig = null;
    enterBattle(reason);
    if (!hooks.physicsWorld) startScanBurst("battle-change:" + reason);
    try { maybeStartMapCache(); } catch (eMap) {}
  }

  function enterBattle(reason) {
    battle.id += 1;
    battle.inBattle = true;
    battle.enteredAt = Date.now();
    battle.posGoneSince = 0;
    battle.worldRef = hooks.physicsWorld || null;
    battle.mapName = hooks.mapName || null;
    battleWatch.worldRef = hooks.physicsWorld || null;
    battleWatch.mapRef = hooks.battleMap || null;
    battleWatch.bodyRef = hooks.physicsBody || null;
    nextScanAt = 0;
    if (!isPosHooked() || !hooks.physicsWorld) {
      burstFramesLeft = Math.max(burstFramesLeft, 8);
      lastBurstAt = 0;
    } else {
      burstFramesLeft = 0;
    }
    posMissingSince = 0;
    logDebug("battle enter " + reason + " #" + battle.id);
  }

  function leaveBattle(reason) {
    if (!battle.inBattle) {
      clearInstanceState(false);
      return;
    }
    battle.inBattle = false;
    battle.posGoneSince = 0;
    battle.worldRef = null;
    battle.mapName = null;
    battleWatch.worldRef = null;
    battleWatch.mapRef = null;
    battleWatch.bodyRef = null;
    battleWatch.lastBodySig = null;
    clearInstanceState(false);
    nextScanAt = 0;
    logDebug("battle leave " + reason);
  }

  function detectBattleChange(now) {
    if (now - battleWatch.lastCheck < 500) return;
    battleWatch.lastCheck = now;
    var world = hooks.physicsWorld;
    var newer = pickNewerWorld(world);
    var map = hooks.battleMap;
    var body = hooks.physicsBody;
    var pos = null;
    try { pos = readPositionFromHook(); } catch (e) { pos = null; }
    var sig = world ? bodiesOfWorld(world) : [];
    var unrelated = !!(battleWatch.lastBodySig && battleWatch.lastBodySig.length >= 3 && sig.length >= 3 && overlapCount(battleWatch.lastBodySig, sig) === 0);
    var frozenMs = 0;
    if (pos && isFiniteNum(pos.x)) {
      var prev = battleWatch.lastPos;
      var moved = !prev || Math.hypot(pos.x - prev.x, pos.y - prev.y) > 0.05;
      if (moved) {
        battleWatch.lastPos = { x: pos.x, y: pos.y, z: pos.z };
        battleWatch.lastPosChangeAt = now;
      } else if (battleWatch.lastPosChangeAt) {
        frozenMs = now - battleWatch.lastPosChangeAt;
      }
    }
    var sample = {
      inBattle: !!battle.inBattle,
      world: world,
      watchWorld: battleWatch.worldRef,
      newerWorld: newer,
      map: map,
      watchMap: battleWatch.mapRef,
      body: body,
      worldHasBody: body && world ? worldHasBody(world, body) : null,
      bodyListUnrelated: unrelated,
      posFrozenMs: frozenMs
    };
    // Our own tank body put us back into a world we had left: the switch was wrong.
    // Drop the stale world instead of resetting the map again.
    if (world && battleWatch.worldRef && world !== battleWatch.worldRef && isRetiredWorld(world)) {
      retireWorld(battleWatch.worldRef);
      unretireWorld(world);
      battleWatch.worldRef = world;
      logDebug("physicsWorld back to own tank world, stale world dropped");
      resetMapState();
      try { maybeStartMapCache(); } catch (eMapB) {}
      sample.watchWorld = world;
      sample.newerWorld = pickNewerWorld(world);
    }
    var reason = decideBattleChange(sample);
    if (reason) {
      triggerBattleChange(reason);
      return;
    }
    // Position function returns nothing for a while (battle over, or we are dead):
    // keep it, but let the broad scan look for a newer one meanwhile.
    if (isPosHooked() && !(pos && isFiniteNum(pos.x))) {
      if (!battleWatch.posNullSince) battleWatch.posNullSince = now;
      else if (now - battleWatch.posNullSince > 2500 && !battleWatch.posStale) {
        battleWatch.posStale = true;
        logDebug("position hook returns nothing, scanning for a newer one");
      }
    } else {
      battleWatch.posNullSince = 0;
      battleWatch.posStale = false;
    }
    // We are alive, but no body of the current world is anywhere near us.
    if (sig.length) battleWatch.bodiesWorld = world;
    if (world && pos && isFiniteNum(pos.x) && battle.inBattle && (sig.length || battleWatch.bodiesWorld === world) &&
        isLocalAlive() === true) {
      var nearOwn = false, wb = sig, bi, bp;
      for (bi = 0; bi < wb.length && !nearOwn; bi++) {
        bp = bodyPos(wb[bi]);
        if (bp && Math.abs(bp.x - pos.x) + Math.abs(bp.y - pos.y) + Math.abs(bp.z - pos.z) < 800) nearOwn = true;
      }
      // A battle can have several physics worlds, so this alone never resets
      // anything (that made our tank vanish): it only starts a search. Our hull,
      // once found, brings its world along and a real switch is detected as usual.
      if (!nearOwn) {
        if (!battleWatch.strayedSince) battleWatch.strayedSince = now;
        else if (now - battleWatch.strayedSince > 1500 && !battleWatch.strayed) {
          battleWatch.strayed = true;
          logDebug("no body of the current world near us, scanning for ours");
          startScanBurst("stray");
        }
      } else {
        battleWatch.strayedSince = 0;
        battleWatch.strayed = false;
      }
    } else {
      battleWatch.strayedSince = 0;
      battleWatch.strayed = false;
    }
    if (world) battleWatch.worldRef = world;
    if (map) battleWatch.mapRef = map;
    if (body) battleWatch.bodyRef = body;
    if (sig.length) battleWatch.lastBodySig = sig;
  }

  function updateBattleSession(now) {
    detectBattleChange(now);
    var live = livePositionOk();
    if (live) {
      if (!battle.inBattle) enterBattle("live-pos");
      battle.posGoneSince = 0;
      return;
    }
    if (battle.inBattle) {
      if (!battle.posGoneSince) battle.posGoneSince = now;
      var instGone = !hooks.physicsWorld && !hooks.battleMap;
      if (instGone && now - battle.posGoneSince >= 2000) leaveBattle("left");
    }
  }

  function seedScanQueue(push) {
    push(window.Launcher);
    push(window._cmd);
    push(window.tankiStreamApi);
    try {
      var canvases = document.querySelectorAll("canvas");
      for (var i = 0; i < canvases.length; i++) push(canvases[i]);
    } catch (e) {}
    var listenerFns = capturedListeners.slice();
    try {
      collectListenerFns(window, listenerFns);
      collectListenerFns(document, listenerFns);
      collectListenerFns(document.body, listenerFns);
      collectListenerFns(document.documentElement, listenerFns);
      var cvs = document.querySelectorAll("canvas");
      for (var c = 0; c < cvs.length; c++) collectListenerFns(cvs[c], listenerFns);
    } catch (e2) {}
    listenerFns.forEach(push);
    try {
      var keys = Object.getOwnPropertyNames(window);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (/^(webkit|moz|chrome|on|external|clientInformation)/i.test(key)) continue;
        if (key === "toCoords") continue;
        try { push(window[key]); } catch (e3) {}
      }
    } catch (e4) {}
  }

  function resetScanCursor() {
    scanCursor.queue = null;
    scanCursor.seen = null;
  }

  function isGameBundleReady() {
    try { if (window.Launcher) return true; } catch (e) {}
    try { if (window.tankiStreamApi) return true; } catch (e2) {}
    try {
      var scripts = document.getElementsByTagName("script"), i, src;
      for (i = 0; i < scripts.length; i++) {
        src = scripts[i].src || "";
        if ((/\/static\/js\/main[\w.\-]*\.js/.test(src) || /main\.[a-f0-9]+\.js/.test(src)) && window.Launcher) return true;
      }
    } catch (e3) {}
    try { if (document.querySelector("canvas") && window.Launcher) return true; } catch (e4) {}
    return false;
  }

  function waitForGameBundle(cb) {
    var t0 = Date.now();
    function check() {
      if (isGameBundleReady()) { cb("ready"); return; }
      if (Date.now() - t0 > 45000) { cb("timeout"); return; }
      setTimeout(check, 200);
    }
    check();
  }

  function scanGraph(budgetMs, quiet) {
    if (OFF.scan) return;
    var t0 = performance.now();
    budgetMs = budgetMs || 45;
    if (!scanCursor.queue || !scanCursor.seen) {
      scanCursor.queue = [];
      scanCursor.seen = new Set();
    }
    var queue = scanCursor.queue;
    var seen = scanCursor.seen;

    function push(obj) {
      if (obj == null) return;
      var t = typeof obj;
      if (t !== "object" && t !== "function") return;
      if (seen.has(obj)) return;
      seen.add(obj);
      queue.push(obj);
    }

    seedScanQueue(push);

    var visited = 0;
    while (queue.length && performance.now() - t0 < budgetMs && visited < 80000) {
      var obj = queue.shift();
      visited++;
      if (shouldSkip(obj) && obj !== window.Launcher && obj !== window._cmd) {
        if (typeof obj === "function") recordCallable(obj);
        continue;
      }
      if (typeof obj === "function") recordCallable(obj);

      rememberBody(obj);
      rememberMount(obj);
      try { rememberRadarSystem(obj); } catch (eRad) {}
      try { rememberLiveObjects(obj); } catch (eCpL) {}
      try { rememberMapData(obj); } catch (eMap) {}
      maybePhysicsWorld(obj);
      if (obj instanceof Map) {
        try { var mapN = 0; obj.forEach(function (mv) { if (mapN++ < 400 && mv && typeof mv === "object" && !shouldSkip(mv)) push(mv); }); } catch (eMapV) {}
        continue;
      }

      var props;
      try {
        props = Object.getOwnPropertyNames(obj);
      } catch (e) { continue; }
      if (props.length > 400) continue;

      for (var p = 0; p < props.length; p++) {
        var name = props[p];
        if (name === "toCoords" || SCAN_SKIP_KEYS[name]) continue;
        var val;
        try {
          var desc = Object.getOwnPropertyDescriptor(obj, name);
          if (desc && typeof desc.get === "function" && !desc.get.callableName) {
            if (name.indexOf("_") === -1) continue;
          }
          val = obj[name];
        } catch (e) { continue; }
        var vt = typeof val;
        if (vt === "function") {
          recordCallable(val);
          if (!OFF.wrapPoint && val && (val.callableName === "initPoint" || val.callableName === "initNewStylePoint")) {
            try { val = wrapPointInitFn(obj, name, val); hooks[val.callableName] = val; } catch (eCp) {}
          }
        }
        if (vt === "object" || vt === "function") {
          if (val && !seen.has(val) && !shouldSkip(val)) push(val);
        }
      }

      try {
        var proto = Object.getPrototypeOf(obj);
        if (proto && proto !== Object.prototype && proto !== Function.prototype) {
          var pnames = Object.getOwnPropertyNames(proto);
          for (var q = 0; q < pnames.length && q < 80; q++) {
            var pn = pnames[q];
            if (pn === "constructor") continue;
            var pv;
            try {
              var pd = Object.getOwnPropertyDescriptor(proto, pn);
              if (!pd || typeof pd.get === "function") continue;
              pv = pd.value;
            } catch (e) { continue; }
            if (typeof pv === "function") recordCallable(pv);
          }
        }
      } catch (e) {}
    }

    if (!queue.length && !isPosHooked()) {
      scanCursor.queue = null;
      scanCursor.seen = null;
    }

    scanStats.runs++;
    scanStats.visited += visited;
    scanStats.lastMs = Math.round(performance.now() - t0);
    if (!quiet) logDebug("scan #" + scanStats.runs + " visited=" + visited + " ms=" + scanStats.lastMs + " bodies=" + bodyCandidates.length + " mounts=" + mountCandidates.length + " queue=" + (scanCursor.queue ? scanCursor.queue.length : 0));
  }

  /* ---------- overlay ---------- */

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed",
      "top:8px",
      "left:8px",
      "z-index:2147483647",
      "pointer-events:none",
      "font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "color:#d6ffd6",
      "background:rgba(0,0,0,0.62)",
      "padding:6px 8px",
      "border-radius:4px",
      "white-space:pre",
      "text-shadow:0 1px 2px #000",
      "user-select:none"
    ].join(";");
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function fmt(n, digits) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toFixed(digits);
  }

  function formatRayLine(label, a) {
    if (!a || a.type == null || a.dist == null) return label + ": —";
    var dist = fmt(a.dist, 1) + " м";
    if (a.name) return label + ": " + a.type + " (" + a.name + "), " + dist;
    return label + ": " + a.type + ", " + dist;
  }

  function render(me, waiting) {
    var el = ensureOverlay();
    if (waiting) {
      var sec = ((Date.now() - startedAt) / 1000) | 0;
      setOverlayText(el, "toCoords: жду бой… (" + sec + "s)\nscan " + scanStats.runs + ", hooks: " + hookSummary());
      return;
    }
    var htxt = me.headingDeg == null ? "—" : fmt(me.headingDeg, 1) + "°";
    var vtxt = speedState.kmh == null ? "—" : fmt(speedState.kmh, 1) + " км/ч";
    setOverlayText(el,
      "x " + fmt(me.x, 2) + " м" +
      "\ny " + fmt(me.y, 2) + " м" +
      "\nz " + fmt(me.z, 2) + " м" +
      "\nh " + htxt +
      "\nv " + vtxt +
      "\n" + formatRayLine("корпус", lastAhead && lastAhead.hull) +
      "\n" + formatRayLine("дуло", lastAhead && lastAhead.barrel));
  }

  var lastOverlayText = null, lastOverlayAt = 0;
  function setOverlayText(el, txt) {
    var now = Date.now();
    if (txt === lastOverlayText || now - lastOverlayAt < 100) return;
    lastOverlayText = txt;
    lastOverlayAt = now;
    el.textContent = txt;
  }

  function hookSummary() {
    var names = [];
    if (hooks.getLocalTankPosition) names.push("pos");
    if (hooks.isLocalTankAlive) names.push("alive");
    if (hooks.showPositionLocalTank) names.push("cmd");
    if (hooks.physicsBody) names.push("body");
    if (hooks.physicsWorld) names.push("ray");
    if (hooks.camera) names.push("cam");
    if (mountCandidates.length) names.push("mount");
    if (hooks.battleMap || mapCache.data) names.push("map");
    return names.length ? names.join(",") : "нет";
  }

  var lastHeadingDebug = null;

  function computeMe(now) {
    var pos = readPositionFromHook();
    if (!pos) return null;

    var hull = pickLocalHull(pos);
    var body = hull && hull.body ? hull.body : matchLocalBody(pos);
    var heading = null;
    var headingSource = null;
    var q = hull && hull.quat ? hull.quat : null;
    if (!q && body && body.v9i_1) {
      q = parseQuaternion(body.v9i_1.g9j_1);
    }
    if (q) {
      lastQuat = q;
      heading = quatToHeading(q);
      if (heading != null) headingSource = "physicsQuat";
    }
    var vel = hull && hull.vel ? hull.vel : (body && body.v9i_1 ? parseVector3(body.v9i_1.f9j_1) : null);
    var velH = headingFromVelocity(vel);
    if (heading == null && velH != null) {
      heading = velH;
      headingSource = "velocity";
    }
    var d = headingFromDelta(lastMeEngine, pos);
    if (heading == null && d != null) {
      heading = d;
      headingSource = "delta";
    }
    if (heading == null) {
      heading = lastHeading;
      if (heading != null) headingSource = "held";
    }
    if (heading != null) lastHeading = heading;
    lastHeadingSource = headingSource;

    lastMeEngine = { x: pos.x, y: pos.y, z: pos.z, heading: heading };
    updateSpeed(pos, now, body);

    var me = {
      x: toM(pos.x),
      y: toM(pos.y),
      z: toM(pos.z),
      heading: heading,
      headingDeg: radToDeg(heading),
      ready: true,
      source: lastSource,
      headingSource: headingSource
    };
    lastMe = me;
    lastHeadingDebug = {
      quat: q ? { w: q.w, x: q.x, y: q.y, z: q.z } : null,
      yawRad: heading,
      yawDeg: radToDeg(heading),
      forward: q ? quatForwardXY(q) : null,
      source: headingSource,
      velYawDeg: radToDeg(velH),
      bodyMatched: !!body,
      nearbyBodies: bodyCandidates.length,
      ang: hull && hull.ang != null ? hull.ang : null
    };
    return lastMeEngine;
  }

  function headingDebug() {
    var out = lastHeadingDebug || { error: "no heading yet" };
    console.log("[toCoords.headingDebug]", out);
    return out;
  }

  function targetedBodyScan(budgetMs) {
    if (OFF.scan) return;
    budgetMs = budgetMs || 40;
    var t0 = performance.now();
    var seen = [], q = [], i, obj, keys, k, v, n = 0;
    function push(o) {
      if (!o || (typeof o !== "object" && typeof o !== "function")) return;
      if (seen.indexOf(o) >= 0) return;
      seen.push(o);
      q.push(o);
    }
    push(hooks.physicsWorld);
    push(hooks.physicsBody);
    push(hooks.battleMap);
    try { if (hooks.physicsBody && hooks.physicsBody.b9i_1) push(hooks.physicsBody.b9i_1); } catch (e) {}
    for (i = 0; i < bodyCandidates.length && i < 12; i++) push(bodyCandidates[i]);
    for (i = 0; i < mountCandidates.length && i < 12; i++) push(mountCandidates[i]);
    while (q.length && performance.now() - t0 < budgetMs && n < 2500) {
      obj = q.shift();
      n++;
      try { rememberBody(obj); } catch (eB) {}
      try { rememberMount(obj); } catch (eM) {}
      try { rememberRadarSystem(obj); } catch (eRad2) {}
      try { rememberLiveObjects(obj); } catch (eCp2) {}
      try { rememberMapData(obj); } catch (eD) {}
      try { maybePhysicsWorld(obj); } catch (eW) {}
      if (obj instanceof Map) {
        try { var tmN = 0; obj.forEach(function (mv) { if (tmN++ < 400 && seen.length < 400) push(mv); }); } catch (eTm) {}
        continue;
      }
      try { keys = Object.getOwnPropertyNames(obj); } catch (eK) { continue; }
      for (i = 0; i < keys.length && i < 80; i++) {
        k = keys[i];
        if (SCAN_SKIP_KEYS[k]) continue;
        try { v = obj[k]; } catch (eV) { continue; }
        if (v && (typeof v === "object" || typeof v === "function") && seen.length < 400) push(v);
      }
    }
  }

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    drainCallableQueue();

    if (!gameReady) {
      if (isGameBundleReady()) {
        gameReady = true;
        resetScanCursor();
        try { installListenerCapture(); } catch (eReady) {}
        try { harvestCallables(window, 500); } catch (eH) {}
        try { scanGraph(80); } catch (eS) {}
        nextScanAt = now + 2000;
        burstFramesLeft = 0;
        lastBurstAt = now;
        logDebug("game bundle ready t=" + Math.round(now - startedAt) + "ms");
      } else {
        render(null, true);
        if (minimap.on && now >= nextMinimapAt) {
          try { drawMinimap(); } catch (eEarly) {}
          nextMinimapAt = now + 250;
        }
        return;
      }
    }

    try { updateBattleSession(now); } catch (eSess) {}

    var posHooked = isPosHooked() && !battleWatch.posStale;
    var live = livePositionOk();
    var hasWorld = !!hooks.physicsWorld && !battleWatch.strayed;
    if (live) posMissingSince = 0;
    var lobby = !battle.inBattle && !live && !hasWorld;
    var lobbyDue = lobby && (now - (lastBurstAt || 0) >= 2000);
    var scanSample = {
      posHooked: posHooked,
      hasWorld: hasWorld,
      inBattle: !!battle.inBattle,
      live: live,
      lobbyDue: lobbyDue
    };
    if (posHooked && hasWorld) {
      burstFramesLeft = 0;
      // Our own muzzle not found yet: keep a light background scan going (~5% of a frame budget),
      // otherwise the map ray falls back to the camera/hull direction.
      var needMount = radarScanRuns < RADAR_SCAN_MAX_RUNS && !(lastMeEngine && dirFromLocalMount(lastMeEngine));
      var needRadar = !hooks.radarSystem && radarScanRuns < RADAR_SCAN_MAX_RUNS;
      var sinceEnter = Date.now() - (battle.enteredAt || 0);
      var needCpLive = mapControlPoints.length > 0 && cpLive.length < mapControlPoints.length && sinceEnter < 60000;
      var earlyBattle = sinceEnter < 45000;
      if (now >= nextMountScanAt && (needMount || needRadar || needCpLive || earlyBattle)) {
        if (scanCursor.queue && !scanCursor.queue.length) resetScanCursor();
        try { scanGraph(5, true); } catch (eMs) {}
        radarScanRuns++;
        nextMountScanAt = now + 100;
      }
      var cpSearch = mapControlPoints.length < 1 && (Date.now() - (battle.enteredAt || 0)) < 30000;
      if ((!hooks.physicsBody || mountCandidates.length < 1 || cpSearch || needCpLive) && now >= nextScanAt) {
        try { targetedBodyScan(8); } catch (eT) {}
        nextScanAt = now + 200;
      }
    } else if (shouldBroadScan(scanSample) && now >= nextScanAt) {
      // Small slices every frame instead of 60-120 ms blocks: same search speed
      // over a second, but no visible freezes while driving.
      var budget = lobby ? 15 : 8;
      if (burstFramesLeft > 0 && !lobby) {
        budget = 12;
        burstFramesLeft--;
      }
      try { scanGraph(budget); } catch (e) { scanStats.lastError = String(e && e.message || e); }
      if (lobby) lastBurstAt = now;
      var delay;
      if (lobby) delay = 2000;
      else if (burstFramesLeft > 0 || (!posHooked && !battleWatch.posStale)) delay = 0;
      else delay = 50; // also while the position hook only returns nothing (dead / lobby)
      nextScanAt = now + delay;
    }

    var engineMe = computeMe(now);
    if (engineMe) {
      if (now >= nextRayAt) {
        lastAhead = castAhead(engineMe, true);
        nextRayAt = now + RAY_INTERVAL_MS;
      }
      render(lastMe, false);
    } else {
      render(null, true);
    }
    if (battle.inBattle || live) {
      try { updateFlagTakenStates(); } catch (eFl) {}
    }
    if (hooks.physicsWorld || hooks.battleMap || battle.inBattle || live) {
      try { maybeStartMapCache(); } catch (eCache) {}
    }
    // Flags, points, battle format and the follow camera hang off the battle
    // world's controller Map: a short walk from there finds them quickly.
    var sinceIn = Date.now() - (battle.enteredAt || 0);
    if ((hooks.physicsWorld || hooks.radarSystem || mountCandidates.length) && now >= nextLiveWalkAt &&
        (sinceIn < 45000 || ((!battleParams || !followCam || !magnumAim) && sinceIn < 600000))) {
      try { walkBattleWorld(battleWorld(), 4); } catch (eLw) {}
      nextLiveWalkAt = now + 1000;
    }
    if (!parkourSearchDone() && (hooks.physicsWorld || followCam || hooks.radarSystem)) {
      try { parkourSearchStep(3); } catch (ePk) {}
    }
    applyParkourCam();
    if (now >= nextTreesAt) {
      try { applyParkourTrees(); } catch (eTr) {}
      nextTreesAt = now + 1000;
    }
    minimapFrame(now);
  }

  function status() {
    return {
      ready: !!(lastMe && lastMe.ready),
      inBattle: !!battle.inBattle,
      battleId: battle.id,
      nativeMaps: nativeState.ready,
      drive: !!minimap.drive,
      localAlive: isLocalAlive(),
      off: offList(),
      unitToMeter: UNIT,
      hooks: {
        getLocalTankPosition: !!hooks.getLocalTankPosition,
        isLocalTankAlive: !!hooks.isLocalTankAlive,
        showPositionLocalTank: !!hooks.showPositionLocalTank,
        physicsBody: !!hooks.physicsBody,
        physicsWorld: !!hooks.physicsWorld,
        radar: !!hooks.radarSystem,
        cpLive: cpLive.length,
        cpPoints: mapControlPoints.length,
        flagBases: mapTeamPoints.length,
        flagLive: flagLive.length,
        parkour: isParkour(),
        battleFormat: battlefieldCC ? String(battlefieldCC.bic_1) : null,
        followCam: !!followCam,
        parkourCam: parkourCam.mult,
        magnumAim: !!magnumAim,
        ownBody: !!ownBodyFromCamera(),
        posSource: lastSource,
        radarMarkers: (function () { try { return radarMarkers().length; } catch (e) { return 0; } })(),
        radarRange: (function () {
          try {
            var pr = hooks.radarSystem && hooks.radarSystem.j11x_1;
            if (!pr || !isFiniteNum(pr.dje_1)) return null;
            return { enterM: Math.round(toM(pr.dje_1) * 10) / 10, exitM: isFiniteNum(pr.eje_1) ? Math.round(toM(pr.eje_1) * 10) / 10 : null };
          } catch (e) { return null; }
        })(),
        camera: !!hooks.camera,
        battleMap: !!hooks.battleMap,
        mapName: hooks.mapName || null,
        hasB9m: (typeof worldHasFn === "function") ? worldHasFn("b9m") : false,
        bodyCandidates: bodyCandidates.length,
        mountCandidates: mountCandidates.length,
        getEventListeners: typeof getEventListeners === "function"
      },
      hookSummary: hookSummary(),
      source: lastMe && lastMe.source,
      headingSource: lastHeadingSource,
      barrelSource: lastBarrelSource,
      speed: { kmh: speedState.kmh, mps: speedState.mps, source: speedState.source },
      ahead: lastAhead,
      rayError: lastRayError,
      scan: scanStats,
      interestingFound: Object.keys(foundCallables).filter(function (k) { return INTERESTING[k]; }),
      debugLog: debugLog.slice()
    };
  }

  function debug() {
    debugOn = true;
    var payload = {
      status: status(),
      callableCounts: foundCallables,
      note: "Только диагностика хуков. Чужие координаты не собираются и не печатаются."
    };
    console.log("[toCoords.debug]", payload);
    return payload;
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    var el = document.getElementById(OVERLAY_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    overlay = null;
    var mm = document.getElementById(MINIMAP_ID);
    if (mm && mm.parentNode) mm.parentNode.removeChild(mm);
    minimap.wrap = null;
    minimap.canvas = null;
    try { document.removeEventListener("keydown", onMinimapHotkey, true); } catch (eKey) {}
    logDebug("stopped");
    return "stopped";
  }

  window.toCoords = {
    me: function () {
      return lastMe || { ready: false, x: null, y: null, z: null, heading: null, headingDeg: null };
    },
    speed: function () {
      return {
        kmh: speedState.kmh,
        mps: speedState.mps,
        ready: speedState.kmh != null,
        source: speedState.source
      };
    },
    ahead: function () {
      function snap(a) {
        return a && a.type != null
          ? { type: a.type, name: a.name, dist: a.dist }
          : { type: null, name: null, dist: null };
      }
      return {
        hull: snap(lastAhead && lastAhead.hull),
        barrel: snap(lastAhead && lastAhead.barrel)
      };
    },
    rayDebug: function () {
      if (lastMeEngine) lastAhead = castAhead(lastMeEngine, true);
      var out = lastRayDebug || { error: "no ray has been attempted yet" };
      console.log("[toCoords.rayDebug]", out);
      return out;
    },
    status: status,
    scan: function () {
      scanGraph(80);
      return status();
    },
    exportMap: exportMap,
    mapDebug: mapDebug,
    minimap: minimapApi,
    pickMapFolder: pickMapFolder,
    grantMapFolder: grantMapFolder,
    loadMapFile: loadMapFile,
    saveMap: saveMap,
    headingDebug: headingDebug,
    engineRays: function (on) {
      if (on === true || on === false) {
        engineRaysOn = on;
        try { localStorage.setItem("toCoords.engineRays", on ? "1" : "0"); } catch (e) {}
      }
      return engineRaysOn;
    },
    // toCoords.off()                 -> list what is switched off now
    // toCoords.off("cn,listeners")   -> switch those off after a page reload
    // toCoords.off("all") / off("")  -> everything off / everything back on
    off: function (list) {
      if (typeof list === "string") {
        var want = list.split(/[\s,]+/).filter(function (k) { return k === "all" || OFF_KEYS.indexOf(k) >= 0; });
        try { localStorage.setItem("toCoords.off", want.join(",")); } catch (e) {}
        var msg = want.length ? "после перезагрузки будет выключено: " + want.join(", ") : "после перезагрузки всё снова включено";
        console.log("[toCoords] " + msg + ". Перезагрузи страницу (F5).");
        return msg;
      }
      return { now: offList(), keys: OFF_KEYS.slice() };
    },
    // parkour camera: what the script sees and what the camera currently uses
    camDebug: function () {
      var c = followCam, out = {
        parkour: isParkour(),
        battleFormat: battlefieldCC ? String(battlefieldCC.bic_1) : null,
        parkourFlag: battlefieldCC ? battlefieldCC.hic_1 : null,
        sources: { battleData: !!battlefieldCC, battleParams: !!battleParams, mapComponent: mapComp ? mapComp.m102_1 : null },
        treesHidden: treesHidden.filter(function (t) { try { return !t.o.m3k(); } catch (e) { return false; } }).length,
        searching: !parkourKnown(),
        cameras: followCams.length,
        ours: !!c,
        mult: parkourCam.mult,
        off: !!OFF.camera
      };
      try {
        if (c) {
          out.distance = Math.round(c.uzs_1.uzu_1);
          out.height = Math.round(c.uzs_1.vzu_1);
          out.key0 = { d: Math.round(c.tzs_1.wzu_1.uzu_1), h: Math.round(c.tzs_1.wzu_1.vzu_1) };
          out.azv = c.tzs_1.azv_1;
          out.path = Math.round(c.qzs_1 * 1000) / 1000;
        }
      } catch (e) { out.error = String(e && e.message || e); }
      return out;
    },
    // Magnum aim as the game shows it right now (null when not aiming)
    aimDebug: function () {
      var st = magnumAimState();
      if (!st) return { found: !!magnumAim, showing: false };
      return { found: true, showing: true, points: st.pts.length, land: st.land ? { x: Math.round(st.land.x * 10) / 10, y: Math.round(st.land.y * 10) / 10 } : null };
    },
    // CTF flags the game is showing a marker for right now (carried / dropped)
    flagDebug: function () {
      return flagLiveStates().map(function (f) {
        return { state: f.state, team: f.team, ourTeam: f.local, x: Math.round(f.pos.x), y: Math.round(f.pos.y) };
      });
    },
    // live control points: owner, score (-100..100), who is capturing, our team
    cpDebug: function () {
      return cpLiveStates().map(function (c) {
        return { letter: c.letter, owner: c.owner || "NEUTRAL", score: Math.round(c.score), capturing: c.capTeam, ourTeam: c.local, active: c.active };
      });
    },
    radarDebug: function () {
      var sys = hooks.radarSystem;
      if (!sys) return { radar: false };
      return iterList(sys.n11x_1).slice(0, 12).map(function (e) {
        var m = e && e.u11x_1, spr = m && m.q11w_1, nums = {}, k;
        try {
          for (k in spr) {
            if (typeof spr[k] === "number" || typeof spr[k] === "string" || typeof spr[k] === "boolean") nums[k] = spr[k];
          }
        } catch (eK) {}
        var col = spr && spr.d4q_1, colFields = null;
        if (col && typeof col === "object") {
          colFields = {};
          try { Object.keys(col).forEach(function (ck) { var cv = col[ck]; if (typeof cv !== "object" && typeof cv !== "function") colFields[ck] = cv; }); } catch (eCF) {}
        }
        return { color: typeof col === "object" ? "[object]" : col, colorFields: colFields, rgb: colorToRgb(col), colorHex: typeof col === "number" ? "#" + ((col >>> 0).toString(16)) : null, ally: radarColorIsAlly(col), sprite: nums };
      });
    },
    _decideBattleChange: decideBattleChange,
    _shouldBroadScan: shouldBroadScan,
    debug: debug,
    stop: stop
  };

  function boot() {
    if (boot.done) return;
    boot.done = true;
    ensureOverlay();
    render(null, true);
    if (minimap.on) {
      try { ensureMinimap(); } catch (eMin) {}
    }
    try { document.addEventListener("keydown", onMinimapHotkey, true); } catch (eKey) {}
    rafId = requestAnimationFrame(tick);
    function startScan(reason) {
      gameReady = isGameBundleReady() || reason === "timeout";
      resetScanCursor();
      try { installListenerCapture(); } catch (eCap) {}
      if (gameReady) {
        try { harvestCallables(window, 500); } catch (eH) {}
        try { scanGraph(80); } catch (e) { scanStats.lastError = String(e && e.message || e); }
        burstFramesLeft = 0;
        nextScanAt = (typeof performance !== "undefined" ? performance.now() : Date.now()) + 2000;
      }
      console.log("[toCoords] запущен. toCoords.me() / speed() / ahead() / exportMap() / minimap() / pickMapFolder() / loadMapFile() / saveMap() / headingDebug() / mapDebug() / rayDebug() / status() / stop()");
    }
    installNativeListener();
    pingNative().then(function () { try { updateMinimapChrome(); } catch (eN) {} });
    if (isGameBundleReady()) startScan("ready");
    else waitForGameBundle(startScan);
  }

  installListenerCapture();
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
