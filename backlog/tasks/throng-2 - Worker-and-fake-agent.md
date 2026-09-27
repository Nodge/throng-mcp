---
id: THRONG-2
title: Worker and fake-agent
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
labels: []
milestone: m-0
dependencies:
  - THRONG-1
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
One call = one adapter process = one ACP session. The Worker owns that lifecycle and is the only layer that knows ACP; tests must not call LLMs, so a fake ACP agent is built alongside. The Worker interface is a contract and is written by the main session.

Scope: DESIGN §4.2, §4.3, §9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `acp/process.ts`, `acp/worker.ts`, `acp/collector.ts` follow the sequence in DESIGN §4.2 and the folding rules in §4.3; the Worker does not import MCP
- [ ] #2 `test/fake-agent` is an ACP agent on the agent-side SDK with scenarios selected via `FAKE_SCENARIO`
- [ ] #3 Tests cover handshake, prompt → text, usage, cancel, timeout and transport_lost
- [ ] #4 After close no process from the adapter tree survives (fake-agent spawns a grandchild `sleep`)
- [ ] #5 Error messages carry the adapter stderr excerpt
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
