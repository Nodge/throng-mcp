import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAgentSpec } from '../src/agent-spec.ts';
import { EFFORT_LEVELS, HARNESS_IDS } from '../src/contract.ts';
import { ThrongError } from '../src/errors.ts';
import type { ErrorCode } from '../src/errors.ts';

function assertThrongError(fn: () => unknown, code: ErrorCode, includes: string[]): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ThrongError, 'expected a ThrongError');
    assert.equal(err.code, code);
    for (const part of includes) assert.ok(err.message.includes(part), `message "${err.message}" lacks "${part}"`);
    return true;
  });
}

describe('parseAgentSpec', () => {
  it('parses the DESIGN §3.1 examples', () => {
    assert.deepEqual(parseAgentSpec('claude/opus-5-5'), { harness: 'claude', model: 'opus-5-5' });
    assert.deepEqual(parseAgentSpec('claude/opus-5-5:max'), { harness: 'claude', model: 'opus-5-5', effort: 'max' });
    assert.deepEqual(parseAgentSpec('codex/gpt-6-sol:xhigh'), { harness: 'codex', model: 'gpt-6-sol', effort: 'xhigh' });
    assert.deepEqual(parseAgentSpec('opencode/openrouter/moonshotai/kimi-k3:high'), {
      harness: 'opencode',
      model: 'openrouter/moonshotai/kimi-k3',
      effort: 'high',
    });
  });

  it("keeps a model's own :tag", () => {
    assert.deepEqual(parseAgentSpec('opencode/ollama/llama3:8b'), { harness: 'opencode', model: 'ollama/llama3:8b' });
    assert.deepEqual(parseAgentSpec('opencode/ollama/llama3:8b:low'), {
      harness: 'opencode',
      model: 'ollama/llama3:8b',
      effort: 'low',
    });
  });

  it('omits the effort key when there is no suffix', () => {
    assert.equal('effort' in parseAgentSpec('codex/gpt-6-sol'), false);
  });

  for (const effort of EFFORT_LEVELS) {
    it(`recognizes effort "${effort}"`, () => {
      assert.deepEqual(parseAgentSpec(`codex/m:${effort}`), { harness: 'codex', model: 'm', effort });
    });
  }

  it('rejects an unknown or missing harness with harness_unavailable', () => {
    assertThrongError(() => parseAgentSpec('gemini/pro'), 'harness_unavailable', ['"gemini"', ...HARNESS_IDS]);
    assertThrongError(() => parseAgentSpec('Claude/opus-5-5'), 'harness_unavailable', ['"Claude"']);
    assertThrongError(() => parseAgentSpec(''), 'harness_unavailable', ['""']);
    assertThrongError(() => parseAgentSpec('/opus-5-5'), 'harness_unavailable', ['""']);
  });

  it('rejects an empty model with model_rejected', () => {
    for (const spec of ['claude', 'claude/', 'claude/:max']) {
      assertThrongError(() => parseAgentSpec(spec), 'model_rejected', [`"${spec}"`, '<harness>/<model>[:<effort>]']);
    }
  });
});
