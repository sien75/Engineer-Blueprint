# Engineer Blueprint 长期演进规划（2612）

> **定位说明**：本文档记录 `<script type="blueprint/flow">` 运行时在保持自然语言声明体验不变的前提下，向更低延迟与本地化演进的长期技术方向。

---

## 一、自然语言 Flow 的 AOT / JIT 混合编译

### 1. 现状与瓶颈

当前 Flow 采用**纯解释型控制流（Interpreted Control Flow）**：每一步执行后都将流程指令、触发事件与历史摘要发给云端决策模型（Jev）选择下一节点。该模式零编译复杂度、对语义分支极其友好，但对于纯确定性的顺序流或字段条件流（如 `clean -> save-note -> done`），每一步仍需承担一次云端网络往返延迟。

### 2. 混合编译思路

在 `bp reload` / 蓝图保存时（**AOT**）或首次执行时（**JIT**），将 `<script type="blueprint/flow">` 编译并缓存为原生 JS 控制流，使确定性骨架与语义判断各司其职：

- **确定性骨架 → 原生 JS（`<1 ms`）**：顺序串联、固定重试次数、以及基于上游明确返回字段的结构化条件判断（如 `valid === true`）直接编译为原生 JS 顺序调用与 `if / else`。
- **非结构化语义分支 → `semantic_if` / `choice` 原语**：无法用确定表达式描述的分支（如根据用户输入情绪、上游 `blueprint/ai` 文本结论、或 `blueprint/sh` 报错文本判断是否可重试），在编译产物中保留对 System One 决策模型的单次调用。

```js
// 编译产物示意：确定性步骤零开销，仅语义分叉点调用一次 Jev
await run("clean");
if (ctx.last.output.valid) {
  const next = await jevChoice(ctx, {
    alert: "内容紧急或涉及故障",
    log: "常规记录即可",
  });
  await run(next);
} else {
  await run("reject");
}
```

---

## 二、本地高速 System One 决策推理

- **模型趋势**：随着开源小型 System One 决策模型（2B–9B，如 Apache 2.0 开源的 9B `Clef Flash` 等，单次 prefill 前向计算、零输出 token）逐步成熟，端侧已具备高质量语义分类与路由能力。
- **端侧加速**：结合 Apple Silicon 统一内存与 **KV Cache 前缀复用**（同一 Flow 的指令与候选节点描述不变，每步仅增量计算新状态），本地单次决策推理延迟可压低至 **20–80 ms**，彻底消除跨国网络 RTT，实现近乎无感的交互体验。

---

## 三、演进原则

- **声明方式不变**：蓝图作者依然只需编写自然语言 `<script type="blueprint/flow">` 与现有的 `js` / `sh` / `sql` / `emit` / `ai` 节点，底层 AOT/JIT 编译与本地/云端路由切换对蓝图完全透明。
