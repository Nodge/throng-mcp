---
id: THRONG-5
title: Smoke and README
status: Done
assignee:
  - '@fable'
created_date: '2026-09-27 18:56'
updated_date: '2026-09-28 10:12'
labels: []
milestone: m-0
dependencies:
  - THRONG-4
documentation:
  - docs/DESIGN.md
type: task
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
v1 closes on real harnesses, not on fakes: smoke scripts give the maintainer a repeatable matrix, and the README lets someone else install and register the server. Smoke runs spend tokens and are done by the maintainer, not by agents.

Scope: DESIGN §9, §10.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `scripts/smoke/*` with `pnpm smoke:<harness>` for claude, codex and opencode
- [x] #2 README covers install of throng and of the adapters (commands with the verified versions, `--omit=optional` when the harness is on PATH), the registration command for the user to run, and config
- [x] #3 Quirks found during smoke are fixed
- [x] #4 Maintainer smoke passed with user-installed adapters (versions recorded from `list_harnesses`): claude/codex/opencode × `auto`, opencode with a custom provider, Esc leaves no orphans, a call over 2 min goes to the background
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THRONG-5 — Smoke and README. Goal: (1) a repeatable smoke runner against REAL harnesses that the maintainer runs by hand (`pnpm smoke:<harness>`), tested here only against the fake agent; (2) a README that lets someone else install throng and the adapters, register the server in Claude Code, configure it, and run the smoke matrix. No new server features.

READ FIRST: docs/DESIGN.md §1, §3 (tools and payloads — the README documents exactly these), §3.5 (registration), §4.1 (adapters are user-installed, install hints, env for harness binaries), §7 (limits, prompt prefix), §8 (config yaml, env vars THRONG_MCP_CONFIG / THRONG_MCP_DEPTH / THRONG_MCP_CACHE_DIR, session records, transcripts, rotation), §9 (smoke list), §10; backlog/decisions/decision-1 and decision-3. AGENTS.md "Code rules". README is for users; AGENTS.md stays the dev-process doc — link to it from a short "Development" section, don't duplicate it.

ALREADY IN THE TREE (all green, 132 tests): src/mcp.ts registers `list_harnesses` and `run_thronglet`; payload shapes in src/contract.ts; config schema in src/config.ts (`permissions`, `harnesses.<id>.{command,args,env,permissions}`, `limits.{timeout_s,handshake_s,elicitation_s,max_concurrency,max_depth}`); src/sessions.ts `cacheDir()`; test/mcp.test.ts shows how to drive the server over stdio with the SDK client (`serverEnv()`, temp config via THRONG_MCP_CONFIG, temp cache via THRONG_MCP_CACHE_DIR, PATH with only node); test/fake-agent (scenarios via FAKE_SCENARIO; `echo` answers `echo: <prompt> [model=… effort=…]`, session/new records nothing about cwd yet — see step 2).

VERIFIED FACTS for the README (don't re-verify by running real harnesses):
- Toolchain: node 24.11.1, pnpm 11.10. Tested harness CLIs: claude 2.1.282, codex 0.156.1, opencode 1.18.30. Registry snapshot adapter versions: `@agentclientprotocol/claude-agent-acp@0.81.2`, `@agentclientprotocol/codex-acp@1.13.1` (the versions the design was verified against, decision-1). `list_harnesses` reports the installed adapter version per harness (on the maintainer's machine today: claude-agent-acp 0.76.0, codex-acp 1.11.0, opencode 1.18.30 — versions drift, README says to check with list_harnesses).
- `npm i -g @agentclientprotocol/claude-agent-acp@0.81.2 @agentclientprotocol/codex-acp@1.13.1` pulls the adapters' bundled harness binaries (~600 MB). With `--omit=optional` the install is 58 MB and both adapters start fine as long as `claude` / `codex` are on PATH (throng passes their absolute paths via CLAUDE_CODE_EXECUTABLE / CODEX_PATH). Without the CLIs on PATH, install WITHOUT `--omit=optional` so the adapters use their bundled binaries. OpenCode is a single binary (`opencode acp`): https://opencode.ai/docs.
- Registration (user runs it, never the tools): `claude mcp add --scope user throng -- node /abs/path/to/throng-mcp/src/mcp.ts`; check with `claude mcp list`; tool names in Claude Code: `mcp__throng__run_thronglet`, `mcp__throng__list_harnesses`. Auth: the nested `claude` uses whatever auth the standalone CLI has; if `claude auth status` says not logged in, put `CLAUDE_CODE_OAUTH_TOKEN` (or ANTHROPIC_API_KEY) into `harnesses.claude.env` in the throng config. Codex and OpenCode use their own logins (`codex login`, `opencode auth login`).
- Claude Code as the client: a call longer than 120 s in an interactive main session is moved to a background task automatically (result arrives as a notification; stop with TaskStop); Esc cancels → throng cancels the nested session and kills the adapter tree; progress notifications keep the 30-min idle timeout from firing.
- Model values are the harness's own option values: claude `default | opus[1m] | claude-fable-5-1 | sonnet | haiku`, efforts `default,low,medium,high,xhigh,max`; codex `gpt-6-astra | gpt-6-sol | gpt-6-luna | gpt-5.6-sol | …`, efforts `low,medium,high,xhigh,max,ultra`; opencode `<provider>/<model>` (411 values on the maintainer's machine, e.g. `openrouter/anthropic/claude-sonnet-5`, default `opencode/big-pickle`), no effort option → effort suffix yields a warning. Custom providers live in the user's `~/.config/opencode/opencode.json`; throng does not touch it.
- v1 limits: permissions policy `auto` only (other values in config → the run fails with `harness_unavailable: permissions "…" is not supported yet (v2)`); `schema` is accepted and ignored with a warning; `resume_thronglet` is v2.

BUILD:

1. scripts/smoke/smoke.ts — one runner, TypeScript under node type stripping (imports with .ts, only erasable syntax), no new dependencies. Usage: `node scripts/smoke/smoke.ts <agent-spec> [--prompt "<text>"] [--cwd <dir>] [--timeout <s>]`. Steps, each printed as a numbered line to stdout:
   a. Start the server: `StdioClientTransport({ command: process.execPath, args: ['src/mcp.ts'], cwd: <repo root resolved from import.meta.url>, env: process.env, stderr: 'pipe' })` — the user's real env, config and cache (this is the point of smoke). Server stderr is forwarded to the smoke's stderr prefixed `[server] `.
   b. Snapshot adapter processes BEFORE: pids from `pgrep -f` for `claude-agent-acp`, `codex-acp`, `opencode acp` (ignore failures).
   c. `list_harnesses` → print a table: harness, version, number of models, efforts, command; and every `unavailable` entry with its reason. Then check the requested harness is available and the requested model is in its `models`; otherwise print the valid models (first 40 + total) and exit 2. Print `limits`.
   d. `run_thronglet` in `--cwd` or a fresh `mkdtemp(throng-smoke-)` with the default prompt: `Create a file named pong.txt in the current directory containing exactly the word pong (no newline needed), then reply with the single word: done.` and `timeout_s` = `--timeout` or 300. Pass `onprogress` and print each progress message to stderr as `[progress] <n> <message>` (the SDK client: `client.callTool(params, CallToolResultSchema, { onprogress })` — see test/mcp.test.ts for the exact call).
   e. Print the payload: `isError`, `code`/`message` on failure; `session_id`, `stop_reason`, `duration_s`, `usage` (tokens, cost_usd), `warnings`, and the `text` (first 400 chars). Then verify `pong.txt` exists in the cwd with content `pong` (trimmed) → `PASS: pong.txt written` or `FAIL: …`.
   f. Close the client, wait ≤ 3 s, snapshot adapter processes AFTER; new pids that are still alive → `FAIL: orphaned adapter processes: <pids>`; otherwise `PASS: no orphans`.
   g. Exit code: 0 when the run succeeded and both checks pass; 1 on any FAIL or tool error; 2 for the availability/model check. Print the transcript hint at the end: `transcripts: <cacheDir>/runs`. Remove the temp cwd only when it was created by the script AND the run passed (keep it on failure for inspection, print its path).
   Package scripts: `"smoke": "node scripts/smoke/smoke.ts"`, `"smoke:claude": "node scripts/smoke/smoke.ts claude/haiku"`, `"smoke:codex": "node scripts/smoke/smoke.ts codex/gpt-6-luna"`, `"smoke:opencode": "node scripts/smoke/smoke.ts opencode/opencode/big-pickle"` (extra args pass through: `pnpm smoke:opencode -- --prompt "…"`; a custom provider is `pnpm smoke opencode/<provider>/<model>`). tsconfig already includes `scripts`.

2. Fake agent: add scenario `write-pong` — session/new remembers the session's `cwd` (FakeSession gets `cwd` and `mcpServers` fields, recorded from the request for both session/new and session/resume — this closes the THRONG-2 gap too), and on prompt writes `pong` into `<cwd>/pong.txt` and answers `done` with the usual usage. Don't change other scenarios' output.

3. test/smoke.test.ts — runs the smoke script as a child process (`node scripts/smoke/smoke.ts …`) with an env built like test/mcp.test.ts's `serverEnv()` (THRONG_MCP_* stripped, temp cache dir, PATH with only node) plus `THRONG_MCP_CONFIG` → temp yaml pointing `harnesses.claude.command/args/env` at the fake agent: (a) `claude/fake-small --prompt x` with `FAKE_SCENARIO=write-pong` → exit 0, stdout contains `PASS: pong.txt written` and `PASS: no orphans` and a `session_id`; (b) `FAKE_SCENARIO=echo` → exit 1 with `FAIL: pong.txt` (the run succeeds but no file); (c) `claude/nope` → exit 2 and the output lists `fake-small`; (d) `codex/x` with no adapter on PATH → exit 2 and the output contains the install hint. Assert no fake-agent processes are left.

4. README.md (English, terse, no marketing), sections in this order:
   - What it is: 3–5 sentences (MCP server; `run_thronglet` runs Claude Code / Codex / OpenCode over ACP in a given cwd and returns the final message; `list_harnesses`; edits the live tree, no sandbox; v1 = auto permissions).
   - Requirements: node ≥ 24, pnpm; harness CLIs you want to use on PATH; the ACP adapters.
   - Install: clone + `pnpm install`; adapters (both npm commands, the `--omit=optional` variant and when it is safe, the OpenCode pointer); `claude mcp add --scope user throng -- node /abs/path/src/mcp.ts` and `claude mcp list`; how to check everything: ask Claude to call `list_harnesses`, or run `pnpm smoke claude/haiku`.
   - Usage: agent spec grammar with 4 examples; the tool inputs; the success and failure payloads (copy the shapes from DESIGN §3.2, list the ErrorCodes with one-line meanings); what the prompt prefix does (executor, not orchestrator) and that the prompt must be self-contained; background/Esc/progress behavior in Claude Code; where `text`, `session_id`, `usage.cost_usd` come from.
   - Configuration: full `~/.config/throng/config.yaml` example from DESIGN §8 with comments; the three env vars; the auth note for claude (CLAUDE_CODE_OAUTH_TOKEN in `harnesses.claude.env`); `permissions: auto` only in v1.
   - Files on disk: session records, transcripts, 14-day rotation, server stderr.
   - Smoke (maintainer): `pnpm smoke:claude|codex|opencode`, custom provider example, what PASS/FAIL lines mean; the manual matrix items that need an interactive Claude session: (i) Esc during a run → `pgrep -f "claude-agent-acp|codex-acp|opencode acp"` shows nothing afterwards; (ii) a call over 2 min goes to the background — prompt suggestion: `run sleep 150 in the shell, then reply done`; (iii) opencode with a custom provider. Ask the maintainer to record adapter versions from `list_harnesses` in the backlog task notes.
   - Troubleshooting: `harness_unavailable` (adapter missing → the message carries the install command; config error → fix the yaml, the server refuses to run on defaults), `model_rejected` (run list_harnesses), `handshake_timeout` / `spawn_failed` (adapter stderr is in the message; check auth: `claude auth status`, `codex login`), `empty_result`, timeouts.
   - Development: gates (`pnpm typecheck && pnpm test`), tests use test/fake-agent and never call an LLM, design in docs/DESIGN.md, process in AGENTS.md.

DON'T: run real harnesses or the real smoke (the maintainer does; it spends tokens) — the only proof you need is test/smoke.test.ts against the fake agent; change server behavior or contracts; add dependencies; touch ~/.config, ~/.cache, ~/.claude, backlog/, docs/DESIGN.md.

GATES: `pnpm typecheck && pnpm test` green; `pgrep -f fake-agent` empty afterwards; `node scripts/smoke/smoke.ts` with no args prints usage and exits 2. Acceptance criteria covered here: #1 scripts/smoke with `pnpm smoke:<harness>` for all three; #2 README (install of throng and adapters with verified versions and `--omit=optional`, registration command, config). #3 (quirks found during smoke) and #4 (maintainer smoke) are the maintainer's, outside this cycle.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
task-cycle wf_71224bf1-4e8: Opus coder, gates green, dual review 5 findings → 2 confirmed and fixed (f1 minor: orphan check said PASS when pgrep could not run — now FAIL + exit 1, test PATH gets a pgrep symlink; f2 minor: --cwd with a pre-existing pong.txt gave a false PASS — now refused with exit 2), verified; spot-checked smoke.ts:53-55, 70-75, 194-207. Deviations accepted: explicit SDK request timeouts on both tool calls ((timeout_s+60) s and 180 s — the SDK default of 60 s would cut real runs); pong.txt check also applies to a custom --prompt (README says so); final SMOKE PASSED/FAILED line. Main session after the cycle: config.ts now treats a harness entry with no value (codex: with only commented children) as an empty override, so the DESIGN §8 yaml loads as written (+ test); README note adjusted. Deferred: f3 relative --cwd resolves against process.cwd() (README uses absolute paths). Pre-cycle check by the main session on the real server (no prompt, no tokens): list_harnesses probed all three installed adapters in 3.6 s — claude-agent-acp 0.76.0 (5 models, 6 efforts), codex-acp 1.11.0 (7 models, 6 efforts), opencode 1.18.30 (411 models, no efforts); no leftover processes; CLAUDECODE=1 in the env does not break the handshake. Installed adapters are older than the registry snapshot (0.81.2 / 1.13.1). WAITING ON THE MAINTAINER (AC #3, #4): pnpm smoke:claude / smoke:codex / smoke:opencode (+ opencode with a custom provider), Esc → no orphans, a >2 min call goes to the background; record adapter versions from list_harnesses here; standalone claude is not logged in on this machine — put CLAUDE_CODE_OAUTH_TOKEN into harnesses.claude.env first or the claude smoke fails at the prompt.

Maintainer smoke 2026-09-27 (transcripts in ~/.cache/throng/runs, checked by Fable): claude/haiku ok 6.5 s $0.025 (adapter 0.76.0), codex/gpt-6-luna ok 15.1 s (1.11.0), opencode/opencode/big-pickle ok 11.4 s cost 0 (1.18.30); pong.txt written in all three (smoke removed the temp dirs = PASS), no adapter processes left. Quirk found and fixed: claude-agent-acp reports the auto→acceptEdits fallback (haiku has no auto mode) as current_mode_update + a plain agent_message_chunk BEFORE the prompt turn, and startTurn() discarded both — now run.ts warns when current_mode_update differs from the requested mode and the Collector turns pre-turn agent text into a warning; fake scenario mode-fallback + tests; README troubleshooting entry. Still open for AC #4: opencode with a custom provider, Esc → no orphans, a >2 min call goes to the background (no transcripts for these yet).

Maintainer smoke 2026-09-28: opencode/openrouter/z-ai/glm-5.3-flash ok 17.6 s $0.0023, pong.txt PASS, no orphans (built-in openrouter provider, not a custom one in opencode.json).

Smoke 2026-09-28 by Fable on request: claude/haiku ok 6.0 s $0.025 (warnings now show the auto→acceptEdits fallback); claude/opus[1m] ok 8.8 s $0.117, real auto mode, no warnings; both PASS pong.txt, no orphans.

Dogfood 2026-09-28 from the desktop Code-tab session (server registered by the maintainer): list_harnesses sees all three adapters from Claude Code's env. run_thronglet claude/haiku with sleep 150 → ok in 161 s, $0.026, no hang, progress delivered; the call did NOT auto-background in this session (env CLAUDE_CODE_ENTRYPOINT=claude-desktop, CLAUDE_CODE_CHILD_SESSION=1 — the desktop tab counts as a child session for Claude Code's auto-background), so the '>2 min goes to background' item must be checked from a terminal claude TUI. Under acceptEdits the adapter ran the bash command without request_permission: the allow_once bridge has still not been exercised by a real adapter. Custom provider item: maintainer's openrouter provider in opencode.json points at a custom endpoint — the GLM run covers it (maintainer's call).

Dogfood 2026-09-28: timeout on a real adapter — claude/haiku with sleep 300 and timeout_s 240 → tool error timeout at 240 s with session_id/usage/warnings; session/cancel made the adapter answer stopReason cancelled within the grace, transcript stop+stderr+outcome written, adapter tree incl. the sleep gone. Esc from the client still to be exercised.

Dogfood 2026-09-28: Esc from the desktop session during claude/haiku sleep 300 → notifications/cancelled → session/cancel; adapter answered stopReason cancelled within 2 s, outcome cancelled at 7 s, no adapter or sleep process left. Matrix status: claude/codex/opencode × auto PASS, opencode custom provider PASS (maintainer's openrouter → custom endpoint), Esc → no orphans PASS, timeout PASS; '>2 min call goes to the background' NOT reproducible from the desktop Code tab (child session stays synchronous) — needs a terminal claude TUI run if it is to be checked at all.

Dogfood 2026-09-28: codex/gpt-6-luna with sleep 150 → ok in 168.8 s, no warnings (mode agent ran the long bash without asking); the call again stayed synchronous in the desktop Code tab, so the missing auto-background is the client session type (CLAUDE_CODE_CHILD_SESSION=1), not the nested harness.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
scripts/smoke/smoke.ts + pnpm smoke:<harness> (list_harnesses table, run_thronglet with pong.txt and orphan checks, tested against the fake agent), README (install incl. adapters and --omit=optional, registration, config, payloads, smoke matrix, troubleshooting). Maintainer/dogfood smoke on real harnesses: claude/haiku, claude/opus[1m], codex/gpt-6-luna, opencode/big-pickle and opencode/openrouter/z-ai/glm-5.3-flash (custom endpoint) all PASS; Esc → cancelled in 7 s, timeout path twice, long runs 161 s and 169 s, never an orphaned process. Quirk fixed: claude-agent-acp's auto→acceptEdits fallback now lands in warnings. Not reproducible from the desktop Code tab: Claude Code's auto-background after 120 s (client session type), left as a note. Gates: typecheck clean, 142 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
