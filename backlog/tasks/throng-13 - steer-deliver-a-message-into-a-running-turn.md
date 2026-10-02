---
id: THRONG-13
title: 'steer: deliver a message into a running turn'
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
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A queued message (THRONG-9) reaches the thronglet only after the current turn ends, which for a long task can be hours: a correction such as "stop, do not touch the migrations" has to land now. Spike 2026-10-02 (notes on THRONG-9): a concurrent `session/prompt` is not a usable contract, but `session/cancel` followed by a new prompt works on all three adapters, the cancelled prompt resolves within 0.3 s and the next reply shows the agent remembers the interrupted work. Decision-6 exposes that as `steer: true` on `send_message`: cancel the running turn, deliver this message as the very next turn ahead of the queue, keep the queue after it. The cancelled turn ends with the `cancelled` payload (visible to a pending `wait_thronglet` only if nothing else is queued, which after a steer is never the case; it becomes the previous turn`s result in the record). Cost, documented in the tool description: the in-flight tool call is aborted, a half-applied edit may remain.

`steer` on an idle session is a plain `send_message`. Combined with `background: false` the call returns when the session is idle again, as any `send_message`.

Scope: DESIGN §3.3 as updated by decision-6.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `send_message({steer: true})` on a running session cancels the turn and runs this message as the next turn, before anything already queued; the queue is preserved after it
- [x] #2 The cancelled turn is recorded with the `cancelled` failure payload; the steered turn`s result becomes the session`s last result
- [x] #3 `steer` on an idle session behaves exactly like `send_message` without it
- [x] #4 fake-agent test: a long turn is steered; the agent`s next reply reflects the steer message, the queued message runs after it
- [x] #5 Smoke: steer a running thronglet on claude, codex and opencode; the reply acknowledges the interrupted work
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-13 — steer: deliver a message into a running turn

Repo: /Users/nodge/Sites/throng-mcp, branch v2. Runs as `node src/mcp.ts`, no build: erasable TS only, `import type`, imports end in `.ts`, `exactOptionalPropertyTypes` (`...(x ? { x } : {})`), `noUncheckedIndexedAccess`. Tests: vitest next to the code, fake agent only (`test/fake-agent`; scenarios and knobs documented in `test/fake-agent/index.ts`; sandbox `test/fake-harness.ts`). Gates: `pnpm typecheck && pnpm lint && pnpm test`. Don't touch `backlog/`, don't commit, don't edit `src/contract.ts` (nothing in it changes for this task). DESIGN is already written (decision-6): §3.3, paragraph **Steer**. If the code can't match it, say so in deviations instead of editing DESIGN.

Spike behind the design (2026-10-02, real adapters): `session/cancel` followed by a new prompt works on claude-agent-acp, codex-acp and opencode; the cancelled prompt resolves within a second and the next reply remembers the interrupted work. A concurrent second `session/prompt` is NOT usable (codex never resolves the first). So steer = cancel the running turn, then run this message as the very next turn.

## What exists
- `src/registry.ts` `SessionRegistry`: `acquire(id, signal, onQueued) → release` (FIFO lock on a `Semaphore(1)` per session), `busy`, `waiting`, `idle(id)`, `attachTurn(id, controller) → detach`, `turns(id): AbortController[]`. All attached controllers are alike: the registry doesn't know which one holds the lock.
- `src/semaphore.ts` `Semaphore`: FIFO `#queue` of waiters; `acquire(signal?)`.
- `src/run.ts` `runCall(call, ctx)`: creates `cancel = new AbortController()`, `signal = AbortSignal.any([ctx.signal, cancel.signal])`, `RunLifecycle(signal, cancelMessage)` where the message is `cancelled by cancel_thronglet` when `cancel` aborted, else `cancelled by the client`; `lockSession(id)` = `sessions.acquire(id, signal, onQueued('session'))` + `sessions.attachTurn(id, cancel)` back to back, then await; `detachTurn()` the moment the outcome is fixed; an ok outcome becomes `cancelled` if `cancel` aborted before that point. `Call { tool, prompt, schema, timeout_s, logFields, request }`.
- `src/cancel.ts` `cancelThronglet`: aborts every controller in `turns(id)`, waits for idle.
- `src/mcp/tools/send-message.ts`: input `session_id, prompt, schema?, timeout_s?, background?`; `background ? env.callBackground(extra, start, session_id) : env.callRun(extra, start)`.
- `src/background.ts` `startBackground`: acceptance on `onTurnStarted` (`running`) or on `queued(…, 'session')` (`queued`).
- Fake agent: `hang` (every turn hangs until `session/cancel`), `resume-memory` (first turn stores the prompt under `FAKE_MEMORY_DIR/<id>.json` and says `noted […]`; a resumed turn says `you said: <notes joined ' | '>`), `echo` with `FAKE_TURN_MS`.

## What to build

### 1. Registry knows the holder; the lock can be jumped
- `SessionRegistry.acquire` grows an options form (replace the positional one everywhere, there are few call sites): `acquire(sessionId, { signal, controller, onQueued, front? })`. The entry keeps `holder: AbortController | undefined` (set when the acquire resolves, cleared on release) and the ordered `waiters: AbortController[]` (added when the acquire has to wait, removed when it resolves or rejects). `turns(id)` = holder (if still attached) + waiters, in that order. New `holder(id): AbortController | undefined`. `detachTurn(id, controller)` removes a controller from what `turns()`/`holder()` report without touching the lock (this is what runCall does today at "outcome fixed" through the detach returned by `attachTurn`); `attachTurn` goes away.
- `Semaphore.acquire(signal?, { front?: boolean })`: `front` puts the waiter at the head of the queue (`unshift`). The registry passes `front` through.
- `runCall.lockSession` passes `cancel` as the controller and keeps the detach-at-outcome behavior via `detachTurn`.

### 2. `steer` on `send_message` (DESIGN §3.3)
- Input: `steer: z.boolean().optional().describe('Interrupt the running turn (session/cancel) and run this message as the very next turn, ahead of queued messages. The in-flight tool call is aborted; a half-applied edit may remain.')`.
- `Call` gets `steer?: boolean`; `send_message` sets it. In `runCall`, for `request.kind === 'resume'` with `steer`: right before `lockSession`, `const holder = ctx.sessions.holder(id); holder?.abort('cancelled by steer')` and acquire with `front: true`. Only the holder is aborted: queued waiters stay and run after the steer turn. A holder that already detached (teardown) or an idle session → nothing to abort, the acquire just goes to the front (on idle it resolves at once: steer behaves like a plain send_message).
- Cancel message: `RunLifecycle`'s `cancelMessage()` in runCall becomes: `typeof cancel.signal.reason === 'string' ? cancel.signal.reason : CANCELLED_BY_TOOL` when `cancel` aborted, else `cancelled by the client`. `cancel_thronglet` keeps aborting without a reason (its message unchanged). The cancelled turn records `cancelled` with `cancelled by steer` as `last_error` (via the existing endTurn path), then the steer turn's result replaces it.
- `steer` with `background: true`: the acceptance comes as `queued` (the cancelled turn still has to end: session/cancel, grace, close) or `running` if the session was idle; nothing special to do, but test it.
- Tool description of send_message: append `steer: true interrupts the running turn and delivers this message next; queued messages follow it.`

### 3. Fake agent: scenario `steer`
- First turn of a session (no notes file yet): store the prompt in the notes (like resume-memory) and then hang until `session/cancel` (like hang). Every later turn (resume): store the prompt and reply `you said: <notes joined ' | '>`. Document it in `test/fake-agent/index.ts`.

### 4. Tests
- `src/semaphore.test.ts`: `front: true` is granted before earlier waiters; FIFO otherwise unchanged.
- `src/registry.test.ts`: `holder(id)` is the controller of the acquire that holds the lock; waiters in order; `turns(id)` = holder + waiters; `detachTurn` removes without releasing; `front` acquire resolves before an earlier waiter.
- `src/steer.test.ts` (new, runCall level with `test/fake-harness.ts`, scenario `steer`):
  a. A `run_thronglet` turn hangs (its promise pending); `send_message { steer: true }` → the first call resolves `cancelled` with message `cancelled by steer`; the steer call succeeds with text `you said: <first prompt> | <steer prompt>`; the record's `last_result` is the steer turn's payload; the adapter of the first turn is gone before the steer turn starts.
  b. Queue preserved: first turn hangs, a plain `send_message` C is queued, then steer S: order of turns is first (cancelled), S, C; C's text is `you said: … | <S> | <C>`; `waiting(id)` after S starts is 1.
  c. Steer on an idle session behaves like a plain send_message (same text, nothing cancelled, no `cancelled` in the record).
  d. Steer with `background: true` on a running session → acceptance `state: 'queued'`; `wait_thronglet` afterwards returns the steer turn's result (or the last queued one's, if any).
  e. `cancel_thronglet` after a steer: still aborts holder + waiters (regression for the registry change).
- `src/mcp.test.ts` (stdio): `send_message { steer: true }` against a `steer`-scenario background run returns the `you said` text; `list_thronglets` shows the session idle afterwards.
- `scripts/smoke/smoke.ts`: add `--steer`: the first `run_thronglet` runs in the background with the prompt `Run the shell command \`sleep 60\` as one tool call and wait for it; then write pong.txt with "pong".` (so a real harness has a turn to interrupt), then after acceptance `send_message { steer: true, prompt: 'Stop what you are doing. Reply with exactly one line: "STEERED" followed by what you were doing.' }` synchronously; check the text contains `STEERED`; then `list_thronglets` shows the session `idle`; skip the pong.txt and follow-up checks. `smoke.test.ts` drives `--steer` against the fake agent with the `steer` scenario (its reply `you said: …` won't contain STEERED: make the smoke check accept either `STEERED` or `you said:` and say so in a comment, or let the fake scenario answer `STEERED` when the prompt contains that word; pick the smaller change).
- README: `steer` on send_message (what it does, the cost, queue preserved), `--steer` in the smoke section.

## Acceptance criteria (from the task)
1. `send_message({steer: true})` on a running session cancels the turn and runs this message as the next turn, before anything already queued; the queue is preserved after it.
2. The cancelled turn is recorded with the `cancelled` failure payload; the steered turn's result becomes the session's last result.
3. `steer` on an idle session behaves exactly like `send_message` without it.
4. fake-agent test: a long turn is steered; the agent's next reply reflects the steer message, the queued message runs after it.
5. Smoke on real harnesses is the maintainer's; `--steer` must work against the fake agent.

Report in `summary`: the registry API after the change, exactly where the holder is aborted and how the steer acquire jumps the queue, and every deviation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_4a884afd-91a: Opus coder, gates green (244 tests), Opus review 3 minor findings, Codex review 1 ("major", triaged as message-only); all four deferred by triage. Applied by the main session afterwards: (f3) steer does not abort the holder when the steer call itself is already cancelled; (f4) a cancel_thronglet / steer abort names itself in the cancelled payload whichever wait it interrupted (the slot-wait message is replaced; cancel.test expectation updated); (f1) fake steer scenario checks signal.aborted before attaching its abort listener; (f2) two steers in a row run newest first, written into DESIGN §3.3. Coder deviations accepted: registry acquire takes an options object with the controller, holder/waiters tracked explicitly, attachTurn removed; onQueued reports position 1 for a front acquire; smoke --steer STEERED check passes on the fake because the reply repeats the prompt (a real harness repeating the prompt would pass too). Spot-checked by the main session: run.ts (holder abort right before lockSession with front, reason-aware cancel message), registry.ts. Gates after the fixes: tsc 0, eslint 0, vitest 23 files / 244 tests.

Smoke 2026-10-02 (maintainer): pnpm smoke:claude -- --steer — background run (sleep 60 prompt) accepted, send_message steer: the running turn ended cancelled in 0.6 s, the steer turn answered in 3.9 s: "STEERED running `sleep 60` before writing pong.txt with \"pong\"." (the agent remembers the interrupted work), list_thronglets shows idle; no orphans. SMOKE PASSED on claude/sonnet; codex and opencode pending for AC #5.

2026-10-02: nodge accepted the smoke (AC #5) as passed; any bugs will be filed separately.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
steer: true on send_message aborts the session lock holder with reason "cancelled by steer" and takes the lock at the head of the queue (Semaphore front acquire); queued messages keep their place and run after; on an idle session identical to a plain send_message; with background it is accepted as queued. Registry now tracks holder and ordered waiters (holder(), turns(), detachTurn()). Fake-agent scenario steer (first turn hangs, later turns echo all prompts). Verified: tsc 0, eslint 0, vitest 244/244 incl. steer.test a–e (cancelled turn recorded, steer text, queue order, background acceptance, cancel after steer), stdio steer test, smoke --steer against the fake agent. Maintainer smoke (AC #5) accepted by nodge on 2026-10-02 without a recorded run; bugs come as separate tasks.
<!-- SECTION:FINAL_SUMMARY:END -->
