import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type LoadedConfig, readDepth } from '../config.ts';
import type { RunContext, RunOutcome } from '../run.ts';
import type { Semaphore } from '../semaphore.ts';
import { createProgress, type ProgressExtra } from './progress.ts';
import * as listHarnesses from './tools/list-harnesses.ts';
import * as resumeThronglet from './tools/resume-thronglet.ts';
import * as runThronglet from './tools/run-thronglet.ts';

export interface ToolDeps {
    loaded: LoadedConfig;
    /** One per process (DESIGN §7). */
    semaphore: Semaphore;
    cacheDir: string;
}

/** What a tool file gets to register itself. */
export interface ToolEnv {
    loaded: LoadedConfig;
    /** Shared body of run_thronglet and resume_thronglet: progress, tracking, one JSON text block, isError on failure. */
    callRun(
        extra: ProgressExtra & { signal: AbortSignal },
        start: (ctx: RunContext) => Promise<RunOutcome>
    ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
    /** Marks a call in flight, so that shutdown waits for it. */
    track<T>(call: Promise<T>): Promise<T>;
}

export interface Tools {
    /** Resolves once every call in flight has finished, its cleanup (scratch dirs, adapters) included. */
    drain(): Promise<void>;
}

/** Registers every tool; one file per tool under tools/. Every result is one JSON text block (decision-2). */
export function registerTools(server: McpServer, deps: ToolDeps): Tools {
    const { loaded, semaphore, cacheDir } = deps;
    const inflight = new Set<Promise<unknown>>();
    const track = <T>(call: Promise<T>): Promise<T> => {
        inflight.add(call);
        call.finally(() => inflight.delete(call)).catch(() => {
            /* ignored */
        });
        return call;
    };

    const env: ToolEnv = {
        loaded,
        track,
        async callRun(extra, start) {
            const progress = createProgress(extra);
            const outcome = await track(
                start({ loaded, depth: readDepth(), semaphore, signal: extra.signal, progress, cacheDir })
            );
            // A progress notification written after the result hits the client as an unknown token. Bounded: done() already
            // stopped new sends. After an abort the SDK drops the result anyway, so don't wait.
            if (!extra.signal.aborted) await progress.idle();
            const content = [{ type: 'text' as const, text: JSON.stringify(outcome.payload) }];
            return outcome.ok ? { content } : { content, isError: true };
        },
    };

    for (const tool of [listHarnesses, runThronglet, resumeThronglet]) tool.register(server, env);

    return {
        drain: async () => {
            await Promise.allSettled(inflight);
        },
    };
}
