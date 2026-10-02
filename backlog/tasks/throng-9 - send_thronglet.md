---
id: THRONG-9
title: send_message with a per-session turn queue replaces resume_thronglet
status: To Do
assignee: []
created_date: '2026-09-28 15:33'
updated_date: '2026-10-02 09:54'
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
A thronglet session is a sequence of turns. Today a turn is started by `run_thronglet` (first) or `resume_thronglet` (next), both synchronous, and nothing stops two callers from resuming one session at once: two adapter processes do `session/resume` on the same id. The background mode (THRONG-11) makes a busy session the normal case, so turns on one session must be serialized by throng itself. Spike 2026-10-02 (`scripts/spike/concurrent-prompt.ts`, notes below): a second `session/prompt` while a turn runs is delivered to the model by all three adapters, but the request/response pairing breaks differently in each (codex-acp never resolves the first prompt), so the queue cannot be left to the adapters.

Decision-6 fixes the contract: `send_message` is the one tool for a next turn, `resume_thronglet` is removed (v2 is not tagged; one user). `run_thronglet` gets a required `description` so that a session can be told apart in `list_thronglets` and after a server restart; it goes into the session record (DESIGN §8). This task delivers the synchronous form only: `background` and `wait_thronglet` are THRONG-11, `steer` is THRONG-13.

Queue semantics: FIFO per session, one turn per message, each with its own `schema`/`timeout_s`; a message arriving while a turn runs waits for `stop` and starts the next turn. Every turn runs in a fresh adapter process via `session/resume`, exactly as `resume_thronglet` does today (DESIGN §3.3): no keep-alive worker. A session has a state visible to later tools: `running | queued | idle | failed`. Live state is per server process; the record on disk is what survives.

Scope: DESIGN §3.2, §3.3, §4, §8 as updated by decision-6. README and the smoke script follow the rename.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `run_thronglet` requires `description`; the session record stores it
- [ ] #2 `send_message({session_id, prompt, schema?, timeout_s?})` runs the next turn of the session synchronously and returns the `run_thronglet` payload; unknown id or a harness without `sessionCapabilities.resume` → `session_not_found`
- [ ] #3 Two `send_message` calls on one session run one after the other, never two adapter processes on one session at a time; the second call waits in the queue and reports it in progress; covered by a fake-agent test
- [ ] #4 `resume_thronglet` is gone from the tool list, README, DESIGN and the smoke script; `send_message` takes its place in all of them
- [ ] #5 Smoke: `run_thronglet` then `send_message` on claude, codex and opencode; the second turn sees the first
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Spike 2026-10-02 (scripts/spike/concurrent-prompt.ts, real harnesses, prompt A runs `sleep 25`, prompt B sent 3-10 s into A):

Concurrent second `session/prompt` while a turn runs: in all three adapters the agent sees B mid-turn (quotes it in the A reply), but request/response pairing is broken differently in each:
- claude-agent-acp 0.78.0 (claude/sonnet): A resolves end_turn at +29 s before the reply text; the combined text (A-DONE + quoted B) arrives under B, which resolves at +37 s.
- opencode 1.18.31 (glm-5.3-flash): A and B resolve at the same instant (+33.4 s) with one combined text.
- codex-acp 1.12.0 (gpt-6-luna): B resolves end_turn at +45 s with the combined text; A never resolves, not even after session/cancel (checked 10 s), only when the worker is closed. Verdict: not a usable contract; throng must serialize prompts per session itself.

Steer = `session/cancel` then prompt B: works on all three. A resolves `cancelled` within 0.3 s; B gets a reply that remembers the interrupted work ("B-ACK running `sleep 25`, interrupted before it finished" on codex; equivalent on claude and opencode). Cost: the in-flight tool call is aborted.
<!-- SECTION:NOTES:END -->
