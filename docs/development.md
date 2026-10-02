# throng-mcp — development

For maintainers. Users start with [README.md](../README.md); the design and the exact tool contracts are in [DESIGN.md](DESIGN.md), the process (backlog, task cycle, roles) in [AGENTS.md](../AGENTS.md).

## Running from the checkout

To run your working copy instead of the npm package: `pnpm install`, then `pnpm start` (`node src/mcp.ts`, Node >= 22.18 or 24, no build). Register it in place of the package:

```bash
claude mcp add --scope user throng -- node /abs/path/to/throng-mcp/src/mcp.ts
```

## Development

- Gates: `pnpm typecheck && pnpm lint && pnpm test`. The pre-commit hook (lefthook, installed by `pnpm install`) formats with prettier, runs `eslint --fix` and typecheck.
- Tests are vitest, next to the code (`src/**/*.test.ts`). They drive `test/fake-agent` (an ACP agent with scripted scenarios) and never call an LLM; real harnesses only in `scripts/smoke/`, run by hand. `src/skill.test.ts` keeps `skills/throng/SKILL.md` to the existing tool names and error codes.

## Build and package

- `pnpm build` (tsdown, config in `tsdown.config.ts`) writes `dist/mcp.js`, the bin, and `dist/structured/submit-tool.js`, spawned for `schema` runs; shared code may land in a chunk under `dist/`. The runtime libraries are `devDependencies`, bundled into `dist/`: the package has no dependencies of its own. The build also writes `dist/THIRD_PARTY_LICENSES.md`, the licenses of the bundled packages, collected from the modules that ended up in the bundle (`scripts/build/third-party-licenses.ts`); a bundled package with neither a license file nor a `license` field fails the build. `ci:build` is the same for CI; `prepack` runs it, so `pnpm pack` and `pnpm publish` always ship a fresh build. `dist/` is ignored by git, prettier and eslint.
- Why a build: Node refuses to strip types under `node_modules`, so the package can't ship `src/`. Development, tests and smoke keep running the sources (`node src/mcp.ts`, Node >= 22.18 or 24); the published package needs Node `^22.13 || >=24`.
- The version from `package.json` and `data/registry.json` are JSON imports, inlined at build time: a registry update needs a rebuild, and `data/` is not in the package.
- `src/mcp.ts` resolves the submit tool's path from its own location (`.ts` next to the sources, `.js` in `dist/`) and passes it down as `RunContext.submitTool`.
- The tarball holds `dist/`, `skills/`, `docs/`, `README.md`, `LICENSE` and `package.json`. `pnpm pack --dry-run` lists it; `scripts/pack.test.ts` (in `pnpm test`) packs it into a temp dir, checks that list, that the packed `package.json` has no `dependencies` or `peerDependencies`, that `dist/THIRD_PARTY_LICENSES.md` names `@modelcontextprotocol/sdk` and `zod` and that `dist/` stays under 2 MB, and runs `node dist/mcp.js` from the unpacked package, with no `node_modules` anywhere, against the fake agent: `list_harnesses` and a `run_thronglet` with a `schema`.

## Release

- A task commit touching `src/` (tests aside), `data/` or the published fields of `package.json` carries a changeset, `pnpm changeset`; the rule and the bump levels are in [AGENTS.md](../AGENTS.md#task-cycle). Config: `.changeset/config.json`.
- `ci:changesets` (`changeset status --since=origin/main`) runs in CI on every push and PR. It fails any change to `src/` (tests aside), `data/` or `package.json` that has no changeset. It matches `package.json` as a whole file, so a PR that only touches `devDependencies` or `scripts` needs `pnpm changeset --empty`. On main it compares main with itself and always passes.
- Dependency bumps come from dependabot (`.github/dependabot.yml`): weekly, one grouped PR, a 7-day cooldown, the same as `minimumReleaseAge` in `pnpm-workspace.yaml` for local installs. The Changesets CI check is skipped for dependabot's own pushes. A bump of a bundled library (the five runtime libraries in [DESIGN §9](DESIGN.md#9-package-language-tests)) ships to users, so before merging add a patch changeset to the PR (`pnpm changeset` on the branch, text "Update <lib> to <version>"); that commit runs the check again. A bump of dev tooling alone needs none and is merged as is.
- On push to main the Release workflow (`.github/workflows/release.yml`, `changesets/action`) opens or updates the "Upcoming Release" PR: `changeset version` bumps `package.json` and writes `CHANGELOG.md`.
- Merging that PR runs `pnpm run ci:publish` (`ci:build` + `changeset publish`) with npm trusted publishing (OIDC, no token in the repo), and creates the GitHub release and the tag `throng-mcp@x.y.z`.
- The first publish goes by hand from a clean checkout, `pnpm publish --access public`: npmjs.com configures a trusted publisher only on a package that already exists (THRONG-18). Until `throng-mcp@0.1.0` is on npm, every Release run on main fails at `changeset publish` and publishes or tags nothing. So publish by hand right after the release setup lands on main, or before pushing it.

## Files on disk

- `~/.cache/throng/sessions/<session_id>.json`: one record per session (`harness, model, effort, cwd, description, created_at, last_used_at`), read by `send_message`, `wait_thronglet` and `list_thronglets`. Every turn also writes `turn_started_at` and `turn_pid` (the server process running it) while it runs, then replaces them with `last_result` (the success payload) or `last_error` (the failure payload) and updates `last_used_at`. At start the server gives every record whose `turn_pid` is gone the interrupted `last_error`.
- Records are rotated at server start: files older than 14 days are deleted.
- Server logs are short lines on stderr (start/stop, permission decisions, each run's outcome, errors); the MCP client decides where they end up.
- throng keeps no transcripts: the harness logs every session itself, find it by `session_id`.
- `data/registry.json` in the repo is a verbatim snapshot of the ACP registry, https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, taken 2026-09-27, inlined into the bundle at build time. It supplies the adapters' launch `args`/`env` and the install hints ([DESIGN §2.3](DESIGN.md#23-adapters), [§4.1](DESIGN.md#41-harnesses-and-discovery)).

## Smoke

Runs one real task against a real harness with your env, config and cache. Spends tokens; one harness at a time.

```bash
pnpm smoke:claude          # claude/sonnet
pnpm smoke:claude-schema   # claude/sonnet with --schema (structured output)
pnpm smoke:codex           # codex/gpt-6-luna
pnpm smoke:codex-schema    # codex/gpt-6-luna with --schema
pnpm smoke:opencode        # opencode/openrouter/z-ai/glm-5.3-flash (needs openrouter configured in opencode)
pnpm smoke:opencode-schema # opencode/openrouter/z-ai/glm-5.3-flash with --schema
pnpm smoke opencode/<provider>/<model>                  # custom provider
pnpm smoke:claude -- --prompt "…" --cwd /some/dir --timeout 600
pnpm smoke:claude -- --no-follow-up                    # skip the send_message step
pnpm smoke:claude -- --schema                          # run_thronglet with a schema {file, content}
pnpm smoke:claude -- --background                      # both turns with background: true, results via wait_thronglet
pnpm smoke:claude -- --cancel                          # background run, list_thronglets, cancel_thronglet, wait_thronglet
pnpm smoke:claude -- --steer                           # background run kept busy by `sleep 60`, then send_message steer
```

The script starts the server, prints the `list_harnesses` table (versions, model counts, efforts, commands, unavailable reasons, limits), runs `run_thronglet` in a fresh temp dir asking the agent to write `pong.txt`, prints the payload, then checks:

- `PASS: pong.txt written` / `FAIL: …`: the file exists with content `pong`. The check runs with a custom `--prompt` too, so such a prompt should also write `pong.txt`. A `--cwd` that already contains `pong.txt` is refused (exit 2).
- `PASS: structured is {file: pong.txt, content: pong}` / `FAIL: structured is …`: with `--schema` only; the run asks for the created file's name and content as structured output, and the payload's `structured` must match.
- `PASS: send_message answered pong.txt` / `FAIL: send_message …`: a `send_message` into the same session asks which file it created; its payload is printed and the answer must mention `pong.txt`. Skipped when the run failed, or with `--no-follow-up` (e.g. with a custom `--prompt`).
- `PASS: run_thronglet background accepted` / `PASS: send_message background accepted`: with `--background` only; the call answered `{session_id, state, queued}` (printed as `pending:`), and `wait_thronglet` then delivers the payload the checks above run on.
- With `--cancel` instead of the pong.txt and follow-up checks: `PASS: run_thronglet background accepted`, `PASS: list_thronglets shows the turn running` (the row has description `smoke: ping/pong`), `PASS: cancel_thronglet cancelled the turn` (`cancelled_turn: true`), `PASS: wait_thronglet returned cancelled`, `PASS: list_thronglets shows the turn failed with cancelled`.
- With `--steer` instead of the pong.txt and follow-up checks: `PASS: run_thronglet background accepted` (the prompt asks for `sleep 60` as one tool call, so there is a turn to interrupt), `PASS: send_message steer answered STEERED` (a synchronous `send_message` with `steer: true` asks for a line starting with STEERED and what the agent was doing; the payload is printed), `PASS: list_thronglets shows the session idle`.
- `PASS: no orphans` / `FAIL: orphaned adapter processes: <pids>`: no new `claude-agent-acp`, `codex-acp`, `opencode acp` or `submit-tool` process is alive 3 s after the client closed. `FAIL: cannot check orphans (…)` when `pgrep` is missing or fails.

Exit code: 0 all passed; 1 a FAIL or a tool error; 2 bad usage, harness unavailable or unknown model (the valid models are printed). Server stderr is prefixed `[server]`, progress `[progress]`. The temp dir is removed on success and kept (path printed) on failure.

Manual items that need an interactive Claude Code session:

1. Esc during a running `run_thronglet`; afterwards `pgrep -f "claude-agent-acp|codex-acp|opencode acp"` prints nothing.
2. A call over 2 min goes to the background: e.g. prompt `run sleep 150 in the shell, then reply done`; the result arrives as a notification.
3. OpenCode with a custom provider from `opencode.json`.

Record the adapter versions `list_harnesses` reported in the backlog task notes.
