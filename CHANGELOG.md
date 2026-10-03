# throng-mcp

## 0.4.0

### Minor Changes

- [`2ead051`](https://github.com/agent-runbooks/throng-mcp/commit/2ead0514c0aa957262f290fcf5b75bc0e678b770) Thanks [@Nodge](https://github.com/Nodge)! - Gemini CLI as a harness: `gemini/<model>` runs through Gemini CLI's own ACP mode (`gemini --acp`), with the Google-account login of the installed CLI. `list_harnesses` shows its models. Limits: a gemini session is one turn (`send_message` fails with `session_not_found`, Gemini CLI can't resume a session), there are no effort levels and no usage numbers, and the run's `cwd` is trusted (`GEMINI_CLI_TRUST_WORKSPACE=true`).

- [`780ae7f`](https://github.com/agent-runbooks/throng-mcp/commit/780ae7fd05e079795ad9042f356b748fe10abd06) Thanks [@Nodge](https://github.com/Nodge)! - `send_message` to a session whose harness can't resume (Gemini CLI) is refused with `session_not_found` before anything runs: no adapter process is started, and `steer: true` no longer cancels the running turn first. The session record remembers what the adapter advertised when the session was created; sessions created by an earlier version fail at the next turn's handshake as before. `list_thronglets` shows such a session with the new field `accepts_messages: false`.

### Patch Changes

- [`c8b4a01`](https://github.com/agent-runbooks/throng-mcp/commit/c8b4a0107f95eb0e3adfe3c2a215a2edfa79d270) Thanks [@Nodge](https://github.com/Nodge)! - The `agent` parameter description and the docs no longer show `claude/opus[1m]` as an example: the claude adapter stopped offering that value.

- [`1eb5d4d`](https://github.com/agent-runbooks/throng-mcp/commit/1eb5d4d24cfed04fe48ff19bd23f0797bc9a3010) Thanks [@Nodge](https://github.com/Nodge)! - A harness definition can now express the permission policy through `session/set_config_option` and extra launch args, next to the session mode and env. The built-in harnesses (claude, codex, opencode) behave as before; this prepares agents such as Copilot CLI and Cursor that switch auto-approval this way.

- [`b7463d7`](https://github.com/agent-runbooks/throng-mcp/commit/b7463d729ee6c4be5cf97126bee89cabc874d03c) Thanks [@Nodge](https://github.com/Nodge)! - The repository moved to github.com/agent-runbooks/throng-mcp. The npm package name and the tools are the same.

## 0.3.0

### Minor Changes

- [`4e6b810`](https://github.com/Nodge/throng-mcp/commit/4e6b810538b3ed288c266d1904739d1c1dda7a57) Thanks [@Nodge](https://github.com/Nodge)! - Claude Code plugin: `claude plugin marketplace add Nodge/throng-mcp`, then `claude plugin install throng@throng-mcp` installs the server and the skill together.

### Patch Changes

- [`ca5d875`](https://github.com/Nodge/throng-mcp/commit/ca5d8750a7cd26e4146473c9dcb230abac95b79f) Thanks [@Nodge](https://github.com/Nodge)! - An agent's `fs/*` call to throng (OpenCode sends `fs/write_text_file` after an approved edit) no longer adds a warning to the result; it is still answered "method not found" and logged to stderr. `terminal/*` calls keep the warning.

- [`4e6b810`](https://github.com/Nodge/throng-mcp/commit/4e6b810538b3ed288c266d1904739d1c1dda7a57) Thanks [@Nodge](https://github.com/Nodge)! - The `run_thronglet` description no longer lists the harnesses or limits the work to coding; `list_harnesses` has the current set.

## 0.2.0

### Minor Changes

- [`1317631`](https://github.com/Nodge/throng-mcp/commit/131763166f799da4fd457b0477446be10c381fa2) Thanks [@Nodge](https://github.com/Nodge)! - The package is self-contained: the runtime libraries (`@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`, `ajv`, `yaml`, `zod`) are bundled into `dist/`, and `package.json` has no `dependencies`. `npx -y throng-mcp` fetches one tarball and resolves nothing else; the versions a user runs are the ones the release was tested with. `dist/THIRD_PARTY_LICENSES.md` lists every bundled package with its license text.

## 0.1.1

### Patch Changes

- [`85d24ff`](https://github.com/Nodge/throng-mcp/commit/85d24ff3313788cda62cf9edaf8528b7677f1f16) Thanks [@Nodge](https://github.com/Nodge)! - Release notes for the first version, 0.1.0 shipped without a changelog. No code changes.
  
  throng-mcp is an MCP server that hands a task from one coding agent to another over ACP (Agent Client Protocol) and returns the final message into the calling session.
  
  - Tools: `run_thronglet` (new session, first turn), `send_message` (next turn in the same session; `steer: true` interrupts the running turn), `wait_thronglet`, `list_thronglets`, `cancel_thronglet`, `list_harnesses`.
  - Harnesses: Claude Code and Codex through their ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`), OpenCode natively (`opencode acp`) with every model it can reach. `agent` is one string, `<harness>/<model>[:<effort>]`.
  - Background turns: `background: true` returns once the turn runs; `wait_thronglet` collects the result, also after a server restart.
  - Structured output: pass a JSON Schema and the agent submits a matching result through an injected `throng_result` MCP tool, with up to two corrective prompts.
  - Permission policies from the config: `auto` (each harness's own auto-approve mode), `allow_all`, `deny_all`, `elicit` (every request goes to the human through the MCP client's elicitation).
  - Config in `~/.config/throng/config.yaml`: per-harness command, args, env, auth; limits for concurrency, nesting depth and the default timeout. Session records in `~/.cache/throng/sessions`, rotated after 14 days.
  - Published as a tsdown bundle with the `throng-mcp` bin: `npx -y throng-mcp` in any MCP client config; Node `^22.13 || >=24`.
  - `skills/throng`: a skill for the calling agent on when to delegate, how to write the prompt, follow-ups, background runs and structured output.
