# Preflight

Run `git status --porcelain` in `<repo>`. Keep repository files unchanged.

Write `<run>/preflight.md`: the exit code, stdout and stderr. A non-zero exit code is `failed` with the reason.

`clean` is true when stdout is empty.

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
