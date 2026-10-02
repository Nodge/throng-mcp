import type { TurnPending } from '../contract.ts';
import type { RunOutcome } from '../run.ts';

export interface ToolResult {
    /** The SDK's CallToolResult is open-ended. */
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

/** One JSON text block (decision-2): a pending turn and a success are results, a failure is a tool error. */
export function toolResult(result: RunOutcome | { pending: TurnPending }): ToolResult {
    if ('pending' in result) return { content: [{ type: 'text', text: JSON.stringify(result.pending) }] };
    const content = [{ type: 'text' as const, text: JSON.stringify(result.payload) }];
    return result.ok ? { content } : { content, isError: true };
}
