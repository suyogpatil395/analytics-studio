/**
 * render.js
 * ------------------------------------------------------------------
 * Draws engine results: KPI tiles with comparison deltas, SVG line / bar /
 * pie charts, sortable tables, join tables with a verification note, and
 * CSV export. Clicking a bar or pie slice drills down (adds a filter and
 * re-runs the same spec, with no AI call).
 */
(function (AS) {
  "use strict";
  var PALETTE = ["#0f766e", "#c2410c", "#6d28d9", "#b45309", "#0369a1", "#be185d", "#4d7c0f", "#475569"];

  function fmt(v, kind) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (kind === "percent") return (v * 100).toFixed(1) + "%";
    var a = Math.abs(v), s;
    if (kind === "currency") s = a >= 1e7 ? (a / 1e7).toFixed(2) + " Cr" : a >= 1e5 ? (a / 1e5).toFixed(2) + " L" : a >= 1e3 ? Math.round(a).toLocaleString("en-IN") : a.toFixed(0);
    else s = a >= 1e5 ? (a / 1e5).toFixed(1) + " L" : Math.round(a).toLocaleString("en-IN");
    return (v < 0 ? "-" : "") + (kind === "currency" ? "₹" : "") + s;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function label(catalog, view, m) { var v = catalog[view]; var x = v && v.measures.filter(function (y) { return y.name === m; })[0]; return x ? x.label : m; }
  function delta(cur, prev) {
    if (prev === null || prev === undefined || !prev) return "";
    var p = (cur - prev) / Math.abs(prev); return '<span class="delta ' + (p >= 0 ? "up" : "down") + '">' + (p >= 0 ? "▲ " : "▼ ") + Math.abs(p * 100).toFixed(1) + "%</span>";
  }

  function kpis(b, r, catalog) {
    return '<div class="kpis">' + b.measures.map(function (m) {
      var f = AS.semantic.formats(b.view, m);
      return '<div class="kpi"><div class="kl">' + esc(label(catalog, b.view, m)) + '</div><div class="kv">' + fmt(r.values[m], f) + "</div>" +
        (r.previous ? '<div class="kd">' + delta(r.values[m], r.previous[m]) + ' <span class="muted">vs ' + fmt(r.previous[m], f) + "</span></div>" : "") + "</div>";
    }).join("") + "</div>";
  }

  function lineChart(b, r) {
    var rows = r.rows, prev = r.previous || [], W = 640, H = 220, P = { l: 52, r: 12, t: 12, b: 28 };
    var vals = rows.map(function (x) { return x[b.measure] || 0; }), pv = prev.map(function (x) { return x[b.measure] || 0; });
    var max = Math.max.apply(null, vals.concat(pv).concat([1])) * 1.1, n = Math.max(rows.length, 2);
    var X = function (i) { return P.l + i * (W - P.l - P.r) / (n - 1); }, Y = function (v) { return H - P.b - v / max * (H - P.t - P.b); };
    var path = function (arr) { return arr.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); }).join(""); };
    var grid = [0, .25, .5, .75, 1].map(function (g) { var v = max * g; return '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" class="grid"/><text x="' + (P.l - 6) + '" y="' + (Y(v) + 4) + '" class="ax" text-anchor="end">' + fmt(v, AS.semantic.formats(b.view, b.measure)).replace("₹", "") + "</text>"; }).join("");
    var step = Math.ceil(rows.length / 6), xl = rows.map(function (x, i) { return i % step ? "" : '<text x="' + X(i) + '" y="' + (H - 8) + '" class="ax" text-anchor="middle">' + esc(String(x.__time).slice(5)) + "</text>"; }).join("");
    return '<svg viewBox="0 0 ' + W + " " + H + '" class="chart" role="img">' + grid + xl +
      (pv.length ? '<path d="' + path(pv) + '" class="prev"/>' : "") +
      '<path d="' + path(vals) + "L" + X(vals.length - 1) + "," + Y(0) + "L" + X(0) + "," + Y(0) + 'Z" class="area"/><path d="' + path(vals) + '" class="line"/></svg>' +
      (pv.length ? '<div class="legend"><span class="sw cur"></span>Current <span class="sw prv"></span>Comparison period</div>' : "");
  }
  function barChart(b, r) {
    var rows = r.rows, max = Math.max.apply(null, rows.map(function (x) { return x[b.measure] || 0; }).concat([1]));
    return '<div class="bars">' + rows.map(function (x) {
      return '<button type="button" class="bar" data-drill="' + esc(b.dimension) + '" data-val="' + esc(x[b.dimension]) + '" title="Drill into ' + esc(x[b.dimension]) + '"><span class="bl">' + esc(x[b.dimension]) + '</span><span class="bt"><span class="bf" style="width:' + (100 * (x[b.measure] || 0) / max).toFixed(1) + '%"></span></span><span class="bv">' + fmt(x[b.measure], AS.semantic.formats(b.view, b.measure)) + "</span></button>";
    }).join("") + "</div>";
  }
  function pieChart(b, r) {
    var rows = r.rows, tot = rows.reduce(function (s, x) { return s + (x[b.measure] || 0); }, 0) || 1, a0 = -Math.PI / 2, cx = 110, cy = 110, R = 95, ri = 55;
    var arcs = rows.map(function (x, i) {
      var a1 = a0 + 2 * Math.PI * (x[b.measure] || 0) / tot, big = a1 - a0 > Math.PI ? 1 : 0;
      var p = function (a, rr) { return (cx + rr * Math.cos(a)).toFixed(1) + "," + (cy + rr * Math.sin(a)).toFixed(1); };
      var d = "M" + p(a0, R) + "A" + R + "," + R + " 0 " + big + " 1 " + p(a1, R) + "L" + p(a1, ri) + "A" + ri + "," + ri + " 0 " + big + " 0 " + p(a0, ri) + "Z";
      a0 = a1; return '<path d="' + d + '" fill="' + PALETTE[i % PALETTE.length] + '" data-drill="' + esc(b.dimension) + '" data-val="' + esc(x[b.dimension]) + '" class="slice"><title>' + esc(x[b.dimension]) + "</title></path>";
    }).join("");
    var leg = rows.map(function (x, i) { return '<div><span class="sw" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' + esc(x[b.dimension]) + ' <b>' + Math.round(100 * (x[b.measure] || 0) / tot) + "%</b></div>"; }).join("");
    return '<div class="pie"><svg viewBox="0 0 220 220" class="donut">' + arcs + '</svg><div class="pleg">' + leg + "</div></div>";
  }

  function table(cols, rows, fmts, prevMap) {
    return '<div class="tw"><table><thead><tr>' + cols.map(function (c, i) { return '<th data-sort="' + i + '">' + esc(c.label) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (row) { return "<tr>" + cols.map(function (c) { var v = row[c.key]; return c.num ? '<td class="n" data-v="' + (v === null ? "" : v) + '">' + fmt(v, fmts[c.key]) + (prevMap && c.cmp ? " " + delta(v, (prevMap[row.__k] || {})[c.key]) : "") + "</td>" : "<td>" + esc(v) + "</td>"; }).join("") + "</tr>"; }).join("") +
      "</tbody></table></div>";
  }

  function block(b, r, catalog) {
    var title = b.title || "";
    if (r && r.error) return card(title || b.type, '<div class="err">' + esc(r.error) + "</div>");
    if (b.type === "kpi") return kpis(b, r, catalog);
    if (b.type === "chart") {
      title = title || label(catalog, b.view, b.measure) + (b.dimension === "__time" ? " trend (" + b.grain + ")" : " by " + b.dimension.replace("_", " "));
      return card(title, b.chart === "line" ? lineChart(b, r) : b.chart === "pie" ? pieChart(b, r) : barChart(b, r), b);
    }
    if (b.type === "table") {
      var cols = b.dimensions.map(function (d) { return { key: d, label: d.replace("_", " ") }; }).concat(b.measures.map(function (m) { return { key: m, label: label(catalog, b.view, m), num: true, cmp: true }; }));
      var fm = {}; b.measures.forEach(function (m) { fm[m] = AS.semantic.formats(b.view, m); });
      var pm = null; if (r.previous) { pm = {}; r.previous.forEach(function (x) { pm[b.dimensions.map(function (d) { return x[d]; }).join("|")] = x; }); }
      r.rows.forEach(function (x) { x.__k = b.dimensions.map(function (d) { return x[d]; }).join("|"); });
      return card(title || "Breakdown by " + b.dimensions.join(", ").replace("_", " "), table(cols, r.rows, fm, pm), b);
    }
    if (b.type === "join") {
      var jc = b.on.map(function (d) { return { key: d, label: d }; })
        .concat(b.left.measures.map(function (m) { return { key: m, label: label(catalog, b.left.view, m), num: true }; }))
        .concat(b.right.measures.map(function (m) { return { key: m, label: label(catalog, b.right.view, m), num: true }; }))
        .concat(b.calc.map(function (c) { return { key: c.name, label: c.label || c.name, num: true }; }));
      var jf = {}; b.left.measures.forEach(function (m) { jf[m] = AS.semantic.formats(b.left.view, m); }); b.right.measures.forEach(function (m) { jf[m] = AS.semantic.formats(b.right.view, m); }); b.calc.forEach(function (c) { jf[c.name] = c.format || "currency"; });
      return card(title || "Joined analysis", '<div class="joinnote ' + (r.join && r.join.ok ? "ok" : "bad") + '">' + esc(r.join ? r.join.message : "") + "</div>" + table(jc, r.rows, jf), b);
    }
    return "";
  }
  function card(title, body, b) { return '<section class="card"><header><h3>' + esc(title) + '</h3>' + (b && b.type !== "kpi" ? '<button type="button" class="ghost csv">CSV</button>' : "") + "</header>" + body + "</section>"; }

  function report(el, spec, run, catalog) {
    el.innerHTML = spec.blocks.map(function (b, i) { return '<div class="blk" data-i="' + i + '">' + block(b, run.results[i], catalog) + "</div>"; }).join("");
    // sortable tables
    el.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.onclick = function () {
        var tb = th.closest("table").tBodies[0], i = +th.dataset.sort, asc = th.dataset.dir !== "asc"; th.dataset.dir = asc ? "asc" : "desc";
        [].slice.call(tb.rows).sort(function (a, c) { var x = a.cells[i].dataset.v !== undefined ? +a.cells[i].dataset.v : a.cells[i].textContent, y = c.cells[i].dataset.v !== undefined ? +c.cells[i].dataset.v : c.cells[i].textContent; return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1); }).forEach(function (r) { tb.appendChild(r); });
      };
    });
  }

  function toCSV(rows) {
    if (!rows || !rows.length) return "";
    var cols = Object.keys(rows[0]).filter(function (k) { return k !== "__k"; });
    return cols.join(",") + "\n" + rows.map(function (r) { return cols.map(function (c) { var v = r[c]; return v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; }).join(","); }).join("\n");
  }

  AS.render = { report: report, fmt: fmt, toCSV: toCSV };
})(window.AS = window.AS || {});
