---
id: THRONG-14
title: 'Skill: how to use throng'
status: Review
assignee:
  - '@nodge'
created_date: '2026-10-02 11:08'
updated_date: '2026-10-02 12:26'
labels: []
milestone: m-1
dependencies:
  - THRONG-8
  - THRONG-12
  - THRONG-13
documentation:
  - docs/DESIGN.md
type: docs
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tool descriptions say what each tool does, not how to work with thronglets as a whole: when to delegate to another harness or model at all, how to pick an agent spec, when to run in the background and when to wait, how to keep a long conversation with one thronglet via `send_message`, when `steer` is worth its cost, how to find and stop forgotten thronglets, how to ask for structured output and pick a permission policy. Today that knowledge lives in the maintainer's head and in personal rules (`~/.claude/rules/subagents.md`), so every calling session reinvents it. A skill shipped with the repo gives any calling agent the working patterns in one place. It describes the v2 contract, so it is written after the tools that change it (permission policies, list/cancel, steer). Written per the `writing-for-agents` skill.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The repo contains a skill (`SKILL.md` with frontmatter `name` and a `description` that triggers on delegating work to another harness/model and on any throng tool use) under a skills directory in the project
- [x] #2 The skill covers: choosing an agent spec (`list_harnesses`), foreground vs background turns and `wait_thronglet`, multi-turn work with `send_message` and the queue, `steer` and its cost, `list_thronglets`/`cancel_thronglet`, structured output, permission policies
- [x] #3 Every tool name, parameter and error code in the skill matches DESIGN §3 at the time of writing; the skill does not duplicate tool descriptions verbatim, it links patterns to them
- [x] #4 README gives the maintainer the command to install the skill into user scope; the task itself does not touch `~/.claude`
- [ ] #5 Checked in a real session: a fresh Claude Code session with the skill installed picks it up on a delegation request and makes a correct background run + wait + follow-up `send_message`
- [x] #6 The skill states what the prompt of a thronglet must contain: it is self-contained, the thronglet has no access to the caller's conversation
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-14 — Skill: how to use throng

Repo: /Users/nodge/Sites/throng-mcp, branch v2. Gates: `pnpm typecheck && pnpm lint && pnpm test`. Don't touch `backlog/`, don't commit, don't edit `docs/DESIGN.md` or `src/contract.ts`. Nothing under `~/.claude` is touched by this task: README tells the maintainer the command.

This is a documentation task. The skill draft already exists at `skills/throng/SKILL.md`, written by the main session. Your job: verify it against the contract, tighten it, add a staleness guard test, and document installation. Keep the draft's structure and voice; change wording where a rule below or a contract fact demands it, and report every change in `summary`.

## 1. Verify against the contract (AC #3)
Sources of truth, in this order: `docs/DESIGN.md` §3 (tool contracts), the zod input schemas and `description` strings in `src/mcp/tools/*.ts`, `src/contract.ts` (`ERROR_CODES`, `SessionState`, payload types), `README.md` Usage. Check every tool name, parameter name, state value, error code and behavioral claim in the skill:
- Parameter names and which tool has them (`description`, `background`, `steer`, `schema`, `timeout_s`, `cwd`, `agent`, `session_id`).
- Error codes: every code in the skill's table exists in `ERROR_CODES`; the "what to do" column agrees with README's table and DESIGN. Codes the skill omits are fine (the table is for the caller's decisions), but every `cancelled` / `timeout` / `transport_lost` claim must match the implemented behavior (e.g. a timed-out turn's session exists and `send_message` continues it; a `transport_lost` turn's record is marked at the next server start or by `wait_thronglet`).
- Claims about queue, steer, background acceptance, `wait_thronglet` idempotence and restart behavior, `list_thronglets` states, cross-process visibility (a session of another throng server shows from its record, cancel only from there), permission policy (config only, `auto` default; v2 note: policies other than `auto` are THRONG-8, not built yet; the skill describes the design and must not promise `allow_all`/`elicit` behavior beyond "comes from config").
- The agent spec format and the effort levels (`low | medium | high | xhigh | max`), `list_harnesses` semantics (probe, seconds, no tokens).
Fix the skill where it is wrong. If DESIGN and code disagree, say so in deviations and follow the code.

## 2. Writing rules (the maintainer's `writing-for-agents` skill, digest)
- The `description` in the frontmatter is the always-loaded pointer: front-load the trigger words, one trigger per distinct case, no identity the body carries. Keep it to 2–3 sentences.
- The body is reference the caller consults: group each concept's definition, rules and caveats under one heading; no concept scattered across sections; each fact in one place (no duplicating the tool descriptions or README verbatim: the skill links patterns to the tools, it is not a second manual).
- Prompt the positive: say what to do, not what to avoid; a prohibition only as a hard guardrail, paired with the positive target.
- Hunt no-ops: a sentence a capable agent would do by default without being told earns no place; delete the whole sentence.
- Cache only what the agent can't look up: the unwritten convention, the gotcha, the reason. Facts the tool description or an error message already states on the spot (e.g. the valid model list in `model_rejected`) need no restating beyond the pointer to them.
- Keep it short: the current draft is 66 lines; the result should not grow past ~80. Prettier does not format `*.md` here; keep lines readable.

## 3. Staleness guard (new test)
`src/skill.test.ts`: reads `skills/throng/SKILL.md` and checks
- every backticked token that looks like an error code (`[a-z_]+` and present in the skill's error table, or any token equal to a member of `ERROR_CODES`) is in `ERROR_CODES` (import from `src/contract.ts`), so a renamed code breaks the test;
- every backticked token ending in `_thronglet` or equal to `send_message` / `list_harnesses` is a registered tool name: get the names by registering the tools on a real `McpServer` (reuse how `src/mcp.test.ts` lists tools over stdio, or export the registered tool names from `src/mcp/tools.ts` as a const used by `registerTools`; the export is the cheaper way);
- the frontmatter has `name: throng` and a non-empty `description`.
Also add a one-line check that the README install command references the `skills/throng` path.

## 4. README
New section `## Skill` after `## Install` (or at the end of Install): what the skill is (one sentence: working patterns for a calling agent: when to delegate, prompt, background/wait, follow-ups, steer, housekeeping, structured output, permissions), and the install command for user scope:
```bash
ln -s "$(pwd)/skills/throng" ~/.claude/skills/throng
```
with a note that Claude Code picks skills up from `~/.claude/skills` at session start, and that the command is run by the maintainer, not by throng. Add `skills/` to the file layout list if README has one (check `## Development`).

## 5. Out of scope
No changes to tools, DESIGN, contract; no smoke. AC #5 (a fresh real session picks the skill up and runs background + wait + follow-up) is the maintainer's check after install.

## Acceptance criteria (from the task)
1. `skills/throng/SKILL.md` with frontmatter `name` and a `description` that triggers on delegating work to another harness/model and on any throng tool use.
2. Covers: choosing an agent spec (`list_harnesses`), foreground vs background and `wait_thronglet`, multi-turn with `send_message` and the queue, `steer` and its cost, `list_thronglets` / `cancel_thronglet`, structured output, permission policies.
3. Every tool name, parameter and error code matches DESIGN §3 at the time of writing; patterns link to tools, no verbatim duplication of tool descriptions.
4. README gives the maintainer the install command; nothing under `~/.claude` touched.
6. The skill states the prompt must be self-contained: the thronglet has no access to the caller's conversation.

Report in `summary`: every wording change to the skill and why (contract fact or writing rule), what the test guards, and deviations.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Dependency on THRONG-8 waived by the maintainer: the skill describes permissions per DESIGN §5 and says that today only auto runs (other policies fail with harness_unavailable). THRONG-8 must update the Permissions paragraph of skills/throng/SKILL.md when it lands (note added to THRONG-8). task-cycle wf_9afcc1af-eb7 on the main session draft: Opus coder verified every claim against DESIGN §3, tool schemas and README and tightened the text per writing-for-agents (changes listed in its report: description pointer regrouped, model list and tool-description restatements removed, depth_exceeded/timeout/transport_lost advice corrected to the implemented behavior, cwd no-sandbox gotcha added); gates green (248 tests). Reviews: Opus 3 findings, Codex 0. Confirmed and fixed (verified by a separate Opus): f1 the skill claimed background returns "running or queued" for run_thronglet while a slot wait blocks the call; f3 the permissions paragraph implied a wider policy could be configured today. Deferred f2 applied by the main session: mkdir -p before ln -s in the README install command. Staleness guard src/skill.test.ts: error codes in the skill table ⊆ ERROR_CODES (now a runtime const in contract.ts), every tool-shaped identifier ∈ TOOL_NAMES (exported from src/mcp/tools.ts; tool modules export their name) and all six tools mentioned, frontmatter name/description, README install command path. Known DESIGN/code gap reported by the coder: DESIGN §3.2 stop_reason lists refusal, the code reports refusal as an error (README and skill follow the code). AC #5 (fresh session with the skill installed runs background + wait + follow-up) is the maintainer`s after install.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
skills/throng/SKILL.md: model-invoked skill (65 lines) covering agent spec and list_harnesses, the self-contained prompt and cwd as the live tree, send_message conversations and the queue, steer and its cost, background + wait_thronglet and the fan-out pattern, list/cancel housekeeping, structured output, permissions (auto only today), and an error-code table with what to do. README ## Skill with the user-scope install command. src/skill.test.ts guards tool names and error codes against the code (TOOL_NAMES, ERROR_CODES). Verified: tsc 0, eslint 0, vitest 248/248. Pending: maintainer install + fresh-session check (AC #5) — status Review.
<!-- SECTION:FINAL_SUMMARY:END -->
