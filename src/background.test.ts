import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeHarness, tagAlive, waitFor } from '../test/fake-harness.ts';
import { startBackground } from './background.ts';
import type { RunFailure, TurnPending } from './contract.ts';
import { noProgress, type Progress } from './progress.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import type { RunOutcome } from './run.ts';
import { Semaphore } from './semaphore.ts';
import type { SessionRecord } from './sessions.ts';

const h = fakeHarness('throng-background-');
afterAll(() => h.cleanup());

const input = (agent: string, extra: Record<string, unknown> = {}) => ({
    agent,
    prompt: 'do the thing',
    cwd: h.work,
    description: 'background test',
    ...extra,
});

/** `track` that keeps what it was given. */
function tracker(): { track: <T>(p: Promise<T>) => Promise<T>; tracked: Promise<unknown>[] } {
    const tracked: Promise<unknown>[] = [];
    return {
        tracked,
        track: <T>(p: Promise<T>) => {
            tracked.push(p);
            return p;
        },
    };
}

/** Progress that logs the calls the accepting call would see. */
function recorder(): { progress: Progress; calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        progress: {
            ...noProgress,
            queued: (position, behind) => calls.push(`queued ${position} ${behind}`),
            started: () => calls.push('started'),
            tool: () => calls.push('tool'),
            text: () => calls.push('text'),
            done: () => calls.push('done'),
        },
    };
}

/** A semaphore of one slot, taken. */
async function fullSemaphore(): Promise<{ semaphore: Semaphore; release: () => void }> {
    const semaphore = new Semaphore(1);
    return { semaphore, release: await semaphore.acquire() };
}

function pendingOf(result: RunOutcome | { pending: TurnPending }): TurnPending {
    expect('pending' in result, `expected pending, got ${JSON.stringify(result)}`).toBe(true);
    return (result as { pending: TurnPending }).pending;
}

function failureOf(result: RunOutcome | { pending: TurnPending }, code: RunFailure['code']): RunFailure {
    expect('pending' in result, `expected a failure, got ${JSON.stringify(result)}`).toBe(false);
    const outcome = result as RunOutcome;
    expect(outcome.ok).toBe(false);
    expect(outcome.payload as RunFailure).toMatchObject({ code });
    return outcome.payload as RunFailure;
}

describe('startBackground', () => {
    it('run_thronglet: accepted as running long before the turn ends; one slot while running, none after', async () => {
        const { loaded, tag } = h.fakeClaude('echo', '', { FAKE_TURN_MS: '800' });
        const base = h.makeCtx(loaded);
        const { track, tracked } = tracker();
        const t0 = Date.now();
        const pending = pendingOf(
            await startBackground(ctx => runThronglet(input('claude/fake-small'), ctx), base, { track })
        );
        const acceptedAt = Date.now();
        expect(pending.state).toBe('running');
        expect(pending.queued).toBe(0);
        expect(pending.session_id.startsWith('fake-')).toBe(true);
        expect(base.sessions.busy(pending.session_id)).toBe(true);
        expect(base.semaphore.active).toBe(1);
        expect(tracked.length).toBe(1);

        let settled = false;
        void tracked[0]?.then(() => (settled = true));
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(settled, 'the run finished within 300 ms of acceptance').toBe(false);
        expect(base.sessions.busy(pending.session_id)).toBe(true);

        const outcome = (await tracked[0]) as RunOutcome;
        expect(outcome.ok, JSON.stringify(outcome.payload)).toBe(true);
        expect(Date.now() - acceptedAt >= 700, `ran ${Date.now() - acceptedAt} ms after acceptance`).toBe(true);
        expect(acceptedAt - t0 < 2000, `acceptance took ${acceptedAt - t0} ms`).toBe(true);
        expect(base.semaphore.active).toBe(0);
        expect(base.sessions.busy(pending.session_id)).toBe(false);
        const record = JSON.parse(
            readFileSync(join(base.cacheDir, 'sessions', `${pending.session_id}.json`), 'utf8')
        ) as SessionRecord;
        expect(record.last_result).toStrictEqual(outcome.payload);
        expect(tagAlive(tag)).toBe(false);
    });

    it('send_message on a busy session: accepted at once as queued; the queued turn holds no slot', async () => {
        const { loaded, tag } = h.fakeClaude('hang');
        const base = h.makeCtx(loaded);
        await h.record(base.cacheDir, 'fake-b');
        const { track, tracked } = tracker();
        const send = (prompt: string) =>
            startBackground(ctx => sendMessage({ session_id: 'fake-b', prompt, timeout_s: 1 }, ctx), base, {
                sessionId: 'fake-b',
                track,
            });

        const first = pendingOf(await send('A'));
        expect(first).toStrictEqual({ session_id: 'fake-b', state: 'running', queued: 0 });
        const t0 = Date.now();
        const second = pendingOf(await send('B'));
        expect(Date.now() - t0 < 300, `queued acceptance took ${Date.now() - t0} ms`).toBe(true);
        expect(second).toStrictEqual({ session_id: 'fake-b', state: 'queued', queued: 1 });
        expect(base.semaphore.active).toBe(1);
        expect(base.sessions.turns('fake-b').length).toBe(2);

        const outcomes = (await Promise.all(tracked)) as RunOutcome[];
        expect(outcomes.map(o => (o.ok ? 'ok' : o.payload.code))).toStrictEqual(['timeout', 'timeout']);
        expect(base.semaphore.active).toBe(0);
        expect(base.sessions.busy('fake-b')).toBe(false);
        expect(tagAlive(tag)).toBe(false);
    });

    it('a failure before the turn is the result, not a pending: model_rejected, spawn_failed, session_not_found', async () => {
        const { loaded, tag } = h.fakeClaude('echo');
        const base = h.makeCtx(loaded);
        const { track, tracked } = tracker();
        const rejected = failureOf(
            await startBackground(ctx => runThronglet(input('claude/nope'), ctx), base, { track }),
            'model_rejected'
        );
        expect(rejected.session_id).toBeTruthy();

        const missing = join(h.root, 'missing-dir');
        failureOf(
            await startBackground(ctx => runThronglet(input('claude/fake-small', { cwd: missing }), ctx), base, {
                track,
            }),
            'spawn_failed'
        );
        failureOf(
            await startBackground(ctx => sendMessage({ session_id: 'fake-none', prompt: 'x' }, ctx), base, {
                sessionId: 'fake-none',
                track,
            }),
            'session_not_found'
        );
        expect(tracked.length).toBe(3);
        expect(base.semaphore.active).toBe(0);
        expect(tagAlive(tag)).toBe(false);
    });

    it('waiting for a slot: progress reaches the accepting call; done() on acceptance; a cancel after it is ignored', async () => {
        const { loaded, tag } = h.fakeClaude('echo', '', { FAKE_TURN_MS: '300' });
        const { semaphore, release } = await fullSemaphore();
        const base = h.makeCtx(loaded, { semaphore });
        const { track, tracked } = tracker();
        const { progress, calls } = recorder();
        const client = new AbortController();
        let accepted = false;
        const result = startBackground(ctx => runThronglet(input('claude/fake-small'), ctx), base, {
            track,
            progress,
            signal: client.signal,
        }).finally(() => (accepted = true));

        await waitFor('queued progress', () => calls.includes('queued 1 slot'));
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(accepted, 'accepted while waiting for a slot').toBe(false);
        release();
        const pending = pendingOf(await result);
        expect(pending.state).toBe('running');
        expect(calls).toStrictEqual(['queued 1 slot', 'started', 'done']);

        client.abort();
        const outcome = (await tracked[0]) as RunOutcome;
        expect(outcome.ok, JSON.stringify(outcome.payload)).toBe(true);
        expect(calls.at(-1)).toBe('done');
        expect(tagAlive(tag)).toBe(false);
    });

    it("the accepting call's cancel before the acceptance cancels the run: no slot taken, no agent", async () => {
        const { loaded, tag } = h.fakeClaude('echo');
        const { semaphore, release } = await fullSemaphore();
        const base = h.makeCtx(loaded, { semaphore });
        const { track, tracked } = tracker();
        const { progress, calls } = recorder();
        const client = new AbortController();
        const result = startBackground(ctx => runThronglet(input('claude/fake-small'), ctx), base, {
            track,
            progress,
            signal: client.signal,
        });
        await waitFor('queued progress', () => calls.includes('queued 1 slot'));
        client.abort();
        failureOf(await result, 'cancelled');
        expect(calls.at(-1)).toBe('done');
        expect(semaphore.waiting).toBe(0);
        release();
        expect(semaphore.active).toBe(0);
        expect(((await tracked[0]) as RunOutcome).ok).toBe(false);
        expect(tagAlive(tag)).toBe(false);
    });

    it('send_message on an idle session waiting for a slot is not accepted as queued: a model error fails the call', async () => {
        const { loaded, tag } = h.fakeClaude('echo');
        const { semaphore, release } = await fullSemaphore();
        const base = h.makeCtx(loaded, { semaphore });
        await h.record(base.cacheDir, 'fake-c', { model: 'nope' });
        const { track } = tracker();
        const { progress, calls } = recorder();
        let accepted = false;
        const result = startBackground(ctx => sendMessage({ session_id: 'fake-c', prompt: 'x' }, ctx), base, {
            sessionId: 'fake-c',
            track,
            progress,
        }).finally(() => (accepted = true));

        await waitFor('queued progress', () => calls.includes('queued 1 slot'));
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(accepted, 'accepted while waiting for a slot').toBe(false);
        release();
        failureOf(await result, 'model_rejected');
        expect(calls.at(-1)).toBe('done');
        expect(semaphore.active).toBe(0);
        expect(tagAlive(tag)).toBe(false);
    });

    it("the detached controller on the registry (cancel_thronglet's hook) aborts the turn", async () => {
        const { loaded, tag } = h.fakeClaude('hang');
        const base = h.makeCtx(loaded);
        const { track, tracked } = tracker();
        const pending = pendingOf(
            await startBackground(ctx => runThronglet(input('claude/fake-small'), ctx), base, { track })
        );
        await waitFor('adapter', () => tagAlive(tag));
        const [controller] = base.sessions.turns(pending.session_id);
        expect(controller).toBeDefined();
        controller?.abort();
        const outcome = (await tracked[0]) as RunOutcome;
        expect(outcome.ok ? 'ok' : outcome.payload.code).toBe('cancelled');
        expect(base.sessions.turns(pending.session_id)).toStrictEqual([]);
        expect(tagAlive(tag)).toBe(false);
    });
});
