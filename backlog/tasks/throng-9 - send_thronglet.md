---
id: THRONG-9
title: send_message with a per-session turn queue replaces resume_thronglet
status: Done
assignee:
  - '@nodge'
created_date: '2026-09-28 15:33'
updated_date: '2026-10-02 15:52'
labels: []
milestone: m-1
dependencies:
  - THRONG-7
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A thronglet session is a sequence of turns. Today a turn is started by `run_thronglet` (first) or `resume_thronglet` (next), both synchronous, and nothing stops two callers from resuming one session at once: two adapter processes do `session/resume` on the same id. The background mode (THRONG-11) makes a busy session the normal case, so turns on one session must be serialized by throng itself. Spike 2026-10-02 (`scripts/spike/concurrent-prompt.ts`, notes below): a second `session/prompt` while a turn runs is delivered to the model by all three adapters, but the request/response pairing breaks differently in each (codex-acp never resolves the first prompt), so the queue cannot be left to the adapters.

Decision-6 fixes the contract: `send_message` is the one tool for a next turn, `resume_thronglet` is removed (v2 is not tagged; one user). `run_thronglet` gets a required `description` so that a session can be told apart in `list_thronglets` and after a server restart; it goes into the session record (DESIGN §8). This task delivers the synchronous form only: `background` and `wait_thronglet` are THRONG-11, `steer` is THRONG-13.

Queue semantics: FIFO per session, one turn per message, each with its own `schema`/`timeout_s`; a message arriving while a turn runs waits for `stop` and starts the next turn. Every turn runs in a fresh adapter process via `session/resume`, exactly as `resume_thronglet` does today (DESIGN §3.3): no keep-alive worker. A session has a state visible to later tools: `running | queued | idle | failed`. Live state is per server process; the record on disk is what survives.

Scope: DESIGN §3.2, §3.3, §4, §8 as updated by decision-6. README and the smoke script follow the rename.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `run_thronglet` requires `description`; the session record stores it
- [x] #2 `send_message({session_id, prompt, schema?, timeout_s?})` runs the next turn of the session synchronously and returns the `run_thronglet` payload; unknown id or a harness without `sessionCapabilities.resume` → `session_not_found`
- [x] #3 Two `send_message` calls on one session run one after the other, never two adapter processes on one session at a time; the second call waits in the queue and reports it in progress; covered by a fake-agent test
- [x] #4 `resume_thronglet` is gone from the tool list, README, DESIGN and the smoke script; `send_message` takes its place in all of them
- [x] #5 Smoke: `run_thronglet` then `send_message` on claude, codex and opencode; the second turn sees the first
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-9 — send_message with a per-session turn queue replaces resume_thronglet; required description

Repo: /Users/nodge/Sites/throng-mcp. Runs as `node src/mcp.ts`, no build: erasable TS only (no enums/namespaces/parameter properties), `import type`, imports end in `.ts`, `exactOptionalPropertyTypes` (use the `...(x ? { x } : {})` pattern), `noUncheckedIndexedAccess`. Tests: vitest next to the code, fake agent only (`test/fake-agent`), never a real LLM. Gates: `pnpm typecheck && pnpm lint && pnpm test`. Don't touch `backlog/`, don't commit. `docs/DESIGN.md` is already updated for this contract (decision-6): §3.2 (`description`), §3.3 (`send_message`, the **Queue** paragraph), §7 (queue wait excluded from `timeout_s`), §8 (record field `description`). If the code can't match DESIGN, say so in deviations instead of editing DESIGN. Do NOT implement `steer`, `background`, `wait_thronglet`, `list_thronglets`, `cancel_thronglet`, or the record fields `turn_started_at` / `last_result` / `last_error`: those are later tasks (THRONG-11/12/13), even though DESIGN already describes them.

## What to build

### 1. `description` on `run_thronglet`
- `src/mcp/tools/run-thronglet.ts` inputSchema: `description: z.string().min(1).describe('What this thronglet is for, in a few words; shown in session listings')`. Required.
- Carry it to the session record: add `description: string` to `RunRequest { kind: 'new' }` in `src/run.ts` and write it in the record at the `writeSessionRecord` call (run.ts ~l.228).
- `SessionRecord` in `src/sessions.ts` gets `description: string`. Records written before this change lack the field: when `send_message` loads a record without it, treat it as `""`, not as corrupt.
- Update the tool description string of run_thronglet to mention the new field, e.g. append: `description names the thronglet for listings.`

### 2. `send_message` replaces `resume_thronglet`
- New file `src/mcp/tools/send-message.ts`, delete `src/mcp/tools/resume-thronglet.ts`. Register in `src/mcp/tools.ts` in place of resumeThronglet. Tool name `send_message`.
- Input: `session_id: z.string().describe('session_id from run_thronglet')`, `prompt: z.string().describe('Next message for the agent')`, `schema: schemaField`, `timeout_s: timeoutField`. No `steer`, no `background`.
- Behavior identical to today's resume_thronglet (fresh adapter via `session/resume`, mode/model/effort re-applied, same payload, `session_not_found` for unknown/unreadable/corrupt records and for harnesses without `sessionCapabilities.resume`) plus the queue below. `Call.tool` = `'send_message'`.
- Tool description string: `Sends the next message into an earlier session (session_id from run_thronglet) and returns the same JSON as run_thronglet. A message to a session whose turn is still running waits for that turn to end: turns on one session never overlap.`
- Rename every mention of resume_thronglet in code comments and texts: `src/mcp/tools.ts` callRun doc, `src/acp/types.ts:28`, `src/contract.ts:62` comment (comment only; nothing structural changes in contract.ts), `src/prompt.ts:1`, `src/run.ts` comments l.31, l.78 and the warning text at l.240 ("send_message will not find this session"), `src/mcp/tools/run-thronglet.ts:9`, the `session_id` describe strings.

### 3. Per-session turn queue (DESIGN §3.3 Queue, §7)
- New module `src/registry.ts` (named in DESIGN §4 tree: "live sessions of this process"): a `SessionRegistry` class with, for now, one job: a FIFO lock per `session_id`. Suggested API: `acquire(sessionId: string, signal: AbortSignal, onQueued: (waiting: number) => void): Promise<() => void>` and a `busy(sessionId): boolean` / `waiting(sessionId): number` for tests. Implementation can be a `Map<string, Semaphore>` of `Semaphore(1)` (reuse `src/semaphore.ts`), entries deleted when idle. Abort while waiting → `ThrongError('cancelled', 'cancelled while waiting for the session's running turn to end')` (don't reuse the max_concurrency message). Keep it small: THRONG-11 will add state and waiters here.
- One registry per server process: create it in `src/mcp.ts` next to the semaphore, pass through `ToolDeps` → `RunContext.sessions` (new required field). Tests that share a registry between two calls pass the same instance through `makeCtx`.
- Where the lock is taken:
  - `send_message`: in `runCall`, after `call.request()` succeeded (unknown id fails before queueing) and before the semaphore acquire, inside the same `queuedAt … waitedMs` window so the wait is excluded from `timeout_s` and `duration_s` like the semaphore wait (DESIGN §7). While waiting call `ctx.progress.queued(n)` (the McpProgress heartbeat then says "queued"). Add the `queued N s` warning the same way the semaphore does (one combined wait is fine).
  - `run_thronglet`: the session id is only known after the handshake; take the lock synchronously the moment `sessionId = worker.session.sessionId` is set (run.ts ~l.227), before `writeSessionRecord`, so a `send_message` that reads the fresh record cannot start a second adapter while the first turn runs. A brand-new id is never contended, so this acquire resolves immediately; still go through the registry so the id shows as busy.
- Release: after `lifecycle.close()` and the `touchSessionRecord` in the cleanup, i.e. when the adapter process is gone. Mind `RunLifecycle.close()` with a lingering handshake (cancel/timeout during handshake): the semaphore slot is released only when the lingering start settles; defer the session lock release the same way so "never two adapter processes on one session" holds exactly.
- Shutdown: `startWorker` already refuses with `cancelled` while shutting down, so a queued call that wins the lock during shutdown fails cleanly; verify this path in a test only if cheap, otherwise note it.

### 4. Tests (all against the fake agent)
- `src/run.test.ts`: rename the `resumeThronglet` describe to `sendMessage`; the `record()` helper and echo-test record assertions include `description`. Add queue tests with a shared registry:
  a. Two concurrent `sendMessage` calls on one hand-written session record, scenario `hang`, `timeout_s: 1`: the second call's progress starts with `queued 1`, the second adapter process starts only after the first is gone (use the tag/pgrep helpers, e.g. a different `--tag` per call isn't possible since scenario is per harness; instead assert via the registry: `busy(id)` and timing — B's `started` happens after A's outcome), both fail with `timeout`, and B's `duration_s` excludes the wait (< 2.5 s like the existing timeout test).
  b. A deterministic success case: add a small fixture knob to the fake agent, `FAKE_TURN_MS` (echo scenario sleeps that long before answering; default 0), so that A (echo, ~800 ms) and B (echo) on the same session both succeed, B after A, B's text is the echo of B's prompt. Keep the knob minimal and documented in `test/fake-agent/index.ts`.
  c. Abort while queued → `cancelled` with the session-queue message; the lock is released and a later call on the same id proceeds.
  d. `run_thronglet` → the returned `session_id` is busy in the registry while the turn runs (hang scenario), idle after close.
- `src/mcp.test.ts`: tool list is `['list_harnesses', 'run_thronglet', 'send_message']`; every `run_thronglet` call passes `description`; a run_thronglet call without `description` is rejected by zod (tool error with the validation text); the resume test becomes a send_message test (resume-memory scenario; the `/no session record for "fake-nope"/` assertion stays).
- `src/sessions.test.ts`: record literals include `description`; a round-trip keeps it; `readSessionRecord` on a record without `description` still returns it.
- `src/registry.test.ts`: FIFO order for three waiters, release deletes the entry, abort while waiting.

### 5. README and smoke
- `README.md`: intro tool list; `mcp__throng__send_message` in tool names; `description` in the run_thronglet input block; "for send_message" at the session_id comment; `session_not_found` row; the "so you can resume" sentence; replace `### resume_thronglet` with `### send_message` (same input/output, plus two sentences on the queue: turns on one session run one after another, a message to a busy session waits and reports `queued` in progress, the wait doesn't count toward `timeout_s`); Files on disk: record fields with `description`, "read by send_message"; smoke section flag and PASS line.
- `scripts/smoke/smoke.ts`: run_thronglet call passes `description: 'smoke: ping/pong'`; the follow-up step calls `send_message` and says `send_message session_id=…`; the PASS line becomes `send_message answered pong.txt`; rename the flag `--no-resume` → `--no-follow-up` (usage string, parseArgs, doc comment). `scripts/smoke/smoke.test.ts` pins these strings: update them.

## Acceptance criteria (from the task)
1. `run_thronglet` requires `description`; the session record stores it.
2. `send_message({session_id, prompt, schema?, timeout_s?})` runs the next turn synchronously and returns the run_thronglet payload; unknown id or no `sessionCapabilities.resume` → `session_not_found`.
3. Two `send_message` calls on one session run one after the other, never two adapter processes on one session; the second waits in the queue and reports it in progress; fake-agent test.
4. `resume_thronglet` is gone from the tool list, README, DESIGN (already) and the smoke script; `send_message` replaces it everywhere.
5. Smoke on real harnesses is the maintainer's; keep `pnpm smoke:*` working against the fake agent (`smoke.test.ts`).

Report in `summary`: the registry API you settled on, where exactly the lock is taken/released, and any deviation from this brief.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Spike 2026-10-02 (scripts/spike/concurrent-prompt.ts, real harnesses, prompt A runs `sleep 25`, prompt B sent 3-10 s into A):

Concurrent second `session/prompt` while a turn runs: in all three adapters the agent sees B mid-turn (quotes it in the A reply), but request/response pairing is broken differently in each:
- claude-agent-acp 0.78.0 (claude/sonnet): A resolves end_turn at +29 s before the reply text; the combined text (A-DONE + quoted B) arrives under B, which resolves at +37 s.
- opencode 1.18.31 (glm-5.3-flash): A and B resolve at the same instant (+33.4 s) with one combined text.
- codex-acp 1.12.0 (gpt-6-luna): B resolves end_turn at +45 s with the combined text; A never resolves, not even after session/cancel (checked 10 s), only when the worker is closed. Verdict: not a usable contract; throng must serialize prompts per session itself.

Steer = `session/cancel` then prompt B: works on all three. A resolves `cancelled` within 0.3 s; B gets a reply that remembers the interrupted work ("B-ACK running `sleep 25`, interrupted before it finished" on codex; equivalent on claude and opencode). Cost: the in-flight tool call is aborted.

task-cycle wf_29fa48f5-bcd: Opus coder, gates green (189 tests), Opus review 0 findings, Codex review 1 finding (f1, major: the queue timeout test asserted a `queued N s` warning with a 28-41 ms margin over QUEUE_WARNING_MS) → confirmed, fixed (A holds the session with timeout_s: 2, margin ~1 s), verified by a separate Opus. Spot-checked by the main session: src/registry.ts (SessionRegistry: Semaphore(1) per id, users count, entry dropped at zero, acquire rejects `cancelled` with its own message), run.ts lock sites (send_message: after guards, before the semaphore, inside the queued window; run_thronglet: right after sessionId is known, before writeSessionRecord), release via the new RunLifecycle.whenGone after close + touch. Coder deviations accepted: old-record fallback (description "") lives in readSessionRecord; Semaphore got an optional cancel message; lock taken after guards so a failing call never queues; shutdown path (queued call wins the lock during shutdown → startWorker refuses with cancelled) not covered by a test. Gates re-run by the main session: tsc 0, eslint 0, vitest 18 files / 189 tests.

Smoke 2026-10-02 (maintainer): pnpm smoke:claude — claude/sonnet run 4.7 s → "done", pong.txt written, send_message 2.4 s → "pong.txt", no orphans. SMOKE PASSED. AC #5 still needs codex and opencode.

2026-10-02: nodge accepted the smoke (AC #5) as passed; any bugs will be filed separately.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
run_thronglet requires description (stored in the session record); send_message replaces resume_thronglet everywhere (tools, README, smoke with --no-follow-up, comments); per-session FIFO turn queue in src/registry.ts shared through RunContext.sessions, wait excluded from timeout_s/duration_s and reported as queued in progress; FAKE_TURN_MS knob in the fake agent. Verified: tsc 0, eslint 0, vitest 189/189 incl. queue tests (hang+timeout ordering, echo with FAKE_TURN_MS, abort while queued, new session busy while running, cancel during handshake keeps the lock). Maintainer smoke (AC #5) : claude run recorded, codex and opencode accepted by nodge on 2026-10-02 without a recorded run; bugs come as separate tasks.
<!-- SECTION:FINAL_SUMMARY:END -->
