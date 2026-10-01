import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type Config, DEFAULT_CONFIG, type PermissionPolicy } from '../src/config.ts';
import { HARNESS_IDS } from '../src/contract.ts';
import { HARNESSES, findOnPath, harnessById, installHint, loadRegistry } from '../src/harnesses/index.ts';
import type { HarnessLaunch, HarnessResolution, RegistrySnapshot } from '../src/harnesses/types.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-harnesses-'));
after(() => rmSync(root, { recursive: true, force: true }));

const registry = loadRegistry();
const raw = JSON.parse(readFileSync(new URL('../data/registry.json', import.meta.url), 'utf8')) as RegistrySnapshot;
const npxPackage = (id: string) => raw.agents.find((a) => a.id === id)?.distribution?.npx?.package?.replace(/@[^@/]*$/, '');

let dirs = 0;
/** A fresh PATH dir holding executable stubs for `bins`. */
function pathDir(bins: string[]): string {
  const dir = join(root, `bin-${dirs++}`);
  mkdirSync(dir);
  for (const bin of bins) {
    writeFileSync(join(dir, bin), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, bin), 0o755);
  }
  return dir;
}

function withHarnesses(harnesses: Config['harnesses']): Config {
  return { ...DEFAULT_CONFIG, harnesses };
}

function launchOf(resolution: HarnessResolution): HarnessLaunch {
  assert.ok(resolution.available, resolution.available ? '' : resolution.reason);
  return resolution.launch;
}

function reasonOf(resolution: HarnessResolution): string {
  assert.equal(resolution.available, false);
  return resolution.available ? '' : resolution.reason;
}

const ALL_BINS = ['claude-agent-acp', 'claude', 'codex-acp', 'codex', 'opencode'];

describe('registry and PATH lookup', () => {
  it('loadRegistry reads data/registry.json once', () => {
    assert.equal(loadRegistry(), registry);
    assert.equal(registry.agents.length, raw.agents.length);
  });

  it('installHint: npx package, binary pointer, unknown id', () => {
    assert.equal(installHint(registry, 'claude-acp'), `npm i -g ${npxPackage('claude-acp')}`);
    assert.equal(installHint(registry, 'codex-acp'), `npm i -g ${npxPackage('codex-acp')}`);
    assert.match(installHint(registry, 'opencode'), /opencode\.ai/);
    assert.equal(installHint(registry, 'nope'), 'no install hint in the registry snapshot');
  });

  it('findOnPath skips non-executable files, directories and relative entries', () => {
    const plain = pathDir([]);
    writeFileSync(join(plain, 'tool'), '');
    mkdirSync(join(plain, 'dirtool'));
    const exec = pathDir(['tool', 'dirtool']);
    const env = { PATH: ['', 'relative', plain, exec].join(':') };
    assert.equal(findOnPath('tool', env), join(exec, 'tool'));
    assert.equal(findOnPath('dirtool', env), join(exec, 'dirtool'));
    assert.equal(findOnPath('missing', env), undefined);
    assert.equal(findOnPath('tool', {}), undefined);
  });

  it('HARNESSES covers every harness id', () => {
    assert.deepEqual(Object.keys(HARNESSES), [...HARNESS_IDS]);
    for (const id of HARNESS_IDS) assert.equal(harnessById(id).id, id);
    assert.deepEqual(
      HARNESS_IDS.map((id) => harnessById(id).registryId),
      ['claude-acp', 'codex-acp', 'opencode'],
    );
  });
});

describe('resolve', () => {
  it('all present: adapters from PATH, harness binaries in env', () => {
    const dir = pathDir(ALL_BINS);
    const env = { PATH: dir };
    assert.deepEqual(launchOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env)), {
      command: join(dir, 'claude-agent-acp'),
      args: [],
      env: { CLAUDE_CODE_EXECUTABLE: join(dir, 'claude') },
    });
    assert.deepEqual(launchOf(HARNESSES.codex.resolve(DEFAULT_CONFIG, registry, env)), {
      command: join(dir, 'codex-acp'),
      args: [],
      env: { CODEX_PATH: join(dir, 'codex') },
    });
    assert.deepEqual(launchOf(HARNESSES.opencode.resolve(DEFAULT_CONFIG, registry, env)), {
      command: join(dir, 'opencode'),
      args: ['acp'],
      env: {},
    });
  });

  it('adapter missing: unavailable with the install command from the registry', () => {
    const env = { PATH: pathDir(['claude', 'codex']) };
    const claude = reasonOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env));
    assert.ok(claude.includes('claude-agent-acp not found on PATH'), claude);
    assert.ok(claude.includes(`npm i -g ${npxPackage('claude-acp')}`), claude);
    assert.ok(claude.includes('npm i -g @agentclientprotocol/claude-agent-acp'), claude);

    const codex = reasonOf(HARNESSES.codex.resolve(DEFAULT_CONFIG, registry, env));
    assert.ok(codex.includes('codex-acp not found on PATH'), codex);
    assert.ok(codex.includes('npm i -g @agentclientprotocol/codex-acp'), codex);

    const opencode = reasonOf(HARNESSES.opencode.resolve(DEFAULT_CONFIG, registry, env));
    assert.ok(opencode.includes('opencode not found on PATH'), opencode);
    assert.ok(opencode.includes('opencode.ai'), opencode);
  });

  it('harness binary missing alone does not make the harness unavailable', () => {
    const env = { PATH: pathDir(['claude-agent-acp', 'codex-acp']) };
    assert.deepEqual(launchOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env)).env, {});
    assert.deepEqual(launchOf(HARNESSES.codex.resolve(DEFAULT_CONFIG, registry, env)).env, {});
  });

  it('harness binary env var already set in the server environment is left alone', () => {
    const env = { PATH: pathDir(['claude-agent-acp', 'claude']), CLAUDE_CODE_EXECUTABLE: '/elsewhere/claude' };
    assert.deepEqual(launchOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env)).env, {});
  });

  it('config override: command, args and env win; configured env is not overwritten from PATH', () => {
    const dir = pathDir(ALL_BINS);
    const custom = join(pathDir(['my-adapter']), 'my-adapter');
    const config = withHarnesses({
      claude: { command: custom, args: ['--flag'], env: { CLAUDE_CODE_EXECUTABLE: '/custom/claude', EXTRA: '1' } },
      codex: { env: { OTHER: 'x' } },
    });
    assert.deepEqual(launchOf(HARNESSES.claude.resolve(config, registry, { PATH: dir })), {
      command: custom,
      args: ['--flag'],
      env: { CLAUDE_CODE_EXECUTABLE: '/custom/claude', EXTRA: '1' },
    });
    // Config env merges over the PATH-derived harness env.
    assert.deepEqual(launchOf(HARNESSES.codex.resolve(config, registry, { PATH: dir })).env, {
      CODEX_PATH: join(dir, 'codex'),
      OTHER: 'x',
    });
  });

  it('config override: bare command is looked up on PATH; a missing one is named in the reason', () => {
    const dir = pathDir(['my-opencode']);
    const found = withHarnesses({ opencode: { command: 'my-opencode' } });
    assert.deepEqual(launchOf(HARNESSES.opencode.resolve(found, registry, { PATH: dir })), {
      command: join(dir, 'my-opencode'),
      args: ['acp'],
      env: {},
    });

    const bare = withHarnesses({ opencode: { command: 'nope-opencode' } });
    const bareReason = reasonOf(HARNESSES.opencode.resolve(bare, registry, { PATH: dir }));
    assert.ok(bareReason.startsWith('nope-opencode (harnesses.opencode.command) not found on PATH; install: '), bareReason);

    const path = withHarnesses({ claude: { command: join(root, 'no-such-adapter') } });
    const pathReason = reasonOf(HARNESSES.claude.resolve(path, registry, { PATH: pathDir(ALL_BINS) }));
    assert.ok(pathReason.startsWith(`${join(root, 'no-such-adapter')} (harnesses.claude.command) not found or not executable`), pathReason);
    assert.ok(pathReason.includes('npm i -g @agentclientprotocol/claude-agent-acp'), pathReason);
  });
});

describe('mapEffort', () => {
  it('claude: exact value or nothing', () => {
    const options = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.equal(HARNESSES.claude.mapEffort('high', options), 'high');
    assert.equal(HARNESSES.claude.mapEffort('max', options), 'max');
    assert.equal(HARNESSES.claude.mapEffort('max', ['low', 'high']), undefined);
  });

  it('codex: exact, else max → xhigh', () => {
    assert.equal(HARNESSES.codex.mapEffort('max', ['low', 'medium', 'high', 'xhigh']), 'xhigh');
    assert.equal(HARNESSES.codex.mapEffort('max', ['low', 'xhigh', 'max']), 'max');
    assert.equal(HARNESSES.codex.mapEffort('medium', ['low', 'medium']), 'medium');
    assert.equal(HARNESSES.codex.mapEffort('max', ['low', 'high']), undefined);
    assert.equal(HARNESSES.codex.mapEffort('xhigh', ['low', 'high']), undefined);
  });

  it('opencode: exact value or nothing', () => {
    assert.equal(HARNESSES.opencode.mapEffort('high', []), undefined);
    assert.equal(HARNESSES.opencode.mapEffort('high', ['low', 'high']), 'high');
  });
});

describe('permissionSetup', () => {
  const policies: PermissionPolicy[] = ['auto', 'allow_all', 'deny_all', 'elicit'];
  const ask = { env: { OPENCODE_CONFIG_CONTENT: '{"permission":"ask"}' } };
  const expected = {
    claude: { auto: { modeId: 'auto' }, other: { modeId: 'default' } },
    codex: { auto: { modeId: 'agent' }, other: { modeId: 'read-only' } },
    opencode: { auto: {}, other: ask },
  } as const;

  for (const id of HARNESS_IDS) {
    for (const policy of policies) {
      it(`${id} × ${policy}`, () => {
        const want = policy === 'auto' ? expected[id].auto : expected[id].other;
        assert.deepEqual(HARNESSES[id].permissionSetup(policy), want);
      });
    }
  }
});
