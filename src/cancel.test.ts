import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeHarness, tagAlive, waitFor } from '../test/fake-harness.ts';
import { startBackground } from './background.ts';
import { cancelThronglet, type CancelDeps, stopBoundMs } from './cancel.ts';
import { ThrongError, type TurnPending } from './contract.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import { noProgress } from './progress.ts';
import type { RunContext, RunOutcome } from './run.ts';
import { SessionRegistry } from './registry.ts';
import { readSessionRecord } from './sessions.ts';
import { waitThronglet } from './wait.ts';

const h = fakeHarness('throng-cancel-');
afterAll(() => h.cleanup());

const input = (prompt: string) => ({ agent: 'claude/fake-small', prompt, cwd: h.work, description: 'cancel test' });

function deps(ctx: RunContext, overrides: Partial<CancelDeps> = {}): CancelDeps {
    return {
        sessions: ctx.sessions,
        cacheDir: ctx.cacheDir,
        stopMs: stopBoundMs({
            handshakeMs: ctx.loaded.config.limits.handshake_s * 1000,
            ...(ctx.cancelGraceMs !== undefined ? { cancelGraceMs: ctx.cancelGraceMs } : {}),
            ...(ctx.exitGraceMs !== undefined ? { exitGraceMs: ctx.exitGraceMs } : {}),
        }),
        ...overrides,
    };
}

function code(outcome: RunOutcome | { pending: TurnPending }): string {
    if ('pending' in outcome) return 'pending';
    return outcome.ok ? 'ok' : outcome.payload.code;
}

/** A registry that calls `onDetach` with the turn's controller when runCall detaches it, i.e. when the outcome is fixed. */
class DetachHookRegistry extends SessionRegistry {
    onDetach: ((controller: AbortController) => void) | undefined;
    override detachTurn(sessionId: string, controller: AbortController): void {
        this.onDetach?.(controller);
        super.detachTurn(sessionId, controller);
    }
}

async function rejection(p: Promise<unknown>): Promise<ThrongError> {
    const err = await p.then(
        () => undefined,
        (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ThrongError);
    return err as ThrongError;
}

describe('cancelThronglet', () => {
    it('a running background turn with a pending wait: cancelled_turn, wait gets cancelled, a new message runs', async () => {
        const hang = h.fakeClaude('hang');
        const echo = h.fakeClaude('echo');
        const ctx = h.makeCtx(hang.loaded);
        let run: Promise<RunOutcome> | undefined;
        const track = <T>(p: Promise<T>) => {
            run = p as unknown as Promise<RunOutcome>;
            return p;
        };
        const accepted = await startBackground(c => runThronglet(input('x'), c), ctx, { track });
        if (!('pending' in accepted)) expect.unreachable(JSON.stringify(accepted));
        const id = accepted.pending.session_id;
        await waitFor('adapter', () => tagAlive(hang.tag));
        const waiting = waitThronglet(
            { session_id: id },
            {
                sessions: ctx.sessions,
                cacheDir: ctx.cacheDir,
                signal: new AbortController().signal,
                progress: noProgress,
                defaultTimeoutS: 30,
            }
        );

        expect(await cancelThronglet(id, deps(ctx))).toStrictEqual({
            session_id: id,
            state: 'idle',
            cancelled_turn: true,
        });
        expect(ctx.sessions.busy(id)).toBe(false);
        expect(tagAlive(hang.tag)).toBe(false);
        const waited = await waiting;
        expect(waited).toMatchObject({
            ok: false,
            payload: { code: 'cancelled', message: 'cancelled by cancel_thronglet', session_id: id },
        });
        expect(code(await (run ?? Promise.reject(new Error('not tracked'))))).toBe('cancelled');
        expect((await readSessionRecord(ctx.cacheDir, id))?.last_error?.code).toBe('cancelled');

        const next = await sendMessage(
            { session_id: id, prompt: 'again' },
            h.makeCtx(echo.loaded, { sessions: ctx.sessions, cacheDir: ctx.cacheDir })
        );
        expect(code(next)).toBe('ok');
    });

    it('a queued synchronous send_message fails cancelled; the queue is empty afterwards', async () => {
        const hang = h.fakeClaude('hang');
        const ctx = h.makeCtx(hang.loaded);
        await h.record(ctx.cacheDir, 'fake-q');
        const a = sendMessage({ session_id: 'fake-q', prompt: 'A' }, ctx);
        await waitFor('A holds the session', () => ctx.sessions.busy('fake-q'));
        const b = sendMessage({ session_id: 'fake-q', prompt: 'B' }, ctx);
        await waitFor('B queued', () => ctx.sessions.waiting('fake-q') === 1);

        expect((await cancelThronglet('fake-q', deps(ctx))).cancelled_turn).toBe(true);
        const [aOut, bOut] = await Promise.all([a, b]);
        expect(code(aOut)).toBe('cancelled');
        expect(bOut).toMatchObject({
            ok: false,
            payload: { code: 'cancelled', message: 'cancelled by cancel_thronglet' },
        });
        expect(ctx.sessions.waiting('fake-q')).toBe(0);
        expect(ctx.sessions.busy('fake-q')).toBe(false);
        expect(tagAlive(hang.tag)).toBe(false);
    });

    it('an idle session: cancelled_turn false, the record untouched', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        await h.record(ctx.cacheDir, 'fake-idle');
        const path = join(ctx.cacheDir, 'sessions', 'fake-idle.json');
        const before = readFileSync(path, 'utf8');
        expect(await cancelThronglet('fake-idle', deps(ctx))).toStrictEqual({
            session_id: 'fake-idle',
            state: 'idle',
            cancelled_turn: false,
        });
        expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('unknown id → session_not_found', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        const err = await rejection(cancelThronglet('fake-nope', deps(ctx)));
        expect(err.code).toBe('session_not_found');
    });

    it('a turn of another live throng process → agent_error, the record untouched', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        const other = spawn('sleep', ['30'], { stdio: 'ignore' });
        await once(other, 'spawn');
        try {
            const pid = other.pid ?? 0;
            await h.record(ctx.cacheDir, 'fake-far', { turn_started_at: new Date().toISOString(), turn_pid: pid });
            const err = await rejection(cancelThronglet('fake-far', deps(ctx)));
            expect(err.code).toBe('agent_error');
            expect(err.message).toBe(
                `turn of fake-far runs in another throng server process (pid ${pid}); cancel it from the session that started it`
            );
            expect((await readSessionRecord(ctx.cacheDir, 'fake-far'))?.turn_pid).toBe(pid);
        } finally {
            other.kill('SIGKILL');
        }
    });

    it('a turn whose outcome is fixed is not cancelled: cancelled_turn false, the result stands', async () => {
        const sessions = new DetachHookRegistry();
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded, { sessions });
        await h.record(ctx.cacheDir, 'fake-done');
        let cancelling: ReturnType<typeof cancelThronglet> | undefined;
        let busyAtCancel = false;
        // Right after detach: the adapter close and the record write are still ahead, the session is still busy.
        sessions.onDetach = () =>
            queueMicrotask(() => {
                busyAtCancel = sessions.busy('fake-done');
                cancelling = cancelThronglet('fake-done', deps(ctx));
            });
        const out = await sendMessage({ session_id: 'fake-done', prompt: 'hi' }, ctx);
        expect(code(out)).toBe('ok');
        if (!cancelling) expect.unreachable('cancel not started');
        expect(busyAtCancel).toBe(true);
        expect(await cancelling).toStrictEqual({ session_id: 'fake-done', state: 'idle', cancelled_turn: false });
        const record = await readSessionRecord(ctx.cacheDir, 'fake-done');
        expect(record?.last_result).toBeDefined();
        expect(record?.last_error).toBeUndefined();
    });

    it('a cancel that lands after the last guard but before the outcome is fixed still wins', async () => {
        const sessions = new DetachHookRegistry();
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded, { sessions });
        await h.record(ctx.cacheDir, 'fake-late');
        sessions.onDetach = controller => controller.abort();
        const out = await sendMessage({ session_id: 'fake-late', prompt: 'hi' }, ctx);
        expect(out).toMatchObject({
            ok: false,
            payload: { code: 'cancelled', message: 'cancelled by cancel_thronglet', session_id: 'fake-late' },
        });
        expect((await readSessionRecord(ctx.cacheDir, 'fake-late'))?.last_error?.code).toBe('cancelled');
    });

    it('a holder that does not stop within stopMs → agent_error', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        const release = await ctx.sessions.acquire('fake-stuck', {
            signal: new AbortController().signal,
            controller: new AbortController(),
            onQueued: () => undefined,
        });
        try {
            const err = await rejection(cancelThronglet('fake-stuck', deps(ctx, { stopMs: 1000 })));
            expect(err.code).toBe('agent_error');
            expect(err.message).toBe('turn of fake-stuck did not stop within 1 s');
        } finally {
            release();
        }
    });
});
