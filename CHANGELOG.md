# throng-mcp

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
