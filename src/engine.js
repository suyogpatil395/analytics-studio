/**
 * engine.js
 * ------------------------------------------------------------------
 * Executes a validated spec: turns each block into semantic-layer queries,
 * runs them (in parallel), adds comparison values, and returns render-ready
 * results. No AI is involved here, so it is deterministic and free.
 *
 * Also contains the DEEP-DIVE JOIN: when a question needs measures from two
 * metrics views (e.g. revenue from item_sales + cost from recipe_costs), the
 * engine queries both at the shared grain, VERIFIES the join keys actually
 * match, then merges and computes calculated fields null-safely.
 */
(function (AS) {
  "use strict";

  function baseArgs(view, spec, range, extra) {
    var where = spec.filters.filter(function (f) { return AS.engine.viewHasDim(view, f.dimension); });
    return Object.assign({ metrics_view: view, time_range: range, where: where }, extra);
  }

  var catalogRef = {};
  function viewHasDim(view, dim) { var v = catalogRef[view]; return !!(v && v.dimensions.some(function (d) { return d.name === dim; })); }

  async function runBlock(b, spec, range, cmp) {
    if (b.type === "kpi") {
      var args = baseArgs(b.view, spec, range, { measures: b.measures.map(function (m) { return { name: m }; }) });
      var cur = await AS.data.query(args), prev = cmp ? await AS.data.query(Object.assign({}, args, { time_range: cmp })) : null;
      return { values: cur.rows[0] || {}, previous: prev ? prev.rows[0] || {} : null };
    }
    if (b.type === "chart") {
      var cargs = baseArgs(b.view, spec, range, { measures: [{ name: b.measure }], dimensions: [{ name: b.dimension }], time_grain: b.grain,
        sort: b.dimension === "__time" ? [{ name: "__time" }] : [{ name: b.measure, desc: true }], limit: b.limit || undefined });
      var res = await AS.data.query(cargs), out = { rows: res.rows };
      if (cmp && b.dimension === "__time") { var p = await AS.data.query(Object.assign({}, cargs, { time_range: cmp })); out.previous = p.rows; }
      return out;
    }
    if (b.type === "table") {
      var targs = baseArgs(b.view, spec, range, { measures: b.measures.map(function (m) { return { name: m }; }), dimensions: b.dimensions.map(function (x) { return { name: x }; }),
        sort: [{ name: b.sort.by, desc: b.sort.desc }], limit: b.limit });
      var t = await AS.data.query(targs), tp = null;
      if (cmp) { tp = await AS.data.query(Object.assign({}, targs, { time_range: cmp, limit: 1000 })); }
      return { rows: t.rows, previous: tp ? tp.rows : null };
    }
    if (b.type === "join") return deepJoin(b, spec, range);
    return null;
  }

  // ---------- deep-dive join ----------
  function keyOf(row, on) { return on.map(function (k) { return String(row[k]).trim().toLowerCase(); }).join("|"); }

  /** Evaluate "a - b" style expressions over a row. Any missing operand -> null (never treat missing as 0). */
  function calc(expr, row) {
    var missing = false;
    var js = expr.replace(/[A-Za-z_]\w*/g, function (name) { var v = row[name]; if (v === null || v === undefined || Number.isNaN(v)) missing = true; return "(" + Number(v) + ")"; });
    if (missing) return null;
    try { var r = Function('"use strict";return (' + js + ")")(); return Number.isFinite(r) ? r : null; } catch (e) { return null; }
  }

  async function deepJoin(b, spec, range) {
    var la = baseArgs(b.left.view, spec, range, { measures: b.left.measures.map(function (m) { return { name: m }; }), dimensions: b.on.map(function (k) { return { name: k }; }), limit: 5000 });
    var ra = baseArgs(b.right.view, spec, range, { measures: b.right.measures.map(function (m) { return { name: m }; }), dimensions: b.on.map(function (k) { return { name: k }; }), limit: 5000 });
    var L = (await AS.data.query(la)).rows, R = (await AS.data.query(ra)).rows;
    // 1. verify keys: how many left keys exist on the right?
    var rIdx = {}; R.forEach(function (r) { rIdx[keyOf(r, b.on)] = r; });
    var matched = L.filter(function (l) { return rIdx[keyOf(l, b.on)]; }).length;
    var matchRate = L.length ? matched / L.length : 0;
    if (matchRate < 0.5) return { rows: [], join: { on: b.on, matchRate: matchRate, ok: false, message: "Join keys don't line up (" + Math.round(matchRate * 100) + "% match). Not merging, to avoid wrong numbers." } };
    // 2. merge (left join) + calculated fields
    var rows = L.map(function (l) {
      var r = rIdx[keyOf(l, b.on)] || {}, row = Object.assign({}, l);
      b.right.measures.forEach(function (m) { row[m] = r[m] === undefined ? null : r[m]; });
      b.calc.forEach(function (c) { row[c.name] = calc(c.expr, row); });
      return row;
    });
    if (b.sort) rows.sort(function (x, y) { var a = x[b.sort.by], c = y[b.sort.by]; if (a === null) return 1; if (c === null) return -1; return b.sort.desc ? c - a : a - c; });
    return { rows: rows.slice(0, b.limit), join: { on: b.on, matchRate: matchRate, ok: true, matched: matched, total: L.length,
      message: "Verified join on " + b.on.join(", ") + ": " + matched + " of " + L.length + " keys matched (" + Math.round(matchRate * 100) + "%). Unmatched rows show blank, not zero." } };
  }

  async function execute(spec, catalog, today) {
    catalogRef = catalog;
    var range = AS.spec.resolveRange(spec.date_range, today), cmp = AS.spec.compareRange(range, spec.compare);
    var t0 = Date.now(), before = AS.data.stats.queries;
    var results = await Promise.all(spec.blocks.map(function (b) { return runBlock(b, spec, range, cmp).catch(function (e) { return { error: e.message }; }); }));
    return { range: range, compareRange: cmp, results: results, ms: Date.now() - t0, queries: AS.data.stats.queries - before };
  }

  AS.engine = { execute: execute, viewHasDim: viewHasDim, calc: calc };
})(window.AS = window.AS || {});
