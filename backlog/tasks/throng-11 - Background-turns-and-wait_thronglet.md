---
id: THRONG-11
title: Background turns and wait_thronglet
status: To Do
assignee: []
created_date: '2026-10-02 09:53'
updated_date: '2026-10-02 09:53'
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
- [ ] #1 `run_thronglet` and `send_message` with `background: true` return `{session_id, state}` once the turn has started; handshake, model and depth errors still fail the call itself
- [ ] #2 `wait_thronglet` returns the last turn`s success payload, or the tool error with its failure payload, only when no turn is running and the queue is empty
- [ ] #3 `wait_thronglet` with `timeout_s` elapsed returns the session state and queue length as a normal result, not an error
- [ ] #4 Calling `wait_thronglet` twice returns the same result; a result written before a server restart is returned after it
- [ ] #5 A background turn holds a semaphore slot only while running; an idle session holds none; covered by tests
- [ ] #6 fake-agent tests cover: background run then wait; message queued behind a running turn then wait resolves after both; wait timeout while running
- [ ] #7 Smoke: two background thronglets on different harnesses started from one session, both results collected with `wait_thronglet`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
