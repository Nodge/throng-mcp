import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HARNESS_IDS, ThrongError } from '../../contract.ts';
import { type RunContext, type RunOutcome, runCall } from '../../run.ts';
import { readSessionRecord, type SessionRecord } from '../../sessions.ts';
import type { ToolEnv } from '../tools.ts';
import { schemaField, timeoutField } from './run-thronglet.ts';

const inputSchema = {
    session_id: z.string().describe('session_id from run_thronglet'),
    prompt: z.string().describe('Next message for the agent'),
    schema: schemaField,
    timeout_s: timeoutField,
};

export type SendMessageInput = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * DESIGN §3.3: harness, model, effort and cwd come from the session record; a busy session queues the call.
 * Never throws, like runThronglet.
 */
export function sendMessage(input: SendMessageInput, ctx: RunContext): Promise<RunOutcome> {
    return runCall(
        {
            tool: 'send_message',
            prompt: input.prompt,
            schema: input.schema,
            timeout_s: input.timeout_s,
            logFields: { session_id: input.session_id },
            request: async () => ({
                kind: 'resume',
                sessionId: input.session_id,
                record: await loadRecord(ctx.cacheDir, input.session_id),
            }),
        },
        ctx
    );
}

/** Any record we can't use is `session_not_found`: missing, unsafe id, unreadable or corrupt file. */
async function loadRecord(dir: string, sessionId: string): Promise<SessionRecord> {
    const id = JSON.stringify(sessionId);
    let record: SessionRecord | undefined;
    try {
        record = await readSessionRecord(dir, sessionId);
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new ThrongError('session_not_found', `session record for ${id} is unreadable: ${why}`);
    }
    if (!record)
        throw new ThrongError(
            'session_not_found',
            `no session record for ${id} (records live 14 days under ${dir}/sessions)`
        );
    if (
        !(HARNESS_IDS as readonly unknown[]).includes(record.harness) ||
        typeof record.model !== 'string' ||
        typeof record.cwd !== 'string'
    ) {
        throw new ThrongError('session_not_found', `session record for ${id} is corrupt: ${JSON.stringify(record)}`);
    }
    return record;
}

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        'send_message',
        {
            description:
                'Sends the next message into an earlier session (session_id from run_thronglet) and returns the same JSON ' +
                'as run_thronglet. A message to a session whose turn is still running waits for that turn to end: turns on ' +
                'one session never overlap.',
            inputSchema,
        },
        (args, extra) => env.callRun(extra, ctx => sendMessage(args, ctx))
    );
}
