import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HARNESS_IDS, ThrongError } from '../../contract.ts';
import { type RunContext, type RunOutcome, runCall } from '../../run.ts';
import { readSessionRecord, type SessionRecord } from '../../sessions.ts';
import type { ToolEnv } from '../tools.ts';
import { schemaField, timeoutField } from './run-thronglet.ts';

const inputSchema = {
    session_id: z.string().describe('session_id from a previous run_thronglet / resume_thronglet'),
    prompt: z.string().describe('Follow-up message for the agent'),
    schema: schemaField,
    timeout_s: timeoutField,
};

export type ResumeThrongletInput = z.infer<z.ZodObject<typeof inputSchema>>;

/** DESIGN §3.3: harness, model, effort and cwd come from the session record. Never throws, like runThronglet. */
export function resumeThronglet(input: ResumeThrongletInput, ctx: RunContext): Promise<RunOutcome> {
    return runCall(
        {
            tool: 'resume_thronglet',
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
        'resume_thronglet',
        {
            description:
                'Sends a follow-up prompt into an earlier session (session_id from run_thronglet / resume_thronglet). ' +
                'Returns the same JSON as run_thronglet.',
            inputSchema,
        },
        (args, extra) => env.callRun(extra, ctx => resumeThronglet(args, ctx))
    );
}
