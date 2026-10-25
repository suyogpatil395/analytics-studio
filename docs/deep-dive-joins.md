# Deep-dive joins

Some questions need measures from two metrics views, for example **profit = item revenue (sales) − food cost (recipes)**. A semantic layer usually exposes each source as its own view, so the Studio joins them, but only after proving the join is safe.

## Algorithm

1. **Query both views at the shared grain** (the `on` dimensions), with the same date range and filters.
2. **Normalise keys**: trim and lower-case each key part.
3. **Measure the match rate**: the share of left keys that exist on the right.
4. **Refuse below 50%.** Keys that don't line up usually mean naming differs between systems (e.g. "Baner Outlet" in one system vs "Baner" in another). Merging would produce confident but wrong numbers, so the Studio explains instead.
5. **Left-join** and add right-side measures (missing → `null`).
6. **Calculated fields** are evaluated per row; **any missing operand makes the result `null`**.
7. **Sort, limit and render** with a verification note.

## Why "missing is not zero"

| product | item_revenue | food_cost | profit if missing = 0 | profit (null-safe) |
|---|---|---|---|---|
| Butter Chicken | 3,29,000 | 1,25,000 | 2,04,000 | 2,04,000 |
| New Special | 40,000 | *missing* | **40,000 (100% margin!)** | **blank** |

Treating missing as zero invents a perfect margin. Blank is honest.

## Grain matters

If order-level IDs are not exposed in one of the views, a "join on order" is impossible; the right answer is to join at **branch** or **branch + product** level and say so. The planner is told which dimensions are shared, and the validator removes join keys that don't exist in both views.
