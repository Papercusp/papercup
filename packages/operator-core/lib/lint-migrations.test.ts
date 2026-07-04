/**
 * Audit P-074 (EI-170) — lint:migrations logic:
 *   - dollar-quote/comment/string-aware stripping so plpgsql BEGIN…END never
 *     false-positives the raw-transaction-control check,
 *   - top-level BEGIN;/COMMIT;/ROLLBACK;/START TRANSACTION detection,
 *   - duplicate-NNN grouping,
 *   - unreserved-number detection from the ENFORCED_FROM epoch.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  it('groups files sharing a numeric prefix (below the enforced boundary, pass 0 to test pure grouping)', () => {
    const groups = duplicateNumberGroups(
      ['131-engineer-issues.sql', '131-other-thing.sql', '132-fine.sql', 'README.md'],
      0,
    );
    expect(groups).toEqual([
      { num: 131, files: ['131-engineer-issues.sql', '131-other-thing.sql'] },
    ]);
  });

  it('grandfathers a duplicate below the enforced boundary (the default) — already-applied ledgered history', () => {
    const groups = duplicateNumberGroups(['131-engineer-issues.sql', '131-other-thing.sql'], 200);
    expect(groups).toEqual([]);
  });
});

describe('unreservedNumbers', () => {
  it('flags on-disk numbers ≥ epoch missing from the reservation set', () => {
    const reserved = new Set([215, 216, 218]);
    expect(unreservedNumbers([200, 214, 215, 216, 217, 218], reserved, 215)).toEqual([217]);
  });

  it('grandfathers pre-epoch numbers', () => {
    expect(unreservedNumbers([100, 150, ENFORCED_FROM - 1], new Set())).toEqual([]);
  });
});

// EI-6843: `lint:migrations` (scripts/lint-migrations.mjs) exists and is
// unit-tested above, but its real filesystem SCAN was never wired into any
// automated gate — only a manual `npm run lint:migrations` invoked it, which
// nobody ran, so the exact "two agents raced ls and collided on the same NNN"
// incident this ticket reports would NOT have been caught by CI even though
// the checking logic already existed. Running the pure-filesystem checks (1:
// duplicate NNN, 2: raw transaction control) against the REAL sql/ dir here
// means `npm run test:affected` — which the green-checkpoint gate runs on
// every candidate — now catches both classes automatically. (Check 3,
// unreserved-number, needs a live PG connection and is exercised by the CLI's
// own fail-soft-when-unreachable path; not duplicated here.)
describe('the real libs/papercusp/libs/db/sql/ directory (gate wiring)', () => {
  const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));

  it('has no two migration files sharing a numeric prefix', () => {
    expect(duplicateNumberGroups(files)).toEqual([]);
  });

  it('has no top-level BEGIN/COMMIT/ROLLBACK in an enforced-era migration', () => {
    const violations: string[] = [];
    for (const f of files) {
      const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
      if (num < ENFORCED_FROM) continue; // pre-contract files are grandfathered (ledgered history)
      const hits = findRawTxControl(readFileSync(join(SQL_DIR, f), 'utf8'));
      if (hits.length) violations.push(`${f}: ${hits.join(', ')}`);
    }
    expect(violations).toEqual([]);
  });
});
