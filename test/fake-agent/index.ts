import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type FakeScenario =
  | 'echo'
  | 'permission'
  | 'notice'
  | 'hang'
  | 'handshake-hang'
  | 'crash-on-prompt'
  | 'fs-call'
  | 'grandchild'
  | 'no-resume'
  | 'orphan-exit'
  | 'orphan-crash'
  | 'early-update'
  | 'no-effort-option'
  | 'empty'
  | 'refuse'
  | 'max-turns';

const agentPath = fileURLToPath(new URL('./agent.ts', import.meta.url));

/**
 * Spawn spec for the fake agent (`cwd`/`depth` are the test's). `tag` is a unique argv marker,
 * so a test can find the process with `pgrep -f <tag>` even when the worker never came up.
 */
export function fakeAgentSpawn(scenario: FakeScenario): { command: string; args: string[]; env: Record<string, string>; tag: string } {
  const tag = `fake-agent-${randomUUID()}`;
  return { command: process.execPath, args: [agentPath, `--tag=${tag}`], env: { FAKE_SCENARIO: scenario }, tag };
}
