import { EFFORT_LEVELS, type Effort, HARNESS_IDS, type HarnessId, ThrongError } from './contract.ts';

export interface AgentSpec {
    harness: HarnessId;
    model: string;
    effort?: Effort;
}

const isHarnessId = (value: string): value is HarnessId => (HARNESS_IDS as readonly string[]).includes(value);
const isEffort = (value: string): value is Effort => (EFFORT_LEVELS as readonly string[]).includes(value);

/**
 * Parses `<harness>/<model>[:<effort>]` (DESIGN §3.1). The `:<effort>` suffix is split off only
 * when it is a known level, so a model's own `:tag` stays part of the model.
 */
export function parseAgentSpec(spec: string): AgentSpec {
    const slash = spec.indexOf('/');
    const harness = slash === -1 ? spec : spec.slice(0, slash);
    if (!isHarnessId(harness)) {
        throw new ThrongError(
            'harness_unavailable',
            `Unknown harness "${harness}" in agent spec "${spec}"; valid harnesses: ${HARNESS_IDS.join(', ')}`
        );
    }

    let model = slash === -1 ? '' : spec.slice(slash + 1);
    let effort: Effort | undefined;
    const colon = model.lastIndexOf(':');
    if (colon !== -1) {
        const suffix = model.slice(colon + 1);
        if (isEffort(suffix)) {
            effort = suffix;
            model = model.slice(0, colon);
        }
    }

    if (model === '') {
        throw new ThrongError(
            'model_rejected',
            `Agent spec "${spec}" has no model; expected <harness>/<model>[:<effort>], e.g. ${harness}/<model>:high`
        );
    }
    return effort === undefined ? { harness, model } : { harness, model, effort };
}
