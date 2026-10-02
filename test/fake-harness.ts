import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { loadConfig, type LoadedConfig } from '../src/config.ts';
import { noProgress } from '../src/progress.ts';
import { SessionRegistry } from '../src/registry.ts';
import type { RunContext } from '../src/run.ts';
import { Semaphore } from '../src/semaphore.ts';
import { type SessionRecord, writeSessionRecord } from '../src/sessions.ts';
import type { FakeScenario } from './fake-agent/index.ts';

// A sandbox for runCall tests on the fake agent: temp root, PATH with only `node`, configs whose `claude` is the fake.

const fakeAgent = fileURLToPath(new URL('./fake-agent/agent.ts', import.meta.url));
/** RunContext.submitTool for tests: the source file, as `node src/mcp.ts` resolves it. */
export const submitTool = fileURLToPath(new URL('../src/structured/submit-tool.ts', import.meta.url));

export interface FakeHarness {
    root: string;
    /** An existing directory to run in. */
    work: string;
    /** Config whose `claude` harness is the fake agent in `scenario`; `agentEnv` is added to the adapter's env. */
    fakeClaude(
        scenario: FakeScenario,
        extra?: string,
        agentEnv?: Record<string, string>
    ): { loaded: LoadedConfig; tag: string };
    /** A RunContext with a fresh semaphore, registry and cache dir unless overridden. */
    makeCtx(loaded: LoadedConfig, overrides?: Partial<RunContext>): RunContext;
    /** A session record of the fake `claude` in `work`. */
    record(cacheDir: string, sessionId: string, fields?: Partial<SessionRecord>): Promise<void>;
    /** Kills every fake agent left behind and removes the root; for afterAll. */
    cleanup(): void;
}

export function fakeHarness(prefix: string): FakeHarness {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const work = join(root, 'work');
    mkdirSync(work);
    const tags: string[] = [];

    return {
        root,
        work,
        fakeClaude(scenario, extra = '', agentEnv = {}) {
            const tag = `fake-agent-${randomUUID()}`;
            tags.push(tag);
            const path = join(root, `config-${randomUUID()}.yaml`);
            writeFileSync(
                path,
                [
                    'harnesses:',
                    '  claude:',
                    `    command: ${JSON.stringify(process.execPath)}`,
                    `    args: [${JSON.stringify(fakeAgent)}, "--tag=${tag}"]`,
                    `    env: ${JSON.stringify({ FAKE_SCENARIO: scenario, ...agentEnv })}`,
                    extra,
                    '',
                ].join('\n')
            );
            const loaded = loadConfig({ THRONG_MCP_CONFIG: path });
            expect(loaded.error, loaded.error).toBe(undefined);
            return { loaded, tag };
        },
        makeCtx(loaded, overrides = {}) {
            return {
                loaded,
                depth: 0,
                semaphore: new Semaphore(10),
                sessions: new SessionRegistry(),
                signal: new AbortController().signal,
                progress: noProgress,
                env: { PATH: bin },
                cacheDir: mkdtempSync(join(root, 'cache-')),
                submitTool,
                cancelGraceMs: 1000,
                exitGraceMs: 300,
                ...overrides,
            };
        },
        async record(cacheDir, sessionId, fields = {}) {
            const at = new Date().toISOString();
            await writeSessionRecord(cacheDir, sessionId, {
                harness: 'claude',
                model: 'fake-small',
                cwd: work,
                description: '',
                created_at: at,
                last_used_at: at,
                ...fields,
            });
        },
        cleanup() {
            for (const tag of tags) {
                try {
                    execFileSync('pkill', ['-9', '-f', tag]);
                } catch {
                    // nothing matched
                }
            }
            rmSync(root, { recursive: true, force: true });
        },
    };
}

export function tagAlive(tag: string): boolean {
    try {
        execFileSync('pgrep', ['-f', tag]);
        return true;
    } catch {
        return false;
    }
}

export async function waitFor(what: string, check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) expect.unreachable(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
