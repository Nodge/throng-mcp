---
id: THRONG-15
title: Prepare the repository for publishing on GitHub
status: Done
assignee:
  - '@nodge'
created_date: '2026-10-02 16:18'
updated_date: '2026-10-02 18:11'
labels: []
milestone: m-1
dependencies:
  - THRONG-8
type: task
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The repo goes public on GitHub. Two things are needed: release hygiene found by an audit on 2026-10-02 (tracked files + full history: no secrets, no internal references, no Cyrillic; only the items below), and a README that serves users, with the technical material moved to separate documents.

Decisions already made by the maintainer: commit author email stays as is (no history rewrite); `backlog/` is published as part of the project, so its contents must read fine for an outsider; stage tags are not required. License: MIT. Repository URL: https://github.com/Nodge/throng-mcp. The skill is installed with the skills CLI (`npx skills add Nodge/throng-mcp --skill throng -g`), not a symlink.

Hygiene findings:
- No `LICENSE` file; `package.json` has no `license`, `description`, `repository`. (`bin` / npx distribution of the server is out of scope.)
- `README.md` Install says `git clone <this repo>`; needs the real GitHub URL.
- The no-sandbox / auto-approve default is one sentence in the README intro; a public MCP server that spawns agents with bypass permissions needs a visible Security block near the top: no isolation, what the default policy refuses, how to switch policy.
- The absolute path of the maintainer home-directory checkout in the notes of backlog/tasks throng-9, 11, 12, 13, 14; and "Sherpa review" (the maintainer private tool) in throng-6. Both scrubbed by the maintainer by hand before the run.
- `data/registry.json` provenance (registry URL + snapshot date) lives only in DESIGN §4.1; the maintainer docs need one line with it.
- `scripts/spike/concurrent-prompt.ts` is a committed spike: delete it, or keep with a one-line pointer in DESIGN.md to the finding it produced.

README restructure. Today README.md (320 lines) serves three audiences at once: a user installing throng and calling it from Claude Code, an agent/developer needing exact tool contracts, and the maintainer (smoke matrix, development). README should serve the first audience only. Decision: docs/DESIGN.md §3 stays the one canonical contract, README links to it; Files on disk, Smoke and Development move to docs/development.md; `skills/throng/SKILL.md` is linked, not restated.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 LICENSE file exists at the repo root and `package.json` has a matching `license` field, plus `description` and `repository`
- [x] #2 README has the real repository URL in Install; no `<this repo>` placeholder anywhere
- [x] #3 README has a Security section right after the intro stating no sandbox/isolation, the default permission policy and how to change it
- [x] #4 README covers only user-facing content: what it is, requirements, install, skill setup, agent spec, one worked example, configuration, permissions, troubleshooting, links to the other docs
- [x] #5 Tool contracts (inputs, results, error codes, stop reasons) live in exactly one place; README and DESIGN §3 link to it rather than restating it
- [x] #6 Smoke, Files on disk and Development live in a maintainer document under docs/, linked from README; it names the ACP registry URL and the snapshot date of data/registry.json
- [x] #7 Every relative link in README, docs/ and skills/throng/SKILL.md resolves to an existing file or anchor
- [x] #8 A user can go from a fresh clone to a successful list_harnesses call using README alone
- [x] #9 backlog/tasks/throng-6 no longer references Sherpa by name; the note reads as a maintainer review
- [x] #10 scripts/spike/ is either removed or referenced from DESIGN.md with the finding it produced
- [x] #11 Gates green: pnpm typecheck && pnpm lint && pnpm test
- [x] #12 No absolute home-directory path in any tracked file (a grep for the macOS home prefix over tracked files is empty)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Went through the task-cycle workflow; report spot-checked
- [x] #2 Gates green: pnpm typecheck && pnpm test
- [x] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# THRONG-15: prepare the repository for publishing on GitHub

Repository URL (assumed, not yet published): https://github.com/Nodge/throng-mcp. Owner: Nodge. The project: `throng`, an MCP server that runs Claude Code, Codex and OpenCode over ACP and returns the nested agent's result; see README.md, docs/DESIGN.md, AGENTS.md.

Out of scope, do not touch: `backlog/` (already scrubbed by the maintainer), `src/`, `test/`, `scripts/smoke/`, `skills/throng/SKILL.md` (link it, don't edit it), the content of the contracts in docs/DESIGN.md §3 (you may add facts that README documented and §3 lacks, see 2c, and link lines). No npm `bin`/npx distribution of the server.

## 1. License and package metadata

- `LICENSE` at the repo root: MIT, "Copyright (c) 2026 Maksim Zemskov".
- `package.json`: add `"license": "MIT"`, `"description": "MCP server that delegates coding tasks to Claude Code, Codex and OpenCode over ACP"`, `"repository": { "type": "git", "url": "git+https://github.com/Nodge/throng-mcp.git" }`. Keep `"private": true`.

## 2. README.md for users only

Today README.md (320 lines) mixes three audiences. After the task it serves a user who wants to install throng and call it from Claude Code. Target order of sections:

1. Intro: what throng is and what the tools do, one paragraph (keep the current one, trimmed).
2. **Security** (new, right after the intro): there is no sandbox, worktree or isolation: the nested agent edits the live tree at `cwd`; every harness runs in its own auto-approve mode and the default policy `auto` refuses whatever that mode still asks about; the other policies are `allow_all`, `deny_all`, `elicit` (a dialog in the client); run throng only on trees you would let an agent edit; link to Permissions.
3. Requirements (as is).
4. Install: server via `git clone https://github.com/Nodge/throng-mcp` (no `<this repo>` placeholder anywhere), adapters, `claude mcp add` as today. Skill: replace the `mkdir -p ~/.claude/skills && ln -s ...` command with the skills CLI (vercel-labs/skills): `npx skills add Nodge/throng-mcp --skill throng -g -a claude-code` (`-g` = user scope; omit `-g` for the current project only). Keep the notes that throng itself never touches `~/.claude` and that Claude Code picks skills up at session start.
5. Agent spec: keep, but do not enumerate the harnesses' current model lists (they go stale; codex now offers gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 and efforts low..max plus ultra): say the model must be one the harness offers, `list_harnesses` lists them, one example per harness.
6. One worked example: a `run_thronglet` call (agent, prompt, cwd, description) and what comes back (session_id, text, stop_reason, usage), then one `send_message` follow-up. Prose plus one short JSON each; no TypeScript shapes.
7. Configuration and Permissions: keep (they are what a user needs), trim repetition.
8. Troubleshooting: keep.
9. Links: `docs/DESIGN.md#3-external-contract` for exact tool contracts, `docs/development.md` for maintainers, `skills/throng/SKILL.md` for the calling agent's patterns.

2a. Move out of README the per-tool TypeScript shapes and tables: `run_thronglet`, `send_message`, Background turns and `wait_thronglet`, `list_thronglets`, `cancel_thronglet`, the error-code table, stop reasons. The canonical contract is docs/DESIGN.md §3 "External contract"; README links there instead of restating. One place only: no new reference document for contracts.

2b. Move "Files on disk", "Smoke (maintainer)" and "Development" to a new `docs/development.md` (maintainer document). Its "Files on disk" part also names `data/registry.json` as a verbatim snapshot of the ACP registry, URL https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, snapshot date 2026-09-27 (DESIGN §2.2 / §4.1). Moved content is moved, not duplicated.

2c. Before deleting a README passage, check that DESIGN §3 states the same fact (field, error code, behaviour such as queueing, steer, background semantics). A fact README had and §3 lacks is added to §3 in its style (a documentation sync, not a contract change). List every such addition in impl.md.

## 3. scripts/spike/concurrent-prompt.ts

Delete the file. Check docs/DESIGN.md for the finding it produced (concurrent prompts on one ACP session; grep DESIGN for "spike" and "concurrent"); if DESIGN already records the fact, nothing more; if not, add one sentence where the fact belongs (§2.3 adapters or §4) saying it was verified by a spike on 2026-09-27.

## 4. Links

Every relative link in README.md, docs/DESIGN.md, docs/development.md and skills/throng/SKILL.md resolves to an existing file and, when it has a fragment, an existing heading (GitHub anchors: lowercase, spaces to `-`, punctuation dropped). Check with a small script or by hand; put the list of checked links in impl.md.

## 5. Checks and style

`pnpm typecheck && pnpm lint && pnpm test` green (deleting the spike must not break lint). Prettier ignores `*.md`: match the existing README style by hand (ATX headers, fenced blocks with language tags, tables, backticked identifiers). The Russian/English rule: everything in English.

## Acceptance criteria (verbatim)

1. LICENSE file exists at the repo root and `package.json` has a matching `license` field, plus `description` and `repository`.
2. README has the real repository URL in Install; no `<this repo>` placeholder anywhere.
3. README has a Security section right after the intro stating no sandbox/isolation, the default permission policy and how to change it.
4. README covers only user-facing content: what it is, requirements, install, skill setup, agent spec, one worked example, configuration, permissions, troubleshooting, links to the other docs.
5. Tool contracts (inputs, results, error codes, stop reasons) live in exactly one place; README and DESIGN §3 link to it rather than restating it.
6. Smoke, Files on disk and Development live in a maintainer document under docs/, linked from README; it names the ACP registry URL and the snapshot date of data/registry.json.
7. Every relative link in README, docs/ and skills/throng/SKILL.md resolves to an existing file or anchor.
8. A user can go from a fresh clone to a successful list_harnesses call using README alone.
9. No absolute home-directory path in any tracked file (a grep for the macOS home prefix over tracked files is empty).
10. (done by the maintainer) backlog/tasks/throng-6 no longer references Sherpa by name.
11. scripts/spike/ is either removed or referenced from DESIGN.md with the finding it produced.
12. Gates green: pnpm typecheck && pnpm lint && pnpm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Runbook run .agent-runbooks/runs/20261002-throng-15 ended ready: preflight, implement (Opus, 4.8 min), checks, review-a (Opus, 2 findings) + review-b (gpt-6.1-sol, 0 findings), triage (2 to fix), fix, verify (2 resolved, 0 unresolved), polish. Spot-checked: a2 DESIGN.md:115 harness_unavailable comment binds the install hint to the not-found branch only. a1 was resolved by the coder by keeping an ln -s alternative next to npx skills because src/skill.test.ts asserted the ln -s command; the maintainer dropped the alternative and retargeted the test to the npx skills add command. DESIGN §3 received the facts README documented and §3 lacked (list in the run impl.md: timeout_s source, text/usage sources, ErrorCode comments, queue wait not counted, steer and cancel semantics, list ordering); no contract change. Deviation from the brief: registry links point to DESIGN §2.3 (where the registry paragraph is), not §2.2. Deferred: README "Tested with" versions are stale (codex adapter is 2.1.1 now); DESIGN §3.5 keeps the generic /path/to placeholder. Orchestrator deviation logged in progress.md: the fix launch message was reconstructed after its output was truncated.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
LICENSE (MIT) and package.json description/license/repository added; README rewritten for users (320 → 184 lines: intro, Security, Requirements, Install with the real URL and the skills CLI, Agent spec, one worked example, Configuration, Permissions, Troubleshooting, Links); per-tool contracts live only in DESIGN §3, which README links; Files on disk, Smoke and Development moved to docs/development.md with the ACP registry URL and snapshot date; scripts/spike removed (its finding already in DESIGN §3.3); backlog notes scrubbed of the home-directory path and the private tool name. Verified: gates green (typecheck, lint, 267 tests), git grep for the home prefix and for the placeholder empty, every relative link target and anchor exists (coder link check listed in the run impl.md; anchors 3-external-contract, 23-adapters, 41-harnesses-and-discovery, smoke, permissions confirmed against headings), two independent reviews with the two findings fixed and verified by a separate Opus.
<!-- SECTION:FINAL_SUMMARY:END -->
