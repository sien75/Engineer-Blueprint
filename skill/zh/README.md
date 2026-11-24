---
name: engineer-blueprint
description: 使用声明式 blueprint/* 代码块、bp Daemon/CLI 与 window.bp 编写及操作单文件 HTML Engineer Blueprint。
---

# Engineer Blueprint Skill

[English](../README.md)

单文件 `.html` Engineer Blueprint 的规范与操作技能。Blueprint 是一个自包含的单文件 `.html` 文档，由标准 HTML 元数据、声明式 `<script type="blueprint/*">` 块以及文档 `<body>` 组成。

## 文档结构

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="bp:id" content="my-app" />
    <title>My Blueprint</title>
  </head>
  <body>
    <!-- 应用界面（Daemon 会自动注入 window.bp） -->

    <script type="blueprint/def">
      /* 声明式 SQLite 表结构与初始数据 */
    </script>

    <script type="blueprint/flow" on="note:create">
      /* 引用动作节点 ID 的自然语言流程指令 */
    </script>
    <script type="blueprint/js" id="clean">
      /* 纯 ES Module 动作节点：export default async (ctx) => ... */
    </script>
    <script type="blueprint/sh" id="inspect">
      /* Shell 脚本动作节点：从 stdin 读取全量 ctx JSON，输出 JSON 或文本 */
    </script>
    <script type="blueprint/sql" id="save-note">
      /* 绑定 ctx.last.output 或 ctx.event.data 的 SQL 动作节点 */
    </script>
    <script type="blueprint/ai" id="summarize" cli="agy">
      /* 可选角色提示词，仅在新开会话时拼接在 prompt 前 */
    </script>
    <script type="blueprint/emit" id="notify" event="note:saved"></script>
  </body>
</html>
```

- **`<!doctype html>`**：标准 HTML5 文档声明。
- **`<title>`**：面向用户的蓝图标题（展示于 Daemon 概览页）。
- **蓝图身份标识（`<meta name="bp:id" content="<id>">` 或 `<meta id="<id>">`）**：每个蓝图 `.html` 文档必须声明一个匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` 的唯一标识符（长度 1–64 个字符；必须以 ASCII 字母或数字开头，后续可包含 ASCII 字母、数字、`.`、`_` 或 `-`）。两种写法同时存在时，优先使用 `<meta name="bp:id" content="<id>">`；当前生效写法出现多个不同取值时视为非法。
- **声明式模块块（`<script type="blueprint/*">`）**：用于在 `.html` 文件内部声明数据表结构（`blueprint/def`）、自然语言编排规则（`blueprint/flow`）及后端动作节点（`blueprint/js`、`blueprint/sh`、`blueprint/sql`、`blueprint/emit`、`blueprint/ai`）的专用脚本块。
- **`<body>`**：蓝图界面的 HTML 标记、样式以及调用 `window.bp`（`bp.emit`、`bp.on`、`bp.watch`、`bp.sql`、`bp.mode`）的客户端脚本。

## 工作流概览

1. **在 `.html` 中编写声明与界面**：在 `.html` 文档中定义蓝图身份标识、`<script type="blueprint/*">` 代码块与前端界面（若用户未指定目录，默认保存到 `~/.engineer-blueprint/data/config.json` 记录的目录或 `~/.engineer-blueprint/blueprints/`）。
2. **通过 `bp` Daemon 与 CLI 操作运行时**：
   - **`bp up [dir]` / `bp down`**：启停常驻 HTTP/WebSocket Daemon 与调度器（不传 `dir` 时默认沿用 `config.json` 记录的目录、`$BP_DIR` 或自动创建的 `~/.engineer-blueprint/blueprints`，默认提供 `http://127.0.0.1:7500` 概览页、`/bp/<slug>` 与 `/bp-dev/<slug>`）。
   - **`bp reload [slug] [--dev]`**：检测 `.html` 变更，同步 `<script type="blueprint/def">` 表结构、重建 `every` 定时器并触发在线浏览器自动刷新。
   - **`bp emit <slug> <event> [json] [--dev]`**：向运行中的 Daemon 触发匹配的 `on="<event>"` Flow，并向浏览器推送事件与 `bp.watch` 更新。
   - **`bp sql <file.html|id> "<statement>" [--dev]`**：在开发调试阶段查询或修改蓝图 SQLite 数据（写操作会通知运行中的 Daemon 刷新 `bp.watch`）。
   - **`bp logs <slug> [--dev] [--limit <n>]`**：读取 Daemon 环形缓冲区中近期的 Flow、节点步骤、定时调度、`init` 与重载日志。
   - **`bp run <file.html> <event> [json] | --init`**：无需启动 Daemon，直接针对单个 `.html` 文件执行离线单次 Flow。
3. **显式选择环境与数据目录**：默认模式为 `prod`；传入 `--dev`（或访问 `/bp-dev/<slug>`）可使用隔离的开发环境存储。禁止直接打开 `.sqlite` 文件或手动修改 `<data>/blueprints/` 目录下的文件（默认 `$BP_DATA` 或 `~/.engineer-blueprint/data`，可用 `--data <dir>` 覆盖）。

## 模块指南

| 模块 | 指南 | 适用范围 |
|---|---|---|
| 典型使用场景 | [`workflows.md`](workflows.md) | 区分打开展示（系统/内置浏览器）与无感调试（`dev` 模式、`ego-lite`/`browser-use` 等 + `bp emit`/`sql`/`logs`）。 |
| `blueprint/def`（SQLite） | [`def.md`](def.md) | `<script type="blueprint/def">` 声明式 SQLite Schema/初始数据、同步生命周期、安全注意事项、访问边界及 `bp sql`。 |
| `blueprint/flow`（`sql` / `emit`） | [`flow.md`](flow.md) | `<script type="blueprint/flow">` 基于 `qwen3.5:9b` 的自然语言路由、`<script type="blueprint/sql">` 与 `<script type="blueprint/emit">` 节点、共享 `ctx`、自检规则及离线 `bp run`。 |
| `blueprint/js` | [`js.md`](js.md) | 纯 ES Module 后端动作节点（`export default async (ctx) => ...`）、`ctx` 隔离与异常捕获。 |
| `blueprint/sh` | [`sh.md`](sh.md) | Shell 脚本动作节点（`stdin` 读取全量 `ctx` JSON、JSON/文本输出归一化与非零退出码错误处理）。 |
| `blueprint/ai`（`cli="agy"`） | [`ai.md`](ai.md) | 无状态 AI CLI 动作节点、`{ prompt, session?, cwd? }` -> `{ text, session }` 契约、临时对话与 SQLite 续聊模式以及节点 `id` 清晰命名约定。 |
| Daemon 与 `window.bp` | [`daemon.md`](daemon.md) | `bp up`、`bp down`、`bp reload`、`bp emit`、`bp logs`、`127.0.0.1:7500` 概览页、`/bp/<slug>` 与 `/bp-dev/<slug>`、`every` 定时调度、自动刷新与前端 `window.bp` 接口。 |
