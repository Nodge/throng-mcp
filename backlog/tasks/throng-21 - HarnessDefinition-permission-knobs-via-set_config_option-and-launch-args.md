---
id: THRONG-21
title: 'HarnessDefinition: permission knobs via set_config_option and launch args'
status: To Do
assignee: []
created_date: '2026-10-02 21:22'
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
- [ ] #1 permissionSetup can return configOptions: Array<{ id, value }>; the Worker applies them with session/set_config_option after session/new and again after session/resume, before the first prompt
- [ ] #2 permissionSetup can return args: string[] appended to the launch args of the adapter process for that policy (both for session/new and session/resume processes)
- [ ] #3 A config option the agent does not advertise, or a set_config_option error, surfaces as a warning on the call and the turn still runs
- [ ] #4 Existing harnesses are unaffected: claude, codex, opencode pass the existing tests unchanged
- [ ] #5 test/fake-agent can advertise config options and record set_config_option calls; tests cover apply-after-new, apply-after-resume, unknown option warning, args appended
- [ ] #6 DESIGN §4.1 (HarnessDefinition) and §4.2 (Worker steps) updated in the same commit
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
