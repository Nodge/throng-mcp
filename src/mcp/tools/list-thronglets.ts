import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listThronglets } from '../../list-thronglets.ts';
import { jsonResult } from '../result.ts';
import type { ToolEnv } from '../tools.ts';

export const name = 'list_thronglets';

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        name,
        {
            description:
                'Lists thronglet sessions on this machine: description, agent, cwd, state (running | queued | idle | failed), ' +
                "queue length, accepts_messages (false: send_message to it fails), timestamps and the last error. Live state is this server's; a session run by another throng " +
                'instance shows what its record says.',
            inputSchema: {},
        },
        async () => jsonResult(await env.track(listThronglets(env.cacheDir, env.sessions)))
    );
}
