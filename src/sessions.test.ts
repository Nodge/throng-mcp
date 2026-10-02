import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunFailure, RunSuccess } from './contract.ts';
import {
    cacheDir,
    endTurn,
    markInterrupted,
    pidAlive,
    readSessionRecord,
    rotate,
    type SessionRecord,
    touchSessionRecord,
    updateSessionRecord,
    writeSessionRecord,
} from './sessions.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-sessions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base: SessionRecord = {
    harness: 'claude',
    model: 'fake-small',
    cwd: '/tmp',
    description: 'x',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: '2026-01-01T00:00:00.000Z',
};
const success: RunSuccess = {
    session_id: 's',
    text: 'done',
    stop_reason: 'end_turn',
    usage: {},
    duration_s: 1,
};
const failure: RunFailure = { code: 'timeout', message: 'timed out after 1 s', session_id: 's', duration_s: 1 };

/** A pid no process has: the largest macOS/Linux pid range ends below it, checked rather than assumed. */
function deadPid(): number {
    for (let pid = 2 ** 22 - 1; pid > 2 ** 21; pid--) if (!pidAlive(pid)) return pid;
    throw new Error('no dead pid found');
}

describe('sessions', () => {
    it('cacheDir honours THRONG_MCP_CACHE_DIR', () => {
        expect(cacheDir({ THRONG_MCP_CACHE_DIR: '/x/y' })).toBe('/x/y');
        expect(cacheDir({})).toMatch(/\.cache\/throng$/);
    });

    it('write / read / touch round-trip, atomic (no temp files left)', async () => {
        const dir = join(root, 'rt');
        const record = {
            harness: 'claude' as const,
            model: 'fake-small',
            effort: 'high' as const,
            cwd: '/tmp',
            description: 'round trip',
            created_at: '2026-01-01T00:00:00.000Z',
            last_used_at: '2026-01-01T00:00:00.000Z',
        };
        await writeSessionRecord(dir, 'sess-1', record);
        expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['sess-1.json']);
        expect(await readSessionRecord(dir, 'sess-1')).toStrictEqual(record);
        await touchSessionRecord(dir, 'sess-1', new Date('2026-02-02T00:00:00.000Z'));
        expect(await readSessionRecord(dir, 'sess-1')).toStrictEqual({
            ...record,
            last_used_at: '2026-02-02T00:00:00.000Z',
        });
        expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['sess-1.json']);
        expect(await readSessionRecord(dir, 'missing')).toBe(undefined);
        await touchSessionRecord(dir, 'missing');
        expect(existsSync(join(dir, 'sessions', 'missing.json'))).toBe(false);
    });

    it('a record written before description existed reads with description ""', async () => {
        const dir = join(root, 'legacy');
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        const legacy = {
            harness: 'codex',
            model: 'gpt',
            cwd: '/tmp',
            created_at: '2026-01-01T00:00:00.000Z',
            last_used_at: '2026-01-01T00:00:00.000Z',
        };
        writeFileSync(join(dir, 'sessions', 'old-1.json'), JSON.stringify(legacy));
        expect(await readSessionRecord(dir, 'old-1')).toStrictEqual({ ...legacy, description: '' });
    });

    it('refuses session ids that would escape the directory', async () => {
        const dir = join(root, 'unsafe');
        await expect(
            writeSessionRecord(dir, '../evil', {
                harness: 'claude',
                model: 'm',
                cwd: '/',
                description: '',
                created_at: '',
                last_used_at: '',
            })
        ).rejects.toThrow();
        expect(await readSessionRecord(dir, '../evil')).toBe(undefined);
    });

    it('rotate deletes old session records, keeps fresh ones; a missing dir is fine', async () => {
        const dir = join(root, 'rot');
        await rotate(dir);
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
        writeFileSync(join(dir, 'sessions', 'old.json'), '{}');
        utimesSync(join(dir, 'sessions', 'old.json'), old, old);
        writeFileSync(join(dir, 'sessions', 'fresh.json'), '{}');
        await rotate(dir);
        expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['fresh.json']);
    });

    it('updateSessionRecord merges a patch atomically; a missing record stays missing', async () => {
        const dir = join(root, 'upd');
        await writeSessionRecord(dir, 'u-1', base);
        const next = await updateSessionRecord(dir, 'u-1', {
            turn_started_at: '2026-01-02T00:00:00.000Z',
            turn_pid: 42,
        });
        expect(next).toStrictEqual({ ...base, turn_started_at: '2026-01-02T00:00:00.000Z', turn_pid: 42 });
        expect(await readSessionRecord(dir, 'u-1')).toStrictEqual(next);
        expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['u-1.json']);
        expect(await updateSessionRecord(dir, 'nope', { turn_pid: 1 })).toBe(undefined);
        expect(existsSync(join(dir, 'sessions', 'nope.json'))).toBe(false);
    });

    it('last_result and last_error replace each other, by patch and by endTurn', async () => {
        const dir = join(root, 'excl');
        await writeSessionRecord(dir, 'x-1', { ...base, last_result: success });
        await updateSessionRecord(dir, 'x-1', { last_error: failure });
        expect(await readSessionRecord(dir, 'x-1')).toStrictEqual({ ...base, last_error: failure });
        await updateSessionRecord(dir, 'x-1', { last_result: success });
        expect(await readSessionRecord(dir, 'x-1')).toStrictEqual({ ...base, last_result: success });

        await updateSessionRecord(dir, 'x-1', { turn_started_at: '2026-01-02T00:00:00.000Z', turn_pid: 42 });
        const at = new Date('2026-01-03T00:00:00.000Z');
        await updateSessionRecord(dir, 'x-1', endTurn({ ok: false, payload: failure }, at));
        expect(await readSessionRecord(dir, 'x-1')).toStrictEqual({
            ...base,
            last_used_at: at.toISOString(),
            last_error: failure,
        });
        await updateSessionRecord(dir, 'x-1', endTurn({ ok: true, payload: success }, at));
        expect(await readSessionRecord(dir, 'x-1')).toStrictEqual({
            ...base,
            last_used_at: at.toISOString(),
            last_result: success,
        });
    });

    it('pidAlive: our pid and pid 1 (EPERM) are alive, an unused pid is not', () => {
        expect(pidAlive(process.pid)).toBe(true);
        expect(pidAlive(1)).toBe(true);
        expect(pidAlive(deadPid())).toBe(false);
        expect(pidAlive(undefined)).toBe(false);
    });

    it('markInterrupted: a turn of a dead or recycled pid becomes transport_lost; a live pid, an idle record and junk stay', async () => {
        const dir = join(root, 'intr');
        const turn = { turn_started_at: '2026-01-02T00:00:00.000Z' };
        const interrupted = {
            ...base,
            last_error: {
                code: 'transport_lost',
                message: 'turn interrupted: the throng server process that ran it is gone',
                duration_s: 0,
            },
        };
        await writeSessionRecord(dir, 'dead', { ...base, ...turn, turn_pid: deadPid(), last_result: success });
        // At startup nothing of ours can be running: our own pid in a record means the pid was recycled.
        await writeSessionRecord(dir, 'recycled', { ...base, ...turn, turn_pid: process.pid });
        await writeSessionRecord(dir, 'live', { ...base, ...turn, turn_pid: process.ppid });
        await writeSessionRecord(dir, 'idle', { ...base, last_result: success });
        writeFileSync(join(dir, 'sessions', 'junk.json'), '{');
        await markInterrupted(dir);
        expect(await readSessionRecord(dir, 'dead')).toStrictEqual(interrupted);
        expect(await readSessionRecord(dir, 'recycled')).toStrictEqual(interrupted);
        expect(await readSessionRecord(dir, 'live')).toStrictEqual({ ...base, ...turn, turn_pid: process.ppid });
        expect(await readSessionRecord(dir, 'idle')).toStrictEqual({ ...base, last_result: success });
        await markInterrupted(join(root, 'no-such-dir'));
    });
});
