# Common

Repository: `<repo>`, the throng-mcp project: an MCP server that runs agent harnesses over ACP, one pnpm package, TypeScript run as `node src/mcp.ts` with no build step. Its rules are in `<repo>/AGENTS.md`, the design in `<repo>/docs/DESIGN.md`. The task brief is `<run>/brief.md`. In short:

- Version control is `git`. Nothing is committed by a step.
- Only erasable TypeScript syntax, imports with `.ts`. Tests are vitest next to the code (`src/foo.test.ts` for `src/foo.ts`) and never call an LLM: everything goes through `test/fake-agent`. Real harnesses only in `scripts/smoke/`, run by hand.
- Nothing outside `<repo>` is touched: no user-scope config, nothing under `~/.claude`.
- The external contracts of DESIGN §3 (tool input and output, `ErrorCode`, `HarnessDefinition`, the Worker interface) and `backlog/` are the maintainer's: a step changes them only when the brief says so.
- Formatting is prettier, applied by the pre-commit hook. Do not hand-format; run `pnpm fmt` if `lint` complains about formatting.

"The changes" are everything uncommitted in `<repo>`: `git status` and `git diff HEAD`, plus untracked files read in full.

The project checks are three commands run in `<repo>`, each one even if an earlier one failed: `pnpm typecheck`, `pnpm lint`, `pnpm test`. A check that cannot run, because `node_modules` is missing, is failed, not skipped.

A report that mentions the checks has a "Checks" section: each command, its exit code, and the full output of the failing ones. The checks change no tracked files. If one did, say so in the Checks section. Files they write that git ignores do not count as changes.

Create the parent directories of the files you write.

## Executor constraints

You run one step of a larger procedure. The project's procedures for task cycles, review and commit are not yours to start. Change repository files only as your step instructs, and leave the changes uncommitted unless it instructs a commit. File names in your step's prompt, such as `checks.md`, are names, not paths: the launch message gives a `write <name>: <path>` line for each file you write, and a `read <name>: <path>` line for each file you read, or says it is absent. Write other files only at the paths your launch message gives. Commits, pushes, comments, tickets and other external writes happen only when your step instructs them. Nobody will answer a question. If you cannot proceed, stop and reply `blocked`.

Your final message is the JSON your step's schema describes and nothing else. `status` is `done` when the deliverable exists as described, `failed` when you tried and it does not, `blocked` when you cannot proceed. `failed` and `blocked` carry a one-line `reason`. Other fields are required only with `done`. Explanations and evidence go into your step's output file.
