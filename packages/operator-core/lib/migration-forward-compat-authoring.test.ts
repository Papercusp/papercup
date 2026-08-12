/**
 * Authoring-time forward-compat guard — EI-19462877357083817 rung 2.
 *
 * `lint:migration-forward-compat` is a correct detector that speaks LAST: it runs
 * inside green-checkpoint, hours after the author wrote the file and after
 * `db:migrate` already applied the destructive DDL to the live DB. The
 * PostToolUse nudge moves the same rule to the moment of the edit.
 *
 * Two properties are pinned here, both of which have already failed in the wild:
 *
 *  1. THE RUBBER-STAMP HAZARD. `ACK_MARKER` matches ANY non-whitespace after the
 *     colon, so a seeded placeholder (`-- FORWARD-COMPAT: TODO`) SATISFIES it.
 *     The original proposal suggested seeding exactly such a placeholder into new
 *     migrations, which would have silenced the guard permanently and invisibly.
 *     next-migration.mjs's reminder is therefore asserted against the REAL marker.
 *
 *  2. NO RULE DRIFT. The nudge must apply the lint's own exported rule, never a
 *     copy. `check-migration-forward-compat.mjs`'s SQL_DIR_REL comment already
 *     records why: two copies that silently disagree leave the run green while it
 *     no longer checks anything.
 *
 * Every block carries a CALIBRATION case (a known-positive) so the suite cannot
 * pass while asserting nothing — the same non-vacuity discipline the detector
 * applies to itself in its own selfTest().
 */
import { describe, expect, it } from 'vitest';

import {
  addedColumnsFor,
  ACK_MARKER,
  ENFORCE_FROM,
  findDraftColumnReferences,
  isDraftMigrationFile,
  isEnforcedMigrationFile,
  isMigrationArtifactFile,
  SOURCE_ROOTS,
  violationsFor,
} from '../../../scripts/check-migration-forward-compat.mjs';
import { buildAllocationResult } from '../../../scripts/next-migration.mjs';
import {
  effectiveMigrationName,
  isCandidateFile,
  nudgeFor,
} from '../../../apps/operator/scripts/hooks/cc/posttooluse-migration-forward-compat-nudge.mjs';

const DROP = 'DROP INDEX IF EXISTS harness_shared.memory_canonical_current;';
const REAL_ACK = '-- FORWARD-COMPAT: non-unique btree, cannot be an ON CONFLICT arbiter';

/** Feed the hook a synthetic file without touching the shared tree. */
function hookDeps(text: string) {
  return {
    exists: () => true,
    sizeOf: () => text.length,
    readFile: () => text,
    // The hook resolves the repo root by locating the detector; short-circuit to
    // the REAL module so these cases exercise the production rule, not a stub.
    loadDetector: async () => ({ ACK_MARKER, violationsFor, isEnforcedMigrationFile }),
  };
}

const P = `/repo/libs/papercusp/libs/db/sql/${ENFORCE_FROM + 60}-drop-something.sql`;

describe('ACK_MARKER is permissive by design — which is exactly why placeholders are dangerous', () => {
  it('accepts a real, reasoned acknowledgment (calibration: the marker works at all)', () => {
    expect(ACK_MARKER.test(REAL_ACK)).toBe(true);
  });

  // The whole reason next-migration.mjs must not seed an ack line.
  it.each([
    ['-- FORWARD-COMPAT: TODO'],
    ['-- FORWARD-COMPAT: <why the currently-deployed release does not use this>'],
    ['   --   FORWARD-COMPAT: xxx'],
  ])('a placeholder ack SATISFIES the marker and would silence the guard: %s', (placeholder) => {
    expect(ACK_MARKER.test(placeholder)).toBe(true);
  });

  it('rejects an empty acknowledgment (a reason is mandatory)', () => {
    expect(ACK_MARKER.test('-- FORWARD-COMPAT:')).toBe(false);
  });
});

describe("next-migration.mjs's reminder must never itself be a valid acknowledgment", () => {
  const result = buildAllocationResult({
    next: 999,
    filename: '999-example.sql',
    reservedBy: 'test',
    dryRun: false,
  });

  it('emits the reminder', () => {
    expect(result.forward_compat).toContain('FORWARD-COMPAT');
    expect(result.forward_compat).toContain('lint:migration-forward-compat');
  });

  // THE REGRESSION THIS FILE EXISTS FOR. If someone later reformats this string
  // so the token starts a line, every future migration is silently rubber-stamped.
  it('does NOT satisfy ACK_MARKER, so copying it can never rubber-stamp a migration', () => {
    expect(ACK_MARKER.test(result.forward_compat)).toBe(false);
  });

  it('stays non-matching even when embedded in a migration body next to real DDL', () => {
    const body = `-- ${result.forward_compat}\n${DROP}`;
    expect(ACK_MARKER.test(body)).toBe(false);
    expect(violationsFor(body).map((r) => r.id)).toContain('drop-index');
  });
});

describe('the nudge fires on exactly what the gate would red on', () => {
  it('fires on unacknowledged destructive DDL, naming the rule', async () => {
    const msg = await nudgeFor(P, hookDeps(DROP));
    expect(msg).toBeTruthy();
    expect(msg).toContain('[drop-index]');
    expect(msg).toContain('-- FORWARD-COMPAT:');
  });

  it('goes silent once a real acknowledgment is added', async () => {
    expect(await nudgeFor(P, hookDeps(`${REAL_ACK}\n${DROP}`))).toBeNull();
  });

  it('stays silent on non-destructive DDL', async () => {
    expect(await nudgeFor(P, hookDeps('CREATE INDEX foo ON harness_shared.x (id);'))).toBeNull();
  });

  it('stays silent on historical migrations, which are immutable and unfixable', async () => {
    const historical = `/repo/libs/papercusp/libs/db/sql/${ENFORCE_FROM - 1}-old.sql`;
    expect(await nudgeFor(historical, hookDeps(DROP))).toBeNull();
  });

  it('fails OPEN when the detector cannot be resolved — a hook bug must never disturb an edit', async () => {
    const msg = await nudgeFor(P, { ...hookDeps(DROP), loadDetector: async () => null });
    expect(msg).toBeNull();
  });
});

describe('the nudge covers the DRAFT window, which IS the authoring window', () => {
  // scripts/next-migration.mjs tells authors to write + iterate at `<NNN>-<slug>.sql.DRAFT`;
  // the runner only applies `*.sql`. A nudge matching only `.sql` would miss the
  // entire period in which acting on it is cheap.
  it.each([['.DRAFT'], ['.PENDING-CODE-DEPLOY']])('treats a %s file as the migration it will become', (suffix) => {
    expect(isCandidateFile(`libs/papercusp/libs/db/sql/750-x.sql${suffix}`)).toBe(true);
    expect(effectiveMigrationName(`/a/b/750-x.sql${suffix}`)).toBe('750-x.sql');
  });

  it('fires on a .DRAFT carrying unacknowledged destructive DDL', async () => {
    const msg = await nudgeFor(`${P}.DRAFT`, hookDeps(DROP));
    expect(msg).toBeTruthy();
    expect(msg).toContain('[drop-index]');
  });

  it('ignores archived and non-migration paths', () => {
    expect(isCandidateFile('libs/papercusp/libs/db/sql/archive/001-x.sql')).toBe(false);
    expect(isCandidateFile('apps/operator/lib/foo.ts')).toBe(false);
    expect(isCandidateFile('libs/papercusp/libs/db/sql/README.md')).toBe(false);
  });
});

describe('the parked-migration dependency guard (EI-20208711931756460)', () => {
  const DRAFT = `${ENFORCE_FROM + 107}-adv-sessions-ended-by-signal.sql.DRAFT`;

  it('recognizes armed and parked migration artifacts, but not historical drafts', () => {
    expect(isMigrationArtifactFile(DRAFT)).toBe(true);
    expect(isMigrationArtifactFile(DRAFT.replace('.DRAFT', ''))).toBe(true);
    expect(isDraftMigrationFile(DRAFT)).toBe(true);
    expect(isDraftMigrationFile(`${ENFORCE_FROM - 1}-old.sql.DRAFT`)).toBe(false);
  });

  it('extracts ADD COLUMN identifiers while ignoring migration comments', () => {
    const sql = `
      -- ADD COLUMN IF NOT EXISTS commented_out text;
      ALTER TABLE harness_shared.adv_sessions
        ADD COLUMN IF NOT EXISTS ended_signal text;
      ALTER TABLE harness_shared.adv_sessions ADD COLUMN "quoted_signal" text;
    `;
    expect(addedColumnsFor(sql)).toEqual(['ended_signal', 'quoted_signal']);
  });

  it('finds source consumers and ignores comments in source files', () => {
    const sql = 'ALTER TABLE harness_shared.adv_sessions ADD COLUMN IF NOT EXISTS ended_signal text;';
    const result = findDraftColumnReferences(sql, [
      {
        file: 'packages/operator-core/lib/adv-sessions.ts',
        text: 'const query = sql`SELECT ended_signal FROM adv_sessions`;\n',
      },
      {
        file: 'packages/operator-core/lib/comment-only.ts',
        text: '// ended_signal is discussed, but never read\nconst value = 1;\n',
      },
      {
        file: 'packages/operator-core/lib/sql-comment-only.sql',
        text: '-- ended_signal is discussed, but never read\nSELECT 1;\n',
      },
    ]);

    expect(result.columns).toEqual(['ended_signal']);
    expect(result.references).toEqual([
      {
        column: 'ended_signal',
        file: 'packages/operator-core/lib/adv-sessions.ts',
        line: 1,
      },
    ]);
  });

  it('keeps the source scan domain explicit and production-oriented', () => {
    expect(SOURCE_ROOTS).toEqual([
      'apps',
      'packages',
      'libs/papercusp/packages',
      'libs/papercusp/libs/db/src',
    ]);
  });
});

describe('no rule drift between the gate leg and the nudge', () => {
  // The nudge imports these rather than restating them; if that ever becomes a
  // copy, this is the test that notices.
  it('every rule the lint detects is reachable through the shared export', () => {
    const cases: Array<[string, string]> = [
      ['drop-index', 'DROP INDEX x;'],
      ['drop-constraint', 'ALTER TABLE t DROP CONSTRAINT c;'],
      ['drop-column', 'ALTER TABLE t DROP COLUMN c;'],
      ['drop-table', 'DROP TABLE t;'],
      ['rename', 'ALTER TABLE t RENAME TO u;'],
      ['set-not-null', 'ALTER TABLE t ALTER COLUMN c SET NOT NULL;'],
      ['narrowing-unique-index', 'CREATE UNIQUE INDEX i ON t (a) WHERE b IS NULL;'],
    ];
    for (const [id, sql] of cases) {
      expect(violationsFor(sql).map((r) => r.id), `rule ${id} should fire on: ${sql}`).toContain(id);
    }
  });

  it('ignores DDL keywords that appear only in prose (calibration: comments are stripped)', () => {
    expect(violationsFor('-- we used to DROP INDEX here, and DROP COLUMN too\nSELECT 1;')).toHaveLength(0);
  });

  it('applies the same ENFORCE_FROM cutoff the lint uses', () => {
    expect(isEnforcedMigrationFile(`${ENFORCE_FROM}-x.sql`)).toBe(true);
    expect(isEnforcedMigrationFile(`${ENFORCE_FROM - 1}-x.sql`)).toBe(false);
  });
});
