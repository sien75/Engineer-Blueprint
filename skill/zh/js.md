# Blueprint JS 动作节点技能（`<script type="blueprint/js">`）

[English](../js.md) · [技能首页](README.md) · [Flow 模块](flow.md) · [Def 模块](def.md) · [SH 模块](sh.md) · [AI 模块](ai.md) · [Daemon 模块](daemon.md)

本指南规定如何在 `<script type="blueprint/flow">` 工作流中编写纯 JavaScript 后端动作节点（`<script type="blueprint/js">`）。

## 1. 声明语法

```html
<script type="blueprint/js" id="clean" desc="校验并裁剪笔记正文">
export default async (ctx) => {
  const body = String(ctx.event.data?.body ?? "").trim();
  if (!body) return { valid: false, reason: "empty body" };
  return { valid: true, id: ctx.event.data.id, body };
};
</script>
```

- **`id`**（必填）：在当前文档全部后端动作节点中唯一（禁止使用 `"done"`）。
- **`desc`**（可选）：节点职责描述，供 Flow 路由模型参考。
- **`<\/script>` 还原**：执行前会自动将正文中的 `<\/script>` 还原为 `</script>`。

## 2. 运行时契约

- **纯 ES Module**：需默认导出 `export default async (ctx) => ...`（缺失 `default` 时兼容具名导出 `run`）。
- **仅传入 `(ctx)` 单一参数**：每次调用都会传入完整、未截断的共享上下文深拷贝（`structuredClone(ctx)`）：

```js
{
  event: { type: eventName, data: eventData },
  last: null,       // 上一步 { node, ok, output, error }
  steps: {},        // nodeId -> 最近一次执行的 { ok, output, error }
  history: []       // 按执行顺序记录的 [{ step, node, ok, output, error }]
}
```

- **无 `bp` 注入与 SQLite 访问边界**：不向节点注入任何 `bp` 辅助对象；**禁止直接打开 `.sqlite` 文件**，所有数据库读写均须经由 `<script type="blueprint/sql">` 节点（[`flow.md`](flow.md)）或 `bp sql`（[`def.md`](def.md)）执行。
- **无缓存加载与返回值规范**：每次执行都会写入独立临时 `.mjs` 文件动态加载并在 `finally` 中清理，避免 ESM 模块缓存污染；返回 `undefined` 时自动规范化为 `null`。
- **错误捕获**：若函数抛出异常或未导出可执行函数，Flow 循环会捕获异常并向 `ctx.history`、`ctx.last` 与 `ctx.steps[id]` 写入 `{ step, node, ok: false, output: null, error: err.message }`，供后续路由走失败兜底分支。
