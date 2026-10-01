import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { Usage } from '../contract.ts';

// Folds the session/update stream and prompt responses into the run result (DESIGN §4.3).

export class Collector {
  #text = '';
  /** Agent text received outside a prompt turn. */
  #preTurn = '';
  #inTurn = false;
  #usage: Usage = {};
  #warnings: string[] = [];
  #lastToolTitle: string | undefined;

  /**
   * Starts a new prompt turn: `text` only ever holds the latest turn. Text the agent sent outside a turn
   * (e.g. claude-agent-acp announcing a permission-mode fallback right after set_mode) becomes a warning.
   */
  startTurn(): void {
    const before = this.#preTurn.trim();
    if (before) this.#warn(`agent message before the task: ${before.slice(0, 300)}`);
    this.#preTurn = '';
    this.#text = '';
    this.#inTurn = true;
  }

  handle(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          if (this.#inTurn) this.#text += update.content.text;
          else this.#preTurn += update.content.text;
        }
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
      case 'notice':
        this.#warn(
          update.description ? `${update.severity}: ${update.title} — ${update.description}` : `${update.severity}: ${update.title}`,
        );
        break;
    }
  }

  endTurn(response: PromptResponse): void {
    this.#inTurn = false;
    if (response.usage != null) {
      this.#usage.input_tokens = (this.#usage.input_tokens ?? 0) + response.usage.inputTokens;
      this.#usage.output_tokens = (this.#usage.output_tokens ?? 0) + response.usage.outputTokens;
    }
  }

  #warn(warning: string): void {
    if (!this.#warnings.includes(warning)) this.#warnings.push(warning);
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

  /** Title of the latest tool call seen; progress reports it. */
  get lastToolTitle(): string | undefined {
    return this.#lastToolTitle;
  }
}
