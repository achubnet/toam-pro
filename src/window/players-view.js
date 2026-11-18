/*
 * players = [{ side, name, score, players: [{ name, rank, score, kills, deaths, turret, hull, me }] }]
 *   side: ally | enemy | red | blue | all
 */
(function (root) {
  "use strict";

  var COLUMNS = [
    ["name", "Игрок"],
    ["turret", "Пушка"],
    ["hull", "Корпус"],
    ["score", "Очки"],
    ["kills", "У"],
    ["deaths", "С"]
  ];

  function cell(tag, text, cls) {
    var c = document.createElement(tag);
    if (cls) c.className = cls;
    c.textContent = text == null ? "" : String(text);
    return c;
  }

  function teamTable(team) {
    var box = document.createElement("div");
    box.className = "team";
    box.setAttribute("data-side", team.side || "all");
    var title = document.createElement("h2");
    title.textContent = (team.name || "Игроки") + (team.score == null ? "" : "  " + team.score);
    box.appendChild(title);
    var table = document.createElement("table");
    var head = document.createElement("tr");
    COLUMNS.forEach(function (c) { head.appendChild(cell("th", c[1])); });
    table.appendChild(head);
    (team.players || []).forEach(function (p) {
      var row = document.createElement("tr");
      if (p.me) row.className = "me";
      COLUMNS.forEach(function (c) {
        var text = p[c[0]];
        if (c[0] === "name" && p.rank != null) text = p.name + " · " + p.rank;
        row.appendChild(cell("td", text, c[0]));
      });
      table.appendChild(row);
    });
    box.appendChild(table);
    return box;
  }

  function render(el, teams) {
    var key = JSON.stringify(teams || []);
    if (el.lastKey === key) return;
    el.lastKey = key;
    el.textContent = "";
    if (!teams || !teams.length) {
      el.appendChild(cell("p", "Нет данных — зайди в бой", "empty"));
      return;
    }
    teams.forEach(function (t) { el.appendChild(teamTable(t)); });
  }

  root.TOC.views = root.TOC.views || {};
  root.TOC.views.players = { render: render };
})(window);
