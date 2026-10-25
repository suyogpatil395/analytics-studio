# Report spec reference

The report spec is the **only** thing the AI produces. The app validates it, executes it and renders it.

## Top level

| Field | Type | Default | Notes |
|---|---|---|---|
| `title` | string | `"Untitled report"` | Shown as the report heading |
| `date_range` | `{preset}` or `{start, end}` | `last_30_days` | Presets: `today`, `yesterday`, `last_7_days`, `last_14_days`, `last_30_days`, `this_month`, `last_month`, `last_90_days`. Explicit ranges are half-open: `end` is excluded |
| `compare` | `null` · `previous_period` · `previous_week` · `previous_year` | `null` | The comparison window has the same length as the main range |
| `filters` | `[{dimension, op, values[]}]` | `[]` | `op` is `in` or `not_in`. Applied to every block whose view has that dimension |
| `blocks` | array | required | See below. Rendered in order |

## Blocks

### `kpi`
```json
{ "type": "kpi", "view": "orders", "measures": ["revenue", "orders", "aov"] }
```
One query (plus one more when `compare` is set). Each measure becomes a tile with a Δ%.

### `chart`
```json
{ "type": "chart", "view": "orders", "chart": "line", "measure": "revenue", "dimension": "__time", "grain": "day" }
{ "type": "chart", "view": "orders", "chart": "bar",  "measure": "revenue", "dimension": "channel", "limit": 10 }
```
- `dimension: "__time"` means a trend; `grain` is `day`, `week` or `month`.
- `pie` is only allowed for categorical dimensions (the validator switches a time pie to a line).
- Bars and slices are clickable for drill-down.

### `table`
```json
{ "type": "table", "view": "orders", "dimensions": ["branch"], "measures": ["revenue", "orders"],
  "sort": { "by": "revenue", "desc": true }, "limit": 50 }
```
With `compare`, every numeric cell shows its own Δ% against the matching row of the comparison period.

### `join` (deep-dive)
```json
{ "type": "join",
  "left":  { "view": "item_sales",   "measures": ["item_revenue"] },
  "right": { "view": "recipe_costs", "measures": ["food_cost"] },
  "on": ["product"],
  "calc": [ { "name": "profit", "expr": "item_revenue - food_cost", "format": "currency" } ],
  "sort": { "by": "profit", "desc": true }, "limit": 15 }
```
- `on` must be dimensions present in **both** views.
- `calc.expr` may only contain field names, numbers and `+ - * / ( )`.
- Missing operands make the result `null` (blank), never zero.

## Validation outcomes

| Severity | Meaning |
|---|---|
| **error** | The block was removed (unknown view, measure or dimension; no join key) |
| **warning** | The block was repaired (dropped an unknown KPI measure, switched chart type, clamped a limit) |

Both are shown to the user above the report.
