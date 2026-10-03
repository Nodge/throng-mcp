---
id: THRONG-22
title: Gemini CLI as a native harness
status: Review
assignee:
  - '@fable'
created_date: '2026-10-02 21:22'
updated_date: '2026-10-03 10:47'
labels: []
milestone: m-3
dependencies: []
references:
  - 'https://github.com/google-gemini/gemini-cli'
  - >-
    https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md
priority: high
type: feature
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Gemini CLI is the only candidate whose subscription cannot be reached any other way: the Google-account login gives Code Assist quota (free 1000 requests/day, AI Pro 1500, AI Ultra 2000) that is usable only through Gemini CLI itself. Its terms forbid using that OAuth from third-party software and Google banned accounts for it in Feb–Mar 2026, so routing Gemini through opencode is not an option; running Gemini CLI in its own official ACP mode is. It also adds a third model family for independent reviews next to Claude and GPT.

Facts from the research (2026-10-02, verified in google-gemini/gemini-cli source): registry id gemini, launch 'gemini --acp' (npx package @google/gemini-cli). ACP modes: default, autoEdit, yolo, plan; auto = mode yolo, also '--approval-mode yolo'. Folder trust is on by default and in an untrusted folder the mode is forced back to default and setApprovalMode throws: the launcher must set GEMINI_CLI_TRUST_WORKSPACE=true (or --skip-trust). Policy mapping: auto → yolo, allow_all/deny_all/elicit → default mode with request_permission answered by the server as in §5. Model and thinking level knobs: check what the ACP config options expose (model, thought_level) and map effort accordingly; what is not exposed → warning per §3. Auth is the user's business: README says to run gemini once and sign in. Decide whether this is built on the generic harness or as a HarnessDefinition like claude.ts; either way the trust env and the policy table are native.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Agent strings gemini/<model>[:<effort>] run through Gemini CLI over ACP; list_harnesses shows gemini with its models and efforts read from the probe
- [x] #2 Policy auto selects mode yolo and the process runs with GEMINI_CLI_TRUST_WORKSPACE=true; allow_all, deny_all and elicit run in mode default and request_permission is answered per the §5 table
- [x] #3 gemini not on PATH → unavailable with the install hint derived from the registry entry
- [x] #4 Unit tests via test/fake-agent cover the mode and env wiring and the policy table; scripts/smoke has a gemini case
- [ ] #5 Maintainer smoke on the real Gemini CLI: a run with auto that edits a file in a temp project, one with deny_all that refuses an edit, model and effort visible in the result
- [x] #6 DESIGN §4.1 table gets a gemini column; README lists gemini among supported harnesses with the sign-in step
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-22: Gemini CLI as a native harness

Repo: the worktree you were given (branch `throng-22`). Read AGENTS.md "Code rules" and DESIGN.md §2.3 (the new Gemini CLI block), §3.3, §3.4, §4.1, §4.2, §5 first: they already describe the target behaviour.

## Goal

`gemini/<model>[:<effort>]` runs through Gemini CLI's own ACP mode (`gemini --acp`). Gemini CLI is not installed on this machine and must not be installed or run: everything is built and tested against `test/fake-agent`. The maintainer runs the real smoke later.

## Facts about Gemini CLI 0.61.0 the code relies on (from its source; details in DESIGN §2.3)

- `session/new` returns no `configOptions`. Models: `models: { availableModels: [{ modelId, name }], currentModelId }`, set with `session/set_model { sessionId, modelId }` → `{}`; the agent accepts any string, so throng validates against the list.
- No `thought_level` option, no `session/resume` capability, no `usage_update`, no `PromptResponse.usage`.
- Modes `default | autoEdit | yolo | plan`.

## Already done by the main session (commit `THRONG-22: contract …` on this branch). Do not change these

- `src/contract.ts`: `HARNESS_IDS` has `gemini`.
- `src/harnesses/gemini.ts` and its registration in `src/harnesses/index.ts`: launch `gemini --acp`, `auto` → mode `yolo`, other policies → mode `default`, `GEMINI_CLI_TRUST_WORKSPACE=true` under every policy, `mapEffort` → `undefined`.
- `src/acp/types.ts`: `WorkerSession.models?: SessionModels` (`{ current, available }`), `Worker.setModel(modelId)`.
- `src/acp/worker.ts`: `setModel` (raw method `session/set_model`), `parseModels` in `buildSession`.
- `src/harnesses/index.test.ts`: the gemini row of the `permissionSetup` table.
- `docs/DESIGN.md`: all Gemini-related text.

If the implementation has to contradict any of this, stop and report instead of editing it. Small corrections of a bug in the worker code above are fine; say so in the report.

## Known red on the contract commit: fix as part of this task

`pnpm typecheck` and `pnpm lint` are green; `pnpm test` has 8 failures, all because tests enumerate the three harness ids or use `gemini` as their example of an unknown harness (`src/agent-spec.test.ts`, `src/config.test.ts`, `src/mcp.test.ts` ×4, `src/run.test.ts` "corrupt record", `src/harnesses/index.test.ts` "HARNESSES covers every harness id"). Update the expectations to four harnesses; where a test needs an unknown harness name, use one that is not planned as a harness (`nope`), not `cursor` or `copilot`. Keep what each test proves.

## What to implement

1. `src/harnesses/select.ts` `selectModel`: the `model` config option first, as today. Without one, `worker.session.models`: the value must be in `available`, else `model_rejected` through the existing `modelRejectedMessage`; then `worker.setModel`. Neither → the existing "harness exposes no model option" error. Keep the file's header comment true.
2. `src/list.ts` probe: `models` from the config option, else from `session.models.available`. `efforts` stays `[]` for gemini.
3. Effort: `gemini/<model>:<effort>` must run and carry the existing warning from `selectEffort` (`effort "x" ignored: gemini exposes no effort option`). Verify, don't add code unless it doesn't.
4. Tool descriptions, zod schemas and any user-facing text that lists harness names (`src/mcp/tools*.ts`, `skills/throng`, error messages): find every place that enumerates claude/codex/opencode and make gemini appear where a list of supported harnesses is given. Places that say "all three adapters" about behaviour gemini doesn't share (resume, steer) must stay true: reword rather than add gemini. Report the list of places touched.
5. `test/fake-agent`: a scenario that behaves like Gemini CLI: no `configOptions` in the session response, a `models` field, a `session/set_model` handler (records the model so the reply/call log shows it; accepts any string like the real one), modes `default | autoEdit | yolo | plan`, no `sessionCapabilities.resume`, no usage in updates or the prompt response. Reuse `FAKE_CALL_LOG` for `set_model`. Document it in `test/fake-agent/index.ts`.
6. `test/fake-harness.ts`: a way to get a config whose `gemini` harness is the fake agent (generalize `fakeClaude` or add a sibling; existing callers stay as they are).
7. Tests (vitest, next to the code, fake agent only):
   - run through `runCall` with harness `gemini`: policy `auto` → `set_mode yolo`; each of `allow_all`, `deny_all`, `elicit` → `set_mode default`; under every policy the agent process env has `GEMINI_CLI_TRUST_WORKSPACE=true` (make the fake expose its env value through the call log's `start` entry or similar, minimal);
   - model: a listed model is set through `session/set_model` before the prompt; an unlisted one → `model_rejected` naming the valid models, no prompt sent;
   - effort suffix → warning, turn completes;
   - a permission request under `allow_all` / `deny_all` in the gemini scenario is answered `allow_once` / `reject_once` (the §5 table; reuse the existing `permission` machinery of the fake if the scenario can be combined, otherwise the smallest addition);
   - result without `usage` when the agent reports none (assert what the result actually contains; do not invent zeros);
   - `send_message` to a gemini session → `session_not_found` with the "does not support session/resume" text;
   - probe: `list_harnesses` shows gemini with `models` from the `models` field and `efforts: []`; gemini not on PATH → `unavailable` with `gemini not found on PATH; install: npm i -g @google/gemini-cli`;
   - worker-level: `setModel` updates `session.models.current`; a malformed `models` field is ignored.
8. `scripts/smoke/smoke.ts` and `package.json` scripts: a gemini case. Add `gemini --acp` to `ADAPTER_PATTERNS`. The follow-up step needs `send_message`, which gemini doesn't have: for harness `gemini` the smoke skips the follow-up (same effect as `--no-follow-up`) and says why in its output; `--steer` with gemini is a usage error. Scripts: `smoke:gemini` (`gemini/gemini-2.5-flash`) and `smoke:gemini-schema`. Update `scripts/smoke/smoke.test.ts` if it covers argument handling. The maintainer's AC #5 also needs a `deny_all` run that refuses an edit: check how policy is chosen for smoke runs today (config file via `THRONG_MCP_CONFIG`?) and document the exact commands for the three maintainer runs (auto edits a file; deny_all refuses the edit; model and effort warning visible in the result) in `docs/development.md` under the smoke section. No new smoke flags unless there is no way to do it with config.
9. `README.md`: gemini among the supported harnesses; an install/sign-in block next to the OpenCode one (`npm i -g @google/gemini-cli`, run `gemini` once and sign in); the limits a user must know, one line each: no `send_message` follow-ups, no effort levels, no usage numbers, runs with the workspace trusted. Match the README's existing tone and structure. `docs/configuration.md`: add gemini where harness ids or per-harness examples are listed, and to troubleshooting if auth hints are listed per harness.

## Acceptance criteria (from the task)

1. `gemini/<model>[:<effort>]` runs through Gemini CLI over ACP; list_harnesses shows gemini with models and efforts read from the probe.
2. Policy auto → mode yolo with `GEMINI_CLI_TRUST_WORKSPACE=true`; allow_all, deny_all, elicit → mode default, request_permission answered per the §5 table.
3. gemini not on PATH → unavailable with the install hint derived from the registry entry.
4. Unit tests via test/fake-agent cover the mode and env wiring and the policy table; scripts/smoke has a gemini case.
5. (maintainer, after the run) smoke on the real CLI.
6. DESIGN §4.1 has a gemini column (done); README lists gemini with the sign-in step.

## Do not touch

`backlog/`, `.changeset/`, `data/registry.json`, the claude/codex/opencode definitions, anything outside the worktree. No new dependencies. No `session/load`. No reading of `_meta.quota`.

## Gates

`pnpm typecheck && pnpm lint && pnpm test` green. Only erasable TS syntax, imports with `.ts`. Comments per the surrounding code: sparse, purpose above public entities.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Recon 2026-10-03 against gemini-cli v0.61.0 source (packages/cli/src/acp, bundled @agentclientprotocol/sdk 0.16.1), nothing run locally (gemini is not installed here):
- session/new returns no configOptions. Models come only through the unstable `models` field (availableModels/currentModelId) and are set with session/set_model, which validates nothing. No thought_level/effort option; thinking is configurable only through settings modelConfigs overrides.
- No session/resume (no sessionCapabilities at all). Only session/load, which replays the whole history as notifications and does not await the replay.
- Modes: default, autoEdit, yolo, plan. set_mode yolo/autoEdit in an untrusted folder throws (-32603). Trust: GEMINI_CLI_TRUST_WORKSPACE=true or --skip-trust; folder trust is on by default.
- An untrusted folder does not start MCP servers at all, including the stdio server passed in session/new: throng's submit_result (structured output) needs the trust env under every policy, not only auto.
- request_permission: allow_once (proceed_once) and reject_once (cancel) are always present and unique; MCP tools from session/new ask in mode default. Read-only tools run without asking.
- No usage_update, no PromptResponse.usage, no cost; token counts only in PromptResponse._meta.quota.
- Prompt errors use HTTP statuses as JSON-RPC codes (429, 500); safety blocks end with end_turn.
- No client fs/* or terminal/* calls when not advertised. Launch: gemini --acp; model at launch via --model or GEMINI_MODEL.
Waiting on the maintainer: how to select the model (unstable set_model vs launch flag) and what send_message does without session/resume.

Maintainer 2026-10-03: send_message is not supported for gemini (no session/load fallback); the task runs after THRONG-21 lands, not in parallel. Model selection still open.

Maintainer 2026-10-03: model selection through the unstable models field and session/set_model.

Run .agent-runbooks/runs/20261003-throng-22 ended ready. Built as a native HarnessDefinition (THRONG-20 generic harness is not done). Contract by the main session: gemini in HARNESS_IDS, src/harnesses/gemini.ts, WorkerSession.models and Worker.setModel (raw session/set_model; the SDK 1.5.0 schema has no models field, parsed defensively), DESIGN §2.3, §3.1, §3.3, §3.4, §4.1, §4.2. Coder: selectModel and the probe fall back to session.models, fake-agent gemini scenarios, fakeAs in test/fake-harness, src/harnesses/gemini.test.ts, smoke case, README, docs/configuration.md, docs/development.md, skill text. Review: Opus 2 findings, GPT 1, all fixed, none rejected. a1: steer to a running gemini turn cancels it and then fails session_not_found; documented in README and the skill (code fix needs a static cannot-resume fact on HarnessDefinition, reported to the maintainer as a possible follow-up). a2: smoke orphan pattern widened to gemini.*--acp because the relaunched CLI process may show the package entry, not the bin name; to confirm on the real CLI. b1: the documented auto smoke now pins permissions: auto through its own config. Deviations and decisions: GEMINI_CLI_TRUST_WORKSPACE=true under every policy, not only auto (AC #2 names auto): an untrusted folder starts no MCP servers, so submit_result would not work; efforts is always [] and a :effort suffix gives the existing warning; usage is {} (key present, empty), PromptResponse._meta.quota is not read; no session/load. Gates in the worktree: pnpm typecheck, pnpm lint, pnpm test green, 26 files, 296 tests. Evidence per AC: #1 gemini.test.ts (run through runCall, set_model before the prompt, model_rejected for an unlisted model, list_harnesses models from the models field, efforts []); #2 gemini.test.ts policy x mode with trust=true in the start entry, allow_once/reject_once answers, index.test.ts permissionSetup table; #3 index.test.ts and mcp.test.ts: 'gemini not found on PATH; install: npm i -g @google/gemini-cli'; #4 the tests above plus smoke.test.ts gemini case and package.json smoke:gemini; #6 DESIGN §4.1 table, README Gemini CLI block. AC #5 waits on the maintainer: three commands in docs/development.md (smoke section). Gemini CLI was never run here (not installed): everything about the real CLI comes from reading its 0.61.0 source.
<!-- SECTION:NOTES:END -->
