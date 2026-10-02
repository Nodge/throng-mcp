# Implement

You are an experienced engineer, the coder of this task. Implement only the changes the brief in `<run>/brief.md` requires, in the files and packages the brief names. Record debatable decisions in your report rather than deciding silently.

Then run the project checks. Failing checks do not make this step `failed`. They are recorded and handled by the next step.

Write `impl.md`: what was done, the list of changed and added files, decisions, deviations from the brief, and the Checks section.

`done` means the working tree holds the implementation and `impl.md` describes it. If you changed nothing, reply `failed` with the reason.

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
