import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaObject } from '../contract.ts';
import { compileSchema, toolInputSchema, type SubmitState } from './validate.ts';

// The `throng_result` stdio MCP server the harness spawns for a run with a schema (DESIGN §6):
// `node src/structured/submit-tool.ts --schema <path> --out <path>`. stdout carries MCP frames only.
// Low-level Server, not McpServer.registerTool: the SDK must not validate the arguments, ajv below is the only validator.

const { values } = parseArgs({ options: { schema: { type: 'string' }, out: { type: 'string' } } });
if (!values.schema || !values.out) {
    process.stderr.write('usage: submit-tool.ts --schema <path> --out <path>\n');
    process.exit(2);
}
const schemaPath = values.schema;
const out = values.out;

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchemaObject;
const compiled = compileSchema(schema);

function writeState(state: SubmitState): void {
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, out);
}

function reject(errors: string): CallToolResult {
    writeState({ ok: false, errors });
    return { content: [{ type: 'text', text: `rejected: ${errors}` }], isError: true };
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- the advanced case: no SDK argument validation, see above.
const server = new Server({ name: 'throng_result', version: '1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
        {
            name: 'submit_result',
            description:
                'Submit the final result of the task. Call it once, when done; `result` must match the input schema. ' +
                'If the call is rejected, fix the result and call it again.',
            inputSchema: toolInputSchema(schema),
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, ({ params }): CallToolResult => {
    if (params.name !== 'submit_result') {
        return { content: [{ type: 'text', text: `unknown tool ${params.name}` }], isError: true };
    }
    const args = params.arguments ?? {};
    if (!('result' in args)) return reject('result is required');
    const validation = compiled.validate(args.result);
    if (!validation.ok) return reject(validation.errors);
    writeState({ ok: true, result: args.result });
    return { content: [{ type: 'text', text: 'accepted' }] };
});

process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
