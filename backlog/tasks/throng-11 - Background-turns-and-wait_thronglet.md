---
id: THRONG-11
title: Background turns and wait_thronglet
status: Review
assignee:
  - '@nodge'
created_date: '2026-10-02 09:53'
updated_date: '2026-10-02 10:58'
labels: []
milestone: m-1
dependencies:
  - THRONG-9
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A `run_thronglet` call blocks the calling session for the whole turn, up to 6 h. Claude Code moves MCP calls over 120 s to the background on its own (DESIGN §2.4), Codex and OpenCode as callers do not, and nothing lets the caller start several thronglets, do other work, and come back for the results. Decision-6 adds `background: true` to `run_thronglet` and `send_message`: the call returns `{session_id, state}` as soon as the ACP session exists and the turn is running (so a failing handshake or model selection still fails the call synchronously); the turn continues inside the server process, and `wait_thronglet({session_id, timeout_s?})` blocks until the session is idle: no turn running and the queue empty. It then returns the last turn`s payload, success or the tool error with the failure payload, exactly as the synchronous call would have. On `timeout_s` it returns `{state: running | queued, queued: n, ...}` and that is not an error, so an orchestrator can poll. Results and failures are persisted in the session record, so `wait_thronglet` is idempotent and answers after a server restart.

The semaphore slot (DESIGN §7) is held only while a turn runs; idle sessions cost nothing. Server shutdown closes running workers as today (§4.2 step 7); the record of a turn interrupted that way must say so (THRONG-12 shows it). `wait_thronglet` sends progress heartbeats like a run, so the client idle timeout does not fire.

Scope: DESIGN §3 (background flag, `wait_thronglet`), §7, §8 (record fields for the last result) as updated by decision-6. Depends on the queue and session state from THRONG-9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `run_thronglet` and `send_message` with `background: true` return `{session_id, state}` once the turn has started; handshake, model and depth errors still fail the call itself
- [x] #2 `wait_thronglet` returns the last turn`s success payload, or the tool error with its failure payload, only when no turn is running and the queue is empty
- [x] #3 `wait_thronglet` with `timeout_s` elapsed returns the session state and queue length as a normal result, not an error
- [x] #4 Calling `wait_thronglet` twice returns the same result; a result written before a server restart is returned after it
- [x] #5 A background turn holds a semaphore slot only while running; an idle session holds none; covered by tests
- [x] #6 fake-agent tests cover: background run then wait; message queued behind a running turn then wait resolves after both; wait timeout while running
- [ ] #7 Smoke: two background thronglets on different harnesses started from one session, both results collected with `wait_thronglet`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-11 — background turns and wait_thronglet

Repo: /Users/nodge/Sites/throng-mcp, branch v2. Runs as `node src/mcp.ts`, no build: erasable TS only, `import type`, imports end in `.ts`, `exactOptionalPropertyTypes` (`...(x ? { x } : {})`), `noUncheckedIndexedAccess`. Tests: vitest next to the code, fake agent only (`test/fake-agent`; knobs documented in `test/fake-agent/index.ts`, incl. `FAKE_TURN_MS` from THRONG-9 and the `hang` scenario). Gates: `pnpm typecheck && pnpm lint && pnpm test`. Don't touch `backlog/`, don't commit. DESIGN is already written for this contract (decision-6): read §3.2 (`background`), §3.3, §3.6 (background turns, `wait_thronglet`), §7 (semaphore counted in running turns), §8 (record fields `turn_started_at`, `last_result`, `last_error`). If the code can't match DESIGN, report it in deviations rather than editing DESIGN. Out of scope: `steer` (THRONG-13), `list_thronglets` and `cancel_thronglet` (THRONG-12). Do leave the hook THRONG-12 needs (see Registry below).

Contract types already exist in `src/contract.ts` (do not edit that file): `SessionState = 'running' | 'queued' | 'idle' | 'failed'` and `TurnPending { session_id; state: 'running' | 'queued'; queued: number }`. Tool results stay one JSON text block (decision-2): a `TurnPending` is a success result; failures are tool errors with the `RunFailure` payload.

## What exists (THRONG-9)
- `src/registry.ts` `SessionRegistry`: per-session FIFO lock (`acquire(sessionId, signal, onQueued) → release`, `busy(id)`, `waiting(id)`), entry dropped when the holder and all waiters are gone.
- `src/run.ts` `runCall(call, ctx)`: never throws; `RunContext { loaded, depth, semaphore, sessions, signal, progress, env?, now?, cacheDir, cancelGraceMs?, exitGraceMs? }`. Order: `call.request()` → guards → (session lock for resume) → semaphore → `lifecycle.arm(timeout)` → `progress.started()` → worker handshake → (session lock + record write for new) → mode/model/effort → `turn(...)` (+ structured corrective turns) → `finish(...)`; cleanup: `progress.done()`, `lifecycle.close()`, `touchSessionRecord`, session lock released via `lifecycle.whenGone`.
- `src/mcp/tools.ts`: `ToolDeps { loaded, semaphore, sessions, cacheDir }`, `ToolEnv.callRun(extra, start)` builds the `RunContext` from the MCP call (`extra.signal`, `createProgress(extra)`), tracks the promise in `inflight` so `drain()` waits at shutdown, serializes the outcome. Tools: `tools/run-thronglet.ts`, `tools/send-message.ts`, `tools/list-harnesses.ts`.
- `src/sessions.ts`: `SessionRecord { harness, model, effort?, cwd, description, created_at, last_used_at }`, `writeSessionRecord`, `readSessionRecord` (old records get `description: ""`), `touchSessionRecord`, `rotate` (14 days, run at startup in `src/mcp.ts`).
- `src/progress.ts` `Progress { queued, started, tool, text, done, idle }`, `noProgress`; `src/mcp/progress.ts` `McpProgress` with a 30 s heartbeat ("queued …" before `started()`, "running …" after).

## What to build

### 1. Turn results in the session record (DESIGN §8)
- `SessionRecord` gains: `turn_started_at?: string` (ISO), `turn_pid?: number` (the server process running the turn: records are shared by every throng server instance on the machine, so a pid is the only way to tell "running elsewhere" from "died"), `last_result?: RunSuccess`, `last_error?: RunFailure`. `last_result` and `last_error` are mutually exclusive: writing one deletes the other.
- Add `updateSessionRecord(dir, id, patch | (record) => record)` in sessions.ts (read-merge-write atomic, like `touchSessionRecord`; fold `touchSessionRecord` into it or keep it as a thin wrapper).
- In `runCall`, for every call (synchronous or background): when the turn is about to start (right before the first `turn(...)`, after mode/model/effort), write `turn_started_at = now, turn_pid = process.pid` (for a new session, include them in the initial `writeSessionRecord` instead of a second write). In the cleanup, where `touchSessionRecord` is called today, write `last_result` (the success payload) or `last_error` (the failure payload) and delete `turn_started_at` / `turn_pid`, in one update together with `last_used_at`. A failure before the turn started (guards, handshake, model) is also recorded as `last_error` when a `session_id` exists (resume path), so `wait_thronglet` can report it; for a brand-new session that never got an id there is no record and nothing to write.
- Startup (`src/mcp.ts`, next to `rotate`): a new `markInterrupted(dir)` in sessions.ts: every record with `turn_started_at` set whose `turn_pid` is not alive (`process.kill(pid, 0)` throws ESRCH; EPERM counts as alive) gets `last_error = { code: 'transport_lost', message: 'turn interrupted: the throng server process that ran it is gone', duration_s: 0 }` and loses `turn_started_at` / `turn_pid`. Records owned by a live pid are left alone. Log one line per marked record.

### 2. Background turns (DESIGN §3.6)
- `background: z.boolean().optional().describe('Return as soon as the turn is running (or queued behind the session's current turn); collect the result with wait_thronglet')` on both `run_thronglet` and `send_message` input schemas.
- New `RunContext.onTurnStarted?: (sessionId: string) => void`, called by `runCall` right before the first `turn(...)` (same place as the `turn_started_at` write). Nothing else in `runCall` changes for background: it is the same function run under a different context.
- New module `src/background.ts`: `startBackground(start: (ctx: RunContext) => Promise<RunOutcome>, base: Omit<RunContext,'signal'|'progress'|'onTurnStarted'>, opts: { sessionId?: string; track: <T>(p: Promise<T>) => Promise<T> }): Promise<RunOutcome | { pending: TurnPending }>`:
  - Builds the detached context: its own `AbortController` (the client's signal is NOT used: a client cancel of the accepting call must not kill the turn), `progress` = a small Progress implementation that only observes (`queued()` resolves the acceptance with `state: 'queued'` when `opts.sessionId` is known, i.e. for send_message; for run_thronglet a semaphore wait just blocks the accepting call, since there is no session id to report yet), `onTurnStarted(id)` resolves the acceptance with `{ session_id: id, state: 'running', queued: registry.waiting(id) }`.
  - Runs `track(start(ctx))` so shutdown drains it; the outcome is persisted by `runCall` itself (section 1), nothing else needs to hold it.
  - Returns whichever comes first: the acceptance (`{ pending }`) or the run's own outcome (a failure before the turn started, e.g. `session_not_found`, `depth_exceeded`, `handshake_failed`, `model_rejected`, returned to the caller as the usual tool error; a success can't come first). Store the detached `AbortController` on the registry entry (`registry.attachTurn(sessionId, controller)` or similar) so THRONG-12's `cancel_thronglet` can abort it; nothing uses it yet.
- `src/mcp/tools.ts`: add `ToolEnv.callBackground(extra, start, sessionId?)` next to `callRun`, returning the `TurnPending` JSON block, or the failure as today. `run-thronglet.ts` / `send-message.ts`: `background ? env.callBackground(...) : env.callRun(...)`. Keep `callRun` unchanged for synchronous calls.
- Tool descriptions: append to run_thronglet: `With background: true the call returns {session_id, state, queued} as soon as the turn runs; collect the result with wait_thronglet.` Same sentence on send_message.

### 3. `wait_thronglet` (DESIGN §3.6)
- New tool file `src/mcp/tools/wait-thronglet.ts`; the logic in `src/wait.ts` so it is unit-testable: `waitThronglet({ session_id, timeout_s? }, deps: { sessions: SessionRegistry; cacheDir; signal; progress; now?; pollMs? }): Promise<RunOutcome | { pending: TurnPending }>`.
- Algorithm, repeated until done or `timeout_s` (default `config.limits.timeout_s`) elapses:
  1. If `sessions.busy(id)` in this process: await the registry becoming idle for that id (add `SessionRegistry.idle(id): Promise<void>`, resolved when the entry is dropped; resolves at once when not busy). Race it with the timeout and the client signal.
  2. Read the record. Missing and not busy → `session_not_found` (same message style as send_message's `loadRecord`).
  3. Record has `turn_started_at`: if `turn_pid` is alive and not our pid → the turn runs in another throng instance: sleep `pollMs` (default 1000) and repeat. If the pid is dead → mark it interrupted exactly like `markInterrupted` (reuse the helper) and fall through.
  4. Record has `last_result` → success outcome with it; `last_error` → failure outcome with it (isError, same payload shape). Neither (an old record, no turn recorded) → tool error `empty_result`, message `no turn result recorded for session <id>`.
- Timeout elapsed → `{ pending: { session_id, state: waiting(id) > 0 ? 'queued' : 'running', queued: waiting(id) } }` as a normal (non-error) result. Client cancel (signal) → stop waiting and return the same pending shape (the SDK drops the answer anyway).
- Progress: add `Progress.waiting(): void` ("waiting for the session's turns to finish; heartbeat 'waiting Xm' until done()") to `src/progress.ts`, `noProgress` and `McpProgress` (heartbeat text `waiting <elapsed>`). `wait_thronglet` calls it once at start; the heartbeat keeps the client's idle timeout away.
- Registration in tools.ts (`track` the call like list_harnesses does). Description: `Waits until a session has no running or queued turn and returns the last turn's result: the same JSON as run_thronglet, or its error. With timeout_s elapsed returns {session_id, state, queued} instead. Idempotent: the result is stored with the session.`

### 4. Tests (fake agent only)
- `src/sessions.test.ts`: `updateSessionRecord` merges and keeps atomic writes; `last_result` replaces `last_error` and vice versa; `markInterrupted` marks a record with a dead pid (use a pid that cannot exist, e.g. 2**22-1 after checking it is dead) and leaves one with `process.pid` alone.
- `src/registry.test.ts`: `idle(id)` resolves immediately when not busy, and after the last release otherwise; `attachTurn` is retrievable.
- `src/run.test.ts`: `onTurnStarted` fires once with the session id, after the record exists, before the agent's text arrives; after a synchronous echo run the record has `last_result` equal to the payload and no `turn_started_at`; after a `timeout` the record has `last_error` with `code: 'timeout'`; while a `hang` turn runs the record has `turn_started_at` and `turn_pid === process.pid`.
- `src/background.test.ts` (new): run_thronglet background with echo + `FAKE_TURN_MS=800`: acceptance arrives with `state: 'running'` well before the run finishes (< 800 ms after acceptance the registry is still busy), the semaphore has one slot taken while running and none after; `send_message` background on a busy session (hang + timeout_s 1) returns `state: 'queued', queued: 1` immediately; a background run that fails before the turn (e.g. `model_rejected` or a missing cwd → `spawn_failed`) returns that failure, not a pending; `track` sees the detached promise.
- `src/wait.test.ts` (new): wait on a finished session returns `last_result`; twice → same payload; wait during a running background turn resolves after it with the result; message queued behind a running turn (background send_message) → wait resolves only after both, with the second turn's result; wait with `timeout_s: 0.5` while running → pending with `state: 'running'`; unknown id → `session_not_found`; record with `turn_started_at` and a dead pid → marked interrupted and returned as `transport_lost`; record with `turn_started_at` and a live foreign pid (use a child `sleep` process's pid, then kill it) → polls, then returns once the record changes.
- `src/mcp.test.ts` (stdio): tool list `['list_harnesses', 'run_thronglet', 'send_message', 'wait_thronglet']`; `run_thronglet { background: true }` returns a pending JSON; `wait_thronglet` on it returns the echo payload; a result written before a server restart is returned after it (start a second server on the same cache dir and wait); a server killed with SIGKILL mid-turn → the next server marks the record interrupted and `wait_thronglet` returns `transport_lost`.
- `scripts/smoke/smoke.ts`: add `--background`: run_thronglet with `background: true`, print the pending JSON, `wait_thronglet` → the same checks as the synchronous run; then the follow-up as `send_message` with `background: true` + `wait_thronglet`. `smoke.test.ts` drives `--background` against the fake agent. The two-harness dogfood of AC #7 is the maintainer's from a real session; make sure a background run of one harness works end to end in the smoke.

### 5. README
- Document `background` on both tools, `wait_thronglet` (input, the two result shapes, idempotence, the restart behavior), the new record fields under "Files on disk", `--background` in the smoke section. Short; the DESIGN carries the rationale.

## Acceptance criteria (from the task)
1. `run_thronglet` and `send_message` with `background: true` return `{session_id, state}` once the turn has started; handshake, model and depth errors still fail the call itself.
2. `wait_thronglet` returns the last turn's success payload, or the tool error with its failure payload, only when no turn is running and the queue is empty.
3. `wait_thronglet` with `timeout_s` elapsed returns the session state and queue length as a normal result, not an error.
4. Calling `wait_thronglet` twice returns the same result; a result written before a server restart is returned after it.
5. A background turn holds a semaphore slot only while running; an idle session holds none; covered by tests.
6. fake-agent tests cover: background run then wait; message queued behind a running turn then wait resolves after both; wait timeout while running.
7. Smoke on real harnesses is the maintainer's.

Report in `summary`: the exact record shape, the acceptance race in `startBackground` (what resolves it and when), how `wait` handles the foreign-pid case, and every deviation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_ccd9901e-b4c: Opus coder, gates green (218 tests), Opus review 3 findings, Codex review 2. Confirmed and fixed (verified by a separate Opus): f1 callBackground ignored the client call (no progress/heartbeat while a background run_thronglet waited for a slot or handshake; a dropped call still ran a full turn) → progress forwarded until acceptance, client cancel aborts the detached run only before acceptance; f2 a background send_message waiting for a semaphore slot was accepted as queued:0 → Progress.queued carries behind: session|slot, only the session wait accepts as queued. Deferred minor: registry.idle() resolvers of timed-out waits stay until the session ends (memory only). Applied by the main session: at startup a record with turn_pid === process.pid counts as gone (recycled pid; was deferred f3), test adjusted to use process.ppid as the live foreign pid. Coder deviations accepted: failures before the session lock (guards, cancel while queued, missing record) are not written to the record, only the lock holder writes turn fields (DESIGN §8 updated to say so); own-pid + not-busy record is marked transport_lost "turn ended without recording its result"; attachTurn returns detach and also covers queued background turns (hook for THRONG-12 cancel); loadRecord moved to sessions.loadSessionRecord; src/mcp/result.ts, test/fake-harness.ts, Semaphore.active added. Known limits recorded by the coder: wait on a turn in another server process reports state running without that process queue length; two server processes running turns on one session can still race on the record. DESIGN §3.7/§8 updated by the main session: turn_pid, pid-based startup marking, lock-holder-only writes. Gates re-run after the fix: tsc 0, eslint 0, vitest 20 files / 218 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
background: true on run_thronglet and send_message (src/background.ts: detached context, acceptance on onTurnStarted or on the session-queue wait, pre-turn failures still fail the call, client cancel stops the run only before acceptance); wait_thronglet (src/wait.ts) resolves when the session is idle with the stored last_result/last_error, returns {session_id, state, queued} on timeout, polls records of turns owned by other live server processes, marks dead-owner turns transport_lost; session record carries turn_started_at, turn_pid, last_result | last_error, written by the lock holder; markInterrupted at startup; Progress.waiting heartbeat; smoke --background. Verified: tsc 0, eslint 0, vitest 218/218 incl. background acceptance/slot/cancel tests, wait idempotence, wait across a server restart and after SIGKILL mid-turn over stdio. Pending: maintainer smoke/dogfood (AC #7) — status Review.
<!-- SECTION:FINAL_SUMMARY:END -->
