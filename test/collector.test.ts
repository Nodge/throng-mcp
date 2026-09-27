import assert from 'node:assert/strict';
import type { PromptResponse, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, it } from 'node:test';
import { Collector } from '../src/acp/collector.ts';

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
    assert.equal(c.text, 'first turn');
    c.startTurn();
    assert.equal(c.text, '');
    c.handle(text('second'));
    c.endTurn(stop());
    assert.equal(c.text, 'second');
  });

  it('non-text message chunks are ignored for text', () => {
    const c = new Collector();
    c.startTurn();
    c.handle(note({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } }));
    assert.equal(c.text, '');
    assert.equal(c.events.length, 1);
  });

  it('cost: last value wins; tokens: summed across turns', () => {
    const c = new Collector();
    c.handle(note({ sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount: 0.01, currency: 'USD' } }));
    c.endTurn(stop(10, 5));
    c.handle(note({ sessionUpdate: 'usage_update', used: 2, size: 10, cost: { amount: 0.03, currency: 'USD' } }));
    c.handle(note({ sessionUpdate: 'usage_update', used: 3, size: 10 }));
    c.endTurn(stop(7, 2));
    c.endTurn(stop());
    assert.deepEqual(c.usage, { cost_usd: 0.03, input_tokens: 17, output_tokens: 7 });
  });

  it('usage is empty until something reports it', () => {
    assert.deepEqual(new Collector().usage, {});
  });

  it('notice → warnings, exact duplicates dropped', () => {
    const c = new Collector();
    c.handle(note({ sessionUpdate: 'notice', severity: 'warning', title: 'fell back', description: 'to default model' }));
    c.handle(note({ sessionUpdate: 'notice', severity: 'info', title: 'no description' }));
    c.handle(note({ sessionUpdate: 'notice', severity: 'warning', title: 'fell back', description: 'to default model' }));
    assert.deepEqual(c.warnings, ['warning: fell back — to default model', 'info: no description']);
  });

  it('thought and plan are transcript only', () => {
    const c = new Collector();
    c.startTurn();
    c.handle(note({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }));
    c.handle(note({ sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'pending' }] }));
    c.endTurn(stop());
    assert.equal(c.text, '');
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(
      c.events.map((e) => e.kind),
      ['update', 'update', 'stop'],
    );
    assert.equal((c.events[0]?.payload as SessionNotification).update.sessionUpdate, 'agent_thought_chunk');
  });

  it('lastToolTitle follows tool_call and titled tool_call_update', () => {
    const c = new Collector();
    assert.equal(c.lastToolTitle, undefined);
    c.handle(note({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read a.txt' }));
    assert.equal(c.lastToolTitle, 'read a.txt');
    c.handle(note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
    assert.equal(c.lastToolTitle, 'read a.txt');
    c.handle(note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'read b.txt' }));
    assert.equal(c.lastToolTitle, 'read b.txt');
  });
});
