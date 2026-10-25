/**
 * planner.js
 * ------------------------------------------------------------------
 * Turns a plain-language request into a REPORT SPEC (see spec.js).
 *
 * Production path (LLM):
 *   1. buildCatalog()      -> compact text description of every metrics view
 *   2. buildPrompt()       -> system rules + catalog + user request
 *   3. llm(prompt)         -> JSON only
 *   4. parse + validate    -> spec.js repairs or rejects invalid fields
 *
 * Demo path (offline):
 *   offlinePlan() maps keywords to measures / dimensions / dates so the demo
 *   runs with no API key. Same output format, so the rest of the pipeline is
 *   identical.
 */
(function (AS) {
  "use strict";

  /** One line per field keeps the prompt small: names + short descriptions only, never data. */
  function catalogText(catalog) {
    return Object.keys(catalog).map(function (name) {
      var v = catalog[name];
      return "VIEW " + name + ": " + v.description + "\n  measures: " + v.measures.map(function (m) { return m.name + " (" + m.description + ")"; }).join("; ") +
        "\n  dimensions: " + v.dimensions.map(function (d) { return d.name; }).join(", ");
    }).join("\n");
  }

  function buildPrompt(catalog, request, current) {
    return [
      "You are a report planner for a restaurant analytics app.",
      "Return ONLY a JSON report spec. Never write SQL. Never invent measures or dimensions.",
      "Use only the views, measures and dimensions listed below. If something is not available, leave it out and add a short 'note'.",
      "Block types: kpi, chart (line for trends over __time, bar for comparing categories, pie only for share of a few categories), table, join.",
      "Use a 'join' block only when the request needs measures from two views; join on shared dimensions and add calc fields like profit = revenue - cost.",
      "Prefer few, meaningful blocks: KPIs first, then 1-3 charts, then a table only if asked or useful for drill-down.",
      "Date presets: " + AS.spec.PRESETS.join(", ") + ". Compare: previous_period, previous_week, previous_year or null.",
      "",
      "CATALOG",
      catalogText(catalog),
      current ? "\nCURRENT REPORT (edit this instead of starting over):\n" + JSON.stringify(current) : "",
      "\nREQUEST\n" + request
    ].join("\n");
  }

  /** Extract the first JSON object from an LLM reply (handles ```json fences). */
  function parseReply(text) {
    var t = String(text).replace(/```json|```/g, "");
    var a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("The model did not return JSON");
    return JSON.parse(t.slice(a, b + 1));
  }

  // ---------------- offline planner (demo) ----------------
  var MEASURE_WORDS = [
    [/profit|margin|food cost|recipe cost/, "__profit"],
    [/revenue|sales|turnover|business/, "revenue"], [/\borders?\b|bills?|transactions/, "orders"], [/aov|average (order|bill|ticket)|avg (order|bill)/, "aov"],
    [/discount/, "discount"], [/customers?/, "customers"], [/cancel/, "cancel_rate"],
    [/items?|dish(es)?|products?|menu|qty|quantity|top selling|best selling/, "qty_sold"]
  ];
  var DIM_WORDS = [[/channel|aggregator|platform|source/, "channel"], [/branch(es)?|outlet|store|location/, "branch"], [/restaurant|brand/, "restaurant"], [/city|cities/, "city"],
    [/payment|upi|card|cash/, "payment_method"], [/hour|peak|time of day/, "hour"], [/weekday|day of week|day-wise/, "weekday"], [/categor/, "category"], [/product|item|dish/, "product"]];

  function offlinePlan(request, catalog) {
    var q = " " + request.toLowerCase() + " ", s = { title: "", date_range: { preset: "last_30_days" }, compare: null, filters: [], blocks: [] };
    // dates
    [["yesterday", "yesterday"], ["today", "today"], ["last 7 days", "last_7_days"], ["last week", "last_7_days"], ["this week", "last_7_days"], ["last 14 days", "last_14_days"],
      ["last 30 days", "last_30_days"], ["this month", "this_month"], ["last month", "last_month"], ["last 90 days", "last_90_days"], ["quarter", "last_90_days"]]
      .forEach(function (p) { if (q.indexOf(p[0]) >= 0) s.date_range = { preset: p[1] }; });
    // comparison
    if (/vs|versus|compare|compared|growth|change|wow|mom/.test(q)) s.compare = /last year|yoy/.test(q) ? "previous_year" : /last week|wow/.test(q) && s.date_range.preset !== "last_7_days" ? "previous_week" : "previous_period";
    // filters: any known dimension value mentioned in the text
    ["channel", "branch", "restaurant", "city", "payment_method"].forEach(function (dim) {
      var vals = AS.semantic.dimensionValues("orders", dim).filter(function (v) { return v && q.indexOf(" " + v.toLowerCase()) >= 0 && !new RegExp("by " + v.toLowerCase()).test(q); });
      if (vals.length) s.filters.push({ dimension: dim, op: "in", values: vals });
    });
    var measures = []; MEASURE_WORDS.forEach(function (m) { if (m[0].test(q) && measures.indexOf(m[1]) < 0) measures.push(m[1]); });
    var dims = []; DIM_WORDS.forEach(function (dw) { if (dw[0].test(q)) dims.push(dw[1]); });
    var wantsTrend = /trend|daily|day by day|over time|weekly|monthly|by day|by week|by month/.test(q);
    var grain = /monthly|by month/.test(q) ? "month" : /weekly|by week/.test(q) ? "week" : "day";
    var chartType = /pie|share|split|mix/.test(q) ? "pie" : /line/.test(q) ? "line" : "bar";
    var limit = (q.match(/top (\d+)/) || [])[1];

    if (measures.indexOf("__profit") >= 0) {
      var on = dims.indexOf("branch") >= 0 ? "branch" : dims.indexOf("category") >= 0 ? "category" : "product";
      s.title = "Profit by " + on;
      s.blocks.push({ type: "join", title: "Revenue vs food cost by " + on, left: { view: "item_sales", measures: ["item_revenue"] }, right: { view: "recipe_costs", measures: ["food_cost"] }, on: [on],
        calc: [{ name: "profit", label: "Profit", expr: "item_revenue - food_cost", format: "currency" }, { name: "margin", label: "Margin %", expr: "(item_revenue - food_cost) / item_revenue", format: "percent" }],
        sort: { by: "profit", desc: true }, limit: +limit || 15 });
      return s;
    }
    var itemMode = measures.indexOf("qty_sold") >= 0 && !measures.some(function (m) { return ["revenue", "orders", "aov"].indexOf(m) >= 0 && !/items? revenue/.test(q); });
    if (itemMode) {
      var idim = dims.indexOf("category") >= 0 ? "category" : "product";
      s.title = "Top selling " + (idim === "category" ? "categories" : "items");
      s.blocks.push({ type: "kpi", view: "item_sales", measures: ["qty_sold", "item_revenue"] });
      s.blocks.push({ type: "chart", view: "item_sales", chart: chartType === "pie" ? "pie" : "bar", measure: "qty_sold", dimension: idim, limit: +limit || 10 });
      s.blocks.push({ type: "table", view: "item_sales", dimensions: [idim], measures: ["qty_sold", "item_revenue"], sort: { by: "qty_sold", desc: true }, limit: +limit || 20 });
      return s;
    }
    measures = measures.filter(function (m) { return m !== "qty_sold"; });
    if (!measures.length) measures = ["revenue", "orders", "aov"];
    var main = measures[0], odims = dims.filter(function (x) { return ["category", "product"].indexOf(x) < 0; });
    s.title = (catalog.orders.measures.filter(function (m) { return m.name === main; })[0] || { label: "Sales" }).label + (odims.length ? " by " + odims.join(" & ").replace("_", " ") : " overview");
    s.blocks.push({ type: "kpi", view: "orders", measures: measures.length > 1 ? measures : [main, "orders", "aov"].filter(function (x, i, a) { return a.indexOf(x) === i; }) });
    if (wantsTrend || !odims.length) s.blocks.push({ type: "chart", view: "orders", chart: "line", measure: main, dimension: "__time", grain: grain });
    odims.forEach(function (dim) { s.blocks.push({ type: "chart", view: "orders", chart: dim === "hour" || dim === "weekday" ? "bar" : chartType, measure: main, dimension: dim, limit: +limit || 10 }); });
    if (odims.length || /table|list|breakdown|detail/.test(q))
      s.blocks.push({ type: "table", view: "orders", dimensions: odims.length ? odims.slice(0, 2) : ["branch"], measures: ["revenue", "orders", "aov"], sort: { by: main === "aov" ? "aov" : main, desc: true }, limit: +limit || 50 });
    return s;
  }

  /**
   * plan(request): uses the LLM if one is configured, otherwise the offline planner.
   * `llm` is any async function(prompt) -> string (Claude, OpenAI, a proxy…).
   */
  var llm = null;
  async function plan(request, catalog, current) {
    if (llm) return { spec: parseReply(await llm(buildPrompt(catalog, request, current))), source: "llm" };
    return { spec: offlinePlan(request, catalog), source: "offline" };
  }

  AS.planner = { plan: plan, buildPrompt: buildPrompt, catalogText: catalogText, parseReply: parseReply, offlinePlan: offlinePlan, setLLM: function (fn) { llm = fn; } };
})(window.AS = window.AS || {});
