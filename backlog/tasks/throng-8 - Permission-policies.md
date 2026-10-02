---
id: THRONG-8
title: Permission policies
status: To Do
assignee: []
created_date: '2026-09-27 18:56'
updated_date: '2026-10-02 12:26'
labels: []
milestone: m-1
dependencies:
  - THRONG-5
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`auto` is not always acceptable: some setups need a locked-down agent or a human in the loop. The policy comes from config only, so the calling model cannot grant itself more.

Scope: DESIGN §5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `allow_all`, `deny_all` and `elicit` behave per the DESIGN §5 table; options are picked by kind and are always `*_once`
- [ ] #2 `elicit` without the client capability fails with `elicitation_unsupported` before spawn; an unanswered elicitation times out to `cancelled`
- [ ] #3 Pending permission requests are answered `cancelled` on cancel
- [ ] #4 Tests use the fake-agent `permission` scenario and a fake MCP client with the capability
- [ ] #5 Smoke: elicit from an interactive session
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
When this lands, update the Permissions paragraph of skills/throng/SKILL.md (THRONG-14): it currently says only auto runs and other policies fail with harness_unavailable.
<!-- SECTION:NOTES:END -->
