import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker } from '../../src/acp/worker.ts';
import { parseAgentSpec } from '../../src/agent-spec.ts';
import { loadConfig } from '../../src/config.ts';
import { harnessById, loadRegistry } from '../../src/harnesses/index.ts';
import { selectEffort, selectModel } from '../../src/harnesses/select.ts';
import { decideReject } from '../../src/permissions.ts';

// Spike (THRONG-9 open question): what does an adapter do with a second session/prompt while a turn is running?
// Modes: default = concurrent prompt B during A; --steer = session/cancel A, then prompt B asking what it was doing.
// Usage: node scripts/spike/concurrent-prompt.ts <agent-spec> [--steer]

const [specText, ...flags] = process.argv.slice(2);
if (!specText) throw new Error('usage: concurrent-prompt.ts <agent-spec> [--steer]');
const steer = flags.includes('--steer');
const spec = parseAgentSpec(specText);
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...parts: unknown[]) => console.log(ts(), ...parts);

const { config } = loadConfig();
const def = harnessById(spec.harness);
const resolution = def.resolve(config, loadRegistry());
if (!resolution.available) throw new Error(resolution.reason);
const setup = def.permissionSetup('auto');
const cwd = mkdtempSync(join(tmpdir(), 'throng-spike-'));

const pending = new Set<string>();
const chunks: { at: string; pending: string; text: string }[] = [];
const worker = await startWorker(
    {
        command: resolution.launch.command,
        args: resolution.launch.args,
        env: { ...resolution.launch.env, ...setup.env },
        cwd,
        depth: 0,
    },
    { kind: 'new', cwd, mcpServers: [], ...(setup.newSessionMeta ? { meta: setup.newSessionMeta } : {}) },
    {
        onUpdate: n => {
            const u = n.update;
            const who = [...pending].join('+') || '-';
            if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
                chunks.push({ at: ts(), pending: who, text: u.content.text });
            } else if (u.sessionUpdate === 'tool_call') {
                log(`[pending ${who}] tool_call: ${u.title}`);
                onToolCall();
            } else if (
                u.sessionUpdate !== 'agent_thought_chunk' &&
                u.sessionUpdate !== 'tool_call_update' &&
                u.sessionUpdate !== 'usage_update'
            ) {
                log(`[pending ${who}] ${u.sessionUpdate}`);
            }
        },
        onPermission: req => {
            log('permission request:', req.toolCall.title);
            return decideReject(req, new AbortController().signal).then(outcome => ({ outcome }));
        },
        onWarning: w => log('warning:', w),
    },
    { handshakeMs: 60_000 }
);
log('session', worker.session.sessionId, 'agent', worker.session.agentInfo?.name, worker.session.agentInfo?.version);
if (setup.modeId) await worker.setMode(setup.modeId);
await selectModel(worker, spec.model);
if (spec.effort) log('effort:', (await selectEffort(def, worker, spec.effort)) ?? 'ok');

let firstToolCall!: () => void;
const toolCallSeen = new Promise<void>(r => (firstToolCall = r));
const state = { seen: false };
function onToolCall() {
    if (!state.seen) {
        state.seen = true;
        firstToolCall();
    }
}

const promptA =
    'Run the shell command `sleep 25` as one tool call and wait for it to finish. ' +
    'Then reply with exactly one line: "A-DONE" followed by any additional user messages you received while the command was running, quoted verbatim; ' +
    'if there were none, reply "A-DONE none". No other text.';
const promptB = steer
    ? 'New instruction. Reply with exactly one line: "B-ACK" followed by a short description of what you were doing right before this message. No other text.'
    : 'Reply with exactly one line: "B-ACK PINEAPPLE". No other text.';

async function turn(name: string, text: string) {
    pending.add(name);
    log(`prompt ${name} sent`);
    try {
        const r = await worker.prompt(text);
        log(`prompt ${name} resolved: stopReason=${r.stopReason}`);
        return { ok: true as const, r };
    } catch (err) {
        log(`prompt ${name} REJECTED:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
        return { ok: false as const, err };
    } finally {
        pending.delete(name);
    }
}

const a = turn('A', promptA);
await Promise.race([toolCallSeen, new Promise(r => setTimeout(r, 15_000))]);
log(state.seen ? 'tool call seen; A is mid-turn' : 'no tool call within 15 s; sending B anyway');
if (steer) {
    log('session/cancel');
    await worker.cancel();
    await Promise.race([a, new Promise(r => setTimeout(r, 20_000))]);
    if (pending.size) log(`A STILL PENDING 20 s after cancel: ${[...pending].join(', ')}`);
}
const b = turn('B', promptB);
await Promise.race([Promise.all([a, b]), new Promise(r => setTimeout(r, 90_000))]);
if (pending.size) {
    log(`STILL PENDING after 90 s: ${[...pending].join(', ')}; sending session/cancel`);
    await worker.cancel();
    await Promise.race([Promise.all([a, b]), new Promise(r => setTimeout(r, 10_000))]);
    if (pending.size) log(`STILL PENDING after cancel: ${[...pending].join(', ')}`);
}

console.log('\n=== agent text chunks (pending prompts at the time → text) ===');
let cur = '';
let curWho = '';
for (const c of chunks) {
    if (c.pending !== curWho) {
        if (cur) console.log(`[${curWho}] ${JSON.stringify(cur)}`);
        cur = '';
        curWho = c.pending;
    }
    cur += c.text;
}
if (cur) console.log(`[${curWho}] ${JSON.stringify(cur)}`);
console.log('stderr tail:', JSON.stringify(worker.stderrTail().slice(-1500)));
await worker.close();
