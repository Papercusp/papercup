/**
 * pg-read-query.test.ts — unit coverage for the single-read-statement guard
 * (the defense-in-depth check; the READ ONLY transaction is the real
 * enforcement, covered in pg-read-query.integration.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { assertSingleReadStatement, PgReadQueryError } from './pg-read-query';

describe('assertSingleReadStatement', () => {
  it('accepts a plain SELECT and strips a single trailing semicolon', () => {
    expect(assertSingleReadStatement('SELECT 1')).toBe('SELECT 1');
    expect(assertSingleReadStatement('  SELECT 1 ;  ')).toBe('SELECT 1');
  });

  it('accepts a WITH…SELECT (CTE)', () => {
    const q = 'WITH t AS (SELECT 1 AS n) SELECT * FROM t';
    expect(assertSingleReadStatement(q)).toBe(q);
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(assertSingleReadStatement('select 1')).toBe('select 1');
    expect(assertSingleReadStatement('  WiTh t as (select 1) select * from t')).toMatch(/^WiTh/);
  });

  it('rejects an empty query', () => {
    expect(() => assertSingleReadStatement('   ')).toThrow(PgReadQueryError);
  });

  it('rejects multiple statements (no `;`-separated injection)', () => {
    expect(() => assertSingleReadStatement('SELECT 1; DROP TABLE foo')).toThrow(/single statement/i);
    expect(() => assertSingleReadStatement('SELECT 1; SELECT 2')).toThrow(PgReadQueryError);
  });

  it('rejects a non-read leading statement (INSERT/UPDATE/DELETE/DDL)', () => {
    for (const q of [
      'INSERT INTO foo VALUES (1)',
      'UPDATE foo SET x = 1',
      'DELETE FROM foo',
      'DROP TABLE foo',
      'CREATE TABLE foo (id int)',
      'TRUNCATE foo',
      'ALTER TABLE foo ADD COLUMN x int',
    ]) {
      expect(() => assertSingleReadStatement(q), q).toThrow(/read-only/i);
    }
  });
});
