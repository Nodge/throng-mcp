import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { statSync } from 'node:fs';
import { Collector } from './acp/collector.ts';
import type { Worker, WorkerHooks } from './acp/types.ts';
import { startWorker } from './acp/worker.ts';
import { type AgentSpec, parseAgentSpec } from './agent-spec.ts';
import type { LoadedConfig } from './config.ts';
import { HARNESS_IDS, type HarnessId, type ResumeThrongletInput, type RunFailure, type RunSuccess, type RunThrongletInput } from './contract.ts';
import { type ErrorCode, type FailureContext, ThrongError, toThrongError } from './errors.ts';
import { harnessById, loadRegistry } from './harnesses/index.ts';
import { selectEffort, selectModel } from './harnesses/select.ts';
import { log } from './log.ts';
import { createPermissionBridge, type PermissionBridge, resolvePolicy } from './permissions.ts';
import type { Progress } from './progress.ts';
import { buildPrompt } from './prompt.ts';
import type { Semaphore } from './semaphore.ts';
import { readSessionRecord, type SessionRecord, touchSessionRecord, writeSessionRecord } from './sessions.ts';
import { Transcript } from './transcript.ts';

// One run_thronglet / resume_thronglet call (DESIGN §3.2, §3.3, §4.2, §7):
// guards → semaphore → Worker → auto policy → model/effort → prompt → payload.

export interface RunContext {
  loaded: LoadedConfig;
  /** This server's depth (`THRONG_MCP_DEPTH`). */
  depth: number;
  semaphore: Semaphore;
  /** The MCP call's `extra.signal`: client cancel or transport close. */
  signal: AbortSignal;
  progress: Progress;
  /** Environment for the adapter PATH lookup; the server's own by default. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  cacheDir: string;
  /** How long a cancelled prompt may take to settle before the worker is closed; 5000 by default. */
  cancelGraceMs?: number;
  /** Passed to the Worker (stdin close → SIGTERM → SIGKILL steps); the Worker's default otherwise. */
  exitGraceMs?: number;
}

export type RunOutcome = { ok: true; payload: RunSuccess } | { ok: false; payload: RunFailure };

const DEFAULT_CANCEL_GRACE_MS = 5000;
/** setTimeout fires at once above this; a longer timeout_s is effectively "no timeout" anyway. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const QUEUE_WARNING_MS = 1000;
const STDERR_IN_TRANSCRIPT = 16 * 1024;

/** What to start: a new session from the agent spec, or an earlier one from its session record. */
type RunRequest = { kind: 'new'; spec: AgentSpec; cwd: string } | { kind: 'resume'; sessionId: string; record: SessionRecord };

/** A tool call as the shared pipeline sees it. */
interface Call {
  tool: 'run_thronglet' | 'resume_thronglet';
  prompt: string;
  schema: unknown;
  timeout_s: number | undefined;
  /** The transcript `input` line, written once the harness is known; never the prompt text. */
  inputLine: (harness: HarnessId) => Record<string, unknown>;
  logFields: Record<string, unknown>;
  /** Throws a ThrongError when there is nothing to start (bad agent spec, no session record). */
  request: () => Promise<RunRequest>;
}

/** Never throws: every failure is a `{ ok: false }` payload with an ErrorCode. */
export function runThronglet(input: RunThrongletInput, ctx: RunContext): Promise<RunOutcome> {
  return execute(
    {
      tool: 'run_thronglet',
      prompt: input.prompt,
      schema: input.schema,
      timeout_s: input.timeout_s,
      inputLine: () => ({
        agent: input.agent,
        cwd: input.cwd,
        prompt_chars: input.prompt.length,
        ...(input.timeout_s !== undefined ? { timeout_s: input.timeout_s } : {}),
        ...(input.schema !== undefined ? { schema: true } : {}),
      }),
      logFields: { agent: input.agent },
      request: async () => ({ kind: 'new', spec: parseAgentSpec(input.agent), cwd: input.cwd }),
    },
    ctx,
  );
}

/** DESIGN §3.3: harness, model, effort and cwd come from the session record. Never throws, like runThronglet. */
export function resumeThronglet(input: ResumeThrongletInput, ctx: RunContext): Promise<RunOutcome> {
  return execute(
    {
      tool: 'resume_thronglet',
      prompt: input.prompt,
      schema: input.schema,
      timeout_s: input.timeout_s,
      inputLine: (harness) => ({
        resume: true,
        session_id: input.session_id,
        harness,
        prompt_chars: input.prompt.length,
        ...(input.timeout_s !== undefined ? { timeout_s: input.timeout_s } : {}),
        ...(input.schema !== undefined ? { schema: true } : {}),
      }),
      logFields: { session_id: input.session_id },
      request: async () => ({ kind: 'resume', sessionId: input.session_id, record: await loadRecord(ctx.cacheDir, input.session_id) }),
    },
    ctx,
  );
}

/** Any record we can't use is `session_not_found`: missing, unsafe id, unreadable or corrupt file. */
async function loadRecord(dir: string, sessionId: string): Promise<SessionRecord> {
  const id = JSON.stringify(sessionId);
  let record: SessionRecord | undefined;
  try {
    record = await readSessionRecord(dir, sessionId);
  } catch (err) {
    throw new ThrongError('session_not_found', `session record for ${id} is unreadable: ${errorText(err)}`);
  }
  if (!record) throw new ThrongError('session_not_found', `no session record for ${id} (records live 14 days under ${dir}/sessions)`);
  if (!(HARNESS_IDS as readonly unknown[]).includes(record.harness) || typeof record.model !== 'string' || typeof record.cwd !== 'string') {
    throw new ThrongError('session_not_found', `session record for ${id} is corrupt: ${JSON.stringify(record)}`);
  }
  return record;
}

async function execute(call: Call, ctx: RunContext): Promise<RunOutcome> {
  const now = ctx.now ?? Date.now;
  const t0 = now();
  let waitedMs = 0;
  const durationS = () => Math.round((now() - t0 - waitedMs) / 100) / 10;

  const warnings: string[] = [];
  const collector = new Collector();
  const transcript = new Transcript(ctx.cacheDir, new Date(t0));
  let bridge: PermissionBridge | undefined;
  let sessionId: string | undefined;
  let worker: Worker | undefined;
  /** Mode requested by the permission policy; the agent may fall back to another one (claude: auto → acceptEdits). */
  let requestedMode: string | undefined;
  /** A worker whose handshake outlived a cancel/timeout: closed when it arrives, holding the slot until then. */
  let lingering: Promise<void> | undefined;
  let release: (() => void) | undefined;

  const allWarnings = () => [...new Set([...warnings, ...collector.warnings])];
  const context = (): FailureContext => {
    if (sessionId === undefined) return {};
    const out: FailureContext = { session_id: sessionId, usage: collector.usage };
    if (collector.text) out.text = collector.text;
    return out;
  };

  const stop = new AbortController();
  const halt = (code: ErrorCode, message: string) => {
    if (!stop.signal.aborted) stop.abort(new ThrongError(code, message));
  };
  const onClientAbort = () => halt('cancelled', 'cancelled by the client');
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => stop.signal.addEventListener('abort', () => reject(stop.signal.reason)));
  stopped.catch(() => {});
  /** `p`, unless the call is cancelled or times out first. */
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped]);

  const run = async (): Promise<RunSuccess> => {
    const request = await call.request();
    const target =
      request.kind === 'new'
        ? { harness: request.spec.harness, model: request.spec.model, effort: request.spec.effort, cwd: request.cwd }
        : request.record;
    transcript.harness = target.harness;
    transcript.write('input', call.inputLine(target.harness));
    if (call.schema !== undefined) warnings.push('schema is not supported yet (v2); ignored');

    // Guards, all before spawn.
    const { loaded } = ctx;
    // A broken config might have meant a stricter policy: never run on the defaults.
    if (loaded.error) throw new ThrongError('harness_unavailable', `config error: ${loaded.error}`);
    const { config } = loaded;
    const policy = resolvePolicy(config, target.harness);
    if (policy !== 'auto') {
      throw new ThrongError('harness_unavailable', `permissions "${policy}" is not supported yet (v2); set permissions: auto`);
    }
    const permissions = createPermissionBridge(policy, (decision) => transcript.write('permission', { ...decision }));
    bridge = permissions;
    const maxDepth = config.limits.max_depth;
    if (ctx.depth + 1 > maxDepth) {
      throw new ThrongError(
        'depth_exceeded',
        `nested run would be at depth ${ctx.depth + 1}, max_depth is ${maxDepth} (this server runs at depth ${ctx.depth})`,
      );
    }
    const def = harnessById(target.harness);
    const resolution = def.resolve(config, loadRegistry(), ctx.env);
    if (!resolution.available) throw new ThrongError('harness_unavailable', resolution.reason);
    // spawn would fail with ENOENT anyway; checking first gives a message that names the cause.
    if (!isDirectory(target.cwd)) {
      const what = request.kind === 'resume' ? "the session record's cwd" : 'cwd';
      throw new ThrongError('spawn_failed', `${what} does not exist or is not a directory: ${target.cwd}`);
    }

    // Queue wait counts neither toward timeout_s nor toward duration_s (DESIGN §7).
    const queuedAt = now();
    const acquiring = ctx.semaphore.acquire(ctx.signal);
    if (ctx.semaphore.waiting > 0 && !ctx.signal.aborted) ctx.progress.queued(ctx.semaphore.waiting);
    try {
      release = await acquiring;
    } finally {
      waitedMs = now() - queuedAt;
    }
    if (waitedMs > QUEUE_WARNING_MS) warnings.push(`queued ${(waitedMs / 1000).toFixed(1)} s`);

    if (ctx.signal.aborted) onClientAbort();
    else ctx.signal.addEventListener('abort', onClientAbort, { once: true });
    if (stop.signal.aborted) throw stop.signal.reason;
    const timeoutS = call.timeout_s ?? config.limits.timeout_s;
    timer = setTimeout(() => halt('timeout', `timed out after ${timeoutS} s`), Math.min(timeoutS * 1000, MAX_TIMER_MS));
    ctx.progress.started();

    const setup = def.permissionSetup(policy);
    const { launch } = resolution;
    const hooks: WorkerHooks = {
      onUpdate: (notification) => onUpdate(notification),
      onPermission: (request) => permissions.answer(request),
      onWarning: (text) => {
        if (!warnings.includes(text)) warnings.push(text);
      },
    };
    const starting = startWorker(
      { command: launch.command, args: launch.args, env: { ...launch.env, ...setup.env }, cwd: target.cwd, depth: ctx.depth },
      request.kind === 'new'
        ? { kind: 'new', cwd: target.cwd, mcpServers: [], ...(setup.newSessionMeta ? { meta: setup.newSessionMeta } : {}) }
        : { kind: 'resume', sessionId: request.sessionId, cwd: target.cwd, mcpServers: [] },
      hooks,
      { handshakeMs: config.limits.handshake_s * 1000, ...(ctx.exitGraceMs !== undefined ? { exitGraceMs: ctx.exitGraceMs } : {}) },
    );
    try {
      worker = await guard(starting);
    } catch (err) {
      if (stop.signal.aborted && err === stop.signal.reason) {
        lingering = starting.then(
          (late) => late.close(),
          () => {},
        );
      }
      throw err;
    }

    sessionId = worker.session.sessionId;
    transcript.open(sessionId);
    if (request.kind === 'new') {
      const createdAt = new Date(now()).toISOString();
      await writeSessionRecord(ctx.cacheDir, sessionId, {
        harness: target.harness,
        model: target.model,
        ...(target.effort ? { effort: target.effort } : {}),
        cwd: target.cwd,
        created_at: createdAt,
        last_used_at: createdAt,
      }).catch((err: unknown) => {
        log.warn('session record not written', { session: sessionId, error: errorText(err) });
        warnings.push(`session record not written (${errorText(err)}); resume_thronglet will not find this session`);
      });
    }

    // A fresh adapter process starts in its defaults, so a resumed session gets mode, model and effort again (§3.3).
    // The mode is the policy's teeth: failing to set it fails the run. Model before effort: effort values may depend on it.
    if (setup.modeId) {
      requestedMode = setup.modeId;
      await guard(worker.setMode(setup.modeId));
    }
    await guard(selectModel(worker, target.model));
    if (target.effort) {
      const warning = await guard(selectEffort(def, worker, target.effort));
      if (warning) warnings.push(warning);
    }

    collector.startTurn();
    const prompting = worker.prompt(buildPrompt(call.prompt));
    prompting.catch(() => {});
    let response: PromptResponse;
    try {
      response = await guard(prompting);
    } catch (err) {
      if (stop.signal.aborted && err === stop.signal.reason) await cancelTurn(worker, prompting);
      throw err;
    }
    collector.endTurn(response);
    transcript.write('stop', { response });
    return finish(response);
  };

  const onUpdate = (notification: SessionNotification) => {
    transcript.write('update', { update: notification.update });
    collector.handle(notification);
    const { update } = notification;
    if (update.sessionUpdate === 'tool_call') ctx.progress.tool(update.title);
    else if (update.sessionUpdate === 'agent_message_chunk') ctx.progress.text(collector.text.length);
    else if (update.sessionUpdate === 'current_mode_update' && requestedMode && update.currentModeId !== requestedMode) {
      const warning = `permission mode "${requestedMode}" not applied: the agent switched to "${update.currentModeId}"`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  };

  /** DESIGN §4.2 cancel path; closing the worker is left to the cleanup. */
  const cancelTurn = async (w: Worker, prompting: Promise<PromptResponse>) => {
    bridge?.cancelAll();
    await w.cancel().catch(() => {});
    const grace = ctx.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    let graceTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      prompting.then((r) => r, () => undefined),
      new Promise<undefined>((resolve) => (graceTimer = setTimeout(() => resolve(undefined), grace))),
    ]);
    clearTimeout(graceTimer);
    // Usage of the cancelled turn still counts.
    if (settled) {
      collector.endTurn(settled);
      transcript.write('stop', { response: settled });
    }
  };

  const finish = (response: PromptResponse): RunSuccess => {
    const text = collector.text;
    switch (response.stopReason) {
      case 'end_turn':
        if (!text) throw new ThrongError('empty_result', 'agent ended the turn without a message');
        break;
      case 'max_tokens':
      case 'max_turn_requests':
        break;
      case 'refusal':
        throw new ThrongError('refusal', 'agent refused the task (stop_reason refusal)');
      case 'cancelled':
        throw new ThrongError('cancelled', 'agent cancelled the turn itself (stop_reason cancelled)');
      default:
        throw new ThrongError('agent_error', `unknown stop_reason ${JSON.stringify(response.stopReason)}`);
    }
    const payload: RunSuccess = {
      session_id: sessionId!,
      text,
      stop_reason: response.stopReason,
      usage: collector.usage,
      duration_s: durationS(),
    };
    const all = allWarnings();
    if (all.length) payload.warnings = all;
    return payload;
  };

  const failure = (err: unknown): RunFailure => {
    const e = toThrongError(err, context());
    const payload: RunFailure = { code: e.code, message: e.message, duration_s: durationS() };
    if (e.context.session_id !== undefined) payload.session_id = e.context.session_id;
    if (e.context.text) payload.text = e.context.text;
    if (e.context.usage !== undefined) payload.usage = e.context.usage;
    const all = [...new Set([...(e.context.warnings ?? []), ...allWarnings()])];
    if (all.length) payload.warnings = all;
    return payload;
  };

  let outcome: RunOutcome;
  try {
    outcome = { ok: true, payload: await run() };
  } catch (err) {
    outcome = { ok: false, payload: failure(err) };
  }

  // Cleanup runs even after a client cancel: the SDK drops our answer, but the process must not leak.
  try {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onClientAbort);
    ctx.progress.done();
    bridge?.cancelAll();
    if (worker) {
      await worker.close();
      // After close: whatever the adapter printed while shutting down is in the tail too.
      const tail = worker.stderrTail().slice(-STDERR_IN_TRANSCRIPT);
      if (tail) transcript.write('stderr', { tail });
    }
    if (lingering) {
      const held = release;
      void lingering.finally(() => held?.());
    } else {
      release?.();
    }
    if (sessionId !== undefined) {
      await touchSessionRecord(ctx.cacheDir, sessionId, new Date(now())).catch((err: unknown) =>
        log.warn('session record not updated', { session: sessionId, error: errorText(err) }),
      );
    }
    const { text: _text, ...rest } = outcome.payload;
    transcript.write('outcome', { ok: outcome.ok, ...rest, ...(_text !== undefined ? { text_chars: _text.length } : {}) });
    await transcript.close();
  } catch (err) {
    log.error('run cleanup failed', { error: errorText(err) });
  }
  log.info(`${call.tool} done`, {
    ...call.logFields,
    code: outcome.ok ? 'ok' : outcome.payload.code,
    session: sessionId,
    duration_s: outcome.payload.duration_s,
  });
  return outcome;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
