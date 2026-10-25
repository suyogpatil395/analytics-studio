/**
 * app.js
 * ------------------------------------------------------------------
 * The Studio UI: pinned filter bar, requirement box, live preview,
 * file export, scheduling, dashboards, prompt history and the assistant.
 *
 * Pipeline for every request:
 *   request ─▶ token rules (local edit? cached plan?) ─▶ planner (AI)
 *           ─▶ validate against catalog ─▶ merge pinned filters
 *           ─▶ execute queries ─▶ insights ─▶ render
 */
(function (AS) {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var TODAY = AS.semantic.DATA_END, CATALOG_VERSION = "v1", catalog = {}, current = null, lastRun = null, lastTrace = [], fileType = "csv";
  var DATE_WORDS = /yesterday|today|last 7 days|last week|this week|last 14 days|last 30 days|this month|last month|last 90 days|quarter/i;
  var COMPARE_WORDS = /\bvs\b|versus|compare|growth|change|wow|mom|yoy/i;

  // ---------- small helpers ----------
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem("as-" + k) || "null"); localStorage.setItem("as-" + k, JSON.stringify(v)); } catch (e) { return null; } }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(t) { var el = $("toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove("on"); }, 1800); }
  function opts(sel, label, values) { sel.innerHTML = '<option value="">All ' + label + "</option>" + values.sort().map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + "</option>"; }).join(""); }
  function download(name, text, type) { var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

  // ---------- pinned filter bar ----------
  var BRANCHES_BY_REST = {};
  function initFilters() {
    AS.semantic.dimensionValues("orders", "branch").forEach(function (b) { });
    var rows = AS.semantic.queryMetricsView({ metrics_view: "orders", dimensions: [{ name: "restaurant" }, { name: "branch" }], measures: [{ name: "orders" }] }).rows;
    rows.forEach(function (r) { (BRANCHES_BY_REST[r.restaurant] = BRANCHES_BY_REST[r.restaurant] || []).push(r.branch); });
    opts($("fRestaurant"), "restaurants", Object.keys(BRANCHES_BY_REST));
    opts($("fBranch"), "branches", AS.semantic.dimensionValues("orders", "branch"));
    opts($("fChannel"), "channels", AS.semantic.dimensionValues("orders", "channel"));
    $("fRestaurant").onchange = function () { var r = this.value; opts($("fBranch"), "branches", r ? BRANCHES_BY_REST[r].slice() : AS.semantic.dimensionValues("orders", "branch")); rerun(); };
    ["fBranch", "fChannel", "fDate"].forEach(function (id) { $(id).onchange = rerun; });
  }
  function pinned() {
    var f = [];
    [["fRestaurant", "restaurant"], ["fBranch", "branch"], ["fChannel", "channel"]].forEach(function (p) { if ($(p[0]).value) f.push({ dimension: p[1], op: "in", values: [$(p[0]).value], pinned: true }); });
    return f;
  }
  function applyPinned(spec) {
    var pins = pinned(), dims = pins.map(function (p) { return p.dimension; });
    spec.filters = (spec.filters || []).filter(function (f) { return !f.pinned && dims.indexOf(f.dimension) < 0; }).concat(pins);
    spec.date_range = { preset: $("fDate").value };
    spec.compare = $("compare").value || null;
    return spec;
  }
  function syncBarFrom(spec, text) {
    // dates / compare / bar filters mentioned in the prompt move into the pinned controls
    if (text && DATE_WORDS.test(text) && spec.date_range && spec.date_range.preset) { var o = $("fDate").querySelector('option[value="' + spec.date_range.preset + '"]'); if (o) $("fDate").value = spec.date_range.preset; }
    if (text && COMPARE_WORDS.test(text)) $("compare").value = spec.compare || "";
    spec.filters = (spec.filters || []).filter(function (f) {
      var id = { restaurant: "fRestaurant", branch: "fBranch", channel: "fChannel" }[f.dimension];
      if (id && f.values.length === 1 && $(id).querySelector('option[value="' + f.values[0] + '"]')) { $(id).value = f.values[0]; return false; }
      return true;
    });
  }

  // ---------- build ----------
  function step(n, name, detail, ms) { return '<div class="step"><b>' + n + "</b><div><div>" + name + '</div><div class="t">' + detail + '</div></div><span class="t">' + (ms != null ? ms + " ms" : "") + "</span></div>"; }

  async function build(text) {
    text = (text || "").trim(); if (!text) { toast("Describe the report first"); return null; }
    var t0 = performance.now(), how, raw;
    var local = AS.tokens.localEdit(text, current), cached = !local && AS.tokens.getCached(text, CATALOG_VERSION);
    if (local) { raw = local; how = "Local edit, no AI call"; }
    else if (cached) { raw = JSON.parse(JSON.stringify(cached)); how = "Cached plan, no AI call"; }
    else { var p = await AS.planner.plan(text, catalog, null); raw = p.spec; how = p.source === "llm" ? "AI planner" : "Offline planner (demo mode)"; AS.tokens.stats.aiCalls++; AS.tokens.putCached(text, CATALOG_VERSION, raw); }
    var t1 = performance.now();
    var v = AS.spec.validate(raw, catalog), t2 = performance.now();
    lastTrace = [step(1, "Plan", how, Math.round(t1 - t0)),
      step(2, "Validate against semantic layer", v.errors.length ? v.errors.length + " error(s)" : v.warnings.length ? v.warnings.length + " repair(s)" : "All fields exist", Math.round(t2 - t1))];
    if (!v.spec.blocks.length) { $("preview").innerHTML = '<div class="warn">' + esc(v.errors.concat(v.warnings).join(" · ") || "Nothing to show") + "</div>"; return null; }
    if (!local) syncBarFrom(v.spec, text);
    current = v.spec; current._warnings = v.errors.concat(v.warnings);
    pushHistory(text);
    await runSpec(how);
    return { how: how, spec: current };
  }

  async function runSpec(how) {
    if (!current) return;
    applyPinned(current);
    var t2 = performance.now(), run = await AS.engine.execute(current, catalog, TODAY), t3 = performance.now(); lastRun = run;
    var ins = AS.insights.generate(current, run, catalog, AS.render.fmt), t4 = performance.now();
    var trace = (how ? lastTrace : lastTrace.slice(0, 1).map(function () { return step(1, "Plan", "Re-run of saved spec, no AI call", 0); }))
      .concat([step(3, "Query metrics views", run.queries + " queries · " + AS.data.stats.cacheHits + " cache hits this session", Math.round(t3 - t2)),
        step(4, "Insights + render", ins.length + " insights · " + current.blocks.length + " blocks", Math.round(t4 - t3)),
        step("∑", "AI usage this session", AS.tokens.stats.aiCalls + " planner calls · " + AS.tokens.stats.localEdits + " local edits · " + AS.tokens.stats.cacheHits + " cached plans", null)]);
    var filters = current.filters.map(function (f, i) { return '<span class="pill">' + esc(f.dimension.replace("_", " ")) + ": " + esc(f.values.join(", ")) + (f.pinned ? "" : '<button type="button" data-rm="' + i + '" aria-label="Remove">×</button>') + "</span>"; }).join("");
    var cleanSpec = JSON.parse(JSON.stringify(current)); delete cleanSpec._warnings;
    $("preview").innerHTML =
      '<div class="rtitle"><h3>' + esc(current.title) + "</h3><span>" + run.range.start + " → " + run.range.end + " (end excluded)" + (run.compareRange ? " · vs " + run.compareRange.start + " → " + run.compareRange.end : "") + "</span></div>" +
      (filters ? '<div class="active">' + filters + "</div>" : "") +
      (current._warnings || []).map(function (w) { return '<div class="warn">' + esc(w) + "</div>"; }).join("") +
      (ins.length ? '<div class="ins"><b>What changed</b><ul>' + ins.map(function (i) { return '<li class="' + i.tone + '">' + esc(i.text) + "</li>"; }).join("") + "</ul></div>" : "") +
      '<div id="report"></div>' +
      '<div class="pv-tools"><button class="btn" type="button" id="toDash">＋ Add to dashboard</button><button class="btn" type="button" id="toSched">🗓 Schedule</button><button class="btn" type="button" id="toFile">⬇ Export</button></div>' +
      '<details class="how"><summary>How this report was built (pipeline, report spec, planner prompt)</summary><div class="steps">' + trace.join("") + '</div><b style="font-size:13px">Report spec (the only thing the AI produces)</b><pre class="spec">' + esc(JSON.stringify(cleanSpec, null, 2)) +
      '</pre><b style="font-size:13px">Planner prompt (catalog only, never data)</b><pre class="spec">' + esc(AS.planner.buildPrompt(catalog, "<your request>")) + "</pre></details>";
    AS.render.report($("report"), current, run, catalog);
    layout();
    $("toDash").onclick = saveDashboard; $("toSched").onclick = function () { $("c4").scrollIntoView({ behavior: "smooth" }); };
    $("toFile").onclick = function () { $("c3").scrollIntoView({ behavior: "smooth" }); };
    $("preview").querySelectorAll("[data-rm]").forEach(function (b) { b.onclick = function () { current.filters.splice(+b.dataset.rm, 1); runSpec(); }; });
    $("download").disabled = false;
    $("sReports").innerHTML = esc(current.title) + ' <span class="muted">(' + current.blocks.length + " blocks)</span>";
    planned();
  }
  function rerun() { if (current) runSpec(); }

  function layout() {
    var rep = $("report"), grid = null;
    [].slice.call(rep.children).forEach(function (el) {
      var b = current.blocks[+el.dataset.i];
      if (b.type === "chart" && b.dimension !== "__time") { if (!grid) { grid = document.createElement("div"); grid.className = "grid2"; rep.insertBefore(grid, el); } grid.appendChild(el); }
      else grid = null;
    });
    rep.style.cssText = "display:flex;flex-direction:column;gap:14px";
  }

  // ---------- drill-down & block CSV ----------
  document.addEventListener("click", function (e) {
    var d = e.target.closest("[data-drill]");
    if (d && current) {
      var dim = d.dataset.drill, val = d.dataset.val, id = { restaurant: "fRestaurant", branch: "fBranch", channel: "fChannel" }[dim];
      if (id) { if (id === "fRestaurant") $("fRestaurant").onchange.call({ value: val }); $(id).value = val; }
      else current.filters = current.filters.filter(function (f) { return f.dimension !== dim; }).concat([{ dimension: dim, op: "in", values: [val] }]);
      toast("Drilled into " + val + " (no AI call)"); runSpec(); return;
    }
    var c = e.target.closest(".csv");
    if (c && lastRun) { var i = +c.closest(".blk").dataset.i; download(slug() + "_" + (i + 1) + ".csv", AS.render.toCSV(lastRun.results[i].rows), "text/csv"); }
  });
  function slug() { return (current && current.title || "report").replace(/\W+/g, "_"); }

  // ---------- file types ----------
  var TYPES = [["excel", "Excel", ".xls, one table per report"], ["csv", "CSV", ".csv, all reports in one file"], ["powerbi", "Power BI", ".xlsx data, ready for Get Data"],
    ["pdf", "PDF", ".pdf with charts and tables"], ["html", "Web page", ".html with charts"], ["json", "JSON", ".json for systems"]];
  function initTypes() {
    $("types").innerHTML = TYPES.map(function (t) { return '<button type="button" class="type' + (t[0] === fileType ? " on" : "") + '" data-t="' + t[0] + '"><b>' + t[1] + "</b><small>" + t[2] + "</small></button>"; }).join("");
    $("types").querySelectorAll(".type").forEach(function (b) { b.onclick = function () { fileType = b.dataset.t; initTypes(); }; });
  }
  $("download").onclick = function () {
    if (!lastRun) return;
    var blocks = current.blocks.map(function (b, i) { return { title: b.title || b.type + " " + (i + 1), rows: lastRun.results[i].rows || [lastRun.results[i].values] }; });
    if (fileType === "csv") download(slug() + ".csv", blocks.map(function (b) { return "# " + b.title + "\n" + AS.render.toCSV(b.rows); }).join("\n\n"), "text/csv");
    else if (fileType === "json") download(slug() + ".json", JSON.stringify({ spec: current, range: lastRun.range, blocks: blocks }, null, 2), "application/json");
    else if (fileType === "excel") download(slug() + ".xls", "<html><meta charset='utf-8'><body>" + blocks.map(function (b) { var r = b.rows.filter(Boolean); if (!r.length) return ""; var cols = Object.keys(r[0]).filter(function (k) { return k !== "__k"; }); return "<h3>" + esc(b.title) + "</h3><table border='1'><tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>" + r.map(function (x) { return "<tr>" + cols.map(function (c) { return "<td>" + esc(x[c] == null ? "" : x[c]) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table>"; }).join("") + "</body></html>", "application/vnd.ms-excel");
    else if (fileType === "html") download(slug() + ".html", "<!doctype html><meta charset='utf-8'><title>" + esc(current.title) + "</title><style>" + document.querySelector("style").textContent + "</style><body style='padding:24px'>" + $("preview").innerHTML.replace(/<details[\s\S]*<\/details>/, "") + "</body>", "text/html");
    else toast("PDF and Power BI exports are part of the production build");
  };

  // ---------- schedule ----------
  var repeat = "Once";
  $("sRepeat").querySelectorAll("button").forEach(function (b) { b.onclick = function () { $("sRepeat").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); }); repeat = b.textContent; planned(); }; });
  ["sTime", "sTz", "sAs", "sDates"].forEach(function (id) { $(id).onchange = planned; });
  function planned() { $("planned").textContent = current ? "Planned: " + repeat.toLowerCase() + " at " + $("sTime").value + " " + $("sTz").value.split(" ")[0] + " · " + $("sAs").value : ""; }
  $("saveSched").onclick = function () {
    if (!current) { toast("Build a preview first"); return; }
    var list = store("schedules") || [];
    list.unshift({ title: current.title, repeat: repeat, time: $("sTime").value, tz: $("sTz").value, as: $("sAs").value, to: $("sTo").value, spec: current, saved: new Date().toISOString().slice(0, 16).replace("T", " ") });
    store("schedules", list.slice(0, 20)); paintSaved(); toast("Schedule saved");
  };
  function paintSaved() {
    var list = store("schedules") || [], el = $("savedList");
    el.hidden = !list.length;
    el.innerHTML = "<b style='font-size:13px'>Saved schedules</b>" + list.map(function (s, i) { return '<div class="it"><span>' + esc(s.title) + ' · <span class="muted">' + esc(s.repeat + " " + s.time + " · " + s.as) + '</span></span><button class="btn" type="button" data-del="' + i + '">Remove</button></div>'; }).join("");
    el.querySelectorAll("[data-del]").forEach(function (b) { b.onclick = function () { var l = store("schedules") || []; l.splice(+b.dataset.del, 1); store("schedules", l); paintSaved(); }; });
  }

  // ---------- dashboards, history, drawer ----------
  function saveDashboard() {
    if (!current) { toast("Build a preview first"); return; }
    var d = store("dashboards") || []; d.unshift({ title: current.title, spec: current }); store("dashboards", d.slice(0, 30)); toast("Added to dashboard"); paintDrawer();
  }
  function pushHistory(t) { var h = store("history") || []; h = [t].concat(h.filter(function (x) { return x !== t; })).slice(0, 15); store("history", h); }
  function paintDrawer() {
    var d = store("dashboards") || [], s = store("schedules") || [], h = store("history") || [];
    $("dList").innerHTML = d.length ? d.map(function (x, i) { return '<div class="it"><span>' + esc(x.title) + '</span><button type="button" data-open="' + i + '">Open</button></div>'; }).join("") : '<div class="muted">No saved reports yet.</div>';
    $("schList").innerHTML = s.length ? s.map(function (x) { return '<div class="it"><span>' + esc(x.title) + '</span><span class="muted">' + esc(x.repeat + " " + x.time) + "</span></div>"; }).join("") : '<div class="muted">None.</div>';
    $("hList").innerHTML = h.length ? h.map(function (x, i) { return '<div class="it"><span>' + esc(x) + '</span><button type="button" data-hist="' + i + '">Use</button></div>'; }).join("") : '<div class="muted">Empty.</div>';
    $("dList").querySelectorAll("[data-open]").forEach(function (b) { b.onclick = function () { current = JSON.parse(JSON.stringify(d[+b.dataset.open].spec)); $("drawer").hidden = true; runSpec(); toast("Opened from dashboard (no AI call)"); }; });
    $("hList").querySelectorAll("[data-hist]").forEach(function (b) { b.onclick = function () { $("prompt").value = h[+b.dataset.hist]; $("drawer").hidden = true; current = null; build($("prompt").value); }; });
  }
  $("menuBtn").onclick = function () { paintDrawer(); $("drawer").hidden = false; };
  $("closeDrawer").onclick = function () { $("drawer").hidden = true; };
  $("histBtn").onclick = function () { paintDrawer(); $("drawer").hidden = false; };
  $("saveDash").onclick = saveDashboard;

  // ---------- assistant ----------
  $("fab").onclick = function () { $("chat").hidden = !$("chat").hidden; if (!$("chat").hidden) $("chatIn").focus(); };
  $("closeChat").onclick = function () { $("chat").hidden = true; };
  function say(t, who) { var m = document.createElement("div"); m.className = "bub " + who; m.textContent = t; $("msgs").appendChild(m); $("msgs").scrollTop = 1e6; }
  $("chatForm").onsubmit = async function (e) {
    e.preventDefault(); var t = $("chatIn").value.trim(); if (!t) return; $("chatIn").value = ""; say(t, "me");
    if (/save|dashboard/i.test(t) && current) { saveDashboard(); say("Saved “" + current.title + "” to your dashboards.", "bot"); return; }
    if (/schedule|send every|every (day|monday|week)/i.test(t)) { $("c4").scrollIntoView({ behavior: "smooth" }); say("Opened Schedule and send. Pick the delivery and time, then Save schedule.", "bot"); return; }
    var r = await build(t);
    say(r ? "Built “" + r.spec.title + "” with " + r.spec.blocks.length + " blocks (" + r.how.toLowerCase() + ")." : "I couldn't build that from the available data. Try naming a measure like revenue, orders or items.", "bot");
    $("c2").scrollIntoView({ behavior: "smooth" });
  };

  // ---------- requirement box ----------
  var EXAMPLES = ["Branch-wise sales", "Daily sales trend", "Top 10 selling items", "Sales by channel vs previous period", "Payment method split pie", "Orders by hour of day", "Profit by product"];
  $("examples").innerHTML = EXAMPLES.map(function (t) { return '<button type="button" class="chip">' + t + "</button>"; }).join("");
  $("examples").querySelectorAll(".chip").forEach(function (b) { b.onclick = function () { $("prompt").value = b.textContent; current = null; build(b.textContent); }; });
  $("go").onclick = function () { build($("prompt").value); };
  $("prompt").addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") $("go").click(); });
  $("file").onchange = function () { var f = this.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { $("prompt").value = String(r.result).slice(0, 2000); toast("Loaded " + f.name); }; r.readAsText(f); };
  $("compare").onchange = rerun;
  $("theme").onchange = function () { $("preview").className = this.value ? "t-" + this.value : ""; };
  $("themeBtn").onclick = function () { var d = document.documentElement; d.dataset.theme = d.dataset.theme === "dark" ? "" : "dark"; store("theme", d.dataset.theme); };
  $("refresh").onclick = function () { rerun(); toast("Refreshed"); };
  if (store("theme") === "dark") document.documentElement.dataset.theme = "dark";

  // ---------- boot ----------
  (async function () {
    var views = await AS.data.listViews();
    for (var i = 0; i < views.length; i++) catalog[views[i].name] = await AS.data.describe(views[i].name);
    initFilters(); initTypes(); paintSaved();
    $("prompt").value = "Sales by channel vs previous period";
    build($("prompt").value);
  })();
  AS.app = { build: build, catalog: catalog };
})(window.AS = window.AS || {});
