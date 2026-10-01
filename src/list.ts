import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from './acp/types.ts';
import { startWorker } from './acp/worker.ts';
import type { Config, LoadedConfig } from './config.ts';
import { HARNESS_IDS, type HarnessInfo, type ListHarnessesOutput } from './contract.ts';
import { HARNESSES, loadRegistry } from './harnesses/index.ts';
import { optionByCategory } from './harnesses/select.ts';
import type { HarnessDefinition, RegistrySnapshot } from './harnesses/types.ts';

// list_harnesses (DESIGN §3.4): every available harness is started over ACP, no prompt, and closed again.

export interface ProbeOptions {
    handshakeMs: number;
    /** This server's depth; the probed adapter gets depth + 1 like any worker. */
    depth: number;
    /** Environment for the PATH lookup; the server's own by default. */
    env?: NodeJS.ProcessEnv;
}

export type ProbeResult = { ok: true; info: HarnessInfo } | { ok: false; reason: string };

/** Handshake in a throwaway cwd; reads models, efforts and the adapter version. Never throws. */
export async function probeHarness(
    def: HarnessDefinition,
    config: Config,
    registry: RegistrySnapshot,
    opts: ProbeOptions
): Promise<ProbeResult> {
    const resolution = def.resolve(config, registry, opts.env);
    if (!resolution.available) return { ok: false, reason: resolution.reason };
    const { launch } = resolution;

    let cwd: string | undefined;
    let worker: Worker | undefined;
    try {
        cwd = await mkdtemp(join(tmpdir(), `throng-probe-${def.id}-`));
        worker = await startWorker(
            { ...launch, cwd, depth: opts.depth },
            { kind: 'new', cwd, mcpServers: [] },
            { onPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }) },
            { handshakeMs: opts.handshakeMs, exitGraceMs: 1000 }
        );
        const { configOptions, agentInfo } = worker.session;
        const info: HarnessInfo = {
            harness: def.id,
            command: [launch.command, ...launch.args],
            models: optionByCategory(configOptions, 'model')?.values ?? [],
            efforts: optionByCategory(configOptions, 'thought_level')?.values ?? [],
        };
        if (agentInfo?.version) info.version = agentInfo.version;
        return { ok: true, info };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
        await worker?.close();
        if (cwd)
            await rm(cwd, { recursive: true, force: true }).catch(() => {
                /* ignored */
            });
    }
}

/** A config error marks every harness unavailable without probing; otherwise all three are probed in parallel. */
export async function listHarnesses(loaded: LoadedConfig, opts: ProbeOptions): Promise<ListHarnessesOutput> {
    const { config } = loaded;
    const limits = {
        max_concurrency: config.limits.max_concurrency,
        max_depth: config.limits.max_depth,
        default_timeout_s: config.limits.timeout_s,
        current_depth: opts.depth,
    };
    if (loaded.error) {
        const reason = `config error: ${loaded.error}`;
        return { harnesses: [], unavailable: HARNESS_IDS.map(harness => ({ harness, reason })), limits };
    }

    const registry = loadRegistry();
    const results = await Promise.all(
        HARNESS_IDS.map(async harness => ({
            harness,
            result: await probeHarness(HARNESSES[harness], config, registry, opts),
        }))
    );
    const out: ListHarnessesOutput = { harnesses: [], unavailable: [], limits };
    for (const { harness, result } of results) {
        if (result.ok) out.harnesses.push(result.info);
        else out.unavailable.push({ harness, reason: result.reason });
    }
    return out;
}
