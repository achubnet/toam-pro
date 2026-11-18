(function () {
  "use strict";

  var G = TOC.game.names;
  var GAME = TOC.game;

  if (window.toCoords && typeof window.toCoords.stop === "function") {
    try { window.toCoords.stop(); } catch (e) {}
  }

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

  var UNIT = 0.01;
  var RAY_MAX_M = 100;
  var RAY_MAX = RAY_MAX_M / UNIT;
  var ORIGIN_UP = 1.0 / UNIT;
  var ORIGIN_FWD = 0.8 / UNIT;
  var MIN_HIT_M = 3;
  var MIN_HIT = MIN_HIT_M / UNIT;
  var MOUNT_MATCH_M = 5;
  var MOUNT_MATCH = MOUNT_MATCH_M / UNIT;
  var SPEED_WINDOW_MS = 500;
  var MAX_MPS = 40;
  var RAY_INTERVAL_MS = 250;
  var CALLABLE_ROLES = {};
  Object.keys(GAME.callables).forEach(function (role) { CALLABLE_ROLES[GAME.callables[role]] = role; });

  var hooks = {
    localTankPosition: null,
    localTankAlive: null,
    printLocalTankPosition: null,
    initPoint: null,
    initNewStylePoint: null,
    physicsBody: null,
    physicsWorld: null,
    camera: null,
    battleMap: null,
    mapName: null,
    radarSystem: null
  };
  var radarScanRuns = 0;
  var RADAR_SCAN_MAX_RUNS = 360;
  var bodyCandidates = [];
  var mountCandidates = [];
  var foundCallables = {};
  var scanStats = { runs: 0, visited: 0, lastMs: 0, lastError: null };
  var lastMeEngine = null;
  var lastMe = null;
  var lastQuat = null;
  var lastHeading = null;
  var lastHeadingSource = null;
  var lastSource = null;
  var lastPosRef = null;
  var running = true;
  var lastHeadingDebug = null;
  var pageStartedAt = performance.now();

  function readSetting(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function writeSetting(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  var rafId = 0;
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
          if (typeof v === "string" && has.call(CALLABLE_ROLES, v) && cnQueue.length < 500) cnQueue.push(this);
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
  logDebug("session start hooks=" + (hooks.localTankPosition ? "pos" : "no-pos"));

  function isVec3String(s) {
    return typeof s === "string" && s.indexOf(GAME.tags.vector) === 0;
  }
  function isQuatString(s) {
    return typeof s === "string" && s.indexOf(GAME.tags.quaternion) === 0;
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
      var m = GAME.vectorText.exec(s);
      if (!m) return null;
      var x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
      return { x: x, y: y, z: z, ref: obj };
    }
    if (isFiniteNum(obj[G.x]) && isFiniteNum(obj[G.y]) && isFiniteNum(obj[G.z])) {
      return { x: obj[G.x], y: obj[G.y], z: obj[G.z], ref: obj };
    }
    return null;
  }

  function parseQuaternion(obj) {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return null;
    var w, x, y, z;
    if (isFiniteNum(obj[G.quatW]) && isFiniteNum(obj[G.quatX]) && isFiniteNum(obj[G.quatY]) && isFiniteNum(obj[G.quatZ])) {
      w = obj[G.quatW]; x = obj[G.quatX]; y = obj[G.quatY]; z = obj[G.quatZ];
    } else {
      var s;
      try { s = obj.toString(); } catch (e) { return null; }
      if (!isQuatString(s)) return null;
      var m = GAME.quaternionText.exec(s);
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
      var w = body && body[G.bodyState] && body[G.bodyState][G.angularVelocity];
      if (!w) return 0;
      if (isFiniteNum(w[G.z])) {
        return Math.sqrt((w[G.x] || 0) * (w[G.x] || 0) + (w[G.y] || 0) * (w[G.y] || 0) + (w[G.z] || 0) * (w[G.z] || 0));
      }
      if (isFiniteNum(w.z) || isFiniteNum(w.x)) {
        return Math.sqrt((w.x || 0) * (w.x || 0) + (w.y || 0) * (w.y || 0) + (w.z || 0) * (w.z || 0));
      }
    } catch (e) {}
    return 0;
  }

  function bodyHeadingInfo(body) {
    try {
      if (!body || !body[G.bodyState]) return null;
      var q = parseQuaternion(body[G.bodyState][G.orientation]);
      if (!q) return null;
      var f = quatForwardXY(q);
      if (!f) return null;
      return {
        body: body,
        quat: q,
        heading: Math.atan2(f.y, f.x),
        forward: f,
        ang: bodyAngularAbs(body),
        vel: parseVector3(body[G.bodyState][G.velocity])
      };
    } catch (e) { return null; }
  }

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
      if (nearby[0].body[G.bodyOwner] && nearby[0].body[G.bodyOwner][G.entityWorld] && typeof nearby[0].body[G.bodyOwner][G.entityWorld][G.raycast] === "function") {
        hooks.physicsWorld = nearby[0].body[G.bodyOwner][G.entityWorld];
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

  function quatForwardXY(q) {
    if (!q) return null;
    var w = q.w, x = q.x, y = q.y, z = q.z;
    var fx = 2 * (x * y - w * z);
    var fy = 1 - 2 * (x * x + z * z);
    var fz = 2 * (y * z + w * x);
    var len = Math.sqrt(fx * fx + fy * fy);
    if (len < 0.15) {
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
    if (dx * dx + dy * dy < 25) return null;
    return Math.atan2(dy, dx);
  }

  function readPositionFromHook() {
    var own = ownBodyFromCamera();
    if (!OFF.pos && own && own[G.bodyState]) {
      var ov = parseVector3(own[G.bodyState][G.position]);
      if (ov) {
        lastSource = "followCamera.body";
        lastPosRef = ov.ref || lastPosRef;
        ov._quat = parseQuaternion(own[G.bodyState][G.orientation]);
        ov._vel = parseVector3(own[G.bodyState][G.velocity]);
        return ov;
      }
    }
    if (!OFF.pos && typeof hooks.localTankPosition === "function") {
      var r = safeCall(hooks.localTankPosition);
      if (r && !r.__error) {
        var v = parseVector3(r);
        if (v) {
          lastSource = "localTankPosition";
          lastPosRef = v.ref || lastPosRef;
          return v;
        }
      }
    }
    if (!OFF.pos && typeof hooks.printLocalTankPosition === "function") {
      var captured = null;
      var fake = {
        [G.consolePrint]: function (msg) { captured = msg; },
        toString: function () { return "toCoordsConsole"; }
      };
      var sr = safeCall(hooks.printLocalTankPosition, [fake]);
      if (!sr || !sr.__error && typeof captured === "string") {
        var m = GAME.vectorText.exec(captured || "");
        if (m) {
          lastSource = "printLocalTankPosition";
          return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), ref: null };
        }
      }
    }
    var matched = matchLocalBody(lastMeEngine);
    if (matched && matched[G.bodyState]) {
      var pv = parseVector3(matched[G.bodyState][G.position]);
      if (pv) {
        lastSource = "physicsBody[G.bodyState]";
        lastPosRef = pv.ref || lastPosRef;
        pv._quat = parseQuaternion(matched[G.bodyState][G.orientation]);
        pv._vel = parseVector3(matched[G.bodyState][G.velocity]);
        return pv;
      }
    }
    return null;
  }

  function ownBodyFromCamera() {
    try {
      var tp = followCam && followCam[G.cameraTankPhysics];
      if (!tp) return null;
      var b = tp[G.physicsBody] || (typeof tp[G.getBody] === "function" ? tp[G.getBody]() : null);
      return b && b[G.bodyState] ? b : null;
    } catch (e) { return null; }
  }

  function isLocalAlive() {
    if (OFF.pos || typeof hooks.localTankAlive !== "function") return null;
    var r = safeCall(hooks.localTankAlive);
    if (r && r.__error) return null;
    return !!r;
  }

  function bodyPos(body) {
    try {
      if (!body || !body[G.bodyState]) return null;
      return parseVector3(body[G.bodyState][G.position]);
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
    if (best && bestD < 300) {
      hooks.physicsBody = best;
      try {
        if (best[G.bodyOwner] && best[G.bodyOwner][G.entityWorld] && typeof best[G.bodyOwner][G.entityWorld][G.raycast] === "function") {
          hooks.physicsWorld = best[G.bodyOwner][G.entityWorld];
          attachCameraFromWorld(hooks.physicsWorld);
        }
      } catch (e) {}
      return best;
    }
    return hooks.physicsBody;
  }

  function readBodyVelMps(body) {
    try {
      if (!body || !body[G.bodyState]) return null;
      var v = parseVector3(body[G.bodyState][G.velocity]);
      if (!v) return null;
      return Math.sqrt(v.x * v.x + v.y * v.y) * UNIT;
    } catch (e) { return null; }
  }

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

  var TANKISH_NAME = /hull|turret|chassis|tank|cannon|weapon|barrel/i;

  function staticOnlyFilter(body) {
    try {
      if (!body) return false;
      if (body[G.bodyOwner] != null) return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  var STATIC_FILTER = { m9r: staticOnlyFilter };
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
    try { body = shape[G.shapeBody] || null; } catch (e) { body = null; }
    var cands = [];
    try { cands.push(nameFromValue(shape[G.shapeTag]), nameFromValue(shape[G.shapeTagAlt])); } catch (e) {}
    if (body) {
      try { cands.push(nameFromValue(body[G.shapeTag]), nameFromValue(body[G.shapeTagAlt]), nameFromValue(body)); } catch (e) {}
    }
    for (var i = 0; i < cands.length; i++) if (cands[i]) return cands[i];
    return null;
  }

  function isTankishHit(hit) {
    try {
      var shape = hit && hit[G.hitShape];
      if (!shape) return false;
      var body = shape[G.shapeBody] || null;
      if (body && body[G.bodyOwner] != null) return true;
      var raw = [];
      try { raw.push(shape[G.shapeTag], shape[G.shapeTagAlt]); } catch (e) {}
      if (body) {
        try { raw.push(body[G.shapeTag], body[G.shapeTagAlt]); } catch (e) {}
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
    if (lastPosRef && typeof lastPosRef[G.clone] === "function") {
      try { v = lastPosRef[G.clone](); } catch (e) { v = null; }
    }
    if (v && isFiniteNum(v[G.x])) {
      v[G.x] = x; v[G.y] = y; v[G.z] = z;
      if (typeof v[G.setXYZ] === "function") {
        try { v[G.setXYZ](x, y, z); } catch (e) {}
      }
      return v;
    }
    return { [G.x]: x, [G.y]: y, [G.z]: z };
  }

  function makeHitResult() {
    var normal = {
      [G.x]: 0, [G.y]: 0, [G.z]: 0,
      [G.setXYZ]: function (x, y, z) { this[G.x] = x; this[G.y] = y; this[G.z] = z; },
      [G.copyFrom]: function (o) {
        if (!o) return;
        this[G.x] = o[G.x]; this[G.y] = o[G.y]; this[G.z] = o[G.z];
      }
    };
    var point = {
      [G.x]: 0, [G.y]: 0, [G.z]: 0,
      [G.setOnRay]: function (origin, dist, dir) {
        this[G.x] = origin[G.x] + dist * dir[G.x];
        this[G.y] = origin[G.y] + dist * dir[G.y];
        this[G.z] = origin[G.z] + dist * dir[G.z];
      }
    };
    return {
      [G.hitDistance]: 0,
      [G.hitShape]: null,
      [G.hitNormal]: normal,
      [G.hitPoint]: point,
      [G.hitTests]: 0,
      [G.hitStatA]: 0,
      [G.hitStatB]: 0,
      [G.hitStatC]: 0,
      [G.copyHit]: function (o) {
        if (!o) return;
        this[G.hitDistance] = o[G.hitDistance];
        this[G.hitShape] = o[G.hitShape];
        this[G.hitTests] = o[G.hitTests];
        if (o[G.hitNormal]) this[G.hitNormal][G.copyFrom](o[G.hitNormal]);
        if (o[G.hitPoint]) {
          this[G.hitPoint][G.x] = o[G.hitPoint][G.x];
          this[G.hitPoint][G.y] = o[G.hitPoint][G.y];
          this[G.hitPoint][G.z] = o[G.hitPoint][G.z];
        }
      },
      [G.resetHit]: function () {},
      [G.clone]: function () { return this; }
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
      var cam = world && world[G.renderCamera];
      if (cam && cam[G.cameraRotation] && isFiniteNum(cam[G.cameraRotation][G.z])) {
        hooks.camera = cam;
      }
    } catch (e) {}
  }

  function dirFromCamera() {
    var cam = hooks.camera;
    if (!cam) {
      attachCameraFromWorld(hooks.physicsWorld);
      cam = hooks.camera;
    }
    if (!cam || !cam[G.cameraRotation]) return null;
    var yaw = cam[G.cameraRotation][G.z];
    if (!isFiniteNum(yaw)) return null;
    return { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 };
  }

  function looksLikeMuzzleSocket(s) {
    try {
      return !!(s && s[G.socketPosition] && isFiniteNum(s[G.socketPosition][G.x]) &&
        s[G.socketDirection] && isFiniteNum(s[G.socketDirection][G.x]) && isFiniteNum(s[G.socketDirection][G.y]) &&
        isFiniteNum(s[G.socketDirection][G.z]));
    } catch (e) {
      return false;
    }
  }

  function rememberMount(obj) {
    try {
      if (!(obj && obj[G.mountMatrix] && typeof obj[G.mountMatrix][G.rotateVector] === "function")) return;
      if (!obj[G.mountSockets] || typeof obj[G.mountSockets].length !== "number") return;
      if (mountCandidates.indexOf(obj) >= 0) return;
      if (mountCandidates.length > 40) mountCandidates.shift();
      mountCandidates.push(obj);
    } catch (e) {}
  }

  function dirFromMountMatrix(mount) {
    if (!mount || !mount[G.mountMatrix] || typeof mount[G.mountMatrix][G.rotateVector] !== "function") return null;
    var localY = makeGameVec(0, 1, 0);
    var out = makeGameVec(0, 0, 0);
    try {
      mount[G.mountMatrix][G.rotateVector](localY, out);
    } catch (e) {
      return null;
    }
    return normalizeDir(out[G.x], out[G.y], out[G.z]);
  }

  function dirFromLocalMount(engineMe) {
    if (!engineMe || !mountCandidates.length) return null;
    var bestSock = null, bestMount = null, bestD = Infinity, i, j, m, socks, s, dx, dy, dz, d2, dir;
    for (i = 0; i < mountCandidates.length; i++) {
      m = mountCandidates[i];
      socks = m[G.mountSockets];
      if (!socks) continue;
      for (j = 0; j < socks.length; j++) {
        s = socks[j];
        if (!looksLikeMuzzleSocket(s)) continue;
        dx = s[G.socketPosition][G.x] - engineMe.x;
        dy = s[G.socketPosition][G.y] - engineMe.y;
        dz = s[G.socketPosition][G.z] - engineMe.z;
        d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          bestSock = s;
          bestMount = m;
        }
      }
    }
    if (!bestSock || bestD > MOUNT_MATCH * MOUNT_MATCH) return null;
    dir = normalizeDir(bestSock[G.socketDirection][G.x], bestSock[G.socketDirection][G.y], bestSock[G.socketDirection][G.z]);
    if (!dir) dir = dirFromMountMatrix(bestMount);
    if (!dir) return null;
    return {
      dir: dir,
      origin: {
        x: bestSock[G.socketPosition][G.x],
        y: bestSock[G.socketPosition][G.y],
        z: bestSock[G.socketPosition][G.z]
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
    return world[G.raycast](origin, dir, maxDist, mask, hit, filter);
  }

  function interpretHit(ok, hit, dbg, engineMe, ox, oy, oz, fwd, traveled) {
    dbg.z9lResult = !!ok;
    if (hit) {
      dbg.hitDistEngine = isFiniteNum(hit[G.hitDistance]) ? hit[G.hitDistance] + traveled : null;
      dbg.hitDistM = dbg.hitDistEngine != null ? toM(dbg.hitDistEngine) : null;
      dbg.hitNormalZ = hit[G.hitNormal] ? hit[G.hitNormal][G.z] : null;
      try { dbg.hitShapeName = hit[G.hitShape] ? (hit[G.hitShape][G.shapeTag] || null) : null; } catch (e) { dbg.hitShapeName = null; }
    }
    if (!ok) return emptyAhead();
    if (isTankishHit(hit)) {
      dbg.rejectedAsTank = true;
      return emptyAhead();
    }
    dbg.rejectedAsTank = false;
    var dist = hit[G.hitDistance];
    if (!isFiniteNum(dist) || dist < 0 || dist > RAY_MAX * 1.05) return emptyAhead();
    var hx = ox + fwd.x * dist;
    var hy = oy + fwd.y * dist;
    var hz = oz + fwd.z * dist;
    var nz = hit[G.hitNormal] ? hit[G.hitNormal][G.z] : 0;
    if (!isFiniteNum(nz)) nz = 0;
    var cls = classifyHit(nz, nameFromHit(hit[G.hitShape]));
    return { type: cls.type, name: cls.name, dist: toM(dist + traveled) };
  }

  function rayDebugBase(engineMe) {
    return {
      unitToMeter: UNIT,
      heading: engineMe && engineMe.heading,
      headingDeg: engineMe && radToDeg(engineMe.heading),
      headingSource: lastHeadingSource,
      hasQuat: !!lastQuat,
      worldFound: !!(hooks.physicsWorld && typeof hooks.physicsWorld[G.raycast] === "function"),
      z9lArity: hooks.physicsWorld && hooks.physicsWorld[G.raycast] && hooks.physicsWorld[G.raycast].length,
      bodyMatched: !!hooks.physicsBody,
      cameraFound: !!hooks.camera,
      mountsFound: mountCandidates.length,
      clonedVec: !!(lastPosRef && typeof lastPosRef[G.clone] === "function"),
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

  var STATIC_MASK = GAME.staticMask;
  var staticPrimCache = { at: 0, prims: null, debug: null };

  function getCollisionWorlds() {
    var out = [], seen = [];
    function add(o) {
      if (!o || (typeof o !== "object" && typeof o !== "function")) return;
      if (seen.indexOf(o) >= 0) return;
      seen.push(o);
      out.push(o);
      if (seen.length > 30) return;
      try { if (o[G.physics]) add(o[G.physics]); } catch (e) {}
      try { if (o[G.collisionDetector]) add(o[G.collisionDetector]); } catch (e2) {}
      try { if (o[G.entityWorld]) add(o[G.entityWorld]); } catch (e3) {}
      try { if (o[G.bodyLink]) add(o[G.bodyLink]); } catch (e4) {}
    }
    add(hooks.physicsWorld);
    add(hooks.physicsBody);
    try { if (hooks.physicsBody && hooks.physicsBody[G.bodyOwner]) add(hooks.physicsBody[G.bodyOwner]); } catch (e5) {}
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
        if (!(b[G.bodyState] || b[G.bodyShapes])) return;
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
      try { considerList(w[G.bodies]); } catch (e) {}
      try { if (w[G.physics]) considerList(w[G.physics][G.bodies]); } catch (e2) {}
      try { if (w[G.collisionDetector]) considerList(w[G.collisionDetector][G.bodies]); } catch (e3) {}
    }
    for (i = 0; i < bodyCandidates.length; i++) consider(bodyCandidates[i]);
    return bodies;
  }

  function bodiesOfWorld(world) {
    var bodies = [], seen = [];
    function consider(b) {
      if (!b || seen.indexOf(b) >= 0) return;
      try { if (!(b[G.bodyState] || b[G.bodyShapes])) return; } catch (e) { return; }
      seen.push(b);
      bodies.push(b);
    }
    function considerList(list) {
      var arr = iterList(list), i;
      for (i = 0; i < arr.length; i++) consider(arr[i]);
    }
    if (!world) return bodies;
    try { considerList(world[G.bodies]); } catch (e) {}
    try { if (world[G.physics]) considerList(world[G.physics][G.bodies]); } catch (e2) {}
    try { if (world[G.collisionDetector]) considerList(world[G.collisionDetector][G.bodies]); } catch (e3) {}
    return bodies;
  }

  function worldHasBody(world, body) {
    if (!world || !body) return false;
    return bodiesOfWorld(world).indexOf(body) >= 0;
  }

  function isStaticBody(b) {
    if (!b || b === hooks.physicsBody) return false;
    try {
      if (b[G.bodyOwner] != null) return false;
    } catch (e) { return false; }
    try {
      var raw = [b[G.shapeTag], b[G.shapeTagAlt]];
      var i;
      for (i = 0; i < raw.length; i++) {
        if (typeof raw[i] === "string" && TANKISH_NAME.test(raw[i])) return false;
      }
    } catch (e2) {}
    return true;
  }

  function readShapeName(shape) {
    try {
      var n = shape && shape[G.shapeTag];
      if (typeof n === "string" && n && !TANKISH_NAME.test(n)) return n;
    } catch (e) {}
    return null;
  }

  function matFromTransform(tr) {
    if (!tr || !isFiniteNum(tr[G.m00])) return null;
    return {
      g22: tr[G.m00], h22: tr[G.m10], i22: tr[G.m20],
      j22: tr[G.m01], k22: tr[G.m11], l22: tr[G.m21],
      m22: tr[G.m02], n22: tr[G.m12], o22: tr[G.m22]
    };
  }

  function posFromTransform(tr) {
    if (!tr || !isFiniteNum(tr[G.tx])) return null;
    return { x: tr[G.tx], y: tr[G.ty], z: tr[G.tz] };
  }

  function matToEuler(m) {
    if (!m) return { x: 0, y: 0, z: 0 };
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
      var body = shape[G.shapeBody];
      if (body && (body === hooks.physicsBody || body[G.bodyOwner] != null)) return false;
    } catch (e) { return false; }
    try {
      var n = shape[G.shapeTag];
      if (typeof n === "string" && TANKISH_NAME.test(n)) return false;
    } catch (e2) {}
    return true;
  }

  function collectionLen(v) {
    try {
      if (v == null) return 0;
      if (typeof v[G.size] === "function") return v[G.size]();
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

  function collectShapesFromAccel(world, into, seen, stats) {
    if (!world) return;
    try {
      var grid = world[G.staticGrid];
      if (grid && grid[G.gridCells] && typeof grid[G.gridCells].length === "number") {
        var cells = grid[G.gridCells], ci, cell, list, si, filled = 0;
        stats.grids.push({
          cells: cells.length,
          cellSize: grid[G.gridCellSize] || null,
          nx: grid[G.gridCountX] || null,
          ny: grid[G.gridCountY] || null,
          nz: grid[G.gridCountZ] || null
        });
        for (ci = 0; ci < cells.length; ci++) {
          cell = cells[ci];
          if (!cell || !cell[G.cellShapes]) continue;
          list = iterList(cell[G.cellShapes]);
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
          if (node[G.nodeShapes]) {
            var leaf = iterList(node[G.nodeShapes]), li;
            stats.treeLeaves++;
            for (li = 0; li < leaf.length; li++) addUniqueShape(leaf[li], into, seen);
          }
        } catch (e2) {}
        try { if (node[G.nodeLeft]) walkTree(node[G.nodeLeft], depth + 1); } catch (e3) {}
        try { if (node[G.nodeRight]) walkTree(node[G.nodeRight], depth + 1); } catch (e4) {}
      }
      if (world[G.staticTree]) {
        stats.trees++;
        walkTree(world[G.staticTree], 0);
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
      try { if (w[G.collisionDetector]) collectShapesFromAccel(w[G.collisionDetector], into, seen, stats); } catch (e) {}
      try { if (w[G.physics]) collectShapesFromAccel(w[G.physics], into, seen, stats); } catch (e2) {}
    }
    stats.shapeCount = into.length;
    return { shapes: into, stats: stats };
  }

  function extractShapePrim(shape) {
    if (!shape) return null;
    var tr = null, pos = null, mat = null, typ = null;
    try { tr = shape[G.shapeTransform]; } catch (e) {}
    try { typ = shape[G.shapeType]; } catch (e0) {}
    pos = posFromTransform(tr);
    mat = matFromTransform(tr);
    var hasXform = !!(pos && mat);
    if (!pos) pos = { x: 0, y: 0, z: 0 };
    if (!mat) mat = IDENTITY_MAT;
    var name = readShapeName(shape);
    var he, prim, v0, v1, v2, aabb;

    try {
      if (shape[G.boxHalfSize] && isFiniteNum(shape[G.boxHalfSize][G.x]) && hasXform) {
        he = { x: shape[G.boxHalfSize][G.x], y: shape[G.boxHalfSize][G.y], z: shape[G.boxHalfSize][G.z] };
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
      if (shape[G.planeHalfSize] && isFiniteNum(shape[G.planeHalfSize][G.x]) && hasXform) {
        prim = {
          kind: "plane",
          name: name,
          pos: pos,
          mat: mat,
          he: { x: shape[G.planeHalfSize][G.x], y: shape[G.planeHalfSize][G.y], z: 0 },
          euler: matToEuler(mat)
        };
        return prim;
      }
    } catch (e3) {}

    try {
      if (shape[G.triangleA] && shape[G.triangleB] && shape[G.triangleC] && isFiniteNum(shape[G.triangleA][G.x]) && !shape[G.boxHalfSize]) {
        v0 = { x: shape[G.triangleA][G.x], y: shape[G.triangleA][G.y], z: isFiniteNum(shape[G.triangleA][G.z]) ? shape[G.triangleA][G.z] : 0 };
        v1 = { x: shape[G.triangleB][G.x], y: shape[G.triangleB][G.y], z: isFiniteNum(shape[G.triangleB][G.z]) ? shape[G.triangleB][G.z] : 0 };
        v2 = { x: shape[G.triangleC][G.x], y: shape[G.triangleC][G.y], z: isFiniteNum(shape[G.triangleC][G.z]) ? shape[G.triangleC][G.z] : 0 };
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
      if ((typ === 2 || (shape[G.sphereRadius] && isFiniteNum(shape[G.sphereRadius]) && !shape[G.boxHalfSize]))) {
        var rad = isFiniteNum(shape[G.sphereRadius]) ? shape[G.sphereRadius] : 0;
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
      aabb = shape[G.shapeBounds];
      if (aabb && isFiniteNum(aabb[G.minX]) && isFiniteNum(aabb[G.maxX])) {
        prim = {
          kind: "aabb",
          name: name,
          min: { x: aabb[G.minX], y: aabb[G.minY], z: aabb[G.minZ] },
          max: { x: aabb[G.maxX], y: aabb[G.maxY], z: aabb[G.maxZ] }
        };
        return prim;
      }
    } catch (e5) {}
    return null;
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
      try { shapes = iterList(b[G.bodyShapes]); } catch (e) { shapes = []; }
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
        [G.hitDistance]: js.dist,
        [G.hitShape]: js.name ? { [G.shapeTag]: js.name } : null,
        [G.hitNormal]: { [G.x]: 0, [G.y]: 0, [G.z]: js.nz }
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
        ok = filter
          ? world[G.staticRaycast](origin, dir, maxDist, mask, hit, filter)
          : world[G.staticRaycast](origin, dir, maxDist, mask, hit);
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
      distEngine: (hit && isFiniteNum(hit[G.hitDistance])) ? hit[G.hitDistance] : null,
      distM: (hit && isFiniteNum(hit[G.hitDistance])) ? toM(hit[G.hitDistance]) : null,
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
      { method: G.staticRaycast, name: "static+mask", mask: STATIC_MASK, filter: null },
      { method: G.staticRaycast, name: "static+mask+filter", mask: STATIC_MASK, filter: STATIC_FILTER },
      { method: G.raycast, name: "world+mask+filter", mask: STATIC_MASK, filter: STATIC_FILTER },
      { method: G.raycast, name: "world+wide+filter", mask: 0x7fffffff, filter: STATIC_FILTER },
      { method: G.raycast, name: "world+wide", mask: 0x7fffffff, filter: null }
    ];
    var last = { ok: false, hit: null };
    var w, a, i, j, res;
    dbg.hasStaticRaycast = worldHasFn(G.staticRaycast);
    dbg.hasRaycast = worldHasFn(G.raycast);
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
    var last, hx, hy, hz, step, EPS = 10;
    while (remaining > 1 && skips < 5) {
      last = tryCastAt(world, ox, oy, oz, fwd, remaining, dbg);
      result = interpretHit(last.ok, last.hit, dbg, engineMe, ox, oy, oz, fwd, traveled);
      if (result.type != null) return result;
      var canSkip = last.ok && last.hit && isTankishHit(last.hit);
      if (!canSkip) break;
      step = last.hit[G.hitDistance];
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

  function isPointInitRole(role) {
    return role === "initPoint" || role === "initNewStylePoint";
  }

  function recordCallable(fn) {
    var name = fn && fn.callableName;
    if (!name || typeof name !== "string") return;
    foundCallables[name] = (foundCallables[name] || 0) + 1;
    var role = CALLABLE_ROLES[name];
    if (!role || hooks[role] === fn) return;
    if (!OFF.wrapPoint && isPointInitRole(role)) fn = wrapPointInitFn(null, name, fn);
    hooks[role] = fn;
    logDebug("hooked " + role + (foundCallables[name] > 1 ? " (replace #" + foundCallables[name] + ")" : " (first)"));
  }


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
      if (!(obj && obj[G.bodyState] && obj[G.bodyState][G.position] && obj[G.bodyState][G.orientation])) return;
      if (!parseVector3(obj[G.bodyState][G.position]) || !parseQuaternion(obj[G.bodyState][G.orientation])) return;
      if (bodyCandidates.indexOf(obj) >= 0) return;
      if (bodyCandidates.length > 80) bodyCandidates.shift();
      bodyCandidates.push(obj);
    } catch (e) {}
  }

  function extractWorldFrom(obj) {
    if (!obj) return null;
    try {
      if (obj[G.bodyOwner] && obj[G.bodyOwner][G.entityWorld] && typeof obj[G.bodyOwner][G.entityWorld][G.raycast] === "function") return obj[G.bodyOwner][G.entityWorld];
    } catch (e) {}
    try {
      if (obj[G.entityWorld] && typeof obj[G.entityWorld][G.raycast] === "function" && obj[G.entityWorld][G.raycast].length >= 5) return obj[G.entityWorld];
    } catch (e2) {}
    try {
      if (typeof obj[G.raycast] === "function" && obj[G.raycast].length >= 5 && (obj[G.bodies] || obj[G.staticGrid])) return obj;
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
      if (isFiniteNum(obj[G.x]) && isFiniteNum(obj[G.y]) && isFiniteNum(obj[G.z])) {
        return { x: obj[G.x], y: obj[G.y], z: obj[G.z] };
      }
      if (isFiniteNum(obj[G.mapX]) && isFiniteNum(obj[G.mapY]) && isFiniteNum(obj[G.mapZ])) {
        return { x: obj[G.mapX], y: obj[G.mapY], z: obj[G.mapZ] };
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
      if (typeof list[G.size] === "function" && typeof list[G.get] === "function") {
        var n = list[G.size](), out = [], i;
        if (typeof n !== "number" || n < 0 || n > 200000) return [];
        for (i = 0; i < n; i++) out.push(list[G.get](i));
        return out;
      }
    } catch (e) {}
    try {
      if (typeof list.length === "number" && list.length >= 0 && list.length <= 200000 &&
          !isFiniteNum(list[G.x]) && !isFiniteNum(list[G.mapX])) {
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
      var cg = obj[G.collisionGeometry];
      if (cg && (cg[G.boxes] != null || cg[G.planes] != null || cg[G.triangles] != null) && obj[G.staticGeometry] != null) {
        return true;
      }
      if (typeof obj[G.getCollisionGeometry] === "function" && typeof obj[G.getStaticGeometry] === "function" && typeof obj[G.getOutsideGeometry] === "function") {
        try {
          if (String(obj).indexOf(GAME.tags.battleMap) === 0) return true;
        } catch (e) {}
      }
    } catch (e2) {}
    return false;
  }

  function looksLikeCollisionGeometry(obj) {
    try {
      if (!obj) return false;
      if (obj[G.boxes] != null || obj[G.planes] != null || obj[G.triangles] != null) return true;
      if (typeof obj[G.getBoxes] === "function" && typeof obj[G.getPlanes] === "function" && typeof obj[G.getTriangles] === "function") {
        try { return String(obj).indexOf(GAME.tags.collisionGeometry) === 0; } catch (e) {}
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
      if (!hooks.mapName && typeof obj[G.mapTitle] === "string" && obj[G.mapTitle].length > 0 && obj[G.mapTitle].length < 80 &&
          (typeof obj[G.getMapTitle] === "function" || obj[G.mapTitleMarker] != null)) {
        hooks.mapName = obj[G.mapTitle];
      }
      if (!hooks.mapName && typeof obj[G.battleName] === "string" && obj[G.battleName].length > 1 && obj[G.battleName].length < 80 &&
          typeof obj[G.getBattleMap] === "function") {
        hooks.mapName = obj[G.battleName];
      }
      if (obj && obj[G.teamPointPosition] && parseMapVec(obj[G.teamPointPosition]) && obj[G.teamPointTeam] != null && obj[G.flagCarrierId] == null) {
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
      var st = obj[G.flagStatus];
      if (st == null) return null;
      var s = enumName(st) || String(st);
      if (s.indexOf(GAME.flagStates.atBase) >= 0) return GAME.flagStates.atBase;
      if (GAME.flagStates.away.indexOf(s) >= 0) return s;
    } catch (e) {}
    return null;
  }

  function rememberFlagHud(obj) {
    if (!obj || obj[G.flagStatus] == null) return;
    if (flagStateName(obj) == null) return;
    if (flagHudObjs.indexOf(obj) < 0 && flagHudObjs.length < 8) flagHudObjs.push(obj);
  }

  function looksLikeClientPointData(obj) {
    if (!obj || typeof obj !== "object") return false;
    try { if (String(obj).indexOf(GAME.tags.clientPointData) === 0) return true; } catch (e) {}
    try {
      if (typeof obj[G.pointActive] === "boolean" && obj[G.pointId] != null && (obj[G.pointPosition] || typeof obj[G.getPosition] === "function")) return true;
    } catch (e2) {}
    return false;
  }

  function looksLikeDominationCC(obj) {
    if (!obj || typeof obj !== "object") return false;
    try { if (String(obj).indexOf(GAME.tags.dominationConfig) === 0) return true; } catch (e) {}
    try {
      if (obj[G.dominationPoints] != null && obj[G.dominationA] != null && obj[G.dominationB] != null && typeof obj[G.getDominationPoints] === "function") return true;
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
    try { if (obj[G.flagCarrierId] != null) return; } catch (eSkip) {}
    var i, list, pos, name, id, letter;
    if (looksLikeDominationCC(obj)) {
      list = [];
      try { list = iterList(typeof obj[G.getDominationPoints] === "function" ? obj[G.getDominationPoints]() : obj[G.dominationPoints]); } catch (eL) { list = []; }
      logDebug("DominationCC points=" + list.length);
      for (i = 0; i < list.length; i++) rememberControlPoint(list[i]);
      return;
    }
    if (looksLikeClientPointData(obj)) {
      pos = null;
      try { if (typeof obj[G.getPosition] === "function") pos = vecToM(parseMapVec(obj[G.getPosition]())); } catch (eP) {}
      if (!pos) { try { pos = vecToM(parseMapVec(obj[G.pointPosition])); } catch (eP2) {} }
      name = "";
      try { if (typeof obj[G.getName] === "function") name = String(obj[G.getName]() || ""); } catch (eN) {}
      try { id = obj[G.pointId]; } catch (eI) { id = null; }
      letter = letterFromPointMeta(name, id);
      rememberControlPointAt(pos, letter, name || letter);
    }
  }

  function capturePointFromInitArgs(args) {
    var n = args && (args.length > 1 ? args[1] : args[0]);
    if (!n || typeof n !== "object") return;
    var rec = n[G.initPointRecord] || n[G.initPointRecordAlt];
    if (!rec) return;
    var pos = null, id = null, name = "";
    try { id = rec[G.recordId]; } catch (e) {}
    try {
      var tr = (typeof rec[G.getTransform] === "function") ? rec[G.getTransform]() : rec;
      var raw = (tr && typeof tr[G.clone] === "function") ? tr[G.clone]() : tr;
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
      return normalizeTeam(enumName(obj[G.teamPointTeam]) || enumName(obj[G.teamPointTeamAlt]) || enumName(obj.teamType) || enumName(obj.team));
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
        next[team] = st !== GAME.flagStates.atBase;
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

  function rotateEuler(v, e) { return TOC.geometry.rotateEuler(v, e); }

  function add3(a, b) { return TOC.geometry.add3(a, b); }

  function exportBox(box) {
    var pos = vecToM(parseMapVec(box && (box[G.boxPosition] || (typeof box[G.getPosition] === "function" && box[G.getPosition]()))));
    var rot = parseMapVec(box && (box[G.boxRotation] || (typeof box[G.getRotation] === "function" && box[G.getRotation]())));
    var sizeRaw = parseMapVec(box && (box[G.boxSize] || (typeof box[G.size] === "function" && box[G.size]())));
    if (!pos || !sizeRaw) return null;
    var size = vecToM(sizeRaw);
    return { type: "box", position: pos, rotation: rot, size: size };
  }

  function exportPlane(plane) {
    var pos = vecToM(parseMapVec(plane && (plane[G.planePosition] || (typeof plane[G.getPosition] === "function" && plane[G.getPosition]()))));
    var rot = parseMapVec(plane && (plane[G.planeRotation] || (typeof plane[G.getRotation] === "function" && plane[G.getRotation]())));
    if (!pos) return null;
    var length = plane[G.planeLength], width = plane[G.planeWidth];
    return {
      type: "plane",
      position: pos,
      rotation: rot,
      length: isFiniteNum(length) ? toM(length) : null,
      width: isFiniteNum(width) ? toM(width) : null
    };
  }

  function exportTriangle(tri) {
    var pos = vecToM(parseMapVec(tri && (tri[G.trianglePosition] || (typeof tri[G.getPosition] === "function" && tri[G.getPosition]()))));
    var rot = parseMapVec(tri && (tri[G.triangleRotation] || (typeof tri[G.getRotation] === "function" && tri[G.getRotation]())));
    var v0 = vecToM(parseMapVec(tri && (tri[G.vertex0] || (typeof tri[G.getVertex0] === "function" && tri[G.getVertex0]()))));
    var v1 = vecToM(parseMapVec(tri && (tri[G.vertex1] || (typeof tri[G.getVertex1] === "function" && tri[G.getVertex1]()))));
    var v2 = vecToM(parseMapVec(tri && (tri[G.vertex2] || (typeof tri[G.getVertex2] === "function" && tri[G.getVertex2]()))));
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
    var boxList = unwrapList(typeof cg[G.getBoxes] === "function" ? cg[G.getBoxes]() : cg[G.boxes], [G.boxes]);
    var planeList = unwrapList(typeof cg[G.getPlanes] === "function" ? cg[G.getPlanes]() : cg[G.planes], [G.planes]);
    var triList = unwrapList(typeof cg[G.getTriangles] === "function" ? cg[G.getTriangles]() : cg[G.triangles], [G.triangles]);
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
    try { name = prop[G.propName] || (typeof prop[G.getName] === "function" ? prop[G.getName]() : null); } catch (e) {}
    try { groupName = prop[G.propGroup] || null; } catch (e2) {}
    try { libraryName = prop[G.propLibrary] || (typeof prop[G.getLibrary] === "function" ? prop[G.getLibrary]() : null); } catch (e3) {}
    if (typeof name !== "string") name = name != null ? String(name) : null;
    if (name && /hull|turret|chassis|tank|bonus|mine|shell|player/i.test(name)) return null;
    var pos = vecToM(parseMapVec(prop[G.propPosition] || (typeof prop[G.getPosition] === "function" && prop[G.getPosition]())));
    var rot = parseMapVec(prop[G.propRotation]);
    var scale = parseMapVec(prop[G.propScale]);
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
    var pos = vecToM(parseMapVec(sp[G.spawnPosition] || (typeof sp[G.getPosition] === "function" && sp[G.getPosition]())));
    if (!pos) return null;
    return {
      position: pos,
      rotation: parseMapVec(sp[G.spawnRotation] || (typeof sp[G.getRotation] === "function" && sp[G.getRotation]())),
      type: enumName(sp[G.spawnType])
    };
  }

  function slugName(name) {
    var s = (name || "map").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "");
    return s || "map";
  }

  function collectBounds(data) { return TOC.geometry.collectBounds(data); }

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
      try { cg = map[G.collisionGeometry] || (typeof map[G.getCollisionGeometry] === "function" && map[G.getCollisionGeometry]()); } catch (e) { cg = null; }
      try { outside = map[G.outsideGeometry] || (typeof map[G.getOutsideGeometry] === "function" && map[G.getOutsideGeometry]()); } catch (e2) { outside = null; }
      try { sg = map[G.staticGeometry] || (typeof map[G.getStaticGeometry] === "function" && map[G.getStaticGeometry]()); } catch (e3) { sg = null; }
      if (cg) collision = exportCollisionGeometry(cg);
      if (outside) collisionOutside = exportCollisionGeometry(outside);
      list = unwrapList(sg && (typeof sg[G.getProps] === "function" ? sg[G.getProps]() : sg[G.propList]), [G.propList]);
      for (i = 0; i < list.length; i++) {
        item = exportProp(list[i]);
        if (item) props.push(item);
      }
      list = unwrapList(map[G.spawnSet] && (typeof map[G.spawnSet][G.getSpawns] === "function" ? map[G.spawnSet][G.getSpawns]() : map[G.spawnSet][G.spawnList]), [G.spawnList, G.spawnSet]);
      if (!list.length) list = unwrapList(map[G.spawnSet], [G.spawnList]);
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
        if (item[G.flagCarrierId] != null) continue;
        var pos = vecToM(parseMapVec(item[G.teamPointPosition]));
        if (!pos) continue;
        bases.push({
          position: pos,
          teamType: enumName(item[G.teamPointTeam]),
          id: item[G.recordId] != null ? item[G.recordId] : null
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
        error: "Статику карты не нашла (ни BattleMap, ни тела physicsWorld).",
        status: status()
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

  var capturedListeners = [];
  var capturedListenerSet = typeof Set === "function" ? new Set() : null;
  var scanCursor = { queue: null, seen: null };
  var gameReady = false;
  var lastScanResetAt = 0;
  var posMissingSince = 0;
  var burstFramesLeft = 0;
  var lastBurstAt = 0;
  var SCAN_SKIP_KEYS = {
    [G.staticGrid]: 1, [G.staticTree]: 1, [G.bulkListA]: 1, [G.bulkListB]: 1, [G.gridCells]: 1, [G.cellShapes]: 1, [G.nodeShapes]: 1,
    [G.bodies]: 1, [G.bodyShapes]: 1, [G.bulkListC]: 1, [G.mapCollision]: 1,
    [G.flagCarrierCodec]: 1, [G.flagPositionCodec]: 1, flagCarrierId: 1, flagPosition: 1
  };
  var COS35 = Math.cos(35 * Math.PI / 180);
  var TANK_WIDTH_M = 3.5;
  var nextLiveWalkAt = 0;
  var nextTreesAt = 0;

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
    native: null
  };
  var flagHudObjs = [];
  var flagTaken = {};
  var mapControlPoints = [];

  var cpLive = [];
  var cpSign = { pos: GAME.teams.b, neg: GAME.teams.a };
  function looksLikeCpRuntime(obj) {
    try {
      return !!(obj && typeof obj === "object" &&
        typeof obj[G.cpScore] === "number" && typeof obj[G.cpServerScore] === "number" && typeof obj[G.cpScoreRate] === "number" &&
        obj[G.cpOwner] && typeof obj[G.cpOwner] === "object" &&
        typeof obj[G.cpName] === "string" && obj[G.cpPosition] && typeof obj[G.cpPosition] === "object");
    } catch (e) { return false; }
  }
  function rememberCpRuntime(obj) {
    if (!looksLikeCpRuntime(obj) || cpLive.indexOf(obj) >= 0 || cpLive.length >= 16) return false;
    cpLive.push(obj);
    logDebug("cp live " + obj[G.cpName] + " (" + cpLive.length + ")");
    if (!bfsScan.busy) { try { walkBattleWorld(obj[G.cpWorld], 6); } catch (e) {} }
    return true;
  }
  function enumStr(v) {
    try { return v == null ? "" : String(v); } catch (e) { return ""; }
  }
  function otherTeam(t) { return t === GAME.teams.a ? GAME.teams.b : GAME.teams.a; }
  function cpLiveStates() {
    var out = [], i, pt, pos, owner, score, local, name;
    for (i = 0; i < cpLive.length; i++) {
      pt = cpLive[i];
      if (hooks.physicsWorld && pt[G.cpWorld] && pt[G.cpWorld] !== hooks.physicsWorld && pt[G.cpWorld][G.physics] !== hooks.physicsWorld) continue;
      pos = null;
      try { pos = vecToM(parseMapVec(pt[G.cpPosition])); } catch (e) {}
      if (!pos || !isFiniteNum(pos.x)) continue;
      owner = enumStr(pt[G.cpOwner]);
      score = isFiniteNum(pt[G.cpScore]) ? Math.max(-100, Math.min(100, pt[G.cpScore])) : 0;
      if ((owner === GAME.teams.a || owner === GAME.teams.b) && Math.abs(score) >= 99.5) {
        if (score > 0) { cpSign.pos = owner; cpSign.neg = otherTeam(owner); }
        else { cpSign.neg = owner; cpSign.pos = otherTeam(owner); }
      }
      local = "";
      try { local = enumStr(pt[G.cpTeams] && pt[G.cpTeams][G.ourTeam]); } catch (e2) {}
      name = pt[G.cpName] || "";
      out.push({
        pos: pos,
        letter: letterFromPointMeta(name, null) || (name ? name.charAt(0).toUpperCase() : "?"),
        owner: owner === GAME.teams.a || owner === GAME.teams.b ? owner : null,
        score: score,
        capTeam: score > 0 ? cpSign.pos : (score < 0 ? cpSign.neg : null),
        local: local,
        active: pt[G.cpActive] !== false
      });
    }
    return out;
  }
  var flagLive = [];
  function looksLikeFlagObj(obj) {
    try {
      var m = obj && obj[G.flagMarker];
      return !!(m && typeof m === "object" && m[G.markerPosition] && typeof m[G.markerRule] === "function" &&
        obj[G.flagState] && typeof obj[G.flagState] === "object" && obj[G.flagTeam] && typeof obj[G.flagTeam] === "object");
    } catch (e) { return false; }
  }
  function rememberFlagObj(obj) {
    if (!looksLikeFlagObj(obj) || flagLive.indexOf(obj) >= 0 || flagLive.length >= 6) return;
    flagLive.push(obj);
    logDebug("flag live " + enumStr(obj[G.flagTeam]) + " " + enumStr(obj[G.flagState]));
  }
  function flagLiveStates() {
    var out = [], i, f, m, pos, st, shown;
    for (i = 0; i < flagLive.length; i++) {
      f = flagLive[i];
      try {
        if (hooks.physicsWorld && f[G.flagWorld] && f[G.flagWorld] !== hooks.physicsWorld && f[G.flagWorld][G.physics] !== hooks.physicsWorld) continue;
        m = f[G.flagMarker];
        st = enumStr(f[G.flagState]);
        if (st !== GAME.flagStates.carried && st !== GAME.flagStates.dropped) continue;
        shown = false;
        try { shown = !!m[G.markerRule](m[G.markerPosition]); } catch (eV) { shown = false; }
        if (!shown) continue;
        pos = vecToM(parseMapVec(m[G.markerPosition]));
        if (!pos) continue;
        out.push({ key: f, pos: pos, state: st, team: enumStr(f[G.flagTeam]), local: enumStr(f[G.flagTeams] && f[G.flagTeams][G.ourTeam]) });
      } catch (e) {}
    }
    return out;
  }

  var battleParams = null;
  function rememberBattleParams(obj) {
    try {
      if (obj && obj[G.parkourSlot] && obj[G.parkourSlot][G.slotName] === "parkourMode" && obj[G.spectatorSlot] && obj[G.spectatorSlot][G.slotName] === "spectatorMode") {
        if (battleParams !== obj) { battleParams = obj; logDebug("battle params found, parkour=" + obj[G.parkourSlot][G.slotValue]); }
      }
    } catch (e) {}
  }
  var battlefieldCC = null;
  function rememberBattlefieldCC(obj) {
    try {
      if (obj && typeof obj[G.getBattleMap] === "function" && typeof obj[G.parkourMode] === "boolean" && G.formatName in obj && G.battleName in obj) {
        if (battlefieldCC !== obj) {
          battlefieldCC = obj;
          logDebug("battle data found, format=" + obj[G.formatName] + " parkour=" + obj[G.parkourMode]);
        }
      }
    } catch (e) {}
  }
  var mapComp = null;
  function rememberMapComp(obj) {
    try {
      if (obj && typeof obj[G.parkourGeometry] === "boolean" && typeof obj[G.getDustSettings] === "function" && obj[G.mapCollision] && obj[G.mapLighting]) {
        if (mapComp !== obj) { mapComp = obj; logDebug("battle map component found, parkour=" + obj[G.parkourGeometry]); }
      }
    } catch (e) {}
  }
  function parkourKnown() { return !!(battleParams || battlefieldCC || mapComp); }
  function battleFormatName() {
    try { if (battlefieldCC) return String(battlefieldCC[G.formatName]); } catch (e) {}
    if (mapComp) return mapComp[G.parkourGeometry] ? "паркур" : "не паркур";
    if (battleParams) return battleParams[G.parkourSlot] && battleParams[G.parkourSlot][G.slotValue] ? "паркур" : "не паркур";
    return "?";
  }
  function isParkour() {
    try { if (battleParams && battleParams[G.parkourSlot] && battleParams[G.parkourSlot][G.slotValue] === true) return true; } catch (e) {}
    try { if (battlefieldCC && (battlefieldCC[G.parkourMode] === true || GAME.parkourFormat.test(String(battlefieldCC[G.formatName])))) return true; } catch (e2) {}
    try { if (mapComp && mapComp[G.parkourGeometry] === true) return true; } catch (e3) {}
    return false;
  }

  var treesHidden = [];
  function treeObjects() {
    var out = [], lists, i, j, arr;
    if (!mapComp) return out;
    lists = [mapComp[G.spriteTrees], mapComp[G.trees], mapComp[G.treesExtra]];
    for (i = 0; i < lists.length; i++) {
      try { arr = iterList(lists[i]); } catch (e) { arr = []; }
      for (j = 0; j < arr.length; j++) {
        if (arr[j] && typeof arr[j][G.setVisible] === "function" && typeof arr[j][G.isVisible] === "function") out.push(arr[j]);
      }
    }
    return out;
  }
  function restoreTrees() {
    for (var i = 0; i < treesHidden.length; i++) {
      try { treesHidden[i].o[G.setVisible](treesHidden[i].was); } catch (e) {}
    }
    if (treesHidden.length) logDebug("parkour: trees restored (" + treesHidden.length + ")");
    treesHidden = [];
  }
  var bushesHidden = readSetting("toCoords.parkourBushes", "1") === "1";
  function setBushesHidden(hide) {
    bushesHidden = hide;
    writeSetting("toCoords.parkourBushes", hide ? "1" : "0");
    applyParkourTrees();
    flash(hide ? "кусты скрыты" : "кусты видны");
  }
  function applyParkourTrees() {
    if (OFF.trees || !isParkour() || !mapComp || !bushesHidden) {
      if (treesHidden.length) restoreTrees();
      return;
    }
    var objs = treeObjects(), i, o, known, k, n = 0;
    for (i = 0; i < objs.length; i++) {
      o = objs[i];
      known = false;
      for (k = 0; k < treesHidden.length; k++) if (treesHidden[k].o === o) { known = true; break; }
      try {
        if (!known) treesHidden.push({ o: o, was: !!o[G.isVisible]() });
        if (o[G.isVisible]()) { o[G.setVisible](false); n++; }
      } catch (e) {}
    }
    if (n) logDebug("parkour: trees hidden (" + n + ")");
  }

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
      try { var bw = battleWorld(); if (bw && bw[G.controllers]) push(bw[G.controllers][G.jsMap]); push(bw); } catch (e0) {}
      push(hooks.physicsWorld);
      try { push(followCam && followCam[G.systemEntity]); } catch (e1) {}
      push(hooks.radarSystem);
      push(hooks.battleMap);
      try { push(window[GAME.globals.launcher]); } catch (e2) {}
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

  var followCam = null;
  var followCams = [];
  var camKeysOrig = typeof WeakMap === "function" ? new WeakMap() : null;
  var parkourCam = { mult: 1, applied: false };
  try { var _pc = Number(localStorage.getItem("toCoords.parkourCam")); if (_pc >= 0.5 && _pc <= 8) parkourCam.mult = _pc; } catch (ePc) {}
  function camBody(cam) {
    try {
      var tp = cam && cam[G.cameraTankPhysics];
      var b = tp && (tp[G.physicsBody] || (typeof tp[G.getBody] === "function" ? tp[G.getBody]() : null));
      return b && b[G.bodyState] ? b : null;
    } catch (e) { return null; }
  }
  function rememberFollowCam(obj) {
    try {
      if (obj && obj[G.cameraSpline] && typeof obj[G.cameraSpline][G.splineScale] === "number" && obj[G.cameraSpline][G.splineKey0] && obj[G.cameraSpline][G.splineKey3] &&
          typeof obj[G.cameraPath] === "number" && typeof obj[G.setCameraPath] === "function") {
        if (followCams.indexOf(obj) < 0) {
          followCams.push(obj);
          if (followCams.length > 4) followCams.shift();
          logDebug("follow camera found (" + followCams.length + ")");
        }
        if (followCam !== obj && (!followCam || !maybeOwnBody(camBody(followCam))) && maybeOwnBody(camBody(obj))) followCam = obj;
      }
    } catch (e) {}
  }
  function camKeys(cam) {
    var sp = cam && cam[G.cameraSpline];
    return sp ? [sp[G.splineKey0], sp[G.splineKey1], sp[G.splineKey2], sp[G.splineKey3]] : [];
  }
  function setCamMult(cam, k) {
    try {
      var keys = camKeys(cam), i, orig;
      if (!keys.length || !keys[0]) return;
      orig = camKeysOrig && camKeysOrig.get(cam[G.cameraSpline]);
      if (!orig) {
        if (k === 1) return;
        orig = keys.map(function (h) { return { u: h[G.keyDistance], v: h[G.keyHeight] }; });
        if (camKeysOrig) camKeysOrig.set(cam[G.cameraSpline], orig);
      }
      if (Math.abs(keys[0][G.keyDistance] - orig[0].u * k) < 1e-6 && Math.abs(keys[0][G.keyHeight] - orig[0].v * k) < 1e-6) return;
      for (i = 0; i < keys.length; i++) {
        if (!keys[i] || !orig[i]) continue;
        keys[i][G.keyDistance] = orig[i].u * k;
        keys[i][G.keyHeight] = orig[i].v * k;
      }
      cam[G.setCameraPath](cam[G.cameraPath]);
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
      for (i = 0; i < followCams.length; i++) setCamMult(followCams[i], 1);
      parkourCam.applied = false;
    }
  }
  function bumpParkourCam(factor) {
    parkourCam.mult = Math.max(0.5, Math.min(8, Math.round(parkourCam.mult * factor * 100) / 100));
    try { localStorage.setItem("toCoords.parkourCam", String(parkourCam.mult)); } catch (e) {}
    applyParkourCam();
    logDebug("parkour camera x" + parkourCam.mult);
    flash("паркур: камера ×" + parkourCam.mult.toFixed(2));
  }

  function battleWorld() {
    var c = [hooks.physicsWorld], i, w;
    try { if (hooks.physicsBody && hooks.physicsBody[G.bodyOwner]) c.push(hooks.physicsBody[G.bodyOwner][G.entityWorld]); } catch (e) {}
    try { if (hooks.radarSystem && hooks.radarSystem[G.systemEntity]) c.push(hooks.radarSystem[G.systemEntity][G.entityWorld]); } catch (e2) {}
    for (i = 0; i < mountCandidates.length && i < 4; i++) {
      try { c.push(mountCandidates[i][G.systemEntity] && mountCandidates[i][G.systemEntity][G.entityWorld]); } catch (e3) {}
    }
    for (i = 0; i < c.length; i++) {
      w = c[i];
      try { if (w && w[G.controllers] && w[G.controllers][G.jsMap]) return w; } catch (e4) {}
    }
    return null;
  }
  function walkBattleWorld(w, budgetMs) {
    if (!w) return;
    var seeds = [];
    try { if (w[G.controllers] && w[G.controllers][G.jsMap]) seeds.push(w[G.controllers][G.jsMap]); } catch (e) {}
    seeds.push(w);
    bfsScan(seeds, budgetMs, 3000, rememberLiveObjects);
  }

  var magnumAim = null;
  function maybeOwnBody(b) {
    if (!b || b === hooks.physicsBody || !lastMeEngine) return true;
    var bp = bodyPos(b);
    if (!bp) return true;
    return Math.abs(bp.x - lastMeEngine.x) + Math.abs(bp.y - lastMeEngine.y) + Math.abs(bp.z - lastMeEngine.z) < 800;
  }
  function rememberMagnumAim(obj) {
    try {
      if (obj && obj[G.aimHit] && obj[G.aimHit][G.hitPoint] && typeof obj[G.aimPointCount] === "number" && obj[G.aimPoints] && obj[G.aimState] &&
          obj[G.aimMark] && typeof obj[G.aimMark][G.isVisible] === "function" && typeof obj[G.aimActive] === "boolean") {
        if (!maybeOwnBody(obj[G.aimTankBody])) return;
        if (magnumAim !== obj) { magnumAim = obj; logDebug("magnum aim found"); }
      }
    } catch (e) {}
  }
  function magnumAimState() {
    var a = magnumAim;
    if (!a) return null;
    try {
      if (!maybeOwnBody(a[G.aimTankBody])) { magnumAim = null; return null; }
      if (enumStr(a[G.aimState]) !== GAME.aimShowing) return null;
      var pts = [], n = Math.min(a[G.aimPointCount] | 0, 1000), list = a[G.aimPoints], i, it, v;
      for (i = 0; i < n; i += 2) {
        it = null;
        try { it = list[G.get](i); } catch (eG) { break; }
        v = it && vecToM(parseMapVec(it[G.aimPointPosition]));
        if (v) pts.push(v);
      }
      var land = null;
      try { if (a[G.aimMark][G.isVisible]()) land = vecToM(parseMapVec(a[G.aimHit][G.hitPoint])); } catch (eL) {}
      return { pts: pts, land: land };
    } catch (e) { return null; }
  }
  function rememberLiveObjects(obj) {
    rememberCpRuntime(obj);
    rememberFlagObj(obj);
    rememberBattleParams(obj);
    rememberFollowCam(obj);
    rememberMagnumAim(obj);
    rememberBattlefieldCC(obj);
    rememberMapComp(obj);
  }

  function localTeamName() {
    var i, t;
    for (i = 0; i < flagLive.length; i++) {
      t = enumStr(flagLive[i][G.flagTeams] && flagLive[i][G.flagTeams][G.ourTeam]);
      if (t === GAME.teams.a || t === GAME.teams.b) return t;
    }
    for (i = 0; i < cpLive.length; i++) {
      t = enumStr(cpLive[i][G.cpTeams] && cpLive[i][G.cpTeams][G.ourTeam]);
      if (t === GAME.teams.a || t === GAME.teams.b) return t;
    }
    return "";
  }

  function cpTeamColor(team, local) {
    if (team !== GAME.teams.a && team !== GAME.teams.b) return "#8a8a8a";
    if (local === GAME.teams.a || local === GAME.teams.b) return team === local ? "#1e6bff" : "#ff2a2a";
    return team === GAME.teams.a ? "#ff2a2a" : "#1e6bff";
  }

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
    return !!(hooks.localTankPosition || hooks.printLocalTankPosition || ownBodyFromCamera());
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
      return Promise.resolve({ ok: true, id: mapCache.id, source: mapCache.source, cached: true });
    }
    mapCache.status = "ищу карту…";
    return idbGetMeta("folder").then(function (handle) {
      if (handle && !mapCache.folderHandle) mapCache.folderHandle = handle;
    }).catch(function () {}).then(function () {
      var nameId = (hooks.mapName && hooks.mapName !== "unknown") ? slugName(hooks.mapName) : null;
      return tryLoadById(nameId);
    }).then(function (found) {
      if (found && applyMapData(found.data, found.source)) return { ok: true, id: mapCache.id, source: found.source };
      var live = null;
      try { live = collectLiveMapData(); } catch (e) { live = null; }
      if (!live) {
        mapCache.status = "карты нет";
        return { ok: false, error: "no map yet" };
      }
      var hashId = "h" + geometryHash(live);
      return tryLoadById(hashId).then(function (found2) {
        if (found2 && applyMapData(found2.data, found2.source)) return { ok: true, id: mapCache.id, source: found2.source };
        applyMapData(live, "physicsWorld");
        return saveMap(false).then(function (res) {
          return { ok: true, id: mapCache.id, source: "exported", save: res };
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
        }).catch(function () { mapCache.building = false; });
      } catch (e) { mapCache.building = false; }
    }, 0);
  }

  function sideOf(team, local) {
    if (team !== GAME.teams.a && team !== GAME.teams.b) return "neutral";
    if (local === GAME.teams.a || local === GAME.teams.b) return team === local ? "ally" : "enemy";
    return team === GAME.teams.a ? "red" : "blue";
  }
  function legacySide(team) {
    var t = normalizeTeam(team);
    return t === "RED" ? "red" : (t === "BLUE" ? "blue" : "neutral");
  }

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
      var keys, i, val, nums = [], ints = [];
      try { keys = Object.keys(v); } catch (eK) { keys = []; }
      for (i = 0; i < keys.length; i++) {
        try { val = v[keys[i]]; } catch (eV) { continue; }
        if (!isFiniteNum(val)) continue;
        var rgb24 = (val >>> 0) & 0xFFFFFF;
        if (val > 255 && (rgb24 === GAME.radarTints.ally || rgb24 === GAME.radarTints.enemy)) return colorToRgb(rgb24);
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
      var list = obj && obj[G.radarEntries];
      if (!list || typeof list[G.size] !== "function" || typeof list[G.get] !== "function") return false;
      if (!obj[G.radarPartA] || !obj[G.radarPartB] || !obj[G.radarPartC] || typeof obj[G.radarFlag] !== "boolean") return false;
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
    var entries = iterList(sys[G.radarEntries]), i, e, m, pos, col;
    for (i = 0; i < entries.length && i < 64; i++) {
      e = entries[i];
      m = e && e[G.entryMarker];
      if (!m) continue;
      pos = null;
      try { pos = vecToM(parseMapVec(m[G.markerPos] || (typeof m[G.getPosition] === "function" && m[G.getPosition]()))); } catch (eP) {}
      if (!pos || !isFiniteNum(pos.x) || !isFiniteNum(pos.y)) continue;
      col = null;
      try { col = m[G.markerSprite] && m[G.markerSprite][G.spriteTint]; } catch (eC) {}
      var entity = e[G.entryEntity] && typeof e[G.entryEntity] === "object" ? e[G.entryEntity] : null;
      out.push({ pos: pos, ally: radarColorIsAlly(col), raw: col, key: entity || m, entity: entity });
    }
    return out;
  }

  var radarTrack = typeof WeakMap === "function" ? new WeakMap() : null;
  var RADAR_STEP_M = 0.6;
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
    if (!tr.movedAt) return null;
    return { x: tr.dx, y: tr.dy };
  }

  function carriedFlags() {
    return flagLiveStates().filter(function (f) { return f.state === GAME.flagStates.carried; });
  }
  function nearCarriedFlag(pos, carried) {
    for (var i = 0; i < carried.length; i++) {
      if (Math.abs(carried[i].pos.x - pos.x) < 4 && Math.abs(carried[i].pos.y - pos.y) < 4) return carried[i];
    }
    return null;
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
      hooks.localTankPosition = null;
      hooks.localTankAlive = null;
      hooks.printLocalTankPosition = null;
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
    if (sig.length) battleWatch.bodiesWorld = world;
    if (world && pos && isFiniteNum(pos.x) && battle.inBattle && (sig.length || battleWatch.bodiesWorld === world) &&
        isLocalAlive() === true) {
      var nearOwn = false, wb = sig, bi, bp;
      for (bi = 0; bi < wb.length && !nearOwn; bi++) {
        bp = bodyPos(wb[bi]);
        if (bp && Math.abs(bp.x - pos.x) + Math.abs(bp.y - pos.y) + Math.abs(bp.z - pos.z) < 800) nearOwn = true;
      }
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
    push(window[GAME.globals.launcher]);
    push(window[GAME.globals.commands]);
    push(window[GAME.globals.stream]);
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
    try { if (window[GAME.globals.launcher]) return true; } catch (e) {}
    try { if (window[GAME.globals.stream]) return true; } catch (e2) {}
    try {
      var scripts = document.getElementsByTagName("script"), i, src;
      for (i = 0; i < scripts.length; i++) {
        src = scripts[i].src || "";
        if ((/\/static\/js\/main[\w.\-]*\.js/.test(src) || /main\.[a-f0-9]+\.js/.test(src)) && window[GAME.globals.launcher]) return true;
      }
    } catch (e3) {}
    try { if (document.querySelector("canvas") && window[GAME.globals.launcher]) return true; } catch (e4) {}
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
      if (shouldSkip(obj) && obj !== window[GAME.globals.launcher] && obj !== window[GAME.globals.commands]) {
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
          if (!OFF.wrapPoint && val && isPointInitRole(CALLABLE_ROLES[val.callableName])) {
            try { val = wrapPointInitFn(obj, name, val); hooks[CALLABLE_ROLES[val.callableName]] = val; } catch (eCp) {}
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

  function fmt(n, digits) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toFixed(digits);
  }

  function computeMe(now) {
    var pos = readPositionFromHook();
    if (!pos) return null;

    var hull = pickLocalHull(pos);
    var body = hull && hull.body ? hull.body : matchLocalBody(pos);
    var heading = null;
    var headingSource = null;
    var q = hull && hull.quat ? hull.quat : null;
    if (!q && body && body[G.bodyState]) {
      q = parseQuaternion(body[G.bodyState][G.orientation]);
    }
    if (q) {
      lastQuat = q;
      heading = quatToHeading(q);
      if (heading != null) headingSource = "physicsQuat";
    }
    var vel = hull && hull.vel ? hull.vel : (body && body[G.bodyState] ? parseVector3(body[G.bodyState][G.velocity]) : null);
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
    try { if (hooks.physicsBody && hooks.physicsBody[G.bodyOwner]) push(hooks.physicsBody[G.bodyOwner]); } catch (e) {}
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
      else delay = 50;
      nextScanAt = now + delay;
    }

    var engineMe = computeMe(now);
    if (engineMe) {
      if (now >= nextRayAt) {
        lastAhead = castAhead(engineMe, true);
        nextRayAt = now + RAY_INTERVAL_MS;
      }
    }
    if (battle.inBattle || live) {
      try { updateFlagTakenStates(); } catch (eFl) {}
    }
    if (hooks.physicsWorld || hooks.battleMap || battle.inBattle || live) {
      try { maybeStartMapCache(); } catch (eCache) {}
    }
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
    publishToMapWindow(now);
  }

  var statusFlash = null;
  function flash(text) {
    statusFlash = { text: text, until: Date.now() + 1500 };
  }
  function statusText() {
    if (statusFlash && Date.now() < statusFlash.until) return statusFlash.text;
    if (nativeState.ready) return mapCache.status || "maps: tanki-ext/maps";
    if (mapCache.needFolderClick) return "в консоли toCoords.pickMapFolder() или поставь native-host";
    return mapCache.status || "жду бой";
  }

  function isHealthComponent(c) {
    return !!c && typeof c === "object" && G.healthEvent in c &&
      isFiniteNum(c[G.healthCurrent]) && isFiniteNum(c[G.healthMax]) && c[G.healthMax] > 0;
  }

  function entityHealth(entity) {
    var components, found = null;
    try { components = entity && entity[G.entityComponents] && entity[G.entityComponents][G.jsMap]; } catch (e) { return null; }
    if (!components || typeof components.forEach !== "function") return null;
    components.forEach(function (list) {
      if (found || !list) return;
      try {
        var first = list[G.size]() > 0 ? list[G.get](0) : null;
        if (isHealthComponent(first)) found = first;
      } catch (e) {}
    });
    return found ? { now: Math.max(0, Math.round(found[G.healthCurrent])), max: Math.round(found[G.healthMax]) } : null;
  }

  function visibleHealth(entity, ally) {
    if (!entity || (ally !== true && !isParkour())) return null;
    return entityHealth(entity);
  }

  function ownEntity() {
    var body = ownBodyFromCamera() || hooks.physicsBody;
    try { return body && body[G.bodyOwner] || null; } catch (e) { return null; }
  }

  function buildMapFrame() {
    var now = Date.now(), local = localTeamName(), i, j, t, hd;
    var me = lastMe && isFiniteNum(lastMe.x) ? {
      x: lastMe.x, y: lastMe.y,
      z: isFiniteNum(lastMe.z) ? lastMe.z : null,
      heading: isFiniteNum(lastMe.heading) ? lastMe.heading : null,
      hp: entityHealth(ownEntity())
    } : null;
    var ray = null;
    if (me) {
      var barrel = lastRayDebug && lastRayDebug.barrel && lastRayDebug.barrel.forward;
      ray = {
        dx: barrel && isFiniteNum(barrel.x) ? barrel.x : null,
        dy: barrel && isFiniteNum(barrel.y) ? barrel.y : null,
        dist: lastAhead && lastAhead.barrel && isFiniteNum(lastAhead.barrel.dist) && lastAhead.barrel.dist > 0 ? lastAhead.barrel.dist : null
      };
    }

    var flags = [], carried = [], dropped = [];
    try { flags = flagLiveStates(); } catch (eF) { flags = []; }
    for (i = 0; i < flags.length; i++) {
      if (flags[i].state === GAME.flagStates.carried) carried.push(flags[i]);
      else dropped.push({ x: flags[i].pos.x, y: flags[i].pos.y, side: sideOf(flags[i].team, flags[i].local || local) });
    }

    var markers = [], tanks = [];
    try { markers = radarMarkers(); } catch (eR) { markers = []; }
    for (i = 0; i < markers.length; i++) {
      t = markers[i];
      hd = radarHeading(t, now);
      if (carried.length && nearCarriedFlag(t.pos, carried)) continue;
      tanks.push({ x: t.pos.x, y: t.pos.y, z: t.pos.z, side: t.ally === true ? "ally" : (t.ally === false ? "enemy" : "unknown"), hd: hd, hp: visibleHealth(t.entity, t.ally) });
    }

    var carriers = [], f, flagLocal, carrierTeam, carrierMarker, carrierSide;
    for (i = 0; i < carried.length; i++) {
      f = carried[i];
      flagLocal = f.local || local;
      carrierTeam = f.team === GAME.teams.a || f.team === GAME.teams.b ? otherTeam(f.team) : "";
      hd = radarHeading({ key: f.key, pos: f.pos }, now);
      carrierMarker = null;
      for (j = 0; j < markers.length; j++) {
        if (Math.abs(markers[j].pos.x - f.pos.x) < 4 && Math.abs(markers[j].pos.y - f.pos.y) < 4) { carrierMarker = markers[j]; break; }
      }
      if (!hd && carrierMarker) hd = radarHeading(carrierMarker, now);
      carrierSide = carrierTeam ? sideOf(carrierTeam, flagLocal) : "unknown";
      carriers.push({
        x: f.pos.x, y: f.pos.y, side: carrierSide, flagSide: sideOf(f.team, flagLocal), hd: hd,
        hp: carrierMarker ? visibleHealth(carrierMarker.entity, carrierSide === "ally") : null
      });
    }

    var bases = [], point, pos, team;
    for (i = 0; i < mapTeamPoints.length; i++) {
      point = mapTeamPoints[i];
      try {
        if (!point || point[G.flagCarrierId] != null) continue;
        pos = vecToM(parseMapVec(point[G.teamPointPosition]));
        if (!pos) continue;
        team = normalizeTeam(enumName(point[G.teamPointTeam]));
        bases.push({
          x: pos.x, y: pos.y,
          side: team === GAME.teams.a || team === GAME.teams.b ? sideOf(team, local) : legacySide(team),
          taken: !!flagTaken[team]
        });
      } catch (eTp) {}
    }

    var live = [], used = [], cps = [], cp, state;
    try { live = cpLiveStates(); } catch (eC) { live = []; }
    function liveAt(p) {
      var k, d, best = -1, bestD = 9;
      for (k = 0; k < live.length; k++) {
        if (used[k]) continue;
        d = (live[k].pos.x - p.x) * (live[k].pos.x - p.x) + (live[k].pos.y - p.y) * (live[k].pos.y - p.y);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0) return null;
      used[best] = true;
      return live[best];
    }
    function controlPoint(x, y, letter, s) {
      if (!s) return { x: x, y: y, letter: letter || "?", live: false };
      return {
        x: x, y: y, letter: letter || s.letter || "?", live: true,
        owner: s.owner ? sideOf(s.owner, s.local) : "neutral",
        ring: s.capTeam ? sideOf(s.capTeam, s.local) : "neutral",
        frac: Math.abs(s.score) / 100, active: s.active !== false
      };
    }
    for (i = 0; i < mapControlPoints.length; i++) {
      cp = mapControlPoints[i];
      if (!cp || !cp.position) continue;
      state = liveAt(cp.position);
      cps.push(controlPoint(cp.position.x, cp.position.y, cp.letter && cp.letter !== "?" ? cp.letter : (state && state.letter), state));
    }
    for (i = 0; i < live.length; i++) if (!used[i]) cps.push(controlPoint(live[i].pos.x, live[i].pos.y, live[i].letter, live[i]));

    var aim = null, aimState = null;
    try { aimState = magnumAimState(); } catch (eA) { aimState = null; }
    if (aimState) aim = { pts: aimState.pts.map(function (q) { return [q.x, q.y]; }), land: aimState.land ? [aimState.land.x, aimState.land.y] : null };

    return {
      me: me, ray: ray, tanks: tanks, carriers: carriers, bases: bases, dropped: dropped, cps: cps, aim: aim,
      speedKmh: speedState.kmh,
      status: statusText(),
      parkour: { active: isParkour(), bushesHidden: bushesHidden }
    };
  }

  var FRAME_INTERVAL_MS = 33;
  var AUTO_OPEN_DELAY_MS = 3000;
  var mapWindow = { connected: false, sentMapId: null, nextFrameAt: 0, openRequested: false };

  function toBridge(kind, payload) {
    var msg = payload || {};
    msg.type = "TOC_OUT";
    msg.kind = kind;
    try { window.postMessage(msg, "*"); } catch (e) {}
  }

  function openMapWindow() {
    mapWindow.openRequested = true;
    toBridge("open");
    return "окно карты открывается";
  }

  function sendMapToWindow() {
    if (!mapCache.data || mapWindow.sentMapId === mapCache.id) return;
    mapWindow.sentMapId = mapCache.id;
    toBridge("map", { id: mapCache.id, data: mapCache.data, orientation: null });
  }

  function publishToMapWindow(now) {
    if (!mapWindow.connected) {
      if (battle.inBattle && !mapWindow.openRequested && now - pageStartedAt > AUTO_OPEN_DELAY_MS) openMapWindow();
      return;
    }
    sendMapToWindow();
    if (now < mapWindow.nextFrameAt) return;
    mapWindow.nextFrameAt = now + FRAME_INTERVAL_MS;
    toBridge("frame", { frame: buildMapFrame() });
  }

  function stepParkourCamera(factor) {
    if (OFF.camera) return flash("камера: выключена (toCoords.off)");
    if (!isParkour()) {
      return flash(parkourKnown() ? "камера: только в паркуре (формат боя: " + battleFormatName() + ")" : "камера: ищу формат боя…");
    }
    if (!followCam) return flash("камера: ещё ищу…");
    bumpParkourCam(factor);
  }

  var forwardedKeys = typeof WeakSet === "function" ? new WeakSet() : null;

  function pressKey(command) {
    if (command.type !== "keydown" && command.type !== "keyup") return;
    var keyCode = Number(command.keyCode) || 0;
    var ev = new KeyboardEvent(command.type, {
      code: String(command.code || ""), key: String(command.key || ""), keyCode: keyCode, which: keyCode,
      shiftKey: !!command.shift, ctrlKey: !!command.ctrl, altKey: !!command.alt, metaKey: !!command.meta,
      bubbles: true, cancelable: true, composed: true
    });
    if (ev.keyCode !== keyCode) {
      try {
        Object.defineProperty(ev, "keyCode", { value: keyCode });
        Object.defineProperty(ev, "which", { value: keyCode });
      } catch (e) {}
    }
    if (forwardedKeys) forwardedKeys.add(ev);
    (document.activeElement || document.body || document).dispatchEvent(ev);
  }

  function runCommand(command) {
    if (command.name === "camera") stepParkourCamera(Number(command.factor) || 1);
    else if (command.name === "bushes") setBushesHidden(!!command.hide);
    else if (command.name === "key") pressKey(command);
  }

  function onBridgeMessage(event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.type !== "TOC_IN") return;
    if (msg.kind === "connected") {
      mapWindow.connected = true;
      mapWindow.openRequested = true;
      mapWindow.sentMapId = null;
      logDebug("map window connected");
    } else if (msg.kind === "disconnected") {
      mapWindow.connected = false;
      logDebug("map window closed");
    } else if (msg.kind === "command") {
      runCommand(msg.command || {});
    }
  }

  function onKeyDown(ev) {
    if (!ev || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var target = ev.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    var plus = ev.code === "Equal" || ev.code === "NumpadAdd";
    var minus = ev.code === "Minus" || ev.code === "NumpadSubtract";
    if ((plus || minus) && ev.shiftKey) stepParkourCamera(plus ? 1.15 : 1 / 1.15);
    else if ((plus || minus) && mapWindow.connected) toBridge("zoom", { factor: plus ? 1.25 : 0.8 });
    else if (ev.code === "KeyM" && !ev.shiftKey && !(forwardedKeys && forwardedKeys.has(ev))) openMapWindow();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  function status() {
    return {
      ready: !!(lastMe && lastMe.ready),
      inBattle: !!battle.inBattle,
      battleId: battle.id,
      nativeMaps: nativeState.ready,
      mapWindow: mapWindow.connected,
      localAlive: isLocalAlive(),
      off: offList(),
      unitToMeter: UNIT,
      hooks: {
        localTankPosition: !!hooks.localTankPosition,
        localTankAlive: !!hooks.localTankAlive,
        printLocalTankPosition: !!hooks.printLocalTankPosition,
        physicsBody: !!hooks.physicsBody,
        physicsWorld: !!hooks.physicsWorld,
        radar: !!hooks.radarSystem,
        cpLive: cpLive.length,
        cpPoints: mapControlPoints.length,
        flagBases: mapTeamPoints.length,
        flagLive: flagLive.length,
        parkour: isParkour(),
        battleFormat: battlefieldCC ? String(battlefieldCC[G.formatName]) : null,
        followCam: !!followCam,
        parkourCam: parkourCam.mult,
        magnumAim: !!magnumAim,
        ownBody: !!ownBodyFromCamera(),
        posSource: lastSource,
        radarMarkers: (function () { try { return radarMarkers().length; } catch (e) { return 0; } })(),
        radarRange: (function () {
          try {
            var pr = hooks.radarSystem && hooks.radarSystem[G.radarParams];
            if (!pr || !isFiniteNum(pr[G.radarEnterRange])) return null;
            return { enterM: Math.round(toM(pr[G.radarEnterRange]) * 10) / 10, exitM: isFiniteNum(pr[G.radarExitRange]) ? Math.round(toM(pr[G.radarExitRange]) * 10) / 10 : null };
          } catch (e) { return null; }
        })(),
        camera: !!hooks.camera,
        battleMap: !!hooks.battleMap,
        mapName: hooks.mapName || null,
        hasStaticRaycast: worldHasFn(G.staticRaycast),
        bodyCandidates: bodyCandidates.length,
        mountCandidates: mountCandidates.length,
        getEventListeners: typeof getEventListeners === "function"
      },
      source: lastMe && lastMe.source,
      headingSource: lastHeadingSource,
      barrelSource: lastBarrelSource,
      speed: { kmh: speedState.kmh, mps: speedState.mps, source: speedState.source },
      ahead: lastAhead,
      rayError: lastRayError,
      scan: scanStats,
      callablesFound: Object.keys(foundCallables).filter(function (k) { return CALLABLE_ROLES[k]; }),
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
    try { document.removeEventListener("keydown", onKeyDown, true); } catch (eKey) {}
    try { window.removeEventListener("message", onBridgeMessage); } catch (eMsg) {}
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
    openMap: openMapWindow,
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
    camDebug: function () {
      var c = followCam, out = {
        parkour: isParkour(),
        battleFormat: battlefieldCC ? String(battlefieldCC[G.formatName]) : null,
        parkourFlag: battlefieldCC ? battlefieldCC[G.parkourMode] : null,
        sources: { battleData: !!battlefieldCC, battleParams: !!battleParams, mapComponent: mapComp ? mapComp[G.parkourGeometry] : null },
        treesHidden: treesHidden.filter(function (t) { try { return !t.o[G.isVisible](); } catch (e) { return false; } }).length,
        searching: !parkourKnown(),
        cameras: followCams.length,
        ours: !!c,
        mult: parkourCam.mult,
        off: !!OFF.camera
      };
      try {
        if (c) {
          out.distance = Math.round(c[G.cameraOffset][G.keyDistance]);
          out.height = Math.round(c[G.cameraOffset][G.keyHeight]);
          out.key0 = { d: Math.round(c[G.cameraSpline][G.splineKey0][G.keyDistance]), h: Math.round(c[G.cameraSpline][G.splineKey0][G.keyHeight]) };
          out.azv = c[G.cameraSpline][G.splineScale];
          out.path = Math.round(c[G.cameraPath] * 1000) / 1000;
        }
      } catch (e) { out.error = String(e && e.message || e); }
      return out;
    },
    aimDebug: function () {
      var st = magnumAimState();
      if (!st) return { found: !!magnumAim, showing: false };
      return { found: true, showing: true, points: st.pts.length, land: st.land ? { x: Math.round(st.land.x * 10) / 10, y: Math.round(st.land.y * 10) / 10 } : null };
    },
    flagDebug: function () {
      return flagLiveStates().map(function (f) {
        return { state: f.state, team: f.team, ourTeam: f.local, x: Math.round(f.pos.x), y: Math.round(f.pos.y) };
      });
    },
    cpDebug: function () {
      return cpLiveStates().map(function (c) {
        return { letter: c.letter, owner: c.owner || "NEUTRAL", score: Math.round(c.score), capturing: c.capTeam, ourTeam: c.local, active: c.active };
      });
    },
    radarDebug: function () {
      var sys = hooks.radarSystem;
      if (!sys) return { radar: false };
      return iterList(sys[G.radarEntries]).slice(0, 12).map(function (e) {
        var m = e && e[G.entryMarker], spr = m && m[G.markerSprite], nums = {}, k;
        try {
          for (k in spr) {
            if (typeof spr[k] === "number" || typeof spr[k] === "string" || typeof spr[k] === "boolean") nums[k] = spr[k];
          }
        } catch (eK) {}
        var col = spr && spr[G.spriteTint], colFields = null;
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
    try { document.addEventListener("keydown", onKeyDown, true); } catch (eKey) {}
    window.addEventListener("message", onBridgeMessage);
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
      console.log("[toCoords] запущен. Карта — в отдельном окне (M). toCoords.status() / openMap() / me() / off()");
    }
    installNativeListener();
    pingNative();
    if (isGameBundleReady()) startScan("ready");
    else waitForGameBundle(startScan);
  }

  installListenerCapture();
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
