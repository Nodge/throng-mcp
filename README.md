# throng

An MCP server for delegating coding tasks to other agents. `run_thronglet` starts Claude Code, Codex or OpenCode over ACP (Agent Client Protocol) in the directory you give it, runs one prompt to completion and returns the agent's final message. `send_message` sends the next message into that session; with `background: true` either call returns at once and `wait_thronglet` collects the result. `list_thronglets` shows the sessions and what each is doing, `cancel_thronglet` stops a session's running turn. `list_harnesses` shows which harnesses are installed, with their models and effort levels. The nested agent edits the live tree at `cwd`: there is no sandbox, worktree or apply-back step. v1 runs every harness in its own auto-approve mode (`permissions: auto`); whatever that mode still asks about, throng refuses.

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

Tool names in Claude Code: `mcp__throng__run_thronglet`, `mcp__throng__send_message`, `mcp__throng__wait_thronglet`, `mcp__throng__list_thronglets`, `mcp__throng__cancel_thronglet`, `mcp__throng__list_harnesses`.

Check the setup: ask Claude to call `list_harnesses` (each installed adapter is started without a prompt, so it costs no tokens), or run `pnpm smoke claude/sonnet` from the repo (spends a few tokens, see [Smoke](#smoke-maintainer)).

## Skill

`skills/throng` is a skill for the calling agent: working patterns for when to delegate, writing the prompt, background turns and `wait_thronglet`, follow-ups, `steer`, housekeeping, structured output and permissions. Install it for every project (user scope):

```bash
mkdir -p ~/.claude/skills && ln -s "$(pwd)/skills/throng" ~/.claude/skills/throng
```

Run it from the repo root yourself; throng doesn't touch `~/.claude`. Claude Code picks skills up from `~/.claude/skills` at session start, so start a new session after linking.

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
  background?: boolean;  // return as soon as the turn runs, see "Background turns"
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
| `session_not_found` | send_message / wait_thronglet: no session record for the id, or the harness can't resume it |
| `spawn_failed` | the adapter process could not start, or `cwd` is not a directory |
| `handshake_timeout` | the adapter didn't finish initialize/session setup within `limits.handshake_s` |
| `handshake_failed` | the adapter answered the handshake with an error |
| `model_rejected` | model not among the harness's values; message lists the valid ones |
| `timeout` | the run exceeded `timeout_s` |
| `cancelled` | the client cancelled the call (Esc, TaskStop) or the agent cancelled its turn |
| `transport_lost` | the adapter exited or closed its stdio mid-run; or the server running a background turn died |
| `empty_result` | the turn ended without a single agent message; wait_thronglet: the record has no turn result |
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
  background?: boolean;  // as in run_thronglet
  steer?: boolean;       // interrupt the running turn, run this message next
}
```

Harness, model, effort and `cwd` come from the session record written by `run_thronglet` (see [Files on disk](#files-on-disk)); the caller doesn't repeat them. Each call starts a fresh adapter process, which picks the session up with ACP `session/resume`: the nested session's context is the harness's own, throng replays no history. Permission mode, model and effort are applied again, as for a new run. The result is the same payload as `run_thronglet`, with the same `session_id`; the same failure codes apply, plus `session_not_found` when there is no record for the id (records live 14 days) or the harness refuses to resume it.

Turns on one session run one after another: a message to a session whose turn is still running waits for that turn to end and reports `queued` in progress. The wait doesn't count toward `timeout_s` (or `duration_s`).

`steer: true` is the way to reach a running turn: throng cancels it (ACP `session/cancel`, then the adapter is closed) and runs this message as the very next turn, ahead of anything already queued; the queued messages run after it, in their order. The cancelled turn ends with `cancelled` ("cancelled by steer"), which its own caller gets; the steered turn's result then becomes the session's last result. The cost: the tool call in flight is aborted, and a half-applied edit may remain in the tree. The agent's next reply still knows what it was doing, as far as the harness kept it (checked on all three adapters). With `background: true` a steer on a running session is accepted as `queued` (the cancelled turn has to end first). On an idle session `steer` changes nothing.

### Background turns and `wait_thronglet`

With `background: true`, `run_thronglet` and `send_message` return as soon as the turn runs, or, for `send_message`, as soon as it is queued behind the session's running turn:

```ts
{ session_id: string; state: 'running' | 'queued'; queued: number }   // queued: messages waiting behind the running turn
```

Failures before the turn starts (bad spec, depth, handshake, model, unknown session) still fail the call itself, with the usual payload; for a message accepted as `queued`, those that come after the acceptance go to `wait_thronglet`. A call that has to wait for a `max_concurrency` slot returns only once it gets one and its handshake is done, reporting `queued (n)` in progress meanwhile; cancelling it before the acceptance cancels the run. After the acceptance the turn keeps running inside the server process and cancelling the call doesn't stop it. It holds a slot only while it runs.

```ts
wait_thronglet {
  session_id: string;
  timeout_s?: number;    // how long to wait; default from config limits.timeout_s
}
```

Waits until the session has no running or queued turn, then returns the last turn's result exactly as the synchronous call would have: the success payload, or the tool error with the failure payload. When `timeout_s` elapses first it returns `{ session_id, state, queued }` as a normal result, not an error; call it again to keep waiting. Progress heartbeats (`waiting 3m00s`) keep the client's idle timeout away.

The result lives in the session record, so `wait_thronglet` is idempotent and answers after a server restart. A turn running in another throng server (another Claude session, a nested agent) is polled through the record until it ends. A turn whose server died gets `transport_lost` ("turn interrupted: the throng server process that ran it is gone"), marked at the next server start or by `wait_thronglet` itself. Messages queued behind such a turn are lost: the queue lives in the server process.

### `list_thronglets`

No input. Every session record on this machine, most recently used first:

```ts
{
  thronglets: Array<{
    session_id: string;
    description: string;   // from run_thronglet
    agent: string;         // <harness>/<model>[:<effort>]
    cwd: string;
    state: 'running' | 'queued' | 'idle' | 'failed';
    queued: number;        // messages waiting behind the running turn
    created_at: string;
    last_used_at: string;
    last_error?: { code: string; message: string };   // when failed
  }>;
}
```

`running` / `queued` is this server's live state. A session whose turn runs in another throng server (another Claude session, a nested agent) shows as `running` from its record, with `queued: 0`: the queue of that server is not visible here. `failed` means the last turn ended with an error, `idle` that it succeeded or no turn has finished yet. A turn whose server died is never listed as `running`: it is marked `failed` with `transport_lost`, as described under `wait_thronglet`. A record that can't be read is skipped (logged).

### `cancel_thronglet`

```ts
{ session_id: string }
// → { session_id: string; state: 'idle'; cancelled_turn: boolean }
```

Cancels the session's running turn (ACP `session/cancel`, then the adapter is closed) and drops every message queued behind it, synchronous or background. The cancelled turn's error is `cancelled` ("cancelled by cancel_thronglet"); it becomes the session's last result, so a pending `wait_thronglet` returns it, and so do the queued calls (theirs say they were waiting for the running turn). Returns once the session is idle; it accepts a new `send_message` right away. On an idle session it is a no-op with `cancelled_turn: false`; the same for a turn that has already finished and is only closing its adapter: its result stands, and the call returns once the session is idle. Failures: `session_not_found` for an unknown id; `agent_error` when the turn runs in another throng server process (cancel it from the session that started it) or doesn't stop in time (the longer of `limits.handshake_s` and the 5 s cancel grace, plus 20 s: 80 s by default).

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

- `~/.cache/throng/sessions/<session_id>.json`: one record per session (`harness, model, effort, cwd, description, created_at, last_used_at`), read by `send_message`, `wait_thronglet` and `list_thronglets`. Every turn also writes `turn_started_at` and `turn_pid` (the server process running it) while it runs, then replaces them with `last_result` (the success payload) or `last_error` (the failure payload) and updates `last_used_at`. At start the server gives every record whose `turn_pid` is gone the interrupted `last_error`.
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
- Tests are vitest, next to the code (`src/**/*.test.ts`). They drive `test/fake-agent` (an ACP agent with scripted scenarios) and never call an LLM; real harnesses only in `scripts/smoke/`, run by hand. `src/skill.test.ts` keeps `skills/throng/SKILL.md` to the existing tool names and error codes.
- Design: [docs/DESIGN.md](docs/DESIGN.md). Process: [AGENTS.md](AGENTS.md).
