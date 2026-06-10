/**
 * Audit P-074 (EI-170) — lint:migrations logic:
 *   - dollar-quote/comment/string-aware stripping so plpgsql BEGIN…END never
 *     false-positives the raw-transaction-control check,
 *   - top-level BEGIN;/COMMIT;/ROLLBACK;/START TRANSACTION detection,
 *   - duplicate-NNN grouping,
 *   - unreserved-number detection from the ENFORCED_FROM epoch.
 */
import { describe, expect, it } from 'vitest';
import {
  stripSqlBodies,
  findRawTxControl,
  duplicateNumberGroups,
  unreservedNumbers,
  ENFORCED_FROM,
  // eslint-disable-next-line import/no-relative-packages
} from '../../../scripts/lint-migrations.mjs';

describe('stripSqlBodies', () => {
  it('removes dollar-quoted bodies (anonymous and tagged)', () => {
    const sql = [
      'CREATE FUNCTION f() RETURNS trigger AS $$',
      'BEGIN',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'CREATE FUNCTION g() AS $body$ BEGIN; COMMIT; $body$ LANGUAGE sql;',
    ].join('\n');
    const stripped = stripSqlBodies(sql);
    expect(stripped).not.toContain('RETURN NEW');
    expect(stripped).not.toContain('COMMIT');
    expect(stripped).toContain('CREATE FUNCTION');
  });

  it('removes line comments, block comments, and quoted strings', () => {
    const sql = "-- BEGIN;\n/* COMMIT; */\nINSERT INTO t VALUES ('BEGIN;');\n";
    const stripped = stripSqlBodies(sql);
    expect(stripped).not.toContain('BEGIN');
    expect(stripped).not.toContain('COMMIT');
  });
});

describe('findRawTxControl', () => {
  it('flags top-level transaction control', () => {
    expect(findRawTxControl('BEGIN;\nCREATE TABLE t (a int);\nCOMMIT;\n'))
      .toEqual(['BEGIN;', 'COMMIT']);
    expect(findRawTxControl('START TRANSACTION;\nROLLBACK;\n'))
      .toEqual(['START TRANSACTION', 'ROLLBACK']);
  });

  it('ignores plpgsql bodies and comments', () => {
    const sql = [
      '-- runner wraps: BEGIN;',
      'CREATE OR REPLACE FUNCTION trg() RETURNS trigger AS $$',
      'BEGIN',
      "  NEW.x := 'COMMIT;';",
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'CREATE TABLE t (a int);',
    ].join('\n');
    expect(findRawTxControl(sql)).toEqual([]);
  });

  it('does not confuse CASE…END with transaction control', () => {
    const sql = 'CREATE VIEW v AS SELECT CASE WHEN a THEN 1 ELSE 2 END AS c FROM t;';
    expect(findRawTxControl(sql)).toEqual([]);
  });
});

describe('duplicateNumberGroups', () => {
  it('groups files sharing a numeric prefix', () => {
    const groups = duplicateNumberGroups([
      '131-engineer-issues.sql',
      '131-other-thing.sql',
      '132-fine.sql',
      'README.md',
    ]);
    expect(groups).toEqual([
      { num: 131, files: ['131-engineer-issues.sql', '131-other-thing.sql'] },
    ]);
  });
});

describe('unreservedNumbers', () => {
  it('flags on-disk numbers ≥ epoch missing from the reservation set', () => {
    const reserved = new Set([215, 216, 218]);
    expect(unreservedNumbers([200, 214, 215, 216, 217, 218], reserved)).toEqual([217]);
  });

  it('grandfathers pre-epoch numbers', () => {
    expect(unreservedNumbers([100, 150, ENFORCED_FROM - 1], new Set())).toEqual([]);
  });
});
