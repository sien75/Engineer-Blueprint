import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlueprintSql } from "../src/db.js";
import { runBlueprintFlow } from "../src/flow.js";
import { parseBlueprintHtml } from "../src/parse.js";

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/bp.js");

let tmpDir;
let dataDir;
let savedAgyBin;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-nodes-test-"));
  dataDir = path.join(tmpDir, "data");
  savedAgyBin = process.env.BP_AGY_BIN;
  delete process.env.BP_AGY_BIN;
});

afterEach(() => {
  if (savedAgyBin === undefined) {
    delete process.env.BP_AGY_BIN;
  } else {
    process.env.BP_AGY_BIN = savedAgyBin;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeBlueprint(filename, html) {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

function createMockAgy(filename = "mock-agy.js") {
  const logPath = path.join(tmpDir, `${filename}.calls.jsonl`);
  const scriptPath = path.join(tmpDir, filename);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const argv = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
const entry = { argv, cwd, envKeys: Object.keys(process.env) };
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");

function readFlag(name) {
  const idx = argv.indexOf(name);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
}

const prompt = readFlag("-p") ?? "";
const conversation = readFlag("--conversation");
const model = readFlag("--model");
const mode = readFlag("--mode");

if (prompt.includes("__FAIL_EXIT__")) {
  console.error("mock agy simulated failure");
  process.exit(2);
}
if (prompt.includes("__BAD_JSON__")) {
  console.log("not valid json {{{");
  process.exit(0);
}
if (prompt.includes("__MISSING_TEXT__")) {
  console.log(JSON.stringify({ session: "s-only" }));
  process.exit(0);
}
if (prompt.includes("__ALT_KEYS__")) {
  console.log(JSON.stringify({ response: "alt-reply", conversation_id: "conv-alt-99" }));
  process.exit(0);
}

const turn = fs.readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").length;
const nextSession = conversation ? \`\${conversation}-next-\${turn}\` : \`sess-\${turn}\`;
console.log(
  JSON.stringify({
    result: \`reply#\${turn}:conv=\${conversation ?? "new"}:model=\${model ?? "none"}:mode=\${mode ?? "none"}:prompt=\${prompt}\`,
    session_id: nextSession,
  })
);
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { scriptPath, logPath };
}

function readMockCalls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
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

describe("parseBlueprintHtml support for blueprint/sh and blueprint/ai", () => {
  test("parses blueprint/sh and blueprint/ai with optional attrs and </script> unescaping", () => {
    const parsed = parseBlueprintHtml(`
      <!doctype html>
      <html>
        <head><meta name="bp:id" content="sh-ai-parse" /></head>
        <body>
          <script type="blueprint/sh" id="inspect" desc="Inspect ctx via shell">
            cat <<'EOF'
            <\\/script>
            EOF
          </script>
          <script type="blueprint/ai" id="coder" cli="AGY" model="claude-sonnet" mode="auto" desc="Code assistant">
            You are strict. Watch for <\\/script> tags.
          </script>
          <script type="blueprint/ai" id="bare-ai" cli="agy">   </script>
        </body>
      </html>
    `);

    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[0]).toMatchObject({
      id: "inspect",
      type: "blueprint/sh",
      kind: "sh",
      desc: "Inspect ctx via shell",
    });
    expect(parsed.nodes[0].code).toContain("</script>");

    expect(parsed.nodes[1]).toEqual({
      id: "coder",
      type: "blueprint/ai",
      kind: "ai",
      desc: "Code assistant",
      cli: "agy",
      model: "claude-sonnet",
      mode: "auto",
      rolePrompt: "You are strict. Watch for </script> tags.",
    });

    expect(parsed.nodes[2]).toEqual({
      id: "bare-ai",
      type: "blueprint/ai",
      kind: "ai",
      desc: null,
      cli: "agy",
      model: null,
      mode: null,
      rolePrompt: "",
    });
  });

  test("validates id uniqueness, done exclusion, and cli requirements on sh and ai nodes", () => {
    const base = `<meta name="bp:id" content="bad-nodes">`;

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/sh" id="done">echo ok</script>`)
    ).toThrow(/"done" is reserved/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/ai" id="done" cli="agy">hi</script>`)
    ).toThrow(/"done" is reserved/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/sh" id="../bad">echo ok</script>`)
    ).toThrow(/Invalid blueprint ID/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/ai" id="bot">role</script>`)
    ).toThrow(/requires a non-empty "cli" attribute/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/ai" id="bot" cli="codex">role</script>`)
    ).toThrow(/Unsupported cli "codex".*agy/);

    expect(() =>
      parseBlueprintHtml(`
        ${base}
        <script type="blueprint/sh" id="dup-id">echo 1</script>
        <script type="blueprint/ai" id="dup-id" cli="agy">role</script>
      `)
    ).toThrow(/Duplicate action node id "dup-id"/);
  });
});

describe("blueprint/sh runtime execution", () => {
  test("passes full untruncated ctx JSON on stdin, avoids BP_IN_* env vars, parses JSON stdout, and cleans up temp file", async () => {
    const longEventValue = "L".repeat(1200);
    const htmlFile = writeBlueprint(
      "sh-json.html",
      `
      <meta name="bp:id" content="sh-json-app">
      <script type="blueprint/flow" on="run">
        Run prep, then inspect-sh, then done.
      </script>
      <script type="blueprint/js" id="prep">
        export default async () => ({ marker: "from-js", size: 42 });
      </script>
      <script type="blueprint/sh" id="inspect-sh" desc="Read stdin ctx and emit JSON">
        CTX=$(cat)
        BP_IN_VARS=$(env | grep '^BP_IN_' || true)
        bun -e '
          const fs = require("node:fs");
          const ctx = JSON.parse(process.argv[1]);
          console.log(JSON.stringify({
            scriptPath: process.argv[2],
            eventTextLen: ctx.event.data.longText.length,
            prepMarker: ctx.steps.prep.output.marker,
            lastSize: ctx.last.output.size,
            bpInCount: process.argv[3].length,
          }));
        ' "$CTX" "$0" "$BP_IN_VARS"
      </script>
      `
    );

    const seq = ["prep", "inspect-sh", "done"];
    let idx = 0;
    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "run",
      data: { longText: longEventValue },
      dataDir,
      decide: () => seq[idx++],
    });

    const out = res.ctx.steps["inspect-sh"].output;
    expect(out.eventTextLen).toBe(1200);
    expect(out.prepMarker).toBe("from-js");
    expect(out.lastSize).toBe(42);
    expect(out.bpInCount).toBe(0);

    const realTmp = fs.realpathSync(os.tmpdir());
    expect(out.scriptPath.startsWith(realTmp)).toBe(true);
    expect(out.scriptPath).toMatch(/node-.*\.sh$/);
    expect(fs.existsSync(out.scriptPath)).toBe(false);
    expect(fs.existsSync(path.dirname(out.scriptPath))).toBe(false);
  });

  test("wraps plain-text stdout as { text }, handles empty stdout, and prevents concurrent temp file collisions", async () => {
    const htmlFile = writeBlueprint(
      "sh-text.html",
      `
      <meta name="bp:id" content="sh-text-app">
      <script type="blueprint/flow" on="plain">
        Run plain-sh then empty-sh then done.
      </script>
      <script type="blueprint/sh" id="plain-sh">
        cat >/dev/null
        printf "  hello from shell  \n"
      </script>
      <script type="blueprint/sh" id="empty-sh">
        cat >/dev/null
      </script>
      `
    );

    const runOne = async (n) => {
      const seq = ["plain-sh", "empty-sh", "done"];
      let idx = 0;
      return runBlueprintFlow({
        filePath: htmlFile,
        event: "plain",
        data: { n },
        dataDir,
        decide: () => seq[idx++],
      });
    };

    const [r1, r2] = await Promise.all([runOne(1), runOne(2)]);
    expect(r1.ctx.steps["plain-sh"].output).toEqual({ text: "hello from shell" });
    expect(r2.ctx.steps["plain-sh"].output).toEqual({ text: "hello from shell" });
    expect(r1.ctx.steps["empty-sh"].output).toEqual({ text: "" });
  });

  test("records non-zero exit code errors (stderr and fallback code message) in ctx and routes to fallback node", async () => {
    const htmlFile = writeBlueprint(
      "sh-err.html",
      `
      <meta name="bp:id" content="sh-err-app">
      <script type="blueprint/flow" on="check">
        Run failing-sh or silent-fail-sh; on error run fallback-emit then done.
      </script>
      <script type="blueprint/sh" id="failing-sh">
        echo "  boom on stderr  " >&2
        exit 7
      </script>
      <script type="blueprint/sh" id="silent-fail-sh">
        exit 9
      </script>
      <script type="blueprint/emit" id="fallback-emit" event="sh:failed"></script>
      `
    );

    const seq = ["failing-sh", "silent-fail-sh", "fallback-emit", "done"];
    let idx = 0;
    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "check",
      data: { job: "j1" },
      dataDir,
      decide: () => seq[idx++],
    });

    expect(res.ctx.steps["failing-sh"]).toEqual({
      ok: false,
      output: null,
      error: "boom on stderr",
    });
    expect(res.ctx.steps["silent-fail-sh"]).toEqual({
      ok: false,
      output: null,
      error: "sh exited with code 9",
    });
    expect(res.ctx.history[0]).toEqual({
      step: 1,
      node: "failing-sh",
      ok: false,
      output: null,
      error: "boom on stderr",
    });
    expect(res.emittedEvents).toEqual([{ event: "sh:failed", data: { job: "j1" } }]);
  });
});

describe("blueprint/ai runtime execution (mock agy CLI)", () => {
  test("temporary chat prepends rolePrompt, skips --conversation, forwards --model/--mode and cwd, and normalizes keys", async () => {
    const mock = createMockAgy();
    process.env.BP_AGY_BIN = mock.scriptPath;

    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, "work-")));
    const htmlFile = writeBlueprint(
      "ai-temp.html",
      `
      <meta name="bp:id" content="ai-temp-app">
      <script type="blueprint/flow" on="ask">
        Run reviewer then alt-bot then done.
      </script>
      <script type="blueprint/ai" id="reviewer" cli="agy" model="claude-sonnet" mode="auto" desc="Review code">
        You are a strict reviewer.
      </script>
      <script type="blueprint/ai" id="alt-bot" cli="agy">
      </script>
      `
    );

    const seq = ["reviewer", "done"];
    let idx = 0;
    const res1 = await runBlueprintFlow({
      filePath: htmlFile,
      event: "ask",
      data: { prompt: "Inspect index.js", session: "   ", cwd: workDir },
      dataDir,
      decide: () => seq[idx++],
    });

    expect(res1.ctx.last.output).toEqual({
      text: "reply#1:conv=new:model=claude-sonnet:mode=auto:prompt=You are a strict reviewer.\n\nInspect index.js",
      session: "sess-1",
    });

    // Also test alternative JSON output keys (`response`, `conversation_id`) and empty rolePrompt
    let idx2 = 0;
    const seq2 = ["alt-bot", "done"];
    const res2 = await runBlueprintFlow({
      filePath: htmlFile,
      event: "ask",
      data: { prompt: "__ALT_KEYS__" },
      dataDir,
      decide: () => seq2[idx2++],
    });

    expect(res2.ctx.last.output).toEqual({
      text: "alt-reply",
      session: "conv-alt-99",
    });

    const calls = readMockCalls(mock.logPath);
    expect(calls).toHaveLength(2);
    expect(calls[0].cwd).toBe(workDir);
    expect(calls[0].argv).toEqual([
      "-p",
      "You are a strict reviewer.\n\nInspect index.js",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet",
      "--mode",
      "auto",
    ]);
    expect(calls[0].argv).not.toContain("--conversation");

    expect(calls[1].cwd).toBe(fs.realpathSync(process.cwd()));
    expect(calls[1].argv).toEqual(["-p", "__ALT_KEYS__", "--output-format", "json"]);
  });

  test("full SQLite session-resume workflow: sql load -> js prepare -> ai (new then --conversation without rolePrompt) -> sql upsert", async () => {
    const mock = createMockAgy();
    process.env.BP_AGY_BIN = mock.scriptPath;

    const htmlFile = writeBlueprint(
      "ai-resume.html",
      `
      <meta name="bp:id" content="ai-resume-app">
      <script type="blueprint/def">
        CREATE TABLE IF NOT EXISTS threads (
          id         TEXT PRIMARY KEY,
          session_id TEXT,
          last_reply TEXT
        );
      </script>
      <script type="blueprint/flow" on="chat:turn">
        Run load-thread, prepare-ai, chat, attach-thread, save-thread, then done.
      </script>
      <script type="blueprint/sql" id="load-thread">
        SELECT session_id AS session FROM threads WHERE id = :thread_id;
      </script>
      <script type="blueprint/js" id="prepare-ai">
        export default async (ctx) => ({
          prompt: ctx.event.data.prompt,
          session: ctx.last.output?.[0]?.session ?? null,
        });
      </script>
      <script type="blueprint/ai" id="chat" cli="agy" model="gemini-2.5-pro">
        SYSTEM ROLE: Keep answers concise.
      </script>
      <script type="blueprint/js" id="attach-thread">
        export default async (ctx) => ({
          thread_id: ctx.event.data.thread_id,
          session: ctx.last.output.session,
          text: ctx.last.output.text,
        });
      </script>
      <script type="blueprint/sql" id="save-thread">
        INSERT INTO threads (id, session_id, last_reply)
        VALUES (:thread_id, :session, :text)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          last_reply = excluded.last_reply;
      </script>
      `
    );

    const runTurn = async (promptText) => {
      const seq = ["load-thread", "prepare-ai", "chat", "attach-thread", "save-thread", "done"];
      let idx = 0;
      return runBlueprintFlow({
        filePath: htmlFile,
        event: "chat:turn",
        data: { thread_id: "t-1", prompt: promptText },
        dataDir,
        decide: () => seq[idx++],
      });
    };

    // Turn 1: no stored session -> rolePrompt prepended, no --conversation
    const turn1 = await runTurn("Hello round 1");
    expect(turn1.ctx.steps.chat.output).toEqual({
      text: "reply#1:conv=new:model=gemini-2.5-pro:mode=none:prompt=SYSTEM ROLE: Keep answers concise.\n\nHello round 1",
      session: "sess-1",
    });

    // Turn 2: loads sess-1 from SQLite -> passes --conversation sess-1, NO repeated rolePrompt
    const turn2 = await runTurn("Follow-up round 2");
    expect(turn2.ctx.steps.chat.output).toEqual({
      text: "reply#2:conv=sess-1:model=gemini-2.5-pro:mode=none:prompt=Follow-up round 2",
      session: "sess-1-next-2",
    });

    const calls = readMockCalls(mock.logPath);
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toEqual([
      "-p",
      "SYSTEM ROLE: Keep answers concise.\n\nHello round 1",
      "--output-format",
      "json",
      "--model",
      "gemini-2.5-pro",
    ]);
    expect(calls[1].argv).toEqual([
      "-p",
      "Follow-up round 2",
      "--conversation",
      "sess-1",
      "--output-format",
      "json",
      "--model",
      "gemini-2.5-pro",
    ]);
    expect(calls[1].argv[1]).not.toContain("SYSTEM ROLE");

    const rows = runBlueprintSql({
      fileOrId: "ai-resume-app",
      statement: "SELECT id, session_id, last_reply FROM threads",
      dataDir,
    }).rows;
    expect(rows).toEqual([
      {
        id: "t-1",
        session_id: "sess-1-next-2",
        last_reply: "reply#2:conv=sess-1:model=gemini-2.5-pro:mode=none:prompt=Follow-up round 2",
      },
    ]);
  });

  test("records missing prompt, non-zero exit code, invalid JSON, and missing text errors into ctx.history", async () => {
    const mock = createMockAgy();
    process.env.BP_AGY_BIN = mock.scriptPath;

    const htmlFile = writeBlueprint(
      "ai-errors.html",
      `
      <meta name="bp:id" content="ai-err-app">
      <script type="blueprint/flow" on="test">
        Run chat; if it fails, run on-fail then done.
      </script>
      <script type="blueprint/ai" id="chat" cli="agy">Helpful bot</script>
      <script type="blueprint/emit" id="on-fail" event="ai:failed"></script>
      `
    );

    const runErrorCase = async (data) => {
      const seq = ["chat", "on-fail", "done"];
      let idx = 0;
      return runBlueprintFlow({
        filePath: htmlFile,
        event: "test",
        data,
        dataDir,
        decide: () => seq[idx++],
      });
    };

    const missingPrompt = await runErrorCase({ prompt: "   " });
    expect(missingPrompt.ctx.steps.chat.ok).toBe(false);
    expect(missingPrompt.ctx.steps.chat.error).toMatch(/requires a non-empty string "prompt"/);

    const noData = await runErrorCase(null);
    expect(noData.ctx.steps.chat.ok).toBe(false);
    expect(noData.ctx.steps.chat.error).toMatch(/requires a non-empty string "prompt"/);

    const exitFail = await runErrorCase({ prompt: "__FAIL_EXIT__" });
    expect(exitFail.ctx.steps.chat).toEqual({
      ok: false,
      output: null,
      error: 'AI CLI "agy" exited with code 2 on node "chat": mock agy simulated failure',
    });

    const badJson = await runErrorCase({ prompt: "__BAD_JSON__" });
    expect(badJson.ctx.steps.chat.ok).toBe(false);
    expect(badJson.ctx.steps.chat.error).toMatch(/returned invalid JSON/);

    const missingText = await runErrorCase({ prompt: "__MISSING_TEXT__" });
    expect(missingText.ctx.steps.chat.ok).toBe(false);
    expect(missingText.ctx.steps.chat.error).toMatch(/missing a response text field/);
    expect(missingText.emittedEvents[0].event).toBe("ai:failed");
  });

  test("end-to-end bp run CLI combines blueprint/sh and blueprint/ai with mock Ollama and BP_AGY_BIN", async () => {
    const mock = createMockAgy();
    let turn = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        const order = ["prep-sh", "ai-step", "done"];
        const next = order[turn++] ?? "done";
        return Response.json({
          message: { role: "assistant", content: JSON.stringify({ next }) },
        });
      },
    });

    try {
      const htmlFile = writeBlueprint(
        "cli-sh-ai.html",
        `
        <meta name="bp:id" content="cli-sh-ai-app">
        <script type="blueprint/flow" on="run">
          Run prep-sh, then ai-step, then done.
        </script>
        <script type="blueprint/sh" id="prep-sh">
          bun -e '
            const ctx = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
            console.log(JSON.stringify({ prompt: "Task: " + ctx.event.data.task }));
          '
        </script>
        <script type="blueprint/ai" id="ai-step" cli="agy" mode="plan">
          Be concise.
        </script>
        `
      );

      const res = await runCliAsync(
        [
          "run",
          htmlFile,
          "run",
          JSON.stringify({ task: "audit" }),
          "--data",
          dataDir,
          "--ollama",
          `http://127.0.0.1:${server.port}`,
          "--json",
        ],
        { BP_AGY_BIN: mock.scriptPath }
      );

      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.steps.map((s) => [s.node, s.ok])).toEqual([
        ["prep-sh", true],
        ["ai-step", true],
      ]);
      expect(parsed.ctx.last.output).toEqual({
        text: "reply#1:conv=new:model=none:mode=plan:prompt=Be concise.\n\nTask: audit",
        session: "sess-1",
      });
    } finally {
      server.stop(true);
    }
  });
});
