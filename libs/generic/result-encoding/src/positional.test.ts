import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  projectReadColumns,
  projectWriteColumns,
  applyColumnOverrides,
  encodePositionalRows,
  positionalRowSchema,
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

  // Gap-17: a SINGLE-column free-text tool (scalarCount = columns.length - 1 = 0).
  // With no scalar columns to peel off, splitRow performs NO comma splitting —
  // the entire row is the free-text remainder, so embedded commas/newlines are
  // taken verbatim. This is the degenerate base case of the trailing-free-text
  // rule and must not corrupt a prose body that happens to contain commas.
  describe('single-column free-text tool (Gap-17)', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ body: z.string() })))!;

    it('projects to one trailing text column with scalarCount 0', () => {
      expect(cols).toHaveLength(1);
      expect(cols[0]).toMatchObject({ name: 'body', type: 'text', optional: false, nullable: false });
    });

    it('keeps the whole row verbatim — no comma splitting', () => {
      const r = reconstructArgs('hello, world\nmore', cols);
      expect(r).toEqual({ ok: true, args: { body: 'hello, world\nmore' } });
    });

    it('a row that is just a comma stays a comma (not split into fields)', () => {
      expect(reconstructArgs(',', cols)).toEqual({ ok: true, args: { body: ',' } });
    });

    it('empty row → required-but-empty handling: explicit empty string (pinned)', () => {
      // `body` is required (not optional, not nullable) and string-ish `text`, so
      // the null-rule coerces an empty cell to '' rather than rejecting.
      expect(reconstructArgs('', cols)).toEqual({ ok: true, args: { body: '' } });
    });
  });
});

// ── positionalRowSchema — the advertised single `row` arg ────────────────────

describe('positionalRowSchema', () => {
  it('advertises a single required `row` string and names the column order', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number() })))!;
    const schema = positionalRowSchema(cols);
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['row'] });
    const row = (schema.properties as { row: { type: string; description: string } }).row;
    expect(row.type).toBe('string');
    expect(row.description).toContain('id');
    expect(row.description).toContain('column order');
  });

  it('marks an optional column with a trailing ? in the order legend', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number(), note: z.string().optional() })))!;
    const desc = (positionalRowSchema(cols).properties as { row: { description: string } }).row.description;
    expect(desc).toMatch(/note\?/);
  });

  it('adds the free-text hint when the last column is text, omits it otherwise', () => {
    const textCols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), body: z.string() })))!;
    expect((positionalRowSchema(textCols).properties as { row: { description: string } }).row.description).toMatch(/free-text/);
    const scalarCols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number() })))!;
    expect((positionalRowSchema(scalarCols).properties as { row: { description: string } }).row.description).not.toMatch(/free-text/);
  });
});

// ── reconstructArgs — coercion guards (shifted/garbage row rejected, D-007) ───

describe('reconstructArgs — type coercion guards', () => {
  it('rejects a non-numeric value in a number column (not silently coerced to NaN)', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number() })))!;
    const r = reconstructArgs('x,not-a-number', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expected number/);
  });

  it('rejects a non-integer value in an integer column', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number().int() })))!;
    const r = reconstructArgs('x,1.5', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expected integer/);
  });

  it('rejects an unrecognized boolean token', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), ok: z.boolean() })))!;
    expect(reconstructArgs('x,maybe', cols).ok).toBe(false);
  });

  it('accepts 1/0 (not only true/false) as boolean', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), ok: z.boolean() })))!;
    expect(reconstructArgs('x,1', cols)).toEqual({ ok: true, args: { id: 'x', ok: true } });
    expect(reconstructArgs('y,0', cols)).toEqual({ ok: true, args: { id: 'y', ok: false } });
  });

  it('rejects a required-but-empty NON-string column (a missing number is not "")', () => {
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), n: z.number() })))!;
    const r = reconstructArgs('x,', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/required but empty/);
  });

  it('rejects when no columns are declared', () => {
    expect(reconstructArgs('anything', [])).toEqual({ ok: false, reason: 'no columns declared' });
  });
});

// ── reconstructArgs — RFC-4180 quoted scalar carries the delimiter ────────────

describe('reconstructArgs — quoted scalar with an embedded comma (no trailing free-text)', () => {
  it('un-quotes a scalar cell that carries a comma when the last column is NOT free-text', () => {
    // Last column is a number → no free-text mode → the row is RFC-4180 parsed, so a
    // quoted middle cell can carry the delimiter. This is the decode side of
    // encodePositionalRows's quoting (round-trip integrity for comma-bearing scalars).
    const cols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), label: z.string(), n: z.number() })))!;
    const r = reconstructArgs('WI-1,"x, y",42', cols);
    expect(r).toEqual({ ok: true, args: { id: 'WI-1', label: 'x, y', n: 42 } });
  });
});

// ── columnOverrides — D-007 residual (EI-7927): id-shape/enum checks beyond arity ──

describe('applyColumnOverrides', () => {
  const base = (): ColumnSpec[] => [
    { name: 'id', type: 'id', optional: false, nullable: false },
    { name: 'state', type: 'string', optional: false, nullable: false },
    { name: 'note', type: 'text', optional: true, nullable: false },
  ];

  it('fills a gap the schema left empty (no pattern/enumValues derived)', () => {
    const cols = applyColumnOverrides(base(), {
      id: { pattern: '^WI-\\d+$' },
      state: { enumValues: ['open', 'closed'] },
    });
    expect(cols.find((c) => c.name === 'id')?.pattern).toBe('^WI-\\d+$');
    expect(cols.find((c) => c.name === 'state')?.enumValues).toEqual(['open', 'closed']);
  });

  it('never attaches an override to the trailing free-text column', () => {
    const cols = applyColumnOverrides(base(), { note: { pattern: '^x$', enumValues: ['a'] } });
    const note = cols.find((c) => c.name === 'note')!;
    expect(note.pattern).toBeUndefined();
    expect(note.enumValues).toBeUndefined();
  });

  it('never overwrites a constraint the schema itself already derived', () => {
    const withSchemaEnum: ColumnSpec[] = [
      { name: 'state', type: 'enum', optional: false, nullable: false, enumValues: ['todo', 'done'] },
    ];
    const cols = applyColumnOverrides(withSchemaEnum, { state: { enumValues: ['zzz'] } });
    expect(cols[0].enumValues).toEqual(['todo', 'done']); // schema's own enum wins
  });

  it('is a no-op when no overrides are declared for this tool', () => {
    expect(applyColumnOverrides(base())).toEqual(base());
  });
});

describe('reconstructArgs — columnOverrides catch a swapped row arity alone would miss', () => {
  // The {id, state, harness?} shape S07 gates against — both id and state are
  // plain strings in the real tool's schema (id spans WI-/F-/EI- prefixes;
  // state spans every cross-family alias), so neither carries a schema-derived
  // pattern/enum. columnOverrides supplies the id-shape + known-vocabulary
  // checks out of band (mirrors pre-prompt-registry-config.ts's real config).
  const cols = () =>
    applyColumnOverrides(
      projectWriteColumns(jsonSchema(z.object({ id: z.string(), state: z.string(), harness: z.string().optional() })))!,
      { id: { pattern: '^(WI|F|EI)-\\d+$' }, state: { enumValues: ['open', 'resolved', 'closed', 'passed'] } },
    );

  it('a correctly-ordered row still passes', () => {
    expect(reconstructArgs('WI-42,passed', cols())).toEqual({ ok: true, args: { id: 'WI-42', state: 'passed' } });
  });

  it('rejects a row with the state value shifted into the id column', () => {
    // Arity is fine (2 fields for 2 required columns) — only the id-shape check catches this.
    const r = reconstructArgs('passed,WI-42', cols());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/column "id" failed sanity check/);
  });

  it('rejects a row with an out-of-vocabulary state (arity-only would have accepted it)', () => {
    const r = reconstructArgs('WI-42,zzz-not-a-state', cols());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/column "state" must be one of/);
  });

  it('never applies the enum/pattern check to the trailing free-text column', () => {
    const withNote = applyColumnOverrides(
      projectWriteColumns(
        jsonSchema(z.object({ id: z.string(), state: z.string(), note: z.string() })),
        { freeTextName: 'note' },
      )!,
      { id: { pattern: '^(WI|F|EI)-\\d+$' } },
    );
    // Free text can say anything, including something id-shaped-looking.
    expect(reconstructArgs('WI-42,open,anything at all incl. WI-99 EI-1', withNote)).toEqual({
      ok: true,
      args: { id: 'WI-42', state: 'open', note: 'anything at all incl. WI-99 EI-1' },
    });
  });
});
