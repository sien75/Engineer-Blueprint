# Blueprint SQLite 定义模块技能（`<script type="blueprint/def">`）

[English](../def.md) · [技能首页](README.md) · [Flow 模块](flow.md) · [Daemon 模块](daemon.md)

本指南规定 `<script type="blueprint/def">` 的声明式 SQLite Schema 与初始数据规范、表结构同步与环境隔离语义，以及开发调试阶段使用 `bp sql` 查询/修改数据的操作方式。（流程中的 `<script type="blueprint/sql" id="...">` 动作节点规范见 [`flow.md`](flow.md)。）

## 1. 编写 `<script type="blueprint/def">`

在 `.html` 文档的一个或多个 `<script type="blueprint/def">` 代码块中编写标准 SQLite 语句（按文档出现顺序求值）：

- 建表统一使用 `CREATE TABLE IF NOT EXISTS ...`，创建显式索引统一使用 `CREATE [UNIQUE] INDEX IF NOT EXISTS ...`。
- 在同一代码块中使用 `INSERT OR IGNORE INTO ...` 写入初始数据，确保首次访问数据库时写入初始数据，后续同步既不重复插入也不会覆盖用户已修改的数据。
- 块内转义的 `<\/script>` 序列会还原为 `</script>`。

```html
<script type="blueprint/def">
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light');
</script>
```

## 2. 声明式表结构同步与生命周期

蓝图仅在 `.html` 中声明期望的目标表结构，不维护版本号或增量迁移脚本。在 Daemon 模式下通过 **`bp reload`** 触发表结构同步；离线传入 `.html` 文件执行 `bp sql <file.html>` 或 `bp run <file.html>` 时也会自动同步（`dev` 与 `prod` 语义完全一致）：

- **缺失表**：按声明的 `CREATE TABLE` 语句建表。
- **缺失列**：向现有表新增列（向已有数据的非空表添加无 `DEFAULT` 值的 `NOT NULL` 列会被拒绝）。
- **多余列 / 多余表**：直接物理删除，永久清除其数据。
- **显式索引**：在删列与删表之前先删除失效或已变更的索引；创建新增或更新后的索引。
- **列重命名**：等效于删除旧列（清除其数据）并新增列。
- **非 DDL 语句**：除 `CREATE TABLE` 与 `CREATE [UNIQUE] INDEX` 之外的语句（如 `INSERT OR IGNORE ...`）在表结构同步完成后按文档顺序执行。
- **隔离性与生命周期独立**：每个蓝图 ID 对应一个独立的 SQLite 数据库（`<data>/<id>/<mode>/db.sqlite`），`dev` 与 `prod` 各自独立存储。删除 `.html` 文件会保留其数据库；恢复具有相同蓝图 ID 的 `.html` 文件后会自动接续原有数据库。

## 3. 表结构安全注意事项

- **优先做增量变更**：新增表，或新增可为空 / 带默认值的列。
- **删列或删表会永久清除数据（无自动备份）**：从 `CREATE TABLE` 或 `<script type="blueprint/def">` 中移除某列或某表会导致下次同步（`bp reload`、`bp sql <file.html>` 或 `bp run <file.html>`）时直接物理删除，永久擦除数据且不产生任何自动备份。
- **重命名列等同于删旧列加新列**：声明式同步无法识别字段重命名；将 `old_col` 改名为 `new_col` 前请先显式备份或迁移数据。
- **新增 `NOT NULL` 列**：向可能已有数据的现有表添加 `NOT NULL` 列时，必须包含 `DEFAULT` 子句。

## 4. 访问边界

| 访问方 | 契约规则 |
|---|---|
| **后端脚本（`blueprint/js`、`blueprint/sh`）** | 不得直接打开 `.sqlite` 文件；所有读写均须经由 `<script type="blueprint/sql">` 节点（[`flow.md`](flow.md)）或 `bp sql` 执行，且禁止手动编辑 `<data>/<id>/` 目录下的文件。 |
| **前端 `window.bp.sql`** | 由 Daemon 客户端提供的**严格只读** SQL 查询接口（`SELECT` / `WITH ... SELECT` / `PRAGMA table_info(...)`，详见 [`daemon.md`](daemon.md)）；所有写操作须通过 `bp.emit(...)` 触发后端流程完成。 |
| **前端 `window.bp.watch`** | 实时订阅接口，支持传入纯表名（如 `bp.watch("notes", cb)`）或带条件的只读 `SELECT` / `WITH ... SELECT` 查询（如 `bp.watch("SELECT * FROM messages ORDER BY id DESC LIMIT 50", cb)`），后端写库时自动重查推送（[`daemon.md`](daemon.md)）。 |

## 5. `bp sql` 命令

开发调试期间可使用 `bp sql` 查询或修改数据。默认数据目录为 `$BP_DATA` 或 `~/.engineer-blueprint/data`（可通过 `--data <dir>` 覆盖）。默认模式为 `prod`；传入 `--dev` 可使用隔离的开发环境存储，传入 `--json` 可输出结构化 JSON。

```bash
bp sql <file.html|id> "<statement>" [--dev] [--data <dir>] [--json]
```

- 传入 `.html` 文件路径时，`bp sql` 会先自动依据最新的 `<script type="blueprint/def">` 同步表结构，再执行 `<statement>`。
- 传入纯蓝图 ID 时，`bp sql` 直接对已初始化的 `<data>/<id>/<mode>/db.sqlite` 数据库执行 `<statement>`。
- 当 `<statement>` 写入数据或变更表结构时，`bp sql` 会尽最大努力通知运行中的 Daemon（`/_bp/notify-change`），使已打开的 `bp.watch(...)` 页面即时刷新。
