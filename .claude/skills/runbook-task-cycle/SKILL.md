---
name: runbook-task-cycle
description: "One throng-mcp task end to end. Coder, project checks, two independent reviews (Claude and GPT), triage, fix rounds with verification, a polish pass. Inputs taskId, brief, repo, optional coder and maxFixRounds. Leaves the changes uncommitted."
---

# Task cycle

Leaves one throng-mcp task implemented in the working tree, uncommitted, with `pnpm typecheck`, `pnpm lint` and `pnpm test` green and every review finding triage marked to fix either fixed with evidence or listed for the maintainer. The backlog, the commit and the maintainer's smoke runs happen outside.

## Inputs

- `taskId`: the backlog task id, e.g. `THRONG-7`
- `brief`: the task brief as text, the plan of record from the backlog task. The orchestrator saves it to `<run>/brief.md` and passes `"brief": "brief.md"` to `start`
- `repo`: absolute path of the tree the task runs in: the project directory, or a worktree under `.claude/worktrees/<name>` for tasks that run in parallel
- `coder`: `opus` (default) or `codex`. `codex` only when the maintainer asks for it
- `maxFixRounds`: positive integer, default 2. One round is one pass of fix and verify
- `run-id`: given only to resume an interrupted run
- Smoke input: `taskId: SMOKE`, brief "Create `SMOKE.md` in the repository root with the single line `smoke`", coder opus, `repo` the project directory. `SMOKE.md` must not exist before the run. The maintainer deletes it after. The expected path is the shortest one: the reviewers should find nothing.

The checks are green before a run. The runbook does not fix what was red already.

## Run directory

`<the directory this session runs in>/.agent-runbooks/runs/<YYYYMMDD>-<slug>/`. Slug: the task id in lower case, `throng-7`.

## Execution rules

You are the orchestrator of this run. Orchestrating takes a session that can launch subagents and learn when they finish. If yours cannot, stop and say so. During the run you do only these things:

- run `python3 <skill>/flow.py …` as written below
- save the input files the Inputs section names into the run directory `start` created
- launch steps as subagents, with the message `flow.py` prints
- read a step's output file only to quote it to the human
- ask the human, and report the end of the run

Nothing else. No other command, no reading of `flow.py`, `state.json`, `progress.md` or the prompt files, no editing of anything in the run directory. `<skill>` is the directory this `SKILL.md` was loaded from.

Starting

- The run directory is `.agent-runbooks/runs/<YYYYMMDD>-<slug>` under the directory your session started in, with today's local date. Run `python3 <skill>/flow.py <run> start '<the inputs you were given, as one JSON object>'` first, with every input the Inputs section saves to a file given as that file name: it creates the directory, or refuses because it exists, in which case add `-2`, `-3` to the name and start again. Then save the input files the Inputs section names into the directory it created.
- Resume: `python3 <skill>/flow.py <run>`.

flow.py

- It keeps the state of the run and prints what to do: which steps to launch, with which executor and what message, whom to wait for, what to ask the human, or that the run has ended. Do all of what it prints, then wait. Every command it asks you to run next is printed in full.
- A step's message arrives: take the last JSON object in it and run the `reply` command printed for that step with that JSON. No JSON object in the message: pass `{"status": "failed", "reason": "invalid reply"}`. Any JSON argument, for `start` or `reply`, with a single quote (`'`) in it goes through stdin: put `-` in place of the JSON and pipe it in with a quoted heredoc.
- The human answers a question: map the answer to one of the choices `flow.py` listed, ask again if none fits, and run the `answer` command printed with that choice and the human's words verbatim. A free-text question takes the words alone. `flow.py` keeps the words and writes them where the steps that follow read them.
- A running step's executor is gone, because the session is new or the tool reports it dead: `flow.py <run> interrupted <section>`. Executors you launched in this conversation are not gone: wait for them.
- You departed from these rules, or did something `flow.py` does not know about: `flow.py <run> log '<one line>'`.

Launching

- Launch every step `flow.py` lists, with the executor it names, and send exactly the text between `--- message ---` and `--- end of message ---`. Add nothing, apart from lines your harness or your own rules require in every subagent prompt. An executor that only relays another agent's reply gets one more line: "Return the agent's final message verbatim."

Waiting

- Waiting costs zero turns. Pick the branch that matches your harness.
  - You can launch a subagent in the background and get woken up when it finishes, and ending your turn does not end your session: launch the ready steps that way and end your turn. On a wake-up, record the reply, do what `flow.py` prints, end your turn.
  - Otherwise, which includes running nested in another agent where the end of your turn is the end of your run: launch the ready steps in the foreground, in parallel if your harness allows several calls at once, otherwise one after another. Set every timeout or yield parameter your tool accepts to 24 hours or its maximum. If a call returns while the step still runs, call the wait again and do nothing else.
- Either way the step's completion is the only event. No polling, no sleeping, no reading ahead, no status messages while it runs. An hour-long step is a normal working state.

Human steps and side effects

- `flow.py` tells you when to ask the human and what. Ask, then wait for the answer the way you wait for a step. A failed step with side effects is relaunched only after the human says yes: `flow.py <run> relaunch <section>`.

Ending

- When `flow.py` prints `end`, report what it says to the human: the status, the run directory, the file to read. The run is over and these rules no longer bind you.

## Steps

Declared in `flow.py` next to this file: inputs, executors, steps with their prompts, what each reads and writes, and the transitions between them. `flow.py` drives the run and prints, for every launch, the executor's model and tool. This section is a pointer, not a copy.

## End of run

- `ready`: both reviewers found nothing, so triage was skipped, or triage marked nothing to fix, or every finding to fix is resolved with evidence; the checks are green and the polish pass is done. The maintainer reads the polish file `flow.py` names, then the last `verify.md` if there is one, else `triage.md` if there is one. Step outputs in the run directory carry their launch number: `05-triage.md`, `08-verify.md`. Findings not worth fixing are under "Rejected" in `triage.md` with reason "not worth it". Then the backlog notes and finalization, and one commit to main with the task id.
- `needs_attention`: findings to fix remain unresolved or the checks still fail. `verify.md` says which, or `polish.md` if the polish pass left them red. The maintainer decides.
- `failed`: a step failed or was blocked, the checks stayed red after one fix attempt, or the maintainer stopped at ask-dirty. The file `flow.py` names at the end says why.

Report the status, the run directory and the file `flow.py` names.

