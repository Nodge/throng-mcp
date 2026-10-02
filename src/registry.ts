import { Semaphore } from './semaphore.ts';

// Live sessions of this process (DESIGN §4): the per-session turn queue of §3.3 and the background turns of §3.6.

interface Entry {
    lock: Semaphore;
    /** The holder plus the waiters; the entry is dropped at zero. */
    users: number;
    /** `idle()` callers, resolved when the entry is dropped. */
    idle: (() => void)[];
    /** Cancel controllers of the turns on this session, running or queued (runCall attaches them); for cancel_thronglet. */
    turns: Set<AbortController>;
}

/** One per server process: turns on one session_id run one after another, FIFO. */
export class SessionRegistry {
    readonly #entries = new Map<string, Entry>();

    /**
     * Resolves with an idempotent release once no other turn holds `sessionId`; `onQueued` fires when the call
     * has to wait. Rejects `cancelled` when `signal` aborts first.
     */
    async acquire(sessionId: string, signal: AbortSignal, onQueued: (waiting: number) => void): Promise<() => void> {
        const entry = this.#entries.get(sessionId) ?? {
            lock: new Semaphore(1, "cancelled while waiting for the session's running turn to end"),
            users: 0,
            idle: [],
            turns: new Set<AbortController>(),
        };
        this.#entries.set(sessionId, entry);
        entry.users++;
        const leave = () => {
            if (--entry.users > 0) return;
            this.#entries.delete(sessionId);
            for (const resolve of entry.idle) resolve();
        };
        const acquiring = entry.lock.acquire(signal);
        if (entry.lock.waiting > 0 && !signal.aborted) onQueued(entry.lock.waiting);
        let release: () => void;
        try {
            release = await acquiring;
        } catch (err) {
            leave();
            throw err;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            release();
            leave();
        };
    }

    /** A turn holds the session (it runs or is about to start). */
    busy(sessionId: string): boolean {
        return this.#entries.has(sessionId);
    }

    /** Calls queued behind the session's running turn. */
    waiting(sessionId: string): number {
        return this.#entries.get(sessionId)?.lock.waiting ?? 0;
    }

    /** Resolves once the session has no running or queued turn in this process; at once when it has none now. */
    idle(sessionId: string): Promise<void> {
        const entry = this.#entries.get(sessionId);
        if (!entry) return Promise.resolve();
        return new Promise(resolve => entry.idle.push(resolve));
    }

    /** Registers a turn's cancel controller on a busy session; returns its detach. A no-op on an idle session. */
    attachTurn(sessionId: string, controller: AbortController): () => void {
        const entry = this.#entries.get(sessionId);
        if (!entry) return () => undefined;
        entry.turns.add(controller);
        return () => entry.turns.delete(controller);
    }

    /** Cancel controllers of the turns attached to the session. */
    turns(sessionId: string): AbortController[] {
        return [...(this.#entries.get(sessionId)?.turns ?? [])];
    }
}
