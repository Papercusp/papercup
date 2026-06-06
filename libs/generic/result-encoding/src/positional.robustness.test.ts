import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  projectReadColumns,
  projectWriteColumns,
  reconstructArgs,
  encodePositionalRows,
  decode,
  type ColumnSpec,
} from './index';

/**
 * Robustness coverage for the positional primitives — the edge cases a core
 * dispatch/serialize path must survive, beyond the happy-path round-trips.
 */

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (z as any).toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

describe('reconstruct — whitespace + free-text content fidelity', () => {
  const setStateCols = projectWriteColumns(
    jsonSchema(z.object({ id: z.string(), state: z.enum(['todo', 'passed']), harness: z.string().optional() })),
  )!;

  it('tolerates spaces after commas (natural CSV style) on scalar/enum columns', () => {
    expect(reconstructArgs('WI-12, passed', setStateCols)).toEqual({ ok: true, args: { id: 'WI-12', state: 'passed' } });
    expect(reconstructArgs(' WI-12 , passed , papercup ', setStateCols)).toEqual({
      ok: true,
      args: { id: 'WI-12', state: 'passed', harness: 'papercup' },
    });
  });

  it('free-text preserves INTERNAL commas AND newlines, trims only edges', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), body: z.string() })))!;
    const r = reconstructArgs('WI-9, line one, still line one\nline two ', cols);
    expect(r).toEqual({ ok: true, args: { id: 'WI-9', body: 'line one, still line one\nline two' } });
  });

  it('whitespace-only required scalar with an enum guard is rejected (caught, not blank-written)', () => {
    const r = reconstructArgs('WI-12,   ', setStateCols); // state blanked
    expect(r.ok).toBe(false);
  });

  it('empty row → rejected (too few fields)', () => {
    expect(reconstructArgs('', setStateCols).ok).toBe(false);
  });

  it('a single trailing optional may be present-but-empty → omitted', () => {
    expect(reconstructArgs('WI-1,passed,', setStateCols)).toEqual({ ok: true, args: { id: 'WI-1', state: 'passed' } });
  });
});

describe('reconstruct — numeric/boolean coercion edges', () => {
  const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number(), k: z.number().int(), ok: z.boolean() })))!;

  it('rejects a non-numeric value in a number column', () => {
    expect(reconstructArgs('x,not-a-number,1,true', cols).ok).toBe(false);
  });
  it('rejects a non-integer in an integer column', () => {
    expect(reconstructArgs('x,1.5,2.5,true', cols).ok).toBe(false);
  });
  it('accepts 0/1 and true/false for booleans', () => {
    expect(reconstructArgs('x,1,2,1', cols)).toEqual({ ok: true, args: { id: 'x', n: 1, k: 2, ok: true } });
    expect(reconstructArgs('x,1,2,false', cols)).toEqual({ ok: true, args: { id: 'x', n: 1, k: 2, ok: false } });
  });
  it('rejects a non-boolean token', () => {
    expect(reconstructArgs('x,1,2,maybe', cols).ok).toBe(false);
  });
});

describe('projectWriteColumns — defaults, unions, passthrough', () => {
  it('a Zod default makes the (trailing) column optional (model may omit → Zod applies the default)', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number().default(5) })))!;
    expect(cols.find((c) => c.name === 'n')?.optional).toBe(true);
    // omitted → not present in reconstructed args → Zod fills the default downstream
    expect(reconstructArgs('WI-1', cols)).toEqual({ ok: true, args: { id: 'WI-1' } });
  });

  it('a NON-trailing optional → ineligible (prevents a mid-row omission shift, D-006)', () => {
    // `mid` optional sits before required `name`; omitting it would shift values.
    expect(
      projectWriteColumns(jsonSchema(z.object({ id: z.string(), mid: z.string().optional(), name: z.string() }))),
    ).toBeUndefined();
  });

  it('contiguous TRAILING optionals are fine (work_items:claim shape)', () => {
    const cols = projectWriteColumns(
      jsonSchema(z.object({ id: z.string(), assignee: z.string().optional(), harness: z.string().optional() })),
    )!;
    expect(cols.map((c) => c.optional)).toEqual([false, true, true]);
  });

  it('a non-nullable union column → ineligible (undefined), so the tool stays typed-JSON', () => {
    expect(projectWriteColumns(jsonSchema(z.object({ id: z.string(), v: z.union([z.string(), z.number()]) })))).toBeUndefined();
  });

  it('a passthrough/catchall object (unknown extra columns) → ineligible', () => {
    expect(projectWriteColumns(jsonSchema(z.object({ id: z.string() }).catchall(z.string())))).toBeUndefined();
  });

  it('nullable enum projects with both flags + members', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), s: z.enum(['a', 'b']).nullable() })))!;
    const s = cols.find((c) => c.name === 's')!;
    expect(s.type).toBe('enum');
    expect(s.nullable).toBe(true);
    expect(s.enumValues).toEqual(['a', 'b']);
  });
});

describe('read encoder — nasty data survives RFC quoting and decodes back', () => {
  it('values with commas, quotes, and newlines round-trip through headerless CSV', () => {
    const cols: ColumnSpec[] = projectReadColumns(jsonSchema(z.array(z.object({ id: z.string(), text: z.string() }))))!;
    const rows = [
      { id: 'a', text: 'has, comma' },
      { id: 'b', text: 'has "quote"' },
      { id: 'c', text: 'has\nnewline' },
    ];
    const body = encodePositionalRows(rows, cols);
    // The [N] guard prefixes; the rest is RFC-4180 CSV the model parses.
    expect(body.startsWith('[3]\n')).toBe(true);
    const csvPart = body.slice(body.indexOf('\n') + 1);
    // Re-prepend the (server-omitted) header so the shared CSV decoder can read
    // it back, proving the body is valid RFC-4180 (the model maps positions).
    const decoded = decode(`${cols.map((c) => c.name).join(',')}\n${csvPart}`, 'csv') as Array<Record<string, string>>;
    expect(decoded).toEqual([
      { id: 'a', text: 'has, comma' },
      { id: 'b', text: 'has "quote"' },
      { id: 'c', text: 'has\nnewline' },
    ]);
  });

  it('null + number cells stringify predictably (id,n with a null)', () => {
    const cols = projectReadColumns(jsonSchema(z.array(z.object({ id: z.string(), n: z.number().nullable() }))))!;
    expect(encodePositionalRows([{ id: 'a', n: 7 }, { id: 'b', n: null }], cols)).toBe('[2]\na,7\nb,');
  });

  it('declared columns the data is MISSING render as empty cells (positional integrity preserved)', () => {
    const cols: ColumnSpec[] = [
      { name: 'id', type: 'id', optional: false, nullable: false },
      { name: 'state', type: 'string', optional: false, nullable: false },
    ];
    // a row missing `state` keeps the column slot (empty) — never shifts.
    expect(encodePositionalRows([{ id: 'a' } as Record<string, unknown>], cols)).toBe('[1]\na,');
  });
});
