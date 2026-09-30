import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeAllWorkers } from './acp/worker.ts';
import { loadConfig, readDepth } from './config.ts';
import { listHarnessesInput, resumeThrongletInput, runThrongletInput } from './contract.ts';
import { listHarnesses } from './harnesses/probe.ts';
import { log } from './log.ts';
import { createProgress, type ProgressExtra } from './progress.ts';
import { type RunContext, type RunOutcome, resumeThronglet, runThronglet } from './run.ts';
import { Semaphore } from './semaphore.ts';
import { cacheDir, rotate } from './sessions.ts';

// Entry point: `node src/mcp.ts`. stdout belongs to the MCP transport; logs go to stderr.

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const loaded = loadConfig();
if (loaded.error) log.error('config error: run_thronglet refuses to run until it is fixed', { error: loaded.error });
const { config } = loaded;

const cache = cacheDir();
await rotate(cache);
/** One per process (DESIGN §7). */
const semaphore = new Semaphore(config.limits.max_concurrency);

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
    description:
      'Discover valid agent values for run_thronglet (<harness>/<model>[:<effort>]): ' +
      'available harnesses with their models and effort levels, unavailable ones with the reason and install hint, ' +
      'and the server limits (concurrency, nesting depth, default timeout). ' +
      'Probes every harness on each call, takes a few seconds, spends no tokens.',
    inputSchema: listHarnessesInput,
  },
  async () => {
    const out = await track(listHarnesses(loaded, { handshakeMs: config.limits.handshake_s * 1000, depth: readDepth() }));
    // One JSON text block, no structuredContent (decision-2).
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  },
);

server.registerTool(
  'run_thronglet',
  {
    description:
      'Run a coding harness (Claude Code, Codex, OpenCode) on a task in cwd and return its final message. ' +
      'agent: <harness>/<model>[:<effort>], e.g. claude/opus-5-5:max. ' +
      'prompt must be self-contained: the nested session does not see this conversation. ' +
      'cwd: absolute path; the harness edits that tree directly. ' +
      'Returns one JSON text block {session_id, text, stop_reason, usage, duration_s, warnings?}; ' +
      'failures are tool errors with {code, message, session_id?, text?, usage?, duration_s, warnings?}.',
    inputSchema: runThrongletInput,
  },
  (args, extra) => callRun(extra, (ctx) => runThronglet(args, ctx)),
);

server.registerTool(
  'resume_thronglet',
  {
    description:
      'Send a follow-up prompt into an earlier nested session (session_id from run_thronglet / resume_thronglet). ' +
      'Harness, model, effort and cwd come from the session record; the nested session keeps its own context. ' +
      'Returns the same payload as run_thronglet with the same session_id; ' +
      'session_not_found for an unknown id or a harness that cannot resume.',
    inputSchema: resumeThrongletInput,
  },
  (args, extra) => callRun(extra, (ctx) => resumeThronglet(args, ctx)),
);

/** Shared body of run_thronglet and resume_thronglet: progress, tracking, one JSON text block, isError on failure. */
async function callRun(extra: ProgressExtra & { signal: AbortSignal }, start: (ctx: RunContext) => Promise<RunOutcome>) {
  const progress = createProgress(extra);
  const outcome = await track(start({ loaded, depth: readDepth(), semaphore, signal: extra.signal, progress, cacheDir: cache }));
  // A progress notification written after the result hits the client as an unknown token. Bounded: done() already
  // stopped new sends. After an abort the SDK drops the result anyway, so don't wait.
  if (!extra.signal.aborted) await progress.idle();
  const content = [{ type: 'text' as const, text: JSON.stringify(outcome.payload) }];
  return outcome.ok ? { content } : { content, isError: true };
}

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
