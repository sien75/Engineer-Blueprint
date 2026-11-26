import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlueprintSql } from "../src/db.js";
import { runBlueprintFlow } from "../src/flow.js";
import { parseBlueprintHtml } from "../src/parse.js";
import { resolveAcpCommand } from "../src/ai.js";

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

function createMockAcpServer(filename = "mock-acp.js") {
  const logPath = path.join(tmpDir, `${filename}.calls.jsonl`);
  const scriptPath = path.join(tmpDir, filename);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const argv = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
const logFile = ${JSON.stringify(logPath)};
function logEntry(entry) {
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
}
logEntry({ type: "spawn", argv, cwd });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

let state = {
  model: null,
  mode: null,
  sessionCounter: 0,
  pendingPermResolve: null,
};

const decoder = new TextDecoder();
let buffer = "";

async function handleLine(line) {
  const msg = JSON.parse(line);
  logEntry({ type: "recv", msg });

  // Response to server-initiated request (e.g., session/request_permission)
  if (msg.id !== undefined && !msg.method) {
    if (state.pendingPermResolve) {
      const resolve = state.pendingPermResolve;
      state.pendingPermResolve = null;
      resolve(msg);
    }
    return;
  }

  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "mock-acp", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "session/new") {
    state.sessionCounter += 1;
    send({
      jsonrpc: "2.0",
      id,
      result: { sessionId: \`sess-\${state.sessionCounter}\` },
    });
    return;
  }

  if (method === "session/load") {
    // Replay historical chunks that MUST be ignored by the client
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "[REPLAYED_HISTORY_MUST_IGNORE]" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id,
      result: { sessionId: params.sessionId },
    });
    return;
  }

  if (method === "session/set_model") {
    state.model = params.modelId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/set_mode") {
    state.mode = params.modeId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/prompt") {
    const promptText = params?.prompt?.[0]?.text ?? "";

    if (promptText.includes("__FAIL_EXIT__")) {
      console.error("mock acp simulated failure");
      process.exit(2);
    }
    if (promptText.includes("__BAD_JSON__")) {
      process.stdout.write("not valid json {{{\\n");
      return;
    }
    if (promptText.includes("__RPC_ERROR__")) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "simulated rpc error" },
      });
      return;
    }

    let permInfo = "";
    if (promptText.includes("__PERMISSION__")) {
      const permResp = await new Promise((resolve) => {
        state.pendingPermResolve = resolve;
        send({
          jsonrpc: "2.0",
          id: 9001,
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            options: [
              { optionId: "deny-1", kind: "reject_once", name: "Deny" },
              { optionId: "allow-1", kind: "allow_once", name: "Allow once" },
            ],
          },
        });
      });
      permInfo = \`:perm=\${permResp?.result?.outcome?.optionId ?? "none"}\`;
    }

    const fullReply = \`reply:sess=\${params.sessionId}:model=\${state.model ?? "none"}:mode=\${state.mode ?? "none"}\${permInfo}:prompt=\${promptText}\`;
    const mid = Math.floor(fullReply.length / 2);
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: fullReply.slice(0, mid) },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: fullReply.slice(mid) },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: \`Unknown method: \${method}\` },
  });
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      handleLine(line).catch((err) => {
        console.error("mock-acp error:", err);
        process.exit(1);
      });
    }
  }
}
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
  test("parses blueprint/sh and blueprint/ai with protocol default/validation, preserved cli, optional attrs, and </script> unescaping", () => {
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
          <script type="blueprint/ai" id="coder" protocol="ACP" cli="AGY" model="claude-sonnet" mode="auto" desc="Code assistant">
            You are strict. Watch for <\\/script> tags.
          </script>
          <script type="blueprint/ai" id="bare-ai" cli="codex">   </script>
          <script type="blueprint/ai" id="custom-ai" cli="./Bin/MyAgent --acp">Custom</script>
        </body>
      </html>
    `);

    expect(parsed.nodes).toHaveLength(4);
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
      protocol: "acp",
      cli: "AGY",
      model: "claude-sonnet",
      mode: "auto",
      rolePrompt: "You are strict. Watch for </script> tags.",
    });

    expect(parsed.nodes[2]).toEqual({
      id: "bare-ai",
      type: "blueprint/ai",
      kind: "ai",
      desc: null,
      protocol: "acp",
      cli: "codex",
      model: null,
      mode: null,
      rolePrompt: "",
    });

    expect(parsed.nodes[3]).toEqual({
      id: "custom-ai",
      type: "blueprint/ai",
      kind: "ai",
      desc: null,
      protocol: "acp",
      cli: "./Bin/MyAgent --acp",
      model: null,
      mode: null,
      rolePrompt: "Custom",
    });
  });

  test("validates id uniqueness, done exclusion, protocol, and cli requirements on sh and ai nodes", () => {
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
      parseBlueprintHtml(`${base}<script type="blueprint/ai" id="bot" cli="   ">role</script>`)
    ).toThrow(/requires a non-empty "cli" attribute/);

    expect(() =>
      parseBlueprintHtml(`${base}<script type="blueprint/ai" id="bot" protocol="mcp" cli="agy">role</script>`)
    ).toThrow(/Unsupported protocol "mcp".*acp/);

    expect(() =>
      parseBlueprintHtml(`
        ${base}
        <script type="blueprint/sh" id="dup-id">echo 1</script>
        <script type="blueprint/ai" id="dup-id" cli="agy">role</script>
      `)
    ).toThrow(/Duplicate action node id "dup-id"/);
  });

  test("resolveAcpCommand maps built-in presets and splits/resolves custom commands", () => {
    expect(resolveAcpCommand("agy")).toEqual(["agy", "acp"]);
    expect(resolveAcpCommand("AGY")).toEqual(["agy", "acp"]);
    expect(resolveAcpCommand("opencode")).toEqual(["opencode", "acp"]);
    expect(resolveAcpCommand("dsh")).toEqual(["dsh", "acp"]);
    expect(resolveAcpCommand("claude")).toEqual(["npx", "-y", "@agentclientprotocol/claude-agent-acp"]);
    expect(resolveAcpCommand("codex")).toEqual(["npx", "-y", "@zed-industries/codex-acp"]);

    process.env.BP_AGY_BIN = "/custom/bin/agy";
    expect(resolveAcpCommand("agy")).toEqual(["/custom/bin/agy", "acp"]);

    const customCmd = resolveAcpCommand('./scripts/my-acp --flag "hello world"');
    expect(customCmd).toEqual([path.resolve("./scripts/my-acp"), "--flag", "hello world"]);
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

describe("blueprint/ai runtime execution (mock ACP server)", () => {
  test("new session prepends rolePrompt, sets model/mode, collects streamed chunks, and supports custom cli command", async () => {
    const mock = createMockAcpServer();
    process.env.BP_AGY_BIN = mock.scriptPath;

    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, "work-")));
    const htmlFile = writeBlueprint(
      "ai-temp.html",
      `
      <meta name="bp:id" content="ai-temp-app">
      <script type="blueprint/flow" on="ask">
        Run reviewer then custom-bot then done.
      </script>
      <script type="blueprint/ai" id="reviewer" protocol="acp" cli="agy" model="claude-sonnet" mode="auto" desc="Review code">
        You are a strict reviewer.
      </script>
      <script type="blueprint/ai" id="custom-bot" cli="${mock.scriptPath} --custom-flag">
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
      text: "reply:sess=sess-1:model=claude-sonnet:mode=auto:prompt=You are a strict reviewer.\n\nInspect index.js",
      session: "sess-1",
    });

    let idx2 = 0;
    const seq2 = ["custom-bot", "done"];
    const res2 = await runBlueprintFlow({
      filePath: htmlFile,
      event: "ask",
      data: { prompt: "Custom check" },
      dataDir,
      decide: () => seq2[idx2++],
    });

    expect(res2.ctx.last.output).toEqual({
      text: "reply:sess=sess-1:model=none:mode=none:prompt=Custom check",
      session: "sess-1",
    });

    const calls = readMockCalls(mock.logPath);
    const spawns = calls.filter((c) => c.type === "spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[0].cwd).toBe(workDir);
    expect(spawns[0].argv).toEqual(["acp"]);
    expect(spawns[1].cwd).toBe(fs.realpathSync(process.cwd()));
    expect(spawns[1].argv).toEqual(["--custom-flag"]);
  });

  test("full SQLite session-resume workflow: turn 1 session/new + rolePrompt -> turn 2 session/load (ignoring replayed chunks) + prompt without rolePrompt", async () => {
    const mock = createMockAcpServer();
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

    // Turn 1: no stored session -> session/new + rolePrompt
    const turn1 = await runTurn("Hello round 1");
    expect(turn1.ctx.steps.chat.output).toEqual({
      text: "reply:sess=sess-1:model=gemini-2.5-pro:mode=none:prompt=SYSTEM ROLE: Keep answers concise.\n\nHello round 1",
      session: "sess-1",
    });

    // Turn 2: loads sess-1 from SQLite -> session/load (replayed chunks ignored), NO repeated rolePrompt
    const turn2 = await runTurn("Follow-up round 2");
    expect(turn2.ctx.steps.chat.output).toEqual({
      text: "reply:sess=sess-1:model=gemini-2.5-pro:mode=none:prompt=Follow-up round 2",
      session: "sess-1",
    });
    expect(turn2.ctx.steps.chat.output.text).not.toContain("[REPLAYED_HISTORY_MUST_IGNORE]");

    const calls = readMockCalls(mock.logPath).filter((c) => c.type === "recv");
    const methods = calls.map((c) => c.msg.method);
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);

    const rows = runBlueprintSql({
      fileOrId: "ai-resume-app",
      statement: "SELECT id, session_id, last_reply FROM threads",
      dataDir,
    }).rows;
    expect(rows).toEqual([
      {
        id: "t-1",
        session_id: "sess-1",
        last_reply: "reply:sess=sess-1:model=gemini-2.5-pro:mode=none:prompt=Follow-up round 2",
      },
    ]);
  });

  test("auto-approves session/request_permission without hanging", async () => {
    const mock = createMockAcpServer();
    process.env.BP_AGY_BIN = mock.scriptPath;

    const htmlFile = writeBlueprint(
      "ai-perm.html",
      `
      <meta name="bp:id" content="ai-perm-app">
      <script type="blueprint/flow" on="run">Run bot then done.</script>
      <script type="blueprint/ai" id="bot" cli="agy"></script>
      `
    );

    const seq = ["bot", "done"];
    let idx = 0;
    const res = await runBlueprintFlow({
      filePath: htmlFile,
      event: "run",
      data: { prompt: "Test __PERMISSION__" },
      dataDir,
      decide: () => seq[idx++],
    });

    expect(res.ctx.steps.bot.ok).toBe(true);
    expect(res.ctx.steps.bot.output).toEqual({
      text: "reply:sess=sess-1:model=none:mode=none:perm=allow-1:prompt=Test __PERMISSION__",
      session: "sess-1",
    });
  });

  test("records missing prompt, non-zero exit code, invalid JSON, and JSON-RPC errors into ctx.history", async () => {
    const mock = createMockAcpServer();
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
      error: 'ACP CLI "agy" exited with code 2 on node "chat": mock acp simulated failure',
    });

    const badJson = await runErrorCase({ prompt: "__BAD_JSON__" });
    expect(badJson.ctx.steps.chat.ok).toBe(false);
    expect(badJson.ctx.steps.chat.error).toMatch(/returned invalid JSON/);

    const rpcErr = await runErrorCase({ prompt: "__RPC_ERROR__" });
    expect(rpcErr.ctx.steps.chat.ok).toBe(false);
    expect(rpcErr.ctx.steps.chat.error).toMatch(/ACP error \(-32000\).*simulated rpc error/);
    expect(rpcErr.emittedEvents[0].event).toBe("ai:failed");
  });

  test("end-to-end bp run CLI combines blueprint/sh and blueprint/ai with mock Jev server and mock ACP server", async () => {
    const mock = createMockAcpServer();
    let turn = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/systemone") {
          const body = await req.json();
          const order = ["prep-sh", "ai-step", "done"];
          const next = order[turn++] ?? "done";
          return Response.json({
            model: body.model,
            answers: {
              next: { type: "choice", choice: next, probabilities: { [next]: 1 }, confidence: 1 },
            },
          });
        }
        return new Response("Not found", { status: 404 });
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
          "--jev-url",
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
        text: "reply:sess=sess-1:model=none:mode=plan:prompt=Be concise.\n\nTask: audit",
        session: "sess-1",
      });
    } finally {
      server.stop(true);
    }
  });
});
