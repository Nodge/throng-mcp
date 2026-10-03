import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type FakeScenario =
    | 'echo'
    | 'permission'
    | 'notice'
    | 'hang'
    | 'handshake-hang'
    | 'crash-on-prompt'
    | 'fs-call'
    | 'terminal-call'
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
    | 'steer'
    | 'submit-valid'
    | 'submit-invalid-then-valid'
    | 'submit-missing'
    | 'submit-invalid-always'
    | 'submit-ask';

// Knobs besides FAKE_SCENARIO (env of the agent process): FAKE_TURN_MS — an echo turn takes that long before answering
// (default 0); FAKE_MEMORY_DIR — where resume-memory and steer keep their notes; FAKE_SUBMIT — the valid submit_result (JSON);
// FAKE_CONFIG_OPTIONS — extra `SessionConfigOption[]` (JSON) every session/new and session/resume advertises, select or
// boolean; FAKE_CALL_LOG — a file the process appends a `FakeCall` JSON line to for its start (argv), every set_mode,
// set_config_option (rejected ones included) and prompt, in order; read it with `readFakeCalls`; FAKE_STDERR — a line the
// process writes to stderr at startup.
// steer: every turn appends its prompt to the session's notes; the session's first turn then hangs until session/cancel,
// every later one replies `you said: <notes joined ' | '>`.

/** One line of FAKE_CALL_LOG. `resumed`: the session came from session/resume. */
export type FakeCall =
    | { event: 'start'; argv: string[] }
    | { event: 'set_mode'; modeId: string; resumed: boolean }
    | { event: 'set_config_option'; configId: string; value: string | boolean; resumed: boolean }
    | { event: 'prompt'; resumed: boolean };

/** The FAKE_CALL_LOG lines so far, across every process that wrote to it; [] when the file is absent. */
export function readFakeCalls(path: string): FakeCall[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as FakeCall);
}

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
