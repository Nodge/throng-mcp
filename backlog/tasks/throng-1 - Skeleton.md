---
id: THRONG-1
title: Skeleton
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
labels: []
milestone: m-0
dependencies: []
documentation:
  - docs/DESIGN.md
type: task
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Everything else builds on a runnable, type-checked package and on two unverified assumptions: that the ACP adapters start against the installed harness binaries without their bundled platform packages, and whether Claude Code passes `structuredContent` to the model. The spikes run against real adapters and are done by the main session, as are the contracts (`errors.ts`, tool schemas); the rest goes through task-cycle.

Scope: DESIGN §3.1, §3.4, §3.5, §4, §4.1, §8, §9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json and tsconfig per DESIGN §9, including `pnpm.ignoredOptionalDependencies` for the harness platform packages; the server runs as `node src/mcp.ts` without a build step
- [ ] #2 Spike outcome recorded as a backlog decision: `claude-agent-acp` and `codex-acp` start with `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` and no platform packages, or the DESIGN §4.1 fallback is applied
- [ ] #3 Spike outcome recorded as a backlog decision: whether Claude Code feeds `structuredContent` to the model
- [ ] #4 `data/registry.json` is a verbatim snapshot of the ACP registry
- [ ] #5 `src/mcp.ts` serves a `list_harnesses` stub over stdio
- [ ] #6 `config.ts` (yaml, `THRONG_MCP_*` env), `agent-spec.ts`, `errors.ts`, `log.ts` exist; agent-spec parsing is covered by tests
- [ ] #7 `pnpm typecheck` and `pnpm test` are green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
