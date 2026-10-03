import type { PromptResponse, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { Collector } from './collector.ts';

const note = (update: SessionUpdate): SessionNotification => ({ sessionId: 's1', update });
const text = (chunk: string): SessionNotification =>
    note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
const stop = (inputTokens?: number, outputTokens?: number): PromptResponse =>
    inputTokens === undefined || outputTokens === undefined
        ? { stopReason: 'end_turn' }
        : { stopReason: 'end_turn', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };

describe('collector', () => {
    it('text is the last turn; startTurn resets it', () => {
        const c = new Collector();
        c.startTurn();
        c.handle(text('first '));
        c.handle(text('turn'));
        c.endTurn(stop());
        expect(c.text).toBe('first turn');
        c.startTurn();
        expect(c.text).toBe('');
        c.handle(text('second'));
        c.endTurn(stop());
        expect(c.text).toBe('second');
    });

    it('pre-turn text matching preTurnNoise is dropped; other text still warns', () => {
        const c = new Collector();
        c.preTurnNoise = [/^\[MODE_UPDATE\] \S+$/];
        c.handle(text('[MODE_UPDATE] yolo'));
        c.handle(text('something else'));
        c.startTurn();
        c.handle(text('[MODE_UPDATE] yolo'));
        c.endTurn(stop());
        expect(c.text).toBe('[MODE_UPDATE] yolo');
        expect(c.warnings).toStrictEqual(['agent message before the task: something else']);
    });

    it('agent text before the turn becomes a warning, not text', () => {
        const c = new Collector();
        c.handle(text('Auto mode unavailable; using Accept edits instead.'));
        c.startTurn();
        c.handle(text('done'));
        c.endTurn(stop());
        expect(c.text).toBe('done');
        expect(c.warnings).toStrictEqual([
            'agent message before the task: Auto mode unavailable; using Accept edits instead.',
        ]);
        // Text of a finished turn is not re-reported by the next startTurn.
        c.startTurn();
        expect(c.warnings.length).toBe(1);
    });

    it('non-text message chunks are ignored for text', () => {
        const c = new Collector();
        c.startTurn();
        c.handle(
            note({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'image', data: 'AA==', mimeType: 'image/png' },
            })
        );
        expect(c.text).toBe('');
    });

    it('cost: last value wins; tokens: summed across turns', () => {
        const c = new Collector();
        c.handle(note({ sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount: 0.01, currency: 'USD' } }));
        c.endTurn(stop(10, 5));
        c.handle(note({ sessionUpdate: 'usage_update', used: 2, size: 10, cost: { amount: 0.03, currency: 'USD' } }));
        c.handle(note({ sessionUpdate: 'usage_update', used: 3, size: 10 }));
        c.endTurn(stop(7, 2));
        c.endTurn(stop());
        expect(c.usage).toStrictEqual({ cost_usd: 0.03, input_tokens: 17, output_tokens: 7 });
    });

    it('usage is empty until something reports it', () => {
        expect(new Collector().usage).toStrictEqual({});
    });

    it('notice → warnings, exact duplicates dropped', () => {
        const c = new Collector();
        c.handle(
            note({ sessionUpdate: 'notice', severity: 'warning', title: 'fell back', description: 'to default model' })
        );
        c.handle(note({ sessionUpdate: 'notice', severity: 'info', title: 'no description' }));
        c.handle(
            note({ sessionUpdate: 'notice', severity: 'warning', title: 'fell back', description: 'to default model' })
        );
        expect(c.warnings).toStrictEqual(['warning: fell back — to default model', 'info: no description']);
    });

    it('thought and plan are ignored', () => {
        const c = new Collector();
        c.startTurn();
        c.handle(note({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }));
        c.handle(note({ sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'pending' }] }));
        c.endTurn(stop());
        expect(c.text).toBe('');
        expect(c.warnings).toStrictEqual([]);
    });

    it('lastToolTitle follows tool_call and titled tool_call_update', () => {
        const c = new Collector();
        expect(c.lastToolTitle).toBe(undefined);
        c.handle(note({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read a.txt' }));
        expect(c.lastToolTitle).toBe('read a.txt');
        c.handle(note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
        expect(c.lastToolTitle).toBe('read a.txt');
        c.handle(note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'read b.txt' }));
        expect(c.lastToolTitle).toBe('read b.txt');
    });
});
