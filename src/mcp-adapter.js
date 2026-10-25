/**
 * mcp-adapter.js
 * ------------------------------------------------------------------
 * The ONLY place the Studio touches data. Everything else calls
 * AS.data.query(...) and never knows where the numbers come from.
 *
 * Two backends:
 *   1. "demo"  -> the in-browser synthetic semantic layer (semantic-layer.js)
 *   2. "mcp"   -> a real semantic layer exposed as MCP tools, e.g.
 *                 list_metrics_views / get_metrics_view / query_metrics_view.
 *                 The host app provides `callTool(name, args)`; the user's own
 *                 login is used, so row-level security is enforced at the source.
 *
 * Results are cached per (tool, args) for the session so re-renders,
 * theme changes and drill-down "back" never re-query.
 */
(function (AS) {
  "use strict";
  var backend = "demo", callTool = null, cache = new Map(), stats = { queries: 0, cacheHits: 0 };

  function useMcp(fn) { backend = "mcp"; callTool = fn; cache.clear(); }
  function useDemo() { backend = "demo"; callTool = null; cache.clear(); }

  function key(tool, args) { return tool + ":" + JSON.stringify(args); }

  async function run(tool, args) {
    var k = key(tool, args);
    if (cache.has(k)) { stats.cacheHits++; return cache.get(k); }
    stats.queries++;
    var res;
    if (backend === "demo") {
      if (tool === "list_metrics_views") res = AS.semantic.listMetricsViews();
      else if (tool === "get_metrics_view") res = AS.semantic.getMetricsView(args.metrics_view);
      else if (tool === "query_metrics_view") res = AS.semantic.queryMetricsView(args);
      else throw new Error("Unknown tool " + tool);
    } else {
      // Real MCP: tool results arrive as JSON text content.
      var raw = await callTool(tool, args);
      res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (tool === "query_metrics_view" && Array.isArray(res.data)) res = { rows: res.data, meta: res.meta || {} };
    }
    cache.set(k, res);
    return res;
  }

  AS.data = {
    useMcp: useMcp, useDemo: useDemo, stats: stats,
    listViews: function () { return run("list_metrics_views", {}); },
    describe: function (view) { return run("get_metrics_view", { metrics_view: view }); },
    query: function (args) { return run("query_metrics_view", args); },
    backend: function () { return backend; }
  };
})(window.AS = window.AS || {});
