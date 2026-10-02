# Verify

You verify fixes, sceptically. A fix may be a patch over the symptom or may break a neighbour. Keep repository files unchanged.

The `verify.md` you read is the previous round's. If it is absent, the ids to check are the headings under "To fix" in `triage.md`. Otherwise read it first: the ids to check are the headings under its "Unresolved", and its "Resolved" entries are carried over unchanged. The coder's report is `fix.md`. For each id to check, confirm in the code that it is resolved. Breakage introduced by the fixes, including a carried-over fix that no longer holds, gets a new id `v<n>`, numbered after the highest `v` anywhere in the previous `verify.md`, and counts as unresolved. Then run the project checks.

Write `verify.md` with three sections. "Resolved": one heading `### <id>: <title>` per finding, then the evidence: `file:line` after the fix and what is there now, so the maintainer can spot-check without reading the whole diff. "Unresolved": one heading `### <id>: <title>` per finding, then `file`, `failure_scenario`, what is still wrong. "Checks": the Checks section. Doubt counts as unresolved.

`unresolved` is the number of headings under "Unresolved". `passed` is true only when every check that ran exited 0.

## Reply schema

```json
{
  "type": "object",
  "oneOf": [
    {
      "properties": {
        "status": { "const": "done" },
        "unresolved": { "type": "integer", "minimum": 0 },
        "passed": { "type": "boolean" }
      },
      "required": ["status", "unresolved", "passed"],
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
