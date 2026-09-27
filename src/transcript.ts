import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.ts';
import { isSafeName } from './sessions.ts';

// Per-call JSONL transcript under <cacheDir>/runs (DESIGN §8). Debugging aid only: never returned to the caller.

/**
 * The file name carries the session id, known only after the handshake: lines are buffered until `open()`
 * (or `close()` without a session → `nosession`), then appended as they come.
 */
export class Transcript {
  /** Goes into the file name; set once the agent spec is parsed. */
  harness = 'unknown';
  readonly #dir: string;
  readonly #startedAt: Date;
  #buffer: string[] = [];
  #stream: WriteStream | undefined;
  #path: string | undefined;
  #broken = false;

  constructor(cacheDir: string, startedAt: Date) {
    this.#dir = join(cacheDir, 'runs');
    this.#startedAt = startedAt;
  }

  get path(): string | undefined {
    return this.#path;
  }

  write(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.#broken) return;
    let line: string;
    try {
      line = `${JSON.stringify({ ts: new Date().toISOString(), kind, ...fields })}\n`;
    } catch (err) {
      line = `${JSON.stringify({ ts: new Date().toISOString(), kind, unserializable: String(err) })}\n`;
    }
    if (this.#stream) this.#stream.write(line);
    else if (!this.#path) this.#buffer.push(line);
  }

  /** Picks the file name, flushes the buffer, logs the path. Later calls are no-ops. */
  open(sessionId?: string): void {
    if (this.#path || this.#broken) return;
    const ts = this.#startedAt.toISOString().replaceAll(':', '-');
    // The session id makes the name unique; without one, a random suffix keeps concurrent calls in separate files.
    const id =
      sessionId !== undefined && isSafeName(sessionId) ? sessionId : `nosession-${randomBytes(4).toString('hex')}`;
    const path = join(this.#dir, `${ts}-${safe(this.harness)}-${id}.jsonl`);
    this.#path = path;
    try {
      mkdirSync(this.#dir, { recursive: true });
      const stream = createWriteStream(path, { flags: 'wx' });
      stream.on('error', (err) => this.#fail(err));
      this.#stream = stream;
    } catch (err) {
      this.#fail(err);
      return;
    }
    for (const line of this.#buffer) this.#stream.write(line);
    this.#buffer = [];
    log.info('run transcript', { path });
  }

  async close(): Promise<void> {
    this.open();
    const stream = this.#stream;
    this.#stream = undefined;
    if (!stream || this.#broken) return;
    // 'close' follows both a clean finish and a destroy on error.
    await new Promise<void>((resolve) => {
      stream.once('close', resolve);
      stream.end();
    });
  }

  #fail(err: unknown): void {
    if (this.#broken) return;
    this.#broken = true;
    this.#buffer = [];
    this.#stream?.destroy();
    this.#stream = undefined;
    log.warn('transcript write failed', { path: this.#path, error: err instanceof Error ? err.message : String(err) });
  }
}

function safe(name: string): string {
  return isSafeName(name) ? name : 'unknown';
}
