---
id: THRONG-18
title: First npm publish and trusted publisher setup
status: To Do
assignee:
  - '@nodge'
created_date: '2026-10-02 19:56'
labels: []
milestone: m-2
dependencies:
  - THRONG-17
type: chore
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Maintainer-only steps, spend real credentials. npm trusted publishing (OIDC) is configured in the settings of an existing package, so the first version is published by hand from a clean checkout; from the second release on the Release workflow publishes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pnpm pack --dry-run reviewed: only dist, skills, README/docs md, LICENSE, package.json in the tarball
- [ ] #2 throng-mcp@0.1.0 published by hand (pnpm publish --access public) from a clean main checkout
- [ ] #3 Trusted publisher on npmjs.com for throng-mcp: GitHub Nodge/throng-mcp, workflow release.yml
- [ ] #4 A release after that goes through the Upcoming Release PR and lands on npm with provenance
- [ ] #5 Dogfood: a real client session configured with npx -y throng-mcp runs run_thronglet with a schema
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
