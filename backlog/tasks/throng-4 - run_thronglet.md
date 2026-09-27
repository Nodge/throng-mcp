---
id: THRONG-4
title: run_thronglet
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
updated_date: '2026-09-27 19:18'
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
- [ ] #1 `run_thronglet` input and output match DESIGN §3.2, including failures as tool errors with an `ErrorCode`
- [ ] #2 Policy `auto` means native auto mode plus `allow_once` on every request; any other policy in config is a config error "not supported yet"
- [ ] #3 Semaphore, depth guard, timeouts and progress notifications behave per DESIGN §7
- [ ] #4 Session records and per-call transcripts are written per DESIGN §8
- [ ] #5 Integration tests run the full call through fake-agent
- [ ] #6 `run_thronglet` checks the adapter command before spawn: missing → `harness_unavailable` with the install command, not `spawn_failed`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
