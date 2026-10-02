import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cancelThronglet, stopBoundMs } from '../../cancel.ts';
import { errorResult, jsonResult } from '../result.ts';
import type { ToolEnv } from '../tools.ts';

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        'cancel_thronglet',
        {
            description:
                "Cancels the session's running turn (session/cancel) and drops its queued messages; a pending wait_thronglet " +
                'returns the cancelled error. The session is idle afterwards and accepts a new send_message. No-op on an idle session.',
            inputSchema: { session_id: z.string().describe('session_id from run_thronglet') },
        },
        async args => {
            try {
                const out = await env.track(
                    cancelThronglet(args.session_id, {
                        sessions: env.sessions,
                        cacheDir: env.cacheDir,
                        stopMs: stopBoundMs({ handshakeMs: env.loaded.config.limits.handshake_s * 1000 }),
                    })
                );
                return jsonResult(out);
            } catch (err) {
                return errorResult(err);
            }
        }
    );
}
