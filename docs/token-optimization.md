# Token optimization

Only one step of the pipeline (the planner) uses an LLM. The goal is to call it **only when a genuinely new plan is needed**.

| Path | Example | Tokens |
|---|---|---|
| New report | "Revenue by channel last 30 days vs previous period" | 1 planner call |
| Local edit | "make it a pie", "top 5", "last month", "compare", "only Zomato" | 0 |
| Drill-down | click a bar | 0 |
| Filter chip removal | × on a filter | 0 |
| Repeat request | same text again (same catalog version) | 0 (plan cache) |
| Scheduled run | Monday 9 AM delivery | 0 (stored spec) |

## How local edits are detected

`token-rules.js` strips known edit phrases from the request. If **nothing meaningful is left**, it's an edit and is applied directly to the current spec. If words remain ("Daily sales trend this month"), it's a new report and goes to the planner.

## Prompt size

- Catalog = names + one-line descriptions, never data samples
- Edit mode sends the current spec, so the model returns a small change
- Rules are short and stable (good for provider-side prompt caching)

## Measuring it

The demo's pipeline panel shows *planner calls · local edits · cached* for the session. In production, the same counters were logged to compare planner calls with total report views.
