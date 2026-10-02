import { describe, expect, it } from 'vitest';
import { compileSchema, toolInputSchema } from './validate.ts';

const body = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

describe('compileSchema', () => {
    it.each([
        ['draft-07', { $schema: 'http://json-schema.org/draft-07/schema#', ...body }],
        ['2020-12', { $schema: 'https://json-schema.org/draft/2020-12/schema', ...body }],
        ['no $schema', body],
    ])('%s: validates, errors are ajv text', (_, schema) => {
        const compiled = compileSchema(schema);
        expect(compiled.validate({ answer: 'pong' })).toStrictEqual({ ok: true });
        expect(compiled.validate({ answer: 1 })).toStrictEqual({ ok: false, errors: 'result/answer must be string' });
        expect(compiled.validate({})).toStrictEqual({
            ok: false,
            errors: "result must have required property 'answer'",
        });
    });

    it('allErrors: every error, joined with "; "', () => {
        const compiled = compileSchema({
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'number' } },
        });
        expect(compiled.validate({ a: 1, b: 'x' })).toStrictEqual({
            ok: false,
            errors: 'result/a must be string; result/b must be number',
        });
    });

    it('the dialect comes from $schema: draft-07 tuples vs 2020-12 prefixItems', () => {
        const tuple = { type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: false };
        const draft07 = compileSchema({ $schema: 'http://json-schema.org/draft-07/schema#', ...tuple });
        expect(draft07.validate(['a', 1])).toStrictEqual({ ok: true });
        expect(draft07.validate(['a', 1, 2])).toStrictEqual({
            ok: false,
            errors: 'result must NOT have more than 2 items',
        });
        expect(compileSchema(tuple).validate(['a', 'b'])).toStrictEqual({
            ok: false,
            errors: 'result/1 must be number',
        });
        const draft2020 = compileSchema({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'array',
            prefixItems: [{ type: 'string' }],
            items: false,
        });
        expect(draft2020.validate(['a'])).toStrictEqual({ ok: true });
        expect(draft2020.validate(['a', 'b'])).toStrictEqual({
            ok: false,
            errors: 'result must NOT have more than 1 items',
        });
    });

    it('a non-object schema root: arrays and scalars', () => {
        const compiled = compileSchema({ type: 'array', items: { type: 'integer' } });
        expect(compiled.validate([1, 2])).toStrictEqual({ ok: true });
        expect(compiled.validate('x')).toStrictEqual({ ok: false, errors: 'result must be array' });
    });

    it('an invalid schema throws with the ajv message', () => {
        expect(() => compileSchema({ type: 'nope' })).toThrow(/schema is invalid: data\/type must be/);
    });

    it('unknown keywords and formats do not throw', () => {
        const compiled = compileSchema({
            type: 'object',
            'x-custom': true,
            properties: { mail: { type: 'string', format: 'email' }, when: { type: 'string', format: 'nope' } },
        });
        expect(compiled.validate({ mail: 'not a mail', when: 'x' })).toStrictEqual({ ok: true });
    });
});

describe('toolInputSchema', () => {
    it('wraps the schema under a required `result`, drops $schema', () => {
        expect(toolInputSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...body })).toStrictEqual({
            type: 'object',
            properties: { result: body },
            required: ['result'],
        });
    });

    it('hoists $defs and definitions to the root, so the wrapper resolves the refs', () => {
        const defs = { name: { type: 'string' } };
        const legacy = { tag: { type: 'number' } };
        const schema = {
            type: 'object',
            properties: { a: { $ref: '#/$defs/name' }, b: { $ref: '#/definitions/tag' } },
            $defs: defs,
            definitions: legacy,
        };
        const wrapped = toolInputSchema(schema);
        expect(wrapped).toStrictEqual({
            type: 'object',
            properties: { result: { type: 'object', properties: schema.properties } },
            required: ['result'],
            $defs: defs,
            definitions: legacy,
        });
        expect(schema.$defs, 'input not mutated').toBe(defs);

        const compiled = compileSchema(wrapped);
        expect(compiled.validate({ result: { a: 'x', b: 1 } })).toStrictEqual({ ok: true });
        expect(compiled.validate({ result: { a: 1, b: 1 } })).toStrictEqual({
            ok: false,
            errors: 'result/result/a must be string',
        });
    });
});
