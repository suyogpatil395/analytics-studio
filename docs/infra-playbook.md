# Infrastructure playbook: making a semantic layer AI-ready

Once reports are self-serve, the data team stops building reports and starts building the **platform the AI stands on**. This is the checklist I follow.

## 1. Model at the right grain

| Do | Don't |
|---|---|
| One fact model per grain: `orders` (one row per bill), `item_sales` (one row per bill line) | One wide table mixing bill amounts and line items |
| Put the grain in the model's description | Leave it implicit |

Mixing grains is the #1 source of double-counted revenue (the fan-out trap). An AI combining fields will hit it immediately.

## 2. Encode business rules in measures, not in prompts

```yaml
- name: revenue
  description: Net sales of completed bills (after discount, incl. tax)
  expression: SUM(CASE WHEN status = 'completed' THEN net_amount ELSE 0 END)
```
The AI never has to remember "exclude cancelled bills", because it can't get it wrong.

## 3. Name and describe for a reader who has never seen your database

- `snake_case`, unique across views where meaning is the same (`revenue` means the same thing everywhere)
- A one-line description on **every** view, measure and important dimension. The planner reads these
- A view-level description that says what the view is *for*: "Use for revenue, orders, AOV, channels, branches"

## 4. Make join keys consistent across views

Deep-dive joins (sales × recipe cost, sales × stock) only work if keys line up:
- Same dimension name (`branch`, `product`) in every view
- Same values: trim spaces, consistent case, one spelling per branch or product
- Expose the **lowest shared grain** that is reliable (often branch + product + date); if order-level IDs aren't exposed in a view, the join happens at branch / product level

## 5. Security belongs in the semantic layer

```yaml
security:
  access: true
  row_filter: "restaurant_id = {{ .user.restaurant_id }}"
```
- Each user gets attributes (restaurant, brand, region)
- The Studio queries **as the user**, so RLS applies to every AI request automatically
- Never rely on the prompt to restrict data

## 6. Performance budget

A prompt should become a report in seconds:
- Materialise models; keep metrics views on columnar storage (DuckDB)
- Pre-aggregate heavy, popular combinations (daily × branch × channel)
- Cap result sizes (the app clamps limits too)
- Cache identical queries per session

## 7. Data quality: trust is the product

Run before every rollout and on a schedule:

| Check | Expect |
|---|---|
| Duplicate primary keys in fact models | 0 |
| Daily revenue: model vs source | equal |
| Orphan keys (lines without a bill, bills without a branch) | 0 |
| Freshness: latest timestamp | within the refresh window |
| Impossible values (negative bills, 0-minute deliveries) | 0 |

Alert the data team (e.g. Slack) when a check fails.

## 8. Change management

- **Additive changes are safe** (new measure, new dimension)
- **Renames and removals break saved reports and schedules.** Deprecate first (keep the old name, mark it in the description), then remove
- Bump the **catalog version** on any change; the Studio's plan cache is keyed by it, so stale plans are never reused

## 9. Onboarding a new client

1. Connect the source (POS database)
2. Reuse the standard models; add client-specific rules only where needed
3. Reuse the standard metrics views; set RLS attributes per user
4. Run the quality checks
5. Give access to the Studio; the AI works immediately because the catalog is the same

A new client is configuration, not new reports.
