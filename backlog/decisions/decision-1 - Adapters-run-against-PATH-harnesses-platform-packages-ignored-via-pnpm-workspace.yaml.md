---
id: decision-1
title: >-
  Adapters run against PATH harnesses; platform packages ignored via
  pnpm-workspace.yaml
date: '2026-09-27 19:07'
status: superseded
---
## Context

DESIGN §4.1 assumed, unverified, that `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` start without their bundled harness platform packages (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`, `@openai/codex-<os>-<arch>`) when pointed at the installed harnesses via `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`. Fallback was to keep the 217 MB package.

Spike (2026-09-27, Fable, THRONG-1): scratch project with the three pinned adapters; ACP client does `initialize` + `session/new` in a temp dir, no prompt.

- `pnpm.ignoredOptionalDependencies` in `package.json` is silently ignored by pnpm 11.10: both platform packages landed in `node_modules/.pnpm`, 576 MB. The same list in `pnpm-workspace.yaml` works: 58 MB, no platform packages.
- `claude-agent-acp` 0.81.2 + `CLAUDE_CODE_EXECUTABLE=$(which claude)` (2.1.282): handshake + session in 1.0 s. `claudeCliPath()` returns the env value before touching the platform package.
- `codex-acp` 1.13.1 + `CODEX_PATH=$(which codex)` (0.156.1): 3.8 s.
- `opencode acp` 1.18.30: 1.9 s.
- All three return `configOptions` with `category: 'model'` (claude 5 values, codex 7, opencode 411) and, for claude and codex, `category: 'thought_level'`. OpenCode has no effort option, only `model` and `mode` (build/plan).

## Decision

Keep the DESIGN §4.1 layout: adapters as pinned dependencies, harness binaries from PATH, platform packages excluded. The exclusion list lives in `pnpm-workspace.yaml` (`ignoredOptionalDependencies`), not in `package.json`. DESIGN §4.1/§9 updated accordingly.

## Consequences

- Install stays ~60 MB; no second copy of Claude Code or codex.
- The adapters require the env overrides at spawn time: missing `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` throws "native binary not found" inside the adapter. Harness definitions must always set them.
- Standalone `claude` on the maintainer's machine is not logged in (`claude auth status` → `loggedIn: false`); the nested harness needs auth via `harnesses.claude.env` in the throng config (e.g. `CLAUDE_CODE_OAUTH_TOKEN`). Goes into the README task (THRONG-5).

Superseded by decision-3 (adapters are installed by the user). The spike results above still hold.
