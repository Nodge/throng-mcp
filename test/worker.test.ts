import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { after, describe, it } from 'node:test';
import { Collector } from '../src/acp/collector.ts';
import type { SessionStart, Worker, WorkerHooks, WorkerLimits } from '../src/acp/types.ts';
import { startWorker } from '../src/acp/worker.ts';
import { ThrongError } from '../src/contract.ts';
import { type FakeScenario, fakeAgentSpawn } from './fake-agent/index.ts';

const cwd = process.cwd();
const limits: WorkerLimits = { handshakeMs: 5000, exitGraceMs: 300 };
const newSession: SessionStart = { kind: 'new', cwd, mcpServers: [] };

// Safety net: whatever a failing test left behind is killed here.
const tags: string[] = [];
const grandchildren: number[] = [];
after(() => {
  for (const pid of grandchildren) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const tag of tags) {
    try {
      execFileSync('pkill', ['-9', '-f', tag]);
    } catch {
      // nothing matched
    }
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tagAlive(tag: string): boolean {
  try {
    execFileSync('pgrep', ['-f', tag]);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, probe: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Grandchild pid the fake agent printed to stderr (`grandchild pid=N`); registered for cleanup. */
function grandchildPid(text: string): number {
  const match = /grandchild pid=(\d+)/.exec(text);
  assert.ok(match?.[1], `no grandchild pid in: ${text}`);
  const pid = Number(match[1]);
  grandchildren.push(pid);
  return pid;
}

interface Harness {
  worker: Worker;
  collector: Collector;
  updates: SessionNotification[];
  warnings: string[];
  /** One prompt turn through the collector. */
  turn(text: string): Promise<string>;
}

async function start(
  scenario: FakeScenario,
  options: { start?: SessionStart; depth?: number; onPermission?: WorkerHooks['onPermission'] } = {},
): Promise<Harness> {
  const spawn = fakeAgentSpawn(scenario);
  tags.push(spawn.tag);
  const collector = new Collector();
  const updates: SessionNotification[] = [];
  const warnings: string[] = [];
  const worker = await startWorker(
    { command: spawn.command, args: spawn.args, env: spawn.env, cwd, depth: options.depth ?? 0 },
    options.start ?? newSession,
    {
      onUpdate: (n) => {
        updates.push(n);
        collector.handle(n);
      },
      onPermission: options.onPermission ?? (async () => ({ outcome: { outcome: 'cancelled' } })),
      onWarning: (text) => warnings.push(text),
    },
    limits,
  );
  return {
    worker,
    collector,
    updates,
    warnings,
    async turn(text) {
      collector.startTurn();
      collector.endTurn(await worker.prompt(text));
      return collector.text;
    },
  };
}

/** Runs `body` with a started worker; always closes it and asserts the adapter is gone. */
async function withWorker(
  scenario: FakeScenario,
  body: (h: Harness) => Promise<void>,
  options?: Parameters<typeof start>[1],
): Promise<void> {
  const h = await start(scenario, options);
  try {
    await body(h);
  } finally {
    await h.worker.close();
    assert.equal(isAlive(h.worker.pid), false, 'adapter pid is gone after close');
  }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<ThrongError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ThrongError, `expected ThrongError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected rejection with ${code}`);
}

describe('worker', () => {
  it('handshake exposes session, agent info, config options and modes', async () => {
    await withWorker('echo', async ({ worker }) => {
      const { session } = worker;
      assert.match(session.sessionId, /^fake-/);
      assert.equal(session.agentInfo?.name, 'fake-agent');
      assert.deepEqual(
        session.configOptions?.map((o) => [o.id, o.category]),
        [
          ['model', 'model'],
          ['effort', 'thought_level'],
        ],
      );
      assert.equal(session.modes?.currentModeId, 'ask');
      assert.deepEqual(session.modes?.availableModes.map((m) => m.id), ['ask', 'auto']);
      assert.ok(worker.pid > 0);
    });
  });

  it('prompt resolves with end_turn and the collector holds the text', async () => {
    await withWorker('echo', async ({ worker, collector }) => {
      collector.startTurn();
      const response = await worker.prompt('hello');
      assert.equal(response.stopReason, 'end_turn');
      assert.equal(collector.text, 'echo: hello [model=fake-small effort=low]');
      assert.equal(collector.lastToolTitle, 'read README.md');
    });
  });

  it('setConfigOption and setMode', async () => {
    await withWorker('echo', async (h) => {
      const options = await h.worker.setConfigOption('model', 'fake-large');
      const model = options.find((o) => o.id === 'model');
      assert.equal(model?.type === 'select' && model.currentValue, 'fake-large');
      assert.equal(await h.turn('hi'), 'echo: hi [model=fake-large effort=low]');

      await h.worker.setMode('auto');

      const err = await rejectsWith(h.worker.setConfigOption('model', 'fake-huge'), 'agent_error');
      assert.match(err.message, /fake-large/);
    });
  });

  it('usage: tokens summed across turns, cost is the last cumulative value', async () => {
    await withWorker('echo', async (h) => {
      await h.turn('one');
      await h.turn('two');
      assert.equal(h.collector.text, 'echo: two [model=fake-small effort=low]');
      assert.deepEqual(h.collector.usage, { input_tokens: 20, output_tokens: 10, cost_usd: 0.02 });
    });
  });

  it('cancel makes the pending prompt resolve with cancelled', async () => {
    await withWorker('hang', async ({ worker }) => {
      const pending = worker.prompt('wait');
      // Let the prompt reach the agent before cancelling.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await worker.cancel();
      assert.equal((await pending).stopReason, 'cancelled');
    });
  });

  it('handshake timeout names the pending step and kills the adapter', async () => {
    const spawn = fakeAgentSpawn('handshake-hang');
    tags.push(spawn.tag);
    const err = await rejectsWith(
      startWorker({ ...spawn, cwd, depth: 0 }, newSession, { onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }, {
        handshakeMs: 500,
        exitGraceMs: 300,
      }),
      'handshake_timeout',
    );
    assert.match(err.message, /initialize/);
    assert.equal(tagAlive(spawn.tag), false, 'adapter is gone after a failed handshake');
  });

  it('spawn_failed for a missing command', async () => {
    const err = await rejectsWith(
      startWorker(
        { command: '/nonexistent/adapter', args: [], env: {}, cwd, depth: 0 },
        newSession,
        { onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
        limits,
      ),
      'spawn_failed',
    );
    assert.match(err.message, /ENOENT/);
  });

  it('spawn_failed when spawn rejects the arguments synchronously', async () => {
    const err = await rejectsWith(
      startWorker(
        { command: process.execPath, args: ['bad\u0000arg'], env: {}, cwd, depth: 0 },
        newSession,
        { onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
        limits,
      ),
      'spawn_failed',
    );
    assert.match(err.message, /cannot start adapter/);
  });

  it('transport_lost when the adapter dies mid-prompt, with exit code and stderr', async () => {
    await withWorker('crash-on-prompt', async ({ worker }) => {
      const err = await rejectsWith(worker.prompt('x'), 'transport_lost');
      assert.match(err.message, /boom/);
      assert.match(err.message, /exit code 3/);
      assert.match(worker.stderrTail(), /fake-agent: boom/);
    });
  });

  it('adapter exit before initialize is spawn_failed even when a grandchild holds its stdout', async () => {
    const spawn = fakeAgentSpawn('orphan-exit');
    tags.push(spawn.tag);
    const err = await rejectsWith(
      startWorker({ ...spawn, cwd, depth: 0 }, newSession, { onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }, {
        handshakeMs: 20_000,
        exitGraceMs: 300,
      }),
      'spawn_failed',
    );
    assert.match(err.message, /exit code 5/);
    assert.match(err.message, /early exit/);
    const orphan = grandchildPid(err.message);
    await waitFor('the stdout-holding grandchild to die', () => !isAlive(orphan));
  });

  it('transport_lost when the adapter dies mid-prompt while a grandchild holds its stdout', async () => {
    let orphan = 0;
    await withWorker('orphan-crash', async ({ worker }) => {
      await waitFor('the grandchild pid on stderr', () => worker.stderrTail().includes('grandchild pid='));
      orphan = grandchildPid(worker.stderrTail());
      // Without a live stdout holder this case degenerates into plain crash-on-prompt.
      assert.ok(isAlive(orphan), 'the stdout-holding grandchild is running');
      const err = await rejectsWith(worker.prompt('x'), 'transport_lost');
      assert.match(err.message, /exit code 3/);
      assert.match(err.message, /boom/);
    });
    await waitFor('the stdout-holding grandchild to die', () => !isAlive(orphan));
  });

  it('updates sent before session/new or session/resume answers reach onUpdate', async () => {
    const early = (h: Harness) =>
      waitFor('the early notice', () =>
        h.updates.some((n) => n.update.sessionUpdate === 'notice' && n.update.title === 'early'),
      );
    await withWorker('early-update', early);
    await withWorker('early-update', early, { start: { kind: 'resume', sessionId: 'abc', cwd, mcpServers: [] } });
  });

  it('fs/* call from the agent: one warning, prompt still completes', async () => {
    await withWorker('fs-call', async (h) => {
      assert.equal(await h.turn('a'), 'echo: a [model=fake-small effort=low]');
      await h.turn('b');
      assert.equal(h.warnings.length, 1);
      assert.match(h.warnings[0] ?? '', /fs\/read_text_file/);
    });
  });

  it('notice goes to warnings', async () => {
    await withWorker('notice', async (h) => {
      await h.turn('n');
      assert.deepEqual(h.collector.warnings, ['warning: fake notice — mode fell back']);
    });
  });

  it('resume keeps the given session id', async () => {
    await withWorker(
      'echo',
      async (h) => {
        assert.equal(h.worker.session.sessionId, 'abc');
        assert.match(await h.turn('again'), /^resumed: echo: again/);
      },
      { start: { kind: 'resume', sessionId: 'abc', cwd, mcpServers: [] } },
    );
  });

  it('resume against an agent without the capability → session_not_found', async () => {
    const spawn = fakeAgentSpawn('no-resume');
    tags.push(spawn.tag);
    await rejectsWith(
      startWorker(
        { ...spawn, cwd, depth: 0 },
        { kind: 'resume', sessionId: 'abc', cwd, mcpServers: [] },
        { onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
        limits,
      ),
      'session_not_found',
    );
    assert.equal(tagAlive(spawn.tag), false);
  });

  it('permission requests go to onPermission', async () => {
    const requests: RequestPermissionRequest[] = [];
    const answer =
      (response: RequestPermissionResponse) =>
      async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        requests.push(request);
        return response;
      };

    await withWorker(
      'permission',
      async (h) => {
        assert.equal(await h.turn('p'), 'allowed');
      },
      { onPermission: answer({ outcome: { outcome: 'selected', optionId: 'yes' } }) },
    );
    assert.equal(requests[0]?.options.length, 3);
    assert.deepEqual(
      requests[0]?.options.map((o) => o.kind),
      ['allow_once', 'allow_always', 'reject_once'],
    );

    await withWorker(
      'permission',
      async (h) => {
        assert.equal(await h.turn('p'), 'cancelled');
      },
      { onPermission: answer({ outcome: { outcome: 'cancelled' } }) },
    );
  });

  it('child sees THRONG_MCP_DEPTH = depth + 1', async () => {
    // The fake agent reports the depth it sees as `_meta.throngDepth` of a session_info_update.
    await withWorker(
      'echo',
      async (h) => {
        await h.turn('d');
        const info = h.updates.find((n) => n.update.sessionUpdate === 'session_info_update');
        assert.equal(info?.update._meta?.throngDepth, '2');
      },
      { depth: 1 },
    );
  });

  it('close is idempotent and later calls reject transport_lost', async () => {
    const h = await start('echo');
    await Promise.all([h.worker.close(), h.worker.close()]);
    await h.worker.close();
    assert.equal(isAlive(h.worker.pid), false);
    await rejectsWith(h.worker.prompt('late'), 'transport_lost');
    await rejectsWith(h.worker.cancel(), 'transport_lost');
  });
});
