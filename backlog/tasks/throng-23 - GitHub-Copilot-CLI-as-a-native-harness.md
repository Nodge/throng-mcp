---
id: THRONG-23
title: GitHub Copilot CLI as a native harness
status: Blocked
assignee: []
created_date: '2026-10-02 21:23'
labels: []
milestone: m-3
dependencies:
  - THRONG-21
references:
  - 'https://github.com/github/copilot-cli/issues/4537'
  - 'https://github.com/github/copilot-cli/blob/main/changelog.md'
priority: medium
type: feature
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Copilot subscriptions are common in teams, and the Copilot CLI gives Claude, GPT and Gemini models under that one subscription; the quota is bound to GitHub login, so no other harness can spend it. Registry id github-copilot-cli, launch 'copilot --acp' (npx package @github/copilot). Auto approval in ACP: flag --allow-all-tools (alias --yolo, supported in ACP since 0.0.400) or session/set_config_option allow_all=on (works since 1.0.88). Both knobs need the HarnessDefinition extension task.

Blocked by an upstream regression: since Copilot CLI 1.0.81 the ACP server never sends request_permission at all (github/copilot-cli issue #4537), so deny_all and elicit cannot be implemented honestly; every policy would behave as allow_all. Pick the task up when the issue is closed and a release restores request_permission. Copilot CLI is closed source: the exact mode ids and config option ids must be read from the probe (session/new response), not assumed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Agent strings copilot/<model>[:<effort>] run through Copilot CLI over ACP; list_harnesses shows copilot with models and efforts from the probe
- [ ] #2 Policy auto turns on allow_all (config option or flag); allow_all, deny_all and elicit leave it off and answer request_permission per the §5 table, verified against a Copilot release where request_permission is sent
- [ ] #3 copilot not on PATH → unavailable with the install hint from the registry entry
- [ ] #4 Unit tests via test/fake-agent for the wiring; scripts/smoke has a copilot case; maintainer smoke on the real CLI with auto and deny_all
- [ ] #5 DESIGN §4.1 table and README updated
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Blocked on github/copilot-cli issue #4537 (ACP never sends request_permission since 1.0.81). Re-check the changelog before starting.
<!-- SECTION:NOTES:END -->
