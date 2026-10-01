import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { statSync } from 'node:fs';
import { Collector } from './acp/collector.ts';
import type { WorkerHooks } from './acp/types.ts';
import { startWorker } from './acp/worker.ts';
import type { AgentSpec } from './agent-spec.ts';
import type { LoadedConfig } from './config.ts';
import { type FailureContext, type RunFailure, type RunSuccess, ThrongError, toThrongError } from './contract.ts';
import { harnessById, loadRegistry } from './harnesses/index.ts';
import { selectEffort, selectModel } from './harnesses/select.ts';
import { RunLifecycle } from './lifecycle.ts';
import { log } from './log.ts';
import { createPermissionBridge, type PermissionBridge, resolvePolicy } from './permissions.ts';
import type { Progress } from './progress.ts';
import { buildPrompt } from './prompt.ts';
import type { Semaphore } from './semaphore.ts';
import { type SessionRecord, touchSessionRecord, writeSessionRecord } from './sessions.ts';

// The pipeline shared by run_thronglet and resume_thronglet (DESIGN §3.2, §3.3, §4.2, §7):
// guards → semaphore → Worker → auto policy → model/effort → prompt → payload. The adapter's lifetime is in lifecycle.ts.

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
const QUEUE_WARNING_MS = 1000;

/** What to start: a new session from the agent spec, or an earlier one from its session record. */
export type RunRequest = { kind: 'new'; spec: AgentSpec; cwd: string } | { kind: 'resume'; sessionId: string; record: SessionRecord };

/** A tool call as the shared pipeline sees it; built by the tool (src/mcp/tools/). */
export interface Call {
  /** Tool name, for the log. */
  tool: string;
  prompt: string;
  schema: unknown;
  timeout_s: number | undefined;
  logFields: Record<string, unknown>;
  /** Throws a ThrongError when there is nothing to start (bad agent spec, no session record). */
  request: () => Promise<RunRequest>;
}

/** Runs one run_thronglet / resume_thronglet call. Never throws: every failure is a `{ ok: false }` payload with an ErrorCode. */
export async function runCall(call: Call, ctx: RunContext): Promise<RunOutcome> {
  const now = ctx.now ?? Date.now;
  const t0 = now();
  let waitedMs = 0;
  const durationS = () => Math.round((now() - t0 - waitedMs) / 100) / 10;

  const warnings: string[] = [];
  const collector = new Collector();
  const lifecycle = new RunLifecycle(ctx.signal);
  let bridge: PermissionBridge | undefined;
  let sessionId: string | undefined;
  /** Mode requested by the permission policy; the agent may fall back to another one (claude: auto → acceptEdits). */
  let requestedMode: string | undefined;

  const warn = (text: string) => {
    if (!warnings.includes(text)) warnings.push(text);
  };
  const allWarnings = () => [...new Set([...warnings, ...collector.warnings])];
  const context = (): FailureContext => {
    if (sessionId === undefined) return {};
    const out: FailureContext = { session_id: sessionId, usage: collector.usage };
    if (collector.text) out.text = collector.text;
    return out;
  };

  const onUpdate = (notification: SessionNotification) => {
    collector.handle(notification);
    const { update } = notification;
    if (update.sessionUpdate === 'tool_call') ctx.progress.tool(update.title);
    else if (update.sessionUpdate === 'agent_message_chunk') ctx.progress.text(collector.text.length);
    else if (update.sessionUpdate === 'current_mode_update' && requestedMode && update.currentModeId !== requestedMode) {
      warn(`permission mode "${requestedMode}" not applied: the agent switched to "${update.currentModeId}"`);
    }
  };

  const run = async (): Promise<RunSuccess> => {
    const request = await call.request();
    const target =
      request.kind === 'new'
        ? { harness: request.spec.harness, model: request.spec.model, effort: request.spec.effort, cwd: request.cwd }
        : request.record;
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
    const permissions = createPermissionBridge(policy, (decision) => log.info('permission', { tool: call.tool, session: sessionId, ...decision }));
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
    try {
      await lifecycle.acquire(ctx.semaphore, (waiting) => ctx.progress.queued(waiting));
    } finally {
      waitedMs = now() - queuedAt;
    }
    if (waitedMs > QUEUE_WARNING_MS) warnings.push(`queued ${(waitedMs / 1000).toFixed(1)} s`);
    lifecycle.arm(call.timeout_s ?? config.limits.timeout_s);
    ctx.progress.started();

    const setup = def.permissionSetup(policy);
    const { launch } = resolution;
    const hooks: WorkerHooks = {
      onUpdate,
      onPermission: (request) => permissions.answer(request),
      onWarning: warn,
    };
    const worker = await lifecycle.start(
      startWorker(
        { command: launch.command, args: launch.args, env: { ...launch.env, ...setup.env }, cwd: target.cwd, depth: ctx.depth },
        request.kind === 'new'
          ? { kind: 'new', cwd: target.cwd, mcpServers: [], ...(setup.newSessionMeta ? { meta: setup.newSessionMeta } : {}) }
          : { kind: 'resume', sessionId: request.sessionId, cwd: target.cwd, mcpServers: [] },
        hooks,
        { handshakeMs: config.limits.handshake_s * 1000, ...(ctx.exitGraceMs !== undefined ? { exitGraceMs: ctx.exitGraceMs } : {}) },
      ),
    );

    sessionId = worker.session.sessionId;
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
      await lifecycle.guard(worker.setMode(setup.modeId));
    }
    await lifecycle.guard(selectModel(worker, target.model));
    if (target.effort) {
      const warning = await lifecycle.guard(selectEffort(def, worker, target.effort));
      if (warning) warnings.push(warning);
    }

    collector.startTurn();
    const response = await lifecycle.turn(worker.prompt(buildPrompt(call.prompt)), ctx.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, {
      onCancel: () => bridge?.cancelAll(),
      onLateStop: (late) => collector.endTurn(late),
    });
    collector.endTurn(response);
    return finish(response, sessionId);
  };

  const finish = (response: PromptResponse, id: string): RunSuccess => {
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
      session_id: id,
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

  try {
    ctx.progress.done();
    bridge?.cancelAll();
    await lifecycle.close();
    if (sessionId !== undefined) {
      await touchSessionRecord(ctx.cacheDir, sessionId, new Date(now())).catch((err: unknown) =>
        log.warn('session record not updated', { session: sessionId, error: errorText(err) }),
      );
    }
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
