# throng-mcp — configuration

For users. The install steps are in [README.md](../README.md); the tool contracts in [DESIGN §3](DESIGN.md#3-external-contract).

## Config file

Optional, `~/.config/throng/config.yaml`. Every key has a default; an empty or missing file is fine.

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
  # gemini:
  #   permissions: deny_all                    # harness ids: claude, codex, opencode, gemini

limits:
  timeout_s: 21600       # default turn timeout (6 h)
  handshake_s: 60        # adapter start + session setup
  elicitation_s: 600     # policy elicit: how long a permission dialog waits for an answer
  max_concurrency: 10    # parallel turns per server process
  max_depth: 2           # nested throng → harness → throng → … levels
```

Unknown keys are rejected. A broken config is logged on server start and shows up in every `list_harnesses` `unavailable` reason; `run_thronglet` refuses to run until it's fixed. It never falls back to defaults, which might be less strict than what you meant.

## Environment variables

| variable | meaning |
|---|---|
| `THRONG_MCP_CONFIG` | config path instead of `~/.config/throng/config.yaml` |
| `THRONG_MCP_CACHE_DIR` | cache dir instead of `~/.cache/throng` (session records, kept 14 days) |
| `THRONG_MCP_DEPTH` | nesting depth; set by throng for its children, you don't set it by hand |

## Permissions

The policy comes from the config only, never from a tool parameter, so the calling model can't grant itself more than the config allows. throng answers every permission request with a one-time option, never "always allow" (Claude would write that rule into the project settings).

- `auto` (default): each harness runs in its own auto-approve mode (Claude `auto`, Codex `agent`, OpenCode as configured, Gemini `yolo`); whatever it still asks about is rejected.
- `allow_all`: the harness runs in its asking mode (Claude `default`, Codex `read-only`, OpenCode with every permission set to `ask`, Gemini `default`) and every request is allowed once.
- `deny_all`: the same asking mode; every request is rejected.
- `elicit`: the same asking mode; each request is shown to you as a dialog in the MCP client (the tool title, kind, input truncated to 2 KB, paths) with the one-time choices the harness offered. Your answer goes to the agent; Decline rejects, dismissing the dialog or no answer within `limits.elicitation_s` cancels the request, and the agent carries on either way. Background turns ask the same way. Needs an MCP client that supports elicitation (Claude Code does); otherwise the call fails with `elicitation_unsupported` before anything starts. A throng call inside a thronglet usually fails that way, since its client is the harness.

`harnesses.<harness>.permissions` overrides the policy for one harness.

throng's own `submit_result` (structured output) is allowed under every policy. Cancelling a run answers its pending requests `cancelled` and closes any open dialog.

Claude Code has no auto mode for some models (haiku, for one) and falls back to accept-edits. throng warns `permission mode "auto" not applied: the agent switched to "acceptEdits"`; file edits are still auto-approved, anything else the harness asks about is rejected (`auto` never widens into allow-all). Pick another model if you need the real auto mode.

Gemini CLI runs with its workspace trusted (`GEMINI_CLI_TRUST_WORKSPACE=true`) under every policy: in an untrusted folder it refuses `yolo` and starts no MCP servers, throng's `submit_result` included. In its `default` mode read-only tools run without asking; edits, shell and MCP tools ask.

## Auth

The nested harness uses whatever login its CLI has. If `claude auth status` says not logged in, put `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) into `harnesses.claude.env` as in the config above. Codex, OpenCode and Gemini CLI use their own logins: `codex login`, `opencode auth login`, and a first run of `gemini` to sign in. OpenCode custom providers live in your `~/.config/opencode/opencode.json`; throng doesn't touch it.

## Effort

The `:<effort>` suffix of the agent spec is taken as effort only when it is `low | medium | high | xhigh | max`, so a model name with its own `:tag` stays intact. Claude takes the level as is; Codex too, with `max` falling back to `xhigh` if absent. OpenCode's ACP adapter exposes no effort option (1.18.31), so a suffix there only produces a warning. Gemini CLI has no effort knob over ACP either: always a warning. An effort the harness doesn't offer is a warning, not an error.

## Troubleshooting

| what you see | what to do |
|---|---|
| `harness_unavailable` | the adapter isn't on PATH, and the message carries the install command; or the config is broken (message starts with `config error:`): fix the yaml, throng won't run on defaults |
| `elicitation_unsupported` | `permissions: elicit` (global or `harnesses.<harness>.permissions`) but the MCP client has no elicitation support; the message names the key. Use a client that has it or pick another policy |
| `model_rejected` | the model isn't one of the harness's values. Call `list_harnesses` for the current list; they are the harness's own option values and change with harness versions |
| `handshake_timeout`, `spawn_failed`, `handshake_failed` | the message includes the adapter's stderr. Usual cause is auth: check `claude auth status` (or set `CLAUDE_CODE_OAUTH_TOKEN` in config), `codex login`, `opencode auth login`, `gemini` (sign in once). Slow first start: raise `limits.handshake_s` |
| `empty_result` | the agent ended its turn without saying anything; the harness's own session log shows what it did |
| `timeout` | raise `timeout_s` for the call or `limits.timeout_s`. The payload keeps `session_id` and any partial `text` |
| anything else | the server log (stderr of the server; the MCP client decides where it ends up), then the harness's session log by `session_id`. throng keeps no transcripts |
