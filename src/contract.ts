import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ErrorCode, Usage } from './errors.ts';

// External contract of the MCP tools (DESIGN §3). Input schemas are zod raw shapes for
// `McpServer.registerTool`; invalid input is rejected by the SDK's validation before our code runs.
// Output types describe the single JSON text block in `content[0].text` (decision-2).

/** Effort suffix of the agent spec (DESIGN §3.1). Anything else after `:` stays part of the model name. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const HARNESS_IDS = ['claude', 'codex', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const runThrongletInput = {
  agent: z.string().describe('Agent spec: <harness>/<model>[:<effort>], e.g. claude/opus-5-5:max, codex/gpt-6-sol:xhigh'),
  prompt: z.string().describe('Self-contained task: the nested session does not see this conversation'),
  cwd: z.string().refine(isAbsolute, 'cwd must be an absolute path').describe('Absolute path; the harness edits this tree directly'),
  schema: jsonSchemaObject.optional().describe('JSON Schema for structured output; the result comes back in `structured`'),
  timeout_s: z.number().positive().optional().describe('Wall-clock limit for the run; default from config (21600)'),
};

export const resumeThrongletInput = {
  session_id: z.string().describe('session_id from a previous run_thronglet / resume_thronglet'),
  prompt: z.string(),
  schema: jsonSchemaObject.optional(),
  timeout_s: z.number().positive().optional(),
};

export const listHarnessesInput = {};

export type RunThrongletInput = z.infer<z.ZodObject<typeof runThrongletInput>>;
export type ResumeThrongletInput = z.infer<z.ZodObject<typeof resumeThrongletInput>>;

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';

export interface RunSuccess {
  session_id: string;
  text?: string;
  structured?: unknown;
  stop_reason: StopReason;
  usage: Usage;
  duration_s: number;
  warnings?: string[];
}

export interface RunFailure {
  code: ErrorCode;
  message: string;
  session_id?: string;
  text?: string;
  usage?: Usage;
  duration_s: number;
  warnings?: string[];
}

export interface HarnessInfo {
  harness: HarnessId;
  command: string[];
  /** Adapter's `initialize.agentInfo.version`. */
  version?: string;
  models: string[];
  efforts: string[];
}

export interface ListHarnessesOutput {
  harnesses: HarnessInfo[];
  unavailable: Array<{ harness: string; reason: string }>;
  limits: {
    max_concurrency: number;
    max_depth: number;
    default_timeout_s: number;
    current_depth: number;
  };
}
