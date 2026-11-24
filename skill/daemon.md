# Blueprint Daemon & Live Browser Skill (`bp up` / `window.bp`)

[中文](zh/daemon.md) · [Skill Index](README.md) · [Def Module](def.md) · [Flow Module](flow.md) · [JS Module](js.md) · [SH Module](sh.md) · [AI Module](ai.md)

Operational guide for running the persistent `bp` daemon (`bp up`, `bp down`, `bp reload`, `bp emit`, `bp logs`), serving single-file blueprint UIs at `127.0.0.1:7500`, scheduling `every` flows, and using the frontend `window.bp` WebSocket API.

## 1. Daemon Lifecycle & CLI Commands

Default data directory is `$BP_DATA` or `~/.engineer-blueprint/data` (override with `--data <dir>`).

```bash
bp up [dir] [--port <n>] [--bind <host>] [--data <dir>] [--foreground] [--model <name>] [--ollama <url>] [--json]
bp down [--data <dir>] [--json]
bp reload [slug] [--dev] [--data <dir>] [--json]
bp emit <slug> <event> [json-data] [--dev] [--data <dir>] [--json]
bp logs <slug> [--dev] [--limit <n>] [--data <dir>] [--json]
```

- **`bp up [dir]`**: Starts the persistent HTTP/WebSocket daemon for a single directory of `*.html` blueprints (default `127.0.0.1:7500`). When `dir` is omitted, reuses the saved `config.json` `dir` or falls back to (and auto-creates) `$BP_DIR` / `~/.engineer-blueprint/blueprints`. Saves `{ dir, bind, port }` to `config.json`, writes `daemon.json` (`{ pid, bind, port, dir, startedAt }`) once healthy, and cleans stale `daemon.json` files automatically.
  - On startup, all `*.html` files load in **`prod`** mode: parse → `syncBlueprint` → start `every` timers → run `init` flows asynchronously in background.
  - **`dev`** mode blueprints load lazily when visiting `/bp-dev/<slug>`, running `bp reload [slug] --dev`, or running `bp emit <slug> ... --dev`.
- **`bp down`**: Cleanly stops all `every` timers, closes WebSocket connections, stops the HTTP server, and removes `daemon.json`.
- **`bp reload [slug] [--dev]`**: Re-reads `.html` file(s) using SHA-256 content hashes (reconciling `<script type="blueprint/def">` schemas, restarting `every` timers, unloading deleted blueprints, and pushing `{ op: "reload" }` over WebSocket to trigger automatic browser refresh). Exits `1` if a reloaded blueprint fails parse/sync.
- **`bp emit <slug> <event> [json-data] [--dev]`**: Triggers matching `on="<event>"` flows inside the running daemon, broadcasting events and `bp.watch` updates to connected browser clients. Fails clearly if the daemon is not running (use `bp run` for offline single runs).
- **`bp logs <slug> [--dev] [--limit <n>]`**: Reads recent entries from the daemon's 200-entry in-memory ring buffer per `(slug, mode)` (load/reload, background `init`, `every` ticks, flow start/finish, step ok/error, emits).

## 2. Overview Page, Routes & HTML Serving

- **Overview (`GET /`, default `http://127.0.0.1:7500`)**: Lists all `*.html` blueprints in `dir` sorted alphabetically by `slug` (`basename` without `.html`) with `<title>`, `slug`, blueprint ID, `/bp/<slug>` (`prod`) and `/bp-dev/<slug>` (`dev`) links, and any parse/sync error banner.
- **Blueprint pages (`GET /bp/<slug>` and `GET /bp-dev/<slug>`)**:
  - Strips all `<script type="blueprint/...">...</script>` blocks while preserving HTML comments and frontend `<script>` tags.
  - Injects `<script src="/bp/<slug>/bp.js"></script>` (or `/bp-dev/<slug>/bp.js`) near the top of the document so `window.bp` is ready before any inline `<body>` scripts execute.
  - Returns HTTP `500` with a readable error page if the blueprint failed parse or schema sync.
- **Automatic browser reload (no corner button)**: `bp.js` does not inject any corner reload button or DOM UI; when `bp reload` updates a blueprint, `bp.js` receives `{ op: "reload" }` over WebSocket and calls `location.reload()` automatically.

## 3. Frontend `window.bp` API

`bp.js` opens a single WebSocket (`WS /bp/<slug>/ws` or `WS /bp-dev/<slug>/ws`) with automatic reconnect and `watch` re-subscription:

```html
<script>
  const stopWatch = bp.watch("SELECT id, body FROM notes ORDER BY id DESC LIMIT 50", (rows) => {
    renderNotes(rows);
  });

  const stopListen = bp.on("note:saved", (data) => {
    console.log("Saved:", data);
  });

  async function submitNote(id, body) {
    await bp.emit("note:create", { id, body });
  }

  async function lookupNote(id) {
    return bp.sql("SELECT id, body FROM notes WHERE id = :id", { id });
  }
</script>
```

| Member | Contract |
|---|---|
| `bp.mode` | `"prod"` (for `/bp/<slug>`) or `"dev"` (for `/bp-dev/<slug>`). |
| `bp.emit(event, data)` | Sends `{ op: "emit", event, data }` over WS, returning a `Promise` that resolves when matching `on="<event>"` flows complete. |
| `bp.on(event, cb)` | Subscribes to server-pushed `{ op: "event", event, source, data, time }` frames (`ui`, `cli`, `flow`); returns an unsubscribe function. |
| `bp.watch(query, cb)` | Accepts a plain table name (`^[A-Za-z_][A-Za-z0-9_]*$`) or a single read-only `SELECT` / `WITH ... SELECT` query; calls `cb(rows)` initially and on every `{ op: "change", query, rows }` push (triggered by flow SQL writes or `bp sql` write notifications); returns an unsubscribe function. |
| `bp.sql(sql, params)` | **Strictly read-only** query (`SELECT`, `WITH ... SELECT`, or `PRAGMA table_info(...)`) supporting `:name` / `$name` / `@name` objects or positional `[...]` arrays; returns `Promise<rows>` and rejects any write/DDL/multi-statement SQL. |

## 4. `every="..."` Schedule Formats

Inside `<script type="blueprint/flow" every="...">`, the daemon supports:

- **Duration intervals**: `<n>s`, `<n>m`, `<n>h` (e.g. `1s`, `30s`, `5m`, `1h`).
- **Daily clock time**: `HH:MM` (24-hour local time, e.g. `09:00`).
- **Standard 5-field cron**: `minute hour dom month dow` (e.g. `*/5 * * * *`).
