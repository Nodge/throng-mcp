import { resolveAdapter } from './discovery.ts';
import type { AdapterSpec } from './discovery.ts';
import type { HarnessDefinition } from './types.ts';

const spec: AdapterSpec = {
    id: 'opencode',
    registryId: 'opencode',
    adapter: 'opencode',
    args: ['acp'],
};

export const opencode: HarnessDefinition = {
    id: spec.id,
    registryId: spec.registryId,
    resolve: (config, registry, env) => resolveAdapter(spec, config, registry, env),
    mapEffort: (level, options) => (options.includes(level) ? level : undefined),
    // `auto` keeps the user's opencode.json; any other policy routes every tool through request_permission.
    permissionSetup: policy => (policy === 'auto' ? {} : { env: { OPENCODE_CONFIG_CONTENT: '{"permission":"ask"}' } }),
};
