---
id: THRONG-7
title: resume_thronglet
status: Review
assignee:
  - '@fable'
created_date: '2026-09-27 18:56'
updated_date: '2026-09-30 16:00'
labels: []
milestone: m-1
dependencies:
  - THRONG-5
documentation:
  - docs/DESIGN.md
type: feature
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up questions to an earlier nested session without re-sending its context.

Scope: DESIGN §3.3, §4.2, §8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `resume_thronglet` matches DESIGN §3.3; harness, model, effort and cwd come from the session record
- [x] #2 An unknown id or a harness without resume support fails with `session_not_found`
- [x] #3 fake-agent scenario `resume` remembers a fact from the first prompt and answers it in the second
- [ ] #4 Smoke: a follow-up question on claude, codex and opencode
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THRONG-7 — resume_thronglet. Goal: a follow-up prompt into an earlier nested session. `resume_thronglet({ session_id, prompt, schema?, timeout_s? })` reads the session record, starts a fresh adapter process, `session/resume`s the harness's own session, re-applies mode/model/effort, sends the prompt and returns the same payload as run_thronglet with the same `session_id`. Structured output (`schema`) stays ignored with the existing warning (THRONG-6).

READ FIRST: docs/DESIGN.md §3.2, §3.3 (the contract — note the last sentence: mode, model and effort are applied again after session/resume), §4.2 (step 3: session/resume needs `sessionCapabilities.resume`; unknown id → session_not_found), §8 (session records: `{ harness, model, effort?, cwd, created_at, last_used_at }`, updated on every resume). AGENTS.md "Code rules". Contract files by the main session — don't change exported shapes (gaps → deviations): src/contract.ts (`resumeThrongletInput` = session_id, prompt, schema?, timeout_s?; `ResumeThrongletInput`; RunSuccess/RunFailure), src/errors.ts (`session_not_found` exists), src/acp/types.ts (`SessionStart` has `{ kind: 'resume', sessionId, cwd, mcpServers }`).

ALREADY IN THE TREE (145 tests green): src/run.ts `runThronglet(input, ctx)` — guards → semaphore → startWorker(kind 'new') → writeSessionRecord → setMode → selectModel → selectEffort → prompt → payload; cleanup with touchSessionRecord, transcript, close. src/acp/worker.ts handles `kind: 'resume'`: missing `sessionCapabilities.resume` → ThrongError `session_not_found` before sending; a JSON-RPC error from session/resume → `session_not_found`; `session.sessionId` is the id we sent. src/sessions.ts: `readSessionRecord(dir, id)` (undefined when missing; `isSafeName` guards path tricks), `touchSessionRecord`, `writeSessionRecord(dir, id, record)`. src/mcp.ts registers list_harnesses and run_thronglet (pattern: `track(...)`, one JSON text block, `isError` on failure). src/permissions.ts: policy auto → reject_once (decision-4). test/fake-agent/agent.ts: `session/resume` accepts any id today (FakeSession.resumed → echo prefix `resumed: `); scenario `no-resume` omits the capability; scenario `write-pong` writes pong.txt and answers `done`. test/run.test.ts helpers: `fakeClaude(scenario)`, `makeCtx(loaded, overrides)`, `input(agent, extra)`, `ok()`, `failed(outcome, code)`, `readJsonl`. test/mcp.test.ts drives the real server over stdio. scripts/smoke/smoke.ts + test/smoke.test.ts (fake agent).

BUILD:

1. src/run.ts — one shared pipeline, two entry points. Refactor `runThronglet` so the part after "agent spec parsed" works on an internal request:
   `type RunRequest = { kind: 'new'; spec: AgentSpec; cwd: string } | { kind: 'resume'; sessionId: string; record: SessionRecord }` (harness/model/effort/cwd read from the record). Export `resumeThronglet(input: ResumeThrongletInput, ctx: RunContext): Promise<RunOutcome>`; it never throws either. Differences for resume, in order:
   a. `readSessionRecord(ctx.cacheDir, input.session_id)`: missing (or unsafe id) → `session_not_found` with message `no session record for "<id>" (records live 14 days under <cacheDir>/sessions)`; a record whose `harness` is not in HARNESS_IDS → `session_not_found` too (corrupt file). No spawn, no semaphore.
   b. Same guards as a new run: config error / policy ≠ auto → `harness_unavailable`; depth; `def.resolve` → `harness_unavailable`; `record.cwd` must still be a directory → `spawn_failed` (message names the cwd from the record).
   c. Semaphore, clock, timeout as for a new run. `startWorker(..., { kind: 'resume', sessionId: input.session_id, cwd: record.cwd, mcpServers: [] }, ...)` — the Worker's ThrongErrors pass through (`session_not_found` when the harness lacks the capability or rejects the id; `handshake_*`, `spawn_failed`, `transport_lost` as usual). `_meta` from permissionSetup is NOT sent on resume (session/resume has no _meta in our start type).
   d. On success of the handshake: no new record; `sessionId` = `input.session_id`; then setMode / selectModel(record.model) / selectEffort(record.effort) exactly like a new run (a fresh adapter process starts in its default mode/model). `model_rejected` on resume is possible if the harness's model list changed — let it through as is.
   e. Prompt, stop-reason mapping, payload: unchanged; `session_id` in the payload is the resumed id. Cleanup: `touchSessionRecord` (last_used_at; created_at untouched), transcript (file name uses the same session id, the timestamp differs), close, release.
   f. Transcript `input` line for resume: `{ resume: true, session_id, harness, prompt_chars, timeout_s? }` (no prompt text).
   Keep `runThronglet` behavior byte-for-byte (all existing tests must pass unchanged).

2. src/mcp.ts — register `resume_thronglet` with `inputSchema: resumeThrongletInput`, description from DESIGN §3.3 (follow-up prompt into an earlier session; harness/model/effort/cwd come from the record; same payload; `session_not_found` for unknown ids or harnesses without resume). Same wrapper as run_thronglet (progress, track, one JSON text block, isError).

3. test/fake-agent/agent.ts — make resume real for AC #3 without breaking existing tests:
   - Memory on disk, because one call = one fake-agent process: dir = `process.env.FAKE_MEMORY_DIR ?? join(os.tmpdir(), 'throng-fake-agent')`, file `<dir>/<sessionId>.json` = `{ notes: string[] }`.
   - New scenario `resume-memory`: on a prompt in a session created by session/new, append the prompt text to the session's notes file and answer `noted` (plus the usual `[model=… effort=…]` suffix and usage); on `session/resume`, a missing notes file → `RequestError.invalidParams(undefined, 'unknown session <id>')` (so the Worker maps it to session_not_found); on a prompt in a resumed session, answer `you said: <notes joined by " | ">` with the same suffix and usage.
   - Scenario `write-pong`: a prompt in a resumed session answers `pong.txt` (so the smoke follow-up "which file did you create" works against the fake agent).
   - Every other scenario keeps today's behavior (resume of any id, `resumed: ` prefix).
   - test/fake-agent/index.ts: add the scenario to `FakeScenario`.

4. scripts/smoke/smoke.ts — after the pong check, step `6b. resume_thronglet`: `{ session_id: <from the run payload>, prompt: 'Which file did you create in the previous step? Reply with the bare file name only.', timeout_s }` → print the payload (same fields as step 5) and `PASS: resume answered pong.txt` when `text` contains `pong.txt`, else `FAIL: resume …` (exit 1). Skipped (with a printed note) when the run itself failed. Flag `--no-resume` to skip the step. README smoke section: mention the step and the flag.

5. README.md — the Usage section documents `resume_thronglet` (input, what comes from the record, same payload, `session_not_found`, records live 14 days, one adapter process per call so the nested session's context is the harness's own — no history replay), and the "v2: resume_thronglet" mentions become current. Don't touch docs/DESIGN.md (already updated by the main session).

TESTS (fake agent only; temp cache dir per test; no leaked processes):
- test/run.test.ts — with `fakeClaude('resume-memory')` and `FAKE_MEMORY_DIR` set to a temp dir in the harness env (the fake agent gets the env from the config override, look at how fakeClaude builds `harnesses.claude.env`):
  (1) run `claude/fake-small:high` with prompt `remember: banana` → ok, text starts with `noted`; then `resumeThronglet({ session_id, prompt: 'what did I say?' }, ctx)` → ok, `session_id` equal, text contains `you said: remember: banana` and `effort=high` and `model=fake-small` (re-applied from the record), record's `last_used_at` > the one after the first call and `created_at` unchanged; a second transcript file exists under runs/ whose `input` line has `resume: true` and no prompt text.
  (2) unknown id → `session_not_found`, no fake-agent process was started (the id's tag can't exist; assert the duration is tiny or that the message says `no session record`); `../etc` as id → `session_not_found`, no throw.
  (3) record present but the harness has no resume capability (`fakeClaude('no-resume')`, write the record by hand with `writeSessionRecord`) → `session_not_found` mentioning `session/resume`.
  (4) record present, `resume-memory` scenario, but the id has no notes file (write the record by hand) → `session_not_found` with the adapter's message (`unknown session`).
  (5) record for harness `codex` with no adapter on PATH → `harness_unavailable` with the install hint; record whose cwd was deleted → `spawn_failed`.
  (6) resume + `hang` scenario + `timeout_s: 1` → `timeout` with the session_id; adapter gone.
  (7) policy `deny_all` in config → `harness_unavailable` "not supported yet" on resume too; depth guard on resume (`ctx.depth = 2`).
- test/mcp.test.ts — over stdio: run then resume (`resume-memory`) → resume payload text contains the note; `resume_thronglet` with an unknown id → `isError: true`, JSON `code: 'session_not_found'`; `listTools` now has three tools.
- test/smoke.test.ts — the write-pong case now also expects `PASS: resume answered pong.txt`; add a case with `--no-resume` that has no resume step; keep the others.
- Existing fake-agent resume tests in test/worker.test.ts must still pass (default scenarios resume any id).

DON'T: implement structured output / other policies / message injection (THRONG-6/8/9); change src/contract.ts, src/errors.ts, src/acp/*, src/sessions.ts exports (add new functions only if truly needed, and say so); run real harnesses; touch ~/.cache, ~/.config, ~/.claude, backlog/, docs/DESIGN.md. No new dependencies.

GATES: `pnpm typecheck` exit 0 (check the exit code, not the tail of the output) and `pnpm test` exit 0; `pgrep -f fake-agent` empty afterwards. Acceptance criteria covered here: #1 resume_thronglet per §3.3 with harness/model/effort/cwd from the record; #2 unknown id / no resume capability → session_not_found; #3 fake scenario remembers a fact across two prompts. #4 (smoke on real harnesses) is the maintainer's; the smoke runner gets the step here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_e0fa4d5a-7ee: Opus coder, gates green (156 tests), review: Opus 2 minor findings, both deferred; Codex review did not run (the workflow reads the reviewer's answer from run_thronglet.structured, which is THRONG-6 — single review until then). Deviations accepted: transcript input line written once the request is resolved (harness known); unreadable/corrupt records → session_not_found; fake agent imports EXECUTOR_PREFIX to strip the prefix from stored notes; smoke resume step numbered 7. Main session: f2 (stale Transcript.harness comment) fixed. Deferred f1: two concurrent resume_thronglet calls on the same session_id each spawn an adapter and interleave turns in one harness session — no per-session lock; revisit with THRONG-9 (messages into a running thronglet). Smoke 2026-09-30: opencode/openrouter/z-ai/glm-5.3-flash run 7.4 s + resume 5.5 s → 'pong.txt', PASS, no orphans. claude/codex smoke blocked: claude-agent-acp and codex-acp are no longer installed on the maintainer's machine (npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.81.2 @agentclientprotocol/codex-acp@1.13.1); opencode 1.18.31 no longer offers opencode/big-pickle, so the pnpm smoke:opencode default needs a model on the maintainer's list.
<!-- SECTION:NOTES:END -->
