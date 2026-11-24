# Blueprint 典型使用场景（打开展示与编写调试）

[English](../workflows.md) · [技能首页](README.md) · [Def 模块](def.md) · [Flow 模块](flow.md) · [JS 模块](js.md) · [SH 模块](sh.md) · [AI 模块](ai.md) · [Daemon 模块](daemon.md)

日常使用 Engineer Blueprint 分为两个核心场景：**对外展示（用户可见）** 与 **开发调试（用户无感）**，两者选用的浏览器方式不同。

---

## 1. 打开蓝图（面向用户展示）

适用于蓝图已就绪、需要将页面直接呈现给用户查看或使用的场景：

1. **确保 Daemon 运行**：若尚未启动，执行 `bp up [dir]`（不传 `dir` 时默认读取 `config.json`、`$BP_DIR` 或自动创建的 `~/.engineer-blueprint/blueprints`，默认监听 `http://127.0.0.1:7500`）。
2. **用用户可见的浏览器打开**：使用**系统默认浏览器**或 **IDE 内置浏览器**打开链接，直接展示给用户：
   - **概览页**：`http://127.0.0.1:7500`（列出目录下全部蓝图及 `prod` / `dev` 入口）
   - **正式环境**：`http://127.0.0.1:7500/bp/<slug>`
   - **开发环境**：`http://127.0.0.1:7500/bp-dev/<slug>`

---

## 2. 编写与调试蓝图（尽量用户无感）

适用于新建或修改 `.html` 蓝图并在 `dev` 环境下闭环联调的场景。**调试阶段应尽量不打扰用户（避免频繁弹窗抢占前台）**：

1. **按模块编写 `.html`**（若用户未指定目录，默认保存到 `~/.engineer-blueprint/data/config.json` 记录的目录，否则保存到 `~/.engineer-blueprint/blueprints/`）：
   - 在 `<head>` 声明 `<meta name="bp:id" content="<id>">` 与 `<title>`；
   - 在 `<script type="blueprint/def">` 定义 SQLite 表结构与初始数据（[`def.md`](def.md)）；
   - 在 `<script type="blueprint/flow">` 编写自然语言流程，并按需声明 `blueprint/js`、`blueprint/sh`、`blueprint/sql`、`blueprint/ai`、`blueprint/emit` 节点（[`flow.md`](flow.md)）；
   - 在 `<body>` 编写前端界面与 `window.bp` 交互（`bp.watch`、`bp.emit`、`bp.on`、[`daemon.md`](daemon.md)）。
2. **启动或热重载进入 `dev` 环境**：
   - 首次运行 `bp up [dir]`；修改 `.html` 后执行 `bp reload <slug> --dev`（自动同步 `.dev.sqlite`、重启 `every` 定时器并触发刷新）。
3. **无感浏览器 + CLI 协同调试**：
   - **后台页面验证**：优先使用 `ego-lite`（`ego-browser`）、内置自动化浏览器或 `browser-use` 等**用户无感**的浏览器工具打开 `http://127.0.0.1:7500/bp-dev/<slug>` 检查渲染、控制台报错与交互（具体使用哪种调试浏览器也可与用户商议）。
   - **触发事件**：`bp emit <slug> <event> '<json>' --dev` —— 直接触发后端 `on` Flow，验证数据库变更及界面 `bp.watch` / `bp.on` 实时推送。
   - **检查/修改数据**：`bp sql <slug> "<SQL语句>" --dev` —— 查询入库结果，或手动写入数据验证前端 `bp.watch` 刷新。
   - **排查日志**：`bp logs <slug> --dev` —— 查看 `qwen3.5:9b` 路由决策、节点执行结果与报错信息（离线单步验证也可用 `bp run <file.html> <event> '<json>' --dev`）。
