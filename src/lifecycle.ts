import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { Worker } from './acp/types.ts';
import { type ErrorCode, ThrongError } from './contract.ts';
import type { Semaphore } from './semaphore.ts';

/** setTimeout fires at once above this; a longer timeout_s is effectively "no timeout" anyway. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TurnHooks {
    /** Called first on a cancel or timeout, before `session/cancel` goes out. */
    onCancel(): void;
    /** The cancelled turn settled within the grace period: its usage still counts. */
    onLateStop(response: PromptResponse): void;
}

/**
 * The adapter side of one call (DESIGN §4.2, §7): the semaphore slot, the cancel/timeout race and the worker.
 * Every wait on the adapter goes through `guard`, so a client cancel or a timeout interrupts it with a ThrongError.
 */
export class RunLifecycle {
    readonly #clientSignal: AbortSignal;
    readonly #stop = new AbortController();
    readonly #stopped: Promise<never>;
    readonly #onClientAbort = () => this.#halt('cancelled', 'cancelled by the client');
    #timer: NodeJS.Timeout | undefined;
    #release: (() => void) | undefined;
    #worker: Worker | undefined;
    /** A worker whose handshake outlived a cancel/timeout: closed when it arrives, holding the slot until then. */
    #lingering: Promise<void> | undefined;

    /** `clientSignal` is the MCP call's `extra.signal`: client cancel or transport close. */
    constructor(clientSignal: AbortSignal) {
        this.#clientSignal = clientSignal;
        // #halt is the only abort and always passes a ThrongError.
        this.#stopped = new Promise<never>((_, reject) =>
            this.#stop.signal.addEventListener('abort', () => reject(this.#stop.signal.reason as ThrongError))
        );
        this.#stopped.catch(() => {
            /* ignored */
        });
    }

    /** Waits for a slot; `onQueued` fires when the call has to wait. Rejects `cancelled` if the client cancels meanwhile. */
    async acquire(semaphore: Semaphore, onQueued: (waiting: number) => void): Promise<void> {
        const acquiring = semaphore.acquire(this.#clientSignal);
        if (semaphore.waiting > 0 && !this.#clientSignal.aborted) onQueued(semaphore.waiting);
        this.#release = await acquiring;
    }

    /** Starts the timeout and listens for the client cancel; throws at once when the client has already cancelled. */
    arm(timeoutS: number): void {
        if (this.#clientSignal.aborted) this.#onClientAbort();
        else this.#clientSignal.addEventListener('abort', this.#onClientAbort, { once: true });
        if (this.#stop.signal.aborted) throw this.#stop.signal.reason;
        this.#timer = setTimeout(
            () => this.#halt('timeout', `timed out after ${timeoutS} s`),
            Math.min(timeoutS * 1000, MAX_TIMER_MS)
        );
    }

    /** `p`, unless the call is cancelled or times out first. */
    guard<T>(p: Promise<T>): Promise<T> {
        return Promise.race([p, this.#stopped]);
    }

    /** The handshake under the race. A worker that arrives after a cancel or timeout is closed on arrival. */
    async start(starting: Promise<Worker>): Promise<Worker> {
        try {
            this.#worker = await this.guard(starting);
            return this.#worker;
        } catch (err) {
            if (this.#isStop(err)) {
                this.#lingering = starting.then(
                    late => late.close(),
                    () => {
                        /* ignored */
                    }
                );
            }
            throw err;
        }
    }

    /** One prompt turn under the race; on cancel or timeout the turn is cancelled (DESIGN §4.2) and gets `graceMs` to settle. */
    async turn(prompting: Promise<PromptResponse>, graceMs: number, hooks: TurnHooks): Promise<PromptResponse> {
        prompting.catch(() => {
            /* ignored */
        });
        try {
            return await this.guard(prompting);
        } catch (err) {
            if (this.#isStop(err) && this.#worker) await cancelTurn(this.#worker, prompting, graceMs, hooks);
            throw err;
        }
    }

    /**
     * Stops the timer, closes the worker and gives the slot back; after a lingering handshake the slot is held
     * until that adapter is gone. Runs even after a client cancel: the SDK drops the answer, but the process must not leak.
     */
    async close(): Promise<Worker | undefined> {
        clearTimeout(this.#timer);
        this.#clientSignal.removeEventListener('abort', this.#onClientAbort);
        if (this.#worker) await this.#worker.close();
        const release = this.#release;
        if (release) this.whenGone(release);
        return this.#worker;
    }

    /** After `close`: runs `fn` once no adapter of this call is left, i.e. now or when a lingering handshake settles. */
    whenGone(fn: () => void): void {
        if (this.#lingering) void this.#lingering.finally(fn);
        else fn();
    }

    #halt(code: ErrorCode, message: string): void {
        if (!this.#stop.signal.aborted) this.#stop.abort(new ThrongError(code, message));
    }

    #isStop(err: unknown): boolean {
        return this.#stop.signal.aborted && err === this.#stop.signal.reason;
    }
}

async function cancelTurn(
    worker: Worker,
    prompting: Promise<PromptResponse>,
    graceMs: number,
    hooks: TurnHooks
): Promise<void> {
    hooks.onCancel();
    await worker.cancel().catch(() => {
        /* ignored */
    });
    let graceTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
        prompting.then(
            r => r,
            () => undefined
        ),
        new Promise<undefined>(resolve => (graceTimer = setTimeout(() => resolve(undefined), graceMs))),
    ]);
    clearTimeout(graceTimer);
    if (settled) hooks.onLateStop(settled);
}
