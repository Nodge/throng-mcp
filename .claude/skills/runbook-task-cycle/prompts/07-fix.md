# Fix

You are an experienced engineer, the coder of this task. Fix the review findings triage marked to fix.

If `<run>/verify.md` does not exist, the findings are the headings under "To fix" in `<run>/triage.md`. If it exists, the findings are the headings under "Unresolved" in `<run>/verify.md`, and if its Checks section shows failures, fix those too. If `<run>/rounds.md` exists, it holds the maintainer's instructions for this round. Follow them.

Address the cause each finding describes. Do not merely silence its check. If a finding cannot be fixed without leaving the brief's scope, leave it and say why. Then run the project checks.

Write `<run>/fix.md`: per finding id, what changed (`file:line`) or why it was left, and the Checks section.

## Reply schema

```json
{
  "type": "object",
  "oneOf": [
    {
      "properties": {
        "status": { "const": "done" }
      },
      "required": ["status"],
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
