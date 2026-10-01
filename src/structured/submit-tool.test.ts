import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const tool = fileURLToPath(new URL('./submit-tool.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-submit-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const schemaPath = join(dir, 'schema.json');
writeFileSync(
    schemaPath,
    JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] })
);

let client: Client;
let out: string;
beforeEach(async () => {
    out = join(mkdtempSync(join(dir, 'run-')), 'result.json');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [tool, '--schema', schemaPath, '--out', out],
            stderr: 'inherit',
        })
    );
});
afterEach(() => client.close());

async function submit(result: unknown): Promise<{ isError: boolean; text: string }> {
    const response = await client.callTool({ name: 'submit_result', arguments: { result } });
    const content = response.content as { type: string; text?: string }[];
    return { isError: response.isError === true, text: content[0]?.text ?? '' };
}

const state = () => JSON.parse(readFileSync(out, 'utf8')) as unknown;

describe('submit-tool', () => {
    it('lists one tool, submit_result', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toStrictEqual(['submit_result']);
        expect(client.getServerVersion()?.name).toBe('throng_result');
    });

    it('valid → accepted, out file {ok:true,result}', async () => {
        expect(await submit({ answer: 'pong' })).toStrictEqual({ isError: false, text: 'accepted' });
        expect(state()).toStrictEqual({ ok: true, result: { answer: 'pong' } });
    });

    it('invalid → isError with the ajv text, out file {ok:false,errors}; the last call wins', async () => {
        expect(await submit({ answer: 1 })).toStrictEqual({
            isError: true,
            text: 'rejected: result/answer must be string',
        });
        expect(state()).toStrictEqual({ ok: false, errors: 'result/answer must be string' });

        await submit({ answer: 'pong' });
        expect(state()).toStrictEqual({ ok: true, result: { answer: 'pong' } });
        await submit({});
        expect(state()).toStrictEqual({ ok: false, errors: "result must have required property 'answer'" });
    });

    // A permissive schema would accept `undefined`; the zod input schema keeps `result` required, so the SDK
    // rejects the call before the handler and nothing is written.
    it('absent result → input error, out file not written', async () => {
        const { tools } = await client.listTools();
        expect(tools[0]?.inputSchema.required).toStrictEqual(['result']);
        const response = await client.callTool({ name: 'submit_result', arguments: {} });
        expect(response.isError).toBe(true);
        expect(existsSync(out)).toBe(false);
    });
});
