import { describe, expect, it } from 'vitest';
import { createProgress, type ProgressNotification } from './progress.ts';

function fakeExtra(token: string | number | undefined, fail = false) {
    const sent: ProgressNotification['params'][] = [];
    const extra = {
        ...(token === undefined ? {} : { _meta: { progressToken: token } }),
        sendNotification: (n: ProgressNotification): Promise<void> => {
            if (fail) return Promise.reject(new Error('transport closed'));
            sent.push(n.params);
            return Promise.resolve();
        },
    };
    return { extra, sent };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('progress', () => {
    it('sends nothing without a progress token', async () => {
        const { extra, sent } = fakeExtra(undefined);
        const p = createProgress(extra, { heartbeatMs: 5 });
        p.queued(1, 'slot');
        p.started();
        p.waiting();
        p.tool('read x');
        p.text(10);
        await sleep(20);
        p.done();
        await p.idle();
        expect(sent).toStrictEqual([]);
    });

    it('tool titles and queued position, with a monotonic counter and no total', async () => {
        const { extra, sent } = fakeExtra('tok');
        const p = createProgress(extra);
        p.queued(3, 'session');
        p.tool('read README.md');
        p.tool('edit src/a.ts');
        p.done();
        await p.idle();
        expect(sent).toStrictEqual([
            { progressToken: 'tok', progress: 1, message: 'queued (3)' },
            { progressToken: 'tok', progress: 2, message: 'read README.md' },
            { progressToken: 'tok', progress: 3, message: 'edit src/a.ts' },
        ]);
    });

    it('throttles agent text', async () => {
        const { extra, sent } = fakeExtra(7);
        const p = createProgress(extra, { textEveryMs: 50 });
        p.text(5);
        await sleep(10);
        p.text(12);
        await p.idle();
        expect(sent.map(s => s.message)).toStrictEqual(['agent is writing… (5 chars)']);
        await sleep(50);
        p.text(40);
        p.done();
        await p.idle();
        expect(sent.map(s => s.message)).toStrictEqual(['agent is writing… (5 chars)', 'agent is writing… (40 chars)']);
    });

    it('heartbeat reports elapsed time until done()', async () => {
        const { extra, sent } = fakeExtra('hb');
        const p = createProgress(extra, { heartbeatMs: 30 });
        p.started();
        await sleep(100);
        p.done();
        await p.idle();
        const count = sent.length;
        expect(count, `expected heartbeats, got ${count}`).toBeGreaterThanOrEqual(2);
        for (const s of sent) expect(s.message ?? '').toMatch(/^running \dm\d\ds$/);
        await sleep(80);
        expect(sent.length, 'heartbeat kept going after done()').toBe(count);
        p.tool('late');
        await p.idle();
        expect(sent.length, 'sent after done()').toBe(count);
    });

    it('waiting: heartbeat "waiting <elapsed>" until done()', async () => {
        const { extra, sent } = fakeExtra('w');
        const p = createProgress(extra, { heartbeatMs: 30 });
        p.waiting();
        await sleep(100);
        p.done();
        await p.idle();
        expect(sent.length, `expected heartbeats, got ${sent.length}`).toBeGreaterThanOrEqual(2);
        for (const s of sent) expect(s.message ?? '').toMatch(/^waiting \dm\d\ds$/);
    });

    it('a failing send does not throw', async () => {
        const { extra } = fakeExtra('x', true);
        const p = createProgress(extra);
        p.tool('a');
        p.tool('b');
        p.done();
        await p.idle();
    });
});
