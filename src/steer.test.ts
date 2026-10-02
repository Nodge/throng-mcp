import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeHarness, tagAlive, waitFor } from '../test/fake-harness.ts';
import { startBackground } from './background.ts';
import { cancelThronglet, stopBoundMs } from './cancel.ts';
import type { RunSuccess, TurnPending } from './contract.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import { SessionRegistry } from './registry.ts';
import type { RunContext, RunOutcome } from './run.ts';
import { readSessionRecord, type SessionRecord } from './sessions.ts';
import { waitThronglet } from './wait.ts';

// send_message steer (DESIGN §3.3) on the fake agent's `steer` scenario: a session's first turn hangs until cancelled.

const h = fakeHarness('throng-steer-');
afterAll(() => h.cleanup());

function code(outcome: RunOutcome | { pending: TurnPending }): string {
    if ('pending' in outcome) return 'pending';
    return outcome.ok ? 'ok' : outcome.payload.code;
}

function text(outcome: RunOutcome): string | undefined {
    return outcome.ok ? outcome.payload.text : outcome.payload.message;
}

/**
 * A shared registry, cache and notes dir; `ctx()` gives a context on its own fake `steer` config (`tag` tells its
 * adapter apart) with `onTurnStarted` reported in `started`.
 */
function sandbox() {
    const sessions = new SessionRegistry();
    const memory = mkdtempSync(join(h.root, 'memory-'));
    const cacheDir = mkdtempSync(join(h.root, 'cache-'));
    const started: string[] = [];
    const ctx = (name: string, overrides: Partial<RunContext> = {}) => {
        const { loaded, tag } = h.fakeClaude('steer', '', { FAKE_MEMORY_DIR: memory });
        const c = h.makeCtx(loaded, {
            sessions,
            cacheDir,
            onTurnStarted: () => started.push(name),
            ...overrides,
        });
        return { ctx: c, tag };
    };
    return { sessions, cacheDir, memory, started, ctx };
}

/** A run_thronglet whose first turn hangs; resolves with its session id once the turn runs. */
async function hangingRun(
    box: ReturnType<typeof sandbox>
): Promise<{ id: string; run: Promise<RunOutcome>; tag: string }> {
    let id: string | undefined;
    const { ctx, tag } = box.ctx('first', {
        onTurnStarted: sessionId => {
            id = sessionId;
            box.started.push('first');
        },
    });
    const run = runThronglet(
        { agent: 'claude/fake-small', prompt: 'first task', cwd: h.work, description: 'steer' },
        ctx
    );
    await waitFor('first turn', () => id !== undefined);
    if (id === undefined) expect.unreachable();
    return { id, run, tag };
}

describe('send_message steer', () => {
    it('cancels the running turn and runs next; its result replaces the cancelled one', async () => {
        const box = sandbox();
        const first = await hangingRun(box);
        let recordAtSteerStart: Promise<SessionRecord | undefined> | undefined;
        let firstAdapterAlive: boolean | undefined;
        const { ctx } = box.ctx('steer', {
            onTurnStarted: id => {
                firstAdapterAlive = tagAlive(first.tag);
                recordAtSteerStart = readSessionRecord(box.cacheDir, id);
                box.started.push('steer');
            },
        });
        const steered = await sendMessage({ session_id: first.id, prompt: 'new direction', steer: true }, ctx);
        const firstOut = await first.run;

        expect(firstOut).toMatchObject({
            ok: false,
            payload: { code: 'cancelled', message: 'cancelled by steer', session_id: first.id },
        });
        expect(code(steered)).toBe('ok');
        expect(text(steered)).toBe('you said: first task | new direction');
        expect(firstAdapterAlive, 'the cancelled turn ends before the steer turn starts').toBe(false);
        expect((await recordAtSteerStart)?.last_error).toMatchObject({
            code: 'cancelled',
            message: 'cancelled by steer',
        });
        const record = await readSessionRecord(box.cacheDir, first.id);
        expect(record?.last_result).toStrictEqual((steered as { payload: RunSuccess }).payload);
        expect(record?.last_error).toBeUndefined();
        expect(box.started).toStrictEqual(['first', 'steer']);
        expect(box.sessions.busy(first.id)).toBe(false);
    });

    it('jumps the queue: the queued message runs after the steer turn', async () => {
        const box = sandbox();
        const first = await hangingRun(box);
        const queued = sendMessage({ session_id: first.id, prompt: 'queued C' }, box.ctx('C').ctx);
        await waitFor('C queued', () => box.sessions.waiting(first.id) === 1);
        let waitingAtSteerStart: number | undefined;
        const steer = box.ctx('S', {
            onTurnStarted: id => {
                waitingAtSteerStart = box.sessions.waiting(id);
                box.started.push('S');
            },
        });
        const steered = sendMessage({ session_id: first.id, prompt: 'steer S', steer: true }, steer.ctx);
        const [firstOut, sOut, cOut] = await Promise.all([first.run, steered, queued]);

        expect(code(firstOut)).toBe('cancelled');
        expect(box.started).toStrictEqual(['first', 'S', 'C']);
        expect(waitingAtSteerStart).toBe(1);
        expect(text(sOut)).toBe('you said: first task | steer S');
        expect(text(cOut)).toBe('you said: first task | steer S | queued C');
        const record = await readSessionRecord(box.cacheDir, first.id);
        expect(record?.last_result?.text).toBe('you said: first task | steer S | queued C');
    });

    it('on an idle session behaves like a plain send_message', async () => {
        const box = sandbox();
        const reply: Record<string, string | undefined> = {};
        for (const [id, steer] of [
            ['fake-plain', false],
            ['fake-steer', true],
        ] as const) {
            await h.record(box.cacheDir, id);
            await writeFile(join(box.memory, `${id}.json`), JSON.stringify({ notes: ['earlier'] }));
            const out = await sendMessage(
                { session_id: id, prompt: 'hello', ...(steer ? { steer } : {}) },
                box.ctx(id).ctx
            );
            expect(code(out)).toBe('ok');
            reply[id] = text(out);
            const record = await readSessionRecord(box.cacheDir, id);
            expect(record?.last_error).toBeUndefined();
            expect(record?.last_result?.text).toBe('you said: earlier | hello');
        }
        expect(reply['fake-steer']).toBe(reply['fake-plain']);
    });

    it('background: accepted as queued behind the turn it cancels; wait_thronglet returns the last queued result', async () => {
        const box = sandbox();
        const first = await hangingRun(box);
        const runs: Promise<unknown>[] = [];
        const track = <T>(p: Promise<T>) => (runs.push(p), p);

        const { ctx } = box.ctx('S');
        const accepted = await startBackground(
            c => sendMessage({ session_id: first.id, prompt: 'steer S', steer: true }, c),
            ctx,
            { track, sessionId: first.id }
        );
        expect(accepted).toStrictEqual({ pending: { session_id: first.id, state: 'queued', queued: 1 } });

        const waited = await waitThronglet(
            { session_id: first.id },
            {
                sessions: box.sessions,
                cacheDir: box.cacheDir,
                signal: new AbortController().signal,
                progress: ctx.progress,
                defaultTimeoutS: 10,
            }
        );
        expect(code(waited)).toBe('ok');
        expect(text(waited as RunOutcome)).toBe('you said: first task | steer S');
        expect(code(await first.run)).toBe('cancelled');
        await Promise.all(runs);

        // Steer on the now idle session in the background: running at once.
        const again = await startBackground(
            c => sendMessage({ session_id: first.id, prompt: 'steer T', steer: true }, c),
            box.ctx('T').ctx,
            { track, sessionId: first.id }
        );
        expect(again).toStrictEqual({ pending: { session_id: first.id, state: 'running', queued: 0 } });
        await Promise.all(runs);
    });

    it('cancel_thronglet after a steer aborts the steered turn and the waiters', async () => {
        const box = sandbox();
        const first = await hangingRun(box);
        const queuedC = sendMessage({ session_id: first.id, prompt: 'queued C' }, box.ctx('C').ctx);
        await waitFor('C queued', () => box.sessions.waiting(first.id) === 1);
        // The steer turn itself hangs, so cancel_thronglet finds it holding the session with C behind it.
        const hang = h.fakeClaude('hang');
        let sRunning = false;
        const steered = sendMessage(
            { session_id: first.id, prompt: 'steer S', steer: true },
            h.makeCtx(hang.loaded, {
                sessions: box.sessions,
                cacheDir: box.cacheDir,
                onTurnStarted: () => (sRunning = true),
            })
        );
        await waitFor('S running', () => sRunning);
        expect(code(await first.run)).toBe('cancelled');
        expect(box.sessions.turns(first.id).length).toBe(2);

        const out = await cancelThronglet(first.id, {
            sessions: box.sessions,
            cacheDir: box.cacheDir,
            stopMs: stopBoundMs({ handshakeMs: 10_000, cancelGraceMs: 1000, exitGraceMs: 300 }),
        });
        expect(out).toStrictEqual({ session_id: first.id, state: 'idle', cancelled_turn: true });
        const [sOut, cOut] = await Promise.all([steered, queuedC]);
        expect(sOut).toMatchObject({
            ok: false,
            payload: { code: 'cancelled', message: 'cancelled by cancel_thronglet' },
        });
        expect(code(cOut)).toBe('cancelled');
        expect(box.started).toStrictEqual(['first']);
        expect(tagAlive(hang.tag)).toBe(false);
        expect(box.sessions.turns(first.id)).toStrictEqual([]);
    });
});
