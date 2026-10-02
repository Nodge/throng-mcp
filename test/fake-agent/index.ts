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
    | 'grandchild-detached'
    | 'no-resume'
    | 'orphan-exit'
    | 'orphan-crash'
    | 'early-update'
    | 'no-effort-option'
    | 'mode-fallback'
    | 'empty'
    | 'refuse'
    | 'max-turns'
    | 'write-pong'
    | 'resume-memory'
    | 'submit-valid'
    | 'submit-invalid-then-valid'
    | 'submit-missing'
    | 'submit-invalid-always'
    | 'submit-ask';

// Knobs besides FAKE_SCENARIO (env of the agent process): FAKE_TURN_MS — an echo turn takes that long before answering
// (default 0); FAKE_MEMORY_DIR — where resume-memory keeps its notes; FAKE_SUBMIT — the valid submit_result (JSON).

const agentPath = fileURLToPath(new URL('./agent.ts', import.meta.url));

/**
 * Spawn spec for the fake agent (`cwd`/`depth` are the test's). `tag` is a unique argv marker,
 * so a test can find the process with `pgrep -f <tag>` even when the worker never came up.
 */
export function fakeAgentSpawn(scenario: FakeScenario): {
    command: string;
    args: string[];
    env: Record<string, string>;
    tag: string;
} {
    const tag = `fake-agent-${randomUUID()}`;
    return { command: process.execPath, args: [agentPath, `--tag=${tag}`], env: { FAKE_SCENARIO: scenario }, tag };
}
