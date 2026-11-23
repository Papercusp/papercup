import { describe, expect, it } from 'vitest';
import { acpKeyedToolSchema } from './su-session-acp-schema';

const batchForm = { type: 'object', properties: { _batch: { const: true }, items: { type: 'array' } }, required: ['_batch', 'items'] };
const keyedForm = { allOf: [{ $ref: '#/$defs/operation' }, { not: { required: ['_batch'] } }] };

function listed(operation: Record<string, unknown>, defs: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'object', $defs: { ...defs, operation }, anyOf: [batchForm, keyedForm] };
}

describe('acpKeyedToolSchema', () => {
  it('advertises a plain object operation as itself, with the definitions it refers to', () => {
    const operation = { type: 'object', properties: { id: { $ref: '#/$defs/0' } }, required: ['id'] };
    expect(acpKeyedToolSchema(listed(operation, { 0: { type: 'string' } }))).toEqual({
      ...operation,
      $defs: { 0: { type: 'string' }, operation },
    });
  });

  it('advertises an operation that is a union of object shapes as one object with no union at its root', () => {
    const one = { type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } }, required: ['id', 'state'], additionalProperties: false };
    const many = { type: 'object', properties: { ids: { type: 'array' }, state: { type: 'string', maxLength: 40 } }, required: ['ids', 'state'], additionalProperties: false };
    const out = acpKeyedToolSchema(listed({ anyOf: [one, many], $defs: { a: { type: 'number' } } }, { 0: { type: 'string' } }));
    expect(out.anyOf).toBeUndefined();
    expect(out.type).toBe('object');
    // Every shape's properties; the first shape's schema where two declare one.
    expect(out.properties).toEqual({ id: { type: 'string' }, state: { type: 'string' }, ids: { type: 'array' } });
    // Only what every shape requires.
    expect(out.required).toEqual(['state']);
    expect(Object.keys(out.$defs as object).sort()).toEqual(['0', 'a', 'operation']);
  });

  it('requires nothing when the shapes share no required property', () => {
    const out = acpKeyedToolSchema(listed({ anyOf: [
      { type: 'object', properties: { summary: { type: 'string' } } },
      { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
    ] }));
    expect(out.required).toBeUndefined();
    expect(Object.keys(out.properties as object)).toEqual(['summary', 'items']);
  });

  it('leaves alone a schema with no batch union, and an operation whose union holds something other than object shapes', () => {
    const plain = { type: 'object', properties: { id: { type: 'string' } } };
    expect(acpKeyedToolSchema(plain)).toBe(plain);
    const odd = listed({ anyOf: [{ type: 'object', properties: {} }, { type: 'string' }] });
    expect(acpKeyedToolSchema(odd)).toBe(odd);
  });
});
