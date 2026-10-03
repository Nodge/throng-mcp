---
id: THRONG-26
title: >-
  send_message refuses a session that cannot resume before touching the running
  turn
status: Done
assignee:
  - '@fable'
created_date: '2026-10-03 12:51'
updated_date: '2026-10-03 13:29'
labels: []
milestone: m-3
dependencies: []
priority: medium
type: bug
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A harness without session/resume (today Gemini CLI, later any generic registry agent from THRONG-20) gives one-turn sessions. throng learns this only when the next turn's adapter process answers initialize, i.e. after send_message has already spawned a process, and with steer: true after it has already cancelled the running turn (src/run.ts: the steer abort comes before the worker start; src/acp/worker.ts refuses with session_not_found 'adapter does not support session/resume'). Result: a steer at a running gemini turn destroys the turn and delivers nothing. Found in the THRONG-22 review (finding a1); README and the throng skill currently only warn about it.

Maintainer's decision 2026-10-03: no static flag on HarnessDefinition. The session record remembers what the adapter advertised (sessionCapabilities.resume) when the session was created, and send_message reads it. The capability is known from the first turn's handshake, before the record is written, so already the first send_message is refused early; it must not fail the way it does now. Records written before this change have no such field and keep today's behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The session record stores whether the adapter advertised session/resume, taken from the handshake of the turn that created the session
- [x] #2 send_message to a session recorded as unable to resume fails with session_not_found before spawning an adapter process, and the message says the harness cannot continue a session
- [x] #3 With steer: true on such a session the running turn is not cancelled: it completes and its result is delivered as usual
- [x] #4 A record without the field (written by an earlier version) behaves as today; harnesses that can resume are unaffected
- [x] #5 list_thronglets shows that a session cannot take another message, so a caller sees it before trying
- [x] #6 Tests via test/fake-agent: early refusal without a spawn, steer leaves the running turn alive, old record without the field
- [x] #7 DESIGN §3.3, §3.7 and §8 (session record) updated; README and skills/throng wording about steering a gemini session corrected
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the runbook-task-cycle; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-26: send_message refuses a session that cannot resume before touching the running turn

## Problem

A harness whose adapter does not advertise `agentCapabilities.sessionCapabilities.resume` (today Gemini CLI) gives one-turn sessions. throng learns it only when the next turn's adapter answers `initialize`: `send_message` has already spawned a process, and with `steer: true` has already cancelled the running turn (`src/run.ts`, the steer abort around line 229 precedes the worker start; `src/acp/worker.ts` ~line 220 then refuses with `session_not_found`, "adapter does not support session/resume"). A steer at a running gemini turn destroys the turn and delivers nothing.

Maintainer's decision: no static flag on `HarnessDefinition`. The session record remembers what the adapter advertised when the session was created, and `send_message` reads it.

## Contracts (fixed, implement verbatim)

1. `SessionRecord` (`src/sessions.ts`) gets `resumable?: boolean`: whether the adapter advertised `sessionCapabilities.resume` in the handshake of the turn that created the session. Absent on records written by earlier versions, which means unknown.
   - Written at the single creation site in `src/run.ts` (the `writeSessionRecord` call for `request.kind === 'new'`), from `worker.session.agentCapabilities?.sessionCapabilities?.resume != null`. Always written there, `true` or `false`. Later writes merge, so nothing else needs to carry it.
2. `send_message` on a record with `resumable === false` fails with `ThrongError('session_not_found', …)` before anything else happens: before the guards, the steer abort, the session lock, the semaphore and the spawn. Place it where the record is loaded for a resume (the `request` thunk in `src/mcp/tools/send-message.ts`, or right after `call.request()` in `runCall`; pick the one that reads better, the order is what matters). Message: `session <id> cannot take another message: the <harness> harness has no session/resume, so its sessions are one turn`. Like other failures before the lock it carries no `session_id` and leaves the record untouched.
   - `resumable === undefined` (old record) and `true` go on as today. The refusal in `src/acp/worker.ts` stays as the fallback for old records. `wait_thronglet` and `cancel_thronglet` are not affected: do not put the check in `loadSessionRecord`.
3. `ThrongletInfo` (`src/contract.ts`) gets a required `accepts_messages: boolean`, placed after `queued`, doc comment: `false`: the harness cannot resume a session, so `send_message` to it fails with `session_not_found`. Built in `src/list-thronglets.ts` as `record.resumable !== false`.
4. Tool descriptions: `list_thronglets` (`src/mcp/tools/list-thronglets.ts`) names the new field; `send_message` says that a session whose harness cannot resume takes no further message, steer included, and that `list_thronglets` shows it as `accepts_messages: false`. Keep them as short as the neighbouring text.

## Tests (vitest, next to the code, through test/fake-agent, no LLM)

- A new session records the capability: `resumable: true` on a normal scenario, `false` on `no-resume` (and a gemini scenario in `src/harnesses/gemini.test.ts`).
- Early refusal: `send_message` to a record with `resumable: false` gives `session_not_found` with the new message, and no adapter process was spawned. Prove "never spawned" with `FAKE_CALL_LOG` + `readFakeCalls` returning `[]` (`tagAlive` only shows nothing is alive now). The record is unchanged.
- Steer: a turn is running in a session recorded as `resumable: false`; `send_message` with `steer: true` is refused; the running turn is not cancelled, completes and its result is delivered as usual (through the run's own outcome and the record's `last_result`). The fake agent has no hanging scenario without the resume capability (`steer` advertises resume; only `no-resume` and `gemini*` drop it). Add the smallest knob that gives one, e.g. an env variable that drops the capability for any scenario, documented with the other knobs in `test/fake-agent/index.ts`.
- Old record without the field: behaviour as today. `src/run.test.ts` 'harness without resume capability → session_not_found' and `src/harnesses/gemini.test.ts` 'send_message to a gemini session → …' hand-write records without the field and already cover this; keep them on that path and make the titles say they are the old-record case. Add the steer side if missing is cheap: not required.
- `list_thronglets`: `accepts_messages` is `false` for a `resumable: false` record, `true` for `resumable: true` and for a record without the field.
- One check over stdio in `src/mcp.test.ts` only if an existing test extends naturally; do not build a new sandbox for it.

`h.record` in `test/fake-harness.ts` and the local `record()` helpers may take the new field through their existing `fields` argument; do not change their defaults.

## Docs

- `docs/DESIGN.md` §3.2: the `session_not_found` comment in the error list still fits; touch only if wrong after the change.
- §3.3 `send_message`: replace "Gemini CLI has no session/resume … always fails this way" with the mechanism: the record remembers the capability, the refusal comes before a process is spawned, old records fail at the handshake as before. In the Steer paragraph: a session that cannot resume is refused before the running turn is cancelled.
- §3.7 `list_thronglets`: add `accepts_messages` to the output type and one sentence to the prose.
- §8: add `resumable?` to the session record shape, with one sentence on where it comes from and what its absence means.
- `README.md` Gemini limits (the "One turn per session" bullet, ~line 115): `send_message` is refused up front, with `steer: true` too, and the running turn is left alone; `list_thronglets` shows `accepts_messages: false`. Sessions created by an earlier throng version behave the old way: mention it only in DESIGN, not in README.
- `skills/throng/SKILL.md`: the `session_not_found` row of the error table and, if it fits in one clause, the `list_thronglets` mention: `accepts_messages: false` marks a session that takes no further message. No harness names in the skill, no separate note on one-turn sessions.

Write docs in the style of the surrounding text. No em-dash-heavy prose, no "now"/"previously" history in DESIGN: it describes the current state.

## Do not touch

- `backlog/`, `.changeset/`, `CHANGELOG.md`, anything outside the project directory (`~/.claude`, the installed copy of the skill).
- `HarnessDefinition` and `src/harnesses/*` definitions: no static capability flag.
- `wait_thronglet`, `cancel_thronglet`, `list_harnesses` behaviour and output.
- DESIGN §9's stale mention of a `resume` fake-agent scenario and `docs/development.md`: out of scope.

## Code rules

Erasable TS only, imports with `.ts`, comments sparse and in the style of the file. Gates: `pnpm typecheck && pnpm lint && pnpm test`. Prettier runs in the pre-commit hook; do not hand-format.

## Acceptance criteria (from the task)

1. The session record stores whether the adapter advertised session/resume, taken from the handshake of the turn that created the session.
2. `send_message` to a session recorded as unable to resume fails with `session_not_found` before spawning an adapter process, and the message says the harness cannot continue a session.
3. With `steer: true` on such a session the running turn is not cancelled: it completes and its result is delivered as usual.
4. A record without the field behaves as today; harnesses that can resume are unaffected.
5. `list_thronglets` shows that a session cannot take another message.
6. Tests via test/fake-agent: early refusal without a spawn, steer leaves the running turn alive, old record without the field.
7. DESIGN §3.3, §3.7 and §8 updated; README and skills/throng wording about steering a gemini session corrected.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Run .agent-runbooks/runs/20261003-throng-26 ended ready: Opus and GPT-6.1 Sol reviews both with 0 findings, triage skipped, polish changed one test title. Spot-check by the main session: diff of src/, docs, README, skill read in full; gates rerun (typecheck, lint, 303 tests green).

Decisions: record field resumable?: boolean (absent = unknown, old behaviour); ThrongletInfo.accepts_messages is a required boolean, record.resumable !== false; the check lives in the request thunk of src/mcp/tools/send-message.ts, which runCall calls first, so wait/cancel are unaffected. Deviation from the brief: no new fake-agent env knob; the no-resume scenario honours FAKE_TURN_MS instead, which gives a running turn that completes on its own. Changeset: minor (additive output field, new refusal point).

Seen outside the task, not touched: DESIGN §9 lists a fake-agent scenario named resume that does not exist (real ones: no-resume, resume-memory).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The session record stores resumable from the creating turn's handshake; send_message refuses a resumable: false session with session_not_found in the request thunk, before guards, steer abort, lock and spawn; list_thronglets reports accepts_messages. Evidence: src/run.test.ts (record gets true/false; refusal with empty FAKE_CALL_LOG and byte-identical record, plain and steer; old record still fails at the handshake), src/steer.test.ts (steer refused, running turn ends ok with last_result), src/harnesses/gemini.test.ts, src/list-thronglets.test.ts, src/mcp.test.ts; pnpm typecheck, lint, test green (303). DESIGN §3.3, §3.7, §8, README and skills/throng updated.
<!-- SECTION:FINAL_SUMMARY:END -->
