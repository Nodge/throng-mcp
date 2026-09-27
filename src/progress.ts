import { log } from './log.ts';

// MCP progress for one tool call (DESIGN §7). Keeps Claude Code's 30-minute idle timeout from firing on long turns.

export interface ProgressNotification {
  method: 'notifications/progress';
  params: { progressToken: string | number; progress: number; message?: string };
}

/** The slice of the SDK's `RequestHandlerExtra` progress needs. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification: (notification: ProgressNotification) => Promise<void>;
}

export interface Progress {
  /** Waiting for the semaphore at `position`; also keeps the heartbeat going while queued. */
  queued(position: number): void;
  /** The run itself began: heartbeat with the elapsed time from here on. */
  started(): void;
  /** Every `tool_call`. */
  tool(title: string): void;
  /** Agent text of the current turn has `chars` characters; throttled. */
  text(chars: number): void;
  /** Stops the heartbeat; later calls are ignored. */
  done(): void;
  /** Resolves once every notification sent so far has been handed to the transport; await before returning the result. */
  idle(): Promise<void>;
}

export interface ProgressOptions {
  textEveryMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

export const noProgress: Progress = {
  queued: () => {},
  started: () => {},
  tool: () => {},
  text: () => {},
  done: () => {},
  idle: () => Promise.resolve(),
};

/** No-op when the client didn't ask for progress (no `progressToken`). */
export function createProgress(extra: ProgressExtra, options: ProgressOptions = {}): Progress {
  const token = extra._meta?.progressToken;
  if (token === undefined) return noProgress;
  const textEveryMs = options.textEveryMs ?? 2000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const now = options.now ?? Date.now;

  let counter = 0;
  let chain = Promise.resolve();
  let failed = false;
  let finished = false;
  let lastText = -Infinity;
  let queuedAt: number | undefined;
  let startedAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;

  // Serialized: each send waits for the previous one (stdio backpressure).
  const send = (message: string) => {
    if (finished) return;
    const progress = ++counter;
    chain = chain
      .then(() => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, message } }))
      .catch((err: unknown) => {
        if (failed) return;
        failed = true;
        log.warn('progress notification failed', { error: err instanceof Error ? err.message : String(err) });
      });
  };

  const beat = () => {
    if (startedAt !== undefined) send(`running ${formatElapsed(now() - startedAt)}`);
    else if (queuedAt !== undefined) send(`queued ${formatElapsed(now() - queuedAt)}`);
  };
  const ensureHeartbeat = () => {
    if (!timer && !finished) {
      timer = setInterval(beat, heartbeatMs);
      timer.unref();
    }
  };

  return {
    queued(position) {
      queuedAt ??= now();
      send(`queued (${position})`);
      ensureHeartbeat();
    },
    started() {
      startedAt = now();
      ensureHeartbeat();
    },
    tool(title) {
      send(title);
    },
    text(chars) {
      const t = now();
      if (t - lastText < textEveryMs) return;
      lastText = t;
      send(`agent is writing… (${chars} chars)`);
    },
    done() {
      finished = true;
      clearInterval(timer);
      timer = undefined;
    },
    idle: () => chain,
  };
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
