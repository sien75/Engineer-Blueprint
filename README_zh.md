# Engineer-Blueprint

[English](README.md)

**Engineer-Blueprint** 是一套轻量级规范与工具集，用于在单文件 `.html` 蓝图中直接嵌入声明式 SQLite 表结构、初始数据、自然语言后端工作流，并通过常驻 HTTP/WebSocket Daemon 托管实时界面与定时任务。

## 前置依赖

- **`bun` 与 `sqlite`**：用于运行 `bp` CLI、Daemon 与本地 SQLite 持久化存储。
- **`ollama`（`qwen3.5:9b` 模型）**：用于执行自然语言流程决策路由。
- **`agy` CLI（可选）**：运行 `<script type="blueprint/ai" cli="agy">` 节点时需要。

## 安装

复制以下提示词并发送给你的编程 Agent，即可在本地机器上安装 Engineer-Blueprint：

> 请基于当前仓库为我安装配置 Engineer-Blueprint。首先检查本机是否已安装并可正常使用 `bun`、`sqlite` 与 `ollama`，确认 `ollama` 正在运行，并确保本地已拉取且可用 `qwen3.5:9b` 模型（用于自然语言流程决策路由；如有缺失，请协助安装、拉取或向我报告）。接着，从 `cli/` 目录安装 CLI 工具（将其 `bp` 可执行文件链接或暴露到全局路径，以便直接调用 `bp`），并将 `skill/zh/`（`skill/zh/README.md`、`skill/zh/def.md`、`skill/zh/flow.md`、`skill/zh/js.md`、`skill/zh/sh.md`、`skill/zh/ai.md`、`skill/zh/daemon.md` 与 `skill/zh/workflows.md`，对应英文目录为 `skill/`）中的 Agent Skill 安装到我本地的 agent skills 目录中（例如 `~/.agents/skills/engineer-blueprint/`）。最后，运行 CLI 测试套件、验证 `bp` 命令正常响应并确认 `ollama` 与 `qwen3.5:9b` 就绪，以确保全部组件工作正常。

## 目录结构

- **[`skill/`](skill/zh/README.md)** — **规范与 Agent Skill**（英文原版 [`skill/README.md`](skill/README.md)）：Blueprint `.html` 文档结构、声明式 `<script type="blueprint/def">` SQLite Schema 规范（[`def.md`](skill/zh/def.md)）、`<script type="blueprint/flow">` 编排与 SQL/事件节点规范（[`flow.md`](skill/zh/flow.md)）、`<script type="blueprint/js">`（[`js.md`](skill/zh/js.md)）、`<script type="blueprint/sh">`（[`sh.md`](skill/zh/sh.md)）、`<script type="blueprint/ai">`（[`ai.md`](skill/zh/ai.md)）、常驻 Daemon 与前端 `window.bp` 接口规范（[`daemon.md`](skill/zh/daemon.md)）及典型使用场景指南（[`workflows.md`](skill/zh/workflows.md)）。
- **[`cli/`](cli/)** — **Bun CLI 与 Daemon**：基于 `bun:sqlite` 与 `Bun.serve` 构建的零依赖 `bp` 工具，提供 `bp up` / `bp down`（常驻服务与定时调度）、`bp reload`（增量热重载）、`bp emit`（触发事件）、`bp sql`（读写 SQLite）、`bp logs`（查看日志）与 `bp run`（离线单次执行）。
- **[`plans/2611/`](plans/2611/)** — **设计笔记**：各子系统的架构设计与决策说明（[`sql.md`](plans/2611/sql.md)、[`flow.md`](plans/2611/flow.md)、[`ai.md`](plans/2611/ai.md)、[`daemon.md`](plans/2611/daemon.md)）。
