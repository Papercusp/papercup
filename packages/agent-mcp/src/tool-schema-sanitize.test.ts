import { describe, it, expect } from 'vitest';
import { sanitizeToolSchema } from './tool-schema-sanitize';

describe('sanitizeToolSchema', () => {
  it('objectifies a boolean property value (z.unknown() → true)', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: { value: true, name: { type: 'string' } },
      additionalProperties: false,
    });
    expect(out).toEqual({
      type: 'object',
      properties: { value: { description: 'matches any value' }, name: { type: 'string' } },
      additionalProperties: false, // untouched
    });
  });

  it('maps false → { not: {} } (accept-nothing equivalent)', () => {
    expect(sanitizeToolSchema({ properties: { x: false } })).toEqual({
      properties: { x: { not: {} } },
    });
  });

  it('objectifies a boolean items (z.array(z.unknown()) → items:true)', () => {
    expect(sanitizeToolSchema({ type: 'array', items: true })).toEqual({
      type: 'array',
      items: { description: 'matches any value' },
    });
  });

  it('reaches nested properties + items', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: {
        ops: { type: 'array', items: { type: 'object', properties: { payload: true } } },
        cfg: { type: 'object', properties: { value: true } },
      },
    });
    expect((out as any).properties.ops.items.properties.payload).toEqual({
      description: 'matches any value',
    });
    expect((out as any).properties.cfg.properties.value).toEqual({ description: 'matches any value' });
  });

  it('the true-mapping is NEVER a literally-empty object (omp-ollama-tool-schema-investigation-2026-06-30): ' +
    'OMP collapses a bare `{}` property/items schema back into the boolean `true` when it serializes its ' +
    'own outbound request, re-introducing the construct Ollama 400s on. A non-empty-but-still-unconstrained ' +
    'object dodges that re-collapse; this guards the fix from regressing back to `{}`.', () => {
    const out = sanitizeToolSchema({ properties: { a: true }, items: true }) as Record<string, unknown>;
    const a = (out.properties as Record<string, unknown>).a as Record<string, unknown>;
    expect(Object.keys(a).length).toBeGreaterThan(0);
    expect(Object.keys(out.items as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it('does NOT touch additionalProperties booleans (Ollama ignores; OpenAI strict needs literal false)', () => {
    const schema = {
      type: 'object',
      properties: { extra: { type: 'object', additionalProperties: true } },
      additionalProperties: false,
    };
    const out = sanitizeToolSchema(schema);
    expect((out as any).additionalProperties).toBe(false);
    expect((out as any).properties.extra.additionalProperties).toBe(true);
  });

  it('leaves a clean schema byte-identical', () => {
    const schema = {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        status: { type: 'string', enum: ['pending', 'all'] },
      },
      required: ['slug'],
      additionalProperties: false,
    };
    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });

  it('does not mutate the input', () => {
    const schema = { properties: { x: true } };
    const copy = JSON.parse(JSON.stringify(schema));
    sanitizeToolSchema(schema);
    expect(schema).toEqual(copy); // input still has x: true
  });

  it('passes through a non-object (defensive)', () => {
    expect(sanitizeToolSchema(true as unknown)).toBe(true);
    expect(sanitizeToolSchema(null as unknown)).toBe(null);
  });
});
