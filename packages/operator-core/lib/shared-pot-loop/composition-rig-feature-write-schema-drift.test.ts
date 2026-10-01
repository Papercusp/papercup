/**
 * composition-rig schema drift — the FEDERATED WRITE path vs the rig's `work_items`.
 *
 * WI-10005120. composition-rig.ts hand-rolls `harness_features_consolidated` (renamed
 * to `work_items` mid-setup, mirroring migration 374) and loads a fixed set of real
 * migrations verbatim. The hyperbee harness-features projection's `writeToPg`
 * (sync/hyperbee/projections/harness-features.ts) INSERTs an explicit column list into
 * `harness_shared.work_items` on EVERY replicated feature write. When WI-41745 added
 * the migration-944 admission trio (admission / admitted_at / admitted_by) to that
 * list, the rig had none of them: every F-00N merge failed with 42703, read-merge held
 * the cursor, and composition-happy-path silently stopped converging (`expected [] to
 * deeply equal ['F-001',…]`). Nothing fails at the moment of the edit, because the
 * writer's diff never touches the rig; this guard is that missing signal.
 *
 * Sibling of composition-rig-issue-schema-drift.test.ts, which guards the READ path
 * (ISSUE_COLS vs engineer_issues), and composition-rig-schema-drift.integration.test.ts,
 * which guards the OTHER direction (every rig column exists in the real schema).
 *
 * Both sides are DERIVED from source, never hand-listed: the writer's columns from the
 * INSERT itself, and the rig's migration set from the `'NNN-….sql'` literals
 * composition-rig.ts actually names. A migration added to the rig is therefore counted
 * here automatically. (Over-approximation, accepted: migration 314 is loaded as a
 * slice, so a column only its skipped §2 adds would be counted without being created.
 * §2 only adds fed_hlc, which the rig's CREATE TABLE already declares.)
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const RIG_FILE = join(HERE, 'composition-rig.ts');
const FEATURES_PROJECTION_FILE = resolve(HERE, '..', 'sync/hyperbee/projections/harness-features.ts');

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Pure, exported for its own coverage: the column list of the projection's
 * `INSERT INTO harness_shared.work_items (…) VALUES`.
 */
export function extractFeatureWriteColumns(projectionSource: string): string[] {
  const src = projectionSource.replace(/--[^\n]*/g, '');
  const matches = [...src.matchAll(/INSERT INTO harness_shared\.work_items\s*\(([\s\S]*?)\)\s*VALUES/g)];
  if (matches.length !== 1) {
    throw new Error(
      `extractFeatureWriteColumns: expected exactly one \`INSERT INTO harness_shared.work_items (…) VALUES\` ` +
        `in harness-features.ts, found ${matches.length} — did its shape change?`,
    );
  }
  return matches[0][1]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Pure, exported for its own coverage: every migration file composition-rig.ts names
 * as a quoted `'NNN-….sql'` literal (including `archive/…`). Comment lines are
 * skipped so prose that cites a migration is not mistaken for a load.
 */
export function extractRigMigrationFiles(rigSource: string): string[] {
  const code = rigSource
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  const files = new Set<string>();
  for (const m of code.matchAll(/'((?:archive\/)?\d{3}-[a-z0-9-]+\.sql)'/g)) files.add(m[1]);
  return [...files];
}

/**
 * Pure, exported for its own coverage: every column declared for the rig's feature
 * base relation across `rawSources`. Production renamed harness_features_consolidated
 * to work_items (migration 374) and the rig mirrors that, so both names are the same
 * table here. Covers `CREATE TABLE … (…)` blocks and every
 * `ALTER TABLE … ADD COLUMN [IF NOT EXISTS] <name>`.
 */
export function extractRigWorkItemsColumns(rawSources: string[]): Set<string> {
  const columns = new Set<string>();
  const rel = String.raw`harness_shared\.(?:harness_features_consolidated|work_items)\b`;
  // Strip `--` comments first: a `;` inside one would end the ALTER capture early.
  const sources = rawSources.map((s) => s.replace(/--[^\n]*/g, ''));
  for (const src of sources) {
    const createRe = new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${rel}\s*\(([\s\S]*?)\n\s*\);`, 'g');
    for (const cm of src.matchAll(createRe)) {
      for (const rawLine of cm[1].split('\n')) {
        const line = rawLine.trim();
        if (!line || /^(PRIMARY KEY|CONSTRAINT|CHECK|UNIQUE|FOREIGN KEY)\b/i.test(line)) continue;
        const col = line.match(/^"?([a-z_][a-z0-9_]*)"?\s+\S/i);
        if (col) columns.add(col[1]);
      }
    }
    const alterRe = new RegExp(String.raw`ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${rel}([\s\S]*?);`, 'g');
    for (const am of src.matchAll(alterRe)) {
      for (const dm of am[1].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?/gi)) columns.add(dm[1]);
    }
  }
  return columns;
}

/** The writer's columns the rig never creates, given a rig source text. */
function missingWriteColumns(rigSource: string): string[] {
  const migrationFiles = extractRigMigrationFiles(rigSource);
  const absent = migrationFiles.filter((f) => !existsSync(join(SQL_DIR, f)));
  if (absent.length > 0) {
    throw new Error(`composition-rig.ts names migration files that do not exist under ${SQL_DIR}: ${absent.join(', ')}`);
  }
  const rigColumns = extractRigWorkItemsColumns([
    rigSource,
    ...migrationFiles.map((f) => readFileSync(join(SQL_DIR, f), 'utf8')),
  ]);
  const writeColumns = extractFeatureWriteColumns(readFileSync(FEATURES_PROJECTION_FILE, 'utf8'));
  return writeColumns.filter((c) => !rigColumns.has(c));
}

describe('feature-write drift parsers (sanity check the parsers themselves)', () => {
  it('extractFeatureWriteColumns reads the full INSERT column list, every entry a bare identifier', () => {
    const cols = extractFeatureWriteColumns(readFileSync(FEATURES_PROJECTION_FILE, 'utf8'));
    expect(cols.length).toBeGreaterThanOrEqual(40);
    for (const c of cols) expect(c, `not a bare column identifier: ${JSON.stringify(c)}`).toMatch(IDENT);
    expect(cols).toEqual(expect.arrayContaining(['workspace_id', 'feature_id', 'admission', 'fed_hlc', 'closed_ts']));
  });

  it('extractRigMigrationFiles finds the verbatim loads, both pre- and post-rename, and skips comment prose', () => {
    const files = extractRigMigrationFiles(readFileSync(RIG_FILE, 'utf8'));
    expect(files).toEqual(
      expect.arrayContaining(['123-coordination-substrate.sql', 'archive/102-substrate-outbox.sql', '379-maintained-ready-column.sql']),
    );
    expect(extractRigMigrationFiles("// loads '999-only-cited-in-a-comment.sql'\nconst x = 1;")).toEqual([]);
  });

  it('extractRigWorkItemsColumns reaches the CREATE block, the pre-rename ALTERs and the post-rename ALTERs', () => {
    const cols = extractRigWorkItemsColumns([readFileSync(RIG_FILE, 'utf8')]);
    expect(cols.has('feature_id')).toBe(true); // CREATE TABLE harness_features_consolidated
    expect(cols.has('last_progress_at')).toBe(true); // pre-rename ALTER … harness_features_consolidated
    expect(cols.has('lane')).toBe(true); // post-rename ALTER … work_items
  });

  it("extractRigWorkItemsColumns is scoped to the feature relation — a sibling table's ALTER never leaks in", () => {
    // The rig also ALTERs harness_plans (it adds updated_at there); counting that
    // would hide a genuinely missing work_items column.
    const cols = extractRigWorkItemsColumns([
      'ALTER TABLE harness_shared.harness_plans\n  ADD COLUMN IF NOT EXISTS updated_at timestamptz;\n' +
        'ALTER TABLE harness_shared.work_items\n  ADD COLUMN IF NOT EXISTS admission text; -- trailing; comment\n',
    ]);
    expect([...cols]).toEqual(['admission']);
  });
});

describe('composition-rig schema drift — work_items vs the federated feature write (writeToPg)', () => {
  it('creates every column the harness-features projection INSERTs (a replicated feature write must not 42703)', () => {
    const missing = missingWriteColumns(readFileSync(RIG_FILE, 'utf8'));
    expect(
      missing,
      `composition-rig.ts's work_items lacks column(s) [${missing.join(', ')}] that ` +
        `harness-features.ts writeToPg INSERTs. Every replicated feature write will fail with 42703 and ` +
        `composition tests stop converging. Load the migration that adds them in setupCellSchema (verbatim, ` +
        `as a '<NNN>-….sql' literal), or add them to the rig's DDL.`,
    ).toEqual([]);
  });

  it('CONTROL: the guard catches the WI-10005120 regression (rig without the 944 load misses the admission trio)', () => {
    const rig = readFileSync(RIG_FILE, 'utf8');
    const withoutMig944 = rig.replaceAll("'944-work-queue-admission-dedup.sql'", "'__removed__'");
    expect(withoutMig944).not.toBe(rig); // the control must actually remove the load, or it passes vacuously
    expect(missingWriteColumns(withoutMig944)).toEqual(['admission', 'admitted_at', 'admitted_by']);
  });
});
