import type {
    AgentCapabilities,
    Implementation,
    McpServer,
    PromptResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionConfigOption,
    SessionModeState,
    SessionNotification,
} from '@agentclientprotocol/sdk';

// Worker contract (DESIGN §4.2). One Worker = one adapter process = one ACP session.
// The Worker knows ACP and the child process; it knows nothing about MCP. Everything
// MCP-flavoured (progress, elicitation, abort signal, timeouts of the whole call) is
// wired by the caller through the hooks below.

/** How to launch the adapter. `env` is merged over the server's own environment. */
export interface WorkerSpawn {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    /** This server's depth; the child gets `THRONG_MCP_DEPTH = depth + 1` (DESIGN §7). */
    depth: number;
}

/** `session/new` for a fresh run, `session/resume` for send_message (requires `sessionCapabilities.resume`). */
export type SessionStart =
    | { kind: 'new'; cwd: string; mcpServers: McpServer[]; meta?: Record<string, unknown> }
    | { kind: 'resume'; sessionId: string; cwd: string; mcpServers: McpServer[] };

export interface WorkerHooks {
    /** Every `session/update` of this session, in order; feeds the collector and progress. */
    onUpdate?: (notification: SessionNotification) => void;
    /** Answer to `session/request_permission`; the Worker never decides itself. */
    onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    /** Non-fatal oddities of the adapter, e.g. a call to an unadvertised `fs/*` method (DESIGN §4.2); goes to `warnings`. */
    onWarning?: (text: string) => void;
}

export interface WorkerLimits {
    /** Covers spawn + initialize + session/new|resume (DESIGN §4.2 steps 1–3). */
    handshakeMs: number;
    /** Grace after closing stdin before SIGTERM, and after SIGTERM before SIGKILL (step 7); 5000 in production. */
    exitGraceMs?: number;
}

/** What the handshake learned; enough for model/effort/mode selection and for the list_harnesses probe. */
export interface WorkerSession {
    sessionId: string;
    agentInfo?: Implementation;
    agentCapabilities?: AgentCapabilities;
    modes?: SessionModeState;
    /** Refreshed by every `setConfigOption`: the agent returns the full list, and effort values may depend on the model. */
    configOptions?: SessionConfigOption[];
}

/**
 * A live adapter process with an open session. Methods reject with ThrongError:
 * `spawn_failed`, `handshake_timeout`, `handshake_failed`, `session_not_found` (from start),
 * `transport_lost` (process died or stream closed mid-call), `agent_error` (JSON-RPC error from the agent).
 * Every message carries the tail of the adapter's stderr.
 */
export interface Worker {
    readonly session: WorkerSession;
    readonly pid: number;
    setMode(modeId: string): Promise<void>;
    /** A boolean `value` is sent as a boolean option's value. Returns the refreshed option list the agent sends back. */
    setConfigOption(configId: string, value: string | boolean): Promise<SessionConfigOption[]>;
    /** One turn: resolves when the agent reports `stop`; updates arrive through `onUpdate` meanwhile. */
    prompt(text: string): Promise<PromptResponse>;
    /** `session/cancel`; the pending `prompt` then resolves with `stopReason: 'cancelled'` (or rejects if the agent dies). */
    cancel(): Promise<void>;
    /** DESIGN §4.2 step 7: stdin close → SIGTERM the group → SIGKILL, plus the descendant snapshot. Idempotent, never throws. */
    close(): Promise<void>;
    /** Last ≤64 KB of the adapter's stderr. */
    stderrTail(): string;
}

/** Spawns the adapter and runs the handshake (steps 1–3); rejects with the codes listed on `Worker`. */
export type StartWorker = (
    spawn: WorkerSpawn,
    start: SessionStart,
    hooks: WorkerHooks,
    limits: WorkerLimits
) => Promise<Worker>;
