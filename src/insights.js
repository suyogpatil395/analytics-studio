/**
 * insights.js
 * ------------------------------------------------------------------
 * "What changed?" in plain language, computed from results the engine
 * already fetched, so it needs no extra queries and no AI tokens.
 *
 *  - KPI movement vs the comparison period
 *  - biggest movers inside a breakdown table (which branch/channel drove it)
 *  - concentration (one item doing most of the volume)
 *  - join health (unmatched keys)
 */
(function (AS) {
  "use strict";
  function pct(a, b) { return b ? (a - b) / Math.abs(b) : null; }

  function generate(spec, run, catalog, fmt) {
    var out = [];
    spec.blocks.forEach(function (b, i) {
      var r = run.results[i]; if (!r || r.error) return;
      var view = catalog[b.view] || {}, label = function (m) { var x = (view.measures || []).filter(function (y) { return y.name === m; })[0]; return x ? x.label : m; };
      if (b.type === "kpi" && r.previous) {
        b.measures.forEach(function (m) {
          var p = pct(r.values[m], r.previous[m]); if (p === null) return;
          if (Math.abs(p) >= 0.03) out.push({ tone: p > 0 ? "up" : "down", text: label(m) + " is " + (p > 0 ? "up " : "down ") + Math.abs(p * 100).toFixed(1) + "% (" + fmt(r.values[m], AS.semantic.formats(b.view, m)) + " vs " + fmt(r.previous[m], AS.semantic.formats(b.view, m)) + ")." });
        });
      }
      if (b.type === "table" && r.previous && b.dimensions.length === 1) {
        var dim = b.dimensions[0], m0 = b.measures[0], prev = {};
        r.previous.forEach(function (x) { prev[x[dim]] = x[m0]; });
        var movers = r.rows.map(function (x) { return { k: x[dim], d: x[m0] - (prev[x[dim]] || 0) }; }).sort(function (a, c) { return Math.abs(c.d) - Math.abs(a.d); });
        if (movers[0] && movers[0].d) out.push({ tone: movers[0].d > 0 ? "up" : "down", text: "Biggest driver: " + movers[0].k + " (" + (movers[0].d > 0 ? "+" : "") + fmt(movers[0].d, AS.semantic.formats(b.view, m0)) + " " + label(m0).toLowerCase() + ")." });
      }
      if (b.type === "chart" && b.dimension !== "__time" && r.rows.length > 2) {
        var tot = r.rows.reduce(function (s, x) { return s + (x[b.measure] || 0); }, 0), top = r.rows[0];
        if (tot && top[b.measure] / tot > 0.35) out.push({ tone: "info", text: top[b.dimension] + " alone is " + Math.round(top[b.measure] / tot * 100) + "% of " + label(b.measure).toLowerCase() + " in this view." });
      }
      if (b.type === "chart" && b.dimension === "__time" && r.rows.length > 6) {
        var best = r.rows.reduce(function (a, x) { return x[b.measure] > a[b.measure] ? x : a; });
        out.push({ tone: "info", text: "Best " + b.grain + ": " + best.__time + " with " + fmt(best[b.measure], AS.semantic.formats(b.view, b.measure)) + "." });
      }
      if (b.type === "join" && r.join) out.push({ tone: r.join.ok ? "info" : "down", text: r.join.message });
    });
    return out.slice(0, 6);
  }
  AS.insights = { generate: generate };
})(window.AS = window.AS || {});
