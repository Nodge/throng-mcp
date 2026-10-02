# throng-mcp

[![skills.sh](https://skills.sh/b/nodge/throng-mcp)](https://skills.sh/nodge/throng-mcp/throng)

An MCP server that lets your coding agent hand work to another one. From a Claude Code session you can give a task to Codex, or to a model behind OpenCode; throng runs that agent in the directory you name, over ACP (Agent Client Protocol), and returns its final message into your session. The nested session stays alive, so a follow-up goes to the same agent with everything it already knows.

What this buys you is a second model where one model's view is not enough: a review by another vendor's model, a design critique, a cheaper model for a mechanical pass. The agents run in the background too, so several can work while you carry on.

## Example

In Claude Code:

> Ask Codex to review the diff on this branch against main. Concrete bugs only, with file and line. Don't change any files.

Claude calls `run_thronglet` with `agent: "codex/gpt-6-sol:high"`, a self-contained prompt and the repository path. The call returns when Codex is done, with its findings as text. Then:

> Have the same Codex session fix the first two findings and run the tests.

That is `send_message` into the same session: Codex still has the diff and its own findings in context.

## Install

Three parts, in order: the server, the agents it may run, and the client it is called from. The skill at the end is optional.

### 1. The server

Needs node ≥ 24 and pnpm. Tested with node 24.11.1, pnpm 11.10, claude 2.1.282, codex 0.156.1, opencode 1.18.30.

```bash
git clone https://github.com/Nodge/throng-mcp
cd throng-mcp
pnpm install
```

There is no build step: the server is `node src/mcp.ts`, run from this checkout. Keep the clone where it is.

### 2. The agents to run

Each agent needs its own CLI installed and logged in. Claude Code and Codex also need an ACP adapter; throng ships none. Install only the agents you want to delegate to.

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

### 3. The MCP client

The client is the session that calls throng. It may be the same program as one of the agents above, or a different one. The server speaks stdio and the command is `node <clone>/src/mcp.ts`; the commands below assume you are in the clone directory.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add --scope user throng -- node "$(pwd)/src/mcp.ts"
```

`--scope user` registers it for every project; without it, for the current project only. `claude mcp list` shows the result.

</details>

<details>
<summary><strong>Codex</strong></summary>

```bash
codex mcp add throng -- node "$(pwd)/src/mcp.ts"
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
      "command": ["node", "/absolute/path/to/throng-mcp/src/mcp.ts"],
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
npx skills add Nodge/throng-mcp --skill throng -g -a claude-code -y
```

`-g` installs into the agent's user directory, for every project; without it, into the current project. `-a codex` or `-a opencode` for the other agents. `npx skills update` pulls later changes.

</details>

<details>
<summary><strong>By hand</strong></summary>

Copy `skills/throng` into your agent's skills directory: `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`.

</details>

Agents pick skills up at session start, so open a new session after installing.

### Check

In a new session, ask the agent to call `list_harnesses`. It starts each installed adapter without a prompt (seconds, no tokens) and lists every available harness with its models and effort levels; `unavailable` names what is missing and how to install it. If a run then fails during the handshake, the usual cause is auth: `claude auth status`, `codex login`, `opencode auth login`. More in [troubleshooting](docs/configuration.md#troubleshooting).

Before the first run, two things to know. The agent edits the directory you name, with your user's rights; throng adds no isolation and rolls nothing back. Give it only trees you would let an agent edit unattended, and give parallel writers a worktree each.

## Using throng

`agent` names harness, model and effort in one string, `<harness>/<model>[:<effort>]`:

```
claude/opus[1m]:max
codex/gpt-6-sol:xhigh
opencode/openrouter/z-ai/glm-5.3-flash
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

- `auto`, the default: each harness runs in its own auto-approve mode (Claude `auto`, Codex `agent`, OpenCode as configured); whatever that mode still asks about, throng refuses.
- `allow_all`: every request allowed, once. `deny_all`: every request refused.
- `elicit`: each request is shown to you as a dialog in the MCP client, with the one-time choices the harness offered. Needs a client with elicitation support; Claude Code has it.

throng never answers "always allow", so no rule gets written into the agent's project settings. Per-harness overrides, extra env for an adapter, timeouts and the nesting limit are in [docs/configuration.md](docs/configuration.md).

## Documentation

- [docs/configuration.md](docs/configuration.md): the config file, environment variables, permissions in detail, auth, troubleshooting.
- [DESIGN §3](docs/DESIGN.md#3-external-contract): the exact inputs, results, error codes and stop reasons of every tool.
- [skills/throng/SKILL.md](skills/throng/SKILL.md): working patterns for the calling agent.
- [docs/development.md](docs/development.md): for maintainers; tests, smoke runs against real harnesses, files on disk.
- [Nodge/skills](https://github.com/Nodge/skills): runbooks, multi-step procedures a session runs through subagents. Any step of a runbook can go to any harness through throng.

## License

MIT, see [LICENSE](LICENSE).
