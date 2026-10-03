# throng-mcp

[![skills.sh](https://skills.sh/b/agent-runbooks/throng-mcp)](https://skills.sh/agent-runbooks/throng-mcp/throng)

An MCP server that lets your agent hand work to another one. Any MCP client can call it, and the task goes to any supported harness.

- **Another model's view.** A review by another vendor's model, a design critique, a cheaper model for a mechanical pass.
- **Second opinions.** Hand one agent's result to another: Codex reviews, Claude fixes, Codex checks again, each in its own long-lived session.
- **Real sessions, not one-shots.** The nested agent keeps running; a follow-up goes to the same agent with everything it already knows.
- **Background work.** Several agents run at once while you carry on.
- **Answers by schema.** Pass a JSON Schema and the result comes back as data that fits it, not prose to parse: a list of findings, a verdict, a plan, ready to feed into the next step.

Supported harnesses: Claude Code, Codex, OpenCode (and every model it can reach), Gemini CLI. Setup for each is under [Install](#2-the-agents-to-run).

## Example

You're in Claude Code and have just changed the payment flow.

> Ask Codex to find a way this payment flow could charge someone twice. Don't change any files.

Claude calls `run_thronglet` with `agent: "codex/gpt-6-sol:high"`, a self-contained prompt, the repository path and a `schema`, so the findings come back as data: file, line, steps to reproduce.

> Give the findings to Opus. Have it fix each one, add a test for it and run the tests.

A second `run_thronglet`, with `agent: "claude/opus"`. Codex's findings go into its prompt; Opus edits the code and runs the tests.

> Now show the same Codex session what changed. Can it still make a customer pay twice?

That is `send_message` into the first session: Codex still has its findings in context and checks the fixes against them instead of starting over.

Any of these calls takes `background: true`: it returns at once and `wait_thronglet` collects the result later, which is how several agents work while you carry on.

## Install

Three parts, in order: the server, the agents it may run, and the client it is called from. The skill at the end is optional.

<details>
<summary><strong>Claude Code: the plugin, server and skill in one go</strong></summary>

The plugin covers parts 1, 3 and 4; the agents from part 2 you still install yourself.

```bash
claude plugin marketplace add agent-runbooks/throng-mcp
claude plugin install throng@throng-mcp
```

</details>

### 1. The server

The npm package [`throng-mcp`](https://www.npmjs.com/package/throng-mcp). Needs node `^22.13 || >=24`. Tested with node 24.11.1, claude 2.1.282, codex 0.156.1, opencode 1.18.30.

Two ways to run it:

- `npx -y throng-mcp` straight in the client config, below. Nothing to install: npx fetches the package on the first start and caches it. The package has no dependencies, so that is one tarball and nothing else.
- A global install, then the command is `throng-mcp`. Starts faster than going through npx.

  ```bash
  npm i -g throng-mcp
  ```

### 2. The agents to run

Each agent needs its own CLI installed and logged in. throng talks to agents over ACP (Agent Client Protocol); Claude Code and Codex need an ACP adapter, and throng ships none. Install only the agents you want to delegate to.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
npm i -g @agentclientprotocol/claude-agent-acp
claude auth status
```

throng passes the path of the `claude` it finds on PATH to the adapter (`CLAUDE_CODE_EXECUTABLE`), so the nested agent runs your installed, logged-in CLI. If `claude auth status` says not logged in, put `CLAUDE_CODE_OAUTH_TOKEN` into the config, see [docs/configuration.md](docs/configuration.md#auth).

</details>

<details>
<summary><strong>Codex</strong></summary>

```bash
npm i -g @agentclientprotocol/codex-acp
codex login
```

The adapter gets the path of your `codex` the same way (`CODEX_PATH`).

</details>

<details>
<summary><strong>OpenCode</strong></summary>

OpenCode speaks ACP itself (`opencode acp`), so there is no adapter. Install it per https://opencode.ai/docs, then:

```bash
opencode auth login
```

Custom providers live in your `~/.config/opencode/opencode.json`; throng doesn't touch it.

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Gemini CLI speaks ACP itself (`gemini --acp`), so there is no adapter.

```bash
npm i -g @google/gemini-cli
gemini
```

Run `gemini` once and sign in; the nested agent uses that login. Checked against Gemini CLI 0.61.0 only up to the first model request (handshake, models, modes); a full turn has not been run yet, so expect rough edges and please report them. Limits:

- One turn per session: Gemini CLI can't resume a session, so `send_message` to it fails with `session_not_found` before anything runs. `steer: true` is refused the same way and leaves the running turn alone; to stop a gemini turn, use `cancel_thronglet` and start a new run. `list_thronglets` shows such a session with `accepts_messages: false`.
- No effort levels: a `:<effort>` suffix is ignored with a warning.
- No usage numbers: the result's `usage` stays empty.
- The `cwd` you give it is trusted for the run (`GEMINI_CLI_TRUST_WORKSPACE=true`), under every permission policy.

</details>

### 3. The MCP client

The client is the session that calls throng. It may be the same program as one of the agents above, or a different one. The server speaks stdio and the command is `npx -y throng-mcp`, or `throng-mcp` after a global install.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add --scope user throng -- npx -y throng-mcp
```

`--scope user` registers it for every project; without it, for the current project only. `claude mcp list` shows the result.

</details>

<details>
<summary><strong>Codex</strong></summary>

```bash
codex mcp add throng -- npx -y throng-mcp
```

</details>

<details>
<summary><strong>OpenCode</strong></summary>

In `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "throng": {
      "type": "local",
      "command": ["npx", "-y", "throng-mcp"],
      "enabled": true
    }
  }
}
```

</details>

Any other MCP client: register a stdio server with that command.

### 4. The skill, optional

[`skills/throng`](skills/throng/SKILL.md) tells the calling agent how to use the server: when to delegate, how to write the prompt, background runs, follow-ups, structured output, what a refused permission means. It is a file for the agent and does not install the server.

<details>
<summary><strong>skills CLI: Claude Code, Codex, opencode and others</strong></summary>

```bash
npx skills add agent-runbooks/throng-mcp --skill throng -g -a claude-code -y
```

`-g` installs into the agent's user directory, for every project; without it, into the current project. `-a codex` or `-a opencode` for the other agents. `npx skills update` pulls later changes.

</details>

<details>
<summary><strong>By hand</strong></summary>

Copy `skills/throng` into your agent's skills directory: `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`. A global install also leaves it under the installed package, `$(npm root -g)/throng-mcp/skills/throng`.

</details>

Agents pick skills up at session start, so open a new session after installing.

### Check

In a new session, ask the agent to call `list_harnesses`. It starts each installed adapter without a prompt (seconds, no tokens) and lists every available harness with its models and effort levels; `unavailable` names what is missing and how to install it. If a run then fails during the handshake, the usual cause is auth: `claude auth status`, `codex login`, `opencode auth login`, `gemini` (sign in once). More in [troubleshooting](docs/configuration.md#troubleshooting).

Before the first run, two things to know. The agent edits the directory you name, with your user's rights; throng adds no isolation and rolls nothing back. Give it only trees you would let an agent edit unattended, and give parallel writers a worktree each.

## Using throng

`agent` names harness, model and effort in one string, `<harness>/<model>[:<effort>]`:

```
claude/opus:max
codex/gpt-6-sol:xhigh
opencode/openrouter/z-ai/glm-5.3-flash
gemini/gemini-2.5-pro
```

The model is one of the harness's own values; `list_harnesses` has the current list. Effort is `low | medium | high | xhigh | max`; omitted means the harness default.

A call:

```json
{
  "agent": "codex/gpt-6-sol:high",
  "prompt": "In this repository, add a --verbose flag to the CLI in src/cli.ts and a test for it. Run pnpm test. Leave the changes uncommitted and end with the list of files you changed.",
  "cwd": "/work/my-app",
  "description": "add --verbose flag"
}
```

The prompt is self-contained: the nested session sees nothing of the calling conversation. The call returns the agent's final message, a `session_id` for follow-ups, and why the turn stopped.

| tool | what it does |
|---|---|
| `run_thronglet` | starts a session and runs the first turn |
| `send_message` | runs the next turn in an existing session; `steer: true` interrupts the running turn instead of waiting for it |
| `wait_thronglet` | collects the result of a turn started with `background: true` |
| `list_thronglets` | the sessions and what each is doing |
| `cancel_thronglet` | stops a session's running turn |
| `list_harnesses` | the installed harnesses, their models and effort levels |

`background: true` on `run_thronglet` or `send_message` returns as soon as the turn is running; `wait_thronglet` collects the result later, which is how several agents run at once. `schema` asks for structured output: the agent fills a JSON Schema and the result comes back as `structured` instead of `text`.

A failure is an MCP tool error with `code`, `message` and, when the session exists, `session_id` and the partial `text`. Every field, error code and stop reason of every tool is in [DESIGN §3](docs/DESIGN.md#3-external-contract).

## Permissions and safety

What a nested agent may do comes from the config file, never from a tool parameter, so the calling model cannot grant itself more than you allowed. Optional `~/.config/throng/config.yaml`:

```yaml
permissions: auto
```

- `auto`, the default: each harness runs in its own auto-approve mode (Claude `auto`, Codex `agent`, OpenCode as configured, Gemini `yolo`); whatever that mode still asks about, throng refuses.
- `allow_all`: every request allowed, once. `deny_all`: every request refused.
- `elicit`: each request is shown to you as a dialog in the MCP client, with the one-time choices the harness offered. Needs a client with elicitation support; Claude Code has it.

throng never answers "always allow", so no rule gets written into the agent's project settings. Per-harness overrides, extra env for an adapter, timeouts and the nesting limit are in [docs/configuration.md](docs/configuration.md).

## Documentation

- [docs/configuration.md](docs/configuration.md): the config file, environment variables, permissions in detail, auth, troubleshooting.
- [DESIGN §3](docs/DESIGN.md#3-external-contract): the exact inputs, results, error codes and stop reasons of every tool.
- [skills/throng/SKILL.md](skills/throng/SKILL.md): working patterns for the calling agent.
- [docs/development.md](docs/development.md): for maintainers; tests, smoke runs against real harnesses, files on disk.
- [Agent Runbooks](https://github.com/agent-runbooks/skills): multi-step procedures a session runs through subagents. Any step of a runbook can go to any harness through throng.

## License

MIT, see [LICENSE](LICENSE).
