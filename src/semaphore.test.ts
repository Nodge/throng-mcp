import { describe, expect, it } from 'vitest';
import { ThrongError } from './contract.ts';
import { Semaphore } from './semaphore.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Semaphore', () => {
    it('grants up to max at once, then queues FIFO', async () => {
        const sem = new Semaphore(2);
        const a = await sem.acquire();
        const b = await sem.acquire();
        const order: string[] = [];
        const c = sem.acquire().then(r => (order.push('c'), r));
        const d = sem.acquire().then(r => (order.push('d'), r));
        expect(sem.waiting).toBe(2);
        await tick();
        expect(order).toStrictEqual([]);
        b();
        const releaseC = await c;
        expect(sem.waiting).toBe(1);
        a();
        const releaseD = await d;
        expect(order).toStrictEqual(['c', 'd']);
        expect(sem.waiting).toBe(0);
        releaseC();
        releaseD();
    });

    it('a front waiter is granted before the earlier ones; the rest stay FIFO', async () => {
        const sem = new Semaphore(1);
        const first = await sem.acquire();
        const order: string[] = [];
        const b = sem.acquire().then(r => (order.push('b'), r));
        const c = sem.acquire().then(r => (order.push('c'), r));
        const f = sem.acquire(undefined, { front: true }).then(r => (order.push('f'), r));
        expect(sem.waiting).toBe(3);
        first();
        (await f)();
        (await b)();
        (await c)();
        expect(order).toStrictEqual(['f', 'b', 'c']);
        expect(sem.waiting).toBe(0);
    });

    it('abort while queued rejects cancelled and frees the queue position', async () => {
        const sem = new Semaphore(1);
        const first = await sem.acquire();
        const controller = new AbortController();
        const queued = sem.acquire(controller.signal);
        const next = sem.acquire();
        expect(sem.waiting).toBe(2);
        controller.abort();
        await expect(queued).rejects.toSatisfy(
            (err: unknown) => err instanceof ThrongError && err.code === 'cancelled'
        );
        expect(sem.waiting).toBe(1);
        first();
        const release = await next;
        expect(sem.waiting).toBe(0);
        release();
    });

    it('an already aborted signal rejects without queueing', async () => {
        const sem = new Semaphore(1);
        await expect(sem.acquire(AbortSignal.abort())).rejects.toSatisfy(
            (err: unknown) => err instanceof ThrongError && err.code === 'cancelled'
        );
        const release = await sem.acquire();
        release();
    });

    it('double release is harmless', async () => {
        const sem = new Semaphore(1);
        const a = await sem.acquire();
        a();
        a();
        const b = await sem.acquire();
        let cGranted = false;
        const c = sem.acquire().then(r => ((cGranted = true), r));
        await tick();
        expect(cGranted, 'a second release of `a` must not free another slot').toBe(false);
        b();
        (await c)();
    });
});
