import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Config, PermissionPolicy } from './config.ts';
import type { HarnessId } from './contract.ts';

// Answers to `session/request_permission` (DESIGN §5). v1 implements `auto`; run.ts refuses other policies before spawn.

type Outcome = RequestPermissionResponse['outcome'];

/** One answered request, for the server log. `choice` is the selected optionId or `cancelled`. */
export interface PermissionDecision {
  title: string;
  kind: string;
  choice: string;
}

/** Decides one request; `signal` aborts when the bridge is cancelled (an elicitation would stop waiting). */
export type Decide = (request: RequestPermissionRequest, signal: AbortSignal) => Promise<Outcome>;

export interface PermissionBridge {
  answer(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Answers every pending request `cancelled` (DESIGN §4.2 cancel path); later requests too. */
  cancelAll(): void;
}

/** Per-harness override, else the global default. Never a tool parameter (DESIGN §5). */
export function resolvePolicy(config: Config, harness: HarnessId): PermissionPolicy {
  return config.harnesses[harness]?.permissions ?? config.permissions;
}

const CANCELLED: Outcome = { outcome: 'cancelled' };

/**
 * `reject_once` picked by kind (ids differ per agent); without one, `cancelled`. Used by `auto` (decision-4):
 * whatever the harness's own auto mode does not approve is refused, so `auto` never widens into allow_all.
 */
export const decideReject: Decide = async (request) => {
  const option = request.options.find((o) => o.kind === 'reject_once');
  return option ? { outcome: 'selected', optionId: option.optionId } : CANCELLED;
};

function deciderFor(policy: PermissionPolicy): Decide {
  // allow_all / deny_all / elicit arrive in v2; until then anything but `auto` is refused before spawn.
  return policy === 'auto' ? decideReject : async () => CANCELLED;
}

export function createPermissionBridge(
  policy: PermissionPolicy,
  onDecision: (decision: PermissionDecision) => void,
  decide: Decide = deciderFor(policy),
): PermissionBridge {
  const controller = new AbortController();
  const pending = new Set<(outcome: Outcome) => void>();

  const report = (request: RequestPermissionRequest, outcome: Outcome) => {
    const { toolCall } = request;
    onDecision({
      title: toolCall.title ?? toolCall.toolCallId,
      kind: toolCall.kind ?? 'other',
      choice: outcome.outcome === 'selected' ? outcome.optionId : 'cancelled',
    });
  };

  return {
    async answer(request) {
      let outcome: Outcome;
      if (controller.signal.aborted) {
        outcome = CANCELLED;
      } else {
        let settle!: (outcome: Outcome) => void;
        const cancelled = new Promise<Outcome>((resolve) => (settle = resolve));
        pending.add(settle);
        try {
          outcome = await Promise.race([decide(request, controller.signal), cancelled]);
        } catch {
          outcome = CANCELLED;
        } finally {
          pending.delete(settle);
        }
      }
      report(request, outcome);
      return { outcome };
    },
    cancelAll() {
      controller.abort();
      for (const settle of pending) settle(CANCELLED);
      pending.clear();
    },
  };
}
