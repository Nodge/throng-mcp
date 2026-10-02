import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import type { ListHarnessesOutput, RunSuccess } from '../src/contract.ts';
import { connectServer, fakeClaudeConfig, payloadOf, serverEnv } from '../test/mcp-server.ts';

// The npm tarball as a user gets it: `pnpm pack` (prepack builds dist/), unpacked, run as `node dist/mcp.js`
// with no node_modules anywhere: the bundle is self-contained.

const repo = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'throng-pack-'));
afterAll(() => {
    try {
        execFileSync('pkill', ['-9', '-f', tmp]);
    } catch {
        // nothing matched
    }
    rmSync(tmp, { recursive: true, force: true });
});

const SHIPPED = /^package\/(dist\/.+|skills\/.+|docs\/.+|README\.md|LICENSE|package\.json)$/;

it(
    'the packed tarball is self-contained and runs from dist/: list_harnesses and a schema run',
    { timeout: 120_000 },
    async () => {
        try {
            execFileSync('pnpm', ['pack', '--pack-destination', tmp], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            // pnpm and tsdown report on either stream: surface both instead of a bare "Command failed".
            const { stdout, stderr } = error as { stdout?: Buffer | null; stderr?: Buffer | null };
            throw new Error(`pnpm pack failed\n${String(stdout ?? '')}\n${String(stderr ?? '')}`, { cause: error });
        }
        const tarball = readdirSync(tmp).find(name => name.endsWith('.tgz'));
        if (!tarball) expect.unreachable('no tarball');

        const files = execFileSync('tar', ['tzf', join(tmp, tarball)], { encoding: 'utf8' })
            .trim()
            .split('\n');
        expect(files.filter(file => !SHIPPED.test(file))).toStrictEqual([]);
        expect(files).toContain('package/dist/mcp.js');
        expect(files).toContain('package/dist/structured/submit-tool.js');
        expect(files).toContain('package/skills/throng/SKILL.md');
        expect(files).toContain('package/dist/THIRD_PARTY_LICENSES.md');

        execFileSync('tar', ['xzf', join(tmp, tarball), '-C', tmp]);
        const pkg = join(tmp, 'package');
        const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest).not.toHaveProperty('dependencies');
        expect(manifest).not.toHaveProperty('peerDependencies');
        const licenses = readFileSync(join(pkg, 'dist', 'THIRD_PARTY_LICENSES.md'), 'utf8');
        expect(licenses).toContain('@modelcontextprotocol/sdk@');
        expect(licenses).toContain('zod@');
        const distSize = readdirSync(join(pkg, 'dist'), { recursive: true, encoding: 'utf8' })
            .map(file => statSync(join(pkg, 'dist', file)))
            .filter(stat => stat.isFile())
            .reduce((total, stat) => total + stat.size, 0);
        expect(distSize).toBeLessThan(2 * 1024 * 1024);

        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        symlinkSync(process.execPath, join(bin, 'node'));
        // `tmp` in the tag: afterAll's pkill also catches a fake agent left behind.
        const tag = `${tmp}/fake-agent`;
        const config = join(tmp, 'config.yaml');
        writeFileSync(config, fakeClaudeConfig(tag, 'submit-valid'));
        const work = join(tmp, 'work');
        mkdirSync(work);

        const { client, close } = await connectServer({
            entry: join(pkg, 'dist', 'mcp.js'),
            cwd: work,
            env: serverEnv({ THRONG_MCP_CONFIG: config, THRONG_MCP_CACHE_DIR: join(tmp, 'cache'), PATH: bin }),
        });
        try {
            const harnesses = payloadOf(
                await client.callTool({ name: 'list_harnesses', arguments: {} })
            ) as ListHarnessesOutput;
            expect(harnesses.harnesses.map(h => h.harness)).toStrictEqual(['claude']);
            // Install hints come from data/registry.json, inlined into the bundle.
            expect(harnesses.unavailable.find(u => u.harness === 'codex')?.reason).toMatch(
                /install: npm i -g @agentclientprotocol\/codex-acp$/
            );

            const result = await client.callTool({
                name: 'run_thronglet',
                arguments: {
                    agent: 'claude/fake-small',
                    prompt: 'hi',
                    cwd: work,
                    description: 'pack test',
                    schema: {
                        type: 'object',
                        properties: { answer: { type: 'string' } },
                        required: ['answer'],
                        additionalProperties: false,
                    },
                },
            });
            expect(result.isError, JSON.stringify(result)).toBe(undefined);
            // Only dist/structured/submit-tool.js, spawned from the path the entry computed, could have produced it.
            expect((payloadOf(result) as RunSuccess).structured).toStrictEqual({ answer: 'pong' });
        } finally {
            await close();
        }
    }
);
