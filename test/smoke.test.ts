import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

// scripts/smoke/smoke.ts driven against the fake agent: the real smoke is the maintainer's (it spends tokens).

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-smoke-test-'));
const fakeAgent = fileURLToPath(new URL('./fake-agent/agent.ts', import.meta.url));

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
after(() => {
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

/** Env like test/mcp.test.ts serverEnv(), with `claude` pointed at the fake agent in `scenario`. */
function smokeEnv(scenario: string, tag: string, path: string): Record<string, string> {
  const config = join(dir, `${tag}.yaml`);
  writeFileSync(
    config,
    [
      'harnesses:',
      '  claude:',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
      `    env: { FAKE_SCENARIO: ${scenario} }`,
      '',
    ].join('\n'),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('THRONG_MCP_')) env[key] = value;
  }
  return { ...env, THRONG_MCP_CONFIG: config, THRONG_MCP_CACHE_DIR: join(dir, 'cache'), PATH: path, TMPDIR: tmp };
}

function smoke(args: string[], scenario = 'echo', path = bin): Promise<{ code: number | null; stdout: string; stderr: string; tag: string }> {
  const tag = `fake-agent-${randomUUID()}`;
  tags.push(tag);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/smoke/smoke.ts', ...args],
      { cwd: repo, env: smokeEnv(scenario, tag, path), timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout, stderr, tag });
      },
    );
  });
}

describe('smoke script against the fake agent', () => {
  it('passes when the agent writes pong.txt', async () => {
    const { code, stdout, stderr, tag } = await smoke(['claude/fake-small', '--prompt', 'x'], 'write-pong');
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /PASS: pong\.txt written/);
    assert.match(stdout, /^\d+\. resume_thronglet session_id=fake-/m);
    assert.match(stdout, /PASS: resume answered pong\.txt/);
    assert.match(stdout, /adapter processes before: (none|[\d ]+)$/m);
    assert.match(stdout, /PASS: no orphans/);
    assert.match(stdout, /session_id: fake-[0-9a-f-]+/);
    assert.match(stdout, /transcripts: .*cache\/runs/);
    assert.match(stderr, /\[server\] .*throng started/);
    assert.equal(tagAlive(tag), false, 'fake agent left running');
  });

  it('--no-resume skips the resume step', async () => {
    const { code, stdout, stderr, tag } = await smoke(['claude/fake-small', '--prompt', 'x', '--no-resume'], 'write-pong');
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /PASS: pong\.txt written/);
    assert.match(stdout, /resume step skipped \(--no-resume\)/);
    assert.doesNotMatch(stdout, /\. resume_thronglet/);
    assert.match(stdout, /PASS: no orphans/);
    assert.equal(tagAlive(tag), false, 'fake agent left running');
  });

  it('fails when the run succeeds but no file is written', async () => {
    const { code, stdout, stderr, tag } = await smoke(['claude/fake-small', '--prompt', 'x'], 'echo');
    assert.equal(code, 1, stdout + stderr);
    assert.match(stdout, /isError: false/);
    assert.match(stdout, /FAIL: pong\.txt/);
    assert.match(stdout, /kept cwd for inspection: /);
    assert.match(stderr, /\[progress\] \d+ read README\.md/);
    assert.equal(tagAlive(tag), false, 'fake agent left running');
  });

  it('fails the orphan check when pgrep cannot run', async () => {
    const { code, stdout, stderr, tag } = await smoke(['claude/fake-small', '--prompt', 'x'], 'write-pong', binNoPgrep);
    assert.equal(code, 1, stdout + stderr);
    assert.match(stdout, /PASS: pong\.txt written/);
    assert.match(stdout, /FAIL: cannot check orphans \(pgrep failed: .*ENOENT/);
    assert.doesNotMatch(stdout, /PASS: no orphans/);
    assert.equal(tagAlive(tag), false, 'fake agent left running');
  });

  it('refuses a --cwd that already has pong.txt', async () => {
    const cwd = join(dir, 'stale');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'pong.txt'), 'pong');
    const { code, stdout, stderr } = await smoke(['claude/fake-small', '--cwd', cwd], 'echo');
    assert.equal(code, 2, stdout + stderr);
    assert.match(stderr, /pong\.txt already exists; remove it or pick another --cwd/);
    assert.doesNotMatch(stdout, /run_thronglet/);
  });

  it('exits 2 and lists the valid models for an unknown model', async () => {
    const { code, stdout, stderr, tag } = await smoke(['claude/nope']);
    assert.equal(code, 2, stdout + stderr);
    assert.match(stdout, /model nope is not offered by claude/);
    assert.match(stdout, /^ {3}fake-small$/m);
    assert.doesNotMatch(stdout, /run_thronglet/);
    assert.equal(tagAlive(tag), false, 'fake agent left running');
  });

  it('exits 2 with the install hint when the adapter is not on PATH', async () => {
    const { code, stdout, stderr } = await smoke(['codex/x']);
    assert.equal(code, 2, stdout + stderr);
    assert.match(stdout, /codex-acp not found on PATH; install: npm i -g @agentclientprotocol\/codex-acp@1\.13\.1/);
    assert.match(stdout, /harness codex is not available/);
  });

  it('prints usage and exits 2 without an agent spec', async () => {
    const { code, stderr } = await smoke([]);
    assert.equal(code, 2);
    assert.match(stderr, /^usage: /m);
  });
});
