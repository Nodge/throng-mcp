import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { Usage } from '../errors.ts';

// Folds the session/update stream and prompt responses into the run result (DESIGN §4.3).

export interface TranscriptEvent {
  ts: number;
  kind: 'update' | 'stop';
  payload: unknown;
}

export class Collector {
  #text = '';
  #usage: Usage = {};
  #warnings: string[] = [];
  #events: TranscriptEvent[] = [];
  #lastToolTitle: string | undefined;

  /** Starts a new prompt turn: `text` only ever holds the latest turn. */
  startTurn(): void {
    this.#text = '';
  }

  handle(notification: SessionNotification): void {
    this.#events.push({ ts: Date.now(), kind: 'update', payload: notification });
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.#text += update.content.text;
        break;
      case 'tool_call':
        this.#lastToolTitle = update.title;
        break;
      case 'tool_call_update':
        if (update.title != null) this.#lastToolTitle = update.title;
        break;
      case 'usage_update':
        if (update.cost != null) this.#usage.cost_usd = update.cost.amount;
        break;
      case 'notice': {
        const warning = update.description
          ? `${update.severity}: ${update.title} — ${update.description}`
          : `${update.severity}: ${update.title}`;
        if (!this.#warnings.includes(warning)) this.#warnings.push(warning);
        break;
      }
    }
  }

  endTurn(response: PromptResponse): void {
    this.#events.push({ ts: Date.now(), kind: 'stop', payload: response });
    if (response.usage != null) {
      this.#usage.input_tokens = (this.#usage.input_tokens ?? 0) + response.usage.inputTokens;
      this.#usage.output_tokens = (this.#usage.output_tokens ?? 0) + response.usage.outputTokens;
    }
  }

  /** Agent text of the last turn. */
  get text(): string {
    return this.#text;
  }

  get usage(): Usage {
    return { ...this.#usage };
  }

  get warnings(): string[] {
    return [...this.#warnings];
  }

  get events(): TranscriptEvent[] {
    return [...this.#events];
  }

  /** Title of the latest tool call seen; progress reports it. */
  get lastToolTitle(): string | undefined {
    return this.#lastToolTitle;
  }
}
