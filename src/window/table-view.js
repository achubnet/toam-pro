/*
 * tables = [{ title, side, columns: [text], rows: [{ cells: [text], mine }] }]
 */
(function (root) {
  "use strict";

  function cell(tag, text) {
    var c = document.createElement(tag);
    c.textContent = text == null ? "" : String(text);
    return c;
  }

  function table(t) {
    var box = document.createElement("div"), title = document.createElement("h2"), grid = document.createElement("table");
    box.className = "table";
    box.setAttribute("data-side", t.side || "neutral");
    title.textContent = t.title || "";
    box.appendChild(title);
    var head = document.createElement("tr");
    (t.columns || []).forEach(function (c) { head.appendChild(cell("th", c)); });
    grid.appendChild(head);
    (t.rows || []).forEach(function (r) {
      var row = document.createElement("tr");
      if (r.mine) row.className = "mine";
      (r.cells || []).forEach(function (c) { row.appendChild(cell("td", c)); });
      grid.appendChild(row);
    });
    box.appendChild(grid);
    return box;
  }

  function render(el, tables, empty) {
    var key = JSON.stringify([tables || [], empty || ""]);
    if (el.lastKey === key) return;
    el.lastKey = key;
    el.textContent = "";
    if (!tables || !tables.length) {
      var p = cell("p", empty || "");
      p.className = "empty";
      el.appendChild(p);
      return;
    }
    tables.forEach(function (t) { el.appendChild(table(t)); });
  }

  root.View = root.View || {};
  root.View.tables = { render: render };
})(window);
