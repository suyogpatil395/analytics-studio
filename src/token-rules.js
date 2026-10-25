/**
 * token-rules.js
 * ------------------------------------------------------------------
 * AI calls cost money and time. Most follow-up requests are small edits
 * ("make it a pie", "top 5", "only Swiggy", "last month") that do not need
 * a model at all. These rules apply such edits directly to the current spec.
 *
 *   localEdit(text, spec)  -> new spec, or null if the AI is really needed
 *   planCache              -> identical requests reuse the previous plan
 *
 * In production this cut planner calls sharply: the model is only used for
 * genuinely new reports or ambiguous requests.
 */
(function (AS) {
  "use strict";
  var stats = { localEdits: 0, cacheHits: 0, aiCalls: 0 };
  var planCache = new Map();
  function norm(t) { return t.toLowerCase().replace(/\s+/g, " ").trim(); }

  function localEdit(text, spec) {
    if (!spec) return null;
    var q = norm(text), s = JSON.parse(JSON.stringify(spec)), changed = false;
    // Only treat the text as an edit if, after removing known edit phrases,
    // almost nothing is left. "Daily sales trend this month" is a NEW report,
    // "this month" alone is an edit.
    var rest = q.replace(/\b(make|it|a|an|the|to|as|into|chart|change|show|switch|please|and|vs|previous|period|year|instead)\b/g, " ")
      .replace(/\b(pie|bar|line)\b|top \d+|yesterday|today|last (7|30|90) days|last week|this month|last month|compar\w*|no compar\w*|remove compar\w*|without compar\w*|clear filters|remove filters|all channels|all branches|^(only|just|filter) .+$/g, " ")
      .trim();
    if (rest.split(/\s+/).filter(Boolean).length > 0) return null;
    var charts = s.blocks.filter(function (b) { return b.type === "chart"; });
    var m;
    if ((m = q.match(/\b(pie|bar|line)\b/)) && charts.length) {
      var target = charts.filter(function (b) { return m[1] !== "pie" || b.dimension !== "__time"; })[0];
      if (target) { target.chart = m[1]; changed = true; }
    }
    if ((m = q.match(/top (\d+)/))) { s.blocks.forEach(function (b) { if (b.type !== "kpi" && !(b.type === "chart" && b.dimension === "__time")) b.limit = +m[1]; }); changed = true; }
    var presets = [["yesterday", "yesterday"], ["today", "today"], ["last 7 days", "last_7_days"], ["last week", "last_7_days"], ["this month", "this_month"], ["last month", "last_month"], ["last 30 days", "last_30_days"], ["last 90 days", "last_90_days"]];
    presets.forEach(function (p) { if (q.indexOf(p[0]) >= 0 && !/vs|compare/.test(q)) { s.date_range = { preset: p[1] }; changed = true; } });
    if (/compare|vs previous|vs last/.test(q)) { s.compare = /year/.test(q) ? "previous_year" : "previous_period"; changed = true; }
    if (/no compar|remove compar|without compar/.test(q)) { s.compare = null; changed = true; }
    if ((m = q.match(/^(only|just|filter) (.+)$/))) {
      var val = m[2], hit = null;
      ["channel", "branch", "restaurant", "city", "payment_method"].forEach(function (dim) {
        AS.semantic.dimensionValues("orders", dim).forEach(function (v) { if (!hit && v.toLowerCase() === val) hit = { dimension: dim, op: "in", values: [v] }; });
      });
      if (hit) { s.filters = s.filters.filter(function (f) { return f.dimension !== hit.dimension; }).concat([hit]); changed = true; }
    }
    if (/clear filters|remove filters|all channels|all branches/.test(q)) { s.filters = []; changed = true; }
    if (changed) stats.localEdits++;
    return changed ? s : null;
  }

  function cacheKey(text, catalogVersion) { return catalogVersion + "::" + norm(text); }
  function getCached(text, v) { var k = cacheKey(text, v); if (planCache.has(k)) { stats.cacheHits++; return planCache.get(k); } return null; }
  function putCached(text, v, spec) { planCache.set(cacheKey(text, v), spec); }

  AS.tokens = { localEdit: localEdit, getCached: getCached, putCached: putCached, stats: stats };
})(window.AS = window.AS || {});
