---
id: THRONG-12
title: list_thronglets and cancel_thronglet
status: To Do
assignee: []
created_date: '2026-10-02 09:53'
updated_date: '2026-10-02 09:53'
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
- [ ] #1 `list_thronglets` lists every session record with description, agent, cwd, state, queue length, timestamps and last error
- [ ] #2 A record whose turn was running when the server process died is listed as `failed` with an error that names the restart, never as `running`; covered by a test that restarts the server
- [ ] #3 `cancel_thronglet` on a running session cancels the turn and drops the queue; a pending `wait_thronglet` returns the `cancelled` failure payload; the session accepts a new `send_message` afterwards
- [ ] #4 `cancel_thronglet` on an idle session succeeds without side effects; unknown id → `session_not_found`
- [ ] #5 fake-agent tests cover list states across running/queued/idle/failed and cancel with a pending wait
- [ ] #6 Smoke: list shows a running background thronglet with its description; cancel stops it on claude, codex and opencode
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
