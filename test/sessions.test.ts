import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cacheDir, readSessionRecord, rotate, touchSessionRecord, writeSessionRecord } from '../src/sessions.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-sessions-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('sessions', () => {
  it('cacheDir honours THRONG_MCP_CACHE_DIR', () => {
    assert.equal(cacheDir({ THRONG_MCP_CACHE_DIR: '/x/y' }), '/x/y');
    assert.match(cacheDir({}), /\.cache\/throng$/);
  });

  it('write / read / touch round-trip, atomic (no temp files left)', async () => {
    const dir = join(root, 'rt');
    const record = {
      harness: 'claude' as const,
      model: 'fake-small',
      effort: 'high' as const,
      cwd: '/tmp',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: '2026-01-01T00:00:00.000Z',
    };
    await writeSessionRecord(dir, 'sess-1', record);
    assert.deepEqual(readdirSync(join(dir, 'sessions')), ['sess-1.json']);
    assert.deepEqual(await readSessionRecord(dir, 'sess-1'), record);
    await touchSessionRecord(dir, 'sess-1', new Date('2026-02-02T00:00:00.000Z'));
    assert.deepEqual(await readSessionRecord(dir, 'sess-1'), { ...record, last_used_at: '2026-02-02T00:00:00.000Z' });
    assert.deepEqual(readdirSync(join(dir, 'sessions')), ['sess-1.json']);
    assert.equal(await readSessionRecord(dir, 'missing'), undefined);
    await touchSessionRecord(dir, 'missing');
    assert.equal(existsSync(join(dir, 'sessions', 'missing.json')), false);
  });

  it('refuses session ids that would escape the directory', async () => {
    const dir = join(root, 'unsafe');
    await assert.rejects(
      writeSessionRecord(dir, '../evil', { harness: 'claude', model: 'm', cwd: '/', created_at: '', last_used_at: '' }),
    );
    assert.equal(await readSessionRecord(dir, '../evil'), undefined);
  });

  it('rotate deletes old files in sessions/ and runs/, keeps fresh ones; missing dirs are fine', async () => {
    const dir = join(root, 'rot');
    await rotate(dir);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    mkdirSync(join(dir, 'runs'), { recursive: true });
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    for (const [sub, name] of [['sessions', 'old.json'], ['runs', 'old.jsonl']] as const) {
      writeFileSync(join(dir, sub, name), '{}');
      utimesSync(join(dir, sub, name), old, old);
    }
    writeFileSync(join(dir, 'sessions', 'fresh.json'), '{}');
    writeFileSync(join(dir, 'runs', 'fresh.jsonl'), '{}');
    await rotate(dir);
    assert.deepEqual(readdirSync(join(dir, 'sessions')), ['fresh.json']);
    assert.deepEqual(readdirSync(join(dir, 'runs')), ['fresh.jsonl']);
  });
});
