import type { RunFailure, SessionState } from './contract.ts';
import type { SessionRegistry } from './registry.ts';
import { INTERRUPTED_MESSAGE, markTurnInterrupted, pidAlive, type SessionRecord } from './sessions.ts';

// What one session is doing (DESIGN §3.7, §8): this process's registry first, then the record's turn fields.
// Shared by wait_thronglet, list_thronglets and cancel_thronglet.

export const UNRECORDED_MESSAGE = 'turn ended without recording its result';

export interface ResolvedState {
    state: SessionState;
    queued: number;
    /** Pid of the other throng server process that runs the turn. */
    foreign?: number;
    /** The record as it is now: updated when its turn was marked interrupted, `undefined` when it went away meanwhile. */
    record: SessionRecord | undefined;
    /** The interrupted turn could not be marked in the record: the failure to report in place of its `last_error`. */
    failure?: RunFailure;
}

/**
 * Busy here → `running`, or `queued` with messages waiting. Otherwise a turn in the record whose owner is a live
 * foreign pid → `running`; one whose owner is gone (a dead pid, or ours with no turn here) is marked interrupted
 * first. Then `failed` on `last_error`, `idle` otherwise.
 */
export async function resolveState(
    cacheDir: string,
    sessionId: string,
    record: SessionRecord | undefined,
    sessions: SessionRegistry
): Promise<ResolvedState> {
    for (;;) {
        if (sessions.busy(sessionId)) {
            const queued = sessions.waiting(sessionId);
            return { state: queued > 0 ? 'queued' : 'running', queued, record };
        }
        if (record?.turn_started_at === undefined) {
            return { state: record?.last_error ? 'failed' : 'idle', queued: 0, record };
        }
        const pid = record.turn_pid;
        if (pid !== undefined && pid !== process.pid && pidAlive(pid)) {
            return { state: 'running', queued: 0, foreign: pid, record };
        }
        // Its process is gone, or it is ours and not busy: either way nobody will write the result.
        const own = pid === process.pid;
        const stale = own
            ? (r: SessionRecord) => r.turn_pid === process.pid && !sessions.busy(sessionId)
            : (r: SessionRecord) => !pidAlive(r.turn_pid);
        const message = own ? UNRECORDED_MESSAGE : INTERRUPTED_MESSAGE;
        try {
            record = await markTurnInterrupted(cacheDir, sessionId, stale, message);
        } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            return {
                state: 'failed',
                queued: 0,
                record,
                failure: { code: 'transport_lost', message: `${message} (record not updated: ${why})`, duration_s: 0 },
            };
        }
    }
}
