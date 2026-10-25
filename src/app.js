/**
 * app.js
 * ------------------------------------------------------------------
 * Wires the pipeline together and shows each step, so you can see exactly
 * what happens between a sentence and a finished report:
 *
 *   request ─▶ token rules (local edit? cached plan?) ─▶ planner (AI)
 *          ─▶ validate against catalog ─▶ execute queries ─▶ insights ─▶ render
 */
(function (AS) {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var TODAY = AS.semantic.DATA_END, CATALOG_VERSION = "v1", catalog = {}, current = null, lastRun = null;

  var EXAMPLES = ["Revenue by channel for the last 30 days vs previous period", "Daily sales trend this month", "Top 10 selling items last month",
    "Orders by hour of day", "Profit by product", "Branch-wise revenue table last 7 days compare", "Swiggy revenue by branch", "Payment method split pie"];
  var EDITS = ["make it a pie", "top 5", "last 7 days", "compare", "only Zomato", "clear filters"];

  function chips(el, list, fn) { el.innerHTML = list.map(function (t) { return '<button type="button" class="chip">' + t + "</button>"; }).join(""); el.querySelectorAll(".chip").forEach(function (b, i) { b.onclick = function () { fn(list[i]); }; }); }
  function toast(t) { var el = $("toast"); el.textContent = t; el.classList.add("on"); setTimeout(function () { el.classList.remove("on"); }, 1800); }
  function step(n, name, detail, ms) { return '<div class="step"><b>' + n + "</b><div><div>" + name + '</div><div class="t">' + detail + "</div></div><span class=\"t\">" + (ms != null ? ms + " ms" : "") + "</span></div>"; }

  async function loadCatalog() {
    var views = await AS.data.listViews();
    for (var i = 0; i < views.length; i++) catalog[views[i].name] = await AS.data.describe(views[i].name);
    $("promptText").textContent = AS.planner.buildPrompt(catalog, "<user request>");
  }

  async function build(text, opts) {
    opts = opts || {};
    var t0 = performance.now(), how, raw, trace = [];
    // 1. token rules
    var local = !opts.forceNew && AS.tokens.localEdit(text, current), cached = !local && AS.tokens.getCached(text, CATALOG_VERSION);
    if (local) { raw = local; how = "Local edit, no AI call"; }
    else if (cached) { raw = cached; how = "Cached plan, no AI call"; }
    else { var p = await AS.planner.plan(text, catalog, null); raw = p.spec; how = p.source === "llm" ? "AI planner" : "Offline planner (demo mode)"; AS.tokens.stats.aiCalls++; AS.tokens.putCached(text, CATALOG_VERSION, raw); }
    var t1 = performance.now(); trace.push(step(1, "Plan", how, Math.round(t1 - t0)));
    // 2. validate
    var v = AS.spec.validate(raw, catalog), t2 = performance.now();
    trace.push(step(2, "Validate against semantic layer", v.errors.length ? v.errors.length + " error(s)" : v.warnings.length ? v.warnings.length + " repair(s)" : "All fields exist", Math.round(t2 - t1)));
    $("warn").innerHTML = v.errors.concat(v.warnings).map(function (w) { return '<div class="warn">' + w + "</div>"; }).join("");
    if (v.errors.length && !v.spec.blocks.length) { $("steps").innerHTML = trace.join(""); return; }
    current = v.spec; $("spec").textContent = JSON.stringify(current, null, 2);
    // 3. execute
    var run = await AS.engine.execute(current, catalog, TODAY), t3 = performance.now(); lastRun = run;
    trace.push(step(3, "Query metrics views", run.queries + " queries · " + AS.data.stats.cacheHits + " cache hits (session)", Math.round(t3 - t2)));
    // 4. insights + render
    var ins = AS.insights.generate(current, run, catalog, AS.render.fmt);
    $("insights").hidden = !ins.length; $("insights").querySelector("ul").innerHTML = ins.map(function (i) { return '<li class="' + i.tone + '">' + i.text + "</li>"; }).join("");
    $("title").textContent = current.title;
    $("range").textContent = run.range.start + " → " + run.range.end + " (exclusive)" + (run.compareRange ? " · vs " + run.compareRange.start + " → " + run.compareRange.end : "");
    AS.render.report($("report"), current, run, catalog);
    layout();
    var t4 = performance.now(); trace.push(step(4, "Insights + render", ins.length + " insights · " + current.blocks.length + " blocks", Math.round(t4 - t3)));
    trace.push(step("∑", "Token savings this session", AS.tokens.stats.aiCalls + " planner calls · " + AS.tokens.stats.localEdits + " local edits · " + AS.tokens.stats.cacheHits + " cached", null));
    $("steps").innerHTML = trace.join("");
    paintFilters();
  }

  // KPI blocks full width, charts side by side
  function layout() {
    var rep = $("report"), blocks = [].slice.call(rep.children), grid = null;
    blocks.forEach(function (el) {
      var b = current.blocks[+el.dataset.i];
      if (b.type === "chart" && b.dimension !== "__time") { if (!grid) { grid = document.createElement("div"); grid.className = "grid2"; rep.insertBefore(grid, el); } grid.appendChild(el); }
      else grid = null;
    });
  }

  function paintFilters() {
    var el = $("active"); if (!current || !current.filters.length) { el.innerHTML = '<span class="muted">None</span>'; return; }
    el.innerHTML = current.filters.map(function (f, i) { return '<span class="pill">' + f.dimension.replace("_", " ") + ": " + f.values.join(", ") + '<button type="button" data-rm="' + i + '" aria-label="Remove filter">×</button></span>'; }).join("");
    el.querySelectorAll("[data-rm]").forEach(function (b) { b.onclick = function () { current.filters.splice(+b.dataset.rm, 1); rerun(); }; });
  }
  async function rerun() { AS.tokens.putCached("__drill" + Math.random(), CATALOG_VERSION, current); await build("__noop__", { spec: current }); }

  // drill-down: click a bar / slice -> add filter, keep everything else (no AI)
  document.addEventListener("click", function (e) {
    var d = e.target.closest("[data-drill]");
    if (d && current) {
      var dim = d.dataset.drill, val = d.dataset.val;
      current.filters = current.filters.filter(function (f) { return f.dimension !== dim; }).concat([{ dimension: dim, op: "in", values: [val] }]);
      toast("Drilled into " + val); runSpec(current); return;
    }
    var c = e.target.closest(".csv");
    if (c) {
      var i = +c.closest(".blk").dataset.i, csv = AS.render.toCSV(lastRun.results[i].rows);
      var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = (current.title || "report").replace(/\W+/g, "_") + "_" + (i + 1) + ".csv"; a.click();
    }
  });
  async function runSpec(spec) {
    var v = AS.spec.validate(spec, catalog); current = v.spec; $("spec").textContent = JSON.stringify(current, null, 2);
    var run = await AS.engine.execute(current, catalog, TODAY); lastRun = run;
    var ins = AS.insights.generate(current, run, catalog, AS.render.fmt);
    $("insights").hidden = !ins.length; $("insights").querySelector("ul").innerHTML = ins.map(function (i) { return '<li class="' + i.tone + '">' + i.text + "</li>"; }).join("");
    AS.render.report($("report"), current, run, catalog); layout(); paintFilters();
  }
  rerun = function () { return runSpec(current); };

  $("go").onclick = function () { build($("prompt").value, { forceNew: false }); };
  $("prompt").addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") $("go").click(); });
  chips($("examples"), EXAMPLES, function (t) { $("prompt").value = t; current = null; build(t); });
  chips($("edits"), EDITS, function (t) { $("prompt").value = t; build(t); });

  loadCatalog().then(function () { build($("prompt").value); });
  AS.app = { build: build, catalog: catalog };
})(window.AS = window.AS || {});
