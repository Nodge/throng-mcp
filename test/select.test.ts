import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { after, describe, it } from 'node:test';
import { Collector } from '../src/acp/collector.ts';
import type { Worker } from '../src/acp/types.ts';
import { startWorker } from '../src/acp/worker.ts';
import { ThrongError } from '../src/errors.ts';
import { HARNESSES } from '../src/harnesses/index.ts';
import { modelRejectedMessage, optionByCategory, selectEffort, selectModel } from '../src/harnesses/select.ts';
import { type FakeScenario, fakeAgentSpawn } from './fake-agent/index.ts';

const tags: string[] = [];
after(() => {
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

/** Runs `body` with a fake-agent worker; always closes it and checks the adapter is gone. */
async function withWorker(scenario: FakeScenario, body: (worker: Worker, turn: (text: string) => Promise<string>) => Promise<void>) {
  const spawn = fakeAgentSpawn(scenario);
  tags.push(spawn.tag);
  const collector = new Collector();
  const cwd = process.cwd();
  const worker = await startWorker(
    { command: spawn.command, args: spawn.args, env: spawn.env, cwd, depth: 0 },
    { kind: 'new', cwd, mcpServers: [] },
    { onUpdate: (n) => collector.handle(n), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    { handshakeMs: 5000, exitGraceMs: 300 },
  );
  const turn = async (text: string) => {
    collector.startTurn();
    collector.endTurn(await worker.prompt(text));
    return collector.text;
  };
  try {
    await body(worker, turn);
  } finally {
    await worker.close();
    assert.equal(isAlive(worker.pid), false, 'adapter pid is gone after close');
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

describe('optionByCategory', () => {
  const options: SessionConfigOption[] = [
    { id: 'reasoning', name: 'R', category: 'thought_level', type: 'boolean', currentValue: true },
    {
      id: 'model_choice',
      name: 'M',
      category: 'model',
      type: 'select',
      currentValue: 'a/x',
      options: [
        { group: 'a', name: 'A', options: [{ value: 'a/x', name: 'x' }, { value: 'a/y', name: 'y' }] },
        { group: 'b', name: 'B', options: [{ value: 'b/z', name: 'z' }] },
      ],
    },
    { id: 'model', name: 'Not a model', category: 'mode', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'm' }] },
  ];

  it('matches on category, flattens groups, ignores non-select options', () => {
    assert.deepEqual(optionByCategory(options, 'model'), { id: 'model_choice', values: ['a/x', 'a/y', 'b/z'] });
    assert.equal(optionByCategory(options, 'thought_level'), undefined);
    assert.equal(optionByCategory(undefined, 'model'), undefined);
  });
});

describe('modelRejectedMessage', () => {
  it('lists every value when the list is short', () => {
    const message = modelRejectedMessage('nope', ['a', 'b']);
    assert.equal(message, 'model "nope" is not available; valid models: a, b');
  });

  it('long list: only the requested provider plus the total', () => {
    const values = [
      ...Array.from({ length: 40 }, (_, i) => `openai/m${i}`),
      'anthropic/fable',
      'anthropic/opus',
    ];
    const message = modelRejectedMessage('anthropic/nope', values);
    assert.equal(
      message,
      'model "anthropic/nope" is not available; anthropic/ models: anthropic/fable, anthropic/opus … 42 models in total; run list_harnesses for the full list',
    );
    assert.ok(!message.includes('openai/'), message);

    const noProvider = modelRejectedMessage('mystery/x', values);
    assert.ok(noProvider.includes('no mystery/ models'), noProvider);
    assert.ok(noProvider.includes('42 models in total'), noProvider);

    const noSlash = modelRejectedMessage('plain', values);
    assert.equal(noSlash, 'model "plain" is not available; … 42 models in total; run list_harnesses for the full list');
  });

  it('exactly 40 values are still listed in full', () => {
    const values = Array.from({ length: 40 }, (_, i) => `p/m${i}`);
    assert.ok(modelRejectedMessage('q/x', values).includes('p/m39'));
  });
});

describe('selectModel / selectEffort (fake agent)', () => {
  it('selectModel sets an offered model', async () => {
    await withWorker('echo', async (worker, turn) => {
      await selectModel(worker, 'fake-large');
      assert.equal(await turn('hi'), 'echo: hi [model=fake-large effort=low]');
    });
  });

  it('selectModel rejects an unknown model with the valid list', async () => {
    await withWorker('echo', async (worker, turn) => {
      const err = await rejectsWith(selectModel(worker, 'nope'), 'model_rejected');
      assert.ok(err.message.includes('"nope"'), err.message);
      assert.ok(err.message.includes('fake-small'), err.message);
      assert.ok(err.message.includes('fake-large'), err.message);
      assert.equal(await turn('hi'), 'echo: hi [model=fake-small effort=low]');
    });
  });

  it('selectEffort sets an exact level without a warning', async () => {
    await withWorker('echo', async (worker, turn) => {
      assert.equal(await selectEffort(HARNESSES.claude, worker, 'high'), undefined);
      assert.equal(await turn('hi'), 'echo: hi [model=fake-small effort=high]');
    });
  });

  it('selectEffort warns when the level is not offered', async () => {
    await withWorker('echo', async (worker, turn) => {
      const claude = await selectEffort(HARNESSES.claude, worker, 'max');
      assert.equal(claude, 'effort "max" not available for claude; options: low, high');
      const codex = await selectEffort(HARNESSES.codex, worker, 'max');
      assert.equal(codex, 'effort "max" not available for codex; options: low, high');
      assert.equal(await turn('hi'), 'echo: hi [model=fake-small effort=low]');
    });
  });

  it('selectEffort warns when the harness has no effort option', async () => {
    await withWorker('no-effort-option', async (worker) => {
      const warning = await selectEffort(HARNESSES.opencode, worker, 'high');
      assert.equal(warning, 'effort "high" ignored: opencode exposes no effort option');
    });
  });

  it('selectEffort reports a mapped level', async () => {
    await withWorker('echo', async (worker, turn) => {
      // A definition whose mapping differs from the requested level: max → high.
      const def = { ...HARNESSES.codex, mapEffort: (level: string, options: string[]) => (level === 'max' && options.includes('high') ? 'high' : undefined) };
      assert.equal(await selectEffort(def, worker, 'max'), 'effort "max" mapped to "high"');
      assert.equal(await turn('hi'), 'echo: hi [model=fake-small effort=high]');
    });
  });
});
