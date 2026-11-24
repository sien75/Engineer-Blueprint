#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BIND,
  DEFAULT_PORT,
  buildDaemonBaseUrl,
  callDaemonApi,
  getDaemonLogPath,
  getDaemonStatus,
  isPidAlive,
  notifyDaemonChange,
  probeDaemonHealth,
  readDaemonConfig,
  readDaemonInfo,
  removeDaemonInfo,
  requireDaemonBaseUrl,
  startDaemon,
  writeDaemonConfig,
} from "../src/daemon.js";
import { resolveBlueprintsDir, resolveDataDir, runBlueprintSql } from "../src/db.js";
import { formatDecisionPreview, runBlueprintFlow } from "../src/flow.js";

const CLI_BIN = fileURLToPath(import.meta.url);

function readPackageVersion() {
  try {
    const pkgPath = path.resolve(path.dirname(CLI_BIN), "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function getUsageText() {
  return `Engineer Blueprint CLI (bp)

Usage:
  bp up [dir] [--port <n>] [--bind <host>] [--data <dir>] [--foreground] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>] [--json]
  bp down [--data <dir>] [--json]
  bp reload [slug] [--dev] [--data <dir>] [--json]
  bp emit <slug> <event> [json-data] [--dev] [--data <dir>] [--json]
  bp logs <slug> [--dev] [--limit <n>] [--data <dir>] [--json]
  bp sql <file.html|id> "<statement>" [--dev] [--data <dir>] [--json]
  bp run <file.html> <event> [json-data] [options]
  bp run <file.html> --init [options]

Options:
  --dev                 Target dev mode instead of prod
  --data <dir>          Override data directory (default: $BP_DATA or ~/.engineer-blueprint/data)
  --json                Output structured JSON
  --port <n>            Daemon listen port (default: 7500, bp up only)
  --bind <host>         Daemon bind host (default: 127.0.0.1, bp up only)
  --foreground          Run daemon in foreground instead of detaching (bp up only)
  --limit <n>           Max log lines to return (bp logs only)
  --init                Execute <script type="blueprint/flow" init> (bp run only)
  --max-steps <n>       Max flow decision turns before aborting (default: 16, bp run only)
  --jev-url <url>       Override Jev API base URL (default: $BP_JEV_URL or https://api.typesafe.ai/v1)
  --jev-model <name>    Override Jev model name (default: $BP_JEV_MODEL or jev-1.14)
  --jev-key <key>       Override Jev API key (default: $BP_JEV_API_KEY or $JEV_API_KEY)
  -h, --help            Show help
  -v, --version         Show version

Note:
  bp up [dir] defaults to saved config.json dir, $BP_DIR, or ~/.engineer-blueprint/blueprints.
  Set BP_JEV_API_KEY (or JEV_API_KEY / --jev-key) to authenticate cloud Jev requests.`;
}

function readFlagValue(argv, index, flagName, label) {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) {
    throw new Error(`Option "${flagName}" requires ${label}.`);
  }
  return next;
}

function parsePositiveIntOption(raw, flagName) {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Option "${flagName}" requires a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Option "${flagName}" requires a positive integer.`);
  }
  return value;
}

function parsePortOption(raw, flagName) {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Option "${flagName}" requires an integer between 0 and 65535.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Option "${flagName}" requires an integer between 0 and 65535.`);
  }
  return value;
}

function parseCliArgs(argv) {
  const positionals = [];
  let dev = false;
  let prod = false;
  let dataDir;
  let json = false;
  let init = false;
  let foreground = false;
  let maxSteps;
  let port;
  let bind;
  let limit;
  let jevModel;
  let jevUrl;
  let jevApiKey;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dev") {
      dev = true;
    } else if (arg === "--prod") {
      prod = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--init") {
      init = true;
    } else if (arg === "--foreground") {
      foreground = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg === "--data") {
      dataDir = readFlagValue(argv, i, "--data", "a directory path");
      i++;
    } else if (arg.startsWith("--data=")) {
      const val = arg.slice("--data=".length);
      if (!val) throw new Error('Option "--data=" requires a non-empty directory path.');
      dataDir = val;
    } else if (arg === "--port") {
      const raw = readFlagValue(argv, i, "--port", "a port number (0-65535)");
      port = parsePortOption(raw, "--port");
      i++;
    } else if (arg.startsWith("--port=")) {
      port = parsePortOption(arg.slice("--port=".length), "--port=");
    } else if (arg === "--bind") {
      bind = readFlagValue(argv, i, "--bind", "a bind host");
      i++;
    } else if (arg.startsWith("--bind=")) {
      const val = arg.slice("--bind=".length);
      if (!val.trim()) throw new Error('Option "--bind=" requires a non-empty bind host.');
      bind = val.trim();
    } else if (arg === "--limit") {
      const raw = readFlagValue(argv, i, "--limit", "a positive integer");
      limit = parsePositiveIntOption(raw, "--limit");
      i++;
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveIntOption(arg.slice("--limit=".length), "--limit=");
    } else if (arg === "--max-steps") {
      const raw = readFlagValue(argv, i, "--max-steps", "a positive integer");
      maxSteps = parsePositiveIntOption(raw, "--max-steps");
      i++;
    } else if (arg.startsWith("--max-steps=")) {
      const val = arg.slice("--max-steps=".length);
      maxSteps = parsePositiveIntOption(val, "--max-steps=");
    } else if (arg === "--jev-model") {
      jevModel = readFlagValue(argv, i, "--jev-model", "a Jev model name");
      i++;
    } else if (arg.startsWith("--jev-model=")) {
      const val = arg.slice("--jev-model=".length);
      if (!val.trim()) throw new Error('Option "--jev-model=" requires a non-empty model name.');
      jevModel = val;
    } else if (arg === "--jev-url") {
      jevUrl = readFlagValue(argv, i, "--jev-url", "a Jev base URL");
      i++;
    } else if (arg.startsWith("--jev-url=")) {
      const val = arg.slice("--jev-url=".length);
      if (!val.trim()) throw new Error('Option "--jev-url=" requires a non-empty URL.');
      jevUrl = val;
    } else if (arg === "--jev-key") {
      jevApiKey = readFlagValue(argv, i, "--jev-key", "a Jev API key");
      i++;
    } else if (arg.startsWith("--jev-key=")) {
      const val = arg.slice("--jev-key=".length);
      if (!val.trim()) throw new Error('Option "--jev-key=" requires a non-empty API key.');
      jevApiKey = val;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (dev && prod) {
    throw new Error("Cannot combine --dev and --prod.");
  }

  return {
    positionals,
    dev,
    dataDir,
    json,
    init,
    foreground,
    maxSteps,
    port,
    bind,
    limit,
    jevModel,
    jevUrl,
    jevApiKey,
    help,
    version,
  };
}

function formatTable(columns, rows) {
  if (rows.length === 0) {
    return "(0 rows)";
  }
  const stringify = (val) => (val === null || val === undefined ? "NULL" : String(val));
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => stringify(r[col]).length))
  );
  const header = columns.map((c, idx) => c.padEnd(widths[idx])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((r) =>
    columns.map((c, idx) => stringify(r[c]).padEnd(widths[idx])).join(" | ")
  );
  return [header, sep, ...body].join("\n");
}

function printSqlResult(res, asJson) {
  if (asJson) {
    if (res.kind === "rows") {
      console.log(JSON.stringify(res.rows, null, 2));
    } else {
      console.log(
        JSON.stringify({ changes: res.changes, lastInsertRowid: res.lastInsertRowid }, null, 2)
      );
    }
    return;
  }

  if (res.kind === "rows") {
    console.log(formatTable(res.columns, res.rows));
  } else {
    console.log(`OK (changes: ${res.changes}, lastInsertRowid: ${res.lastInsertRowid})`);
  }
}

function printFlowResult(res, asJson) {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.log(`Flow complete (id: ${res.id}, mode: ${res.mode}, event: ${res.event.type})`);

  if (res.steps.length === 0) {
    console.log("Steps: (none)");
  } else {
    console.log("Steps:");
    for (const s of res.steps) {
      const detail = s.ok
        ? formatDecisionPreview(s.output, 200)
        : formatDecisionPreview(s.error, 200);
      console.log(`  #${s.step} ${s.node} [${s.ok ? "ok" : "error"}]: ${detail}`);
    }
  }

  if (res.emittedEvents.length === 0) {
    console.log("Emitted events: (none)");
  } else {
    console.log("Emitted events:");
    for (const ev of res.emittedEvents) {
      console.log(`  - ${ev.event}: ${formatDecisionPreview(ev.data, 200)}`);
    }
  }
}

function printEmitResult(res, asJson) {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const runsCount = Array.isArray(res.runs) ? res.runs.length : 0;
  console.log(
    `Emitted "${res.event}" to "${res.slug}" (${res.mode}) — ${runsCount} matching flow(s)`
  );

  if (Array.isArray(res.steps) && res.steps.length > 0) {
    console.log("Steps:");
    for (const s of res.steps) {
      const detail = s.ok
        ? formatDecisionPreview(s.output, 200)
        : formatDecisionPreview(s.error, 200);
      console.log(`  #${s.step} ${s.node} [${s.ok ? "ok" : "error"}]: ${detail}`);
    }
  }

  if (Array.isArray(res.emittedEvents) && res.emittedEvents.length > 0) {
    console.log("Emitted events:");
    for (const ev of res.emittedEvents) {
      console.log(`  - ${ev.event}: ${formatDecisionPreview(ev.data, 200)}`);
    }
  }
}

function printReloadResult(res, asJson) {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const reloaded = res.reloaded ?? [];
  const unchanged = res.unchanged ?? [];
  const removed = res.removed ?? [];
  const errors = res.errors ?? [];

  console.log(
    `Reload (${res.mode}): reloaded=[${reloaded.join(", ")}] unchanged=${unchanged.length} removed=[${removed.join(", ")}] errors=${errors.length}`
  );
  for (const err of errors) {
    console.error(`  Error (${err.slug} [${err.mode}]): ${err.error}`);
  }
}

function printLogsResult(res, asJson) {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (!res.logs || res.logs.length === 0) {
    console.log(`No logs for "${res.slug}" (${res.mode}).`);
    return;
  }

  for (const entry of res.logs) {
    console.log(`[${entry.time}] [${entry.level}] ${entry.message}`);
  }
}

async function handleUp({ positionals, dataDir, json, foreground, port, bind, jevModel, jevUrl, jevApiKey }) {
  if (positionals.length > 2) {
    throw new Error(
      "Usage: bp up [dir] [--port <n>] [--bind <host>] [--data <dir>] [--foreground] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>] [--json]"
    );
  }

  const resolvedDataDir = resolveDataDir(dataDir);
  const status = await getDaemonStatus(resolvedDataDir);
  if (status.running) {
    throw new Error(
      `Daemon is already running (PID ${status.daemon.pid}) at ${status.baseUrl}. Stop it with "bp down" first.`
    );
  }

  const existingConfig = readDaemonConfig(resolvedDataDir);
  let dir;
  if (positionals[1]) {
    dir = path.resolve(positionals[1]);
  } else if (existingConfig.dir) {
    dir = existingConfig.dir;
  } else {
    dir = resolveBlueprintsDir();
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Blueprints directory not found or not a directory: ${dir}`);
  }

  const resolvedBind = bind ?? existingConfig.bind ?? DEFAULT_BIND;
  const resolvedPort = port !== undefined ? port : (existingConfig.port ?? DEFAULT_PORT);

  writeDaemonConfig(resolvedDataDir, {
    dir,
    bind: resolvedBind,
    port: port === 0 ? (existingConfig.port ?? DEFAULT_PORT) : resolvedPort,
  });

  if (foreground) {
    const daemon = startDaemon({
      dir,
      bind: resolvedBind,
      port: resolvedPort,
      dataDir: resolvedDataDir,
      jevModel,
      jevUrl,
      jevApiKey,
      writeFiles: true,
      exitOnShutdown: true,
    });

    const onSignal = () => {
      void daemon.shutdown({ fromHttp: false }).finally(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            pid: daemon.pid,
            bind: daemon.bind,
            port: daemon.port,
            url: daemon.baseUrl,
            dir: daemon.dir,
            startedAt: daemon.startedAt,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Daemon listening at ${daemon.baseUrl} (PID ${daemon.pid}, dir: ${daemon.dir})`);
    }
    return;
  }

  fs.mkdirSync(resolvedDataDir, { recursive: true });
  const logPath = getDaemonLogPath(resolvedDataDir);
  const logStartSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const logFd = fs.openSync(logPath, "a");

  const childArgs = [
    CLI_BIN,
    "up",
    dir,
    "--foreground",
    "--bind",
    resolvedBind,
    "--port",
    String(resolvedPort),
    "--data",
    resolvedDataDir,
  ];
  if (jevModel !== undefined) {
    childArgs.push("--jev-model", jevModel);
  }
  if (jevUrl !== undefined) {
    childArgs.push("--jev-url", jevUrl);
  }

  const childEnv =
    jevApiKey !== undefined
      ? { ...process.env, BP_JEV_API_KEY: jevApiKey }
      : process.env;

  let proc;
  try {
    proc = Bun.spawn([process.execPath, ...childArgs], {
      detached: true,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: childEnv,
    });
    proc.unref();
  } finally {
    fs.closeSync(logFd);
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = readDaemonInfo(resolvedDataDir);
    if (info && info.pid === proc.pid) {
      const url = buildDaemonBaseUrl(info.bind, info.port);
      const health = await probeDaemonHealth(url, 500);
      if (health) {
        if (json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                pid: info.pid,
                bind: info.bind,
                port: info.port,
                url,
                dir: info.dir,
                startedAt: info.startedAt,
              },
              null,
              2
            )
          );
        } else {
          console.log(`Daemon started (PID ${info.pid}) at ${url}`);
        }
        return;
      }
    }

    if (!isPidAlive(proc.pid)) {
      let detail = "";
      try {
        const logBuf = fs.readFileSync(logPath, "utf8").slice(logStartSize).trim();
        if (logBuf) detail = `: ${logBuf}`;
      } catch {
        // ignore
      }
      throw new Error(`Daemon failed to start${detail}`);
    }

    await Bun.sleep(40);
  }

  throw new Error(`Timed out waiting for daemon (PID ${proc.pid}) to become healthy.`);
}

async function handleDown({ positionals, dataDir, json }) {
  if (positionals.length !== 1) {
    throw new Error("Usage: bp down [--data <dir>] [--json]");
  }

  const resolvedDataDir = resolveDataDir(dataDir);
  const status = await getDaemonStatus(resolvedDataDir);
  if (!status.running) {
    if (json) {
      console.log(JSON.stringify({ ok: true, stopped: false, message: "Daemon is not running." }, null, 2));
    } else {
      console.log("Daemon is not running.");
    }
    return;
  }

  const pid = status.daemon.pid;
  try {
    await callDaemonApi(status.baseUrl, "/_bp/shutdown", { method: "POST" });
  } catch {
    // connection may close immediately during shutdown
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const stillExists = readDaemonInfo(resolvedDataDir) !== null;
    if (!stillExists && !isPidAlive(pid)) {
      break;
    }
    await Bun.sleep(40);
  }

  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
    const termDeadline = Date.now() + 1500;
    while (Date.now() < termDeadline && isPidAlive(pid)) {
      await Bun.sleep(40);
    }
  }

  removeDaemonInfo(resolvedDataDir, pid);

  if (json) {
    console.log(JSON.stringify({ ok: true, stopped: true, pid }, null, 2));
  } else {
    console.log(`Daemon stopped (PID ${pid}).`);
  }
}

async function main() {
  const {
    positionals,
    dev,
    dataDir,
    json,
    init,
    foreground,
    maxSteps,
    port,
    bind,
    limit,
    jevModel,
    jevUrl,
    jevApiKey,
    help,
    version,
  } = parseCliArgs(process.argv.slice(2));

  if (version) {
    console.log(readPackageVersion());
    return;
  }

  const command = positionals[0];
  if (help || !command || command === "help") {
    console.log(getUsageText());
    return;
  }

  const hasJevOpts = jevModel !== undefined || jevUrl !== undefined || jevApiKey !== undefined;

  if (command === "up") {
    if (dev || init || maxSteps !== undefined || limit !== undefined) {
      throw new Error('Options --dev, --init, --max-steps, and --limit are not supported with "bp up".');
    }
    await handleUp({ positionals, dataDir, json, foreground, port, bind, jevModel, jevUrl, jevApiKey });
    return;
  }

  if (command === "down") {
    if (dev || init || foreground || port !== undefined || bind !== undefined || limit !== undefined || maxSteps !== undefined || hasJevOpts) {
      throw new Error('Options other than --data and --json are not supported with "bp down".');
    }
    await handleDown({ positionals, dataDir, json });
    return;
  }

  if (command === "reload") {
    if (init || foreground || port !== undefined || bind !== undefined || limit !== undefined || maxSteps !== undefined || hasJevOpts) {
      throw new Error('Only [slug], --dev, --data, and --json are supported with "bp reload".');
    }
    if (positionals.length > 2) {
      throw new Error("Usage: bp reload [slug] [--dev] [--data <dir>] [--json]");
    }
    const { baseUrl } = await requireDaemonBaseUrl(dataDir, {
      explicitDataDir: dataDir !== undefined,
    });
    const res = await callDaemonApi(baseUrl, "/_bp/reload", {
      method: "POST",
      body: { slug: positionals[1], dev },
    });
    printReloadResult(res, json);
    if (Array.isArray(res.errors) && res.errors.length > 0) {
      process.exit(1);
    }
    return;
  }

  if (command === "emit") {
    if (init || foreground || port !== undefined || bind !== undefined || limit !== undefined || maxSteps !== undefined || hasJevOpts) {
      throw new Error('Only <slug> <event> [json], --dev, --data, and --json are supported with "bp emit".');
    }
    if (positionals.length < 3 || positionals.length > 4) {
      throw new Error("Usage: bp emit <slug> <event> [json-data] [--dev] [--data <dir>] [--json]");
    }
    let eventData = null;
    if (positionals.length === 4) {
      try {
        eventData = JSON.parse(positionals[3]);
      } catch (err) {
        throw new Error(`Invalid JSON data argument: ${err.message}`);
      }
    }
    const { baseUrl } = await requireDaemonBaseUrl(dataDir, {
      explicitDataDir: dataDir !== undefined,
    });
    const res = await callDaemonApi(baseUrl, "/_bp/emit", {
      method: "POST",
      body: {
        slug: positionals[1],
        event: positionals[2],
        data: eventData,
        dev,
      },
    });
    printEmitResult(res, json);
    return;
  }

  if (command === "logs") {
    if (init || foreground || port !== undefined || bind !== undefined || maxSteps !== undefined || hasJevOpts) {
      throw new Error('Only <slug>, --dev, --limit, --data, and --json are supported with "bp logs".');
    }
    if (positionals.length !== 2) {
      throw new Error("Usage: bp logs <slug> [--dev] [--limit <n>] [--data <dir>] [--json]");
    }
    const { baseUrl } = await requireDaemonBaseUrl(dataDir, {
      explicitDataDir: dataDir !== undefined,
    });
    const params = new URLSearchParams({
      slug: positionals[1],
      dev: dev ? "1" : "0",
    });
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    const res = await callDaemonApi(baseUrl, `/_bp/logs?${params.toString()}`, { method: "GET" });
    printLogsResult(res, json);
    return;
  }

  if (command === "sql") {
    if (init || maxSteps !== undefined || hasJevOpts) {
      throw new Error(
        'Options --init, --max-steps, --jev-url, --jev-model, and --jev-key are only supported with "bp run".'
      );
    }
    if (foreground || port !== undefined || bind !== undefined || limit !== undefined) {
      throw new Error('Options --foreground, --port, --bind, and --limit are not supported with "bp sql".');
    }
    if (positionals.length !== 3) {
      throw new Error('Usage: bp sql <file.html|id> "<statement>" [--dev] [--data <dir>] [--json]');
    }

    const res = runBlueprintSql({
      fileOrId: positionals[1],
      statement: positionals[2],
      dev,
      dataDir,
    });
    printSqlResult(res, json);
    if (res.didWrite) {
      await notifyDaemonChange({
        id: res.id,
        dev,
        dataDir,
        explicitDataDir: dataDir !== undefined,
      });
    }
    return;
  }

  if (command === "run") {
    if (foreground || port !== undefined || bind !== undefined || limit !== undefined) {
      throw new Error('Options --foreground, --port, --bind, and --limit are not supported with "bp run".');
    }
    if (init) {
      if (positionals.length !== 2) {
        throw new Error(
          "Usage: bp run <file.html> --init [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]"
        );
      }
      const res = await runBlueprintFlow({
        filePath: positionals[1],
        init: true,
        dev,
        dataDir,
        maxSteps,
        jevModel,
        jevUrl,
        jevApiKey,
      });
      printFlowResult(res, json);
      return;
    }

    if (positionals.length < 3 || positionals.length > 4) {
      throw new Error(
        "Usage: bp run <file.html> <event> [json-data] [--dev] [--data <dir>] [--json] [--max-steps <n>] [--jev-url <url>] [--jev-model <name>] [--jev-key <key>]"
      );
    }

    let eventData = null;
    if (positionals.length === 4) {
      try {
        eventData = JSON.parse(positionals[3]);
      } catch (err) {
        throw new Error(`Invalid JSON data argument: ${err.message}`);
      }
    }

    const res = await runBlueprintFlow({
      filePath: positionals[1],
      event: positionals[2],
      data: eventData,
      dev,
      dataDir,
      maxSteps,
      jevModel,
      jevUrl,
      jevApiKey,
    });
    printFlowResult(res, json);
    return;
  }

  throw new Error(`Unknown command "${command}". Run "bp --help" for usage.`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
