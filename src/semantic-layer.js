/**
 * semantic-layer.js
 * ------------------------------------------------------------------
 * A tiny in-browser stand-in for a real semantic layer (e.g. Rill metrics
 * views served over MCP). It exposes the same three operations the Studio
 * relies on in production:
 *
 *   listMetricsViews()            -> [{ name, description }]
 *   getMetricsView(name)          -> { name, measures[], dimensions[], timeDimension }
 *   queryMetricsView(args)        -> { rows: [...], meta: {...} }
 *
 * The query arguments mirror a metrics-view query API:
 *   { metrics_view, measures:[{name}], dimensions:[{name}],
 *     time_range:{start,end}, where:[{dimension,op,values}],
 *     sort:[{name,desc}], limit, time_grain }
 *
 * The data is synthetic: two fictional restaurant brands, five branches.
 * Swap this file for an MCP adapter (see mcp-adapter.js) to run on real data.
 */
(function (AS) {
  "use strict";

  // ---------- deterministic synthetic data ----------
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var BRANCHES = [
    { branch: "Baner", restaurant: "Tandoor Tales", city: "Pune", base: 18 },
    { branch: "Koregaon Park", restaurant: "Tandoor Tales", city: "Pune", base: 14 },
    { branch: "Andheri", restaurant: "Tandoor Tales", city: "Mumbai", base: 20 },
    { branch: "Bandra", restaurant: "Wok Street", city: "Mumbai", base: 16 },
    { branch: "Viman Nagar", restaurant: "Wok Street", city: "Pune", base: 11 }
  ];
  var MENU = {
    "Tandoor Tales": [["Butter Chicken", "Main Course", 420, 160, 3], ["Paneer Tikka", "Starters", 280, 95, 2.2], ["Dal Makhani", "Main Course", 300, 85, 1.8],
      ["Butter Naan", "Breads", 60, 14, 4], ["Garlic Naan", "Breads", 80, 18, 1.4], ["Jeera Rice", "Rice", 180, 45, 1.3], ["Sweet Lassi", "Beverages", 110, 30, 1], ["Gulab Jamun", "Desserts", 120, 35, 1]],
    "Wok Street": [["Hakka Noodles", "Main Course", 240, 70, 3], ["Schezwan Fried Rice", "Rice", 260, 75, 2.6], ["Chicken Momos", "Starters", 240, 85, 2.4], ["Veg Manchurian", "Starters", 260, 80, 2],
      ["Chilli Chicken", "Starters", 340, 125, 1.6], ["Iced Tea", "Beverages", 120, 25, 1.5], ["Brownie", "Desserts", 160, 50, 1]]
  };
  var CHANNELS = [["Dine-in", .38], ["Takeaway", .14], ["Swiggy", .26], ["Zomato", .22]];
  var DATA_END = "2026-10-24";

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function pick(r, arr, wIdx) { var tot = 0, i; for (i = 0; i < arr.length; i++) tot += arr[i][wIdx]; var x = r() * tot; for (i = 0; i < arr.length; i++) { x -= arr[i][wIdx]; if (x <= 0) return arr[i]; } return arr[arr.length - 1]; }

  function generate() {
    var r = rng(42), orders = [], items = [], oid = 1;
    var start = Date.UTC(2026, 6, 1), end = Date.UTC(2026, 9, 24);
    for (var t = start; t <= end; t += 86400000) {
      var d = new Date(t), dow = d.getUTCDay(), wk = dow === 0 || dow === 6 ? 1.35 : dow === 5 ? 1.15 : 1;
      BRANCHES.forEach(function (b) {
        var n = Math.round(b.base * wk * (0.7 + r() * 0.6));
        for (var k = 0; k < n; k++) {
          var x = r(), hour = x < .4 ? 12 + Math.floor(r() * 3) : x < .5 ? 15 + Math.floor(r() * 4) : 19 + Math.floor(r() * 4);
          var ch = pick(r, CHANNELS, 1)[0], status = r() < .93 ? "completed" : "cancelled";
          var gross = 0, lines = 1 + Math.floor(r() * 3);
          for (var l = 0; l < lines; l++) {
            var m = pick(r, MENU[b.restaurant], 4), q = 1 + (r() < .25 ? 1 : 0) + (m[1] === "Breads" && r() < .5 ? 1 : 0);
            items.push({ order_id: oid, date: fmtDate(d), branch: b.branch, restaurant: b.restaurant, channel: ch, status: status, product: m[0], category: m[1], qty: q, revenue: q * m[2], food_cost: q * m[3] });
            gross += q * m[2];
          }
          var disc = r() < .25 ? Math.round(gross * (.05 + r() * .12)) : 0;
          orders.push({ order_id: oid++, date: fmtDate(d), hour: hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow], branch: b.branch, restaurant: b.restaurant, city: b.city,
            channel: ch, payment_method: ch === "Swiggy" || ch === "Zomato" ? "Online" : (r() < .55 ? "UPI" : r() < .6 ? "Card" : "Cash"), status: status,
            customer_id: r() < .65 ? 1 + Math.floor(Math.pow(r(), 2) * 900) : null, net_amount: Math.round((gross - disc) * 1.05), discount: disc });
        }
      });
    }
    return { orders: orders, items: items };
  }
  var DATA = generate();

  // ---------- metrics views (the semantic layer definitions) ----------
  // Each measure is defined ONCE: reducer over the rows of the view.
  function sum(f) { return function (rows) { var s = 0; for (var i = 0; i < rows.length; i++) s += rows[i][f] || 0; return s; }; }
  function completed(fn) { return function (rows) { return fn(rows.filter(function (x) { return x.status === "completed"; })); }; }
  function distinct(f) { return function (rows) { var s = {}; rows.forEach(function (x) { if (x[f] != null) s[x[f]] = 1; }); return Object.keys(s).length; }; }

  var VIEWS = {
    orders: {
      description: "Bill-level sales. One row = one bill. Use for revenue, orders, AOV, discounts, customers, channels, branches, hours.",
      table: "orders", timeDimension: "date",
      measures: {
        revenue: { label: "Revenue", desc: "Net sales of completed bills (after discount, incl. tax)", format: "currency", fn: completed(sum("net_amount")) },
        orders: { label: "Orders", desc: "Number of completed bills", format: "number", fn: function (rows) { return rows.filter(function (x) { return x.status === "completed"; }).length; } },
        aov: { label: "Avg order value", desc: "Revenue / Orders", format: "currency", fn: function (rows) { var c = rows.filter(function (x) { return x.status === "completed"; }); return c.length ? sum("net_amount")(c) / c.length : null; } },
        discount: { label: "Discount", desc: "Discount given on completed bills", format: "currency", fn: completed(sum("discount")) },
        customers: { label: "Customers", desc: "Unique identified customers", format: "number", fn: distinct("customer_id") },
        cancel_rate: { label: "Cancellation rate", desc: "Cancelled bills / all bills", format: "percent", fn: function (rows) { return rows.length ? rows.filter(function (x) { return x.status === "cancelled"; }).length / rows.length : null; } }
      },
      dimensions: { restaurant: "Restaurant brand", branch: "Branch / outlet", city: "City", channel: "Sales channel (Dine-in, Takeaway, Swiggy, Zomato)", payment_method: "Payment method", hour: "Hour of day", weekday: "Day of week", status: "Bill status" }
    },
    item_sales: {
      description: "Menu performance. One row = one line on a bill. Use for products, categories, quantities, item revenue.",
      table: "items", timeDimension: "date",
      measures: {
        qty_sold: { label: "Qty sold", desc: "Units sold on completed bills", format: "number", fn: completed(sum("qty")) },
        item_revenue: { label: "Item revenue", desc: "Qty x menu price on completed bills", format: "currency", fn: completed(sum("revenue")) }
      },
      dimensions: { restaurant: "Restaurant brand", branch: "Branch / outlet", product: "Menu item", category: "Menu category", channel: "Sales channel" }
    },
    recipe_costs: {
      description: "Food cost from recipes. One row = one line on a bill, costed at recipe cost. Use with item_sales for margin / profit.",
      table: "items", timeDimension: "date",
      measures: {
        food_cost: { label: "Food cost", desc: "Qty x recipe cost on completed bills", format: "currency", fn: completed(sum("food_cost")) }
      },
      dimensions: { restaurant: "Restaurant brand", branch: "Branch / outlet", product: "Menu item", category: "Menu category" }
    }
  };

  function listMetricsViews() { return Object.keys(VIEWS).map(function (k) { return { name: k, description: VIEWS[k].description }; }); }
  function getMetricsView(name) {
    var v = VIEWS[name]; if (!v) throw new Error("Unknown metrics view: " + name);
    return { name: name, description: v.description, timeDimension: v.timeDimension,
      measures: Object.keys(v.measures).map(function (m) { return { name: m, label: v.measures[m].label, description: v.measures[m].desc, format: v.measures[m].format }; }),
      dimensions: Object.keys(v.dimensions).map(function (d) { return { name: d, description: v.dimensions[d] }; }) };
  }
  function dimensionValues(view, dim) { var s = {}; DATA[VIEWS[view].table].forEach(function (r) { s[r[dim]] = 1; }); return Object.keys(s); }

  /** Row-level security: in production the semantic layer applies this per user. */
  var SESSION = { allowedRestaurants: null }; // null = admin (all)
  function setUserAccess(restaurants) { SESSION.allowedRestaurants = restaurants; }

  function queryMetricsView(args) {
    var t0 = Date.now(), v = VIEWS[args.metrics_view];
    if (!v) throw new Error("Unknown metrics view: " + args.metrics_view);
    var rows = DATA[v.table];
    if (SESSION.allowedRestaurants) rows = rows.filter(function (r) { return SESSION.allowedRestaurants.indexOf(r.restaurant) >= 0; });
    if (args.time_range) rows = rows.filter(function (r) { return r.date >= args.time_range.start && r.date < args.time_range.end; });
    (args.where || []).forEach(function (w) {
      if (!(w.dimension in v.dimensions)) throw new Error("Dimension '" + w.dimension + "' is not in " + args.metrics_view);
      rows = rows.filter(function (r) { var hit = w.values.indexOf(String(r[w.dimension])) >= 0; return w.op === "not_in" ? !hit : hit; });
    });
    var dims = (args.dimensions || []).map(function (d) { return d.name; });
    dims.forEach(function (d) { if (d !== "__time" && !(d in v.dimensions)) throw new Error("Dimension '" + d + "' is not in " + args.metrics_view); });
    var meas = (args.measures || []).map(function (m) { if (!v.measures[m.name]) throw new Error("Measure '" + m.name + "' is not in " + args.metrics_view); return m.name; });
    var grain = args.time_grain || "day";
    function timeKey(date) {
      if (grain === "month") return date.slice(0, 7) + "-01";
      if (grain === "week") { var d = new Date(date + "T00:00:00Z"), dow = (d.getUTCDay() + 6) % 7; return fmtDate(new Date(d.getTime() - dow * 86400000)); }
      return date;
    }
    var groups = {}, order = [];
    rows.forEach(function (r) {
      var key = dims.map(function (d) { return d === "__time" ? timeKey(r.date) : r[d]; }).join("\u0001");
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });
    if (!dims.length && !order.length) { groups[""] = []; order.push(""); }
    var out = order.map(function (key) {
      var parts = key.split("\u0001"), row = {};
      dims.forEach(function (d, i) { row[d] = parts[i]; });
      meas.forEach(function (m) { row[m] = v.measures[m].fn(groups[key]); });
      return row;
    });
    (args.sort || []).slice().reverse().forEach(function (s) {
      out.sort(function (a, b) { var x = a[s.name], y = b[s.name]; if (x === y) return 0; var c = x > y ? 1 : -1; return s.desc ? -c : c; });
    });
    if (args.limit) out = out.slice(0, args.limit);
    return { rows: out, meta: { metrics_view: args.metrics_view, scanned: rows.length, ms: Date.now() - t0 } };
  }

  AS.semantic = { listMetricsViews: listMetricsViews, getMetricsView: getMetricsView, queryMetricsView: queryMetricsView,
    dimensionValues: dimensionValues, setUserAccess: setUserAccess, DATA_END: DATA_END, formats: function (view, m) { return VIEWS[view] && VIEWS[view].measures[m] ? VIEWS[view].measures[m].format : "number"; } };
})(window.AS = window.AS || {});
