import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseAgentSpec } from '../../agent-spec.ts';
import { type RunContext, type RunOutcome, runCall } from '../../run.ts';
import type { ToolEnv } from '../tools.ts';

/** Shared with resume_thronglet. */
export const schemaField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('JSON Schema for structured output; not supported yet, ignored with a warning');
export const timeoutField = z.number().positive().optional().describe('Wall-clock limit for the run in seconds; default from config (21600)');

const inputSchema = {
  agent: z.string().describe('<harness>/<model>[:<effort>], e.g. claude/opus[1m]:max, codex/gpt-6-sol:xhigh; valid values: list_harnesses'),
  prompt: z.string().describe('Task for the agent'),
  cwd: z.string().refine(isAbsolute, 'cwd must be an absolute path').describe('Absolute path; the agent works in this tree'),
  schema: schemaField,
  timeout_s: timeoutField,
};

export type RunThrongletInput = z.infer<z.ZodObject<typeof inputSchema>>;

/** A new session from the agent spec. Never throws: every failure is a `{ ok: false }` payload. */
export function runThronglet(input: RunThrongletInput, ctx: RunContext): Promise<RunOutcome> {
  return runCall(
    {
      tool: 'run_thronglet',
      prompt: input.prompt,
      schema: input.schema,
      timeout_s: input.timeout_s,
      logFields: { agent: input.agent },
      request: () => Promise.resolve({ kind: 'new', spec: parseAgentSpec(input.agent), cwd: input.cwd }),
    },
    ctx,
  );
}

export function register(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    'run_thronglet',
    {
      description:
        'Runs a coding agent (Claude Code, Codex, OpenCode) on a task in cwd and returns its final message as JSON ' +
        '{session_id, text, stop_reason, usage, duration_s, warnings?}.',
      inputSchema,
    },
    (args, extra) => env.callRun(extra, (ctx) => runThronglet(args, ctx)),
  );
}
