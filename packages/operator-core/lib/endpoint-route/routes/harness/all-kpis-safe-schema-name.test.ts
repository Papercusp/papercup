import { describe, expect, it } from 'vitest';
import { filterSafeSchemaNames, isSafeSchemaName } from './all-kpis-safe-schema-name';

describe('isSafeSchemaName', () => {
  it('accepts a plain harness schema name', () => {
    expect(isSafeSchemaName('harness_papercusp')).toBe(true);
    expect(isSafeSchemaName('harness_my_pot_2')).toBe(true);
    expect(isSafeSchemaName('_leading_underscore')).toBe(true);
  });

  it('rejects names starting with a digit', () => {
    expect(isSafeSchemaName('2fast')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSafeSchemaName('')).toBe(false);
  });

  it('rejects names with a SQL-injection-shaped payload', () => {
    expect(isSafeSchemaName('harness_x; DROP TABLE users; --')).toBe(false);
    expect(isSafeSchemaName("harness_x' OR '1'='1")).toBe(false);
    expect(isSafeSchemaName('harness_x.other_schema')).toBe(false);
    expect(isSafeSchemaName('harness x')).toBe(false);
  });

  it('rejects names with hyphens (not a valid unquoted Postgres identifier)', () => {
    expect(isSafeSchemaName('harness-slug')).toBe(false);
  });
});

describe('filterSafeSchemaNames', () => {
  it('keeps only safe names, preserving order', () => {
    expect(
      filterSafeSchemaNames(['harness_a', 'harness-b', 'harness_c', "harness_d'; --"]),
    ).toEqual(['harness_a', 'harness_c']);
  });

  it('returns an empty array for an empty input', () => {
    expect(filterSafeSchemaNames([])).toEqual([]);
  });

  it('accepts a Set as well as an array', () => {
    expect(filterSafeSchemaNames(new Set(['harness_a', '1bad']))).toEqual(['harness_a']);
  });
});
