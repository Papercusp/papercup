/**
 * Tests for makeAjvResolver — the JSON-Schema form resolver (ajv + ajv-formats)
 * used by the per-plugin config editor. Run with:
 *   cd packages/operator-core && npx vitest run lib/forms/ajvResolver.test.ts
 */
import { describe, expect, it } from 'vitest';
import { makeAjvResolver } from './ajvResolver';

const schema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['email'],
  additionalProperties: true,
};

const resolver = makeAjvResolver(schema);
const run = (values: Record<string, unknown>) =>
  resolver(values, {}, { fields: {}, shouldUseNativeValidation: false } as never);

describe('makeAjvResolver', () => {
  it('passes valid input through with no errors', async () => {
    const r = await run({ email: 'a@b.com', age: 3 });
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({ email: 'a@b.com', age: 3 });
  });

  it('reports a format violation (proves ajv-formats email is registered)', async () => {
    const r = await run({ email: 'not-an-email' });
    expect(r.errors.email).toBeDefined();
    expect(r.values).toEqual({});
  });

  it('reports a missing required field', async () => {
    const r = await run({ age: 1 });
    expect(r.errors.email).toBeDefined();
  });

  it('reports a numeric constraint violation', async () => {
    const r = await run({ email: 'a@b.com', age: -1 });
    expect(r.errors.age).toBeDefined();
  });
});
