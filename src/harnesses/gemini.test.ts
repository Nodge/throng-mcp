import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type FakeCall, readFakeCalls } from '../../test/fake-agent/index.ts';
import { fakeHarness, tagAlive } from '../../test/fake-harness.ts';
import type { PermissionPolicy } from '../config.ts';
import type { RunFailure, RunSuccess } from '../contract.ts';
import { listHarnesses } from '../list.ts';
import { log } from '../log.ts';
import { runThronglet } from '../mcp/tools/run-thronglet.ts';
import { sendMessage } from '../mcp/tools/send-message.ts';
import type { RunOutcome } from '../run.ts';
import { readSessionRecord } from '../sessions.ts';

// The gemini harness end to end on the fake agent's gemini scenarios (DESIGN §2.3, §4.1, §5).

const h = fakeHarness('throng-gemini-');
afterAll(() => h.cleanup());

const input = (agent: string) => ({ agent, prompt: 'do the thing', cwd: h.work, description: 'gemini test' });

/** Never asked in these scenarios; present so `elicit` runs at all. */
const elicitation = { ask: () => Promise.reject(new Error('unexpected elicitation')) };

function ok(outcome: RunOutcome): RunSuccess {
    expect(outcome.ok, `expected success, got ${JSON.stringify(outcome.payload)}`).toBe(true);
    return outcome.payload as RunSuccess;
}

function failed(outcome: RunOutcome, code: RunFailure['code']): RunFailure {
    expect(outcome.ok, `expected failure, got ${JSON.stringify(outcome.payload)}`).toBe(false);
    const payload = outcome.payload as RunFailure;
    expect(payload.code, payload.message).toBe(code);
    return payload;
}

/** A gemini run in `scenario` under `policy`, its FAKE_CALL_LOG lines and the fake's tag. */
async function geminiRun(
    agent: string,
    policy: PermissionPolicy,
    scenario: 'gemini' | 'gemini-permission' = 'gemini'
): Promise<{ outcome: RunOutcome; calls: FakeCall[]; tag: string }> {
    const callLog = join(mkdtempSync(join(h.root, 'calls-')), 'calls.jsonl');
    const { loaded, tag } = h.fakeAs('gemini', scenario, `permissions: ${policy}`, { FAKE_CALL_LOG: callLog });
    const outcome = await runThronglet(input(agent), h.makeCtx(loaded, { elicitation }));
    return { outcome, calls: readFakeCalls(callLog), tag };
}

/** `<event> <value>` per call; the start entry shows the trust env the agent saw. */
const summary = (calls: FakeCall[]) =>
    calls.map(c => {
        if (c.event === 'start') return `start trust=${c.trustWorkspace ?? '-'}`;
        if (c.event === 'set_mode') return `set_mode ${c.modeId}`;
        if (c.event === 'set_model') return `set_model ${c.modelId}`;
        if (c.event === 'set_config_option') return `set_config_option ${c.configId}`;
        return 'prompt';
    });

describe('gemini harness (fake agent)', () => {
    const modes: [PermissionPolicy, string][] = [
        ['auto', 'yolo'],
        ['allow_all', 'default'],
        ['deny_all', 'default'],
        ['elicit', 'default'],
    ];
    for (const [policy, mode] of modes) {
        it(`${policy} → mode ${mode}, workspace trusted`, async () => {
            const { outcome, calls } = await geminiRun('gemini/gemini-2.5-pro', policy);
            ok(outcome);
            expect(outcome.payload.warnings).toBe(undefined);
            expect(summary(calls)).toStrictEqual([
                'start trust=true',
                `set_mode ${mode}`,
                'set_model gemini-2.5-pro',
                'prompt',
            ]);
        });
    }

    it('a listed model is set before the prompt; the result has no usage numbers', async () => {
        const { outcome, calls, tag } = await geminiRun('gemini/gemini-2.5-flash', 'auto');
        const payload = ok(outcome);
        expect(payload.text ?? '').toMatch(/\[model=gemini-2\.5-flash effort=\?\]$/);
        expect(payload.stop_reason).toBe('end_turn');
        expect(payload.usage).toStrictEqual({});
        expect(payload.warnings).toBe(undefined);
        expect(summary(calls).slice(2)).toStrictEqual(['set_model gemini-2.5-flash', 'prompt']);
        expect(tagAlive(tag), 'adapter still running').toBe(false);
    });

    it('an unlisted model → model_rejected naming the listed ones, no prompt', async () => {
        const { outcome, calls } = await geminiRun('gemini/gemini-9', 'auto');
        const payload = failed(outcome, 'model_rejected');
        expect(payload.message).toBe(
            'model "gemini-9" is not available; valid models: gemini-2.5-pro, gemini-2.5-flash'
        );
        expect(summary(calls)).toStrictEqual(['start trust=true', 'set_mode yolo']);
    });

    it('an effort suffix is ignored with a warning; the turn completes', async () => {
        const { outcome } = await geminiRun('gemini/gemini-2.5-pro:high', 'auto');
        const payload = ok(outcome);
        expect(payload.stop_reason).toBe('end_turn');
        expect(payload.warnings).toStrictEqual(['effort "high" ignored: gemini exposes no effort option']);
    });

    it('permission requests: allow_all → allow_once, deny_all → reject_once', async () => {
        const info = vi.spyOn(log, 'info');
        try {
            const allowed = await geminiRun('gemini/gemini-2.5-pro', 'allow_all', 'gemini-permission');
            expect(ok(allowed.outcome).text).toBe('allowed');
            expect(info).toHaveBeenCalledWith(
                'permission',
                expect.objectContaining({ title: 'write notes.txt', choice: 'yes' })
            );
            info.mockClear();
            const denied = await geminiRun('gemini/gemini-2.5-pro', 'deny_all', 'gemini-permission');
            expect(ok(denied.outcome).text).toBe('rejected');
            expect(info).toHaveBeenCalledWith(
                'permission',
                expect.objectContaining({ title: 'write notes.txt', choice: 'no' })
            );
        } finally {
            info.mockRestore();
        }
    });

    it('a gemini session is recorded as not resumable; send_message is refused before a spawn', async () => {
        const callLog = join(mkdtempSync(join(h.root, 'calls-')), 'calls.jsonl');
        const { loaded } = h.fakeAs('gemini', 'gemini', '', { FAKE_CALL_LOG: callLog });
        const ctx = h.makeCtx(loaded);
        const first = ok(await runThronglet(input('gemini/gemini-2.5-pro'), ctx));
        const record = await readSessionRecord(ctx.cacheDir, first.session_id);
        expect(record?.resumable).toBe(false);
        const starts = () => readFakeCalls(callLog).filter(c => c.event === 'start').length;
        expect(starts()).toBe(1);

        const payload = failed(
            await sendMessage({ session_id: first.session_id, prompt: 'x' }, ctx),
            'session_not_found'
        );
        expect(payload.message).toBe(
            `session ${first.session_id} cannot take another message: the gemini harness has no session/resume, so its sessions are one turn`
        );
        expect(payload.session_id).toBe(undefined);
        expect(starts(), 'no adapter process for the refused message').toBe(1);
        expect(await readSessionRecord(ctx.cacheDir, first.session_id)).toStrictEqual(record);
    });

    it('send_message to a gemini session from an old record (no resumable) → session_not_found at the handshake', async () => {
        const { loaded, tag } = h.fakeAs('gemini', 'gemini');
        const ctx = h.makeCtx(loaded);
        await h.record(ctx.cacheDir, 'gemini-a', { harness: 'gemini', model: 'gemini-2.5-pro' });
        const payload = failed(await sendMessage({ session_id: 'gemini-a', prompt: 'x' }, ctx), 'session_not_found');
        expect(payload.message).toMatch(/does not support session\/resume/);
        expect(tagAlive(tag)).toBe(false);
    });

    it('list_harnesses: models from the models field, no efforts', async () => {
        const { loaded, tag } = h.fakeAs('gemini', 'gemini');
        const out = await listHarnesses(loaded, { handshakeMs: 5000, depth: 0, env: { PATH: join(h.root, 'bin') } });
        expect(out.harnesses).toHaveLength(1);
        expect(out.harnesses[0]).toMatchObject({
            harness: 'gemini',
            models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
            efforts: [],
            version: '0.0.1',
        });
        expect(out.unavailable.map(u => u.harness)).toStrictEqual(['claude', 'codex', 'opencode']);
        expect(tagAlive(tag), 'probed fake agent still running').toBe(false);
    });

    it('list_harnesses: gemini not on PATH → unavailable with the install hint', async () => {
        const { loaded } = h.fakeClaude('echo');
        const out = await listHarnesses(loaded, { handshakeMs: 5000, depth: 0, env: { PATH: join(h.root, 'bin') } });
        expect(out.unavailable.find(u => u.harness === 'gemini')?.reason).toBe(
            'gemini not found on PATH; install: npm i -g @google/gemini-cli'
        );
    });
});
