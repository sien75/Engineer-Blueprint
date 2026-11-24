# Blueprint Flow Orchestration Skill (`<script type="blueprint/flow">`)

[中文](zh/flow.md) · [Skill Index](README.md) · [Def Module](def.md) · [JS Module](js.md) · [SH Module](sh.md) · [AI Module](ai.md) · [Daemon Module](daemon.md)

Specification and operational guide for authoring natural-language workflows (`<script type="blueprint/flow">`), SQL and event action nodes (`blueprint/sql`, `blueprint/emit`), and executing single-run flows via `bp run` (or live via `bp emit` / `bp up` in [`daemon.md`](daemon.md)).

## 1. Writing `<script type="blueprint/flow">`

Each `<script type="blueprint/flow">` block declares a natural-language routing specification evaluated step-by-step by Jev (`jev-1.14` via `https://api.typesafe.ai/v1/systemone` by default):

- **Exactly one trigger attribute** is required on every flow block:
  - `on="<event>"` — Runs when triggered via `bp.emit(...)`, `bp emit <slug> <event>`, or offline `bp run <file.html> <event>`.
  - `init` (boolean attribute, e.g. `<script type="blueprint/flow" init>`) — Runs asynchronously in the background when loaded in the daemon (`bp up` / new load), or synchronously via `bp run <file.html> --init`.
  - `every="<schedule>"` — Executed on schedule by the persistent daemon (`bp up` / `bp reload`); supports `<n>s`/`<n>m`/`<n>h`, `HH:MM`, and 5-field cron (see [`daemon.md`](daemon.md); not executed by offline `bp run`).
- **Non-empty body**: Whitespace-only flow blocks are rejected. Escaped `<\/script>` sequences are unescaped to `</script>`.
- **Multiple matching flows**: If multiple `<script type="blueprint/flow">` blocks match the same `on` event or `init`, they execute in document order, each starting its own step loop.

```html
<script type="blueprint/flow" on="note:create">
1. Run clean to trim and validate the incoming note.
2. If clean outputs valid=true, run save-note to persist it, then finish with done.
3. If clean outputs valid=false or fails, run reject, then finish with done.
</script>
```

## 2. Backend Action Nodes

Backend action nodes declare executable steps inside the `.html` file. Every action node:

- Must declare a unique, non-empty `id` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- Must **not** use `"done"` as an `id` (`"done"` is reserved for stopping the flow loop).
- May declare an optional `desc="..."` attribute summarizing its purpose for the decision router.
- Unescapes `<\/script>` to `</script>` in its body.

(`blueprint/def`, `blueprint/flow`, `blueprint/init.*`, and frontend `<script>` tags are excluded from flow action nodes.)

### Node Type Guides

- **`blueprint/js`**: Pure ES module (`export default async (ctx) => ...`) — see [`js.md`](js.md).
- **`blueprint/sh`**: Shell script executed with full `ctx` JSON on `stdin` — see [`sh.md`](sh.md).
- **`blueprint/ai`**: Stateless AI CLI adapter (`cli="agy"`) — see [`ai.md`](ai.md).
- **`blueprint/sql`** & **`blueprint/emit`**: Specified directly below.

### `blueprint/sql`

```html
<script type="blueprint/sql" id="save-note" desc="Insert validated note into SQLite">
INSERT INTO notes (id, body) VALUES (:id, :body);
</script>
```

- Ignored during `<script type="blueprint/def">` schema reconciliation ([`def.md`](def.md)); executed as a flow step against `<id>.<mode>.sqlite`.
- **Parameter binding**: Scans each SQL statement for named placeholders (`:name`, `$name`, `@name`, ignoring comments and string literals) and binds **only** the keys present in the SQL statement from:
  1. `ctx.last?.output` if it is a plain object, otherwise
  2. `ctx.event?.data` if it is a plain object, otherwise `{}`.
- **Return value**:
  - Queries (`SELECT`, `PRAGMA`, `INSERT/UPDATE/DELETE ... RETURNING *`): returns the rows array directly (e.g. `ctx.last.output[0]`).
  - Writes (`INSERT`, `UPDATE`, `DELETE` without `RETURNING`): returns `{ changes, lastInsertRowid }` (e.g. `ctx.last.output.changes`).

### `blueprint/emit`

```html
<script type="blueprint/emit" id="reject" event="note:rejected" desc="Emit rejection event"></script>
```

- Requires a non-empty `event="<event-name>"` attribute.
- Emits `{ event: "<event-name>", data }` using `data = ctx.last?.output ?? ctx.event?.data ?? null`, records it in `emittedEvents` (and broadcasts to connected browser `bp.on` listeners in daemon mode), and returns `{ emitted: "<event-name>", data }`.

## 3. Shared `ctx`, Decision View, Errors & Loop Guard

### Shared `ctx` (Full, Untruncated)

Every downstream action node receives a fresh clone of the full, untruncated `ctx`:

```js
{
  event: { type: eventName, data: eventData },
  last: null,       // { node, ok, output, error } from previous step
  steps: {},        // map of nodeId -> { ok, output, error } (latest execution of that node)
  history: []       // ordered list of { step, node, ok, output, error }
}
```

### Decision Loop (Jev) & 500-Char Truncation

At each turn, Jev selects the next node `id` or `"done"` via a System One `choice` question (`answers.next.choice`). The decision `state` contains:

1. The flow's natural-language instructions.
2. Trigger event `type` and JSON-serialized `data` **truncated to at most 500 characters**.
3. Ordered progress lines (`#1 <node> [ok]: <preview>` or `#1 <node> [error]: <preview>`, or `(none yet)` on step 1), each preview **truncated to at most 500 characters**.
4. Available node `id`s (with `desc` if present) and `done`.

> Truncation applies **only** to the router prompt; action nodes always receive full, untruncated values in `ctx`.

### Error Handling & Loop Guard

- **Action errors are non-fatal to the loop**: If an action node throws, the runtime catches it and records `{ step, node, ok: false, output: null, error: err.message }` in `ctx.history`, `ctx.last`, and `ctx.steps[nodeId]` so the router can branch to a fallback/error node or `done`.
- **`maxSteps` guard**: Defaults to `16` turns (`--max-steps <n>`). If `"done"` is not selected within `maxSteps`, execution aborts with an explicit error listing the executed step trail.

## 4. Authoring Self-Check Rules

Before finalizing a blueprint containing flows, verify all four rules:

1. **Explicitly name node `id`s in flow text**: Reference exact action node `id`s (e.g., `clean`, `save-note`, `reject`, `done`) in `<script type="blueprint/flow">` — avoid vague phrasing like "validate the input" or "save it".
2. **Make branches mutually exclusive and cover failures**: State clear, disjoint routing conditions (e.g., `valid=true` vs `valid=false`, and what to do when a step fails with `[error]`).
3. **Terminate every branch cleanly at `done`**: Ensure every path ends explicitly at `done` with no unbounded loops.
4. **Verify upstream/downstream field & `:param` names**: Confirm every field read via `ctx.steps["<id>"].output.*` or `ctx.last.output.*` and every `:param` / `$param` / `@param` placeholder in `blueprint/sql` matches the exact keys emitted by the preceding node (note that write-only SQL nodes output `{ changes, lastInsertRowid }`; use `RETURNING *` or a JS step if subsequent SQL nodes need original record fields).

## 5. `bp run` (Offline Single Run) vs `bp emit` (Daemon)

For live/daemon execution (including `every` schedules and WebSocket pushes), use `bp up` + `bp emit` ([`daemon.md`](daemon.md)). For isolated offline single runs directly against a `.html` file:

```bash
bp run <file.html> <event> [json-data] [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]
bp run <file.html> --init [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]
```

- Automatically reconciles `<script type="blueprint/def">` with `<id>.<mode>.sqlite` before running matching flow(s).
- `--dev` targets `dev` mode instead of `prod`; `--data <dir>` overrides `$BP_DATA` / `~/.engineer-blueprint/data`.
- `--jev-url` overrides `$BP_JEV_URL` (default `https://api.typesafe.ai/v1`); `--jev-model` overrides `$BP_JEV_MODEL` (default `jev-1.14`); `--jev-key` overrides `$BP_JEV_API_KEY` / `$JEV_API_KEY`.
- `--max-steps <n>` sets the loop guard (positive integer, default `16`); `--json` outputs structured JSON.
