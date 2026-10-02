---
id: THRONG-17
title: Changesets and npm release workflow
status: To Do
assignee: []
created_date: '2026-10-02 19:56'
labels: []
milestone: m-2
dependencies:
  - THRONG-16
references:
  - >-
    https://github.com/Nodge/eslint-plugin-handle-errors/blob/main/.github/workflows/release.yml
  - >-
    https://github.com/Nodge/eslint-plugin-handle-errors/blob/main/.changeset/config.json
type: task
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Releases follow Nodge/eslint-plugin-handle-errors: changesets collect release notes per task, changesets/action on push to main opens an 'Upcoming Release' PR, merging it publishes to npm through OIDC trusted publishing (no NPM_TOKEN). Differences from the plugin: actions are pinned by SHA as in the existing ci.yml; this repo commits straight to main, so 'changeset status --since=origin/main' on push compares main with itself and passes trivially. The check stays for pull requests, but the real guard is the task cycle: a task commit that touches src/ carries its changeset. Install docs move to the npm package (npx -y throng-mcp); the clone-based run goes to docs/development.md with the release procedure.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 @changesets/cli and @changesets/changelog-github installed; .changeset/config.json with repo nodge/throng-mcp, access public, baseBranch main, changedFilePatterns src/**, data/**, package.json
- [ ] #2 package.json scripts: changeset, ci:changesets (changeset status --since=origin/main), ci:version, ci:publish (pnpm run ci:build && changeset publish)
- [ ] #3 .github/workflows/release.yml: on push to main, repository guard, permissions contents/issues/pull-requests/id-token write, changesets/action pinned by SHA with pr-title, commit-message, publish-script, version-script as in the plugin
- [ ] #4 ci.yml: lint job checks out with fetch-depth 0 and runs ci:changesets, skipped on the changeset-release/main branch
- [ ] #5 AGENTS.md task cycle step 6: a commit that changes src/ or data/ includes a changeset (pnpm changeset), with the bump level chosen by the main session; the runbook brief template mentions it
- [ ] #6 README Install: server installed as npm package; claude mcp add, codex mcp add and the opencode config use npx -y throng-mcp; the 'keep the clone where it is' wording is gone; the clone-based command lives in docs/development.md
- [ ] #7 docs/development.md: release procedure (changeset in the task commit, release PR, merge publishes), first-publish note that trusted publishing is configured on the existing npm package
- [ ] #8 A changeset for the first release exists so the first release PR produces 0.1.0 (or the version is set so that it does)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
