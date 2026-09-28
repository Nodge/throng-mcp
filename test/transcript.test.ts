import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Transcript } from '../src/transcript.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-transcript-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('transcript', () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');

  it('a call that never reached a session leaves no file', async () => {
    const t = new Transcript(root, startedAt);
    t.harness = 'claude';
    t.write('input', { call: 'a' });
    t.write('outcome', { code: 'harness_unavailable' });
    await t.close();
    assert.equal(t.path, undefined);
    assert.ok(!existsSync(join(root, 'runs')) || readdirSync(join(root, 'runs')).length === 0);
  });

  it('lines buffered before open() land in the session file', async () => {
    const t = new Transcript(root, startedAt);
    t.harness = 'claude';
    t.write('input', { call: 'b' });
    t.open('sess-1');
    t.write('outcome', { ok: true });
    await t.close();
    const file = '2026-01-01T00-00-00.000Z-claude-sess-1.jsonl';
    assert.deepEqual(readdirSync(join(root, 'runs')), [file]);
    const kinds = readFileSync(join(root, 'runs', file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.deepEqual(kinds, ['input', 'outcome']);
  });
});
