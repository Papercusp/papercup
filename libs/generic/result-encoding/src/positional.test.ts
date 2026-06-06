import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  projectReadColumns,
  projectWriteColumns,
  encodePositionalRows,
  reconstructArgs,
  type ColumnSpec,
} from './index';

/** Project a Zod schema to JSON-Schema the same way the tool framework does. */
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (z as any).toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

describe('projectReadColumns — output data → columns', () => {
  it('flat scalar array → ordered columns with types', () => {
    const s = z.array(z.object({ id: z.string(), state: z.enum(['todo', 'done']), n: z.number() }));
    const cols = projectReadColumns(jsonSchema(s));
    expect(cols?.map((c) => c.name)).toEqual(['id', 'state', 'n']);
    expect(cols?.map((c) => c.type)).toEqual(['id', 'enum', 'number']);
    expect(cols?.[1].enumValues).toEqual(['todo', 'done']);
  });

  it('optional + nullable flags', () => {
    const s = z.array(z.object({ id: z.string(), maybe: z.string().nullable(), opt: z.number().optional() }));
    const cols = projectReadColumns(jsonSchema(s)) as ColumnSpec[];
    expect(cols.find((c) => c.name === 'maybe')?.nullable).toBe(true);
    expect(cols.find((c) => c.name === 'opt')?.optional).toBe(true);
  });

  it('nested object field → not positional (undefined)', () => {
    const s = z.array(z.object({ id: z.string(), meta: z.object({ k: z.number() }) }));
    expect(projectReadColumns(jsonSchema(s))).toBeUndefined();
  });

  it('array field → not positional', () => {
    const s = z.array(z.object({ id: z.string(), tags: z.array(z.string()) }));
    expect(projectReadColumns(jsonSchema(s))).toBeUndefined();
  });

  it('non-array data → undefined', () => {
    expect(projectReadColumns(jsonSchema(z.object({ a: z.string() })))).toBeUndefined();
  });
});

describe('projectWriteColumns — args → columns + free-text-last', () => {
  it('all-scalar args (work_items:set_state shape)', () => {
    const s = z.object({ id: z.string(), state: z.string(), harness: z.string().optional() });
    const cols = projectWriteColumns(jsonSchema(s)) as ColumnSpec[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'state', 'harness']);
    expect(cols.map((c) => c.type)).toEqual(['id', 'string', 'string']);
    expect(cols[2].optional).toBe(true);
    // No free-text column → none typed `text`.
    expect(cols.some((c) => c.type === 'text')).toBe(false);
  });

  it('trailing prose column → marked free-text (text)', () => {
    const s = z.object({ id: z.string(), body: z.string() });
    const cols = projectWriteColumns(jsonSchema(s)) as ColumnSpec[];
    expect(cols[cols.length - 1].type).toBe('text');
  });

  it('explicit freeTextArg override pins the column', () => {
    const s = z.object({ id: z.string(), label: z.string() });
    const cols = projectWriteColumns(jsonSchema(s), { freeTextName: 'label' }) as ColumnSpec[];
    expect(cols[1].type).toBe('text');
  });

  it('two prose columns → ineligible (undefined)', () => {
    const s = z.object({ summary: z.string(), body: z.string() });
    expect(projectWriteColumns(jsonSchema(s))).toBeUndefined();
  });

  it('array arg → ineligible', () => {
    const s = z.object({ to: z.array(z.string()), summary: z.string() });
    expect(projectWriteColumns(jsonSchema(s))).toBeUndefined();
  });
});

describe('encodePositionalRows — headerless CSV + [N] guard', () => {
  it('emits [N] then value rows, no header', () => {
    const cols = projectReadColumns(jsonSchema(z.array(z.object({ id: z.string(), state: z.string() }))))!;
    const text = encodePositionalRows([{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'done' }], cols);
    expect(text).toBe('[2]\nWI-1,todo\nWI-2,done');
  });

  it('quotes cells containing the delimiter', () => {
    const cols = projectReadColumns(jsonSchema(z.array(z.object({ id: z.string(), label: z.string() }))))!;
    const text = encodePositionalRows([{ id: 'a', label: 'x, y' }], cols);
    expect(text).toBe('[1]\na,"x, y"');
  });

  it('empty array → [0]', () => {
    const cols = projectReadColumns(jsonSchema(z.array(z.object({ id: z.string() }))))!;
    expect(encodePositionalRows([], cols)).toBe('[0]');
  });
});

describe('reconstructArgs — positional row → typed args + misalignment guard', () => {
  const setStateCols = projectWriteColumns(
    jsonSchema(z.object({ id: z.string(), state: z.enum(['todo', 'passed', 'failing']), harness: z.string().optional() })),
  )!;

  it('happy path with enum + omitted trailing optional', () => {
    const r = reconstructArgs('WI-12,passed', setStateCols);
    expect(r).toEqual({ ok: true, args: { id: 'WI-12', state: 'passed' } });
  });

  it('all three fields', () => {
    const r = reconstructArgs('WI-12,passed,papercup', setStateCols);
    expect(r).toEqual({ ok: true, args: { id: 'WI-12', state: 'passed', harness: 'papercup' } });
  });

  it('coerces number + boolean columns', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number(), ok: z.boolean() })))!;
    const r = reconstructArgs('x,42,true', cols);
    expect(r).toEqual({ ok: true, args: { id: 'x', n: 42, ok: true } });
  });

  it('trailing free-text keeps embedded commas (split-on-first-N)', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), body: z.string() })))!;
    const r = reconstructArgs('WI-9,fixed the bug, added a test, shipped', cols);
    expect(r).toEqual({ ok: true, args: { id: 'WI-9', body: 'fixed the bug, added a test, shipped' } });
  });

  it('GUARD: too many fields rejected', () => {
    const r = reconstructArgs('WI-12,passed,papercup,extra', setStateCols);
    expect(r.ok).toBe(false);
  });

  it('GUARD: too few required fields rejected', () => {
    const r = reconstructArgs('WI-12', setStateCols);
    expect(r.ok).toBe(false);
  });

  it('GUARD: enum sanity miss rejected (shifted row)', () => {
    // A row where the summary landed in the state column.
    const r = reconstructArgs('WI-12,not-a-state', setStateCols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/state/);
  });

  it('GUARD: id pattern miss rejected', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string().regex(/^WI-\d+$/), state: z.string() })))!;
    const r = reconstructArgs('garbage,todo', cols);
    expect(r.ok).toBe(false);
  });

  it('null-rule: nullable empty → null; optional empty → omitted', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), maybe: z.string().nullable(), opt: z.string().optional() })))!;
    const r = reconstructArgs('x,,', cols);
    expect(r).toEqual({ ok: true, args: { id: 'x', maybe: null } });
  });
});
