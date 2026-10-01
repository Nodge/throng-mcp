import { describe, expect, it } from 'vitest';
import { schemaField } from './run-thronglet.ts';

describe('schemaField', () => {
    it('accepts a schema ajv compiles, and no schema', () => {
        expect(schemaField.safeParse({ type: 'object' }).success).toBe(true);
        expect(schemaField.safeParse(undefined).success).toBe(true);
    });

    it('rejects an invalid schema with the ajv message', () => {
        const parsed = schemaField.safeParse({ type: 'nope' });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toMatch(/^schema is invalid: data\/type must be equal to one of/);
    });
});
