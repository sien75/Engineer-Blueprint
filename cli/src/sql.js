/**
 * SQL statement splitting, classification, and column definition helpers.
 */

function isWordChar(ch) {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

/**
 * Split a SQL script into top-level executable statements.
 * Respects string literals, quoted/bracketed identifiers, line/block comments,
 * and `CREATE [TEMP|TEMPORARY] TRIGGER ... BEGIN ... END;` blocks (including nested `CASE ... END`).
 * @param {string} sql
 * @returns {string[]}
 */
export function splitSqlStatements(sql) {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return [];
  }

  const statements = [];
  let start = 0;
  let i = 0;
  const len = sql.length;

  let tokens = [];
  let hasCode = false;
  let isTrigger = false;
  let inTriggerBody = false;
  let caseDepth = 0;

  const resetStatementState = (nextStart) => {
    start = nextStart;
    tokens = [];
    hasCode = false;
    isTrigger = false;
    inTriggerBody = false;
    caseDepth = 0;
  };

  while (i < len) {
    const ch = sql[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment --
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = i < len ? i + 2 : len;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      hasCode = true;
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      hasCode = true;
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // Backtick identifier
    if (ch === "`") {
      hasCode = true;
      i++;
      while (i < len) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // Bracketed identifier [...]
    if (ch === "[") {
      hasCode = true;
      i++;
      while (i < len && sql[i] !== "]") i++;
      if (i < len) i++;
      continue;
    }

    // Word / keyword
    if (isWordChar(ch)) {
      hasCode = true;
      const wStart = i;
      while (i < len && isWordChar(sql[i])) i++;
      const word = sql.slice(wStart, i).toUpperCase();
      tokens.push(word);

      if (!isTrigger) {
        if (
          (tokens.length === 2 && tokens[0] === "CREATE" && tokens[1] === "TRIGGER") ||
          (tokens.length === 3 &&
            tokens[0] === "CREATE" &&
            (tokens[1] === "TEMP" || tokens[1] === "TEMPORARY") &&
            tokens[2] === "TRIGGER")
        ) {
          isTrigger = true;
        }
      } else if (!inTriggerBody) {
        if (word === "CASE") {
          caseDepth++;
        } else if (word === "END" && caseDepth > 0) {
          caseDepth--;
        } else if (word === "BEGIN" && caseDepth === 0) {
          inTriggerBody = true;
        }
      } else {
        if (word === "CASE") {
          caseDepth++;
        } else if (word === "END") {
          if (caseDepth > 0) {
            caseDepth--;
          } else {
            inTriggerBody = false;
          }
        }
      }
      continue;
    }

    // Statement terminator ';'
    if (ch === ";" && !inTriggerBody) {
      if (hasCode) {
        const stmt = sql.slice(start, i).trim();
        if (stmt.length > 0) {
          statements.push(stmt);
        }
      }
      i++;
      resetStatementState(i);
      continue;
    }

    hasCode = true;
    i++;
  }

  if (hasCode) {
    const tail = sql.slice(start).trim();
    if (tail.length > 0) {
      statements.push(tail);
    }
  }

  return statements;
}

/**
 * Tokenize a single SQL statement, ignoring whitespace and SQL comments.
 * String literals (`'...'`) and quoted/bracketed identifiers are returned with `quoted: true`.
 * @param {string} stmt
 * @param {number} [limit]
 * @returns {Array<{ upper: string, raw: string, quoted: boolean, isString?: boolean }>}
 */
export function tokenizeSql(stmt, limit = Infinity) {
  const tokens = [];
  let i = 0;
  const len = stmt.length;

  const nextToken = () => {
    while (i < len) {
      const ch = stmt[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === "-" && stmt[i + 1] === "-") {
        i += 2;
        while (i < len && stmt[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && stmt[i + 1] === "*") {
        i += 2;
        while (i < len && !(stmt[i] === "*" && stmt[i + 1] === "/")) i++;
        i = i < len ? i + 2 : len;
        continue;
      }
      if (ch === '"' || ch === "`" || ch === "'") {
        const q = ch;
        i++;
        let val = "";
        while (i < len) {
          if (stmt[i] === q) {
            if (stmt[i + 1] === q) {
              val += q;
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            val += stmt[i];
            i++;
          }
        }
        return { upper: val.toUpperCase(), raw: val, quoted: true, isString: q === "'" };
      }
      if (ch === "[") {
        i++;
        const s = i;
        while (i < len && stmt[i] !== "]") i++;
        const val = stmt.slice(s, i);
        if (i < len) i++;
        return { upper: val.toUpperCase(), raw: val, quoted: true, isString: false };
      }
      if (isWordChar(ch)) {
        const s = i;
        while (i < len && isWordChar(stmt[i])) i++;
        const raw = stmt.slice(s, i);
        return { upper: raw.toUpperCase(), raw, quoted: false };
      }
      i++;
      return { upper: ch, raw: ch, quoted: false };
    }
    return null;
  };

  while (tokens.length < limit) {
    const tok = nextToken();
    if (!tok) break;
    tokens.push(tok);
  }

  return tokens;
}

/**
 * Scan the leading tokens (ignoring whitespace and comments) of a single SQL statement.
 * @param {string} stmt
 * @returns {{ kind: string, objectName: string | null }}
 */
export function classifySqlStatement(stmt) {
  const words = tokenizeSql(stmt, 10);

  if (words.length === 0 || words[0].quoted || words[0].upper !== "CREATE") {
    return { kind: "OTHER", objectName: null };
  }

  let idx = 1;
  if (words[idx] && !words[idx].quoted && (words[idx].upper === "TEMP" || words[idx].upper === "TEMPORARY")) {
    idx++;
  }

  if (!words[idx] || words[idx].quoted) {
    return { kind: "OTHER", objectName: null };
  }

  const targetType = words[idx].upper;

  if (targetType === "TABLE") {
    return { kind: "CREATE_TABLE", objectName: extractCreatedObjectName(words, idx + 1) };
  }
  if (targetType === "VIRTUAL" && words[idx + 1]?.upper === "TABLE") {
    return { kind: "CREATE_VIRTUAL_TABLE", objectName: extractCreatedObjectName(words, idx + 2) };
  }
  if (targetType === "UNIQUE" && words[idx + 1]?.upper === "INDEX") {
    return { kind: "CREATE_INDEX", objectName: extractCreatedObjectName(words, idx + 2) };
  }
  if (targetType === "INDEX") {
    return { kind: "CREATE_INDEX", objectName: extractCreatedObjectName(words, idx + 1) };
  }
  if (targetType === "VIEW") {
    return { kind: "CREATE_VIEW", objectName: extractCreatedObjectName(words, idx + 1) };
  }
  if (targetType === "TRIGGER") {
    return { kind: "CREATE_TRIGGER", objectName: extractCreatedObjectName(words, idx + 1) };
  }

  return { kind: "OTHER", objectName: null };
}

function extractCreatedObjectName(words, startIdx) {
  let idx = startIdx;
  if (
    words[idx] &&
    !words[idx].quoted &&
    words[idx].upper === "IF" &&
    words[idx + 1]?.upper === "NOT" &&
    words[idx + 2]?.upper === "EXISTS"
  ) {
    idx += 3;
  }
  if (!words[idx]) return null;
  if (words[idx + 1]?.raw === "." && words[idx + 2]) {
    return words[idx + 2].raw;
  }
  return words[idx].raw;
}

/**
 * Quote a SQLite identifier safely.
 * @param {string} name
 * @returns {string}
 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Escape a SQL single-quoted string literal.
 * @param {string} val
 * @returns {string}
 */
export function escapeSqlString(val) {
  return String(val).replace(/'/g, "''");
}

function isSimpleDefaultLiteral(val) {
  if (/^'(?:[^']|'')*'$/.test(val)) return true;
  if (/^"(?:[^"]|"")*"$/.test(val)) return true;
  if (/^[xX]'[0-9a-fA-F]*'$/.test(val)) return true;
  if (/^[+-]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/.test(val)) {
    return true;
  }
  if (/^(?:NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(val)) {
    return true;
  }
  return false;
}

function isWrappedInOuterParens(expr) {
  if (!expr.startsWith("(") || !expr.endsWith(")")) return false;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inSingle) {
      if (ch === "'" && expr[i + 1] === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
    } else if (inDouble) {
      if (ch === '"' && expr[i + 1] === '"') {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && i < expr.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * Reconstruct a column definition suitable for `ALTER TABLE ... ADD COLUMN`.
 * @param {{ name: string, type: string, notnull: number, dflt_value: string | null }} col
 * @returns {string}
 */
export function formatColumnDefinition(col) {
  const parts = [quoteIdent(col.name)];
  if (col.type && col.type.trim().length > 0) {
    parts.push(col.type.trim());
  }
  if (col.notnull === 1) {
    parts.push("NOT NULL");
  }
  if (col.dflt_value !== null && col.dflt_value !== undefined) {
    const trimmed = String(col.dflt_value).trim();
    if (isSimpleDefaultLiteral(trimmed) || isWrappedInOuterParens(trimmed)) {
      parts.push(`DEFAULT ${trimmed}`);
    } else {
      parts.push(`DEFAULT (${trimmed})`);
    }
  }
  return parts.join(" ");
}

/**
 * Extract unique named parameter placeholders (`:name`, `$name`, `@name`) from a single SQL statement,
 * ignoring comments, string literals, and quoted/bracketed identifiers.
 * @param {string} stmt
 * @returns {Array<{ token: string, name: string }>}
 */
export function extractSqlNamedParameters(stmt) {
  if (typeof stmt !== "string" || stmt.length === 0) {
    return [];
  }

  const params = [];
  const seen = new Set();
  let i = 0;
  const len = stmt.length;

  while (i < len) {
    const ch = stmt[i];

    // Line comment --
    if (ch === "-" && stmt[i + 1] === "-") {
      i += 2;
      while (i < len && stmt[i] !== "\n") i++;
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && stmt[i + 1] === "*") {
      i += 2;
      while (i < len && !(stmt[i] === "*" && stmt[i + 1] === "/")) i++;
      i = i < len ? i + 2 : len;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      i++;
      while (i < len) {
        if (stmt[i] === "'" && stmt[i + 1] === "'") {
          i += 2;
        } else if (stmt[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Double-quoted or backtick identifier
    if (ch === '"' || ch === "`") {
      const q = ch;
      i++;
      while (i < len) {
        if (stmt[i] === q && stmt[i + 1] === q) {
          i += 2;
        } else if (stmt[i] === q) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Bracketed identifier [...]
    if (ch === "[") {
      i++;
      while (i < len && stmt[i] !== "]") i++;
      if (i < len) i++;
      continue;
    }

    // Named parameter prefix: :name, $name, @name
    if (ch === ":" || ch === "$" || ch === "@") {
      const prev = i > 0 ? stmt[i - 1] : "";
      const next = stmt[i + 1] ?? "";
      if (!(prev && isWordChar(prev)) && /[A-Za-z_]/.test(next)) {
        let end = i + 2;
        while (end < len && /[A-Za-z0-9_]/.test(stmt[end])) end++;
        const name = stmt.slice(i + 1, end);
        const token = ch + name;
        if (!seen.has(token)) {
          seen.add(token);
          params.push({ token, name });
        }
        i = end;
        continue;
      }
    }

    i++;
  }

  return params;
}

const PLAIN_TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_READONLY_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "PRAGMA",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/**
 * Validate that a SQL string is a single strictly read-only query
 * (`SELECT`, `WITH ... SELECT`, or optionally `PRAGMA table_info(...)`).
 * @param {string} sql
 * @param {{ allowPragmaTableInfo?: boolean }} [options]
 * @returns {string}
 */
export function validateReadOnlySql(sql, { allowPragmaTableInfo = false } = {}) {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("SQL query cannot be empty.");
  }

  const stmts = splitSqlStatements(sql);
  if (stmts.length === 0) {
    throw new Error("SQL query cannot be empty.");
  }
  if (stmts.length > 1) {
    throw new Error("Multi-statement SQL is not allowed.");
  }

  const stmt = stmts[0];
  const tokens = tokenizeSql(stmt);
  if (tokens.length === 0) {
    throw new Error("SQL query cannot be empty.");
  }

  const first = tokens[0];
  if (first.quoted) {
    throw new Error("Read-only SQL only: query must start with SELECT or WITH.");
  }

  if (first.upper === "PRAGMA") {
    if (!allowPragmaTableInfo) {
      throw new Error("Read-only SQL only: PRAGMA is not allowed here.");
    }
    const isValidTableInfo =
      tokens.length === 5 &&
      !tokens[1].quoted &&
      tokens[1].upper === "TABLE_INFO" &&
      tokens[2].raw === "(" &&
      (tokens[3].quoted || isWordChar(tokens[3].raw[0] ?? "")) &&
      tokens[4].raw === ")";
    if (!isValidTableInfo) {
      throw new Error("Read-only SQL only: only PRAGMA table_info(<table>) is allowed.");
    }
    return stmt;
  }

  if (first.upper !== "SELECT" && first.upper !== "WITH") {
    throw new Error(`Read-only SQL only: "${first.upper}" statements are not allowed.`);
  }

  let depth = 0;
  let sawTopLevelSelect = first.upper === "SELECT";

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.quoted) continue;

    if (tok.raw === "(") {
      depth++;
      continue;
    }
    if (tok.raw === ")") {
      if (depth > 0) depth--;
      continue;
    }

    if (FORBIDDEN_READONLY_KEYWORDS.has(tok.upper)) {
      throw new Error(`Read-only SQL only: "${tok.upper}" is not allowed.`);
    }

    if (tok.upper === "REPLACE" && tokens[idx + 1]?.raw !== "(") {
      throw new Error('Read-only SQL only: "REPLACE" is not allowed.');
    }

    if (depth === 0 && idx > 0 && tok.upper === "SELECT") {
      sawTopLevelSelect = true;
    }
  }

  if (first.upper === "WITH" && !sawTopLevelSelect) {
    throw new Error("Read-only SQL only: WITH query must conclude with SELECT.");
  }

  return stmt;
}

/**
 * Validate a `bp.watch(query, cb)` target: plain table name or single read-only SELECT / WITH ... SELECT.
 * @param {string} query
 * @returns {{ kind: "table" | "query", query: string, sql: string }}
 */
export function validateWatchQuery(query) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Watch query must be a non-empty table name or SELECT query.");
  }
  const trimmed = query.trim();
  if (PLAIN_TABLE_RE.test(trimmed)) {
    return {
      kind: "table",
      query,
      sql: `SELECT * FROM ${quoteIdent(trimmed)}`,
    };
  }
  const sql = validateReadOnlySql(trimmed, { allowPragmaTableInfo: false });
  return {
    kind: "query",
    query,
    sql,
  };
}

/**
 * Check whether every statement in a SQL script is strictly read-only.
 * @param {string} sql
 * @returns {boolean}
 */
export function isReadOnlySqlScript(sql) {
  const stmts = splitSqlStatements(sql);
  if (stmts.length === 0) return true;
  for (const stmt of stmts) {
    try {
      validateReadOnlySql(stmt, { allowPragmaTableInfo: true });
    } catch {
      return false;
    }
  }
  return true;
}
