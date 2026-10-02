# Preflight

Run `git status --porcelain` in `<repo>`. Keep repository files unchanged.

Write `preflight.md`: the exit code, stdout and stderr. A non-zero exit code is `failed` with the reason.

`clean` is true when stdout is empty, or when every line of it names a path under `backlog/`: the main session edits the task's backlog file (status, plan) before every run, and `backlog/` is its own, outside what the steps review or change.

## Reply schema

```json
{
  "type": "object",
  "oneOf": [
    {
      "properties": {
        "status": { "const": "done" },
        "clean": { "type": "boolean" }
      },
      "required": ["status", "clean"],
      "additionalProperties": false
    },
    {
      "properties": {
        "status": { "enum": ["failed", "blocked"] },
        "reason": { "type": "string", "minLength": 1 }
      },
      "required": ["status", "reason"],
      "additionalProperties": false
    }
  ]
}
```
