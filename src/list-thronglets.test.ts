import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeHarness, tagAlive } from '../test/fake-harness.ts';
import { startBackground } from './background.ts';
import type { RunFailure, ThrongletInfo, TurnPending } from './contract.ts';
import { listThronglets } from './list-thronglets.ts';
import { runThronglet } from './mcp/tools/run-thronglet.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import type { RunContext, RunOutcome } from './run.ts';
import { pidAlive, readSessionRecord } from './sessions.ts';

const h = fakeHarness('throng-list-');
afterAll(() => h.cleanup());

const input = (prompt: string) => ({ agent: 'claude/fake-small', prompt, cwd: h.work, description: 'list test' });

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
    const result = await startBackground(start, ctx, { ...(sessionId ? { sessionId } : {}), track });
    expect('pending' in result, JSON.stringify(result)).toBe(true);
    if (!run) expect.unreachable('not tracked');
    return { accepted: (result as { pending: TurnPending }).pending, run };
}

function deadPid(): number {
    let pid = 2 ** 22 - 1;
    while (pidAlive(pid)) pid--;
    return pid;
}

describe('listThronglets', () => {
    it('states across one listing: running, queued, idle, failed, interrupted, foreign; junk skipped; sorted', async () => {
        const hang = h.fakeClaude('hang');
        const echo = h.fakeClaude('echo');
        const ctx = h.makeCtx(hang.loaded);
        const { cacheDir, sessions } = ctx;
        const other = spawn('sleep', ['30'], { stdio: 'ignore' });
        await once(other, 'spawn');
        const runs: Promise<RunOutcome>[] = [];
        try {
            const a = await background(ctx, c => runThronglet(input('A'), c));
            const b = await background(ctx, c => runThronglet(input('B'), c));
            const bId = b.accepted.session_id;
            const b2 = await background(ctx, c => sendMessage({ session_id: bId, prompt: 'B2' }, c), bId);
            expect(b2.accepted.state).toBe('queued');
            runs.push(a.run, b.run, b2.run);
            const c = await runThronglet(input('C'), h.makeCtx(echo.loaded, { sessions, cacheDir }));
            expect(c.ok, JSON.stringify(c.payload)).toBe(true);

            const failure: RunFailure = { code: 'timeout', message: 'timed out after 1 s', duration_s: 1 };
            await h.record(cacheDir, 'fake-failed', {
                last_error: failure,
                effort: 'high',
                last_used_at: '2026-01-04T00:00:00.000Z',
            });
            await h.record(cacheDir, 'fake-dead', {
                turn_started_at: '2026-01-03T00:00:00.000Z',
                turn_pid: deadPid(),
                last_used_at: '2026-01-03T00:00:00.000Z',
            });
            await h.record(cacheDir, 'fake-far', {
                turn_started_at: '2026-01-02T00:00:00.000Z',
                turn_pid: other.pid ?? 0,
                last_used_at: '2026-01-02T00:00:00.000Z',
            });
            await h.record(cacheDir, 'fake-idle', { last_used_at: '2026-01-01T00:00:00.000Z' });
            mkdirSync(join(cacheDir, 'sessions'), { recursive: true });
            writeFileSync(join(cacheDir, 'sessions', 'junk.json'), 'not json');
            writeFileSync(join(cacheDir, 'sessions', 'empty.json'), '{}');

            const { thronglets } = await listThronglets(cacheDir, sessions);
            const byId = new Map(thronglets.map(t => [t.session_id, t]));
            const cId = (c.payload as { session_id: string }).session_id;
            expect(new Set(byId.keys())).toStrictEqual(
                new Set([a.accepted.session_id, bId, cId, 'fake-failed', 'fake-dead', 'fake-far', 'fake-idle'])
            );
            const lastUsed = thronglets.map(t => t.last_used_at);
            expect(lastUsed).toStrictEqual([...lastUsed].sort().reverse());
            expect(thronglets.slice(-4).map(t => t.session_id)).toStrictEqual([
                'fake-failed',
                'fake-dead',
                'fake-far',
                'fake-idle',
            ]);

            const aRow = byId.get(a.accepted.session_id);
            expect(aRow).toMatchObject({
                description: 'list test',
                agent: 'claude/fake-small',
                cwd: h.work,
                state: 'running',
                queued: 0,
            } satisfies Partial<ThrongletInfo>);
            expect(aRow?.last_error).toBe(undefined);
            expect(typeof aRow?.created_at).toBe('string');
            expect(byId.get(bId)).toMatchObject({ state: 'queued', queued: 1 });
            expect(byId.get(cId)).toMatchObject({ state: 'idle', queued: 0 });
            expect(byId.get(cId)?.last_error).toBe(undefined);
            expect(byId.get('fake-failed')).toMatchObject({
                state: 'failed',
                agent: 'claude/fake-small:high',
                last_error: { code: 'timeout', message: 'timed out after 1 s' },
            });
            expect(byId.get('fake-failed')?.last_error).toStrictEqual({
                code: 'timeout',
                message: 'timed out after 1 s',
            });
            expect(byId.get('fake-dead')).toMatchObject({
                state: 'failed',
                last_error: {
                    code: 'transport_lost',
                    message: 'turn interrupted: the throng server process that ran it is gone',
                },
            });
            const dead = await readSessionRecord(cacheDir, 'fake-dead');
            expect(dead?.turn_started_at).toBe(undefined);
            expect(dead?.last_error?.code).toBe('transport_lost');
            expect(byId.get('fake-far')).toMatchObject({ state: 'running', queued: 0 });
            expect(byId.get('fake-far')?.last_error).toBe(undefined);
            expect(byId.get('fake-idle')).toMatchObject({ state: 'idle', queued: 0, description: '' });
        } finally {
            other.kill('SIGKILL');
            for (const id of new Set(
                (await listThronglets(ctx.cacheDir, sessions)).thronglets.map(t => t.session_id)
            )) {
                for (const controller of sessions.turns(id)) controller.abort();
            }
            await Promise.all(runs);
        }
        expect(tagAlive(hang.tag)).toBe(false);
    });

    it('no sessions directory → empty list', async () => {
        const ctx = h.makeCtx(h.fakeClaude('echo').loaded);
        expect(await listThronglets(ctx.cacheDir, ctx.sessions)).toStrictEqual({ thronglets: [] });
    });
});
