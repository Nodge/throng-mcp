import assert from 'node:assert/strict';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { createPermissionBridge, type PermissionDecision, resolvePolicy } from '../src/permissions.ts';

function request(options: RequestPermissionRequest['options']): RequestPermissionRequest {
  return { sessionId: 's', toolCall: { toolCallId: 't1', title: 'write notes.txt', kind: 'edit' }, options };
}

describe('permissions', () => {
  it('resolvePolicy: per-harness override wins over the global default', () => {
    const config: Config = { ...DEFAULT_CONFIG, permissions: 'deny_all', harnesses: { codex: { permissions: 'auto' } } };
    assert.equal(resolvePolicy(config, 'codex'), 'auto');
    assert.equal(resolvePolicy(config, 'claude'), 'deny_all');
    assert.equal(resolvePolicy(DEFAULT_CONFIG, 'opencode'), 'auto');
  });

  it('auto rejects: reject_once picked by kind, never reject_always or allow_*, and reports the decision', async () => {
    const decisions: PermissionDecision[] = [];
    const bridge = createPermissionBridge('auto', (d) => decisions.push(d));
    const answer = await bridge.answer(
      request([
        { optionId: 'always-xyz', name: 'Always', kind: 'allow_always' },
        { optionId: 'once-abc', name: 'Allow', kind: 'allow_once' },
        { optionId: 'never', name: 'Never', kind: 'reject_always' },
        { optionId: 'no-def', name: 'Reject', kind: 'reject_once' },
      ]),
    );
    assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'no-def' } });
    assert.deepEqual(decisions, [{ title: 'write notes.txt', kind: 'edit', choice: 'no-def' }]);
  });

  it('auto without a reject_once option answers cancelled', async () => {
    const decisions: PermissionDecision[] = [];
    const bridge = createPermissionBridge('auto', (d) => decisions.push(d));
    const answer = await bridge.answer(
      request([
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      ]),
    );
    assert.deepEqual(answer, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(decisions, [{ title: 'write notes.txt', kind: 'edit', choice: 'cancelled' }]);
  });

  it('cancelAll answers a pending request cancelled, and every later one', async () => {
    const decisions: PermissionDecision[] = [];
    let sawAbort = false;
    const bridge = createPermissionBridge(
      'auto',
      (d) => decisions.push(d),
      (_req, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => (sawAbort = true));
        }),
    );
    const pending = bridge.answer(request([{ optionId: 'y', name: 'Allow', kind: 'allow_once' }]));
    await new Promise((resolve) => setImmediate(resolve));
    bridge.cancelAll();
    assert.deepEqual(await pending, { outcome: { outcome: 'cancelled' } });
    assert.equal(sawAbort, true);
    assert.deepEqual(await bridge.answer(request([{ optionId: 'y', name: 'Allow', kind: 'allow_once' }])), {
      outcome: { outcome: 'cancelled' },
    });
    assert.equal(decisions.length, 2);
    assert.ok(decisions.every((d) => d.choice === 'cancelled'));
  });
});
