#!/usr/bin/env node
"use strict";

function decideBattleChange(sample) {
  if (!sample) return null;
  // Never reset on a position jump, respawn, teleport, or frozen pos alone.
  // Only a new physicsWorld identity means a different battle.
  if (sample.newerWorld && sample.newerWorld !== sample.world) return "physicsWorld";
  if (sample.world && sample.watchWorld && sample.world !== sample.watchWorld) return "physicsWorld";
  return null;
}

function shouldBroadScan(sample) {
  if (!sample) return false;
  if (sample.posHooked && sample.hasWorld) return false;
  if (!sample.hasWorld && !sample.inBattle && !sample.live) return !!sample.lobbyDue;
  return !sample.posHooked || !sample.hasWorld;
}

var failed = 0;
function check(name, got, want) {
  if (got !== want) {
    console.error("FAIL", name, "got", got, "want", want);
    failed++;
  } else {
    console.log("ok", name, "->", got);
  }
}

var world1 = { id: "w1" };
var world2 = { id: "w2" };
var map1 = { id: "m1" };
var map2 = { id: "m2" };
var body1 = { id: "b1" };
var body2 = { id: "b2" };

check("idle lobby", decideBattleChange({ inBattle: false, world: null }), null);

check("battle1 playing", decideBattleChange({
  inBattle: true, world: world1, watchWorld: world1, newerWorld: null,
  map: map1, watchMap: map1, body: body1, worldHasBody: true,
  posFrozenMs: 0, physicsUpdating: true
}), null);

check("respawn jump same world (must not reset)", decideBattleChange({
  inBattle: true, world: world1, watchWorld: world1, newerWorld: null,
  map: map1, watchMap: map1, body: body1, worldHasBody: true,
  posFrozenMs: 0, physicsUpdating: true, posJumped: true, jumpM: 80
}), null);

check("frozen pos while physics ticks (camping / stale, must not reset)", decideBattleChange({
  inBattle: true, world: world1, watchWorld: world1, map: map1, watchMap: map1,
  body: body1, worldHasBody: true, posFrozenMs: 4000, physicsUpdating: true
}), null);

check("lobby leave is not decideBattleChange", decideBattleChange({
  inBattle: false, world: null, map: null, body: null
}), null);

check("battle2 new physicsWorld", decideBattleChange({
  inBattle: true, world: world1, watchWorld: world1, newerWorld: world2,
  map: map1, watchMap: map1, body: body1, worldHasBody: true
}), "physicsWorld");

check("battle2 world identity changed", decideBattleChange({
  inBattle: true, world: world2, watchWorld: world1, newerWorld: null,
  map: map2, watchMap: map1, body: body2, worldHasBody: true
}), "physicsWorld");

check("body not in world alone does not reset", decideBattleChange({
  inBattle: true, world: world1, watchWorld: world1, body: body1, worldHasBody: false
}), null);

check("lobby idle no scan until due", shouldBroadScan({
  posHooked: false, hasWorld: false, inBattle: false, live: false, lobbyDue: false
}), false);

check("lobby occasional light scan", shouldBroadScan({
  posHooked: false, hasWorld: false, inBattle: false, live: false, lobbyDue: true
}), true);

check("after pos+world hooked stop broad scan", shouldBroadScan({
  posHooked: true, hasWorld: true, inBattle: true, live: true
}), false);

check("in battle missing world still scans", shouldBroadScan({
  posHooked: true, hasWorld: false, inBattle: true, live: true
}), true);

// sequence battle1 -> respawn jump -> lobby -> battle2
var log = [];
function step(label, sample, expect, kind) {
  var r = (kind === "scan") ? shouldBroadScan(sample) : decideBattleChange(sample);
  log.push(label + " => " + r);
  check("seq " + label, r, expect);
}

step("battle1", {
  inBattle: true, world: world1, watchWorld: world1, map: map1, watchMap: map1,
  body: body1, worldHasBody: true, posFrozenMs: 100, physicsUpdating: true
}, null);

step("respawn jump", {
  inBattle: true, world: world1, watchWorld: world1, newerWorld: null,
  posJumped: true, jumpM: 120, physicsUpdating: true, body: body1, worldHasBody: true
}, null);

step("lobby", { inBattle: false, world: null, map: null, body: null }, null);

step("battle2", {
  inBattle: true, world: world1, watchWorld: world1, newerWorld: world2,
  map: map2, watchMap: map1, body: body1, worldHasBody: false,
  posFrozenMs: 4000, physicsUpdating: true, posJumped: true
}, "physicsWorld");

step("scan after hooks", { posHooked: true, hasWorld: true, inBattle: true, live: true }, false, "scan");

console.log("sequence:", log.join(" | "));
if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("all battle-change stub checks passed");
