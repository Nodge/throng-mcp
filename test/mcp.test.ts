import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ListHarnessesOutput, RunFailure, RunSuccess } from '../src/contract.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-mcp-'));
const fakeAgent = fileURLToPath(new URL('./fake-agent/agent.ts', import.meta.url));

// PATH for the server: only `node`, so list_harnesses never finds (and probes) a real adapter.
const bin = join(dir, 'bin');
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));

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

/** Parent env with THRONG_MCP_* stripped (the tests may run inside a throng session), cache and config redirected to the temp dir, PATH = `bin`, plus overrides. */
function serverEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('THRONG_MCP_')) env[key] = value;
  }
  return { ...env, THRONG_MCP_CONFIG: join(dir, 'missing.yaml'), THRONG_MCP_CACHE_DIR: join(dir, 'cache'), PATH: bin, ...overrides };
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
  assert.deepEqual(unavailable.map((u) => u.harness), harnesses);
  const hints: Record<string, string> = {
    claude: 'claude-agent-acp not found on PATH; install: npm i -g @agentclientprotocol/claude-agent-acp@0.81.2',
    codex: 'codex-acp not found on PATH; install: npm i -g @agentclientprotocol/codex-acp@1.13.1',
    opencode: 'opencode not found on PATH; install: see https://opencode.ai/docs (binary install)',
  };
  for (const { harness, reason } of unavailable) assert.equal(reason, hints[harness]);
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(what);
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.ts'], cwd: repo, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'throng-test', version: '0' });
  await client.connect(transport);
  const pid = transport.pid;
  assert.ok(pid, 'server pid');
  try {
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'list_harnesses', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent, undefined);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, 'text');
    return { tools: tools.map((t) => t.name), out: JSON.parse(content[0]?.text ?? '') as ListHarnessesOutput };
  } finally {
    const started = Date.now();
    await client.close();
    // The client escalates to SIGTERM after 2 s; exiting well before that means the server handled stdin EOF itself.
    assert.ok(Date.now() - started < 1500, `server took ${Date.now() - started} ms to exit`);
    assert.equal(isAlive(pid), false, 'server process still alive');
    assert.match(stderr, /throng stopping why=stdin closed/);
  }
}

describe('mcp server over stdio', () => {
  it('without adapters on PATH: every harness unavailable with its install hint, default limits', async () => {
    const { tools, out } = await callListHarnesses(serverEnv({}));
    assert.deepEqual(tools, ['list_harnesses', 'run_thronglet', 'resume_thronglet']);
    assert.deepEqual(out.harnesses, []);
    assertInstallHints(out.unavailable, ['claude', 'codex', 'opencode']);
    assert.deepEqual(out.limits, { max_concurrency: 10, max_depth: 2, default_timeout_s: 21600, current_depth: 0 });
  });

  it('probes a configured adapter: models, efforts, version', async () => {
    const tag = newTag();
    const config = writeConfig(
      'fake-claude.yaml',
      `harnesses: { claude: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"] } }\n`,
    );
    const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config }));
    assert.deepEqual(out.harnesses, [
      {
        harness: 'claude',
        command: [process.execPath, fakeAgent, `--tag=${tag}`],
        models: ['fake-small', 'fake-large'],
        efforts: ['low', 'high'],
        version: '0.0.1',
      },
    ]);
    assertInstallHints(out.unavailable, ['codex', 'opencode']);
    assert.equal(tagAlive(tag), false, 'probed fake agent still running');
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
      ].join('\n'),
    );
    const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config }));
    assert.deepEqual(out.harnesses, []);
    assert.deepEqual(out.unavailable.map((u) => u.harness), ['claude', 'codex', 'opencode']);
    const claude = out.unavailable[0]?.reason ?? '';
    assert.match(claude, /did not answer initialize within 1000 ms/);
    assertInstallHints(out.unavailable.slice(1), ['codex', 'opencode']);
    assert.equal(tagAlive(tag), false, 'timed-out fake agent still running');
  });

  it('reflects the config file and THRONG_MCP_DEPTH', async () => {
    const config = writeConfig('limits.yaml', 'limits: { max_depth: 3, timeout_s: 100 }\n');
    const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config, THRONG_MCP_DEPTH: '1' }));
    assert.deepEqual(out.limits, { max_concurrency: 10, max_depth: 3, default_timeout_s: 100, current_depth: 1 });
  });

  it('reports a broken config in every unavailable reason', async () => {
    const config = writeConfig('broken.yaml', 'limits: [\n');
    const { out } = await callListHarnesses(serverEnv({ THRONG_MCP_CONFIG: config }));
    assert.equal(out.unavailable.length, 3);
    for (const { reason } of out.unavailable) {
      assert.ok(reason.startsWith('config error: '), reason);
      assert.ok(reason.includes(config), reason);
    }
    assert.equal(out.limits.max_depth, 2);
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
      ].join('\n'),
    );
    const tmp = join(dir, 'tmp-sigterm');
    mkdirSync(tmp);
    const env = serverEnv({ THRONG_MCP_CONFIG: config, TMPDIR: tmp });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.ts'], cwd: repo, env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'throng-test', version: '0' });
    await client.connect(transport);
    const pid = transport.pid;
    assert.ok(pid, 'server pid');
    try {
      client.callTool({ name: 'list_harnesses', arguments: {} }).catch(() => {});
      await waitFor(() => tagAlive(tag), 5000, 'probed adapter never started');
      assert.equal(readdirSync(tmp).length, 1, 'probe scratch dir');
      process.kill(pid, 'SIGTERM');
      await waitFor(() => !isAlive(pid), 8000, 'server did not exit after SIGTERM');
      assert.match(stderr, /throng stopping why=SIGTERM/);
      assert.equal(tagAlive(tag), false, 'probed adapter outlived the server');
      assert.deepEqual(readdirSync(tmp), [], 'probe scratch dir left behind');
    } finally {
      await client.close();
    }
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`exits with 0 on ${signal}`, async () => {
      const child = spawn(process.execPath, ['src/mcp.ts'], { cwd: repo, env: serverEnv({}), stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      await new Promise<void>((resolve, reject) => {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.includes('throng started')) resolve();
        });
        child.once('exit', () => reject(new Error(`server exited early: ${stderr}`)));
      });
      child.kill(signal);
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.match(stderr, new RegExp(`throng stopping why=${signal}`));
    });
  }
});

describe('run_thronglet over stdio', () => {
  /** Server whose `claude` harness is the fake agent in `scenario` (plus `agentEnv`); `tag` finds its adapter processes. */
  async function connect(
    scenario: string,
    agentEnv: Record<string, string> = {},
  ): Promise<{ client: Client; tag: string; close: () => Promise<void> }> {
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
      ].join('\n'),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['src/mcp.ts'],
      cwd: repo,
      env: serverEnv({ THRONG_MCP_CONFIG: config }),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'throng-test', version: '0' });
    await client.connect(transport);
    return { client, tag, close: () => client.close() };
  }

  function payloadOf(result: Record<string, unknown>): unknown {
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, 'text');
    return JSON.parse(content[0]?.text ?? '');
  }

  it('success: one JSON text block, isError undefined; model_rejected is a tool error', async () => {
    const { client, tag, close } = await connect('echo');
    try {
      const result = await client.callTool({ name: 'run_thronglet', arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo } });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent, undefined);
      const success = payloadOf(result) as RunSuccess;
      assert.ok(success.text?.startsWith('echo: '));
      assert.equal(success.stop_reason, 'end_turn');
      assert.ok(success.session_id);

      const rejected = await client.callTool({ name: 'run_thronglet', arguments: { agent: 'claude/nope', prompt: 'hi', cwd: repo } });
      assert.equal(rejected.isError, true);
      const failure = payloadOf(rejected) as RunFailure;
      assert.equal(failure.code, 'model_rejected');
      assert.ok(failure.session_id);
      assert.equal(tagAlive(tag), false);
    } finally {
      await close();
    }
  });

  it('invalid arguments are rejected by the SDK', async () => {
    const { client, close } = await connect('echo');
    try {
      const missing = await client.callTool({ name: 'run_thronglet', arguments: { agent: 'claude/fake-small', prompt: 'hi' } });
      assert.equal(missing.isError, true);
      const relative = await client.callTool({ name: 'run_thronglet', arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: 'src' } });
      assert.equal(relative.isError, true);
    } finally {
      await close();
    }
  });

  it('client cancel closes the adapter', async () => {
    const { client, tag, close } = await connect('hang');
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      await assert.rejects(
        client.callTool({ name: 'run_thronglet', arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo } }, undefined, {
          signal: controller.signal,
        }),
      );
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
        { name: 'run_thronglet', arguments: { agent: 'claude/fake-small', prompt: 'hi', cwd: repo } },
        CallToolResultSchema,
        { onprogress: (p) => void messages.push(p.message ?? '') },
      );
      assert.equal(result.isError, undefined);
      assert.ok(messages.includes('read README.md'), JSON.stringify(messages));
    } finally {
      await close();
    }
  });

  it('resume_thronglet: follow-up into the same session; an unknown id is a session_not_found tool error', async () => {
    const { client, tag, close } = await connect('resume-memory', { FAKE_MEMORY_DIR: mkdtempSync(join(dir, 'memory-')) });
    try {
      const run = await client.callTool({ name: 'run_thronglet', arguments: { agent: 'claude/fake-small', prompt: 'remember: banana', cwd: repo } });
      assert.equal(run.isError, undefined);
      const first = payloadOf(run) as RunSuccess;

      const resumed = await client.callTool({ name: 'resume_thronglet', arguments: { session_id: first.session_id, prompt: 'what did I say?' } });
      assert.equal(resumed.isError, undefined);
      assert.equal(resumed.structuredContent, undefined);
      const second = payloadOf(resumed) as RunSuccess;
      assert.equal(second.session_id, first.session_id);
      assert.ok(second.text?.startsWith('you said: remember: banana'), second.text);

      const unknown = await client.callTool({ name: 'resume_thronglet', arguments: { session_id: 'fake-nope', prompt: 'x' } });
      assert.equal(unknown.isError, true);
      const failure = payloadOf(unknown) as RunFailure;
      assert.equal(failure.code, 'session_not_found');
      assert.match(failure.message, /no session record for "fake-nope"/);
      assert.equal(tagAlive(tag), false);
    } finally {
      await close();
    }
  });
});
