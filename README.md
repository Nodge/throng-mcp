# throng

An MCP server for delegating coding tasks to other agents. `run_thronglet` starts Claude Code, Codex or OpenCode over ACP (Agent Client Protocol) in the directory you give it, runs one prompt to completion and returns the agent's final message. `send_message` sends the next message into that session. `list_harnesses` shows which harnesses are installed, with their models and effort levels. The nested agent edits the live tree at `cwd`: there is no sandbox, worktree or apply-back step. v1 runs every harness in its own auto-approve mode (`permissions: auto`); whatever that mode still asks about, throng refuses.

## Requirements

- node ≥ 24 (runs `src/*.ts` directly via type stripping, no build step) and pnpm.
- The CLIs of the harnesses you want to use on PATH, logged in: `claude`, `codex`, `opencode`.
- The ACP adapters for Claude Code and Codex (OpenCode speaks ACP itself). throng ships no adapters; you install them.

Tested with node 24.11.1, pnpm 11.10, claude 2.1.282, codex 0.156.1, opencode 1.18.30.

## Install

```bash
git clone <this repo> throng-mcp
cd throng-mcp
pnpm install
```

Adapters:

```bash
npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
```

throng passes the absolute paths of the `claude` / `codex` it finds on PATH to the adapters (`CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`), so they run your installed, logged-in CLI.

OpenCode is a single binary with ACP built in (`opencode acp`): install it per https://opencode.ai/docs.

Register the server in Claude Code (user scope, all projects):

```bash
claude mcp add --scope user throng -- node /abs/path/to/throng-mcp/src/mcp.ts
claude mcp list
```

Tool names in Claude Code: `mcp__throng__run_thronglet`, `mcp__throng__send_message`, `mcp__throng__list_harnesses`.

Check the setup: ask Claude to call `list_harnesses` (each installed adapter is started without a prompt, so it costs no tokens), or run `pnpm smoke claude/sonnet` from the repo (spends a few tokens, see [Smoke](#smoke-maintainer)).

## Usage

### Agent spec

`agent` names harness, model and effort in one string: `<harness>/<model>[:<effort>]`.

```
claude/sonnet
claude/opus[1m]:max
codex/gpt-6-sol:xhigh
opencode/openrouter/anthropic/claude-sonnet-5
```

- The first path segment is the harness: `claude`, `codex` or `opencode`. The rest is the model as the harness names it (for OpenCode that is `<provider>/<model>`).
- The suffix is taken as effort only when it is `low | medium | high | xhigh | max`, so a model name with its own `:tag` stays intact.
- The model must be one of the harness's own values, as listed by `list_harnesses`. Today: claude `default | opus[1m] | claude-fable-5-1 | sonnet | haiku`; codex `gpt-6-astra | gpt-6-sol | gpt-6-luna | gpt-5.6-sol | …`; opencode every `<provider>/<model>` it knows (e.g. `openrouter/z-ai/glm-5.3-flash`).
- Effort is mapped to the harness's effort option: claude takes the level as is; codex too, with `max` falling back to `xhigh` if absent. OpenCode's ACP adapter exposes no effort option (1.18.31), so a suffix there only produces a warning. An effort the harness doesn't offer is a warning, not an error.

### `run_thronglet`

```ts
{
  agent: string;         // see above
  prompt: string;        // self-contained: the nested session doesn't see your conversation
  cwd: string;           // absolute; the harness works (and edits) there
  description: string;   // what this thronglet is for, in a few words; stored in the session record
  timeout_s?: number;    // default 21600 (6 h), from config limits.timeout_s
  schema?: object;       // JSON Schema (draft-07 or 2020-12): the result comes back as `structured`, see below
}
```

The result is one JSON text block. Success:

```ts
{
  session_id: string;    // the harness's own session id: for send_message (and `claude --resume` / `codex resume` by hand)
  text?: string;         // the agent's final message (last turn); omitted when `structured` is returned
  structured?: unknown;  // with schema: the result the agent submitted, valid against the schema
  stop_reason: 'end_turn' | 'max_tokens' | 'max_turn_requests';
  usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  duration_s: number;
  warnings?: string[];   // adapter notices, effort not applied, …
}
```

Failure is an MCP tool error (`isError: true`) with:

```ts
{
  code: ErrorCode;
  message: string;       // the actual text: adapter stderr excerpt, list of valid models, …
  session_id?: string;   // when the session got created
  text?: string;         // what the agent said before failing
  usage?: { ... };
  duration_s: number;
  warnings?: string[];
}
```

| code | meaning |
|---|---|
| `harness_unavailable` | adapter not found (message has the install command), config error, or unsupported permission policy; checked before spawn |
| `depth_exceeded` | nested throng calls deeper than `limits.max_depth` |
| `session_not_found` | send_message: no session record for the id, or the harness can't resume it |
| `spawn_failed` | the adapter process could not start, or `cwd` is not a directory |
| `handshake_timeout` | the adapter didn't finish initialize/session setup within `limits.handshake_s` |
| `handshake_failed` | the adapter answered the handshake with an error |
| `model_rejected` | model not among the harness's values; message lists the valid ones |
| `timeout` | the run exceeded `timeout_s` |
| `cancelled` | the client cancelled the call (Esc, TaskStop) or the agent cancelled its turn |
| `transport_lost` | the adapter exited or closed its stdio mid-run |
| `empty_result` | the turn ended without a single agent message |
| `structured_missing` | with schema: the agent never called `submit_result`, even after 2 corrective prompts |
| `structured_invalid` | with schema: the last `submit_result` was rejected after 2 corrective prompts; message has the ajv errors |
| `refusal` | the agent refused (stop_reason `refusal`) |
| `agent_error` | anything else the adapter reported |

`elicitation_unsupported` belongs to a feature not built yet and doesn't occur today.

With `schema`, throng gives the nested session a small MCP server, `throng_result`, with one tool, `submit_result`, and tells the agent to finish by calling it. The schema is the tool's input schema (wrapped under `result`, `$defs` / `definitions` hoisted to the root), so the prompt doesn't repeat it. A permission request for `submit_result` is always allowed, whatever the policy. The tool validates with ajv and returns the errors to the agent, which fixes the result within the same turn. A turn that ends without a valid result gets a corrective prompt, at most 2; then the call fails with `structured_missing` or `structured_invalid`, carrying `text` (what the agent said) and `session_id`, so you can `send_message` into the session. A schema ajv can't compile is rejected as invalid input before anything starts.

Where the fields come from: `text` is the concatenated agent message chunks of the last turn; `session_id` is the ACP session id the adapter returned; `usage` tokens come from the prompt response (summed over turns), `cost_usd` from the adapter's usage updates (claude and opencode report cost, codex doesn't).

### `send_message`

The next message into an earlier nested session, e.g. "now fix what the review found" to the agent that wrote the code.

```ts
{
  session_id: string;    // from run_thronglet
  prompt: string;
  timeout_s?: number;    // default from config limits.timeout_s
  schema?: object;       // structured output, as in run_thronglet
}
```

Harness, model, effort and `cwd` come from the session record written by `run_thronglet` (see [Files on disk](#files-on-disk)); the caller doesn't repeat them. Each call starts a fresh adapter process, which picks the session up with ACP `session/resume`: the nested session's context is the harness's own, throng replays no history. Permission mode, model and effort are applied again, as for a new run. The result is the same payload as `run_thronglet`, with the same `session_id`; the same failure codes apply, plus `session_not_found` when there is no record for the id (records live 14 days) or the harness refuses to resume it.

Turns on one session run one after another: a message to a session whose turn is still running waits for that turn to end and reports `queued` in progress. The wait doesn't count toward `timeout_s` (or `duration_s`).

## Configuration

Optional: `~/.config/throng/config.yaml`.

```yaml
# Permission policy: v1 supports only `auto` (each harness's own auto-approve mode;
# a permission request the harness still raises is answered reject_once).
# allow_all | deny_all | elicit are v2; setting them now makes run_thronglet fail with harness_unavailable.
permissions: auto

# Per-harness overrides, all optional.
harnesses:
  # claude:
  #   env: { CLAUDE_CODE_OAUTH_TOKEN: "..." }  # extra adapter env; e.g. auth when the standalone `claude` isn't logged in
  # codex:
  #   permissions: allow_all                   # per-harness policy override (v2)
  # opencode:
  #   command: /opt/opencode                   # adapter outside PATH: absolute path, or a name looked up on PATH
  #   args: [acp]                              # replaces the default args
  #   env: { X: "1" }

limits:
  timeout_s: 21600       # default run_thronglet timeout
  handshake_s: 60        # adapter start + session setup
  elicitation_s: 600     # v2
  max_concurrency: 10    # parallel runs per server process
  max_depth: 2           # nested throng → harness → throng → … levels
```

Unknown keys are rejected. A broken config is logged on server start and shows up in every `list_harnesses` `unavailable` reason; `run_thronglet` refuses to run until it's fixed (it never falls back to defaults, which might be less strict than what you meant).

Environment variables of the server:

| variable | meaning |
|---|---|
| `THRONG_MCP_CONFIG` | config path instead of `~/.config/throng/config.yaml` |
| `THRONG_MCP_CACHE_DIR` | cache dir instead of `~/.cache/throng` |
| `THRONG_MCP_DEPTH` | nesting depth; set by throng for its children, you don't set it by hand |

Auth: the nested harness uses whatever login its CLI has. If `claude auth status` says not logged in, put `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) into `harnesses.claude.env` as above. Codex and OpenCode use their own logins: `codex login`, `opencode auth login`. OpenCode custom providers live in your `~/.config/opencode/opencode.json`; throng doesn't touch it.

## Files on disk

- `~/.cache/throng/sessions/<session_id>.json`: one record per session (`harness, model, effort, cwd, description, created_at, last_used_at`), read by `send_message`, which updates `last_used_at`.
- Records are rotated at server start: files older than 14 days are deleted.
- Server logs are short lines on stderr (start/stop, permission decisions, each run's outcome, errors); the MCP client decides where they end up.
- throng keeps no transcripts: the harness logs every session itself, find it by `session_id`.

## Smoke (maintainer)

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
```

The script starts the server, prints the `list_harnesses` table (versions, model counts, efforts, commands, unavailable reasons, limits), runs `run_thronglet` in a fresh temp dir asking the agent to write `pong.txt`, prints the payload, then checks:

- `PASS: pong.txt written` / `FAIL: …`: the file exists with content `pong`. The check runs with a custom `--prompt` too, so such a prompt should also write `pong.txt`. A `--cwd` that already contains `pong.txt` is refused (exit 2).
- `PASS: structured is {file: pong.txt, content: pong}` / `FAIL: structured is …`: with `--schema` only; the run asks for the created file's name and content as structured output, and the payload's `structured` must match.
- `PASS: send_message answered pong.txt` / `FAIL: send_message …`: a `send_message` into the same session asks which file it created; its payload is printed and the answer must mention `pong.txt`. Skipped when the run failed, or with `--no-follow-up` (e.g. with a custom `--prompt`).
- `PASS: no orphans` / `FAIL: orphaned adapter processes: <pids>`: no new `claude-agent-acp`, `codex-acp`, `opencode acp` or `submit-tool` process is alive 3 s after the client closed. `FAIL: cannot check orphans (…)` when `pgrep` is missing or fails.

Exit code: 0 all passed; 1 a FAIL or a tool error; 2 bad usage, harness unavailable or unknown model (the valid models are printed). Server stderr is prefixed `[server]`, progress `[progress]`. The temp dir is removed on success and kept (path printed) on failure.

Manual items that need an interactive Claude Code session:

1. Esc during a running `run_thronglet`; afterwards `pgrep -f "claude-agent-acp|codex-acp|opencode acp"` prints nothing.
2. A call over 2 min goes to the background: e.g. prompt `run sleep 150 in the shell, then reply done`; the result arrives as a notification.
3. OpenCode with a custom provider from `opencode.json`.

Record the adapter versions `list_harnesses` reported in the backlog task notes.

## Troubleshooting

- `harness_unavailable`: the adapter isn't on PATH, and the message carries the install command; or the config is broken (message starts with `config error:`): fix the yaml, throng won't run on defaults; or `permissions` is something other than `auto` (v2).
- A warning `permission mode "auto" not applied: the agent switched to "acceptEdits"`: Claude Code has no auto mode for that model (haiku, for one) and falls back to accept-edits; file edits are still auto-approved, anything else the harness asks about is rejected by throng (`auto` never widens into allow-all). Pick another model if you need the real auto mode.
- `model_rejected`: the model isn't one of the harness's values. Call `list_harnesses` for the current list; they are the harness's own option values and change with harness versions.
- `handshake_timeout` / `spawn_failed` / `handshake_failed`: the message includes the adapter's stderr. Usual cause is auth: check `claude auth status` (or set `CLAUDE_CODE_OAUTH_TOKEN` in config), `codex login`, `opencode auth login`. Slow first start: raise `limits.handshake_s`.
- `empty_result`: the agent ended its turn without saying anything; the harness's own session log shows what it did.
- `timeout`: raise `timeout_s` for the call or `limits.timeout_s`. The payload keeps `session_id` and any partial `text`.
- Anything else: the server log, then the harness's session log by `session_id`.

## Development

- Gates: `pnpm typecheck && pnpm lint && pnpm test`. The pre-commit hook (lefthook, installed by `pnpm install`) formats with prettier, runs `eslint --fix` and typecheck.
- Tests are vitest, next to the code (`src/**/*.test.ts`). They drive `test/fake-agent` (an ACP agent with scripted scenarios) and never call an LLM; real harnesses only in `scripts/smoke/`, run by hand.
- Design: [docs/DESIGN.md](docs/DESIGN.md). Process: [AGENTS.md](AGENTS.md).
