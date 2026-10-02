---
id: THRONG-24
title: 'Spike: Cursor agent over ACP'
status: To Do
assignee: []
created_date: '2026-10-02 21:23'
labels: []
milestone: m-3
dependencies:
  - THRONG-21
references:
  - 'https://cursor.com/docs/cli/reference/parameters'
priority: low
type: spike
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Cursor subscriptions bundle many models plus the Composer models that exist nowhere else, bound to Cursor login. DESIGN §11 already names Cursor: 'cursor-agent acp' with extension methods cursor/ask_question and cursor/create_plan that the client must answer. Open questions nobody has verified: whether the global flag 'cursor-agent --force acp' (alias --yolo) really applies in ACP mode (vendor docs describe the flag, only a forum reply and a third-party wrapper claim it works over ACP), how model and effort are exposed, and what the two extension methods expect as answers. Cursor also always prompts for web search and does not cover MCP servers from session/new with --force, which matters for the throng_result submit tool (§6).

cursor-agent was not installed on the maintainer machine in v1. The spike needs it installed and logged in (maintainer does that), then a throwaway ACP session driven by hand or by a script under scripts/smoke. Outcome is a written answer, then a decision whether a native definition task is worth creating.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A note (backlog notes or docs/) answers: does --force before acp disable request_permission; what modes, config options (model, thought_level) session/new advertises; what cursor/ask_question and cursor/create_plan require from the client; whether the throng_result MCP server is usable under --force
- [ ] #2 Based on the answers, either a native Cursor harness task is created with concrete acceptance criteria, or the note records why Cursor is not supported
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Went through the runbook-task-cycle; report spot-checked
- [ ] #2 Gates green: pnpm typecheck && pnpm test
- [ ] #3 DESIGN.md updated if an external contract (DESIGN §3) changed
<!-- DOD:END -->
