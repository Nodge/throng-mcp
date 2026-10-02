---
id: THRONG-6
title: Structured output
status: Done
assignee:
  - '@nodge'
created_date: '2026-09-27 18:56'
updated_date: '2026-10-02 08:17'
labels: []
milestone: m-1
dependencies:
  - THRONG-5
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Callers such as workflows need machine-readable results, with one mechanism that works across all harnesses and transports.

Scope: DESIGN §6.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `run_thronglet` with `schema` returns `structured` validated by ajv, via the stdio `submit_result` tool from DESIGN §6
- [x] #2 An invalid submission is fixed by the agent within the turn; a missing one gets at most 2 corrective re-prompts, then `structured_missing` or `structured_invalid` with `text` and `session_id`
- [x] #3 Tests cover valid, invalid → valid, and missing → 2 re-prompts → error
- [x] #4 Smoke: codex with a schema
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-6 — Structured output (DESIGN §6)

Read first: docs/DESIGN.md §3.2 (output and ErrorCode), §4 (file layout), §4.2 (worker sequence, step 6), §6 (the whole section), §9 (tests, fake agent). Code to study before changing anything: src/run.ts, src/lifecycle.ts, src/prompt.ts, src/acp/types.ts (SessionStart, Worker), src/mcp/tools/run-thronglet.ts, test/fake-agent/agent.ts + index.ts, src/run.test.ts (helpers fakeClaude / makeCtx / ok / failed / tagAlive), scripts/smoke/smoke.ts.

Already done by the main session (don't redo): `JsonSchemaObject` type in src/contract.ts; `schemaField` description and the `run_thronglet` description in src/mcp/tools/run-thronglet.ts. `RunSuccess.structured`, `structured_missing` / `structured_invalid` codes already exist in contract.ts. Nothing else of structured output exists: no src/structured/, ajv is never imported, run.ts drops `schema` with the warning "schema is not supported yet (v2); ignored" (run.ts ~line 112) — remove that.

## What to build

### 1. `src/structured/validate.ts` — ajv wrapper
- `compileSchema(schema: JsonSchemaObject): ValidateFunction` (or a small object with `validate(value): { ok: true } | { ok: false; errors: string }`). One ajv instance per call, `Ajv2020` with the draft-07 meta schema added so both `$schema` dialects and no `$schema` work; `allErrors: true`, `strict: false` (unknown keywords and `format` must not throw; `ajv-formats` is not a dependency — don't add it).
- Import style verified under node 24 type stripping + `verbatimModuleSyntax`: `import { Ajv2020 } from 'ajv/dist/2020.js'` (named import; the default import is not constructable under tsc). Draft-07 meta: `ajv/dist/refs/json-schema-draft-07.json` via `createRequire(import.meta.url)` or a JSON import with `with { type: 'json' }` — whichever typechecks; the `.js` suffix on the 2020 path is mandatory at runtime.
- Error text = `ajv.errorsText(errors, { separator: '; ' })` or equivalent — the actual messages, not a paraphrase (DESIGN §3.2).
- Compile errors (invalid schema) throw with ajv's message.

### 2. `src/structured/submit-tool.ts` — the stdio MCP server the harness spawns
- CLI: `node src/structured/submit-tool.ts --schema <path> --out <path>`. Runs inside the harness under node type stripping: only erasable TS, imports with `.ts`.
- `@modelcontextprotocol/sdk` server side (`McpServer` from `server/mcp.js`, `StdioServerTransport` from `server/stdio.js`). Server name `throng_result`, one tool `submit_result` with input `{ result: unknown }` (zod: `z.unknown()` — any JSON value; the schema may describe an array or a scalar). Description tells the agent it must be called once with the final result matching the schema.
- On call: validate against the compiled schema. Valid → write `--out` as `{ "ok": true, "result": <value> }` (atomic: write to `<out>.tmp` then rename), respond with text "accepted". Invalid → write `--out` as `{ "ok": false, "errors": "<ajv text>" }`, respond `isError: true` with the text "rejected: <ajv errors>". Last write wins (DESIGN §6). The out file is how the server tells `structured_missing` (no file) from `structured_invalid` (file with ok:false) and gets "last errors" for the corrective prompt — this replaces DESIGN's "written on valid only"; update §6 wording accordingly (see 8).
- Exit when stdin closes (the SDK does it). Never writes to stdout except MCP frames; diagnostics go to stderr.

### 3. `src/prompt.ts`
- `buildPrompt(task: string, schema?: JsonSchemaObject)`: `EXECUTOR_PREFIX` stays byte-identical (the fake agent's `resume-memory` strips it and run.test.ts checks it). With a schema, append after the task a block, e.g.:
  "Result format: when you are done, call the `submit_result` tool of the `throng_result` MCP server exactly once with `result` matching this JSON Schema (the submitted result, not your final message, is returned to the caller). If the call is rejected, fix the result and call it again in the same turn.\n<schema JSON verbatim, pretty-printed>".
- `buildCorrectivePrompt(last: { ok: false; errors: string } | undefined)`: no prefix. Missing → "You ended the turn without calling submit_result. Call `submit_result` of the `throng_result` MCP server now with a result matching the schema from the task." Invalid → "Your last submit_result call was rejected: <errors>. Fix the result and call submit_result again."

### 4. `src/run.ts` — wiring (DESIGN §4.2 step 6)
- `Call.schema: JsonSchemaObject | undefined` (narrow from unknown).
- After the guards and before `lifecycle.start`: with a schema, `mkdtemp(join(os.tmpdir(), 'throng-'))`, write `schema.json` into it, and build the stdio entry for `mcpServers` of both `new` and `resume` starts:
  `{ name: 'throng_result', command: process.execPath, args: [submitToolPath, '--schema', <dir>/schema.json, '--out', <dir>/result.json], env: [] }` — NO `type` field (ACP `McpServerStdio` has none; claude-agent-acp recognizes stdio only without it, DESIGN §2.3). `submitToolPath = fileURLToPath(new URL('./structured/submit-tool.ts', import.meta.url))`. `process.execPath`, not `'node'`: ACP wants an absolute path and codex gives MCP servers a whitelisted env.
- Turn loop replacing the single turn: run the turn (always through `lifecycle.turn` with the same hooks so cancel/timeout keep working; `collector.startTurn()`/`endTurn()` per turn as now). After the turn, if a schema is set, read the out file:
  - `{ok:true}` → success: `structured` = result, `text` omitted (DESIGN §3.2), `stop_reason` of the last turn.
  - otherwise, if the stop reason is `end_turn` | `max_tokens` | `max_turn_requests` and fewer than 2 corrective prompts were sent → `worker.prompt(buildCorrectivePrompt(lastState))` and loop. `refusal` / `cancelled` → the existing errors, no re-prompt.
  - after 2 corrective prompts still nothing valid → `ThrongError('structured_missing', 'agent did not call submit_result after 2 corrective prompts')` or `ThrongError('structured_invalid', 'last submit_result rejected: <errors>')`. The failure payload gets `text` and `session_id` through the existing `context()` — make sure `text` is the last turn's text when non-empty, otherwise the most recent non-empty turn's text (keep a `lastText` in run.ts; the collector resets per turn).
  - With a schema the `empty_result` check does not apply (a valid result with no text is a success).
- Cleanup: remove the temp dir (`rm -rf`) in the final cleanup block after `await lifecycle.close()` (the tree kill takes the submit-tool child with it); on every path incl. cancel/timeout/handshake failure. A read error of the out file (corrupt JSON) counts as "missing" plus a warning.
- Log one line per corrective re-prompt (`log.info`).

### 5. Input validation of the schema (DESIGN §6: "an invalid schema is an input error")
- In `schemaField` (run-thronglet.ts) add `.superRefine` that compiles the schema with `compileSchema` and reports ajv's message as the zod issue; the MCP SDK then rejects the call before runCall. Keep the existing `.describe` text. Then run.ts can assume the schema compiles (the submit-tool compiles it again on its own; that's fine).

### 6. Claude permission for the MCP tool
- With policy `auto`, every `request_permission` is answered `reject_once` (DESIGN §5). Claude's `acceptEdits` fallback asks before MCP tools, so `submit_result` would be refused. In `src/harnesses/claude.ts` `permissionSetup` add `newSessionMeta: { claudeCode: { options: { allowedTools: ['mcp__throng_result__submit_result'] } } }` for every policy (harmless when the server isn't injected). Resume has no meta today; leave it (known gap, note it in deviations). Don't touch codex/opencode hooks.

### 7. Fake agent + tests (vitest, no LLM)
- `test/fake-agent`: new scenarios `submit-valid`, `submit-invalid-then-valid`, `submit-missing`, `submit-invalid-always`. The fake agent finds the `throng_result` entry in the session's `mcpServers` (the variant without `type`), connects with `Client` + `StdioClientTransport` from `@modelcontextprotocol/sdk/client/*` (`env` from the entry's `[{name,value}]`, `stderr: 'inherit'`, not detached so the Worker's tree kill reaches it), calls `submit_result`, closes the client. Fixed test schema `{ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }`; valid = `{ answer: 'pong' }`, invalid = `{ answer: 1 }`. `submit-invalid-then-valid`: first call must return isError with the ajv text, then the valid call in the same turn. `submit-missing` / `submit-invalid-always`: reply with text "turn N" (N = prompt count in the session) so the test can assert the number of prompts from the error's `text`.
- src/run.test.ts (replace the two "schema is accepted and ignored" tests, run and resume): valid → `structured` equals `{answer:'pong'}`, no `text`; invalid→valid → same success, one turn; missing → `structured_missing`, `text` = "turn 3", `session_id` present, usage present; invalid-always → `structured_invalid`, message contains the ajv error text, `text` = "turn 3"; resume with a schema works (`submit-valid` on resume); after each run the temp dir is gone and no submit-tool process is alive (pgrep on the out path or the `--out` arg).
- src/structured/validate.test.ts: draft-07 `$schema`, 2020-12 `$schema`, no `$schema`, invalid schema throws, unknown keyword / `format` doesn't throw.
- src/structured/submit-tool.test.ts: spawn the tool with the MCP client: valid → file `{ok:true,result}` + "accepted"; invalid → `isError` + file `{ok:false,errors}`.
- A test that `schemaField` rejects an invalid schema (e.g. `{ type: 'nope' }`) with ajv's message in the issue.

### 8. Smoke, README, DESIGN
- scripts/smoke/smoke.ts: `--schema` flag → the run_thronglet step passes a fixed schema `{ type:'object', properties:{ file:{type:'string'}, content:{type:'string'} }, required:['file','content'] }` with a prompt that asks for the created file's name and content; print `structured` and check it; add `submit-tool` to `ADAPTER_PATTERNS` so the orphan check sees leaked submit-tools. package.json: `smoke:codex-schema` = `node scripts/smoke/smoke.ts codex/gpt-6-luna --schema`. scripts/smoke/smoke.test.ts: one case with `--schema` against the `submit-valid` fake scenario. Don't run real harnesses.
- README: replace "schema is ignored" statements with the real behaviour (schema → `structured`, errors `structured_missing`/`structured_invalid` with `text` + `session_id` for resume), and the new smoke script.
- docs/DESIGN.md §6: align wording with the implementation (out file carries `{ok,result}|{ok,errors}`; `command` is the node executable's absolute path; ajv 2020 + draft-07 meta; corrective prompts after end_turn/max_tokens/max_turn_requests). §4 file list already lists src/structured/. No §3 change.

## Don'ts
- Don't change the Worker interface, `SessionStart`, `HarnessDefinition` or `ErrorCode`; `mcpServers` is already plumbed through the Worker.
- Don't add dependencies (ajv is there; no ajv-formats).
- Don't touch `backlog/`.
- Only erasable TS; imports with `.ts`; prettier formats on commit — don't hand-format.

Gates: `pnpm typecheck && pnpm lint && pnpm test`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_218a5f9d-a43: Opus coder, gates green (173 tests), Opus review 3 findings → 1 confirmed (f3, minor: submit_result without result; resolved as a pinning test — zod 4 already requires the key), 2 rejected. Codex review did not reach triage again (this session's throng server predates structured), but its text named a real major bug: Ajv2020 + draft-07 meta schema rejects draft-07 tuples (items: [...]) — reproduced, fixed by the main session: compileSchema picks Ajv2020 when $schema says 2020-12, draft-07 Ajv otherwise (also without $schema); test added, DESIGN §6 updated. Coder deviations accepted: cancel test waits for the session record instead of a 200 ms timer (flaky under load); validateFormats:false + dataVar 'result'; SubmitState type in validate.ts; FAKE_SUBMIT knob and a narrower submit-tool orphan pattern in smoke; a refusal/cancelled stop wins over a valid submission; claude allowedTools for submit_result only on session/new (resume sends no _meta — known gap). Gates after the fix: tsc 0, eslint 0, vitest 17 files / 173 tests. Smoke codex+schema (AC #4) is the maintainer's: pnpm smoke:codex-schema.

Smoke 2026-10-01 (maintainer): pnpm smoke:codex-schema — codex/gpt-6-luna run 27.6 s, submit_result called once, structured {file: pong.txt, content: pong}, pong.txt written, resume 7.9 s → 'pong.txt', no orphans. SMOKE PASSED. AC #4 checked, task Done.

Sherpa review 2026-10-02 (maintainer), commit 2acc7e7: schema moved from the prompt into submit_result's inputSchema (low-level MCP Server, defs hoisted, ajv still the only validator so invalid/missing stays); submit_result answered allow_once under every policy in permissions.ts, claude allowedTools _meta removed; smoke:claude-schema and smoke:opencode-schema added; claude smoke on sonnet. Gates: tsc 0, eslint 0, vitest 180/180. Schema smoke on real harnesses not re-run after these changes.

Smoke 2026-10-02 (maintainer) after the review fixes: pnpm smoke:claude-schema — claude/sonnet run 16.7 s, submit_result called once (schema from the tool's inputSchema, no allowedTools), structured {file: pong.txt, content: pong}, resume 2.5 s → 'pong.txt', no orphans. SMOKE PASSED.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Structured output per DESIGN §6: schema → per-run temp dir + stdio MCP server throng_result (src/structured/submit-tool.ts, ajv validation with the dialect taken from $schema) injected into session/new and session/resume; prompt instruction with the schema verbatim; after a turn without a valid result up to 2 corrective prompts, then structured_missing / structured_invalid with text and session_id; a valid result returns structured and omits text; invalid schema is rejected as tool input. Fake-agent scenarios submit-valid / submit-invalid-then-valid / submit-missing / submit-invalid-always; smoke --schema flag and pnpm smoke:codex-schema; README and DESIGN §6 updated. Verified: tsc 0, eslint 0, vitest 173/173. Pending: maintainer smoke codex+schema (AC #4) — status Review.
<!-- SECTION:FINAL_SUMMARY:END -->
