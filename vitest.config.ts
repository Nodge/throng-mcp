import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        // Tests drive real child processes (fake agent, MCP server) and wait on their timeouts.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
