---
id: THRONG-26
title: >-
  send_message refuses a session that cannot resume before touching the running
  turn
status: To Do
assignee: []
created_date: '2026-10-03 12:51'
labels: []
milestone: m-3
dependencies: []
priority: medium
type: bug
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A harness without session/resume (today Gemini CLI, later any generic registry agent from THRONG-20) gives one-turn sessions. throng learns this only when the next turn's adapter process answers initialize, i.e. after send_message has already spawned a process, and with steer: true after it has already cancelled the running turn (src/run.ts: the steer abort comes before the worker start; src/acp/worker.ts refuses with session_not_found 'adapter does not support session/resume'). Result: a steer at a running gemini turn destroys the turn and delivers nothing. Found in the THRONG-22 review (finding a1); README and the throng skill currently only warn about it.

Maintainer's decision 2026-10-03: no static flag on HarnessDefinition. The session record remembers what the adapter advertised (sessionCapabilities.resume) when the session was created, and send_message reads it. The capability is known from the first turn's handshake, before the record is written, so already the first send_message is refused early; it must not fail the way it does now. Records written before this change have no such field and keep today's behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The session record stores whether the adapter advertised session/resume, taken from the handshake of the turn that created the session
- [ ] #2 send_message to a session recorded as unable to resume fails with session_not_found before spawning an adapter process, and the message says the harness cannot continue a session
- [ ] #3 With steer: true on such a session the running turn is not cancelled: it completes and its result is delivered as usual
- [ ] #4 A record without the field (written by an earlier version) behaves as today; harnesses that can resume are unaffected
- [ ] #5 list_thronglets shows that a session cannot take another message, so a caller sees it before trying
- [ ] #6 Tests via test/fake-agent: early refusal without a spawn, steer leaves the running turn alive, old record without the field
- [ ] #7 DESIGN §3.3, §3.7 and §8 (session record) updated; README and skills/throng wording about steering a gemini session corrected
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
