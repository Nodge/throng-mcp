---
id: THRONG-3
title: Harnesses
status: Done
assignee:
  - '@fable'
created_date: '2026-09-27 18:56'
updated_date: '2026-09-27 20:37'
labels: []
milestone: m-0
dependencies:
  - THRONG-2
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude Code, Codex and OpenCode differ in launch commands, knob names and permission modes. That difference lives in plain-data harness definitions so the rest of the code stays harness-agnostic. `HarnessDefinition` is a contract and is written by the main session.

Scope: DESIGN §2.3, §3.4, §4.1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `harnesses/{claude,codex,opencode}.ts` follow the table in DESIGN §4.1; an adapter command missing from PATH gives an `unavailable` entry whose `reason` carries the install command from the registry snapshot (decision-3)
- [x] #2 `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` are set from PATH when the harness binary is found and not overridden in config; a missing harness binary alone does not make the harness unavailable
- [x] #3 `list_harnesses` probes every available harness without sending a prompt and returns its models, efforts and adapter `version` (`initialize.agentInfo.version`)
- [x] #4 A model not among the harness options fails with `model_rejected` listing the valid values
- [x] #5 Effort goes through `mapEffort`; an unmapped effort yields a warning, not an error
- [x] #6 Shared logic is covered by fake-agent tests; real adapters are left to smoke
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THRONG-3 — Harnesses. Goal: harness definitions for claude / codex / opencode, discovery (adapter on PATH or from config, install hints from the registry snapshot), the real `list_harnesses` (probe every available harness over ACP, no prompt), and model/effort selection with `model_rejected` / effort warnings. Everything harness-specific goes into plain-data definitions so run.ts (THRONG-4) stays harness-agnostic.

READ FIRST: docs/DESIGN.md §2.3 (adapter facts), §3.4 (list_harnesses contract), §4.1 (table + text — decision-3 version: throng ships no adapters), §7 (depth), §8 (config); backlog/decisions/decision-3 (adapters are user-installed) and decision-1 (spike facts). AGENTS.md "Code rules". Contract files written by the main session — implement against them, don't change exported shapes (report gaps in deviations): src/harnesses/types.ts (HarnessDefinition, HarnessResolution, HarnessLaunch, PermissionSetup, RegistrySnapshot), src/contract.ts (HarnessInfo incl. optional `version`, ListHarnessesOutput, HARNESS_IDS, Effort), src/errors.ts, src/acp/types.ts (Worker: `startWorker(spawn, start, hooks, limits)`; `worker.session.configOptions` / `.agentInfo`; `setConfigOption(configId, value)` returns the refreshed list; `close()`).

ALREADY IN THE TREE: src/acp/{worker,process,collector}.ts (THRONG-2, done), test/fake-agent (agent.ts + index.ts `fakeAgentSpawn(scenario)` → `{ command: process.execPath, args: [agent.ts, --tag=…], env: { FAKE_SCENARIO }, tag }`; the fake agent answers session/new with configOptions `model` (category `model`, values fake-small / fake-large) and `effort` (category `thought_level`, values low / high) and agentInfo `{ name: 'fake-agent', version: '0.0.1' }`), src/config.ts (`loadConfig`, `readDepth`, `Config`, `PermissionPolicy`, `config.harnesses.<id>.{command,args,env,permissions}`, `config.limits.handshake_s`), src/mcp.ts (list_harnesses STUB — replace it in this task), data/registry.json (verbatim ACP registry: `agents[]` with `id`, `name`, `version`, `description`, `distribution.npx.package` for `claude-acp` = `@agentclientprotocol/claude-agent-acp@0.81.2` and `codex-acp` = `@agentclientprotocol/codex-acp@1.13.1`; `opencode` has only `distribution.binary`). Gates: `pnpm typecheck && pnpm test` green (56 tests).

FACTS about the real adapters (from the THRONG-1 spike, decision-1; the real adapters are NOT run in tests):
- claude: adapter bin `claude-agent-acp` (npm, user-installed), harness bin `claude`; env `CLAUDE_CODE_EXECUTABLE=<abs path to claude>` makes the adapter use it instead of its bundled binary. Options: `model` (category model; values e.g. default, opus[1m], claude-fable-5-1, sonnet, haiku), `effort` (category thought_level; default, low, medium, high, xhigh, max), `mode` (category mode; default, acceptEdits, plan, auto). Modes also come as `modes.availableModes`.
- codex: adapter bin `codex-acp` (npm, user-installed), harness bin `codex`; env `CODEX_PATH=<abs path to codex>`. Options: `model` (gpt-6-astra, gpt-6-sol, …), `reasoning_effort` (category thought_level; low, medium, high, xhigh, max, ultra), `mode` (read-only, agent, agent-full-access).
- opencode: single binary `opencode`, launched as `opencode acp`. Options: `model` (category model, ~400 values of the form `<provider>/<model>`), `mode` (build, plan); NO thought_level option. Permission policy other than auto → env `OPENCODE_CONFIG_CONTENT={"permission":"ask"}`.
- Startup is 1–4 s each; `initialize` + `session/new` cost no tokens.

BUILD:

1. src/harnesses/index.ts
   - `loadRegistry(): RegistrySnapshot` — reads `data/registry.json` (path relative to the module via import.meta.url), once, cached.
   - `findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined` — scan `env.PATH` entries, return the first existing regular file with the executable bit (`fs.accessSync(p, X_OK)`); no shelling out to `which`.
   - `installHint(registry, registryId): string` — `npm i -g <distribution.npx.package>` when the agent has an npx distribution; otherwise a fixed pointer for opencode: `see https://opencode.ai/docs (binary install)`; unknown id → `no install hint in the registry snapshot`.
   - `HARNESSES: Record<HarnessId, HarnessDefinition>` and `harnessById(id)`.
   - Shared resolve helper used by the three definitions: config override `harnesses.<id>.command` wins (plus `args` default per harness and `env` from config); otherwise adapter bin from PATH; missing → `{ available: false, reason: '<bin> not found on PATH; install: <hint>' }` (when the override command is itself not an existing file or not on PATH → same shape naming the configured command). Harness binary (claude / codex): when found on PATH and the corresponding env var is not already in `config.harnesses.<id>.env`, add it to `launch.env`; when not found, add nothing (the adapter falls back to its bundled binary — decision-3). `launch.env` = config env merged over that.
2. src/harnesses/claude.ts, codex.ts, opencode.ts — one `HarnessDefinition` each, per the §4.1 table:
   - claude: registryId `claude-acp`, adapter `claude-agent-acp` args [], harness `claude` → `CLAUDE_CODE_EXECUTABLE`; `mapEffort(level, options)` = level when `options.includes(level)` else undefined; `permissionSetup`: auto → `{ modeId: 'auto' }`, anything else → `{ modeId: 'default' }`.
   - codex: registryId `codex-acp`, adapter `codex-acp` args [], harness `codex` → `CODEX_PATH`; `mapEffort`: exact match when present, else `max → xhigh` when `xhigh` is present, else undefined; `permissionSetup`: auto → `{ modeId: 'agent' }`, else `{ modeId: 'read-only' }`.
   - opencode: registryId `opencode`, adapter `opencode` args ['acp'], no harness env; `mapEffort`: exact match when present else undefined; `permissionSetup`: auto → `{}`, else `{ env: { OPENCODE_CONFIG_CONTENT: '{"permission":"ask"}' } }`.
3. src/harnesses/select.ts — applied after the handshake, harness-agnostic:
   - `optionByCategory(options, category)` helper (match on `category`, never on `id`; only `type: 'select'` options count; values = `option.options.map(o => o.value)`; note `SessionConfigSelect.options` may be grouped — check the SDK type `SessionConfigSelectOptions` in node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts and flatten groups).
   - `selectModel(worker, model): Promise<void>` — no `model` option → ThrongError `model_rejected` ("harness exposes no model option"); value not among the option values → `model_rejected` whose message names the requested value and lists the valid ones: the full list when ≤ 40 values, otherwise the values sharing the requested value's `<provider>/` prefix (text before the first `/`) plus `… N models in total; run list_harnesses for the full list`; otherwise `worker.setConfigOption(option.id, model)`.
   - `selectEffort(def, worker, effort): Promise<string | undefined>` — returns a warning string or undefined: no `thought_level` option → warning `effort "<e>" ignored: <harness> exposes no effort option`; `def.mapEffort(effort, values)` undefined → warning `effort "<e>" not available for <harness>; options: <values>`; else `setConfigOption(option.id, mapped)` (and when mapped !== effort, warning `effort "<e>" mapped to "<mapped>"`).
4. src/harnesses/probe.ts — `probeHarness(def, config, registry, opts: { handshakeMs, depth, env? }): Promise<{ ok: true; info: HarnessInfo } | { ok: false; reason: string }>`: resolve → unavailable reason as is; available → `mkdtemp` a scratch cwd, `startWorker({ ...launch, cwd, depth }, { kind: 'new', cwd, mcpServers: [] }, { onPermission: cancelled }, { handshakeMs, exitGraceMs: 1000 })`, read `session.configOptions` → `models` (category model values), `efforts` (category thought_level values, `[]` when absent), `version` = `agentInfo.version` (omit when absent), `command` = `[launch.command, ...launch.args]`; always `close()` and `rm -rf` the temp dir (also on failure); any ThrongError → `{ ok: false, reason: err.message }` (that message already carries the stderr tail).
   - `listHarnesses(loaded: LoadedConfig, opts): Promise<ListHarnessesOutput>` — config error → every harness `unavailable` with `config error: <error>` and no probing (as the stub does today); otherwise probe all three in parallel (`Promise.all`), `limits` from config + `current_depth = readDepth()`. Keep the order claude, codex, opencode.
5. src/mcp.ts — replace the stub: `list_harnesses` calls `listHarnesses(loaded, { handshakeMs: config.limits.handshake_s * 1000, depth: readDepth() })`; output still ONE JSON text block, no structuredContent. Nothing else changes in mcp.ts.
6. Fake agent: add scenario `no-effort-option` (session/new without the `effort` option) if you need it for the warning tests; otherwise leave test/fake-agent alone beyond that.

TESTS (node:test; no real adapters; every worker closed; no leaked processes):
- test/harnesses.test.ts (pure): build a temp PATH dir with executable stub files (`claude-agent-acp`, `claude`, `codex-acp`, `opencode`, `codex` — create/chmod as each case needs) and pass `env: { PATH: dir }`: (a) all present → each `resolve` available, claude launch env has `CLAUDE_CODE_EXECUTABLE=<dir>/claude`, codex has `CODEX_PATH`, opencode args `['acp']`; (b) adapter missing → unavailable, reason contains `claude-agent-acp not found on PATH` and `npm i -g @agentclientprotocol/claude-agent-acp@0.81.2` (taken from data/registry.json, not hard-coded in src); codex likewise with its package; opencode reason contains `opencode.ai`; (c) harness bin missing but adapter present → still available and no `CLAUDE_CODE_EXECUTABLE` in env; (d) config override `harnesses.claude.command = /some/path` + `args` + `env: { CLAUDE_CODE_EXECUTABLE: '/custom/claude' }` → launch uses them and the PATH value does not overwrite the configured env; (e) `mapEffort` table: claude exact / unknown → undefined; codex `max` with options lacking max but having xhigh → `xhigh`, with max present → `max`; opencode with `[]` → undefined; (f) `permissionSetup` for all four policies × three harnesses per the table.
- test/select.test.ts (fake agent): `selectModel(worker, 'fake-large')` → the next echo shows `model=fake-large`; `selectModel(worker, 'nope')` → ThrongError `model_rejected`, message contains `fake-small` and `fake-large`; `selectEffort(claudeDef, worker, 'high')` → undefined and echo shows `effort=high`; `selectEffort(claudeDef, worker, 'max')` → warning naming `max` and listing `low, high`; `selectEffort(codexDef, worker, 'max')` against options low/high → warning too (no xhigh); with `no-effort-option` → warning `exposes no effort option`; the long-list truncation rule with a hand-built option list (unit test on the message builder, no worker).
- test/mcp.test.ts additions (the existing helper `callListHarnesses(env)` spawns the real server): (a) env `PATH` = a temp dir containing only a symlink/copy of `node` (so no real adapter is found) and `THRONG_MCP_CONFIG` → yaml `harnesses: { claude: { command: <process.execPath>, args: [<abs test/fake-agent/agent.ts>] } }` → `harnesses` has exactly one entry `{ harness: 'claude', command: [node, agent.ts], version: '0.0.1', models: ['fake-small','fake-large'], efforts: ['low','high'] }` and `unavailable` has codex + opencode with install hints; (b) same but `claude.env: { FAKE_SCENARIO: 'handshake-hang' }` and `limits: { handshake_s: 1 }` → claude in `unavailable` with a reason mentioning `handshake_timeout`-style text (`did not answer initialize`) and no fake-agent process left (pgrep on `agent.ts` after the call); (c) the existing config-error case still holds (all three unavailable with `config error:`). Each case checks the server exits on stdin EOF as before.

DON'T: run real `claude-agent-acp` / `codex-acp` / `opencode` (tests use PATH dirs with stub files or the fake agent); implement run_thronglet / run.ts / permissions bridge / sessions / structured (THRONG-4+); change src/harnesses/types.ts, src/contract.ts, src/errors.ts, src/acp/types.ts; touch ~/.config, ~/.claude, backlog/, docs/. Don't add dependencies.

GATES: `pnpm typecheck && pnpm test` green, `pgrep -f fake-agent` empty afterwards. Acceptance criteria covered: #1 definitions per the §4.1 table, missing adapter → unavailable with the install command from the registry; #2 CLAUDE_CODE_EXECUTABLE/CODEX_PATH from PATH unless configured, missing harness binary alone ≠ unavailable; #3 list_harnesses probes without a prompt and returns models, efforts, version; #4 model_rejected lists valid values; #5 effort through mapEffort, unmapped → warning; #6 fake-agent tests for the shared logic.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_e648dafd-f38: Opus coder, gates green, dual review 5 findings → 1 confirmed and fixed (f4 major: SIGTERM/SIGINT during an in-flight probe orphaned the adapter — worker.ts now keeps a live-worker set + closeAllWorkers(), mcp.ts tracks in-flight calls and shutdown does server.close → closeAllWorkers → await inflight → exit; test with SIGTERM mid-probe), verified; spot-checked worker.ts:33-44, mcp.ts:21-26/44-58. Deviations accepted: shared resolve lives in harnesses/discovery.ts (index.ts would cycle with the definitions); config args apply without a command override; mcp tests run with PATH = dir with only a node symlink. Main session after the cycle: f2 — Worker.setConfigOption now refreshes session.configOptions (contract doc in acp/types.ts), the WeakMap in select.ts is gone; f3 — CLAUDE_CODE_EXECUTABLE/CODEX_PATH already set in the server's own env are no longer overwritten from PATH (+ test). Deferred: f5 findOnPath skips relative/empty PATH entries (deliberate). Open points for THRONG-4: the live-worker registry is what run.ts should rely on for shutdown; effort values may depend on the selected model, so select model before effort.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/harnesses/{types,discovery,claude,codex,opencode,index,select,probe}.ts: definitions per DESIGN §4.1 (adapter from config or PATH, install hint from data/registry.json, CLAUDE_CODE_EXECUTABLE/CODEX_PATH from PATH unless configured or already in env, mapEffort, permissionSetup), model/effort selection (model_rejected with the valid list, effort warnings), real list_harnesses probing all harnesses in parallel over ACP in scratch dirs with no prompt (models, efforts, adapter version). Shutdown closes live workers. Verified: pnpm typecheck clean, pnpm test 94/94 (38 new: harness resolution with stub PATH dirs, mapEffort/permissionSetup tables, select against the fake agent, list_harnesses over stdio incl. probe timeout and SIGTERM mid-probe), no fake-agent processes left.
<!-- SECTION:FINAL_SUMMARY:END -->
