import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type LoadedConfig, readDepth } from '../config.ts';
import type { RunContext, RunOutcome } from '../run.ts';
import type { SessionRegistry } from '../registry.ts';
import type { Semaphore } from '../semaphore.ts';
import { createProgress, type ProgressExtra } from './progress.ts';
import * as listHarnesses from './tools/list-harnesses.ts';
import * as runThronglet from './tools/run-thronglet.ts';
import * as sendMessage from './tools/send-message.ts';

export interface ToolDeps {
    loaded: LoadedConfig;
    /** One per process (DESIGN §7). */
    semaphore: Semaphore;
    /** One per process: the per-session turn queue (DESIGN §3.3). */
    sessions: SessionRegistry;
    cacheDir: string;
}

/** What a tool file gets to register itself. */
export interface ToolEnv {
    loaded: LoadedConfig;
    /** Shared body of run_thronglet and send_message: progress, tracking, one JSON text block, isError on failure. */
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
    const { loaded, semaphore, sessions, cacheDir } = deps;
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
                start({ loaded, depth: readDepth(), semaphore, sessions, signal: extra.signal, progress, cacheDir })
            );
            // A progress notification written after the result hits the client as an unknown token. Bounded: done() already
            // stopped new sends. After an abort the SDK drops the result anyway, so don't wait.
            if (!extra.signal.aborted) await progress.idle();
            const content = [{ type: 'text' as const, text: JSON.stringify(outcome.payload) }];
            return outcome.ok ? { content } : { content, isError: true };
        },
    };

    for (const tool of [listHarnesses, runThronglet, sendMessage]) tool.register(server, env);

    return {
        drain: async () => {
            await Promise.allSettled(inflight);
        },
    };
}
