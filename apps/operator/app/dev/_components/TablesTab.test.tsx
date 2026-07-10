// @vitest-environment jsdom
//
// TablesTab — the schema-aware table inspector. Its genuine logic is the
// value-coercion + cell-rendering layer that translates raw filter-composer
// text into typed PG values and PG row cells into copyable strings. Those
// pure helpers (coerceFilterValue / coerceHint / isHarnessSlugCell /
// valueToLabel / renderCell / filterChipLabel) are extracted + exported and
// pinned branch-by-branch here. The component itself is a fetch-driven shell
// over RichGrid; the heavy grid/nuqs/primitive deps are mocked so the module
// imports cleanly for the pure-function tests.

import { describe, expect, it, vi } from 'vitest';

// Keep the module import side-effect-free: none of these are exercised by the
// pure helpers, only pulled in at module top-level.
vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));
vi.mock('@/app/_components/LazyDetails', () => ({ LazyDetails: () => null }));

import {
  coerceFilterValue,
  coerceHint,
  isHarnessSlugCell,
  valueToLabel,
  renderCell,
  filterChipLabel,
  type ColumnSummary,
  type Filter,
} from './TablesTab';

function col(over: Partial<ColumnSummary>): ColumnSummary {
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

describe('coerceFilterValue', () => {
  it('returns the raw string when no column is known', () => {
    expect(coerceFilterValue(undefined, 'abc')).toBe('abc');
  });

  it('coerces integer/bigint/real column text to Number', () => {
    expect(coerceFilterValue(col({ columnType: 'PgInteger' }), '42')).toBe(42);
    expect(coerceFilterValue(col({ columnType: 'PgBigInt53' }), '7')).toBe(7);
    expect(coerceFilterValue(col({ columnType: 'PgDoublePrecision' }), '1.5')).toBe(1.5);
  });

  it('maps an empty numeric value to null', () => {
    expect(coerceFilterValue(col({ columnType: 'PgInteger' }), '')).toBeNull();
  });

  it('coerces boolean column text — true / 1 / t are truthy, all else false', () => {
    const b = col({ columnType: 'PgBoolean' });
    expect(coerceFilterValue(b, 'true')).toBe(true);
    expect(coerceFilterValue(b, '1')).toBe(true);
    expect(coerceFilterValue(b, 't')).toBe(true);
    expect(coerceFilterValue(b, 'false')).toBe(false);
    expect(coerceFilterValue(b, 'nope')).toBe(false);
  });

  it('returns null for an empty value on a nullable non-numeric column', () => {
    expect(coerceFilterValue(col({ columnType: 'PgText', notNull: false }), '')).toBeNull();
  });

  it('keeps the empty string for a NOT NULL text column', () => {
    expect(coerceFilterValue(col({ columnType: 'PgText', notNull: true }), '')).toBe('');
  });
});

describe('coerceHint', () => {
  it('says "number" for numeric column types', () => {
    expect(coerceHint(col({ columnType: 'PgInteger' }))).toBe('number');
    expect(coerceHint(col({ columnType: 'PgBigInt64' }))).toBe('number');
    expect(coerceHint(col({ columnType: 'PgNumeric' }))).toBe('number');
  });
  it('says "true / false" for booleans and "text" otherwise', () => {
    expect(coerceHint(col({ columnType: 'PgBoolean' }))).toBe('true / false');
    expect(coerceHint(col({ columnType: 'PgText' }))).toBe('text');
  });
});

describe('isHarnessSlugCell', () => {
  it('is true only for harness_slug / install_slug string cells', () => {
    expect(isHarnessSlugCell('harness_slug', 'my-harness')).toBe(true);
    expect(isHarnessSlugCell('install_slug', 'x')).toBe(true);
    expect(isHarnessSlugCell('other_col', 'x')).toBe(false);
  });
  it('is false for null/empty/non-string values even on a slug column', () => {
    expect(isHarnessSlugCell('harness_slug', null)).toBe(false);
    expect(isHarnessSlugCell('harness_slug', '')).toBe(false);
    expect(isHarnessSlugCell('harness_slug', 123)).toBe(false);
  });
});

describe('valueToLabel', () => {
  it('renders ∅ for null/undefined', () => {
    expect(valueToLabel(null)).toBe('∅');
    expect(valueToLabel(undefined)).toBe('∅');
  });
  it('passes through short strings and stringifies primitives', () => {
    expect(valueToLabel('hi')).toBe('hi');
    expect(valueToLabel(7)).toBe('7');
    expect(valueToLabel(true)).toBe('true');
  });
  it('truncates a long string to 37 chars + ellipsis', () => {
    const out = valueToLabel('x'.repeat(60));
    expect(out).toBe('x'.repeat(37) + '…');
  });
  it('JSON-stringifies objects, capped at 40 chars', () => {
    expect(valueToLabel({ a: 1 })).toBe('{"a":1}');
    expect(valueToLabel({ k: 'y'.repeat(100) }).length).toBe(40);
  });
});

describe('renderCell', () => {
  it('renders ∅ / booleans / numbers', () => {
    expect(renderCell(null)).toBe('∅');
    expect(renderCell(false)).toBe('false');
    expect(renderCell(3)).toBe('3');
  });
  it('truncates long strings to 197 + ellipsis', () => {
    expect(renderCell('a'.repeat(300))).toBe('a'.repeat(197) + '…');
  });
  it('JSON-stringifies objects', () => {
    expect(renderCell({ x: 1 })).toBe('{"x":1}');
  });
});

describe('filterChipLabel', () => {
  const mk = (over: Partial<Filter>): Filter => ({ col: 'status', op: 'eq', value: 'ok', ...over });

  it('renders "col OP value" for a scalar eq filter', () => {
    expect(filterChipLabel(mk({}))).toBe('status = ok');
  });
  it('omits the value for valueless ops (IS NULL)', () => {
    expect(filterChipLabel(mk({ op: 'isnull', value: null }))).toBe('status IS NULL');
  });
  it('lists up to four IN values then "+N more"', () => {
    const f = mk({ op: 'in', value: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(filterChipLabel(f)).toBe('status IN (a, b, c, d, …2 more)');
  });
  it('lists all IN values when four or fewer', () => {
    expect(filterChipLabel(mk({ op: 'in', value: ['a', 'b'] }))).toBe('status IN (a, b)');
  });
});
