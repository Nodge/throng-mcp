// The prefix of every run_thronglet / send_message prompt (DESIGN §7): tells the agent where its answer goes.
// No rules about how to work: those belong to the caller's prompt.

export const EXECUTOR_PREFIX = `You are running as a nested session started by another agent through the throng MCP server. Your final message is returned to that agent as the result; it does not see your intermediate steps.

Task:`;

/** Final prompt text sent to the harness; with structured output, the submit_result instruction follows the task (DESIGN §6). */
export function buildPrompt(task: string, structured = false): string {
    const prompt = `${EXECUTOR_PREFIX}\n\n${task}`;
    if (!structured) return prompt;
    return (
        `${prompt}\n\n` +
        'Result format: when you are done, call the `submit_result` tool of the `throng_result` MCP server exactly once; ' +
        'its input schema describes the required `result` (the submitted result, not your final message, is returned ' +
        'to the caller). If the call is rejected, fix the result and call it again in the same turn.'
    );
}

/** Re-prompt after a turn that ended without a valid submit_result: `last` is the rejected call, if any. */
export function buildCorrectivePrompt(last: { ok: false; errors: string } | undefined): string {
    if (!last) {
        return (
            'You ended the turn without calling submit_result. Call `submit_result` of the `throng_result` MCP server ' +
            'now with a result matching its input schema.'
        );
    }
    return `Your last submit_result call was rejected: ${last.errors}. Fix the result and call submit_result again.`;
}
