---
id: THRONG-2
title: Worker and fake-agent
status: Done
assignee:
  - '@fable'
created_date: '2026-09-27 18:56'
updated_date: '2026-09-27 20:14'
labels: []
milestone: m-0
dependencies:
  - THRONG-1
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
One call = one adapter process = one ACP session. The Worker owns that lifecycle and is the only layer that knows ACP; tests must not call LLMs, so a fake ACP agent is built alongside. The Worker interface is a contract and is written by the main session.

Scope: DESIGN §4.2, §4.3, §9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `acp/process.ts`, `acp/worker.ts`, `acp/collector.ts` follow the sequence in DESIGN §4.2 and the folding rules in §4.3; the Worker does not import MCP
- [x] #2 `test/fake-agent` is an ACP agent on the agent-side SDK with scenarios selected via `FAKE_SCENARIO`
- [x] #3 Tests cover handshake, prompt → text, usage, cancel, timeout and transport_lost
- [x] #4 After close no process from the adapter tree survives (fake-agent spawns a grandchild `sleep`)
- [x] #5 Error messages carry the adapter stderr excerpt
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THRONG-2 — Worker and fake-agent. Goal: the ACP layer (spawn adapter, handshake, prompt, cancel, close with tree kill, fold updates) plus a fake ACP agent so tests never call an LLM.

READ FIRST: docs/DESIGN.md §4 (layout), §4.2 (Worker sequence — follow it step by step), §4.3 (collector folding rules), §7 (depth env), §9 (TS constraints, fake-agent scenarios). AGENTS.md "Code rules". src/acp/types.ts is the contract (written by the main session): implement it exactly; don't change exported shapes — if something is missing, say so in deviations.

ALREADY IN THE TREE: src/errors.ts (ThrongError, codes), src/contract.ts, src/config.ts, src/log.ts, src/mcp.ts (list_harnesses stub), src/acp/types.ts (Worker contract). Node 24, TS 7.0.2, `pnpm typecheck && pnpm test` green (28 tests). `@agentclientprotocol/sdk` 1.5.0 is installed; all schema types are exported from its root (`import type { SessionNotification, ... } from '@agentclientprotocol/sdk'`), runtime: `import * as acp from '@agentclientprotocol/sdk'` → `acp.client`, `acp.agent`, `acp.methods`, `acp.ndJsonStream`, `acp.RequestError`, `acp.PROTOCOL_VERSION`.

SDK FACTS (verified against node_modules/@agentclientprotocol/sdk/dist, cite these instead of guessing; look at dist/acp.d.ts and dist/examples/{client,agent}.js):
- Client side: `acp.client({ name }).onRequest(acp.methods.client.session.requestPermission, ctx => ...).onNotification(acp.methods.client.session.update, ctx => ...).connect(stream)` returns a `ClientConnection` = `{ agent: ClientContext, signal: AbortSignal, closed: Promise<void>, close(err?) }`. Use `connect(stream)`, NOT `connectWith`: the Worker outlives any single callback. `connection.agent.request(acp.methods.agent.initialize, params)`, `.request(acp.methods.agent.session.new, ...)`, `.request(acp.methods.agent.session.resume, ...)`, `.request(acp.methods.agent.session.prompt, ...)`, `.request(acp.methods.agent.session.setMode, ...)`, `.request(acp.methods.agent.session.setConfigOption, ...)`, `.notify(acp.methods.agent.session.cancel, { sessionId })` (cancel is a notification). Handlers must be registered on the builder BEFORE `connect`. Custom methods: `.onRequest('fs/read_text_file', parser, handler)` with a parser object — check `ParamsParser` in acp.d.ts; a handler that throws `acp.RequestError.methodNotFound(method)` answers JSON-RPC -32601.
- Do NOT use `ctx.buildSession()` / `ActiveSession`: they exist only for session/new and can't wrap session/resume. Route `session/update` yourself: the `onNotification(session.update)` handler receives `{ params: { sessionId, update } }`; forward the ones for our sessionId to `hooks.onUpdate`.
- `acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))` (node:stream). Malformed lines are answered with a parse error and skipped, they don't close the stream. Stream close when the child's stdout ends → `connection.closed` resolves / `signal` aborts; pending requests reject.
- `session/prompt` params `{ sessionId, prompt: [{ type: 'text', text }] }` → `PromptResponse { stopReason: 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled', usage?: { inputTokens, outputTokens, totalTokens, ... } }`.
- `SetSessionConfigOptionRequest { sessionId, configId, value }` → `{ configOptions }` (refreshed list). `SetSessionModeRequest { sessionId, modeId }` → `{}`.
- `NewSessionRequest { cwd, mcpServers, _meta? }` → `{ sessionId, modes?, configOptions? }`. `ResumeSessionRequest { sessionId, cwd, mcpServers? }` → `{ modes?, configOptions? }` (no sessionId echoed). `McpServerStdio` has NO `type` field (`{ name, command, args, env: [{name,value}] }`).
- `RequestPermissionRequest { sessionId, toolCall, options: [{ optionId, name, kind: allow_once|allow_always|reject_once|reject_always }] }` → `{ outcome: { outcome: 'cancelled' } | { outcome: 'selected', optionId } }`.
- `SessionUpdate` variants (`update.sessionUpdate`): user_message_chunk, agent_message_chunk, agent_thought_chunk (each `{ content: ContentBlock }`), tool_call `{ toolCallId, title, kind?, status?, ... }`, tool_call_update, plan, plan_update, plan_removed, available_commands_update, current_mode_update, config_option_update, session_info_update, usage_update `{ used, size, cost?: { amount, currency } }`, notice `{ severity, title, description? }`, compaction_update, compaction_summary_chunk.
- Agent side (fake-agent): `acp.agent({ name }).onRequest('initialize', ctx => ...).onRequest('session/new', ...).onRequest('session/resume', ...).onRequest('session/prompt', ctx => ...).onRequest('session/set_mode', ...).onRequest('session/set_config_option', ...).onNotification('session/cancel', ...).connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))`. Inside a handler `ctx.params` are the params and `ctx.client` is the AgentContext: `await ctx.client.notify(acp.methods.client.session.update, { sessionId, update })`, `await ctx.client.request(acp.methods.client.session.requestPermission, {...})`. See dist/examples/agent.js for the idiom (AbortController per session for cancel).

BUILD:

1. src/acp/process.ts — child process ownership, no ACP knowledge.
   `spawnAdapter({ command, args, env, cwd }): { child, stderrTail(): string }` — `child_process.spawn(command, args, { cwd, env, stdio: ['pipe','pipe','pipe'], detached: true })` (own process group). stderr → ring buffer capped at 64 KB (keep the last bytes). Spawn errors (`error` event with ENOENT etc.) surface to the caller.
   `snapshotDescendants(pid): Promise<number[]>` — recursive `pgrep -P` (macOS and Linux; on failure return []).
   `killTree(child, snapshot, graceMs)` — DESIGN §4.2 step 7: end stdin, wait up to graceMs for exit; then `process.kill(-pid, 'SIGTERM')`, wait graceMs; then `process.kill(-pid, 'SIGKILL')`; finally SIGKILL every pid in the snapshot that is still alive (`kill(pid, 0)` probe). Swallow ESRCH/EPERM. Idempotent.

2. src/acp/worker.ts — `export const startWorker: StartWorker` (from types.ts) plus the class behind it.
   Sequence (§4.2): spawn with `env = { ...process.env, ...spawn.env, THRONG_MCP_DEPTH: String(spawn.depth + 1) }` → build the client (handlers: requestPermission → `hooks.onPermission`; session.update → filter by our sessionId → `hooks.onUpdate`; `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill` → throw `RequestError.methodNotFound(method)` and call `hooks.onWarning` ONCE per worker with a text naming the method) → `connect` → `initialize` with `{ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }` → `session/new` (`cwd`, `mcpServers`, `_meta: start.meta` when given) or `session/resume`. The whole of spawn+initialize+new/resume runs under one timer of `limits.handshakeMs`.
   Error mapping (all ThrongError, message = short cause + `; adapter stderr: <tail>` when the tail is non-empty; the tail is `stderrTail()` truncated to its last ~2 KB in messages, the full 64 KB stays available via the method):
   - spawn `error` event / exit before initialize responded → `spawn_failed` (include errno/code and exit code/signal).
   - handshake timer fires → `handshake_timeout` (say which step was pending: initialize / session/new / session/resume), then kill the tree before rejecting.
   - JSON-RPC error or protocol mismatch during initialize / session/new → `handshake_failed`; for `kind: 'resume'`: agent lacks `agentCapabilities.sessionCapabilities.resume` → `session_not_found` before sending anything; a JSON-RPC error from `session/resume` → `session_not_found` with the agent's message.
   - connection closes while a request is pending (prompt / setMode / setConfigOption) → `transport_lost` with exit code/signal and stderr.
   - JSON-RPC error from prompt / setMode / setConfigOption → `agent_error` with the agent's error message and data.
   Any failure during start → kill the tree before rejecting (no orphan on failed handshake).
   `session`: sessionId (for resume: the one we sent), agentInfo, agentCapabilities, modes, configOptions (omit keys whose value is null/undefined — `exactOptionalPropertyTypes`).
   `prompt(text)`: one request; resolves with the PromptResponse. `cancel()`: `session/cancel` notification; resolves immediately after sending (waiting for stop is the caller's business). `close()`: snapshot descendants first, then `killTree` with `limits.exitGraceMs ?? 5000`, then `connection.close()`; idempotent, never throws; after close every method rejects `transport_lost`.
   `pid`: child pid. No MCP import anywhere under src/acp (a reviewer will grep).

3. src/acp/collector.ts — folds `SessionNotification`s + `PromptResponse`s per DESIGN §4.3. `class Collector { startTurn(); handle(n: SessionNotification); endTurn(r: PromptResponse); get text(): string; get usage(): Usage; get warnings(): string[]; get events(): TranscriptEvent[] }` where `TranscriptEvent = { ts: number; kind: 'update' | 'stop'; payload: unknown }`. Rules: `agent_message_chunk` with text content → appended to the current turn's text (buffer reset by `startTurn`; `text` is the last turn); `agent_thought_chunk` → transcript only; `tool_call`/`tool_call_update` → transcript, plus `lastToolTitle` getter (progress in THRONG-4 will read it); `usage_update` → `usage.cost_usd = cost.amount` (last value wins, it's cumulative); `endTurn` → `input_tokens`/`output_tokens` summed across turns from `response.usage` when present; `notice` → `warnings` (`<severity>: <title>[ — description]`); everything else transcript only. `Usage` type from src/errors.ts. No dedupe of warnings beyond exact-string.

4. test/fake-agent/agent.ts — an ACP agent on `acp.agent()`, run as `node test/fake-agent/agent.ts` (type stripping, no flags). Scenario via env `FAKE_SCENARIO` (default `echo`). Also export a tiny helper for tests: test/fake-agent/index.ts with `fakeAgentSpawn(scenario): WorkerSpawn`-like `{ command: process.execPath, args: [<abs path to agent.ts>], env: { FAKE_SCENARIO: scenario } }` (cwd/depth added by the test).
   Common behavior: `initialize` → `{ protocolVersion: 1, agentInfo: { name: 'fake-agent', version: '0.0.1' }, agentCapabilities: { sessionCapabilities: { resume: {} }, promptCapabilities: {} } }` (scenario `no-resume` omits `resume`). `session/new` → `{ sessionId: 'fake-<random>', modes: { currentModeId: 'ask', availableModes: [{id:'ask',name:'Ask'},{id:'auto',name:'Auto'}] }, configOptions: [ { id:'model', name:'Model', category:'model', type:'select', currentValue:'fake-small', options:[{value:'fake-small',name:'Fake Small'},{value:'fake-large',name:'Fake Large'}] }, { id:'effort', name:'Effort', category:'thought_level', type:'select', currentValue:'low', options:[{value:'low',name:'Low'},{value:'high',name:'High'}] } ] }` and remembers the session's cwd and mcpServers. `session/resume` → accepts any sessionId (records it), same modes/configOptions. `session/set_mode` → unknown modeId → `RequestError.invalidParams` listing valid ids; else `{}`. `session/set_config_option` → unknown configId or value → `RequestError.invalidParams` with the valid values in the message; else updates `currentValue` and returns `{ configOptions }`. `session/cancel` → aborts the pending prompt of that session → its handler returns `{ stopReason: 'cancelled' }`.
   Scenarios (prompt behavior):
   - `echo`: `agent_thought_chunk` "thinking", `tool_call` { toolCallId:'t1', title:'read README.md', kind:'read', status:'in_progress' }, `tool_call_update` { toolCallId:'t1', status:'completed' }, two `agent_message_chunk`s that together read `echo: <prompt text>` (prefix `resumed: ` when the session came from session/resume; current model/effort appended as ` [model=<m> effort=<e>]`), `usage_update { used: 100, size: 1000, cost: { amount: 0.01, currency: 'USD' } }` → `{ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }`. A second prompt in the same session gives cost 0.02 (cumulative) and the same token usage.
   - `permission`: before echoing, `session/request_permission` with `toolCall { toolCallId:'t2', title:'write notes.txt', kind:'edit', status:'pending' }` and options `[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'always',name:'Always',kind:'allow_always'},{optionId:'no',name:'Reject',kind:'reject_once'}]`; then message `allowed` / `rejected` / `cancelled` depending on the answer.
   - `notice`: echo plus a `notice { severity: 'warning', title: 'fake notice', description: 'mode fell back' }` update before the text.
   - `hang`: no updates, prompt never resolves until `session/cancel` (→ `cancelled`).
   - `handshake-hang`: never answers `initialize` (register the handler with a promise that never settles).
   - `crash-on-prompt`: on prompt, write `fake-agent: boom` to stderr and `process.exit(3)`.
   - `fs-call`: on prompt, first call the client's `fs/read_text_file` ({ sessionId, path: '/etc/hosts' }) and swallow the error, then echo.
   - `grandchild`: at startup spawn `sleep 300` (plain `spawn`, not detached) and print `grandchild pid=<pid>` to stderr, then behave like `echo`.
   Keep the agent small and boring; scenario is a switch inside the prompt handler + two startup hooks.

5. Tests (node:test, all through the fake agent; `exitGraceMs: 300`, `handshakeMs: 5000` unless the case says otherwise; every worker closed in `finally`/`after`, and every test asserts the adapter pid is gone after close):
   - test/worker.test.ts: handshake → `session` has sessionId, agentInfo name, both configOptions with their categories, modes; `prompt` → PromptResponse end_turn and the collector's text equals `echo: hello [model=fake-small effort=low]`; setConfigOption('model','fake-large') → returned list has currentValue fake-large and the next echo shows it; setMode('auto') ok; setConfigOption bad value → ThrongError `agent_error` whose message contains `fake-large`; usage across two prompts → input_tokens 20, output_tokens 10, cost_usd 0.02; cancel: `hang` → prompt pending → `cancel()` → resolves with stopReason `cancelled`; handshake timeout: `handshake-hang` + `handshakeMs: 500` → rejects `handshake_timeout`, message names `initialize`, and the pid is gone; spawn_failed: command `/nonexistent/adapter` → `spawn_failed` with ENOENT in the message; transport_lost: `crash-on-prompt` → prompt rejects `transport_lost`, message contains `boom` (AC #5: stderr excerpt) and exit code 3; `fs-call` → onWarning called exactly once with a text containing `fs/read_text_file`, prompt still completes; resume: start `{ kind:'resume', sessionId:'abc', ... }` → `session.sessionId === 'abc'` and text starts with `resumed: `; `no-resume` scenario + resume start → `session_not_found` before any prompt; permission: onPermission gets 3 options, answering `{ outcome: { outcome: 'selected', optionId: 'yes' } }` → text `allowed`, answering cancelled → `cancelled`; depth: fake agent echoes `THRONG_MCP_DEPTH` into a `session_info_update` or into the echo text (pick one, document it) → with `depth: 1` the child sees `2`.
   - test/process.test.ts: tree kill with `grandchild`: read the grandchild pid from stderr, close the worker, assert both pids are dead within ~2 s; `snapshotDescendants` on the fake agent returns the grandchild pid.
   - test/collector.test.ts: unit tests with hand-built notifications — text per turn resets on startTurn, cost last-wins, tokens summed, notice → warnings, thought/plan → transcript only, lastToolTitle.
   Tests must not leave processes behind even when they fail (kill in `after`), must not depend on wall-clock beyond generous upper bounds, and must not touch ~/.config or ~/.claude.

DON'T: import anything from `@modelcontextprotocol/sdk` under src/acp; implement run.ts, harnesses, permissions policy, progress, sessions on disk, structured output (later tasks); change src/acp/types.ts, src/contract.ts, src/errors.ts (report gaps in deviations); run real harnesses (claude/codex/opencode) or any LLM; edit backlog/, docs/. Timeouts of the whole call (`timeout_s`) are THRONG-4's: here only the handshake timer.

GATES: `pnpm typecheck && pnpm test` green; no leaked processes after the suite (`pgrep -f fake-agent` empty). Acceptance criteria covered: #1 process/worker/collector per §4.2/§4.3, no MCP import; #2 fake-agent with FAKE_SCENARIO; #3 tests for handshake, prompt→text, usage, cancel, timeout, transport_lost; #4 tree kill incl. grandchild; #5 stderr excerpt in error messages.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_e7ca0f41-914: Opus coder, gates green, dual review 8 findings → 2 confirmed and fixed (f7 major: session/update before session/new answered was dropped — now forwarded while the id is unknown, early-update scenario + test; f1 major: adapter exit unnoticed while a descendant holds its stdout — child 'exit' + 1 s settle timer closes the connection by hand, orphan-exit/orphan-crash scenarios + tests), verified with evidence; spot-checked worker.ts:66-77, 84-87. Deviations accepted: killTree always SIGKILLs the group at the end (children may outlive the leader); close during session/new|resume → handshake_failed; fakeAgentSpawn returns a tag field (argv marker) for pgrep; depth reported via session_info_update._meta.throngDepth; prompt() waits one setImmediate so late-dispatched updates precede the stop. Main session after the cycle: f4 — synchronous spawn() throws are now spawn_failed (worker.ts startWorker try/catch + test). Deferred: f2 snapshot-kill path of killTree is untested (grandchild sleep stays in the group); f3 fake agent does not record cwd/mcpServers per session (needed when THRONG-6 injects the throng_result MCP server); f6 cancel() does not unblock a pending onPermission — per DESIGN §4.2 run.ts answers pending permission requests with cancelled on cancel (goes into the THRONG-4 brief).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/acp/{process,worker,collector}.ts implement the Worker contract in src/acp/types.ts (spawn in own group, 64 KB stderr ring, handshake under one timer, manual session/update routing so resume works, tree kill with descendant snapshot, §4.3 folding). test/fake-agent (13 scenarios via FAKE_SCENARIO) drives 28 new tests: handshake, prompt→text, usage, cancel, handshake_timeout, spawn_failed, transport_lost with stderr excerpt, orphaned-stdout exit, early updates, fs/* warning, resume, permission, depth, tree kill incl. grandchild. Verified: pnpm typecheck clean, pnpm test 56/56, no fake-agent processes left after the suite, no @modelcontextprotocol import under src/acp.
<!-- SECTION:FINAL_SUMMARY:END -->
