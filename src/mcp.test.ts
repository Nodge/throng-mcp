import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    CallToolResultSchema,
    type ElicitRequest,
    type ElicitRequestFormParams,
    type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type {
    CancelThrongletOutput,
    ListHarnessesOutput,
    ListThrongletsOutput,
    RunFailure,
    RunSuccess,
    TurnPending,
} from './contract.ts';
import { connectServer, fakeAgent, fakeClaudeConfig, payloadOf, serverEnv as cleanEnv } from '../test/mcp-server.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-mcp-'));

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

/** Server env with cache and config redirected to the temp dir, PATH = `bin`, plus overrides. */
function serverEnv(overrides: Record<string, string>): Record<string, string> {
    return cleanEnv({
        THRONG_MCP_CONFIG: join(dir, 'missing.yaml'),
        THRONG_MCP_CACHE_DIR: join(dir, 'cache'),
        PATH: bin,
        ...overrides,
    });
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
        gemini: 'gemini not found on PATH; install: npm i -g @google/gemini-cli',
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
    const { client, pid, stderr } = await connectServer({ entry: 'src/mcp.ts', cwd: repo, env });
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
        expect(stderr()).toMatch(/throng stopping why=stdin closed/);
    }
}

describe('mcp server over stdio', () => {
    it('without adapters on PATH: every harness unavailable with its install hint, default limits', async () => {
        const { tools, out } = await callListHarnesses(serverEnv({}));
        expect(tools).toStrictEqual([
            'cancel_thronglet',
            'list_harnesses',
            'list_thronglets',
            'run_thronglet',
            'send_message',
            'wait_thronglet',
        ]);
        expect(out.harnesses).toStrictEqual([]);
        assertInstallHints(out.unavailable, ['claude', 'codex', 'opencode', 'gemini']);
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
        assertInstallHints(out.unavailable, ['codex', 'opencode', 'gemini']);
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
        expect(out.unavailable.map(u => u.harness)).toStrictEqual(['claude', 'codex', 'opencode', 'gemini']);
        const claude = out.unavailable[0]?.reason ?? '';
        expect(claude).toMatch(/did not answer initialize within 1000 ms/);
        assertInstallHints(out.unavailable.slice(1), ['codex', 'opencode', 'gemini']);
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
        expect(out.unavailable.length).toBe(4);
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
        const { client, pid, stderr } = await connectServer({ entry: 'src/mcp.ts', cwd: repo, env });
        try {
            client.callTool({ name: 'list_harnesses', arguments: {} }).catch(() => undefined);
            await waitFor(() => tagAlive(tag), 5000, 'probed adapter never started');
            expect(readdirSync(tmp).length, 'probe scratch dir').toBe(1);
            process.kill(pid, 'SIGTERM');
            await waitFor(() => !isAlive(pid), 8000, 'server did not exit after SIGTERM');
            expect(stderr()).toMatch(/throng stopping why=SIGTERM/);
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
    /**
     * Server whose `claude` harness is the fake agent in `scenario` (plus `agentEnv`); `tag` finds its adapter processes.
     * `config` lines are appended to the config file; `onElicit` makes a client with the elicitation capability.
     */
    async function connect(
        scenario: string,
        agentEnv: Record<string, string> = {},
        cache = join(dir, 'cache'),
        opts: { config?: string; onElicit?: (request: ElicitRequest) => ElicitResult } = {}
    ): Promise<{ client: Client; tag: string; pid: number; close: () => Promise<void> }> {
        const tag = newTag();
        const config = writeConfig(`run-${tag}.yaml`, fakeClaudeConfig(tag, scenario, agentEnv, opts.config));
        const { client, pid, close } = await connectServer({
            entry: 'src/mcp.ts',
            cwd: repo,
            env: serverEnv({ THRONG_MCP_CONFIG: config, THRONG_MCP_CACHE_DIR: cache }),
            ...(opts.onElicit ? { onElicit: opts.onElicit } : {}),
        });
        return { client, tag, pid, close };
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

            const listed = await first.client.callTool({ name: 'list_thronglets', arguments: {} });
            expect(listed.isError).toBe(undefined);
            const { thronglets } = payloadOf(listed) as ListThrongletsOutput;
            expect(thronglets.find(t => t.session_id === id)).toMatchObject({
                description: 'test',
                agent: 'claude/fake-small',
                cwd: repo,
                state: 'idle',
                queued: 0,
            });
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

            const listed = await second.client.callTool({ name: 'list_thronglets', arguments: {} });
            const { thronglets } = payloadOf(listed) as ListThrongletsOutput;
            expect(thronglets.find(t => t.session_id === id)).toMatchObject({
                state: 'failed',
                last_error: {
                    code: 'transport_lost',
                    message: 'turn interrupted: the throng server process that ran it is gone',
                },
            });
        } finally {
            await second.close();
        }
        await waitFor(() => !tagAlive(first.tag), 3000, 'the killed server left its adapter running');
    });

    it('list_thronglets shows a running background turn; cancel_thronglet stops it, wait_thronglet returns cancelled', async () => {
        const cache = mkdtempSync(join(dir, 'cache-cancel-'));
        const { client, tag, close } = await connect('hang', {}, cache);
        try {
            const started = await client.callTool({
                name: 'run_thronglet',
                arguments: {
                    agent: 'claude/fake-small',
                    prompt: 'hi',
                    cwd: repo,
                    description: 'cancel me',
                    background: true,
                },
            });
            const { session_id: id } = payloadOf(started) as TurnPending;
            const listed = await client.callTool({ name: 'list_thronglets', arguments: {} });
            expect(listed.isError).toBe(undefined);
            expect((payloadOf(listed) as ListThrongletsOutput).thronglets).toMatchObject([
                { session_id: id, description: 'cancel me', state: 'running', queued: 0, accepts_messages: true },
            ]);

            const cancelled = await client.callTool({ name: 'cancel_thronglet', arguments: { session_id: id } });
            expect(cancelled.isError).toBe(undefined);
            expect(payloadOf(cancelled) as CancelThrongletOutput).toStrictEqual({
                session_id: id,
                state: 'idle',
                cancelled_turn: true,
            });
            expect(tagAlive(tag)).toBe(false);

            const waited = await client.callTool({ name: 'wait_thronglet', arguments: { session_id: id } });
            expect(waited.isError).toBe(true);
            expect(payloadOf(waited)).toMatchObject({ code: 'cancelled', message: 'cancelled by cancel_thronglet' });

            const unknown = await client.callTool({ name: 'cancel_thronglet', arguments: { session_id: 'fake-nope' } });
            expect(unknown.isError).toBe(true);
            expect(payloadOf(unknown)).toMatchObject({ code: 'session_not_found', duration_s: 0 });
        } finally {
            await close();
        }
    });

    it('send_message steer: interrupts a running background turn, returns the steered reply; the session ends idle', async () => {
        const cache = mkdtempSync(join(dir, 'cache-steer-'));
        const { client, tag, close } = await connect(
            'steer',
            { FAKE_MEMORY_DIR: mkdtempSync(join(dir, 'memory-')) },
            cache
        );
        try {
            const started = await client.callTool({
                name: 'run_thronglet',
                arguments: {
                    agent: 'claude/fake-small',
                    prompt: 'long task',
                    cwd: repo,
                    description: 'steer me',
                    background: true,
                },
            });
            const { session_id: id, state } = payloadOf(started) as TurnPending;
            expect(state).toBe('running');

            const steered = await client.callTool({
                name: 'send_message',
                arguments: { session_id: id, prompt: 'change of plans', steer: true },
            });
            expect(steered.isError).toBe(undefined);
            expect((payloadOf(steered) as RunSuccess).text).toBe('you said: long task | change of plans');
            expect(tagAlive(tag)).toBe(false);

            const listed = await client.callTool({ name: 'list_thronglets', arguments: {} });
            expect((payloadOf(listed) as ListThrongletsOutput).thronglets).toMatchObject([
                { session_id: id, state: 'idle', queued: 0 },
            ]);
        } finally {
            await close();
        }
    });

    it('permissions elicit: the client is asked in form mode and its answer reaches the agent', async () => {
        const asked: ElicitRequest['params'][] = [];
        const { client, tag, close } = await connect('permission', {}, join(dir, 'cache'), {
            config: 'permissions: elicit',
            onElicit: request => {
                asked.push(request.params);
                return { action: 'accept', content: { decision: 'allow_once' } };
            },
        });
        try {
            const result = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: 'test' },
            });
            expect(result.isError).toBe(undefined);
            expect((payloadOf(result) as RunSuccess).text).toBe('allowed');
            expect(asked).toHaveLength(1);
            const params = asked[0] as ElicitRequestFormParams;
            expect(params.message.split('\n')[0]).toBe('[agent] write notes.txt');
            expect(params.requestedSchema.properties.decision).toStrictEqual({
                type: 'string',
                title: 'Decision',
                oneOf: [
                    { const: 'allow_once', title: 'Allow' },
                    { const: 'reject_once', title: 'Reject' },
                ],
            });
            expect(tagAlive(tag)).toBe(false);
        } finally {
            await close();
        }
    });

    it('permissions elicit with a client without elicitation → elicitation_unsupported tool error, no spawn', async () => {
        const { client, tag, close } = await connect('permission', {}, join(dir, 'cache'), {
            config: 'permissions: elicit',
        });
        try {
            const result = await client.callTool({
                name: 'run_thronglet',
                arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo, description: 'test' },
            });
            expect(result.isError).toBe(true);
            expect(payloadOf(result)).toMatchObject({ code: 'elicitation_unsupported' });
            expect(tagAlive(tag)).toBe(false);
        } finally {
            await close();
        }
    });
});
