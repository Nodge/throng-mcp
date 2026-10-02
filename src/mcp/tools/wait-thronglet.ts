import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { waitThronglet } from '../../wait.ts';
import { createProgress } from '../progress.ts';
import { toolResult } from '../result.ts';
import type { ToolEnv } from '../tools.ts';

const inputSchema = {
    session_id: z.string().describe('session_id from run_thronglet'),
    timeout_s: z
        .number()
        .positive()
        .optional()
        .describe(
            'How long to wait in seconds; default from config (21600). Elapsed → the session state, not an error'
        ),
};

export const name = 'wait_thronglet';

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        name,
        {
            description:
                "Waits until a session has no running or queued turn and returns the last turn's result: the same JSON as " +
                'run_thronglet, or its error. With timeout_s elapsed returns {session_id, state, queued} instead. ' +
                'Idempotent: the result is stored with the session.',
            inputSchema,
        },
        async (args, extra) => {
            const progress = createProgress(extra);
            const result = await env.track(
                waitThronglet(args, {
                    sessions: env.sessions,
                    cacheDir: env.cacheDir,
                    signal: extra.signal,
                    progress,
                    defaultTimeoutS: env.loaded.config.limits.timeout_s,
                })
            );
            if (!extra.signal.aborted) await progress.idle();
            return toolResult(result);
        }
    );
}
