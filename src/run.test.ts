import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type LoadedConfig } from './config.ts';
import type { RunFailure, RunSuccess } from './contract.ts';
import { createProgress, type ProgressNotification } from './mcp/progress.ts';
import { noProgress, type Progress } from './progress.ts';
import { EXECUTOR_PREFIX } from './prompt.ts';
import { resumeThronglet } from './mcp/tools/resume-thronglet.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import type { RunContext, RunOutcome } from './run.ts';
import { Semaphore } from './semaphore.ts';
import { type SessionRecord, writeSessionRecord } from './sessions.ts';
import type { FakeScenario } from '../test/fake-agent/index.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-run-'));
const fakeAgent = fileURLToPath(new URL('../test/fake-agent/agent.ts', import.meta.url));
// PATH for the adapter lookup: only `node`, so no real adapter or harness binary is ever found.
const bin = join(root, 'bin');
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));
const env = { PATH: bin };
const work = join(root, 'work');
mkdirSync(work);

const tags: string[] = [];
afterAll(() => {
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
        if (Date.now() > deadline) expect.unreachable(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function loadYaml(yaml: string): LoadedConfig {
    const path = join(root, `config-${randomUUID()}.yaml`);
    writeFileSync(path, yaml);
    return loadConfig({ THRONG_MCP_CONFIG: path });
}

/** Config whose `claude` harness is the fake agent in `scenario`; `agentEnv` is added to the adapter's env. */
function fakeClaude(
    scenario: FakeScenario,
    extra = '',
    agentEnv: Record<string, string> = {}
): { loaded: LoadedConfig; tag: string } {
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
        ].join('\n')
    );
    expect(loaded.error, loaded.error).toBe(undefined);
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
    expect(outcome.ok, `expected success, got ${JSON.stringify(outcome.payload)}`).toBe(true);
    return outcome.payload as RunSuccess;
}

function failed(outcome: RunOutcome, code: RunFailure['code']): RunFailure {
    expect(outcome.ok, `expected failure, got ${JSON.stringify(outcome.payload)}`).toBe(false);
    const payload = outcome.payload as RunFailure;
    expect(payload.code, payload.message).toBe(code);
    expect(typeof payload.duration_s).toBe('number');
    return payload;
}

interface RecordingProgress extends Progress {
    calls: string[];
}

function recordingProgress(): RecordingProgress {
    const calls: string[] = [];
    return {
        calls,
        queued: n => calls.push(`queued ${n}`),
        started: () => calls.push('started'),
        tool: title => calls.push(`tool ${title}`),
        text: () => calls.push('text'),
        done: () => calls.push('done'),
        idle: () => Promise.resolve(),
    };
}

const input = (agent: string, extra: Record<string, unknown> = {}) => ({
    agent,
    prompt: 'do the thing',
    cwd: work,
    ...extra,
});

describe('runThronglet', () => {
    it('echo: success payload, session record', async () => {
        const { loaded, tag } = fakeClaude('echo');
        const ctx = makeCtx(loaded);
        const payload = ok(await runThronglet(input('claude/fake-small'), ctx));
        expect(payload.text?.startsWith('echo: '), payload.text).toBe(true);
        expect(payload.text?.includes('do the thing')).toBe(true);
        const firstSentence = EXECUTOR_PREFIX.slice(0, EXECUTOR_PREFIX.indexOf('.') + 1);
        expect(payload.text?.includes(firstSentence), 'executor prefix missing').toBe(true);
        expect(payload.text ?? '').toMatch(/\[model=fake-small effort=low\]$/);
        expect(payload.stop_reason).toBe('end_turn');
        expect(payload.usage).toStrictEqual({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01 });
        expect(typeof payload.duration_s).toBe('number');
        expect(payload.warnings).toBe(undefined);
        expect(payload.session_id.startsWith('fake-')).toBe(true);
        expect(tagAlive(tag), 'adapter still running').toBe(false);

        const record = JSON.parse(
            readFileSync(join(ctx.cacheDir, 'sessions', `${payload.session_id}.json`), 'utf8')
        ) as SessionRecord;
        expect(record.harness).toBe('claude');
        expect(record.model).toBe('fake-small');
        expect(record.cwd).toBe(work);
        expect(record.effort).toBe(undefined);
        expect(Date.parse(record.created_at) <= Date.parse(record.last_used_at)).toBe(true);
    });

    it('model and effort from the agent spec', async () => {
        const { loaded } = fakeClaude('echo');
        const large = ok(await runThronglet(input('claude/fake-large:high'), makeCtx(loaded)));
        expect(large.text ?? '').toMatch(/\[model=fake-large effort=high\]$/);

        const max = ok(await runThronglet(input('claude/fake-small:max'), makeCtx(loaded)));
        expect(
            max.warnings?.some(w => w.includes('"max"')),
            JSON.stringify(max.warnings)
        ).toBe(true);

        const nope = failed(await runThronglet(input('claude/nope'), makeCtx(loaded)), 'model_rejected');
        expect(nope.message).toMatch(/fake-small, fake-large/);
        expect(nope.session_id?.startsWith('fake-')).toBe(true);
    });

    it('schema is accepted and ignored with a warning', async () => {
        const { loaded } = fakeClaude('echo');
        const payload = ok(
            await runThronglet(input('claude/fake-small', { schema: { type: 'object' } }), makeCtx(loaded))
        );
        expect(payload.warnings).toStrictEqual(['schema is not supported yet (v2); ignored']);
    });

    it('unknown harness → harness_unavailable', async () => {
        const { loaded } = fakeClaude('echo');
        const payload = failed(await runThronglet(input('gemini/x'), makeCtx(loaded)), 'harness_unavailable');
        expect(payload.session_id).toBe(undefined);
    });

    it('adapter missing → harness_unavailable with the install hint, before spawn', async () => {
        const payload = failed(await runThronglet(input('claude/opus'), makeCtx(loadYaml(''))), 'harness_unavailable');
        expect(payload.message).toMatch(
            /claude-agent-acp not found on PATH; install: npm i -g @agentclientprotocol\/claude-agent-acp/
        );
    });

    it('depth guard', async () => {
        const { loaded, tag } = fakeClaude('echo', 'limits: { max_depth: 2 }');
        const payload = failed(
            await runThronglet(input('claude/fake-small'), makeCtx(loaded, { depth: 2 })),
            'depth_exceeded'
        );
        expect(payload.message).toMatch(/depth 3.*max_depth is 2/);
        expect(tagAlive(tag)).toBe(false);
    });

    it('config error and unsupported policy refuse to run', async () => {
        const broken = failed(
            await runThronglet(input('claude/fake-small'), makeCtx(loadYaml('limits: [\n'))),
            'harness_unavailable'
        );
        expect(broken.message.startsWith('config error:'), broken.message).toBe(true);

        const { loaded } = fakeClaude('echo', 'permissions: deny_all');
        const policy = failed(await runThronglet(input('claude/fake-small'), makeCtx(loaded)), 'harness_unavailable');
        expect(policy.message).toMatch(/permissions "deny_all" is not supported yet/);
    });

    it('timeout → timeout with session_id, adapter gone', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const started = Date.now();
        const payload = failed(
            await runThronglet(input('claude/fake-small', { timeout_s: 1 }), makeCtx(loaded)),
            'timeout'
        );
        expect(Date.now() - started < 2500, `took ${Date.now() - started} ms`).toBe(true);
        expect(payload.session_id).toBeTruthy();
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('client cancel → cancelled, adapter gone', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const payload = failed(
            await runThronglet(input('claude/fake-small'), makeCtx(loaded, { signal: controller.signal })),
            'cancelled'
        );
        expect(payload.session_id).toBeTruthy();
        expect(payload.usage, 'cancelled turn without usage').toStrictEqual({});
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('adapter crash mid-prompt → transport_lost with stderr', async () => {
        const { loaded, tag } = fakeClaude('crash-on-prompt');
        const payload = failed(await runThronglet(input('claude/fake-small'), makeCtx(loaded)), 'transport_lost');
        expect(payload.message).toMatch(/boom/);
        expect(payload.session_id).toBeTruthy();
        expect(tagAlive(tag)).toBe(false);
    });

    it('stop reasons: empty_result, refusal, max_turn_requests', async () => {
        const empty = failed(
            await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('empty').loaded)),
            'empty_result'
        );
        expect(empty.session_id).toBeTruthy();
        expect(empty.usage).toStrictEqual({ input_tokens: 10, output_tokens: 5 });

        const refusal = failed(
            await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('refuse').loaded)),
            'refusal'
        );
        expect(refusal.text).toBe('I will not do that.');

        const maxTurns = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('max-turns').loaded)));
        expect(maxTurns.stop_reason).toBe('max_turn_requests');
        expect(maxTurns.text?.startsWith('echo: ')).toBe(true);
    });

    it('adapter notices become warnings', async () => {
        const payload = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('notice').loaded)));
        expect(payload.warnings).toStrictEqual(['warning: fake notice — mode fell back']);
    });

    it('auto: a request_permission the harness still raises is rejected', async () => {
        const payload = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('permission').loaded)));
        expect(payload.text).toBe('rejected');
    });

    it('a permission-mode fallback announced by the agent lands in warnings, not in text', async () => {
        const payload = ok(await runThronglet(input('claude/fake-small'), makeCtx(fakeClaude('mode-fallback').loaded)));
        expect(payload.text?.startsWith('echo: '), payload.text).toBe(true);
        expect(payload.warnings).toStrictEqual([
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
            makeCtx(loaded, { semaphore, signal: second.signal, progress: secondProgress })
        );
        await waitFor('first session', () => readdirSync(firstCtx.cacheDir).includes('sessions'));
        expect(secondProgress.calls).toStrictEqual(['queued 1']);
        expect(semaphore.waiting).toBe(1);
        second.abort();
        const queuedPayload = failed(await queued, 'cancelled');
        expect(queuedPayload.session_id).toBe(undefined);
        expect(secondProgress.calls).toStrictEqual(['queued 1', 'done']);
        first.abort();
        failed(await running, 'cancelled');
        expect(tagAlive(tag)).toBe(false);
        expect(semaphore.waiting).toBe(0);
        (await semaphore.acquire())();
    });

    it('cancel during the handshake answers at once; the slot is held until the adapter is gone', async () => {
        const { loaded, tag } = fakeClaude('handshake-hang', 'limits: { handshake_s: 1 }');
        const semaphore = new Semaphore(1);
        const controller = new AbortController();
        const call = runThronglet(
            input('claude/fake-small'),
            makeCtx(loaded, { semaphore, signal: controller.signal })
        );
        await waitFor('adapter', () => tagAlive(tag));
        const started = Date.now();
        controller.abort();
        const payload = failed(await call, 'cancelled');
        expect(Date.now() - started < 500, `took ${Date.now() - started} ms`).toBe(true);
        expect(payload.session_id).toBe(undefined);
        let granted = false;
        const next = semaphore.acquire().then(release => ((granted = true), release));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(granted, 'slot released while the adapter was still up').toBe(false);
        (await next)();
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('missing cwd → spawn_failed before spawn', async () => {
        const { loaded } = fakeClaude('echo');
        const payload = failed(
            await runThronglet(input('claude/fake-small', { cwd: join(root, 'nope') }), makeCtx(loaded)),
            'spawn_failed'
        );
        expect(payload.message).toMatch(/cwd does not exist or is not a directory/);
    });

    it('progress: tool titles and text on echo, heartbeat on a long run', async () => {
        const sent: string[] = [];
        const extra = {
            _meta: { progressToken: 'p' },
            sendNotification: (n: ProgressNotification) => {
                sent.push(n.params.message ?? '');
                return Promise.resolve();
            },
        };
        ok(
            await runThronglet(
                input('claude/fake-small'),
                makeCtx(fakeClaude('echo').loaded, { progress: createProgress(extra) })
            )
        );
        expect(sent.includes('read README.md'), JSON.stringify(sent)).toBe(true);
        expect(
            sent.some(m => m.startsWith('agent is writing…')),
            JSON.stringify(sent)
        ).toBe(true);

        sent.length = 0;
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const progress = createProgress(extra, { heartbeatMs: 30 });
        failed(
            await runThronglet(
                input('claude/fake-small'),
                makeCtx(fakeClaude('hang').loaded, { progress, signal: controller.signal })
            ),
            'cancelled'
        );
        expect(
            sent.some(m => /^running 0m0\ds$/.test(m)),
            JSON.stringify(sent)
        ).toBe(true);
    });
});

describe('resumeThronglet', () => {
    /** Writes a session record by hand, as a run_thronglet call would have. */
    async function record(ctx: RunContext, sessionId: string, fields: Partial<SessionRecord> = {}): Promise<void> {
        const at = new Date().toISOString();
        const base: SessionRecord = {
            harness: 'claude',
            model: 'fake-small',
            cwd: work,
            created_at: at,
            last_used_at: at,
        };
        await writeSessionRecord(ctx.cacheDir, sessionId, { ...base, ...fields });
    }

    it('follow-up into the same session: memory kept, model and effort re-applied from the record', async () => {
        const { loaded, tag } = fakeClaude('resume-memory', '', {
            FAKE_MEMORY_DIR: mkdtempSync(join(root, 'memory-')),
        });
        const ctx = makeCtx(loaded);
        const first = ok(await runThronglet(input('claude/fake-large:high', { prompt: 'remember: banana' }), ctx));
        expect(first.text).toBe('noted [model=fake-large effort=high]');
        const recordPath = join(ctx.cacheDir, 'sessions', `${first.session_id}.json`);
        const before = JSON.parse(readFileSync(recordPath, 'utf8')) as SessionRecord;
        await new Promise(resolve => setTimeout(resolve, 10));

        const second = ok(await resumeThronglet({ session_id: first.session_id, prompt: 'what did I say?' }, ctx));
        expect(second.session_id).toBe(first.session_id);
        expect(second.text).toBe('you said: remember: banana [model=fake-large effort=high]');
        expect(second.stop_reason).toBe('end_turn');
        expect(second.usage).toStrictEqual({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01 });
        expect(second.warnings).toBe(undefined);
        expect(tagAlive(tag), 'adapter still running').toBe(false);

        const after = JSON.parse(readFileSync(recordPath, 'utf8')) as SessionRecord;
        expect(after.created_at).toBe(before.created_at);
        expect(
            Date.parse(after.last_used_at) > Date.parse(before.last_used_at),
            `${before.last_used_at} → ${after.last_used_at}`
        ).toBe(true);
        expect({ ...after, last_used_at: undefined }).toStrictEqual({ ...before, last_used_at: undefined });
    });

    it('unknown or unsafe id → session_not_found before spawn', async () => {
        const { loaded, tag } = fakeClaude('resume-memory');
        const ctx = makeCtx(loaded);
        const unknown = failed(
            await resumeThronglet({ session_id: 'fake-nope', prompt: 'x' }, ctx),
            'session_not_found'
        );
        expect(unknown.message).toMatch(
            /^no session record for "fake-nope" \(records live 14 days under .*\/sessions\)$/
        );
        expect(unknown.session_id).toBe(undefined);
        const unsafe = failed(await resumeThronglet({ session_id: '../etc', prompt: 'x' }, ctx), 'session_not_found');
        expect(unsafe.message).toMatch(/no session record for "\.\.\/etc"/);
        expect(tagAlive(tag)).toBe(false);
        expect(readdirSync(ctx.cacheDir), 'nothing written for a call that never started').toStrictEqual([]);
    });

    it('corrupt record → session_not_found', async () => {
        const { loaded } = fakeClaude('echo');
        const ctx = makeCtx(loaded);
        mkdirSync(join(ctx.cacheDir, 'sessions'));
        writeFileSync(
            join(ctx.cacheDir, 'sessions', 'fake-bad.json'),
            JSON.stringify({ harness: 'gemini', model: 'x', cwd: work })
        );
        writeFileSync(join(ctx.cacheDir, 'sessions', 'fake-junk.json'), '{');
        expect(
            failed(await resumeThronglet({ session_id: 'fake-bad', prompt: 'x' }, ctx), 'session_not_found').message
        ).toMatch(/corrupt/);
        expect(
            failed(await resumeThronglet({ session_id: 'fake-junk', prompt: 'x' }, ctx), 'session_not_found').message
        ).toMatch(/unreadable/);
    });

    it('harness without resume capability → session_not_found', async () => {
        const { loaded, tag } = fakeClaude('no-resume');
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-a');
        const payload = failed(await resumeThronglet({ session_id: 'fake-a', prompt: 'x' }, ctx), 'session_not_found');
        expect(payload.message).toMatch(/session\/resume/);
        expect(tagAlive(tag)).toBe(false);
    });

    it('adapter rejects the id → session_not_found with its message', async () => {
        const { loaded, tag } = fakeClaude('resume-memory', '', {
            FAKE_MEMORY_DIR: mkdtempSync(join(root, 'memory-')),
        });
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-forgotten');
        const payload = failed(
            await resumeThronglet({ session_id: 'fake-forgotten', prompt: 'x' }, ctx),
            'session_not_found'
        );
        expect(payload.message).toMatch(/unknown session fake-forgotten/);
        expect(tagAlive(tag)).toBe(false);
    });

    it('adapter missing → harness_unavailable; record cwd gone → spawn_failed', async () => {
        const { loaded } = fakeClaude('echo');
        const ctx = makeCtx(loaded);
        await record(ctx, 'codex-a', { harness: 'codex', model: 'gpt' });
        const codex = failed(await resumeThronglet({ session_id: 'codex-a', prompt: 'x' }, ctx), 'harness_unavailable');
        expect(codex.message).toMatch(/codex-acp not found on PATH; install: npm i -g @agentclientprotocol\/codex-acp/);

        const gone = join(root, `gone-${randomUUID()}`);
        mkdirSync(gone);
        await record(ctx, 'fake-gone', { cwd: gone });
        rmSync(gone, { recursive: true });
        const spawn = failed(await resumeThronglet({ session_id: 'fake-gone', prompt: 'x' }, ctx), 'spawn_failed');
        expect(spawn.message.includes(gone), spawn.message).toBe(true);
    });

    it('timeout → timeout with the session_id, adapter gone', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-hang');
        const started = Date.now();
        const payload = failed(
            await resumeThronglet({ session_id: 'fake-hang', prompt: 'x', timeout_s: 1 }, ctx),
            'timeout'
        );
        expect(Date.now() - started < 2500, `took ${Date.now() - started} ms`).toBe(true);
        expect(payload.session_id).toBe('fake-hang');
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('the guards of a new run apply: unsupported policy, depth', async () => {
        const denied = fakeClaude('echo', 'permissions: deny_all');
        const deniedCtx = makeCtx(denied.loaded);
        await record(deniedCtx, 'fake-a');
        const policy = failed(
            await resumeThronglet({ session_id: 'fake-a', prompt: 'x' }, deniedCtx),
            'harness_unavailable'
        );
        expect(policy.message).toMatch(/permissions "deny_all" is not supported yet/);

        const deep = fakeClaude('echo', 'limits: { max_depth: 2 }');
        const deepCtx = makeCtx(deep.loaded, { depth: 2 });
        await record(deepCtx, 'fake-a');
        failed(await resumeThronglet({ session_id: 'fake-a', prompt: 'x' }, deepCtx), 'depth_exceeded');
        expect(tagAlive(deep.tag)).toBe(false);
    });

    it('schema is accepted and ignored with a warning', async () => {
        const { loaded } = fakeClaude('echo');
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-a');
        const payload = ok(
            await resumeThronglet({ session_id: 'fake-a', prompt: 'x', schema: { type: 'object' } }, ctx)
        );
        expect(payload.text?.startsWith('resumed: echo: '), payload.text).toBe(true);
        expect(payload.warnings).toStrictEqual(['schema is not supported yet (v2); ignored']);
    });
});
