// The prefix of every run_thronglet / resume_thronglet prompt (DESIGN §7): tells the agent where its answer goes.
// No rules about how to work: those belong to the caller's prompt.

export const EXECUTOR_PREFIX = `You are running as a nested session started by another agent through the throng MCP server. Your final message is returned to that agent as the result; it does not see your intermediate steps.

Task:`;

/** Final prompt text sent to the harness. */
export function buildPrompt(task: string): string {
    return `${EXECUTOR_PREFIX}\n\n${task}`;
}
