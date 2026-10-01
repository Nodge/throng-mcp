// External contract of the tools (DESIGN §3): results and failure codes. Transport-agnostic; the inputs are
// described by each tool's schema in src/mcp/tools/.

/** Effort suffix of the agent spec (DESIGN §3.1). Anything else after `:` stays part of the model name. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const HARNESS_IDS = ['claude', 'codex', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

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
  unavailable: { harness: string; reason: string }[];
  limits: {
    max_concurrency: number;
    max_depth: number;
    default_timeout_s: number;
    current_depth: number;
  };
}

/** Failure codes of `run_thronglet` / `resume_thronglet` (DESIGN §3.2). */
export type ErrorCode =
  | 'harness_unavailable'
  | 'depth_exceeded'
  | 'elicitation_unsupported'
  | 'session_not_found'
  | 'spawn_failed'
  | 'handshake_timeout'
  | 'handshake_failed'
  | 'model_rejected'
  | 'timeout'
  | 'cancelled'
  | 'transport_lost'
  | 'empty_result'
  | 'structured_missing'
  | 'structured_invalid'
  | 'refusal'
  | 'agent_error';

/** Everything a failed run knows besides the code and the message: partial results the caller can still use. */
export interface FailureContext {
  session_id?: string;
  text?: string;
  usage?: Usage;
  warnings?: string[];
}

/**
 * A run failure that becomes a tool error with the DESIGN §3.2 payload.
 * `message` carries the actual text (adapter stderr excerpt, list of valid models), not a paraphrase.
 */
export class ThrongError extends Error {
  readonly code: ErrorCode;
  readonly context: FailureContext;

  constructor(code: ErrorCode, message: string, context: FailureContext = {}) {
    super(message);
    this.name = 'ThrongError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Anything thrown that is not a ThrongError is reported as `agent_error` with its message.
 * `context` fills in what the error itself doesn't carry (e.g. session_id known only to the caller).
 */
export function toThrongError(err: unknown, context: FailureContext = {}): ThrongError {
  if (err instanceof ThrongError) {
    return new ThrongError(err.code, err.message, { ...context, ...err.context });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ThrongError('agent_error', message, context);
}
