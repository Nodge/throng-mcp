---
id: THRONG-21
title: 'HarnessDefinition: permission knobs via set_config_option and launch args'
status: Done
assignee:
  - '@fable'
created_date: '2026-10-02 21:22'
updated_date: '2026-10-03 10:13'
labels: []
milestone: m-3
dependencies: []
priority: medium
type: feature
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
permissionSetup(policy) in HarnessDefinition returns modeId, env and newSessionMeta (DESIGN §4.1). Two mechanisms used by real agents are missing. GitHub Copilot CLI and JetBrains Junie switch auto approval through session/set_config_option (Copilot: configId allow_all, value on, since 1.0.88; Junie: brave_mode=true); amp-acp accepts permission=bypass the same way. Cursor enables auto only with a global CLI flag placed before the subcommand ('cursor-agent --force acp'), i.e. the policy has to change the launch args. Without these two knobs Copilot, Junie and Cursor cannot get policy auto, and the generic harness (see the generic harness task) cannot use a config-option based auto.

This is a contract change (Fable edits the contract itself per AGENTS.md roles): extend permissionSetup, apply the result in the Worker after session/new and session/resume (config options are per adapter process, like modes), and reflect it in DESIGN §4.1 and §4.2. No native definition for Copilot or Cursor in this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 permissionSetup can return configOptions: Array<{ id, value }>; the Worker applies them with session/set_config_option after session/new and again after session/resume, before the first prompt
- [x] #2 permissionSetup can return args: string[] appended to the launch args of the adapter process for that policy (both for session/new and session/resume processes)
- [x] #3 A config option the agent does not advertise, or a set_config_option error, surfaces as a warning on the call and the turn still runs
- [x] #4 Existing harnesses are unaffected: claude, codex, opencode pass the existing tests unchanged
- [x] #5 test/fake-agent can advertise config options and record set_config_option calls; tests cover apply-after-new, apply-after-resume, unknown option warning, args appended
- [x] #6 DESIGN §4.1 (HarnessDefinition) and §4.2 (Worker steps) updated in the same commit
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-21: permission knobs via set_config_option and launch args

Repo: the worktree you were given (branch `throng-21`). Read AGENTS.md "Code rules" and DESIGN.md §4.1, §4.2, §5 first.

## Goal

`HarnessDefinition.permissionSetup(policy)` gains two mechanisms: config options set over `session/set_config_option`, and extra launch args. The Worker/run flow applies them. No new harness definitions (Copilot, Junie, Cursor are other tasks); claude, codex and opencode keep returning what they return today.

## Already done by the main session (commit `THRONG-21: contract …` on this branch). Do not change these

- `src/harnesses/types.ts`: `ConfigOptionValue = string | boolean`; `PermissionSetup.configOptions?: { id; value }[]` and `PermissionSetup.args?: string[]`.
- `src/acp/types.ts`: `Worker.setConfigOption(configId, value: string | boolean)`.
- `docs/DESIGN.md` §4.1 (interface block and the paragraph after it) and §4.2 step 4. If the implementation ends up contradicting that text, stop and report it instead of editing either side silently.

## What to implement

1. `src/acp/worker.ts` `setConfigOption`: accept `string | boolean`. ACP 1.5.0 `SetSessionConfigOptionRequest` is a union: a boolean goes as `{ type: 'boolean', value }`, a string as `{ value }` (see `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`). No casts around the union.
2. `src/run.ts`:
   - launch args: `[...launch.args, ...(setup.args ?? [])]`. The same code path serves `session/new` and `session/resume`; keep it one path.
   - after `setMode` and before `selectModel`: apply `setup.configOptions` in order. For each: the id is absent from `worker.session.configOptions` → warning, no request. Present → `worker.setConfigOption(id, value)` under `lifecycle.guard`; a `ThrongError` with code `agent_error` → warning, the turn goes on. Any other failure (`transport_lost`, cancel, timeout from the guard) propagates as it does for the mode. Warnings go through the existing `warn`/`warnings` of the call and name the harness, the option id and, for a rejection, the agent's error text. Put the loop in a small function next to `selectModel`/`selectEffort` in `src/harnesses/select.ts` if that reads better than inline; it must stay harness-agnostic.
   - `src/list.ts` (the probe) stays as is: no policy, no policy args.
3. `test/fake-agent`: 
   - it can advertise extra config options: env knob `FAKE_CONFIG_OPTIONS` (JSON array of `SessionConfigOption`) appended to the session's options on `session/new` and `session/resume`; support a boolean option in `session/set_config_option` (`type: 'boolean'`, value must be a boolean) next to the existing select handling;
   - it records what it was asked: every `session/set_config_option` call (`configId`, `value`, whether the session was resumed) and the process argv. Pick the simplest observable channel that fits the existing fake (check how `resume-memory` uses `FAKE_MEMORY_DIR`, or echo it in the reply text the way mode/model are echoed, if they are); tests must be able to assert order relative to the prompt, i.e. that the options were applied before the first prompt.
   - document the new knobs in the comment in `test/fake-agent/index.ts`.
4. Tests (vitest, next to the code, through the fake agent only). A definition with `configOptions`/`args` is needed: `runCall` takes the definition from `HARNESSES`, so look at how existing run tests inject harness behaviour (`test/fake-harness.ts`, `src/run.test.ts`) and pick the least invasive way to run a turn with a `permissionSetup` that returns `configOptions` and `args`; do not add a production harness for this and do not add test-only branches to production code. If the only way is a new seam in `RunContext`, keep it minimal and say so in the report. Cover:
   - options applied after `session/new`, before the first prompt, in order; a boolean option goes out as a boolean;
   - applied again after `session/resume` (send_message path);
   - an option the agent does not advertise → warning in the result, no request sent, turn completes;
   - an option the agent rejects (`agent_error`) → warning, turn completes;
   - `args` appended to the adapter's argv on both `session/new` and `session/resume` processes;
   - worker-level: `setConfigOption` with a boolean.
5. Existing tests for claude/codex/opencode pass unchanged (AC #4): do not edit existing assertions; add new tests.

## Acceptance criteria (from the task)

1. permissionSetup can return `configOptions`; applied with session/set_config_option after session/new and again after session/resume, before the first prompt.
2. permissionSetup can return `args` appended to the launch args for that policy, for session/new and session/resume processes.
3. An option the agent does not advertise, or a set_config_option error, surfaces as a warning on the call and the turn still runs.
4. Existing harnesses unaffected: existing tests pass unchanged.
5. fake-agent can advertise config options and record set_config_option calls; tests cover apply-after-new, apply-after-resume, unknown option warning, args appended.
6. DESIGN §4.1 and §4.2 updated (done by the main session; verify the code matches).

## Do not touch

`backlog/`, `.changeset/`, `README.md`, `src/contract.ts`, the three harness definitions' behaviour, `data/registry.json`, anything outside the worktree. No new dependencies.

## Gates

`pnpm typecheck && pnpm lint && pnpm test` green. Only erasable TS syntax, imports with `.ts`. Comments per the surrounding code: sparse, purpose above public entities.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Run .agent-runbooks/runs/20261003-throng-21 ended ready. Contract (PermissionSetup.configOptions/args, Worker.setConfigOption with booleans, DESIGN §4.1/§4.2) edited by the main session before the run. Review: Opus 1 finding, GPT 0. a1 fixed: the rejected-option warning carried up to 2 KB of adapter stderr, repeated on every resumed turn; the warning now carries only the agent's error text (withoutStderrTail in worker.ts, test with FAKE_STDERR). Nothing rejected in triage. Decisions: option values are string | boolean (ACP 1.5.0 has boolean options; Junie's brave_mode is one); only agent_error becomes a warning, transport loss, cancel and timeout fail the run like the mode does; the list_harnesses probe launches without policy args or env. Test seam: vi.spyOn(HARNESSES.claude, 'permissionSetup'), no new production seam; safe while run.test.ts is not concurrent. Fake agent got FAKE_CONFIG_OPTIONS, FAKE_CALL_LOG, FAKE_STDERR. For Cursor: args are appended, so its definition keeps the launch args empty and returns ['--force','acp'] or ['acp'] from permissionSetup. DoD #3: DESIGN §3 unchanged, §4.1/§4.2 updated.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
permissionSetup can return configOptions (applied with session/set_config_option after the mode, on new and resumed sessions, best effort with warnings) and args (appended to the adapter launch args). claude, codex and opencode are unchanged. Verified by pnpm typecheck, pnpm lint and pnpm test in the worktree (25 files, 273 tests): run.test.ts 'permission setup: config options and launch args' covers order after new and resume, boolean values, unadvertised and rejected options, argv of both processes; worker.test.ts covers the boolean request. Existing assertions untouched.
<!-- SECTION:FINAL_SUMMARY:END -->
