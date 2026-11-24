# Engineer Blueprint SQL 与数据存储设计

> **定位说明**：在 Engineer Blueprint 中，数据存储是 CLI / Daemon 的基础能力。CLI 为每个蓝图管理独立的 SQLite 数据库，并通过单一入口 `bp sql <file.html|id> "<statement>"` 提供自动声明式表结构同步与 SQL 执行能力（无单独同步步骤，也不设自动备份机制）。其中前端能力（`bp.sql`、`bp.watch`）先仅作协议记录，暂不实现。

---

## 一、Schema 规范（HTML 侧）

### 1. 声明方式与初始数据

- **建表与索引语句**：在蓝图 `.html` 文件的一个或多个 `<script type="blueprint/def">` 块中编写标准 SQLite 语句，约定统一使用 `CREATE TABLE IF NOT EXISTS ...` 声明表结构，需要显式索引时使用 `CREATE [UNIQUE] INDEX IF NOT EXISTS ...`。（注：`<script type="blueprint/sql" id="...">` 预留给流程 SQL 动作节点，不作为表结构定义块处理。）
- **默认数据**：初始默认数据（如预设角色、默认配置行）可直接写在同一个 `blueprint/def` 块中，使用幂等语句：

```sql
CREATE TABLE IF NOT EXISTS agents (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT OR IGNORE INTO agents (id, name) VALUES ('agy', 'AGY');
```

- **幂等语义**：首次访问数据库时写入初始数据；后续通过 `bp sql <file.html> ...` 自动同步时，因 `INSERT OR IGNORE` 不会重复插入，也不会覆盖用户已修改的数据。

### 2. 自动声明式表结构同步（`dev` 与 `prod` 一致）

HTML 中无需维护版本号或增量迁移脚本，只需维护当前期望的最终表结构。无需单独执行同步命令——每次向 `bp sql <file.html> "<statement>"` 传入 `.html` 文件时，`dev` 与 `prod` 均在执行 `<statement>` 前按同一逻辑自动同步表结构：

1. CLI 先在**内存 SQLite（`:memory:`）**中执行 `blueprint/def`，解析出目标表结构与显式索引。
2. 分别读取内存库（目标结构）和真实库（现状结构）的 `PRAGMA table_info(<table_name>)` 与 `sqlite_master` 进行对比：
   - **没表**：直接执行建表语句。
   - **少字段**：执行 `ALTER TABLE <table> ADD COLUMN <col_def>`（若向非空表添加无 `DEFAULT` 值的 `NOT NULL` 列，则拒绝变更并报错）。
   - **多字段**：执行 `ALTER TABLE <table> DROP COLUMN <col_name>`（直接物理删除，永久清除该列数据，不设软保留或自动备份）。
   - **多余表**：执行 `DROP TABLE <table>`（直接物理删除，永久清除该表数据，不设自动备份）。
   - **显式索引**：在删列/删表前先清理失效或已变更的旧索引，再创建新增或更新后的索引。
   - **非 DDL 语句**：如 `INSERT OR IGNORE ...` 等语句在表结构同步完成后按文档顺序执行。

### 3. Skill 编写提醒约定

在面向 Agent 的 `skill/` 文档中需明确注明以下约束：
- **建议表结构只增不减**：删列或删表会直接物理删除并永久清除历史数据，且系统不会自动备份，调整列或表时务必谨慎。
- **改列名等同于删旧列加新列**：声明式结构比对无法识别字段重命名，重命名列会导致原列数据被永久清理，如需保留历史数据应先显式导出或迁移后再修改。

---

## 二、CLI 运行时与访问边界

### 1. 隔离与生命周期

- **一蓝图一库**：以 `<meta name="bp:id" content="...">`（优先）或 `<meta id="...">` 作为数据库唯一身份标识，一个蓝图对应一个独立数据库（`<data>/blueprints/<id>.<mode>.sqlite`，`<data>` 默认为 `$BP_DATA` 或 `~/.engineer-blueprint/data`，可通过 `--data` 覆盖），代码目录与数据目录分离。
- **环境隔离**：`prod` 与 `dev` 各自使用独立的 SQLite 文件（`<id>.prod.sqlite` 与 `<id>.dev.sqlite`），开发调试互不污染。
- **文件解耦**：删除蓝图 `.html` 文件不删除对应的 `.sqlite` 数据文件；将同 ID 的蓝图文件放回目录并再次运行 `bp sql` 后自动接上原有数据。
- **唯一 CLI 入口**：CLI 提供 `bp sql <file.html|id> "<statement>" [--dev] [--data <dir>] [--json]`。传入 `.html` 文件路径时自动对 `<script type="blueprint/def">` 执行声明式同步后再运行 `<statement>`；直接传入蓝图 ID 时直接在已初始化的数据库上执行 `<statement>`。

### 2. 访问边界约定

| 访问方 | 约定规则 | 设计原因 |
|---|---|---|
| **后端脚本（`blueprint/js` 等）** | **禁止直连 `.sqlite` 文件**（1A） | 读写统一经过 CLI / 编排层，确保每次写库都能被运行时感知并通知订阅方，同时避免并发写锁冲突。 |
| **前端 `bp.sql`（暂不实现）** | **只读**（2A） | 前端只允许发起读取查询，所有写操作一律通过 `bp.emit` 触发编排步骤完成，保证数据修改路径收口且易于审阅。 |
| **前端 `bp.watch`（暂不实现）** | **兼容整表订阅与条件 `SELECT` 订阅**（3B） | 保留 `bp.watch("table", cb)` 的简洁用法，同时支持 `bp.watch("SELECT * FROM messages ORDER BY id DESC LIMIT 50", cb)` 等带条件的查询订阅，避免聊天记录或运维日志增长后全量推送导致前端卡顿。 |
