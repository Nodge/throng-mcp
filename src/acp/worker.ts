import * as acp from '@agentclientprotocol/sdk';
import type { ClientConnection, InitializeResponse, PromptResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { type ErrorCode, ThrongError } from '../contract.ts';
import { type AdapterProcess, killTree, snapshotDescendants, spawnAdapter } from './process.ts';
import type { SessionStart, StartWorker, Worker, WorkerHooks, WorkerLimits, WorkerSession, WorkerSpawn } from './types.ts';

// ACP client over one adapter process (DESIGN §4.2). Knows nothing about MCP.

/** How much of the stderr tail goes into error messages; the full 64 KB stays behind `stderrTail()`. */
const STDERR_IN_MESSAGE = 2048;
const DEFAULT_EXIT_GRACE_MS = 5000;
/**
 * How long to wait for the child's stdio to drain after it exited, and for its exit status after
 * the stream broke. Bounded because a descendant may keep the adapter's stdout open forever.
 */
const EXIT_SETTLE_MS = 1000;

/** Client methods we don't advertise (DESIGN §4.2): answered "method not found" plus one warning. */
const UNADVERTISED_METHODS = [
  acp.methods.client.fs.readTextFile,
  acp.methods.client.fs.writeTextFile,
  acp.methods.client.terminal.create,
  acp.methods.client.terminal.output,
  acp.methods.client.terminal.release,
  acp.methods.client.terminal.waitForExit,
  acp.methods.client.terminal.kill,
] as const;

type HandshakeStep = 'initialize' | 'session/new' | 'session/resume';

/** Workers from spawn until their close() finishes, handshake included. */
const live = new Set<AcpWorker>();
let shuttingDown = false;

/**
 * Server shutdown (DESIGN §4.2): step 7 for every live worker. Workers requested afterwards
 * are refused with `cancelled`, so a call racing the shutdown can't spawn past it.
 */
export async function closeAllWorkers(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...live].map((worker) => worker.close()));
}

export const startWorker: StartWorker = async (spawn, start, hooks, limits) => {
  if (shuttingDown) throw new ThrongError('cancelled', `server is shutting down; not starting ${spawn.command}`);
  let worker: AcpWorker;
  try {
    worker = new AcpWorker(spawn, hooks, limits);
  } catch (err) {
    // child_process.spawn rejects some inputs synchronously (NUL bytes in args/env, bad types); no child exists then.
    const message = err instanceof Error ? err.message : String(err);
    throw new ThrongError('spawn_failed', `cannot start adapter ${spawn.command}: ${message}`);
  }
  await worker.handshake(start);
  return worker;
};

class AcpWorker implements Worker {
  readonly pid: number;
  #session: WorkerSession | undefined;
  /** Our session's id: from the session/new response, or the id sent in session/resume. */
  #sessionId: string | undefined;
  readonly #process: AdapterProcess;
  readonly #connection: ClientConnection;
  readonly #hooks: WorkerHooks;
  readonly #limits: WorkerLimits;
  #spawnError: NodeJS.ErrnoException | undefined;
  /** Resolves once the child is gone: its stdio closed, or EXIT_SETTLE_MS after it exited. */
  readonly #gone: Promise<void>;
  #warned = false;
  #closing: Promise<void> | undefined;

  constructor(spawn: WorkerSpawn, hooks: WorkerHooks, limits: WorkerLimits) {
    this.#hooks = hooks;
    this.#limits = limits;
    this.#process = spawnAdapter({
      command: spawn.command,
      args: spawn.args,
      cwd: spawn.cwd,
      env: { ...process.env, ...spawn.env, THRONG_MCP_DEPTH: String(spawn.depth + 1) },
    });
    this.#child.on('error', (err: NodeJS.ErrnoException) => {
      this.#spawnError ??= err;
    });
    let markGone!: () => void;
    this.#gone = new Promise((resolve) => (markGone = resolve));
    this.#child.once('close', markGone);
    this.#child.once('exit', () => {
      // stdout still open after the adapter exited: a descendant inherited it and EOF may never come,
      // so the connection is closed by hand. On a normal close the stream sees EOF itself, after
      // draining the lines still buffered — closing it here would drop them.
      const timer = setTimeout(() => {
        markGone();
        this.#connection.close(new Error(`adapter exited but its stdout stayed open (${this.#exitStatus()})`));
      }, EXIT_SETTLE_MS);
      void this.#gone.then(() => clearTimeout(timer));
    });
    this.pid = this.#child.pid ?? -1;

    let app = acp
      .client({ name: 'throng' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.#hooks.onPermission(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => {
        // Before session/new answers, the id is unknown; one process runs one session, so the update is ours.
        if (this.#sessionId === undefined || ctx.params.sessionId === this.#sessionId) this.#hooks.onUpdate?.(ctx.params);
      });
    for (const method of UNADVERTISED_METHODS) {
      app = app.onRequest(method, () => {
        if (!this.#warned) {
          this.#warned = true;
          this.#hooks.onWarning?.(`adapter called ${method}, which throng does not advertise; answered "method not found"`);
        }
        throw acp.RequestError.methodNotFound(method);
      });
    }
    const { stdin, stdout } = this.#child;
    if (!stdin || !stdout) throw new Error('adapter stdio pipes were not created');
    const stream = acp.ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    );
    this.#connection = app.connect(stream);
    live.add(this);
  }

  get #child(): ChildProcess {
    return this.#process.child;
  }

  get session(): WorkerSession {
    if (!this.#session) throw new Error('worker session is not established');
    return this.#session;
  }

  stderrTail(): string {
    return this.#process.stderrTail();
  }

  /** Steps 1–3 of DESIGN §4.2 under one `handshakeMs` timer; any failure kills the tree before rejecting. */
  async handshake(start: SessionStart): Promise<void> {
    let step: HandshakeStep = 'initialize';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(this.#error('handshake_timeout', `adapter did not answer ${step} within ${this.#limits.handshakeMs} ms`)),
        this.#limits.handshakeMs,
      );
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      this.#child.once('error', (err: NodeJS.ErrnoException) => reject(this.#spawnFailed(err)));
    });

    const run = async (): Promise<void> => {
      const agent = this.#connection.agent;
      const init = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw this.#error(
          'handshake_failed',
          `adapter speaks ACP protocol v${init.protocolVersion}, throng speaks v${acp.PROTOCOL_VERSION}`,
        );
      }

      if (start.kind === 'new') {
        step = 'session/new';
        const created = await agent.request(acp.methods.agent.session.new, {
          cwd: start.cwd,
          mcpServers: start.mcpServers,
          ...(start.meta ? { _meta: start.meta } : {}),
        });
        this.#sessionId = created.sessionId;
        this.#session = buildSession(created.sessionId, init, created);
      } else {
        if (init.agentCapabilities?.sessionCapabilities?.resume == null) {
          throw this.#error('session_not_found', `adapter does not support session/resume; cannot resume ${start.sessionId}`);
        }
        step = 'session/resume';
        this.#sessionId = start.sessionId;
        const resumed = await agent.request(acp.methods.agent.session.resume, {
          sessionId: start.sessionId,
          cwd: start.cwd,
          mcpServers: start.mcpServers,
        });
        this.#session = buildSession(start.sessionId, init, resumed);
      }
    };

    const running = run();
    running.catch(() => { /* ignored */ });
    timeout.catch(() => { /* ignored */ });
    spawnFailed.catch(() => { /* ignored */ });
    try {
      await Promise.race([running, timeout, spawnFailed]);
    } catch (err) {
      const failure = err instanceof ThrongError ? err : await this.#handshakeError(step, start, err);
      await this.close();
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  async #handshakeError(step: HandshakeStep, start: SessionStart, err: unknown): Promise<ThrongError> {
    if (this.#isTransportError(err)) {
      await this.#settleExit();
      if (this.#spawnError) return this.#spawnFailed(this.#spawnError);
      const cause = `adapter exited before answering ${step} (${this.#exitStatus()})`;
      return this.#error(step === 'initialize' ? 'spawn_failed' : 'handshake_failed', cause);
    }
    const detail = describeRpcError(err);
    if (step === 'session/resume' && start.kind === 'resume') {
      return this.#error('session_not_found', `session/resume ${start.sessionId} failed: ${detail}`);
    }
    return this.#error('handshake_failed', `${step} failed: ${detail}`);
  }

  async setMode(modeId: string): Promise<void> {
    await this.#call(acp.methods.agent.session.setMode, () =>
      this.#connection.agent.request(acp.methods.agent.session.setMode, { sessionId: this.session.sessionId, modeId }),
    );
  }

  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    const response = await this.#call(acp.methods.agent.session.setConfigOption, () =>
      this.#connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.session.sessionId,
        configId,
        value,
      }),
    );
    if (this.#session) this.#session.configOptions = response.configOptions;
    return response.configOptions;
  }

  async prompt(text: string): Promise<PromptResponse> {
    const response = await this.#call(acp.methods.agent.session.prompt, () =>
      this.#connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.session.sessionId,
        prompt: [{ type: 'text', text }],
      }),
    );
    // The SDK dispatches notifications a few microtasks later than responses; one macrotask
    // lets updates that arrived before the response reach `onUpdate` before the caller sees the stop.
    await new Promise((resolve) => setImmediate(resolve));
    return response;
  }

  async cancel(): Promise<void> {
    await this.#call(acp.methods.agent.session.cancel, () =>
      this.#connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId }),
    );
  }

  close(): Promise<void> {
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    try {
      const snapshot = this.#child.pid === undefined ? [] : await snapshotDescendants(this.#child.pid);
      await killTree(this.#child, snapshot, this.#limits.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
    } catch {
      // close never throws; killTree already swallows signal errors.
    }
    live.delete(this);
    this.#connection.close(new Error('worker closed'));
  }

  /** One request after the handshake: agent errors → `agent_error`, a broken stream or closed worker → `transport_lost`. */
  async #call<T>(method: string, send: () => Promise<T>): Promise<T> {
    if (this.#closing) throw this.#error('transport_lost', `${method}: worker is closed`);
    try {
      return await send();
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may run during the await; TS keeps the narrowing from the check above
      if (this.#closing) throw this.#error('transport_lost', `${method}: worker is closed`);
      if (this.#isTransportError(err)) {
        await this.#settleExit();
        throw this.#error('transport_lost', `connection to the adapter lost during ${method} (${this.#exitStatus()})`);
      }
      throw this.#error('agent_error', `${method} failed: ${describeRpcError(err)}`);
    }
  }

  /** True when `err` is the connection's own close reason rather than an answer from the agent. */
  #isTransportError(err: unknown): boolean {
    const signal = this.#connection.signal;
    return signal.aborted && err === signal.reason;
  }

  /** Waits (bounded) for the child's exit status and last stderr bytes after the stream broke. */
  async #settleExit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#gone, new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_SETTLE_MS)))]);
    clearTimeout(timer);
  }

  #exitStatus(): string {
    const child = this.#child;
    if (child.exitCode !== null) return `exit code ${child.exitCode}`;
    if (child.signalCode !== null) return `killed by ${child.signalCode}`;
    return 'process still running';
  }

  #spawnFailed(err: NodeJS.ErrnoException): ThrongError {
    const code = err.code ? `${err.code}: ` : '';
    return this.#error('spawn_failed', `cannot start adapter ${this.#child.spawnfile}: ${code}${err.message}`);
  }

  #error(code: ErrorCode, cause: string): ThrongError {
    const tail = this.stderrTail().slice(-STDERR_IN_MESSAGE).trim();
    return new ThrongError(code, tail ? `${cause}; adapter stderr: ${tail}` : cause);
  }
}

function buildSession(
  sessionId: string,
  init: InitializeResponse,
  response: { modes?: WorkerSession['modes'] | null; configOptions?: SessionConfigOption[] | null },
): WorkerSession {
  const session: WorkerSession = { sessionId };
  if (init.agentInfo != null) session.agentInfo = init.agentInfo;
  if (init.agentCapabilities != null) session.agentCapabilities = init.agentCapabilities;
  if (response.modes != null) session.modes = response.modes;
  if (response.configOptions != null) session.configOptions = response.configOptions;
  return session;
}

function describeRpcError(err: unknown): string {
  if (err instanceof acp.RequestError) {
    const data = err.data === undefined ? '' : ` (data: ${JSON.stringify(err.data)})`;
    return `${err.message}${data}`;
  }
  return err instanceof Error ? err.message : String(err);
}
