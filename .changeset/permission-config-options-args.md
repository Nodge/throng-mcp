---
'throng-mcp': patch
---

A harness definition can now express the permission policy through `session/set_config_option` and extra launch args, next to the session mode and env. The built-in harnesses (claude, codex, opencode) behave as before; this prepares agents such as Copilot CLI and Cursor that switch auto-approval this way.
