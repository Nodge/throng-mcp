import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Config, DEFAULT_CONFIG, type PermissionPolicy } from '../config.ts';
import { HARNESS_IDS } from '../contract.ts';
import { HARNESSES, findOnPath, harnessById, installHint, loadRegistry } from './index.ts';
import type { HarnessLaunch, HarnessResolution, RegistrySnapshot } from './types.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-harnesses-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const registry = loadRegistry();
const raw = JSON.parse(readFileSync(new URL('../../data/registry.json', import.meta.url), 'utf8')) as RegistrySnapshot;
const npxPackage = (id: string) => raw.agents.find((a) => a.id === id)?.distribution?.npx?.package.replace(/@[^@/]*$/, '');

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
  if (!resolution.available) expect.unreachable(resolution.reason);
  return resolution.launch;
}

function reasonOf(resolution: HarnessResolution): string {
  expect(resolution.available).toBe(false);
  return resolution.available ? '' : resolution.reason;
}

const ALL_BINS = ['claude-agent-acp', 'claude', 'codex-acp', 'codex', 'opencode'];

describe('registry and PATH lookup', () => {
  it('loadRegistry reads data/registry.json once', () => {
    expect(loadRegistry()).toBe(registry);
    expect(registry.agents.length).toBe(raw.agents.length);
  });

  it('installHint: npx package, binary pointer, unknown id', () => {
    expect(installHint(registry, 'claude-acp')).toBe(`npm i -g ${npxPackage('claude-acp')}`);
    expect(installHint(registry, 'codex-acp')).toBe(`npm i -g ${npxPackage('codex-acp')}`);
    expect(installHint(registry, 'opencode')).toMatch(/opencode\.ai/);
    expect(installHint(registry, 'nope')).toBe('no install hint in the registry snapshot');
  });

  it('findOnPath skips non-executable files, directories and relative entries', () => {
    const plain = pathDir([]);
    writeFileSync(join(plain, 'tool'), '');
    mkdirSync(join(plain, 'dirtool'));
    const exec = pathDir(['tool', 'dirtool']);
    const env = { PATH: ['', 'relative', plain, exec].join(':') };
    expect(findOnPath('tool', env)).toBe(join(exec, 'tool'));
    expect(findOnPath('dirtool', env)).toBe(join(exec, 'dirtool'));
    expect(findOnPath('missing', env)).toBe(undefined);
    expect(findOnPath('tool', {})).toBe(undefined);
  });

  it('HARNESSES covers every harness id', () => {
    expect(Object.keys(HARNESSES)).toStrictEqual([...HARNESS_IDS]);
    for (const id of HARNESS_IDS) expect(harnessById(id).id).toBe(id);
    expect(HARNESS_IDS.map((id) => harnessById(id).registryId)).toStrictEqual(['claude-acp', 'codex-acp', 'opencode']);
  });
});

describe('resolve', () => {
  it('all present: adapters from PATH, harness binaries in env', () => {
    const dir = pathDir(ALL_BINS);
    const env = { PATH: dir };
    expect(launchOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env))).toStrictEqual({
      command: join(dir, 'claude-agent-acp'),
      args: [],
      env: { CLAUDE_CODE_EXECUTABLE: join(dir, 'claude') },
    });
    expect(launchOf(HARNESSES.codex.resolve(DEFAULT_CONFIG, registry, env))).toStrictEqual({
      command: join(dir, 'codex-acp'),
      args: [],
      env: { CODEX_PATH: join(dir, 'codex') },
    });
    expect(launchOf(HARNESSES.opencode.resolve(DEFAULT_CONFIG, registry, env))).toStrictEqual({
      command: join(dir, 'opencode'),
      args: ['acp'],
      env: {},
    });
  });

  it('adapter missing: unavailable with the install command from the registry', () => {
    const env = { PATH: pathDir(['claude', 'codex']) };
    const claude = reasonOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env));
    expect(claude).toContain('claude-agent-acp not found on PATH');
    expect(claude).toContain(`npm i -g ${npxPackage('claude-acp')}`);
    expect(claude).toContain('npm i -g @agentclientprotocol/claude-agent-acp');

    const codex = reasonOf(HARNESSES.codex.resolve(DEFAULT_CONFIG, registry, env));
    expect(codex).toContain('codex-acp not found on PATH');
    expect(codex).toContain('npm i -g @agentclientprotocol/codex-acp');

    const opencode = reasonOf(HARNESSES.opencode.resolve(DEFAULT_CONFIG, registry, env));
    expect(opencode).toContain('opencode not found on PATH');
    expect(opencode).toContain('opencode.ai');
  });

  it('harness binary missing alone does not make the harness unavailable', () => {
    const env = { PATH: pathDir(['claude-agent-acp', 'codex-acp']) };
    expect(launchOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env)).env).toStrictEqual({});
    expect(launchOf(HARNESSES.codex.resolve(DEFAULT_CONFIG, registry, env)).env).toStrictEqual({});
  });

  it('harness binary env var already set in the server environment is left alone', () => {
    const env = { PATH: pathDir(['claude-agent-acp', 'claude']), CLAUDE_CODE_EXECUTABLE: '/elsewhere/claude' };
    expect(launchOf(HARNESSES.claude.resolve(DEFAULT_CONFIG, registry, env)).env).toStrictEqual({});
  });

  it('config override: command, args and env win; configured env is not overwritten from PATH', () => {
    const dir = pathDir(ALL_BINS);
    const custom = join(pathDir(['my-adapter']), 'my-adapter');
    const config = withHarnesses({
      claude: { command: custom, args: ['--flag'], env: { CLAUDE_CODE_EXECUTABLE: '/custom/claude', EXTRA: '1' } },
      codex: { env: { OTHER: 'x' } },
    });
    expect(launchOf(HARNESSES.claude.resolve(config, registry, { PATH: dir }))).toStrictEqual({
      command: custom,
      args: ['--flag'],
      env: { CLAUDE_CODE_EXECUTABLE: '/custom/claude', EXTRA: '1' },
    });
    // Config env merges over the PATH-derived harness env.
    expect(launchOf(HARNESSES.codex.resolve(config, registry, { PATH: dir })).env).toStrictEqual({
      CODEX_PATH: join(dir, 'codex'),
      OTHER: 'x',
    });
  });

  it('config override: bare command is looked up on PATH; a missing one is named in the reason', () => {
    const dir = pathDir(['my-opencode']);
    const found = withHarnesses({ opencode: { command: 'my-opencode' } });
    expect(launchOf(HARNESSES.opencode.resolve(found, registry, { PATH: dir }))).toStrictEqual({
      command: join(dir, 'my-opencode'),
      args: ['acp'],
      env: {},
    });

    const bare = withHarnesses({ opencode: { command: 'nope-opencode' } });
    const bareReason = reasonOf(HARNESSES.opencode.resolve(bare, registry, { PATH: dir }));
    expect(bareReason.startsWith('nope-opencode (harnesses.opencode.command) not found on PATH; install: '), bareReason).toBe(true);

    const path = withHarnesses({ claude: { command: join(root, 'no-such-adapter') } });
    const pathReason = reasonOf(HARNESSES.claude.resolve(path, registry, { PATH: pathDir(ALL_BINS) }));
    expect(pathReason.startsWith(`${join(root, 'no-such-adapter')} (harnesses.claude.command) not found or not executable`), pathReason).toBe(true);
    expect(pathReason).toContain('npm i -g @agentclientprotocol/claude-agent-acp');
  });
});

describe('mapEffort', () => {
  it('claude: exact value or nothing', () => {
    const options = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
    expect(HARNESSES.claude.mapEffort('high', options)).toBe('high');
    expect(HARNESSES.claude.mapEffort('max', options)).toBe('max');
    expect(HARNESSES.claude.mapEffort('max', ['low', 'high'])).toBe(undefined);
  });

  it('codex: exact, else max → xhigh', () => {
    expect(HARNESSES.codex.mapEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    expect(HARNESSES.codex.mapEffort('max', ['low', 'xhigh', 'max'])).toBe('max');
    expect(HARNESSES.codex.mapEffort('medium', ['low', 'medium'])).toBe('medium');
    expect(HARNESSES.codex.mapEffort('max', ['low', 'high'])).toBe(undefined);
    expect(HARNESSES.codex.mapEffort('xhigh', ['low', 'high'])).toBe(undefined);
  });

  it('opencode: exact value or nothing', () => {
    expect(HARNESSES.opencode.mapEffort('high', [])).toBe(undefined);
    expect(HARNESSES.opencode.mapEffort('high', ['low', 'high'])).toBe('high');
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
        expect(HARNESSES[id].permissionSetup(policy)).toStrictEqual(want);
      });
    }
  }
});
