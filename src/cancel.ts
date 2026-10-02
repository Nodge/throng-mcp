import { DEFAULT_EXIT_GRACE_MS } from './acp/worker.ts';
import { type CancelThrongletOutput, ThrongError } from './contract.ts';
import type { SessionRegistry } from './registry.ts';
import { DEFAULT_CANCEL_GRACE_MS } from './run.ts';
import { resolveState } from './session-state.ts';
import { loadSessionRecord } from './sessions.ts';

// cancel_thronglet (DESIGN §3.8): the running turn and every queued one on the session, in this process.

export interface CancelDeps {
    sessions: SessionRegistry;
    cacheDir: string;
    /** How long the cancelled turns get to end; `stopBoundMs()` of the run's grace periods. */
    stopMs: number;
}

/**
 * The longest a cancelled turn takes to end: the cancelled prompt's grace or, for a cancel during the handshake, the
 * handshake that has to settle first (the adapter is closed when it arrives); then the worker close (stdin close,
 * SIGTERM, SIGKILL, `exitGraceMs` each) and 5 s of slack.
 */
export function stopBoundMs(limits: { handshakeMs: number; cancelGraceMs?: number; exitGraceMs?: number }): number {
    const { handshakeMs, cancelGraceMs = DEFAULT_CANCEL_GRACE_MS, exitGraceMs = DEFAULT_EXIT_GRACE_MS } = limits;
    return Math.max(handshakeMs, cancelGraceMs) + 3 * exitGraceMs + 5000;
}

/**
 * Aborts every turn of the session in this process and resolves once the session is idle. `cancelled_turn` is false
 * when nothing was left to cancel: an idle session, or a turn whose outcome is already fixed and is only shutting its
 * adapter down. Throws `session_not_found` for an unknown id and `agent_error` for a turn of another throng process
 * or one that outlives `stopMs`.
 */
export async function cancelThronglet(sessionId: string, deps: CancelDeps): Promise<CancelThrongletOutput> {
    const { sessions } = deps;
    if (!sessions.busy(sessionId)) {
        const record = await loadSessionRecord(deps.cacheDir, sessionId);
        const resolved = await resolveState(deps.cacheDir, sessionId, record, sessions);
        if (resolved.foreign !== undefined) {
            throw new ThrongError(
                'agent_error',
                `turn of ${sessionId} runs in another throng server process (pid ${resolved.foreign}); cancel it from the session that started it`
            );
        }
        if (!sessions.busy(sessionId)) return { session_id: sessionId, state: 'idle', cancelled_turn: false };
    }

    // The running turn goes through session/cancel and records `cancelled`; queued ones leave the queue `cancelled`.
    // runCall detaches its controller once the outcome is fixed, so none left means the holder is only tearing down.
    const turns = sessions.turns(sessionId);
    for (const controller of turns) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
        sessions.idle(sessionId).then(() => true),
        new Promise<false>(resolve => (timer = setTimeout(() => resolve(false), deps.stopMs))),
    ]);
    clearTimeout(timer);
    if (!stopped) {
        throw new ThrongError(
            'agent_error',
            `turn of ${sessionId} did not stop within ${Math.round(deps.stopMs / 1000)} s`
        );
    }
    return { session_id: sessionId, state: 'idle', cancelled_turn: turns.length > 0 };
}
