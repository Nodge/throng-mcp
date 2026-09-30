import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { loadConfig, type LoadedConfig } from '../src/config.ts';
import type { RunFailure, RunSuccess } from '../src/contract.ts';
import { createProgress, noProgress, type Progress, type ProgressNotification } from '../src/progress.ts';
import { EXECUTOR_PREFIX } from '../src/prompt.ts';
import { type RunContext, type RunOutcome, resumeThronglet, runThronglet } from '../src/run.ts';
import { Semaphore } from '../src/semaphore.ts';
import { type SessionRecord, writeSessionRecord } from '../src/sessions.ts';
import type { FakeScenario } from './fake-agent/index.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-run-'));
const fakeAgent = fileURLToPath(new URL('./fake-agent/agent.ts', import.meta.url));
// PATH for the adapter lookup: only `node`, so no real adapter or harness binary is ever found.
const bin = join(root, 'bin');
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));
const env = { PATH: bin };
const work = join(root, 'work');
mkdirSync(work);

const tags: string[] = [];
after(() => {
  for (const tag of tags) {
    try {
      execFileSync('pkill', ['-9', '-f', tag]);
    } catch {
      // nothing matched
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function tagAlive(tag: string): boolean {
  try {
    execFileSync('pgrep', ['-f', tag]);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function loadYaml(yaml: string): LoadedConfig {
  const path = join(root, `config-${randomUUID()}.yaml`);
  writeFileSync(path, yaml);
  return loadConfig({ THRONG_MCP_CONFIG: path });
}

/** Config whose `claude` harness is the fake agent in `scenario`; `agentEnv` is added to the adapter's env. */
function fakeClaude(scenario: FakeScenario, extra = '', agentEnv: Record<string, string> = {}): { loaded: LoadedConfig; tag: string } {
  const tag = `fake-agent-${randomUUID()}`;
  tags.push(tag);
  const loaded = loadYaml(
    [
      'harnesses:',
      '  claude:',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
      `    env: ${JSON.stringify({ FAKE_SCENARIO: scenario, ...agentEnv })}`,
      extra,
      '',
    ].join('\n'),
  );
  assert.equal(loaded.error, undefined, loaded.error);
  return { loaded, tag };
}

function makeCtx(loaded: LoadedConfig, overrides: Partial<RunContext> = {}): RunContext {
  return {
    loaded,
    depth: 0,
    semaphore: new Semaphore(10),
    signal: new AbortController().signal,
    progress: noProgress,
    env,
    cacheDir: mkdtempSync(join(root, 'cache-')),
    cancelGraceMs: 1000,
    exitGraceMs: 300,
    ...overrides,
  };
}

function ok(outcome: RunOutcome): RunSuccess {
  assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome.payload)}`);
  return outcome.payload as RunSuccess;
}

function failed(outcome: RunOutcome, code: RunFailure['code']): RunFailure {
  assert.equal(outcome.ok, false, `expected failure, got ${JSON.stringify(outcome.payload)}`);
  const payload = outcome.payload as RunFailure;
  assert.equal(payload.code, code, payload.message);
  assert.equal(typeof payload.duration_s, 'number');
  return payload;
}

interface RecordingProgress extends Progress {
  calls: string[];
}

function recordingProgress(): RecordingProgress {
  const calls: string[] = [];
  return {
    calls,
    queued: (n) => calls.push(`queued ${n}`),
    started: () => calls.push('started'),
    tool: (title) => calls.push(`tool ${title}`),
    text: () => calls.push('text'),
    done: () => calls.push('done'),
    idle: () => Promise.resolve(),
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const input = (agent: string, extra: Record<string, unknown> = {}) => ({ agent, prompt: 'do the thing', cwd: work, ...extra });

describe('runThronglet', () => {
  it('echo: success payload, session record, transcript', async () => {
    const { loaded, tag } = fakeClaude('echo');
    const ctx = makeCtx(loaded);
    const payload = ok(await runThronglet(input('claude/fake-small'), ctx));
    assert.ok(payload.text?.startsWith('echo: '), payload.text);
    assert.ok(payload.text?.includes('do the thing'));
    const firstSentence = EXECUTOR_PREFIX.slice(0, EXECUTOR_PREFIX.indexOf('.') + 1);
    assert.ok(payload.text?.includes(firstSentence), 'executor prefix missing');
    assert.match(payload.text ?? '', /\[model=fake-small effort=low\]$/);
    assert.equal(payload.stop_reason, 'end_turn');
    assert.deepEqual(payload.usage, { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 });
    assert.equal(typeof payload.duration_s, 'number');
    assert.equal(payload.warnings, undefined);
    assert.ok(payload.session_id.startsWith('fake-'));
    assert.equal(tagAlive(tag), false, 'adapter still running');

    const record = JSON.parse(readFileSync(join(ctx.cacheDir, 'sessions', `${payload.session_id}.json`), 'utf8'));
    assert.equal(record.harness, 'claude');
    assert.equal(record.model, 'fake-small');
    assert.equal(record.cwd, work);
    assert.equal(record.effort, undefined);
    assert.ok(Date.parse(record.created_at) <= Date.parse(record.last_used_at));

    const runs = readdirSync(join(ctx.cacheDir, 'runs'));
    assert.equal(runs.length, 1);
    assert.match(runs[0]!, new RegExp(`-claude-${payload.session_id}\\.jsonl$`));
    const lines = readJsonl(join(ctx.cacheDir, 'runs', runs[0]!));
    const inputLine = lines.find((l) => l.kind === 'input')!;
    assert.deepEqual(
      { agent: inputLine.agent, cwd: inputLine.cwd, prompt_chars: inputLine.prompt_chars, prompt: inputLine.prompt },
      { agent: 'claude/fake-small', cwd: work, prompt_chars: 12, prompt: undefined },
    );
    assert.ok(!JSON.stringify(inputLine).includes('do the thing'));
    assert.ok(lines.some((l) => l.kind === 'update'));
    const outcome = lines.at(-1)!;
    assert.equal(outcome.kind, 'outcome');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, undefined);
    assert.equal(outcome.session_id, payload.session_id);
  });

  it('model and effort from the agent spec', async () => {
    const { loaded } = fakeClaude('echo');
    const large = ok(await runThronglet(input('claude/fake-large:high'), makeCtx(loaded)));
    assert.match(large.text ?? '', /\[model=fake-large effort=high\]$/);

    const max = ok(await runThronglet(input('claude/fake-small:max'), makeCtx(loaded)));
    assert.ok(max.warnings?.some((w) => w.includes('"max"')), JSON.stringify(max.warnings));

    const nope = failed(await runThronglet(input('claude/nope'), makeCtx(loaded)), 'model_rejected');
    assert.match(nope.message, /fake-small, fake-large/);
    assert.ok(nope.session_id?.startsWith('fake-'));
  });

  it('schema is accepted and ignored with a warning', async () => {
    const { loaded } = fakeClaude('echo');
    const payload = ok(await runThronglet(input('claude/fake-small', { schema: { type: 'object' } }), makeCtx(loaded)));
    assert.deepEqual(payload.warnings, ['schema is not supported yet (v2); ignored']);
  });

  it('unknown harness → harness_unavailable', async () => {
    const { loaded } = fakeClaude('echo');
    const payload = failed(await runThronglet(input('gemini/x'), makeCtx(loaded)), 'harness_unavailable');
    assert.equal(payload.session_id, undefined);
  });

  it('adapter missing → harness_unavailable with the install hint, before spawn', async () => {
    const payload = failed(await runThronglet(input('claude/opus'), makeCtx(loadYaml(''))), 'harness_unavailable');
    assert.match(payload.message, /claude-agent-acp not found on PATH; install: npm i -g @agentclientprotocol\/claude-agent-acp/);
  });

  it('depth guard', async () => {
    const { loaded, tag } = fakeClaude('echo', 'limits: { max_depth: 2 }');
    const payload = failed(await runThronglet(input('claude/fake-small'), makeCtx(loaded, { depth: 2 })), 'depth_exceeded');
    assert.match(payload.message, /depth 3.*max_depth is 2/);
    assert.equal(tagAlive(tag), false);
  });

  it('config error and unsupported policy refuse to run', async () => {
    const broken = failed(await runThronglet(input('claude/fake-small'), makeCtx(loadYaml('limits: [\n'))), 'harness_unavailable');
    assert.ok(broken.message.startsWith('config error:'), broken.message);

    const { loaded } = fakeClaude('echo', 'permissions: deny_all');
    const policy = failed(await runThronglet(input('claude/fake-small'), makeCtx(loaded)), 'harness_unavailable');
    assert.match(policy.message, /permissions "deny_all" is not supported yet/);
  });

  it('timeout → timeout with session_id, adapter gone', async () => {
    const { loaded, tag } = fakeClaude('hang');
    const started = Date.now();
    const payload = failed(await runThronglet(input('claude/fake-small', { timeout_s: 1 }), makeCtx(loaded)), 'timeout');
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
    assert.ok(payload.session_id);
    assert.equal(tagAlive(tag), false, 'adapter still running');
  });

  it('client cancel → cancelled, adapter gone', async () => {
    const { loaded, tag } = fakeClaude('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const payload = failed(await runThronglet(input('claude/fake-small'), makeCtx(loaded, { signal: controller.signal })), 'cancelled');
    assert.ok(payload.session_id);
    assert.deepEqual(payload.usage, {}, 'cancelled turn without usage');
    assert.equal(tagAlive(tag), false, 'adapter still running');
  });

  it('adapter crash mid-prompt → transport_lost with stderr', async () => {
    const { loaded, tag } = fakeClaude('crash-on-prompt');
    const payload = failed(await runThronglet(input('claude/fake-small'), makeCtx(loaded)), 'transport_lost');
    assert.match(payload.message, /boom/);
    assert.ok(payload.session_id);
    assert.equal(tagAlive(tag), false);
  });

  it('stop reasons: empty_result, refusal, max_turn_requests', async () => {
    const empty = failed(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('empty').loaded)), 'empty_result');
    assert.ok(empty.session_id);
    assert.deepEqual(empty.usage, { input_tokens: 10, output_tokens: 5 });

    const refusal = failed(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('refuse').loaded)), 'refusal');
    assert.equal(refusal.text, 'I will not do that.');

    const maxTurns = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('max-turns').loaded)));
    assert.equal(maxTurns.stop_reason, 'max_turn_requests');
    assert.ok(maxTurns.text?.startsWith('echo: '));
  });

  it('adapter notices become warnings', async () => {
    const payload = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('notice').loaded)));
    assert.deepEqual(payload.warnings, ['warning: fake notice — mode fell back']);
  });

  it('auto: a request_permission the harness still raises is rejected', async () => {
    const payload = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('permission').loaded)));
    assert.equal(payload.text, 'rejected');
  });

  it('a permission-mode fallback announced by the agent lands in warnings, not in text', async () => {
    const payload = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('mode-fallback').loaded)));
    assert.ok(payload.text?.startsWith('echo: '), payload.text);
    assert.deepEqual(payload.warnings, [
      'permission mode "auto" not applied: the agent switched to "ask"',
      'agent message before the task: Auto mode unavailable; using Ask instead.',
    ]);
  });

  it('semaphore: the second call queues, cancel while queued and while running', async () => {
    const { loaded, tag } = fakeClaude('hang', 'limits: { max_concurrency: 1 }');
    const semaphore = new Semaphore(loaded.config.limits.max_concurrency);
    const first = new AbortController();
    const second = new AbortController();
    const secondProgress = recordingProgress();
    const firstCtx = makeCtx(loaded, { semaphore, signal: first.signal });
    const running = runThronglet(input('claude/fake-small'), firstCtx);
    const queued = runThronglet(
      input('claude/fake-small'),
      makeCtx(loaded, { semaphore, signal: second.signal, progress: secondProgress }),
    );
    await waitFor('first session', () => readdirSync(firstCtx.cacheDir).includes('sessions'));
    assert.deepEqual(secondProgress.calls, ['queued 1']);
    assert.equal(semaphore.waiting, 1);
    second.abort();
    const queuedPayload = failed(await queued, 'cancelled');
    assert.equal(queuedPayload.session_id, undefined);
    assert.deepEqual(secondProgress.calls, ['queued 1', 'done']);
    first.abort();
    failed(await running, 'cancelled');
    assert.equal(tagAlive(tag), false);
    assert.equal(semaphore.waiting, 0);
    (await semaphore.acquire())();
  });

  it('cancel during the handshake answers at once; the slot is held until the adapter is gone', async () => {
    const { loaded, tag } = fakeClaude('handshake-hang', 'limits: { handshake_s: 1 }');
    const semaphore = new Semaphore(1);
    const controller = new AbortController();
    const call = runThronglet(input('claude/fake-small'), makeCtx(loaded, { semaphore, signal: controller.signal }));
    await waitFor('adapter', () => tagAlive(tag));
    const started = Date.now();
    controller.abort();
    const payload = failed(await call, 'cancelled');
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
    assert.equal(payload.session_id, undefined);
    let granted = false;
    const next = semaphore.acquire().then((release) => ((granted = true), release));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(granted, false, 'slot released while the adapter was still up');
    (await next)();
    assert.equal(tagAlive(tag), false, 'adapter still running');
  });

  it('missing cwd → spawn_failed before spawn', async () => {
    const { loaded } = fakeClaude('echo');
    const payload = failed(await runThronglet(input('claude/fake-small', { cwd: join(root, 'nope') }), makeCtx(loaded)), 'spawn_failed');
    assert.match(payload.message, /cwd does not exist or is not a directory/);
  });

  it('progress: tool titles and text on echo, heartbeat on a long run', async () => {
    const sent: string[] = [];
    const extra = {
      _meta: { progressToken: 'p' },
      sendNotification: async (n: ProgressNotification) => void sent.push(n.params.message ?? ''),
    };
    ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('echo').loaded, { progress: createProgress(extra) })));
    assert.ok(sent.includes('read README.md'), JSON.stringify(sent));
    assert.ok(sent.some((m) => m.startsWith('agent is writing…')), JSON.stringify(sent));

    sent.length = 0;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const progress = createProgress(extra, { heartbeatMs: 30 });
    failed(
      await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('hang').loaded, { progress, signal: controller.signal })),
      'cancelled',
    );
    assert.ok(sent.some((m) => /^running 0m0\ds$/.test(m)), JSON.stringify(sent));
  });
});

describe('resumeThronglet', () => {
  /** Writes a session record by hand, as a run_thronglet call would have. */
  async function record(ctx: RunContext, sessionId: string, fields: Partial<SessionRecord> = {}): Promise<void> {
    const at = new Date().toISOString();
    const base: SessionRecord = { harness: 'claude', model: 'fake-small', cwd: work, created_at: at, last_used_at: at };
    await writeSessionRecord(ctx.cacheDir, sessionId, { ...base, ...fields });
  }

  it('follow-up into the same session: memory kept, model and effort re-applied from the record', async () => {
    const { loaded, tag } = fakeClaude('resume-memory', '', { FAKE_MEMORY_DIR: mkdtempSync(join(root, 'memory-')) });
    const ctx = makeCtx(loaded);
    const first = ok(await runThronglet(input('claude/fake-large:high', { prompt: 'remember: banana' }), ctx));
    assert.equal(first.text, 'noted [model=fake-large effort=high]');
    const recordPath = join(ctx.cacheDir, 'sessions', `${first.session_id}.json`);
    const before = JSON.parse(readFileSync(recordPath, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = ok(await resumeThronglet({ session_id: first.session_id, prompt: 'what did I say?' }, ctx));
    assert.equal(second.session_id, first.session_id);
    assert.equal(second.text, 'you said: remember: banana [model=fake-large effort=high]');
    assert.equal(second.stop_reason, 'end_turn');
    assert.deepEqual(second.usage, { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 });
    assert.equal(second.warnings, undefined);
    assert.equal(tagAlive(tag), false, 'adapter still running');

    const after = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(after.created_at, before.created_at);
    assert.ok(Date.parse(after.last_used_at) > Date.parse(before.last_used_at), `${before.last_used_at} → ${after.last_used_at}`);
    assert.deepEqual({ ...after, last_used_at: undefined }, { ...before, last_used_at: undefined });

    const runs = readdirSync(join(ctx.cacheDir, 'runs'));
    assert.equal(runs.length, 2);
    for (const name of runs) assert.match(name, new RegExp(`-claude-${first.session_id}\\.jsonl$`));
    const inputs = runs.map((name) => readJsonl(join(ctx.cacheDir, 'runs', name)).find((l) => l.kind === 'input')!);
    const resumed = inputs.find((l) => l.resume === true)!;
    assert.ok(resumed, JSON.stringify(inputs));
    const { ts: _ts, ...line } = resumed;
    assert.deepEqual(line, { kind: 'input', resume: true, session_id: first.session_id, harness: 'claude', prompt_chars: 15 });
  });

  it('unknown or unsafe id → session_not_found before spawn', async () => {
    const { loaded, tag } = fakeClaude('resume-memory');
    const ctx = makeCtx(loaded);
    const unknown = failed(await resumeThronglet({ session_id: 'fake-nope', prompt: 'x' }, ctx), 'session_not_found');
    assert.match(unknown.message, /^no session record for "fake-nope" \(records live 14 days under .*\/sessions\)$/);
    assert.equal(unknown.session_id, undefined);
    const unsafe = failed(await resumeThronglet({ session_id: '../etc', prompt: 'x' }, ctx), 'session_not_found');
    assert.match(unsafe.message, /no session record for "\.\.\/etc"/);
    assert.equal(tagAlive(tag), false);
    assert.deepEqual(readdirSync(ctx.cacheDir), [], 'nothing written for a call that never started');
  });

  it('corrupt record → session_not_found', async () => {
    const { loaded } = fakeClaude('echo');
    const ctx = makeCtx(loaded);
    mkdirSync(join(ctx.cacheDir, 'sessions'));
    writeFileSync(join(ctx.cacheDir, 'sessions', 'fake-bad.json'), JSON.stringify({ harness: 'gemini', model: 'x', cwd: work }));
    writeFileSync(join(ctx.cacheDir, 'sessions', 'fake-junk.json'), '{');
    assert.match(failed(await resumeThronglet({ session_id: 'fake-bad', prompt: 'x' }, ctx), 'session_not_found').message, /corrupt/);
    assert.match(failed(await resumeThronglet({ session_id: 'fake-junk', prompt: 'x' }, ctx), 'session_not_found').message, /unreadable/);
  });

  it('harness without resume capability → session_not_found', async () => {
    const { loaded, tag } = fakeClaude('no-resume');
    const ctx = makeCtx(loaded);
    await record(ctx, 'fake-a');
    const payload = failed(await resumeThronglet({ session_id: 'fake-a', prompt: 'x' }, ctx), 'session_not_found');
    assert.match(payload.message, /session\/resume/);
    assert.equal(tagAlive(tag), false);
  });

  it('adapter rejects the id → session_not_found with its message', async () => {
    const { loaded, tag } = fakeClaude('resume-memory', '', { FAKE_MEMORY_DIR: mkdtempSync(join(root, 'memory-')) });
    const ctx = makeCtx(loaded);
    await record(ctx, 'fake-forgotten');
    const payload = failed(await resumeThronglet({ session_id: 'fake-forgotten', prompt: 'x' }, ctx), 'session_not_found');
    assert.match(payload.message, /unknown session fake-forgotten/);
    assert.equal(tagAlive(tag), false);
  });

  it('adapter missing → harness_unavailable; record cwd gone → spawn_failed', async () => {
    const { loaded } = fakeClaude('echo');
    const ctx = makeCtx(loaded);
    await record(ctx, 'codex-a', { harness: 'codex', model: 'gpt' });
    const codex = failed(await resumeThronglet({ session_id: 'codex-a', prompt: 'x' }, ctx), 'harness_unavailable');
    assert.match(codex.message, /codex-acp not found on PATH; install: npm i -g @agentclientprotocol\/codex-acp/);

    const gone = join(root, `gone-${randomUUID()}`);
    mkdirSync(gone);
    await record(ctx, 'fake-gone', { cwd: gone });
    rmSync(gone, { recursive: true });
    const spawn = failed(await resumeThronglet({ session_id: 'fake-gone', prompt: 'x' }, ctx), 'spawn_failed');
    assert.ok(spawn.message.includes(gone), spawn.message);
  });

  it('timeout → timeout with the session_id, adapter gone', async () => {
    const { loaded, tag } = fakeClaude('hang');
    const ctx = makeCtx(loaded);
    await record(ctx, 'fake-hang');
    const started = Date.now();
    const payload = failed(await resumeThronglet({ session_id: 'fake-hang', prompt: 'x', timeout_s: 1 }, ctx), 'timeout');
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
    assert.equal(payload.session_id, 'fake-hang');
    assert.equal(tagAlive(tag), false, 'adapter still running');
  });

  it('the guards of a new run apply: unsupported policy, depth', async () => {
    const denied = fakeClaude('echo', 'permissions: deny_all');
    const deniedCtx = makeCtx(denied.loaded);
    await record(deniedCtx, 'fake-a');
    const policy = failed(await resumeThronglet({ session_id: 'fake-a', prompt: 'x' }, deniedCtx), 'harness_unavailable');
    assert.match(policy.message, /permissions "deny_all" is not supported yet/);

    const deep = fakeClaude('echo', 'limits: { max_depth: 2 }');
    const deepCtx = makeCtx(deep.loaded, { depth: 2 });
    await record(deepCtx, 'fake-a');
    failed(await resumeThronglet({ session_id: 'fake-a', prompt: 'x' }, deepCtx), 'depth_exceeded');
    assert.equal(tagAlive(deep.tag), false);
  });

  it('schema is accepted and ignored with a warning', async () => {
    const { loaded } = fakeClaude('echo');
    const ctx = makeCtx(loaded);
    await record(ctx, 'fake-a');
    const payload = ok(await resumeThronglet({ session_id: 'fake-a', prompt: 'x', schema: { type: 'object' } }, ctx));
    assert.ok(payload.text?.startsWith('resumed: echo: '), payload.text);
    assert.deepEqual(payload.warnings, ['schema is not supported yet (v2); ignored']);
  });
});
