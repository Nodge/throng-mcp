import type { HarnessId } from '../contract.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { opencode } from './opencode.ts';
import type { HarnessDefinition } from './types.ts';

export { findOnPath, installHint, loadRegistry } from './discovery.ts';

export const HARNESSES: Record<HarnessId, HarnessDefinition> = { claude, codex, opencode };

export function harnessById(id: HarnessId): HarnessDefinition {
  return HARNESSES[id];
}
