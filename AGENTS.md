# throng-mcp — development rules

Project: MCP server `throng` that runs coding harnesses (Claude Code, Codex, OpenCode) over ACP and returns their result to the calling session. Source of truth: `docs/DESIGN.md`. Tasks, milestones and decisions: Backlog.md in `backlog/` (CLI rules at the end of this file).

## Session ritual

1. At the start: `backlog instructions overview`, then `backlog task list -s "In Progress" --plain` and `-s Review` for unfinished work, `backlog milestone list --plain`, fresh `git log --oneline -15`. Next task: the first `To Do` in the current milestone (`backlog task list -m v1 -s "To Do" --plain`) whose dependencies are `Done`.
2. 2–4 tasks per sitting, no more: review quality beats speed.
3. At the end: statuses are current; a task left unfinished gets a "where we stopped" via `--append-notes`; commit.

## Task cycle

Every code task goes through the `runbook-task-cycle` skill (`.claude/skills/runbook-task-cycle/`): the main session is the orchestrator, `flow.py` keeps the state of the run and prints which step to launch next. The main session drives the backlog lifecycle around it (`backlog instructions task-execution` / `task-finalization`):

1. `backlog task view THRONG-n --plain`, then `backlog task edit THRONG-n -s "In Progress" -a @<you>`.
2. The main session researches and writes a self-contained brief: specific DESIGN.md sections, contracts, the task's acceptance criteria, what not to touch. The brief is the plan of record: `backlog task edit THRONG-n --plan "<brief>"`.
3. Load the skill and run it with inputs `taskId`, `brief`, `repo` (the project directory, or a worktree), optionally `coder` and `maxFixRounds` — implementation by an Opus coder, project checks, dual review (Opus + Codex), triage by the main session, fixes by the coder verified by a separate Opus, a polish pass. The run lives in `.agent-runbooks/runs/<date>-<task>/` (gitignored) and ends `ready`, `needs_attention` or `failed`, naming the file to read.
4. The main session reads that file (`polish.md`, then `verify.md` or `triage.md`) and spot-checks the "Resolved" evidence against the code. Report summary, deviations and deferred minor findings go to `--append-notes`.
5. Finalization: check acceptance criteria and DoD items only against evidence (tests, command output), `--final-summary`, status `Done`.
6. One commit to main with the code and the `backlog/` changes, task ID in the message (`THRONG-1: skeleton`).

Subagents (coder, reviewers, verifier) don't touch `backlog/`: everything they need is in the brief.

Statuses: `To Do / In Progress / Review / Blocked / Done`. `Review` = the code is ready and waits on a check outside the run (e.g. the maintainer's smoke run); `Blocked` = waits on something external, reason in notes.

v1 tasks are sequential. Tasks without mutual dependencies (v2: THRONG-6, THRONG-7, THRONG-8) may run in parallel, each in its own worktree under `.claude/worktrees/<name>`, passed as `repo`.

The Codex/GPT coder variant is the same runbook with `coder: codex`. Run it **only** when the maintainer asks explicitly ("on codex"); never picked on its own. Everything else stays the same: checks, dual review, triage, Opus verification of fixes.

Work found outside a task's acceptance criteria is not added silently: describe it to the maintainer and create a task only after approval.

## Roles

- **Fable (main session)**: backlog lifecycle, briefs, review triage, contracts (tool input/output and `ErrorCode` from DESIGN §3, `HarnessDefinition`, the Worker interface) — edits them itself, doesn't delegate; architecture decisions; spikes against real adapters; commits.
- **Opus (subagents)**: all other code — implementation and post-review fixes via the runbook; as separate agents, one of the two independent reviews and fix verification.
- **Codex (thronglets via the throng MCP server, `codex/gpt-6.1-sol:high`)**: the second independent review — another model's view of the code; writes code only in the `coder: 'codex'` variant, on the maintainer's explicit request.
- **Maintainer (human)**: smoke matrix on real harnesses (DESIGN §9; spends tokens), dogfood at the end of the stage, approves new tasks.

## Code rules

- Stack and TS constraints: DESIGN §9. Runs as `node src/mcp.ts` with no build step, so only erasable TS syntax; imports with `.ts`.
- Tests are vitest and live next to the code (`src/foo.test.ts` for `src/foo.ts`). They don't call LLMs: everything goes through `test/fake-agent`. Real harnesses only in `scripts/smoke/`, run by hand.
- Nothing outside the project directory is touched by tasks: no registering the server in the user-scope Claude config, no edits under `~/.claude/*`. README gives the maintainer the commands to run.
- Gates before any commit: `pnpm typecheck && pnpm lint && pnpm test`. Formatting is prettier, applied by the pre-commit hook; don't hand-format.

## End of stage

All milestone tasks `Done` (the maintainer's smoke list is part of their acceptance criteria) + dogfood (the maintainer calls `run_thronglet` from real sessions) + `backlog milestone archive <name>`. Dogfood is the only point where the process stops and waits for a human. Work past v2 (DESIGN §11) is decomposed into tasks when v2 closes, not before.

## Decisions

Decisions made during development (on top of DESIGN.md) are backlog decisions: `backlog decision create "<title>" -s accepted`, then fill Context / Decision / Consequences in the created file, with who made it. A decision that changes an external contract (DESIGN §3) also updates DESIGN.md in the same commit.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.53.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
