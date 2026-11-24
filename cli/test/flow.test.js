import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlueprintSql } from "../src/db.js";
import { runBlueprintFlow } from "../src/flow.js";
import { parseBlueprintHtml } from "../src/parse.js";
import { extractSqlNamedParameters } from "../src/sql.js";

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/bp.js");

let tmpDir;
let dataDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-flow-test-"));
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

function runCli(args, envOverrides = {}) {
  const proc = Bun.spawnSync(["bun", CLI_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
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

describe("parseBlueprintHtml flow & action nodes", () => {
  test("parses flows and action nodes in order, unescapes </script>, and excludes def/flow/init/frontend scripts", () => {
    const parsed = parseBlueprintHtml(`
      <!doctype html>
      <html>
        <head><meta name="bp:id" content="flow-parse-app" /></head>
        <body>
          <script type="blueprint/def">
            CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT);
          </script>
          <script type="blueprint/init.seed">ignoredInit();</script>
          <script type="module">console.log("frontend");</script>
          <script>console.log("plain frontend");</script>

          <script type="blueprint/flow" on="submit">
            First run clean. Mention &lt;\\/script&gt; literal: <\\/script>.
          </script>
          <script type="blueprint/flow" every="10m">
            Periodic check
          </script>
          <script type="blueprint/flow" init>
            Bootstrap app
          </script>

          <script type="blueprint/js" id="clean" desc="Trim note body">
            export default async (ctx) => ({ tag: "<\\/script>", body: ctx.event.data.body.trim() });
          </script>
          <script type="blueprint/sql" id="save-note" desc="Persist note">
            INSERT INTO notes (id, body) VALUES (:id, :body);
          </script>
          <script type="blueprint/emit" id="reject" event="note:rejected" desc="Emit rejection"></script>
        </body>
      </html>
    `);

    expect(parsed.id).toBe("flow-parse-app");
    expect(parsed.sqlBlocks).toHaveLength(1);
    expect(parsed.flows).toEqual([
      {
        triggerType: "on",
        triggerValue: "submit",
        prompt: "First run clean. Mention &lt;\\/script&gt; literal: </script>.",
      },
      {
        triggerType: "every",
        triggerValue: "10m",
        prompt: "Periodic check",
      },
      {
        triggerType: "init",
        triggerValue: true,
        prompt: "Bootstrap app",
      },
    ]);

    expect(parsed.nodes.map((n) => ({ id: n.id, type: n.type, desc: n.desc, event: n.event }))).toEqual([
      { id: "clean", type: "blueprint/js", desc: "Trim note body", event: undefined },
      { id: "save-note", type: "blueprint/sql", desc: "Persist note", event: undefined },
      { id: "reject", type: "blueprint/emit", desc: "Emit rejection", event: "note:rejected" },
    ]);
    expect(parsed.nodesById.clean.code).toContain('tag: "</script>"');
    expect(parsed.nodesById["save-note"].id).toBe("save-note");
  });

  test("rejects invalid flow triggers, empty flow bodies, duplicate/reserved/invalid node IDs, and missing emit event", () => {
    const base = `<meta name="bp:id" content="bad-flow">`;

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow">Do stuff</script>`)
    ).toThrow(/exactly one trigger/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow" on="a" every="1h">Do stuff</script>`)
    ).toThrow(/only one trigger/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow" on="a" init>Do stuff</script>`)
    ).toThrow(/only one trigger/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow" on="">Do stuff</script>`)
    ).toThrow(/empty "on"/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow" every="  ">Do stuff</script>`)
    ).toThrow(/empty "every"/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow" init="false">Do stuff</script>`)
    ).toThrow(/Invalid "init"/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/flow" on="submit">   \n  </script>`)
    ).toThrow(/empty body/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/js">export default () => 1;</script>`)
    ).toThrow(/non-empty "id"/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/js" id="done">export default () => 1;</script>`)
    ).toThrow(/"done" is reserved/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/js" id="../bad">export default () => 1;</script>`)
    ).toThrow(/Invalid blueprint ID/);

    expect(() =>
      parseBlueprintHtml(`
        ${base}
        <script type="blueprint/js" id="step1">export default () => 1;</script>
        <script type="blueprint/sql" id="step1">SELECT 1;</script>
      `)
    ).toThrow(/Duplicate action node id "step1"/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/emit" id="notify"></script>`)
    ).toThrow(/requires a non-empty "event"/);
  });

  test("extractSqlNamedParameters ignores comments, string literals, and quoted identifiers", () => {
    const params = extractSqlNamedParameters(`
      -- :ignored_line_comment $also_ignored
      /* :ignored_block_comment @also_ignored */
      SELECT ':not_a_param', '$not_a_param', "col:quoted", [col$bracket], \`col@tick\`, v$internal
      FROM notes
      WHERE id = :id AND tag = $tag AND owner = @owner AND body = :id
    `);
    expect(params).toEqual([
      { token: ":id", name: "id" },
      { token: "$tag", name: "tag" },
      { token: "@owner", name: "owner" },
    ]);
  });
});

describe("runBlueprintFlow runtime", () => {
  test("happy path: auto-reconciles schema, executes JS -> SQL write -> SQL query -> done, ignores extra object keys", async () => {
    const htmlFile = writeBlueprint(
      "notes.html",
      `
      <meta name="bp:id" content="notes-flow">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS notes (
          id   TEXT PRIMARY KEY,
          body TEXT NOT NULL
        );
      </script>

      <script type="blueprint/flow" on="note:create">
        1. Run clean to trim the note body and inspect args.
        2. Run save-note to insert the note into SQLite.
        3. Run load-note to verify the inserted row.
        4. Finish with done.
      </script>

      <script type="blueprint/js" id="clean" desc="Validate and trim note">
        export default async function (ctx) {
          if (arguments.length !== 1) {
            throw new Error("Expected exactly 1 argument (ctx), got " + arguments.length);
          }
          const cleaned = String(ctx.event.data.body ?? "").trim();
          // Mutate local clone to prove runtime ctx isolation
          ctx.history.push({ fake: true });
          return {
            id: ctx.event.data.id,
            body: cleaned,
            extraNested: { ignoredBySql: [1, 2, 3] },
          };
        }
      </script>

      <script type="blueprint/sql" id="save-note" desc="Insert note row">
        INSERT INTO notes (id, body) VALUES (:id, :body);
      </script>

      <script type="blueprint/sql" id="load-note" desc="Load note row by rowid">
        SELECT id, body FROM notes WHERE rowid = :lastInsertRowid;
      </script>
      `
    );

    const script = ["clean", "save-note", "load-note", "done"];
    let turn = 0;

    const result = await runBlueprintFlow({
      filePath: htmlFile,
      event: "note:create",
      data: { id: "n1", body: "  hello blueprint  " },
      dev: true,
      dataDir,
      decide: () => script[turn++],
    });

    expect(result.id).toBe("notes-flow");
    expect(result.mode).toBe("dev");
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((s) => [s.step, s.node, s.ok])).toEqual([
      [1, "clean", true],
      [2, "save-note", true],
      [3, "load-note", true],
    ]);

    expect(result.ctx.steps["save-note"].output).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    expect(result.ctx.steps["load-note"].output).toEqual([
      { id: "n1", body: "hello blueprint" },
    ]);

    const dbRows = runBlueprintSql({
      fileOrId: "notes-flow",
      statement: "SELECT id, body FROM notes",
      dev: true,
      dataDir,
    }).rows;
    expect(dbRows).toEqual([{ id: "n1", body: "hello blueprint" }]);
  });

  test("blueprint/sql binds directly from ctx.event.data when no prior plain-object output exists and returns rows array", async () => {
    const htmlFile = writeBlueprint(
      "query.html",
      `
      <meta name="bp:id" content="query-flow">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, label TEXT NOT NULL);
        INSERT OR IGNORE INTO items (id, label) VALUES ('i1', 'Alpha'), ('i2', 'Beta');
      </script>
      <script type="blueprint/flow" on="item:lookup">
        Run fetch-item then done.
      </script>
      <script type="blueprint/sql" id="fetch-item">
        SELECT id, label FROM items WHERE id = :id;
      </script>
      `
    );

    const choices = ["fetch-item", "done"];
    let idx = 0;
    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "item:lookup",
      data: { id: "i2", unusedExtra: { foo: "bar" } },
      dataDir,
      decide: () => choices[idx++],
    });

    expect(res.ctx.last.output).toEqual([{ id: "i2", label: "Beta" }]);
  });

  test("conditional reject branch emits event and skips database insert", async () => {
    const htmlFile = writeBlueprint(
      "reject.html",
      `
      <meta name="bp:id" content="reject-flow">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      </script>
      <script type="blueprint/flow" on="submit">
        First run validate. If valid, run save then done; if invalid, run reject then done.
      </script>
      <script type="blueprint/js" id="validate">
        export async function run(ctx) {
          const body = String(ctx.event.data?.body ?? "").trim();
          return body ? { valid: true, id: ctx.event.data.id, body } : { valid: false, reason: "empty body" };
        }
      </script>
      <script type="blueprint/sql" id="save">
        INSERT INTO notes (id, body) VALUES (:id, :body);
      </script>
      <script type="blueprint/emit" id="reject" event="note:rejected"></script>
      `
    );

    let stepIdx = 0;
    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "submit",
      data: { id: "n-bad", body: "   " },
      dataDir,
      decide: (input) => {
        stepIdx++;
        if (stepIdx === 1) return "validate";
        if (stepIdx === 2) {
          expect(input.history[0].preview).toContain('"valid":false');
          return "reject";
        }
        return "done";
      },
    });

    expect(res.emittedEvents).toEqual([
      {
        event: "note:rejected",
        data: { valid: false, reason: "empty body" },
      },
    ]);
    expect(res.ctx.last.output).toEqual({
      emitted: "note:rejected",
      data: { valid: false, reason: "empty body" },
    });

    const rows = runBlueprintSql({
      fileOrId: "reject-flow",
      statement: "SELECT * FROM notes",
      dataDir,
    }).rows;
    expect(rows).toEqual([]);
  });

  test("error-handling branch records ok:false error in ctx and routes to fallback node", async () => {
    const htmlFile = writeBlueprint(
      "error-branch.html",
      `
      <meta name="bp:id" content="err-flow">
      <script type="blueprint/flow" on="process">
        Run risky-step; if it fails, run on-error then done.
      </script>
      <script type="blueprint/js" id="risky-step">
        export default async () => {
          throw new Error("downstream validation exploded");
        };
      </script>
      <script type="blueprint/js" id="noop-step">
        export default async () => {};
      </script>
      <script type="blueprint/emit" id="on-error" event="flow:failed"></script>
      `
    );

    const decisions = [];
    const seq = ["noop-step", "risky-step", "on-error", "done"];
    let ptr = 0;

    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "process",
      data: { requestId: "req-9" },
      dataDir,
      decide: (input) => {
        decisions.push(input);
        return seq[ptr++];
      },
    });

    // noop-step returned undefined -> normalized to null
    expect(res.ctx.steps["noop-step"]).toEqual({ ok: true, output: null, error: null });
    // risky-step threw -> caught and recorded with ok: false
    expect(res.ctx.steps["risky-step"]).toEqual({
      ok: false,
      output: null,
      error: "downstream validation exploded",
    });
    expect(res.ctx.history[1]).toEqual({
      step: 2,
      node: "risky-step",
      ok: false,
      output: null,
      error: "downstream validation exploded",
    });
    // Decision input on step 3 saw [error] summary
    expect(decisions[2].prompt).toContain("#2 risky-step [error]: downstream validation exploded");
    // on-error emit fell back to ctx.event.data because risky-step output was null
    expect(res.emittedEvents).toEqual([{ event: "flow:failed", data: { requestId: "req-9" } }]);
  });

  test("truncates decision prompt previews to <= 500 chars while passing full untruncated ctx to downstream nodes", async () => {
    const longInput = "X".repeat(1200);
    const longOutput = "Y".repeat(1400);

    const htmlFile = writeBlueprint(
      "truncation.html",
      `
      <meta name="bp:id" content="trunc-flow">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      </script>
      <script type="blueprint/flow" on="ingest">
        Run produce then verify-and-save then done.
      </script>
      <script type="blueprint/js" id="produce">
        export default async (ctx) => {
          return {
            id: "b1",
            receivedLen: ctx.event.data.text.length,
            body: "${longOutput}",
          };
        };
      </script>
      <script type="blueprint/js" id="verify-and-save">
        export default async (ctx) => {
          return {
            eventLen: ctx.event.data.text.length,
            lastLen: ctx.last.output.body.length,
            stepsLen: ctx.steps.produce.output.body.length,
            historyLen: ctx.history[0].output.body.length,
            id: ctx.last.output.id,
            body: ctx.last.output.body,
          };
        };
      </script>
      <script type="blueprint/sql" id="persist">
        INSERT INTO blobs (id, body) VALUES (:id, :body);
      </script>
      `
    );

    const seenDecisionInputs = [];
    const seq = ["produce", "verify-and-save", "persist", "done"];
    let i = 0;

    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "ingest",
      data: { text: longInput },
      dataDir,
      decide: (input) => {
        seenDecisionInputs.push(input);
        return seq[i++];
      },
    });

    // Decision prompt previews must be <= 500 chars
    expect(seenDecisionInputs[0].event.dataPreview.length).toBeLessThanOrEqual(500);
    expect(seenDecisionInputs[0].event.dataPreview.endsWith("...")).toBe(true);
    expect(seenDecisionInputs[1].history[0].preview.length).toBeLessThanOrEqual(500);
    expect(seenDecisionInputs[1].history[0].preview.endsWith("...")).toBe(true);
    expect(seenDecisionInputs[1].prompt).not.toContain("Y".repeat(501));

    // Downstream JS node saw full untruncated ctx
    expect(res.ctx.steps["verify-and-save"].output).toMatchObject({
      eventLen: 1200,
      lastLen: 1400,
      stepsLen: 1400,
      historyLen: 1400,
    });

    // SQLite persisted full untruncated 1400-char string
    const rows = runBlueprintSql({
      fileOrId: "trunc-flow",
      statement: "SELECT id, length(body) AS len FROM blobs",
      dataDir,
    }).rows;
    expect(rows).toEqual([{ id: "b1", len: 1400 }]);
  });

  test("enforces maxSteps loop guard with executed step trail and avoids ESM cache across repeated JS runs", async () => {
    const htmlFile = writeBlueprint(
      "loop.html",
      `
      <meta name="bp:id" content="loop-flow">
      <script type="blueprint/flow" on="spin">
        Keep spinning
      </script>
      <script type="blueprint/js" id="ping">
        let calls = 0;
        export default async (ctx) => {
          calls += 1;
          return { stepCount: ctx.history.length + 1, localCalls: calls };
        };
      </script>
      `
    );

    let step = 0;
    const finite = await runBlueprintFlow({
      filePath: htmlFile,
      event: "spin",
      maxSteps: 4,
      dataDir,
      decide: () => (++step <= 3 ? "ping" : "done"),
    });
    expect(finite.steps.map((s) => s.output)).toEqual([
      { stepCount: 1, localCalls: 1 },
      { stepCount: 2, localCalls: 1 },
      { stepCount: 3, localCalls: 1 },
    ]);

    await expect(
      runBlueprintFlow({
        filePath: htmlFile,
        event: "spin",
        maxSteps: 3,
        dataDir,
        decide: () => "ping",
      })
    ).rejects.toThrow(/did not reach "done" within maxSteps \(3\).*#1 ping \[ok\], #2 ping \[ok\], #3 ping \[ok\]/);
  });

  test("runs --init flows, runs multiple matching flows in document order, and reports missing/every triggers clearly", async () => {
    const htmlFile = writeBlueprint(
      "multi.html",
      `
      <meta name="bp:id" content="multi-flow">
      <script type="blueprint/flow" init>
        Run seed-step then done.
      </script>
      <script type="blueprint/flow" on="ping">
        First flow: run first then done.
      </script>
      <script type="blueprint/flow" on="ping">
        Second flow: run second then done.
      </script>
      <script type="blueprint/flow" every="5m">
        Periodic cleanup
      </script>
      <script type="blueprint/js" id="seed-step">export default async () => ({ seeded: true });</script>
      <script type="blueprint/emit" id="first" event="first:done"></script>
      <script type="blueprint/emit" id="second" event="second:done"></script>
      `
    );

    // init flow
    const initSeq = ["seed-step", "done"];
    let initIdx = 0;
    const initRes = await runBlueprintFlow({
      filePath: htmlFile,
      init: true,
      dataDir,
      decide: () => initSeq[initIdx++],
    });
    expect(initRes.event.type).toBe("init");
    expect(initRes.ctx.steps["seed-step"].output).toEqual({ seeded: true });

    // multiple matching `on="ping"` flows execute in document order
    const multiSeq = ["first", "done", "second", "done"];
    let multiIdx = 0;
    const multiRes = await runBlueprintFlow({
      filePath: htmlFile,
      event: "ping",
      data: { n: 1 },
      dataDir,
      decide: () => multiSeq[multiIdx++],
    });
    expect(multiRes.flows).toHaveLength(2);
    expect(multiRes.emittedEvents.map((e) => e.event)).toEqual(["first:done", "second:done"]);

    // missing event reports helpful message including `every` daemon note
    await expect(
      runBlueprintFlow({
        filePath: htmlFile,
        event: "missing-event",
        dataDir,
        decide: () => "done",
      })
    ).rejects.toThrow(/daemon execution is not implemented yet/);
  });
});

describe("CLI bp run end-to-end with mock Ollama server", () => {
  test("bp run sends expected Ollama /api/chat payload, handles --init, and validates CLI flags", async () => {
    const recordedRequests = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/chat") {
          const body = await req.json();
          recordedRequests.push(body);
          const turn = recordedRequests.length;
          let next = "done";
          if (turn === 1) next = "clean";
          else if (turn === 2) next = "save-note";
          else if (turn === 3) next = "done";
          else if (turn === 4) next = "init-mark";
          else next = "done";

          return Response.json({
            model: body.model,
            message: {
              role: "assistant",
              content: JSON.stringify({ next }),
            },
            done: true,
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const ollamaUrl = `http://127.0.0.1:${server.port}`;
      const longPad = "Z".repeat(700);
      const htmlFile = writeBlueprint(
        "e2e.html",
        `
        <meta name="bp:id" content="cli-flow-e2e">
        <script type="blueprint/def">
          CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS meta_flags (k TEXT PRIMARY KEY, v TEXT);
        </script>

        <script type="blueprint/flow" on="note:add">
          Run clean to sanitize input, then run save-note to store it in SQLite, then done.
        </script>
        <script type="blueprint/flow" init>
          Run init-mark then done.
        </script>

        <script type="blueprint/js" id="clean" desc="Trim note body">
          export default async (ctx) => ({
            id: ctx.event.data.id,
            body: ctx.event.data.body.trim(),
            debugPad: "${longPad}"
          });
        </script>
        <script type="blueprint/sql" id="save-note" desc="Save note to DB">
          INSERT INTO notes (id, body) VALUES (:id, :body);
        </script>
        <script type="blueprint/sql" id="init-mark" desc="Record initialization flag">
          INSERT OR REPLACE INTO meta_flags (k, v) VALUES ('initialized', 'yes');
        </script>
        `
      );

      const res = await runCliAsync([
        "run",
        htmlFile,
        "note:add",
        JSON.stringify({ id: "e1", body: "  via ollama mock  " }),
        "--dev",
        "--data",
        dataDir,
        "--ollama",
        ollamaUrl,
        "--model",
        "qwen3.5:9b",
        "--max-steps",
        "8",
        "--json",
      ]);

      expect(res.exitCode).toBe(0);
      const parsedOut = JSON.parse(res.stdout);
      expect(parsedOut.id).toBe("cli-flow-e2e");
      expect(parsedOut.mode).toBe("dev");
      expect(parsedOut.steps.map((s) => s.node)).toEqual(["clean", "save-note"]);

      // Verify DB row persisted in dev DB
      const rows = runBlueprintSql({
        fileOrId: "cli-flow-e2e",
        statement: "SELECT id, body FROM notes",
        dev: true,
        dataDir,
      }).rows;
      expect(rows).toEqual([{ id: "e1", body: "via ollama mock" }]);

      // Verify exact Ollama request payloads for the 3 turns
      expect(recordedRequests).toHaveLength(3);
      for (const reqBody of recordedRequests) {
        expect(reqBody.model).toBe("qwen3.5:9b");
        expect(reqBody.stream).toBe(false);
        expect(reqBody.think).toBe(false);
        expect(reqBody.format).toEqual({
          type: "object",
          properties: {
            next: {
              type: "string",
              enum: ["clean", "save-note", "init-mark", "done"],
            },
          },
          required: ["next"],
          additionalProperties: false,
        });
      }

      // Turn 1 had (none yet)
      expect(recordedRequests[0].messages[1].content).toContain("(none yet)");
      // Turn 2 saw #1 clean [ok] truncated to <= 500 chars (not full 700-char Z pad)
      const turn2UserPrompt = recordedRequests[1].messages[1].content;
      expect(turn2UserPrompt).toContain("#1 clean [ok]:");
      expect(turn2UserPrompt).not.toContain("Z".repeat(501));

      // Verify --init in human-readable text mode
      const initRes = await runCliAsync([
        "run",
        htmlFile,
        "--init",
        "--dev",
        "--data",
        dataDir,
        "--ollama",
        ollamaUrl,
      ]);
      expect(initRes.exitCode).toBe(0);
      expect(initRes.stdout).toContain("Flow complete (id: cli-flow-e2e, mode: dev, event: init)");
      expect(initRes.stdout).toContain("#1 init-mark [ok]");

      const flagRows = runBlueprintSql({
        fileOrId: "cli-flow-e2e",
        statement: "SELECT k, v FROM meta_flags",
        dev: true,
        dataDir,
      }).rows;
      expect(flagRows).toEqual([{ k: "initialized", v: "yes" }]);

      // Verify CLI validation errors
      const badJson = runCli(["run", htmlFile, "note:add", "{not-json", "--data", dataDir]);
      expect(badJson.exitCode).toBe(1);
      expect(badJson.stderr).toContain("Invalid JSON data argument");

      const badSteps = runCli(["run", htmlFile, "note:add", "--max-steps", "0", "--data", dataDir]);
      expect(badSteps.exitCode).toBe(1);
      expect(badSteps.stderr).toContain("--max-steps");

      const badInit = runCli(["run", htmlFile, "note:add", "--init", "--data", dataDir]);
      expect(badInit.exitCode).toBe(1);
      expect(badInit.stderr).toContain("Usage: bp run");
    } finally {
      server.stop(true);
    }
  });

  test("handles Ollama HTTP 404, invalid router choice, unreachable server, and env overrides", async () => {
    let mode = "404";
    let seenModel = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        seenModel = body.model;
        if (mode === "404") {
          return new Response("model 'custom-model' not found", { status: 404 });
        }
        if (mode === "invalid-choice") {
          return Response.json({
            message: { role: "assistant", content: JSON.stringify({ next: "non-existent-node" }) },
          });
        }
        return Response.json({
          message: { role: "assistant", content: JSON.stringify({ next: "done" }) },
        });
      },
    });

    const ollamaUrl = `http://127.0.0.1:${server.port}`;
    const htmlFile = writeBlueprint(
      "err-ollama.html",
      `
      <meta name="bp:id" content="err-ollama">
      <script type="blueprint/flow" on="ping">Finish with done.</script>
      <script type="blueprint/js" id="step-a">export default async () => ({ ok: true });</script>
      `
    );

    try {
      const res404 = await runCliAsync(
        ["run", htmlFile, "ping", "--data", dataDir],
        { BP_OLLAMA_URL: ollamaUrl, BP_ROUTER_MODEL: "custom-model" }
      );
      expect(res404.exitCode).toBe(1);
      expect(seenModel).toBe("custom-model");
      expect(res404.stderr).toContain("HTTP 404");
      expect(res404.stderr).toContain("ollama pull custom-model");

      mode = "invalid-choice";
      const resInvalid = await runCliAsync([
        "run",
        htmlFile,
        "ping",
        "--data",
        dataDir,
        "--ollama",
        ollamaUrl,
      ]);
      expect(resInvalid.exitCode).toBe(1);
      expect(resInvalid.stderr).toContain("invalid choice");

      mode = "ok";
      const resOk = await runCliAsync([
        "run",
        htmlFile,
        "ping",
        "--data",
        dataDir,
        "--ollama",
        ollamaUrl,
      ]);
      expect(resOk.exitCode).toBe(0);
      expect(resOk.stdout).toContain("Steps: (none)");
    } finally {
      server.stop(true);
    }

    // Now server is stopped -> unreachable Ollama error
    const resUnreachable = await runCliAsync([
      "run",
      htmlFile,
      "ping",
      "--data",
      dataDir,
      "--ollama",
      ollamaUrl,
    ]);
    expect(resUnreachable.exitCode).toBe(1);
    expect(resUnreachable.stderr).toContain("Failed to connect to Ollama");
  });
});
