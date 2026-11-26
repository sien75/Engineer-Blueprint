import fs from "node:fs";
import path from "node:path";

export const BLUEPRINT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACTION_NODE_TYPES = new Set([
  "blueprint/js",
  "blueprint/sh",
  "blueprint/sql",
  "blueprint/emit",
  "blueprint/ai",
]);
const SUPPORTED_AI_PROTOCOLS = new Set(["acp"]);

/**
 * Validate a blueprint ID against the spec pattern.
 * @param {string} id
 * @returns {string}
 */
export function validateBlueprintId(id) {
  if (typeof id !== "string" || !BLUEPRINT_ID_RE.test(id)) {
    throw new Error(
      `Invalid blueprint ID "${id}". Expected 1-64 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.`
    );
  }
  return id;
}

function unescapeScriptBody(rawBody) {
  return rawBody.replace(/<\\\/script>/gi, "</script>");
}

function parseFlowBlock(attrs, rawBody) {
  const hasOn = Object.hasOwn(attrs, "on");
  const hasEvery = Object.hasOwn(attrs, "every");
  const hasInit = Object.hasOwn(attrs, "init");
  const triggerCount = (hasOn ? 1 : 0) + (hasEvery ? 1 : 0) + (hasInit ? 1 : 0);

  if (triggerCount === 0) {
    throw new Error(
      'Flow <script type="blueprint/flow"> must declare exactly one trigger attribute: on="...", every="...", or init.'
    );
  }
  if (triggerCount > 1) {
    throw new Error(
      'Flow <script type="blueprint/flow"> must declare only one trigger attribute among on, every, and init.'
    );
  }

  let triggerType;
  let triggerValue;
  if (hasOn) {
    const val = attrs.on.trim();
    if (!val) {
      throw new Error('Flow <script type="blueprint/flow"> has an empty "on" trigger attribute.');
    }
    triggerType = "on";
    triggerValue = val;
  } else if (hasEvery) {
    const val = attrs.every.trim();
    if (!val) {
      throw new Error('Flow <script type="blueprint/flow"> has an empty "every" trigger attribute.');
    }
    triggerType = "every";
    triggerValue = val;
  } else {
    const initVal = attrs.init.trim().toLowerCase();
    if (initVal !== "" && initVal !== "init" && initVal !== "true") {
      throw new Error(
        `Invalid "init" attribute value "${attrs.init}" on <script type="blueprint/flow">; use boolean "init".`
      );
    }
    triggerType = "init";
    triggerValue = true;
  }

  const prompt = unescapeScriptBody(rawBody).trim();
  if (!prompt) {
    throw new Error('Flow <script type="blueprint/flow"> cannot have an empty body.');
  }

  return { triggerType, triggerValue, prompt };
}

function parseActionNode(scriptType, attrs, rawBody, seenNodeIds) {
  const rawId = Object.hasOwn(attrs, "id") ? attrs.id.trim() : "";
  if (!rawId) {
    throw new Error(`Action node <script type="${scriptType}"> requires a non-empty "id" attribute.`);
  }
  validateBlueprintId(rawId);
  if (rawId === "done") {
    throw new Error('Action node id "done" is reserved for flow completion.');
  }
  if (seenNodeIds.has(rawId)) {
    throw new Error(`Duplicate action node id "${rawId}".`);
  }
  seenNodeIds.add(rawId);

  const desc = typeof attrs.desc === "string" && attrs.desc.trim().length > 0 ? attrs.desc.trim() : null;
  const code = unescapeScriptBody(rawBody);

  if (scriptType === "blueprint/emit") {
    const event = Object.hasOwn(attrs, "event") ? attrs.event.trim() : "";
    if (!event) {
      throw new Error(
        `Action node <script type="blueprint/emit" id="${rawId}"> requires a non-empty "event" attribute.`
      );
    }
    return {
      id: rawId,
      type: scriptType,
      kind: "emit",
      desc,
      code,
      event,
    };
  }

  if (scriptType === "blueprint/ai") {
    const rawProtocol = Object.hasOwn(attrs, "protocol") ? attrs.protocol.trim() : "";
    const protocol = rawProtocol ? rawProtocol.toLowerCase() : "acp";
    if (!SUPPORTED_AI_PROTOCOLS.has(protocol)) {
      throw new Error(
        `Unsupported protocol "${rawProtocol}" on action node <script type="blueprint/ai" id="${rawId}">. Supported protocols: ${[...SUPPORTED_AI_PROTOCOLS].join(", ")}.`
      );
    }

    const cli = Object.hasOwn(attrs, "cli") ? attrs.cli.trim() : "";
    if (!cli) {
      throw new Error(
        `Action node <script type="blueprint/ai" id="${rawId}"> requires a non-empty "cli" attribute.`
      );
    }

    const model =
      typeof attrs.model === "string" && attrs.model.trim().length > 0 ? attrs.model.trim() : null;
    const mode =
      typeof attrs.mode === "string" && attrs.mode.trim().length > 0 ? attrs.mode.trim() : null;
    const rolePrompt = code.trim();

    return {
      id: rawId,
      type: scriptType,
      kind: "ai",
      desc,
      protocol,
      cli,
      model,
      mode,
      rolePrompt,
    };
  }

  return {
    id: rawId,
    type: scriptType,
    kind: scriptType.slice("blueprint/".length),
    desc,
    code,
  };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseAttributes(attrText) {
  const attrs = {};
  let i = 0;
  const len = attrText.length;

  while (i < len) {
    while (i < len && /\s/.test(attrText[i])) i++;
    if (i >= len || attrText[i] === "/") {
      i++;
      continue;
    }

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrText[i])) i++;
    const name = attrText.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }

    while (i < len && /\s/.test(attrText[i])) i++;
    if (attrText[i] !== "=") {
      attrs[name] = "";
      continue;
    }
    i++; // skip '='
    while (i < len && /\s/.test(attrText[i])) i++;

    let value = "";
    const quote = attrText[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valStart = i;
      while (i < len && attrText[i] !== quote) i++;
      value = decodeHtmlEntities(attrText.slice(valStart, i));
      if (i < len && attrText[i] === quote) i++;
    } else {
      const valStart = i;
      while (i < len && !/[\s>]/.test(attrText[i])) i++;
      value = decodeHtmlEntities(attrText.slice(valStart, i));
    }

    attrs[name] = value;
  }

  return attrs;
}

function findTagEnd(html, start) {
  let i = start;
  let quote = null;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        return i;
      }
    }
    i++;
  }
  return -1;
}

function matchTagPrefix(html, index, tagName) {
  if (html[index] !== "<") return false;
  const after = html.slice(index + 1, index + 1 + tagName.length);
  if (after.toLowerCase() !== tagName) return false;
  const boundary = html[index + 1 + tagName.length];
  return boundary === undefined || /[\s/>]/.test(boundary);
}

/**
 * Parse blueprint identity, `<script type="blueprint/def">`, `<script type="blueprint/flow">`,
 * and backend action node blocks (`blueprint/js`, `blueprint/sh`, `blueprint/sql`, `blueprint/emit`, `blueprint/ai`) from HTML.
 * @param {string} html
 * @returns {{ id: string, sqlBlocks: string[], sql: string, flows: Array<object>, nodes: Array<object>, nodesById: Record<string, object> }}
 */
export function parseBlueprintHtml(html) {
  if (typeof html !== "string") {
    throw new Error("Blueprint HTML input must be a string.");
  }

  const bpIdValues = [];
  const metaIdValues = [];
  const sqlBlocks = [];
  const flows = [];
  const nodes = [];
  const nodesById = {};
  const seenNodeIds = new Set();

  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const commentEnd = html.indexOf("-->", lt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }

    if (matchTagPrefix(html, lt, "script")) {
      const tagEnd = findTagEnd(html, lt + 7);
      if (tagEnd === -1) {
        throw new Error("Malformed <script> opening tag in blueprint HTML.");
      }
      const attrText = html.slice(lt + 7, tagEnd);
      const attrs = parseAttributes(attrText);
      const bodyStart = tagEnd + 1;

      const closeMatch = /<\/script\s*>/i.exec(html.slice(bodyStart));
      if (!closeMatch) {
        throw new Error("Unclosed <script> tag in blueprint HTML.");
      }

      const bodyEnd = bodyStart + closeMatch.index;
      const scriptType = (attrs.type ?? "").trim().toLowerCase();
      const rawBody = html.slice(bodyStart, bodyEnd);

      if (scriptType === "blueprint/def") {
        const unescaped = unescapeScriptBody(rawBody);
        if (unescaped.trim().length > 0) {
          sqlBlocks.push(unescaped);
        }
      } else if (scriptType === "blueprint/flow") {
        flows.push(parseFlowBlock(attrs, rawBody));
      } else if (ACTION_NODE_TYPES.has(scriptType)) {
        const node = parseActionNode(scriptType, attrs, rawBody, seenNodeIds);
        nodes.push(node);
        nodesById[node.id] = node;
      }

      i = bodyEnd + closeMatch[0].length;
      continue;
    }

    if (matchTagPrefix(html, lt, "style")) {
      const tagEnd = findTagEnd(html, lt + 6);
      if (tagEnd === -1) break;
      const closeMatch = /<\/style\s*>/i.exec(html.slice(tagEnd + 1));
      i = closeMatch ? tagEnd + 1 + closeMatch.index + closeMatch[0].length : len;
      continue;
    }

    if (matchTagPrefix(html, lt, "meta")) {
      const tagEnd = findTagEnd(html, lt + 5);
      if (tagEnd === -1) {
        throw new Error("Malformed <meta> tag in blueprint HTML.");
      }
      const attrText = html.slice(lt + 5, tagEnd);
      const attrs = parseAttributes(attrText);

      if ((attrs.name ?? "").trim().toLowerCase() === "bp:id") {
        bpIdValues.push(attrs.content ?? "");
      } else if ("id" in attrs) {
        metaIdValues.push(attrs.id ?? "");
      }

      i = tagEnd + 1;
      continue;
    }

    i = lt + 1;
  }

  let selectedId = null;
  if (bpIdValues.length > 0) {
    const unique = [...new Set(bpIdValues)];
    if (unique.length > 1) {
      throw new Error(`Conflicting <meta name="bp:id"> declarations: ${unique.join(", ")}`);
    }
    selectedId = unique[0];
  } else if (metaIdValues.length > 0) {
    const unique = [...new Set(metaIdValues)];
    if (unique.length > 1) {
      throw new Error(`Conflicting <meta id="..."> declarations: ${unique.join(", ")}`);
    }
    selectedId = unique[0];
  } else {
    throw new Error(
      'Missing blueprint ID: declare <meta name="bp:id" content="..."> or <meta id="..."> in the HTML.'
    );
  }

  const id = validateBlueprintId(selectedId);
  return {
    id,
    sqlBlocks,
    sql: sqlBlocks.join("\n"),
    flows,
    nodes,
    nodesById,
  };
}

/**
 * Read and parse a blueprint `.html` file.
 * @param {string} filePath
 * @returns {{ id: string, sqlBlocks: string[], sql: string, flows: Array<object>, nodes: Array<object>, nodesById: Record<string, object>, filePath: string }}
 */
export function parseBlueprintFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Blueprint file not found: ${filePath}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Expected a file path, got non-file: ${filePath}`);
  }
  const html = fs.readFileSync(resolved, "utf8");
  const parsed = parseBlueprintHtml(html);
  return { ...parsed, filePath: resolved };
}

/**
 * Resolve either a `.html` file path or a direct blueprint ID string.
 * @param {string} fileOrId
 * @returns {{ id: string, filePath: string | null }}
 */
export function resolveBlueprintId(fileOrId) {
  if (typeof fileOrId !== "string" || fileOrId.length === 0) {
    throw new Error("Missing blueprint file path or ID.");
  }

  if (fs.existsSync(fileOrId)) {
    const stat = fs.statSync(fileOrId);
    if (!stat.isFile()) {
      throw new Error(`Expected a blueprint HTML file, got non-file: ${fileOrId}`);
    }
    const parsed = parseBlueprintFile(fileOrId);
    return { id: parsed.id, filePath: parsed.filePath };
  }

  if (/\.html?$/i.test(fileOrId) || fileOrId.includes("/") || fileOrId.includes("\\")) {
    throw new Error(`Blueprint file not found: ${fileOrId}`);
  }

  return { id: validateBlueprintId(fileOrId), filePath: null };
}

/**
 * Extract the document `<title>` text from blueprint HTML, ignoring comments/scripts/styles.
 * @param {string} html
 * @returns {string | null}
 */
export function extractHtmlTitle(html) {
  if (typeof html !== "string") return null;

  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const commentEnd = html.indexOf("-->", lt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }

    if (matchTagPrefix(html, lt, "script")) {
      const tagEnd = findTagEnd(html, lt + 7);
      if (tagEnd === -1) break;
      const closeMatch = /<\/script\s*>/i.exec(html.slice(tagEnd + 1));
      i = closeMatch ? tagEnd + 1 + closeMatch.index + closeMatch[0].length : len;
      continue;
    }

    if (matchTagPrefix(html, lt, "style")) {
      const tagEnd = findTagEnd(html, lt + 6);
      if (tagEnd === -1) break;
      const closeMatch = /<\/style\s*>/i.exec(html.slice(tagEnd + 1));
      i = closeMatch ? tagEnd + 1 + closeMatch.index + closeMatch[0].length : len;
      continue;
    }

    if (matchTagPrefix(html, lt, "title")) {
      const tagEnd = findTagEnd(html, lt + 6);
      if (tagEnd === -1) break;
      const bodyStart = tagEnd + 1;
      const closeMatch = /<\/title\s*>/i.exec(html.slice(bodyStart));
      if (!closeMatch) break;
      const rawTitle = html.slice(bodyStart, bodyStart + closeMatch.index);
      const cleaned = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
      return cleaned.length > 0 ? cleaned : null;
    }

    i = lt + 1;
  }

  return null;
}

/**
 * Strip all `<script type="blueprint/...">...</script>` blocks while preserving
 * HTML comments and frontend scripts, and inject `<script src="${bpJsPath}"></script>`
 * near the top of the document so `window.bp` is ready before inline scripts run.
 * @param {string} html
 * @param {string} bpJsPath
 * @returns {string}
 */
export function renderBrowserHtml(html, bpJsPath) {
  if (typeof html !== "string") {
    throw new Error("Blueprint HTML input must be a string.");
  }

  const removeRanges = [];
  let headInsertAt = null;
  let doctypeInsertAt = null;
  let htmlInsertAt = null;
  let firstScriptAt = null;

  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const commentEnd = html.indexOf("-->", lt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }

    if (html.slice(lt, lt + 9).toLowerCase() === "<!doctype") {
      const tagEnd = findTagEnd(html, lt + 9);
      if (tagEnd !== -1 && doctypeInsertAt === null) {
        doctypeInsertAt = tagEnd + 1;
      }
      i = tagEnd === -1 ? len : tagEnd + 1;
      continue;
    }

    if (matchTagPrefix(html, lt, "html")) {
      const tagEnd = findTagEnd(html, lt + 5);
      if (tagEnd !== -1 && htmlInsertAt === null) {
        htmlInsertAt = tagEnd + 1;
      }
      i = tagEnd === -1 ? len : tagEnd + 1;
      continue;
    }

    if (matchTagPrefix(html, lt, "head")) {
      const tagEnd = findTagEnd(html, lt + 5);
      if (tagEnd !== -1 && headInsertAt === null) {
        headInsertAt = tagEnd + 1;
      }
      i = tagEnd === -1 ? len : tagEnd + 1;
      continue;
    }

    if (matchTagPrefix(html, lt, "script")) {
      const tagEnd = findTagEnd(html, lt + 7);
      if (tagEnd === -1) break;
      const attrText = html.slice(lt + 7, tagEnd);
      const attrs = parseAttributes(attrText);
      const bodyStart = tagEnd + 1;
      const closeMatch = /<\/script\s*>/i.exec(html.slice(bodyStart));
      if (!closeMatch) break;
      const endPos = bodyStart + closeMatch.index + closeMatch[0].length;
      const scriptType = (attrs.type ?? "").trim().toLowerCase();
      if (scriptType.startsWith("blueprint/")) {
        removeRanges.push([lt, endPos]);
      } else if (firstScriptAt === null) {
        firstScriptAt = lt;
      }
      i = endPos;
      continue;
    }

    if (matchTagPrefix(html, lt, "style")) {
      const tagEnd = findTagEnd(html, lt + 6);
      if (tagEnd === -1) break;
      const closeMatch = /<\/style\s*>/i.exec(html.slice(tagEnd + 1));
      i = closeMatch ? tagEnd + 1 + closeMatch.index + closeMatch[0].length : len;
      continue;
    }

    i = lt + 1;
  }

  let insertAt = 0;
  if (headInsertAt !== null && (firstScriptAt === null || headInsertAt <= firstScriptAt)) {
    insertAt = headInsertAt;
  } else if (doctypeInsertAt !== null && (firstScriptAt === null || doctypeInsertAt <= firstScriptAt)) {
    insertAt = doctypeInsertAt;
  } else if (htmlInsertAt !== null && (firstScriptAt === null || htmlInsertAt <= firstScriptAt)) {
    insertAt = htmlInsertAt;
  } else if (firstScriptAt !== null) {
    insertAt = firstScriptAt;
  }

  const injectedTag = `<script src="${escapeHtmlAttr(bpJsPath)}"></script>`;
  const chunks = [];
  let cursor = 0;
  let injected = false;

  for (const [start, end] of removeRanges) {
    if (!injected && insertAt <= start) {
      chunks.push(html.slice(cursor, insertAt), injectedTag, html.slice(insertAt, start));
      injected = true;
    } else {
      chunks.push(html.slice(cursor, start));
    }
    cursor = end;
  }

  if (!injected) {
    if (insertAt >= cursor) {
      chunks.push(html.slice(cursor, insertAt), injectedTag, html.slice(insertAt));
    } else {
      chunks.push(injectedTag, html.slice(cursor));
    }
  } else {
    chunks.push(html.slice(cursor));
  }

  return chunks.join("");
}
