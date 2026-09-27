import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeAllWorkers } from './acp/worker.ts';
import { loadConfig, readDepth } from './config.ts';
import { listHarnessesInput } from './contract.ts';
import { listHarnesses } from './harnesses/probe.ts';
import { log } from './log.ts';

// Entry point: `node src/mcp.ts`. stdout belongs to the MCP transport; logs go to stderr.

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const loaded = loadConfig();
if (loaded.error) log.error('config error, using defaults', { error: loaded.error });
const { config } = loaded;

const server = new McpServer({ name: 'throng', version });

/** Tool calls still running; shutdown waits for them so their cleanup (scratch dirs) runs. */
const inflight = new Set<Promise<unknown>>();
function track<T>(call: Promise<T>): Promise<T> {
  inflight.add(call);
  call.finally(() => inflight.delete(call)).catch(() => {});
  return call;
}

server.registerTool(
  'list_harnesses',
  {
    description: 'List the harnesses throng can run, with their models, effort levels and the server limits.',
    inputSchema: listHarnessesInput,
  },
  async () => {
    const out = await track(listHarnesses(loaded, { handshakeMs: config.limits.handshake_s * 1000, depth: readDepth() }));
    // One JSON text block, no structuredContent (decision-2).
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  },
);

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
  await Promise.allSettled(inflight);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.stdin.on('end', () => void shutdown('stdin closed'));

await server.connect(transport);
log.info('throng started', { version, pid: process.pid, depth: readDepth(), config: loaded.path });
