---
id: THRONG-16
title: Build with tsdown and npm package layout
status: Done
assignee:
  - '@fable'
created_date: '2026-10-02 19:56'
updated_date: '2026-10-02 20:20'
labels: []
milestone: m-2
dependencies: []
references:
  - >-
    https://github.com/Nodge/eslint-plugin-handle-errors/blob/main/tsdown.config.ts
  - 'https://github.com/Nodge/eslint-plugin-handle-errors/blob/main/package.json'
type: task
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The server runs as node src/mcp.ts from a clone. Published to npm it cannot: Node refuses to strip types from files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so npx throng-mcp on .ts sources fails. Bundle with tsdown (same tool as Nodge/eslint-plugin-handle-errors) into dist/, keep pnpm start and tests on the sources. Three places depend on file layout today: src/mcp.ts reads ../package.json for the version, src/harnesses/discovery.ts reads ../../data/registry.json, src/run.ts spawns ./structured/submit-tool.ts as a subprocess. After bundling import.meta.url inside an inlined module points at whatever chunk rolldown put it in, so the submit-tool path must be computed in the entry (src/mcp.ts) and passed in; the two JSON reads become JSON imports (with { type: 'json' }) that rolldown inlines. engines goes down to Node 22 (^22.13 || >=24): the published package needs no type stripping, grep found no Node-24-only APIs; CI test matrix gets 22.x. The npm name throng-mcp is free (checked 2026-10-02).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 tsdown.config.ts builds dist/mcp.js and dist/structured/submit-tool.js (esm, platform node, dts off, dependencies external); pnpm build and ci:build scripts; dist ignored by git, prettier and eslint
- [x] #2 Version and data/registry.json come from JSON imports; no readFileSync on package-relative paths remains in src
- [x] #3 The submit-tool path is computed in src/mcp.ts from its own import.meta.url (.ts in sources, .js in dist) and passed through RunContext; src/run.ts has no import.meta.url
- [x] #4 node src/mcp.ts, pnpm test, typecheck and lint still pass on the sources
- [x] #5 CI: Build step in the lint job, tests matrix 22.x/24.x/26.x
- [x] #6 docs/DESIGN.md §9 and docs/development.md: dev runs on sources with type stripping, the package ships a tsdown bundle
- [x] #7 package.json: private removed, bin throng-mcp -> dist/mcp.js (shebang present), files = dist, skills, docs, README.md, LICENSE; keywords, author, bugs, homepage filled; engines ^22.13 || >=24; prepack builds
- [x] #8 scripts/pack.test.ts: pnpm pack into a temp dir, tarball holds only dist/skills/docs/README/LICENSE/package.json, dist/mcp.js started over stdio with the fake agent answers list_harnesses and a run_thronglet with a schema (proves dist/structured/submit-tool.js is spawned from the right path)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-16: build with tsdown and npm package layout

## Why
The server runs as `node src/mcp.ts` (type stripping). Published to npm that fails: Node refuses to strip types under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). So the package ships a tsdown bundle in `dist/`; development, tests and smoke stay on the sources. Model: https://github.com/Nodge/eslint-plugin-handle-errors (tsdown.config.ts, package.json), adapted for a bin with two entries.

## Contracts and files (read first)
- `src/mcp.ts` (entry; reads `../package.json` for the version), `src/harnesses/discovery.ts` (`loadRegistry` reads `../../data/registry.json`), `src/run.ts` (`SUBMIT_TOOL` at line 75, used at ~251 to spawn `node <submit-tool> --schema --out`), `src/structured/submit-tool.ts` (second entry), `src/mcp/tools.ts` (`ToolDeps`, `ToolEnv`), `src/background.ts` (`base: Omit<RunContext, ...>`), `src/run.ts` `RunContext`.
- `src/mcp.test.ts`: how a test starts the real server over stdio with `test/fake-agent` configured as the `claude` harness (config file with `harnesses: { claude: { command, args } }`, PATH with only `node`). Fake-agent scenarios via `FAKE_SCENARIO` env, `submit-valid` returns a valid structured result.
- `docs/DESIGN.md` §9 (lines ~411-417), `docs/development.md`.

## Changes
1. tsdown: `pnpm add -D tsdown` (latest 0.23.x). `tsdown.config.ts` at the root: `entry: ['src/mcp.ts', 'src/structured/submit-tool.ts']`, `format: 'esm'`, `platform: 'node'`, `target: 'node22'`, `dts: false`, `clean: true`, `fixedExtension: false` (outputs `dist/mcp.js` and `dist/structured/submit-tool.js`; shared modules may land in a chunk under `dist/`, that is fine). Dependencies stay external (tsdown default for `dependencies`). No sourcemaps. Add `tsdown.config.ts` to tsconfig `include` so typecheck and eslint (projectService) cover it. Add `dist/` to `.gitignore`, `.prettierignore` and the eslint `ignores`.
2. `src/mcp.ts`: first line `#!/usr/bin/env node` (Node ignores it in ESM, tsdown keeps it). Version from `import pkg from '../package.json' with { type: 'json' }` instead of `readFileSync` (tsconfig: `resolveJsonModule: true`). Compute the submit-tool path here, in the entry, from its own `import.meta.url`: `./structured/submit-tool.ts` when `import.meta.url` ends with `.ts`, `./structured/submit-tool.js` otherwise; pass it as `submitTool` (absolute path string) through `ToolDeps` -> `ToolEnv`/background base -> `RunContext` (new required field `submitTool: string`). `src/run.ts` loses `SUBMIT_TOOL` and its `import.meta.url` (after bundling, `import.meta.url` inside an inlined module points at whichever chunk rolldown put it in; only the entry's is reliable, also for the bin symlink, which Node realpaths). Tests that build a `RunContext` (run, registry, steer, cancel, wait tests) pass the source path; a small shared helper in `test/` is fine.
3. `src/harnesses/discovery.ts`: `loadRegistry` returns `import registry from '../../data/registry.json' with { type: 'json' }` (cast through `unknown` to `RegistrySnapshot` if the inferred JSON type fights `exactOptionalPropertyTypes`). rolldown inlines it, so `data/` is not shipped.
4. `package.json`: remove `private`; `"bin": { "throng-mcp": "dist/mcp.js" }`; `"files": ["dist", "skills", "docs", "README.md", "LICENSE"]` (package.json is always included); `"engines": { "node": "^22.13 || >=24" }`; `keywords` (mcp, mcp-server, acp, agent-client-protocol, claude-code, codex, opencode, subagents, delegation), `author` "Maksim Zemskov <maxaz74@gmail.com>", `bugs` and `homepage` pointing at https://github.com/Nodge/throng-mcp. Scripts: `"build": "tsdown"`, `"ci:build": "tsdown"`, `"prepack": "pnpm run build"`. Keep everything else.
5. Pack check as a vitest test `scripts/pack.test.ts` (vitest already includes `scripts/**/*.test.ts`): in a temp dir run `pnpm pack --pack-destination <tmp>` (prepack builds), extract the tarball (`tar xzf`), assert the tarball lists only `package/dist/**`, `package/skills/**`, `package/docs/**`, `package/README.md`, `package/LICENSE`, `package/package.json` (no `src`, `data`, `test`, `backlog`); symlink the repo's `node_modules` into `<tmp>/package/node_modules` (dist imports only direct dependencies, so no install is needed and the test stays offline); then start `node <tmp>/package/dist/mcp.js` over stdio exactly like `src/mcp.test.ts` does, with `test/fake-agent` configured as the `claude` harness: `list_harnesses` returns the registry-driven table (claude present, unavailable/available does not matter), and `run_thronglet` with a `schema` and `FAKE_SCENARIO=submit-valid` returns `structured` (this proves `dist/structured/submit-tool.js` is spawned from the right path). Clean up the temp dir. Reuse helpers from `src/mcp.test.ts` by extracting them into `test/` if that keeps things small; do not duplicate 100 lines.
6. CI (`.github/workflows/ci.yml`): lint job gets a `Build` step (`pnpm run ci:build`) after Prettier; tests matrix `[22.x, 24.x, 26.x]`. Keep the SHA-pinned actions as they are.
7. Docs: `docs/DESIGN.md` §9: package is published (`bin`, `files`, engines `^22.13 || >=24`), run in development with `node src/mcp.ts` (type stripping, needs Node >= 22.18 or 24), shipped as a tsdown bundle `dist/mcp.js` + `dist/structured/submit-tool.js`, registry and version inlined via JSON imports; `pnpm build`, `ci:build`, the pack test. `docs/development.md`: a "Build and package" section with the same facts, and the note that `data/registry.json` is inlined at build time (keep the registry paragraph under "Files on disk"). README is not touched in this task (THRONG-17 rewrites Install).

## Acceptance (from the backlog task)
- tsdown builds `dist/mcp.js` and `dist/structured/submit-tool.js`; `pnpm build`, `ci:build`, `prepack`; dist ignored by git, prettier, eslint.
- package.json as in 4.
- No `readFileSync` on package-relative paths in `src`; `src/run.ts` has no `import.meta.url`; the submit-tool path comes from `src/mcp.ts` through `RunContext`.
- `node src/mcp.ts`, `pnpm typecheck`, `pnpm lint`, `pnpm test` pass on the sources; `scripts/pack.test.ts` passes (tarball contents, list_harnesses, schema run through dist).
- CI: Build step, matrix 22/24/26.
- DESIGN §9 and development.md updated.

## Do not touch
`README.md`, `backlog/`, `skills/`, `scripts/smoke/*`, the tool contracts (DESIGN §3), `data/registry.json`. No changesets yet (THRONG-17). Do not run smoke against real harnesses.

Gates before you finish: `pnpm typecheck && pnpm lint && pnpm test`, plus `pnpm build` and `pnpm pack --dry-run` (check the file list).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Runbook run .agent-runbooks/runs/20261002-throng-16: ready. Review A (Opus) 2 findings, review B (GPT) 0. Both fixed and verified: a1 DESIGN §6 still named src/structured/submit-tool.ts as the spawned path (now RunContext.submitTool with both values); a2 pack test swallowed pnpm pack/tsdown output on failure (stdio piped, stdout+stderr rethrown). Nothing rejected. Polish: no edits.
Deviation from the brief: the stdio test helpers (connectServer, fakeClaudeConfig, serverEnv, payloadOf) moved from src/mcp.test.ts into test/mcp-server.ts so scripts/pack.test.ts shares them; test/fake-harness.ts exports the source submitTool path for RunContext tests. Build: dist/mcp.js 140 kB (registry and version inlined), dist/structured/submit-tool.js 2.3 kB, shared chunk dist/validate-*.js 1.5 kB. Node 22 leg of the CI matrix not run locally (no Node 22 here); first push will show.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Published layout: tsdown bundles src/mcp.ts and src/structured/submit-tool.ts into dist/ (esm, node22, deps external), package.json has bin throng-mcp, files dist/skills/docs/README/LICENSE, engines ^22.13 || >=24, metadata, build/ci:build/prepack scripts; private removed. Version and data/registry.json are JSON imports inlined by the bundle; the submit-tool path is computed in src/mcp.ts from its own import.meta.url and flows through ToolDeps to RunContext.submitTool. CI builds and tests on Node 22/24/26. DESIGN §6/§9 and development.md updated. Verified: pnpm typecheck, lint, prettier check, test (25 files, 268 tests) green; scripts/pack.test.ts packs the tarball, asserts its file list and runs node dist/mcp.js over stdio: list_harnesses with registry install hints and a schema run returning structured through dist/structured/submit-tool.js; pnpm pack --dry-run lists 10 files, none from src/data/test/backlog.
<!-- SECTION:FINAL_SUMMARY:END -->
