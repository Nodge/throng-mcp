# Fix the checks

The project checks fail. Their output is in `<run>/checks.md`. Make one attempt: fix the failures inside the brief's scope, without changing what the task's changes mean, then run the checks once more. Whether they pass is decided by the next step, not by you.

Write `<run>/fix-checks.md`: what you changed and why, or why nothing inside the brief's scope fixes the failures, and the Checks section.

`fixed` is true when you changed something that addresses the failures. If no fix inside the brief's scope exists, change nothing and reply `fixed: false`.

## Reply schema

```json
{
  "type": "object",
  "oneOf": [
    {
      "properties": {
        "status": { "const": "done" },
        "fixed": { "type": "boolean" }
      },
      "required": ["status", "fixed"],
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
