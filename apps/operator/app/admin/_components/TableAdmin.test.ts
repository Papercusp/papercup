// TableAdmin — the Drizzle-driven CRUD admin factory. Its substance is fetch
// orchestration + RichGrid wiring (an e2e shell), but two pure helpers carry
// real logic and are extracted + exported: coerceColumnValue (form-string →
// typed value, the create/edit body coercion) and renderCell (cell display
// formatting). Those are tested here branch-by-branch; the shell itself is an
// → e2e surface (grid + confirm-dialog + 4 fetch endpoints), not unit-tested.

import { describe, expect, it } from 'vitest';
import { coerceColumnValue, renderCell, type ColumnSummary } from './TableAdmin';

function col(over: Partial<ColumnSummary> = {}): ColumnSummary {
  return {
    name: 'c',
    dataType: 'text',
    columnType: 'PgText',
    notNull: false,
    primary: false,
    hasDefault: false,
    default: null,
    isUnique: false,
    generated: false,
    ...over,
  };
}

describe('coerceColumnValue', () => {
  it('coerces an empty string to null for a nullable column', () => {
    expect(coerceColumnValue(col({ notNull: false }), '')).toBeNull();
  });

  it('coerces an empty string to undefined when a default exists (let the DB fill)', () => {
    // hasDefault wins for a not-null column with a default.
    expect(coerceColumnValue(col({ notNull: true, hasDefault: true }), '')).toBeUndefined();
  });

  it('parses integer-family columns with Number', () => {
    expect(coerceColumnValue(col({ columnType: 'PgInteger', notNull: true }), '42')).toBe(42);
    expect(coerceColumnValue(col({ columnType: 'PgBigInt53', notNull: true }), '7')).toBe(7);
  });

  it('keeps numeric/decimal columns as the raw string (precision preservation)', () => {
    expect(coerceColumnValue(col({ columnType: 'PgNumeric', notNull: true }), '3.14159')).toBe('3.14159');
    expect(coerceColumnValue(col({ columnType: 'PgReal', notNull: true }), '1.5')).toBe('1.5');
  });

  it('coerces booleans from "true"/"1" and treats everything else as false', () => {
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), 'true')).toBe(true);
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), '1')).toBe(true);
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), 'false')).toBe(false);
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), 'no')).toBe(false);
  });

  it('parses JSON columns and falls back to the raw string on bad JSON', () => {
    expect(coerceColumnValue(col({ columnType: 'PgJsonb', notNull: true }), '{"a":1}')).toEqual({ a: 1 });
    expect(coerceColumnValue(col({ columnType: 'PgJson', notNull: true }), 'not json')).toBe('not json');
  });

  it('passes text columns through unchanged', () => {
    expect(coerceColumnValue(col({ columnType: 'PgText', notNull: true }), 'hello')).toBe('hello');
  });
});

describe('renderCell', () => {
  it('renders null/undefined as the empty-set glyph', () => {
    expect(renderCell(null)).toBe('∅');
    expect(renderCell(undefined)).toBe('∅');
  });

  it('renders booleans and numbers as their string form', () => {
    expect(renderCell(true)).toBe('true');
    expect(renderCell(false)).toBe('false');
    expect(renderCell(0)).toBe('0');
    expect(renderCell(42)).toBe('42');
  });

  it('passes short strings through and truncates long ones with an ellipsis', () => {
    expect(renderCell('short')).toBe('short');
    const long = 'x'.repeat(250);
    const out = renderCell(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(198); // 197 chars + ellipsis
  });

  it('JSON-stringifies objects, truncating long output', () => {
    expect(renderCell({ a: 1 })).toBe('{"a":1}');
    const big = renderCell({ data: 'y'.repeat(300) });
    expect(big.endsWith('…')).toBe(true);
  });
});
