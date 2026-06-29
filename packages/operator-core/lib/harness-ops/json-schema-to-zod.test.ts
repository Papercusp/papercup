/**
 * `jsonSchemaToZod` — the manifest JSON-Schema → Zod validator compiler
 * (`harness-provided-cadence-ops-2026-06-26` P-003). Proves the proxy's
 * args/result validators behave: required vs optional, type coercion-free
 * checks, enums, arrays, nested objects, unions, nullables, and the
 * accept-everything escape hatches (`{}` and unrecognized constructs).
 */
import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from './json-schema-to-zod.js';

describe('jsonSchemaToZod', () => {
  it('empty schema {} accepts anything', () => {
    const z = jsonSchemaToZod({});
    expect(z.safeParse(42).success).toBe(true);
    expect(z.safeParse({ a: 1 }).success).toBe(true);
    expect(z.safeParse(null).success).toBe(true);
  });

  it('object with required + optional properties', () => {
    const z = jsonSchemaToZod({
      type: 'object',
      properties: { limit: { type: 'integer' }, note: { type: 'string' } },
      required: ['limit'],
    });
    expect(z.safeParse({ limit: 5 }).success).toBe(true);
    expect(z.safeParse({ limit: 5, note: 'hi' }).success).toBe(true);
    // missing required `limit`
    expect(z.safeParse({ note: 'hi' }).success).toBe(false);
    // wrong type for `limit`
    expect(z.safeParse({ limit: 'five' }).success).toBe(false);
    // integer check (not a float)
    expect(z.safeParse({ limit: 5.5 }).success).toBe(false);
  });

  it('passthrough by default, strict with additionalProperties:false', () => {
    const loose = jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
    expect(loose.safeParse({ a: 'x', extra: 1 }).success).toBe(true);
    const strict = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(strict.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
  });

  it('string enum', () => {
    const z = jsonSchemaToZod({ type: 'string', enum: ['kalshi', 'polymarket'] });
    expect(z.safeParse('kalshi').success).toBe(true);
    expect(z.safeParse('betfair').success).toBe(false);
  });

  it('arrays of typed items', () => {
    const z = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(z.safeParse(['a', 'b']).success).toBe(true);
    expect(z.safeParse(['a', 3]).success).toBe(false);
    expect(z.safeParse('not-an-array').success).toBe(false);
  });

  it('nested objects + arrays (a realistic op result)', () => {
    const z = jsonSchemaToZod({
      type: 'object',
      properties: {
        enqueued: { type: 'integer' },
        keys: { type: 'array', items: { type: 'string' } },
        byVenue: { type: 'object' },
      },
      required: ['enqueued', 'keys'],
    });
    expect(z.safeParse({ enqueued: 2, keys: ['k1', 'k2'], byVenue: { kalshi: 3 } }).success).toBe(true);
    expect(z.safeParse({ enqueued: 2 }).success).toBe(false);
  });

  it('union type [string, null] and nullable', () => {
    const u = jsonSchemaToZod({ type: ['string', 'null'] });
    expect(u.safeParse('x').success).toBe(true);
    expect(u.safeParse(null).success).toBe(true);
    expect(u.safeParse(3).success).toBe(false);

    const n = jsonSchemaToZod({ type: 'number', nullable: true });
    expect(n.safeParse(null).success).toBe(true);
    expect(n.safeParse(1.5).success).toBe(true);
  });

  it('boolean + const + anyOf', () => {
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true);
    expect(jsonSchemaToZod({ const: 'fixed' }).safeParse('fixed').success).toBe(true);
    expect(jsonSchemaToZod({ const: 'fixed' }).safeParse('other').success).toBe(false);
    const any = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(any.safeParse('s').success).toBe(true);
    expect(any.safeParse(2).success).toBe(true);
    expect(any.safeParse(true).success).toBe(false);
  });

  it('unrecognized construct degrades to accept-any (never throws)', () => {
    const z = jsonSchemaToZod({ $ref: '#/definitions/Foo', weirdKeyword: 1 });
    expect(z.safeParse({ anything: true }).success).toBe(true);
    // a non-object schema is also tolerated
    expect(jsonSchemaToZod(null).safeParse(123).success).toBe(true);
  });
});
