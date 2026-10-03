---
id: THRONG-27
title: Smoke gemini on a real Gemini CLI account
status: Blocked
assignee: []
created_date: '2026-10-03 13:07'
labels: []
milestone: m-3
dependencies:
  - THRONG-22
priority: low
type: task
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
THRONG-22 shipped the gemini harness without a run on a real model turn: the maintainer has no Gemini account (2026-10-03). The harness was checked against Gemini CLI 0.61.0 only up to the first model request (handshake, models list, modes, folder trust, session/set_model, process pattern, with an invalid API key). This task is the former AC #5 of THRONG-22. Blocked until someone with a Google account or a Gemini API key can run it. The three commands are in docs/development.md, smoke section. With OAuth login the model list may differ from the API-key one recorded in the THRONG-22 notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pnpm smoke:gemini under permissions: auto on the real Gemini CLI: the agent edits a file in a temp project (PASS: pong.txt written), no orphans
- [ ] #2 The same under permissions: deny_all: the edit is refused, the run itself succeeds
- [ ] #3 pnpm smoke:gemini-schema: submit_result over the MCP server works in a trusted workspace
- [ ] #4 A run with an effort suffix shows the model and the effort warning in the result; warnings contain nothing unexpected
- [ ] #5 README: the note that gemini was not run on a real turn is removed and the tested Gemini CLI version is added; any difference from DESIGN §2.3 is fixed or filed
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Blocked: no Gemini account or API key available to the maintainer.
<!-- SECTION:NOTES:END -->
