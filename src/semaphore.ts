import { ThrongError } from './contract.ts';

// Per-process limit on concurrent runs (DESIGN §7).

interface Waiter {
    grant: () => void;
}

/** FIFO counting semaphore; `acquire` resolves with an idempotent release function. */
export class Semaphore {
    readonly #max: number;
    #active = 0;
    #queue: Waiter[] = [];

    constructor(max: number) {
        this.#max = max;
    }

    /** Callers queued behind the running ones. */
    get waiting(): number {
        return this.#queue.length;
    }

    /** Rejects with `cancelled` when `signal` aborts before a slot frees up; the waiter then leaves the queue. */
    acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) return Promise.reject(cancelled());
        if (this.#active < this.#max && this.#queue.length === 0) {
            this.#active++;
            return Promise.resolve(this.#releaser());
        }
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.#queue = this.#queue.filter(w => w !== waiter);
                reject(cancelled());
            };
            const waiter: Waiter = {
                grant: () => {
                    signal?.removeEventListener('abort', onAbort);
                    this.#active++;
                    resolve(this.#releaser());
                },
            };
            this.#queue.push(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    #releaser(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#active--;
            if (this.#active < this.#max) this.#queue.shift()?.grant();
        };
    }
}

function cancelled(): ThrongError {
    return new ThrongError('cancelled', 'cancelled while waiting for a free slot (max_concurrency)');
}
