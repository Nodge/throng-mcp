import * as acp from '@agentclientprotocol/sdk';
import type {
    AgentContext,
    McpServer,
    SessionConfigOption,
    SessionModeState,
    SessionUpdate,
    StopReason,
} from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { EXECUTOR_PREFIX } from '../../src/prompt.ts';

// Minimal ACP agent for tests; no LLM. Scenario via FAKE_SCENARIO (default `echo`), see index.ts.
// Every echo turn also sends `session_info_update` with `_meta.throngDepth` = the THRONG_MCP_DEPTH it sees.

const scenario = process.env.FAKE_SCENARIO ?? 'echo';
/** FAKE_TURN_MS: an echo turn takes this long before answering (a cancel cuts it short); 0 by default. */
const turnMs = Number(process.env.FAKE_TURN_MS ?? 0);

interface FakeSession {
    resumed: boolean;
    /** From session/new or session/resume. */
    cwd: string;
    mcpServers: McpServer[];
    modeId: string;
    configOptions: SessionConfigOption[];
    cost: number;
    pending: AbortController | undefined;
    /** session/prompt calls so far, the current one included. */
    prompts: number;
}

const sessions = new Map<string, FakeSession>();

// resume-memory: one call = one fake-agent process, so what a session remembers lives on disk.
const memoryDir = process.env.FAKE_MEMORY_DIR ?? join(tmpdir(), 'throng-fake-agent');
const notesPath = (sessionId: string) => join(memoryDir, `${sessionId}.json`);

/** `undefined` when the session has no notes file. */
async function readNotes(sessionId: string): Promise<string[] | undefined> {
    try {
        return (JSON.parse(await readFile(notesPath(sessionId), 'utf8')) as { notes: string[] }).notes;
    } catch {
        return undefined;
    }
}

async function writeNotes(sessionId: string, notes: string[]): Promise<void> {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(notesPath(sessionId), JSON.stringify({ notes }));
}

/** Scenarios that end the turn with something other than end_turn. */
const STOP_REASONS: Partial<Record<string, StopReason>> = { refuse: 'refusal', 'max-turns': 'max_turn_requests' };

function freshSession(resumed: boolean, cwd: string, mcpServers: McpServer[]): FakeSession {
    const session: FakeSession = {
        resumed,
        cwd,
        mcpServers,
        modeId: 'ask',
        configOptions: [
            {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'fake-small',
                options: [
                    { value: 'fake-small', name: 'Fake Small' },
                    { value: 'fake-large', name: 'Fake Large' },
                ],
            },
            {
                id: 'effort',
                name: 'Effort',
                category: 'thought_level',
                type: 'select',
                currentValue: 'low',
                options: [
                    { value: 'low', name: 'Low' },
                    { value: 'high', name: 'High' },
                ],
            },
        ],
        cost: 0,
        pending: undefined,
        prompts: 0,
    };
    if (scenario === 'no-effort-option') session.configOptions = session.configOptions.filter(o => o.id !== 'effort');
    return session;
}

function modes(session: FakeSession): SessionModeState {
    return {
        currentModeId: session.modeId,
        availableModes: [
            { id: 'ask', name: 'Ask' },
            { id: 'auto', name: 'Auto' },
        ],
    };
}

function getSession(sessionId: string): FakeSession {
    const session = sessions.get(sessionId);
    if (!session) throw acp.RequestError.invalidParams(undefined, `unknown session ${sessionId}`);
    return session;
}

function optionValue(session: FakeSession, id: string): string {
    const option = session.configOptions.find(o => o.id === id);
    return option?.type === 'select' ? option.currentValue : '?';
}

function selectValues(option: SessionConfigOption): string[] {
    if (option.type !== 'select') return [];
    return option.options.flatMap(o => ('value' in o ? [o.value] : o.options.map(g => g.value)));
}

// submit-*: the result the agent submits to throng_result. The valid one can be overridden with FAKE_SUBMIT (JSON);
// one with string `file` and `content` (the smoke's schema) is also written to the session cwd first.
const VALID_SUBMIT: unknown = process.env.FAKE_SUBMIT ? JSON.parse(process.env.FAKE_SUBMIT) : { answer: 'pong' };
const INVALID_SUBMIT = { answer: 1 };

/** Calls `submit_result` of the session's throng_result stdio server, as a harness would. */
async function submit(session: FakeSession, result: unknown): Promise<{ isError: boolean; text: string }> {
    const entry = session.mcpServers.find(s => s.name === 'throng_result' && !('type' in s));
    if (!entry || !('command' in entry)) throw new Error('no throng_result stdio server in mcpServers');
    const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: Object.fromEntries(entry.env.map(e => [e.name, e.value])),
        stderr: 'inherit',
    });
    const client = new Client({ name: 'fake-agent', version: '0' });
    await client.connect(transport);
    try {
        const response = await client.callTool({ name: 'submit_result', arguments: { result } });
        const content = response.content as { type: string; text?: string }[];
        return { isError: response.isError === true, text: content[0]?.text ?? '' };
    } finally {
        await client.close();
    }
}

/** Resolves after a tick, rejects if the prompt was cancelled meanwhile. */
function step(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        setImmediate(() => (signal.aborted ? reject(new Error('cancelled')) : resolve()));
    });
}

/** Resolves after `ms`, rejects as soon as the prompt is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new Error('cancelled'));
            },
            { once: true }
        );
    });
}

async function runTurn(sessionId: string, text: string, client: AgentContext, signal: AbortSignal): Promise<void> {
    const session = getSession(sessionId);
    const send = (update: SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId, update });
    const say = (chunk: string) =>
        send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });

    switch (scenario) {
        case 'empty':
            return;
        case 'refuse':
            await say('I will not do that.');
            return;
        case 'write-pong':
            // Resumed: the follow-up asks which file the first turn created.
            if (session.resumed) await say('pong.txt');
            else {
                await writeFile(join(session.cwd, 'pong.txt'), 'pong');
                await say('done');
            }
            session.cost += 0.01;
            await send({
                sessionUpdate: 'usage_update',
                used: 100,
                size: 1000,
                cost: { amount: Number(session.cost.toFixed(2)), currency: 'USD' },
            });
            return;
        case 'resume-memory': {
            const notes = (await readNotes(sessionId)) ?? [];
            const suffix = ` [model=${optionValue(session, 'model')} effort=${optionValue(session, 'effort')}]`;
            if (session.resumed) await say(`you said: ${notes.join(' | ')}${suffix}`);
            else {
                // The note is the task itself, without the executor prefix every prompt carries.
                const task = text.startsWith(`${EXECUTOR_PREFIX}\n\n`) ? text.slice(EXECUTOR_PREFIX.length + 2) : text;
                await writeNotes(sessionId, [...notes, task]);
                await say(`noted${suffix}`);
            }
            session.cost += 0.01;
            await send({
                sessionUpdate: 'usage_update',
                used: 100,
                size: 1000,
                cost: { amount: Number(session.cost.toFixed(2)), currency: 'USD' },
            });
            return;
        }
        case 'submit-valid': {
            const valid = VALID_SUBMIT as { file?: unknown; content?: unknown } | null;
            if (typeof valid?.file === 'string' && typeof valid.content === 'string') {
                await writeFile(join(session.cwd, valid.file), valid.content);
            }
            await submit(session, VALID_SUBMIT);
            return;
        }
        case 'submit-invalid-then-valid': {
            const rejected = await submit(session, INVALID_SUBMIT);
            if (!rejected.isError || !rejected.text.startsWith('rejected: ')) {
                throw new Error(`invalid result not rejected: ${rejected.text}`);
            }
            await submit(session, VALID_SUBMIT);
            await say('done');
            return;
        }
        case 'submit-missing':
            await say(`turn ${session.prompts}`);
            return;
        case 'submit-invalid-always':
            await submit(session, INVALID_SUBMIT);
            await say(`turn ${session.prompts}`);
            return;
        case 'submit-ask': {
            // Like a harness that asks before an MCP tool: submits only if throng allows it.
            const answer = await client.request(acp.methods.client.session.requestPermission, {
                sessionId,
                toolCall: {
                    toolCallId: 't3',
                    title: 'mcp.throng_result.submit_result',
                    kind: 'other',
                    status: 'pending',
                },
                options: [
                    { optionId: 'approve', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'decline', name: 'Reject', kind: 'reject_once' },
                ],
            });
            if (answer.outcome.outcome !== 'selected' || answer.outcome.optionId !== 'approve') {
                await say('denied');
                return;
            }
            await submit(session, VALID_SUBMIT);
            return;
        }
        case 'echo':
            if (turnMs > 0) await sleep(turnMs, signal);
            break;
        case 'hang':
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
            return;
        case 'crash-on-prompt':
        case 'orphan-crash':
            process.stderr.write('fake-agent: boom\n', () => process.exit(3));
            await new Promise(() => {
                /* never settles */
            });
            return;
        case 'permission': {
            const answer = await client.request(acp.methods.client.session.requestPermission, {
                sessionId,
                toolCall: { toolCallId: 't2', title: 'write notes.txt', kind: 'edit', status: 'pending' },
                options: [
                    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'always', name: 'Always', kind: 'allow_always' },
                    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
                ],
            });
            const outcome =
                answer.outcome.outcome === 'cancelled'
                    ? 'cancelled'
                    : answer.outcome.optionId === 'no'
                      ? 'rejected'
                      : 'allowed';
            await say(outcome);
            return;
        }
        case 'fs-call':
            await client.request(acp.methods.client.fs.readTextFile, { sessionId, path: '/etc/hosts' }).catch(() => {
                /* ignored */
            });
            break;
        case 'notice':
            await send({
                sessionUpdate: 'notice',
                severity: 'warning',
                title: 'fake notice',
                description: 'mode fell back',
            });
            break;
    }

    await send({ sessionUpdate: 'session_info_update', _meta: { throngDepth: process.env.THRONG_MCP_DEPTH ?? null } });
    await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    await step(signal);
    await send({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read README.md',
        kind: 'read',
        status: 'in_progress',
    });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    await step(signal);
    const prefix = session.resumed ? 'resumed: ' : '';
    await say(`${prefix}echo: `);
    await say(`${text} [model=${optionValue(session, 'model')} effort=${optionValue(session, 'effort')}]`);
    session.cost += 0.01;
    await send({
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1000,
        cost: { amount: Number(session.cost.toFixed(2)), currency: 'USD' },
    });
}

// grandchild: a plain child, dies with our process group. grandchild-detached: its own group
// (setsid), like a harness's background helper — only the descendant snapshot reaches it.
if (scenario === 'grandchild' || scenario === 'grandchild-detached') {
    const child = spawn('sleep', ['300'], { stdio: 'ignore', detached: scenario === 'grandchild-detached' });
    child.unref();
    process.stderr.write(`grandchild pid=${child.pid}\n`);
}

// orphan-*: a grandchild inherits our stdout, so the client sees no EOF when we die.
// It carries our argv (the test's --tag) so a failed test can still find and kill it.
if (scenario === 'orphan-exit' || scenario === 'orphan-crash') {
    // `--`: without it node takes `--tag=…` for its own option and exits at once.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300_000)', '--', ...process.argv.slice(2)], {
        stdio: ['ignore', 'inherit', 'ignore'],
    });
    process.stderr.write(`grandchild pid=${child.pid}\n`);
    if (scenario === 'orphan-exit') {
        process.stderr.write('fake-agent: early exit\n', () => process.exit(5));
    }
}

/** early-update: a notice before answering session/new or session/resume, as real adapters do. */
async function earlyUpdate(sessionId: string, client: AgentContext): Promise<void> {
    if (scenario !== 'early-update') return;
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'notice', severity: 'info', title: 'early' },
    });
}

let app = acp.agent({ name: 'fake-agent' });

app =
    scenario === 'handshake-hang'
        ? app.onRequest(
              'initialize',
              () =>
                  new Promise(() => {
                      /* never settles */
                  })
          )
        : app.onRequest('initialize', () => ({
              protocolVersion: acp.PROTOCOL_VERSION,
              agentInfo: { name: 'fake-agent', version: '0.0.1' },
              agentCapabilities: {
                  sessionCapabilities: scenario === 'no-resume' ? {} : { resume: {} },
                  promptCapabilities: {},
              },
          }));

app.onRequest('session/new', async ctx => {
    const sessionId = `fake-${randomUUID()}`;
    const session = freshSession(false, ctx.params.cwd, ctx.params.mcpServers);
    sessions.set(sessionId, session);
    await earlyUpdate(sessionId, ctx.client);
    return { sessionId, modes: modes(session), configOptions: session.configOptions };
})
    .onRequest('session/resume', async ctx => {
        if (scenario === 'resume-memory' && !(await readNotes(ctx.params.sessionId))) {
            throw acp.RequestError.invalidParams(undefined, `unknown session ${ctx.params.sessionId}`);
        }
        const session = freshSession(true, ctx.params.cwd, ctx.params.mcpServers ?? []);
        sessions.set(ctx.params.sessionId, session);
        await earlyUpdate(ctx.params.sessionId, ctx.client);
        return { modes: modes(session), configOptions: session.configOptions };
    })
    .onRequest('session/set_mode', async ctx => {
        const session = getSession(ctx.params.sessionId);
        const valid = modes(session).availableModes.map(m => m.id);
        if (!valid.includes(ctx.params.modeId)) {
            throw acp.RequestError.invalidParams(
                undefined,
                `unknown mode ${ctx.params.modeId}; valid: ${valid.join(', ')}`
            );
        }
        if (scenario === 'mode-fallback') {
            // Like claude-agent-acp when the model lacks auto mode: another mode, announced as plain agent text.
            session.modeId = 'ask';
            const { sessionId } = ctx.params;
            await ctx.client.notify(acp.methods.client.session.update, {
                sessionId,
                update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' },
            });
            await ctx.client.notify(acp.methods.client.session.update, {
                sessionId,
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Auto mode unavailable; using Ask instead.' },
                },
            });
            return {};
        }
        session.modeId = ctx.params.modeId;
        return {};
    })
    .onRequest('session/set_config_option', ctx => {
        const session = getSession(ctx.params.sessionId);
        const { configId, value } = ctx.params;
        const option = session.configOptions.find(o => o.id === configId);
        if (option?.type !== 'select') {
            const ids = session.configOptions.map(o => o.id);
            throw acp.RequestError.invalidParams(
                undefined,
                `unknown config option ${configId}; valid: ${ids.join(', ')}`
            );
        }
        const values = selectValues(option);
        if (typeof value !== 'string' || !values.includes(value)) {
            throw acp.RequestError.invalidParams(
                undefined,
                `invalid value ${String(value)} for ${configId}; valid: ${values.join(', ')}`
            );
        }
        option.currentValue = value;
        return { configOptions: session.configOptions };
    })
    .onRequest('session/prompt', async ctx => {
        const session = getSession(ctx.params.sessionId);
        session.pending?.abort();
        const controller = new AbortController();
        session.pending = controller;
        session.prompts++;
        const text = ctx.params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('');
        try {
            await runTurn(ctx.params.sessionId, text, ctx.client, controller.signal);
        } catch (err) {
            if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
            throw err;
        } finally {
            if (session.pending === controller) session.pending = undefined;
        }
        if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
        return {
            stopReason: STOP_REASONS[scenario] ?? 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
    })
    .onNotification('session/cancel', ctx => {
        sessions.get(ctx.params.sessionId)?.pending?.abort();
    })
    .connect(
        acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
    );
