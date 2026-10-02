import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { JsonSchemaObject } from '../contract.ts';

// ajv wrapper for structured output (DESIGN §6): shared by the input check in run_thronglet and by submit-tool.

export type Validation = { ok: true } | { ok: false; errors: string };

/** What submit-tool's out file holds after a submit_result call; the last call wins. */
export type SubmitState = { ok: true; result: unknown } | { ok: false; errors: string };

export interface CompiledSchema {
    validate(value: unknown): Validation;
}

/**
 * Compiles a draft-07 or 2020-12 schema. The dialect comes from `$schema` (draft-07 when absent): the two
 * engines differ in keyword semantics (`items` tuples vs `prefixItems`), so a meta schema alone isn't enough.
 * Unknown keywords and formats are ignored. Throws with ajv's message on an invalid schema.
 */
export function compileSchema(schema: JsonSchemaObject): CompiledSchema {
    const options = { allErrors: true, strict: false, validateFormats: false };
    const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
    const ajv = dialect.includes('2020-12') ? new Ajv2020(options) : new Ajv(options);
    const validate = ajv.compile(schema);
    return {
        validate: value =>
            validate(value)
                ? { ok: true }
                : { ok: false, errors: ajv.errorsText(validate.errors, { separator: '; ', dataVar: 'result' }) },
    };
}

/**
 * `submit_result`'s inputSchema: the caller's schema under `result`, its `$defs` / `definitions` hoisted to the root so
 * `#/$defs/…` and `#/definitions/…` refs keep resolving. `$schema` is dropped.
 */
export function toolInputSchema(schema: JsonSchemaObject): {
    type: 'object';
    properties: { result: JsonSchemaObject };
    required: string[];
    $defs?: unknown;
    definitions?: unknown;
} {
    const { $defs, definitions, ...result } = schema;
    delete result.$schema;
    return {
        type: 'object',
        properties: { result },
        required: ['result'],
        ...($defs === undefined ? {} : { $defs }),
        ...(definitions === undefined ? {} : { definitions }),
    };
}
