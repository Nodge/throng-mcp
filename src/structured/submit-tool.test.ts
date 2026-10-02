import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const tool = fileURLToPath(new URL('./submit-tool.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'throng-submit-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const body = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const schemaPath = join(dir, 'schema.json');
writeFileSync(schemaPath, JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...body }));

let client: Client;
let out: string;

async function connect(schema: string): Promise<void> {
    out = join(mkdtempSync(join(dir, 'run-')), 'result.json');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [tool, '--schema', schema, '--out', out],
            stderr: 'inherit',
        })
    );
}

beforeEach(() => connect(schemaPath));
afterEach(() => client.close());

async function submit(result: unknown): Promise<{ isError: boolean; text: string }> {
    const response = await client.callTool({ name: 'submit_result', arguments: { result } });
    const content = response.content as { type: string; text?: string }[];
    return { isError: response.isError === true, text: content[0]?.text ?? '' };
}

const state = () => JSON.parse(readFileSync(out, 'utf8')) as unknown;

describe('submit-tool', () => {
    it('lists one tool, submit_result, with the caller schema under `result` minus $schema', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toStrictEqual(['submit_result']);
        expect(tools[0]?.inputSchema).toStrictEqual({
            type: 'object',
            properties: { result: body },
            required: ['result'],
        });
        expect(client.getServerVersion()?.name).toBe('throng_result');
    });

    it('definitions are hoisted to the root; $ref still validates through the tool', async () => {
        await client.close();
        const answer = { type: 'string', minLength: 2 };
        const refSchemaPath = join(dir, 'ref-schema.json');
        writeFileSync(
            refSchemaPath,
            JSON.stringify({
                type: 'object',
                properties: { answer: { $ref: '#/definitions/answer' } },
                required: ['answer'],
                definitions: { answer },
            })
        );
        await connect(refSchemaPath);

        const { tools } = await client.listTools();
        expect(tools[0]?.inputSchema).toStrictEqual({
            type: 'object',
            properties: {
                result: {
                    type: 'object',
                    properties: { answer: { $ref: '#/definitions/answer' } },
                    required: ['answer'],
                },
            },
            required: ['result'],
            definitions: { answer },
        });
        expect(await submit({ answer: 'x' })).toStrictEqual({
            isError: true,
            text: 'rejected: result/answer must NOT have fewer than 2 characters',
        });
        expect(await submit({ answer: 'pong' })).toStrictEqual({ isError: false, text: 'accepted' });
        expect(state()).toStrictEqual({ ok: true, result: { answer: 'pong' } });
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

    // The SDK does not check the arguments (low-level Server), so the handler rejects a missing `result` itself.
    it('absent result → rejected: result is required, out file {ok:false,errors}', async () => {
        const response = await client.callTool({ name: 'submit_result', arguments: {} });
        expect(response.isError).toBe(true);
        expect((response.content as { text?: string }[])[0]?.text).toBe('rejected: result is required');
        expect(state()).toStrictEqual({ ok: false, errors: 'result is required' });
    });
});
