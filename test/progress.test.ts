import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProgress, type ProgressNotification } from '../src/mcp/progress.ts';

function fakeExtra(token: string | number | undefined, fail = false) {
  const sent: ProgressNotification['params'][] = [];
  const extra = {
    ...(token === undefined ? {} : { _meta: { progressToken: token } }),
    sendNotification: async (n: ProgressNotification) => {
      if (fail) throw new Error('transport closed');
      sent.push(n.params);
    },
  };
  return { extra, sent };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('progress', () => {
  it('sends nothing without a progress token', async () => {
    const { extra, sent } = fakeExtra(undefined);
    const p = createProgress(extra, { heartbeatMs: 5 });
    p.queued(1);
    p.started();
    p.tool('read x');
    p.text(10);
    await sleep(20);
    p.done();
    await p.idle();
    assert.deepEqual(sent, []);
  });

  it('tool titles and queued position, with a monotonic counter and no total', async () => {
    const { extra, sent } = fakeExtra('tok');
    const p = createProgress(extra);
    p.queued(3);
    p.tool('read README.md');
    p.tool('edit src/a.ts');
    p.done();
    await p.idle();
    assert.deepEqual(sent, [
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
    assert.deepEqual(sent.map((s) => s.message), ['agent is writing… (5 chars)']);
    await sleep(50);
    p.text(40);
    p.done();
    await p.idle();
    assert.deepEqual(sent.map((s) => s.message), ['agent is writing… (5 chars)', 'agent is writing… (40 chars)']);
  });

  it('heartbeat reports elapsed time until done()', async () => {
    const { extra, sent } = fakeExtra('hb');
    const p = createProgress(extra, { heartbeatMs: 30 });
    p.started();
    await sleep(100);
    p.done();
    await p.idle();
    const count = sent.length;
    assert.ok(count >= 2, `expected heartbeats, got ${count}`);
    for (const s of sent) assert.match(s.message ?? '', /^running \dm\d\ds$/);
    await sleep(80);
    assert.equal(sent.length, count, 'heartbeat kept going after done()');
    p.tool('late');
    await p.idle();
    assert.equal(sent.length, count, 'sent after done()');
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
