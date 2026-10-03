import { resolveAdapter } from './discovery.ts';
import type { AdapterSpec } from './discovery.ts';
import type { HarnessDefinition } from './types.ts';

// Gemini CLI speaks ACP itself (`gemini --acp`), so the adapter and the harness are one binary.
const spec: AdapterSpec = {
    id: 'gemini',
    registryId: 'gemini',
    adapter: 'gemini',
    args: ['--acp'],
};

export const gemini: HarnessDefinition = {
    id: spec.id,
    registryId: spec.registryId,
    resolve: (config, registry, env) => resolveAdapter(spec, config, registry, env),
    // Gemini CLI exposes no thought_level option (DESIGN §2.3).
    mapEffort: () => undefined,
    // Trust under every policy: an untrusted folder refuses `yolo` and starts no MCP servers, throng's submit_result included.
    permissionSetup: policy => ({
        modeId: policy === 'auto' ? 'yolo' : 'default',
        env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    }),
};
