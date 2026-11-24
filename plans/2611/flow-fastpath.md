# Engineer Blueprint 确定性 Flow 快路径方案（`run="..."`）

> **定位说明**：在不改变自然语言 Flow 主体范式的前提下，为单步操作与固定线性流水线提供零决策开销的确定性执行通道，将简单交互延迟从秒级降至毫秒级。

---

## 一、背景与动机

当前所有 `<script type="blueprint/flow">` 均统一走 Jev 决策循环。即使是最简单的确定性操作，也需要多次云端往返：

- 单节点操作（如 `task:toggle`、`task:delete`）：需 2 轮 Jev 调用（选节点 + 选 `done`），约 1 秒左右。
- 固定线性流水线（如 `collect-sys-sh -> save-sys-sql -> emit-sys-updated`）：需 4 轮 Jev 调用，约 1.5–2 秒。

对于没有分支判断、也不依赖语义理解的固定步骤，完全可以通过声明式属性直接顺序执行。

---

## 二、HTML 声明写法

在 `<script type="blueprint/flow">` 上新增可选属性 `run`，支持单个节点 ID 或 `->` 分隔的线性管道，与现有触发属性（`on` / `every` / `init`）正交组合：

```html
<!-- 确定性快路径：0 次 Jev 调用，毫秒级完成 -->
<script type="blueprint/flow" on="task:toggle" run="toggle-task-sql"></script>
<script type="blueprint/flow" on="task:delete" run="delete-task-sql"></script>
<script type="blueprint/flow" on="sys:inspect" run="collect-sys-sh -> save-sys-sql -> emit-sys-updated"></script>

<!-- 含条件分支或语义判断的流程：继续写自然语言正文，走 Jev 路由 -->
<script type="blueprint/flow" on="task:create">
  1. 首先执行 validate-task 节点校验并清洗任务标题与标签。
  2. 若 validate-task 返回 valid=true，则执行 insert-task，随后 emit-task-saved，最后 done。
  3. 若 validate-task 返回 valid=false 或发生错误，则执行 emit-task-rejected，最后 done。
</script>
```

### 约束规则

- **互斥约束**：声明了 `run` 属性时，`<script>` 正文必须为空（避免与自然语言路由规则产生歧义）；未声明 `run` 时，沿用原有的非空自然语言正文 + Jev 路由逻辑。
- **步数**：`run` 管道依然受 `maxSteps` 上限保护。

---

## 三、解析与运行时语义

### 1. 解析阶段（`parse.js`）

- 读取 `run` 属性并按 `->` 拆分、裁剪首尾空白，得到有序节点数组 `pipeline`（如 `["collect-sys-sh", "save-sys-sql", "emit-sys-updated"]`）。
- 校验：`pipeline` 非空，且每一项均为合法节点 ID（不能包含保留字 `done`），并校验对应节点在当前蓝图中存在。

### 2. 执行阶段（`flow.js`）

- 当 `flow.pipeline` 存在时，**完全跳过 `decideFn`（0 次 Jev 网络请求）**，按顺序依次调用 `executeActionNode`。
- **上下文与生命周期复用**：与 Jev 路由共享同一套 `ctx`（`event` / `last` / `steps` / `history`）、数据库自动同步与 `hooks`（`onFlowStart`、`onStep`、`onEmit`、`onFlowEnd`、`onFlowError`）。
- **失败即止**：线性管道中任一节点执行失败（`ok: false`）时，记录错误到 `ctx.history` 与日志后直接中止后续节点并结束当前 Flow（不做隐式分支跳转）。

---

## 四、适用边界

- **使用 `run="..."`**：单步 SQL/JS/SH 动作、固定顺序的多节点管道（追求低延迟、确定性）。
- **使用自然语言正文（Jev）**：需要条件分支、错误兜底路由、或结合 `blueprint/ai` 输出做语义决策的流程。
