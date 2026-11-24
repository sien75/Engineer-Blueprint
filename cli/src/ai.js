import fs from "node:fs";
import path from "node:path";

const TEXT_OUTPUT_KEYS = ["text", "result", "response", "content"];
const SESSION_OUTPUT_KEYS = [
  "conversation",
  "conversation_id",
  "conversationId",
  "session",
  "session_id",
  "sessionId",
];

/**
 * Check whether a value is a plain key-value object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Resolve plain-object input from `ctx.last?.output`, falling back to `ctx.event?.data`, else `{}`.
 * @param {{ last?: { output?: unknown } | null, event?: { data?: unknown } | null } | null | undefined} ctx
 * @returns {Record<string, unknown>}
 */
export function resolveObjectInput(ctx) {
  if (isPlainObject(ctx?.last?.output)) {
    return ctx.last.output;
  }
  if (isPlainObject(ctx?.event?.data)) {
    return ctx.event.data;
  }
  return {};
}

function pickFirstString(obj, keys, { requireNonEmpty = false } = {}) {
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) continue;
    const value = obj[key];
    if (typeof value !== "string") continue;
    if (requireNonEmpty && value.trim().length === 0) continue;
    return value;
  }
  return null;
}

function normalizeAiInput(node, rawInput) {
  const input = isPlainObject(rawInput) ? rawInput : {};

  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new Error(
      `Action node "${node.id}" (blueprint/ai) requires a non-empty string "prompt" in input (ctx.last.output or ctx.event.data).`
    );
  }
  const prompt = input.prompt;

  let session = null;
  if (input.session !== undefined && input.session !== null) {
    if (typeof input.session !== "string") {
      throw new Error(
        `Action node "${node.id}" (blueprint/ai) received invalid "session" (expected string, null, or undefined).`
      );
    }
    const trimmedSession = input.session.trim();
    session = trimmedSession.length > 0 ? trimmedSession : null;
  }

  let cwd = process.cwd();
  if (input.cwd !== undefined && input.cwd !== null) {
    if (typeof input.cwd !== "string") {
      throw new Error(
        `Action node "${node.id}" (blueprint/ai) received invalid "cwd" (expected string, null, or undefined).`
      );
    }
    const trimmedCwd = input.cwd.trim();
    if (trimmedCwd.length > 0) {
      cwd = path.resolve(trimmedCwd);
    }
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(
      `Action node "${node.id}" (blueprint/ai) working directory does not exist or is not a directory: ${cwd}`
    );
  }

  return { prompt, session, cwd };
}

function normalizeAiJsonOutput({ node, cli, stdout, inputSession }) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`AI CLI "${cli}" returned empty stdout on node "${node.id}" (expected JSON).`);
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `AI CLI "${cli}" returned invalid JSON on node "${node.id}": ${err.message}`
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `AI CLI "${cli}" returned non-object JSON on node "${node.id}" (expected JSON object).`
    );
  }

  if (parsed.is_error === true) {
    const errDetail =
      pickFirstString(parsed, ["error", ...TEXT_OUTPUT_KEYS], { requireNonEmpty: true }) ||
      "CLI reported is_error=true";
    throw new Error(`AI CLI "${cli}" failed on node "${node.id}": ${errDetail}`);
  }

  const text = pickFirstString(parsed, TEXT_OUTPUT_KEYS);
  if (text === null) {
    throw new Error(
      `AI CLI "${cli}" JSON output on node "${node.id}" is missing a response text field (expected one of: ${TEXT_OUTPUT_KEYS.join(", ")}).`
    );
  }

  const rawSession = pickFirstString(parsed, SESSION_OUTPUT_KEYS, { requireNonEmpty: true });
  const session = rawSession !== null ? rawSession.trim() : (inputSession ?? "");

  return { text, session };
}

async function runAgyAdapter({ node, prompt, session, cwd }) {
  const rawBin =
    typeof process.env.BP_AGY_BIN === "string" && process.env.BP_AGY_BIN.trim().length > 0
      ? process.env.BP_AGY_BIN.trim()
      : "agy";
  const bin = rawBin.includes("/") || rawBin.includes("\\") ? path.resolve(rawBin) : rawBin;

  const args = [];
  if (session) {
    args.push("-p", prompt, "--conversation", session, "--output-format", "json");
  } else {
    const rolePrompt = typeof node.rolePrompt === "string" ? node.rolePrompt.trim() : "";
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${prompt}` : prompt;
    args.push("-p", fullPrompt, "--output-format", "json");
  }

  if (node.model) {
    args.push("--model", node.model);
  }
  if (node.mode) {
    args.push("--mode", node.mode);
  }

  let proc;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new Error(`Failed to launch AI CLI "${bin}" on node "${node.id}": ${err.message}`);
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `AI CLI "agy" exited with code ${exitCode} on node "${node.id}"${detail ? `: ${detail}` : ""}`
    );
  }

  return normalizeAiJsonOutput({
    node,
    cli: "agy",
    stdout,
    inputSession: session,
  });
}

const AI_ADAPTERS = {
  agy: runAgyAdapter,
};

/**
 * Execute a `<script type="blueprint/ai">` action node via its configured CLI adapter.
 * @param {{ node: object, input?: unknown, ctx?: object }} options
 * @returns {Promise<{ text: string, session: string }>}
 */
export async function runAiActionNode({ node, input, ctx }) {
  const cli = typeof node?.cli === "string" ? node.cli.trim().toLowerCase() : "";
  const adapter = Object.hasOwn(AI_ADAPTERS, cli) ? AI_ADAPTERS[cli] : null;
  if (!adapter) {
    throw new Error(
      `Unsupported AI CLI adapter "${node?.cli ?? ""}" on action node "${node?.id ?? ""}". Supported adapters: ${Object.keys(AI_ADAPTERS).join(", ")}.`
    );
  }

  const rawInput = input !== undefined ? input : resolveObjectInput(ctx);
  const normalized = normalizeAiInput(node, rawInput);
  return adapter({ node, ...normalized });
}
