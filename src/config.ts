import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { HARNESS_IDS } from './contract.ts';

// Server config (DESIGN §8). Unknown keys are rejected so a typo surfaces as a config error instead of being ignored.

const permissionPolicy = z.enum(['auto', 'allow_all', 'deny_all', 'elicit']);

const harnessOverride = z.strictObject({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    permissions: permissionPolicy.optional(),
});

const limits = z.strictObject({
    timeout_s: z.number().positive().default(21600),
    handshake_s: z.number().positive().default(60),
    elicitation_s: z.number().positive().default(600),
    max_concurrency: z.number().int().positive().default(10),
    max_depth: z.number().int().nonnegative().default(2),
});

// A section left with no value (`limits:` with every child commented out) parses as null; it counts as absent.
const section = <T extends z.ZodType>(schema: T) => z.preprocess(v => v ?? undefined, schema);

const configSchema = z.strictObject({
    permissions: section(permissionPolicy.default('auto')),
    harnesses: section(
        z
            .partialRecord(
                z.enum(HARNESS_IDS),
                z.preprocess(v => v ?? {}, harnessOverride)
            )
            .default({})
    ),
    limits: section(limits.prefault({})),
});

export type PermissionPolicy = z.infer<typeof permissionPolicy>;
export type HarnessOverride = z.infer<typeof harnessOverride>;
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(configSchema.parse({}));

export interface LoadedConfig {
    config: Config;
    /** One line with the path and the yaml/zod message; the config is then the defaults. */
    error?: string;
    path: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty variable means unset
    return env.THRONG_MCP_CONFIG || join(homedir(), '.config', 'throng', 'config.yaml');
}

/** Reads the YAML config over the defaults. Never throws: any failure yields the defaults plus `error`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
    const path = configPath(env);
    const fallback = (error: string): LoadedConfig => ({
        config: configSchema.parse({}),
        error: `${path}: ${error}`,
        path,
    });

    let source: string;
    try {
        source = readFileSync(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: configSchema.parse({}), path };
        return fallback(`cannot read: ${err instanceof Error ? err.message : String(err)}`);
    }

    let raw: unknown;
    try {
        raw = parseYaml(source);
    } catch (err) {
        // yaml appends a multi-line source excerpt after the first line.
        const message = err instanceof Error ? err.message : String(err);
        return fallback(`invalid YAML: ${message.split('\n')[0]?.replace(/:$/, '')}`);
    }

    const result = configSchema.safeParse(raw ?? {});
    if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
        return fallback(`invalid config: ${issues.join('; ')}`);
    }
    return { config: result.data, path };
}

/** Nesting depth of this server (`THRONG_MCP_DEPTH`): a non-negative integer, anything else counts as 0. */
export function readDepth(env: NodeJS.ProcessEnv = process.env): number {
    const value = env.THRONG_MCP_DEPTH?.trim();
    if (!value || !/^\d+$/.test(value)) return 0;
    const depth = Number(value);
    return Number.isSafeInteger(depth) ? depth : 0;
}
