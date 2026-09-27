---
id: THRONG-3
title: Harnesses
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
updated_date: '2026-09-27 19:18'
labels: []
milestone: m-0
dependencies:
  - THRONG-2
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude Code, Codex and OpenCode differ in launch commands, knob names and permission modes. That difference lives in plain-data harness definitions so the rest of the code stays harness-agnostic. `HarnessDefinition` is a contract and is written by the main session.

Scope: DESIGN §2.3, §3.4, §4.1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `harnesses/{claude,codex,opencode}.ts` follow the table in DESIGN §4.1; an adapter command missing from PATH gives an `unavailable` entry whose `reason` carries the install command from the registry snapshot (decision-3)
- [ ] #2 `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` are set from PATH when the harness binary is found and not overridden in config; a missing harness binary alone does not make the harness unavailable
- [ ] #3 `list_harnesses` probes every available harness without sending a prompt and returns its models, efforts and adapter `version` (`initialize.agentInfo.version`)
- [ ] #4 A model not among the harness options fails with `model_rejected` listing the valid values
- [ ] #5 Effort goes through `mapEffort`; an unmapped effort yields a warning, not an error
- [ ] #6 Shared logic is covered by fake-agent tests; real adapters are left to smoke
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
