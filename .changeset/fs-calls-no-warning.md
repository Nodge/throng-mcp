---
'throng-mcp': patch
---

An agent's `fs/*` call to throng (OpenCode sends `fs/write_text_file` after an approved edit) no longer adds a warning to the result; it is still answered "method not found" and logged to stderr. `terminal/*` calls keep the warning.
