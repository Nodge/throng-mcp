import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ElicitRequest, ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';

// The real server over stdio, driven by an MCP client: src/mcp.test.ts on the sources, scripts/pack.test.ts on dist/.

export const fakeAgent = fileURLToPath(new URL('./fake-agent/agent.ts', import.meta.url));

/** The parent env without THRONG_MCP_* (the tests may run inside a throng session), plus `vars`. */
export function serverEnv(vars: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith('THRONG_MCP_')) env[key] = value;
    }
    return { ...env, ...vars };
}

/** Config file content whose `claude` harness is the fake agent in `scenario`; `tag` marks its processes for pgrep. */
export function fakeClaudeConfig(
    tag: string,
    scenario: string,
    agentEnv: Record<string, string> = {},
    extra = ''
): string {
    return [
        'harnesses:',
        '  claude:',
        `    command: ${JSON.stringify(process.execPath)}`,
        `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
        `    env: ${JSON.stringify({ FAKE_SCENARIO: scenario, ...agentEnv })}`,
        extra,
        '',
    ].join('\n');
}

export interface ServerConnection {
    client: Client;
    pid: number;
    /** Everything the server wrote to stderr so far. */
    stderr: () => string;
    close: () => Promise<void>;
}

/** Starts `node <entry>` in `cwd` and connects a client; `onElicit` gives the client the elicitation capability. */
export async function connectServer(opts: {
    entry: string;
    cwd: string;
    env: Record<string, string>;
    onElicit?: (request: ElicitRequest) => ElicitResult;
}): Promise<ServerConnection> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [opts.entry],
        cwd: opts.cwd,
        env: opts.env,
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const { onElicit } = opts;
    const client = new Client(
        { name: 'throng-test', version: '0' },
        onElicit ? { capabilities: { elicitation: {} } } : {}
    );
    if (onElicit) client.setRequestHandler(ElicitRequestSchema, request => onElicit(request));
    await client.connect(transport);
    const pid = transport.pid;
    if (!pid) expect.unreachable('server pid');
    return { client, pid, stderr: () => stderr, close: () => client.close() };
}

/** The tool result's single JSON text block, parsed. */
export function payloadOf(result: Record<string, unknown>): unknown {
    const content = result.content as { type: string; text: string }[];
    expect(content.length).toBe(1);
    expect(content[0]?.type).toBe('text');
    return JSON.parse(content[0]?.text ?? '');
}
