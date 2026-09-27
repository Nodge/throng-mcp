---
id: THRONG-5
title: Smoke and README
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
labels: []
milestone: m-0
dependencies:
  - THRONG-4
documentation:
  - docs/DESIGN.md
type: task
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
v1 closes on real harnesses, not on fakes: smoke scripts give the maintainer a repeatable matrix, and the README lets someone else install and register the server. Smoke runs spend tokens and are done by the maintainer, not by agents.

Scope: DESIGN §9, §10.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `scripts/smoke/*` with `pnpm smoke:<harness>` for claude, codex and opencode
- [ ] #2 README covers install, the registration command for the user to run, and config
- [ ] #3 Quirks found during smoke are fixed
- [ ] #4 Maintainer smoke passed: claude/codex/opencode × `auto`, opencode with a custom provider, Esc leaves no orphans, a call over 2 min goes to the background
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
