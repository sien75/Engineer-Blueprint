# Blueprint Flow 编排模块技能（`<script type="blueprint/flow">`）

[English](../flow.md) · [技能首页](README.md) · [Def 模块](def.md) · [JS 模块](js.md) · [SH 模块](sh.md) · [AI 模块](ai.md) · [Daemon 模块](daemon.md)

本指南规定自然语言流程（`<script type="blueprint/flow">`）、SQL 与事件动作节点（`blueprint/sql`、`blueprint/emit`）的编写规范，以及离线单次执行命令 `bp run` 的用法（常驻 Daemon 模式与 `bp emit` 见 [`daemon.md`](daemon.md)）。

## 1. 编写 `<script type="blueprint/flow">`

每个 `<script type="blueprint/flow">` 代码块用自然语言声明业务路由规则，由云端 Jev 决策模型（默认通过 `https://api.typesafe.ai/v1/systemone` 调用 `jev-1.14`）逐步决定下一个执行节点：

- **必须且只能声明一个触发属性**：
  - `on="<event>"`：响应 `bp.emit(...)`、`bp emit <slug> <event>` 或离线 `bp run <file.html> <event>` 触发。
  - `init`（布尔属性，如 `<script type="blueprint/flow" init>`）：在 Daemon 首次加载时于后台异步运行，或通过离线 `bp run <file.html> --init` 显式执行。
  - `every="<schedule>"`：由常驻 Daemon（`bp up` / `bp reload`）按计划定时触发，支持 `<n>s`/`<n>m`/`<n>h`、`HH:MM` 与 5 段 Cron（详见 [`daemon.md`](daemon.md)；离线 `bp run` 不执行定时任务）。
- **正文非空与转义**：禁止纯空白 Flow 正文；块内 `<\/script>` 会自动还原为 `</script>`。
- **同触发器多 Flow**：若同一 `on` 事件或 `init` 匹配多个 Flow 块，按文档出现顺序依次独立运行。

```html
<script type="blueprint/flow" on="note:create">
1. 先执行 clean 校验并整理笔记正文。
2. 若 clean 返回 valid=true，执行 save-note 持久化写入，然后选择 done 结束。
3. 若 clean 返回 valid=false 或执行失败，执行 reject，然后选择 done 结束。
</script>
```

## 2. 后端动作节点（Action Nodes）

在 `.html` 文件中声明可执行的后端动作节点。所有动作节点必须满足：

- 必须声明唯一且非空的 `id`，匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
- **禁止使用 `"done"` 作为节点 `id`**（`"done"` 为决策循环结束的保留字）。
- 可选声明 `desc="..."` 属性，用于向决策路由模型说明节点用途。
- 正文中的 `<\/script>` 会自动还原为 `</script>`。

（`blueprint/def`、`blueprint/flow`、`blueprint/init.*` 与前端 `<script>` 标签不会进入动作节点列表。）

### 节点类型索引

- **`blueprint/js`**：纯 ES Module 动作节点（`export default async (ctx) => ...`）——详见 [`js.md`](js.md)。
- **`blueprint/sh`**：Shell 脚本动作节点（从 `stdin` 读取全量 `ctx` JSON）——详见 [`sh.md`](sh.md)。
- **`blueprint/ai`**：基于 ACP 的无状态 AI CLI 动作节点（`protocol="acp"`、`cli="..."`）——详见 [`ai.md`](ai.md)。
- **`blueprint/sql`** 与 **`blueprint/emit`**：规范如下。

### `blueprint/sql`

```html
<script type="blueprint/sql" id="save-note" desc="将校验后的笔记写入 SQLite">
INSERT INTO notes (id, body) VALUES (:id, :body);
</script>
```

- 在 `<script type="blueprint/def">` 表结构同步时会被忽略（[`def.md`](def.md)），仅作为 Flow 动作节点对 `<data>/<id>/<mode>/db.sqlite` 执行。
- **命名参数绑定**：扫描每条 SQL 语句中的 `:name`、`$name`、`@name` 占位符（忽略注释与字符串字面量），**仅提取语句实际出现的参数键**进行绑定。参数源优先级为：
  1. 若 `ctx.last?.output` 为普通对象，使用 `ctx.last.output`；
  2. 否则若 `ctx.event?.data` 为普通对象，使用 `ctx.event.data`；
  3. 否则使用 `{}`。
- **返回值**：
  - 查询语句（`SELECT`、`PRAGMA`、`INSERT/UPDATE/DELETE ... RETURNING *`）：直接返回结果行数组（如 `ctx.last.output[0]`）。
  - 写入语句（无 `RETURNING` 的 `INSERT`、`UPDATE`、`DELETE`）：返回 `{ changes, lastInsertRowid }`（如 `ctx.last.output.changes`）。

### `blueprint/emit`

```html
<script type="blueprint/emit" id="reject" event="note:rejected" desc="发出拒绝事件"></script>
```

- 必须声明非空 `event="<event-name>"` 属性。
- 以 `data = ctx.last?.output ?? ctx.event?.data ?? null` 作为负载记录 `{ event: "<event-name>", data }` 至 `emittedEvents`（在 Daemon 模式下同时向在线浏览器的 `bp.on` 监听方广播），并返回 `{ emitted: "<event-name>", data }`。

## 3. 共享 `ctx`、决策视图、异常捕获与步数保护

### 共享 `ctx`（全量未截断）

每个下游动作节点都会收到完整、未截断的 `ctx` 克隆对象：

```js
{
  event: { type: eventName, data: eventData },
  last: null,       // 上一步 { node, ok, output, error }
  steps: {},        // nodeId -> 最近一次执行的 { ok, output, error }
  history: []       // 按执行顺序记录的 [{ step, node, ok, output, error }]
}
```

### Jev 决策路由与 500 字符截断

每一轮决策都会通过 Jev System One 的 `choice` 问题从 `[...nodeIds, "done"]` 中选择下一步（读取 `answers.next.choice`），并同时回答 `questions.last`（`yes` / `no`）：为 `yes` 时执行完所选节点立即结束，不再发起下一轮决策（`done` 保留，用于需要依据结果判断结束或无事可做的情况）。决策 `state` 包含：

1. Flow 自然语言指令正文；
2. 触发事件 `type` 与 JSON 序列化后**截断至最多 500 字符**的 `data`；
3. 有序执行进度（`#1 <node> [ok]: <预览>` 或 `#1 <node> [error]: <预览>`，首步为 `(none yet)`），每条预览**截断至最多 500 字符**；
4. 全部可选节点 `id`（含 `desc`）及 `done`。

> 500 字符截断**仅作用于路由决策提示词**，动作节点内部的 `ctx` 始终保持全量未截断。

### 异常处理与循环上限

- **节点异常不直接崩溃流程**：若动作节点抛出错误，运行时会捕获异常并向 `ctx.history`、`ctx.last` 与 `ctx.steps[nodeId]` 写入 `{ step, node, ok: false, output: null, error: err.message }`，使后续决策能够路由至错误处理节点或 `done`。
- **`maxSteps` 循环上限**：默认最多 `16` 轮（可通过 `--max-steps <n>` 修改）。若在上限内未选择 `"done"`，将立即中止并抛出附带已执行步骤轨迹的错误。

## 4. 编写自检规则

编写包含 Flow 的蓝图后，务必逐项核对以下四条自检规则：

1. **Flow 文本中显式写出准确节点 `id`**：明确点出节点名（如 `clean`、`save-note`、`reject`、`done`），避免“校验一下并入库”等模糊表述。
2. **分支条件互斥且覆盖失败情形**：确保条件分支互斥、无歧义，并明确包含某步失败（`[error]`）或校验不通过时的兜底路径。
3. **每条分支都必须有明确的 `done` 终点**：保证任意路径都能收敛至 `done`，避免死循环。
4. **核对上下游字段名与 SQL `:param` 绑定**：逐一检查下游脚本读取的 `ctx.steps["<id>"].output.*`、`ctx.last.output.*` 以及 `blueprint/sql` 中的 `:param` / `$param` / `@param` 键名是否与上游节点实际返回的字段一致（注意普通写入 SQL 节点返回的是 `{ changes, lastInsertRowid }`，若后续 SQL 需要原记录字段，请使用 `RETURNING *` 或衔接 JS 节点透传）。

## 5. `bp run`（离线单次执行）与 `bp emit`（Daemon）

在常驻 Daemon 中运行流程（含 `every` 定时调度与 WebSocket 推送）请使用 `bp up` + `bp emit`（见 [`daemon.md`](daemon.md)）。若需针对单个 `.html` 文件直接离线执行一次流程，使用 `bp run`：

```bash
bp run <file.html> <event> [json-data] [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]
bp run <file.html> --init [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]
```

- 执行匹配 Flow 前会自动根据 `<script type="blueprint/def">` 同步 `<data>/<id>/<mode>/db.sqlite` 表结构。
- `--dev` 指向开发环境数据库；`--data <dir>` 覆盖 `$BP_DATA` / `~/.engineer-blueprint/data`。
- `--jev-url` 覆盖 `$BP_JEV_URL`（默认 `https://api.typesafe.ai/v1`）；`--jev-model` 覆盖 `$BP_JEV_MODEL`（默认 `jev-1.14`）；`--jev-key` 覆盖 `$BP_JEV_API_KEY` / `$JEV_API_KEY`。
- `--max-steps <n>` 设置最大决策轮数（正整数，默认 `16`）；`--json` 输出结构化 JSON 结果。
