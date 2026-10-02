---
id: THRONG-18
title: First npm publish and trusted publisher setup
status: Done
assignee:
  - '@nodge'
created_date: '2026-10-02 19:56'
updated_date: '2026-10-02 21:22'
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
- [x] #1 pnpm pack --dry-run reviewed: only dist, skills, README/docs md, LICENSE, package.json in the tarball
- [x] #2 throng-mcp@0.1.0 published by hand (pnpm publish --access public) from a clean main checkout
- [x] #3 Trusted publisher on npmjs.com for throng-mcp: GitHub Nodge/throng-mcp, workflow release.yml
- [x] #4 A release after that goes through the Upcoming Release PR and lands on npm with provenance
- [x] #5 The published package works from an unrelated directory: npx -y throng-mcp answers MCP initialize over stdio (the maintainer keeps running the server from the sources)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Order matters (THRONG-17 review a1): changesets/action publishes any unpublished version even with no changesets, so until throng-mcp@0.1.0 is on npm every Release run on main is red at changeset publish (nothing published or tagged). Publish 0.1.0 by hand from the local THRONG-17 commit before pushing main, or right after the push; then configure the trusted publisher (npmjs.com package settings: GitHub Nodge/throng-mcp, workflow release.yml, environment none). pnpm pack --dry-run first; the pack test already checks the tarball contents.

2026-10-02: throng-mcp@0.1.0 published by hand by nodge (npm view: 10 files, 220542 bytes unpacked). Checked from an unrelated directory: npx -y throng-mcp answers MCP initialize with serverInfo throng 0.1.0 and stops on stdin close. Blocker on the way: ~/.npmrc had legacy basic auth (username/_password) for registry.npmjs.org, pnpm got 401/404 until npm login wrote a token. Next: trusted publisher on npmjs.com, then push main.

Trusted publisher configured on npmjs.com by nodge: GitHub Nodge/throng-mcp, release.yml, 'Allow npm publish' on, dist-tag off.

Pushed 48c2267..b9b8a73. First Release run on main (37064066963) green: changeset publish said 'No unpublished projects to publish', nothing tagged, as expected with 0.1.0 already on npm. CI run 37064066986 result below in the final summary.

Maintainer decision: no dogfood over npx, the maintainer's own sessions keep running from the sources; the npx path is covered by the initialize check and scripts/pack.test.ts. AC #4 is exercised with .changeset/first-release-notes.md: a patch changeset carrying the release notes of the first version (0.1.0 shipped without a changelog), so the first Upcoming Release PR produces 0.1.1 with a real CHANGELOG entry and proves the OIDC publish path.

First automated release: Release run on 85d24ff failed at PR creation ('GitHub Actions is not permitted to create or approve pull requests'); fixed by nodge with gh api PUT actions/permissions/workflow can_approve_pull_request_reviews=true (the plugin repo has the same), rerun opened PR #4 Upcoming Release (0.1.1, CHANGELOG seeded with the first-release notes). Merged by nodge; Release run 37066071786 published throng-mcp@0.1.1 through OIDC, tag and GitHub release throng-mcp@0.1.1 created. The registry showed 0.1.1 only ~10 min after 'Successfully published' (replication lag, not a staged publish). Provenance present: dist.attestations.provenance slsa.dev/provenance/v1 plus the npm publish attestation.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
throng-mcp@0.1.0 published by hand (npm login needed: ~/.npmrc had legacy basic auth), trusted publisher configured on npmjs.com (Nodge/throng-mcp, release.yml, 'Allow npm publish'), repo setting 'Allow GitHub Actions to create and approve pull requests' enabled. End to end verified: a changeset on main opened the Upcoming Release PR, merging it published 0.1.1 via OIDC with SLSA provenance and created the GitHub release. npx -y throng-mcp from an unrelated directory answers MCP initialize; the maintainer keeps running from the sources.
<!-- SECTION:FINAL_SUMMARY:END -->
