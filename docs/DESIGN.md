# throng-mcp — design

Date: 2026-09-27. Status: agreed; stages in §10, tasks in `backlog/`.

## 1. Purpose

MCP server `throng`. Tools: `run_thronglet` (launch a harness with a model, get the result synchronously), `resume_thronglet` (follow-up prompt into an earlier session), `list_harnesses` (discovery). Harnesses in v1: Claude Code, Codex, OpenCode. Transport to harnesses is ACP (Agent Client Protocol) v1. The harness edits the live tree at `cwd`; no sandboxes.

Out of scope: runner/DSL, message bus, UI, OTel, worktree/apply-back, trust gates.

## 2. Facts the design rests on (verified 2026-09-27)

### 2.1 Environment

node 24.11.1, pnpm 11.10, claude 2.1.282, codex 0.156.1, opencode 1.18.30. `cursor-agent` is not installed → Cursor is excluded from v1.

### 2.2 `@agentclientprotocol/sdk` 1.5.0 (`PROTOCOL_VERSION = 1`)

- Client API: `acp.client({name}).onRequest(...).onNotification(...).connectWith(ndJsonStream(stdin, stdout), ctx => ...)`. Inside: `ctx.buildSession(cwd).withMcpServer(...).start()` → `ActiveSession` with `prompt()` and `nextUpdate()`.
- `session/resume` is stable (`agentCapabilities.sessionCapabilities.resume`), no history replay. `session/fork` is unstable.
- Config options are stable: `{id, category: 'model'|'thought_level'|'mode'|..., type:'select', currentValue, options[]}`. Set via `setSessionConfigOption({sessionId, configId, value})`. Match on `category`, not `id`.
- `request_permission`: `options[{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}]`. Answer `{outcome:{outcome:'selected', optionId}}` or `{outcome:{outcome:'cancelled'}}`. Pick by `kind`: ids differ per agent.
- `usage_update {used, size, cost?}` is stable. `PromptResponse.usage {inputTokens, outputTokens, ...}` is unstable but all three adapters send it.
- `StopReason`: `end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
- None of the three adapters needs client fs/terminal capabilities; we don't advertise them.

### 2.3 Adapters

Versions below are the ones the design was verified against; the user installs adapters and may run others (§4.1).

`@agentclientprotocol/claude-agent-acp` 0.81.2 (bin `claude-agent-acp`):
- Drags a full copy of Claude Code with it: depends on `@anthropic-ai/claude-agent-sdk`, whose optional platform package (`…-darwin-arm64`, 217 MB) is the Claude Code 2.1.280 binary. `CLAUDE_CODE_EXECUTABLE` points the adapter at another `claude`, and then it runs without the platform package (decision-1).
- Model: config option category `model` (also env `ANTHROPIC_MODEL`). Effort: option `effort`, category `thought_level`.
- Modes: `default | acceptEdits | plan | auto | bypassPermissions`. `auto` falls back to `acceptEdits` with a `notice` when the model doesn't support it. Initial mode comes from `settings.json permissions.defaultMode`, so set it explicitly after `session/new`.
- `session/new._meta.claudeCode.options` passes Agent SDK options (`disallowedTools`, `allowedTools`, `env`, `settings`, ...).
- `mcpServers`: http/sse fine; stdio is recognized only when the object has no `type` field.
- Without client capability `elicitation.form` the adapter adds `AskUserQuestion` to `disallowedTools` by itself. That's what we want.
- Usage: `usage_update` with `cost.amount` (USD), plus `PromptResponse.usage`.

`@agentclientprotocol/codex-acp` 1.13.1 (bin `codex-acp`, TypeScript):
- Same story: depends on `@openai/codex`, whose optional platform package is the codex binary; `CODEX_PATH` overrides it the same way.
- Options: `model`, `reasoning_effort` (category `thought_level`), `mode`.
- Mode presets: `read-only` (asks the user, workspace-write sandbox), `agent` (default; approvals decided by auto_review, workspace-write), `agent-full-access` (never + danger-full-access).
- `mcpServers`: stdio, http. Usage without cost. Env `CODEX_CONFIG` = JSON layered over config.toml.

OpenCode 1.18.x (`opencode acp`):
- Model: option `model` = `<provider>/<model>`. Effort: option `effort` (model variants; not every model has them).
- Permissions: `permission` in opencode.json (`allow|ask|deny`, per tool). `ask` → `request_permission` (`once/always/reject`). Runtime override without touching files: env `OPENCODE_CONFIG_CONTENT` (inline JSON).
- Usage with cost.
- Quirk: after an approved `edit` OpenCode calls client `fs/write_text_file` without checking the capability and ignores the error.
- Custom providers live in the user's `~/.config/opencode/opencode.json`; the server doesn't touch it.

ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, format v1.0.0, 41 agents): `{id, name, version, description, distribution: npx{package,args,env} | binary{platform → {archive, cmd, args}}}`. Relevant ids: `claude-acp`, `codex-acp`, `opencode`. It gives launch commands only; model/effort/mode knobs differ per adapter.

### 2.4 Claude Code 2.1.282 as an MCP client

- **Auto-background**: an MCP call running longer than 120 s in an interactive main session is moved to a background task (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). The result arrives as a notification; stop via `TaskStop`. Doesn't trigger inside subagents (there the call stays synchronous). Doesn't background while an elicitation is pending.
- **Idle timeout** for stdio servers: 30 min without a response or `notifications/progress`; progress resets it (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 0 = off).
- **Hard wall-clock** per call: `MCP_TOOL_TIMEOUT`, default 1e8 ms (~27.8 h), or per-server `timeout` in settings. Not settable per call; progress doesn't extend it.
- Elicitation form and URL modes are supported (`elicitation_dialog`, `elicitation_url_dialog`). `notifications/cancelled` is sent on cancel.
- Nested-claude CLI flags aren't needed: everything goes through the adapter and `_meta.claudeCode.options`.

Consequence: wrapper subagents that shell out to a nested harness CLI aren't needed. The main session calls `run_thronglet` directly, several in parallel, and long calls go to the background by themselves.

## 3. External contract

### 3.1 Agent spec string

One string names harness, model and effort: `<harness>/<model>[:<effort>]`.

- `claude/opus[1m]`, `claude/opus[1m]:max`, `codex/gpt-6-sol:xhigh`, `opencode/openrouter/moonshotai/kimi-k3:high`.
- First path segment is the harness; the rest up to the last `:` is the model as the harness understands it (for opencode that's already `provider/model`).
- The `:<effort>` suffix is recognized only when it's one of `low | medium | high | xhigh | max`, so model names with their own `:tag` survive.

### 3.2 `run_thronglet`

```ts
input: {
  agent: string;              // §3.1
  prompt: string;             // self-contained: the nested session doesn't see the conversation
  cwd: string;                // absolute
  schema?: JsonSchemaObject;  // structured output, see §6
  timeout_s?: number;         // default 21600 (6 h)
}

output (success): {
  session_id: string;         // the harness's own ACP session id; for resume_thronglet, and for `claude --resume` / `codex resume` by hand
  text?: string;              // final agent message (last prompt turn); omitted when `structured` is returned
  structured?: unknown;       // only with schema
  stop_reason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';
  usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  duration_s: number;
  warnings?: string[];        // adapter notices, effort not applied, etc.
}

output (failure, MCP tool error: isError = true): {
  code: ErrorCode;
  message: string;            // the actual text: adapter stderr excerpt, ajv errors, list of valid models; not a paraphrase
  session_id?: string;        // when the ACP session exists: lets the caller resume after timeout / structured_invalid
  text?: string;              // what the agent said before failing, if anything
  usage?: { ... };
  duration_s: number;
  warnings?: string[];
}
```

Both are a single JSON text block in `content[0].text`; no `structuredContent`, no `outputSchema`. Invalid input is rejected by the SDK's zod validation before our code runs (MCP SDK 1.30 reports it as a tool error whose text is the validation message, not the payload above); everything else that goes wrong is a tool error with the payload above, never an exception.

```ts
type ErrorCode =
  | 'harness_unavailable'    // adapter command not found, checked before spawn; message carries the install command (§4.1)
  | 'depth_exceeded'         // §7
  | 'elicitation_unsupported'// policy 'elicit' configured but the client lacks the capability; before spawn
  | 'session_not_found'      // resume_thronglet: unknown id or harness lacks sessionCapabilities.resume
  | 'spawn_failed' | 'handshake_timeout' | 'handshake_failed'
  | 'model_rejected'         // value not among options; message lists the valid ones
  | 'timeout' | 'cancelled' | 'transport_lost'
  | 'empty_result'           // end_turn without a single agent_message_chunk and without submit_result
  | 'structured_missing' | 'structured_invalid'   // after 2 corrective re-prompts
  | 'refusal'                // stop_reason refusal is reported as an error
  | 'agent_error';
```

### 3.3 `resume_thronglet`

```ts
input: {
  session_id: string;         // from a previous run_thronglet / resume_thronglet
  prompt: string;
  schema?: JsonSchemaObject;
  timeout_s?: number;
}
output: same as run_thronglet; session_id stays the same
```

Harness, model, effort and `cwd` come from the session record (§8): the caller doesn't repeat them. A fresh adapter process picks the session up via `session/resume` (no history replay); the nested session keeps its own context. Since the adapter process is new, the permission mode, model and effort are applied again after `session/resume`, exactly as after `session/new`. Unknown id, or the harness can't resume → tool error `session_not_found` (added to `ErrorCode`).

### 3.4 `list_harnesses`

```ts
input: {}
output: {
  harnesses: Array<{
    harness: 'claude' | 'codex' | 'opencode';
    command: string[];       // what will actually be launched
    version?: string;        // adapter's initialize.agentInfo.version: adapters are user-installed, versions drift
    models: string[];        // config option category 'model'
    efforts: string[];       // config option category 'thought_level'; empty when the harness has none
  }>;
  unavailable: Array<{ harness: string; reason: string }>;   // adapter not found + install command, config error, probe failed
  limits: { max_concurrency; max_depth; default_timeout_s; current_depth };
}
```

Every available harness is started through ACP on each call (in parallel, no prompt, `session/new` in a throwaway temp dir, seconds, no tokens) to read the current `models`/`efforts`. A harness whose probe fails (handshake error, timeout) goes to `unavailable` with the error text. No caching.

### 3.5 Registration

```bash
claude mcp add --scope user throng -- node /path/to/throng-mcp/src/mcp.ts
```

Run by the user, not by the tasks: nothing outside the project directory is touched by the work itself. Tool names in Claude: `mcp__throng__run_thronglet`, `mcp__throng__resume_thronglet`, `mcp__throng__list_harnesses`.

## 4. Architecture

```
data/registry.json          — snapshot of the ACP registry (§4.1)
src/
  mcp.ts                    — entry: config, semaphore, StdioServerTransport, shutdown hooks
  mcp/
    tools.ts                — shared registration: progress, in-flight tracking, one JSON text block per result
    tools/                  — one file per tool: input schema, description, mapping to run.ts / list.ts
    progress.ts             — notifications/progress
  contract.ts               — tool inputs and results, ErrorCode, ThrongError (§3)
  config.ts                 — defaults + ~/.config/throng/config.yaml + env (THRONG_MCP_CONFIG, THRONG_MCP_DEPTH)
  agent-spec.ts             — parse '<harness>/<model>[:<effort>]'
  harnesses/
    types.ts                — HarnessDefinition
    claude.ts codex.ts opencode.ts
    index.ts discovery.ts   — registry snapshot + PATH resolution + discovery
    select.ts               — model/effort selection by option category
  acp/
    process.ts              — spawn in own process group, kill tree, descendant snapshot
    worker.ts               — Worker: connect/initialize/newSession|resumeSession/setOptions/prompt/cancel/close
    collector.ts            — fold session/update → text, usage, warnings
  sessions.ts               — session records on disk (§8)
  permissions.ts            — policy → answer to request_permission; bridge to MCP elicitation
  structured/
    submit-tool.ts          — stdio MCP server spawned by the harness: submit_result → ajv → result file
    validate.ts             — ajv
  run.ts                    — orchestration of one run/resume call
  lifecycle.ts              — slot, cancel/timeout race, worker start/cancel/close for one call
  list.ts                   — list_harnesses: probe every harness
  prompt.ts                 — prompt prefix, submit_result instructions
  progress.ts               — Progress interface (the MCP implementation is mcp/progress.ts)
  semaphore.ts log.ts
  **/*.test.ts              — vitest, next to the module under test
test/
  fake-agent/               — minimal ACP agent on @agentclientprotocol/sdk (agent side), scenarios via env
scripts/smoke/              — runs against real harnesses (manual); smoke.test.ts drives it against the fake agent
```

Layers: `mcp/` knows about MCP and nothing else calls it; `run.ts` gets progress and the cancel signal through plain interfaces and knows about Worker; Worker knows about ACP and the process, not about MCP; HarnessDefinition is plain data plus 3 hooks. Swapping the transport (ACP v2) = a new Worker with the same interface.

### 4.1 Harnesses and discovery

throng-mcp ships no adapters and no harnesses (decision-3). The user installs both; throng finds them on PATH:

| | claude | codex | opencode |
|---|---|---|---|
| registry id | `claude-acp` | `codex-acp` | `opencode` |
| adapter on PATH | `claude-agent-acp` | `codex-acp` | `opencode acp` |
| install hint | `npm i -g @agentclientprotocol/claude-agent-acp` | `npm i -g @agentclientprotocol/codex-acp` | opencode install docs |
| harness on PATH | `claude` → `CLAUDE_CODE_EXECUTABLE` | `codex` → `CODEX_PATH` | same binary |
| model | option category `model` | option category `model` | option category `model` |
| effort | option `thought_level`; exact | `thought_level`; `max → xhigh` | `thought_level` if present; otherwise warning |
| `auto` | mode `auto` | mode `agent` | opencode.json defaults |
| `allow_all` / `deny_all` / `elicit` | mode `default` | mode `read-only` (asks the client) | `OPENCODE_CONFIG_CONTENT={"permission":"ask"}` |

Availability is decided by the adapter command only. Adapter not on PATH → `unavailable` with `reason` = `<command> not found on PATH; install: <hint>`, and `run_thronglet` fails with `harness_unavailable` and the same text before spawn. The harness binary is optional: when `claude`/`codex` is on PATH, its absolute path goes into `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` (unless config sets them), so the adapter runs the user's installed and logged-in harness; otherwise the adapter falls back to its bundled platform package, and if that is missing too, the probe fails at handshake and the adapter's error lands in `reason`. Everything past "the command exists" is checked by the probe (§3.4), not by guessing.

Install hints for npm adapters come from `distribution.npx.package` of the registry snapshot with its version dropped: the user installs the latest adapter, `list_harnesses` shows which one. OpenCode ships as a binary, so its hint is a fixed pointer to its install docs. `npm i -g --omit=optional` skips the platform packages (~500 MB for both adapters, decision-1); it's safe only with the harness on PATH and isn't documented.

`data/registry.json` is a verbatim snapshot of the ACP registry. In v1 it supplies `args`/`env` of the distribution for the three ids, the install hints and the description shown by `list_harnesses`; commands come from the table above. Later iterations can fetch the live registry and expose "generic" harnesses from it without changing the data shape.

Config (§8) can override `command`/`args`/`env` per harness, e.g. to point at an adapter outside PATH.

```ts
interface HarnessDefinition {                 // src/harnesses/types.ts
  id: 'claude' | 'codex' | 'opencode';
  registryId: string;
  resolve(config, registry, env?): { available: true; launch: { command; args; env } } | { available: false; reason: string };
  mapEffort(level: Effort, options: string[]): string | undefined;   // our level → option value; undefined = not applicable → warning
  permissionSetup(policy): { modeId?: string; env?: Record<string,string>; newSessionMeta?: object };
}
```

Model is set strictly: the value must be in `options` of the matching config option, otherwise `model_rejected` with the list. Effort: `mapEffort` picks the option value; `undefined` → `warnings`, not an error.

### 4.2 Worker (acp/worker.ts)

One call = one adapter process = one ACP session. No pool (YAGNI; adapter start is seconds).

Sequence:
1. `spawn` (detached, own group, `stdio: [pipe, pipe, pipe]`, stderr → 64 KB ring buffer for error messages). `THRONG_MCP_DEPTH = depth + 1` in the child env.
2. `connectWith(ndJsonStream)`, `initialize` (`clientCapabilities: { fs: {readTextFile:false, writeTextFile:false}, terminal:false }`).
3. `session/new { cwd, mcpServers }` (+ `_meta` from the harness), or `session/resume { sessionId, cwd, mcpServers }` for `resume_thronglet` (requires `sessionCapabilities.resume`; unknown id → `session_not_found`). Steps 1–3 run under the handshake timeout (60 s) → `handshake_timeout`.
4. Mode (`setSessionMode`), model, effort via `setSessionConfigOption`.
5. `prompt` → `nextUpdate()` loop until `stop`. Every event → collector + progress.
6. Structured-output re-prompts (§6): step 5 again.
7. `close()`: close stdin, wait 5 s for exit, then `SIGTERM` to the group, 5 s more → `SIGKILL`; finish off the descendant snapshot (`pgrep -P`, recursive, taken before close).

Cancel (MCP `extra.signal` abort, i.e. Esc/TaskStop): `session/cancel` → wait for `stop` up to 5 s → step 7. All pending `request_permission` are answered `{outcome:'cancelled'}`. Result: tool error `cancelled`. Call timeout takes the same path with `timeout`.

Server shutdown (`SIGTERM`/`SIGINT`/EOF on stdin): step 7 for every live worker, then exit.

Client methods `fs/*`, `terminal/*`: not advertised; if an agent calls them anyway (OpenCode quirk) we answer JSON-RPC method not found and add one warning.

### 4.3 Collector

From the `session/update` stream:
- `agent_message_chunk` (text) of the current turn → `text`. Each new `prompt` resets the buffer; the last turn is returned.
- `agent_thought_chunk`: ignored.
- `tool_call` / `tool_call_update`: title → progress.
- `usage_update` → `cost_usd` (last value; it's cumulative); `PromptResponse.usage` → tokens (summed across turns).
- `notice` (unstable, but claude sends it) → `warnings`.
- everything else: ignored.

## 5. Permissions

The policy comes from config only (§8): a global default and optional per-harness overrides. It is deliberately not a tool parameter, so the calling model can't grant itself more than the config allows. Default `auto`. The answer to `request_permission` is an option chosen by `kind`:

| policy | native mode | server answer |
|---|---|---|
| `auto` | the harness's auto mode (§4.1) | `reject_once`; if absent, `cancelled` (decision-4) |
| `allow_all` | asking mode | `allow_once` |
| `deny_all` | asking mode | `reject_once`; if absent, `cancelled` |
| `elicit` | asking mode | per the user's answer |

A `request_permission` for throng's own `submit_result` (§6) is answered `allow_once` under every policy, before the policy applies.

Always `*_once`, never `allow_always`: Claude's `allow-with-updates` writes a rule into the project settings.

`auto` trusts the harness's own auto mode and nothing more: what that mode does not approve on its own is refused by the server. Answering `allow_once` there would turn `auto` into `allow_all` whenever a harness asks a lot (Claude's `acceptEdits` fallback, Codex's "potentially unsafe" checks).

`elicit`:
- At call start check `server.getClientCapabilities()?.elicitation`; missing → tool error `elicitation_unsupported`, no spawn.
- `elicitInput` in form mode: `message` = `[agent] <toolCall.title>` + kind + `rawInput` (JSON, truncated to 2 KB) + locations; field `decision` is a titled `oneOf` of the kinds present in `options`. Not `enumNames` (deprecated).
- `accept` → the chosen optionId; `decline` → `reject_once` (or `cancelled`); `cancel` → `cancelled`.
- Wait timeout 10 min → `cancelled` (the agent gets a rejection, the call continues).
- While an elicitation is pending Claude Code doesn't background the call; that's its behavior, nothing for us to do.

## 6. Structured output

One mechanism for all harnesses, transport-independent, no network:
- With `schema` the server writes the schema to a per-run temp dir (`$TMPDIR/throng-*`) and injects a stdio MCP server into `session/new.mcpServers` (or `session/resume.mcpServers`): `{ name:'throng_result', command:<absolute path of the node executable>, args:['<repo>/src/structured/submit-tool.ts', '--schema', <path>, '--out', <path>], env:[] }` (no `type` field: claude-agent-acp quirk; an absolute `command` because ACP wants one and codex gives MCP servers a whitelisted env). The harness spawns it itself; it exposes one tool, `submit_result({ result })`. A `request_permission` for it is answered `allow_once` under every policy (§5).
- The schema is the tool's `inputSchema`: wrapped as `{ type:'object', properties:{ result:<schema> }, required:['result'] }`, the schema's `$defs` / `definitions` hoisted to the wrapper root so local refs resolve, `$schema` dropped. The SDK doesn't check the arguments; submit-tool validates them itself. The prompt only gets an instruction: finish by calling `submit_result`, whose input schema describes `result`.
- `submit_result` validates with ajv: the engine follows `$schema` (`Ajv2020` for 2020-12, draft-07 `Ajv` otherwise, also when `$schema` is absent), since the dialects differ in keyword semantics (`items` tuples vs `prefixItems`); `allErrors`, non-strict, formats not checked. Every call writes the `--out` file (last write wins): `{ ok:true, result }` with response "accepted", or `{ ok:false, errors }` with an `isError` response carrying the ajv errors, so the agent fixes it within the same turn. After `stop` the server reads the file: no file means not submitted.
- After a turn that ends with `end_turn`, `max_tokens` or `max_turn_requests` and no valid result: corrective re-prompt ("you didn't call submit_result" / "your last call was rejected: <errors>"), at most 2. Then tool error `structured_missing` (no file) or `structured_invalid` (last call rejected; message carries the ajv errors) with `text` (the last turn's, or the latest non-empty one) and `session_id` in the payload, so the caller sees what the agent said and can resume. `refusal` / `cancelled` fail as without a schema.
- With a valid result the response carries `structured` and omits `text`; a turn without any agent message is then not `empty_result`.
- Check: ajv compiles the schema in the tool's input validation, before spawn; an invalid schema is an input error. The temp dir is removed when the run ends (after the adapter's tree kill, which takes submit-tool with it).

## 7. Limits and guards

- Semaphore per server process: `max_concurrency = 10`. Queue wait doesn't count toward `timeout_s`; while queued we send progress "queued (n)".
- Depth: the server reads `THRONG_MCP_DEPTH` (default 0), sets `+1` for the child; `depth + 1 > max_depth (2)` → tool error `depth_exceeded` before spawn. A nested claude session sees the same user-scope server; the guard exists for it.
- `timeout_s` default 21600. Handshake 60 s. Elicitation 10 min. All in config.
- Progress (`notifications/progress`, when a `progressToken` arrived): on every `tool_call` (title), on agent text (at most once per 2 s), heartbeat every 30 s with elapsed time. This keeps Claude Code's idle timeout (30 min) from firing on long turns.
- Prompt prefix (`prompt.ts`), always: the agent runs as a nested session and its final message goes back to the caller as the result. No rules on how to work (orchestration, workflows, commits): that is the caller's prompt, not the server's business.

## 8. Config, sessions, logs

`~/.config/throng/config.yaml` (optional, path via `THRONG_MCP_CONFIG`). Session records live under `~/.cache/throng` (path via `THRONG_MCP_CACHE_DIR`). All env vars of the server use the `THRONG_MCP_` prefix.
```yaml
permissions: auto            # auto | allow_all | deny_all | elicit; global default
harnesses:
  opencode:
    command: /opt/opencode
    args: [acp]
    env: { X: "1" }
  codex:
    permissions: allow_all   # per-harness override
  claude:
    env: { ANTHROPIC_BASE_URL: "..." }
limits:
  timeout_s: 21600
  handshake_s: 60
  elicitation_s: 600
  max_concurrency: 10
  max_depth: 2
```
Config validation with zod; an error goes to stderr at server start and into `list_harnesses.reason`.

Session records: `~/.cache/throng/sessions/<session_id>.json` = `{ harness, model, effort, cwd, created_at, last_used_at }`, keyed by the harness's own ACP session id (UUID-like in all three; collisions across harnesses are not a practical concern). Written when the ACP session exists, updated on every resume. Records survive server restarts.

Logs: server stderr has short lines (worker start/stop, errors, every permission decision, each call's outcome). throng keeps no transcripts: the full history of a session is in the harness's own log, found by `session_id` (Claude Code `~/.claude/projects/`, Codex `~/.codex/sessions/`, OpenCode its storage). Rotation: session records older than 14 days are deleted at start.

## 9. Package, language, tests

- `package.json`: `private`, `type: module`, `engines.node >= 24`, no `bin`. pnpm. Dependencies: `@modelcontextprotocol/sdk` ^1 (latest), `@agentclientprotocol/sdk` ^1.5.0, `ajv` ^8, `zod` ^4, `yaml` ^2. Dev: `typescript` (6.x: typescript-eslint has no support for the 7.x native compiler package yet), `@types/node`, `vitest`, `eslint` + `typescript-eslint` (`strictTypeChecked` + `stylisticTypeChecked`), `prettier`, `lefthook`. No adapters (§4.1).
- Run with `node src/mcp.ts`, no transpilation (type stripping): no `enum`, `namespace`, parameter properties, `import =`. tsconfig: `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `module: nodenext`, `noEmit`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Imports with `.ts`.
- Scripts: `pnpm typecheck` (`tsc --noEmit`), `pnpm test` (`vitest --run`; `pnpm test:watch` for watch mode), `pnpm lint` (`eslint .`), `pnpm fmt` (`prettier --write`), `pnpm smoke:<harness>`. The `ci:*` variants are what GitHub Actions runs (`.github/workflows/ci.yml`: lint, typecheck, prettier check, tests on Node 24 and 26). The lefthook pre-commit hook runs fmt, lint --fix and typecheck.
- Tests without an LLM: `test/fake-agent` is an ACP agent on the agent-side SDK, scenarios via env (`FAKE_SCENARIO=echo|permission|submit-valid|submit-invalid-then-valid|resume|hang|crash-on-prompt|notice`). They cover Worker, collector, permissions (all 4 policies; elicit through a fake MCP client with the capability), structured (both re-prompt branches), resume, timeouts, cancel, tree kill (fake-agent spawns a grandchild `sleep`; after close it's gone), depth, semaphore, agent-spec parsing.
- Smoke on real harnesses (manual, one at a time; per-stage lists are in the backlog tasks): claude/codex/opencode × `auto`, opencode with a custom provider, Esc → no orphans, a call > 2 min from the main session goes to the background; v2 adds codex+schema, resume with a follow-up question, elicit from an interactive session.

## 10. Stages

- **v1 = MVP**: `run_thronglet` with the `auto` policy, `list_harnesses`, three harnesses. Enough to call it from a real session.
- **v2**: structured output, `resume_thronglet`, permission policies `allow_all | deny_all | elicit`, messages into a running thronglet (THRONG-9; contract TBD).
- Later: §11.

Tasks, their acceptance criteria and dependencies live in Backlog.md: milestones `v1` and `v2` (`backlog task list -m v1 --plain`).

## 11. Later iterations (not v1)

- File access modes `read-only | read-write | sandbox`: read-only = Claude `plan` mode + `deny_all` on edit kinds, Codex `read-only` sandbox via `CODEX_CONFIG`, OpenCode `permission.edit = deny`. Sandbox is an open question.
- Live ACP registry fetch on top of the snapshot; "generic" harnesses from it (config options only, no native auto).
- Cursor: `cursor-agent --model X acp`; the extension methods `cursor/ask_question` and `cursor/create_plan` must be answered.
- ACP v2: `session/prompt` no longer closes the turn, stop arrives in `state_update`; `tool_call` merges into `tool_call_update`. Isolated in Worker/collector.
