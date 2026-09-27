---
id: THRONG-6
title: Structured output
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
labels: []
milestone: m-1
dependencies:
  - THRONG-5
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Callers such as workflows need machine-readable results, with one mechanism that works across all harnesses and transports.

Scope: DESIGN §6.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `run_thronglet` with `schema` returns `structured` validated by ajv, via the stdio `submit_result` tool from DESIGN §6
- [ ] #2 An invalid submission is fixed by the agent within the turn; a missing one gets at most 2 corrective re-prompts, then `structured_missing` or `structured_invalid` with `text` and `session_id`
- [ ] #3 Tests cover valid, invalid → valid, and missing → 2 re-prompts → error
- [ ] #4 Smoke: codex with a schema
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
