# Blueprint SH Action Node Skill (`<script type="blueprint/sh">`)

[中文](zh/sh.md) · [Skill Index](README.md) · [Flow Module](flow.md) · [Def Module](def.md) · [JS Module](js.md) · [AI Module](ai.md) · [Daemon Module](daemon.md)

Specification and operational guide for authoring shell backend action nodes (`<script type="blueprint/sh">`) inside `<script type="blueprint/flow">` workflows.

## 1. Declaration Syntax

```html
<script type="blueprint/sh" id="summarize" desc="Inspect ctx JSON via shell">
CTX_JSON=$(cat)
echo "$CTX_JSON" | jq -c '{ branch: .event.data.branch, prev: .steps.clean.output }'
</script>
```

- **`id`** (required): Unique backend action node ID within the document (cannot be `"done"`).
- **`desc`** (optional): Concise purpose summary shown to the flow decision router.
- **`<\/script>` unescaping**: Escaped `<\/script>` sequences in the body are unescaped to `</script>` before writing the script file.

## 2. Runtime Contract

- **Execution**: Writes the script body to a unique temporary `.sh` file under `fs.realpathSync(os.tmpdir())`, executes `sh <tmpFile>`, and cleans up the temporary directory in `finally`.
- **`stdin` & environment**: Receives full, untruncated `JSON.stringify(ctx)` on `stdin`; **no implicit `BP_IN_*` environment variables** are injected.
- **SQLite isolation**: Must **not** open `.sqlite` files directly; route all database reads and writes through `<script type="blueprint/sql">` nodes ([`flow.md`](flow.md)) or `bp sql` ([`def.md`](def.md)).
- **Output & exit handling**:
  - **Exit code `0`**: Trims `stdout`; if non-empty and valid JSON (`JSON.parse`), returns the parsed JSON value; otherwise returns `{ text: trimmed }` (empty stdout yields `{ text: "" }`).
  - **Non-zero exit code**: Throws an error using `stderr.trim() || "sh exited with code <N>"`, which the flow loop catches and records in `ctx.history`, `ctx.last`, and `ctx.steps[id]` (`ok: false`, `output: null`, `error`).
