---
'throng-mcp': minor
---

`send_message` to a session whose harness can't resume (Gemini CLI) is refused with `session_not_found` before anything runs: no adapter process is started, and `steer: true` no longer cancels the running turn first. The session record remembers what the adapter advertised when the session was created; sessions created by an earlier version fail at the next turn's handshake as before. `list_thronglets` shows such a session with the new field `accepts_messages: false`.
