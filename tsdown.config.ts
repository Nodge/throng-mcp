import { defineConfig } from 'tsdown';

// The published bin: two entries, since run.ts spawns the submit tool as its own process. Dependencies stay external.
export default defineConfig({
    entry: ['src/mcp.ts', 'src/structured/submit-tool.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: true,
    fixedExtension: false,
});
