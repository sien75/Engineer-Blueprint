# Engineer Blueprint Flow 编排与动作节点设计

> **定位说明**：在 Engineer Blueprint 中，Flow 是面向单个 `.html` 蓝图的轻量级后端编排能力。蓝图作者使用自然语言编写 `<script type="blueprint/flow">` 流程规则，配合 `blueprint/js`、`blueprint/sh`、`blueprint/sql`、`blueprint/emit`、`blueprint/ai` 五类可声明动作节点，通过云端 TypeSafe Jev（`jev-1.14`）决策路由循环逐步推进执行，并由 `bp run` 统一入口自动同步表结构后运行。

---

## 一、HTML 声明规范

### 1. Flow 块（`<script type="blueprint/flow">`）

- **唯一触发属性**：每个 `<script type="blueprint/flow">` 块必须且只能声明以下三种触发属性之一：
  - `on="<event>"`：响应指定事件名。
  - `every="<schedule>"`：周期性定时调度（当前仅解析校验，**预留给后续 Daemon 调度执行**，`bp run` 暂不执行）。
  - `init`（布尔属性）：初始化引导流程，通过 `bp run <file.html> --init` 显式触发。
- **非空与转义**：Flow 正文不允许为空白字符；标签体内的 `<\/script>` 会自动还原为 `</script>`。若同一触发条件匹配多个 Flow 块，按文档出现顺序依次执行。

### 2. 动作节点（Action Nodes）

所有可执行后端动作节点均要求声明唯一且合法的 `id`（匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，且 **`"done"` 为保留字禁止用作节点 `id`**），可选声明 `desc="..."` 为决策模型提供语义提示：

| 节点类型 | 属性约束 | 运行时语义 |
|---|---|---|
| `<script type="blueprint/js" id="..." [desc="..."]>` | 必填 `id` | 纯 ES Module（`export default async (ctx) => output`，兼容 `export async function run(ctx)`）。仅接收 `(ctx)` 单一参数，不注入 `bp` 对象；通过临时独立目录 `.mjs` 文件动态 `import()` 执行后立即清理，避免 Bun ESM 缓存。返回 `undefined` 时规范化为 `null`。 |
| `<script type="blueprint/sh" id="..." [desc="..."]>` | 必填 `id` | 必选代码动作节点：将正文写入 `fs.realpathSync(os.tmpdir())` 下的唯一临时 `.sh` 文件并执行 `sh <tmpFile>`，通过 `stdin` 传入完整未截断的 `JSON.stringify(ctx)`（不注入任何隐式 `BP_IN_*` 环境变量），并在 `finally` 中清理临时文件。退出码为 `0` 时裁剪 `stdout`：若非空且为合法 JSON 则解析返回该 JSON 值，否则返回 `{ text: trimmed }`；退出码非 `0` 时以 `stderr.trim() || "sh exited with code <N>"` 抛错写入 `ctx`。 |
| `<script type="blueprint/sql" id="..." [desc="..."]>` | 必填 `id` | 在当前蓝图数据库 `<data>/<id>/<mode>/db.sqlite` 上执行 SQL（表结构定义同步时会被忽略）。按语句扫描 `:name` / `$name` / `@name` 占位符，优先从 `ctx.last.output`（若为普通对象）绑定，否则回退 `ctx.event.data`（若为普通对象），**仅传入语句实际出现的参数键**。查询返回结果行数组，写入返回 `{ changes, lastInsertRowid }`。 |
| `<script type="blueprint/emit" id="..." event="..." [desc="..."]>` | 必填 `id` 与非空 `event` | 发出 `event` 事件，负载取 `ctx.last?.output ?? ctx.event?.data ?? null`，追加至 `emittedEvents` 并返回 `{ emitted: event, data }`。 |
| `<script type="blueprint/ai" id="..." [protocol="acp"] cli="..." [model="..."] [mode="..."] [desc="..."]>` | 必填 `id` 与非空 `cli`；可选 `protocol`（默认 `"acp"`）、`model`、`mode` | 无状态 AI CLI 动作节点（详见 [`ai.md`](ai.md)）。通过标准 ACP（JSON-RPC 2.0 over stdio）与内置预设（`agy`、`opencode`、`dsh`、`claude`、`codex`）或自定义命令通信，从 `ctx.last.output`（或回退 `ctx.event.data`）读取 `{ prompt, session?, cwd? }` 并返回 `{ text, session }`；无 `session` 时通过 `session/new` 开新会话并前置拼接角色提示词，有 `session` 时通过 `session/load`（或 `session/resume`）续聊且不重复拼接角色提示词。 |

> `blueprint/def`、`blueprint/flow`、`blueprint/init.*` 及普通前端 `<script>` 均不进入动作节点集合。

---

## 二、运行时循环与上下文隔离

### 1. 自动同步与共享上下文（`ctx`）

- **先同步后执行**：`bp run <file.html> ...` 运行前自动调用 `syncBlueprint` 对 `<script type="blueprint/def">` 执行声明式表结构同步（与 `bp sql` 保持一致的 `dev` / `prod` 隔离语义）。
- **全量 `ctx` 透传**：每次执行动作节点均传入完整、未截断的共享上下文副本（`structuredClone(ctx)`）：

```js
{
  event: { type: eventName, data: eventData },
  last: null,       // 上一步执行结果 { node, ok, output, error }
  steps: {},        // nodeId -> 最近一次执行的 { ok, output, error }
  history: []       // 有序执行历史 [{ step, node, ok, output, error }]
}
```

- **异常捕获与容错路由**：任意动作节点抛出异常时，运行时不会直接中断流程，而是捕获错误并记录 `{ step, node, ok: false, output: null, error: err.message }` 写入 `ctx.history`、`ctx.last` 与 `ctx.steps[nodeId]`，由下一轮决策路由决定转向兜底错误处理节点或 `done`。

### 2. Jev 决策路由与 500 字符截断视图

- **结构化决策协议（Jev System One）**：默认调用 `POST ${BP_JEV_URL || "https://api.typesafe.ai/v1"}/systemone`（默认模型 `BP_JEV_MODEL || "jev-1.14"`，鉴权读取 `BP_JEV_API_KEY`、`JEV_API_KEY` 或 `--jev-key`），请求体携带 `model`、`state` 与 `questions.next`（`type: "choice"`，`criteria` 为 `[...nodeIds, "done"]` 及其描述）及 `questions.last`（`type: "choice"`，`yes` / `no`）。从 `answers.next.choice` 读取下一步节点；当 `answers.last.choice` 为 `"yes"` 时，执行完所选节点后立即结束，不再发起下一轮决策。`done` 保留，用于需要依据结果判断结束或无事可做的情况。
- **决策提示视图截断（最大 500 字符）**：传给决策模型的提示词包含四部分：(1) Flow 自然语言指令；(2) 触发事件类型与截断至最多 500 字符的 JSON 序列化 `data`；(3) 按步编号的执行进度摘要（`#1 <node> [ok]: <截断至500字符>` 或 `#1 <node> [error]: <截断至500字符>`，首步为 `(none yet)`）；(4) 各候选节点 `id`（含 `desc`）及 `done`。**决策视图截断仅作用于模型提示词，下游动作节点依然接收完整未截断的 `ctx`。**
- **循环上限保护（`maxSteps`）**：默认最多执行 `16` 轮决策（可通过 `--max-steps <n>` 调整）。若在上限内仍未选择 `"done"`，立即终止并抛出包含已执行轨迹（`#1 ..., #2 ...`）的明确错误。

---

## 三、访问边界与 CLI 入口

- **访问边界**：`blueprint/js`、`blueprint/sh` 等代码动作节点与 `plans/2611/sql.md` 约定保持一致——**严禁在脚本中直接打开 `.sqlite` 文件**，所有数据库读写必须经由 `<script type="blueprint/sql" id="...">` 节点或 `bp sql` 完成。
- **CLI 入口**：
  - `bp run <file.html> <event> [json-data] [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]`
  - `bp run <file.html> --init [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]`
