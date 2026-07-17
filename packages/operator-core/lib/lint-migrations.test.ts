/**
 * Audit P-074 (EI-170) — lint:migrations logic:
 *   - dollar-quote/comment/string-aware stripping so plpgsql BEGIN…END never
 *     false-positives the raw-transaction-control check,
 *   - top-level BEGIN;/COMMIT;/ROLLBACK;/START TRANSACTION detection,
 *   - duplicate-NNN grouping,
 *   - unreserved-number detection from the ENFORCED_FROM epoch,
 *   - unguarded RENAME CONSTRAINT detection (WI-4547).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripSqlBodies,
  findRawTxControl,
  findUnguardedConstraintRename,
  findLiteralTenantDefault,
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

// WI-4547: `ALTER TABLE IF EXISTS t RENAME CONSTRAINT x TO y` reads as guarded and
// is not — IF EXISTS binds the TABLE, not the CONSTRAINT, so an absent constraint
// still throws 42704 and aborts the migration. Migration 592 hit exactly this (an
// earlier migration had dropped the constraint's column, taking the CHECK with it),
// failed on EVERY database, and broke every fresh-DB integration test in the repo.
// It survived review precisely because it LOOKS guarded — which is why it needs a lint.
describe('findUnguardedConstraintRename', () => {
  it('flags a bare RENAME CONSTRAINT — including the deceptive ALTER TABLE IF EXISTS form', () => {
    expect(
      findUnguardedConstraintRename(
        'ALTER TABLE harness_shared.t RENAME CONSTRAINT old_pkey TO new_pkey;\n',
      ),
    ).toEqual(['old_pkey']);
    // The exact shape that shipped in 592 and failed everywhere: the IF EXISTS
    // makes it read as safe, so this MUST still be caught.
    expect(
      findUnguardedConstraintRename(
        'ALTER TABLE IF EXISTS harness_shared.t\n  RENAME CONSTRAINT a_nonempty TO b_nonempty;\n',
      ),
    ).toEqual(['a_nonempty']);
  });

  it('accepts the guarded DO-block form (the prescribed fix shape)', () => {
    // Renames inside a dollar-quoted body are stripped, so the conditional form
    // — rename only if the old name exists and the new one does not — passes.
    const guarded = [
      'DO $$',
      'BEGIN',
      '  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $q$old_pkey$q$) THEN',
      '    ALTER TABLE harness_shared.t RENAME CONSTRAINT old_pkey TO new_pkey;',
      '  END IF;',
      'END $$;',
    ].join('\n');
    expect(findUnguardedConstraintRename(guarded)).toEqual([]);
  });

  it('does not flag a genuinely-guarded ALTER INDEX IF EXISTS … RENAME TO', () => {
    // Here IF EXISTS binds to the INDEX itself, so it really is guarded — a
    // false positive would push authors toward pointless DO-block ceremony.
    expect(
      findUnguardedConstraintRename(
        'ALTER INDEX IF EXISTS harness_shared.old_idx RENAME TO new_idx;\n',
      ),
    ).toEqual([]);
  });

  it('ignores RENAME CONSTRAINT mentioned in a comment', () => {
    expect(findUnguardedConstraintRename('-- never do a bare RENAME CONSTRAINT x TO y\n')).toEqual([]);
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

  // WI-4547. The instance (592) is fixed; this is the recurrence guard, wired into
  // the same gate-run block as checks 1–2 so the CLASS cannot come back silently.
  // A bare RENAME CONSTRAINT aborts its migration with 42704 the moment the
  // constraint is absent — which takes down every fresh-DB integration test at once.
  it('has no unguarded RENAME CONSTRAINT in an enforced-era migration', () => {
    const violations: string[] = [];
    for (const f of files) {
      const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
      if (num < ENFORCED_FROM) continue; // applied history: immutable, and it already survived
      const hits = findUnguardedConstraintRename(readFileSync(join(SQL_DIR, f), 'utf8'));
      if (hits.length) violations.push(`${f}: ${hits.join(', ')}`);
    }
    expect(violations).toEqual([]);
  });

  // WI-5125 / WI-5243. Same shape as the RENAME guard above: the instances are
  // corrected (migration 616), this stops the CLASS from silently returning.
  it('has no literal tenant-column DEFAULT in an enforced-era migration', () => {
    const violations: string[] = [];
    for (const f of files) {
      const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
      if (num < ENFORCED_FROM) continue; // applied history: immutable (sha256-verified by the runner)
      const hits = findLiteralTenantDefault(readFileSync(join(SQL_DIR, f), 'utf8'));
      // WI-5217: `hits` is `any[]` (the .mjs import has no declaration file — a
      // pre-existing, baselined TS7016), so the callback param needs an explicit
      // type to avoid a NEW noImplicitAny error; shape per findLiteralTenantDefault.
      if (hits.length)
        violations.push(
          `${f}: ${hits.map((h: { column: string; value: string }) => `${h.column}=${h.value}`).join(', ')}`,
        );
    }
    expect(violations).toEqual([]);
  });
});

/**
 * WI-5125 — a literal DEFAULT on a tenant-scoping column silently mis-tenants
 * every writer that omits it. The INSERT still SUCCEEDS, so nothing fails loudly:
 * it shipped 181/181 mis-tenanted agent_chats rows and reached the owner as a chat
 * panel spinning on "loading chat…" forever.
 */
describe('findLiteralTenantDefault', () => {
  it('flags the exact DDL that caused WI-5125 (migration 116)', () => {
    // Verbatim shape from 116-consolidate-agent-chats.sql: the literal rides a
    // format() %L arg, INSIDE a per-schema DO $$ … $$ loop.
    const sql = `DO $mig$ BEGIN
      EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    END $mig$;`;
    expect(findLiteralTenantDefault(sql)).toEqual([{ column: 'workspace_id', value: '%L' }]);
  });

  it('flags a direct quoted literal too', () => {
    const sql = `ALTER VIEW s.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default';`;
    expect(findLiteralTenantDefault(sql)).toEqual([{ column: 'workspace_id', value: "'default'" }]);
  });

  // The load-bearing reason this scans RAW text while its siblings scan stripped
  // text: the real ALTERs live inside a DO $$ … $$ body, so a stripped scan sees
  // NOTHING and passes. That false green is the whole bug.
  it('still catches it despite the DO-block body (why it does not use stripSqlBodies)', () => {
    const sql = `DO $$ BEGIN
      EXECUTE format('ALTER VIEW %I.messages ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    END $$;`;
    expect(stripSqlBodies(sql)).not.toMatch(/workspace_id/); // the body is gone …
    expect(findLiteralTenantDefault(sql)).toHaveLength(1); // … but the lint still sees it
  });

  it('does NOT flag a DERIVED default — deriving the tenant is the correct shape', () => {
    expect(
      findLiteralTenantDefault(
        `ALTER VIEW s.t ALTER COLUMN workspace_id SET DEFAULT current_setting('app.workspace_id', true);`,
      ),
    ).toEqual([]);
  });

  it('does NOT flag a literal on a non-tenant column (harness_slug/created_at are knowable in DDL)', () => {
    const sql = [
      `ALTER VIEW s.t ALTER COLUMN harness_slug SET DEFAULT 'papercusp';`,
      `ALTER VIEW s.t ALTER COLUMN transcript SET DEFAULT '[]'::jsonb;`,
    ].join('\n');
    expect(findLiteralTenantDefault(sql)).toEqual([]);
  });

  // A lint that fires on the migration FIXING the bug it detects is a lint people
  // delete. 616 quotes the offending DDL in its header comment to explain itself.
  it('does NOT flag offending DDL quoted inside a comment', () => {
    const sql = [
      `-- ALTER VIEW <schema>.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default'`,
      `/* also ALTER VIEW x ALTER COLUMN workspace_id SET DEFAULT 'default' */`,
      `ALTER TABLE harness_shared.agent_chats_consolidated ALTER COLUMN workspace_id DROP DEFAULT;`,
    ].join('\n');
    expect(findLiteralTenantDefault(sql)).toEqual([]);
  });
});
