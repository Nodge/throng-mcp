import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Effort, HARNESS_IDS, type HarnessId, type RunFailure, type RunSuccess, ThrongError } from './contract.ts';
import { log } from './log.ts';

// Session records under <cacheDir>/sessions (DESIGN §8), keyed by the harness's own ACP session id.

export interface SessionRecord {
    harness: HarnessId;
    model: string;
    effort?: Effort;
    cwd: string;
    /** From run_thronglet; records written before it existed read as `""`. */
    description: string;
    created_at: string;
    last_used_at: string;
    /** Set while a turn runs (ISO); cleared together with `turn_pid` when the turn's outcome is written. */
    turn_started_at?: string;
    /** The throng server process running the turn: records are shared by every server instance on the machine. */
    turn_pid?: number;
    /** The last finished turn's success payload; never together with `last_error`. */
    last_result?: RunSuccess;
    /** The last finished turn's failure payload; never together with `last_result`. */
    last_error?: RunFailure;
}

export const INTERRUPTED_MESSAGE = 'turn interrupted: the throng server process that ran it is gone';

/** `THRONG_MCP_CACHE_DIR` or `~/.cache/throng`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty variable means unset
    return env.THRONG_MCP_CACHE_DIR || join(homedir(), '.cache', 'throng');
}

/** A session id becomes a file name: anything that could leave the directory is refused. */
export function isSafeName(name: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function recordPath(dir: string, sessionId: string): string {
    if (!isSafeName(sessionId)) throw new Error(`session id ${JSON.stringify(sessionId)} is not usable as a file name`);
    return join(dir, 'sessions', `${sessionId}.json`);
}

async function writeAtomic(path: string, content: string): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, content);
        await rename(tmp, path);
    } catch (err) {
        await unlink(tmp).catch(() => {
            /* ignored */
        });
        throw err;
    }
}

export async function writeSessionRecord(dir: string, sessionId: string, record: SessionRecord): Promise<void> {
    const path = recordPath(dir, sessionId);
    await mkdir(join(dir, 'sessions'), { recursive: true });
    await writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** `undefined` when there is no such record. Not validated beyond JSON: the caller checks the fields it uses. */
export async function readSessionRecord(dir: string, sessionId: string): Promise<SessionRecord | undefined> {
    if (!isSafeName(sessionId)) return undefined;
    try {
        const record = JSON.parse(await readFile(recordPath(dir, sessionId), 'utf8')) as Partial<SessionRecord> | null;
        if (typeof record === 'object' && record !== null && typeof record.description !== 'string') {
            return { ...record, description: '' } as SessionRecord;
        }
        return (record ?? undefined) as SessionRecord | undefined;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
    }
}

/**
 * Read-merge-write of an existing record, atomic like every write; a missing record stays missing (`undefined`).
 * A patch's `last_result` drops `last_error` and vice versa; a function gets the current record and returns the new one.
 */
export async function updateSessionRecord(
    dir: string,
    sessionId: string,
    update: Partial<SessionRecord> | ((record: SessionRecord) => SessionRecord)
): Promise<SessionRecord | undefined> {
    const record = await readSessionRecord(dir, sessionId);
    if (!record) return undefined;
    let next: SessionRecord;
    if (typeof update === 'function') {
        next = update(record);
    } else {
        next = { ...record, ...update };
        if (update.last_result) delete next.last_error;
        if (update.last_error) delete next.last_result;
    }
    await writeAtomic(recordPath(dir, sessionId), `${JSON.stringify(next, null, 2)}\n`);
    return next;
}

/** Sets `last_used_at`; a missing record stays missing. */
export async function touchSessionRecord(dir: string, sessionId: string, at: Date = new Date()): Promise<void> {
    await updateSessionRecord(dir, sessionId, { last_used_at: at.toISOString() });
}

/** The record update that closes a turn: its outcome replaces the previous one, the turn fields go. */
export function endTurn(
    outcome: { ok: true; payload: RunSuccess } | { ok: false; payload: RunFailure },
    at: Date
): (record: SessionRecord) => SessionRecord {
    return record => {
        const next: SessionRecord = { ...record, last_used_at: at.toISOString() };
        delete next.turn_started_at;
        delete next.turn_pid;
        delete next.last_result;
        delete next.last_error;
        if (outcome.ok) next.last_result = outcome.payload;
        else next.last_error = outcome.payload;
        return next;
    };
}

/** `process.kill(pid, 0)` succeeds or fails with EPERM (alive, someone else's). */
export function pidAlive(pid: number | undefined): boolean {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Ends a turn whose result will never be written: `last_error` = `transport_lost` with `message`. Applied only while
 * the record still has `turn_started_at` and `stale` holds (re-checked on the fresh read); returns the record as it is now.
 */
export async function markTurnInterrupted(
    dir: string,
    sessionId: string,
    stale: (record: SessionRecord) => boolean = record => !pidAlive(record.turn_pid),
    message: string = INTERRUPTED_MESSAGE
): Promise<SessionRecord | undefined> {
    return updateSessionRecord(dir, sessionId, record => {
        if (record.turn_started_at === undefined || !stale(record)) return record;
        const next = endTurn(
            { ok: false, payload: { code: 'transport_lost', message, duration_s: 0 } },
            new Date()
        )(record);
        next.last_used_at = record.last_used_at;
        return next;
    });
}

/**
 * Startup: every record whose turn ran in a process that is gone gets the interrupted `last_error`. Our own pid can't
 * own a turn yet, so a record carrying it is a recycled pid and counts as gone too. Never throws.
 */
export async function markInterrupted(dir: string): Promise<void> {
    const gone = (record: SessionRecord) => record.turn_pid === process.pid || !pidAlive(record.turn_pid);
    for (const sessionId of await listSessionIds(dir)) {
        try {
            const record = await readSessionRecord(dir, sessionId);
            if (record?.turn_started_at === undefined || !gone(record)) continue;
            await markTurnInterrupted(dir, sessionId, gone);
            log.info('turn marked interrupted', {
                session: sessionId,
                pid: record.turn_pid,
                turn_started_at: record.turn_started_at,
            });
        } catch (err) {
            log.warn('markInterrupted: cannot update', {
                session: sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/** Ids of the session records on disk; `[]` when there are none or the directory is unreadable (logged). */
export async function listSessionIds(dir: string): Promise<string[]> {
    try {
        const names = await readdir(join(dir, 'sessions'));
        return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
            log.warn('cannot list session records', { dir, error: String(err) });
        return [];
    }
}

/** Any record we can't use is `session_not_found`: missing, unsafe id, unreadable or corrupt file. */
export async function loadSessionRecord(dir: string, sessionId: string): Promise<SessionRecord> {
    const id = JSON.stringify(sessionId);
    let record: SessionRecord | undefined;
    try {
        record = await readSessionRecord(dir, sessionId);
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new ThrongError('session_not_found', `session record for ${id} is unreadable: ${why}`);
    }
    if (!record)
        throw new ThrongError(
            'session_not_found',
            `no session record for ${id} (records live 14 days under ${dir}/sessions)`
        );
    if (
        !(HARNESS_IDS as readonly unknown[]).includes(record.harness) ||
        typeof record.model !== 'string' ||
        typeof record.cwd !== 'string'
    ) {
        throw new ThrongError('session_not_found', `session record for ${id} is corrupt: ${JSON.stringify(record)}`);
    }
    return record;
}

/** Deletes session records older than `maxAgeDays` by mtime. Never throws. */
export async function rotate(dir: string, maxAgeDays = 14, now: number = Date.now()): Promise<void> {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    const base = join(dir, 'sessions');
    let names: string[];
    try {
        names = await readdir(base);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
            log.warn('rotate: cannot list', { dir: base, error: String(err) });
        return;
    }
    for (const name of names) {
        const path = join(base, name);
        try {
            const info = await stat(path);
            if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
        } catch (err) {
            log.warn('rotate: cannot remove', { path, error: err instanceof Error ? err.message : String(err) });
        }
    }
}
