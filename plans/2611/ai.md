# Engineer Blueprint AI 节点设计（`blueprint/ai`）

> **定位说明**：`<script type="blueprint/ai">` 是 Flow 可调度的 AI 执行节点，定位为无状态执行器——节点自身不维护会话状态、历史记录或持久化存储；会话 ID 由蓝图自己的 SQLite 表（`blueprint/def` + `blueprint/sql`）按需读写。通过标准 **ACP（Agent Client Protocol，JSON-RPC 2.0 over stdio）** 接入各类兼容的 AI CLI。

---

## 一、HTML 声明写法

在蓝图 `.html` 文件中通过 `<script type="blueprint/ai">` 声明一个可被 Flow 调度的 AI 节点：

```html
<script type="blueprint/ai" id="coder" protocol="acp" cli="agy" model="claude-sonnet" mode="auto" desc="负责代码分析与修改">
你是一位严谨的工程助手，只基于仓库现状给出清晰结论。
</script>
```

- **`id`**（必填）：节点唯一标识，自动加入 `flow` 的可调度选项列表。
- **`protocol`**（可选，默认 `"acp"`）：底层通信协议。当前仅支持 `"acp"`（大小写不敏感，未填写时默认 `"acp"`）。
- **`cli`**（必填）：ACP CLI 预设名或自定义启动命令。内置预设（不区分大小写）：
  - `"agy"` → `agy acp`（支持 `BP_AGY_BIN` 覆盖二进制路径）
  - `"opencode"` → `opencode acp`（支持 `BP_OPENCODE_BIN` 覆盖）
  - `"dsh"` → `dsh acp`（支持 `BP_DSH_BIN` 覆盖）
  - `"claude"` → `npx -y @agentclientprotocol/claude-agent-acp`
  - `"codex"` → `npx -y @zed-industries/codex-acp`
  - 其他非空字符串按命令拆分（支持单/双引号参数与路径解析），可直接指定任意自定义 ACP 二进制或适配器命令。
- **`model`**（可选）：通过 ACP `session/set_model`（若不支持则回退 `session/set_config_option`）设置模型。
- **`mode`**（可选）：通过 ACP `session/set_mode`（若不支持则回退 `session/set_config_option`）设置执行模式。
- **`desc`**（可选）：节点职责描述，供决策模型参考。
- **节点正文**（可选）：角色提示词。**仅在新开会话时**拼接在输入 `prompt` 前面；续聊时会话已有上下文，不重复拼接。若正文内包含 `</script>`，按 HTML 规范转义为 `<\/script>` 并在解析时还原。

---

## 二、统一输入 / 输出契约

`blueprint/ai` 对上下游提供统一的输入 / 输出契约，屏蔽底层 CLI 差异：

### 1. 输入（从 `ctx.last.output` 读取，首步回退 `ctx.event.data`）

```ts
{
  prompt: string;   // 必填：本次发送给 AI 的提示词
  session?: string; // 可选：存在且非空则续聊；缺失或为空则新开会话
  cwd?: string;     // 可选：执行工作目录，默认当前目录
}
```

- `prompt` 缺失或为空时按节点错误处理。
- `session` 仅在非空时视为续聊；缺失、`null` 或空字符串 `""` 均视为新开会话。

### 2. 输出（写入 `ctx.last.output`）

```ts
{
  text: string;     // AI 本轮响应文本
  session: string;  // 本轮产生或延续的会话 ID
}
```

输出字段名直接对齐下游参数绑定，可供后续 `blueprint/sql` 节点直接绑定 `:text`、`:session`。

---

## 三、两种典型用法

基于同一套 `{ prompt, session?, cwd? } -> { text, session }` 接口，蓝图可按需选择是否持久化 `session`：

### 1. 临时对话

上游不传 `session`，下游直接消费返回的 `text`（不保存 `session`），每次均为独立新会话。

```
ctx.event.data { prompt } ─▶ blueprint/ai ─▶ 下游消费 :text（不落库 :session）
```

### 2. 接着某个 session 聊

通过蓝图自己的表保存并延续会话 ID：

```
blueprint/sql（查库取旧 session）
  ─▶ blueprint/js（组装 { prompt, session }）
  ─▶ blueprint/ai（通过 ACP 续聊或首次新开，输出 { text, session }）
  ─▶ blueprint/sql（将新 :session 与 :text 写回表里）
```

示例片段：

```html
<script type="blueprint/def">
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  last_reply TEXT
);
</script>

<script type="blueprint/sql" id="load_thread">
SELECT session_id AS session FROM threads WHERE id = :thread_id;
</script>

<script type="blueprint/js" id="prepare_ai">
export default (ctx) => ({
  prompt: ctx.event.data.prompt,
  session: ctx.last.output?.[0]?.session ?? undefined,
  cwd: ctx.event.data.cwd,
});
</script>

<script type="blueprint/ai" id="chat" protocol="acp" cli="agy" desc="延续指定线程与用户对话">
你是项目协助助手，请结合上下文直接作答。
</script>

<!-- 下游可直接绑定 blueprint/ai 输出的 :session 与 :text -->
<script type="blueprint/sql" id="save_thread">
UPDATE threads
SET session_id = :session,
    last_reply = :text
WHERE id = :thread_id;
</script>
```

---

## 四、ACP 协议实现策略（JSON-RPC 2.0 over stdio）

### 1. 握手与会话生命周期

在 `cwd`（缺省为当前目录）下启动 `resolveAcpCommand(cli)` 解析出的子进程，通过 stdin/stdout NDJSON 执行标准 ACP 流程：

1. 发送 `initialize`（`protocolVersion: 1`）完成能力协商。
2. **无 `session`（新开会话）**：
   - 调用 `session/new`（`{ cwd, mcpServers: [] }`）获取 `sessionId`。
   - 将节点正文角色提示词与输入 `prompt` 拼接后传入（正文为空时仅传 `prompt`）。
3. **有 `session`（续聊）**：
   - 调用 `session/load`（`{ sessionId, cwd, mcpServers: [] }`；若服务端返回 `-32601`，回退 `session/resume`）。
   - 加载阶段忽略历史回放的 `agent_message_chunk` 通知，仅传入 `prompt`（不重复拼接角色提示词）。
4. 若节点配置了 `model` / `mode`，依次调用 `session/set_model` / `session/set_mode`（若返回 `-32601` 则回退 `session/set_config_option`）。
5. 调用 `session/prompt` 并收集本轮流式 `session/update` 中的 `agent_message_chunk` 文本片段，遇到 `session/request_permission` 请求时自动选择允许选项以免阻塞。

### 2. 输出解析与错误处理

- 拼接本轮收集的文本块并返回 `{ text, session }`。
- 当子进程启动失败、非零退出、JSON 解析失败、JSON-RPC 返回错误或缺少必需字段时，按 Flow 通用节点错误处理写入 `ctx.history`，供后续分支判断或 `done` 节点收口处理。

### 3. 协议扩展点

执行器内部保留按节点 `protocol` 属性分发的协议路由层（当前内置 `acp`）：

- 通过 `protocol="acp"` 可直接使用所有内置预设 CLI 及任意自定义 ACP stdio 命令；
- HTML 侧 `<script type="blueprint/ai">` 的写法与上下游统一契约保持不变。
