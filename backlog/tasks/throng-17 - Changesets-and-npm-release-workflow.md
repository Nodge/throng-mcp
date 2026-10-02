---
id: THRONG-17
title: Changesets and npm release workflow
status: Done
assignee:
  - '@fable'
created_date: '2026-10-02 19:56'
updated_date: '2026-10-02 20:47'
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
- [x] #1 @changesets/cli and @changesets/changelog-github installed; .changeset/config.json with repo nodge/throng-mcp, access public, baseBranch main, changedFilePatterns src/**, data/**, package.json
- [x] #2 package.json scripts: changeset, ci:changesets (changeset status --since=origin/main), ci:version, ci:publish (pnpm run ci:build && changeset publish)
- [x] #3 ci.yml: lint job checks out with fetch-depth 0 and runs ci:changesets, skipped on the changeset-release/main branch
- [x] #4 README Install: server installed as npm package; claude mcp add, codex mcp add and the opencode config use npx -y throng-mcp; the 'keep the clone where it is' wording is gone; the clone-based command lives in docs/development.md
- [x] #5 docs/development.md: release procedure (changeset in the task commit, release PR, merge publishes), first-publish note that trusted publishing is configured on the existing npm package
- [x] #6 AGENTS.md: task cycle step 6 says a commit touching src/, data/ or package.json carries a changeset written by the main session at finalization, with the bump rule (patch fixes, minor new behaviour, major DESIGN §3 contract change); subagents don't touch .changeset/; a Releases paragraph describes the Upcoming Release PR flow
- [x] #7 No changeset and no version bump in this task: 0.1.0 is published by hand in THRONG-18, changesets start after it
- [x] #8 .github/workflows/release.yml: on push to main, repository guard, permissions contents/issues/pull-requests/id-token write, changesets/action@v2 with pr-title, commit-message, publish-script, version-script as in the plugin; action references by tag like ci.yml (Dependabot updates them)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-17: changesets and npm release workflow

## Why
THRONG-16 made the package publishable (tsdown bundle in `dist/`, `bin`, `files`, `prepack`). This task adds the release machinery and moves the install docs to the npm package. Model: https://github.com/Nodge/eslint-plugin-handle-errors (`.github/workflows/release.yml`, `.changeset/config.json`, the `ci:*` scripts). Differences from that repo: actions pinned by SHA (as the existing `ci.yml` does); this repo commits straight to main, so the `changeset status` check on push compares main with itself and passes trivially. It stays for pull requests; the real guard is the process rule in AGENTS.md.

Versioning: `0.1.0` is unpublished and will be published by hand (THRONG-18, maintainer), then trusted publishing is configured on npm and the Release workflow publishes every later version. So no changeset is added in this task, and `package.json` version stays `0.1.0`.

## Read first
- `package.json` (scripts, `files`, `prepack`), `.github/workflows/ci.yml` (pinned actions, lint and test jobs), `README.md` Install section (lines ~21-150), `docs/development.md`, `docs/DESIGN.md` §2.3 line ~176 and §9, `AGENTS.md` "Task cycle" (lines 11-30), `src/skill.test.ts` (asserts the README keeps a line matching `npx skills add <x> --skill throng`).

## Changes
1. Changesets. `pnpm add -D @changesets/cli @changesets/changelog-github` (latest: 3.0.3 and 1.0.1). `.changeset/config.json`:
   `{ "$schema": "https://unpkg.com/@changesets/config@4.0.0/schema.json", "changelog": ["@changesets/changelog-github", { "repo": "Nodge/throng-mcp" }], "commit": false, "fixed": [], "linked": [], "access": "public", "baseBranch": "main", "changedFilePatterns": ["src/**", "data/**", "package.json"], "updateInternalDependencies": "patch", "ignore": [] }` (check the `$schema` version against what the installed `@changesets/config` ships). `.changeset/README.md` as `changeset init` writes it is fine, or omit it. Scripts in `package.json`: `"changeset": "changeset add"`, `"ci:changesets": "changeset status --since=origin/main"`, `"ci:version": "changeset version"`, `"ci:publish": "pnpm run ci:build && changeset publish"`.
2. `.github/workflows/release.yml`, same shape as the plugin's: `name: Release`, `on: push: branches: [main]`, `concurrency: ${{ github.workflow }}-${{ github.ref }}`, one job `release` with `if: github.repository == 'Nodge/throng-mcp'`, `permissions: contents: write, issues: write, pull-requests: write, id-token: write` (one-line comments as in the plugin: create release, issue comments, release PR, OIDC token for npm), `runs-on: ubuntu-latest`, steps: checkout, pnpm/action-setup, setup-node with `node-version: 24.x` and `cache: pnpm` (same pinned SHAs and version comments as `ci.yml`), `pnpm install --frozen-lockfile`, then `changesets/action@66d7d1ddafddf1ef45f98ee51a7496f9cdadb2f4 # v2.1.2` with `pr-title: 'Upcoming Release'`, `commit-message: 'chore(release): version bump'`, `publish-script: pnpm run ci:publish`, `version-script: pnpm run ci:version`. No `NPM_TOKEN`: publishing is OIDC trusted publishing.
3. `ci.yml`: the lint job's checkout gets `fetch-depth: 0` with the plugin's comment (changeset status diffs against the merge base with origin/main, which a shallow clone lacks); a `Changesets` step at the end of the lint job: `run: pnpm run ci:changesets`, `if: github.head_ref != 'changeset-release/main' && github.ref != 'refs/heads/changeset-release/main'`.
4. `AGENTS.md`: in "Task cycle" step 6 add the rule: a commit whose changes touch `src/`, `data/` or `package.json` carries a changeset, written by the main session at finalization (`pnpm changeset`; bump: patch for fixes, minor for new tools, options, harnesses or behaviour, major for a change of the DESIGN §3 contracts); pure docs, tests, backlog and CI commits need none. Extend "Subagents (coder, reviewers, verifier) don't touch `backlog/`" with `.changeset/`. After the "End of stage" section add a short "Releases" paragraph: changesets accumulate on main, the Release workflow keeps an "Upcoming Release" PR with the version bump and CHANGELOG, the maintainer merges it and the workflow publishes to npm; the first version goes by hand (THRONG-18). Keep AGENTS.md's terse style.
5. `README.md` Install: "### 1. The server" becomes the npm package. Requirements line: node `^22.13 || >=24` (keep the "Tested with …" line, update node to say 24.11.1 is what it was tested on). Two ways: `npx -y throng-mcp` straight in the client config (nothing to install, npx caches the package), or `npm i -g throng-mcp` and the command `throng-mcp` (faster start). Drop `git clone`, "There is no build step" and "Keep the clone where it is". "### 3. The MCP client": the command is `npx -y throng-mcp` (or `throng-mcp` after a global install); `claude mcp add --scope user throng -- npx -y throng-mcp`, `codex mcp add throng -- npx -y throng-mcp`, opencode `"command": ["npx", "-y", "throng-mcp"]`; drop "the commands below assume you are in the clone directory". Section 4 (the skill) stays as is, including the `npx skills add Nodge/throng-mcp --skill throng -g -a claude-code -y` line that `src/skill.test.ts` checks; add one sentence that a global install also leaves `skills/throng` under the installed package, for the by-hand copy. Everything else in README untouched.
6. `docs/development.md`: a "Running from the checkout" note (the clone-based command for maintainers: `pnpm install`, `pnpm start` = `node src/mcp.ts`, register it with `claude mcp add --scope user throng -- node /abs/path/src/mcp.ts`, needs Node >= 22.18 or 24). A "## Release" section: `pnpm changeset` in the task commit for `src/`, `data/`, `package.json` changes (the same rule as AGENTS.md, one line, link to AGENTS.md rather than repeating the bump table); on push to main the Release workflow opens or updates the "Upcoming Release" PR (`changeset version` bumps `package.json` and writes `CHANGELOG.md`); merging it runs `pnpm run ci:publish` (build + `changeset publish`) with npm trusted publishing (OIDC, no token in the repo), creates the GitHub release and tag `throng-mcp@x.y.z`; `ci:changesets` runs in CI on every push and PR, trivially green on main itself. First publish: by hand from a clean checkout (`pnpm publish --access public`), because the trusted publisher is configured on an existing package on npmjs.com; THRONG-18.
7. `docs/DESIGN.md` §2.3 line ~176: the example `claude mcp add` uses `npx -y throng-mcp`. §9 first bullet: mention `@changesets/cli` + `@changesets/changelog-github` among dev deps and the `ci:changesets`, `ci:version`, `ci:publish` scripts, `.github/workflows/release.yml`. Nothing else in DESIGN.

## Acceptance
- `@changesets/cli`, `@changesets/changelog-github` installed; `.changeset/config.json` as in 1; the four scripts.
- `release.yml` as in 2, SHA-pinned.
- `ci.yml`: `fetch-depth: 0` on the lint job's checkout, `Changesets` step with the branch guard.
- AGENTS.md rule and Releases paragraph as in 4.
- README Install moved to the npm package as in 5; `src/skill.test.ts` still passes.
- development.md and DESIGN.md as in 6 and 7.
- `pnpm changeset status --since=origin/main` runs locally without error (exit 0; it needs the config and the git history); `pnpm typecheck && pnpm lint && pnpm test` green; `pnpm ci:fmt` green (prettier; `.changeset/*.json` is formatted, `*.md` is prettier-ignored).

## Do not touch
`src/` except nothing (no code change in this task), `data/`, `backlog/`, `skills/`, `scripts/`, `tsdown.config.ts`, `package.json` version. Do not add a changeset file. Do not run `changeset version` or `changeset publish`. Do not push.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Runbook run .agent-runbooks/runs/20261002-throng-17: ready. Review A (Opus) 2 findings, review B (GPT) 1 (duplicate of a1). Fixed and verified in two rounds: a1 until throng-mcp@0.1.0 is on npm every Release run on main fails at changeset publish (changesets/action publishes unpublished versions even without changesets); documented in development.md, procedure in THRONG-18. a2 AGENTS.md rule was self-contradictory for devDependencies/scripts-only package.json changes; tie-break added. v1 (verifier) development.md sentence about what ci:changesets matches corrected. Nothing rejected. Polish split two long sentences.
Deviations: release.yml references actions by tag (@v4, @v2) rather than SHA: the brief said SHA like ci.yml, but ci.yml (48c2267) uses tags with Dependabot, so tags for consistency. Orchestrator mistake: fix-2 was launched with write path 09-fix-2.md instead of the printed 09-fix.md; verify-2 read the real file, logged in the run.
pnpm run ci:changesets fails locally while THRONG-16 is unpushed (it diffs against origin/main, and THRONG-16 changed src/ and package.json without a changeset, by design: 0.1.0 goes by hand). In CI on main it compares the pushed commit with itself. Note: pnpm changeset status runs the changeset script (= changeset add); use pnpm run ci:changesets or pnpm exec changeset status.
README: only the Install hunks are committed with this task; concurrent intro/Example edits by the maintainer's other session stay in the working tree.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Changesets (@changesets/cli 3.0.3, changelog-github, .changeset/config.json with changedFilePatterns src/** minus tests, data/**, package.json), scripts changeset / ci:changesets / ci:version / ci:publish, .github/workflows/release.yml (changesets/action v2, OIDC, Upcoming Release PR), ci.yml with fetch-depth 0 and the Changesets step. AGENTS.md step 6 carries the changeset rule (main session writes it at finalization, bump levels, package.json field tie-break) and a Releases paragraph; development.md has Running from the checkout and Release sections; README Install uses npx -y throng-mcp or a global install; DESIGN §3.5 and §9 updated. No changeset or version bump: 0.1.0 goes by hand (THRONG-18). Verified: pnpm typecheck, lint, test (25 files, 268 tests) and prettier check green; src/skill.test.ts still finds the README skill command.
<!-- SECTION:FINAL_SUMMARY:END -->
