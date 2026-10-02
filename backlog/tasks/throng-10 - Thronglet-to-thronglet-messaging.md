---
id: THRONG-10
title: Thronglet-to-thronglet messaging
status: To Do
assignee: []
created_date: '2026-10-01 21:53'
updated_date: '2026-10-02 09:53'
labels: []
dependencies:
  - THRONG-9
  - THRONG-11
documentation:
  - docs/DESIGN.md
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
With THRONG-9 (star topology) every exchange between two thronglets passes through the calling session: it reads one result, pastes it into a message to the other, and so on. For a multi-round debate or a shared task between N models that is N messages per round landing in the orchestrator context twice (read + relay), and the orchestrator is the most expensive model in the setup. Thronglets should be able to address each other directly, with the orchestrator only moderating (who participates, when to stop) and reading what it wants.

Why this is not a small extension of THRONG-9: every harness spawns its own throng server instance over stdio (user-scope registration, DESIGN §3.5), so a thronglet at depth 1 calling `send_thronglet` lands in a different server process than the one holding its peer worker. Live workers are in memory per process (DESIGN §4.2); only session records are shared on disk (§8). Direct messaging needs a cross-process mailbox: the obvious shape is an inbox directory per session under the session records (`~/.cache/throng/sessions/<id>/inbox/`) watched by the process that owns the live worker, delivered per the THRONG-9 semantics (next turn after `stop`, or steer via `session/cancel`). A daemon is the alternative and is out of scope unless the file mailbox proves unworkable.

Open questions to settle at pickup, recorded as a backlog decision and in DESIGN §3:
- Addressing: by `session_id` only, or also by the `description`/name the orchestrator gave at `run_thronglet`, and how a thronglet learns who its peers are (passed in the prompt by the orchestrator vs a list tool scoped to a group).
- Whether a nested thronglet may message a session it did not start, and whether the orchestrator can restrict that (a group/room id set at `run_thronglet`).
- Delivery to a session whose owning server process is gone (idle session on disk, no live worker): resume in the sender process, queue on disk until someone resumes, or error.
- Stop condition and budget: direct conversations have no moderator in the loop; at least a per-session message cap or the depth/timeout guards must bound them.

Depends on THRONG-9 for the message tool and the delivery semantics within one process; this task makes the same tool work across processes. Not for v2: decompose further when v2 closes if needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A thronglet started by `run_thronglet` can send a message to another live thronglet by id (and by name if the decision adds names) from inside its own harness, through the throng server instance that harness spawned
- [ ] #2 The message reaches the peer worker owned by a different throng server process, with the same delivery semantics as THRONG-9 (documented in DESIGN §3)
- [ ] #3 A message to a session with no live worker anywhere gives the documented behavior (queue on disk, resume, or error), covered by tests
- [ ] #4 Direct conversations are bounded: the documented cap or guard stops an exchange that never ends, covered by tests
- [ ] #5 Tests cover two fake-agent sessions in two server processes exchanging messages without an LLM
- [ ] #6 Smoke: two thronglets on different harnesses exchange at least one round of messages with the calling session only starting them
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
