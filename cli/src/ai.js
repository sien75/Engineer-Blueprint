import fs from "node:fs";
import path from "node:path";

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

function envBinOr(envName, fallback) {
  const value = process.env[envName];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function splitCommandTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let inToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        const next = command[i + 1];
        if (next === '"' || next === "\\") {
          current += next;
          i++;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    inToken = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i++;
    } else {
      current += ch;
    }
  }

  if (quote) {
    throw new Error(`Unterminated quote in AI CLI command: ${command}`);
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Resolve an ACP CLI preset name or custom command string into `[bin, ...args]`.
 * @param {string} cli
 * @returns {string[]}
 */
export function resolveAcpCommand(cli) {
  const trimmed = typeof cli === "string" ? cli.trim() : "";
  if (!trimmed) {
    throw new Error('AI node "cli" attribute must be a non-empty string.');
  }

  const presetKey = trimmed.toLowerCase();
  let cmd;
  switch (presetKey) {
    case "agy":
      cmd = [envBinOr("BP_AGY_BIN", "agy"), "acp"];
      break;
    case "opencode":
      cmd = [envBinOr("BP_OPENCODE_BIN", "opencode"), "acp"];
      break;
    case "dsh":
      cmd = [envBinOr("BP_DSH_BIN", "dsh"), "acp"];
      break;
    case "claude":
      cmd = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"];
      break;
    case "codex":
      cmd = ["npx", "-y", "@zed-industries/codex-acp"];
      break;
    default: {
      const tokens = splitCommandTokens(trimmed);
      if (tokens.length === 0) {
        throw new Error('AI node "cli" attribute must be a non-empty command.');
      }
      cmd = tokens;
      break;
    }
  }

  const [bin, ...args] = cmd;
  const resolvedBin = bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin;
  return [resolvedBin, ...args];
}

function makeRpcError(method, nodeId, errorObj) {
  const code = errorObj?.code ?? "unknown";
  const message =
    typeof errorObj?.message === "string" ? errorObj.message : JSON.stringify(errorObj);
  const err = new Error(`ACP error (${code}) on "${method}" for node "${nodeId}": ${message}`);
  err.rpcCode = errorObj?.code;
  err.rpcData = errorObj?.data;
  return err;
}

function selectPermissionOutcome(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const preferred =
    options.find((opt) => opt?.kind === "allow_once" || opt?.kind === "allow_always") ??
    options[0];
  if (preferred && typeof preferred.optionId === "string" && preferred.optionId.length > 0) {
    return { outcome: { outcome: "selected", optionId: preferred.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

async function runAcpAdapter({ node, prompt, session, cwd }) {
  const cmd = resolveAcpCommand(node.cli);
  const [bin] = cmd;

  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new Error(`Failed to launch ACP CLI "${bin}" on node "${node.id}": ${err.message}`);
  }

  const pending = new Map();
  let nextId = 1;
  let collectingPromptOutput = false;
  let textChunks = [];
  let processExited = false;
  let exitCode = null;
  let fatalError = null;

  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const exitPromise = proc.exited.then((code) => {
    processExited = true;
    exitCode = code;
    return code;
  });

  function sendJsonRpc(payload) {
    if (processExited) {
      throw new Error(`Cannot send to ACP CLI "${node.cli}" after process exited.`);
    }
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    proc.stdin.flush?.();
  }

  function rejectAllPending(err) {
    if (!fatalError) fatalError = err;
    for (const [, entry] of pending) {
      entry.reject(err);
    }
    pending.clear();
  }

  function rpcCall(method, params) {
    if (fatalError) {
      return Promise.reject(fatalError);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      try {
        sendJsonRpc({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  async function rpcCallWithConfigFallback(primaryMethod, primaryParams, fallbackParams) {
    try {
      return await rpcCall(primaryMethod, primaryParams);
    } catch (err) {
      if (err?.rpcCode === -32601) {
        return await rpcCall("session/set_config_option", fallbackParams);
      }
      throw err;
    }
  }

  function handleMessage(msg) {
    if (!isPlainObject(msg)) return;

    const hasId = Object.hasOwn(msg, "id") && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === "string";

    if (hasId && !hasMethod) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) {
        entry.reject(makeRpcError(entry.method, node.id, msg.error));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (hasId && hasMethod) {
      if (msg.method === "session/request_permission") {
        try {
          sendJsonRpc({
            jsonrpc: "2.0",
            id: msg.id,
            result: selectPermissionOutcome(msg.params),
          });
        } catch {
          // Process already exited; pending requests will reject.
        }
      } else {
        try {
          sendJsonRpc({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
          });
        } catch {
          // Process already exited.
        }
      }
      return;
    }

    if (!hasId && hasMethod && msg.method === "session/update") {
      if (!collectingPromptOutput) return;
      const update = msg.params?.update;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        textChunks.push(update.content.text);
      }
    }
  }

  const stdoutReaderTask = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (err) {
            rejectAllPending(
              new Error(
                `ACP CLI "${node.cli}" returned invalid JSON on node "${node.id}": ${err.message}`
              )
            );
            return;
          }
          handleMessage(parsed);
        }
      }

      const trailing = (buffer + decoder.decode()).trim();
      if (trailing) {
        let parsed;
        try {
          parsed = JSON.parse(trailing);
        } catch (err) {
          rejectAllPending(
            new Error(
              `ACP CLI "${node.cli}" returned invalid JSON on node "${node.id}": ${err.message}`
            )
          );
          return;
        }
        handleMessage(parsed);
      }
    } catch (err) {
      rejectAllPending(
        new Error(`Failed reading ACP stdout from "${node.cli}" on node "${node.id}": ${err.message}`)
      );
      return;
    }

    if (pending.size > 0) {
      const code = await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(exitCode), 200)),
      ]);
      const stderr = (await Promise.race([
        stderrPromise,
        new Promise((resolve) => setTimeout(() => resolve(""), 200)),
      ])).trim();
      const codePart = code !== null ? `exited with code ${code}` : "closed stdout unexpectedly";
      rejectAllPending(
        new Error(
          `ACP CLI "${node.cli}" ${codePart} on node "${node.id}"${stderr ? `: ${stderr}` : ""}`
        )
      );
    }
  })();

  exitPromise.then(async (code) => {
    if (pending.size > 0) {
      const stderr = (await stderrPromise).trim();
      rejectAllPending(
        new Error(
          `ACP CLI "${node.cli}" exited with code ${code} on node "${node.id}"${stderr ? `: ${stderr}` : ""}`
        )
      );
    }
  });

  try {
    await rpcCall("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "engineer-blueprint", version: "0.1.0" },
    });

    let sessionId;
    let fullPrompt;

    if (!session) {
      const newRes = await rpcCall("session/new", { cwd, mcpServers: [] });
      sessionId = typeof newRes?.sessionId === "string" ? newRes.sessionId.trim() : "";
      if (!sessionId) {
        throw new Error(
          `ACP CLI "${node.cli}" session/new response on node "${node.id}" is missing a valid sessionId.`
        );
      }
      const rolePrompt = typeof node.rolePrompt === "string" ? node.rolePrompt.trim() : "";
      fullPrompt = rolePrompt ? `${rolePrompt}\n\n${prompt}` : prompt;
    } else {
      collectingPromptOutput = false;
      let loadRes;
      try {
        loadRes = await rpcCall("session/load", { sessionId: session, cwd, mcpServers: [] });
      } catch (err) {
        if (err?.rpcCode === -32601) {
          loadRes = await rpcCall("session/resume", { sessionId: session, cwd, mcpServers: [] });
        } else {
          throw err;
        }
      }
      sessionId =
        typeof loadRes?.sessionId === "string" && loadRes.sessionId.trim().length > 0
          ? loadRes.sessionId.trim()
          : session;
      fullPrompt = prompt;
    }

    if (node.model) {
      await rpcCallWithConfigFallback(
        "session/set_model",
        { sessionId, modelId: node.model },
        { sessionId, configId: "model", value: node.model }
      );
    }

    if (node.mode) {
      await rpcCallWithConfigFallback(
        "session/set_mode",
        { sessionId, modeId: node.mode },
        { sessionId, configId: "mode", value: node.mode }
      );
    }

    collectingPromptOutput = true;
    textChunks = [];
    let promptRes;
    try {
      promptRes = await rpcCall("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: fullPrompt }],
      });
    } finally {
      collectingPromptOutput = false;
    }

    let text = textChunks.join("");
    if (text.length === 0 && typeof promptRes?.text === "string") {
      text = promptRes.text;
    }

    return { text, session: sessionId };
  } finally {
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }

    if (!processExited) {
      const exitedGracefully = await Promise.race([
        exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 150)),
      ]);
      if (!exitedGracefully && !processExited) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        const exitedAfterTerm = await Promise.race([
          exitPromise.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        if (!exitedAfterTerm && !processExited) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          await exitPromise.catch(() => {});
        }
      }
    }

    await stdoutReaderTask.catch(() => {});
  }
}

const AI_PROTOCOLS = {
  acp: runAcpAdapter,
};

/**
 * Execute a `<script type="blueprint/ai">` action node via its configured protocol adapter (default: ACP).
 * @param {{ node: object, input?: unknown, ctx?: object }} options
 * @returns {Promise<{ text: string, session: string }>}
 */
export async function runAiActionNode({ node, input, ctx }) {
  const protocol = (node?.protocol ?? "acp").trim().toLowerCase();
  const adapter = Object.hasOwn(AI_PROTOCOLS, protocol) ? AI_PROTOCOLS[protocol] : null;
  if (!adapter) {
    throw new Error(
      `Unsupported AI protocol "${node?.protocol ?? ""}" on action node "${node?.id ?? ""}". Supported protocols: ${Object.keys(AI_PROTOCOLS).join(", ")}.`
    );
  }

  const cli = typeof node?.cli === "string" ? node.cli.trim() : "";
  if (!cli) {
    throw new Error(
      `Action node "${node?.id ?? ""}" (blueprint/ai) requires a non-empty "cli" attribute.`
    );
  }

  const rawInput = input !== undefined ? input : resolveObjectInput(ctx);
  const normalized = normalizeAiInput(node, rawInput);
  return adapter({ node, ...normalized });
}
