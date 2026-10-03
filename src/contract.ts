// External contract of the tools (DESIGN §3): results and failure codes. Transport-agnostic; the inputs are
// described by each tool's schema in src/mcp/tools/.

/** Effort suffix of the agent spec (DESIGN §3.1). Anything else after `:` stays part of the model name. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'gemini'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';

/** A JSON Schema (draft-07 or 2020-12) for structured output (DESIGN §6); compiled by ajv before spawn. */
export type JsonSchemaObject = Record<string, unknown>;

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

/** What a session is doing, as the registry sees it in this process (DESIGN §3.7). */
export type SessionState = 'running' | 'queued' | 'idle' | 'failed';

/**
 * A turn accepted with `background: true`, or `wait_thronglet`'s answer when its `timeout_s` elapsed (DESIGN §3.6).
 * `queued` counts the messages waiting behind the running turn.
 */
export interface TurnPending {
    session_id: string;
    state: 'running' | 'queued';
    queued: number;
}

/** One row of `list_thronglets` (DESIGN §3.7): the session record merged with this process's live state. */
export interface ThrongletInfo {
    session_id: string;
    description: string;
    /** Agent spec as §3.1 would spell it: `<harness>/<model>[:<effort>]`. */
    agent: string;
    cwd: string;
    state: SessionState;
    queued: number;
    /** `false`: the harness cannot resume a session, so `send_message` to it fails with `session_not_found`. */
    accepts_messages: boolean;
    created_at: string;
    last_used_at: string;
    /** When `failed`. */
    last_error?: { code: ErrorCode; message: string };
}

export interface ListThrongletsOutput {
    thronglets: ThrongletInfo[];
}

/** `cancel_thronglet` (DESIGN §3.8): the session is idle again; `cancelled_turn` says whether anything was running or queued. */
export interface CancelThrongletOutput {
    session_id: string;
    state: 'idle';
    cancelled_turn: boolean;
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

/** Failure codes of `run_thronglet` / `send_message` / `wait_thronglet` / `cancel_thronglet` (DESIGN §3.2). */
export const ERROR_CODES = [
    'harness_unavailable',
    'depth_exceeded',
    'elicitation_unsupported',
    'session_not_found',
    'spawn_failed',
    'handshake_timeout',
    'handshake_failed',
    'model_rejected',
    'timeout',
    'cancelled',
    'transport_lost',
    'empty_result',
    'structured_missing',
    'structured_invalid',
    'refusal',
    'agent_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

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
