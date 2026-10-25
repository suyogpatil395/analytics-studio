# Connecting a real LLM and a real semantic layer

The demo runs fully offline. Two hooks switch it to production mode.

## 1. LLM planner

```js
AS.planner.setLLM(async (prompt) => {
  // Call your model through a server-side proxy that holds the API key.
  const r = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
  if (!r.ok) throw new Error("Planner unavailable");
  return (await r.json()).text;     // must contain the JSON spec
});
```
- Never put API keys in browser code
- `AS.planner.parseReply` tolerates code fences around the JSON
- Hosts with a built-in model call (e.g. a chat app's sandboxed artifact runtime) can pass that function directly

## 2. Semantic layer over MCP

Any server that exposes these tools works:

| Tool | Arguments | Returns |
|---|---|---|
| `list_metrics_views` | none | `[{name, description}]` |
| `get_metrics_view` | `{metrics_view}` | `{measures[], dimensions[], timeDimension}` |
| `query_metrics_view` | `{metrics_view, measures[], dimensions[], time_range, where[], sort[], limit, time_grain}` | `{data: rows[]}` or `{rows: []}` |

```js
AS.data.useMcp((tool, args) => mcpClient.callTool(tool, args));
```

The adapter normalises `{data: [...]}` to `{rows: [...]}` and caches every call for the session.

## Security checklist

- Queries must run with the **end user's** identity so row-level security applies
- Keep the planner prompt free of data; it only needs the catalog
- Log specs (not data) for debugging and quality review
