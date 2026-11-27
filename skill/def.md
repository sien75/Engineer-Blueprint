# Blueprint SQLite Definition Skill (`<script type="blueprint/def">`)

[中文](zh/def.md) · [Skill Index](README.md) · [Flow Module](flow.md) · [Daemon Module](daemon.md)

Specification and operational guide for authoring declarative SQLite schemas and seed data in `<script type="blueprint/def">`, understanding reconciliation and isolation semantics, and inspecting or modifying development data via `bp sql`. (For `<script type="blueprint/sql" id="...">` workflow action nodes, see [`flow.md`](flow.md).)

## 1. Writing `<script type="blueprint/def">`

Write standard SQLite statements inside one or more `<script type="blueprint/def">` blocks in the `.html` document (evaluated in document order):

- Always use `CREATE TABLE IF NOT EXISTS ...` for tables and `CREATE [UNIQUE] INDEX IF NOT EXISTS ...` for explicit indexes.
- Write initial seed rows in the same block with `INSERT OR IGNORE INTO ...` so initial database access inserts seed rows while subsequent reconciliations neither duplicate rows nor overwrite user edits.
- Any escaped `<\/script>` sequence inside a block is unescaped to `</script>`.

```html
<script type="blueprint/def">
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light');
</script>
```

## 2. Declarative Schema Reconciliation & Lifecycle

Blueprints declare only the desired target schema in `.html`, with no schema version numbers or incremental migration scripts. Declarative reconciliation runs against `<script type="blueprint/def">` via **`bp reload`** in daemon mode (and automatically whenever `bp sql <file.html>` or `bp run <file.html>` is invoked with a `.html` file path; `dev` and `prod` follow identical semantics):

- **Missing table**: Created from the declared `CREATE TABLE` statement.
- **Missing column**: Added to the existing table (`NOT NULL` without a `DEFAULT` value on an existing non-empty table is rejected).
- **Extra column / extra table**: Physically dropped, permanently deleting its data.
- **Explicit indexes**: Obsolete or modified indexes are dropped prior to column and table drops; missing or updated indexes are created.
- **Column rename**: Treated as dropping the old column (deleting its data) and adding a new column.
- **Non-DDL statements**: Statements other than `CREATE TABLE` and `CREATE [UNIQUE] INDEX` (such as `INSERT OR IGNORE ...`) execute in document order after schema reconciliation.
- **Isolation & lifecycle independence**: Each blueprint ID maps to an isolated SQLite database (`<data>/<id>/<mode>/db.sqlite`), with `dev` and `prod` stored separately. Deleting an `.html` file preserves its database; restoring an `.html` file with the same blueprint ID reconnects to the existing database.

## 3. Schema Safety Cautions

- **Prefer additive changes**: Add new tables or nullable/defaulted columns.
- **Dropping a column or table permanently deletes its data (no automatic backup)**: Removing a column or table from `CREATE TABLE` / `<script type="blueprint/def">` causes the next schema reconciliation (`bp reload`, `bp sql <file.html>`, or `bp run <file.html>`) to drop it permanently without any automatic backup.
- **Renaming a column equals drop + add**: Declarative reconciliation cannot detect column renames; back up or migrate data explicitly before renaming `old_col` to `new_col`.
- **Adding `NOT NULL` columns**: When adding a `NOT NULL` column to an existing table that may already have rows, always include a `DEFAULT` clause.

## 4. Access Boundaries

| Accessor | Contract |
|---|---|
| **Backend scripts (`blueprint/js`, `blueprint/sh`)** | Must not open `.sqlite` files directly; route all reads and writes through `<script type="blueprint/sql">` nodes ([`flow.md`](flow.md)) or `bp sql`, and do not hand-edit files under `<data>/<id>/`. |
| **Frontend `window.bp.sql`** | Strictly read-only SQL query interface (`SELECT` / `WITH ... SELECT` / `PRAGMA table_info(...)`) served by the daemon client ([`daemon.md`](daemon.md)). All UI writes must trigger backend flows via `bp.emit(...)`. |
| **Frontend `window.bp.watch`** | Live subscription interface accepting a plain table name (`bp.watch("notes", cb)`) or a conditional read-only `SELECT` / `WITH ... SELECT` query (`bp.watch("SELECT * FROM messages ORDER BY id DESC LIMIT 50", cb)`), auto-refreshed on backend writes ([`daemon.md`](daemon.md)). |

## 5. `bp sql` Command

Use `bp sql` for querying and modifying blueprint data during development or inspection. Default data directory is `$BP_DATA` or `~/.engineer-blueprint/data` (override with `--data <dir>`). Default mode is `prod`; pass `--dev` for isolated development storage, and `--json` for structured JSON output.

```bash
bp sql <file.html|id> "<statement>" [--dev] [--data <dir>] [--json]
```

- When passed a `.html` file path, `bp sql` reconciles `<script type="blueprint/def">` automatically before executing `<statement>`.
- When passed a bare blueprint ID, `bp sql` executes `<statement>` directly against the already-initialized `<data>/<id>/<mode>/db.sqlite` database.
- When `<statement>` writes data (or reconciles schema changes), `bp sql` performs a best-effort notification to the running daemon (`/_bp/notify-change`) so open `bp.watch(...)` subscribers refresh immediately.
