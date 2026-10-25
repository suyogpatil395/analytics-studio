/**
 * spec.js
 * ------------------------------------------------------------------
 * The REPORT SPEC is the contract between the AI and the app.
 * The AI never writes SQL and never touches data. It only writes a small
 * JSON document that says WHAT to show. The app validates it against the
 * semantic layer catalog and decides HOW to fetch and draw it.
 *
 * {
 *   "title": "Channel performance",
 *   "date_range": { "preset": "last_7_days" } | { "start": "2026-10-01", "end": "2026-10-08" },
 *   "compare": null | "previous_period" | "previous_week" | "previous_year",
 *   "filters": [ { "dimension": "channel", "op": "in", "values": ["Swiggy"] } ],
 *   "blocks": [
 *     { "type": "kpi",   "view": "orders", "measures": ["revenue", "orders", "aov"] },
 *     { "type": "chart", "view": "orders", "chart": "line|bar|pie", "measure": "revenue",
 *       "dimension": "__time" | "<dimension>", "grain": "day|week|month", "limit": 10 },
 *     { "type": "table", "view": "orders", "dimensions": ["branch"], "measures": ["revenue"],
 *       "sort": { "by": "revenue", "desc": true }, "limit": 20 },
 *     { "type": "join",  "title": "Profit by product",
 *       "left":  { "view": "item_sales",   "dimensions": ["product"], "measures": ["item_revenue"] },
 *       "right": { "view": "recipe_costs", "dimensions": ["product"], "measures": ["food_cost"] },
 *       "on": ["product"],
 *       "calc": [ { "name": "profit", "label": "Profit", "expr": "item_revenue - food_cost", "format": "currency" },
 *                 { "name": "margin", "label": "Margin %", "expr": "(item_revenue - food_cost) / item_revenue", "format": "percent" } ],
 *       "sort": { "by": "profit", "desc": true }, "limit": 15 }
 *   ]
 * }
 */
(function (AS) {
  "use strict";
  var PRESETS = ["today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "this_month", "last_month", "last_90_days"];
  var COMPARES = [null, "previous_period", "previous_week", "previous_year"];

  function d(s) { return new Date(s + "T00:00:00Z"); }
  function f(dt) { return dt.toISOString().slice(0, 10); }
  function add(s, days) { return f(new Date(d(s).getTime() + days * 86400000)); }

  /** Resolve a preset to a half-open [start, end) range relative to "today". */
  function resolveRange(range, today) {
    var end = add(today, 1);
    if (range && range.start && range.end) return { start: range.start, end: range.end };
    var p = (range && range.preset) || "last_30_days";
    switch (p) {
      case "today": return { start: today, end: end };
      case "yesterday": return { start: add(today, -1), end: today };
      case "last_7_days": return { start: add(today, -6), end: end };
      case "last_14_days": return { start: add(today, -13), end: end };
      case "last_90_days": return { start: add(today, -89), end: end };
      case "this_month": return { start: today.slice(0, 8) + "01", end: end };
      case "last_month": var first = today.slice(0, 8) + "01", prev = d(first); prev.setUTCMonth(prev.getUTCMonth() - 1); return { start: f(prev), end: first };
      default: return { start: add(today, -29), end: end };
    }
  }
  /** Comparison window of the same length. */
  function compareRange(r, mode) {
    if (!mode) return null;
    var len = (d(r.end) - d(r.start)) / 86400000;
    if (mode === "previous_week") return { start: add(r.start, -7), end: add(r.end, -7) };
    if (mode === "previous_year") { var s = d(r.start), e = d(r.end); s.setUTCFullYear(s.getUTCFullYear() - 1); e.setUTCFullYear(e.getUTCFullYear() - 1); return { start: f(s), end: f(e) }; }
    return { start: add(r.start, -len), end: r.start };
  }

  /**
   * Validate + normalise a spec against the catalog.
   * Returns { spec, errors[], warnings[] }. Invalid fields are dropped or
   * repaired instead of failing the whole report, and every change is reported.
   */
  function validate(raw, catalog) {
    var errors = [], warnings = [], s = JSON.parse(JSON.stringify(raw || {}));
    s.title = s.title || "Untitled report";
    if (s.date_range && s.date_range.preset && PRESETS.indexOf(s.date_range.preset) < 0) { warnings.push("Unknown date preset '" + s.date_range.preset + "', using last_30_days"); s.date_range = { preset: "last_30_days" }; }
    s.date_range = s.date_range || { preset: "last_30_days" };
    if (COMPARES.indexOf(s.compare || null) < 0) { warnings.push("Unknown compare mode, comparison turned off"); s.compare = null; }
    s.compare = s.compare || null;

    function view(name, where) { var v = catalog[name]; if (!v) errors.push(where + ": metrics view '" + name + "' does not exist"); return v; }
    function hasM(v, m) { return v && v.measures.some(function (x) { return x.name === m; }); }
    function hasD(v, dd) { return dd === "__time" || (v && v.dimensions.some(function (x) { return x.name === dd; })); }

    s.filters = (s.filters || []).filter(function (fl) {
      var ok = fl && fl.dimension && Array.isArray(fl.values) && fl.values.length;
      if (!ok) warnings.push("Dropped an incomplete filter");
      fl.op = fl.op === "not_in" ? "not_in" : "in";
      return ok;
    });

    s.blocks = (s.blocks || []).filter(function (b, i) {
      var where = "block " + (i + 1) + " (" + b.type + ")";
      if (b.type === "kpi") {
        var v = view(b.view, where); if (!v) return false;
        b.measures = (b.measures || []).filter(function (m) { if (!hasM(v, m)) { warnings.push(where + ": dropped unknown measure '" + m + "'"); return false; } return true; });
        return b.measures.length > 0;
      }
      if (b.type === "chart") {
        var cv = view(b.view, where); if (!cv) return false;
        if (!hasM(cv, b.measure)) { errors.push(where + ": unknown measure '" + b.measure + "'"); return false; }
        b.dimension = b.dimension || "__time";
        if (!hasD(cv, b.dimension)) { errors.push(where + ": unknown dimension '" + b.dimension + "'"); return false; }
        b.chart = ["line", "bar", "pie"].indexOf(b.chart) >= 0 ? b.chart : (b.dimension === "__time" ? "line" : "bar");
        if (b.dimension === "__time" && b.chart === "pie") { b.chart = "line"; warnings.push(where + ": a pie can't show a trend, switched to line"); }
        b.grain = ["day", "week", "month"].indexOf(b.grain) >= 0 ? b.grain : "day";
        b.limit = b.dimension === "__time" ? null : Math.min(b.limit || 10, 25);
        return true;
      }
      if (b.type === "table") {
        var tv = view(b.view, where); if (!tv) return false;
        b.dimensions = (b.dimensions || []).filter(function (x) { return hasD(tv, x) && x !== "__time"; });
        b.measures = (b.measures || []).filter(function (m) { return hasM(tv, m); });
        if (!b.measures.length) { errors.push(where + ": table needs at least one valid measure"); return false; }
        b.sort = b.sort && (b.measures.indexOf(b.sort.by) >= 0 || b.dimensions.indexOf(b.sort.by) >= 0) ? b.sort : { by: b.measures[0], desc: true };
        b.limit = Math.min(b.limit || 50, 500);
        return true;
      }
      if (b.type === "join") {
        var lv = view(b.left && b.left.view, where + " left"), rv = view(b.right && b.right.view, where + " right");
        if (!lv || !rv) return false;
        b.on = (b.on || []).filter(function (k) { return hasD(lv, k) && hasD(rv, k); });
        if (!b.on.length) { errors.push(where + ": no shared dimension to join on"); return false; }
        b.left.dimensions = b.on.slice(); b.right.dimensions = b.on.slice();
        b.left.measures = (b.left.measures || []).filter(function (m) { return hasM(lv, m); });
        b.right.measures = (b.right.measures || []).filter(function (m) { return hasM(rv, m); });
        b.calc = (b.calc || []).filter(function (c) { return c.name && /^[\w\s+\-*/().]+$/.test(c.expr || ""); });
        b.limit = Math.min(b.limit || 20, 200);
        return true;
      }
      warnings.push("Dropped unsupported block type '" + b.type + "'");
      return false;
    });
    if (!s.blocks.length && !errors.length) errors.push("The plan has no blocks the data can answer");
    return { spec: s, errors: errors, warnings: warnings };
  }

  AS.spec = { validate: validate, resolveRange: resolveRange, compareRange: compareRange, PRESETS: PRESETS };
})(window.AS = window.AS || {});
