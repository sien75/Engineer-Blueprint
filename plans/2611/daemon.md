# Engineer Blueprint Daemon 与实时前端设计

> **定位说明**：Daemon（`bp up` / `bp down`）是 Engineer Blueprint 的常驻运行时。它在单目录模式下管理全量蓝图生命周期：启动时全量加载 `prod`、按需懒加载 `dev`、驱动 `every` 定时调度与后台 `init`、通过单条统一 WebSocket 向浏览器 `window.bp` 推送实时事件与 `bp.watch` 变更，并在 `bp reload` 时触发增量热重载与页面自动刷新。

---

## 一、单目录生命周期与配置文件（`$BP_DATA`）

数据目录默认为 `$BP_DATA` 或 `~/.engineer-blueprint/data`（可通过 `--data <dir>` 覆盖）：

- **`config.json`（`{ dir, bind, port }`）**：记录最近一次 `bp up <dir>` 指定的单个蓝图目录及监听地址（默认 `bind = "127.0.0.1"`、`port = 7500`）。后续执行无参 `bp up` 时自动沿用保存的目录与配置；若首次启动未传 `dir` 且无历史配置，则回退并自动创建 `$BP_DIR` 或 `~/.engineer-blueprint/blueprints`。
- **`daemon.json`（`{ pid, bind, port, dir, startedAt }`）**：在 `Bun.serve` 成功监听后写入，正常 `bp down` / `SIGINT` / `SIGTERM` 时清理。若文件存在但 `process.kill(pid, 0)` 失败或 `/_bp/health` 不可达，视作陈旧状态文件自动清理。
- **启动与停止**：
  - `bp up [dir] [--port <n>] [--bind <host>] [--foreground]`：默认以分离（detached）子进程启动并轮询 `/_bp/health` 就绪后退出；若已有健康 Daemon 在运行则拒绝重复启动。
  - `bp down`：请求 `POST /_bp/shutdown`，停止全部定时任务、关闭所有 WebSocket、停服并删除 `daemon.json`。

---

## 二、HTTP 页面路由、HTML 剥离与概览页

### 1. 概览页（`GET /`，默认 `http://127.0.0.1:7500`）

扫描目录内按字母序排列的 `*.html`（`slug` 为去掉 `.html` 的文件名），展示每份蓝图的：
- 页面 `<title>`、`slug`、蓝图 ID（`<meta name="bp:id">` / `<meta id>`）；
- `/bp/<slug>`（`prod`）与 `/bp-dev/<slug>`（`dev`）访问链接；
- 解析或表结构同步失败时的错误提示横幅。

### 2. 蓝图页面与客户端脚本剥离/注入

- **`prod` 与 `dev` 加载策略**：
  - `prod`：Daemon 启动时扫描全部 `*.html`，依次执行解析 → `syncBlueprint` → 启动 `every` 定时器 → 在后台异步触发 `init` Flow 并记录日志。
  - `dev`：保持懒加载，仅在访问 `/bp-dev/<slug>`、执行 `bp reload [slug] --dev` 或 `bp emit <slug> ... --dev` 时加载到内存。
- **`renderBrowserHtml(html, bpJsPath)`**：
  - 精确剥离全部 `<script type="blueprint/...">...</script>` 声明块（完整保留前端 `<script>` 与 HTML 注释）。
  - 在文档顶部（优先 `<head>` 开头，否则紧跟 `<!doctype html>` 或文档最前）注入 `<script src="/bp/<slug>/bp.js"></script>`（或 `/bp-dev/<slug>/bp.js`），确保 `window.bp` 在任意 `<body>` 内联脚本执行前就绪。
  - 若蓝图存在解析或同步错误，访问 `/bp/<slug>` / `/bp-dev/<slug>` 直接返回 HTTP 500 可读错误页。

---

## 三、热重载（`bp reload`）与无按钮自动刷新

- **SHA-256 变更检测**：Registry 为每个 `(slug, mode)` 记录文件内容 SHA-256 摘要。
  - `bp reload`（不传 `slug`）：扫描目录中的新增、删除或摘要变化的 `.html` 文件（同时刷新已加载且发生变更的 `dev` 蓝图），仅对变更/新增项重新解析、`syncBlueprint`、重建 `every` 定时器并卸载已删除蓝图。
  - `bp reload <slug> [--dev]`：强制重载指定蓝图（并触发 `dev` 懒加载）。
- **静默自动刷新（无角落按钮）**：`client.js` 不向页面注入任何角落重载按钮或 DOM 元素；重载成功后 Daemon 向该 `(slug, mode)` 的全部 WS 客户端广播 `{ op: "reload" }`，前端收到后直接调用 `location.reload()`。

---

## 四、单条统一 WebSocket 与 `window.bp`

每个页面仅维护一条 WebSocket 连接（`WS /bp/<slug>/ws` 或 `WS /bp-dev/<slug>/ws`，断线自动指数退避重连并恢复 `watch` 订阅）：

| 方向 | 协议消息 | 语义与安全约束 |
|---|---|---|
| Client → Server | `{ id?, op: "emit", event, data }` | 校验非空 `event`，广播 `{ op: "event", source: "ui", ... }`，执行匹配的 `on="<event>"` Flow，实时推送 `blueprint/emit` 事件与 `watch` 数据变更。 |
| Client → Server | `{ id?, op: "watch", query }` | 仅允许纯表名（`^[A-Za-z_][A-Za-z0-9_]*$`）或单条只读 `SELECT` / `WITH ... SELECT`；对 `<data>/<id>/<mode>/db.sqlite` 以只读连接执行并订阅，返回初始 `rows`。 |
| Client → Server | `{ id?, op: "unwatch", query }` | 取消该连接对指定 `query` 的变更推送订阅。 |
| Client → Server | `{ id?, op: "sql", sql, params }` | **严格只读**（仅允许单条 `SELECT`、`WITH ... SELECT` 或 `PRAGMA table_info(...)`，配合只读 SQLite 连接双重兜底），支持 `:name` 命名参数与位置数组参数。 |
| Server → Client | `{ op: "event" \| "change" \| "reload" \| "error", ... }` | 分别用于前端事件通知、`bp.watch` 增量重查推送、页面重载与错误提示。 |

前端 `window.bp` 暴露五个成员：`bp.emit(event, data)`、`bp.on(event, cb)`、`bp.watch(query, cb)`、`bp.sql(sql, params)`、`bp.mode`（`"prod"` / `"dev"`）。

---

## 五、CLI 运行时命令分工与 `every` 调度器

- **`bp emit <slug> <event> [json] [--dev]` vs `bp run <file.html> ...`**：
  - `bp emit` 通过运行中的 Daemon 触发事件（Daemon 未运行时明确报错提示先执行 `bp up`），与运行中定时器、WS 事件广播及 `bp.watch` 推送联动。
  - `bp run` 为离线单次执行入口，直接读取单个 `.html` 文件同步表结构并执行一次 Flow。
- **`bp sql` 写库联动**：`bp sql` 在执行写入或引发 DDL 变更后，尽最大努力调用 `POST /_bp/notify-change`，使打开着 `bp.watch` 的浏览器页面即时刷新。
- **`bp logs <slug> [--dev] [--limit <n>]`**：Daemon 在内存中为每个 `(slug, mode)` 维护最多 **200 条**的环形日志缓冲区（记录时间、加载/重载、后台 `init`、定时调度、Flow 启停、节点执行状态/错误与 `emit` 事件）。
- **`every="..."` 调度器（`cli/src/schedule.js`）**：支持三种表达式——间隔时长（`<n>s` / `<n>m` / `<n>h`）、每日固定时间（`HH:MM`，24 小时制）以及标准 5 段 Cron（`minute hour dom month dow`），并在并发重叠防护下执行；重载或 `bp down` 时统一清理全部定时器。
