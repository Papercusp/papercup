/**
 * datatype-payload-validation.test — P-001 instance payload validation (pure, no DB).
 * The "validation a datatype exists to provide": a payload that violates the datatype's
 * payload_schema is rejected; the absent/empty/malformed-schema fail-open cases are explicit.
 */
import { describe, it, expect } from 'vitest';
import { validateDatatypePayload, isCompilableSchema } from './datatype-payload-validation';

// A representative `bet` schema: market (required string), edge (number 0..1), optional thesis.
const BET_SCHEMA = {
  type: 'object',
  properties: {
    market: { type: 'string', minLength: 1 },
    edge: { type: 'number', minimum: 0, maximum: 1 },
    thesis: { type: 'string' },
  },
  required: ['market', 'edge'],
  additionalProperties: false,
} as const;

describe('validateDatatypePayload — enforces the datatype schema', () => {
  it('accepts a well-formed payload', () => {
    expect(validateDatatypePayload(BET_SCHEMA, { market: 'BTC>100k EOY', edge: 0.12 })).toEqual({ ok: true });
  });

  it('rejects a missing required field', () => {
    const r = validateDatatypePayload(BET_SCHEMA, { market: 'BTC>100k EOY' }); // no edge
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors.join(' ')).toMatch(/edge/);
  });

  it('rejects a wrong type', () => {
    const r = validateDatatypePayload(BET_SCHEMA, { market: 'x', edge: 'not-a-number' });
    expect(r.ok).toBe(false);
  });

  it('rejects an out-of-range value', () => {
    expect(validateDatatypePayload(BET_SCHEMA, { market: 'x', edge: 1.5 }).ok).toBe(false);
  });

  it('rejects an unexpected extra field (additionalProperties:false)', () => {
    expect(validateDatatypePayload(BET_SCHEMA, { market: 'x', edge: 0.2, sneaky: true }).ok).toBe(false);
  });
});

describe('validateDatatypePayload — fail-open cases', () => {
  it('no schema ⇒ ok (the datatype imposes no constraint)', () => {
    expect(validateDatatypePayload(null, { anything: 1 })).toEqual({ ok: true });
    expect(validateDatatypePayload({}, { anything: 1 })).toEqual({ ok: true });
  });

  it('a malformed schema ⇒ ok (declare-time gate owns it, create never hard-fails)', () => {
    // `type: 'banana'` is not a valid JSON Schema type → compile throws → fail-open.
    expect(validateDatatypePayload({ type: 'banana' } as Record<string, unknown>, { x: 1 })).toEqual({ ok: true });
  });

  it('an undefined payload validates against an all-optional schema', () => {
    expect(validateDatatypePayload({ type: 'object', properties: { a: { type: 'string' } } }, undefined)).toEqual({ ok: true });
  });
});

describe('isCompilableSchema — the declare-time gate', () => {
  it('accepts a well-formed schema, rejects a malformed one', () => {
    expect(isCompilableSchema(BET_SCHEMA)).toBe(true);
    expect(isCompilableSchema({ type: 'object' })).toBe(true);
    expect(isCompilableSchema({ type: 'banana' } as Record<string, unknown>)).toBe(false);
    expect(isCompilableSchema({ required: 'not-an-array' } as Record<string, unknown>)).toBe(false);
  });
});
