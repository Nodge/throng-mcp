---
id: THRONG-22
title: Gemini CLI as a native harness
status: To Do
assignee:
  - '@fable'
created_date: '2026-10-02 21:22'
updated_date: '2026-10-03 10:04'
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
- [ ] #1 Agent strings gemini/<model>[:<effort>] run through Gemini CLI over ACP; list_harnesses shows gemini with its models and efforts read from the probe
- [ ] #2 Policy auto selects mode yolo and the process runs with GEMINI_CLI_TRUST_WORKSPACE=true; allow_all, deny_all and elicit run in mode default and request_permission is answered per the §5 table
- [ ] #3 gemini not on PATH → unavailable with the install hint derived from the registry entry
- [ ] #4 Unit tests via test/fake-agent cover the mode and env wiring and the policy table; scripts/smoke has a gemini case
- [ ] #5 Maintainer smoke on the real Gemini CLI: a run with auto that edits a file in a temp project, one with deny_all that refuses an edit, model and effort visible in the result
- [ ] #6 DESIGN §4.1 table gets a gemini column; README lists gemini among supported harnesses with the sign-in step
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

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
<!-- SECTION:NOTES:END -->
