import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDaemonStatus,
  readDaemonConfig,
  readDaemonInfo,
  startDaemon,
} from "../src/daemon.js";
import { runBlueprintSql } from "../src/db.js";
import { extractHtmlTitle, renderBrowserHtml } from "../src/parse.js";
import { getNextScheduleTime, parseSchedule, startSchedule } from "../src/schedule.js";
import { validateReadOnlySql, validateWatchQuery } from "../src/sql.js";

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/bp.js");

let tmpDir;
let blueprintsDir;
let dataDir;
const activeDaemons = [];
const activeServers = [];
const activeDataDirsForCleanup = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-daemon-test-"));
  blueprintsDir = path.join(tmpDir, "blueprints");
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(blueprintsDir, { recursive: true });
  activeDataDirsForCleanup.push(dataDir);
});

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop();
    try {
      await d.shutdown();
    } catch {
      // ignore
    }
  }

  while (activeServers.length > 0) {
    const s = activeServers.pop();
    try {
      s.stop(true);
    } catch {
      // ignore
    }
  }

  for (const dir of activeDataDirsForCleanup.splice(0)) {
    const info = readDaemonInfo(dir);
    if (info && Number.isInteger(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // ignore if already dead
      }
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeBlueprint(filename, html) {
  const filePath = path.join(blueprintsDir, filename);
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function runCliAsync(args, envOverrides = {}) {
  const proc = Bun.spawn(["bun", CLI_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function createMockOllama(decideNext) {
  const requests = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await req.json();
        requests.push(body);
        const next = await decideNext(body, requests.length);
        return Response.json({
          model: body.model,
          message: {
            role: "assistant",
            content: JSON.stringify({ next }),
          },
          done: true,
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  activeServers.push(srv);
  return {
    server: srv,
    url: `http://127.0.0.1:${srv.port}`,
    requests,
  };
}

class WsTestClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.closed = false;

    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (ev) => reject(new Error(ev?.message || "WS error")));
    });

    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (w.predicate(msg)) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      this.messages.push(msg);
    });

    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  async connect() {
    await this.opened;
    return this;
  }

  waitFor(predicate, timeoutMs = 4000) {
    for (let i = 0; i < this.messages.length; i++) {
      if (predicate(this.messages[i])) {
        return Promise.resolve(this.messages.splice(i, 1)[0]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for WS message`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  async rpc(payload) {
    const id = Math.floor(Math.random() * 1e9) + Date.now();
    const wait = this.waitFor((m) => m.id === id);
    this.ws.send(JSON.stringify({ id, ...payload }));
    return wait;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

describe("parse helpers, schedule parser, and read-only SQL guard", () => {
  test("renderBrowserHtml strips all blueprint/* script blocks, keeps comments and frontend scripts, and injects bp.js before inline scripts", () => {
    const raw = `<!doctype html>
<html>
  <head>
    <meta name="bp:id" content="strip-test" />
    <title>Strip &amp; Render</title>
  </head>
  <body>
    <!-- <script type="blueprint/def">commented block should stay</script> -->
    <div id="app"></div>
    <script>window.__seenBp = typeof window.bp;</script>
    <script type="module">console.log("keep module");</script>
    <script type="blueprint/def">CREATE TABLE IF NOT EXISTS t (id TEXT);</script>
    <script type="blueprint/flow" on="x">Run s then done.</script>
    <script type="blueprint/js" id="s">export default () => 1;</script>
    <script type="blueprint/sh" id="sh1">echo hi</script>
    <script type="blueprint/sql" id="q1">SELECT 1;</script>
    <script type="blueprint/emit" id="e1" event="x:done"></script>
    <script type="blueprint/ai" id="a1" cli="agy">Role</script>
    <script type="blueprint/init.seed">seed();</script>
  </body>
</html>`;

    expect(extractHtmlTitle(raw)).toBe("Strip & Render");

    const rendered = renderBrowserHtml(raw, "/bp/strip-test/bp.js");
    expect(rendered).toContain('<script src="/bp/strip-test/bp.js"></script>');
    expect(rendered).toContain("<!-- <script type=\"blueprint/def\">commented block should stay</script> -->");
    expect(rendered).toContain('window.__seenBp = typeof window.bp');
    expect(rendered).toContain('console.log("keep module")');

    // Every blueprint/* block outside HTML comments must be stripped
    expect(rendered).not.toContain('CREATE TABLE IF NOT EXISTS t');
    expect(rendered).not.toContain('type="blueprint/flow"');
    expect(rendered).not.toContain('type="blueprint/js"');
    expect(rendered).not.toContain('type="blueprint/sh"');
    expect(rendered).not.toContain('type="blueprint/sql"');
    expect(rendered).not.toContain('type="blueprint/emit"');
    expect(rendered).not.toContain('type="blueprint/ai"');
    expect(rendered).not.toContain('type="blueprint/init.seed"');

    // Injected script must appear before inline body script
    const injectedPos = rendered.indexOf('<script src="/bp/strip-test/bp.js"></script>');
    const inlinePos = rendered.indexOf('<script>window.__seenBp');
    expect(injectedPos).toBeGreaterThan(-1);
    expect(injectedPos).toBeLessThan(inlinePos);

    // Works without <head> too
    const headless = `<!doctype html><script>console.log(1)</script><script type="blueprint/def">SELECT 1;</script>`;
    const renderedHeadless = renderBrowserHtml(headless, "/bp-dev/x/bp.js");
    expect(renderedHeadless.indexOf('<script src="/bp-dev/x/bp.js"></script>')).toBeLessThan(
      renderedHeadless.indexOf("<script>console.log(1)</script>")
    );
    expect(renderedHeadless).not.toContain("blueprint/def");
  });

  test("schedule.js parses <n>s/m/h, HH:MM, and 5-field cron accurately and clears timers on stop()", async () => {
    expect(parseSchedule("1s")).toMatchObject({ kind: "interval", intervalMs: 1000 });
    expect(parseSchedule("5m")).toMatchObject({ kind: "interval", intervalMs: 300_000 });
    expect(parseSchedule("2h")).toMatchObject({ kind: "interval", intervalMs: 7_200_000 });

    const morning = parseSchedule("09:00");
    expect(morning).toMatchObject({ kind: "daily", hour: 9, minute: 0 });
    const nextSameDay = getNextScheduleTime(morning, new Date(2026, 4, 10, 8, 30, 0));
    expect(nextSameDay.getFullYear()).toBe(2026);
    expect(nextSameDay.getMonth()).toBe(4);
    expect(nextSameDay.getDate()).toBe(10);
    expect(nextSameDay.getHours()).toBe(9);
    expect(nextSameDay.getMinutes()).toBe(0);

    const nextTomorrow = getNextScheduleTime(morning, new Date(2026, 4, 10, 9, 0, 0));
    expect(nextTomorrow.getDate()).toBe(11);
    expect(nextTomorrow.getHours()).toBe(9);

    const cronNext = getNextScheduleTime("*/5 10-12 * * MON-FRI", new Date(2026, 4, 11, 10, 3, 20)); // Monday
    expect(cronNext.getHours()).toBe(10);
    expect(cronNext.getMinutes()).toBe(5);

    expect(() => parseSchedule("0s")).toThrow();
    expect(() => parseSchedule("25:00")).toThrow();
    expect(() => parseSchedule("* * 31 2 *")).toThrow();
    expect(() => parseSchedule("* * *")).toThrow();

    let ticks = 0;
    const handle = startSchedule("1s", () => {
      ticks++;
    });
    handle.stop();
    await Bun.sleep(50);
    expect(ticks).toBe(0);
  });

  test("validateReadOnlySql and validateWatchQuery allow reads and block mutations/multi-statements", () => {
    expect(validateWatchQuery("notes").sql).toBe('SELECT * FROM "notes"');
    expect(validateWatchQuery("SELECT id, body FROM notes WHERE body != 'DROP TABLE'").kind).toBe("query");
    expect(
      validateReadOnlySql("WITH latest AS (SELECT * FROM notes LIMIT 5) SELECT replace(body, 'a', 'b') FROM latest")
    ).toContain("WITH latest");
    expect(validateReadOnlySql("PRAGMA table_info(notes)", { allowPragmaTableInfo: true })).toBe(
      "PRAGMA table_info(notes)"
    );

    for (const bad of [
      "INSERT INTO notes VALUES ('1', 'x')",
      "UPDATE notes SET body = 'x'",
      "DELETE FROM notes",
      "DROP TABLE notes",
      "ALTER TABLE notes ADD COLUMN x TEXT",
      "CREATE TABLE evil (id TEXT)",
      "REPLACE INTO notes VALUES ('1', 'x')",
      "ATTACH DATABASE ':memory:' AS extra",
      "PRAGMA journal_mode = DELETE",
      "SELECT 1; DROP TABLE notes;",
      "WITH x AS (SELECT 1) DELETE FROM notes",
    ]) {
      expect(() => validateReadOnlySql(bad, { allowPragmaTableInfo: true })).toThrow();
      expect(() => validateWatchQuery(bad)).toThrow();
    }
  });
});

describe("Daemon HTTP overview, HTML stripping, client.js, and WS API", () => {
  test("GET / lists blueprints with prod/dev links and parse error banner; GET /bp/<slug> returns 500 error page for broken blueprints and stripped HTML for valid ones", async () => {
    writeBlueprint(
      "notes.html",
      `<!doctype html>
<html>
  <head>
    <meta name="bp:id" content="notes-app" />
    <title>Notes App</title>
  </head>
  <body>
    <h1>Notes</h1>
    <script>window.__boot = true;</script>
    <script type="blueprint/def">
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      INSERT OR IGNORE INTO notes (id, body) VALUES ('n1', 'initial note');
    </script>
  </body>
</html>`
    );

    writeBlueprint(
      "broken.html",
      `<!doctype html>
<html>
  <head><title>Broken Blueprint</title></head>
  <body><p>Missing bp:id</p></body>
</html>`
    );

    const daemon = startDaemon({
      dir: blueprintsDir,
      bind: "127.0.0.1",
      port: 0,
      dataDir,
      writeFiles: false,
    });
    activeDaemons.push(daemon);

    const overviewRes = await fetch(`${daemon.baseUrl}/`);
    expect(overviewRes.status).toBe(200);
    const overviewHtml = await overviewRes.text();
    expect(overviewHtml).toContain("Notes App");
    expect(overviewHtml).toContain("notes-app");
    expect(overviewHtml).toContain('href="/bp/notes"');
    expect(overviewHtml).toContain('href="/bp-dev/notes"');
    expect(overviewHtml).toContain("Broken Blueprint");
    expect(overviewHtml).toContain('href="/bp/broken"');
    expect(overviewHtml).toContain('href="/bp-dev/broken"');
    expect(overviewHtml).toContain("Missing blueprint ID");

    // Broken blueprint returns HTTP 500 with clean readable error page
    const brokenRes = await fetch(`${daemon.baseUrl}/bp/broken`);
    expect(brokenRes.status).toBe(500);
    const brokenHtml = await brokenRes.text();
    expect(brokenHtml).toContain('Failed to load blueprint "broken"');
    expect(brokenHtml).toContain("Missing blueprint ID");

    // Valid blueprint strips blueprint/* scripts and injects /bp/notes/bp.js
    const notesRes = await fetch(`${daemon.baseUrl}/bp/notes`);
    expect(notesRes.status).toBe(200);
    const notesHtml = await notesRes.text();
    expect(notesHtml).toContain('<script src="/bp/notes/bp.js"></script>');
    expect(notesHtml).toContain("window.__boot = true;");
    expect(notesHtml).not.toContain("CREATE TABLE IF NOT EXISTS notes");

    // Dev page lazy-loads dev DB and injects /bp-dev/notes/bp.js
    const notesDevRes = await fetch(`${daemon.baseUrl}/bp-dev/notes`);
    expect(notesDevRes.status).toBe(200);
    const notesDevHtml = await notesDevRes.text();
    expect(notesDevHtml).toContain('<script src="/bp-dev/notes/bp.js"></script>');
    expect(notesDevHtml).not.toContain("CREATE TABLE IF NOT EXISTS notes");

    // client.js served cleanly and has NO corner reload button
    const bpJsRes = await fetch(`${daemon.baseUrl}/bp/notes/bp.js`);
    expect(bpJsRes.status).toBe(200);
    expect(bpJsRes.headers.get("content-type")).toContain("text/javascript");
    const bpJs = await bpJsRes.text();
    expect(bpJs).toContain("window.bp = bp");
    expect(bpJs).toContain("location.reload()");
    expect(bpJs).not.toContain("createElement");
    expect(bpJs).not.toContain("appendChild");
  });

  test("client.js exposes bp.emit, bp.on, bp.watch, bp.sql, bp.mode and auto-reloads on { op: 'reload' } in browser-like environment", async () => {
    const clientCode = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/client.js"),
      "utf8"
    );

    const sentFrames = [];
    const sockets = [];
    let reloadCount = 0;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.listeners = new Map();
        sockets.push(this);
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      send(data) {
        sentFrames.push(JSON.parse(data));
      }
      emitMock(type, payload) {
        for (const fn of this.listeners.get(type) || []) fn(payload);
      }
    }

    const fakeWindow = {
      location: {
        href: "http://127.0.0.1:7500/bp-dev/chat",
        pathname: "/bp-dev/chat",
        reload() {
          reloadCount++;
        },
      },
      setTimeout,
      clearTimeout,
    };

    const fn = new Function(
      "window",
      "document",
      "WebSocket",
      clientCode
    );
    fn(
      fakeWindow,
      { currentScript: { src: "http://127.0.0.1:7500/bp-dev/chat/bp.js" } },
      MockWebSocket
    );

    const bp = fakeWindow.bp;
    expect(bp).toBeDefined();
    expect(bp.mode).toBe("dev");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://127.0.0.1:7500/bp-dev/chat/ws");

    // Subscribe before WS finishes opening (queued in outbox)
    const watchedSnapshots = [];
    const unwatch = bp.watch("messages", (rows) => watchedSnapshots.push(rows));
    const receivedEvents = [];
    const unlisten = bp.on("msg:saved", (data) => receivedEvents.push(data));

    // Open socket -> flushes outbox watch request
    sockets[0].readyState = MockWebSocket.OPEN;
    sockets[0].emitMock("open", {});
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({ op: "watch", query: "messages" });

    // Server replies with initial watch rows
    sockets[0].emitMock("message", {
      data: JSON.stringify({ id: sentFrames[0].id, ok: true, rows: [{ id: 1, text: "hi" }] }),
    });
    await Promise.resolve();
    expect(watchedSnapshots).toEqual([[{ id: 1, text: "hi" }]]);

    // Server pushes change & event
    sockets[0].emitMock("message", {
      data: JSON.stringify({ op: "change", query: "messages", rows: [{ id: 1, text: "hi" }, { id: 2, text: "yo" }] }),
    });
    sockets[0].emitMock("message", {
      data: JSON.stringify({ op: "event", event: "msg:saved", source: "flow", data: { id: 2 } }),
    });
    expect(watchedSnapshots).toHaveLength(2);
    expect(receivedEvents).toEqual([{ id: 2 }]);

    // bp.sql resolves rows and bp.emit resolves
    const sqlPromise = bp.sql("SELECT * FROM messages WHERE id = ?", [2]);
    const sqlReq = sentFrames[sentFrames.length - 1];
    expect(sqlReq).toMatchObject({ op: "sql", sql: "SELECT * FROM messages WHERE id = ?", params: [2] });
    sockets[0].emitMock("message", {
      data: JSON.stringify({ id: sqlReq.id, ok: true, rows: [{ id: 2, text: "yo" }] }),
    });
    expect(await sqlPromise).toEqual([{ id: 2, text: "yo" }]);

    const emitPromise = bp.emit("msg:send", { text: "hey" });
    const emitReq = sentFrames[sentFrames.length - 1];
    sockets[0].emitMock("message", { data: JSON.stringify({ id: emitReq.id, ok: true }) });
    await emitPromise;

    unwatch();
    unlisten();
    expect(sentFrames[sentFrames.length - 1]).toEqual({ op: "unwatch", query: "messages" });

    // { op: "reload" } calls location.reload()
    sockets[0].emitMock("message", { data: JSON.stringify({ op: "reload" }) });
    expect(reloadCount).toBe(1);
  });

  test("single unified WebSocket handles watch, unwatch, read-only sql, write rejection, emit flow + blueprint/emit broadcast, and bp sql write notify", async () => {
    const mockOllama = createMockOllama((body) => {
      const prompt = body.messages[1].content;
      if (prompt.includes("(none yet)")) return "save-msg";
      if (prompt.includes("#1 save-msg [ok]") && !prompt.includes("#2 notify-saved")) return "notify-saved";
      return "done";
    });

    writeBlueprint(
      "chat.html",
      `<!doctype html>
<html>
  <head>
    <meta name="bp:id" content="chat-ws" />
    <title>Chat WS</title>
  </head>
  <body>
    <script type="blueprint/def">
      CREATE TABLE IF NOT EXISTS messages (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        body TEXT NOT NULL
      );
      INSERT OR IGNORE INTO messages (id, room, body) VALUES (1, 'general', 'welcome');
      INSERT OR IGNORE INTO messages (id, room, body) VALUES (2, 'ops', 'alert');
    </script>
    <script type="blueprint/flow" on="msg:send">
      Run save-msg, then notify-saved, then done.
    </script>
    <script type="blueprint/sql" id="save-msg" desc="Insert message">
      INSERT INTO messages (room, body) VALUES (:room, :body) RETURNING id, room, body;
    </script>
    <script type="blueprint/emit" id="notify-saved" event="msg:saved" desc="Notify UI"></script>
  </body>
</html>`
    );

    const daemon = startDaemon({
      dir: blueprintsDir,
      bind: "127.0.0.1",
      port: 0,
      dataDir,
      ollamaUrl: mockOllama.url,
      writeFiles: true,
    });
    activeDaemons.push(daemon);

    const wsUrl = daemon.baseUrl.replace("http://", "ws://") + "/bp/chat/ws";
    const client = await new WsTestClient(wsUrl).connect();

    try {
      // 1. Watch plain table name
      const wTable = await client.rpc({ op: "watch", query: "messages" });
      expect(wTable.ok).toBe(true);
      expect(wTable.rows).toHaveLength(2);

      // 2. Watch conditional SELECT query
      const condQuery = "SELECT id, body FROM messages WHERE room = 'general' ORDER BY id DESC LIMIT 5";
      const wCond = await client.rpc({ op: "watch", query: condQuery });
      expect(wCond.ok).toBe(true);
      expect(wCond.rows).toEqual([{ id: 1, body: "welcome" }]);

      // 3. Read-only sql with named & positional params
      const sqlNamed = await client.rpc({
        op: "sql",
        sql: "SELECT id, room, body FROM messages WHERE room = :room",
        params: { room: "ops" },
      });
      expect(sqlNamed.ok).toBe(true);
      expect(sqlNamed.rows).toEqual([{ id: 2, room: "ops", body: "alert" }]);

      const sqlPos = await client.rpc({
        op: "sql",
        sql: "SELECT id, body FROM messages WHERE id = ?",
        params: [1],
      });
      expect(sqlPos.ok).toBe(true);
      expect(sqlPos.rows).toEqual([{ id: 1, body: "welcome" }]);

      // 4. Reject write / DDL / multi-statement SQL over WS sql & watch
      for (const badSql of [
        "INSERT INTO messages (room, body) VALUES ('general', 'hack')",
        "UPDATE messages SET body = 'hack'",
        "DELETE FROM messages",
        "DROP TABLE messages",
        "SELECT 1; DROP TABLE messages;",
      ]) {
        const badRes = await client.rpc({ op: "sql", sql: badSql });
        expect(badRes.ok).toBe(false);
        expect(badRes.error).toMatch(/Read-only SQL|Multi-statement/);

        const badWatch = await client.rpc({ op: "watch", query: badSql });
        expect(badWatch.ok).toBe(false);
      }

      // 5. WS emit triggers flow, broadcasts ui event + flow blueprint/emit event + watch change frames
      const uiEvPromise = client.waitFor((m) => m.op === "event" && m.event === "msg:send" && m.source === "ui");
      const flowEvPromise = client.waitFor((m) => m.op === "event" && m.event === "msg:saved" && m.source === "flow");
      const tableChangePromise = client.waitFor((m) => m.op === "change" && m.query === "messages");
      const condChangePromise = client.waitFor((m) => m.op === "change" && m.query === condQuery);

      const emitReply = await client.rpc({
        op: "emit",
        event: "msg:send",
        data: { room: "general", body: "hello live ws" },
      });
      expect(emitReply.ok).toBe(true);

      const [uiEv, flowEv, tableChange, condChange] = await Promise.all([
        uiEvPromise,
        flowEvPromise,
        tableChangePromise,
        condChangePromise,
      ]);

      expect(uiEv.data).toEqual({ room: "general", body: "hello live ws" });
      expect(flowEv.data).toEqual([{ id: 3, room: "general", body: "hello live ws" }]);
      expect(tableChange.rows).toHaveLength(3);
      expect(condChange.rows).toEqual([
        { id: 3, body: "hello live ws" },
        { id: 1, body: "welcome" },
      ]);

      // 6. bp sql write from CLI notifies running daemon so active watch refreshes
      const tableChangeFromSql = client.waitFor(
        (m) => m.op === "change" && m.query === "messages" && m.rows.length === 4
      );
      const sqlNotifyPromise = client.waitFor(
        (m) => m.op === "change" && m.query === condQuery && m.rows.some((r) => r.body === "via bp sql")
      );
      const cliSqlRes = await runCliAsync([
        "sql",
        "chat-ws",
        "INSERT INTO messages (room, body) VALUES ('general', 'via bp sql')",
        "--data",
        dataDir,
        "--json",
      ]);
      expect(cliSqlRes.exitCode).toBe(0);
      const [, afterCliWatch] = await Promise.all([tableChangeFromSql, sqlNotifyPromise]);
      expect(afterCliWatch.rows[0].body).toBe("via bp sql");

      // 7. Unwatch stops change pushes on that query
      const unw = await client.rpc({ op: "unwatch", query: condQuery });
      expect(unw.ok).toBe(true);
      const tableOnlyChange = client.waitFor((m) => m.op === "change" && m.query === "messages");
      await runCliAsync([
        "sql",
        "chat-ws",
        "INSERT INTO messages (room, body) VALUES ('general', 'after unwatch')",
        "--data",
        dataDir,
      ]);
      const tChange2 = await tableOnlyChange;
      expect(tChange2.rows).toHaveLength(5);
      await Bun.sleep(60);
      expect(client.messages.some((m) => m.op === "change" && m.query === condQuery)).toBe(false);
    } finally {
      client.close();
    }
  });
});

describe("CLI commands: bp up, bp down, bp reload, bp emit, bp logs, and scheduler", () => {
  test("bp emit fails clearly when daemon is NOT running, and works with bp up / bp down / bp reload / bp logs / dev lazy-load", async () => {
    // 1. bp emit fails cleanly when daemon is not running
    const offlineEmit = await runCliAsync([
      "emit",
      "notes",
      "note:add",
      '{"id":"1"}',
      "--data",
      dataDir,
    ]);
    expect(offlineEmit.exitCode).toBe(1);
    expect(offlineEmit.stderr).toContain('Daemon is not running. Start it with "bp up" first.');

    // Also test stale daemon.json cleanup
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "daemon.json"),
      JSON.stringify({ pid: 999999, bind: "127.0.0.1", port: 59999, dir: blueprintsDir }),
      "utf8"
    );
    const staleStatus = await getDaemonStatus(dataDir);
    expect(staleStatus.running).toBe(false);
    expect(staleStatus.cleanedStale).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "daemon.json"))).toBe(false);

    // Prepare mock Ollama + blueprint with init + on + every="1s"
    const mockOllama = createMockOllama((body) => {
      const prompt = body.messages[1].content;
      if (prompt.includes("type: init") && prompt.includes("(none yet)")) return "init-mark";
      if (prompt.includes("type: every") && prompt.includes("(none yet)")) return "tick-inc";
      if (prompt.includes("type: note:add") && prompt.includes("(none yet)")) return "add-note";
      return "done";
    });

    const bpPath = writeBlueprint(
      "notes.html",
      `<!doctype html>
<html>
  <head>
    <meta name="bp:id" content="notes-daemon" />
    <title>Notes Daemon</title>
  </head>
  <body>
    <script type="blueprint/def">
      CREATE TABLE IF NOT EXISTS notes (
        id   TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flags (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    </script>
    <script type="blueprint/flow" init>
      Run init-mark then done.
    </script>
    <script type="blueprint/flow" every="1s">
      Run tick-inc then done.
    </script>
    <script type="blueprint/flow" on="note:add">
      Run add-note then done.
    </script>
    <script type="blueprint/sql" id="init-mark">
      INSERT OR REPLACE INTO flags (k, v) VALUES ('init_ran', 'yes');
    </script>
    <script type="blueprint/sql" id="tick-inc">
      INSERT INTO ticks (ts) VALUES (datetime('now'));
    </script>
    <script type="blueprint/sql" id="add-note">
      INSERT INTO notes (id, body) VALUES (:id, :body);
    </script>
  </body>
</html>`
    );

    const freePort = await getFreePort();

    // 2. Detached bp up
    const upRes = await runCliAsync([
      "up",
      blueprintsDir,
      "--port",
      String(freePort),
      "--data",
      dataDir,
      "--ollama",
      mockOllama.url,
      "--json",
    ]);
    expect(upRes.exitCode).toBe(0);
    const upJson = JSON.parse(upRes.stdout);
    expect(upJson.ok).toBe(true);
    expect(upJson.port).toBe(freePort);
    expect(upJson.url).toBe(`http://127.0.0.1:${freePort}`);
    expect(fs.existsSync(path.join(dataDir, "daemon.json"))).toBe(true);
    expect(readDaemonConfig(dataDir)).toEqual({
      dir: path.resolve(blueprintsDir),
      bind: "127.0.0.1",
      port: freePort,
    });

    // Reject duplicate bp up while running
    const dupUp = await runCliAsync(["up", "--data", dataDir]);
    expect(dupUp.exitCode).toBe(1);
    expect(dupUp.stderr).toContain("Daemon is already running");

    // Verify /_bp/health
    const healthRes = await fetch(`http://127.0.0.1:${freePort}/_bp/health`);
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(upJson.pid);

    // Wait briefly for background `init` and at least one `every="1s"` tick
    await Bun.sleep(1350);

    const initFlagRows = runBlueprintSql({
      fileOrId: "notes-daemon",
      statement: "SELECT v FROM flags WHERE k = 'init_ran'",
      dataDir,
    }).rows;
    expect(initFlagRows).toEqual([{ v: "yes" }]);

    const tickRows = runBlueprintSql({
      fileOrId: "notes-daemon",
      statement: "SELECT COUNT(*) AS cnt FROM ticks",
      dataDir,
    }).rows;
    expect(tickRows[0].cnt).toBeGreaterThanOrEqual(1);

    // 3. bp emit in prod & lazy-loaded dev
    const emitProd = await runCliAsync([
      "emit",
      "notes",
      "note:add",
      JSON.stringify({ id: "p1", body: "prod note" }),
      "--data",
      dataDir,
      "--json",
    ]);
    expect(emitProd.exitCode).toBe(0);
    expect(JSON.parse(emitProd.stdout).mode).toBe("prod");

    const emitDev = await runCliAsync([
      "emit",
      "notes",
      "note:add",
      JSON.stringify({ id: "d1", body: "dev note" }),
      "--dev",
      "--data",
      dataDir,
      "--json",
    ]);
    expect(emitDev.exitCode).toBe(0);
    expect(JSON.parse(emitDev.stdout).mode).toBe("dev");

    // Verify prod/dev DB isolation
    expect(
      runBlueprintSql({
        fileOrId: "notes-daemon",
        statement: "SELECT id, body FROM notes",
        dataDir,
      }).rows
    ).toEqual([{ id: "p1", body: "prod note" }]);
    expect(
      runBlueprintSql({
        fileOrId: "notes-daemon",
        statement: "SELECT id, body FROM notes",
        dev: true,
        dataDir,
      }).rows
    ).toEqual([{ id: "d1", body: "dev note" }]);

    // 4. Connect WS to prod and dev to verify { op: "reload" } broadcast on bp reload
    const prodWs = await new WsTestClient(`ws://127.0.0.1:${freePort}/bp/notes/ws`).connect();
    const devWs = await new WsTestClient(`ws://127.0.0.1:${freePort}/bp-dev/notes/ws`).connect();

    try {
      // Edit notes.html to add a `tag TEXT DEFAULT 'general'` column
      const updatedHtml = fs
        .readFileSync(bpPath, "utf8")
        .replace(
          "body TEXT NOT NULL",
          "body TEXT NOT NULL,\n        tag  TEXT DEFAULT 'general'"
        );
      writeBlueprint("notes.html", updatedHtml);

      // Change-detecting bp reload (prod + loaded dev)
      const prodReloadWait = prodWs.waitFor((m) => m.op === "reload");
      const devReloadWait = devWs.waitFor((m) => m.op === "reload");

      const reloadAll = await runCliAsync(["reload", "--data", dataDir, "--json"]);
      expect(reloadAll.exitCode).toBe(0);
      const reloadAllJson = JSON.parse(reloadAll.stdout);
      expect(reloadAllJson.reloaded).toEqual(["notes"]);
      expect(reloadAllJson.errors).toEqual([]);

      await Promise.all([prodReloadWait, devReloadWait]);

      // Verify schema reconciliation ran in both prod and dev
      const prodCols = runBlueprintSql({
        fileOrId: "notes-daemon",
        statement: "PRAGMA table_info(notes)",
        dataDir,
      }).rows.map((r) => r.name);
      expect(prodCols).toEqual(["id", "body", "tag"]);

      const devCols = runBlueprintSql({
        fileOrId: "notes-daemon",
        statement: "PRAGMA table_info(notes)",
        dev: true,
        dataDir,
      }).rows.map((r) => r.name);
      expect(devCols).toEqual(["id", "body", "tag"]);

      // Second bp reload with no changes -> unchanged
      const reloadUnchanged = await runCliAsync(["reload", "--data", dataDir, "--json"]);
      expect(reloadUnchanged.exitCode).toBe(0);
      expect(JSON.parse(reloadUnchanged.stdout)).toMatchObject({
        reloaded: [],
        unchanged: ["notes"],
        removed: [],
        errors: [],
      });

      // Targeted bp reload notes --dev pushes { op: "reload" } to dev WS
      const targetedDevReloadWait = devWs.waitFor((m) => m.op === "reload");
      const reloadTargetDev = await runCliAsync([
        "reload",
        "notes",
        "--dev",
        "--data",
        dataDir,
        "--json",
      ]);
      expect(reloadTargetDev.exitCode).toBe(0);
      expect(JSON.parse(reloadTargetDev.stdout).reloaded).toEqual(["notes"]);
      await targetedDevReloadWait;
    } finally {
      prodWs.close();
      devWs.close();
    }

    // 5. bp logs returns recent entries
    const logsRes = await runCliAsync([
      "logs",
      "notes",
      "--limit",
      "25",
      "--data",
      dataDir,
      "--json",
    ]);
    expect(logsRes.exitCode).toBe(0);
    const logsJson = JSON.parse(logsRes.stdout);
    expect(logsJson.slug).toBe("notes");
    expect(logsJson.mode).toBe("prod");
    expect(logsJson.logs.length).toBeGreaterThan(0);
    expect(logsJson.logs.some((l) => l.type === "flow:finish" && l.event === "note:add")).toBe(true);
    expect(logsJson.logs.some((l) => l.type === "step" && l.node === "add-note" && l.ok)).toBe(true);
    expect(logsJson.logs.some((l) => l.type === "reload")).toBe(true);

    // 6. bp down stops daemon cleanly and removes daemon.json
    const downRes = await runCliAsync(["down", "--data", dataDir, "--json"]);
    expect(downRes.exitCode).toBe(0);
    expect(JSON.parse(downRes.stdout)).toMatchObject({ ok: true, stopped: true, pid: upJson.pid });
    expect(fs.existsSync(path.join(dataDir, "daemon.json"))).toBe(false);

    // Confirm ticks stopped after bp down
    const countAfterDown = runBlueprintSql({
      fileOrId: "notes-daemon",
      statement: "SELECT COUNT(*) AS cnt FROM ticks",
      dataDir,
    }).rows[0].cnt;
    await Bun.sleep(1150);
    const countLater = runBlueprintSql({
      fileOrId: "notes-daemon",
      statement: "SELECT COUNT(*) AS cnt FROM ticks",
      dataDir,
    }).rows[0].cnt;
    expect(countLater).toBe(countAfterDown);

    // 7. bp up with no [dir] reuses config.json dir & port, and broken reload exits 1
    const reuseUp = await runCliAsync(["up", "--data", dataDir, "--json"]);
    expect(reuseUp.exitCode).toBe(0);
    expect(JSON.parse(reuseUp.stdout).port).toBe(freePort);

    writeBlueprint("notes.html", "<html><body>Broken after edit</body></html>");
    const badReload = await runCliAsync(["reload", "notes", "--data", dataDir, "--json"]);
    expect(badReload.exitCode).toBe(1);
    expect(JSON.parse(badReload.stdout).errors).toHaveLength(1);

    const secondDown = await runCliAsync(["down", "--data", dataDir]);
    expect(secondDown.exitCode).toBe(0);
    expect(secondDown.stdout).toContain("Daemon stopped");
  });

  test("bp reload detects added/removed .html files, ring buffer caps at 200 entries, and client.js re-subscribes watch on reconnect", async () => {
    // 1. CLI smoke checks & error handling
    const helpRes = await runCliAsync(["--help"]);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain("bp up");
    expect(helpRes.stdout).toContain("bp down");
    expect(helpRes.stdout).toContain("bp reload");
    expect(helpRes.stdout).toContain("bp emit");
    expect(helpRes.stdout).toContain("bp logs");

    const emptyDataDir = path.join(tmpDir, "empty-data");
    activeDataDirsForCleanup.push(emptyDataDir);
    const badDirUp = await runCliAsync([
      "up",
      path.join(tmpDir, "does-not-exist"),
      "--data",
      emptyDataDir,
    ]);
    expect(badDirUp.exitCode).toBe(1);
    expect(badDirUp.stderr).toContain("Blueprints directory not found or not a directory");

    const defaultBlueprintsDir = path.join(tmpDir, "default-blueprints");
    const defaultPort = await getFreePort();
    const defaultDirUp = await runCliAsync(
      ["up", "--port", String(defaultPort), "--data", emptyDataDir, "--json"],
      { BP_DIR: defaultBlueprintsDir }
    );
    expect(defaultDirUp.exitCode).toBe(0);
    expect(fs.existsSync(defaultBlueprintsDir)).toBe(true);
    expect(JSON.parse(defaultDirUp.stdout).dir).toBe(defaultBlueprintsDir);

    const stopDefaultUp = await runCliAsync(["down", "--data", emptyDataDir]);
    expect(stopDefaultUp.exitCode).toBe(0);
    expect(stopDefaultUp.stdout).toContain("Daemon stopped");

    const downIdle = await runCliAsync(["down", "--data", emptyDataDir]);
    expect(downIdle.exitCode).toBe(0);
    expect(downIdle.stdout).toContain("Daemon is not running.");

    // 2. Added / removed .html files and 200-entry ring buffer cap
    writeBlueprint(
      "alpha.html",
      `<meta name="bp:id" content="alpha-id"><title>Alpha</title>`
    );

    const daemon = startDaemon({
      dir: blueprintsDir,
      bind: "127.0.0.1",
      port: 0,
      dataDir,
      writeFiles: false,
    });
    activeDaemons.push(daemon);

    // Add beta.html and remove alpha.html
    writeBlueprint(
      "beta.html",
      `<meta name="bp:id" content="beta-id"><title>Beta</title>`
    );
    fs.unlinkSync(path.join(blueprintsDir, "alpha.html"));

    const reloadOut = daemon.reload({});
    expect(reloadOut.reloaded).toEqual(["beta"]);
    expect(reloadOut.removed).toEqual(["alpha"]);
    expect(reloadOut.errors).toEqual([]);

    // Deleted alpha returns 404, new beta returns 200
    expect((await fetch(`${daemon.baseUrl}/bp/alpha`)).status).toBe(404);
    expect((await fetch(`${daemon.baseUrl}/bp/beta`)).status).toBe(200);

    // Emit > 210 events to verify 200-entry ring buffer cap
    for (let i = 0; i < 210; i++) {
      await daemon.emit({ slug: "beta", event: "ping", data: { i }, source: "cli" });
    }
    const cappedLogs = daemon.getLogs("beta", "prod", 500);
    expect(cappedLogs).toHaveLength(200);

    // 3. client.js reconnect re-subscribes active watches
    const clientCode = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/client.js"),
      "utf8"
    );
    const sockets = [];
    const sent = [];
    const timerQueue = [];

    class ReconnectSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = ReconnectSocket.CONNECTING;
        this.listeners = new Map();
        sockets.push(this);
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      send(data) {
        sent.push({ sockIdx: sockets.indexOf(this), frame: JSON.parse(data) });
      }
      trigger(type, payload = {}) {
        for (const fn of this.listeners.get(type) || []) fn(payload);
      }
    }

    const fakeWin = {
      location: { href: "http://127.0.0.1:7500/bp/beta", pathname: "/bp/beta", reload() {} },
      setTimeout(fn) {
        timerQueue.push(fn);
        return timerQueue.length;
      },
      clearTimeout() {},
    };
    new Function("window", "document", "WebSocket", clientCode)(
      fakeWin,
      { currentScript: { src: "http://127.0.0.1:7500/bp/beta/bp.js" } },
      ReconnectSocket
    );

    const snapshots = [];
    fakeWin.bp.watch("items", (rows) => snapshots.push(rows));
    sockets[0].readyState = ReconnectSocket.OPEN;
    sockets[0].trigger("open");
    expect(sent.filter((s) => s.sockIdx === 0 && s.frame.op === "watch")).toHaveLength(1);

    // Simulate disconnect + reconnect timer firing
    sockets[0].trigger("close");
    expect(timerQueue).toHaveLength(1);
    timerQueue.shift()();
    expect(sockets).toHaveLength(2);

    sockets[1].readyState = ReconnectSocket.OPEN;
    sockets[1].trigger("open");
    const resub = sent.filter((s) => s.sockIdx === 1 && s.frame.op === "watch");
    expect(resub).toHaveLength(1);
    expect(resub[0].frame.query).toBe("items");
  });
});
