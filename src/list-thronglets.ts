import { HARNESS_IDS, type ListThrongletsOutput, type ThrongletInfo } from './contract.ts';
import { log } from './log.ts';
import type { SessionRegistry } from './registry.ts';
import { resolveState } from './session-state.ts';
import { listSessionIds, readSessionRecord, type SessionRecord } from './sessions.ts';

// list_thronglets (DESIGN §3.7): the session records on disk merged with this process's live state.

/**
 * One row per usable session record, most recently used first. A record that can't be read or lacks the fields of
 * a row is skipped with a warning. A new session busy here whose record isn't written yet is not listed.
 */
export async function listThronglets(cacheDir: string, sessions: SessionRegistry): Promise<ListThrongletsOutput> {
    const rows = await Promise.all((await listSessionIds(cacheDir)).map(id => row(cacheDir, id, sessions)));
    const thronglets = rows.filter(r => r !== undefined);
    thronglets.sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));
    return { thronglets };
}

async function row(cacheDir: string, id: string, sessions: SessionRegistry): Promise<ThrongletInfo | undefined> {
    let record: SessionRecord | undefined;
    try {
        record = await readSessionRecord(cacheDir, id);
        if (record === undefined) return undefined;
        if (!usable(record)) {
            log.warn('list_thronglets: skipping a corrupt session record', { session: id });
            return undefined;
        }
        const resolved = await resolveState(cacheDir, id, record, sessions);
        record = resolved.record ?? record;
        const info: ThrongletInfo = {
            session_id: id,
            description: record.description,
            agent: `${record.harness}/${record.model}${record.effort ? `:${record.effort}` : ''}`,
            cwd: record.cwd,
            state: resolved.state,
            queued: resolved.queued,
            accepts_messages: record.resumable !== false,
            created_at: record.created_at,
            last_used_at: record.last_used_at,
        };
        const error = resolved.failure ?? record.last_error;
        if (resolved.state === 'failed' && error) info.last_error = { code: error.code, message: error.message };
        return info;
    } catch (err) {
        log.warn('list_thronglets: skipping an unreadable session record', {
            session: id,
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

function usable(record: SessionRecord): boolean {
    const r = record as Partial<Record<keyof SessionRecord, unknown>> | null;
    return (
        typeof r === 'object' &&
        r !== null &&
        (HARNESS_IDS as readonly unknown[]).includes(r.harness) &&
        typeof r.model === 'string' &&
        typeof r.cwd === 'string' &&
        typeof r.created_at === 'string' &&
        typeof r.last_used_at === 'string'
    );
}
