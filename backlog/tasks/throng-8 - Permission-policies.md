---
id: THRONG-8
title: Permission policies
status: Review
assignee:
  - '@nodge'
created_date: '2026-09-27 18:56'
updated_date: '2026-10-02 17:39'
labels: []
milestone: m-1
dependencies:
  - THRONG-5
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`auto` is not always acceptable: some setups need a locked-down agent or a human in the loop. The policy comes from config only, so the calling model cannot grant itself more.

Scope: DESIGN §5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `allow_all`, `deny_all` and `elicit` behave per the DESIGN §5 table; options are picked by kind and are always `*_once`
- [x] #2 `elicit` without the client capability fails with `elicitation_unsupported` before spawn; an unanswered elicitation times out to `cancelled`
- [x] #3 Pending permission requests are answered `cancelled` on cancel
- [x] #4 Tests use the fake-agent `permission` scenario and a fake MCP client with the capability
- [ ] #5 Smoke: elicit from an interactive session
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-8: permission policies `allow_all`, `deny_all`, `elicit`

Source of truth: docs/DESIGN.md §5 (Permissions), §3.2 error table (`elicitation_unsupported`), §4.2 cancel path ("All pending request_permission are answered cancelled"), §8 config (`permissions`, `limits.elicitation_s`), §2.4 (Claude Code supports elicitation form mode). Read §5 in full before coding; the table there is the contract.

## What exists today

- `src/config.ts`: `permissions: auto | allow_all | deny_all | elicit`, per-harness override, `limits.elicitation_s` (default 600). Nothing to change there.
- `src/permissions.ts`: `createPermissionBridge(policy, onDecision, decide?)`, `decideReject` (reject_once by kind, else cancelled), `isThrongResultCall` + allow_once for our `submit_result` before the policy, `cancelAll()` answering pending and later requests `cancelled`. `deciderFor(policy)` returns `decideReject` for auto and a stub (`cancelled`) for the rest.
- `src/run.ts` ~line 166: guard `if (policy !== 'auto') throw harness_unavailable "not supported yet (v2)"`. Remove it; the three policies now run.
- Harness side is DONE (THRONG-3, `src/harnesses/{claude,codex,opencode}.ts` `permissionSetup`, tested in `src/harnesses/index.test.ts`): non-auto policies put claude in mode `default`, codex in `read-only`, opencode under `OPENCODE_CONFIG_CONTENT={"permission":"ask"}`. Don't touch.
- `src/contract.ts`: `ErrorCode` already has `elicitation_unsupported`. Don't edit contract.ts (owned by the main session); if you believe a contract change is needed, stop and say so in the report.
- Fake agent `test/fake-agent/agent.ts` scenario `permission`: one `request_permission` (title `write notes.txt`, kind `edit`, options allow_once `yes`, allow_always `always`, reject_once `no`), then says `allowed` / `rejected` / `cancelled`. Scenario `hang` for cancel tests. Add scenarios only if needed (e.g. a request whose options lack `reject_once`, or `permission-hang` that asks and then the test cancels while the elicitation is pending). Register new scenarios in `test/fake-agent/index.ts` `FakeScenario`.
- `src/mcp.test.ts` runs the real server over stdio with `@modelcontextprotocol/sdk` `Client`; the fake agent is wired as a harness through a config file (`harnesses: claude: command/args` → `test/fake-agent/agent.ts`). Follow the existing helpers there (`serverEnv`, `writeConfig`, `newTag`, pgrep for leftovers).

## Contracts (fixed; the main session owns them)

1. `src/permissions.ts` exports:

```ts
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/** The MCP client's elicitation, form mode; absent on RunContext when the client lacks the capability. */
export interface Elicitation {
    /** `server.server.elicitInput`; rejects on `signal` abort and after `timeoutMs`. */
    ask(params: ElicitRequestFormParams, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ElicitResult>;
}

export interface DeciderOptions {
    elicitation?: Elicitation;
    /** `limits.elicitation_s * 1000`. */
    elicitationTimeoutMs: number;
}

export function deciderFor(policy: PermissionPolicy, opts: DeciderOptions): Decide;
```

   `createPermissionBridge(policy, onDecision, decide)` keeps its signature; `decide` becomes required (run.ts passes `deciderFor(policy, …)`). Keep `decideReject`, `isThrongResultCall`, `resolvePolicy`, `PermissionDecision`, `cancelAll` semantics as they are.

2. `RunContext` (src/run.ts) gets `elicitation?: Elicitation` — undefined when the client has no `elicitation` capability. `src/mcp/tools.ts` `registerTools(server, deps)` builds it per call (capabilities are known only after initialize, so compute inside `callRun` / `callBackground`, not at registration): `server.server.getClientCapabilities()?.elicitation ? { ask: (params, { signal, timeoutMs }) => server.server.elicitInput(params, { signal, timeout: timeoutMs }) } : undefined`. Background turns use the same server-level `elicitInput` (it does not depend on the call still being open).

## Behaviour (DESIGN §5)

Decision by policy, always picked by `kind`, always `*_once`, never `allow_always`/`reject_always`:

- `auto`: `decideReject` (unchanged).
- `allow_all`: `allow_once` by kind; if the options have none → `reject_once`; if none either → `cancelled`.
- `deny_all`: same as `decideReject` (`reject_once`, else `cancelled`).
- `elicit`:
  - Guard at call start in run.ts (next to the config/depth guards, before spawn, before the session lock): policy `elicit` and `ctx.elicitation` undefined → `ThrongError('elicitation_unsupported', …)` with a message saying the MCP client doesn't support elicitation and naming the config key to change. For a `background: true` call this fails the call itself (it is a pre-turn failure like depth/handshake), covered by the existing background acceptance logic — no special code.
  - Per request: `elicitation.ask` in form mode: `message` = `[agent] <toolCall.title>` then one line each for `kind`, `rawInput` as JSON truncated to 2 KB (say so when truncated), `locations` (paths joined), only when present. `requestedSchema` = `{ type: 'object', properties: { decision: { type: 'string', title: 'Decision', oneOf: [{ const: <kind>, title: <option.name> }, …] } }, required: ['decision'] }` with one entry per `*_once` kind present in `options` (first option of each kind wins); **not** `enum`/`enumNames`. If the options have no `*_once` kind at all, answer `cancelled` without asking.
  - Result: `accept` with `content.decision` a kind present → that option's id; `accept` with anything else → `cancelled`; `decline` → `reject_once` if present else `cancelled`; `cancel` → `cancelled`.
  - Timeout `elicitationTimeoutMs` (SDK `timeout` option) → `cancelled`; the agent gets a rejection and the run continues (the call does not fail). Any other rejection from `ask` (transport gone) → `cancelled` as well; log it.
  - Cancel of the run (`cancelAll`): the bridge already aborts `controller.signal`; make sure the signal reaches `ask` so the SDK sends `notifications/cancelled` for the pending elicitation, and the request is answered `cancelled` (AC #3).
  - A request for our own `submit_result` is still `allow_once` before the policy (existing `allowOwnTool`), no elicitation for it.
- Every decision is logged through the existing `onDecision` (unchanged). For `elicit` also report the wait through progress if cheap (e.g. `ctx.progress.tool(\`permission: <title>\`)`) — optional, don't build new progress kinds.

## Tests (vitest, no LLM)

- `src/permissions.test.ts`: unit tests of `deciderFor` for `allow_all` (allow_once picked by kind, never allow_always; fallback reject_once; fallback cancelled), `deny_all`, `elicit` with a fake `Elicitation` (accept/decline/cancel/timeout-rejection/invalid decision; the requestedSchema shape — `oneOf` with const+title, only `*_once` kinds; message contents incl. 2 KB truncation; abort signal propagated into `ask`).
- `src/run.test.ts` (fake-agent `permission` scenario through `runCall` with a fake `Elicitation` on the context): `allow_all` → text `allowed`; `deny_all` → `rejected`; `elicit` accept → `allowed`, decline → `rejected`, timeout → `cancelled`; `elicit` without `ctx.elicitation` → `elicitation_unsupported`, and no adapter was spawned (pgrep the tag). Cancel while the elicitation is pending (ask never resolves until its signal aborts) → the run fails `cancelled`, the fake `ask` saw the abort, the decision log says `cancelled`.
- `src/mcp.test.ts`: one stdio test with the real server, config `permissions: elicit`, a `Client` created with `capabilities: { elicitation: {} }` and `setRequestHandler(ElicitRequestSchema, …)` answering `accept {decision:'allow_once'}`: `run_thronglet` on the fake agent returns `allowed`, and the handler saw the message `[agent] write notes.txt` and a `oneOf` with `allow_once` and `reject_once` only. A second stdio test with a Client without the capability → tool error `elicitation_unsupported` (AC #2, AC #4).
- Existing tests must keep passing; `src/harnesses/index.test.ts` already covers permissionSetup per policy.

## Docs

- README: the intro sentence ("v1 runs every harness in its own auto-approve mode…"), the error table row for `harness_unavailable` (drop "unsupported permission policy"), the line "`elicitation_unsupported` belongs to a feature not built yet" (replace with what it means and the fix), the config example comments (`permissions`, per-harness override, `elicitation_s`), the Troubleshooting bullet about `permissions` other than `auto`. Add a short Permissions section (or extend the existing text) with the §5 table in words: what each policy does on each harness and that elicit needs an MCP client with elicitation (Claude Code has it; inside a nested thronglet the client is the harness, which usually doesn't — the run fails before spawn).
- `skills/throng/SKILL.md` ## Permissions: rewrite the paragraph — all four policies run; what `elicit` means for the caller (the human answers each request in the client's dialog; a background turn's requests arrive the same way; a nested throng server usually has no elicitation and fails with `elicitation_unsupported`). Keep it to one paragraph of the same register as the rest of the skill; `src/skill.test.ts` checks error codes named in the skill against the code.
- DESIGN §9 and §8 need no change unless you find the text wrong; the §5 contract is implemented as written, don't reword it.

## Out of scope / don't touch

- `src/contract.ts`, `backlog/`, `~/.claude`, harness definitions, the smoke script (unless a `--policy` flag is trivial — then it's welcome but optional; AC #5 smoke is the maintainer's, from an interactive session).
- No new tool parameters: the policy comes from config only (§5).

## Acceptance criteria (from the task)

1. `allow_all`, `deny_all` and `elicit` behave per the DESIGN §5 table; options are picked by kind and are always `*_once`.
2. `elicit` without the client capability fails with `elicitation_unsupported` before spawn; an unanswered elicitation times out to `cancelled`.
3. Pending permission requests are answered `cancelled` on cancel.
4. Tests use the fake-agent `permission` scenario and a fake MCP client with the capability.
5. (maintainer) Smoke: elicit from an interactive session.

Gates: `pnpm typecheck && pnpm lint && pnpm test`. Formatting via prettier in the pre-commit hook; don't hand-format. Comment sparingly: purpose above public entities, inside bodies only for non-obvious intent.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
When this lands, update the Permissions paragraph of skills/throng/SKILL.md (THRONG-14): it currently says only auto runs and other policies fail with harness_unavailable.

task-cycle wf_5e15fef7-1f0: Opus coder, gates green (267 tests), Opus review 0 findings, Codex review 0 findings, 0 fix rounds. Spot-checked by the main session: src/permissions.ts (pick by kind, decideAllow fallback chain, elicit form schema with titled oneOf of *_once kinds, every ask failure → cancelled, bridge signal passed into ask), run.ts guard (elicitation_unsupported before the session lock, message names the config key), tools.ts (elicitation built per call from getClientCapabilities()?.elicitation?.form, shared by callRun and callBackground), stdio tests with a Client with/without the capability. Coder deviations accepted: capability check on .form (SDK normalizes elicitation: {} to {form: {}}; DESIGN §5 updated by the main session); fake agent gained mode 'default' (claude's asking mode); truncation at 2048 chars; progress 'permission: <title>' sent from run.ts onPermission. Outside the task, flagged by the coder: DESIGN §2.3 says opencode calls fs/write_text_file after an approved edit without checking the client capability — allow_all/elicit on opencode may not write the file; to check in the smoke.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
allow_all, deny_all and elicit run (src/permissions.ts deciderFor: pick by kind, *_once only; elicit asks the MCP client in form mode with a titled oneOf of the *_once kinds, every ask failure/timeout/bad answer → cancelled, bridge signal passed into ask); run.ts refuses elicit without the client capability with elicitation_unsupported before spawn, message names the config key; tools.ts builds the elicitation per call from getClientCapabilities()?.elicitation?.form (SDK normalizes elicitation: {} to {form: {}}; DESIGN §5 updated). README Permissions section, SKILL.md paragraph. Verified: tsc 0, eslint 0, vitest 267/267 incl. permissions.test deciders, run.test policies via the fake-agent permission scenario (timeout 0.2 s, cancel while pending, no spawn), two stdio tests with a Client with/without the elicitation capability. Reviewed by nodge in Sherpa, no code changes. Pending: maintainer smoke (AC #5), elicit from an interactive session — status Review.
<!-- SECTION:FINAL_SUMMARY:END -->
