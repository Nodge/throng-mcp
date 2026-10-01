import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from './config.ts';
import { createPermissionBridge, type PermissionDecision, resolvePolicy } from './permissions.ts';

function request(options: RequestPermissionRequest['options']): RequestPermissionRequest {
    return { sessionId: 's', toolCall: { toolCallId: 't1', title: 'write notes.txt', kind: 'edit' }, options };
}

describe('permissions', () => {
    it('resolvePolicy: per-harness override wins over the global default', () => {
        const config: Config = {
            ...DEFAULT_CONFIG,
            permissions: 'deny_all',
            harnesses: { codex: { permissions: 'auto' } },
        };
        expect(resolvePolicy(config, 'codex')).toBe('auto');
        expect(resolvePolicy(config, 'claude')).toBe('deny_all');
        expect(resolvePolicy(DEFAULT_CONFIG, 'opencode')).toBe('auto');
    });

    it('auto rejects: reject_once picked by kind, never reject_always or allow_*, and reports the decision', async () => {
        const decisions: PermissionDecision[] = [];
        const bridge = createPermissionBridge('auto', d => decisions.push(d));
        const answer = await bridge.answer(
            request([
                { optionId: 'always-xyz', name: 'Always', kind: 'allow_always' },
                { optionId: 'once-abc', name: 'Allow', kind: 'allow_once' },
                { optionId: 'never', name: 'Never', kind: 'reject_always' },
                { optionId: 'no-def', name: 'Reject', kind: 'reject_once' },
            ])
        );
        expect(answer).toStrictEqual({ outcome: { outcome: 'selected', optionId: 'no-def' } });
        expect(decisions).toStrictEqual([{ title: 'write notes.txt', kind: 'edit', choice: 'no-def' }]);
    });

    it('auto without a reject_once option answers cancelled', async () => {
        const decisions: PermissionDecision[] = [];
        const bridge = createPermissionBridge('auto', d => decisions.push(d));
        const answer = await bridge.answer(
            request([
                { optionId: 'always', name: 'Always', kind: 'allow_always' },
                { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            ])
        );
        expect(answer).toStrictEqual({ outcome: { outcome: 'cancelled' } });
        expect(decisions).toStrictEqual([{ title: 'write notes.txt', kind: 'edit', choice: 'cancelled' }]);
    });

    it('cancelAll answers a pending request cancelled, and every later one', async () => {
        const decisions: PermissionDecision[] = [];
        let sawAbort = false;
        const bridge = createPermissionBridge(
            'auto',
            d => decisions.push(d),
            (_req, signal) =>
                new Promise(() => {
                    signal.addEventListener('abort', () => (sawAbort = true));
                })
        );
        const pending = bridge.answer(request([{ optionId: 'y', name: 'Allow', kind: 'allow_once' }]));
        await new Promise(resolve => setImmediate(resolve));
        bridge.cancelAll();
        expect(await pending).toStrictEqual({ outcome: { outcome: 'cancelled' } });
        expect(sawAbort).toBe(true);
        expect(await bridge.answer(request([{ optionId: 'y', name: 'Allow', kind: 'allow_once' }]))).toStrictEqual({
            outcome: { outcome: 'cancelled' },
        });
        expect(decisions.length).toBe(2);
        expect(decisions.every(d => d.choice === 'cancelled')).toBe(true);
    });
});
