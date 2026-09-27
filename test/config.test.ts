import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_CONFIG, loadConfig, readDepth } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'throng-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function withFile(name: string, content: string): NodeJS.ProcessEnv {
  const path = join(dir, name);
  writeFileSync(path, content);
  return { THRONG_MCP_CONFIG: path };
}

describe('loadConfig', () => {
  it('has the DESIGN §8 defaults', () => {
    assert.deepEqual(DEFAULT_CONFIG, {
      permissions: 'auto',
      harnesses: {},
      limits: { timeout_s: 21600, handshake_s: 60, elicitation_s: 600, max_concurrency: 10, max_depth: 2 },
    });
  });

  it('returns defaults without an error when the file is missing', () => {
    const path = join(dir, 'missing.yaml');
    const loaded = loadConfig({ THRONG_MCP_CONFIG: path });
    assert.deepEqual(loaded, { config: DEFAULT_CONFIG, path });
  });

  it('defaults the path to ~/.config/throng/config.yaml', () => {
    assert.match(loadConfig({}).path, /\/\.config\/throng\/config\.yaml$/);
  });

  it('treats an empty file as defaults', () => {
    const loaded = loadConfig(withFile('empty.yaml', ''));
    assert.equal(loaded.error, undefined);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  });

  it('treats sections without a value as absent', () => {
    const loaded = loadConfig(withFile('empty-sections.yaml', 'permissions:\nharnesses:\nlimits:\n  # timeout_s: 10\n'));
    assert.equal(loaded.error, undefined);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  });

  it('merges file values over the defaults', () => {
    const env = withFile(
      'partial.yaml',
      [
        'permissions: deny_all',
        'harnesses:',
        '  opencode: { command: /opt/opencode, args: [acp], env: { X: "1" } }',
        '  codex: { permissions: allow_all }',
        'limits: { max_depth: 3, timeout_s: 100 }',
      ].join('\n'),
    );
    const loaded = loadConfig(env);
    assert.equal(loaded.error, undefined);
    assert.deepEqual(loaded.config, {
      permissions: 'deny_all',
      harnesses: {
        opencode: { command: '/opt/opencode', args: ['acp'], env: { X: '1' } },
        codex: { permissions: 'allow_all' },
      },
      limits: { ...DEFAULT_CONFIG.limits, max_depth: 3, timeout_s: 100 },
    });
  });

  it('reports invalid YAML as one line with the path, keeping defaults', () => {
    const env = withFile('broken.yaml', 'limits: { max_depth: 3\npermissions: [\n');
    const loaded = loadConfig(env);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    const error = loaded.error ?? '';
    assert.ok(error.startsWith(`${env.THRONG_MCP_CONFIG}: invalid YAML: `), error);
    assert.ok(!error.includes('\n'));
  });

  it('reports schema violations with the field path, keeping defaults', () => {
    const env = withFile('bad.yaml', 'permissions: yolo\nharnesses: { gemini: {} }\nlimits: { max_depth: -1 }\n');
    const loaded = loadConfig(env);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    const error = loaded.error ?? '';
    assert.ok(error.startsWith(`${env.THRONG_MCP_CONFIG}: invalid config: `), error);
    for (const field of ['permissions', 'harnesses', 'limits.max_depth']) assert.ok(error.includes(field), error);
    assert.ok(!error.includes('\n'));
  });

  it('rejects unknown keys', () => {
    const loaded = loadConfig(withFile('typo.yaml', 'limit: { max_depth: 3 }\n'));
    assert.match(loaded.error ?? '', /invalid config: .*limit/);
  });

  it('reports an unreadable path, keeping defaults', () => {
    const loaded = loadConfig({ THRONG_MCP_CONFIG: dir });
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.ok(loaded.error?.startsWith(`${dir}: cannot read: `), loaded.error);
  });
});

describe('readDepth', () => {
  it('reads a non-negative integer', () => {
    assert.equal(readDepth({}), 0);
    assert.equal(readDepth({ THRONG_MCP_DEPTH: '0' }), 0);
    assert.equal(readDepth({ THRONG_MCP_DEPTH: '1' }), 1);
    assert.equal(readDepth({ THRONG_MCP_DEPTH: ' 3 ' }), 3);
  });

  it('treats garbage as 0', () => {
    for (const value of ['', '-1', '1.5', 'abc', '2x', '1e3']) assert.equal(readDepth({ THRONG_MCP_DEPTH: value }), 0, value);
  });

  it('treats values beyond a safe integer as 0', () => {
    assert.equal(readDepth({ THRONG_MCP_DEPTH: '9007199254740993' }), 0);
    assert.equal(readDepth({ THRONG_MCP_DEPTH: '9'.repeat(400) }), 0);
  });
});
