import type { Config, PermissionPolicy } from '../config.ts';
import type { Effort, HarnessId } from '../contract.ts';

// HarnessDefinition contract (DESIGN §4.1, decision-3): plain data plus three hooks.
// Everything harness-specific (adapter command, env for the harness binary, knob names,
// permission modes) lives here; run.ts and list_harnesses stay harness-agnostic.

/** Verbatim shape of data/registry.json (ACP registry v1), only the fields throng reads. */
export interface RegistrySnapshot {
    version: string;
    agents: RegistryAgent[];
}

export interface RegistryAgent {
    id: string;
    name: string;
    version: string;
    description?: string;
    distribution?: {
        npx?: { package: string; args?: string[]; env?: Record<string, string> };
        binary?: Record<string, { archive: string; cmd: string; args?: string[] }>;
    };
}

/** What gets spawned. `env` is merged over the server's environment by the Worker. */
export interface HarnessLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
}

/** `reason` is what `list_harnesses.unavailable[].reason` and `harness_unavailable` carry, install hint included. */
export type HarnessResolution = { available: true; launch: HarnessLaunch } | { available: false; reason: string };

/** A value for `session/set_config_option`: a select option's value id, or the value of a boolean option. */
export type ConfigOptionValue = string | boolean;

/** How a permission policy is expressed natively. Everything here is per adapter process, so it applies to resumed turns too. */
export interface PermissionSetup {
    modeId?: string;
    env?: Record<string, string>;
    newSessionMeta?: Record<string, unknown>;
    /** Set by id after the mode, in order. Best effort, unlike the mode: an option the agent lacks or rejects is a warning. */
    configOptions?: { id: string; value: ConfigOptionValue }[];
    /** Appended to the launch args of the adapter process. */
    args?: string[];
}

export interface HarnessDefinition {
    id: HarnessId;
    registryId: string;
    /** Adapter command from config or PATH; harness binary env when found (decision-3). Pure: no spawning. */
    resolve(config: Config, registry: RegistrySnapshot, env?: NodeJS.ProcessEnv): HarnessResolution;
    /** Our effort level → value of the `thought_level` option; `undefined` = not applicable, reported as a warning. */
    mapEffort(level: Effort, options: string[]): string | undefined;
    permissionSetup(policy: PermissionPolicy): PermissionSetup;
    /** Agent messages outside a turn that are routine for this harness; dropped instead of reported as warnings. */
    preTurnNoise?: RegExp[];
}
