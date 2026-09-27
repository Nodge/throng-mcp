---
id: decision-3
title: 'Adapters are installed by the user, not shipped as dependencies'
date: '2026-09-27 19:17'
status: accepted
---
## Context

decision-1 kept `claude-agent-acp` and `codex-acp` as exact-pinned dependencies of throng-mcp, with their harness platform packages excluded via `pnpm-workspace.yaml`. That ties adapter upgrades to our releases and keeps a hand-maintained list of 14 platform package names.

Checked 2026-09-27: `data/registry.json` has `distribution.npx.package` with the version for `claude-acp` (`@agentclientprotocol/claude-agent-acp@0.81.2`) and `codex-acp` (`@agentclientprotocol/codex-acp@1.13.1`). The optional deps of `@anthropic-ai/claude-agent-sdk` and `@openai/codex` are exactly the platform packages, so `npm i -g --omit=optional` skips them.

## Decision

Made by the maintainer (nodge), 2026-09-27. Supersedes decision-1.

- throng-mcp depends on no adapter. The user installs `claude-agent-acp`, `codex-acp` and `opencode`; throng resolves the adapter command on PATH (or from config).
- Availability = the adapter command exists. Missing → `unavailable.reason` / `harness_unavailable` with the install command taken from the registry snapshot (`npm i -g <npx.package>`); OpenCode gets a fixed pointer to its install docs.
- The harness binary is optional: if `claude`/`codex` is on PATH, throng sets `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` to it (config wins); otherwise the adapter uses its bundled binary. The `list_harnesses` probe is the only real health check.
- `list_harnesses` reports the adapter version from `initialize.agentInfo.version`, since versions now drift per machine.

DESIGN §2.3, §3.2, §3.4, §4.1, §9 updated in the same change.

## Consequences

- No `pnpm-workspace.yaml` exclusion list, no adapter pins; the install is just the MCP/ACP SDKs.
- decision-1's spike results still hold and back the README advice: with the harness on PATH the adapters run without platform packages, so `--omit=optional` is safe there.
- Adapter version drift is on the user; smoke (THRONG-5) records which versions were tested, and `list_harnesses` shows what is actually installed.
- `run_thronglet` adds a PATH check before spawn so a missing adapter is `harness_unavailable`, not `spawn_failed`.
