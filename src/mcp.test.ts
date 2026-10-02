import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ListHarnessesOutput, RunFailure, RunSuccess, TurnPending } from './contract.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-mcp-'));
const fakeAgent = fileURLToPath(new URL('../test/fake-agent/agent.ts', import.meta.url));

// PATH for the server: only `node`, so list_harnesses never finds (and probes) a real adapter.
const bin = join(dir, 'bin');
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));

const tags: string[] = [];
afterAll(() => {
    for (const tag of tags) {
        try {
            execFileSync('pkill', ['-9', '-f', tag]);
        } catch {
            // nothing matched
        }
    }
    rmSync(dir, { recursive: true, force: true });
});

/** Parent env with THRONG_MCP_* stripped (the tests may run inside a throng session), cache and config redirected to the temp dir, PATH = `bin`, plus overrides. */
function serverEnv(overrides: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith('THRONG_MCP_')) env[key] = value;
    }
    return {
        ...env,
        THRONG_MCP_CONFIG: join(dir, 'missing.yaml'),
        THRONG_MCP_CACHE_DIR: join(dir, 'cache'),
        PATH: bin,
        ...overrides,
    };
}

/** Unique argv marker for a fake agent the server spawns, so the test can pgrep for leftovers. */
function newTag(): string {
    const tag = `fake-agent-${randomUUID()}`;
    tags.push(tag);
    return tag;
}

function tagAlive(tag: string): boolean {
    try {
        execFileSync('pgrep', ['-f', tag]);
        return true;
    } catch {
        return false;
    }
}

function assertInstallHints(unavailable: ListHarnessesOutput['unavailable'], harnesses: string[]): void {
    expect(unavailable.map(u => u.harness)).toStrictEqual(harnesses);
    const hints: Record<string, string> = {
        claude: 'claude-agent-acp not found on PATH; install: npm i -g @agentclientprotocol/claude-agent-acp',
        codex: 'codex-acp not found on PATH; install: npm i -g @agentclientprotocol/codex-acp',
        opencode: 'opencode not found on PATH; install: see https://opencode.ai/docs (binary install)',
    };
    for (const { harness, reason } of unavailable) expect(reason).toBe(hints[harness]);
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) expect.unreachable(what);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

function writeConfig(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Starts the real server over stdio, calls list_harnesses, closes the client and checks the server exited on stdin EOF. */
async function callListHarnesses(env: Record<string, string>): Promise<{ tools: string[]; out: ListHarnessesOutput }> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['src/mcp.ts'],
        cwd: repo,
        env,
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'throng-test', version: '0' });
    await client.connect(transport);
    const pid = transport.pid;
    if (!pid) expect.unreachable('server pid');
    try {
        const { tools } = await client.listTools();
        const result = await client.callTool({ name: 'list_harnesses', arguments: {} });
        expect(result.isError).toBe(undefined);
        expect(result.structuredContent).toBe(undefined);
        const content = result.content as { type: string; text: string }[];
        expect(content.length).toBe(1);
        expect(content[0]?.type).toBe('text');
        return { tools: tools.map(t => t.name), out: JSON.parse(content[0]?.text ?? '') as ListHarnessesOutput };
    } finally {
        const started = Date.now();
        await client.close();
        // The client escalates to SIGTERM after 2 s; exiting well before that means the server handled stdin EOF itself.
        expect(Date.now() - started < 1500, `server took ${Date.now() - started} ms to exit`).toBe(true);
        expect(isAlive(pid), 'server process still alive').toBe(false);
        expect(stderr).toMatch(/throng stopping why=stdin closed/);
    }
}

describe('mcp server over stdio', () => {
    it('without adapters on PATH: every harness unavailable with its install hint, default limits', async () => {
        const { tools, out } = await callListHarnesses(serverEnv({}));
        expect(tools).toStrictEqual(['list_harnesses', 'run_thronglet', 'send_message', 'wait_thronglet']);
        expect(out.harnesses).toStrictEqual([]);
        assertInstallHints(out.unavailable, ['claude', 'codex', 'opencode']);
        expect(out.limits).toStrictEqual({
            max_concurrency: 10,
            max_depth: 2,
            default_timeout_s: 21600,
            current_depth: 0,
        });
    });

    it('probes a configured adapter: models, efforts, version', async () => {
        const tag = newTag();
        const config = writeConfig(
            'fake-claude.yaml',
            `harnesses: { claude: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"] } }\n`
        );
        const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config }));
        expect(out.harnesses).toStrictEqual([
            {
                harness: 'claude',
                command: [process.execPath, fakeAgent, `--tag=${tag}`],
                models: ['fake-small', 'fake-large'],
                efforts: ['low', 'high'],
                version: '0.0.1',
            },
        ]);
        assertInstallHints(out.unavailable, ['codex', 'opencode']);
        expect(tagAlive(tag), 'probed fake agent still running').toBe(false);
    });

    it('a probe that times out lands in unavailable and leaves no process behind', async () => {
        const tag = newTag();
        const config = writeConfig(
            'hang-claude.yaml',
            [
                'limits: { handshake_s: 1 }',
                'harnesses:',
                '  claude:',
                `    command: ${JSON.stringify(process.execPath)}`,
                `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
                '    env: { FAKE_SCENARIO: handshake-hang }',
                '',
            ].join('\n')
        );
        const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config }));
        expect(out.harnesses).toStrictEqual([]);
        expect(out.unavailable.map(u => u.harness)).toStrictEqual(['claude', 'codex', 'opencode']);
        const claude = out.unavailable[0]?.reason ?? '';
        expect(claude).toMatch(/did not answer initialize within 1000 ms/);
        assertInstallHints(out.unavailable.slice(1), ['codex', 'opencode']);
        expect(tagAlive(tag), 'timed-out fake agent still running').toBe(false);
    });

    it('reflects the config file and THRONG_MCP_DEPTH', async () => {
        const config = writeConfig('limits.yaml', 'limits: { max_depth: 3, timeout_s: 100 }\n');
        const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config, THRONG_MCP_DEPTH: '1' }));
        expect(out.limits).toStrictEqual({
            max_concurrency: 10,
            max_depth: 3,
            default_timeout_s: 100,
            current_depth: 1,
        });
    });

    it('reports a broken config in every unavailable reason', async () => {
        const config = writeConfig('broken.yaml', 'limits: [\n');
        const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config }));
        expect(out.unavailable.length).toBe(3);
        for (const { reason } of out.unavailable) {
            expect(reason.startsWith('config error: '), reason).toBe(true);
            expect(reason.includes(config), reason).toBe(true);
        }
        expect(out.limits.max_depth).toBe(2);
    });

    it('SIGTERM during a probe closes the probed adapter and removes its scratch dir', async () => {
        // An adapter that never answers and ignores stdin EOF: only the worker's close() ends it.
        const tag = newTag();
        const config = writeConfig(
            'stuck-claude.yaml',
            [
                'limits: { handshake_s: 30 }',
                'harnesses:',
                '  claude:',
                `    command: ${JSON.stringify(process.execPath)}`,
                `    args: ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(tag)}]`,
                '',
            ].join('\n')
        );
        const tmp = join(dir, 'tmp-sigterm');
        mkdirSync(tmp);
        const env = serverEnv({ THRONG_MCP_CONFIG: config, TMPDIR: tmp });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['src/mcp.ts'],
            cwd: repo,
            env,
            stderr: 'pipe',
        });
        let stderr = '';
        transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        const client = new Client({ name: 'throng-test', version: '0' });
        await client.connect(transport);
        const pid = transport.pid;
        if (!pid) expect.unreachable('server pid');
        try {
            client.callTool({ name: 'list_harnesses', arguments: {} }).catch(() => undefined);
            await waitFor(() => tagAlive(tag), 5000, 'probed adapter never started');
            expect(readdirSync(tmp).length, 'probe scratch dir').toBe(1);
            process.kill(pid, 'SIGTERM');
            await waitFor(() => !isAlive(pid), 8000, 'server did not exit after SIGTERM');
            expect(stderr).toMatch(/throng stopping why=SIGTERM/);
            expect(tagAlive(tag), 'probed adapter outlived the server').toBe(false);
            expect(readdirSync(tmp), 'probe scratch dir left behind').toStrictEqual([]);
        } finally {
            await client.close();
        }
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        it(`exits with 0 on ${signal}`, async () => {
            const child = spawn(process.execPath, ['src/mcp.ts'], {
                cwd: repo,
                env: serverEnv({}),
                stdio: ['pipe', 'ignore', 'pipe'],
            });
            let stderr = '';
            await new Promise<void>((resolve, reject) => {
                child.stderr.on('data', (chunk: Buffer) => {
                    stderr += chunk.toString();
                    if (stderr.includes('throng started')) resolve();
                });
                child.once('exit', () => reject(new Error(`server exited early: ${stderr}`)));
            });
            child.kill(signal);
            const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
            expect(code).toBe(0);
            expect(stderr).toMatch(new RegExp(`throng stopping why=${signal}`));
        });
    }
});

describe('run_thronglet over stdio', () => {
    /** Server whose `claude` harness is the fake agent in `scenario` (plus `agentEnv`); `tag` finds its adapter processes. */
    async function connect(
        scenario: string,
        agentEnv: Record<string, string> = {},
        cache = join(dir, 'cache')
    ): Promise<{ client: Client; tag: string; pid: number; close: () => Promise<void> }> {
        const tag = newTag();
        const config = writeConfig(
            `run-${tag}.yaml`,
            [
                'harnesses:',
                '  claude:',
                `    command: ${JSON.stringify(process.execPath)}`,
                `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
                `    env: ${JSON.stringify({ FAKE_SCENARIO: scenario, ...agentEnv })}`,
                '',
            ].join('\n')
        );
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['src/mcp.ts'],
            cwd: repo,
            env: serverEnv({ THRONG_MCP_CONFIG: config, THRONG_MCP_CACHE_DIR: cache }),
            stderr: 'pipe',
        });
        const client = new Client({ name: 'throng-test', version: '0' });
        await client.connect(transport);
        return { client, tag, pid: transport.pid ?? 0, close: () => client.close() };
    }

    function payloadOf(result: Record<string, unknown>): unknown {
        const content = result.content as { type: string; text: string }[];
        expect(content.length).toBe(1);
        expect(content[0]?.type).toBe('text');
        return JSON.parse(content[0]?.text ?? '');
    }

    it('success: one JSON text block, isError undefined; model_rejected is a tool error', async () => {
        const { client, tag, close } = await connect('echo');
        try {
            const result = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: 'test' },
            });
            expect(result.isError).toBe(undefined);
            expect(result.structuredContent).toBe(undefined);
            const success = payloadOf(result) as RunSuccess;
            expect(success.text?.startsWith('echo: ')).toBe(true);
            expect(success.stop_reason).toBe('end_turn');
            expect(success.session_id).toBeTruthy();

            const rejected = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/nope', prompt: 'hi', cwd: repo, description: 'test' },
            });
            expect(rejected.isError).toBe(true);
            const failure = payloadOf(rejected) as RunFailure;
            expect(failure.code).toBe('model_rejected');
            expect(failure.session_id).toBeTruthy();
            expect(tagAlive(tag)).toBe(false);
        } finally {
            await close();
        }
    });

    it('invalid arguments are rejected by the SDK', async () => {
        const { client, close } = await connect('echo');
        try {
            const missing = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', description: 'test' },
            });
            expect(missing.isError).toBe(true);
            const relative = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: 'src', description: 'test' },
            });
            expect(relative.isError).toBe(true);
            const badSchema = await client.callTool({
                name: 'run_thronglet',
                arguments: {
                    agent: 'claude/fake-small',
                    prompt: 'hi',
                    cwd: repo,
                    description: 'test',
                    schema: { type: 'nope' },
                },
            });
            expect(badSchema.isError).toBe(true);
            expect(JSON.stringify(badSchema.content)).toMatch(/schema is invalid: data\/type must be/);
            const noDescription = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo },
            });
            expect(noDescription.isError).toBe(true);
            expect(JSON.stringify(noDescription.content)).toMatch(/Input validation error.*description/);
            const emptyDescription = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: '' },
            });
            expect(emptyDescription.isError).toBe(true);
        } finally {
            await close();
        }
    });

    it('client cancel closes the adapter', async () => {
        const { client, tag, close } = await connect('hang');
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 300);
            await expect(
                client.callTool(
                    {
                        name: 'run_thronglet',
                        arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: 'test' },
                    },
                    undefined,
                    {
                        signal: controller.signal,
                    }
                )
            ).rejects.toThrow();
            await waitFor(() => !tagAlive(tag), 2000, 'adapter outlived the cancelled call');
        } finally {
            await close();
        }
    });

    it('progress notifications reach the client', async () => {
        const { client, close } = await connect('echo');
        try {
            const messages: string[] = [];
            const result = await client.callTool(
                {
                    name: 'run_thronglet',
                    arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: 'test' },
                },
                CallToolResultSchema,
                { onprogress: p => void messages.push(p.message ?? '') }
            );
            expect(result.isError).toBe(undefined);
            expect(messages.includes('read README.md'), JSON.stringify(messages)).toBe(true);
        } finally {
            await close();
        }
    });

    it('send_message: the next turn in the same session; an unknown id is a session_not_found tool error', async () => {
        const { client, tag, close } = await connect('resume-memory', {
            FAKE_MEMORY_DIR: mkdtempSync(join(dir, 'memory-')),
        });
        try {
            const run = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'remember: banana', cwd: repo, description: 'test' },
            });
            expect(run.isError).toBe(undefined);
            const first = payloadOf(run) as RunSuccess;

            const resumed = await client.callTool({
                name: 'send_message',
                arguments: { session_id: first.session_id, prompt: 'what did I say?' },
            });
            expect(resumed.isError).toBe(undefined);
            expect(resumed.structuredContent).toBe(undefined);
            const second = payloadOf(resumed) as RunSuccess;
            expect(second.session_id).toBe(first.session_id);
            expect(second.text?.startsWith('you said: remember: banana'), second.text).toBe(true);

            const unknown = await client.callTool({
                name: 'send_message',
                arguments: { session_id: 'fake-nope', prompt: 'x' },
            });
            expect(unknown.isError).toBe(true);
            const failure = payloadOf(unknown) as RunFailure;
            expect(failure.code).toBe('session_not_found');
            expect(failure.message).toMatch(/no session record for "fake-nope"/);
            expect(tagAlive(tag)).toBe(false);
        } finally {
            await close();
        }
    });

    it('background: run_thronglet returns pending, wait_thronglet the payload, also after a server restart', async () => {
        const cache = mkdtempSync(join(dir, 'cache-bg-'));
        const first = await connect('echo', { FAKE_TURN_MS: '300' }, cache);
        let payload: RunSuccess;
        let id: string;
        try {
            const started = await first.client.callTool({
                name: 'run_thronglet',
                arguments: {
                    agent: 'claude/fake-small',
                    prompt: 'hi',
                    cwd: repo,
                    description: 'test',
                    background: true,
                },
            });
            expect(started.isError).toBe(undefined);
            const pending = payloadOf(started) as TurnPending;
            expect(pending.state).toBe('running');
            expect(pending.queued).toBe(0);
            id = pending.session_id;

            const waited = await first.client.callTool({ name: 'wait_thronglet', arguments: { session_id: id } });
            expect(waited.isError).toBe(undefined);
            payload = payloadOf(waited) as RunSuccess;
            expect(payload.session_id).toBe(id);
            expect(payload.text?.startsWith('echo: '), payload.text).toBe(true);
            expect(tagAlive(first.tag)).toBe(false);
        } finally {
            await first.close();
        }

        const second = await connect('echo', {}, cache);
        try {
            const again = await second.client.callTool({ name: 'wait_thronglet', arguments: { session_id: id } });
            expect(again.isError).toBe(undefined);
            expect(payloadOf(again)).toStrictEqual(payload);
        } finally {
            await second.close();
        }
    });

    it('a server killed mid-turn: the next server marks the turn interrupted, wait_thronglet returns transport_lost', async () => {
        const cache = mkdtempSync(join(dir, 'cache-kill-'));
        const first = await connect('hang', {}, cache);
        const started = await first.client.callTool({
            name: 'run_thronglet',
            arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: 'test', background: true },
        });
        const { session_id: id } = payloadOf(started) as TurnPending;
        process.kill(first.pid, 'SIGKILL');
        await waitFor(() => !isAlive(first.pid), 2000, 'server survived SIGKILL');
        await first.close().catch(() => undefined);

        const second = await connect('echo', {}, cache);
        try {
            const waited = await second.client.callTool({ name: 'wait_thronglet', arguments: { session_id: id } });
            expect(waited.isError).toBe(true);
            const failure = payloadOf(waited) as RunFailure;
            expect(failure.code).toBe('transport_lost');
            expect(failure.message).toBe('turn interrupted: the throng server process that ran it is gone');
        } finally {
            await second.close();
        }
        await waitFor(() => !tagAlive(first.tag), 3000, 'the killed server left its adapter running');
    });
});
