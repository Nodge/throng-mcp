---
id: THRONG-15
title: Prepare the repository for publishing on GitHub
status: To Do
assignee:
  - '@nodge'
created_date: '2026-10-02 16:18'
updated_date: '2026-10-02 16:20'
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

Decisions already made by the maintainer: commit author email stays as is (no history rewrite); `backlog/` is published as part of the project, so its contents must read fine for an outsider; stage tags are not required. License: MIT unless the maintainer says otherwise.

Hygiene findings:
- No `LICENSE` file; `package.json` has no `license`, `description`, `repository`. (`bin` / npx distribution is out of scope.)
- `README.md` Install says `git clone <this repo>`; needs the real GitHub URL.
- The no-sandbox / auto-approve default is one sentence in the README intro; a public MCP server that spawns agents with bypass permissions needs a visible Security block near the top: no isolation, what the default policy refuses, how to switch policy.
- Absolute path `/Users/nodge/Sites/throng-mcp` in backlog/tasks throng-9, 11, 12, 13, 14 (notes, ~line 50 each); replace with a relative path or `<repo>`.
- `backlog/tasks/throng-6` line ~116 mentions "Sherpa review" (the maintainer private tool); reword so an outsider understands it was a manual maintainer review.
- `data/registry.json` provenance (registry URL + snapshot date) lives only in DESIGN §4.1; the maintainer docs need one line with it.
- `scripts/spike/concurrent-prompt.ts` is a committed spike: delete it, or keep with a one-line pointer in DESIGN.md to the finding it produced.

README restructure. Today README.md (320 lines) serves three audiences at once: a user installing throng and calling it from Claude Code, an agent/developer needing exact tool contracts, and the maintainer (smoke matrix, development). README should serve the first audience only. Proposal for the cut (the worker decides the final shape):
- Stay in README, trimmed to what a user needs: intro, Security, Requirements, Install, Skill, Agent spec, one worked example instead of per-tool TypeScript shapes, Configuration, Permissions, Troubleshooting, links to the other docs.
- Per-tool contracts (`run_thronglet`, `send_message`, Background turns, `list_thronglets`, `cancel_thronglet`: input and result shapes, error code table, stop reasons): one canonical place. DESIGN §3 already holds the contract; either it is the reference and README links there, or a new `docs/` reference becomes canonical and DESIGN §3 points to it. No third copy.
- Files on disk, Smoke (maintainer), Development: a maintainer document under `docs/`.
- `skills/throng/SKILL.md` already covers calling-agent patterns; README links it, not restates it.
Moved content is moved, not duplicated; all links between README, skill, DESIGN and the new docs must resolve.

Backlog files are edited via the `backlog` CLI only (AGENTS.md).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 LICENSE file exists at the repo root and `package.json` has a matching `license` field, plus `description` and `repository`
- [ ] #2 README has the real repository URL in Install; no `<this repo>` placeholder anywhere
- [ ] #3 README has a Security section right after the intro stating no sandbox/isolation, the default permission policy and how to change it
- [ ] #4 README covers only user-facing content: what it is, requirements, install, skill setup, agent spec, one worked example, configuration, permissions, troubleshooting, links to the other docs
- [ ] #5 Tool contracts (inputs, results, error codes, stop reasons) live in exactly one place; README and DESIGN §3 link to it rather than restating it
- [ ] #6 Smoke, Files on disk and Development live in a maintainer document under docs/, linked from README; it names the ACP registry URL and the snapshot date of data/registry.json
- [ ] #7 Every relative link in README, docs/ and skills/throng/SKILL.md resolves to an existing file or anchor
- [ ] #8 A user can go from a fresh clone to a successful list_harnesses call using README alone
- [ ] #9 No absolute path under /Users in any tracked file (`git grep -n /Users/` is empty)
- [ ] #10 backlog/tasks/throng-6 no longer references Sherpa by name; the note reads as a maintainer review
- [ ] #11 scripts/spike/ is either removed or referenced from DESIGN.md with the finding it produced
- [ ] #12 Gates green: pnpm typecheck && pnpm lint && pnpm test
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
