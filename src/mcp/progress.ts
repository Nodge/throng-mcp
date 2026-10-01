import { log } from '../log.ts';
import { noProgress, type Progress } from '../progress.ts';

// MCP progress notifications for one tool call (DESIGN §7). Sent only when the client asked for them with a
// `progressToken`. The heartbeat keeps a client's idle timeout from dropping a long call (Claude Code: 30 min).

export interface ProgressNotification {
  method: 'notifications/progress';
  params: { progressToken: string | number; progress: number; message?: string };
}

/** The slice of the SDK's `RequestHandlerExtra` progress needs. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification: (notification: ProgressNotification) => Promise<void>;
}

export interface ProgressOptions {
  textEveryMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

/** `noProgress` when the client didn't ask for progress (no `progressToken`). */
export function createProgress(extra: ProgressExtra, options: ProgressOptions = {}): Progress {
  const token = extra._meta?.progressToken;
  return token === undefined ? noProgress : new McpProgress(extra, token, options);
}

class McpProgress implements Progress {
  readonly #extra: ProgressExtra;
  readonly #token: string | number;
  readonly #textEveryMs: number;
  readonly #heartbeatMs: number;
  readonly #now: () => number;
  #counter = 0;
  #chain = Promise.resolve();
  #failed = false;
  #finished = false;
  #lastText = -Infinity;
  #queuedAt: number | undefined;
  #startedAt: number | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(extra: ProgressExtra, token: string | number, options: ProgressOptions) {
    this.#extra = extra;
    this.#token = token;
    this.#textEveryMs = options.textEveryMs ?? 2000;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  queued(position: number): void {
    this.#queuedAt ??= this.#now();
    this.#send(`queued (${position})`);
    this.#ensureHeartbeat();
  }

  started(): void {
    this.#startedAt = this.#now();
    this.#ensureHeartbeat();
  }

  tool(title: string): void {
    this.#send(title);
  }

  text(chars: number): void {
    const t = this.#now();
    if (t - this.#lastText < this.#textEveryMs) return;
    this.#lastText = t;
    this.#send(`agent is writing… (${chars} chars)`);
  }

  done(): void {
    this.#finished = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  idle(): Promise<void> {
    return this.#chain;
  }

  // Serialized: each send waits for the previous one (stdio backpressure).
  #send(message: string): void {
    if (this.#finished) return;
    const progress = ++this.#counter;
    const params = { progressToken: this.#token, progress, message };
    this.#chain = this.#chain
      .then(() => this.#extra.sendNotification({ method: 'notifications/progress', params }))
      .catch((err: unknown) => {
        if (this.#failed) return;
        this.#failed = true;
        log.warn('progress notification failed', { error: err instanceof Error ? err.message : String(err) });
      });
  }

  #beat(): void {
    if (this.#startedAt !== undefined) this.#send(`running ${formatElapsed(this.#now() - this.#startedAt)}`);
    else if (this.#queuedAt !== undefined) this.#send(`queued ${formatElapsed(this.#now() - this.#queuedAt)}`);
  }

  #ensureHeartbeat(): void {
    if (!this.#timer && !this.#finished) {
      this.#timer = setInterval(() => this.#beat(), this.#heartbeatMs);
      this.#timer.unref();
    }
  }
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
