---
id: decision-5
title: >-
  Tooling: vitest next to the code, strict typescript-eslint, prettier,
  lefthook, GitHub Actions
date: '2026-10-01 21:07'
status: accepted
---
## Context

Up to v1 the project had the bare minimum: `tsc --noEmit` and `node --test "test/*.test.ts"` with `node:assert`, no linter, no formatter, no hooks, no CI. Two things pushed for more: the code is written mostly by subagents through the task cycle, so mechanical quality checks should run without a human, and the maintainer's other repos (`eslint-plugin-handle-errors`) already have a proven setup to copy.

## Decision

Made by the maintainer (nodge), 2026-10-01; set up by Fable with Opus subagents doing the migration.

- Tests: vitest (`vitest --run`), files next to the module under test (`src/foo.test.ts` for `src/foo.ts`, `scripts/smoke/smoke.test.ts` for the smoke script). `test/` keeps only the `fake-agent` fixture. Assertions are vitest `expect`. 30 s test and hook timeouts in `vitest.config.ts`, since tests drive real child processes.
- Lint: eslint 10 flat config, `@eslint/js` recommended + typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`, type-aware via `projectService`. Two rules relaxed: `restrict-template-expressions` allows numbers, `no-confusing-void-expression` ignores arrow shorthand. `.claude/` and `backlog/` are not linted.
- Format: prettier with the maintainer's house config (4 spaces, 120 columns, single quotes, `arrowParens: avoid`, `trailingComma: es5`). Not formatted: `*.md` (hand-aligned yaml/ts examples in README and DESIGN would be reflowed), `data/registry.json` (verbatim upstream snapshot), `backlog/` (owned by the Backlog.md CLI), `pnpm-lock.yaml`.
- Hooks: lefthook pre-commit = `fmt` → `lint --fix` → `typecheck`, with `stage_fixed`. Installed by `pnpm install` (`allowBuilds: lefthook` in `pnpm-workspace.yaml`). Tests are not in the hook: they spawn processes and take tens of seconds; they stay in the task-cycle gate and in CI.
- CI: GitHub Actions `ci.yml` on push and pull_request: `lint` job (eslint, typecheck, prettier check) then `test` job on Node 24 and 26. No release workflow yet.
- TypeScript pinned to 6.x: the `typescript@7` npm package ships the native compiler without the JS API (`ts.createProgram` is undefined), and typescript-eslint 8.71 declares `typescript <6.1`. Revisit when typescript-eslint supports 7.
- Gates for the task cycle become `pnpm typecheck && pnpm lint && pnpm test` (AGENTS.md, README, `task-cycle.js` default).

## Consequences

- Coders (subagents) must leave the tree lint-clean under strict type-aware rules; `any` leaks and floating promises no longer pass review by accident.
- A new module's tests go next to it, not into `test/`. Briefs that name test paths use the `src/...` form.
- Every commit is prettier-formatted; formatting diffs don't appear in review. Hand-aligned comments in code (not in markdown) are gone.
- `tsc` runs the JS compiler (6.x) rather than the native 7.x one; on this codebase the difference is under a second.
