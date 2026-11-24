# Blueprint JS Action Node Skill (`<script type="blueprint/js">`)

[中文](zh/js.md) · [Skill Index](README.md) · [Flow Module](flow.md) · [Def Module](def.md) · [SH Module](sh.md) · [AI Module](ai.md) · [Daemon Module](daemon.md)

Specification and operational guide for authoring pure JavaScript backend action nodes (`<script type="blueprint/js">`) inside `<script type="blueprint/flow">` workflows.

## 1. Declaration Syntax

```html
<script type="blueprint/js" id="clean" desc="Trim and validate note body">
export default async (ctx) => {
  const body = String(ctx.event.data?.body ?? "").trim();
  if (!body) return { valid: false, reason: "empty body" };
  return { valid: true, id: ctx.event.data.id, body };
};
</script>
```

- **`id`** (required): Unique backend action node ID within the document (cannot be `"done"`).
- **`desc`** (optional): Concise purpose summary shown to the flow decision router.
- **`<\/script>` unescaping**: Escaped `<\/script>` sequences in the body are unescaped to `</script>` before execution.

## 2. Runtime Contract

- **Pure ES module**: Must export a default function (`export default async (ctx) => ...`) or a named `run` function fallback if `default` is absent.
- **Single `(ctx)` argument**: Invoked with **only `(ctx)`**—a fresh deep clone (`structuredClone`) of the full, untruncated workflow context:

```js
{
  event: { type: eventName, data: eventData },
  last: null,       // { node, ok, output, error } from previous step
  steps: {},        // map of nodeId -> { ok, output, error }
  history: []       // ordered list of { step, node, ok, output, error }
}
```

- **No `bp` helper object & SQLite isolation**: No `bp` helper is injected into `blueprint/js`. Scripts must **not** open `.sqlite` files directly; route all database reads and writes through `<script type="blueprint/sql">` nodes ([`flow.md`](flow.md)) or `bp sql` ([`def.md`](def.md)).
- **Fresh module execution & return normalization**: Executed from a unique temporary `.mjs` file on every call (cleaned up in `finally`) to avoid stale ESM caching. Returning `undefined` normalizes to `null`.
- **Error recording**: If the function throws (or lacks an exported handler), the flow loop catches the error and records `{ step, node, ok: false, output: null, error: err.message }` in `ctx.history`, `ctx.last`, and `ctx.steps[id]` so subsequent flow branches can handle the failure cleanly.
