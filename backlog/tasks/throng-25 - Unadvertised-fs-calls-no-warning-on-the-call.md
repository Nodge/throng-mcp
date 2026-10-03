---
id: THRONG-25
title: 'Unadvertised fs/* calls: no warning on the call'
status: Done
assignee:
  - '@nodge'
created_date: '2026-10-03 09:30'
updated_date: '2026-10-03 09:43'
labels: []
milestone: m-1
dependencies: []
documentation:
  - docs/DESIGN.md
priority: low
type: enhancement
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
THRONG-8 smoke (2026-10-03): OpenCode calls client `fs/write_text_file` after an approved edit, without checking that throng declared `fs.writeTextFile: false`. It has already written the file itself and ignores the error, so the call is harmless, yet every such run carries the warning "adapter called fs/write_text_file, which throng does not advertise". The warning tells the caller nothing actionable. An agent that really needs client fs and does not check the capability is not silent either: its own tool call fails with "method not found" and the model reports it. So for `fs/*` the warning only ever fires on harmless calls. Decided with nodge: `fs/*` stays unadvertised and answered "method not found", without a warning; the server log keeps a line for debugging. `terminal/*` keeps the warning: an agent calling it unchecked meant to run commands, which the caller should see.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An agent calling `fs/read_text_file` or `fs/write_text_file` gets JSON-RPC "method not found" as before, the turn completes, and the result has no warning about it
- [x] #2 Each such call is logged to the server stderr at info level with the method name
- [x] #3 An agent calling a `terminal/*` method still gets "method not found" plus one warning per worker, also when an `fs/*` call happened earlier in the same worker
- [x] #4 Worker tests via test/fake-agent cover the fs case (no warning) and the terminal case (one warning, after an fs call)
- [x] #5 DESIGN §4.2 sentence on unadvertised client methods matches the new behavior
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-25: unadvertised fs/* calls without a warning

## Why

throng declares `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }` (src/acp/worker.ts ~line 181). OpenCode still calls `fs/write_text_file` after an approved edit (DESIGN §2.3 quirk): it has already written the file itself and ignores the error. Today every such run gets the warning `adapter called fs/write_text_file, which throng does not advertise; answered "method not found"` in the result's `warnings`. It is noise: an agent that truly depends on client fs gets "method not found" in its own tool call and reports the failure itself. Decision (nodge, 2026-10-03): `fs/*` keeps being answered "method not found" but adds no warning, only a server log line; `terminal/*` keeps the warning.

## What exists

- `src/acp/worker.ts`: `UNADVERTISED_METHODS` (fs.readTextFile, fs.writeTextFile, terminal.create/output/release/waitForExit/kill) with a doc comment pointing to DESIGN §4.2. In the connection setup a loop registers `onRequest` for each; the handler emits one warning per worker through `this.#hooks.onWarning` guarded by `#warned`, then throws `acp.RequestError.methodNotFound(method)`.
- `src/log.ts`: logger with `info | warn | error`, writes to stderr. Use `log.info(msg, fields)` like the rest of the code (e.g. `{ method }`; add the session id or pid if the worker has it handy, the way other worker logs do).
- `src/acp/worker.test.ts` ~line 301: test `'fs/* call from the agent: one warning, prompt still completes'` using fake-agent scenario `fs-call`, which calls `fs/read_text_file` and swallows the error. `withWorker(scenario, fn)` gives `h.turn`, `h.warnings`.
- `test/fake-agent/agent.ts` (scenario switch ~line 317) and `test/fake-agent/index.ts` (`FakeScenario` union).
- `docs/DESIGN.md` §4.2, line ~328: "Client methods `fs/*`, `terminal/*`: not advertised; if an agent calls them anyway (OpenCode quirk) we answer JSON-RPC method not found and add one warning."

## Change

1. worker.ts: split the list. `fs/*` methods: answer "method not found", log at info level, no warning, do not touch `#warned`. `terminal/*` methods: unchanged, one warning per worker. Update the doc comment(s) to match; keep them short.
2. Fake agent: add a scenario (e.g. `terminal-call`) that first calls `fs/write_text_file` (swallow the error), then a `terminal/create` (swallow the error), then completes the prompt like `fs-call` does. Register it in `FakeScenario`. `fs-call` stays as is.
3. worker.test.ts: rewrite the fs test to assert the turn completes and `h.warnings` is empty; add a test on the new scenario asserting exactly one warning that names `terminal/create` across two turns. Logging to stderr does not need a test.
4. DESIGN.md §4.2 line ~328: one sentence matching the new behavior (fs/*: method not found, logged, no warning; terminal/*: method not found plus one warning).

## Acceptance criteria

1. An agent calling `fs/read_text_file` or `fs/write_text_file` gets JSON-RPC "method not found" as before, the turn completes, and the result has no warning about it.
2. Each such call is logged to the server stderr at info level with the method name.
3. An agent calling a `terminal/*` method still gets "method not found" plus one warning per worker, also when an `fs/*` call happened earlier in the same worker.
4. Worker tests via test/fake-agent cover the fs case (no warning) and the terminal case (one warning, after an fs call).
5. DESIGN §4.2 sentence on unadvertised client methods matches the new behavior.

## Do not touch

- `clientCapabilities` stays as is: do not advertise fs or terminal.
- `src/contract.ts`, `HarnessDefinition`, harness files, `backlog/`, `.changeset/`, `package.json`, the lockfile.
- No other DESIGN sections.

Gates: `pnpm typecheck && pnpm lint && pnpm test`. Formatting via prettier in the pre-commit hook; don't hand-format. Comment sparingly: purpose above public entities, inside bodies only for non-obvious intent.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle 20261003-throng-25, worktree .claude/worktrees/throng-25 (main had unrelated uncommitted changes from another session: dependabot.yml, package.json, lockfile). Opus coder; Opus review 1 finding (a1: tests did not prove fs is answered method not found — a fake success in the fs handler kept the suite green), GPT review 0 findings; triage to fix a1; fix: terminal-call scenario reports each request error code, test asserts fs=-32601 terminal=-32601; Opus verify resolved, mutation check (fs handler returning {}) now fails the test. Residual limit accepted: deleting the fs loop is indistinguishable from the SDK default except for the log line. Polish: doc comments only. Spot-checked by the main session: worker.ts fs loop log.info {method, pid} + throw, terminal loop unchanged with #warned; DESIGN §4.2 sentence.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
fs/read_text_file and fs/write_text_file from an agent are answered "method not found" and logged at info level with method and pid, without a warning on the call (src/acp/worker.ts UNADVERTISED_FS_METHODS); terminal/* keeps one warning per worker, not consumed by earlier fs calls. New fake-agent scenario terminal-call returns both error codes. DESIGN §4.2 updated, changeset patch. Verified: tsc 0, eslint 0, vitest 269/269 incl. worker tests "fs/* call: no warning" and "fs=-32601 terminal=-32601, one terminal/create warning over two turns".
<!-- SECTION:FINAL_SUMMARY:END -->
