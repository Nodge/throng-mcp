# throng

An MCP server for delegating coding tasks to other agents. `run_thronglet` starts Claude Code, Codex or OpenCode over ACP (Agent Client Protocol) in the directory you give it, runs one prompt to completion and returns the agent's final message. `list_harnesses` shows which harnesses are installed, with their models and effort levels. The nested agent edits the live tree at `cwd`: there is no sandbox, worktree or apply-back step. v1 runs every harness in its own auto-approve mode (`permissions: auto`).

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

Adapters (the versions throng was verified against):

```bash
npm i -g @agentclientprotocol/claude-agent-acp@0.81.2 @agentclientprotocol/codex-acp@1.13.1
```

This also pulls each adapter's bundled copy of its harness (~600 MB). If `claude` and `codex` are already on PATH, skip the bundled copies:

```bash
npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.81.2 @agentclientprotocol/codex-acp@1.13.1   # ~58 MB
```

throng passes the absolute paths of the `claude` / `codex` it finds on PATH to the adapters (`CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`), so they run your installed, logged-in CLI. Without the CLI on PATH, install without `--omit=optional`: the adapter then falls back to its bundled binary.

OpenCode is a single binary with ACP built in (`opencode acp`): install it per https://opencode.ai/docs.

Register the server in Claude Code (user scope, all projects):

```bash
claude mcp add --scope user throng -- node /abs/path/to/throng-mcp/src/mcp.ts
claude mcp list
```

Tool names in Claude Code: `mcp__throng__run_thronglet`, `mcp__throng__list_harnesses`.

Check the setup: ask Claude to call `list_harnesses` (each installed adapter is started without a prompt, so it costs no tokens), or run `pnpm smoke claude/haiku` from the repo (spends a few tokens, see [Smoke](#smoke-maintainer)).

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
- The model must be one of the harness's own values, as listed by `list_harnesses`. Today: claude `default | opus[1m] | claude-fable-5-1 | sonnet | haiku`; codex `gpt-6-astra | gpt-6-sol | gpt-6-luna | gpt-5.6-sol | …`; opencode every `<provider>/<model>` it knows (default `opencode/big-pickle`).
- Effort is mapped to the harness's effort option: claude takes the level as is; codex too, with `max` falling back to `xhigh` if absent; OpenCode has no effort option, so a suffix there only produces a warning. An effort the harness doesn't offer is a warning, not an error.

### `run_thronglet`

```ts
{
  agent: string;         // see above
  prompt: string;        // self-contained: the nested session doesn't see your conversation
  cwd: string;           // absolute; the harness works (and edits) there
  timeout_s?: number;    // default 21600 (6 h), from config limits.timeout_s
  schema?: object;       // v2; accepted in v1 and ignored with a warning
}
```

The result is one JSON text block. Success:

```ts
{
  session_id: string;    // the harness's own session id (usable with `claude --resume` / `codex resume` by hand)
  text?: string;         // the agent's final message (last turn)
  stop_reason: 'end_turn' | 'max_tokens' | 'max_turn_requests';
  usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  duration_s: number;
  warnings?: string[];   // adapter notices, effort not applied, ignored schema, …
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
| `spawn_failed` | the adapter process could not start, or `cwd` is not a directory |
| `handshake_timeout` | the adapter didn't finish initialize/session setup within `limits.handshake_s` |
| `handshake_failed` | the adapter answered the handshake with an error |
| `model_rejected` | model not among the harness's values; message lists the valid ones |
| `timeout` | the run exceeded `timeout_s` |
| `cancelled` | the client cancelled the call (Esc, TaskStop) or the agent cancelled its turn |
| `transport_lost` | the adapter exited or closed its stdio mid-run |
| `empty_result` | the turn ended without a single agent message |
| `refusal` | the agent refused (stop_reason `refusal`) |
| `agent_error` | anything else the adapter reported |

`elicitation_unsupported`, `session_not_found`, `structured_missing`, `structured_invalid` belong to v2 features and don't occur in v1.

Where the fields come from: `text` is the concatenated agent message chunks of the last turn; `session_id` is the ACP session id the adapter returned; `usage` tokens come from the prompt response (summed over turns), `cost_usd` from the adapter's usage updates (claude and opencode report cost, codex doesn't).

### What the nested agent is told

Every prompt is prefixed with executor rules (`src/prompt.ts`): do the task yourself in cwd; don't run the project's own task cycles/workflows from CLAUDE.md / AGENTS.md; don't commit or push unless told; don't kill processes you didn't start; say plainly when something couldn't be done, no placeholders; the final message is the result. The nested session sees nothing of the calling conversation, so the prompt must carry all the context: files, constraints, what "done" means.

### In Claude Code

- A call running longer than 120 s in an interactive main session is moved to a background task automatically; the result arrives as a notification, stop it with TaskStop. Inside subagents the call stays synchronous.
- Esc (or TaskStop) cancels the call: throng cancels the nested session and kills the adapter's process tree.
- throng sends progress notifications (tool calls, agent text, a heartbeat every 30 s), which keep Claude Code's 30-min idle timeout for MCP calls from firing on long turns.
- Several `run_thronglet` calls can run in parallel, up to `limits.max_concurrency`; the rest wait in a queue (reported as progress).

## Configuration

Optional: `~/.config/throng/config.yaml`.

```yaml
# Permission policy: v1 supports only `auto` (each harness's own auto-approve mode).
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

- `~/.cache/throng/sessions/<session_id>.json`: one record per session (`harness, model, effort, cwd, created_at, last_used_at`), for `resume_thronglet` in v2.
- `~/.cache/throng/runs/<ts>-<harness>-<session_id>.jsonl`: transcript of each call: input (prompt length only), every ACP event, permission decisions, adapter stderr tail, outcome. Not returned to the caller; for debugging by hand.
- Both are rotated at server start: files older than 14 days are deleted.
- Server logs are short lines on stderr (start/stop, each run's outcome and transcript path, errors); the MCP client decides where they end up.

## Smoke (maintainer)

Runs one real task against a real harness with your env, config and cache. Spends tokens; one harness at a time.

```bash
pnpm smoke:claude       # claude/haiku
pnpm smoke:codex        # codex/gpt-6-luna
pnpm smoke:opencode     # opencode/opencode/big-pickle
pnpm smoke opencode/<provider>/<model>                  # custom provider
pnpm smoke:claude -- --prompt "…" --cwd /some/dir --timeout 600
```

The script starts the server, prints the `list_harnesses` table (versions, model counts, efforts, commands, unavailable reasons, limits), runs `run_thronglet` in a fresh temp dir asking the agent to write `pong.txt`, prints the payload, then checks:

- `PASS: pong.txt written` / `FAIL: …`: the file exists with content `pong`. The check runs with a custom `--prompt` too, so such a prompt should also write `pong.txt`. A `--cwd` that already contains `pong.txt` is refused (exit 2).
- `PASS: no orphans` / `FAIL: orphaned adapter processes: <pids>`: no new `claude-agent-acp`, `codex-acp` or `opencode acp` process is alive 3 s after the client closed. `FAIL: cannot check orphans (…)` when `pgrep` is missing or fails.

Exit code: 0 all passed; 1 a FAIL or a tool error; 2 bad usage, harness unavailable or unknown model (the valid models are printed). Server stderr is prefixed `[server]`, progress `[progress]`. The temp dir is removed on success and kept (path printed) on failure; transcripts are under the printed `transcripts:` path.

Manual items that need an interactive Claude Code session:

1. Esc during a running `run_thronglet`; afterwards `pgrep -f "claude-agent-acp|codex-acp|opencode acp"` prints nothing.
2. A call over 2 min goes to the background: e.g. prompt `run sleep 150 in the shell, then reply done`; the result arrives as a notification.
3. OpenCode with a custom provider from `opencode.json`.

Record the adapter versions `list_harnesses` reported in the backlog task notes.

## Troubleshooting

- `harness_unavailable`: the adapter isn't on PATH, and the message carries the install command; or the config is broken (message starts with `config error:`): fix the yaml, throng won't run on defaults; or `permissions` is something other than `auto` (v2).
- A warning `permission mode "auto" not applied: the agent switched to "acceptEdits"`: Claude Code has no auto mode for that model (haiku, for one) and falls back to accept-edits; file edits are still auto-approved, other requests are answered `allow_once` by throng. Pick another model if you need the real auto mode.
- `model_rejected`: the model isn't one of the harness's values. Call `list_harnesses` for the current list; they are the harness's own option values and change with harness versions.
- `handshake_timeout` / `spawn_failed` / `handshake_failed`: the message includes the adapter's stderr. Usual cause is auth: check `claude auth status` (or set `CLAUDE_CODE_OAUTH_TOKEN` in config), `codex login`, `opencode auth login`. Slow first start: raise `limits.handshake_s`.
- `empty_result`: the agent ended its turn without saying anything; the transcript shows what it did.
- `timeout`: raise `timeout_s` for the call or `limits.timeout_s`. The payload keeps `session_id` and any partial `text`.
- Anything else: the per-call transcript under `~/.cache/throng/runs/`.

## Development

- Gates: `pnpm typecheck && pnpm test`.
- Tests drive `test/fake-agent` (an ACP agent with scripted scenarios) and never call an LLM; real harnesses only in `scripts/smoke/`, run by hand.
- Design: [docs/DESIGN.md](docs/DESIGN.md). Process: [AGENTS.md](AGENTS.md).
