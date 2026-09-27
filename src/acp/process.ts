import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// Child process ownership for the adapter (DESIGN §4.2 steps 1 and 7). No ACP here.

const STDERR_CAP = 64 * 1024;

const execFileAsync = promisify(execFile);

export interface AdapterSpawnOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface AdapterProcess {
  child: ChildProcess;
  /** Last ≤64 KB of the child's stderr. */
  stderrTail(): string;
}

/**
 * Spawns the adapter as the leader of its own process group, stderr into a 64 KB ring buffer.
 * A failed spawn (ENOENT, EACCES, bad cwd) arrives as the child's `error` event; the caller listens for it.
 */
export function spawnAdapter(options: AdapterSpawnOptions): AdapterProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  // EPIPE after the child died must not crash the server; the ACP layer notices the closed stream itself.
  child.stdin?.on('error', () => {});

  let tail = Buffer.alloc(0);
  child.stderr?.on('data', (chunk: Buffer) => {
    const joined = Buffer.concat([tail, chunk]);
    tail = joined.length > STDERR_CAP ? Buffer.from(joined.subarray(joined.length - STDERR_CAP)) : joined;
  });

  return { child, stderrTail: () => tail.toString('utf8') };
}

async function childrenOf(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)]);
    return stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits 1 when nothing matches; any other failure also means "don't know".
    return [];
  }
}

/** All descendants of `pid` (recursive `pgrep -P`), taken before close so re-parented grandchildren can still be found. */
export async function snapshotDescendants(pid: number): Promise<number[]> {
  const seen = new Set<number>();
  let frontier = [pid];
  while (frontier.length > 0) {
    const next = (await Promise.all(frontier.map(childrenOf))).flat().filter((p) => !seen.has(p));
    for (const p of next) seen.add(p);
    frontier = next;
  }
  return [...seen];
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child has exited, false after `ms`. */
function exitWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(hasExited(child));
    }, ms);
    child.once('exit', onExit);
  });
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // ESRCH: already gone; EPERM: not ours (pid reused) — nothing to do either way.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const kills = new WeakMap<ChildProcess, Promise<void>>();

/**
 * DESIGN §4.2 step 7: close stdin and give the adapter `graceMs` to exit, then SIGTERM its
 * group, `graceMs` more, then SIGKILL. The group gets a final SIGKILL even when the leader
 * exited on its own (its children may still sit in the group), and so does every snapshot pid
 * still alive. Idempotent: repeated calls share one run.
 */
export function killTree(child: ChildProcess, snapshot: number[], graceMs: number): Promise<void> {
  let run = kills.get(child);
  if (!run) {
    run = doKillTree(child, snapshot, graceMs);
    kills.set(child, run);
  }
  return run;
}

async function doKillTree(child: ChildProcess, snapshot: number[], graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (!hasExited(child)) {
    child.stdin?.end();
    if (!(await exitWithin(child, graceMs))) {
      signal(-pid, 'SIGTERM');
      if (!(await exitWithin(child, graceMs))) {
        signal(-pid, 'SIGKILL');
        await exitWithin(child, graceMs);
      }
    }
  }

  signal(-pid, 'SIGKILL');
  for (const p of snapshot) {
    if (isAlive(p)) signal(p, 'SIGKILL');
  }
}
