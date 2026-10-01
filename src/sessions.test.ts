import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cacheDir, readSessionRecord, rotate, touchSessionRecord, writeSessionRecord } from './sessions.ts';

const root = mkdtempSync(join(tmpdir(), 'throng-sessions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('sessions', () => {
  it('cacheDir honours THRONG_MCP_CACHE_DIR', () => {
    expect(cacheDir({ THRONG_MCP_CACHE_DIR: '/x/y' })).toBe('/x/y');
    expect(cacheDir({})).toMatch(/\.cache\/throng$/);
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
    expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['sess-1.json']);
    expect(await readSessionRecord(dir, 'sess-1')).toStrictEqual(record);
    await touchSessionRecord(dir, 'sess-1', new Date('2026-02-02T00:00:00.000Z'));
    expect(await readSessionRecord(dir, 'sess-1')).toStrictEqual({ ...record, last_used_at: '2026-02-02T00:00:00.000Z' });
    expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['sess-1.json']);
    expect(await readSessionRecord(dir, 'missing')).toBe(undefined);
    await touchSessionRecord(dir, 'missing');
    expect(existsSync(join(dir, 'sessions', 'missing.json'))).toBe(false);
  });

  it('refuses session ids that would escape the directory', async () => {
    const dir = join(root, 'unsafe');
    await expect(
      writeSessionRecord(dir, '../evil', { harness: 'claude', model: 'm', cwd: '/', created_at: '', last_used_at: '' }),
    ).rejects.toThrow();
    expect(await readSessionRecord(dir, '../evil')).toBe(undefined);
  });

  it('rotate deletes old session records, keeps fresh ones; a missing dir is fine', async () => {
    const dir = join(root, 'rot');
    await rotate(dir);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    writeFileSync(join(dir, 'sessions', 'old.json'), '{}');
    utimesSync(join(dir, 'sessions', 'old.json'), old, old);
    writeFileSync(join(dir, 'sessions', 'fresh.json'), '{}');
    await rotate(dir);
    expect(readdirSync(join(dir, 'sessions'))).toStrictEqual(['fresh.json']);
  });
});
