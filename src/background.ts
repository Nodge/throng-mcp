import type { TurnPending } from './contract.ts';
import { log } from './log.ts';
import { noProgress, type Progress } from './progress.ts';
import type { RunContext, RunOutcome } from './run.ts';

// `background: true` (DESIGN §3.6): the same runCall under a detached context; the caller gets the acceptance.

export interface BackgroundOptions {
    /** send_message's session: known up front, so a turn queued behind the session's running turn is accepted at once. */
    sessionId?: string;
    /** Marks the detached run in flight, so that shutdown waits for it. */
    track: <T>(p: Promise<T>) => Promise<T>;
    /**
     * The accepting call's progress, fed until the acceptance: a wait for a slot or the handshake keeps the client's
     * idle timeout away. `done()` on the acceptance or the outcome.
     */
    progress?: Progress;
    /** The accepting call's signal: cancels the run until it is accepted, ignored after (no turn to lose before). */
    signal?: AbortSignal;
}

/**
 * Starts the run detached from the client's call and resolves with whichever comes first: the acceptance (the turn
 * runs, or is queued behind the running turn of a known session) or the run's own outcome, i.e. a failure before the
 * turn started. The outcome itself lands in the session record (runCall); nothing here holds it.
 */
export function startBackground(
    start: (ctx: RunContext) => Promise<RunOutcome>,
    base: Omit<RunContext, 'signal' | 'progress' | 'onTurnStarted'>,
    opts: BackgroundOptions
): Promise<RunOutcome | { pending: TurnPending }> {
    // After the acceptance only cancel_thronglet aborts it: cancelling the accepting call must not kill the turn.
    const controller = new AbortController();
    const forward = opts.progress ?? noProgress;
    const clientSignal = opts.signal;
    const onClientAbort = () => controller.abort();
    let settled = false;
    let detach: (() => void) | undefined;
    const settle = () => {
        settled = true;
        clientSignal?.removeEventListener('abort', onClientAbort);
        forward.done();
    };
    if (clientSignal?.aborted) controller.abort();
    else clientSignal?.addEventListener('abort', onClientAbort, { once: true });

    return new Promise(resolve => {
        const accept = (sessionId: string, state: TurnPending['state']) => {
            if (settled) return;
            settle();
            detach = base.sessions.attachTurn(sessionId, controller);
            resolve({ pending: { session_id: sessionId, state, queued: base.sessions.waiting(sessionId) } });
        };
        const finish = (outcome: RunOutcome) => {
            if (!settled) settle();
            detach?.();
            resolve(outcome);
        };
        const { sessionId } = opts;
        const progress: Progress = {
            ...noProgress,
            // Only a wait behind the session's turn is accepted as queued: before a slot comes free the handshake and
            // model errors are still ahead, and they fail the call itself.
            queued: (position, behind) => {
                if (behind === 'session' && sessionId !== undefined) accept(sessionId, 'queued');
                else forward.queued(position, behind);
            },
            started: () => forward.started(),
        };
        opts.track(
            start({ ...base, signal: controller.signal, progress, onTurnStarted: id => accept(id, 'running') })
        ).then(finish, (err: unknown) => {
            // runCall never throws; this only keeps a bug from becoming an unhandled rejection.
            const message = err instanceof Error ? err.message : String(err);
            log.error('background run threw', { error: message });
            finish({ ok: false, payload: { code: 'agent_error', message, duration_s: 0 } });
        });
    });
}
