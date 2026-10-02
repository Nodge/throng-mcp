import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeHarness, tagAlive } from '../test/fake-harness.ts';
import { startBackground } from './background.ts';
import type { RunFailure, RunSuccess, TurnPending } from './contract.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import { noProgress, type Progress } from './progress.ts';
import type { RunContext, RunOutcome } from './run.ts';
import { endTurn, pidAlive, readSessionRecord, updateSessionRecord } from './sessions.ts';
import { waitThronglet, type WaitDeps } from './wait.ts';

const h = fakeHarness('throng-wait-');
afterAll(() => h.cleanup());

const input = (prompt: string) => ({ agent: 'claude/fake-small', prompt, cwd: h.work, description: 'wait test' });
const old: RunSuccess = { session_id: 'x', text: 'old', stop_reason: 'end_turn', usage: {}, duration_s: 1 };

type Result = RunOutcome | { pending: TurnPending };

function deps(ctx: RunContext, overrides: Partial<WaitDeps> = {}): WaitDeps {
    return {
        sessions: ctx.sessions,
        cacheDir: ctx.cacheDir,
        signal: new AbortController().signal,
        progress: noProgress,
        defaultTimeoutS: 30,
        pollMs: 50,
        ...overrides,
    };
}

function success(result: Result): RunSuccess {
    expect('pending' in result || !result.ok, `expected success, got ${JSON.stringify(result)}`).toBe(false);
    return (result as RunOutcome).payload as RunSuccess;
}

function failure(result: Result, code: RunFailure['code']): RunFailure {
    expect('pending' in result, `expected a failure, got ${JSON.stringify(result)}`).toBe(false);
    const outcome = result as RunOutcome;
    expect(outcome.ok).toBe(false);
    expect(outcome.payload).toMatchObject({ code });
    return outcome.payload as RunFailure;
}

function pending(result: Result): TurnPending {
    expect('pending' in result, `expected pending, got ${JSON.stringify(result)}`).toBe(true);
    return (result as { pending: TurnPending }).pending;
}

/** Runs `start` in the background on `ctx`; resolves with the acceptance and the detached run. */
async function background(
    ctx: RunContext,
    start: (c: RunContext) => Promise<RunOutcome>,
    sessionId?: string
): Promise<{ accepted: TurnPending; run: Promise<RunOutcome> }> {
    let run: Promise<RunOutcome> | undefined;
    const track = <T>(p: Promise<T>) => {
        run = p as unknown as Promise<RunOutcome>;
        return p;
    };
    const accepted = pending(await startBackground(start, ctx, { ...(sessionId ? { sessionId } : {}), track }));
    if (!run) expect.unreachable('not tracked');
    return { accepted, run };
}

describe('waitThronglet', () => {
    it('a finished session: last_result, the same on a second call; progress waiting → done', async () => {
        const { loaded } = h.fakeClaude('echo');
        const ctx = h.makeCtx(loaded);
        const first = await runThronglet(input('hello'), ctx);
        const id = (first.payload as RunSuccess).session_id;
        const calls: string[] = [];
        const progress: Progress = {
            ...noProgress,
            waiting: () => calls.push('waiting'),
            done: () => calls.push('done'),
        };
        const a = success(await waitThronglet({ session_id: id }, deps(ctx, { progress })));
        expect(a).toStrictEqual(first.payload);
        expect(success(await waitThronglet({ session_id: id }, deps(ctx)))).toStrictEqual(a);
        expect(calls).toStrictEqual(['waiting', 'done']);
    });

    it('during a running background turn: resolves after it, with its result', async () => {
        const { loaded, tag } = h.fakeClaude('echo', '', { FAKE_TURN_MS: '800' });
        const ctx = h.makeCtx(loaded);
        const { accepted, run } = await background(ctx, c => runThronglet(input('hello'), c));
        let finished = false;
        void run.then(() => (finished = true));
        const result = success(await waitThronglet({ session_id: accepted.session_id }, deps(ctx)));
        expect(finished, 'wait resolved before the run').toBe(true);
        expect(result).toStrictEqual((await run).payload);
        expect(result.text?.includes('hello')).toBe(true);
        expect(tagAlive(tag)).toBe(false);
    });

    it('a message queued behind the running turn: resolves only after both, with the second result', async () => {
        const { loaded } = h.fakeClaude('echo', '', { FAKE_TURN_MS: '500' });
        const ctx = h.makeCtx(loaded);
        const a = await background(ctx, c => runThronglet(input('first message'), c));
        const id = a.accepted.session_id;
        const b = await background(ctx, c => sendMessage({ session_id: id, prompt: 'second message' }, c), id);
        expect(b.accepted).toStrictEqual({ session_id: id, state: 'queued', queued: 1 });
        const done: string[] = [];
        void a.run.then(() => done.push('a'));
        void b.run.then(() => done.push('b'));
        const result = success(await waitThronglet({ session_id: id }, deps(ctx)));
        expect(done).toStrictEqual(['a', 'b']);
        expect(result.text?.startsWith('resumed: echo: '), result.text).toBe(true);
        expect(result.text?.includes('second message'), result.text).toBe(true);
        expect(result).toStrictEqual((await b.run).payload);
    });

    it('timeout_s elapsed while running → pending, not an error; a client cancel too', async () => {
        const { loaded } = h.fakeClaude('hang');
        const ctx = h.makeCtx(loaded);
        const { accepted, run } = await background(ctx, c => runThronglet({ ...input('x'), timeout_s: 2 }, c));
        const id = accepted.session_id;
        const t0 = Date.now();
        expect(pending(await waitThronglet({ session_id: id, timeout_s: 0.5 }, deps(ctx)))).toStrictEqual({
            session_id: id,
            state: 'running',
            queued: 0,
        });
        expect(Date.now() - t0 >= 450 && Date.now() - t0 < 1500, `${Date.now() - t0} ms`).toBe(true);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        expect(
            pending(await waitThronglet({ session_id: id }, deps(ctx, { signal: controller.signal })))
        ).toMatchObject({
            state: 'running',
        });
        failure(await run, 'timeout');
        failure(await waitThronglet({ session_id: id }, deps(ctx)), 'timeout');
    });

    it('unknown id → session_not_found; a record without any turn result → empty_result', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        const unknown = failure(await waitThronglet({ session_id: 'fake-nope' }, deps(ctx)), 'session_not_found');
        expect(unknown.message).toMatch(
            /^no session record for "fake-nope" \(records live 14 days under .*\/sessions\)$/
        );
        await h.record(ctx.cacheDir, 'fake-old');
        expect(failure(await waitThronglet({ session_id: 'fake-old' }, deps(ctx)), 'empty_result').message).toBe(
            'no turn result recorded for session fake-old'
        );
    });

    it('a turn of a dead pid → marked interrupted, transport_lost', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        let dead = 2 ** 22 - 1;
        while (pidAlive(dead)) dead--;
        await h.record(ctx.cacheDir, 'fake-dead', {
            turn_started_at: new Date().toISOString(),
            turn_pid: dead,
            last_result: old,
        });
        const payload = failure(await waitThronglet({ session_id: 'fake-dead' }, deps(ctx)), 'transport_lost');
        expect(payload.message).toBe('turn interrupted: the throng server process that ran it is gone');
        const record = await readSessionRecord(ctx.cacheDir, 'fake-dead');
        expect(record?.last_error).toStrictEqual(payload);
        expect(record?.turn_started_at).toBe(undefined);
        expect(record?.last_result).toBe(undefined);
    });

    it('our own pid but no turn in this process → the result was never recorded: transport_lost', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        await h.record(ctx.cacheDir, 'fake-own', { turn_started_at: new Date().toISOString(), turn_pid: process.pid });
        const payload = failure(await waitThronglet({ session_id: 'fake-own' }, deps(ctx)), 'transport_lost');
        expect(payload.message).toBe('turn ended without recording its result');
    });

    it('a turn of another live throng process: polled until the record changes, or until that process dies', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        const other = spawn('sleep', ['30'], { stdio: 'ignore' });
        await once(other, 'spawn');
        try {
            const turn = { turn_started_at: new Date().toISOString(), turn_pid: other.pid ?? 0 };
            await h.record(ctx.cacheDir, 'fake-far', { ...turn, last_result: old });
            let settled = false;
            const waiting = waitThronglet({ session_id: 'fake-far' }, deps(ctx)).finally(() => (settled = true));
            await new Promise(resolve => setTimeout(resolve, 300));
            expect(settled, 'wait returned while the other process still runs the turn').toBe(false);
            const fresh: RunSuccess = { ...old, text: 'fresh' };
            await updateSessionRecord(ctx.cacheDir, 'fake-far', endTurn({ ok: true, payload: fresh }, new Date()));
            expect(success(await waiting)).toStrictEqual(fresh);

            await updateSessionRecord(ctx.cacheDir, 'fake-far', turn);
            const second = waitThronglet({ session_id: 'fake-far' }, deps(ctx));
            await new Promise(resolve => setTimeout(resolve, 200));
            other.kill('SIGKILL');
            await once(other, 'exit');
            failure(await second, 'transport_lost');
        } finally {
            other.kill('SIGKILL');
        }
    });
});
