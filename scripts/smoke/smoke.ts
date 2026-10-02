import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseAgentSpec } from '../../src/agent-spec.ts';
import type {
    CancelThrongletOutput,
    ListHarnessesOutput,
    ListThrongletsOutput,
    RunFailure,
    RunSuccess,
    ThrongletInfo,
    TurnPending,
} from '../../src/contract.ts';

// Manual smoke against a REAL harness (DESIGN §9): starts `node src/mcp.ts` with the user's own env, config and cache,
// runs list_harnesses and one run_thronglet, checks the file the agent wrote, asks a send_message follow-up about it,
// and checks that no adapter process is left. With --schema the run_thronglet step asks for structured output
// (DESIGN §6) and checks `structured` as well. With --background both turns run with `background: true` (DESIGN §3.6):
// the pending answer is printed and the result is collected with wait_thronglet, then checked the same way.
// With --cancel the run goes to the background and is cancelled right away (DESIGN §3.7, §3.8): list_thronglets shows it
// running, cancel_thronglet stops it, wait_thronglet returns `cancelled`, list_thronglets shows it failed; the pong.txt
// and follow-up checks are skipped.
// With --steer the run goes to the background on a prompt that keeps it busy, and a send_message with `steer: true`
// interrupts it (DESIGN §3.3): its reply must contain STEERED, then list_thronglets shows the session idle; the pong.txt
// and follow-up checks are skipped.
// Spends tokens: run by hand, one harness at a time. Exit: 0 pass, 1 any FAIL or tool error, 2 usage/availability.

const USAGE =
    'usage: node scripts/smoke/smoke.ts <harness>/<model>[:<effort>] [--prompt "<text>"] [--cwd <dir>] [--timeout <s>] [--no-follow-up] [--schema] [--background] [--cancel] [--steer]';
const DEFAULT_PROMPT =
    'Create a file named pong.txt in the current directory containing exactly the word pong (no newline needed), then reply with the single word: done.';
const SCHEMA_PROMPT =
    'Create a file named pong.txt in the current directory containing exactly the word pong (no newline needed). ' +
    'The result is the name of the file you created (`file`) and its content (`content`).';
const SMOKE_SCHEMA = {
    type: 'object',
    properties: { file: { type: 'string' }, content: { type: 'string' } },
    required: ['file', 'content'],
};
const STEER_RUN_PROMPT =
    'Run the shell command `sleep 60` as one tool call and wait for it; then write pong.txt with "pong".';
const STEER_PROMPT = 'Stop what you are doing. Reply with exactly one line: "STEERED" followed by what you were doing.';
const FOLLOW_UP_PROMPT = 'Which file did you create in the previous step? Reply with the bare file name only.';
const DEFAULT_TIMEOUT_S = 300;
// submit-tool: the structured-output server the harness spawns; its argv carries the run's temp dir under our TMPDIR.
const ADAPTER_PATTERNS = [
    'claude-agent-acp',
    'codex-acp',
    'opencode acp',
    `submit-tool\\.ts --schema ${escapeRegex(join(tmpdir(), 'throng-'))}`,
];
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usage(message?: string): never {
    if (message) console.error(message);
    console.error(USAGE);
    process.exit(2);
}

// `pnpm smoke:x -- --prompt …` forwards the `--`; parseArgs would take everything after it as positionals.
let parsed;
try {
    parsed = parseArgs({
        args: process.argv.slice(2).filter(a => a !== '--'),
        allowPositionals: true,
        options: {
            prompt: { type: 'string' },
            cwd: { type: 'string' },
            timeout: { type: 'string' },
            'no-follow-up': { type: 'boolean' },
            schema: { type: 'boolean' },
            background: { type: 'boolean' },
            cancel: { type: 'boolean' },
            steer: { type: 'boolean' },
        },
    });
} catch (err) {
    usage(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;
if (positionals.length !== 1) usage();
const agent = positionals[0] ?? '';
const timeoutS = values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(values.timeout);
if (!(timeoutS > 0)) usage(`--timeout must be a positive number of seconds, got ${values.timeout}`);
let spec;
try {
    spec = parseAgentSpec(agent);
} catch (err) {
    usage(err instanceof Error ? err.message : String(err));
}
// A pong.txt left from an earlier run would make the file check pass without the agent writing anything.
const userCwd = values.cwd === undefined ? undefined : resolve(values.cwd);
if (userCwd && existsSync(join(userCwd, 'pong.txt')))
    usage(`${join(userCwd, 'pong.txt')} already exists; remove it or pick another --cwd`);

let step = 0;
const say = (line: string) => console.log(`${++step}. ${line}`);
const fails: string[] = [];
const check = (ok: boolean, pass: string, fail: string) => {
    console.log(ok ? `PASS: ${pass}` : `FAIL: ${fail}`);
    if (!ok) fails.push(fail);
};

/** Live pids whose command line matches one of the adapter patterns; throws when pgrep itself fails. */
function adapterPids(): Set<number> {
    const pids = new Set<number>();
    for (const pattern of ADAPTER_PATTERNS) {
        let out = '';
        try {
            out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (err) {
            // pgrep exits 1 when nothing matches; anything else (ENOENT, bad pattern) means the check can't run.
            if ((err as { status?: unknown }).status !== 1) {
                throw new Error(`pgrep failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
            }
        }
        for (const line of out.split('\n')) if (line.trim()) pids.add(Number(line.trim()));
    }
    return pids;
}

function textOf(result: Record<string, unknown>): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    return content?.[0]?.text ?? '';
}

/** Prints the fields of a run_thronglet / send_message result. */
function printResult(result: Record<string, unknown>): { isError: boolean; payload: Partial<RunSuccess & RunFailure> } {
    const isError = result.isError === true;
    const payload = JSON.parse(textOf(result)) as Partial<RunSuccess & RunFailure>;
    console.log(`   isError: ${isError}`);
    if (isError) console.log(`   code: ${payload.code}\n   message: ${payload.message}`);
    console.log(`   session_id: ${payload.session_id ?? '-'}`);
    console.log(`   stop_reason: ${payload.stop_reason ?? '-'}`);
    console.log(`   duration_s: ${payload.duration_s}`);
    console.log(`   usage: ${JSON.stringify(payload.usage ?? {})}`);
    console.log(`   warnings: ${JSON.stringify(payload.warnings ?? [])}`);
    console.log(`   text: ${JSON.stringify((payload.text ?? '').slice(0, 400))}`);
    if (payload.structured !== undefined) console.log(`   structured: ${JSON.stringify(payload.structured)}`);
    return { isError, payload };
}

const withBackground = values.background === true;

/**
 * One turn: `run_thronglet` / `send_message` as is, or with --background the call with `background: true`, its pending
 * answer printed, then `wait_thronglet` for the result. A failed background call is returned as the result.
 */
async function turn(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const options = {
        onprogress: (p: { progress: number; message?: string | undefined }) =>
            void process.stderr.write(`[progress] ${p.progress} ${p.message ?? ''}\n`),
        // The run's own timeout_s decides; the SDK's 60 s request default must not cut it short.
        timeout: (timeoutS + 60) * 1000,
    };
    if (!withBackground) return client.callTool({ name, arguments: args }, CallToolResultSchema, options);
    const accepted = await client.callTool({ name, arguments: { ...args, background: true } }, CallToolResultSchema, {
        ...options,
        // Acceptance: the handshake, plus a possible wait for a semaphore slot.
        timeout: 300_000,
    });
    if (accepted.isError === true) return accepted;
    const pending = JSON.parse(textOf(accepted)) as Partial<TurnPending>;
    console.log(`   pending: ${textOf(accepted)}`);
    check(
        typeof pending.session_id === 'string' && (pending.state === 'running' || pending.state === 'queued'),
        `${name} background accepted`,
        `${name} background answered ${textOf(accepted).slice(0, 200)}, expected {session_id, state, queued}`
    );
    say(`wait_thronglet session_id=${pending.session_id} timeout_s=${timeoutS}`);
    return client.callTool(
        { name: 'wait_thronglet', arguments: { session_id: pending.session_id, timeout_s: timeoutS } },
        CallToolResultSchema,
        options
    );
}

/** The session's row in list_thronglets, printed. */
async function listedRow(sessionId: string | undefined): Promise<ThrongletInfo | undefined> {
    const listed = await client.callTool({ name: 'list_thronglets', arguments: {} }, CallToolResultSchema, {
        timeout: 60_000,
    });
    const row = (JSON.parse(textOf(listed)) as Partial<ListThrongletsOutput>).thronglets?.find(
        t => t.session_id === sessionId
    );
    console.log(`   row: ${JSON.stringify(row)}`);
    return row;
}

/** --cancel: a background run_thronglet, then list, cancel, wait and list again. */
async function cancelSteps(args: Record<string, unknown>): Promise<void> {
    const accepted = await client.callTool(
        { name: 'run_thronglet', arguments: { ...args, background: true } },
        CallToolResultSchema,
        { timeout: 300_000 }
    );
    if (accepted.isError === true) {
        const { payload } = printResult(accepted);
        fails.push(`run_thronglet failed with ${payload.code}`);
        return;
    }
    console.log(`   pending: ${textOf(accepted)}`);
    const pending = JSON.parse(textOf(accepted)) as Partial<TurnPending>;
    const id = pending.session_id;
    check(
        typeof id === 'string' && pending.state === 'running',
        'run_thronglet background accepted',
        `run_thronglet background answered ${textOf(accepted).slice(0, 200)}, expected state running`
    );

    say('list_thronglets');
    const running = await listedRow(id);
    check(
        running?.description === 'smoke: ping/pong' && running.state === 'running',
        'list_thronglets shows the turn running',
        `list_thronglets row is ${JSON.stringify(running)}, expected description "smoke: ping/pong", state running`
    );

    say(`cancel_thronglet session_id=${id}`);
    const cancelled = await client.callTool(
        { name: 'cancel_thronglet', arguments: { session_id: id } },
        CallToolResultSchema,
        { timeout: 120_000 }
    );
    console.log(`   ${cancelled.isError === true ? 'error: ' : ''}${textOf(cancelled)}`);
    const out = JSON.parse(textOf(cancelled)) as Partial<CancelThrongletOutput>;
    check(
        cancelled.isError !== true && out.cancelled_turn === true,
        'cancel_thronglet cancelled the turn',
        `cancel_thronglet answered ${textOf(cancelled).slice(0, 200)}, expected cancelled_turn: true`
    );

    say(`wait_thronglet session_id=${id}`);
    const waited = await client.callTool(
        { name: 'wait_thronglet', arguments: { session_id: id, timeout_s: 60 } },
        CallToolResultSchema,
        { timeout: 120_000 }
    );
    const result = printResult(waited);
    check(
        result.isError && result.payload.code === 'cancelled',
        'wait_thronglet returned cancelled',
        `wait_thronglet returned ${result.isError ? result.payload.code : 'a success'}, expected the cancelled error`
    );

    say('list_thronglets');
    const failed = await listedRow(id);
    check(
        failed?.state === 'failed' && failed.last_error?.code === 'cancelled',
        'list_thronglets shows the turn failed with cancelled',
        `list_thronglets row is ${JSON.stringify(failed)}, expected state failed, last_error.code cancelled`
    );
    console.log('   pong.txt and follow-up steps skipped (--cancel)');
}

/** --steer: a background run_thronglet that stays busy, then a synchronous steer and list_thronglets. */
async function steerSteps(args: Record<string, unknown>): Promise<void> {
    const accepted = await client.callTool(
        { name: 'run_thronglet', arguments: { ...args, background: true } },
        CallToolResultSchema,
        { timeout: 300_000 }
    );
    if (accepted.isError === true) {
        const { payload } = printResult(accepted);
        fails.push(`run_thronglet failed with ${payload.code}`);
        return;
    }
    console.log(`   pending: ${textOf(accepted)}`);
    const pending = JSON.parse(textOf(accepted)) as Partial<TurnPending>;
    const id = pending.session_id;
    check(
        typeof id === 'string' && pending.state === 'running',
        'run_thronglet background accepted',
        `run_thronglet background answered ${textOf(accepted).slice(0, 200)}, expected state running`
    );

    say(`send_message session_id=${id} steer timeout_s=${timeoutS}`);
    const steered = await client.callTool(
        { name: 'send_message', arguments: { session_id: id, prompt: STEER_PROMPT, steer: true, timeout_s: timeoutS } },
        CallToolResultSchema,
        { timeout: (timeoutS + 60) * 1000 }
    );
    const result = printResult(steered);
    const text = result.payload.text ?? '';
    check(
        !result.isError && text.includes('STEERED'),
        'send_message steer answered STEERED',
        result.isError
            ? `send_message steer failed with ${result.payload.code}`
            : `send_message steer answered ${JSON.stringify(text.slice(0, 200))}, expected STEERED`
    );

    say('list_thronglets');
    const row = await listedRow(id);
    check(
        row?.state === 'idle',
        'list_thronglets shows the session idle',
        `list_thronglets row is ${JSON.stringify(row)}, expected state idle`
    );
    console.log('   pong.txt and follow-up steps skipped (--steer)');
}

function table(rows: string[][]): string {
    const widths = rows[0]?.map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length))) ?? [];
    return rows
        .map(
            r =>
                '   ' +
                r
                    .map((cell, i) => cell.padEnd(widths[i] ?? 0))
                    .join('  ')
                    .trimEnd()
        )
        .join('\n');
}

say(`start server: node src/mcp.ts (cwd ${repo})`);
const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp.ts'],
    cwd: repo,
    env: process.env as Record<string, string>,
    stderr: 'pipe',
});
let stderrTail = '';
transport.stderr?.on('data', (chunk: Buffer) => {
    const lines = (stderrTail + chunk.toString()).split('\n');
    stderrTail = lines.pop() ?? '';
    for (const line of lines) process.stderr.write(`[server] ${line}\n`);
});
const client = new Client({ name: 'throng-smoke', version: '0' });
await client.connect(transport);

let before: Set<number> | undefined;
let pgrepError: string | undefined;
try {
    before = adapterPids();
    say(`adapter processes before: ${before.size ? [...before].join(' ') : 'none'}`);
} catch (err) {
    pgrepError = err instanceof Error ? err.message : String(err);
    say(`adapter processes before: unknown (${pgrepError})`);
}

let exitCode = 0;
let cwd: string | undefined;
let createdCwd = false;
try {
    say('list_harnesses');
    const listed = await client.callTool({ name: 'list_harnesses', arguments: {} }, CallToolResultSchema, {
        timeout: 180_000,
    });
    const out = JSON.parse(textOf(listed)) as ListHarnessesOutput;
    console.log(
        table([
            ['harness', 'version', 'models', 'efforts', 'command'],
            ...out.harnesses.map(h => [
                h.harness,
                h.version ?? '?',
                String(h.models.length),
                h.efforts.join(',') || '-',
                h.command.join(' '),
            ]),
        ])
    );
    for (const u of out.unavailable) console.log(`   unavailable: ${u.harness}: ${u.reason}`);
    console.log(`   limits: ${JSON.stringify(out.limits)}`);

    const info = out.harnesses.find(h => h.harness === spec.harness);
    if (!info) {
        console.log(`harness ${spec.harness} is not available (see its reason above)`);
        exitCode = 2;
    } else if (!info.models.includes(spec.model)) {
        console.log(
            `model ${spec.model} is not offered by ${spec.harness}; valid models (${info.models.length} total):`
        );
        for (const model of info.models.slice(0, 40)) console.log(`   ${model}`);
        if (info.models.length > 40) console.log(`   … ${info.models.length - 40} more`);
        exitCode = 2;
    } else if (values.cancel === true) {
        cwd = userCwd ?? mkdtempSync(join(tmpdir(), 'throng-smoke-'));
        createdCwd = userCwd === undefined;
        say(`run_thronglet agent=${agent} cwd=${cwd} timeout_s=${timeoutS} background, then cancel`);
        await cancelSteps({
            agent,
            prompt: values.prompt ?? DEFAULT_PROMPT,
            description: 'smoke: ping/pong',
            cwd,
            timeout_s: timeoutS,
        });
    } else if (values.steer === true) {
        cwd = userCwd ?? mkdtempSync(join(tmpdir(), 'throng-smoke-'));
        createdCwd = userCwd === undefined;
        say(`run_thronglet agent=${agent} cwd=${cwd} timeout_s=${timeoutS} background, then steer`);
        await steerSteps({
            agent,
            prompt: values.prompt ?? STEER_RUN_PROMPT,
            description: 'smoke: steer',
            cwd,
            timeout_s: timeoutS,
        });
    } else {
        cwd = userCwd ?? mkdtempSync(join(tmpdir(), 'throng-smoke-'));
        createdCwd = userCwd === undefined;
        const withSchema = values.schema === true;
        say(
            `run_thronglet agent=${agent} cwd=${cwd} timeout_s=${timeoutS}${withSchema ? ' schema' : ''}${withBackground ? ' background' : ''}`
        );
        const result = await turn('run_thronglet', {
            agent,
            prompt: values.prompt ?? (withSchema ? SCHEMA_PROMPT : DEFAULT_PROMPT),
            description: 'smoke: ping/pong',
            cwd,
            timeout_s: timeoutS,
            ...(withSchema ? { schema: SMOKE_SCHEMA } : {}),
        });

        say('result');
        const { isError, payload } = printResult(result);
        if (isError) fails.push(`run_thronglet failed with ${payload.code}`);

        if (withSchema && !isError) {
            say('check structured');
            const structured = payload.structured as { file?: unknown; content?: unknown } | undefined;
            check(
                structured?.file === 'pong.txt' &&
                    typeof structured.content === 'string' &&
                    structured.content.trim() === 'pong',
                'structured is {file: pong.txt, content: pong}',
                `structured is ${JSON.stringify(structured)}, expected {file: pong.txt, content: pong}`
            );
        }

        say('check pong.txt');
        let content: string | undefined;
        try {
            content = readFileSync(join(cwd, 'pong.txt'), 'utf8');
        } catch {
            // missing
        }
        check(
            content?.trim() === 'pong',
            'pong.txt written',
            content === undefined
                ? `pong.txt not found in ${cwd}`
                : `pong.txt contains ${JSON.stringify(content.slice(0, 100))}, expected pong`
        );

        if (values['no-follow-up']) {
            console.log('   follow-up step skipped (--no-follow-up)');
        } else if (isError || !payload.session_id) {
            console.log('   follow-up step skipped: run_thronglet failed');
        } else {
            say(
                `send_message session_id=${payload.session_id} timeout_s=${timeoutS}${withBackground ? ' background' : ''}`
            );
            const sent = await turn('send_message', {
                session_id: payload.session_id,
                prompt: FOLLOW_UP_PROMPT,
                timeout_s: timeoutS,
            });
            const follow = printResult(sent);
            const text = follow.payload.text ?? '';
            check(
                !follow.isError && text.includes('pong.txt'),
                'send_message answered pong.txt',
                follow.isError
                    ? `send_message failed with ${follow.payload.code}`
                    : `send_message answered ${JSON.stringify(text.slice(0, 100))}, expected pong.txt`
            );
        }
    }
} catch (err) {
    console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    fails.push('smoke threw');
} finally {
    await client.close();
    if (stderrTail) process.stderr.write(`[server] ${stderrTail}\n`);
}

say('check adapter processes');
if (before && !pgrepError) {
    const baseline = before;
    let orphans: number[] = [];
    const deadline = Date.now() + 3000;
    try {
        for (;;) {
            orphans = [...adapterPids()].filter(pid => !baseline.has(pid));
            if (orphans.length === 0 || Date.now() >= deadline) break;
            await new Promise(r => setTimeout(r, 200));
        }
    } catch (err) {
        pgrepError = err instanceof Error ? err.message : String(err);
    }
    if (!pgrepError) check(orphans.length === 0, 'no orphans', `orphaned adapter processes: ${orphans.join(' ')}`);
}
if (pgrepError) check(false, '', `cannot check orphans (${pgrepError})`);

if (fails.length && exitCode === 0) exitCode = 1;
if (cwd && createdCwd) {
    if (exitCode === 0) rmSync(cwd, { recursive: true, force: true });
    else console.log(`kept cwd for inspection: ${cwd}`);
}
console.log(exitCode === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (exit ${exitCode})`);
process.exitCode = exitCode;
