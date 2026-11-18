/*
 * rows = [{ label, text, bar, barColor, wide }]
 *   bar: 0…1 draws a progress line under the row, wide: value on its own line
 */
(function (root) {
  "use strict";

  function makeRow() {
    var line = document.createElement("div"), label = document.createElement("span");
    var value = document.createElement("span"), bar = document.createElement("div");
    line.className = "row";
    label.className = "label";
    value.className = "value";
    bar.className = "bar";
    bar.appendChild(document.createElement("div"));
    line.appendChild(label);
    line.appendChild(value);
    line.appendChild(bar);
    return { line: line, label: label, value: value, bar: bar };
  }

  function render(el, rows) {
    rows = rows || [];
    el.rows = el.rows || [];
    while (el.rows.length < rows.length) {
      var row = makeRow();
      el.rows.push(row);
      el.appendChild(row.line);
    }
    el.rows.forEach(function (r, i) {
      var data = rows[i];
      r.line.hidden = !data;
      if (!data) return;
      r.line.classList.toggle("wide", !!data.wide);
      r.label.textContent = data.label || "";
      r.value.textContent = data.text == null ? "—" : data.text;
      var hasBar = typeof data.bar === "number" && isFinite(data.bar);
      r.bar.hidden = !hasBar;
      if (hasBar) {
        r.bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, data.bar)) * 100) + "%";
        r.bar.firstChild.style.background = data.barColor || "";
      }
    });
  }

  root.View = root.View || {};
  root.View.info = { render: render };
})(window);
