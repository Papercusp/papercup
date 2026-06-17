import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { analyzeSchema, bestCompactFormat } from './index';
import type { ResultFormat } from './index';

/** Project a Zod schema to JSON-Schema the same way the tool framework does. */
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (z as any).toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

const caps = (schema: z.ZodTypeAny): ResultFormat[] => [...analyzeSchema(jsonSchema(schema)).capabilities].sort();

describe('analyzeSchema — D-004 capability table', () => {
  it('array of all-scalar objects → {json,toon,csv,tsv,md}', () => {
    const s = z.array(z.object({ id: z.string(), n: z.number(), ok: z.boolean() }));
    expect(caps(s)).toEqual(['csv', 'json', 'md', 'toon', 'tsv']);
    expect(analyzeSchema(jsonSchema(s)).bestFormat).toBe('toon');
  });

  it('scalar leaves include enum, literal, nullable, optional', () => {
    const s = z.array(
      z.object({
        id: z.string(),
        kind: z.enum(['a', 'b']),
        lit: z.literal('x'),
        maybe: z.string().nullable(),
        opt: z.number().optional(),
      }),
    );
    expect(caps(s)).toContain('csv');
  });

  it('array of objects with a nested object field → {json,toon}', () => {
    const s = z.array(z.object({ id: z.string(), meta: z.object({ k: z.number() }) }));
    expect(caps(s)).toEqual(['json', 'toon']);
    expect(analyzeSchema(jsonSchema(s)).bestFormat).toBe('toon');
  });

  it('array of objects with an array field → {json,toon}', () => {
    const s = z.array(z.object({ id: z.string(), tags: z.array(z.string()) }));
    expect(caps(s)).toEqual(['json', 'toon']);
  });

  it('array of a record (unknown columns) → {json,toon}', () => {
    const s = z.array(z.record(z.string(), z.string()));
    expect(caps(s)).toEqual(['json', 'toon']);
  });

  it('heterogeneous union of row shapes → {json,toon}', () => {
    const s = z.array(z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]));
    expect(caps(s)).toEqual(['json', 'toon']);
  });

  it('array of scalars → {json,toon}', () => {
    expect(caps(z.array(z.string()))).toEqual(['json', 'toon']);
  });

  it('single (non-array) object → {json}', () => {
    const s = z.object({ slug: z.string(), status: z.string() });
    expect(caps(s)).toEqual(['json']);
    expect(analyzeSchema(jsonSchema(s)).bestFormat).toBe('json');
  });

  it('record / any → {json}', () => {
    expect(caps(z.record(z.string(), z.unknown()))).toEqual(['json']);
    expect([...analyzeSchema(undefined).capabilities]).toEqual(['json']);
    expect([...analyzeSchema(null).capabilities]).toEqual(['json']);
    expect([...analyzeSchema({}).capabilities]).toEqual(['json']);
  });

  it('nullable array unwraps to the inner array shape', () => {
    const s = z.array(z.object({ id: z.string() })).nullable();
    expect(caps(s)).toContain('csv');
  });

  it('json is always present', () => {
    for (const s of [
      z.array(z.object({ a: z.string() })),
      z.object({ a: z.string() }),
      z.array(z.unknown()),
      z.record(z.string(), z.number()),
    ]) {
      expect(analyzeSchema(jsonSchema(s)).capabilities.has('json')).toBe(true);
    }
  });
});

describe('bestCompactFormat', () => {
  it('prefers toon, never auto-selects csv, falls back to json', () => {
    expect(bestCompactFormat(new Set<ResultFormat>(['json', 'toon', 'csv']))).toBe('toon');
    expect(bestCompactFormat(new Set<ResultFormat>(['json', 'csv']))).toBe('json');
    expect(bestCompactFormat(new Set<ResultFormat>(['json']))).toBe('json');
  });
});

// Structural edge cases driven by RAW JSON-Schema (shapes zod doesn't readily
// emit: open objects, tuple/boolean items, type-union arrays). These guard the
// CSV-eligibility decision — CSV requires a CLOSED, enumerable, all-scalar
// column set, so anything that breaks that promise must fall back to {json,toon}.
describe('analyzeSchema — structural edge cases (raw JSON-Schema)', () => {
  const caps = (s: Record<string, unknown>) => [...analyzeSchema(s).capabilities].sort();

  it('an OPEN object (additionalProperties:true) is NOT csv-eligible — unknown columns', () => {
    const open = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: true } };
    expect(caps(open)).toEqual(['json', 'toon']);
  });

  it('additionalProperties as a SCHEMA (not just true) is also not csv-eligible', () => {
    const open = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: { type: 'string' } } };
    expect(caps(open)).toEqual(['json', 'toon']);
  });

  it('additionalProperties:false keeps a flat object csv-eligible', () => {
    const closed = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } };
    expect(caps(closed)).toContain('csv');
  });

  it('an array of empty-property objects is not flat → {json,toon}', () => {
    expect(caps({ type: 'array', items: { type: 'object', properties: {} } })).toEqual(['json', 'toon']);
  });

  it('tuple-form items (items is an array of positional schemas) → {json,toon}', () => {
    expect(caps({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] })).toEqual(['json', 'toon']);
  });

  it('boolean items (items: true) → {json,toon}, never csv', () => {
    expect(caps({ type: 'array', items: true })).toEqual(['json', 'toon']);
  });

  it('a type-union array (type:["array","null"]) is still treated as an array', () => {
    const u = { type: ['array', 'null'], items: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' } } } };
    expect(caps(u)).toContain('csv');
  });

  it('a nullable-via-type-array scalar column (type:["number","null"]) is still a flat column', () => {
    const s = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, x: { type: ['number', 'null'] } } } };
    expect(caps(s)).toContain('csv');
  });
});
