import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import type { Worker } from '../src/acp/types.ts';
import { snapshotDescendants } from '../src/acp/process.ts';
import { startWorker } from '../src/acp/worker.ts';
import { fakeAgentSpawn } from './fake-agent/index.ts';

const cwd = process.cwd();
const grandchildren: number[] = [];
const tags: string[] = [];

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

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startGrandchild(): Promise<{ worker: Worker; grandchild: number }> {
  const spawn = fakeAgentSpawn('grandchild');
  tags.push(spawn.tag);
  const worker = await startWorker(
    { ...spawn, cwd, depth: 0 },
    { kind: 'new', cwd, mcpServers: [] },
    { onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    { handshakeMs: 5000, exitGraceMs: 300 },
  );
  const grandchild = await waitFor('grandchild pid on stderr', () => {
    const match = /grandchild pid=(\d+)/.exec(worker.stderrTail());
    return match?.[1] ? Number(match[1]) : undefined;
  });
  grandchildren.push(grandchild);
  return { worker, grandchild };
}

describe('process tree', () => {
  it('snapshotDescendants finds the grandchild', async () => {
    const { worker, grandchild } = await startGrandchild();
    try {
      assert.ok((await snapshotDescendants(worker.pid)).includes(grandchild));
    } finally {
      await worker.close();
    }
    assert.equal(isAlive(worker.pid), false);
  });

  it('close kills the adapter and its grandchild', async () => {
    const { worker, grandchild } = await startGrandchild();
    assert.ok(isAlive(grandchild));
    await worker.close();
    assert.equal(isAlive(worker.pid), false);
    // A SIGKILLed grandchild stays a zombie until its new parent reaps it, so poll.
    await waitFor('grandchild to die', () => (isAlive(grandchild) ? undefined : true), 2000);
  });
});
