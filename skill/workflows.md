# Blueprint Typical Workflows (Present vs. Author & Debug)

[中文](zh/workflows.md) · [Skill Index](README.md) · [Def Module](def.md) · [Flow Module](flow.md) · [JS Module](js.md) · [SH Module](sh.md) · [AI Module](ai.md) · [Daemon Module](daemon.md)

Day-to-day Engineer Blueprint usage falls into two distinct workflows with different browser strategies: **presenting to the user** vs. **non-intrusive debugging**.

---

## 1. Open a Blueprint (User-Facing Presentation)

Use when a blueprint is ready and should be presented directly to the user:

1. **Ensure the daemon is running**: Run `bp up [dir]` if not already running (when `dir` is omitted, defaults to the saved `config.json` `dir`, `$BP_DIR`, or auto-created `~/.engineer-blueprint/blueprints`; listens on `http://127.0.0.1:7500` by default).
2. **Open in a user-visible browser**: Open the link via the **system default browser** or **IDE built-in browser** so the user sees it directly:
   - **Overview**: `http://127.0.0.1:7500` (lists all blueprints with `prod` / `dev` links)
   - **Production UI**: `http://127.0.0.1:7500/bp/<slug>`
   - **Development UI**: `http://127.0.0.1:7500/bp-dev/<slug>`

---

## 2. Author & Debug a Blueprint (Non-Intrusive to the User)

Use when creating or updating a `.html` blueprint and verifying it in `dev` mode. **Keep debugging invisible/non-intrusive so it does not disrupt the user's foreground windows**:

1. **Author the `.html` sections** (if no directory is specified, save to the `dir` in `~/.engineer-blueprint/data/config.json`, or default to `~/.engineer-blueprint/blueprints/`):
   - Declare `<meta name="bp:id" content="<id>">` and `<title>` in `<head>`.
   - Define SQLite tables and seed data in `<script type="blueprint/def">` ([`def.md`](def.md)).
   - Write natural-language flows in `<script type="blueprint/flow">` plus action nodes (`js`, `sh`, `sql`, `ai`, `emit`) ([`flow.md`](flow.md)).
   - Build the `<body>` UI using `window.bp` (`bp.watch`, `bp.emit`, `bp.on`) ([`daemon.md`](daemon.md)).
2. **Start or hot-reload in `dev` mode**:
   - Run `bp up [dir]` initially, or `bp reload <slug> --dev` after editing `.html` (reconciles `.dev.sqlite`, restarts `every` timers, and triggers reload).
3. **Debug with a non-intrusive browser + CLI commands**:
   - **Silent UI verification**: Prefer `ego-lite` (`ego-browser`), an agent built-in browser, or `browser-use` (or agree with the user on which debugging browser tool to use) to open `http://127.0.0.1:7500/bp-dev/<slug>` and inspect rendering, console errors, and interactions without popping up foreground windows.
   - **Trigger flows**: `bp emit <slug> <event> '<json>' --dev` to trigger matching `on` flows and observe live `bp.watch` / `bp.on` updates.
   - **Inspect or mutate SQLite**: `bp sql <slug> "<statement>" --dev` to check stored rows or test reactive `bp.watch` updates.
   - **Inspect logs**: `bp logs <slug> --dev` to review Jev routing decisions, step outputs, and errors (or run `bp run <file.html> <event> '<json>' --dev` for an offline single run).
