import { defineConfig } from 'tsdown';
import { thirdPartyLicenses } from './scripts/build/third-party-licenses.ts';

// The published bin: two entries, since run.ts spawns the submit tool as its own process.
// The package ships self-contained: runtime libraries live in devDependencies, so tsdown bundles them,
// and dist/THIRD_PARTY_LICENSES.md carries their licenses.
export default defineConfig({
    entry: ['src/mcp.ts', 'src/structured/submit-tool.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: true,
    fixedExtension: false,
    plugins: [thirdPartyLicenses()],
});
