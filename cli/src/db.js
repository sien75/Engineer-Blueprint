import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainObject } from "./ai.js";
import { parseBlueprintFile, resolveBlueprintId } from "./parse.js";
import {
  classifySqlStatement,
  extractSqlNamedParameters,
  formatColumnDefinition,
  isReadOnlySqlScript,
  quoteIdent,
  splitSqlStatements,
} from "./sql.js";

export function resolveDataDir(dataDirOption) {
  if (typeof dataDirOption === "string" && dataDirOption.trim().length > 0) {
    return path.resolve(dataDirOption);
  }
  if (typeof process.env.BP_DATA === "string" && process.env.BP_DATA.trim().length > 0) {
    return path.resolve(process.env.BP_DATA);
  }
  return path.join(os.homedir(), ".engineer-blueprint", "data");
}

export function resolveBlueprintsDir(dirOption) {
  if (typeof dirOption === "string" && dirOption.trim().length > 0) {
    return path.resolve(dirOption);
  }
  if (typeof process.env.BP_DIR === "string" && process.env.BP_DIR.trim().length > 0) {
    return path.resolve(process.env.BP_DIR);
  }
  return path.join(os.homedir(), ".engineer-blueprint", "blueprints");
}

export function getMode(dev) {
  return dev ? "dev" : "prod";
}

export function getMainDbPath(id, mode, dataDir) {
  return path.join(dataDir, id, mode, "db.sqlite");
}

function getLegacyMainDbPath(id, mode, dataDir) {
  return path.join(dataDir, "blueprints", `${id}.${mode}.sqlite`);
}

function moveSqliteSidecars(fromDbPath, toDbPath) {
  for (const suffix of ["-wal", "-shm"]) {
    const from = `${fromDbPath}${suffix}`;
    const to = `${toDbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) {
      fs.rmSync(from, { force: true });
      continue;
    }
    fs.renameSync(from, to);
  }
}

/**
 * Move legacy `<data>/blueprints/<id>.<mode>.sqlite` (+ WAL sidecars) to
 * `<data>/<id>/<mode>/db.sqlite` when the new path is missing.
 * @returns {string} Resolved main db path (new layout).
 */
export function ensureMainDbPath(id, mode, dataDir) {
  const dbPath = getMainDbPath(id, mode, dataDir);
  if (fs.existsSync(dbPath)) {
    return dbPath;
  }

  const legacyPath = getLegacyMainDbPath(id, mode, dataDir);
  if (!fs.existsSync(legacyPath)) {
    return dbPath;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.renameSync(legacyPath, dbPath);
  moveSqliteSidecars(legacyPath, dbPath);

  const legacyDir = path.dirname(legacyPath);
  try {
    if (fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).length === 0) {
      fs.rmdirSync(legacyDir);
    }
  } catch {
    // Best-effort cleanup of empty legacy blueprints/ directory.
  }

  return dbPath;
}

function readSchemaSnapshot(db) {
  const rawTables = db
    .query(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY rowid`
    )
    .all();

  const tables = rawTables.map((t) => {
    const columns = db.query(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
    return {
      name: t.name,
      key: t.name.toLowerCase(),
      sql: t.sql,
      columns: columns.map((c) => ({
        ...c,
        key: c.name.toLowerCase(),
      })),
    };
  });

  const indexes = db
    .query(
      `SELECT name, tbl_name, sql FROM sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL
       ORDER BY rowid`
    )
    .all()
    .map((idx) => ({
      name: idx.name,
      key: idx.name.toLowerCase(),
      tableName: idx.tbl_name,
      tableKey: idx.tbl_name.toLowerCase(),
      sql: idx.sql,
    }));

  const viewsAndTriggers = db
    .query(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE type IN ('view', 'trigger') AND sql IS NOT NULL
       ORDER BY rowid`
    )
    .all()
    .map((obj) => ({
      type: obj.type,
      name: obj.name,
      key: `${obj.type}:${obj.name.toLowerCase()}`,
      nameKey: obj.name.toLowerCase(),
      tableName: obj.tbl_name,
      tableKey: obj.tbl_name ? obj.tbl_name.toLowerCase() : null,
      sql: obj.sql,
    }));

  return { tables, indexes, viewsAndTriggers };
}

function normalizeMasterSql(sql) {
  return String(sql ?? "").replace(/\s+/g, " ").trim();
}

function computeSchemaDiff(desired, current) {
  const desiredTableMap = new Map(desired.tables.map((t) => [t.key, t]));
  const currentTableMap = new Map(current.tables.map((t) => [t.key, t]));

  const tablesToCreate = [];
  const tablesToDrop = [];
  const columnsToAdd = [];
  const columnsToDrop = [];

  for (const desiredTable of desired.tables) {
    const currentTable = currentTableMap.get(desiredTable.key);
    if (!currentTable) {
      tablesToCreate.push(desiredTable);
      continue;
    }

    const currentColMap = new Map(currentTable.columns.map((c) => [c.key, c]));
    const desiredColMap = new Map(desiredTable.columns.map((c) => [c.key, c]));

    for (const col of desiredTable.columns) {
      if (!currentColMap.has(col.key)) {
        columnsToAdd.push({ tableName: currentTable.name, column: col });
      }
    }

    for (const col of currentTable.columns) {
      if (!desiredColMap.has(col.key)) {
        columnsToDrop.push({ tableName: currentTable.name, column: col });
      }
    }
  }

  for (const currentTable of current.tables) {
    if (!desiredTableMap.has(currentTable.key)) {
      tablesToDrop.push(currentTable);
    }
  }

  const droppedTableKeys = new Set(tablesToDrop.map((t) => t.key));
  const tablesWithDroppedCols = new Set(columnsToDrop.map((c) => c.tableName.toLowerCase()));

  const desiredIndexMap = new Map(desired.indexes.map((idx) => [idx.key, idx]));
  const currentIndexMap = new Map(current.indexes.map((idx) => [idx.key, idx]));

  const indexesToDrop = [];
  const droppedIndexKeys = new Set();
  for (const curIdx of current.indexes) {
    const desIdx = desiredIndexMap.get(curIdx.key);
    if (
      !desIdx ||
      droppedTableKeys.has(curIdx.tableKey) ||
      tablesWithDroppedCols.has(curIdx.tableKey) ||
      normalizeMasterSql(curIdx.sql) !== normalizeMasterSql(desIdx.sql)
    ) {
      indexesToDrop.push(curIdx);
      droppedIndexKeys.add(curIdx.key);
    }
  }

  const indexesToCreate = [];
  for (const desIdx of desired.indexes) {
    const curIdx = currentIndexMap.get(desIdx.key);
    if (!curIdx || droppedIndexKeys.has(desIdx.key)) {
      indexesToCreate.push(desIdx);
    }
  }

  const desiredVtMap = new Map(desired.viewsAndTriggers.map((obj) => [obj.key, obj]));
  const viewsTriggersToDrop = [];
  const unchangedViewsTriggers = new Set();

  for (const curObj of current.viewsAndTriggers) {
    const desObj = desiredVtMap.get(curObj.key);
    if (
      !desObj ||
      (curObj.tableKey && droppedTableKeys.has(curObj.tableKey)) ||
      (curObj.tableKey && tablesWithDroppedCols.has(curObj.tableKey)) ||
      normalizeMasterSql(curObj.sql) !== normalizeMasterSql(desObj.sql)
    ) {
      viewsTriggersToDrop.push(curObj);
    } else {
      unchangedViewsTriggers.add(curObj.key);
    }
  }

  return {
    tablesToCreate,
    tablesToDrop,
    columnsToAdd,
    columnsToDrop,
    indexesToDrop,
    indexesToCreate,
    viewsTriggersToDrop,
    unchangedViewsTriggers,
  };
}

function validateColumnAdditions(realDb, columnsToAdd) {
  for (const { tableName, column } of columnsToAdd) {
    if (column.notnull === 1 && (column.dflt_value === null || column.dflt_value === undefined)) {
      const hasRow = realDb.query(`SELECT 1 FROM ${quoteIdent(tableName)} LIMIT 1`).get();
      if (hasRow) {
        throw new Error(
          `Cannot add NOT NULL column "${column.name}" without a DEFAULT value to non-empty table "${tableName}". Add a DEFAULT clause or make the column nullable.`
        );
      }
    }
  }
}

/**
 * Reconcile a blueprint's declarative SQLite schema and idempotent seed statements.
 * @param {{ filePath: string, dev?: boolean, dataDir?: string }} options
 */
export function syncBlueprint({ filePath, dev = false, dataDir }) {
  const parsed = parseBlueprintFile(filePath);
  const mode = getMode(dev);
  const resolvedDataDir = resolveDataDir(dataDir);
  const dbPath = ensureMainDbPath(parsed.id, mode, resolvedDataDir);

  const statements = [];
  for (const block of parsed.sqlBlocks) {
    for (const stmt of splitSqlStatements(block)) {
      statements.push({ stmt, ...classifySqlStatement(stmt) });
    }
  }

  let memDb = null;
  let realDb = null;

  try {
    memDb = new Database(":memory:");
    for (const item of statements) {
      memDb.exec(item.stmt);
    }
    const desired = readSchemaSnapshot(memDb);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    realDb = new Database(dbPath);
    realDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

    const current = readSchemaSnapshot(realDb);
    const diff = computeSchemaDiff(desired, current);

    validateColumnAdditions(realDb, diff.columnsToAdd);

    let executedStatements = 0;

    realDb.exec("BEGIN IMMEDIATE;");
    try {
      for (const obj of diff.viewsTriggersToDrop) {
        const keyword = obj.type === "trigger" ? "TRIGGER" : "VIEW";
        realDb.exec(`DROP ${keyword} IF EXISTS ${quoteIdent(obj.name)}`);
      }

      for (const idx of diff.indexesToDrop) {
        realDb.exec(`DROP INDEX IF EXISTS ${quoteIdent(idx.name)}`);
      }

      for (const tbl of diff.tablesToCreate) {
        realDb.exec(tbl.sql);
      }

      for (const { tableName, column } of diff.columnsToAdd) {
        const colDef = formatColumnDefinition(column);
        try {
          realDb.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${colDef}`);
        } catch (err) {
          throw new Error(
            `Failed to add column "${column.name}" to table "${tableName}": ${err.message}`
          );
        }
      }

      for (const { tableName, column } of diff.columnsToDrop) {
        try {
          realDb.exec(`ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(column.name)}`);
        } catch (err) {
          throw new Error(
            `Failed to drop column "${column.name}" from table "${tableName}": ${err.message}`
          );
        }
      }

      for (const tbl of diff.tablesToDrop) {
        realDb.exec(`DROP TABLE IF EXISTS ${quoteIdent(tbl.name)}`);
      }

      for (const idx of diff.indexesToCreate) {
        realDb.exec(idx.sql);
      }

      for (const item of statements) {
        if (item.kind === "CREATE_TABLE" || item.kind === "CREATE_INDEX") {
          continue;
        }
        if (item.kind === "CREATE_VIEW" && item.objectName) {
          if (diff.unchangedViewsTriggers.has(`view:${item.objectName.toLowerCase()}`)) {
            continue;
          }
        }
        if (item.kind === "CREATE_TRIGGER" && item.objectName) {
          if (diff.unchangedViewsTriggers.has(`trigger:${item.objectName.toLowerCase()}`)) {
            continue;
          }
        }
        realDb.exec(item.stmt);
        executedStatements++;
      }

      realDb.exec("COMMIT;");
    } catch (err) {
      try {
        realDb.exec("ROLLBACK;");
      } catch {
        // ignore rollback error if transaction already closed
      }
      throw err;
    }

    const schemaChanged =
      diff.tablesToCreate.length > 0 ||
      diff.tablesToDrop.length > 0 ||
      diff.columnsToAdd.length > 0 ||
      diff.columnsToDrop.length > 0 ||
      diff.indexesToDrop.length > 0 ||
      diff.indexesToCreate.length > 0 ||
      diff.viewsTriggersToDrop.length > 0 ||
      executedStatements > 0;

    return {
      id: parsed.id,
      mode,
      dbPath,
      schemaChanged,
      createdTables: diff.tablesToCreate.map((t) => t.name),
      droppedTables: diff.tablesToDrop.map((t) => t.name),
      addedColumns: diff.columnsToAdd.map((c) => ({ table: c.tableName, column: c.column.name })),
      droppedColumns: diff.columnsToDrop.map((c) => ({ table: c.tableName, column: c.column.name })),
      createdIndexes: diff.indexesToCreate.map((i) => i.name),
      droppedIndexes: diff.indexesToDrop.map((i) => i.name),
      executedStatements,
    };
  } finally {
    memDb?.close();
    realDb?.close();
  }
}

function normalizeJsonValue(value) {
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = normalizeJsonValue(v);
  }
  return out;
}

function buildBoundParams(stmt, paramsSource) {
  if (!paramsSource) return null;
  const placeholders = extractSqlNamedParameters(stmt);
  if (placeholders.length === 0) return null;

  const bound = {};
  let hasAny = false;
  for (const { token, name } of placeholders) {
    if (Object.hasOwn(paramsSource, name)) {
      const val = paramsSource[name];
      bound[token] = val === undefined ? null : val;
      hasAny = true;
    } else if (Object.hasOwn(paramsSource, token)) {
      const val = paramsSource[token];
      bound[token] = val === undefined ? null : val;
      hasAny = true;
    }
  }
  return hasAny ? bound : null;
}

function executeSqlStatements(dbPath, stmts, paramsSource = null) {
  let db = null;
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

    let lastResult = null;
    let totalChanges = 0;

    for (const stmt of stmts) {
      const prepared = db.prepare(stmt);
      const bound = buildBoundParams(stmt, paramsSource);
      if (prepared.columnNames.length > 0) {
        const rows = (bound ? prepared.all(bound) : prepared.all()).map(normalizeRow);
        lastResult = {
          kind: "rows",
          columns: [...prepared.columnNames],
          rows,
        };
      } else {
        const res = bound ? prepared.run(bound) : prepared.run();
        const changes = Number(normalizeJsonValue(res.changes ?? 0));
        totalChanges += changes;
        lastResult = {
          kind: "run",
          changes: totalChanges,
          lastInsertRowid: normalizeJsonValue(res.lastInsertRowid ?? 0),
        };
      }
    }

    return lastResult;
  } finally {
    db?.close();
  }
}

/**
 * Execute SQL statement(s) against a blueprint's database.
 * When given a `.html` file path, reconciles `<script type="blueprint/def">` automatically first.
 * @param {{ fileOrId: string, statement: string, dev?: boolean, dataDir?: string }} options
 */
export function runBlueprintSql({ fileOrId, statement, dev = false, dataDir }) {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new Error("SQL statement cannot be empty.");
  }

  const resolved = resolveBlueprintId(fileOrId);
  const { id, filePath } = resolved;
  const mode = getMode(dev);
  const resolvedDataDir = resolveDataDir(dataDir);
  const dbPath = ensureMainDbPath(id, mode, resolvedDataDir);

  let syncChanged = false;
  if (filePath) {
    const syncRes = syncBlueprint({ filePath, dev, dataDir: resolvedDataDir });
    syncChanged = Boolean(syncRes.schemaChanged);
  } else if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Database not found for blueprint "${id}" (${mode}) at ${dbPath}. Pass the blueprint .html file path to auto-initialize and sync the schema.`
    );
  }

  const stmts = splitSqlStatements(statement);
  if (stmts.length === 0) {
    throw new Error("SQL statement contains no executable SQL.");
  }

  const lastResult = executeSqlStatements(dbPath, stmts);
  const didWrite = syncChanged || !isReadOnlySqlScript(statement);
  return {
    id,
    mode,
    dbPath,
    didWrite,
    ...lastResult,
  };
}

/**
 * Execute a single validated read-only SQL query against `<data>/<id>/<mode>/db.sqlite`.
 * @param {{ dbPath: string, sql: string, params?: unknown }} options
 * @returns {Array<Record<string, unknown>>}
 */
export function executeReadOnlyQuery({ dbPath, sql, params = null }) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found at ${dbPath}.`);
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const prepared = db.prepare(sql);
    let rawRows;
    if (params === null || params === undefined) {
      rawRows = prepared.all();
    } else if (Array.isArray(params)) {
      rawRows = prepared.all(...params);
    } else if (isPlainObject(params)) {
      const bound = buildBoundParams(sql, params);
      rawRows = bound ? prepared.all(bound) : prepared.all();
    } else {
      throw new Error("SQL params must be an array or plain object.");
    }
    return rawRows.map(normalizeRow);
  } finally {
    db?.close();
  }
}

/**
 * Execute a `<script type="blueprint/sql" id="...">` action node against an already-synced database.
 * Binds only named parameters present in each statement from `paramsSource`.
 * Returns `rows` array for queries or `{ changes, lastInsertRowid }` for writes.
 * @param {{ dbPath: string, statement: string, paramsSource?: Record<string, unknown> }} options
 */
export function runSqlActionNode({ dbPath, statement, paramsSource = {} }) {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new Error("SQL action node cannot be empty.");
  }
  const stmts = splitSqlStatements(statement);
  if (stmts.length === 0) {
    throw new Error("SQL action node contains no executable SQL.");
  }

  const lastResult = executeSqlStatements(dbPath, stmts, paramsSource);
  if (lastResult.kind === "rows") {
    return lastResult.rows;
  }
  return {
    changes: lastResult.changes,
    lastInsertRowid: lastResult.lastInsertRowid,
  };
}
