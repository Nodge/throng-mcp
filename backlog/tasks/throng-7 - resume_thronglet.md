---
id: THRONG-7
title: resume_thronglet
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
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up questions to an earlier nested session without re-sending its context.

Scope: DESIGN §3.3, §4.2, §8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `resume_thronglet` matches DESIGN §3.3; harness, model, effort and cwd come from the session record
- [ ] #2 An unknown id or a harness without resume support fails with `session_not_found`
- [ ] #3 fake-agent scenario `resume` remembers a fact from the first prompt and answers it in the second
- [ ] #4 Smoke: a follow-up question on claude, codex and opencode
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
