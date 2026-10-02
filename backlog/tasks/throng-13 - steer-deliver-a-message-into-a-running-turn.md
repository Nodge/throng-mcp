---
id: THRONG-13
title: 'steer: deliver a message into a running turn'
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
- [ ] #1 `send_message({steer: true})` on a running session cancels the turn and runs this message as the next turn, before anything already queued; the queue is preserved after it
- [ ] #2 The cancelled turn is recorded with the `cancelled` failure payload; the steered turn`s result becomes the session`s last result
- [ ] #3 `steer` on an idle session behaves exactly like `send_message` without it
- [ ] #4 fake-agent test: a long turn is steered; the agent`s next reply reflects the steer message, the queued message runs after it
- [ ] #5 Smoke: steer a running thronglet on claude, codex and opencode; the reply acknowledges the interrupted work
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
