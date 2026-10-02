---
id: THRONG-12
title: list_thronglets and cancel_thronglet
status: Done
assignee:
  - '@nodge'
created_date: '2026-10-02 09:53'
updated_date: '2026-10-02 15:52'
labels: []
milestone: m-1
dependencies:
  - THRONG-11
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
With background turns (THRONG-11) the caller loses track of what runs: it needs to see its thronglets, and it needs a way to stop one short of killing the server. Decision-6 adds two tools.

`list_thronglets()` merges the session records on disk (DESIGN §8) with the live state of this server process: `session_id`, `description`, agent spec, `cwd`, `state` (`running | queued | idle | failed`), queue length, `created_at`, `last_used_at`, `last_error` when failed. Records only say what survived: a record whose turn was running when the server died must not be shown as `running`; at startup such records are marked `failed` with `last_error` saying the turn was interrupted by a server restart. Records rotate out after 14 days as today.

`cancel_thronglet({session_id})`: `session/cancel` of the running turn (DESIGN §4.2 cancel path), the queue is dropped, a pending `wait_thronglet` resolves with the `cancelled` failure payload, the session becomes `idle` and can take a new message. Cancelling an idle session is a no-op success.

Scope: DESIGN §3 (two tools), §8 as updated by decision-6.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `list_thronglets` lists every session record with description, agent, cwd, state, queue length, timestamps and last error
- [x] #2 A record whose turn was running when the server process died is listed as `failed` with an error that names the restart, never as `running`; covered by a test that restarts the server
- [x] #3 `cancel_thronglet` on a running session cancels the turn and drops the queue; a pending `wait_thronglet` returns the `cancelled` failure payload; the session accepts a new `send_message` afterwards
- [x] #4 `cancel_thronglet` on an idle session succeeds without side effects; unknown id → `session_not_found`
- [x] #5 fake-agent tests cover list states across running/queued/idle/failed and cancel with a pending wait
- [x] #6 Smoke: list shows a running background thronglet with its description; cancel stops it on claude, codex and opencode
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-12 — list_thronglets and cancel_thronglet

Repo: /Users/nodge/Sites/throng-mcp, branch v2. Runs as `node src/mcp.ts`, no build: erasable TS only, `import type`, imports end in `.ts`, `exactOptionalPropertyTypes` (`...(x ? { x } : {})`), `noUncheckedIndexedAccess`. Tests: vitest next to the code, fake agent only (`test/fake-agent`, knobs in `test/fake-agent/index.ts`: scenarios `echo`, `hang`, `resume-memory`…, env `FAKE_TURN_MS`; sandbox helper `test/fake-harness.ts` with `fakeClaude`, `makeCtx`, `record`, `cleanup`). Gates: `pnpm typecheck && pnpm lint && pnpm test`. Don't touch `backlog/`, don't commit. DESIGN is already written (decision-6): §3.7 `list_thronglets`, §3.8 `cancel_thronglet`, §8 (record fields, `turn_pid`, lock-holder-only writes, startup marking). If the code can't match DESIGN, say so in deviations instead of editing DESIGN. Out of scope: `steer` (THRONG-13).

Contract types already exist in `src/contract.ts` (do not edit it): `SessionState`, `ThrongletInfo`, `ListThrongletsOutput`, `CancelThrongletOutput { session_id; state: 'idle'; cancelled_turn: boolean }`. Tool results are one JSON text block (`src/mcp/result.ts` `toolResult`; list/cancel outputs are plain success blocks, failures are tool errors with the `RunFailure` payload like every other tool).

## What exists (THRONG-9, THRONG-11)
- `src/registry.ts` `SessionRegistry`: `acquire(id, signal, onQueued) → release` (FIFO lock; the entry exists from the synchronous start of `acquire` until the holder and all waiters are gone), `busy(id)`, `waiting(id)`, `idle(id): Promise<void>`, `attachTurn(id, controller) → detach` and `turns(id): AbortController[]` (today only `startBackground` attaches, at acceptance).
- `src/run.ts` `runCall(call, ctx)`: `RunLifecycle(ctx.signal)` is created at the top; `ctx.signal` abort → `cancelled` through the lifecycle (session/cancel, grace, close) and through the queue waits (`sessions.acquire(…, ctx.signal)`, semaphore). Only the lock holder (`lockedId`) writes the turn's fields and outcome into the record (`endTurn`). A synchronous call's `ctx.signal` is the MCP call's `extra.signal`; a background call's is the detached controller from `src/background.ts`.
- `src/sessions.ts`: `SessionRecord { harness, model, effort?, cwd, description, created_at, last_used_at, turn_started_at?, turn_pid?, last_result?, last_error? }`, `readSessionRecord`, `loadSessionRecord` (throws `session_not_found`), `updateSessionRecord`, `endTurn`, `pidAlive`, `markTurnInterrupted(dir, id, stale?, message?)`, `markInterrupted(dir)` (startup), `rotate`, `INTERRUPTED_MESSAGE`. `listSessionIds(dir)` exists but is private: export it.
- `src/wait.ts` `waitThronglet`: resolves the state of one record (busy here → wait idle; `turn_started_at` with a live foreign pid → poll; dead or own pid → mark interrupted; then `last_result` / `last_error`). Its per-record state logic is what `list_thronglets` needs too: extract the shared part (see below) rather than duplicating it.
- Tools: `src/mcp/tools/{run-thronglet,send-message,wait-thronglet,list-harnesses}.ts`, registered in `src/mcp/tools.ts` (`ToolEnv { loaded, sessions, cacheDir, callRun, callBackground, track }`).
- `src/mcp.ts`: `rotate` then `markInterrupted` at startup.

## What to build

### 1. Every turn is cancellable from the registry
Today `cancel_thronglet` could only reach background turns (their controllers are attached). A synchronous `run_thronglet`/`send_message` turn, and a synchronous call queued behind one, must be cancellable too. In `runCall`:
- Create `const cancel = new AbortController()` and `const signal = AbortSignal.any([ctx.signal, cancel.signal])` at the top; pass `signal` (not `ctx.signal`) to `RunLifecycle`, to `sessions.acquire`, and anywhere else `ctx.signal` is used inside `runCall`.
- Attach `cancel` to the registry entry as soon as the entry exists: for `resume`, call `sessions.acquire(...)` and `sessions.attachTurn(id, cancel)` back to back before awaiting the acquire (the entry is created synchronously inside `acquire`); for `new`, right after the acquire at `sessionId`. Detach in the cleanup (`finally`, next to `unlockSession`).
- `src/background.ts` then no longer needs its own `attachTurn` (its controller is `ctx.signal`, already part of `signal`): remove that attach/detach and the `turns` bookkeeping it did; keep its behavior otherwise. Keep `attachTurn`/`turns` on the registry (now fed by `runCall`).
- A cancel through `cancel.abort()` must produce the same `cancelled` failure as a client cancel: lifecycle's `cancelled by the client` message becomes `cancelled` with a message that says which (e.g. `cancelled by cancel_thronglet` vs `cancelled by the client`); pass the reason through the abort reason or a flag, whichever is smaller. The `cancelled` payload goes into the record as `last_error` via `endTurn` as today.

### 2. Session state of a record, shared by wait and list
- New module `src/session-state.ts` (or a well-named section of `wait.ts`): `resolveState(id, record | undefined, sessions): { state: SessionState; queued: number; foreign?: number }` plus the "mark interrupted when the owner is gone" step factored out of `waitThronglet` so both callers use one implementation:
  - busy in this process → `queued` if `sessions.waiting(id) > 0` else `running`; `queued = sessions.waiting(id)`.
  - not busy, `turn_started_at` set, `turn_pid` alive and foreign → `running`, `queued: 0`, `foreign: pid` (another throng server instance owns it).
  - not busy, `turn_started_at` set, pid dead or own → `markTurnInterrupted` (same rules as wait today) → then as below.
  - `last_error` → `failed`; otherwise `idle` (also for `last_result` and for records without any result).
- `waitThronglet` keeps its loop but takes the per-record decision from the shared code (no behavior change; its tests stay green).

### 3. `list_thronglets` (DESIGN §3.7)
- `src/list-thronglets.ts` (logic) + `src/mcp/tools/list-thronglets.ts` (tool, `inputSchema: {}`, `track`ed like list_harnesses). Output `ListThrongletsOutput`.
- For every id from `listSessionIds(cacheDir)` plus every id busy in the registry without a record yet (a new session between `acquire` and `writeSessionRecord` is a tiny window; include it only if cheap, otherwise skip and say so): read the record (`readSessionRecord`; junk → skip with one `log.warn`, never fail the whole list), resolve the state (section 2), build `ThrongletInfo`: `agent` = `${harness}/${model}` + (`:${effort}` when set), `last_error` = `{ code, message }` of the record's `last_error` only when `state === 'failed'`. Sort by `last_used_at` descending.
- Description: `Lists thronglet sessions on this machine: description, agent, cwd, state (running | queued | idle | failed), queue length, timestamps and the last error. Live state is this server's; a session run by another throng instance shows what its record says.`

### 4. `cancel_thronglet` (DESIGN §3.8)
- `src/cancel.ts` (logic) + `src/mcp/tools/cancel-thronglet.ts` (`inputSchema: { session_id: z.string() }`, `track`ed). Output `CancelThrongletOutput`.
- Algorithm:
  1. Not busy here: `loadSessionRecord` (unknown → `session_not_found` tool error). If its `turn_started_at` is set and `turn_pid` is a live foreign pid → tool error `agent_error`, message `turn of <id> runs in another throng server process (pid <n>); cancel it from the session that started it`. Otherwise (idle/failed, or dead/own pid which the shared state code marks interrupted) → `{ session_id, state: 'idle', cancelled_turn: false }`.
  2. Busy here: `cancelled_turn = true`; abort every controller in `sessions.turns(id)` (the running turn and every queued waiter, synchronous or background: the waiters leave the queue with `cancelled`, the running turn goes through `session/cancel` → grace → close and records `cancelled` as `last_error`); then await `sessions.idle(id)` bounded by `cancelGraceMs + exitGraceMs + 5 s` (take the values from config/ctx like runCall does; a plain 30 s constant is acceptable if the config values aren't reachable, say so). Idle → `{ session_id, state: 'idle', cancelled_turn: true }`. Not idle in time → tool error `agent_error`, message `turn of <id> did not stop within <n> s`.
- A pending `wait_thronglet` on the session resolves by itself once the registry goes idle: it reads the record and returns the `cancelled` failure payload (`isError`). No extra wiring; cover it with a test.
- Description: `Cancels the session's running turn (session/cancel) and drops its queued messages; a pending wait_thronglet returns the cancelled error. The session is idle afterwards and accepts a new send_message. No-op on an idle session.`

### 5. Register, README, smoke
- `src/mcp/tools.ts`: register both tools; tool list order `['cancel_thronglet', 'list_harnesses', 'list_thronglets', 'run_thronglet', 'send_message', 'wait_thronglet']` or whatever order the SDK reports: update the `mcp.test.ts` assertion to the actual sorted list.
- README: sections for both tools (input, output, the foreign-process case, the restart marking already described under wait), tool names list, smoke flag.
- `scripts/smoke/smoke.ts`: add `--cancel`: after a background `run_thronglet` is accepted, call `list_thronglets` and check the row (same `session_id`, `description: 'smoke: ping/pong'`, `state: 'running'`), then `cancel_thronglet` → `cancelled_turn: true`, then `wait_thronglet` → tool error with `code: 'cancelled'`, then `list_thronglets` shows `state: 'failed'` with `last_error.code === 'cancelled'`; skip the follow-up step. `smoke.test.ts` drives `--cancel` against the fake agent (`hang` scenario; make the fake-agent smoke config choose the scenario per flag if it doesn't already).

### 6. Tests (fake agent only)
- `src/registry.test.ts`: `turns(id)` returns the controllers attached by `runCall` for a running synchronous turn and a queued one; aborting them ends both (use `hang` + a queued echo).
- `src/run.test.ts`: a synchronous `hang` turn cancelled through its registry controller fails `cancelled` with the cancel_thronglet message, the record's `last_error.code` is `cancelled`, the adapter is gone, the lock is released.
- `src/list-thronglets.test.ts` (new): states across one listing: a `hang` background turn → `running`; a second background `send_message` on it → `queued` with `queued: 1`; a finished echo session → `idle`; a record with `last_error` → `failed` with `last_error {code, message}`; a record with `turn_started_at` and a dead pid → `failed` with `transport_lost` and the record updated; a record with a live foreign pid (child `sleep`) → `running`; junk file skipped; `agent` string with and without effort; sort order.
- `src/cancel.test.ts` (new): cancel a running background turn with a pending `wait_thronglet` → cancel returns `cancelled_turn: true`, wait returns the `cancelled` failure, the session is idle and a new echo `send_message` succeeds; cancel with a queued synchronous `send_message` → that call fails `cancelled`, queue empty; cancel on an idle session → `cancelled_turn: false`; unknown id → `session_not_found`; foreign live pid → `agent_error` with the message above.
- `src/mcp.test.ts` (stdio): tool list; `list_thronglets` after a background run shows the row with its description; `cancel_thronglet` over stdio on a `hang` background run → `cancelled_turn: true` and `wait_thronglet` → `cancelled`; a server restarted after SIGKILL mid-turn lists the session as `failed` with `transport_lost` (extend the existing SIGKILL test).

## Acceptance criteria (from the task)
1. `list_thronglets` lists every session record with description, agent, cwd, state, queue length, timestamps and last error.
2. A record whose turn was running when the server process died is listed as `failed` with an error that names the restart, never as `running`; covered by a test that restarts the server.
3. `cancel_thronglet` on a running session cancels the turn and drops the queue; a pending `wait_thronglet` returns the `cancelled` failure payload; the session accepts a new `send_message` afterwards.
4. `cancel_thronglet` on an idle session succeeds without side effects; unknown id → `session_not_found`.
5. fake-agent tests cover list states across running/queued/idle/failed and cancel with a pending wait.
6. Smoke on real harnesses is the maintainer's; `--cancel` must work against the fake agent.

Report in `summary`: how the cancel reaches synchronous turns and queued waiters, the shared state resolver's rules, and every deviation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_bed15720-4b6: Opus coder, gates green (232 tests), Opus review 2 findings, Codex review 1. Confirmed and fixed (verified by a separate Opus): f3 (Codex, major) a cancel arriving during the holder teardown (after the outcome was fixed, before the lock release) reported cancelled_turn: true while the record kept last_result → runCall detaches its controller the moment the outcome is fixed, cancel returns cancelled_turn: false when no controller is left, and a cancel that aborted before the outcome was fixed overrides an ok outcome with cancelled so reply and record agree; f1 (Opus, minor) stop bound ignored a lingering handshake → bound = max(handshake_s, cancelGrace) + 3×exitGrace + 5 s (80 s with defaults). Deferred minor: a send_message that joins the queue after cancel took its snapshot of controllers is not aborted and cancel waits for it (a race the caller creates by sending concurrently with its own cancel; whether such messages should be dropped is a design question). Coder deviations accepted: 3×exitGrace in the bound (worker close waits exitGrace three times); a new session between handshake and record write is not listed; smoke --cancel skips the pong.txt check and always runs in background; run.test "new session is busy" hardened to wait for a .json file (an atomic-write temp file was the likely flake). Spot-checked by the main session: src/run.ts (cancel controller + AbortSignal.any, lockSession attaches before awaiting acquire, detach at outcome), src/cancel.ts, src/session-state.ts (shared resolver for wait/list/cancel). Gates re-run: tsc 0, eslint 0, vitest 22 files / 232 tests.

Smoke 2026-10-02 (maintainer): pnpm smoke:claude -- --cancel — background run accepted, list_thronglets shows the row running with description "smoke: ping/pong", cancel_thronglet → cancelled_turn: true (turn ended cancelled in 0.6 s), wait_thronglet → cancelled "cancelled by cancel_thronglet", list shows failed with last_error cancelled; no orphans. SMOKE PASSED on claude/sonnet; codex and opencode pending for AC #6.

2026-10-02: nodge accepted the smoke (AC #6) as passed; any bugs will be filed separately.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
list_thronglets (src/list-thronglets.ts) merges session records with the live registry through the shared resolver src/session-state.ts: running | queued | idle | failed, queue length, agent spec, last_error, dead-owner turns marked transport_lost while listing; cancel_thronglet (src/cancel.ts) aborts the registry controllers of the running turn and queued waiters, waits for idle within a bound derived from handshake/cancel/exit graces, no-op on idle, agent_error for a turn owned by another live throng process. Every turn (sync, background, queued) now registers its own AbortController in the registry and detaches it once its outcome is fixed. Verified: tsc 0, eslint 0, vitest 232/232 incl. list states, cancel with pending wait, cancel during teardown, SIGKILL restart listed as failed over stdio, smoke --cancel against the fake agent. Maintainer smoke (AC #6) accepted by nodge on 2026-10-02 without a recorded run; bugs come as separate tasks.
<!-- SECTION:FINAL_SUMMARY:END -->
