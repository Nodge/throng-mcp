import { ThrongError, type TurnPending } from './contract.ts';
import type { Progress } from './progress.ts';
import type { SessionRegistry } from './registry.ts';
import type { RunOutcome } from './run.ts';
import { resolveState } from './session-state.ts';
import { loadSessionRecord, type SessionRecord } from './sessions.ts';

// wait_thronglet (DESIGN §3.6): the last turn's outcome from the session record, once the session is idle.

export interface WaitInput {
    session_id: string;
    timeout_s?: number | undefined;
}

export interface WaitDeps {
    sessions: SessionRegistry;
    cacheDir: string;
    /** The MCP call's signal: a client cancel stops the wait. */
    signal: AbortSignal;
    progress: Progress;
    /** `timeout_s` when the input has none: config `limits.timeout_s`. */
    defaultTimeoutS: number;
    /** How often a turn running in another throng process is re-checked; 1000 by default. */
    pollMs?: number;
}

const DEFAULT_POLL_MS = 1000;
/** setTimeout fires at once above this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Resolves with the last turn's outcome once no turn on the session runs or waits (in this process; a turn of another
 * throng process is polled through its record), or with the pending state when `timeout_s` elapses or the client cancels.
 */
export async function waitThronglet(input: WaitInput, deps: WaitDeps): Promise<RunOutcome | { pending: TurnPending }> {
    const { sessions, cacheDir } = deps;
    const id = input.session_id;
    const timeoutMs = Math.min((input.timeout_s ?? deps.defaultTimeoutS) * 1000, MAX_TIMER_MS);
    const stop = AbortSignal.any([deps.signal, AbortSignal.timeout(timeoutMs)]);
    const pending = (): { pending: TurnPending } => {
        const queued = sessions.waiting(id);
        return { pending: { session_id: id, state: queued > 0 ? 'queued' : 'running', queued } };
    };

    deps.progress.waiting();
    try {
        for (;;) {
            if (sessions.busy(id)) {
                if (!(await until(sessions.idle(id), stop))) return pending();
                continue;
            }
            let record: SessionRecord;
            try {
                record = await loadSessionRecord(cacheDir, id);
            } catch (err) {
                if (sessions.busy(id)) continue;
                const e = err instanceof ThrongError ? err : new ThrongError('session_not_found', String(err));
                return { ok: false, payload: { code: e.code, message: e.message, duration_s: 0 } };
            }
            // A turn of this process may have taken the session while the record was read.
            if (sessions.busy(id)) continue;
            const resolved = await resolveState(cacheDir, id, record, sessions);
            if (resolved.failure) return { ok: false, payload: resolved.failure };
            if (resolved.foreign !== undefined) {
                if (!(await until(sleep(deps.pollMs ?? DEFAULT_POLL_MS), stop))) return pending();
                continue;
            }
            // Busy again, or the record went away: look again.
            if (resolved.state === 'running' || resolved.state === 'queued' || !resolved.record) continue;
            record = resolved.record;
            if (record.last_result) return { ok: true, payload: record.last_result };
            if (record.last_error) return { ok: false, payload: record.last_error };
            return {
                ok: false,
                payload: { code: 'empty_result', message: `no turn result recorded for session ${id}`, duration_s: 0 },
            };
        }
    } finally {
        deps.progress.done();
    }
}

/** `true` once `p` resolves, `false` if `signal` aborts first. */
function until(p: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        const onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
        void p.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms).unref());
}
