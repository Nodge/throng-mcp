import { describe, expect, it } from 'vitest';
import { ThrongError } from './contract.ts';
import { SessionRegistry } from './registry.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const never = new AbortController().signal;

describe('SessionRegistry', () => {
    it('one holder per session, waiters FIFO; release of the last one deletes the entry', async () => {
        const registry = new SessionRegistry();
        const queued: number[] = [];
        const onQueued = (n: number) => queued.push(n);
        const order: string[] = [];
        const a = await registry.acquire('s', never, onQueued);
        expect(registry.busy('s')).toBe(true);
        expect(registry.busy('other')).toBe(false);
        const b = registry.acquire('s', never, onQueued).then(r => (order.push('b'), r));
        const c = registry.acquire('s', never, onQueued).then(r => (order.push('c'), r));
        const d = registry.acquire('s', never, onQueued).then(r => (order.push('d'), r));
        expect(queued).toStrictEqual([1, 2, 3]);
        expect(registry.waiting('s')).toBe(3);
        await tick();
        expect(order).toStrictEqual([]);

        a();
        a();
        const releaseB = await b;
        expect(order).toStrictEqual(['b']);
        expect(registry.waiting('s')).toBe(2);
        releaseB();
        const releaseC = await c;
        releaseC();
        const releaseD = await d;
        expect(order).toStrictEqual(['b', 'c', 'd']);
        expect(registry.busy('s')).toBe(true);
        releaseD();
        expect(registry.busy('s')).toBe(false);
        expect(registry.waiting('s')).toBe(0);
    });

    it('other sessions are not blocked', async () => {
        const registry = new SessionRegistry();
        const queued: number[] = [];
        const a = await registry.acquire('a', never, n => queued.push(n));
        const b = await registry.acquire('b', never, n => queued.push(n));
        expect(queued).toStrictEqual([]);
        a();
        b();
    });

    it('abort while waiting → cancelled, the waiter leaves the queue', async () => {
        const registry = new SessionRegistry();
        const release = await registry.acquire('s', never, () => undefined);
        const controller = new AbortController();
        const waiting = registry.acquire('s', controller.signal, () => undefined);
        expect(registry.waiting('s')).toBe(1);
        controller.abort();
        const err = await waiting.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ThrongError);
        expect((err as ThrongError).code).toBe('cancelled');
        expect((err as ThrongError).message).toBe("cancelled while waiting for the session's running turn to end");
        expect(registry.waiting('s')).toBe(0);
        release();
        expect(registry.busy('s')).toBe(false);

        const aborted = registry.acquire('s', controller.signal, () => undefined);
        await expect(aborted).rejects.toThrow(/session's running turn/);
        expect(registry.busy('s'), 'an already-aborted call leaves no entry').toBe(false);
    });
});
