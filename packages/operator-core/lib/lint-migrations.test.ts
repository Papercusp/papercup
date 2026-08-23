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
// eslint-disable-next-line import/no-relative-packages
import { stripSqlCommentsAndStrings } from '../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  findRawTxControl,
  findUnguardedConstraintRename,
  findUnguardedReslug,
  findLiteralTenantDefault,
  findUniqueIndexShapeSwap,
  duplicateNumberGroups,
  unreservedNumbers,
  reservationFilenameMismatches,
  partitionRawTxControl,
  unappliedFrozenExemptions,
  FROZEN_TXCTL_EXEMPTIONS,
  ENFORCED_FROM,
  INDEX_SWAP_ENFORCED_FROM,
  // eslint-disable-next-line import/no-relative-packages
} from '../../../scripts/lint-migrations.mjs';

/*
 * WI-41119 — the frozen-exemption path.
 *
 * Background: check #2 fails a file ≥ ENFORCED_FROM carrying top-level
 * BEGIN/COMMIT and says "remove it". Once that file is APPLIED, the
 * migration-immutability guard refuses the edit, and a later migration cannot
 * change the old file's bytes — so the check went permanently red and, because
 * lint:migrations is a green-checkpoint gate check, red-pinned the gate.
 *
 * The exemption must NOT be "any applied file": the gate applies pending
 * migrations before judging, so a fresh offender would be applied — and exempt —
 * exactly when the check should fire. Hence a deliberate list, guarded by the
 * requirement that a listed file really is applied.
 */
const TXCTL_SQL = 'BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;\n';
const CLEAN_SQL = 'ALTER TABLE t ADD COLUMN c int;\n';

describe('partitionRawTxControl (WI-41119 frozen exemptions)', () => {
  it('CONTROL: a clean file is neither offender, grandfathered, nor exempt', () => {
    const r = partitionRawTxControl([{ file: '900-clean.sql', text: CLEAN_SQL }]);
    expect(r).toEqual({ offenders: [], grandfathered: 0, exempted: [] });
  });

  it('flags an un-listed offender at or above ENFORCED_FROM', () => {
    const r = partitionRawTxControl([
      { file: `${ENFORCED_FROM}-fresh-offender.sql`, text: TXCTL_SQL },
    ]);
    expect(r.offenders.map((o) => o.file)).toEqual([`${ENFORCED_FROM}-fresh-offender.sql`]);
    expect(r.exempted).toEqual([]);
  });

  it('grandfathers an offender below ENFORCED_FROM by count, not as a failure', () => {
    const r = partitionRawTxControl([
      { file: `${ENFORCED_FROM - 1}-legacy.sql`, text: TXCTL_SQL },
    ]);
    expect(r.offenders).toEqual([]);
    expect(r.grandfathered).toBe(1);
  });

  it('moves a LISTED file out of offenders and into exempted, carrying its reason', () => {
    const exemptions = new Map([['950-frozen.sql', 'applied; immutability guard refuses the edit']]);
    const r = partitionRawTxControl([{ file: '950-frozen.sql', text: TXCTL_SQL }], { exemptions });
    expect(r.offenders).toEqual([]);
    expect(r.exempted).toHaveLength(1);
    expect(r.exempted[0]).toMatchObject({ file: '950-frozen.sql' });
    expect(r.exempted[0].reason).toMatch(/applied/);
  });

  it('does NOT let an exemption leak to a different file (the check keeps its teeth)', () => {
    const exemptions = new Map([['950-frozen.sql', 'reason']]);
    const r = partitionRawTxControl(
      [
        { file: '950-frozen.sql', text: TXCTL_SQL },
        { file: '951-not-listed.sql', text: TXCTL_SQL },
      ],
      { exemptions },
    );
    expect(r.offenders.map((o) => o.file)).toEqual(['951-not-listed.sql']);
    expect(r.exempted.map((e) => e.file)).toEqual(['950-frozen.sql']);
  });
});

describe('unappliedFrozenExemptions — the list cannot become a bypass', () => {
  it('hard-errors on a listed file that is NOT applied (still editable ⇒ must be fixed)', () => {
    const exemptions = new Map([['950-frozen.sql', 'reason']]);
    expect(unappliedFrozenExemptions(new Set<string>(), exemptions)).toEqual(['950-frozen.sql']);
  });

  it('CONTROL: a listed file that IS applied is accepted', () => {
    const exemptions = new Map([['950-frozen.sql', 'reason']]);
    expect(unappliedFrozenExemptions(new Set(['950-frozen.sql']), exemptions)).toEqual([]);
  });

  it('every real exemption states a non-empty reason (an entry is an admission, not a shrug)', () => {
    for (const [file, reason] of FROZEN_TXCTL_EXEMPTIONS) {
      expect(typeof reason, `${file} must carry a reason`).toBe('string');
      expect(reason.trim().length, `${file} reason must be substantive`).toBeGreaterThan(40);
    }
  });
});

/*
 * PER-CALL-SITE DOLLAR-QUOTE MASKING (WI-37800).
 *
 * These replace unit tests of the old private `stripSqlBodies`, and they are deliberately
 * written against the EXPORTED DETECTORS rather than a mask function: the bug this file now
 * pins was never in a stripper's output, it was in WHICH stripper each detector called.
 * Testing the helper could not have caught it — every mask involved was individually correct.
 *
 * Each `PROVES FIX` case was verified to FAIL against the real pre-change entrypoint
 * (commit 69118503, extracted and run out-of-tree) before being written here. The
 * `preserved` cases passed before and after, and exist so the fix cannot regress into
 * over-correction.
 */
describe('per-call-site dollar-quote masking', () => {
  // The tag regex was /^\$[A-Za-z_]*\$/ — no DIGITS — so `$mig377$` was not recognised as a
  // dollar quote at all and its body stayed live for every detector.
  it('PROVES FIX: a COMMIT inside a DIGIT-tagged body is not top-level tx control', () => {
    expect(findRawTxControl('DO $mig377$\nBEGIN\n  COMMIT;\nEND\n$mig377$;')).toEqual([]);
  });

  it('PROVES FIX: an in-DO rename is the documented FIX shape, not a violation', () => {
    expect(
      findUnguardedConstraintRename('DO $mig1$\nBEGIN\n  ALTER TABLE t RENAME CONSTRAINT a TO b;\nEND\n$mig1$;'),
    ).toEqual([]);
  });

  it('preserved: a top-level rename is still caught', () => {
    expect(findUnguardedConstraintRename('ALTER TABLE IF EXISTS t RENAME CONSTRAINT a TO b;')).toHaveLength(1);
  });

  // The false NEGATIVE the split exists to close: sealing every body hides real DDL.
  it('PROVES FIX: an in-DO unique-constraint swap is caught under a LETTER tag', () => {
    const sql =
      'DO $mig$\nBEGIN\n  ALTER TABLE t DROP CONSTRAINT t_ident;\n' +
      '  ALTER TABLE t ADD CONSTRAINT t_ident UNIQUE (a, b);\nEND\n$mig$;';
    expect(findUniqueIndexShapeSwap(sql)).toHaveLength(1);
  });

  it('preserved: migration 377 (DIGIT tag) is still caught — now by design, not by accident', () => {
    const sql =
      'DO $mig377$\nBEGIN\n  ALTER TABLE t DROP CONSTRAINT t_ident;\n' +
      '  ALTER TABLE t ADD CONSTRAINT t_ident UNIQUE (a, b);\nEND\n$mig377$;';
    expect(findUniqueIndexShapeSwap(sql)).toHaveLength(1);
  });

  /*
   * The near-miss this pins. findUnguardedReslug looks like it wants bodies live for the same
   * reason findUniqueIndexShapeSwap does — a reslug inside a body really executes. It does not,
   * because it DISARMS itself on a guard token found anywhere in the FILE. Unsealing bodies was
   * measured on 382-operator-issue-scope-removal.sql to find MORE offences (2, not 1) and report
   * NONE, because an unrelated DELETE inside a trigger body read as a dedup guard for a
   * top-level UPDATE it has nothing to do with.
   */
  it('a DELETE inside a function body must NOT disarm a top-level unguarded reslug', () => {
    const sql =
      "UPDATE harness_shared.work_items SET harness_slug = 'operator:x' WHERE harness_slug = '';\n" +
      'CREATE FUNCTION f() RETURNS trigger AS $fn$\nBEGIN\n' +
      '  DELETE FROM harness_shared.work_items WHERE id = 1;\nEND\n$fn$ LANGUAGE plpgsql;';
    expect(findUnguardedReslug(sql)).toHaveLength(1);
  });
});

describe('findRawTxControl', () => {
  it('flags top-level transaction control', () => {
    expect(findRawTxControl('BEGIN;\nCREATE TABLE t (a int);\nCOMMIT;\n')).toEqual(['BEGIN;', 'COMMIT']);
    expect(findRawTxControl('START TRANSACTION;\nROLLBACK;\n')).toEqual(['START TRANSACTION', 'ROLLBACK']);
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
      findUnguardedConstraintRename('ALTER TABLE harness_shared.t RENAME CONSTRAINT old_pkey TO new_pkey;\n'),
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
    expect(findUnguardedConstraintRename('ALTER INDEX IF EXISTS harness_shared.old_idx RENAME TO new_idx;\n')).toEqual(
      [],
    );
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
    expect(groups).toEqual([{ num: 131, files: ['131-engineer-issues.sql', '131-other-thing.sql'] }]);
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

describe('reservationFilenameMismatches', () => {
  it('rejects an unreserved filename that hijacks a peer reservation number', () => {
    expect(
      reservationFilenameMismatches(
        ['880-session-turn-parts-backfill.sql'],
        [{ num: 880, filename: '880-oauth-flow-private-context.sql' }],
      ),
    ).toEqual([
      {
        num: 880,
        file: '880-session-turn-parts-backfill.sql',
        reservedFilename: '880-oauth-flow-private-context.sql',
      },
    ]);
  });

  it('accepts an exact filename reservation and grandfathers pre-epoch history', () => {
    expect(
      reservationFilenameMismatches(
        ['493-legacy.sql', '881-goal-usage-attribution.sql'],
        [
          { num: 493, filename: '493-other.sql' },
          { num: 881, filename: '881-goal-usage-attribution.sql' },
        ],
      ),
    ).toEqual([]);
  });

  it('grandfathers TODO placeholders only for the exact already-applied final file', () => {
    const files = ['518-p2p-fleet-leader-leases.sql'];
    const reservations = [{ num: 518, filename: '518-TODO-rename.sql' }];
    expect(
      reservationFilenameMismatches(files, reservations, {
        appliedFilenames: new Set(files),
      }),
    ).toEqual([]);
    expect(reservationFilenameMismatches(files, reservations)).toEqual([
      {
        num: 518,
        file: '518-p2p-fleet-leader-leases.sql',
        reservedFilename: '518-TODO-rename.sql',
      },
    ]);
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

  // WI-41119: this must partition exactly as the CLI does, or the two disagree and
  // the gate stays red on a file the CLI has already accounted for. It deliberately
  // uses partitionRawTxControl rather than re-deriving the rule from findRawTxControl,
  // so a FROZEN file (applied ⇒ the immutability guard refuses the edit the lint
  // prescribes) is not reported as a fixable violation here either.
  it('has no top-level BEGIN/COMMIT/ROLLBACK in an enforced-era migration', () => {
    const { offenders } = partitionRawTxControl(
      files.map((f) => ({ file: f, text: readFileSync(join(SQL_DIR, f), 'utf8') })),
    );
    expect(offenders.map((o) => `${o.file}: ${o.hits.join(', ')}`)).toEqual([]);
  });

  // The exemption list is only legitimate for files that are genuinely frozen, and
  // "frozen" means present on disk. A stale entry for a deleted/renamed file would
  // silently widen the exemption surface, so it fails here.
  it('every FROZEN_TXCTL_EXEMPTIONS entry names a file that still exists and still offends', () => {
    for (const file of FROZEN_TXCTL_EXEMPTIONS.keys()) {
      expect(files, `${file} is exempted but not present in sql/`).toContain(file);
      expect(
        findRawTxControl(readFileSync(join(SQL_DIR, file), 'utf8')).length,
        `${file} no longer has top-level tx control — remove its exemption`,
      ).toBeGreaterThan(0);
    }
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

  // EI-18786592200395716. The instances (461, 564, 689) are applied history and
  // grandfathered; this stops the CLASS. Same gate-run block as the checks above,
  // so a NEW same-migration index swap reds here rather than an hour into a
  // fleet-wide write outage.
  it('has no same-migration unique-index shape swap in an enforced-era migration', () => {
    const violations: string[] = [];
    for (const f of files) {
      const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
      if (num < INDEX_SWAP_ENFORCED_FROM) continue; // applied history: immutable (sha256-verified)
      const hits = findUniqueIndexShapeSwap(readFileSync(join(SQL_DIR, f), 'utf8'));
      if (hits.length)
        violations.push(
          `${f}: ${hits.map((h: { index: string; dropped: string[] }) => `${h.index} ← ${h.dropped.join('/')}`).join(', ')}`,
        );
    }
    expect(violations).toEqual([]);
  });
});

/**
 * EI-18786592200395716 — migration 689 made `agent_facts_identity` PARTIAL and
 * dropped the old index in the same file. PostgreSQL infers an ON CONFLICT target
 * by MATCHING a unique index, so every spec written against the old shape then
 * matched no index and failed AT PLAN TIME — every write, not just conflicting
 * ones. On a shared DB the migration lands when any operator boots while code
 * lands per-deploy, so `facts:assert` was down fleet-wide for an hour with the
 * fix already committed. 461 did the same to this table in 2026-07 and 564 to
 * memory_canonical, so the guard is for a three-time class.
 */
describe('findUniqueIndexShapeSwap (the migration-461/564/689 outage class)', () => {
  const SWAP_689 = `CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current
  ON harness_shared.agent_facts
     (workspace_id, scope, COALESCE(scope_ref, ''::text), key)
  WHERE superseded_at IS NULL;
DROP INDEX IF EXISTS harness_shared.agent_facts_identity;`;

  it('flags a partial-index replacement that drops its predecessor in the same file', () => {
    const hits = findUniqueIndexShapeSwap(SWAP_689);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      index: 'agent_facts_identity_current',
      table: 'agent_facts',
      partial: true,
    });
    expect(hits[0].dropped).toContain('agent_facts_identity');
  });

  it('flags a same-NAME rebuild (the 461/564 shape, where only the columns change)', () => {
    // The dropped index's own shape is unknowable from a DROP, so a same-name
    // drop+recreate is flagged too — it is the exact 461 statement pair that
    // produced zero fact writes until 2026-07-03.
    const hits = findUniqueIndexShapeSwap(
      `DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
       CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity
         ON harness_shared.agent_facts (workspace_id, scope, key, coalesce(source_hive, ''));`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ table: 'agent_facts', partial: false });
  });

  it('does NOT flag a drop of an index on an UNRELATED table (the migration-506 false positive)', () => {
    // 506 drops a spawned_agents index and creates unique indexes on four other
    // tables ~190 lines later. A creates-unique-and-drops rule would fire here;
    // the table-scoped rule must not.
    expect(
      findUniqueIndexShapeSwap(
        `DROP INDEX IF EXISTS harness_shared.spawned_agents_fleet_slug_running_idx;
         CREATE UNIQUE INDEX IF NOT EXISTS cross_hive_asks_correlation_pot_uniq
           ON harness_shared.cross_hive_asks (workspace_id, correlation_id);`,
      ),
    ).toEqual([]);
  });

  it('does NOT flag a two-phase migration that only CREATES the new index', () => {
    expect(
      findUniqueIndexShapeSwap(
        `CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current
           ON harness_shared.agent_facts (workspace_id, key) WHERE superseded_at IS NULL;`,
      ),
    ).toEqual([]);
  });

  it('does NOT flag the later phase that only DROPS the old index', () => {
    expect(findUniqueIndexShapeSwap('DROP INDEX IF EXISTS harness_shared.agent_facts_identity;')).toEqual([]);
  });

  it('honours the allow-index-swap pragma when it carries a reason', () => {
    expect(
      findUniqueIndexShapeSwap(
        `-- lint-migrations: allow-index-swap brand-new table, no deployed readers\n${SWAP_689}`,
      ),
    ).toEqual([]);
  });

  it('still flags a bare pragma with no reason', () => {
    expect(findUniqueIndexShapeSwap(`-- lint-migrations: allow-index-swap\n${SWAP_689}`)).toHaveLength(1);
  });

  it('ignores a swap that appears only inside a comment', () => {
    expect(
      findUniqueIndexShapeSwap(
        `-- DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
         -- CREATE UNIQUE INDEX agent_facts_identity ON harness_shared.agent_facts (key);
         SELECT 1;`,
      ),
    ).toEqual([]);
  });

  /**
   * A UNIQUE *constraint* is implemented BY a unique index and is inferable by
   * `ON CONFLICT` identically, so the constraint spelling of either side is the
   * same hazard. Matching only the INDEX spelling left a bypass reachable by an
   * idiom this repo already uses 14 times — the 689 outage re-authored as
   * `DROP CONSTRAINT` + `CREATE UNIQUE INDEX … WHERE` went through clean.
   */
  describe('constraint-backed spellings of the same swap', () => {
    it('flags DROP CONSTRAINT + CREATE UNIQUE INDEX (the 689 outage, re-spelled)', () => {
      const hits = findUniqueIndexShapeSwap(
        `ALTER TABLE harness_shared.agent_facts DROP CONSTRAINT agent_facts_identity_key;
         CREATE UNIQUE INDEX agent_facts_identity_current
           ON harness_shared.agent_facts (workspace_id, key) WHERE superseded_at IS NULL;`,
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        index: 'agent_facts_identity_current',
        table: 'agent_facts',
        partial: true,
        dropped: ['agent_facts_identity_key'],
      });
    });

    it('flags DROP INDEX + ADD CONSTRAINT … UNIQUE (replacement created as a constraint)', () => {
      const hits = findUniqueIndexShapeSwap(
        `DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
         ALTER TABLE harness_shared.agent_facts
           ADD CONSTRAINT agent_facts_identity_key UNIQUE (workspace_id, key);`,
      );
      expect(hits).toHaveLength(1);
      // A UNIQUE constraint cannot carry a predicate, so it is never partial.
      expect(hits[0]).toMatchObject({ table: 'agent_facts', partial: false });
    });

    it('flags both actions carried by ONE comma-separated ALTER TABLE', () => {
      expect(
        findUniqueIndexShapeSwap(
          `ALTER TABLE harness_shared.agent_facts
             ADD CONSTRAINT agent_facts_ident2 UNIQUE (workspace_id, key),
             DROP CONSTRAINT agent_facts_identity_key;`,
        ),
      ).toHaveLength(1);
    });

    it('matches the constraint drop on its STATED table, not the name prefix', () => {
      // `uniq_facts_ident` does not begin with `agent_facts_`, so the name
      // heuristic a bare DROP INDEX needs would miss this one entirely.
      expect(
        findUniqueIndexShapeSwap(
          `ALTER TABLE harness_shared.agent_facts DROP CONSTRAINT uniq_facts_ident;
           CREATE UNIQUE INDEX agent_facts_identity_current
             ON harness_shared.agent_facts (workspace_id, key);`,
        ),
      ).toHaveLength(1);
    });

    it('does NOT flag a constraint dropped from a DIFFERENT table', () => {
      expect(
        findUniqueIndexShapeSwap(
          `ALTER TABLE harness_shared.spawned_agents DROP CONSTRAINT spawned_agents_lease_key;
           CREATE UNIQUE INDEX cross_hive_asks_correlation_uniq
             ON harness_shared.cross_hive_asks (workspace_id, correlation_id);`,
        ),
      ).toEqual([]);
    });

    it('does NOT mistake a column-level ADD COLUMN … UNIQUE for a table-level swap', () => {
      expect(
        findUniqueIndexShapeSwap(
          `ALTER TABLE harness_shared.agent_facts DROP CONSTRAINT agent_facts_identity_key;
           ALTER TABLE harness_shared.agent_facts ADD COLUMN nickname text UNIQUE;`,
        ),
      ).toEqual([]);
    });

    it('honours the allow-index-swap pragma for the constraint spelling too', () => {
      expect(
        findUniqueIndexShapeSwap(
          `-- lint-migrations: allow-index-swap brand-new table, no deployed readers
           ALTER TABLE harness_shared.agent_facts DROP CONSTRAINT agent_facts_identity_key;
           CREATE UNIQUE INDEX agent_facts_identity_current
             ON harness_shared.agent_facts (workspace_id, key);`,
        ),
      ).toEqual([]);
    });
  });
});

/**
 * WI-5125 — a literal DEFAULT on a tenant-scoping column silently mis-tenants
 * every writer that omits it. The INSERT still SUCCEEDS, so nothing fails loudly:
 * it shipped 181/181 mis-tenanted agent_chats rows and reached the owner as a chat
 * panel spinning on "loading chat…" forever.
 */
describe('findUnguardedReslug (the migration-631 crash-loop class)', () => {
  const RESLUG = `UPDATE harness_shared.work_items SET harness_slug = 'papercusp'
    WHERE harness_slug = 'operator:papercusp-workspace' AND item_kind IN ('change','task');`;

  it('flags a straight work_items.harness_slug reslug UPDATE with no collision guard', () => {
    // This is exactly what shipped as migration 631 v1 and crash-looped the seed.
    const hits = findUnguardedReslug(RESLUG);
    expect(hits.length).toBe(1);
  });

  it('an unrelated NOT EXISTS statement must NOT disarm a top-level unguarded reslug', () => {
    const sql = `${RESLUG}\n` + 'SELECT 1 WHERE NOT EXISTS (SELECT 1);';
    expect(findUnguardedReslug(sql)).toHaveLength(1);
  });

  it('accepts a reslug guarded by a dedup DELETE first (the 630/631 fix shape)', () => {
    const guarded = `DELETE FROM harness_shared.work_items o
        WHERE o.harness_slug = 'operator:papercusp-workspace'
          AND EXISTS (SELECT 1 FROM harness_shared.work_items p
                      WHERE p.harness_slug = 'papercusp' AND p.feature_id = o.feature_id);
      ${RESLUG}`;
    expect(findUnguardedReslug(guarded)).toEqual([]);
  });

  it('accepts a reslug guarded by NOT EXISTS on the UPDATE itself', () => {
    const guarded = `UPDATE harness_shared.work_items AS src SET harness_slug = 'papercusp'
        WHERE src.harness_slug = 'operator:papercusp-workspace'
          AND NOT EXISTS (SELECT 1 FROM harness_shared.work_items dst
                          WHERE dst.harness_slug = 'papercusp' AND dst.feature_id = src.feature_id);`;
    expect(findUnguardedReslug(guarded)).toEqual([]);
  });

  it('does not flag a migration with no work_items reslug at all', () => {
    expect(findUnguardedReslug('CREATE TABLE harness_shared.t (id text);\n')).toEqual([]);
    // a reslug mentioned only in a comment is stripped → not flagged
    expect(findUnguardedReslug("-- reslug work_items SET harness_slug='x' someday\n")).toEqual([]);
  });
});

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
  it('still catches it despite the DO-block body (why it scans raw text)', () => {
    const sql = `DO $$ BEGIN
      EXECUTE format('ALTER VIEW %I.messages ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    END $$;`;
    expect(stripSqlCommentsAndStrings(sql)).not.toMatch(/workspace_id/); // a sealing mask loses it …
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

  /*
   * MASK CONTRACT (EI-20073035509369492). These three pin WHICH mask this detector may
   * use. Each is a falsifying control: each one FAILED under a mask this detector
   * plausibly could have been given, so none of them can be satisfied by accident.
   */

  it('SEES real DDL following a `--` that sits inside a STRING LITERAL', () => {
    // The private `--[^\n]*` mask this detector used until 2026-08-10 was not quote-aware:
    // it deleted from that `--` to end-of-line, taking the real ALTER with it and reporting
    // the migration CLEAN. A false NEGATIVE on the exact DDL this exists to catch.
    const sql = `INSERT INTO t(note) VALUES ('see -- below'); ALTER TABLE t ALTER COLUMN workspace_id SET DEFAULT 'ws_1';`;
    expect(findLiteralTenantDefault(sql)).toEqual([{ column: 'workspace_id', value: "'ws_1'" }]);
  });

  it('SEES real DDL inside a dollar-quoted body — the DO-loop ALTERs are the main quarry', () => {
    // Fails under stripSqlCommentsAndStrings, which seals `$tag$` bodies wholesale.
    const sql = `DO $$ BEGIN\n  ALTER TABLE t ALTER COLUMN workspace_id SET DEFAULT 'ws_1';\nEND $$;`;
    expect(findLiteralTenantDefault(sql)).toEqual([{ column: 'workspace_id', value: "'ws_1'" }]);
  });

  it('does NOT flag offending DDL commented out INSIDE a dollar-quoted body', () => {
    // Fails under a mask that SKIPS `$tag$` bodies instead of recursing into them: the body
    // text survives verbatim, so the commented-out ALTER reads as live DDL. False POSITIVE.
    const sql = `DO $$ BEGIN\n  -- ALTER TABLE t ALTER COLUMN workspace_id SET DEFAULT 'ws_1';\n  PERFORM 1;\nEND $$;`;
    expect(findLiteralTenantDefault(sql)).toEqual([]);
  });
});
