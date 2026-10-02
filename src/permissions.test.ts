import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from './config.ts';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import {
    createPermissionBridge,
    deciderFor,
    type Elicitation,
    isThrongResultCall,
    type PermissionDecision,
    resolvePolicy,
} from './permissions.ts';

function request(
    options: RequestPermissionRequest['options'],
    toolCall: RequestPermissionRequest['toolCall'] = { toolCallId: 't1', title: 'write notes.txt', kind: 'edit' }
): RequestPermissionRequest {
    return { sessionId: 's', toolCall, options };
}

const submitCall = { toolCallId: 't9', title: 'mcp.throng_result.submit_result', kind: 'other' } as const;
const auto = deciderFor('auto', { elicitationTimeoutMs: 1000 });
const fullOptions: RequestPermissionRequest['options'] = [
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'never', name: 'Never', kind: 'reject_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
const onceOptions: RequestPermissionRequest['options'] = [
    { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

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
        const bridge = createPermissionBridge('auto', d => decisions.push(d), auto);
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
        const bridge = createPermissionBridge('auto', d => decisions.push(d), auto);
        const answer = await bridge.answer(
            request([
                { optionId: 'always', name: 'Always', kind: 'allow_always' },
                { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            ])
        );
        expect(answer).toStrictEqual({ outcome: { outcome: 'cancelled' } });
        expect(decisions).toStrictEqual([{ title: 'write notes.txt', kind: 'edit', choice: 'cancelled' }]);
    });

    it('isThrongResultCall: by title substrings, codex and claude spellings', () => {
        expect(isThrongResultCall(submitCall)).toBe(true);
        expect(isThrongResultCall({ toolCallId: 't', title: 'mcp__throng_result__submit_result' })).toBe(true);
        expect(isThrongResultCall({ toolCallId: 't', title: 'mcp.other.submit_result' })).toBe(false);
        expect(isThrongResultCall({ toolCallId: 't', title: 'mcp.throng_result.other' })).toBe(false);
        expect(isThrongResultCall({ toolCallId: 't' })).toBe(false);
    });

    it('our submit_result is allowed once before the policy; other tools still rejected', async () => {
        const decisions: PermissionDecision[] = [];
        const bridge = createPermissionBridge('auto', d => decisions.push(d), auto);
        expect(await bridge.answer(request(onceOptions, submitCall))).toStrictEqual({
            outcome: { outcome: 'selected', optionId: 'ok' },
        });
        expect(await bridge.answer(request(onceOptions))).toStrictEqual({
            outcome: { outcome: 'selected', optionId: 'no' },
        });
        expect(decisions).toStrictEqual([
            { title: 'mcp.throng_result.submit_result', kind: 'other', choice: 'ok' },
            { title: 'write notes.txt', kind: 'edit', choice: 'no' },
        ]);
    });

    it('our submit_result without an allow_once option → the policy answers, never allow_always', async () => {
        const bridge = createPermissionBridge('auto', () => undefined, auto);
        const answer = await bridge.answer(
            request(
                [
                    { optionId: 'always', name: 'Always', kind: 'allow_always' },
                    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
                ],
                submitCall
            )
        );
        expect(answer).toStrictEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
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

    describe('allow_all', () => {
        const decide = deciderFor('allow_all', { elicitationTimeoutMs: 1000 });
        const signal = new AbortController().signal;

        it('allow_once picked by kind, never allow_always', async () => {
            expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'selected', optionId: 'yes' });
        });

        it('no allow_once → reject_once; neither → cancelled', async () => {
            expect(
                await decide(
                    request([
                        { optionId: 'always', name: 'Always', kind: 'allow_always' },
                        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
                    ]),
                    signal
                )
            ).toStrictEqual({ outcome: 'selected', optionId: 'no' });
            expect(
                await decide(request([{ optionId: 'always', name: 'Always', kind: 'allow_always' }]), signal)
            ).toStrictEqual({ outcome: 'cancelled' });
        });
    });

    it('deny_all: reject_once by kind, else cancelled', async () => {
        const decide = deciderFor('deny_all', { elicitationTimeoutMs: 1000 });
        const signal = new AbortController().signal;
        expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'selected', optionId: 'no' });
        expect(await decide(request([{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]), signal)).toStrictEqual({
            outcome: 'cancelled',
        });
    });

    describe('elicit', () => {
        interface Asked {
            params: ElicitRequestFormParams;
            opts: { signal: AbortSignal; timeoutMs: number };
        }

        function fakeElicitation(answer: (asked: Asked) => Promise<ElicitResult>): Elicitation & { asked: Asked[] } {
            const asked: Asked[] = [];
            return {
                asked,
                ask: (params, opts) => {
                    asked.push({ params, opts });
                    return answer({ params, opts });
                },
            };
        }

        const decideWith = (elicitation: Elicitation) =>
            deciderFor('elicit', { elicitation, elicitationTimeoutMs: 1234 });
        const signal = new AbortController().signal;

        it('form: titled oneOf of the *_once kinds present, first option of each kind; message and timeout', async () => {
            const elicitation = fakeElicitation(() => Promise.resolve({ action: 'cancel' }));
            await decideWith(elicitation)(
                request(
                    [
                        { optionId: 'always', name: 'Always', kind: 'allow_always' },
                        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
                        { optionId: 'yes2', name: 'Allow again', kind: 'allow_once' },
                        { optionId: 'never', name: 'Never', kind: 'reject_always' },
                        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
                    ],
                    {
                        toolCallId: 't1',
                        title: 'write notes.txt',
                        kind: 'edit',
                        rawInput: { path: 'notes.txt' },
                        locations: [{ path: '/w/notes.txt' }, { path: '/w/b.txt', line: 3 }],
                    }
                ),
                signal
            );
            expect(elicitation.asked).toHaveLength(1);
            const [{ params, opts }] = elicitation.asked as [Asked];
            expect(params).toStrictEqual({
                mode: 'form',
                message: [
                    '[agent] write notes.txt',
                    'kind: edit',
                    'input: {"path":"notes.txt"}',
                    'locations: /w/notes.txt, /w/b.txt',
                ].join('\n'),
                requestedSchema: {
                    type: 'object',
                    properties: {
                        decision: {
                            type: 'string',
                            title: 'Decision',
                            oneOf: [
                                { const: 'allow_once', title: 'Allow once' },
                                { const: 'reject_once', title: 'Reject' },
                            ],
                        },
                    },
                    required: ['decision'],
                },
            });
            expect(opts.timeoutMs).toBe(1234);
            expect(opts.signal).toBe(signal);
        });

        it('message: only the title when nothing else is present; rawInput over 2 KB is truncated and says so', async () => {
            const elicitation = fakeElicitation(() => Promise.resolve({ action: 'cancel' }));
            const decide = decideWith(elicitation);
            await decide(request(onceOptions, { toolCallId: 't7' }), signal);
            await decide(
                request(onceOptions, { toolCallId: 't8', title: 'big', rawInput: { text: 'x'.repeat(5000) } }),
                signal
            );
            const [bare, big] = elicitation.asked.map(a => a.params.message);
            expect(bare).toBe('[agent] t7');
            const input = big?.split('\n')[1] ?? '';
            expect(input.startsWith('input: {"text":"xxx')).toBe(true);
            expect(input).toMatch(/… \(truncated, 5011 chars\)$/);
            expect(input.length).toBeLessThan(2048 + 50);
        });

        it('accept → the chosen option; decline → reject_once; cancel → cancelled', async () => {
            const answers: ElicitResult[] = [
                { action: 'accept', content: { decision: 'allow_once' } },
                { action: 'accept', content: { decision: 'reject_once' } },
                { action: 'decline' },
                { action: 'cancel' },
            ];
            const elicitation = fakeElicitation(() => Promise.resolve(answers.shift() ?? { action: 'cancel' }));
            const decide = decideWith(elicitation);
            expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'selected', optionId: 'yes' });
            expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'selected', optionId: 'no' });
            expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'selected', optionId: 'no' });
            expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'cancelled' });
        });

        it('decline without reject_once → cancelled', async () => {
            const decide = decideWith(fakeElicitation(() => Promise.resolve({ action: 'decline' })));
            expect(
                await decide(request([{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]), signal)
            ).toStrictEqual({ outcome: 'cancelled' });
        });

        it('accept with a decision not offered, or none, → cancelled', async () => {
            const answers: ElicitResult[] = [
                { action: 'accept', content: { decision: 'allow_always' } },
                { action: 'accept', content: { decision: 'reject_once' } },
                { action: 'accept' },
            ];
            const decide = decideWith(fakeElicitation(() => Promise.resolve(answers.shift() ?? { action: 'cancel' })));
            const allowOnly = request([
                { optionId: 'always', name: 'Always', kind: 'allow_always' },
                { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            ]);
            expect(await decide(allowOnly, signal)).toStrictEqual({ outcome: 'cancelled' });
            expect(await decide(allowOnly, signal)).toStrictEqual({ outcome: 'cancelled' });
            expect(await decide(allowOnly, signal)).toStrictEqual({ outcome: 'cancelled' });
        });

        it('a rejected ask (timeout, transport gone) → cancelled', async () => {
            const decide = decideWith(fakeElicitation(() => Promise.reject(new Error('Request timed out'))));
            expect(await decide(request(fullOptions), signal)).toStrictEqual({ outcome: 'cancelled' });
        });

        it('no *_once option → cancelled without asking', async () => {
            const elicitation = fakeElicitation(() => Promise.resolve({ action: 'accept' }));
            const decide = decideWith(elicitation);
            expect(
                await decide(request([{ optionId: 'always', name: 'Always', kind: 'allow_always' }]), signal)
            ).toStrictEqual({ outcome: 'cancelled' });
            expect(elicitation.asked).toHaveLength(0);
        });

        it('our submit_result is allowed before the policy, without asking', async () => {
            const elicitation = fakeElicitation(() => Promise.resolve({ action: 'decline' }));
            const bridge = createPermissionBridge('elicit', () => undefined, decideWith(elicitation));
            expect(await bridge.answer(request(onceOptions, submitCall))).toStrictEqual({
                outcome: { outcome: 'selected', optionId: 'ok' },
            });
            expect(elicitation.asked).toHaveLength(0);
        });

        it("cancelAll aborts the pending ask's signal and answers cancelled", async () => {
            const decisions: PermissionDecision[] = [];
            const elicitation = fakeElicitation(
                ({ opts }) =>
                    new Promise((_, reject) =>
                        opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
                    )
            );
            const bridge = createPermissionBridge('elicit', d => decisions.push(d), decideWith(elicitation));
            const pending = bridge.answer(request(fullOptions));
            await new Promise(resolve => setImmediate(resolve));
            expect(elicitation.asked).toHaveLength(1);
            bridge.cancelAll();
            expect(await pending).toStrictEqual({ outcome: { outcome: 'cancelled' } });
            expect(elicitation.asked[0]?.opts.signal.aborted).toBe(true);
            expect(decisions).toStrictEqual([{ title: 'write notes.txt', kind: 'edit', choice: 'cancelled' }]);
        });
    });
});
