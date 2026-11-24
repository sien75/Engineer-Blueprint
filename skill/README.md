---
name: engineer-blueprint
description: Author and operate single-file HTML Engineer Blueprints using declarative blueprint/* blocks, the bp daemon/CLI, and window.bp.
---

# Engineer Blueprint Skill

[中文](zh/README.md)

Specification and operational skill for single-file `.html` Engineer Blueprints. A Blueprint is a self-contained `.html` document composed of standard HTML metadata, declarative `<script type="blueprint/*">` blocks, and `<body>`.

## Document Structure

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="bp:id" content="my-app" />
    <title>My Blueprint</title>
  </head>
  <body>
    <!-- Application UI (window.bp is injected automatically by the daemon) -->

    <script type="blueprint/def">
      /* Declarative SQLite schema and seed data */
    </script>

    <script type="blueprint/flow" on="note:create">
      /* Natural-language workflow instructions referencing action node IDs */
    </script>
    <script type="blueprint/js" id="clean">
      /* Pure ES module action: export default async (ctx) => ... */
    </script>
    <script type="blueprint/sh" id="inspect">
      /* Shell script action: reads full ctx JSON on stdin, outputs JSON or text */
    </script>
    <script type="blueprint/sql" id="save-note">
      /* SQL action node bound to ctx.last.output or ctx.event.data */
    </script>
    <script type="blueprint/ai" id="summarize" cli="agy">
      /* Optional role prompt prepended only on a new session */
    </script>
    <script type="blueprint/emit" id="notify" event="note:saved"></script>
  </body>
</html>
```

- **`<!doctype html>`**: Standard HTML5 document declaration.
- **`<title>`**: Human-readable blueprint title (shown on the daemon overview page).
- **Blueprint Identity (`<meta name="bp:id" content="<id>">` or `<meta id="<id>">`)**: Every blueprint `.html` document must declare a unique identifier matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (1–64 characters; starts with an ASCII letter or digit, followed by ASCII letters, digits, `.`, `_`, or `-`). If both forms appear, `<meta name="bp:id" content="<id>">` takes precedence; multiple declarations of the active form with differing values are invalid.
- **Declarative Blocks (`<script type="blueprint/*">`)**: Specialized script blocks declaring data schemas (`blueprint/def`), natural-language orchestration (`blueprint/flow`), and backend action nodes (`blueprint/js`, `blueprint/sh`, `blueprint/sql`, `blueprint/emit`, `blueprint/ai`) inside the `.html` file.
- **`<body>`**: HTML markup, styles, and client scripts using `window.bp` (`bp.emit`, `bp.on`, `bp.watch`, `bp.sql`, `bp.mode`).

## Workflow Overview

1. **Author declarations and UI in `.html`**: Define the blueprint identity, `<script type="blueprint/*">` blocks, and frontend UI in the `.html` document (if the user does not specify a directory, default to the `dir` saved in `~/.engineer-blueprint/data/config.json` or `~/.engineer-blueprint/blueprints/`).
2. **Operate via `bp` Daemon & CLI**:
   - **`bp up [dir]` / `bp down`**: Start or stop the persistent HTTP/WebSocket daemon & scheduler (when `dir` is omitted, defaults to the saved `config.json` `dir`, `$BP_DIR`, or auto-created `~/.engineer-blueprint/blueprints`; serves `http://127.0.0.1:7500` overview, `/bp/<slug>`, `/bp-dev/<slug>`).
   - **`bp reload [slug] [--dev]`**: Re-read changed `.html` files, reconcile `<script type="blueprint/def">` schemas, restart `every` timers, and auto-reload open browser tabs.
   - **`bp emit <slug> <event> [json] [--dev]`**: Trigger matching `on="<event>"` flows inside the running daemon and push live WS events / `bp.watch` updates.
   - **`bp sql <file.html|id> "<statement>" [--dev]`**: Query or modify blueprint SQLite data during development (notifying the running daemon on writes so `bp.watch` refreshes).
   - **`bp logs <slug> [--dev] [--limit <n>]`**: Inspect recent flow, step, schedule, init, and reload logs from the daemon ring buffer.
   - **`bp run <file.html> <event> [json] | --init`**: Execute an offline single flow run directly against a `.html` file without starting the daemon.
3. **Select environment and storage explicitly**: Default mode is `prod`; pass `--dev` (or visit `/bp-dev/<slug>`) for isolated development storage. Never open `.sqlite` files directly or hand-edit files under `<data>/blueprints/` (`$BP_DATA` or `~/.engineer-blueprint/data`, override with `--data <dir>`).

## Modules

| Module | Guide | Scope |
|---|---|---|
| Typical Workflows | [`workflows.md`](workflows.md) | Distinguish user-facing presentation (system/built-in browser) from non-intrusive `dev` debugging (`ego-lite`/`browser-use` + `bp emit`/`sql`/`logs`). |
| `blueprint/def` (SQLite) | [`def.md`](def.md) | `<script type="blueprint/def">` declarative SQLite schemas/seeds, reconciliation lifecycle, safety cautions, access boundaries, and `bp sql`. |
| `blueprint/flow` (`sql` / `emit`) | [`flow.md`](flow.md) | `<script type="blueprint/flow">` natural-language routing via Jev (`jev-1.14`), `<script type="blueprint/sql">` & `<script type="blueprint/emit">` nodes, shared `ctx`, self-check rules, and offline `bp run`. |
| `blueprint/js` | [`js.md`](js.md) | Pure ES module backend action node (`export default async (ctx) => ...`), `ctx` isolation, and error recording. |
| `blueprint/sh` | [`sh.md`](sh.md) | Shell script backend action node reading full `ctx` JSON on `stdin`, JSON/text stdout normalization, and exit error handling. |
| `blueprint/ai` (`cli="agy"`) | [`ai.md`](ai.md) | Stateless AI CLI action node, `{ prompt, session?, cwd? }` -> `{ text, session }` contract, temporary vs SQLite session-resume patterns, and unambiguous node IDs. |
| Daemon & `window.bp` | [`daemon.md`](daemon.md) | `bp up`, `bp down`, `bp reload`, `bp emit`, `bp logs`, `127.0.0.1:7500` overview, `/bp/<slug>` vs `/bp-dev/<slug>`, `every` scheduling, auto-reload, and frontend `window.bp` WebSocket API. |
