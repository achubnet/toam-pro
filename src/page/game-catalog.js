(function (root) {
  "use strict";

  var turrets = {
    "920009630983": "Огнемёт", "920009631074": "Фриз", "920009630913": "Изида", "920009631046": "Молот",
    "920009630997": "Твинс", "920009631088": "Рикошет", "920009630969": "Смоки", "920009630990": "Страйкер",
    "920009631144": "Вулкан", "920009631123": "Гром", "920009631011": "Рельса", "920009630976": "Магнум",
    "920009631158": "Шафт", "920009631151": "Гаусс", "920009631165": "Джагер", "921009714084": "Тесла",
    "921009741519": "Бонк", "931009771122": "Скорпион", "1931009780251": "Цунами"
  };

  var hulls = {
    "920009630962": "Диктатор", "920009630927": "Хорнет", "920009631039": "Хантер", "920009631102": "Джаггернаут",
    "920009631025": "Мамонт", "920009631018": "Титан", "920009630941": "Викинг", "920009630955": "Васп",
    "920009661882": "Арес", "921009707333": "Крусейдер", "921009687066": "Хоппер", "921009749934": "Паладин"
  };

  var damage = {
    SCORPIO: "Скорпион", SCORPIO_ROCKET: "Скорпион", SMOKY: "Смоки", TSUNAMI: "Цунами", TSUNAMI_COMBO: "Цунами",
    FIREBIRD: "Огнемёт", FIREBIRD_OVERHEAT: "Огнемёт", TWINS: "Твинс", RAILGUN: "Рельса", ISIS: "Изида",
    MINE: "Мина", THUNDER: "Гром", RICOCHET: "Рикошет", RICOCHET_BOUNCED: "Рикошет", FREEZE: "Фриз",
    SHAFT: "Шафт", SHAFT_AIMING: "Шафт", MACHINE_GUN: "Вулкан", SHOTGUN: "Молот", SHOTGUN_LAST_SHOT: "Молот",
    ROCKET: "Страйкер", SALVO_ROCKET: "Страйкер", ARTILLERY: "Магнум", SNOWBALL: "Снежок", TOMATO: "Помидор",
    TERMINATOR: "Джагер", BONK: "Бонк", BOMB: "Бомба", GAUSS: "Гаусс", GAUSS_AIMING: "Гаусс",
    TESLA: "Тесла", TESLA_GLOBE_LIGHTNING: "Тесла"
  };

  var weaponKinds = {
    ArtilleryRotating: "Магнум", ArtilleryElevating: "Магнум", Bonk: "Бонк", Firebird: "Огнемёт", Freeze: "Фриз",
    Gauss: "Гаусс", Isis: "Изида", MachineGun: "Вулкан", Railgun: "Рельса", Ricochet: "Рикошет",
    Striker: "Страйкер", Scorpio: "Скорпион", Shaft: "Шафт", Shotgun: "Молот", Smoky: "Смоки",
    Terminator: "Джагер", Tesla: "Тесла", Thunder: "Гром", Twins: "Твинс", Tsunami: "Цунами"
  };

  var supplies = [
    ["FIRST_AID", "Аптечка"], ["DOUBLE_ARMOR", "Броня"], ["DOUBLE_DAMAGE", "Урон"], ["NITRO", "Нитро"],
    ["MINE", "Мина"], ["GRENADE", "Граната"], ["GOLD_BOX", "Голд", true], ["NUCLEAR", "Ядерка", true]
  ];

  root.TOC = root.TOC || {};
  root.TOC.catalog = { turrets: turrets, hulls: hulls, damage: damage, weaponKinds: weaponKinds, supplies: supplies };
})(window);
