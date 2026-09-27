---
id: decision-2
title: >-
  Tool results are one JSON text block; Claude Code replaces content with
  structuredContent
date: '2026-09-27 19:07'
status: accepted
---
## Context

DESIGN §3.2 returns tool results as a single JSON text block in `content[0].text`, no `structuredContent` and no `outputSchema`. Open question from THRONG-1: what does Claude Code actually feed the model when an MCP tool returns `structuredContent`?

Spike (2026-09-27, Fable): a throwaway stdio MCP server (`@modelcontextprotocol/sdk` 1.30, `registerTool` with `outputSchema`) with two tools: `probe_both` returns `content: [text "TEXT_MARKER_ALPHA_7731"]` plus `structuredContent: {marker: "STRUCT_MARKER_BRAVO_9942", n: 42}`; `probe_struct_only` returns `content: []` plus `structuredContent` only. Called from `claude -p --model haiku --mcp-config … --strict-mcp-config --output-format stream-json --verbose` (Claude Code 2.1.282, one call, $0.03) and the `tool_result` blocks sent to the model were read from the stream.

Result: in both cases the model received exactly the serialized `structuredContent` as the `tool_result` content string: `{"marker":"STRUCT_MARKER_BRAVO_9942","n":42}` and `{"marker":"STRUCT_ONLY_MARKER_CHARLIE_5518"}`. The text block `TEXT_MARKER_ALPHA_7731` never reached the model. So Claude Code does forward `structuredContent`, and when present it replaces `content` entirely.

## Decision

Keep DESIGN §3.2 as is: success and failure payloads are one JSON text block in `content[0].text`; the server never sets `structuredContent` or `outputSchema`.

## Consequences

- Any human-readable text we might add to `content` alongside `structuredContent` would be invisible to the calling model in Claude Code; a single text block is the only shape that behaves the same in every client.
- No `outputSchema` means the MCP SDK does not validate our output; the payload shape is enforced by TypeScript types in `src/contract.ts`.
