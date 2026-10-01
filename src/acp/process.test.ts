import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeAgentSpawn } from '../../test/fake-agent/index.ts';
import { snapshotDescendants } from './process.ts';
import type { Worker } from './types.ts';
import { startWorker } from './worker.ts';

const cwd = process.cwd();
const grandchildren: number[] = [];
const tags: string[] = [];

afterAll(() => {
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
    if (Date.now() > deadline) expect.unreachable(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startGrandchild(scenario: 'grandchild' | 'grandchild-detached' = 'grandchild'): Promise<{ worker: Worker; grandchild: number }> {
  const spawn = fakeAgentSpawn(scenario);
  tags.push(spawn.tag);
  const worker = await startWorker(
    { ...spawn, cwd, depth: 0 },
    { kind: 'new', cwd, mcpServers: [] },
    { onPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }) },
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
      expect(await snapshotDescendants(worker.pid)).toContain(grandchild);
    } finally {
      await worker.close();
    }
    expect(isAlive(worker.pid)).toBe(false);
  });

  it('close kills the adapter and its grandchild', async () => {
    const { worker, grandchild } = await startGrandchild();
    expect(isAlive(grandchild)).toBe(true);
    await worker.close();
    expect(isAlive(worker.pid)).toBe(false);
    // A SIGKILLed grandchild stays a zombie until its new parent reaps it, so poll.
    await waitFor('grandchild to die', () => (isAlive(grandchild) ? undefined : true), 2000);
  });

  it('close kills a grandchild that left the process group (snapshot path)', async () => {
    const { worker, grandchild } = await startGrandchild('grandchild-detached');
    // Its own group: the group signals in killTree cannot reach it, only the snapshot can.
    expect(await snapshotDescendants(worker.pid)).toContain(grandchild);
    await worker.close();
    expect(isAlive(worker.pid)).toBe(false);
    await waitFor('detached grandchild to die', () => (isAlive(grandchild) ? undefined : true), 2000);
  });
});
