import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Transcript } from '../src/transcript.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-transcript-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('transcript', () => {
  it('concurrent calls without a session in the same millisecond get separate files', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const a = new Transcript(root, startedAt);
    const b = new Transcript(root, startedAt);
    a.harness = b.harness = 'claude';
    a.write('input', { call: 'a' });
    b.write('input', { call: 'b' });
    a.write('outcome', { call: 'a' });
    b.write('outcome', { call: 'b' });
    await Promise.all([a.close(), b.close()]);

    const files = readdirSync(join(root, 'runs'));
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.match(file, /^2026-01-01T00-00-00\.000Z-claude-nosession-[0-9a-f]{8}\.jsonl$/);
      const calls = new Set(
        readFileSync(join(root, 'runs', file), 'utf8')
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { call: string }).call),
      );
      assert.equal(calls.size, 1);
    }
  });
});
