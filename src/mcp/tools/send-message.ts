import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
            request: async () => ({
                kind: 'resume',
                sessionId: input.session_id,
                record: await loadSessionRecord(ctx.cacheDir, input.session_id),
            }),
        },
        ctx
    );
}

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        'send_message',
        {
            description:
                'Sends the next message into an earlier session (session_id from run_thronglet) and returns the same JSON ' +
                'as run_thronglet. A message to a session whose turn is still running waits for that turn to end: turns on ' +
                'one session never overlap. ' +
                BACKGROUND_NOTE +
                ' steer: true interrupts the running turn and delivers this message next; queued messages follow it.',
            inputSchema,
        },
        (args, extra) =>
            args.background
                ? env.callBackground(extra, ctx => sendMessage(args, ctx), args.session_id)
                : env.callRun(extra, ctx => sendMessage(args, ctx))
    );
}
