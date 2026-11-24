# Blueprint AI Action Node Skill (`<script type="blueprint/ai">`)

[中文](zh/ai.md) · [Skill Index](README.md) · [Def Module](def.md) · [Flow Module](flow.md) · [JS Module](js.md) · [SH Module](sh.md) · [Daemon Module](daemon.md)

Operational guide for authoring stateless AI CLI action nodes (`<script type="blueprint/ai">`) inside `<script type="blueprint/flow">` workflows.

## 1. Declaration Syntax

```html
<script type="blueprint/ai" id="coder" cli="agy" model="claude-sonnet" mode="auto" desc="Analyze code and propose changes">
You are a rigorous engineering assistant. Base answers strictly on the repository state.
</script>
```

- **`id`** (required): Unique action node ID across all backend action nodes in the file (cannot be `"done"`).
- **`cli`** (required): Underlying CLI adapter name. In v1, only `"agy"` is supported; missing or unknown `cli` values are rejected at parse time.
- **`model`** (optional): Forwarded as `--model <model>`.
- **`mode`** (optional): Forwarded as `--mode <mode>`.
- **`desc`** (optional): Purpose summary shown to the flow decision router.
- **Role prompt body** (optional): Trimmed script body (with `<\/script>` unescaped to `</script>`). **Prepended (separated by `\n\n`) only when starting a new session**; omitted when resuming an existing `session`.

## 2. Input / Output Contract

`blueprint/ai` is stateless—it keeps no conversation history of its own. Input is read from `ctx.last?.output` if it is a plain object, falling back to `ctx.event?.data` if it is a plain object, else `{}`:

```ts
// Input
{
  prompt: string;   // Required non-empty prompt text
  session?: string; // Optional; missing/null/whitespace starts a new session, non-empty resumes via --conversation
  cwd?: string;     // Optional working directory (defaults to process.cwd())
}

// Output (written to ctx.last.output)
{
  text: string;     // AI response text
  session: string;  // Created or resumed conversation/session ID
}
```

- **CLI execution (`cli="agy"`)**:
  - **New session** (no `session`): invokes `agy -p <fullPrompt> --output-format json` (plus `--model` / `--mode` if set) in `cwd`, where `fullPrompt` is `rolePrompt + "\n\n" + prompt` (or `prompt` if `rolePrompt` is empty).
  - **Resumed session** (`session` non-empty): invokes `agy -p <prompt> --conversation <session> --output-format json` (plus `--model` / `--mode` if set) in `cwd`, without repeating `rolePrompt`.
- **Output normalization**: Parses JSON stdout and normalizes `text` (accepting `text`, `result`, `response`, or `content`) and `session` (accepting `conversation`, `conversation_id`, `conversationId`, `session`, `session_id`, or `sessionId`).
- **Errors**: Missing/empty `prompt`, non-zero CLI exit code, invalid JSON, or missing response text throws an error caught by the flow loop (`ok: false` in `ctx.last` / `ctx.history`) so the flow can route to an error handler or `done`.

## 3. Usage Patterns

### Temporary (Stateless) Chat

Pass `{ prompt }` directly from `ctx.event.data` or a preceding `blueprint/js` node and consume `:text` downstream without storing `session`:

```html
<script type="blueprint/flow" on="ask">
1. Run quick-ai to answer the prompt.
2. Run emit-reply (or emit-error if quick-ai fails), then finish with done.
</script>

<script type="blueprint/ai" id="quick-ai" cli="agy" desc="Answer a standalone question">
Give concise, accurate answers.
</script>

<script type="blueprint/emit" id="emit-reply" event="ask:replied" desc="Emit AI reply"></script>
<script type="blueprint/emit" id="emit-error" event="ask:failed" desc="Emit failure"></script>
```

### SQLite-Backed Session Resume

Store the `session` ID in your blueprint's own SQLite table (`blueprint/def` + `blueprint/sql`), assemble `{ prompt, session, cwd? }` in a `blueprint/js` node, and bind `:session` and `:text` back to SQLite after `blueprint/ai` completes:

```html
<script type="blueprint/def">
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  last_reply TEXT
);
</script>

<script type="blueprint/flow" on="thread:message">
1. Run load-thread to fetch any stored session ID.
2. Run prepare-ai to build { prompt, session, cwd }.
3. Run chat to invoke the AI CLI. If chat fails, run emit-error then done.
4. If chat succeeds, run attach-thread-id, then save-thread to persist :session and :text, then finish with done.
</script>

<script type="blueprint/sql" id="load-thread" desc="Load existing session ID for thread_id">
SELECT session_id AS session FROM threads WHERE id = :thread_id;
</script>

<script type="blueprint/js" id="prepare-ai" desc="Build { prompt, session, cwd } for chat">
export default async (ctx) => ({
  prompt: ctx.event.data.prompt,
  session: ctx.last.output?.[0]?.session ?? null,
  cwd: ctx.event.data.cwd,
});
</script>

<script type="blueprint/ai" id="chat" cli="agy" desc="Run or resume thread conversation">
You are a project assistant. Answer directly using thread context.
</script>

<script type="blueprint/js" id="attach-thread-id" desc="Merge thread_id with AI output for persistence">
export default async (ctx) => ({
  thread_id: ctx.event.data.thread_id,
  session: ctx.last.output.session,
  text: ctx.last.output.text,
});
</script>

<script type="blueprint/sql" id="save-thread" desc="Persist latest session and reply">
INSERT INTO threads (id, session_id, last_reply)
VALUES (:thread_id, :session, :text)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id,
  last_reply = excluded.last_reply;
</script>

<script type="blueprint/emit" id="emit-error" event="thread:failed" desc="Emit chat failure"></script>
```

## 4. Keeping `id` Unambiguous in `<script type="blueprint/flow">`

- Choose distinct, role-specific `id`s (e.g., `ai-review`, `ai-fix`, `load-thread`, `save-thread`) rather than generic names like `step1` or `run`.
- Always reference the exact `blueprint/ai` node `id` in `<script type="blueprint/flow">` instructions, give each node a concise `desc`, and handle both success and `[error]` branches explicitly before ending at `done`.
