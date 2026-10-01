import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Effort, HarnessId } from './contract.ts';
import { log } from './log.ts';

// Session records under <cacheDir>/sessions (DESIGN §8), keyed by the harness's own ACP session id.

export interface SessionRecord {
  harness: HarnessId;
  model: string;
  effort?: Effort;
  cwd: string;
  created_at: string;
  last_used_at: string;
}

/** `THRONG_MCP_CACHE_DIR` or `~/.cache/throng`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty variable means unset
  return env.THRONG_MCP_CACHE_DIR || join(homedir(), '.cache', 'throng');
}

/** A session id becomes a file name: anything that could leave the directory is refused. */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function recordPath(dir: string, sessionId: string): string {
  if (!isSafeName(sessionId)) throw new Error(`session id ${JSON.stringify(sessionId)} is not usable as a file name`);
  return join(dir, 'sessions', `${sessionId}.json`);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => { /* ignored */ });
    throw err;
  }
}

export async function writeSessionRecord(dir: string, sessionId: string, record: SessionRecord): Promise<void> {
  const path = recordPath(dir, sessionId);
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** `undefined` when there is no such record. */
export async function readSessionRecord(dir: string, sessionId: string): Promise<SessionRecord | undefined> {
  if (!isSafeName(sessionId)) return undefined;
  try {
    return JSON.parse(await readFile(recordPath(dir, sessionId), 'utf8')) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Sets `last_used_at`; a missing record stays missing. */
export async function touchSessionRecord(dir: string, sessionId: string, at: Date = new Date()): Promise<void> {
  const record = await readSessionRecord(dir, sessionId);
  if (!record) return;
  await writeAtomic(recordPath(dir, sessionId), `${JSON.stringify({ ...record, last_used_at: at.toISOString() }, null, 2)}\n`);
}

/** Deletes session records older than `maxAgeDays` by mtime. Never throws. */
export async function rotate(dir: string, maxAgeDays = 14, now: number = Date.now()): Promise<void> {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const base = join(dir, 'sessions');
  let names: string[];
  try {
    names = await readdir(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('rotate: cannot list', { dir: base, error: String(err) });
    return;
  }
  for (const name of names) {
    const path = join(base, name);
    try {
      const info = await stat(path);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
    } catch (err) {
      log.warn('rotate: cannot remove', { path, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
