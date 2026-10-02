import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/smoke/smoke.ts driven against the fake agent: the real smoke is the maintainer's (it spends tokens).

const repo = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-smoke-test-'));
const fakeAgent = fileURLToPath(new URL('../../test/fake-agent/agent.ts', import.meta.url));

// PATH for the smoke and its server: `node` and `pgrep` (the orphan check), so no real adapter is found (or probed).
const bin = join(dir, 'bin');
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));
symlinkSync(execFileSync('/usr/bin/which', ['pgrep'], { encoding: 'utf8' }).trim(), join(bin, 'pgrep'));
// Same without pgrep: the orphan check can't run.
const binNoPgrep = join(dir, 'bin-no-pgrep');
mkdirSync(binNoPgrep);
symlinkSync(process.execPath, join(binNoPgrep, 'node'));
// Temp cwds the smoke creates (and keeps on failure) land here.
const tmp = join(dir, 'tmp');
mkdirSync(tmp);

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

function tagAlive(tag: string): boolean {
    try {
        execFileSync('pgrep', ['-f', tag]);
        return true;
    } catch {
        return false;
    }
}

/** Env like src/mcp.test.ts serverEnv(), with `claude` pointed at the fake agent in `scenario`; `agentEnv` goes to the agent. */
function smokeEnv(
    scenario: string,
    tag: string,
    path: string,
    agentEnv: Record<string, string>
): Record<string, string> {
    const config = join(dir, `${tag}.yaml`);
    writeFileSync(
        config,
        [
            'harnesses:',
            '  claude:',
            `    command: ${JSON.stringify(process.execPath)}`,
            `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
            `    env: ${JSON.stringify({ FAKE_SCENARIO: scenario, ...agentEnv })}`,
            '',
        ].join('\n')
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith('THRONG_MCP_')) env[key] = value;
    }
    return { ...env, THRONG_MCP_CONFIG: config, THRONG_MCP_CACHE_DIR: join(dir, 'cache'), PATH: path, TMPDIR: tmp };
}

function smoke(
    args: string[],
    scenario = 'echo',
    path = bin,
    agentEnv: Record<string, string> = {}
): Promise<{ code: number | null; stdout: string; stderr: string; tag: string }> {
    const tag = `fake-agent-${randomUUID()}`;
    tags.push(tag);
    return new Promise(resolve => {
        execFile(
            process.execPath,
            ['scripts/smoke/smoke.ts', ...args],
            { cwd: repo, env: smokeEnv(scenario, tag, path, agentEnv), timeout: 60_000 },
            (err, stdout, stderr) => {
                const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
                resolve({ code, stdout, stderr, tag });
            }
        );
    });
}

describe('smoke script against the fake agent', () => {
    it('passes when the agent writes pong.txt', async () => {
        const { code, stdout, stderr, tag } = await smoke(['claude/fake-small', '--prompt', 'x'], 'write-pong');
        expect(code, stdout + stderr).toBe(0);
        expect(stdout).toMatch(/PASS: pong\.txt written/);
        expect(stdout).toMatch(/^\d+\. send_message session_id=fake-/m);
        expect(stdout).toMatch(/PASS: send_message answered pong\.txt/);
        expect(stdout).toMatch(/adapter processes before: (none|[\d ]+)$/m);
        expect(stdout).toMatch(/PASS: no orphans/);
        expect(stdout).toMatch(/session_id: fake-[0-9a-f-]+/);
        expect(stderr).toMatch(/\[server\] .*throng started/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('--schema: run_thronglet with the schema, structured checked', async () => {
        const { code, stdout, stderr, tag } = await smoke(
            ['claude/fake-small', '--schema', '--no-follow-up'],
            'submit-valid',
            bin,
            { FAKE_SUBMIT: JSON.stringify({ file: 'pong.txt', content: 'pong' }) }
        );
        expect(code, stdout + stderr).toBe(0);
        expect(stdout).toMatch(/run_thronglet agent=claude\/fake-small .* schema$/m);
        expect(stdout).toMatch(/structured: \{"file":"pong\.txt","content":"pong"\}/);
        expect(stdout).toMatch(/PASS: structured is \{file: pong\.txt, content: pong\}/);
        expect(stdout).toMatch(/PASS: pong\.txt written/);
        expect(stdout).toMatch(/PASS: no orphans/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('--background: both turns accepted as pending, results collected with wait_thronglet', async () => {
        const { code, stdout, stderr, tag } = await smoke(
            ['claude/fake-small', '--prompt', 'x', '--background'],
            'write-pong'
        );
        expect(code, stdout + stderr).toBe(0);
        expect(stdout).toMatch(/run_thronglet agent=claude\/fake-small .* background$/m);
        expect(stdout).toMatch(/pending: \{"session_id":"fake-[0-9a-f-]+","state":"running","queued":0\}/);
        expect(stdout).toMatch(/PASS: run_thronglet background accepted/);
        expect(stdout).toMatch(/^\d+\. wait_thronglet session_id=fake-/m);
        expect(stdout).toMatch(/PASS: pong\.txt written/);
        expect(stdout).toMatch(/^\d+\. send_message session_id=fake-.* background$/m);
        expect(stdout).toMatch(/PASS: send_message background accepted/);
        expect(stdout).toMatch(/PASS: send_message answered pong\.txt/);
        expect(stdout).toMatch(/PASS: no orphans/);
        expect(stdout).not.toMatch(/FAIL/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('--no-follow-up skips the send_message step', async () => {
        const { code, stdout, stderr, tag } = await smoke(
            ['claude/fake-small', '--prompt', 'x', '--no-follow-up'],
            'write-pong'
        );
        expect(code, stdout + stderr).toBe(0);
        expect(stdout).toMatch(/PASS: pong\.txt written/);
        expect(stdout).toMatch(/follow-up step skipped \(--no-follow-up\)/);
        expect(stdout).not.toMatch(/\. send_message/);
        expect(stdout).toMatch(/PASS: no orphans/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('fails when the run succeeds but no file is written', async () => {
        const { code, stdout, stderr, tag } = await smoke(['claude/fake-small', '--prompt', 'x'], 'echo');
        expect(code, stdout + stderr).toBe(1);
        expect(stdout).toMatch(/isError: false/);
        expect(stdout).toMatch(/FAIL: pong\.txt/);
        expect(stdout).toMatch(/kept cwd for inspection: /);
        expect(stderr).toMatch(/\[progress\] \d+ read README\.md/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('fails the orphan check when pgrep cannot run', async () => {
        const { code, stdout, stderr, tag } = await smoke(
            ['claude/fake-small', '--prompt', 'x'],
            'write-pong',
            binNoPgrep
        );
        expect(code, stdout + stderr).toBe(1);
        expect(stdout).toMatch(/PASS: pong\.txt written/);
        expect(stdout).toMatch(/FAIL: cannot check orphans \(pgrep failed: .*ENOENT/);
        expect(stdout).not.toMatch(/PASS: no orphans/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('refuses a --cwd that already has pong.txt', async () => {
        const cwd = join(dir, 'stale');
        mkdirSync(cwd);
        writeFileSync(join(cwd, 'pong.txt'), 'pong');
        const { code, stdout, stderr } = await smoke(['claude/fake-small', '--cwd', cwd], 'echo');
        expect(code, stdout + stderr).toBe(2);
        expect(stderr).toMatch(/pong\.txt already exists; remove it or pick another --cwd/);
        expect(stdout).not.toMatch(/run_thronglet/);
    });

    it('exits 2 and lists the valid models for an unknown model', async () => {
        const { code, stdout, stderr, tag } = await smoke(['claude/nope']);
        expect(code, stdout + stderr).toBe(2);
        expect(stdout).toMatch(/model nope is not offered by claude/);
        expect(stdout).toMatch(/^ {3}fake-small$/m);
        expect(stdout).not.toMatch(/run_thronglet/);
        expect(tagAlive(tag), 'fake agent left running').toBe(false);
    });

    it('exits 2 with the install hint when the adapter is not on PATH', async () => {
        const { code, stdout, stderr } = await smoke(['codex/x']);
        expect(code, stdout + stderr).toBe(2);
        expect(stdout).toMatch(/codex-acp not found on PATH; install: npm i -g @agentclientprotocol\/codex-acp$/m);
        expect(stdout).toMatch(/harness codex is not available/);
    });

    it('prints usage and exits 2 without an agent spec', async () => {
        const { code, stderr } = await smoke([]);
        expect(code).toBe(2);
        expect(stderr).toMatch(/^usage: /m);
    });
});
