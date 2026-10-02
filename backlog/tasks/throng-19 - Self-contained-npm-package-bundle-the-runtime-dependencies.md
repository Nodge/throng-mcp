---
id: THRONG-19
title: 'Self-contained npm package: bundle the runtime dependencies'
status: Done
assignee:
  - '@fable'
created_date: '2026-10-02 21:22'
updated_date: '2026-10-02 21:48'
labels: []
milestone: m-2
dependencies: []
type: task
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The published bin runs from a tsdown bundle, but the five runtime libraries stay external: npx -y throng-mcp resolves 94 packages (33 MB) at install time. The lockfile does not reach the consumer, so a user installing a month later runs other versions of @modelcontextprotocol/sdk, zod and 90 transitive packages (debug, qs, cross-spawn among them) than the ones smoke-tested, and a compromised patch release inside a ^ range (chalk/debug, September 2025) reaches every fresh npx within hours. Bundling the dependencies into dist/ makes the tarball the only thing a user runs: 1.3 MB measured with noExternal, boots and answers initialize, the only require() calls left are node builtins. One copy of zod instead of a peer of two SDKs. Cost: fixes in dependencies ship with our release, so dependency updates need automation (dependabot for npm with a cooldown, pnpm minimumReleaseAge), and the bundled packages' license texts have to ship with the package. Source maps are out: Node ignores them without --enable-source-maps and they would double the tarball.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The five runtime libraries are devDependencies; package.json has no dependencies or peerDependencies; pnpm build bundles them into dist/ (tsdown.config.ts says why)
- [x] #2 dist/THIRD_PARTY_LICENSES.md is generated at build from the modules that actually ended up in the bundle: name, version, SPDX id and the license text of every bundled package, sorted by name, deterministic
- [x] #3 scripts/pack.test.ts runs the unpacked tarball without any node_modules (symlink removed), asserts the tarball's package.json has no dependencies, and asserts dist/THIRD_PARTY_LICENSES.md is in the tarball and names @modelcontextprotocol/sdk and zod
- [x] #4 Dependabot covers npm (weekly, grouped into one PR, cooldown 7 days); pnpm-workspace.yaml sets minimumReleaseAge to 7 days; the CI Changesets step is skipped for dependabot's own pushes
- [x] #5 docs/DESIGN.md §9 and docs/development.md describe the self-contained package, the license file, and how a dependency bump reaches users (a patch changeset on the dependabot PR for bundled libs)
- [x] #6 pnpm typecheck, lint, test green; pnpm build output under 2 MB
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
- [ ] #4 Went through the runbook-task-cycle; report spot-checked
- [ ] #5 Gates green: pnpm typecheck && pnpm lint && pnpm test
- [ ] #6 Changeset written (minor)
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-19: self-contained npm package, bundle the runtime dependencies

## Why
`dist/mcp.js` is a tsdown bundle, but the five runtime libraries (`@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`, `ajv`, `yaml`, `zod`) stay external: `npx -y throng-mcp` resolves 94 packages (33 MB) at install time, with whatever versions the `^` ranges give that day. Bundle them into `dist/` so the tarball is the only thing a user runs. Measured already: `noExternal: /.*/` gives `dist/mcp.js` 565 KB + a shared chunk 741 KB + `submit-tool.js` 2 KB (1.3 MB total), the server boots and answers `initialize`, and the only `__require()` calls left in the bundle are node builtins (`process`, `buffer`). No native modules, no `__dirname` tricks in the dependencies.

## Read first
- `tsdown.config.ts` (current config, comment says dependencies stay external: that changes), `package.json`.
- `scripts/pack.test.ts`: packs the tarball into a temp dir, lists it, symlinks the repo's `node_modules` in, runs `node dist/mcp.js` against `test/fake-agent`.
- `docs/DESIGN.md` §9 (lines ~411-417: package.json, bundle, scripts, pack test) and `docs/development.md` (lines ~20-29: build, tarball, changesets rule; ~40: registry snapshot).
- `.github/dependabot.yml`, `.github/workflows/ci.yml` (Changesets step), `pnpm-workspace.yaml`.
- rolldown plugin API: `node_modules/.pnpm/rolldown@*/node_modules/rolldown/dist/shared/define-config-*.d.mts`: `generateBundle(outputOptions, bundle)` hook, `this.getModuleIds()` on the plugin context, `OutputChunk.modules: Record<string, RenderedModule>`, `this.emitFile({ type: 'asset', fileName, source })`. tsdown passes `plugins` through to rolldown.

## Changes

1. **package.json**: move the five runtime libraries from `dependencies` to `devDependencies` (same ranges; `pnpm install` afterwards so the lockfile moves them too). tsdown bundles `devDependencies` and externalizes `dependencies`/`peerDependencies` by default, so no `noExternal` is needed; the pack test (change 3) is what catches a library added back to `dependencies`. Keep every other field.

2. **tsdown.config.ts**: replace the "dependencies stay external" comment with one sentence saying the package ships self-contained: runtime libraries live in `devDependencies` and are bundled, and `dist/THIRD_PARTY_LICENSES.md` carries their licenses. Add a small rolldown plugin (inline in the config, or `scripts/build/third-party-licenses.ts` if it is over ~40 lines; it is typechecked and linted either way, `tsconfig.json` includes `scripts` and `tsdown.config.ts`) that in `generateBundle`:
   - takes `this.getModuleIds()`, keeps ids with `/node_modules/` in them (JSON imports of `package.json` and `data/registry.json` and our own `src/` are not in node_modules), and maps each to its package directory: the path up to and including the segment after the **last** `/node_modules/` (two segments for `@scope/name`). This works for pnpm's virtual store (`node_modules/.pnpm/<pkg>@<ver>/node_modules/<name>/...`).
   - reads that directory's `package.json` (`name`, `version`, `license`) and the first of `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENCE`, `LICENCE.md` (case-insensitive match over `readdirSync`) if present.
   - emits `THIRD_PARTY_LICENSES.md` as an asset (lands in `dist/`): a heading, one section per package sorted by name (`## name@version`, `License: <SPDX or "see text">`, then the license text in full, or "License text not shipped with the package" when no file exists), with a trailing newline. Same input, same bytes: sort, no timestamps.
   - fails the build (`this.error`) when a bundled package has neither a license file nor a `license` field. Do not fail on a missing file alone.
   - Expectation for the current tree: 94 or fewer packages, mostly MIT, plus Apache-2.0 (`@agentclientprotocol/sdk`), BSD-3-Clause (`fast-uri`, `qs`), BSD-2-Clause (`json-schema-typed`), ISC. Only packages that rolldown actually pulled in appear; tree-shaking may drop some of the 94.

3. **scripts/pack.test.ts**: drop the `node_modules` symlink and its comment (the unpacked package runs with no `node_modules` at all; that is the proof). Add: parse `package/package.json` from the unpacked tarball, assert it has no `dependencies` and no `peerDependencies` keys; assert the tarball lists `package/dist/THIRD_PARTY_LICENSES.md`; read it and assert it contains `@modelcontextprotocol/sdk@` and `zod@`. Keep the `SHIPPED` regex as is (`dist/.+` already covers the new file). Assert the unpacked `dist/` is under 2 MB in total (sum of file sizes).

4. **.github/dependabot.yml**: add `package-ecosystem: npm`, `directory: /`, weekly, `groups: { npm: { patterns: ['*'] } }` (one PR for all bumps), `cooldown: { default-days: 7 }`. Keep the github-actions entry.

5. **.github/workflows/ci.yml**: the Changesets step gets one more condition, `github.actor != 'dependabot[bot]'`, so dependabot's own pushes do not fail on the package.json pattern; a maintainer commit on that PR (adding a changeset) runs the check again as the maintainer. Add a one-line YAML comment saying so.

6. **pnpm-workspace.yaml**: `minimumReleaseAge: 10080` (minutes, 7 days). Comment: new versions younger than a week are not installed, the same cooldown as dependabot's.

7. **Docs**:
   - `docs/DESIGN.md` §9: the package.json line now says the five libraries are `devDependencies` bundled into `dist/` and the package has no runtime dependencies; the bundle line replaces "dependencies stay external" with the self-contained bundle and `dist/THIRD_PARTY_LICENSES.md` generated by the plugin; the pack test line drops "with the repo's node_modules symlinked in" and adds the no-dependencies and license-file checks.
   - `docs/development.md`: build section mentions the license file; the tarball section drops the node_modules symlink and adds the two new checks; the changesets section gets a paragraph: dependency bumps come from dependabot (weekly, one grouped PR, 7-day cooldown, same as `minimumReleaseAge` for local installs). The Changesets CI check is skipped for dependabot's pushes. A bump of a bundled library (the five in DESIGN §9) ships to users, so before merging add a patch changeset to the PR (`pnpm changeset` on the branch, text "Update <lib> to <version>"); a devDependency-only bump needs none and is merged as is.
   - `README.md` line 43 (the npx bullet): append "The package has no dependencies of its own: one tarball, nothing else is fetched." or similar in one sentence.

## Not in scope
- No source maps (`sourcemap` stays off).
- No minification.
- Do not touch `src/` beyond what is needed (expected: nothing), `backlog/`, `.changeset/` (the main session writes the changeset).
- Do not change the registry snapshot or the `files` list.

## Acceptance criteria (from the task)
1. The five runtime libraries are devDependencies; package.json has no dependencies or peerDependencies; pnpm build bundles them into dist/ (tsdown.config.ts says why).
2. dist/THIRD_PARTY_LICENSES.md generated at build from the modules that actually ended up in the bundle: name, version, SPDX id and license text of every bundled package, sorted by name, deterministic.
3. scripts/pack.test.ts runs the unpacked tarball without any node_modules, asserts the tarball's package.json has no dependencies, asserts dist/THIRD_PARTY_LICENSES.md is in the tarball and names @modelcontextprotocol/sdk and zod.
4. Dependabot covers npm (weekly, grouped, cooldown 7 days); pnpm-workspace.yaml minimumReleaseAge 7 days; CI Changesets step skipped for dependabot's own pushes.
5. DESIGN §9 and development.md updated as above.
6. `pnpm typecheck && pnpm lint && pnpm test` green; `pnpm build` output under 2 MB.

## Verification the coder runs
`pnpm install`, `pnpm build` (look at the size report and open `dist/THIRD_PARTY_LICENSES.md`), `pnpm typecheck && pnpm lint && pnpm test` (the pack test is part of `pnpm test`), then `pnpm build` twice and `cmp` the two license files for determinism. Also run the built bin once by hand: `(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'; sleep 1) | node dist/mcp.js` from a directory with no node_modules (e.g. copy `dist/` and `package.json` to a temp dir) and expect the `serverInfo` reply.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Runbook run .agent-runbooks/runs/20261002-throng-19: ready after one fix round. Reviews: Opus 2 findings, GPT 1 (duplicate). Fixed: a1, the coder had added trustLockfile: true to pnpm-workspace.yaml to get past the 48 already-locked versions younger than a week, which turns off pnpm's lockfile verification entirely; replaced by minimumReleaseAgeExclude with exact name@version entries, delete the list after 2026-10-08 (comment in the file). a2, the license plugin deduped by name@version so a package reached through two pnpm peer contexts gets one section. Bundled packages at this version: 10 (both SDKs, ajv, ajv-formats, fast-deep-equal, fast-uri, json-schema-traverse, yaml, zod, zod-to-json-schema); the express/hono side of the MCP SDK is tree-shaken out. Source maps left off on purpose (Node ignores them without --enable-source-maps; they would double the tarball). Evidence: pnpm typecheck, lint exit 0; pnpm test 268/268 incl. scripts/pack.test.ts which runs the unpacked tarball with no node_modules; dist 1.3 MB; license file deterministic across two builds (verify step).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Runtime libraries moved to devDependencies and bundled by tsdown into dist/ (1.3 MB); package.json ships with no dependencies. A rolldown plugin (scripts/build/third-party-licenses.ts) writes dist/THIRD_PARTY_LICENSES.md from the modules actually in the bundle, deduped and sorted. Pack test runs the unpacked tarball with no node_modules and checks the manifest, the license file and the size. Dependabot covers npm weekly, grouped, 7-day cooldown; pnpm minimumReleaseAge 7 days with a dated exclude list for the versions already locked; CI skips the Changesets check for dependabot's pushes. DESIGN §9, development.md and README updated. Verified: typecheck, lint, 268 tests green; changeset minor.
<!-- SECTION:FINAL_SUMMARY:END -->
