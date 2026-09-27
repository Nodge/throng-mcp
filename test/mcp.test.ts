import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ListHarnessesOutput } from '../src/contract.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-mcp-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Parent env without THRONG_MCP_* (the tests may themselves run inside a throng session), plus overrides. */
function serverEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('THRONG_MCP_')) env[key] = value;
  }
  return { THRONG_MCP_CONFIG: join(dir, 'missing.yaml'), ...env, ...overrides };
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
  it('exposes a list_harnesses stub with default limits', async () => {
    const { tools, out } = await callListHarnesses(serverEnv({}));
    assert.deepEqual(tools, ['list_harnesses']);
    assert.deepEqual(out, {
      harnesses: [],
      unavailable: ['claude', 'codex', 'opencode'].map((harness) => ({ harness, reason: 'not implemented yet (THRONG-3)' })),
      limits: { max_concurrency: 10, max_depth: 2, default_timeout_s: 21600, current_depth: 0 },
    });
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
