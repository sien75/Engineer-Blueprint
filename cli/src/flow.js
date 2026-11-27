import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveObjectInput, runAiActionNode } from "./ai.js";
import { resolveDataDir, runSqlActionNode, syncBlueprint } from "./db.js";
import { parseBlueprintFile } from "./parse.js";
import { isReadOnlySqlScript } from "./sql.js";

export const DEFAULT_MAX_STEPS = 16;
export const DECISION_PREVIEW_MAX_LEN = 500;
export const DEFAULT_JEV_MODEL = "jev-1.14";
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1";

let jsTempCounter = 0;
let shTempCounter = 0;

/**
 * Truncate a string to at most `maxLen` characters.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateText(str, maxLen = DECISION_PREVIEW_MAX_LEN) {
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Format an arbitrary step output or error value into a bounded preview string.
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
export function formatDecisionPreview(value, maxLen = DECISION_PREVIEW_MAX_LEN) {
  if (typeof value === "string") {
    return truncateText(value, maxLen);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized === undefined) {
    serialized = "null";
  }
  return truncateText(serialized, maxLen);
}

function serializeEventDataPreview(data, maxLen = DECISION_PREVIEW_MAX_LEN) {
  let serialized;
  try {
    serialized = JSON.stringify(data) ?? "null";
  } catch {
    serialized = String(data);
  }
  return truncateText(serialized, maxLen);
}

/**
 * Build the decision input and TypeSafe System One payload sent to the Jev decider.
 */
export function buildDecisionInput({ step, flow, ctx, nodes, choices, jevModel, jevUrl }) {
  const eventDataPreview = serializeEventDataPreview(ctx.event.data, DECISION_PREVIEW_MAX_LEN);

  const historySummaries = ctx.history.map((entry) => {
    const preview = entry.ok
      ? formatDecisionPreview(entry.output, DECISION_PREVIEW_MAX_LEN)
      : truncateText(String(entry.error ?? "Unknown error"), DECISION_PREVIEW_MAX_LEN);
    return {
      step: entry.step,
      node: entry.node,
      ok: entry.ok,
      preview,
    };
  });

  const progressText =
    historySummaries.length === 0
      ? "(none yet)"
      : historySummaries
          .map((h) => `#${h.step} ${h.node} [${h.ok ? "ok" : "error"}]: ${h.preview}`)
          .join("\n");

  const choiceLines = [
    ...nodes.map((n) => (n.desc ? `- ${n.id}: ${n.desc}` : `- ${n.id}`)),
    "- done: Flow is complete, stop",
    "- last (yes/no): Whether to end the flow immediately after executing the chosen node regardless of its result",
  ].join("\n");

  const state = [
    "## Flow Instructions",
    flow.prompt,
    "",
    "## Trigger Event",
    `type: ${ctx.event.type}`,
    `data: ${eventDataPreview}`,
    "",
    "## Execution Progress",
    progressText,
  ].join("\n");

  const userPrompt = [state, "", "## Available Choices", choiceLines].join("\n");

  const criteria = {};
  for (const node of nodes) {
    const desc = typeof node.desc === "string" ? node.desc.trim() : "";
    criteria[node.id] = desc || `Execute ${node.type} node "${node.id}"`;
  }
  criteria.done = "Flow is complete, stop";

  const questions = {
    next: {
      type: "choice",
      instructions:
        'Choose the single next action node ID to execute based on the flow instructions, trigger event, and execution progress, or choose "done" when the flow is complete. Use "done" only when the flow is already complete.',
      criteria,
    },
    last: {
      type: "choice",
      instructions:
        'Answer "yes" if, according to the flow instructions, the flow should end right after executing the chosen node regardless of its result (so no further decision is needed); answer "no" if what happens next depends on that node\'s result, or if "done" was chosen.',
      criteria: {
        yes: "End the flow immediately after executing the chosen node",
        no: "Decide again after seeing the chosen node's result",
      },
    },
  };

  return {
    step,
    flow,
    event: {
      type: ctx.event.type,
      dataPreview: eventDataPreview,
    },
    history: historySummaries,
    choices,
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, desc: n.desc })),
    prompt: userPrompt,
    state,
    questions,
    jevModel,
    jevUrl,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackEndpoint(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function ensureLoopbackNoProxy(endpoint) {
  try {
    if (!isLoopbackEndpoint(endpoint)) return;
    const existing = [process.env.NO_PROXY, process.env.no_proxy]
      .filter(Boolean)
      .join(",")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [...new Set([...existing, "127.0.0.1", "localhost", "::1"])].join(",");
    process.env.NO_PROXY = merged;
    process.env.no_proxy = merged;
  } catch {
    // ignore malformed URL; fetch will throw a descriptive error
  }
}

export function resolveJevApiKey(jevApiKey) {
  const candidates = [
    jevApiKey,
    process.env.BP_JEV_API_KEY,
    process.env.JEV_API_KEY,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

/**
 * Create the default Jev (`/systemone`) step router.
 */
export function createJevDecider({
  jevModel = DEFAULT_JEV_MODEL,
  jevUrl = DEFAULT_JEV_URL,
  jevApiKey,
} = {}) {
  const baseUrl = jevUrl.replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/systemone") ? baseUrl : `${baseUrl}/systemone`;
  ensureLoopbackNoProxy(endpoint);

  return async (decisionInput) => {
    const resolvedApiKey = resolveJevApiKey(jevApiKey);
    if (!resolvedApiKey && !isLoopbackEndpoint(endpoint)) {
      throw new Error(
        `Missing API key for Jev at ${endpoint}. Set BP_JEV_API_KEY (or --jev-key).`
      );
    }

    const headers = { "Content-Type": "application/json" };
    if (resolvedApiKey) {
      headers.Authorization = `Bearer ${resolvedApiKey}`;
    }

    const body = {
      model: jevModel,
      state: decisionInput.state,
      questions: decisionInput.questions,
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Failed to connect to Jev at ${endpoint}: ${err.message}. Check --jev-url / BP_JEV_URL and network connectivity.`
      );
    }

    if (!response.ok) {
      const errBody = truncateText((await response.text().catch(() => "")).trim(), 300);
      throw new Error(
        `Jev API error (HTTP ${response.status} ${response.statusText}) for model "${jevModel}" at ${endpoint}${errBody ? `: ${errBody}` : ""}.`
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new Error(`Invalid JSON response from Jev at ${endpoint}: ${err.message}`);
    }

    const answer = payload?.answers?.next;
    const next = typeof answer === "string" ? answer : answer?.choice;
    if (typeof next !== "string" || next.trim().length === 0) {
      throw new Error(
        `Invalid Jev response from ${endpoint}: missing answers.next.choice.`
      );
    }

    if (!decisionInput.choices.includes(next)) {
      throw new Error(
        `Jev model "${jevModel}" selected invalid choice ${JSON.stringify(next)}; expected one of [${decisionInput.choices.join(", ")}].`
      );
    }

    const lastAnswer = payload?.answers?.last;
    const lastChoice = typeof lastAnswer === "string" ? lastAnswer : lastAnswer?.choice;
    const last = lastChoice === "yes";

    return { next, last };
  };
}

async function executeJsNode(node, ctx) {
  const unique = `${process.pid}-${Date.now()}-${++jsTempCounter}-${crypto.randomUUID()}`;
  const realTmpDir = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmpDir, "bp-js-"));
  const tmpFile = path.join(tmpDir, `node-${unique}.mjs`);
  fs.writeFileSync(tmpFile, node.code, "utf8");

  try {
    const mod = await import(pathToFileURL(tmpFile).href);
    const fn =
      typeof mod.default === "function"
        ? mod.default
        : typeof mod.run === "function"
          ? mod.run
          : null;
    if (!fn) {
      throw new Error(
        `Action node "${node.id}" (blueprint/js) must export a default function (or named "run" function).`
      );
    }
    const output = await fn(structuredClone(ctx));
    return output === undefined ? null : output;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function executeShNode(node, ctx) {
  const unique = `${process.pid}-${Date.now()}-${++shTempCounter}-${crypto.randomUUID()}`;
  const realTmpDir = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmpDir, "bp-sh-"));
  const tmpFile = path.join(tmpDir, `node-${unique}.sh`);
  fs.writeFileSync(tmpFile, node.code, "utf8");

  try {
    const stdinBytes = new TextEncoder().encode(JSON.stringify(ctx));
    const proc = Bun.spawn(["sh", tmpFile], {
      stdin: stdinBytes,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `sh exited with code ${exitCode}`);
    }

    const trimmed = stdout.trim();
    if (trimmed.length > 0) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return { text: trimmed };
      }
    }
    return { text: "" };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function executeActionNode({ node, ctx, dbPath, emittedEvents }) {
  if (node.type === "blueprint/js") {
    return executeJsNode(node, ctx);
  }
  if (node.type === "blueprint/sh") {
    return executeShNode(node, ctx);
  }
  if (node.type === "blueprint/sql") {
    const paramsSource = resolveObjectInput(ctx);
    return runSqlActionNode({
      dbPath,
      statement: node.code,
      paramsSource,
    });
  }
  if (node.type === "blueprint/ai") {
    const input = resolveObjectInput(ctx);
    return runAiActionNode({
      node,
      input,
    });
  }
  if (node.type === "blueprint/emit") {
    const data = structuredClone(ctx.last?.output ?? ctx.event?.data ?? null);
    emittedEvents.push({ event: node.event, data });
    return { emitted: node.event, data };
  }
  throw new Error(`Unsupported action node type "${node.type}" on node "${node.id}".`);
}

function findMatchingFlows(parsed, { init, eventType }) {
  const matched = parsed.flows.filter((flow) =>
    init
      ? flow.triggerType === "init"
      : flow.triggerType === "on" && flow.triggerValue === eventType
  );

  if (matched.length > 0) {
    return matched;
  }

  const hasEvery = parsed.flows.some((f) => f.triggerType === "every");
  const availableOn = [
    ...new Set(parsed.flows.filter((f) => f.triggerType === "on").map((f) => f.triggerValue)),
  ];
  const hasInit = parsed.flows.some((f) => f.triggerType === "init");

  const hints = [];
  if (availableOn.length > 0) {
    hints.push(`available "on" events: ${availableOn.join(", ")}`);
  }
  if (hasInit) {
    hints.push('an "init" flow is declared');
  }
  if (hasEvery) {
    hints.push('scheduled "every" flows exist, but scheduled daemon execution is not implemented yet');
  }
  const suffix = hints.length > 0 ? ` (${hints.join("; ")})` : "";

  if (init) {
    throw new Error(`No <script type="blueprint/flow" init> flow found in "${parsed.filePath}"${suffix}.`);
  }
  throw new Error(
    `No <script type="blueprint/flow" on="${eventType}"> flow found in "${parsed.filePath}"${suffix}.`
  );
}

/**
 * Execute a prepared list of flow blocks against an already-synced blueprint database.
 * @param {{
 *   parsed: { id: string, nodes: Array<object>, nodesById: Record<string, object> },
 *   flows: Array<object>,
 *   eventType: string,
 *   eventData?: unknown,
 *   dbPath: string,
 *   mode: string,
 *   maxSteps?: number,
 *   jevModel?: string,
 *   jevUrl?: string,
 *   jevApiKey?: string,
 *   decide?: (decisionInput: object) => Promise<string | { next: string }> | string | { next: string },
 *   hooks?: {
 *     onFlowStart?: (info: object) => Promise<void> | void,
 *     onStep?: (info: object) => Promise<void> | void,
 *     onEmit?: (info: object) => Promise<void> | void,
 *     onFlowEnd?: (info: object) => Promise<void> | void,
 *     onFlowError?: (info: object) => Promise<void> | void,
 *   }
 * }} options
 */
export async function executeFlows({
  parsed,
  flows,
  eventType,
  eventData = null,
  dbPath,
  mode,
  maxSteps = DEFAULT_MAX_STEPS,
  jevModel,
  jevUrl,
  jevApiKey,
  decide,
  hooks = {},
}) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`Invalid maxSteps "${maxSteps}": must be a positive integer.`);
  }

  const resolvedJevModel =
    (typeof jevModel === "string" && jevModel.trim()) ||
    process.env.BP_JEV_MODEL ||
    DEFAULT_JEV_MODEL;
  const resolvedJevUrl = (
    (typeof jevUrl === "string" && jevUrl.trim()) ||
    process.env.BP_JEV_URL ||
    DEFAULT_JEV_URL
  ).replace(/\/+$/, "");

  const choices = [...parsed.nodes.map((n) => n.id), "done"];
  const decideFn =
    typeof decide === "function"
      ? decide
      : createJevDecider({ jevModel: resolvedJevModel, jevUrl: resolvedJevUrl, jevApiKey });

  const normalizedData = eventData === undefined ? null : eventData;
  const flowResults = [];
  const allSteps = [];
  const allEmittedEvents = [];

  for (const flow of flows) {
    const ctx = {
      event: { type: eventType, data: structuredClone(normalizedData) },
      last: null,
      steps: {},
      history: [],
    };
    const emittedEvents = [];
    let completed = false;

    await hooks.onFlowStart?.({ flow, eventType, eventData: normalizedData });

    try {
      for (let step = 1; step <= maxSteps; step++) {
        const decisionInput = buildDecisionInput({
          step,
          flow,
          ctx,
          nodes: parsed.nodes,
          choices,
          jevModel: resolvedJevModel,
          jevUrl: resolvedJevUrl,
        });

        const rawChoice = await decideFn(decisionInput);
        const nextChoice = typeof rawChoice === "string" ? rawChoice : rawChoice?.next;
        const lastFlag = typeof rawChoice === "object" && rawChoice !== null && rawChoice.last === true;
        if (typeof nextChoice !== "string" || !choices.includes(nextChoice)) {
          throw new Error(
            `Invalid decision "${String(nextChoice)}" at step ${step}: expected one of [${choices.join(", ")}].`
          );
        }

        if (nextChoice === "done") {
          completed = true;
          break;
        }

        const node = parsed.nodesById[nextChoice];
        const emitCountBefore = emittedEvents.length;
        let stepRecord;
        try {
          const output = await executeActionNode({
            node,
            ctx,
            dbPath,
            emittedEvents,
          });
          stepRecord = { node: node.id, ok: true, output, error: null };
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          stepRecord = { node: node.id, ok: false, output: null, error: errMessage };
        }

        ctx.last = stepRecord;
        ctx.steps[node.id] = {
          ok: stepRecord.ok,
          output: stepRecord.output,
          error: stepRecord.error,
        };
        const historyEntry = { step, ...stepRecord };
        ctx.history.push(historyEntry);
        allSteps.push(historyEntry);

        const sqlWrite =
          node.type === "blueprint/sql" && stepRecord.ok && !isReadOnlySqlScript(node.code);
        await hooks.onStep?.({ flow, ...historyEntry, nodeType: node.type, sqlWrite });

        for (let idx = emitCountBefore; idx < emittedEvents.length; idx++) {
          const ev = emittedEvents[idx];
          await hooks.onEmit?.({ flow, event: ev.event, data: ev.data });
        }

        if (lastFlag) {
          completed = true;
          break;
        }
      }

      if (!completed) {
        const trail = ctx.history
          .map((h) => `#${h.step} ${h.node} [${h.ok ? "ok" : "error"}]`)
          .join(", ");
        const label =
          flow.triggerType === "init"
            ? "init"
            : flow.triggerType === "every"
              ? `every="${flow.triggerValue}"`
              : `on="${flow.triggerValue}"`;
        throw new Error(
          `Flow (${label}) did not reach "done" within maxSteps (${maxSteps}). Executed steps: ${trail || "(none)"}.`
        );
      }

      allEmittedEvents.push(...emittedEvents);
      flowResults.push({
        triggerType: flow.triggerType,
        triggerValue: flow.triggerValue,
        steps: ctx.history,
        emittedEvents,
        ctx,
      });

      await hooks.onFlowEnd?.({ flow, steps: ctx.history, emittedEvents });
    } catch (err) {
      await hooks.onFlowError?.({ flow, error: err });
      throw err;
    }
  }

  return {
    id: parsed.id,
    mode,
    dbPath,
    event: { type: eventType, data: normalizedData },
    flows: flowResults,
    steps: allSteps,
    emittedEvents: allEmittedEvents,
    ctx: flowResults.length > 0 ? flowResults[flowResults.length - 1].ctx : null,
  };
}

/**
 * Execute matching `<script type="blueprint/flow">` block(s) in a blueprint `.html` file.
 * Automatically reconciles `<script type="blueprint/def">` against `<data>/<id>/<mode>/db.sqlite` first.
 * @param {{
 *   filePath: string,
 *   event?: string,
 *   data?: unknown,
 *   init?: boolean,
 *   dev?: boolean,
 *   dataDir?: string,
 *   maxSteps?: number,
 *   jevModel?: string,
 *   jevUrl?: string,
 *   jevApiKey?: string,
 *   decide?: (decisionInput: object) => Promise<string | { next: string }> | string | { next: string }
 * }} options
 */
export async function runBlueprintFlow({
  filePath,
  event,
  data = null,
  init = false,
  dev = false,
  dataDir,
  maxSteps = DEFAULT_MAX_STEPS,
  jevModel,
  jevUrl,
  jevApiKey,
  decide,
}) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`Invalid maxSteps "${maxSteps}": must be a positive integer.`);
  }
  if (init && typeof event === "string" && event.trim().length > 0) {
    throw new Error('Cannot specify both an event name and "init: true".');
  }
  if (!init && (typeof event !== "string" || event.trim().length === 0)) {
    throw new Error("Missing trigger event name (or set init: true).");
  }

  const parsed = parseBlueprintFile(filePath);
  const eventType = init ? "init" : event.trim();
  const matchedFlows = findMatchingFlows(parsed, { init, eventType });

  const resolvedDataDir = resolveDataDir(dataDir);
  const syncResult = syncBlueprint({
    filePath: parsed.filePath,
    dev,
    dataDir: resolvedDataDir,
  });

  return executeFlows({
    parsed,
    flows: matchedFlows,
    eventType,
    eventData: data === undefined ? null : data,
    dbPath: syncResult.dbPath,
    mode: syncResult.mode,
    maxSteps,
    jevModel,
    jevUrl,
    jevApiKey,
    decide,
  });
}
