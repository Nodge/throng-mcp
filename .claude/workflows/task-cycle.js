export const meta = {
  name: 'task-cycle',
  description: 'One throng-mcp task: coder (Opus by default) → gates → dual review (Opus + Codex) → triage → fixes',
  whenToUse: 'Run on one Backlog.md task (THRONG-n). args: { taskId, brief, gateCmd?, maxFixRounds?, coder?, repo? }. coder: "opus" (default) or "codex" — the Codex variant runs only when the maintainer asks for it explicitly, never picked on its own. repo: worktree path for parallel tasks. Codex stages run as thronglets: needs the throng MCP server connected. Changes stay in the working tree — backlog updates and commit happen outside.',
  phases: [
    { title: 'Implement', detail: 'coder implements the brief' },
    { title: 'Gates', detail: 'typecheck / tests' },
    { title: 'Review', detail: 'two independent reviews: Opus and Codex', model: 'opus' },
    { title: 'Triage', detail: 'arbitrate and dedupe findings' },
    { title: 'Fix', detail: 'coder fixes, Opus verifies with evidence', model: 'opus' },
  ],
}

// The harness may pass args as a parsed object or as a JSON string — accept both.
const input = typeof args === 'string' ? JSON.parse(args) : args

// Task working tree: the session's cwd by default, a worktree is passed via args.repo
const REPO = (input && input.repo) || 'the current working directory'
const taskId = input && input.taskId
const brief = input && input.brief
const gateCmd = (input && input.gateCmd) || 'pnpm typecheck && pnpm test'
const maxFixRounds = (input && input.maxFixRounds) != null ? input.maxFixRounds : 2
// Who writes code: native Opus subagent (default) or a Codex thronglet.
// Review, triage and verification don't depend on this choice.
const coder = (input && input.coder) || 'opus'

if (!taskId || !brief) throw new Error('args.taskId and args.brief are required')
if (coder !== 'opus' && coder !== 'codex') throw new Error(`args.coder: expected "opus" or "codex", got ${JSON.stringify(coder)}`)

// ---------- Result schemas ----------

const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'changedFiles', 'gatesPassed'],
  properties: {
    summary: { type: 'string', description: 'What was done and which decisions were made along the way' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    gatesPassed: { type: 'boolean' },
    gatesNote: { type: 'string', description: 'Gate output, or why gates are not applicable' },
    deviations: { type: 'string', description: 'Deviations from the brief, if any' },
  },
}

const GATES_SCHEMA = {
  type: 'object',
  required: ['passed'],
  properties: {
    passed: { type: 'boolean' },
    failures: { type: 'string', description: 'The relevant part of the failing commands output' },
    notApplicable: { type: 'boolean', description: 'true if the gate infrastructure does not exist yet' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'title', 'severity', 'description'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          description: { type: 'string', description: 'What is wrong, what it leads to, how to check' },
        },
      },
    },
  },
}

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['confirmed', 'rejected'],
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'Why the finding is confirmed, with a code reference' },
        },
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['resolved', 'unresolvedIds', 'gatesPassed'],
  properties: {
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'evidence'],
        properties: {
          id: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'What proves the fix: file:line after the fix and what is there now — so the process owner can recheck without rereading the whole diff',
          },
        },
      },
    },
    unresolvedIds: { type: 'array', items: { type: 'string' } },
    gatesPassed: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

// ---------- Shared prompt pieces ----------

const commonContext = `Repository: ${REPO}. Read AGENTS.md and follow it.
Task ${taskId}. Task brief:

---
${brief}
---
`

const diffInstruction = `The task's changes are NOT committed: look at \`git status\` and \`git diff\` in ${REPO}, plus new (untracked) files in full.`

// Constraints for the coder (either variant): review and commit stages run outside,
// so the agent must not run them itself.
const executorConstraints = `
Executor constraints: work yourself, directly in the working tree. Don't run workflows (task-cycle or any other),
don't spawn coder subagents, don't commit, don't touch backlog/ (tasks, statuses, notes). The project rules about
task cycles, review and the backlog lifecycle don't apply to you — those stages run outside. Leave changes in the working tree and list them in your answer.
Don't send prompts to real harnesses (claude/codex/opencode, scripts/smoke) unless the brief says so: that spends
the maintainer's tokens — use test/fake-agent. Don't register the server in the user's Claude config and don't edit ~/.claude.
The machine is a developer's laptop: no artificial load (busy loops, stress runs with dozens of processes) without the owner's
explicit permission. A flaky test gets rerun (1–2 processes), and you say plainly that the flake didn't reproduce
rather than "confirming" it under load.`

const reviewerConstraints = `
Reviewer constraints: read only — don't edit files, don't run workflows, don't spawn subagents, don't commit, don't touch backlog/.
The project rules about task cycles, review and the backlog lifecycle don't apply to you.`

// Codex runs as a thronglet through the throng MCP server (user-scope config). A workflow can only
// spawn Claude agents, so a cheap relay agent makes the blocking run_thronglet call and hands back
// its structured result.
const CODEX_AGENT = 'codex/gpt-6-sol:high'

async function thronglet(prompt, schema, opts) {
  const r = await agent(
    `You are a relay. Make exactly one call to the mcp__throng__run_thronglet tool (load it with ToolSearch "select:mcp__throng__run_thronglet") and return its result.
Do nothing else: don't read or edit files, don't check or redo the thronglet's work.
Arguments:
- agent: "${CODEX_AGENT}"
- cwd: absolute path of ${REPO} (resolve it with \`pwd\` if it is the current directory)
- schema: ${JSON.stringify(schema)}
- prompt: the text between the <prompt> tags, verbatim, without the tags
<prompt>
${prompt}

You are running as a subagent of another agent session.
</prompt>
The tool answers with JSON; the thronglet's answer is in \`structured\` → return ok: true, result: <structured>.
Tool error or no \`structured\` → ok: false, error: the code and message from the tool plus the thronglet's text, if any. Don't retry, don't invent a result.`,
    {
      ...opts,
      model: 'sonnet',
      effort: 'low',
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, error: { type: 'string' }, result: schema } },
    },
  )
  if (!r || !r.ok || !r.result) {
    log(`${opts.label}: thronglet failed — ${r ? r.error : 'relay returned nothing'}`)
    return null
  }
  return r.result
}

const coderName = coder === 'codex' ? 'Codex' : 'Opus'
const runCoder = (prompt, opts) => coder === 'codex'
  ? thronglet(prompt, IMPL_SCHEMA, opts)
  : agent(prompt, { ...opts, model: 'opus', effort: 'high', schema: IMPL_SCHEMA })

// ---------- 1. Implementation ----------

phase('Implement')
log(`Task ${taskId}: ${coderName} coder started`)

const impl = await runCoder(
  `You are the coder. ${commonContext}
Implement the task strictly per the brief. Don't go beyond it; record debatable decisions in deviations instead of silently inventing.
Before finishing, run the gates: \`${gateCmd}\` — and get them green. If the gates are not applicable (the infrastructure doesn't exist yet and creating it is not part of the task), say so explicitly in gatesNote.
Don't commit. Leave the changes in the working tree.
${executorConstraints}`,
  { label: `implement:${taskId}`, phase: 'Implement' },
)

if (!impl) throw new Error('Coder returned no result')
if (impl.changedFiles.length === 0) {
  // A coder that returned a placeholder with an empty file list would otherwise burn
  // two reviewers, triage and two fix rounds on an empty tree.
  return {
    taskId,
    coder,
    status: 'failed',
    reason: 'Coder returned no changes — nothing implemented, nothing to review',
    implementation: impl,
  }
}
log(`Implementation ready: ${impl.changedFiles.length} files`)

// ---------- 2. Independent gate check ----------

phase('Gates')

const gates = await agent(
  `Run the checks in ${REPO}: \`${gateCmd}\`. Report honestly: passed only if everything is green.
If the commands are not applicable (no package.json / scripts because the project is at an early stage) — notApplicable: true and passed: true.
Don't fix or edit anything — just run and report.`,
  { label: `gates:${taskId}`, phase: 'Gates', model: 'sonnet', effort: 'low', schema: GATES_SCHEMA },
)

if (gates && !gates.passed) {
  // One chance to fix the gates before review — reviewing red code is pointless
  log('Gates red — sending back for a fix before review')
  await runCoder(
    `You are the coder. ${commonContext}
${diffInstruction}
The checks \`${gateCmd}\` fail. Output:
${gates.failures || '(output not captured — run them yourself)'}
Fix the failures without breaking the intent of the changes. Get to green. Don't commit.
${executorConstraints}`,
    { label: `fix-gates:${taskId}`, phase: 'Gates' },
  )
  const regates = await agent(
    `Run the checks in ${REPO}: \`${gateCmd}\`. Report honestly. Don't edit anything.`,
    { label: `regates:${taskId}`, phase: 'Gates', model: 'sonnet', effort: 'low', schema: GATES_SCHEMA },
  )
  if (regates && !regates.passed) {
    return {
      taskId,
      coder,
      status: 'failed',
      reason: 'Could not get the gates green before review',
      gates: regates,
      implementation: impl,
    }
  }
}

// ---------- 3. Dual review: Opus + Codex ----------
// Deliberate barrier: triage needs both lists at once to dedupe across reviewers.

phase('Review')
log('Dual review: Opus and Codex in parallel')

const reviewPrompt = (who) => `You are an independent code reviewer (${who}). ${commonContext}
${diffInstruction}
Check the changes along four axes:
1. Conformance to the brief and to docs/DESIGN.md — check against the sections the brief references.
2. Correctness: bugs, edge cases, races, hangs, leaked or orphaned processes, lost adapter output, unhandled rejections.
3. Contracts and layering: tool input/output exactly as DESIGN §3; failures are MCP tool errors with the DESIGN §3.2 payload and an ErrorCode, never exceptions, and invalid input is a protocol error; Worker knows ACP and the process but not MCP; HarnessDefinition stays plain data plus hooks; only erasable TypeScript syntax (the code runs under node type stripping).
4. Quality: needless complexity, duplication, mismatch with the repo's style.
Only findings about this diff — don't review old code. Be honest with severity: blocker — can't commit, major — must fix, minor — can wait. If there are no findings, return an empty list; don't make things up.
${reviewerConstraints}`

const [opusReview, codexReview] = await parallel([
  () => agent(reviewPrompt('Claude/Opus perspective'), {
    label: `review-opus:${taskId}`, phase: 'Review', model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA,
  }),
  () => thronglet(reviewPrompt('Codex/GPT perspective'), FINDINGS_SCHEMA, {
    label: `review-codex:${taskId}`, phase: 'Review',
  }),
])

if (!opusReview && !codexReview) throw new Error('Both reviewers failed — cycle aborted')

const allFindings = []
for (const [source, review] of [['opus', opusReview], ['codex', codexReview]]) {
  if (!review) { log(`Reviewer ${source} returned nothing — continuing with one`); continue }
  for (const f of review.findings) {
    allFindings.push({ id: `f${allFindings.length + 1}`, source, ...f })
  }
}
log(`Findings before triage: ${allFindings.length}`)

// ---------- 4. Triage ----------

phase('Triage')

let confirmed = []
if (allFindings.length > 0) {
  const triage = await agent(
    `You are the code review arbiter. ${commonContext}
${diffInstruction}
Two independent reviewers returned findings (source names the author):
${JSON.stringify(allFindings, null, 2)}
For each finding: check it against the actual code (don't take it on faith), merge duplicates (confirm one id, reject the other with reason "duplicate of <id>"), reject matters of taste and false positives. Minor findings that don't affect correctness get rejected with the note "deferred" — the process owner will pick them up from the report.
Every id must land in either confirmed or rejected.`,
    { label: `triage:${taskId}`, phase: 'Triage', effort: 'high', schema: TRIAGE_SCHEMA },
  )
  if (!triage) throw new Error('Triage failed')
  const byId = Object.fromEntries(allFindings.map((f) => [f.id, f]))
  confirmed = triage.confirmed.map((c) => ({ ...byId[c.id], reason: c.reason })).filter((f) => f.file)
  log(`Confirmed: ${confirmed.length}, rejected: ${triage.rejected.length}`)
}

// ---------- 5. Fix loop ----------

phase('Fix')

let remaining = confirmed
let round = 0
// What exactly was declared fixed and what proves it — goes into the report for the owner's spot check
const resolvedLog = []
while (remaining.length > 0 && round < maxFixRounds) {
  round++
  log(`Fix round ${round}/${maxFixRounds}: ${remaining.length} findings`)

  await runCoder(
    `You are the coder. ${commonContext}
${diffInstruction}
Review confirmed these findings — fix each one:
${JSON.stringify(remaining, null, 2)}
Fix the substance, not with patches. If you think a finding can't be fixed without going beyond the brief, leave it and explain in summary. After fixing, run the gates: \`${gateCmd}\`. Don't commit.
${executorConstraints}`,
    { label: `fix-r${round}:${taskId}`, phase: 'Fix' },
  )

  const verify = await agent(
    `You are the fix verifier. ${commonContext}
${diffInstruction}
Check against the code that each of these findings is actually resolved (be skeptical — the fix may be a patch or may have broken something nearby):
${JSON.stringify(remaining, null, 2)}
Then run the gates: \`${gateCmd}\`. Don't edit anything.
Every id must land in either resolved (with evidence: file:line after the fix and what is there now) or unresolvedIds. Don't declare a finding resolved if you can't point at a concrete place in the code — doubt counts as unresolved.`,
    { label: `verify-r${round}:${taskId}`, phase: 'Fix', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA },
  )
  if (!verify) throw new Error('Verifier failed')

  // Fail-closed: only what is explicitly declared resolved with evidence leaves remaining;
  // a finding the verifier kept silent about stays in work instead of vanishing from the report
  const unresolvedIds = new Set(verify.unresolvedIds)
  const byId = Object.fromEntries(remaining.map((f) => [f.id, f]))
  const resolvedIds = new Set()
  for (const r of verify.resolved) {
    const f = byId[r.id]
    if (!f || unresolvedIds.has(r.id) || resolvedIds.has(r.id)) continue
    resolvedIds.add(r.id)
    resolvedLog.push({ id: f.id, file: f.file, title: f.title, severity: f.severity, evidence: r.evidence })
  }
  remaining = remaining.filter((f) => !resolvedIds.has(f.id))
  log(`Round ${round}: resolved ${resolvedIds.size}, remaining ${remaining.length}`)
  if (!verify.gatesPassed) {
    log('Gates red after fixes — another round')
    if (remaining.length === 0) remaining = [{ id: 'gates', file: '(gates)', title: 'Gates red after fixes', severity: 'blocker', description: verify.notes || `Command: ${gateCmd}` }]
  }
}

// ---------- Result ----------

const blockers = remaining.filter((f) => f.severity === 'blocker')
return {
  taskId,
  coder,
  status: blockers.length > 0 ? 'needs_attention' : 'ready_for_commit',
  implementation: { summary: impl.summary, changedFiles: impl.changedFiles, deviations: impl.deviations || null },
  review: {
    total: allFindings.length,
    confirmed: confirmed.length,
    fixed: resolvedLog,
    remaining,
  },
  fixRounds: round,
  next: blockers.length > 0
    ? 'Unresolved blockers — sort them out by hand before committing'
    : 'Changes are in the working tree: spot-check fixed[].evidence → backlog finalization (AC, DoD, notes, final summary, Done) → commit',
}
