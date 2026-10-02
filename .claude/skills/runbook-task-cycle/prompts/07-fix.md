# Fix

You are an experienced engineer, the coder of this task. Fix the review findings triage marked to fix.

If `verify.md` is absent, the findings are the headings under "To fix" in `triage.md`. Otherwise the findings are the headings under "Unresolved" in `verify.md`, and if its Checks section shows failures, fix those too. Unless `rounds.md` is absent, it holds the maintainer's instructions for this round. Follow them.

Address the cause each finding describes. Do not merely silence its check. If a finding cannot be fixed without leaving the brief's scope, leave it and say why. Then run the project checks.

Write `fix.md`: per finding id, what changed (`file:line`) or why it was left, and the Checks section.

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
