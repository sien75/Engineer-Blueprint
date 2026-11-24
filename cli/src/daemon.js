import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeReadOnlyQuery,
  getMainDbPath,
  getMode,
  resolveDataDir,
  syncBlueprint,
} from "./db.js";
import {
  DEFAULT_MAX_STEPS,
  ensureLoopbackNoProxy,
  executeFlows,
  formatDecisionPreview,
} from "./flow.js";
import { extractHtmlTitle, parseBlueprintHtml, renderBrowserHtml } from "./parse.js";
import { parseSchedule, startSchedule } from "./schedule.js";
import { validateReadOnlySql, validateWatchQuery } from "./sql.js";

export const DEFAULT_BIND = "127.0.0.1";
export const DEFAULT_PORT = 7500;
export const MAX_LOGS_PER_BLUEPRINT = 200;

const CLIENT_JS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./client.js");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sha256Hex(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function getConfigPath(dataDir) {
  return path.join(resolveDataDir(dataDir), "config.json");
}

export function getDaemonJsonPath(dataDir) {
  return path.join(resolveDataDir(dataDir), "daemon.json");
}

export function getDaemonLogPath(dataDir) {
  return path.join(resolveDataDir(dataDir), "daemon.log");
}

export function readDaemonConfig(dataDir) {
  const configPath = getConfigPath(dataDir);
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDaemonConfig(dataDir, config) {
  const resolved = resolveDataDir(dataDir);
  fs.mkdirSync(resolved, { recursive: true });
  const configPath = getConfigPath(resolved);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

export function readDaemonInfo(dataDir) {
  const daemonPath = getDaemonJsonPath(dataDir);
  if (!fs.existsSync(daemonPath)) return null;
  try {
    const raw = fs.readFileSync(daemonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removeDaemonInfo(dataDir, expectedPid = null) {
  const daemonPath = getDaemonJsonPath(dataDir);
  if (!fs.existsSync(daemonPath)) return false;
  if (expectedPid !== null) {
    const current = readDaemonInfo(dataDir);
    if (current && current.pid !== expectedPid) {
      return false;
    }
  }
  try {
    fs.unlinkSync(daemonPath);
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function connectHost(bind) {
  const raw = typeof bind === "string" ? bind.trim() : "";
  if (!raw || raw === "0.0.0.0") return "127.0.0.1";
  if (raw === "::" || raw === "[::]") return "[::1]";
  if (raw.includes(":") && !raw.startsWith("[")) return `[${raw}]`;
  return raw;
}

export function buildDaemonBaseUrl(bind, port) {
  return `http://${connectHost(bind)}:${port}`;
}

export async function probeDaemonHealth(baseUrl, timeoutMs = 1500) {
  const healthUrl = `${baseUrl.replace(/\/+$/, "")}/_bp/health`;
  ensureLoopbackNoProxy(healthUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const payload = await res.json();
    if (!payload || payload.ok !== true) return null;
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspect `daemon.json`, verify PID liveness and `/_bp/health` reachability,
 * and clean up stale `daemon.json` files automatically.
 */
export async function getDaemonStatus(dataDir) {
  const resolved = resolveDataDir(dataDir);
  const info = readDaemonInfo(resolved);
  if (!info) {
    const hadFile = fs.existsSync(getDaemonJsonPath(resolved));
    if (hadFile) removeDaemonInfo(resolved);
    return { running: false, daemon: null, health: null, cleanedStale: hadFile };
  }

  if (!Number.isInteger(info.pid) || !Number.isInteger(info.port) || !isPidAlive(info.pid)) {
    removeDaemonInfo(resolved);
    return { running: false, daemon: null, health: null, cleanedStale: true };
  }

  const baseUrl = buildDaemonBaseUrl(info.bind, info.port);
  const health = await probeDaemonHealth(baseUrl);
  if (!health) {
    removeDaemonInfo(resolved);
    return { running: false, daemon: null, health: null, cleanedStale: true };
  }

  return {
    running: true,
    daemon: info,
    baseUrl,
    health,
    cleanedStale: false,
  };
}

export async function requireDaemonBaseUrl(dataDir, { explicitDataDir = false } = {}) {
  const status = await getDaemonStatus(dataDir);
  if (status.running) {
    return { baseUrl: status.baseUrl, daemon: status.daemon };
  }
  if (!explicitDataDir && process.env.BP_DAEMON_URL) {
    const envUrl = process.env.BP_DAEMON_URL.trim().replace(/\/+$/, "");
    if (envUrl) {
      const health = await probeDaemonHealth(envUrl);
      if (health) {
        return { baseUrl: envUrl, daemon: health };
      }
    }
  }
  throw new Error('Daemon is not running. Start it with "bp up" first.');
}

export async function callDaemonApi(baseUrl, pathname, { method = "GET", body } = {}) {
  const targetUrl = `${baseUrl.replace(/\/+$/, "")}${pathname}`;
  ensureLoopbackNoProxy(targetUrl);

  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(targetUrl, init);
  } catch (err) {
    throw new Error(`Failed to reach daemon at ${targetUrl}: ${err.message}`);
  }

  const text = await res.text();
  let parsed = null;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const msg = parsed?.error || text.trim() || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

  return parsed ?? {};
}

/**
 * Best-effort notification to the running daemon after `bp sql` modifies a blueprint DB.
 */
export async function notifyDaemonChange({ id, dev = false, dataDir, explicitDataDir = false }) {
  try {
    const resolved = resolveDataDir(dataDir);
    let baseUrl = null;
    const info = readDaemonInfo(resolved);
    if (info && Number.isInteger(info.port) && isPidAlive(info.pid)) {
      baseUrl = buildDaemonBaseUrl(info.bind, info.port);
    } else if (!explicitDataDir && process.env.BP_DAEMON_URL) {
      baseUrl = process.env.BP_DAEMON_URL.trim().replace(/\/+$/, "");
    }
    if (!baseUrl) return false;

    const targetUrl = `${baseUrl}/_bp/notify-change`;
    ensureLoopbackNoProxy(targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, dev: Boolean(dev) }),
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function scanBlueprintFiles(dir) {
  const resolvedDir = path.resolve(dir);
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".html")) continue;
    const filePath = path.join(resolvedDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const slug = entry.name.slice(0, -".html".length);
    if (!slug) continue;
    files.push({ slug, fileName: entry.name, filePath });
  }

  files.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return files;
}

function renderOverviewPage({ dir, rows }) {
  const itemsHtml =
    rows.length === 0
      ? `<p class="empty">No <code>*.html</code> blueprints found in <code>${escapeHtml(dir)}</code>.</p>`
      : `<div class="list">
          ${rows
            .map((r) => {
              const prodHref = `/bp/${encodeURIComponent(r.slug)}`;
              const devHref = `/bp-dev/${encodeURIComponent(r.slug)}`;
              const errorHtml = r.error
                ? `<div class="err-banner"><strong>Load error:</strong> ${escapeHtml(r.error)}</div>`
                : "";
              const statusBadge = r.error
                ? `<span class="badge badge-err">error</span>`
                : r.loaded
                  ? `<span class="badge badge-ok">ready</span>`
                  : `<span class="badge badge-idle">unloaded</span>`;

              return `<article class="card">
                <div class="card-head">
                  <div>
                    <h2>${escapeHtml(r.title || r.slug)} ${statusBadge}</h2>
                    <div class="meta">
                      <span>slug: <code>${escapeHtml(r.slug)}</code></span>
                      <span>id: <code>${escapeHtml(r.id || "—")}</code></span>
                    </div>
                  </div>
                  <div class="links">
                    <a class="btn" href="${prodHref}">prod</a>
                    <a class="btn btn-dev" href="${devHref}">dev</a>
                  </div>
                </div>
                ${errorHtml}
              </article>`;
            })
            .join("\n")}
        </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Engineer Blueprint</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { max-width: 820px; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.5; }
    header { margin-bottom: 1.5rem; border-bottom: 1px solid #d0d7de44; padding-bottom: 0.75rem; }
    h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
    .dir { font-size: 0.9rem; opacity: 0.8; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    .list { display: flex; flex-direction: column; gap: 0.75rem; }
    .card { border: 1px solid #d0d7de66; border-radius: 8px; padding: 0.9rem 1rem; }
    .card-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    h2 { margin: 0 0 0.25rem; font-size: 1.05rem; display: flex; align-items: center; gap: 0.5rem; }
    .meta { display: flex; gap: 1rem; font-size: 0.85rem; opacity: 0.85; flex-wrap: wrap; }
    .links { display: flex; gap: 0.5rem; }
    .btn { text-decoration: none; padding: 0.35rem 0.75rem; border-radius: 6px; border: 1px solid #0969da; color: #0969da; font-size: 0.85rem; font-weight: 500; }
    .btn-dev { border-color: #8250df; color: #8250df; }
    .badge { font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 999px; font-weight: 500; }
    .badge-ok { background: #1a7f3722; color: #1a7f37; }
    .badge-err { background: #cf222e22; color: #cf222e; }
    .badge-idle { background: #6e778122; color: #6e7781; }
    .err-banner { margin-top: 0.75rem; padding: 0.6rem 0.75rem; border-radius: 6px; background: #cf222e18; border: 1px solid #cf222e55; color: #cf222e; font-size: 0.88rem; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>Engineer Blueprint</h1>
    <div class="dir">Directory: <code>${escapeHtml(dir)}</code> · ${rows.length} blueprint(s)</div>
  </header>
  ${itemsHtml}
</body>
</html>`;
}

function renderBlueprintErrorPage({ slug, mode, filePath, error }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blueprint Error — ${escapeHtml(slug)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { max-width: 760px; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.5; }
    .box { border: 1px solid #cf222e66; background: #cf222e14; border-radius: 8px; padding: 1.1rem 1.25rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.2rem; color: #cf222e; }
    pre { overflow-x: auto; padding: 0.75rem; border-radius: 6px; background: #00000014; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    a { color: #0969da; }
  </style>
</head>
<body>
  <p><a href="/">&larr; Back to Overview</a></p>
  <div class="box">
    <h1>Failed to load blueprint "${escapeHtml(slug)}" (${escapeHtml(mode)})</h1>
    <p>File: <code>${escapeHtml(filePath)}</code></p>
    <pre>${escapeHtml(error)}</pre>
  </div>
</body>
</html>`;
}

function registryKey(mode, slug) {
  return `${mode}:${slug}`;
}

/**
 * Start the persistent Engineer Blueprint HTTP/WebSocket daemon and scheduler.
 */
export function startDaemon({
  dir,
  bind = DEFAULT_BIND,
  port = DEFAULT_PORT,
  dataDir,
  jevModel,
  jevUrl,
  jevApiKey,
  maxSteps = DEFAULT_MAX_STEPS,
  decide,
  writeFiles = true,
  exitOnShutdown = false,
} = {}) {
  if (!dir || typeof dir !== "string") {
    throw new Error("Blueprints directory is required.");
  }
  const resolvedDir = path.resolve(dir);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`Blueprints directory not found or not a directory: ${resolvedDir}`);
  }

  const resolvedDataDir = resolveDataDir(dataDir);
  const startedAt = new Date().toISOString();

  /** @type {Map<string, object>} */
  const registry = new Map();
  /** @type {Map<string, Array<object>>} */
  const logsByKey = new Map();
  /** @type {Map<string, Set<import("bun").ServerWebSocket>>} */
  const roomClients = new Map();

  let shuttingDown = false;
  let server = null;

  function appendLog(slug, mode, entry) {
    const key = registryKey(mode, slug);
    let list = logsByKey.get(key);
    if (!list) {
      list = [];
      logsByKey.set(key, list);
    }
    list.push({
      time: new Date().toISOString(),
      slug,
      mode,
      ...entry,
    });
    if (list.length > MAX_LOGS_PER_BLUEPRINT) {
      list.splice(0, list.length - MAX_LOGS_PER_BLUEPRINT);
    }
  }

  function getLogs(slug, mode, limit = 50) {
    const list = logsByKey.get(registryKey(mode, slug)) ?? [];
    if (!limit || limit >= list.length) {
      return [...list];
    }
    return list.slice(list.length - limit);
  }

  function broadcastToRoom(slug, mode, payload) {
    const clients = roomClients.get(registryKey(mode, slug));
    if (!clients || clients.size === 0) return;
    const text = JSON.stringify(payload);
    for (const ws of clients) {
      try {
        ws.send(text);
      } catch {
        // ignore closed/broken socket
      }
    }
  }

  function notifyWatchSubscribers(slug, mode) {
    const key = registryKey(mode, slug);
    const entry = registry.get(key);
    if (!entry || entry.error || !entry.id) return;

    const clients = roomClients.get(key);
    if (!clients || clients.size === 0) return;

    /** @type {Map<string, string>} */
    const uniqueQueries = new Map();
    for (const ws of clients) {
      if (!ws.data?.watches) continue;
      for (const [query, sql] of ws.data.watches.entries()) {
        if (!uniqueQueries.has(query)) {
          uniqueQueries.set(query, sql);
        }
      }
    }
    if (uniqueQueries.size === 0) return;

    const dbPath = getMainDbPath(entry.id, mode, resolvedDataDir);
    for (const [query, sql] of uniqueQueries.entries()) {
      let rows;
      try {
        rows = executeReadOnlyQuery({ dbPath, sql });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(slug, mode, {
          type: "watch:error",
          level: "error",
          query,
          message: `Watch query "${query}" failed: ${msg}`,
        });
        for (const ws of clients) {
          if (ws.data?.watches?.has(query)) {
            try {
              ws.send(JSON.stringify({ op: "error", message: `Watch "${query}" error: ${msg}` }));
            } catch {
              // ignore
            }
          }
        }
        continue;
      }

      const frame = JSON.stringify({ op: "change", query, rows });
      for (const ws of clients) {
        if (ws.data?.watches?.has(query)) {
          try {
            ws.send(frame);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  function notifyWatchSubscribersById(id, mode) {
    let notified = 0;
    for (const entry of registry.values()) {
      if (entry.mode === mode && entry.id === id && !entry.error) {
        notifyWatchSubscribers(entry.slug, mode);
        notified++;
      }
    }
    return notified;
  }

  function stopEntryTimers(entry) {
    if (!entry?.timers) return;
    for (const handle of entry.timers) {
      try {
        handle.stop();
      } catch {
        // ignore
      }
    }
    entry.timers = [];
  }

  function unloadBlueprint(slug, mode) {
    const key = registryKey(mode, slug);
    const existing = registry.get(key);
    if (!existing) return false;
    stopEntryTimers(existing);
    registry.delete(key);
    appendLog(slug, mode, {
      type: "unload",
      level: "info",
      message: `Unloaded removed blueprint "${slug}" (${mode})`,
    });
    return true;
  }

  function createFlowHooks(slug, mode, eventLabel, source) {
    return {
      onFlowStart({ flow }) {
        const triggerDesc =
          flow.triggerType === "init"
            ? "init"
            : flow.triggerType === "every"
              ? `every="${flow.triggerValue}"`
              : `on="${flow.triggerValue}"`;
        appendLog(slug, mode, {
          type: "flow:start",
          level: "info",
          event: eventLabel,
          source,
          message: `Flow started (${triggerDesc}, source: ${source})`,
        });
      },
      onStep({ step, node, ok, output, error, sqlWrite }) {
        const detail = ok
          ? formatDecisionPreview(output, 200)
          : formatDecisionPreview(error, 200);
        appendLog(slug, mode, {
          type: "step",
          level: ok ? "info" : "error",
          event: eventLabel,
          step,
          node,
          ok,
          message: `#${step} ${node} [${ok ? "ok" : "error"}]: ${detail}`,
        });
        if (sqlWrite) {
          notifyWatchSubscribers(slug, mode);
        }
      },
      onEmit({ event, data }) {
        appendLog(slug, mode, {
          type: "emit",
          level: "info",
          event,
          source: "flow",
          message: `Emitted "${event}": ${formatDecisionPreview(data, 200)}`,
        });
        broadcastToRoom(slug, mode, {
          op: "event",
          event,
          source: "flow",
          data,
          time: new Date().toISOString(),
        });
      },
      onFlowEnd({ steps }) {
        appendLog(slug, mode, {
          type: "flow:finish",
          level: "info",
          event: eventLabel,
          stepsCount: steps.length,
          message: `Flow finished (${steps.length} step(s))`,
        });
      },
      onFlowError({ error }) {
        const msg = error instanceof Error ? error.message : String(error);
        appendLog(slug, mode, {
          type: "flow:error",
          level: "error",
          event: eventLabel,
          message: `Flow failed: ${msg}`,
        });
      },
    };
  }

  async function runInitFlowsInBackground(slug, mode, entry, initFlows) {
    if (shuttingDown || initFlows.length === 0) return;
    const dbPath = getMainDbPath(entry.id, mode, resolvedDataDir);
    appendLog(slug, mode, {
      type: "init",
      level: "info",
      message: `Starting ${initFlows.length} init flow(s) in background`,
    });
    try {
      await executeFlows({
        parsed: entry.parsed,
        flows: initFlows,
        eventType: "init",
        eventData: null,
        dbPath,
        mode,
        maxSteps,
        jevModel,
        jevUrl,
        jevApiKey,
        decide,
        hooks: createFlowHooks(slug, mode, "init", "init"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(slug, mode, {
        type: "init",
        level: "error",
        message: `Init flow error: ${msg}`,
      });
    }
  }

  async function runScheduledEveryFlow(slug, mode, flow) {
    if (shuttingDown) return;
    const entry = registry.get(registryKey(mode, slug));
    if (!entry || entry.error || !entry.parsed) return;
    const dbPath = getMainDbPath(entry.id, mode, resolvedDataDir);
    appendLog(slug, mode, {
      type: "every",
      level: "info",
      schedule: flow.triggerValue,
      message: `Schedule triggered (every="${flow.triggerValue}")`,
    });
    await executeFlows({
      parsed: entry.parsed,
      flows: [flow],
      eventType: "every",
      eventData: { schedule: flow.triggerValue },
      dbPath,
      mode,
      maxSteps,
      jevModel,
      jevUrl,
      jevApiKey,
      decide,
      hooks: createFlowHooks(slug, mode, `every:${flow.triggerValue}`, "schedule"),
    });
  }

  function loadBlueprintEntry(slug, mode, filePath, { runInit = false, isReload = false } = {}) {
    const key = registryKey(mode, slug);
    const prev = registry.get(key);
    if (prev) {
      stopEntryTimers(prev);
    }

    const rawHtml = fs.readFileSync(filePath, "utf8");
    const hash = sha256Hex(rawHtml);
    const title = extractHtmlTitle(rawHtml);
    const timers = [];

    try {
      const parsed = parseBlueprintHtml(rawHtml);
      parsed.filePath = filePath;

      const everyFlows = parsed.flows.filter((f) => f.triggerType === "every");
      for (const flow of everyFlows) {
        parseSchedule(flow.triggerValue);
      }

      syncBlueprint({
        filePath,
        dev: mode === "dev",
        dataDir: resolvedDataDir,
      });

      for (const flow of everyFlows) {
        const handle = startSchedule(
          flow.triggerValue,
          () => runScheduledEveryFlow(slug, mode, flow),
          {
            onError: (err) => {
              const msg = err instanceof Error ? err.message : String(err);
              appendLog(slug, mode, {
                type: "every:error",
                level: "error",
                schedule: flow.triggerValue,
                message: `Scheduled flow error (every="${flow.triggerValue}"): ${msg}`,
              });
            },
          }
        );
        timers.push(handle);
      }

      const entry = {
        slug,
        mode,
        filePath,
        rawHtml,
        hash,
        title,
        parsed,
        id: parsed.id,
        error: null,
        timers,
      };
      registry.set(key, entry);

      appendLog(slug, mode, {
        type: isReload ? "reload" : "load",
        level: "info",
        message: `${isReload ? "Reloaded" : "Loaded"} blueprint "${slug}" (id: ${parsed.id}, mode: ${mode})`,
      });

      if (runInit) {
        const initFlows = parsed.flows.filter((f) => f.triggerType === "init");
        if (initFlows.length > 0) {
          queueMicrotask(() => {
            void runInitFlowsInBackground(slug, mode, entry, initFlows);
          });
        }
      }

      return entry;
    } catch (err) {
      for (const handle of timers) {
        try {
          handle.stop();
        } catch {
          // ignore
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      const entry = {
        slug,
        mode,
        filePath,
        rawHtml,
        hash,
        title,
        parsed: null,
        id: null,
        error: message,
        timers: [],
      };
      registry.set(key, entry);
      appendLog(slug, mode, {
        type: isReload ? "reload" : "load",
        level: "error",
        message: `${isReload ? "Reload" : "Load"} error: ${message}`,
      });
      return entry;
    }
  }

  function resolveSlugFilePath(slug) {
    if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
      return null;
    }
    const candidate = path.join(resolvedDir, `${slug}.html`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    return null;
  }

  function ensureEntry(slug, mode) {
    const key = registryKey(mode, slug);
    const existing = registry.get(key);
    if (existing) return existing;

    if (mode === "dev") {
      const filePath = resolveSlugFilePath(slug);
      if (!filePath) return null;
      return loadBlueprintEntry(slug, "dev", filePath, { runInit: true, isReload: false });
    }
    return null;
  }

  function reloadBlueprints({ slug, dev = false } = {}) {
    const mode = getMode(dev);

    if (slug) {
      const filePath = resolveSlugFilePath(slug);
      if (!filePath) {
        const err = new Error(`Blueprint "${slug}" not found in ${resolvedDir}.`);
        err.statusCode = 404;
        throw err;
      }
      const wasLoaded = registry.has(registryKey(mode, slug));
      const entry = loadBlueprintEntry(slug, mode, filePath, {
        runInit: !wasLoaded,
        isReload: true,
      });

      if (entry.error) {
        broadcastToRoom(slug, mode, { op: "error", message: entry.error });
        return {
          mode,
          reloaded: [],
          unchanged: [],
          removed: [],
          errors: [{ slug, mode, error: entry.error }],
        };
      }

      broadcastToRoom(slug, mode, { op: "reload" });
      return {
        mode,
        reloaded: [slug],
        unchanged: [],
        removed: [],
        errors: [],
      };
    }

    const diskFiles = scanBlueprintFiles(resolvedDir);
    const diskMap = new Map(diskFiles.map((f) => [f.slug, f]));

    const reloaded = [];
    const unchanged = [];
    const removed = [];
    const errors = [];

    for (const existing of [...registry.values()]) {
      if (existing.mode === mode && !diskMap.has(existing.slug)) {
        unloadBlueprint(existing.slug, mode);
        removed.push(existing.slug);
      }
    }

    for (const file of diskFiles) {
      const key = registryKey(mode, file.slug);
      const existing = registry.get(key);
      const diskHash = sha256Hex(fs.readFileSync(file.filePath, "utf8"));

      if (!existing || existing.hash !== diskHash) {
        const entry = loadBlueprintEntry(file.slug, mode, file.filePath, {
          runInit: !existing,
          isReload: Boolean(existing),
        });
        if (entry.error) {
          errors.push({ slug: file.slug, mode, error: entry.error });
          broadcastToRoom(file.slug, mode, { op: "error", message: entry.error });
        } else {
          reloaded.push(file.slug);
          broadcastToRoom(file.slug, mode, { op: "reload" });
        }
      } else {
        unchanged.push(file.slug);
      }
    }

    // Also refresh any already-loaded dev entries when running `bp reload` without --dev
    if (!dev) {
      for (const existing of [...registry.values()]) {
        if (existing.mode !== "dev") continue;
        const diskFile = diskMap.get(existing.slug);
        if (!diskFile) {
          unloadBlueprint(existing.slug, "dev");
          continue;
        }
        const diskHash = sha256Hex(fs.readFileSync(diskFile.filePath, "utf8"));
        if (existing.hash !== diskHash) {
          const devEntry = loadBlueprintEntry(existing.slug, "dev", diskFile.filePath, {
            runInit: false,
            isReload: true,
          });
          if (devEntry.error) {
            errors.push({ slug: existing.slug, mode: "dev", error: devEntry.error });
            broadcastToRoom(existing.slug, "dev", { op: "error", message: devEntry.error });
          } else {
            broadcastToRoom(existing.slug, "dev", { op: "reload" });
          }
        }
      }
    }

    removed.sort();
    return { mode, reloaded, unchanged, removed, errors };
  }

  async function triggerEmit({ slug, dev = false, mode: explicitMode, event, data = null, source = "cli" }) {
    const mode = explicitMode || getMode(dev);
    if (typeof event !== "string" || event.trim().length === 0) {
      const err = new Error('Missing non-empty "event" name.');
      err.statusCode = 400;
      throw err;
    }
    const eventName = event.trim();
    const normalizedData = data === undefined ? null : data;

    const entry = ensureEntry(slug, mode);
    if (!entry) {
      const err = new Error(`Blueprint "${slug}" (${mode}) not found.`);
      err.statusCode = 404;
      throw err;
    }
    if (entry.error || !entry.parsed) {
      const err = new Error(`Blueprint "${slug}" (${mode}) has a load error: ${entry.error}`);
      err.statusCode = 500;
      throw err;
    }

    const matched = entry.parsed.flows.filter(
      (f) => f.triggerType === "on" && f.triggerValue === eventName
    );

    appendLog(slug, mode, {
      type: "emit",
      level: "info",
      event: eventName,
      source,
      message: `Event "${eventName}" (${source}, ${matched.length} matching flow(s))`,
    });

    broadcastToRoom(slug, mode, {
      op: "event",
      event: eventName,
      source,
      data: normalizedData,
      time: new Date().toISOString(),
    });

    if (matched.length === 0) {
      return {
        slug,
        mode,
        event: eventName,
        runs: [],
        steps: [],
        emittedEvents: [],
      };
    }

    const dbPath = getMainDbPath(entry.id, mode, resolvedDataDir);
    const result = await executeFlows({
      parsed: entry.parsed,
      flows: matched,
      eventType: eventName,
      eventData: normalizedData,
      dbPath,
      mode,
      maxSteps,
      jevModel,
      jevUrl,
      jevApiKey,
      decide,
      hooks: createFlowHooks(slug, mode, eventName, source),
    });

    return {
      slug,
      mode,
      event: eventName,
      runs: result.flows,
      steps: result.steps,
      emittedEvents: result.emittedEvents,
    };
  }

  // Eagerly load all *.html blueprints in prod mode on startup
  for (const file of scanBlueprintFiles(resolvedDir)) {
    loadBlueprintEntry(file.slug, "prod", file.filePath, { runInit: true, isReload: false });
  }

  const clientJsContent = fs.readFileSync(CLIENT_JS_PATH, "utf8");

  server = Bun.serve({
    hostname: bind,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;

      // 1. Overview page
      if (req.method === "GET" && pathname === "/") {
        const files = scanBlueprintFiles(resolvedDir);
        const rows = files.map((file) => {
          const prodEntry = registry.get(registryKey("prod", file.slug));
          const devEntry = registry.get(registryKey("dev", file.slug));
          let title = prodEntry?.title || devEntry?.title || null;
          if (!title) {
            try {
              title = extractHtmlTitle(fs.readFileSync(file.filePath, "utf8"));
            } catch {
              title = null;
            }
          }
          const errors = [];
          if (prodEntry?.error) errors.push(`[prod] ${prodEntry.error}`);
          if (devEntry?.error) errors.push(`[dev] ${devEntry.error}`);
          return {
            slug: file.slug,
            title,
            id: prodEntry?.id || devEntry?.id || null,
            loaded: Boolean(prodEntry),
            error: errors.length > 0 ? errors.join("\n") : null,
          };
        });
        return new Response(renderOverviewPage({ dir: resolvedDir, rows }), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      // 2. Control HTTP API
      if (req.method === "GET" && pathname === "/_bp/health") {
        return Response.json({
          ok: true,
          pid: process.pid,
          bind,
          port: srv.port,
          dir: resolvedDir,
          startedAt,
        });
      }

      if (req.method === "POST" && pathname === "/_bp/shutdown") {
        const res = Response.json({ ok: true, stopped: true, pid: process.pid });
        setTimeout(() => {
          void shutdown({ fromHttp: true });
        }, 10);
        return res;
      }

      if (req.method === "POST" && pathname === "/_bp/reload") {
        let body = {};
        try {
          const raw = await req.text();
          if (raw.trim().length > 0) body = JSON.parse(raw);
        } catch (err) {
          return Response.json({ error: `Invalid JSON body: ${err.message}` }, { status: 400 });
        }
        try {
          const out = reloadBlueprints({
            slug: typeof body.slug === "string" && body.slug.trim() ? body.slug.trim() : undefined,
            dev: Boolean(body.dev),
          });
          return Response.json(out);
        } catch (err) {
          return Response.json(
            { error: err.message },
            { status: err.statusCode || 500 }
          );
        }
      }

      if (req.method === "POST" && pathname === "/_bp/emit") {
        let body;
        try {
          body = await req.json();
        } catch (err) {
          return Response.json({ error: `Invalid JSON body: ${err.message}` }, { status: 400 });
        }
        if (!body || typeof body.slug !== "string" || !body.slug.trim()) {
          return Response.json({ error: 'Missing non-empty "slug".' }, { status: 400 });
        }
        try {
          const out = await triggerEmit({
            slug: body.slug.trim(),
            dev: Boolean(body.dev),
            event: body.event,
            data: body.data === undefined ? null : body.data,
            source: "cli",
          });
          return Response.json(out);
        } catch (err) {
          return Response.json(
            { error: err.message },
            { status: err.statusCode || 500 }
          );
        }
      }

      if (req.method === "GET" && pathname === "/_bp/logs") {
        const slug = (url.searchParams.get("slug") ?? "").trim();
        if (!slug) {
          return Response.json({ error: 'Missing query parameter "slug".' }, { status: 400 });
        }
        const devParam = url.searchParams.get("dev");
        const mode = devParam === "1" || devParam === "true" ? "dev" : "prod";
        const rawLimit = url.searchParams.get("limit");
        let limit = 50;
        if (rawLimit !== null && rawLimit !== "") {
          const n = Number(rawLimit);
          if (!Number.isInteger(n) || n < 1) {
            return Response.json({ error: 'Invalid "limit" query parameter.' }, { status: 400 });
          }
          limit = Math.min(n, MAX_LOGS_PER_BLUEPRINT);
        }

        const logs = getLogs(slug, mode, limit);
        if (logs.length === 0 && !registry.has(registryKey(mode, slug)) && !resolveSlugFilePath(slug)) {
          return Response.json(
            { error: `Blueprint "${slug}" not found in ${resolvedDir}.` },
            { status: 404 }
          );
        }
        return Response.json({ slug, mode, logs });
      }

      if (req.method === "POST" && pathname === "/_bp/notify-change") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON body." }, { status: 400 });
        }
        if (!body || typeof body.id !== "string" || !body.id.trim()) {
          return Response.json({ error: 'Missing "id".' }, { status: 400 });
        }
        const mode = getMode(Boolean(body.dev));
        const notified = notifyWatchSubscribersById(body.id.trim(), mode);
        return Response.json({ ok: true, id: body.id.trim(), mode, notified });
      }

      // 3. Blueprint routes: /bp/<slug>... and /bp-dev/<slug>...
      let bpMode = null;
      let rest = null;
      if (pathname.startsWith("/bp/")) {
        bpMode = "prod";
        rest = pathname.slice("/bp/".length);
      } else if (pathname.startsWith("/bp-dev/")) {
        bpMode = "dev";
        rest = pathname.slice("/bp-dev/".length);
      }

      if (bpMode !== null) {
        const slashIdx = rest.indexOf("/");
        const rawSlug = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
        const subRoute = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);

        let slug;
        try {
          slug = decodeURIComponent(rawSlug);
        } catch {
          return new Response("Invalid blueprint slug.", { status: 400 });
        }
        if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
          return new Response("Invalid blueprint slug.", { status: 400 });
        }

        if (req.method === "GET" && subRoute === "bp.js") {
          return new Response(clientJsContent, {
            status: 200,
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        if (subRoute === "ws") {
          const entry = ensureEntry(slug, bpMode);
          if (!entry) {
            return new Response(`Blueprint "${slug}" (${bpMode}) not found.`, { status: 404 });
          }
          if (entry.error) {
            return new Response(`Blueprint "${slug}" (${bpMode}) failed to load: ${entry.error}`, {
              status: 500,
            });
          }
          const upgraded = srv.upgrade(req, {
            data: { slug, mode: bpMode, watches: new Map() },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed.", { status: 400 });
        }

        if (req.method === "GET" && subRoute === "") {
          const entry = ensureEntry(slug, bpMode);
          if (!entry) {
            return new Response(`Blueprint "${slug}" (${bpMode}) not found.`, { status: 404 });
          }
          if (entry.error) {
            return new Response(
              renderBlueprintErrorPage({
                slug,
                mode: bpMode,
                filePath: entry.filePath,
                error: entry.error,
              }),
              {
                status: 500,
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "Cache-Control": "no-store",
                },
              }
            );
          }

          const prefix = bpMode === "dev" ? "/bp-dev" : "/bp";
          const bpJsUrl = `${prefix}/${encodeURIComponent(slug)}/bp.js`;
          const rendered = renderBrowserHtml(entry.rawHtml, bpJsUrl);
          return new Response(rendered, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const key = registryKey(ws.data.mode, ws.data.slug);
        let set = roomClients.get(key);
        if (!set) {
          set = new Set();
          roomClients.set(key, set);
        }
        set.add(ws);
      },

      close(ws) {
        const key = registryKey(ws.data.mode, ws.data.slug);
        const set = roomClients.get(key);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            roomClients.delete(key);
          }
        }
        ws.data?.watches?.clear();
      },

      async message(ws, raw) {
        const rawText =
          typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        let msg;
        try {
          msg = JSON.parse(rawText);
        } catch {
          ws.send(JSON.stringify({ ok: false, error: "Invalid JSON message." }));
          return;
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
          ws.send(JSON.stringify({ ok: false, error: "WebSocket message must be a JSON object." }));
          return;
        }

        const reqId = msg.id;
        const replyOk = (extra = {}) => {
          const frame = reqId !== undefined ? { id: reqId, ok: true, ...extra } : { ok: true, ...extra };
          ws.send(JSON.stringify(frame));
        };
        const replyErr = (message) => {
          const frame =
            reqId !== undefined ? { id: reqId, ok: false, error: message } : { ok: false, error: message };
          ws.send(JSON.stringify(frame));
        };

        const { slug, mode } = ws.data;
        const entry = registry.get(registryKey(mode, slug));

        try {
          if (msg.op === "emit") {
            if (typeof msg.event !== "string" || msg.event.trim().length === 0) {
              replyErr('Missing non-empty "event" string.');
              return;
            }
            await triggerEmit({
              slug,
              mode,
              event: msg.event,
              data: msg.data === undefined ? null : msg.data,
              source: "ui",
            });
            replyOk();
            return;
          }

          if (msg.op === "watch") {
            if (!entry || entry.error || !entry.id) {
              replyErr(`Blueprint "${slug}" (${mode}) is not available.`);
              return;
            }
            const validated = validateWatchQuery(msg.query);
            const dbPath = getMainDbPath(entry.id, mode, resolvedDataDir);
            const rows = executeReadOnlyQuery({ dbPath, sql: validated.sql });
            ws.data.watches.set(validated.query, validated.sql);
            replyOk({ rows });
            return;
          }

          if (msg.op === "unwatch") {
            if (typeof msg.query === "string") {
              ws.data.watches.delete(msg.query);
            }
            replyOk();
            return;
          }

          if (msg.op === "sql") {
            if (!entry || entry.error || !entry.id) {
              replyErr(`Blueprint "${slug}" (${mode}) is not available.`);
              return;
            }
            const validatedSql = validateReadOnlySql(msg.sql, { allowPragmaTableInfo: true });
            const dbPath = getMainDbPath(entry.id, mode, resolvedDataDir);
            const rows = executeReadOnlyQuery({
              dbPath,
              sql: validatedSql,
              params: msg.params === undefined ? null : msg.params,
            });
            replyOk({ rows });
            return;
          }

          replyErr(`Unsupported WebSocket op "${String(msg.op)}".`);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          appendLog(slug, mode, {
            type: "ws:error",
            level: "error",
            op: msg.op,
            message: `WS op "${String(msg.op)}" failed: ${errMessage}`,
          });
          replyErr(errMessage);
        }
      },
    },
  });

  const actualPort = server.port;
  const baseUrl = buildDaemonBaseUrl(bind, actualPort);

  if (writeFiles) {
    fs.mkdirSync(resolvedDataDir, { recursive: true });
    const daemonInfo = {
      pid: process.pid,
      bind,
      port: actualPort,
      dir: resolvedDir,
      startedAt,
    };
    fs.writeFileSync(
      getDaemonJsonPath(resolvedDataDir),
      JSON.stringify(daemonInfo, null, 2) + "\n",
      "utf8"
    );
  }

  async function shutdown({ fromHttp = false } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const entry of registry.values()) {
      stopEntryTimers(entry);
    }

    for (const clients of roomClients.values()) {
      for (const ws of clients) {
        try {
          ws.close(1001, "Daemon shutting down");
        } catch {
          // ignore
        }
      }
    }
    roomClients.clear();

    if (writeFiles) {
      removeDaemonInfo(resolvedDataDir, process.pid);
    }

    try {
      server.stop(true);
    } catch {
      // ignore
    }

    if (exitOnShutdown || fromHttp) {
      if (exitOnShutdown) {
        process.exit(0);
      }
    }
  }

  return {
    server,
    pid: process.pid,
    bind,
    port: actualPort,
    baseUrl,
    dir: resolvedDir,
    dataDir: resolvedDataDir,
    startedAt,
    registry,
    shutdown,
    reload: reloadBlueprints,
    emit: triggerEmit,
    getLogs,
    notifyWatchSubscribers,
  };
}
