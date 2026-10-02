import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config, PermissionPolicy } from './config.ts';
import type { HarnessId } from './contract.ts';
import { log } from './log.ts';

// Answers to `session/request_permission` (DESIGN §5): auto, allow_all, deny_all, elicit.

type Outcome = RequestPermissionResponse['outcome'];
type OptionKind = RequestPermissionRequest['options'][number]['kind'];

/** The MCP client's elicitation, form mode; absent on RunContext when the client lacks the capability. */
export interface Elicitation {
    /** `server.server.elicitInput`; rejects on `signal` abort and after `timeoutMs`. */
    ask(params: ElicitRequestFormParams, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ElicitResult>;
}

export interface DeciderOptions {
    elicitation?: Elicitation;
    /** `limits.elicitation_s * 1000`. */
    elicitationTimeoutMs: number;
}

/** One answered request, for the server log. `choice` is the selected optionId or `cancelled`. */
export interface PermissionDecision {
    title: string;
    kind: string;
    choice: string;
}

/** Decides one request; `signal` aborts when the bridge is cancelled (a pending elicitation stops waiting). */
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

/** The first option of `kind` as a selected outcome, else `undefined`. */
function pick(request: RequestPermissionRequest, kind: OptionKind): Outcome | undefined {
    const option = request.options.find(o => o.kind === kind);
    return option ? { outcome: 'selected', optionId: option.optionId } : undefined;
}

/**
 * `reject_once` picked by kind (ids differ per agent); without one, `cancelled`. Used by `auto` (decision-4) and
 * `deny_all`: whatever the harness's own auto mode does not approve is refused, so `auto` never widens into allow_all.
 */
export const decideReject: Decide = request => Promise.resolve(pick(request, 'reject_once') ?? CANCELLED);

/** `allow_once` by kind; without one `reject_once`, else `cancelled`. Never `allow_always`. */
const decideAllow: Decide = request =>
    Promise.resolve(pick(request, 'allow_once') ?? pick(request, 'reject_once') ?? CANCELLED);

const ONCE_KINDS: readonly OptionKind[] = ['allow_once', 'reject_once'];
const RAW_INPUT_LIMIT = 2048;

/** The elicitation's text (DESIGN §5): title, then kind, rawInput (truncated) and locations when present. */
function elicitationMessage(toolCall: RequestPermissionRequest['toolCall']): string {
    const lines = [`[agent] ${toolCall.title ?? toolCall.toolCallId}`];
    if (toolCall.kind) lines.push(`kind: ${toolCall.kind}`);
    if (toolCall.rawInput !== undefined) {
        const json = JSON.stringify(toolCall.rawInput);
        lines.push(
            json.length > RAW_INPUT_LIMIT
                ? `input: ${json.slice(0, RAW_INPUT_LIMIT)}… (truncated, ${json.length} chars)`
                : `input: ${json}`
        );
    }
    if (toolCall.locations?.length) lines.push(`locations: ${toolCall.locations.map(l => l.path).join(', ')}`);
    return lines.join('\n');
}

/** Asks the human through the MCP client; any failure (timeout, transport gone, bad answer) → `cancelled`. */
function decideByElicitation(elicitation: Elicitation, timeoutMs: number): Decide {
    return async (request, signal) => {
        const choices = new Map<string, RequestPermissionRequest['options'][number]>();
        for (const option of request.options) {
            if (ONCE_KINDS.includes(option.kind) && !choices.has(option.kind)) choices.set(option.kind, option);
        }
        if (choices.size === 0) return CANCELLED;
        let result: ElicitResult;
        try {
            result = await elicitation.ask(
                {
                    mode: 'form',
                    message: elicitationMessage(request.toolCall),
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            decision: {
                                type: 'string',
                                title: 'Decision',
                                oneOf: [...choices].map(([kind, option]) => ({ const: kind, title: option.name })),
                            },
                        },
                        required: ['decision'],
                    },
                },
                { signal, timeoutMs }
            );
        } catch (err) {
            if (!signal.aborted) {
                log.warn('elicitation failed; permission cancelled', {
                    title: request.toolCall.title,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return CANCELLED;
        }
        if (result.action === 'decline') return pick(request, 'reject_once') ?? CANCELLED;
        if (result.action !== 'accept') return CANCELLED;
        const decision = result.content?.decision;
        const option = typeof decision === 'string' ? choices.get(decision) : undefined;
        return option ? { outcome: 'selected', optionId: option.optionId } : CANCELLED;
    };
}

/**
 * The policy's decider. `elicit` without an elicitation answers `cancelled`; run.ts refuses that combination before spawn
 * (`elicitation_unsupported`).
 */
export function deciderFor(policy: PermissionPolicy, opts: DeciderOptions): Decide {
    switch (policy) {
        case 'auto':
        case 'deny_all':
            return decideReject;
        case 'allow_all':
            return decideAllow;
        case 'elicit':
            return opts.elicitation
                ? decideByElicitation(opts.elicitation, opts.elicitationTimeoutMs)
                : () => Promise.resolve(CANCELLED);
    }
}

/** A request for throng's own `submit_result` (DESIGN §6); titles differ per harness, e.g. `mcp.throng_result.submit_result`. */
export function isThrongResultCall(toolCall: RequestPermissionRequest['toolCall']): boolean {
    const title = toolCall.title ?? '';
    return title.includes('throng_result') && title.includes('submit_result');
}

/** `allow_once` for our own submit_result under every policy; `undefined` → the policy decides. */
function allowOwnTool(request: RequestPermissionRequest): Outcome | undefined {
    return isThrongResultCall(request.toolCall) ? pick(request, 'allow_once') : undefined;
}

export function createPermissionBridge(
    policy: PermissionPolicy,
    onDecision: (decision: PermissionDecision) => void,
    decide: Decide
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
            let outcome = controller.signal.aborted ? CANCELLED : allowOwnTool(request);
            if (!outcome) {
                let settle!: (outcome: Outcome) => void;
                const cancelled = new Promise<Outcome>(resolve => (settle = resolve));
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
