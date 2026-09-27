import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, readDepth } from './config.ts';
import { HARNESS_IDS, listHarnessesInput } from './contract.ts';
import type { ListHarnessesOutput } from './contract.ts';
import { log } from './log.ts';

// Entry point: `node src/mcp.ts`. stdout belongs to the MCP transport; logs go to stderr.

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const loaded = loadConfig();
if (loaded.error) log.error('config error, using defaults', { error: loaded.error });
const { config } = loaded;

const server = new McpServer({ name: 'throng', version });

server.registerTool(
  'list_harnesses',
  {
    description: 'List the harnesses throng can run, with their models, effort levels and the server limits.',
    inputSchema: listHarnessesInput,
  },
  () => {
    // Stub until harness discovery lands (THRONG-3).
    const reason = loaded.error ? `config error: ${loaded.error}` : 'not implemented yet (THRONG-3)';
    const out: ListHarnessesOutput = {
      harnesses: [],
      unavailable: HARNESS_IDS.map((harness) => ({ harness, reason })),
      limits: {
        max_concurrency: config.limits.max_concurrency,
        max_depth: config.limits.max_depth,
        default_timeout_s: config.limits.timeout_s,
        current_depth: readDepth(),
      },
    };
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
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.stdin.on('end', () => void shutdown('stdin closed'));

await server.connect(transport);
log.info('throng started', { version, pid: process.pid, depth: readDepth(), config: loaded.path });
