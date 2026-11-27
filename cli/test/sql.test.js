import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBlueprintHtml, validateBlueprintId } from "../src/parse.js";
import { splitSqlStatements } from "../src/sql.js";
import { Database } from "bun:sqlite";
import { ensureMainDbPath, getMainDbPath, runBlueprintSql } from "../src/db.js";

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/bp.js");

let tmpDir;
let dataDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-sql-test-"));
  dataDir = path.join(tmpDir, "data");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeBlueprint(filename, html) {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

function runCli(args) {
  const proc = Bun.spawnSync(["bun", CLI_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("parseBlueprintHtml & splitSqlStatements", () => {
  test("parses bp:id, meta id, validates format, unescapes </script>, and ignores blueprint/sql nodes", () => {
    const p1 = parseBlueprintHtml(`
      <!doctype html>
      <html>
        <head>
          <meta id="fallback-id">
          <meta name="bp:id" content="team.console_1">
        </head>
        <body>
          <script type="blueprint/def">
            CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT);
            INSERT OR IGNORE INTO notes VALUES ('1', '<\\/script>');
          </script>
          <script type="blueprint/sql" id="fetch-notes">
            SELECT * FROM notes;
          </script>
        </body>
      </html>
    `);
    expect(p1.id).toBe("team.console_1");
    expect(p1.sqlBlocks).toHaveLength(1);
    expect(p1.sqlBlocks[0]).toContain("'</script>'");
    expect(p1.sqlBlocks[0]).not.toContain("SELECT * FROM notes");

    const p2 = parseBlueprintHtml(`
      <html><head><meta id="simple-app"></head>
      <!-- <meta name="bp:id" content="ignored-in-comment"> -->
      <script type="blueprint/def">CREATE TABLE IF NOT EXISTS a (id TEXT);</script>
      <script type="blueprint/sql" id="action-node">CREATE TABLE should_not_exist (id TEXT);</script>
      <script type="blueprint/def">CREATE TABLE IF NOT EXISTS b (id TEXT);</script>
      </html>
    `);
    expect(p2.id).toBe("simple-app");
    expect(p2.sqlBlocks).toHaveLength(2);
    expect(p2.sql).not.toContain("should_not_exist");

    expect(() => validateBlueprintId("../escape")).toThrow();
    expect(() => validateBlueprintId(".hidden")).toThrow();
    expect(() => validateBlueprintId("")).toThrow();
    expect(() => parseBlueprintHtml("<html><head></head></html>")).toThrow(/Missing blueprint ID/);
  });

  test("splits SQL statements without breaking triggers, CASE blocks, quotes, or comments", () => {
    const stmts = splitSqlStatements(`
      -- leading ; comment
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, msg TEXT DEFAULT 'a;b');
      /* block ; comment */
      CREATE TRIGGER IF NOT EXISTS tr_logs AFTER INSERT ON logs
      BEGIN
        INSERT INTO mirror (txt) VALUES (CASE WHEN NEW.id = 1 THEN 'one;1' ELSE 'other' END);
        UPDATE counters SET n = n + 1;
      END;
      INSERT OR IGNORE INTO logs (id, msg) VALUES (1, 'hello;world');
    `);

    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("CREATE TABLE IF NOT EXISTS logs");
    expect(stmts[1]).toContain("CREATE TRIGGER IF NOT EXISTS tr_logs");
    expect(stmts[1]).toContain("UPDATE counters SET n = n + 1;");
    expect(stmts[1]).toEndWith("END");
    expect(stmts[2]).toContain("'hello;world'");
  });
});

describe("auto-reconciled bp sql and isolation", () => {
  test("auto-creates tables, ignores blueprint/sql action nodes, and keeps INSERT OR IGNORE idempotent", () => {
    const htmlFile = writeBlueprint(
      "app.html",
      `
      <meta name="bp:id" content="agents-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS agents (
          id   TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
        INSERT OR IGNORE INTO agents (id, name) VALUES ('agy', 'AGY');
        INSERT OR IGNORE INTO agents (id, name) VALUES ('codex', 'Codex');
      </script>
      <script type="blueprint/sql" id="flow-sql-node">
        CREATE TABLE IF NOT EXISTS should_not_exist (id TEXT PRIMARY KEY);
        SELECT id, name FROM agents;
      </script>
      `
    );

    // First bp sql against .html automatically creates table and inserts seed data
    const initial = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT id, name FROM agents ORDER BY id",
      dataDir,
    });
    expect(initial.rows).toEqual([
      { id: "agy", name: "AGY" },
      { id: "codex", name: "Codex" },
    ]);

    // Confirm <script type="blueprint/sql" id="..."> was NOT executed during schema reconciliation
    const tables = runBlueprintSql({
      fileOrId: "agents-app",
      statement: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      dataDir,
    }).rows.map((r) => r.name);
    expect(tables).toEqual(["agents"]);

    // User modifies an existing row
    runBlueprintSql({
      fileOrId: "agents-app",
      statement: "UPDATE agents SET name = 'Custom AGY' WHERE id = 'agy'",
      dataDir,
    });

    // Next bp sql against .html must not overwrite modified row or duplicate rows
    const afterUpdate = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT id, name FROM agents ORDER BY id",
      dataDir,
    });
    expect(afterUpdate.rows).toEqual([
      { id: "agy", name: "Custom AGY" },
      { id: "codex", name: "Codex" },
    ]);
  });

  test("auto-adds columns preserving rows and rejects NOT NULL without default on non-empty tables", () => {
    const htmlFile = writeBlueprint(
      "app.html",
      `
      <meta id="col-add-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS tasks (
          id    TEXT PRIMARY KEY,
          title TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS empty_notes (
          id TEXT PRIMARY KEY
        );
        INSERT OR IGNORE INTO tasks (id, title) VALUES ('t1', 'Ship CLI');
      </script>
      `
    );

    runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT id, title FROM tasks",
      dev: true,
      dataDir,
    });

    // Add nullable, defaulted NOT NULL, and expression-default columns
    writeBlueprint(
      "app.html",
      `
      <meta id="col-add-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS tasks (
          id       TEXT PRIMARY KEY,
          title    TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 1,
          note     TEXT,
          tag      TEXT DEFAULT 'core'
        );
        CREATE TABLE IF NOT EXISTS empty_notes (
          id   TEXT PRIMARY KEY,
          slug TEXT DEFAULT (lower('EMPTY'))
        );
        INSERT OR IGNORE INTO tasks (id, title) VALUES ('t1', 'Ship CLI');
      </script>
      `
    );

    const rows = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT id, title, priority, note, tag FROM tasks",
      dev: true,
      dataDir,
    }).rows;
    expect(rows).toEqual([
      { id: "t1", title: "Ship CLI", priority: 1, note: null, tag: "core" },
    ]);

    // Attempting to add NOT NULL without DEFAULT on a non-empty table fails cleanly
    writeBlueprint(
      "app.html",
      `
      <meta id="col-add-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS tasks (
          id       TEXT PRIMARY KEY,
          title    TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 1,
          note     TEXT,
          tag      TEXT DEFAULT 'core',
          owner    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS empty_notes (
          id   TEXT PRIMARY KEY,
          slug TEXT DEFAULT (lower('EMPTY'))
        );
      </script>
      `
    );

    expect(() =>
      runBlueprintSql({
        fileOrId: htmlFile,
        statement: "SELECT * FROM tasks",
        dev: true,
        dataDir,
      })
    ).toThrow(/NOT NULL column "owner" without a DEFAULT/);
  });

  test("auto-drops columns and tables without creating backups directory", () => {
    const htmlFile = writeBlueprint(
      "app.html",
      `
      <meta name="bp:id" content="drop-col-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS users (
          id     TEXT PRIMARY KEY,
          name   TEXT NOT NULL,
          secret TEXT
        );
        CREATE TABLE IF NOT EXISTS temp_log (msg TEXT);
        CREATE INDEX IF NOT EXISTS idx_users_secret ON users(secret);
        INSERT OR IGNORE INTO users (id, name, secret) VALUES ('u1', 'Alice', 'top-secret');
      </script>
      `
    );

    runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT id, name, secret FROM users",
      dataDir,
    });

    // Remove `secret` column, its index, and `temp_log` table
    writeBlueprint(
      "app.html",
      `
      <meta name="bp:id" content="drop-col-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS users (
          id   TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
      </script>
      `
    );

    const cols = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "PRAGMA table_info(users)",
      dataDir,
    }).rows.map((r) => r.name);
    expect(cols).toEqual(["id", "name"]);

    const tables = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      dataDir,
    }).rows.map((r) => r.name);
    expect(tables).toEqual(["users"]);

    // Verify no backups directory is created under the blueprint data root
    expect(fs.existsSync(path.join(dataDir, "drop-app", "backups"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "blueprints"))).toBe(false);
  });

  test("isolates dev and prod databases completely", () => {
    const htmlFile = writeBlueprint(
      "app.html",
      `
      <meta name="bp:id" content="iso-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        INSERT OR IGNORE INTO kv VALUES ('env', 'default');
      </script>
      `
    );

    runBlueprintSql({
      fileOrId: htmlFile,
      statement: "UPDATE kv SET v = 'production' WHERE k = 'env'",
      dev: false,
      dataDir,
    });
    runBlueprintSql({
      fileOrId: htmlFile,
      statement: "UPDATE kv SET v = 'development' WHERE k = 'env'",
      dev: true,
      dataDir,
    });

    const prodVal = runBlueprintSql({
      fileOrId: "iso-app",
      statement: "SELECT v FROM kv WHERE k = 'env'",
      dev: false,
      dataDir,
    }).rows[0].v;
    const devVal = runBlueprintSql({
      fileOrId: "iso-app",
      statement: "SELECT v FROM kv WHERE k = 'env'",
      dev: true,
      dataDir,
    }).rows[0].v;

    expect(prodVal).toBe("production");
    expect(devVal).toBe("development");
    expect(fs.existsSync(getMainDbPath("iso-app", "prod", dataDir))).toBe(true);
    expect(fs.existsSync(getMainDbPath("iso-app", "dev", dataDir))).toBe(true);
    expect(getMainDbPath("iso-app", "prod", dataDir)).toBe(
      path.join(dataDir, "iso-app", "prod", "db.sqlite")
    );

    // Dropping table in dev does not affect prod
    writeBlueprint(
      "app.html",
      `
      <meta name="bp:id" content="iso-app">
      <script type="blueprint/def"></script>
      `
    );
    const devTables = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      dev: true,
      dataDir,
    }).rows;
    expect(devTables).toEqual([]);

    expect(
      runBlueprintSql({
        fileOrId: "iso-app",
        statement: "SELECT v FROM kv WHERE k = 'env'",
        dev: false,
        dataDir,
      }).rows[0].v
    ).toBe("production");
  });

  test("migrates legacy blueprints/<id>.<mode>.sqlite into <id>/<mode>/db.sqlite", () => {
    const legacyPath = path.join(dataDir, "blueprints", "legacy-app.prod.sqlite");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const seed = new Database(legacyPath);
    seed.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT); INSERT INTO kv VALUES ('hello', 'world');");
    seed.close();

    const migrated = ensureMainDbPath("legacy-app", "prod", dataDir);
    expect(migrated).toBe(path.join(dataDir, "legacy-app", "prod", "db.sqlite"));
    expect(fs.existsSync(migrated)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);

    const rows = runBlueprintSql({
      fileOrId: "legacy-app",
      statement: "SELECT v FROM kv WHERE k = 'hello'",
      dataDir,
    }).rows;
    expect(rows).toEqual([{ v: "world" }]);
  });

  test("handles triggers, index updates, and .html file decoupling", () => {
    const htmlFile = writeBlueprint(
      "trig.html",
      `
      <meta name="bp:id" content="trig-app">
      <script type="blueprint/def">
        CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, extra TEXT);
        CREATE TABLE audit (msg TEXT);
        CREATE INDEX idx_events_kind ON events(kind);
        CREATE TRIGGER tr_events_ins AFTER INSERT ON events
        BEGIN
          INSERT INTO audit VALUES (CASE WHEN NEW.kind = 'a' THEN 'alpha;ok' ELSE NEW.kind END);
        END;
      </script>
      `
    );

    runBlueprintSql({
      fileOrId: htmlFile,
      statement: "INSERT INTO events (id, kind, extra) VALUES (1, 'a', 'x')",
      dataDir,
    });
    expect(
      runBlueprintSql({ fileOrId: htmlFile, statement: "SELECT msg FROM audit", dataDir }).rows
    ).toEqual([{ msg: "alpha;ok" }]);

    // Update index to UNIQUE and drop `extra` column while keeping trigger working
    writeBlueprint(
      "trig.html",
      `
      <meta name="bp:id" content="trig-app">
      <script type="blueprint/def">
        CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT);
        CREATE TABLE audit (msg TEXT);
        CREATE UNIQUE INDEX idx_events_kind ON events(kind);
        CREATE TRIGGER tr_events_ins AFTER INSERT ON events
        BEGIN
          INSERT INTO audit VALUES (CASE WHEN NEW.kind = 'a' THEN 'alpha;ok' ELSE NEW.kind END);
        END;
      </script>
      `
    );
    const evCols = runBlueprintSql({
      fileOrId: htmlFile,
      statement: "PRAGMA table_info(events)",
      dataDir,
    }).rows.map((r) => r.name);
    expect(evCols).toEqual(["id", "kind"]);

    // Deleting .html and recreating it with same ID reconnects to existing data
    fs.unlinkSync(htmlFile);
    expect(fs.existsSync(getMainDbPath("trig-app", "prod", dataDir))).toBe(true);
    const recreatedFile = writeBlueprint(
      "trig-recreated.html",
      `
      <meta name="bp:id" content="trig-app">
      <script type="blueprint/def">
        CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT);
        CREATE TABLE audit (msg TEXT);
        CREATE UNIQUE INDEX idx_events_kind ON events(kind);
      </script>
      `
    );
    expect(
      runBlueprintSql({ fileOrId: recreatedFile, statement: "SELECT msg FROM audit", dataDir }).rows
    ).toEqual([{ msg: "alpha;ok" }]);
  });

  test("CLI executable bp.js works end-to-end with bp sql and rejects removed commands", () => {
    const htmlFile = writeBlueprint(
      "cli.html",
      `
      <meta name="bp:id" content="cli-e2e">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS notes (
          id      TEXT PRIMARY KEY,
          body    TEXT,
          old_col TEXT
        );
        INSERT OR IGNORE INTO notes VALUES ('n1', 'hello', 'keep-me');
      </script>
      `
    );

    // Direct bp sql against .html auto-syncs schema & seed rows, then inserts
    const insertRes = runCli([
      "sql",
      htmlFile,
      "INSERT INTO notes VALUES ('n2', 'world', 'also-keep')",
      "--dev",
      "--data",
      dataDir,
      "--json",
    ]);
    expect(insertRes.exitCode).toBe(0);
    expect(JSON.parse(insertRes.stdout).changes).toBe(1);

    const selectRes = runCli([
      "sql",
      htmlFile,
      "SELECT id, body, old_col FROM notes ORDER BY id",
      "--dev",
      "--data",
      dataDir,
      "--json",
    ]);
    expect(selectRes.exitCode).toBe(0);
    expect(JSON.parse(selectRes.stdout)).toEqual([
      { id: "n1", body: "hello", old_col: "keep-me" },
      { id: "n2", body: "world", old_col: "also-keep" },
    ]);

    // Update HTML schema to drop old_col; next bp sql reconciles automatically
    writeBlueprint(
      "cli.html",
      `
      <meta name="bp:id" content="cli-e2e">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS notes (
          id   TEXT PRIMARY KEY,
          body TEXT
        );
      </script>
      `
    );
    const afterDropRes = runCli([
      "sql",
      htmlFile,
      "SELECT * FROM notes ORDER BY id",
      "--dev",
      "--data",
      dataDir,
      "--json",
    ]);
    expect(afterDropRes.exitCode).toBe(0);
    expect(JSON.parse(afterDropRes.stdout)).toEqual([
      { id: "n1", body: "hello" },
      { id: "n2", body: "world" },
    ]);

    // Removed subcommands return an error
    for (const removed of ["sync", "backups", "restore"]) {
      const res = runCli([removed, htmlFile, "--data", dataDir]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(`Unknown command "${removed}"`);
    }
  });
});
