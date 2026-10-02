# Checks

Run the project checks in `<repo>`. Keep repository files unchanged.

Write `<run>/checks.md` with the Checks section only.

`passed` is true only when every check that exists ran and exited 0. Skipped checks do not count against it. A check that exists but could not run makes it false.

## Reply schema

```json
{
  "type": "object",
  "oneOf": [
    {
      "properties": {
        "status": { "const": "done" },
        "passed": { "type": "boolean" }
      },
      "required": ["status", "passed"],
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
