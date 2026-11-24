# Blueprint Daemon 与前端实时能力技能（`bp up` / `window.bp`）

[English](../daemon.md) · [技能首页](README.md) · [Def 模块](def.md) · [Flow 模块](flow.md) · [JS 模块](js.md) · [SH 模块](sh.md) · [AI 模块](ai.md)

本指南规定如何使用常驻 `bp` Daemon（`bp up`、`bp down`、`bp reload`、`bp emit`、`bp logs`），在 `127.0.0.1:7500` 托管单文件蓝图界面、调度 `every` 定时流程以及在前端使用 `window.bp` WebSocket 接口。

## 1. Daemon 生命周期与 CLI 命令

默认数据目录为 `$BP_DATA` 或 `~/.engineer-blueprint/data`（可通过 `--data <dir>` 覆盖）。

```bash
bp up [dir] [--port <n>] [--bind <host>] [--data <dir>] [--foreground] [--model <name>] [--ollama <url>] [--json]
bp down [--data <dir>] [--json]
bp reload [slug] [--dev] [--data <dir>] [--json]
bp emit <slug> <event> [json-data] [--dev] [--data <dir>] [--json]
bp logs <slug> [--dev] [--limit <n>] [--data <dir>] [--json]
```

- **`bp up [dir]`**：针对单个包含 `*.html` 蓝图的目录启动常驻 HTTP/WebSocket Daemon（默认监听 `127.0.0.1:7500`）。不传 `dir` 时优先沿用 `config.json` 中保存的目录，若无记录则回退并自动创建 `$BP_DIR` 或 `~/.engineer-blueprint/blueprints`；启动后会将 `{ dir, bind, port }` 写入 `config.json`，服务就绪后写入 `daemon.json`（`{ pid, bind, port, dir, startedAt }`），并自动清理已失效的陈旧 `daemon.json`。
  - 启动时全量加载 **`prod`** 模式蓝图：解析 → `syncBlueprint` → 启动 `every` 定时器 → 后台异步运行 `init` Flow 并记入日志。
  - **`dev`** 模式按需懒加载，仅在访问 `/bp-dev/<slug>`、执行 `bp reload [slug] --dev` 或 `bp emit <slug> ... --dev` 时加载。
- **`bp down`**：停止全部 `every` 定时器、关闭所有 WebSocket 连接、停服并删除 `daemon.json`。
- **`bp reload [slug] [--dev]`**：基于 SHA-256 摘要检测文件变更（同步 `<script type="blueprint/def">` 表结构、重建 `every` 定时器、卸载已删除蓝图，并向对应 WebSocket 客户端推送 `{ op: "reload" }` 自动刷新页面）。若重载蓝图解析或同步失败，退出码为 `1`。
- **`bp emit <slug> <event> [json-data] [--dev]`**：向运行中的 Daemon 触发匹配的 `on="<event>"` Flow，并将事件与 `bp.watch` 变更推送至在线浏览器页面；Daemon 未运行时会明确报错（离线单次执行请用 `bp run`）。
- **`bp logs <slug> [--dev] [--limit <n>]`**：读取 Daemon 为每个 `(slug, mode)` 维护的 200 条内存环形日志缓冲区（含加载/重载、后台 `init`、定时触发、Flow 启停、节点状态与 `emit` 记录）。

## 2. 概览页、路由与 HTML 渲染

- **概览页（`GET /`，默认 `http://127.0.0.1:7500`）**：按字母序展示目录下所有 `*.html` 蓝图的 `<title>`、`slug`（去 `.html` 文件名）、蓝图 ID、`/bp/<slug>`（`prod`）与 `/bp-dev/<slug>`（`dev`）链接，以及解析/同步错误横幅。
- **蓝图页面（`GET /bp/<slug>` 与 `GET /bp-dev/<slug>`）**：
  - 自动剥离全部 `<script type="blueprint/...">...</script>` 块，完整保留 HTML 注释与前端 `<script>` 标签。
  - 在文档顶部注入 `<script src="/bp/<slug>/bp.js"></script>`（或 `/bp-dev/<slug>/bp.js`），保证 `window.bp` 在任意 `<body>` 内联脚本运行前已就绪。
  - 若蓝图存在解析或表结构同步错误，返回 HTTP `500` 可读错误页面。
- **自动刷新浏览器（无角落按钮）**：`bp.js` 不向页面插入任何角落重载按钮或 DOM 元素；执行 `bp reload` 后收到 `{ op: "reload" }` 会自动调用 `location.reload()`。

## 3. 前端 `window.bp` 接口

`bp.js` 通过单条统一 WebSocket（`WS /bp/<slug>/ws` 或 `WS /bp-dev/<slug>/ws`，支持断线自动重连并恢复 `watch` 订阅）暴露以下接口：

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

| 成员 | 契约说明 |
|---|---|
| `bp.mode` | `"prod"`（`/bp/<slug>`）或 `"dev"`（`/bp-dev/<slug>`）。 |
| `bp.emit(event, data)` | 通过 WS 发送 `{ op: "emit", event, data }`，返回 `Promise`，在匹配的 `on="<event>"` Flow 完成后 resolve。 |
| `bp.on(event, cb)` | 订阅服务端推送的 `{ op: "event", event, source, data, time }` 事件（来源含 `ui`、`cli`、`flow`）；返回取消订阅函数。 |
| `bp.watch(query, cb)` | 支持纯表名（`^[A-Za-z_][A-Za-z0-9_]*$`）或单条只读 `SELECT` / `WITH ... SELECT` 查询；初始返回当前行数组，并在 Flow SQL 写库或 `bp sql` 写库通知后自动重查推送 `{ op: "change", query, rows }`；返回取消订阅函数。 |
| `bp.sql(sql, params)` | **严格只读** SQL 查询（`SELECT`、`WITH ... SELECT` 或 `PRAGMA table_info(...)`），支持 `:name` / `$name` / `@name` 对象或位置参数数组 `[...]`；返回 `Promise<rows>`，拒绝一切写操作、DDL 与多语句 SQL。 |

## 4. `every="..."` 定时表达式格式

在 `<script type="blueprint/flow" every="...">` 中，Daemon 支持三类调度表达式：

- **间隔时长**：`<n>s`、`<n>m`、`<n>h`（如 `1s`、`30s`、`5m`、`1h`）。
- **每日固定时刻**：24 小时制 `HH:MM`（如 `09:00`）。
- **标准 5 段 Cron**：`minute hour dom month dow`（如 `*/5 * * * *`）。
