import { resolveAdapter } from './discovery.ts';
import type { AdapterSpec } from './discovery.ts';
import type { HarnessDefinition } from './types.ts';

const spec: AdapterSpec = {
    id: 'codex',
    registryId: 'codex-acp',
    adapter: 'codex-acp',
    args: [],
    harnessBin: { name: 'codex', envVar: 'CODEX_PATH' },
};

export const codex: HarnessDefinition = {
    id: spec.id,
    registryId: spec.registryId,
    resolve: (config, registry, env) => resolveAdapter(spec, config, registry, env),
    mapEffort(level, options) {
        if (options.includes(level)) return level;
        if (level === 'max' && options.includes('xhigh')) return 'xhigh';
        return undefined;
    },
    // `read-only` makes codex ask the client for every approval; the permission policy answers there.
    permissionSetup: policy => ({ modeId: policy === 'auto' ? 'agent' : 'read-only' }),
};
