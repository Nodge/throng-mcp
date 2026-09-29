---
id: decision-4
title: Policy auto answers permission requests with reject_once
date: '2026-09-29 13:50'
status: accepted
---
## Context

## Context

DESIGN §5 had policy `auto` = the harness's native auto mode plus `allow_once` to every `request_permission` the harness still raised. Smoke on real harnesses showed how often the native mode falls short of "auto": Claude Code has no auto mode for some models (haiku falls back to `acceptEdits`, so every non-edit action would be a request), Codex's `agent` mode asks about anything "potentially unsafe". With `allow_once` as the answer, `auto` silently degrades into `allow_all` on exactly those harnesses.

## Decision

Made by the maintainer (nodge), 2026-09-29. `auto` answers `request_permission` with `reject_once` (picked by kind; `cancelled` when the agent offers none). The harness's own auto mode is the only thing that grants anything; the server never widens it. `allow_all` stays a separate, explicit policy (v2). DESIGN §5 updated in the same commit; `permissions.ts` `decideAuto` became `decideReject`, shared with `deny_all` later.

## Consequences

- Under `auto` a harness that keeps asking gets refused and must work within what its auto mode approves; the run may end with a partial result and the agent's own explanation in `text`. Transcripts record every decision.
- claude/haiku (acceptEdits fallback): edits allowed, shell commands the classifier does not auto-approve are rejected.
- Anyone who wants "approve everything" must set `permissions: allow_all` once v2 ships it; nothing in v1 grants it.
