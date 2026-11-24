# Blueprint SH 动作节点技能（`<script type="blueprint/sh">`）

[English](../sh.md) · [技能首页](README.md) · [Flow 模块](flow.md) · [Def 模块](def.md) · [JS 模块](js.md) · [AI 模块](ai.md) · [Daemon 模块](daemon.md)

本指南规定如何在 `<script type="blueprint/flow">` 工作流中编写 Shell 后端动作节点（`<script type="blueprint/sh">`）。

## 1. 声明语法

```html
<script type="blueprint/sh" id="summarize" desc="从 stdin 读取全量 ctx JSON 执行 shell 逻辑">
CTX_JSON=$(cat)
echo "$CTX_JSON" | jq -c '{ branch: .event.data.branch, prev: .steps.clean.output }'
</script>
```

- **`id`**（必填）：在当前文档全部后端动作节点中唯一（禁止使用 `"done"`）。
- **`desc`**（可选）：节点职责描述，供 Flow 路由模型参考。
- **`<\/script>` 还原**：写入脚本前会自动将正文中的 `<\/script>` 还原为 `</script>`。

## 2. 运行时契约

- **执行方式**：将脚本正文写入 `fs.realpathSync(os.tmpdir())` 下的唯一临时 `.sh` 文件，执行 `sh <tmpFile>`，并在 `finally` 中清理临时目录。
- **`stdin` 与环境变量**：通过 `stdin` 接收完整、未截断的 `JSON.stringify(ctx)`；**不注入任何隐式 `BP_IN_*` 环境变量**。
- **SQLite 访问边界**：**禁止直接打开 `.sqlite` 文件**；所有数据库读写均须经由 `<script type="blueprint/sql">` 节点（[`flow.md`](flow.md)）或 `bp sql`（[`def.md`](def.md)）执行。
- **输出与退出码处理**：
  - **退出码为 `0`**：对 `stdout` 执行 `.trim()`；若非空且为合法 JSON（`JSON.parse`），直接返回解析后的 JSON 值；否则返回 `{ text: trimmed }`（空输出返回 `{ text: "" }`）。
  - **退出码非 `0`**：以 `stderr.trim() || "sh exited with code <N>"` 抛出异常，由 Flow 循环捕获并写入 `ctx.history`、`ctx.last` 与 `ctx.steps[id]`（`ok: false`、`output: null`、`error`）。
