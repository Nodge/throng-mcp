import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeAllWorkers } from './acp/worker.ts';
import { loadConfig, readDepth } from './config.ts';
import { log } from './log.ts';
import { registerTools } from './mcp/tools.ts';
import { SessionRegistry } from './registry.ts';
import { Semaphore } from './semaphore.ts';
import { cacheDir, rotate } from './sessions.ts';

// Entry point: `node src/mcp.ts`. stdout belongs to the MCP transport; logs go to stderr.

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
};

const loaded = loadConfig();
if (loaded.error) log.error('config error: run_thronglet refuses to run until it is fixed', { error: loaded.error });

const cache = cacheDir();
await rotate(cache);

const server = new McpServer({ name: 'throng', version });
const tools = registerTools(server, {
    loaded,
    semaphore: new Semaphore(loaded.config.limits.max_concurrency),
    sessions: new SessionRegistry(),
    cacheDir: cache,
});
const transport = new StdioServerTransport();

let stopping = false;
async function shutdown(why: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info('throng stopping', { why });
    try {
        await server.close();
    } catch (err) {
        log.error('close failed', { error: err instanceof Error ? err.message : String(err) });
    }
    // Workers first: with their adapters gone, the calls waiting on them settle quickly.
    await closeAllWorkers();
    await tools.drain();
    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.stdin.on('end', () => void shutdown('stdin closed'));

await server.connect(transport);
log.info('throng started', { version, pid: process.pid, depth: readDepth(), config: loaded.path });
