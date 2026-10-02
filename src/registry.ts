import { Semaphore } from './semaphore.ts';

// Live sessions of this process (DESIGN §4): the per-session turn queue of §3.3 and the background turns of §3.6.

interface Entry {
    lock: Semaphore;
    /** The holder plus the waiters; the entry is dropped at zero. */
    users: number;
    /** `idle()` callers, resolved when the entry is dropped. */
    idle: (() => void)[];
    /** Cancel controller of the turn that holds the lock, until it releases or detaches. */
    holder: AbortController | undefined;
    /** Cancel controllers of the turns waiting for the lock, in grant order. */
    waiters: AbortController[];
}

export interface AcquireOptions {
    /** Aborts the wait: the acquire rejects `cancelled`. */
    signal: AbortSignal;
    /** The turn's cancel controller: reported by `holder()`/`turns()` for steer and cancel_thronglet. */
    controller: AbortController;
    /** Fires when the call has to wait, with its position in the queue. */
    onQueued: (position: number) => void;
    /** Wait at the head of the queue, ahead of the earlier waiters (steer, DESIGN §3.3). */
    front?: boolean;
}

/** One per server process: turns on one session_id run one after another, FIFO unless a steer jumps the queue. */
export class SessionRegistry {
    readonly #entries = new Map<string, Entry>();

    /**
     * Resolves with an idempotent release once no other turn holds `sessionId`. Rejects `cancelled` when `signal`
     * aborts first.
     */
    async acquire(sessionId: string, opts: AcquireOptions): Promise<() => void> {
        const { signal, controller, onQueued, front = false } = opts;
        const entry = this.#entries.get(sessionId) ?? {
            lock: new Semaphore(1, "cancelled while waiting for the session's running turn to end"),
            users: 0,
            idle: [],
            holder: undefined,
            waiters: [],
        };
        this.#entries.set(sessionId, entry);
        entry.users++;
        const leave = () => {
            if (--entry.users > 0) return;
            this.#entries.delete(sessionId);
            for (const resolve of entry.idle) resolve();
        };
        const acquiring = entry.lock.acquire(signal, { front });
        const queued = entry.lock.waiting > 0 && !signal.aborted;
        if (queued) {
            if (front) entry.waiters.unshift(controller);
            else entry.waiters.push(controller);
            onQueued(front ? 1 : entry.lock.waiting);
        }
        let release: () => void;
        try {
            release = await acquiring;
        } catch (err) {
            this.#dropWaiter(entry, controller);
            leave();
            throw err;
        }
        // A waiter detached while queued is not reported as the holder either.
        if (!queued || this.#dropWaiter(entry, controller)) entry.holder = controller;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (entry.holder === controller) entry.holder = undefined;
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

    /** Cancel controller of the turn holding the session; `undefined` when idle or once the holder has detached. */
    holder(sessionId: string): AbortController | undefined {
        return this.#entries.get(sessionId)?.holder;
    }

    /** Cancel controllers of the session's turns: the holder (while attached), then the waiters in order. */
    turns(sessionId: string): AbortController[] {
        const entry = this.#entries.get(sessionId);
        if (!entry) return [];
        return [...(entry.holder ? [entry.holder] : []), ...entry.waiters];
    }

    /** Stops reporting `controller` in `holder()`/`turns()`; the lock stays where it is. */
    detachTurn(sessionId: string, controller: AbortController): void {
        const entry = this.#entries.get(sessionId);
        if (!entry) return;
        if (entry.holder === controller) entry.holder = undefined;
        this.#dropWaiter(entry, controller);
    }

    /** Whether `controller` was among the waiters. */
    #dropWaiter(entry: Entry, controller: AbortController): boolean {
        const i = entry.waiters.indexOf(controller);
        if (i < 0) return false;
        entry.waiters.splice(i, 1);
        return true;
    }
}
