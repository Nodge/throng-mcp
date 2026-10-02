---
id: THRONG-14
title: 'Skill: how to use throng'
status: To Do
assignee: []
created_date: '2026-10-02 11:08'
updated_date: '2026-10-02 11:08'
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
- [ ] #1 The repo contains a skill (`SKILL.md` with frontmatter `name` and a `description` that triggers on delegating work to another harness/model and on any throng tool use) under a skills directory in the project
- [ ] #2 The skill covers: choosing an agent spec (`list_harnesses`), foreground vs background turns and `wait_thronglet`, multi-turn work with `send_message` and the queue, `steer` and its cost, `list_thronglets`/`cancel_thronglet`, structured output, permission policies
- [ ] #3 Every tool name, parameter and error code in the skill matches DESIGN §3 at the time of writing; the skill does not duplicate tool descriptions verbatim, it links patterns to them
- [ ] #4 README gives the maintainer the command to install the skill into user scope; the task itself does not touch `~/.claude`
- [ ] #5 Checked in a real session: a fresh Claude Code session with the skill installed picks it up on a delegation request and makes a correct background run + wait + follow-up `send_message`
- [ ] #6 The skill states what the prompt of a thronglet must contain: it is self-contained, the thronglet has no access to the caller's conversation
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the task-cycle workflow; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
