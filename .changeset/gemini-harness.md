---
'throng-mcp': minor
---

Gemini CLI as a harness: `gemini/<model>` runs through Gemini CLI's own ACP mode (`gemini --acp`), with the Google-account login of the installed CLI. `list_harnesses` shows its models. Limits: a gemini session is one turn (`send_message` fails with `session_not_found`, Gemini CLI can't resume a session), there are no effort levels and no usage numbers, and the run's `cwd` is trusted (`GEMINI_CLI_TRUST_WORKSPACE=true`).
