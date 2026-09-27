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

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

/** Everything a failed run knows besides the code and the message: partial results the caller can still use. */
export interface FailureContext {
  session_id?: string;
  text?: string;
  usage?: Usage;
  warnings?: string[];
}

/**
 * A run failure that becomes an MCP tool error with the DESIGN §3.2 payload.
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
