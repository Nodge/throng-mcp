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
import type { ListHarnessesOutput, RunFailure, RunSuccess } from '../../src/contract.ts';

// Manual smoke against a REAL harness (DESIGN §9): starts `node src/mcp.ts` with the user's own env, config and cache,
// runs list_harnesses and one run_thronglet, checks the file the agent wrote, asks a resume_thronglet follow-up about it,
// and checks that no adapter process is left. With --schema the run_thronglet step asks for structured output
// (DESIGN §6) and checks `structured` as well.
// Spends tokens: run by hand, one harness at a time. Exit: 0 pass, 1 any FAIL or tool error, 2 usage/availability.

const USAGE =
    'usage: node scripts/smoke/smoke.ts <harness>/<model>[:<effort>] [--prompt "<text>"] [--cwd <dir>] [--timeout <s>] [--no-resume] [--schema]';
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
const RESUME_PROMPT = 'Which file did you create in the previous step? Reply with the bare file name only.';
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
            'no-resume': { type: 'boolean' },
            schema: { type: 'boolean' },
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

/** Prints the fields of a run_thronglet / resume_thronglet result. */
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
    } else {
        if (userCwd) {
            cwd = userCwd;
        } else {
            cwd = mkdtempSync(join(tmpdir(), 'throng-smoke-'));
            createdCwd = true;
        }
        const withSchema = values.schema === true;
        say(`run_thronglet agent=${agent} cwd=${cwd} timeout_s=${timeoutS}${withSchema ? ' schema' : ''}`);
        const result = await client.callTool(
            {
                name: 'run_thronglet',
                arguments: {
                    agent,
                    prompt: values.prompt ?? (withSchema ? SCHEMA_PROMPT : DEFAULT_PROMPT),
                    cwd,
                    timeout_s: timeoutS,
                    ...(withSchema ? { schema: SMOKE_SCHEMA } : {}),
                },
            },
            CallToolResultSchema,
            {
                onprogress: p => void process.stderr.write(`[progress] ${p.progress} ${p.message ?? ''}\n`),
                // The run's own timeout_s decides; the SDK's 60 s request default must not cut it short.
                timeout: (timeoutS + 60) * 1000,
            }
        );

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

        if (values['no-resume']) {
            console.log('   resume step skipped (--no-resume)');
        } else if (isError || !payload.session_id) {
            console.log('   resume step skipped: run_thronglet failed');
        } else {
            say(`resume_thronglet session_id=${payload.session_id} timeout_s=${timeoutS}`);
            const resumed = await client.callTool(
                {
                    name: 'resume_thronglet',
                    arguments: { session_id: payload.session_id, prompt: RESUME_PROMPT, timeout_s: timeoutS },
                },
                CallToolResultSchema,
                {
                    onprogress: p => void process.stderr.write(`[progress] ${p.progress} ${p.message ?? ''}\n`),
                    timeout: (timeoutS + 60) * 1000,
                }
            );
            const follow = printResult(resumed);
            const text = follow.payload.text ?? '';
            check(
                !follow.isError && text.includes('pong.txt'),
                'resume answered pong.txt',
                follow.isError
                    ? `resume failed with ${follow.payload.code}`
                    : `resume answered ${JSON.stringify(text.slice(0, 100))}, expected pong.txt`
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
