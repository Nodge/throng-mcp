import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ThrongError } from '../../contract.ts';
import { type RunContext, type RunOutcome, runCall } from '../../run.ts';
import { loadSessionRecord } from '../../sessions.ts';
import type { ToolEnv } from '../tools.ts';
import { backgroundField, BACKGROUND_NOTE, schemaField, timeoutField } from './run-thronglet.ts';

const inputSchema = {
    session_id: z.string().describe('session_id from run_thronglet'),
    prompt: z.string().describe('Next message for the agent'),
    schema: schemaField,
    timeout_s: timeoutField,
    background: backgroundField,
    steer: z
        .boolean()
        .optional()
        .describe(
            'Interrupt the running turn (session/cancel) and run this message as the very next turn, ahead of queued messages. The in-flight tool call is aborted; a half-applied edit may remain.'
        ),
};

export type SendMessageInput = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * DESIGN §3.3: harness, model, effort and cwd come from the session record; a busy session queues the call, or with
 * `steer` cancels its running turn and goes first.
 * Never throws, like runThronglet.
 */
export function sendMessage(input: SendMessageInput, ctx: RunContext): Promise<RunOutcome> {
    return runCall(
        {
            tool: 'send_message',
            prompt: input.prompt,
            schema: input.schema,
            timeout_s: input.timeout_s,
            logFields: { session_id: input.session_id, ...(input.steer ? { steer: true } : {}) },
            ...(input.steer ? { steer: true } : {}),
            request: async () => {
                const record = await loadSessionRecord(ctx.cacheDir, input.session_id);
                // Before the steer abort and the spawn: the running turn of a one-turn session is left alone.
                if (record.resumable === false) {
                    throw new ThrongError(
                        'session_not_found',
                        `session ${input.session_id} cannot take another message: the ${record.harness} harness has no session/resume, so its sessions are one turn`
                    );
                }
                return { kind: 'resume', sessionId: input.session_id, record };
            },
        },
        ctx
    );
}

export const name = 'send_message';

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        name,
        {
            description:
                'Sends the next message into an earlier session (session_id from run_thronglet) and returns the same JSON ' +
                'as run_thronglet. A message to a session whose turn is still running waits for that turn to end: turns on ' +
                'one session never overlap. ' +
                BACKGROUND_NOTE +
                ' steer: true interrupts the running turn and delivers this message next; queued messages follow it. ' +
                'A session whose harness cannot resume takes no further message, steer included: list_thronglets shows ' +
                'it as accepts_messages: false.',
            inputSchema,
        },
        (args, extra) =>
            args.background
                ? env.callBackground(extra, ctx => sendMessage(args, ctx), args.session_id)
                : env.callRun(extra, ctx => sendMessage(args, ctx))
    );
}
