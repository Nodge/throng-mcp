import { resolveAdapter } from './discovery.ts';
import type { AdapterSpec } from './discovery.ts';
import type { HarnessDefinition } from './types.ts';

const spec: AdapterSpec = {
    id: 'claude',
    registryId: 'claude-acp',
    adapter: 'claude-agent-acp',
    args: [],
    harnessBin: { name: 'claude', envVar: 'CLAUDE_CODE_EXECUTABLE' },
};

export const claude: HarnessDefinition = {
    id: spec.id,
    registryId: spec.registryId,
    resolve: (config, registry, env) => resolveAdapter(spec, config, registry, env),
    mapEffort: (level, options) => (options.includes(level) ? level : undefined),
    permissionSetup: policy => ({ modeId: policy === 'auto' ? 'auto' : 'default' }),
};
