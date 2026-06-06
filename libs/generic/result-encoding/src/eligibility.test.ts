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
