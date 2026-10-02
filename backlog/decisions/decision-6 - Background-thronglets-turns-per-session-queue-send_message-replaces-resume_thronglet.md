---
id: decision-6
title: >-
  Background thronglets: turns, per-session queue, send_message replaces
  resume_thronglet
date: '2026-10-02 09:53'
status: accepted
---
## Context

The v2 plan had one tool for talking to a live thronglet (THRONG-9, `send_thronglet`) with the delivery mechanics left open. Designing it together with the maintainer (nodge) on 2026-10-01/02 widened the question: the real need is running several thronglets at once, letting the calling session do other work meanwhile, and feeding them follow-up messages, so that different models can work on one task or argue about it. Two facts shaped the answer:

- ACP v1 is turn-based: `session/prompt` is one turn and resolves at `stop`. A spike against the real adapters (`scripts/spike/concurrent-prompt.ts`, results in THRONG-9 notes) showed that a second `session/prompt` during a turn is delivered to the model by all three adapters, but the request/response pairing breaks differently in each: claude-agent-acp 0.78 resolves the first prompt before the text and hands the combined text to the second, opencode 1.18 resolves both at once with one text, codex-acp 1.12 never resolves the first prompt, not even after `session/cancel`. `session/cancel` followed by a fresh prompt works on all three: the cancelled prompt resolves within 0.3 s and the next reply remembers the interrupted work.
- Every harness spawns its own throng server instance over stdio (§3.5), so live state is per server process; only session records on disk are shared. Direct thronglet-to-thronglet messaging therefore needs a cross-process mailbox and is a separate step (THRONG-10); the calling session relays for now.

## Decision

Made by the maintainer (nodge) with Fable, 2026-10-02.

- **Sessions are sequences of turns.** `run_thronglet` creates the session and runs the first turn; `send_message` runs the next one. `resume_thronglet` is removed: `send_message` with `background: false` is the same call under the name that reads right once a queue exists. v2 is not tagged and has one user, so no compatibility shim.
- **Per-session FIFO queue, kept by throng.** A message that arrives while a turn runs waits for `stop` and starts the next turn; one message = one turn, with its own `schema` and `timeout_s`. Never two adapter processes on one session. Adapters are not trusted to serialize (see the spike).
- **One turn = one adapter process**, via `session/resume` for every turn after the first, exactly as `resume_thronglet` works today. No keep-alive worker; the adapter start is seconds and the harness keeps the context itself. A semaphore slot is held only while a turn runs; idle sessions cost nothing.
- **`background: true`** on `run_thronglet` and `send_message` returns `{ session_id, state }` as soon as the turn is running; handshake, model and depth errors still fail the call. **`wait_thronglet({ session_id, timeout_s? })`** resolves only when the session is idle (no running turn, empty queue) with the last turn's payload, success or failure, as the synchronous call would have returned it. An elapsed `timeout_s` returns the state and queue length as a normal result, not an error. Results are persisted in the session record: `wait_thronglet` is idempotent and answers after a server restart.
- **`steer: true`** on `send_message` is the one way to reach a running turn: `session/cancel`, then this message as the very next turn, ahead of the queue, which is kept after it. The in-flight tool call is aborted; that cost is in the tool description.
- **`description`** is required on `run_thronglet` and stored in the session record. **`list_thronglets`** merges records on disk with live state: `running | queued | idle | failed`, queue length, last error. A turn interrupted by a server restart is recorded as `failed`, never shown as `running`. **`cancel_thronglet`** cancels the running turn, drops the queue, and resolves a pending `wait_thronglet` with `cancelled`.
- Topology stays a star: the calling session moderates and relays. Direct messaging between thronglets is THRONG-10, after this lands and only if relaying through the orchestrator proves too expensive in tokens.

## Consequences

- DESIGN §3 is rewritten in the same commit: §3.2 gains `description` and `background`, §3.3 is `send_message`, new §3.6–§3.8 for `wait_thronglet`, `list_thronglets`, `cancel_thronglet`; §7 and §8 follow.
- v2 grows four tasks on top of THRONG-8: THRONG-9 (send_message, queue, description), THRONG-11 (background, wait), THRONG-12 (list, cancel), THRONG-13 (steer). They are sequential in that order; THRONG-13 depends on THRONG-11 only.
- The session record (§8) becomes the durable state of a session: description, last result or error, whether a turn was in flight. Tests that touch records need the new fields.
- The smoke script and README lose `resume_thronglet` and gain the background flow; the maintainer's smoke list for each task is in its acceptance criteria.
- A multi-model debate is a protocol in the caller's prompts (roles, rounds, a judge, a stop condition), not a server feature. The server provides turns, queues and waiting; nothing in it decides who speaks.
