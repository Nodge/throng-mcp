---
id: THRONG-20
title: 'Generic harness: launch any ACP registry agent'
status: To Do
assignee: []
created_date: '2026-10-02 21:22'
labels: []
milestone: m-3
dependencies: []
references:
  - 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
priority: high
type: feature
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
throng has three native harnesses (claude, codex, opencode). The ACP registry snapshot in data/registry.json lists 41 agents, and users come with the harness and subscription they already have (Kimi CLI, Qwen Code, Goose, Amp, Antigravity, ...): telling them to install opencode and reconfigure a provider there is a barrier, not an answer. A generic harness lets any registry id run as '<registry-id>/<model>[:<effort>]' with only the registry entry and the ACP session data, no per-harness code.

DESIGN §11 says generic harnesses have "no native auto". Research (2026-10-02) shows that is too pessimistic: Gemini CLI, Qwen Code, Goose, Antigravity and amp-acp all advertise an auto mode in session/new modes.availableModes under the ids yolo, auto or bypass, switchable with session/set_mode. The generic harness can pick policy auto from that list. Model and effort come from ACP config options (categories model and thought_level), the same way list_harnesses already reads them.

Decision-3 stays: throng installs nothing. A generic harness is available only when the user installed it: the command from distribution (npx package bin or binary cmd) must be on PATH; otherwise unavailable with the registry install hint. Native definitions (claude, codex, opencode) take precedence over the registry entry with the same id.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 run_thronglet accepts any registry id from data/registry.json as the harness segment of agent; launch command and args come from the registry distribution (npx: the package bin on PATH, binary: cmd), env from the registry entry plus config overrides
- [ ] #2 A generic harness whose command is not on PATH is unavailable: list_harnesses lists it under unavailable with the install hint, run_thronglet fails with harness_unavailable before spawn
- [ ] #3 Policy auto on a generic harness: when session/new advertises a mode with id yolo, auto or bypass it is selected with session/set_mode; otherwise the harness runs in its default mode and the call carries a warning that no auto mode was found; the rest of the policy table (§5) applies unchanged
- [ ] #4 Model and effort on a generic harness are set through config options of categories model and thought_level; a model not offered → model_not_found as for native harnesses; a harness without thought_level + an explicit effort → warning
- [ ] #5 Native definitions keep precedence: claude, codex, opencode behave exactly as before, list_harnesses output for them is unchanged
- [ ] #6 Tests via test/fake-agent cover: launch from a registry entry, auto via availableModes, missing auto mode warning, model/effort via config options, unavailable with install hint
- [ ] #7 DESIGN §4.1 and §11 describe the generic harness and drop the "no native auto" claim; README lists how a registry harness is named and what it needs installed
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
