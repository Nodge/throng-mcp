import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseAgentSpec } from '../../agent-spec.ts';
import { type RunContext, type RunOutcome, runCall } from '../../run.ts';
import { compileSchema } from '../../structured/validate.ts';
import type { ToolEnv } from '../tools.ts';

/** Shared with resume_thronglet. An invalid schema is an input error (DESIGN §6): ajv must compile it. */
export const schemaField = z
    .record(z.string(), z.unknown())
    .superRefine((schema, ctx) => {
        try {
            compileSchema(schema);
        } catch (err) {
            ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : String(err) });
        }
    })
    .optional()
    .describe(
        'JSON Schema (draft-07 or 2020-12) for structured output: the agent submits a matching result, returned as `structured` instead of `text`'
    );
export const timeoutField = z
    .number()
    .positive()
    .optional()
    .describe('Wall-clock limit for the run in seconds; default from config (21600)');

const inputSchema = {
    agent: z
        .string()
        .describe(
            '<harness>/<model>[:<effort>], e.g. claude/opus[1m]:max, codex/gpt-6-sol:xhigh; valid values: list_harnesses'
        ),
    prompt: z.string().describe('Task for the agent'),
    cwd: z
        .string()
        .refine(isAbsolute, 'cwd must be an absolute path')
        .describe('Absolute path; the agent works in this tree'),
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
        ctx
    );
}

export function register(server: McpServer, env: ToolEnv): void {
    server.registerTool(
        'run_thronglet',
        {
            description:
                'Runs a coding agent (Claude Code, Codex, OpenCode) on a task in cwd and returns its final message as JSON ' +
                '{session_id, text, stop_reason, usage, duration_s, warnings?}; with schema, structured replaces text.',
            inputSchema,
        },
        (args, extra) => env.callRun(extra, ctx => runThronglet(args, ctx))
    );
}
