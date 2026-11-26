# Blueprint AI 动作节点技能（`<script type="blueprint/ai">`）

[English](../ai.md) · [技能首页](README.md) · [Def 模块](def.md) · [Flow 模块](flow.md) · [JS 模块](js.md) · [SH 模块](sh.md) · [Daemon 模块](daemon.md)

本指南规定如何在 `<script type="blueprint/flow">` 工作流中基于标准 **ACP（Agent Client Protocol，JSON-RPC 2.0 over stdio）** 编写与调度无状态 AI CLI 动作节点（`<script type="blueprint/ai">`）。

## 1. 声明语法

```html
<script type="blueprint/ai" id="coder" protocol="acp" cli="agy" model="claude-sonnet" mode="auto" desc="负责代码分析与修改">
你是一位严谨的工程助手，只基于仓库现状给出清晰结论。
</script>
```

- **`id`**（必填）：在当前文档全部后端动作节点中唯一（禁止使用 `"done"`）。
- **`protocol`**（可选，默认 `"acp"`）：底层通信协议。当前支持 `"acp"`（大小写不敏感，省略或为空时默认 `"acp"`）。
- **`cli`**（必填）：ACP CLI 预设名或自定义启动命令：
  - 内置预设（不区分大小写）：
    - `"agy"` → `agy acp`（支持 `BP_AGY_BIN` 环境变量覆盖）
    - `"opencode"` → `opencode acp`（支持 `BP_OPENCODE_BIN` 覆盖）
    - `"dsh"` → `dsh acp`（支持 `BP_DSH_BIN` 覆盖）
    - `"claude"` → `npx -y @agentclientprotocol/claude-agent-acp`
    - `"codex"` → `npx -y @zed-industries/codex-acp`
  - 自定义命令：任意其他非空命令字符串（支持单/双引号参数与路径解析，例如 `./bin/my-agent --acp`）。
- **`model`**（可选）：通过 ACP `session/set_model`（若不支持则回退 `session/set_config_option`）设置。
- **`mode`**（可选）：通过 ACP `session/set_mode`（若不支持则回退 `session/set_config_option`）设置。
- **`desc`**（可选）：节点职责描述，供 Flow 路由模型参考。
- **角色提示词正文**（可选）：脚本正文（会先将 `<\/script>` 还原为 `</script>` 并去除首尾空白）。**仅在新开会话时**以 `\n\n` 拼接在输入 `prompt` 前面；传入 `session` 续聊时不重复拼接。

## 2. 统一输入 / 输出契约

`blueprint/ai` 定位为无状态执行器，节点自身不维护会话历史。输入优先读取 `ctx.last?.output`（若为普通对象），否则回退读取 `ctx.event?.data`（若为普通对象），否则为 `{}`：

```ts
// 输入
{
  prompt: string;   // 必填：非空提示词文本
  session?: string; // 可选：缺失、null 或纯空白时新开会话；非空字符串时通过 ACP session/load 续聊
  cwd?: string;     // 可选：执行工作目录，默认为当前工作目录 process.cwd()
}

// 输出（写入 ctx.last.output）
{
  text: string;     // 从本轮 ACP agent_message_chunk 流式通知汇总的响应文本
  session: string;  // 本轮创建或延续的 ACP sessionId
}
```

- **ACP 协议执行流程（JSON-RPC 2.0 over stdio）**：
  - 在 `cwd` 下启动解析后的 ACP 命令，发送 `initialize`（`protocolVersion: 1`）。
  - **新开会话**（无 `session`）：调用 `session/new`（`{ cwd, mcpServers: [] }`）获取 `sessionId`，并将 `fullPrompt`（`rolePrompt + "\n\n" + prompt`，`rolePrompt` 为空时仅传 `prompt`）发送给 `session/prompt`。
  - **延续会话**（`session` 非空）：调用 `session/load`（若返回 `-32601` 则回退 `session/resume`），加载阶段忽略历史回放消息块，随后仅传 `prompt` 调用 `session/prompt`（不重复拼接 `rolePrompt`）。
  - **模型/模式与权限**：按需设置 `model`/`mode`，遇到 `session/request_permission` 请求时自动选择允许选项（`allow_once` / `allow_always` / 首个选项），并汇总本轮 `agent_message_chunk` 文本。
- **错误处理**：缺少非空 `prompt`、子进程启动失败或非零退出、JSON 解析失败或 JSON-RPC 返回错误时，均会抛出异常并由 Flow 循环捕获写入 `ctx.history`（`ok: false`），供后续路由走失败兜底或 `done`。

## 3. 两种典型用法

### 临时对话（不持久化会话）

直接从 `ctx.event.data` 或前置 `blueprint/js` 节点传入 `{ prompt }`，下游直接消费 `:text` 而无需保存 `session`：

```html
<script type="blueprint/flow" on="ask">
1. 执行 quick-ai 回答输入问题。
2. 成功则执行 emit-reply，失败则执行 emit-error，最后选择 done 结束。
</script>

<script type="blueprint/ai" id="quick-ai" protocol="acp" cli="agy" desc="单轮问答助手">
请直接给出简洁准确的回答。
</script>

<script type="blueprint/emit" id="emit-reply" event="ask:replied" desc="输出 AI 回复"></script>
<script type="blueprint/emit" id="emit-error" event="ask:failed" desc="输出失败事件"></script>
```

### 基于 SQLite 的会话续聊

通过蓝图自身的 SQLite 表（`blueprint/def` + `blueprint/sql`）保存与读取 `session`，用 `blueprint/js` 组装 `{ prompt, session, cwd? }`，并在 `blueprint/ai` 执行后将新的 `:session` 与 `:text` 写回数据库：

```html
<script type="blueprint/def">
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  last_reply TEXT
);
</script>

<script type="blueprint/flow" on="thread:message">
1. 先执行 load-thread 查询已有 session。
2. 执行 prepare-ai 组装 { prompt, session, cwd }。
3. 执行 chat 调用 AI CLI；若 chat 失败，执行 emit-error 后选择 done。
4. 若 chat 成功，执行 attach-thread-id 补齐 thread_id，再执行 save-thread 写回数据库，最后选择 done。
</script>

<script type="blueprint/sql" id="load-thread" desc="按 thread_id 读取历史 session">
SELECT session_id AS session FROM threads WHERE id = :thread_id;
</script>

<script type="blueprint/js" id="prepare-ai" desc="组装 { prompt, session, cwd }">
export default async (ctx) => ({
  prompt: ctx.event.data.prompt,
  session: ctx.last.output?.[0]?.session ?? null,
  cwd: ctx.event.data.cwd,
});
</script>

<script type="blueprint/ai" id="chat" protocol="acp" cli="agy" desc="新开或延续指定线程对话">
你是项目协助助手，请结合上下文直接作答。
</script>

<script type="blueprint/js" id="attach-thread-id" desc="合并 thread_id 与 AI 输出用于落库">
export default async (ctx) => ({
  thread_id: ctx.event.data.thread_id,
  session: ctx.last.output.session,
  text: ctx.last.output.text,
});
</script>

<script type="blueprint/sql" id="save-thread" desc="保存最新 session 与回复">
INSERT INTO threads (id, session_id, last_reply)
VALUES (:thread_id, :session, :text)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id,
  last_reply = excluded.last_reply;
</script>

<script type="blueprint/emit" id="emit-error" event="thread:failed" desc="输出对话失败事件"></script>
```

## 4. 在 Flow 中保持节点 `id` 清晰无歧义

- 为每个 `blueprint/ai` 节点起具象、区分职责的 `id`（例如 `ai-review`、`ai-fix`、`chat`），避免使用 `step1`、`run` 等含糊命名。
- 在 `<script type="blueprint/flow">` 流程指令中显式写出准确的节点 `id`，配合清晰的 `desc` 与互斥分支（包含 `[error]` 兜底分支），并确保所有路径最终收敛至 `done`。
