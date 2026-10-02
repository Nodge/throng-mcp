# throng

An MCP server for delegating coding tasks to other agents. `run_thronglet` starts Claude Code, Codex or OpenCode over ACP (Agent Client Protocol) in the directory you give it, runs one prompt to completion and returns the agent's final message. `send_message` sends the next message into that session; with `background: true` either call returns at once and `wait_thronglet` collects the result. `list_thronglets` shows the sessions and what each is doing, `cancel_thronglet` stops a session's running turn. `list_harnesses` shows which harnesses are installed, with their models and effort levels.

## Security

- There is no sandbox, worktree or isolation: the nested agent edits the live tree at `cwd` with your user's rights, and throng rolls nothing back.
- By default (`permissions: auto`) every harness runs in its own auto-approve mode, and whatever that mode still asks about, throng refuses.
- The other policies are `allow_all` (every request allowed once), `deny_all` (every request refused) and `elicit` (each request shown to you as a dialog in the MCP client). The policy is set in the config file, never by the calling model; see [Permissions](#permissions).
- Run throng only on trees you would let an agent edit unattended.

## Requirements

- node ≥ 24 (runs `src/*.ts` directly via type stripping, no build step) and pnpm.
- The CLIs of the harnesses you want to use on PATH, logged in: `claude`, `codex`, `opencode`.
- The ACP adapters for Claude Code and Codex (OpenCode speaks ACP itself). throng ships no adapters; you install them.

Tested with node 24.11.1, pnpm 11.10, claude 2.1.282, codex 0.156.1, opencode 1.18.30.

## Install

```bash
git clone https://github.com/Nodge/throng-mcp
cd throng-mcp
pnpm install
```

Adapters:

```bash
npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
```

throng passes the absolute paths of the `claude` / `codex` it finds on PATH to the adapters (`CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`), so they run your installed, logged-in CLI.

OpenCode is a single binary with ACP built in (`opencode acp`): install it per https://opencode.ai/docs.

Register the server in Claude Code (user scope, all projects), from the repo root:

```bash
claude mcp add --scope user throng -- node "$(pwd)/src/mcp.ts"
claude mcp list
```

Tool names in Claude Code: `mcp__throng__run_thronglet`, `mcp__throng__send_message`, `mcp__throng__wait_thronglet`, `mcp__throng__list_thronglets`, `mcp__throng__cancel_thronglet`, `mcp__throng__list_harnesses`.

Check the setup: in a new Claude Code session ask Claude to call `list_harnesses`. Each installed adapter is started without a prompt, so it costs no tokens; the answer lists every available harness with its models and efforts, and under `unavailable` what is missing and how to install it.

### Skill

[`skills/throng`](skills/throng/SKILL.md) is a skill for the calling agent: when to delegate, writing the prompt, background turns and `wait_thronglet`, follow-ups, `steer`, housekeeping, structured output and permissions. Install it with the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add Nodge/throng-mcp --skill throng -g -a claude-code
```

`-g` installs it for every project (user scope); without `-g` it goes into the current project only.

You run this yourself; throng itself never touches `~/.claude`. Claude Code picks skills up at session start, so start a new session after installing.

## Agent spec

`agent` names harness, model and effort in one string: `<harness>/<model>[:<effort>]`.

```
claude/opus[1m]:max
codex/gpt-6-sol:xhigh
opencode/openrouter/z-ai/glm-5.3-flash
```

- The first path segment is the harness: `claude`, `codex` or `opencode`. The rest is the model as the harness names it (for OpenCode that is `<provider>/<model>`).
- The model must be one the harness offers. `list_harnesses` lists them; they are the harness's own values and change with its versions.
- The suffix is taken as effort only when it is `low | medium | high | xhigh | max`, so a model name with its own `:tag` stays intact. Omitted, the harness default applies.
- Effort is mapped to the harness's effort option: claude takes the level as is; codex too, with `max` falling back to `xhigh` if absent. OpenCode's ACP adapter exposes no effort option (1.18.31), so a suffix there only produces a warning. An effort the harness doesn't offer is a warning, not an error.

## Example

Ask Claude to delegate a task, and it calls `run_thronglet`:

```json
{
  "agent": "codex/gpt-6-sol:high",
  "prompt": "In this repository, add a --verbose flag to the CLI in src/cli.ts and a test for it. Run pnpm test. Leave the changes uncommitted and end with the list of files you changed.",
  "cwd": "/work/my-app",
  "description": "add --verbose flag"
}
```

The prompt is self-contained: the nested session sees nothing of the calling conversation. When the turn ends, the call returns the agent's final message with the session id, why the turn stopped, and what it cost:

```json
{
  "session_id": "019a4c2e-7d1b-7f40-9a2c-5e8b1d3f6a90",
  "text": "Added --verbose to src/cli.ts and a test in src/cli.test.ts; pnpm test passes. Changed: src/cli.ts, src/cli.test.ts.",
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 48210, "output_tokens": 3120 },
  "duration_s": 94.3
}
```

A follow-up goes into the same session with `send_message`; the agent still has the context of its first turn, and the result has the same shape and the same `session_id`:

```json
{
  "session_id": "019a4c2e-7d1b-7f40-9a2c-5e8b1d3f6a90",
  "prompt": "Also document the flag in README.md."
}
```

A failure is an MCP tool error carrying `code`, `message` and, when the session exists, `session_id` and the partial `text`. Every field, error code and stop reason of every tool is in [DESIGN §3](docs/DESIGN.md#3-external-contract).

## Configuration

Optional: `~/.config/throng/config.yaml`.

```yaml
# Permission policy: auto | allow_all | deny_all | elicit (see Permissions below).
permissions: auto

# Per-harness overrides, all optional.
harnesses:
  # claude:
  #   env: { CLAUDE_CODE_OAUTH_TOKEN: "..." }  # extra adapter env; e.g. auth when the standalone `claude` isn't logged in
  # codex:
  #   permissions: allow_all                   # per-harness policy override
  # opencode:
  #   command: /opt/opencode                   # adapter outside PATH: absolute path, or a name looked up on PATH
  #   args: [acp]                              # replaces the default args
  #   env: { X: "1" }

limits:
  timeout_s: 21600       # default turn timeout (6 h)
  handshake_s: 60        # adapter start + session setup
  elicitation_s: 600     # policy elicit: how long a permission dialog waits for an answer
  max_concurrency: 10    # parallel turns per server process
  max_depth: 2           # nested throng → harness → throng → … levels
```

Unknown keys are rejected. A broken config is logged on server start and shows up in every `list_harnesses` `unavailable` reason; `run_thronglet` refuses to run until it's fixed (it never falls back to defaults, which might be less strict than what you meant).

Environment variables of the server:

| variable | meaning |
|---|---|
| `THRONG_MCP_CONFIG` | config path instead of `~/.config/throng/config.yaml` |
| `THRONG_MCP_CACHE_DIR` | cache dir instead of `~/.cache/throng` (session records, kept 14 days) |
| `THRONG_MCP_DEPTH` | nesting depth; set by throng for its children, you don't set it by hand |

### Permissions

The policy comes from the config only, never from a tool parameter, so the calling model can't grant itself more than the config allows. throng answers every permission request with a one-time option, never "always allow" (Claude would write that rule into the project settings).

- `auto` (default): each harness runs in its own auto-approve mode (Claude `auto`, Codex `agent`, OpenCode as configured); whatever it still asks about is rejected.
- `allow_all`: the harness runs in its asking mode (Claude `default`, Codex `read-only`, OpenCode with every permission set to `ask`) and every request is allowed once.
- `deny_all`: the same asking mode; every request is rejected.
- `elicit`: the same asking mode; each request is shown to you as a dialog in the MCP client (the tool title, kind, input truncated to 2 KB, paths) with the one-time choices the harness offered. Your answer goes to the agent; Decline rejects, dismissing the dialog or no answer within `limits.elicitation_s` cancels the request, and the agent carries on either way. Background turns ask the same way. Needs an MCP client that supports elicitation (Claude Code does); otherwise the call fails with `elicitation_unsupported` before anything starts. A throng call inside a thronglet usually fails that way, since its client is the harness.

throng's own `submit_result` (structured output) is allowed under every policy. Cancelling a run answers its pending requests `cancelled` and closes any open dialog.

Auth: the nested harness uses whatever login its CLI has. If `claude auth status` says not logged in, put `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) into `harnesses.claude.env` as above. Codex and OpenCode use their own logins: `codex login`, `opencode auth login`. OpenCode custom providers live in your `~/.config/opencode/opencode.json`; throng doesn't touch it.

## Troubleshooting

- `harness_unavailable`: the adapter isn't on PATH, and the message carries the install command; or the config is broken (message starts with `config error:`): fix the yaml, throng won't run on defaults.
- `elicitation_unsupported`: `permissions: elicit` (global or `harnesses.<harness>.permissions`) but the MCP client has no elicitation support; the message names the key. Use a client that has it or pick another policy.
- A warning `permission mode "auto" not applied: the agent switched to "acceptEdits"`: Claude Code has no auto mode for that model (haiku, for one) and falls back to accept-edits; file edits are still auto-approved, anything else the harness asks about is rejected by throng (`auto` never widens into allow-all). Pick another model if you need the real auto mode.
- `model_rejected`: the model isn't one of the harness's values. Call `list_harnesses` for the current list; they are the harness's own option values and change with harness versions.
- `handshake_timeout` / `spawn_failed` / `handshake_failed`: the message includes the adapter's stderr. Usual cause is auth: check `claude auth status` (or set `CLAUDE_CODE_OAUTH_TOKEN` in config), `codex login`, `opencode auth login`. Slow first start: raise `limits.handshake_s`.
- `empty_result`: the agent ended its turn without saying anything; the harness's own session log shows what it did.
- `timeout`: raise `timeout_s` for the call or `limits.timeout_s`. The payload keeps `session_id` and any partial `text`.
- Anything else: the server log (stderr of the server; the MCP client decides where it ends up), then the harness's session log by `session_id`. throng keeps no transcripts.

## Links

- [DESIGN §3 "External contract"](docs/DESIGN.md#3-external-contract): the exact inputs, results, error codes and stop reasons of every tool, background turns and `wait_thronglet`, the per-session queue and `steer`.
- [skills/throng/SKILL.md](skills/throng/SKILL.md): working patterns for the calling agent.
- [docs/development.md](docs/development.md): for maintainers: tests, smoke runs against real harnesses, files on disk.
- [LICENSE](LICENSE): MIT.
