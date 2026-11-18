(function (root) {
  "use strict";

  var names = {
    // vector
    x: "f20_1", y: "g20_1", z: "h20_1", mapX: "o80_1", mapY: "p80_1", mapZ: "q80_1", clone: "d21",
    setXYZ: "n23", copyFrom: "k26", setOnRay: "u27",

    // quaternion
    quatW: "i23_1", quatX: "j23_1", quatY: "k23_1", quatZ: "l23_1",

    // transform
    m00: "g22_1", m10: "h22_1", m20: "i22_1", m01: "j22_1", m11: "k22_1", m21: "l22_1", m02: "m22_1",
    m12: "n22_1", m22: "o22_1", tx: "y23_1", ty: "z23_1", tz: "a24_1", rotateVector: "r24",

    // bounds
    minX: "y1z_1", minY: "z1z_1", minZ: "a20_1", maxX: "b20_1", maxY: "c20_1", maxZ: "d20_1",

    // list
    size: "e1", get: "g1",

    // body
    bodyState: "v9i_1", position: "i9j_1", orientation: "g9j_1", velocity: "f9j_1", angularVelocity: "h9j_1",
    bodyOwner: "b9i_1", bodyShapes: "o9i_1", bodyMovable: "d9i_1", bodyLink: "c9i_1",

    // entity
    entityComponents: "gz1_1",

    // health
    healthCurrent: "h12o_1", healthMax: "g12o_1", healthEvent: "f12o_1",

    // world
    entityWorld: "zz0_1", systemEntity: "yz3_1", raycast: "z9l", physics: "zyv_1", controllers: "syw_1",
    jsMap: "s2a_1", renderCamera: "yyw_1", cameraRotation: "u35_1",

    // physics
    bodies: "q9m_1", collisionDetector: "g9m_1", staticRaycast: "b9m", staticGrid: "w9n_1",
    staticTree: "v9n_1", bulkListA: "u9n_1", bulkListB: "y9n_1", bulkListC: "a9o_1", gridCells: "l9p_1",
    gridCellSize: "k9p_1", gridCountX: "n9p_1", gridCountY: "o9p_1", gridCountZ: "p9p_1",
    cellShapes: "f9q_1", nodeShapes: "w9q_1", nodeLeft: "s9q_1", nodeRight: "t9q_1",

    // shape
    shapeBody: "r9j_1", shapeTag: "n9j_1", shapeTagAlt: "q9j_1", shapeTransform: "t9j_1", shapeType: "l9j_1",
    shapeGroup: "p9j_1", shapeBounds: "u9j_1", boxHalfSize: "i9u_1", planeHalfSize: "s9v_1",
    triangleA: "k9x_1", triangleB: "l9x_1", triangleC: "m9x_1", sphereRadius: "j9w_1",

    // hit
    hitDistance: "l9q_1", hitShape: "i9q_1", hitPoint: "j9q_1", hitNormal: "k9q_1", hitTests: "m9q_1",
    hitStatA: "o9q_1", hitStatB: "p9q_1", hitStatC: "n9q_1", copyHit: "h9s", resetHit: "d3",

    // weaponMount
    mountMatrix: "pzr_1", mountSockets: "vzr_1", socketPosition: "tzk_1", socketDirection: "wzk_1",

    // battleMap
    collisionGeometry: "b7w_1", getCollisionGeometry: "g7w", outsideGeometry: "c7w_1",
    getOutsideGeometry: "h7w", staticGeometry: "f7w_1", getStaticGeometry: "j7w", spawnSet: "e7w_1",
    getSpawns: "r7z", spawnList: "q7z_1", propList: "t7z_1", getProps: "u7z", boxes: "u7w_1",
    planes: "v7w_1", triangles: "w7w_1", getBoxes: "x7w", getPlanes: "y7w", getTriangles: "z7w",
    getPosition: "n7v", getRotation: "q7w", getName: "m", boxPosition: "n7w_1", boxRotation: "o7w_1",
    boxSize: "p7w_1", planePosition: "d7x_1", planeRotation: "e7x_1", planeLength: "c7x_1",
    planeWidth: "f7x_1", trianglePosition: "m7x_1", triangleRotation: "n7x_1", vertex0: "o7x_1",
    vertex1: "p7x_1", vertex2: "q7x_1", getVertex0: "r7x", getVertex1: "s7x", getVertex2: "t7x",
    propName: "y7y_1", propGroup: "u7y_1", propLibrary: "w7y_1", getLibrary: "c7v", propPosition: "z7y_1",
    propRotation: "a7z_1", propScale: "b7z_1", spawnPosition: "m7z_1", spawnRotation: "n7z_1",
    spawnType: "o7z_1", mapTitle: "ijb_1", mapTitleMarker: "cjb_1", getMapTitle: "nc1",

    // battle
    battleName: "zib_1", getBattleMap: "d8f", parkourMode: "hic_1", formatName: "bic_1",
    parkourSlot: "qzd_1", spectatorSlot: "pzd_1", slotName: "gzl_1", slotValue: "hzl_1",
    parkourGeometry: "m102_1", getDustSettings: "h10y", mapCollision: "p102_1", mapLighting: "o102_1",
    spriteTrees: "s102_1", trees: "u102_1", treesExtra: "w102_1", setVisible: "p3k", isVisible: "m3k",

    // flags
    teamPointPosition: "xin_1", teamPointTeam: "zin_1", recordId: "yin_1", flagCarrierId: "oir_1",
    teamPointTeamAlt: "win_1", flagStatus: "mir_1", flagState: "z133_1", flagTeam: "u133_1",
    flagTeams: "q13b_1", flagMarker: "t13b_1", markerPosition: "r133_1", markerRule: "k133_1",
    flagWorld: "v133_1", flagCarrierCodec: "kir_1", flagPositionCodec: "lir_1",

    // controlPoints
    pointActive: "xii_1", pointId: "yii_1", pointPosition: "aij_1", dominationPoints: "mii_1",
    dominationA: "jii_1", dominationB: "kii_1", getDominationPoints: "pii", initPointRecord: "o13j_1",
    initPointRecordAlt: "r13j_1", getTransform: "aio", cpName: "r11f_1", cpPosition: "s11f_1",
    cpOwner: "y11f_1", cpScore: "a11g_1", cpServerScore: "z11f_1", cpScoreRate: "b11g_1", cpActive: "d11g_1",
    cpTeams: "x11f_1", cpWorld: "t11f_1", ourTeam: "l10b_1",

    // radar
    radarEntries: "n11x_1", entryEntity: "t11x_1", entryMarker: "u11x_1", radarPartA: "o11x_1",
    radarPartB: "q11x_1", radarPartC: "r11x_1", radarFlag: "g11x_1", radarParams: "j11x_1",
    radarEnterRange: "dje_1", radarExitRange: "eje_1", markerPos: "o11w_1", markerSprite: "q11w_1",
    spriteTint: "d4q_1",

    // camera
    cameraSpline: "tzs_1", splineScale: "azv_1", splineKey0: "wzu_1", splineKey1: "xzu_1",
    splineKey2: "yzu_1", splineKey3: "zzu_1", keyDistance: "uzu_1", keyHeight: "vzu_1", cameraPath: "qzs_1",
    setCameraPath: "tzv", cameraTankPhysics: "lzs_1", physicsBody: "mzq_1", getBody: "fbk",
    cameraOffset: "uzs_1",

    // magnum
    aimHit: "s1ab_1", aimPointCount: "t1ab_1", aimPoints: "o1ab_1", aimPointPosition: "b14v_1",
    aimState: "k1ab_1", aimMark: "i1ab_1", aimActive: "m1ab_1", aimTankBody: "c1ab_1",

    // console
    consolePrint: "z2i"
  };

  root.TOC = root.TOC || {};
  root.TOC.game = {
    names: names,
    tags: {
      vector: "Vector3 (",
      quaternion: "Quaternion(",
      battleMap: "BattleMap [",
      collisionGeometry: "CollisionGeometry [",
      clientPointData: "ClientPointData",
      dominationConfig: "DominationCC"
    },
    vectorText: /Vector3 \((.+), (.+), (.+)\)/,
    quaternionText: /^Quaternion\((.+), (.+), (.+), (.+)\)$/,
    callables: {
      localTankPosition: "getLocalTankPosition",
      localTankAlive: "isLocalTankAlive",
      printLocalTankPosition: "showPositionLocalTank",
      initPoint: "initPoint",
      initNewStylePoint: "initNewStylePoint"
    },
    teams: { a: "TEAM_A", b: "TEAM_B" },
    flagStates: { atBase: "AT_BASE", dropped: "DROPPED", carried: "CARRIED", away: ["DROPPED", "CARRIED", "EXILED", "FLYING"] },
    aimShowing: "StartedIndicating",
    parkourFormat: /PARKOUR|ПАРКУР/i,
    globals: { launcher: "Launcher", commands: "_cmd", stream: "tankiStreamApi" },
    staticMask: 16,
    radarTints: { ally: 0x33bbff, enemy: 0xff6666 }
  };
})(window);
