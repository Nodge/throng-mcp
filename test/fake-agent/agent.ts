import * as acp from '@agentclientprotocol/sdk';
import type { AgentContext, SessionConfigOption, SessionModeState, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

// Minimal ACP agent for tests; no LLM. Scenario via FAKE_SCENARIO (default `echo`), see index.ts.
// Every echo turn also sends `session_info_update` with `_meta.throngDepth` = the THRONG_MCP_DEPTH it sees.

const scenario = process.env.FAKE_SCENARIO ?? 'echo';

interface FakeSession {
  resumed: boolean;
  modeId: string;
  configOptions: SessionConfigOption[];
  cost: number;
  pending: AbortController | undefined;
}

const sessions = new Map<string, FakeSession>();

/** Scenarios that end the turn with something other than end_turn. */
const STOP_REASONS: Partial<Record<string, StopReason>> = { refuse: 'refusal', 'max-turns': 'max_turn_requests' };

function freshSession(resumed: boolean): FakeSession {
  const session: FakeSession = {
    resumed,
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
  };
  if (scenario === 'no-effort-option') session.configOptions = session.configOptions.filter((o) => o.id !== 'effort');
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
  const option = session.configOptions.find((o) => o.id === id);
  return option && option.type === 'select' ? option.currentValue : '?';
}

function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap((o) => ('value' in o ? [o.value] : o.options.map((g) => g.value)));
}

/** Resolves after a tick, rejects if the prompt was cancelled meanwhile. */
function step(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => (signal.aborted ? reject(new Error('cancelled')) : resolve()));
  });
}

async function runTurn(sessionId: string, text: string, client: AgentContext, signal: AbortSignal): Promise<void> {
  const session = getSession(sessionId);
  const send = (update: SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId, update });
  const say = (chunk: string) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });

  switch (scenario) {
    case 'empty':
      return;
    case 'refuse':
      await say('I will not do that.');
      return;
    case 'hang':
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
      return;
    case 'crash-on-prompt':
    case 'orphan-crash':
      process.stderr.write('fake-agent: boom\n', () => process.exit(3));
      await new Promise(() => {});
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
      const outcome = answer.outcome.outcome === 'cancelled' ? 'cancelled' : answer.outcome.optionId === 'no' ? 'rejected' : 'allowed';
      await say(outcome);
      return;
    }
    case 'fs-call':
      await client.request(acp.methods.client.fs.readTextFile, { sessionId, path: '/etc/hosts' }).catch(() => {});
      break;
    case 'notice':
      await send({ sessionUpdate: 'notice', severity: 'warning', title: 'fake notice', description: 'mode fell back' });
      break;
  }

  await send({ sessionUpdate: 'session_info_update', _meta: { throngDepth: process.env.THRONG_MCP_DEPTH ?? null } });
  await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  await step(signal);
  await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read README.md', kind: 'read', status: 'in_progress' });
  await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  await step(signal);
  const prefix = session.resumed ? 'resumed: ' : '';
  await say(`${prefix}echo: `);
  await say(`${text} [model=${optionValue(session, 'model')} effort=${optionValue(session, 'effort')}]`);
  session.cost += 0.01;
  await send({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: Number(session.cost.toFixed(2)), currency: 'USD' } });
}

if (scenario === 'grandchild') {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
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

app = scenario === 'handshake-hang'
  ? app.onRequest('initialize', () => new Promise(() => {}))
  : app.onRequest('initialize', () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'fake-agent', version: '0.0.1' },
      agentCapabilities: {
        sessionCapabilities: scenario === 'no-resume' ? {} : { resume: {} },
        promptCapabilities: {},
      },
    }));

app
  .onRequest('session/new', async (ctx) => {
    const sessionId = `fake-${randomUUID()}`;
    const session = freshSession(false);
    sessions.set(sessionId, session);
    await earlyUpdate(sessionId, ctx.client);
    return { sessionId, modes: modes(session), configOptions: session.configOptions };
  })
  .onRequest('session/resume', async (ctx) => {
    const session = freshSession(true);
    sessions.set(ctx.params.sessionId, session);
    await earlyUpdate(ctx.params.sessionId, ctx.client);
    return { modes: modes(session), configOptions: session.configOptions };
  })
  .onRequest('session/set_mode', (ctx) => {
    const session = getSession(ctx.params.sessionId);
    const valid = modes(session).availableModes.map((m) => m.id);
    if (!valid.includes(ctx.params.modeId)) {
      throw acp.RequestError.invalidParams(undefined, `unknown mode ${ctx.params.modeId}; valid: ${valid.join(', ')}`);
    }
    session.modeId = ctx.params.modeId;
    return {};
  })
  .onRequest('session/set_config_option', (ctx) => {
    const session = getSession(ctx.params.sessionId);
    const { configId, value } = ctx.params;
    const option = session.configOptions.find((o) => o.id === configId);
    if (!option || option.type !== 'select') {
      const ids = session.configOptions.map((o) => o.id);
      throw acp.RequestError.invalidParams(undefined, `unknown config option ${configId}; valid: ${ids.join(', ')}`);
    }
    const values = selectValues(option);
    if (typeof value !== 'string' || !values.includes(value)) {
      throw acp.RequestError.invalidParams(undefined, `invalid value ${String(value)} for ${configId}; valid: ${values.join(', ')}`);
    }
    option.currentValue = value;
    return { configOptions: session.configOptions };
  })
  .onRequest('session/prompt', async (ctx) => {
    const session = getSession(ctx.params.sessionId);
    session.pending?.abort();
    const controller = new AbortController();
    session.pending = controller;
    const text = ctx.params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
    try {
      await runTurn(ctx.params.sessionId, text, ctx.client, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
      throw err;
    } finally {
      if (session.pending === controller) session.pending = undefined;
    }
    if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
    return { stopReason: STOP_REASONS[scenario] ?? 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  })
  .onNotification('session/cancel', (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
