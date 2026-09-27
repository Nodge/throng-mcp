---
id: THRONG-4
title: run_thronglet
status: Done
assignee:
  - '@fable'
created_date: '2026-09-27 18:56'
updated_date: '2026-09-27 21:01'
labels: []
milestone: m-0
dependencies:
  - THRONG-3
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The tool itself and the point of v1. Only the `auto` permission policy ships now; the others come in v2. Session records are written already, so v1 sessions become resumable once `resume_thronglet` lands.

Scope: DESIGN §3.2, §5 (auto row only), §7, §8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `run_thronglet` input and output match DESIGN §3.2, including failures as tool errors with an `ErrorCode`
- [x] #2 Policy `auto` means native auto mode plus `allow_once` on every request; any other policy in config is a config error "not supported yet"
- [x] #3 Semaphore, depth guard, timeouts and progress notifications behave per DESIGN §7
- [x] #4 Session records and per-call transcripts are written per DESIGN §8
- [x] #5 Integration tests run the full call through fake-agent
- [x] #6 `run_thronglet` checks the adapter command before spawn: missing → `harness_unavailable` with the install command, not `spawn_failed`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THRONG-4 — run_thronglet. Goal: the tool itself. One call = parse the agent spec → guards (config, depth, adapter present) → semaphore → Worker → policy `auto` → model/effort → prompt with the executor prefix → fold the result → DESIGN §3.2 payload. Failures are MCP tool errors with the §3.2 failure payload and an ErrorCode, never exceptions. Session records and per-call transcripts are written. resume_thronglet, structured output and the other permission policies are v2 (not this task).

READ FIRST: docs/DESIGN.md §3.1, §3.2 (contract — read twice), §4 (layout: run.ts, permissions.ts, progress.ts, semaphore.ts, sessions.ts, prompt.ts), §4.2 (Cancel paragraph), §4.3, §5 (auto row only), §7 (all of it), §8 (config, session records, logs, rotation). AGENTS.md "Code rules". Contract files by the main session — implement against them, don't change exported shapes (gaps → deviations): src/contract.ts (runThrongletInput zod raw shape, RunSuccess, RunFailure, StopReason), src/errors.ts (ErrorCode, ThrongError, toThrongError(err, context) merges the caller's context), src/acp/types.ts (Worker; `session.configOptions` is refreshed by setConfigOption), src/harnesses/types.ts, src/prompt.ts (`buildPrompt(task)` = executor prefix + task; use it, don't rewrite the text).

ALREADY IN THE TREE (all green, 94 tests): src/acp/{worker,process,collector}.ts — `startWorker(spawn, start, hooks, limits)`, `closeAllWorkers()` (server shutdown), `Collector` (startTurn/handle/endTurn/text/usage/warnings/events/lastToolTitle); src/harnesses — `harnessById(id)`, `loadRegistry()`, `def.resolve(config, registry, env)` → `{available, launch{command,args,env}} | {available:false, reason}` (reason already contains the install hint), `selectModel(worker, model)` (throws model_rejected), `selectEffort(def, worker, effort)` → warning | undefined, `def.permissionSetup(policy)` → `{ modeId?, env?, newSessionMeta? }`, `listHarnesses` in probe.ts; src/config.ts — `loadConfig()` → `{config, error?, path}`, `readDepth()`, `config.permissions`, `config.harnesses.<id>.permissions`, `config.limits.{timeout_s, handshake_s, elicitation_s, max_concurrency, max_depth}`; src/mcp.ts — McpServer + stdio, `list_harnesses` registered, `inflight` tracking + `shutdown()` that closes the server, `closeAllWorkers()`, awaits in-flight calls, exits; src/agent-spec.ts — `parseAgentSpec(spec)` throws ThrongError (harness_unavailable / model_rejected); test/fake-agent — scenarios via FAKE_SCENARIO (echo, permission, notice, hang, handshake-hang, crash-on-prompt, fs-call, grandchild, no-resume, orphan-exit, orphan-crash, early-update, no-effort-option), `fakeAgentSpawn(scenario)` → `{command, args, env, tag}`; echo answers `echo: <prompt> [model=… effort=…]`, usage tokens 10/5 per turn, cost 0.01 cumulative; test/mcp.test.ts has `serverEnv()` (PATH = temp dir with only node, THRONG_MCP_* stripped) and `callListHarnesses()` as patterns for driving the real server over stdio with the SDK client.

MCP SDK 1.30 FACTS (verified in node_modules/@modelcontextprotocol/sdk/dist/esm; cite these):
- Tool callback `(args, extra) => CallToolResult`; `extra: RequestHandlerExtra` has `signal: AbortSignal` (aborted by `notifications/cancelled` from the client — shared/protocol.js `_oncancel` — and by transport close), `_meta?.progressToken` (string | number, present only when the client asked for progress), `sendNotification(n)`, `requestId`.
- Progress: `await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, total?, message? } })`; no-op after abort. Await each send (stdio backpressure), never fire a burst.
- After `extra.signal` aborts, the SDK drops whatever the callback returns (shared/protocol.js:368-393); still return a proper failure payload for symmetry, but don't wait on anything after cleanup.
- A thrown error inside the callback becomes `{ isError: true, content: [{ type: 'text', text: error.message }] }` — we never rely on that: run.ts returns the payload itself; mcp.ts wraps `{ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true|undefined }`. Invalid args (zod) are reported by the SDK as a tool error with the validation text before our code runs — fine, documented in DESIGN §3.2.
- There is no server-side timeout on inbound tool calls; `timeout_s` is ours.
- `server.server.getClientCapabilities()` exists (needed only in v2 for elicit).

BUILD:

1. src/semaphore.ts — `class Semaphore { constructor(max); acquire(signal?): Promise<() => void>; get waiting(): number }`. FIFO; `acquire` rejects with ThrongError `cancelled` when `signal` aborts while queued (and removes the waiter). Release is idempotent.

2. src/progress.ts — `createProgress(extra)`: returns `{ queued(n), tool(title), text(), heartbeat start/stop, done() }` or a no-op object when `extra._meta?.progressToken` is undefined. Rules (DESIGN §7): a progress notification on every tool_call (message = title), on agent text at most once per 2 s (message `agent is writing… (<n> chars)`), a heartbeat every 30 s with elapsed time (`running <m>m<s>s`), `queued (n)` while waiting for the semaphore. `progress` = a monotonically increasing counter (1, 2, 3…), no `total`. Intervals injectable (`{ textEveryMs, heartbeatMs }`) so tests can use small values. `done()` clears the heartbeat timer. Sends are awaited and serialized (a simple promise chain); a failing send is swallowed and logged once.

3. src/permissions.ts — v1 = policy `auto` only. `resolvePolicy(config, harnessId): PermissionPolicy` (per-harness override, else global). `createPermissionBridge(policy, onDecision)` → `{ answer(request): Promise<RequestPermissionResponse>; cancelAll(): void }`: for `auto`: pick the option with `kind === 'allow_once'` → `{ outcome: { outcome: 'selected', optionId } }`; no such option → `{ outcome: { outcome: 'cancelled' } }`; never `allow_always`. `cancelAll()` answers every still-pending request with cancelled (for `auto` nothing pends, but the bridge keeps a pending set so THRONG-8 can drop in `elicit` without touching run.ts — DESIGN §4.2 "All pending request_permission are answered cancelled"). Each decision is reported through `onDecision({ title, kind, optionId | 'cancelled' })` for the transcript. Policies other than `auto` are refused before spawn: see run.ts step 2.

4. src/sessions.ts — `cacheDir(env)` = `THRONG_MCP_CACHE_DIR` or `~/.cache/throng`; `writeSessionRecord(dir, record)` / `touchSessionRecord(dir, sessionId)` / `readSessionRecord(dir, sessionId)` for `~/.cache/throng/sessions/<session_id>.json` = `{ harness, model, effort?, cwd, created_at, last_used_at }` (ISO strings); atomic write (tmp + rename); mkdir -p. `rotate(dir, maxAgeDays = 14)`: delete files under `sessions/` and `runs/` older than that (by mtime); called once at server start from mcp.ts; never throws (log and continue). The session id is the harness's own ACP session id (DESIGN §8).

5. src/transcript.ts (or inside sessions.ts — your call, keep it small) — one JSONL file per call at `<cacheDir>/runs/<ISO ts with : replaced>-<harness>-<sessionId or 'nosession'>.jsonl`, lines `{ ts, kind, ... }`: `input` (agent spec, cwd, prompt length only — never the prompt text), `update` (every ACP event from the collector's events, or streamed as they come), `permission` (decisions), `stderr` (tail at the end), `outcome` (payload without `text`, plus code). Written incrementally (append) so a crash leaves something; flushed/closed at the end. Log the transcript path to stderr once per call (DESIGN §8 "Logs").

6. src/run.ts — `runThronglet(input: RunThrongletInput, ctx: RunContext): Promise<RunOutcome>` where `RunContext = { loaded: LoadedConfig; depth: number; semaphore: Semaphore; signal: AbortSignal; progress: Progress; env?: NodeJS.ProcessEnv; now?: () => number; cacheDir: string }` and `RunOutcome = { ok: true; payload: RunSuccess } | { ok: false; payload: RunFailure }`. NEVER throws (wrap everything; unknown errors → `agent_error` via toThrongError). Steps, in order, each failure → `{ ok: false, payload }` with `duration_s` (from the moment the call started, excluding semaphore wait — DESIGN §7 says the queue wait doesn't count toward `timeout_s`; report duration_s as wall time of the actual run, and add a warning `queued <n> s` when the wait exceeded 1 s):
   a. `parseAgentSpec(input.agent)` (ThrongError → failure with its code).
   b. Config error (`loaded.error`) → `harness_unavailable`, message `config error: <error>` (never run on defaults when the user's config is broken — a broken config could have meant a stricter policy). Policy for this harness ≠ `auto` → `harness_unavailable`, message `permissions "<p>" is not supported yet (v2); set permissions: auto` (AC #2 "config error not supported yet").
   c. Depth: `ctx.depth + 1 > config.limits.max_depth` → `depth_exceeded` with both numbers.
   d. `def.resolve(config, registry, env)` unavailable → `harness_unavailable` with the resolution reason verbatim (AC #6: before spawn, not spawn_failed).
   e. `cwd` must exist and be a directory → `spawn_failed`? No: use `harness_unavailable`? Neither fits; use `agent_error` with message `cwd does not exist or is not a directory: <cwd>` — and list this choice in deviations so the main session can decide whether an `invalid_cwd` code is warranted.
   f. Semaphore: `progress.queued(n)` while waiting; abort while queued → `cancelled`.
   g. Start the clock. `timeout_s` = input or `config.limits.timeout_s`. `startWorker({ command, args, env: { ...launch.env, ...setup.env }, cwd, depth }, { kind: 'new', cwd, mcpServers: [], meta: setup.newSessionMeta? }, hooks, { handshakeMs: config.limits.handshake_s * 1000 })` where `setup = def.permissionSetup(policy)`; hooks: `onUpdate` → collector.handle + progress (tool title / text) + transcript; `onPermission` → bridge.answer; `onWarning` → warnings list. ThrongError from start → failure with its code (no session_id yet).
   h. Session exists: `writeSessionRecord`. From here every failure payload carries `session_id`, `text` (collector.text if non-empty), `usage`, `warnings`.
   i. `setup.modeId` → `worker.setMode(modeId)` (failure → `agent_error`; the mode is the permission policy's teeth). `selectModel` (model_rejected passes through). `selectEffort` → push the warning if any. Order: model before effort (effort values may depend on the model).
   j. `collector.startTurn(); progress.heartbeat start; await worker.prompt(buildPrompt(input.prompt))` raced against (1) `ctx.signal` abort → cancel path with code `cancelled`, (2) the timeout timer → same path with code `timeout`. Cancel path (DESIGN §4.2): `bridge.cancelAll()`, `worker.cancel()`, wait for the pending prompt to settle up to 5 s (injectable), then `worker.close()`; failure payload with session_id/text/usage/warnings.
   k. Stop reason mapping (§3.2): `end_turn` with empty collector.text → `empty_result`; `end_turn` / `max_tokens` / `max_turn_requests` → success `{ session_id, text, stop_reason, usage, duration_s, warnings? }` (omit `warnings` when empty); `refusal` → failure `refusal` with text; `cancelled` (agent-initiated, we didn't cancel) → failure `cancelled`. `usage` from the collector (`input_tokens`, `output_tokens`, `cost_usd`; omit undefined keys).
   l. Always: `progress.done()`, transcript outcome + stderr tail + close, `touchSessionRecord`, `worker.close()`, release the semaphore. `close()` must run even when the client already cancelled (the SDK drops our return value, but the process must not leak).

7. src/mcp.ts — register `run_thronglet` (description from §3.2: agent spec, self-contained prompt, absolute cwd; `inputSchema: runThrongletInput`): create the progress object from `extra`, call `runThronglet(args, { loaded, depth: readDepth(), semaphore, signal: extra.signal, progress, cacheDir })` wrapped in `track(...)`, return ONE JSON text block with `isError: true` for failures. One `Semaphore(config.limits.max_concurrency)` per process. Call `rotate(cacheDir)` at start (before `server.connect`). Keep `list_harnesses` and `shutdown()` as they are.

8. DESIGN sanity: `warnings` on success only when non-empty; `text` present on success (v1 has no structured). `duration_s` = seconds with 1 decimal.

TESTS (node:test; fake agent only; no leaked processes; every case uses a temp `THRONG_MCP_CACHE_DIR` and a temp config; assert the adapter process is gone after each call):
- test/semaphore.test.ts: FIFO order, `waiting` count, abort while queued rejects `cancelled` and doesn't hold a slot, double release is harmless.
- test/progress.test.ts: with a fake `extra` (records notifications): no token → nothing sent; tool titles sent; text throttled (textEveryMs 50 → two texts 10 ms apart = one notification); heartbeat fires with `heartbeatMs 30`; `done()` stops it; a rejecting `sendNotification` doesn't throw.
- test/permissions.test.ts: `resolvePolicy` global vs per-harness; `auto` picks `allow_once` by kind even when ids differ; no allow_once → cancelled; `cancelAll` on a bridge with a pending request (construct one directly) answers cancelled; decisions are reported.
- test/sessions.test.ts: write/read/touch round-trip, atomic file present, `rotate` deletes a file with an old mtime (utimes) and keeps a fresh one, missing dirs are fine.
- test/run.test.ts — call `runThronglet` directly with a config whose `harnesses.claude.command/args/env` point at the fake agent (so the harness id is `claude`, PATH is a temp dir with only node): (1) success: `echo` → `ok`, `text` = `echo: <prompt with prefix>…` — assert the text starts with `echo: ` and contains the task string AND the executor prefix's first sentence (proves buildPrompt), `stop_reason: end_turn`, `usage {input_tokens:10, output_tokens:5, cost_usd:0.01}`, `duration_s` a number, `session_id` present; the session record exists at `<cache>/sessions/<session_id>.json` with harness/model/cwd, the transcript file exists under `<cache>/runs/` with an `input` line without prompt text and an `outcome` line; (2) `agent: 'claude/fake-large:high'` → the echo shows `model=fake-large effort=high`; `claude/fake-small:max` → success with a warning naming `max`; `claude/nope` → `model_rejected` failure listing fake-small/fake-large, with `session_id` (the session existed); (3) unknown harness `gemini/x` → `harness_unavailable`; (4) adapter missing (no config override, empty PATH) → `harness_unavailable` whose message contains `npm i -g @agentclientprotocol/claude-agent-acp`; (5) depth: `ctx.depth = 2` with max_depth 2 → `depth_exceeded`; (6) config error (invalid yaml) → `harness_unavailable` starting with `config error:`; policy `deny_all` in config → `harness_unavailable` mentioning `not supported yet`; (7) `hang` + `timeout_s: 1` → `timeout` within ~2 s with `session_id`, adapter gone; (8) cancel: `hang`, abort `ctx.signal` after 200 ms → `cancelled`, adapter gone, `bridge.cancelAll` path exercised (permission scenario with a hook that never resolves is NOT needed: keep it simple); (9) `crash-on-prompt` → `transport_lost` with stderr `boom` and `session_id`; (10) new fake scenarios: `empty` (end_turn, no text) → `empty_result`; `refuse` (stopReason refusal with a short text) → `refusal` with `text`; `max-turns` (stopReason max_turn_requests) → success with that stop_reason; (11) notice → success with `warnings`; (12) semaphore: `max_concurrency: 1`, two concurrent `hang` calls with a shared Semaphore, the second sees `progress.queued(1)` (assert via a recording progress object), then cancel both; (13) `cwd` missing → the failure chosen in 6e; (14) progress: with a recording progress object and small intervals, an `echo` run produces at least one tool-title notification (`read README.md`) and the heartbeat fires for a `hang` run before cancel.
- test/mcp.test.ts additions: `run_thronglet` over the real stdio server: success payload is one text block with valid JSON and `isError` undefined; `claude/nope` → `isError: true` and JSON with `code: 'model_rejected'`; missing `cwd` arg → the SDK's validation tool error (assert `isError` true, don't assert the text); a relative `cwd` likewise (contract.ts refine); cancel via the client: `client.callTool(..., { signal })` aborted after 300 ms on a `hang` run → the call rejects on the client side and the adapter is gone within 2 s (that proves the server-side cleanup on `extra.signal`); progress: `client.callTool(params, CallToolResultSchema, { onprogress })` on an `echo` run receives at least one notification.

DON'T: implement resume_thronglet, structured output (schema is accepted by the input schema but ignored in v1 — add a warning `schema is not supported yet (v2); ignored` when present), elicit/allow_all/deny_all behavior; change the contract files; run real harnesses; touch ~/.cache, ~/.config, ~/.claude (always redirect via THRONG_MCP_CACHE_DIR / THRONG_MCP_CONFIG in tests); edit backlog/, docs/. Don't add dependencies.

GATES: `pnpm typecheck && pnpm test` green; `pgrep -f fake-agent` empty afterwards; the whole suite stays under ~30 s. Acceptance criteria covered: #1 payloads per §3.2 (success and failure, isError, codes); #2 auto = native auto mode + allow_once, other policies → config error "not supported yet"; #3 semaphore, depth, timeouts, progress per §7; #4 session records + transcripts per §8 (+ rotation); #5 integration tests through the fake agent; #6 missing adapter → harness_unavailable before spawn.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_1bd8a550-39f: Opus coder, gates green, dual review 9 findings → 2 confirmed and fixed (f1 minor: progress sends drained before the tool result — mcp.ts awaits progress.idle() unless aborted; f8 major: transcript filename collision for concurrent no-session failures — random suffix + flags wx), verified; spot-checked mcp.ts:69, transcript.ts:49-55. Deviations accepted: Progress interface queued/started/tool/text/done/idle; writeSessionRecord(dir, id, record); RunContext gained cancelGraceMs/exitGraceMs; permission bridge takes an optional decide() hook for THRONG-8; a cancel during the handshake answers at once and holds the semaphore slot until the late adapter is closed; mode-set failure after adapter death is transport_lost. Main session after the cycle: missing/non-dir cwd → spawn_failed (what spawn would return anyway; no new ErrorCode), stderr tail written to the transcript after worker.close() (f2), session-record write failure now also lands in payload.warnings (f9), contract.ts header + test comment fixed (f4/f5). DESIGN §3.2 (SDK validation is a tool error, not a protocol error) and §8 (THRONG_MCP_CACHE_DIR) synced by the main session. Deferred: f3 transcript lines are buffered until the handshake ends (a server SIGKILL inside that window leaves no file); Collector#events grows unbounded on multi-hour runs (run.ts streams the transcript from onUpdate and never reads events — candidate follow-up: drop or cap it).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
run_thronglet end to end: src/run.ts (guards → semaphore → Worker → auto policy → model/effort → executor-prefixed prompt → §3.2 payload, never throws), src/semaphore.ts, src/progress.ts (tool titles, throttled text, heartbeat, queued), src/permissions.ts (auto = allow_once by kind, cancelAll), src/sessions.ts (records + 14-day rotation, THRONG_MCP_CACHE_DIR), src/transcript.ts (per-call JSONL), src/prompt.ts; mcp.ts registers the tool with isError failures. Verified: pnpm typecheck clean, pnpm test 132/132 (38 new: semaphore, progress, permissions, sessions, 16 run cases incl. timeout/cancel/transport_lost/empty/refusal/depth/config-error/missing-adapter, mcp over stdio incl. client cancel and progress), no fake-agent processes left.
<!-- SECTION:FINAL_SUMMARY:END -->
