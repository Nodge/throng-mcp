import { ThrongError } from './contract.ts';

// Per-process limit on concurrent runs (DESIGN §7); also the per-session lock of registry.ts.

interface Waiter {
    grant: () => void;
}

/** FIFO counting semaphore; `acquire` resolves with an idempotent release function. */
export class Semaphore {
    readonly #max: number;
    readonly #cancelMessage: string;
    #active = 0;
    #queue: Waiter[] = [];

    /** `cancelMessage` is the `cancelled` error of a waiter whose signal aborts. */
    constructor(max: number, cancelMessage = 'cancelled while waiting for a free slot (max_concurrency)') {
        this.#max = max;
        this.#cancelMessage = cancelMessage;
    }

    /** Slots taken. */
    get active(): number {
        return this.#active;
    }

    /** Callers queued behind the running ones. */
    get waiting(): number {
        return this.#queue.length;
    }

    /** Rejects with `cancelled` when `signal` aborts before a slot frees up; the waiter then leaves the queue. */
    acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) return Promise.reject(this.#cancelled());
        if (this.#active < this.#max && this.#queue.length === 0) {
            this.#active++;
            return Promise.resolve(this.#releaser());
        }
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.#queue = this.#queue.filter(w => w !== waiter);
                reject(this.#cancelled());
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

    #cancelled(): ThrongError {
        return new ThrongError('cancelled', this.#cancelMessage);
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
