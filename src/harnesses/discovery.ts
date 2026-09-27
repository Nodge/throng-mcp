import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import type { HarnessId } from '../contract.ts';
import type { HarnessResolution, RegistrySnapshot } from './types.ts';

// Adapter discovery shared by the harness definitions (DESIGN §4.1, decision-3).
// Kept apart from index.ts so the definitions can import it without an import cycle.

let registry: RegistrySnapshot | undefined;

/** data/registry.json, read once. */
export function loadRegistry(): RegistrySnapshot {
  registry ??= JSON.parse(readFileSync(new URL('../../data/registry.json', import.meta.url), 'utf8')) as RegistrySnapshot;
  return registry;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable regular file named `name` in `env.PATH`; empty and relative entries are skipped. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** Hints for registry agents that ship as a binary rather than an npm package. */
const BINARY_INSTALL_HINTS: Record<string, string> = {
  opencode: 'see https://opencode.ai/docs (binary install)',
};

export function installHint(snapshot: RegistrySnapshot, registryId: string): string {
  const agent = snapshot.agents.find((a) => a.id === registryId);
  const pkg = agent?.distribution?.npx?.package;
  if (pkg) return `npm i -g ${pkg}`;
  return (agent && BINARY_INSTALL_HINTS[registryId]) ?? 'no install hint in the registry snapshot';
}

/** The per-harness data `resolveAdapter` needs; everything else about a harness lives in its definition. */
export interface AdapterSpec {
  id: HarnessId;
  registryId: string;
  /** Adapter command looked up on PATH. */
  adapter: string;
  args: string[];
  /** Harness binary whose absolute path goes into `envVar` when found on PATH. */
  harnessBin?: { name: string; envVar: string };
}

/**
 * Config `harnesses.<id>.command` wins over the PATH lookup; `args` and `env` from config override the defaults.
 * Availability depends on the adapter command only; a missing harness binary just leaves its env var unset.
 */
export function resolveAdapter(
  spec: AdapterSpec,
  config: Config,
  snapshot: RegistrySnapshot,
  env: NodeJS.ProcessEnv = process.env,
): HarnessResolution {
  const override = config.harnesses[spec.id];
  const hint = installHint(snapshot, spec.registryId);

  let command: string | undefined;
  if (override?.command) {
    const configured = override.command;
    const isPath = configured.includes('/');
    command = isPath ? (isExecutableFile(configured) ? resolve(configured) : undefined) : findOnPath(configured, env);
    if (!command) {
      const where = isPath ? 'not found or not executable' : 'not found on PATH';
      return { available: false, reason: `${configured} (harnesses.${spec.id}.command) ${where}; install: ${hint}` };
    }
  } else {
    command = findOnPath(spec.adapter, env);
    if (!command) return { available: false, reason: `${spec.adapter} not found on PATH; install: ${hint}` };
  }

  const configEnv = override?.env ?? {};
  const harnessEnv: Record<string, string> = {};
  // Config or the server's own environment may already point the adapter at a harness binary.
  if (spec.harnessBin && !(spec.harnessBin.envVar in configEnv) && !env[spec.harnessBin.envVar]) {
    const bin = findOnPath(spec.harnessBin.name, env);
    if (bin) harnessEnv[spec.harnessBin.envVar] = bin;
  }

  return { available: true, launch: { command, args: [...(override?.args ?? spec.args)], env: { ...harnessEnv, ...configEnv } } };
}
