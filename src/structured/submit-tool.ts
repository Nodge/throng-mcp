import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { JsonSchemaObject } from '../contract.ts';
import { compileSchema, type SubmitState } from './validate.ts';

// The `throng_result` stdio MCP server the harness spawns for a run with a schema (DESIGN §6):
// `node src/structured/submit-tool.ts --schema <path> --out <path>`. stdout carries MCP frames only.

const { values } = parseArgs({ options: { schema: { type: 'string' }, out: { type: 'string' } } });
if (!values.schema || !values.out) {
    process.stderr.write('usage: submit-tool.ts --schema <path> --out <path>\n');
    process.exit(2);
}
const schemaPath = values.schema;
const out = values.out;

const compiled = compileSchema(JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchemaObject);

function writeState(state: SubmitState): void {
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, out);
}

const server = new McpServer({ name: 'throng_result', version: '1' });
server.registerTool(
    'submit_result',
    {
        description:
            'Submit the final result of the task. Call it once, when done, with `result` matching the JSON Schema ' +
            'given in the task; if it is rejected, fix the result and call it again.',
        inputSchema: { result: z.unknown().describe('The result; must match the JSON Schema from the task') },
    },
    ({ result }) => {
        const validation = compiled.validate(result);
        if (validation.ok) {
            writeState({ ok: true, result });
            return { content: [{ type: 'text', text: 'accepted' }] };
        }
        writeState({ ok: false, errors: validation.errors });
        return { content: [{ type: 'text', text: `rejected: ${validation.errors}` }], isError: true };
    }
);

process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
