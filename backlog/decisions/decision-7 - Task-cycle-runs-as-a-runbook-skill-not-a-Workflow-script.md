---
id: decision-7
title: 'Task cycle runs as a runbook skill, not a Workflow script'
date: '2026-10-02 16:59'
status: accepted
---
## Context

The task cycle (coder, checks, dual review, triage, fix and verify rounds, polish) was a Workflow-tool script, `.claude/workflows/task-cycle.js`. It ran only inside Claude Code, kept its state in the harness, and an interrupted run could not be resumed. A runbook (`.claude/skills/runbook-task-cycle/`: SKILL.md, `flow.py`, prompts) keeps the run state in files under `.agent-runbooks/runs/` and tells the orchestrating session what to launch next, so a run survives a lost session and can be driven from any harness that can start subagents. The smoke run (task SMOKE, 2026-10-02) went preflight → implement → checks → two reviews → polish → `ready`.

## Decision

Every code task goes through `runbook-task-cycle`; the Workflow script is removed. Executors: Opus coder, Sonnet for preflight and checks, Opus and GPT (`codex/gpt-6.1-sol:high` as a thronglet) reviews, the main session for triage. Made by the maintainer (nodge) with Fable, 2026-10-02.

## Consequences

- AGENTS.md "Task cycle" describes the runbook; the backlog definition of done names it.
- `.agent-runbooks/` is gitignored; a run's files are evidence for the task notes, not part of the repo.
- The GPT executor still runs through throng itself; the Claude executors go through the Agent tool, so the orchestrator must be a Claude Code session for now. Moving every executor to a thronglet is a separate task.

