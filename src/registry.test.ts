import { afterAll, describe, expect, it } from 'vitest';
import { fakeHarness, tagAlive, waitFor } from '../test/fake-harness.ts';
import { ThrongError } from './contract.ts';
import { sendMessage } from './mcp/tools/send-message.ts';
import { type AcquireOptions, SessionRegistry } from './registry.ts';

const h = fakeHarness('throng-registry-');
afterAll(() => h.cleanup());

const tick = () => new Promise(resolve => setImmediate(resolve));
const never = new AbortController().signal;

/** `acquire` with a fresh controller unless given; never aborted, ignores onQueued by default. */
function acq(registry: SessionRegistry, id: string, opts: Partial<AcquireOptions> = {}): Promise<() => void> {
    return registry.acquire(id, {
        signal: never,
        controller: new AbortController(),
        onQueued: () => undefined,
        ...opts,
    });
}

describe('SessionRegistry', () => {
    it('one holder per session, waiters FIFO; release of the last one deletes the entry', async () => {
        const registry = new SessionRegistry();
        const queued: number[] = [];
        const onQueued = (n: number) => queued.push(n);
        const order: string[] = [];
        const a = await acq(registry, 's', { onQueued });
        expect(registry.busy('s')).toBe(true);
        expect(registry.busy('other')).toBe(false);
        const b = acq(registry, 's', { onQueued }).then(r => (order.push('b'), r));
        const c = acq(registry, 's', { onQueued }).then(r => (order.push('c'), r));
        const d = acq(registry, 's', { onQueued }).then(r => (order.push('d'), r));
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
        const a = await acq(registry, 'a', { onQueued: n => queued.push(n) });
        const b = await acq(registry, 'b', { onQueued: n => queued.push(n) });
        expect(queued).toStrictEqual([]);
        a();
        b();
    });

    it('abort while waiting → cancelled, the waiter leaves the queue', async () => {
        const registry = new SessionRegistry();
        const release = await acq(registry, 's');
        const controller = new AbortController();
        const waiting = acq(registry, 's', { signal: controller.signal });
        expect(registry.waiting('s')).toBe(1);
        controller.abort();
        const err = await waiting.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ThrongError);
        expect((err as ThrongError).code).toBe('cancelled');
        expect((err as ThrongError).message).toBe("cancelled while waiting for the session's running turn to end");
        expect(registry.waiting('s')).toBe(0);
        release();
        expect(registry.busy('s')).toBe(false);

        const aborted = acq(registry, 's', { signal: controller.signal });
        await expect(aborted).rejects.toThrow(/session's running turn/);
        expect(registry.busy('s'), 'an already-aborted call leaves no entry').toBe(false);
    });

    it('idle(id) resolves at once when not busy, otherwise after the last holder and waiter are gone', async () => {
        const registry = new SessionRegistry();
        await registry.idle('s');
        const a = await acq(registry, 's');
        const b = acq(registry, 's');
        let idle = false;
        const waiting = registry.idle('s').then(() => (idle = true));
        a();
        const releaseB = await b;
        await tick();
        expect(idle, 'idle while B holds the session').toBe(false);
        releaseB();
        await waiting;
        expect(idle).toBe(true);
    });

    it('holder() is the controller of the acquire holding the lock; turns() = holder + waiters in order', async () => {
        const registry = new SessionRegistry();
        expect(registry.holder('s')).toBe(undefined);
        expect(registry.turns('s')).toStrictEqual([]);
        const [a, b, c] = [new AbortController(), new AbortController(), new AbortController()];
        const releaseA = await acq(registry, 's', { controller: a });
        expect(registry.holder('s')).toBe(a);
        const bLock = acq(registry, 's', { controller: b });
        const cLock = acq(registry, 's', { controller: c });
        expect(registry.holder('s')).toBe(a);
        expect(registry.turns('s')).toStrictEqual([a, b, c]);

        releaseA();
        const releaseB = await bLock;
        expect(registry.holder('s')).toBe(b);
        expect(registry.turns('s')).toStrictEqual([b, c]);
        releaseB();
        const releaseC = await cLock;
        expect(registry.turns('s')).toStrictEqual([c]);
        releaseC();
        expect(registry.holder('s')).toBe(undefined);
        expect(registry.turns('s')).toStrictEqual([]);
    });

    it('detachTurn removes the holder from holder()/turns() without releasing the lock', async () => {
        const registry = new SessionRegistry();
        const [a, b] = [new AbortController(), new AbortController()];
        const releaseA = await acq(registry, 's', { controller: a });
        let bGranted = false;
        const bLock = acq(registry, 's', { controller: b }).then(r => ((bGranted = true), r));
        registry.detachTurn('s', a);
        expect(registry.holder('s')).toBe(undefined);
        expect(registry.turns('s')).toStrictEqual([b]);
        await tick();
        expect(bGranted, 'the lock stays with A').toBe(false);
        expect(registry.busy('s')).toBe(true);
        releaseA();
        (await bLock)();
        registry.detachTurn('idle', a);
    });

    it('a front acquire is granted before the earlier waiters, which keep their order', async () => {
        const registry = new SessionRegistry();
        const [a, b, c, s] = [
            new AbortController(),
            new AbortController(),
            new AbortController(),
            new AbortController(),
        ];
        const order: string[] = [];
        const positions: number[] = [];
        const releaseA = await acq(registry, 's', { controller: a });
        const bLock = acq(registry, 's', { controller: b }).then(r => (order.push('b'), r));
        const cLock = acq(registry, 's', { controller: c }).then(r => (order.push('c'), r));
        const sLock = acq(registry, 's', { controller: s, front: true, onQueued: n => positions.push(n) }).then(
            r => (order.push('s'), r)
        );
        expect(positions).toStrictEqual([1]);
        expect(registry.waiting('s')).toBe(3);
        expect(registry.turns('s')).toStrictEqual([a, s, b, c]);

        releaseA();
        const releaseS = await sLock;
        expect(registry.holder('s')).toBe(s);
        releaseS();
        (await bLock)();
        (await cLock)();
        expect(order).toStrictEqual(['s', 'b', 'c']);
        expect(registry.busy('s')).toBe(false);
    });

    it('a front acquire on an idle session resolves at once', async () => {
        const registry = new SessionRegistry();
        const queued: number[] = [];
        const s = new AbortController();
        const release = await acq(registry, 's', { controller: s, front: true, onQueued: n => queued.push(n) });
        expect(queued).toStrictEqual([]);
        expect(registry.holder('s')).toBe(s);
        release();
    });

    it('a waiter that aborts leaves turns()', async () => {
        const registry = new SessionRegistry();
        const [a, b] = [new AbortController(), new AbortController()];
        const releaseA = await acq(registry, 's', { controller: a });
        const bLock = acq(registry, 's', { controller: b, signal: b.signal });
        expect(registry.turns('s')).toStrictEqual([a, b]);
        b.abort();
        await expect(bLock).rejects.toThrow(/session's running turn/);
        expect(registry.turns('s')).toStrictEqual([a]);
        releaseA();
    });

    it("turns(): runCall's controllers of a running synchronous turn and a queued one; aborting them ends both", async () => {
        const hang = h.fakeClaude('hang');
        const echo = h.fakeClaude('echo');
        const sessions = new SessionRegistry();
        const aCtx = h.makeCtx(hang.loaded, { sessions });
        await h.record(aCtx.cacheDir, 'fake-t');
        const a = sendMessage({ session_id: 'fake-t', prompt: 'A' }, aCtx);
        await waitFor('A holds the session', () => sessions.busy('fake-t'));
        expect(sessions.turns('fake-t').length).toBe(1);
        await waitFor('A adapter', () => tagAlive(hang.tag));
        const b = sendMessage(
            { session_id: 'fake-t', prompt: 'B' },
            h.makeCtx(echo.loaded, { sessions, cacheDir: aCtx.cacheDir })
        );
        await waitFor('B queued', () => sessions.waiting('fake-t') === 1);
        const turns = sessions.turns('fake-t');
        expect(turns.length).toBe(2);

        for (const controller of turns) controller.abort();
        const [aOut, bOut] = await Promise.all([a, b]);
        expect(aOut.ok ? 'ok' : aOut.payload.code).toBe('cancelled');
        expect(bOut.ok ? 'ok' : bOut.payload.code).toBe('cancelled');
        await sessions.idle('fake-t');
        expect(sessions.turns('fake-t')).toStrictEqual([]);
        expect(tagAlive(hang.tag)).toBe(false);
        expect(tagAlive(echo.tag), 'the queued turn never started an adapter').toBe(false);
    });
});
