import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThrongError } from '../src/errors.ts';
import { Semaphore } from '../src/semaphore.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Semaphore', () => {
  it('grants up to max at once, then queues FIFO', async () => {
    const sem = new Semaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    const order: string[] = [];
    const c = sem.acquire().then((r) => (order.push('c'), r));
    const d = sem.acquire().then((r) => (order.push('d'), r));
    assert.equal(sem.waiting, 2);
    await tick();
    assert.deepEqual(order, []);
    b();
    const releaseC = await c;
    assert.equal(sem.waiting, 1);
    a();
    const releaseD = await d;
    assert.deepEqual(order, ['c', 'd']);
    assert.equal(sem.waiting, 0);
    releaseC();
    releaseD();
  });

  it('abort while queued rejects cancelled and frees the queue position', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    const controller = new AbortController();
    const queued = sem.acquire(controller.signal);
    const next = sem.acquire();
    assert.equal(sem.waiting, 2);
    controller.abort();
    await assert.rejects(queued, (err: unknown) => err instanceof ThrongError && err.code === 'cancelled');
    assert.equal(sem.waiting, 1);
    first();
    const release = await next;
    assert.equal(sem.waiting, 0);
    release();
  });

  it('an already aborted signal rejects without queueing', async () => {
    const sem = new Semaphore(1);
    await assert.rejects(sem.acquire(AbortSignal.abort()), (err: unknown) => err instanceof ThrongError && err.code === 'cancelled');
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
    const c = sem.acquire().then((r) => ((cGranted = true), r));
    await tick();
    assert.equal(cGranted, false, 'a second release of `a` must not free another slot');
    b();
    (await c)();
  });
});
