/**
 * Phase 4 T3.2 plugin-event JSON-Schema validator + classifier tests.
 */
import { describe, expect, it } from 'vitest';
import {
  validatePluginEventSchema,
  validateAndClassifyPluginEvents,
  classifyEventWireFromJsonSchema,
  PluginEventSchemaError,
} from './plugin-events';

describe('classifyEventWireFromJsonSchema', () => {
  it('returns "string" for plain { type: "string" }', () => {
    expect(classifyEventWireFromJsonSchema({ type: 'string' })).toBe('string');
  });

  it('returns "binary" for { type: "string", contentEncoding: "base64" }', () => {
    expect(classifyEventWireFromJsonSchema({ type: 'string', contentEncoding: 'base64' })).toBe('binary');
  });

  it('returns "json" for objects, arrays, numbers, booleans', () => {
    expect(classifyEventWireFromJsonSchema({ type: 'object', properties: { x: { type: 'string' } } })).toBe('json');
    expect(classifyEventWireFromJsonSchema({ type: 'array', items: { type: 'number' } })).toBe('json');
    expect(classifyEventWireFromJsonSchema({ type: 'number' })).toBe('json');
    expect(classifyEventWireFromJsonSchema({ type: 'boolean' })).toBe('json');
  });

  it('treats other contentEncoding values as plain string', () => {
    expect(classifyEventWireFromJsonSchema({ type: 'string', contentEncoding: 'hex' })).toBe('string');
    // Defensible — only 'base64' triggers binary; everything else is a
    // documentation-only annotation that the wire layer ignores.
  });
});

describe('validatePluginEventSchema — supported keywords accepted', () => {
  it('accepts a primitive string schema', () => {
    expect(() => validatePluginEventSchema('delta', { type: 'string' })).not.toThrow();
  });

  it('accepts an object with properties + required', () => {
    expect(() => validatePluginEventSchema('tool_call', {
      type: 'object',
      properties: {
        name: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['name'],
    })).not.toThrow();
  });

  it('accepts an array with items', () => {
    expect(() => validatePluginEventSchema('picks', {
      type: 'array',
      items: { type: 'string' },
    })).not.toThrow();
  });

  it('accepts enum + const + description', () => {
    expect(() => validatePluginEventSchema('phase', {
      type: 'string',
      enum: ['queued', 'running', 'done'],
      description: 'lifecycle state',
    })).not.toThrow();
    expect(() => validatePluginEventSchema('terminator', {
      type: 'string',
      const: 'end',
    })).not.toThrow();
  });

  it('accepts contentEncoding: "base64" on a string', () => {
    expect(() => validatePluginEventSchema('chunk_payload', {
      type: 'string',
      contentEncoding: 'base64',
    })).not.toThrow();
  });

  it('accepts additionalProperties: false', () => {
    expect(() => validatePluginEventSchema('strict', {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    })).not.toThrow();
  });

  it('accepts nested objects and arrays of objects', () => {
    expect(() => validatePluginEventSchema('complex', {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            inner: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    })).not.toThrow();
  });
});

describe('validatePluginEventSchema — rejected keywords', () => {
  it('rejects format', () => {
    expect(() => validatePluginEventSchema('date_event', {
      type: 'string',
      format: 'date-time',
    })).toThrow(/format/);
  });

  it('rejects pattern', () => {
    expect(() => validatePluginEventSchema('regex_event', {
      type: 'string',
      pattern: '^abc.*',
    })).toThrow(/pattern/);
  });

  it('rejects $ref', () => {
    expect(() => validatePluginEventSchema('ref_event', {
      $ref: '#/$defs/Other',
    })).toThrow(/\$ref/);
  });

  it('rejects oneOf / anyOf / allOf', () => {
    expect(() => validatePluginEventSchema('union_event', {
      oneOf: [{ type: 'string' }, { type: 'number' }],
    })).toThrow(/oneOf/);
    expect(() => validatePluginEventSchema('union_event', {
      anyOf: [{ type: 'string' }],
    })).toThrow(/anyOf/);
    expect(() => validatePluginEventSchema('union_event', {
      allOf: [{ type: 'object' }],
    })).toThrow(/allOf/);
  });

  it('rejects not / if / then / else', () => {
    expect(() => validatePluginEventSchema('cond', { if: { type: 'string' } })).toThrow(/if/);
    expect(() => validatePluginEventSchema('cond', { not: { type: 'string' } })).toThrow(/not/);
  });

  it('rejects numeric range keywords', () => {
    expect(() => validatePluginEventSchema('n', { type: 'number', minimum: 0 })).toThrow(/minimum/);
    expect(() => validatePluginEventSchema('n', { type: 'number', maximum: 100 })).toThrow(/maximum/);
  });

  it('rejects array-size keywords', () => {
    expect(() => validatePluginEventSchema('arr', { type: 'array', minItems: 1, items: { type: 'string' } })).toThrow(/minItems/);
  });

  it('rejects unknown keywords (defensive)', () => {
    expect(() => validatePluginEventSchema('weird', {
      type: 'string',
      'x-vendor-extension': true,
    })).toThrow(/unknown JSON-Schema keyword/);
  });

  it('error message points at supported alternatives', () => {
    let err: PluginEventSchemaError | null = null;
    try {
      validatePluginEventSchema('e', { type: 'string', format: 'email' });
    } catch (e) {
      err = e as PluginEventSchemaError;
    }
    expect(err).toBeInstanceOf(PluginEventSchemaError);
    expect(err!.message).toContain('format');
    expect(err!.message).toContain('Supported');
    expect(err!.message).toContain('type');
  });

  it('rejects deep violations with a dotted path', () => {
    expect(() => validatePluginEventSchema('outer', {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            bad: { type: 'string', format: 'uuid' },
          },
        },
      },
    })).toThrow(/outer\.nested\.bad/);
  });
});

describe('validatePluginEventSchema — additionalProperties variants', () => {
  it('allows additionalProperties: false', () => {
    expect(() => validatePluginEventSchema('strict', {
      type: 'object',
      additionalProperties: false,
    })).not.toThrow();
  });

  it('allows additionalProperties: true', () => {
    expect(() => validatePluginEventSchema('loose', {
      type: 'object',
      additionalProperties: true,
    })).not.toThrow();
  });

  it('rejects additionalProperties: <schema>', () => {
    expect(() => validatePluginEventSchema('schemaval', {
      type: 'object',
      additionalProperties: { type: 'string' },
    })).toThrow(/additionalProperties/);
  });
});

describe('validatePluginEventSchema — structural sanity', () => {
  it('rejects non-object root', () => {
    expect(() => validatePluginEventSchema('bad', null as never)).toThrow();
    expect(() => validatePluginEventSchema('bad', [] as never)).toThrow();
    expect(() => validatePluginEventSchema('bad', 'string-not-object' as never)).toThrow();
  });

  it('rejects tuple-form items', () => {
    expect(() => validatePluginEventSchema('tuple', {
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
    })).toThrow(/tuple/);
  });

  it('rejects required with non-string entries', () => {
    expect(() => validatePluginEventSchema('bad-required', {
      type: 'object',
      required: ['ok', 42 as never],
    })).toThrow(/required must contain only strings/);
  });
});

describe('validateAndClassifyPluginEvents — full event-map pass', () => {
  it('returns wire kinds for a well-formed map', () => {
    const kinds = validateAndClassifyPluginEvents({
      delta: { type: 'string' },
      tool_call: { type: 'object', properties: { name: { type: 'string' } } },
      chunk_payload: { type: 'string', contentEncoding: 'base64' },
    });
    expect(kinds).toEqual({
      delta: 'string',
      tool_call: 'json',
      chunk_payload: 'binary',
    });
  });

  it('rejects the whole map if any one event violates', () => {
    expect(() => validateAndClassifyPluginEvents({
      ok: { type: 'string' },
      bad: { type: 'string', format: 'email' },
    })).toThrow(/format/);
  });

  it('handles an empty map', () => {
    expect(validateAndClassifyPluginEvents({})).toEqual({});
  });
});
