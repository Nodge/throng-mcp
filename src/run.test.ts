import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type LoadedConfig } from './config.ts';
import type { RunFailure, RunSuccess } from './contract.ts';
import { createProgress, type ProgressNotification } from './mcp/progress.ts';
import { noProgress, type Progress } from './progress.ts';
import { EXECUTOR_PREFIX } from './prompt.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import { SessionRegistry } from './registry.ts';
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
        sessions: new SessionRegistry(),
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
        waiting: () => calls.push('waiting'),
        tool: title => calls.push(`tool ${title}`),
        text: () => calls.push('text'),
        done: () => calls.push('done'),
        idle: () => Promise.resolve(),
    };
}

/** The schema the fake agent's submit-* scenarios are written against. */
const SUBMIT_SCHEMA = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
};

/** Runs `fn` with TMPDIR pointed at a fresh dir, where the run's structured-output temp dir lands. */
async function inTmp<T>(fn: () => Promise<T>): Promise<{ result: T; tmp: string }> {
    const tmp = mkdtempSync(join(root, 'tmp-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
        return { result: await fn(), tmp };
    } finally {
        if (saved === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved;
    }
}

/** The run's temp dir is removed and no submit-tool (its argv carries the dir) is left running. */
function expectStructuredGone(tmp: string): void {
    expect(readdirSync(tmp).filter(name => name.startsWith('throng-'))).toStrictEqual([]);
    expect(tagAlive(tmp), 'submit-tool still running').toBe(false);
}

const input = (agent: string, extra: Record<string, unknown> = {}) => ({
    agent,
    prompt: 'do the thing',
    cwd: work,
    description: 'test run',
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
        expect(record.description).toBe('test run');
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

    it('schema: a valid submit_result → structured, no text', async () => {
        const { loaded, tag } = fakeClaude('submit-valid');
        const { result, tmp } = await inTmp(() =>
            runThronglet(input('claude/fake-small', { schema: SUBMIT_SCHEMA }), makeCtx(loaded))
        );
        const payload = ok(result);
        expect(payload.structured).toStrictEqual({ answer: 'pong' });
        expect('text' in payload, JSON.stringify(payload)).toBe(false);
        expect(payload.stop_reason).toBe('end_turn');
        expect(payload.warnings).toBe(undefined);
        expect(tagAlive(tag), 'adapter still running').toBe(false);
        expectStructuredGone(tmp);
    });

    it('schema: a request_permission for submit_result is allowed under auto → structured', async () => {
        const { loaded } = fakeClaude('submit-ask');
        const { result, tmp } = await inTmp(() =>
            runThronglet(input('claude/fake-small', { schema: SUBMIT_SCHEMA }), makeCtx(loaded))
        );
        expect(ok(result).structured).toStrictEqual({ answer: 'pong' });
        expectStructuredGone(tmp);
    });

    it('schema: a rejected submit_result fixed within the turn → structured, one turn', async () => {
        const { loaded } = fakeClaude('submit-invalid-then-valid');
        const { result, tmp } = await inTmp(() =>
            runThronglet(input('claude/fake-small', { schema: SUBMIT_SCHEMA }), makeCtx(loaded))
        );
        const payload = ok(result);
        expect(payload.structured).toStrictEqual({ answer: 'pong' });
        expect('text' in payload).toBe(false);
        expect(payload.usage).toStrictEqual({ input_tokens: 10, output_tokens: 5 });
        expectStructuredGone(tmp);
    });

    it('schema: never submitted → structured_missing after 2 corrective prompts', async () => {
        const { loaded, tag } = fakeClaude('submit-missing');
        const { result, tmp } = await inTmp(() =>
            runThronglet(input('claude/fake-small', { schema: SUBMIT_SCHEMA }), makeCtx(loaded))
        );
        const payload = failed(result, 'structured_missing');
        expect(payload.message).toBe('agent did not call submit_result after 2 corrective prompts');
        expect(payload.text).toBe('turn 3');
        expect(payload.session_id?.startsWith('fake-')).toBe(true);
        expect(payload.usage).toStrictEqual({ input_tokens: 30, output_tokens: 15 });
        expect(tagAlive(tag), 'adapter still running').toBe(false);
        expectStructuredGone(tmp);
    });

    it('schema: always rejected → structured_invalid with the ajv errors', async () => {
        const { loaded } = fakeClaude('submit-invalid-always');
        const { result, tmp } = await inTmp(() =>
            runThronglet(input('claude/fake-small', { schema: SUBMIT_SCHEMA }), makeCtx(loaded))
        );
        const payload = failed(result, 'structured_invalid');
        expect(payload.message).toBe('last submit_result rejected: result/answer must be string');
        expect(payload.text).toBe('turn 3');
        expect(payload.session_id?.startsWith('fake-')).toBe(true);
        expectStructuredGone(tmp);
    });

    it('schema: the temp dir is removed after a timeout', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const { result, tmp } = await inTmp(() =>
            runThronglet(input('claude/fake-small', { schema: SUBMIT_SCHEMA, timeout_s: 1 }), makeCtx(loaded))
        );
        failed(result, 'timeout');
        expect(tagAlive(tag), 'adapter still running').toBe(false);
        expectStructuredGone(tmp);
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
        const ctx = makeCtx(loaded, { signal: controller.signal });
        const running = runThronglet(input('claude/fake-small'), ctx);
        // Cancel once the session exists (its record is written right after the handshake), not on a fixed timer.
        const sessions = join(ctx.cacheDir, 'sessions');
        await waitFor('session record', () => existsSync(sessions) && readdirSync(sessions).length > 0);
        controller.abort();
        const payload = failed(await running, 'cancelled');
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

describe('sendMessage', () => {
    /** Writes a session record by hand, as a run_thronglet call would have. */
    async function record(ctx: RunContext, sessionId: string, fields: Partial<SessionRecord> = {}): Promise<void> {
        const at = new Date().toISOString();
        const base: SessionRecord = {
            harness: 'claude',
            model: 'fake-small',
            cwd: work,
            description: '',
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

        const second = ok(await sendMessage({ session_id: first.session_id, prompt: 'what did I say?' }, ctx));
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
        expect(after.last_result).toStrictEqual(second);
        expect({ ...after, last_used_at: undefined, last_result: undefined }).toStrictEqual({
            ...before,
            last_used_at: undefined,
            last_result: undefined,
        });
    });

    it('unknown or unsafe id → session_not_found before spawn', async () => {
        const { loaded, tag } = fakeClaude('resume-memory');
        const ctx = makeCtx(loaded);
        const unknown = failed(await sendMessage({ session_id: 'fake-nope', prompt: 'x' }, ctx), 'session_not_found');
        expect(unknown.message).toMatch(
            /^no session record for "fake-nope" \(records live 14 days under .*\/sessions\)$/
        );
        expect(unknown.session_id).toBe(undefined);
        const unsafe = failed(await sendMessage({ session_id: '../etc', prompt: 'x' }, ctx), 'session_not_found');
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
            failed(await sendMessage({ session_id: 'fake-bad', prompt: 'x' }, ctx), 'session_not_found').message
        ).toMatch(/corrupt/);
        expect(
            failed(await sendMessage({ session_id: 'fake-junk', prompt: 'x' }, ctx), 'session_not_found').message
        ).toMatch(/unreadable/);
    });

    it('harness without resume capability → session_not_found', async () => {
        const { loaded, tag } = fakeClaude('no-resume');
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-a');
        const payload = failed(await sendMessage({ session_id: 'fake-a', prompt: 'x' }, ctx), 'session_not_found');
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
            await sendMessage({ session_id: 'fake-forgotten', prompt: 'x' }, ctx),
            'session_not_found'
        );
        expect(payload.message).toMatch(/unknown session fake-forgotten/);
        expect(tagAlive(tag)).toBe(false);
    });

    it('adapter missing → harness_unavailable; record cwd gone → spawn_failed', async () => {
        const { loaded } = fakeClaude('echo');
        const ctx = makeCtx(loaded);
        await record(ctx, 'codex-a', { harness: 'codex', model: 'gpt' });
        const codex = failed(await sendMessage({ session_id: 'codex-a', prompt: 'x' }, ctx), 'harness_unavailable');
        expect(codex.message).toMatch(/codex-acp not found on PATH; install: npm i -g @agentclientprotocol\/codex-acp/);

        const gone = join(root, `gone-${randomUUID()}`);
        mkdirSync(gone);
        await record(ctx, 'fake-gone', { cwd: gone });
        rmSync(gone, { recursive: true });
        const spawn = failed(await sendMessage({ session_id: 'fake-gone', prompt: 'x' }, ctx), 'spawn_failed');
        expect(spawn.message.includes(gone), spawn.message).toBe(true);
    });

    it('timeout → timeout with the session_id, adapter gone', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-hang');
        const started = Date.now();
        const payload = failed(
            await sendMessage({ session_id: 'fake-hang', prompt: 'x', timeout_s: 1 }, ctx),
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
            await sendMessage({ session_id: 'fake-a', prompt: 'x' }, deniedCtx),
            'harness_unavailable'
        );
        expect(policy.message).toMatch(/permissions "deny_all" is not supported yet/);

        const deep = fakeClaude('echo', 'limits: { max_depth: 2 }');
        const deepCtx = makeCtx(deep.loaded, { depth: 2 });
        await record(deepCtx, 'fake-a');
        failed(await sendMessage({ session_id: 'fake-a', prompt: 'x' }, deepCtx), 'depth_exceeded');
        expect(tagAlive(deep.tag)).toBe(false);
    });

    it('schema: the submit_result server is injected into session/resume too', async () => {
        const { loaded, tag } = fakeClaude('submit-valid');
        const ctx = makeCtx(loaded);
        await record(ctx, 'fake-a');
        const { result, tmp } = await inTmp(() =>
            sendMessage({ session_id: 'fake-a', prompt: 'x', schema: SUBMIT_SCHEMA }, ctx)
        );
        const payload = ok(result);
        expect(payload.session_id).toBe('fake-a');
        expect(payload.structured).toStrictEqual({ answer: 'pong' });
        expect('text' in payload).toBe(false);
        expect(tagAlive(tag), 'adapter still running').toBe(false);
        expectStructuredGone(tmp);
    });
});

describe('session queue', () => {
    /** Progress that logs into a shared `events` list as `<name> <event>`; `onStarted` runs just before `started` is logged. */
    function loggingProgress(name: string, events: string[], onStarted?: () => void): Progress {
        return {
            queued: n => events.push(`${name} queued ${n}`),
            started: () => {
                onStarted?.();
                events.push(`${name} started`);
            },
            waiting: () => {
                /* not logged */
            },
            tool: () => {
                /* not logged */
            },
            text: () => {
                /* not logged */
            },
            done: () => events.push(`${name} done`),
            idle: () => Promise.resolve(),
        };
    }

    async function record(ctx: RunContext, sessionId: string): Promise<void> {
        const at = new Date().toISOString();
        await writeSessionRecord(ctx.cacheDir, sessionId, {
            harness: 'claude',
            model: 'fake-small',
            cwd: work,
            description: '',
            created_at: at,
            last_used_at: at,
        });
    }

    it('two send_message calls on one session: the second queues, starts after the first adapter is gone', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const sessions = new SessionRegistry();
        const events: string[] = [];
        let adapterAtBStart: boolean | undefined;
        const aCtx = makeCtx(loaded, { sessions, progress: loggingProgress('A', events) });
        await record(aCtx, 'fake-q');
        // A holds the session for 2 s so B's wait clears the 1 s `queued` warning threshold with margin.
        const a = sendMessage({ session_id: 'fake-q', prompt: 'A', timeout_s: 2 }, aCtx);
        await waitFor('A holds the session', () => sessions.busy('fake-q'));
        const bCtx = makeCtx(loaded, {
            sessions,
            cacheDir: aCtx.cacheDir,
            progress: loggingProgress('B', events, () => (adapterAtBStart = tagAlive(tag))),
        });
        const bStarted = Date.now();
        const b = sendMessage({ session_id: 'fake-q', prompt: 'B', timeout_s: 1 }, bCtx);
        await waitFor('B queued', () => sessions.waiting('fake-q') === 1);

        failed(await a, 'timeout');
        const bPayload = failed(await b, 'timeout');
        const bWall = Date.now() - bStarted;
        expect(events).toStrictEqual(['A started', 'B queued 1', 'A done', 'B started', 'B done']);
        expect(adapterAtBStart, "A's adapter still up when B started").toBe(false);
        expect(bPayload.session_id).toBe('fake-q');
        expect(bPayload.duration_s < 2.5, `duration_s ${bPayload.duration_s}, wall ${bWall} ms`).toBe(true);
        expect(bPayload.duration_s * 1000 < bWall - 500, `duration_s ${bPayload.duration_s}, wall ${bWall} ms`).toBe(
            true
        );
        expect(
            bPayload.warnings?.some(w => /^queued \d+\.\d s$/.test(w)),
            JSON.stringify(bPayload.warnings)
        ).toBe(true);
        expect(sessions.busy('fake-q')).toBe(false);
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('two echo turns on one session both succeed, one after the other', async () => {
        const { loaded, tag } = fakeClaude('echo', '', { FAKE_TURN_MS: '800' });
        const sessions = new SessionRegistry();
        const events: string[] = [];
        const aCtx = makeCtx(loaded, { sessions, progress: loggingProgress('A', events) });
        await record(aCtx, 'fake-e');
        const a = sendMessage({ session_id: 'fake-e', prompt: 'first message' }, aCtx);
        await waitFor('A holds the session', () => sessions.busy('fake-e'));
        const b = sendMessage(
            { session_id: 'fake-e', prompt: 'second message' },
            makeCtx(loaded, { sessions, cacheDir: aCtx.cacheDir, progress: loggingProgress('B', events) })
        );
        const aPayload = ok(await a);
        const bPayload = ok(await b);
        expect(events).toStrictEqual(['A started', 'B queued 1', 'A done', 'B started', 'B done']);
        expect(aPayload.text?.includes('first message'), aPayload.text).toBe(true);
        expect(bPayload.text?.startsWith('resumed: echo: '), bPayload.text).toBe(true);
        expect(bPayload.text?.includes('second message'), bPayload.text).toBe(true);
        expect(bPayload.text?.includes('first message'), bPayload.text).toBe(false);
        expect(sessions.busy('fake-e')).toBe(false);
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('abort while queued → cancelled; the lock is released and a later call proceeds', async () => {
        const hang = fakeClaude('hang');
        const sessions = new SessionRegistry();
        const first = new AbortController();
        const second = new AbortController();
        const aCtx = makeCtx(hang.loaded, { sessions, signal: first.signal });
        await record(aCtx, 'fake-c');
        const a = sendMessage({ session_id: 'fake-c', prompt: 'A' }, aCtx);
        await waitFor('A holds the session', () => sessions.busy('fake-c'));
        const bProgress = recordingProgress();
        const b = sendMessage(
            { session_id: 'fake-c', prompt: 'B' },
            makeCtx(hang.loaded, { sessions, cacheDir: aCtx.cacheDir, signal: second.signal, progress: bProgress })
        );
        await waitFor('B queued', () => sessions.waiting('fake-c') === 1);
        second.abort();
        const bPayload = failed(await b, 'cancelled');
        expect(bPayload.message).toBe("cancelled while waiting for the session's running turn to end");
        expect(bProgress.calls).toStrictEqual(['queued 1', 'done']);
        expect(sessions.waiting('fake-c')).toBe(0);
        expect(sessions.busy('fake-c'), 'A still holds the session').toBe(true);

        // A may still be in its handshake: then the lock is held until that lingering adapter is gone.
        first.abort();
        failed(await a, 'cancelled');
        await waitFor('lock released', () => !sessions.busy('fake-c'));
        expect(tagAlive(hang.tag), 'lock released while the adapter was still up').toBe(false);

        const echo = fakeClaude('echo');
        const cProgress = recordingProgress();
        const c = ok(
            await sendMessage(
                { session_id: 'fake-c', prompt: 'third message' },
                makeCtx(echo.loaded, { sessions, cacheDir: aCtx.cacheDir, progress: cProgress })
            )
        );
        expect(c.text?.includes('third message'), c.text).toBe(true);
        expect(
            cProgress.calls.some(call => call.startsWith('queued')),
            JSON.stringify(cProgress.calls)
        ).toBe(false);
    });

    it('cancel during the handshake: the session stays locked until the adapter is gone', async () => {
        const { loaded, tag } = fakeClaude('handshake-hang', 'limits: { handshake_s: 1 }');
        const sessions = new SessionRegistry();
        const controller = new AbortController();
        const ctx = makeCtx(loaded, { sessions, signal: controller.signal });
        await record(ctx, 'fake-h');
        const call = sendMessage({ session_id: 'fake-h', prompt: 'x' }, ctx);
        await waitFor('adapter', () => tagAlive(tag));
        controller.abort();
        failed(await call, 'cancelled');
        expect(sessions.busy('fake-h'), 'lock released while the adapter was still up').toBe(true);
        await waitFor('lock released', () => !sessions.busy('fake-h'));
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('run_thronglet: the new session is busy while its turn runs, idle after close', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const sessions = new SessionRegistry();
        const controller = new AbortController();
        const ctx = makeCtx(loaded, { sessions, signal: controller.signal });
        const running = runThronglet(input('claude/fake-small'), ctx);
        const dir = join(ctx.cacheDir, 'sessions');
        await waitFor('session record', () => existsSync(dir) && readdirSync(dir).length > 0);
        const id = readdirSync(dir)[0]?.replace(/\.json$/, '') ?? '';
        expect(sessions.busy(id), `${id} not busy`).toBe(true);
        controller.abort();
        const payload = failed(await running, 'cancelled');
        expect(payload.session_id).toBe(id);
        expect(sessions.busy(id)).toBe(false);
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });
});

describe('turn record', () => {
    const recordAt = (ctx: RunContext, id: string) => join(ctx.cacheDir, 'sessions', `${id}.json`);
    const readRecord = (ctx: RunContext, id: string) =>
        JSON.parse(readFileSync(recordAt(ctx, id), 'utf8')) as SessionRecord;

    it('onTurnStarted fires once, after the record exists, before the agent text; last_result is the payload', async () => {
        const { loaded } = fakeClaude('echo');
        const events: string[] = [];
        const progress = { ...recordingProgress(), text: () => events.push('text') };
        const cacheDir = mkdtempSync(join(root, 'cache-'));
        const ctx = makeCtx(loaded, {
            cacheDir,
            progress,
            onTurnStarted: id => {
                const path = join(cacheDir, 'sessions', `${id}.json`);
                const record = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SessionRecord) : undefined;
                events.push(`turn ${id} record=${record ? 'yes' : 'no'} pid=${record?.turn_pid}`);
            },
        });
        const payload = ok(await runThronglet(input('claude/fake-small'), ctx));
        expect(events[0]).toBe(`turn ${payload.session_id} record=yes pid=${process.pid}`);
        expect(events.filter(e => e.startsWith('turn ')).length).toBe(1);
        expect(events.slice(1).every(e => e === 'text') && events.length > 1, JSON.stringify(events)).toBe(true);

        const record = readRecord(ctx, payload.session_id);
        expect(record.last_result).toStrictEqual(payload);
        expect(record.last_error).toBe(undefined);
        expect(record.turn_started_at).toBe(undefined);
        expect(record.turn_pid).toBe(undefined);
    });

    it('send_message: turn fields while the turn runs, then last_error replaces last_result', async () => {
        const { loaded, tag } = fakeClaude('hang');
        const ctx = makeCtx(loaded);
        const at = new Date().toISOString();
        const previous: RunSuccess = {
            session_id: 'fake-t',
            text: 'old',
            stop_reason: 'end_turn',
            usage: {},
            duration_s: 1,
        };
        await writeSessionRecord(ctx.cacheDir, 'fake-t', {
            harness: 'claude',
            model: 'fake-small',
            cwd: work,
            description: '',
            created_at: at,
            last_used_at: at,
            last_result: previous,
        });
        const started: string[] = [];
        const call = sendMessage(
            { session_id: 'fake-t', prompt: 'x', timeout_s: 1 },
            { ...ctx, onTurnStarted: id => started.push(id) }
        );
        await waitFor('turn started', () => started.length > 0);
        const running = readRecord(ctx, 'fake-t');
        expect(running.turn_pid).toBe(process.pid);
        expect(Date.parse(running.turn_started_at ?? '') >= Date.parse(at)).toBe(true);
        expect(running.last_result).toStrictEqual(previous);

        const payload = failed(await call, 'timeout');
        const after = readRecord(ctx, 'fake-t');
        expect(after.last_error).toStrictEqual(payload);
        expect(after.last_error?.code).toBe('timeout');
        expect(after.last_result).toBe(undefined);
        expect(after.turn_started_at).toBe(undefined);
        expect(after.turn_pid).toBe(undefined);
        expect(started).toStrictEqual(['fake-t']);
        expect(tagAlive(tag)).toBe(false);
    });

    it('run_thronglet: a timeout lands in last_error; a failure after the handshake too (model_rejected)', async () => {
        const hang = fakeClaude('hang');
        const ctx = makeCtx(hang.loaded);
        const timedOut = failed(await runThronglet(input('claude/fake-small', { timeout_s: 1 }), ctx), 'timeout');
        expect(readRecord(ctx, timedOut.session_id ?? '').last_error).toStrictEqual(timedOut);

        const echo = fakeClaude('echo');
        const echoCtx = makeCtx(echo.loaded);
        let turns = 0;
        const rejected = failed(
            await runThronglet(input('claude/nope'), { ...echoCtx, onTurnStarted: () => turns++ }),
            'model_rejected'
        );
        expect(turns).toBe(0);
        const record = readRecord(echoCtx, rejected.session_id ?? '');
        expect(record.last_error).toStrictEqual(rejected);
        expect(record.turn_started_at).toBe(undefined);
    });

    it('a failure before the session lock leaves the record alone', async () => {
        const { loaded } = fakeClaude('echo');
        const ctx = makeCtx(loaded);
        const gone = join(root, `gone-${randomUUID()}`);
        const at = new Date().toISOString();
        await writeSessionRecord(ctx.cacheDir, 'fake-g', {
            harness: 'claude',
            model: 'fake-small',
            cwd: gone,
            description: '',
            created_at: at,
            last_used_at: at,
        });
        const before = readFileSync(recordAt(ctx, 'fake-g'), 'utf8');
        failed(await sendMessage({ session_id: 'fake-g', prompt: 'x' }, ctx), 'spawn_failed');
        expect(readFileSync(recordAt(ctx, 'fake-g'), 'utf8')).toBe(before);
    });
});
