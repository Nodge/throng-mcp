---
id: THRONG-9
title: send_thronglet
status: To Do
assignee: []
created_date: '2026-09-28 15:33'
updated_date: '2026-09-28 15:36'
labels: []
milestone: m-1
dependencies:
  - THRONG-7
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The calling session cannot talk to a thronglet while it works: a correction, an extra constraint or "stop and report what you have" means waiting for the result, or Esc and re-running from scratch with the context lost. Claude Code subagents have `SendMessage` for this; throng needs the same for a live nested session, addressed by its `session_id`.

Today `run_thronglet` is one synchronous call (DESIGN §2.4, §4.2) and returns `session_id` only at the end, so a message tool alone is not enough: the caller has to learn the id of a live thronglet while its `run_thronglet` is still pending (often auto-backgrounded after 120 s).

Open questions to settle at pickup, recorded as a backlog decision and in DESIGN §3:
- How the caller gets the id of a live thronglet (list of live sessions, id in progress, caller-supplied name).
- Delivery in ACP v1, where `session/prompt` is one turn: queue as the next prompt after the current `stop`, or `session/cancel` + prompt with the message. Check what the three adapters do with a prompt sent while a turn is running.
- What the send call returns: acknowledgement right away, or the result of the turn it started.
- A `session_id` not live in this server process: `session_not_found`, or fall back to `resume_thronglet` behavior.

Scope: DESIGN §3, §4.2, §4.3. Depends on THRONG-7 for the `session_not_found` semantics and the session record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new tool (contract in DESIGN §3, `ErrorCode` extended if needed) delivers a text message to a thronglet whose `run_thronglet`/`resume_thronglet` call is still in progress, addressed by `session_id`
- [ ] #2 The caller can obtain the `session_id` of a live thronglet before its `run_thronglet` call returns
- [ ] #3 The pending `run_thronglet` result reflects the message: the agent sees it and `text` is from the last turn, per the chosen delivery semantics
- [ ] #4 A `session_id` that is unknown or not live in this server process gives the documented behavior (error code or resume fallback), covered by tests
- [ ] #5 fake-agent scenario covers delivery to a running session without an LLM
- [ ] #6 Smoke: a message into a running thronglet on claude, codex and opencode
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
