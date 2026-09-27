---
id: THRONG-1
title: Skeleton
status: Done
assignee:
  - '@fable'
created_date: '2026-09-27 18:56'
updated_date: '2026-09-27 19:28'
labels: []
milestone: m-0
dependencies: []
documentation:
  - docs/DESIGN.md
type: task
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Everything else builds on a runnable, type-checked package and on two unverified assumptions: that the ACP adapters start against the installed harness binaries without their bundled platform packages, and whether Claude Code passes `structuredContent` to the model. The spikes run against real adapters and are done by the main session, as are the contracts (`errors.ts`, tool schemas); the rest goes through task-cycle.

Scope: DESIGN §3.1, §3.4, §3.5, §4, §4.1, §8, §9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 package.json and tsconfig per DESIGN §9, with no ACP adapter dependencies (decision-3); the server runs as `node src/mcp.ts` without a build step
- [x] #2 Spike outcome recorded as a backlog decision: `claude-agent-acp` and `codex-acp` start with `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` and no platform packages, or the DESIGN §4.1 fallback is applied
- [x] #3 Spike outcome recorded as a backlog decision: whether Claude Code feeds `structuredContent` to the model
- [x] #4 `data/registry.json` is a verbatim snapshot of the ACP registry
- [x] #5 `src/mcp.ts` serves a `list_harnesses` stub over stdio
- [x] #6 `config.ts` (yaml, `THRONG_MCP_*` env), `agent-spec.ts`, `errors.ts`, `log.ts` exist; agent-spec parsing is covered by tests
- [x] #7 `pnpm typecheck` and `pnpm test` are green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THRONG-1 — Skeleton. Goal: a runnable, type-checked package with the server entry, config, agent-spec parsing, logging, and tests. No harness/ACP code yet.

READ FIRST: docs/DESIGN.md §3.1 (agent spec), §3.4 (list_harnesses), §3.5, §4 (layout), §4.1 (dependencies / platform packages), §8 (config), §9 (package, TS constraints, tests). AGENTS.md "Code rules".

ALREADY IN THE TREE (written by the main session — do not change exported shapes; if something is missing for your work, say so in deviations instead of editing):
- src/errors.ts — ErrorCode, Usage, ThrongError, toThrongError.
- src/contract.ts — EFFORT_LEVELS/Effort, HARNESS_IDS/HarnessId, zod raw shapes runThrongletInput / resumeThrongletInput / listHarnessesInput, output types RunSuccess / RunFailure / ListHarnessesOutput.
- data/registry.json — verbatim ACP registry snapshot. Don't touch.
- docs/DESIGN.md, backlog/ — don't touch.

BUILD:

1. package.json (a draft from the spike is already in the tree; rewrite it to this): `private: true`, `type: module`, `engines.node >= 24`, no `bin`, `packageManager` pnpm. Dependencies: `@modelcontextprotocol/sdk` ^1 (latest is 1.30.1), `@agentclientprotocol/sdk` 1.5.0 (exact), `ajv` ^8, `zod` ^4, `yaml` ^2. NO ACP adapters (`claude-agent-acp`, `codex-acp`): the user installs them (backlog/decisions/decision-3, DESIGN §4.1). Dev: `typescript`, `@types/node`. Scripts: `typecheck` = `tsc --noEmit`, `test` = `node --test test/` (verify Node 24 picks up `test/*.test.ts` with a bare directory; if not, use an explicit glob), `start` = `node src/mcp.ts`.
   TypeScript: `latest` is 7.0.2 (the native port). Try it first; if `tsc` rejects any tsconfig option listed below, pin `typescript@^5.9` and record it in deviations.
   Delete `pnpm-workspace.yaml` (it only held the platform-package exclusion list, obsolete after decision-3) and run `pnpm install` so pnpm-lock.yaml has no adapter or `@anthropic-ai/*` / `@openai/*` entries. Commit-worthy files: package.json, pnpm-lock.yaml. `.gitignore`: node_modules.

2. tsconfig.json: `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `module: nodenext`, `moduleResolution: nodenext`, `target: es2024`, `noEmit`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `types: ["node"]`, `skipLibCheck`, include `src`, `test`, `scripts`. The code runs as `node src/mcp.ts` under Node's type stripping with no flags: imports with `.ts` extension, `import type` for types, no enum/namespace/parameter properties.

3. src/log.ts: tiny stderr logger (`log.info/warn/error(msg, fields?)`), one short line per call, ISO timestamp + level. Never stdout: stdout is the MCP stdio transport.

4. src/config.ts (DESIGN §8): zod schema —
     permissions: enum auto|allow_all|deny_all|elicit, default auto
     harnesses: record over claude|codex|opencode of { command?: string; args?: string[]; env?: Record<string,string>; permissions?: same enum }
     limits: { timeout_s: 21600, handshake_s: 60, elicitation_s: 600, max_concurrency: 10, max_depth: 2 } (all optional, defaults applied)
   `loadConfig(env = process.env): { config: Config; error?: string; path: string }` — never throws. Path: `THRONG_MCP_CONFIG` or `~/.config/throng/config.yaml`. Missing file → defaults. Unreadable / invalid YAML / schema violation → defaults plus a one-line `error` with the path and the actual yaml/zod message. Also `readDepth(env): number` from `THRONG_MCP_DEPTH` (non-negative int, default 0; garbage → 0). Everything env-related uses the `THRONG_MCP_` prefix. Export the `Config` type and a `DEFAULT_CONFIG`.

5. src/agent-spec.ts (DESIGN §3.1): `parseAgentSpec(spec: string): { harness: HarnessId; model: string; effort?: Effort }`. Rules: split off the first `/` segment = harness, must be in HARNESS_IDS; the rest is the model; a trailing `:<suffix>` is stripped into `effort` only when suffix ∈ EFFORT_LEVELS (so `opencode/ollama/llama3:8b` → model `ollama/llama3:8b`, no effort; `opencode/openrouter/moonshotai/kimi-k3:high` → model `openrouter/moonshotai/kimi-k3`, effort `high`). Errors are ThrongError: unknown/missing harness → code `harness_unavailable`, message names the bad value and lists the valid harnesses; empty model (`claude`, `claude/`, `claude/:max`) → code `model_rejected`, message explains the expected form. Use the constants from src/contract.ts, don't redeclare them.
   test/agent-spec.test.ts (node:test + node:assert/strict): the four examples from DESIGN §3.1, the own-`:tag` case, every effort level, unknown harness, empty model, and that errors are ThrongError with the codes above.

6. src/mcp.ts: `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`) + `StdioServerTransport`; server name `throng`, version from package.json. On start: `loadConfig()`; if `error`, `log.error` it. Register ONLY `list_harnesses` (inputSchema = `listHarnessesInput` from contract.ts) as a stub that returns a `ListHarnessesOutput` serialized as ONE JSON text block (`content: [{ type: 'text', text: JSON.stringify(out) }]`, no structuredContent, no outputSchema — decision-2): `harnesses: []`; `unavailable`: one entry per HARNESS_IDS with reason `config error: <error>` when the config failed, otherwise `not implemented yet (THRONG-3)`; `limits`: `max_concurrency`, `max_depth`, `default_timeout_s` (= limits.timeout_s) from config, `current_depth` = readDepth(). Do not register run_thronglet/resume_thronglet yet. Shutdown: SIGTERM, SIGINT and stdin EOF → close the transport and `process.exit(0)` (worker shutdown hooks come in THRONG-2); log start and stop lines.
   test/mcp.test.ts: drive the real server over stdio with the SDK client (`@modelcontextprotocol/sdk/client/index.js` + `client/stdio.js`, command `node`, args `[src/mcp.ts]`, cwd = repo): `listTools` contains `list_harnesses`; `callTool` → parse `content[0].text` → shape above with three `unavailable` entries and default limits; second case with env `THRONG_MCP_CONFIG` → temp yaml `limits: { max_depth: 3, timeout_s: 100 }` and `THRONG_MCP_DEPTH=1` → limits reflect it and current_depth 1; third case with an invalid yaml file → every reason starts with `config error:`. Close the client at the end of each case and make sure the server process exits (no leaked child).
   test/config.test.ts: defaults when the file is missing; file overrides merge over defaults; invalid file → defaults + error; readDepth cases.

7. README.md is NOT part of this task (THRONG-5). No scripts/smoke yet.

DON'T: create src/harnesses, src/acp, src/run.ts, sessions/permissions/structured (later tasks); run real harnesses (claude/codex/opencode) or send any LLM prompt; register anything in the user's Claude config; touch ~/.claude or ~/.config/throng; edit backlog/ or docs/DESIGN.md; add dependencies beyond the list above.

GATES: `pnpm typecheck && pnpm test` green; `node src/mcp.ts` starts without flags (the mcp test proves it). Acceptance criteria of the task this brief covers: #1 (package/tsconfig/no adapter deps/no build step), #4 (registry snapshot present, untouched), #5 (list_harnesses stub over stdio), #6 (config.ts, agent-spec.ts, errors.ts, log.ts + agent-spec tests), #7 (gates green).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope change 2026-09-27 (maintainer): adapters are no longer dependencies, user installs them (decision-3, supersedes decision-1). AC #1 and the plan (step 1) updated: drop the adapter deps and pnpm-workspace.yaml. contract.ts HarnessInfo gained optional `version`.

task-cycle wf_cbd195d4-f0a: Opus coder, gates green, dual review 8 findings → 2 confirmed (f4 blocker: adapter deps contradicted decision-3 — removed deps + pnpm-workspace.yaml; f5 minor: readDepth overflow → isSafeInteger), fixed and verified in 1 round; evidence spot-checked (package.json deps, config.ts:81-86, test). Coder deviations accepted: test script is node --test "test/*.test.ts" (bare dir fails on Node 24.11; DESIGN §9 updated), @types/node ^24, strict config objects (unknown keys = config error), extra exports (configPath, AgentSpec, LoadedConfig). Deferred minors applied by the main session after the cycle: DESIGN §9 test command (f2); cwd refine isAbsolute in contract.ts (f7); toThrongError merges caller context (f8); yaml sections with no value count as absent (f1) + test. Still deferred: f3 test hygiene in test/mcp.test.ts (wall-clock <1500ms assertion, assertions in finally, untimed wait for 'throng started'). Spikes: decision-1 (adapters start without platform packages via CLAUDE_CODE_EXECUTABLE/CODEX_PATH; pnpm 11 reads ignoredOptionalDependencies only from pnpm-workspace.yaml), decision-2 (Claude Code replaces content with structuredContent; one haiku call, $0.03). Standalone claude on this machine is not logged in — nested claude needs auth via harnesses.claude.env (README, THRONG-5).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Runnable skeleton: package.json (no adapters, decision-3), tsconfig per DESIGN §9 on TS 7.0.2, src/{mcp,config,agent-spec,errors,contract,log}.ts, data/registry.json (verbatim, cmp-verified), list_harnesses stub over stdio. Verified: pnpm typecheck clean, pnpm test 28/28 (agent-spec, config, real server over stdio incl. shutdown on EOF/SIGTERM/SIGINT). Spike outcomes in decision-1 and decision-2.
<!-- SECTION:FINAL_SUMMARY:END -->
