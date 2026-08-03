/**
 * posttooluse-migration-fixture-drift-nudge — the recurrence guard for the
 * integration-test inline-schema-fixture drift CLASS (EI-19359711978838614).
 *
 * Mirrors posttooluse-required-field-strand-nudge.test.ts's shape: the point of
 * this file is not "the hook is well-formed" but that it fires against the REAL
 * `extractIntroducedColumns` SQL parser from scripts/check-migration-fixture-drift.mjs
 * (exercised on realistic migration syntax — a multi-column ADD COLUMN statement
 * exactly like migration 572's), not a stand-in. `findFixtureGaps` is stubbed at
 * the boundary (it's a plain grep over `*.integration.test.ts` files, already
 * exhaustively covered by scripts/check-migration-fixture-drift's own unit
 * tests) so these cases stay deterministic without touching the real tree.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-migration-fixture-drift-nudge.mjs');

async function realExtractIntroducedColumns() {
  const mod = await import(`file://${resolve(ROOT, 'scripts/check-migration-fixture-drift.mjs')}`);
  return mod.extractIntroducedColumns as (
    sql: string,
  ) => Array<{ table: string; column: string }>;
}

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
    isCandidateFile: (p: string) => boolean;
    formatNudge: (
      rel: string,
      findings: Array<{ table: string; column: string; gapFiles: string[] }>,
    ) => string;
  };
}

/**
 * Deps using the REAL `extractIntroducedColumns` parser + a stubbed gap-lookup
 * driven by `gapsByTableColumn` (a `"table.column" -> gapFiles[]` map).
 */
async function depsWith(
  before: string,
  after: string,
  gapsByTableColumn: Record<string, string[]> = {},
) {
  const extractIntroducedColumns = await realExtractIntroducedColumns();
  return {
    exists: () => true,
    sizeOf: () => 100,
    readFile: () => after,
    showHead: () => before,
    loadDetector: async () => ({
      extractIntroducedColumns,
      findFixtureGaps: (table: string, column: string) => gapsByTableColumn[`${table}.${column}`] ?? [],
    }),
  };
}

describe('migration-fixture-drift nudge — fires on the real trap', () => {
  it('FIRES on a brand-new migration (no HEAD version) whose new column stales another fixture', async () => {
    const hook = await loadHook();
    const migrationSql = `
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS node_id         bigint,
  ADD COLUMN IF NOT EXISTS root_id         bigint,
  ADD COLUMN IF NOT EXISTS member_fired_at timestamptz,
  ADD COLUMN IF NOT EXISTS member_payload  jsonb;
`;
    const out = await hook.nudgeFor(
      resolve(ROOT, 'libs/papercusp/libs/db/sql/572-x.sql'),
      {
        ...(await depsWith('', migrationSql, {
          'event_awaits.root_id': ['packages/operator-core/lib/events/await/store.integration.test.ts'],
        })),
        showHead: () => null, // brand-new file: no HEAD version at all
      },
    );
    expect(out).not.toBeNull();
    expect(out).toContain('event_awaits.root_id');
    expect(out).toContain('store.integration.test.ts');
    expect(out).toContain('check-migration-fixture-drift.mjs --check');
  });

  it('FIRES for a CREATE TABLE-introduced column matching an existing fixture', async () => {
    const hook = await loadHook();
    const migrationSql = `
CREATE TABLE IF NOT EXISTS harness_shared.foo (
  id bigint PRIMARY KEY,
  extra_col text
);`;
    const out = await hook.nudgeFor(resolve(ROOT, 'libs/papercusp/libs/db/sql/900-foo.sql'), {
      ...(await depsWith('', migrationSql, { 'foo.extra_col': ['packages/x/foo.integration.test.ts'] })),
      showHead: () => null,
    });
    expect(out).not.toBeNull();
    expect(out).toContain('foo.extra_col');
  });
});

describe('migration-fixture-drift nudge — stays silent when it should', () => {
  it('is SILENT when no fixture builds the affected table', async () => {
    const hook = await loadHook();
    const migrationSql = `ALTER TABLE harness_shared.event_awaits ADD COLUMN IF NOT EXISTS root_id bigint;`;
    const out = await hook.nudgeFor(resolve(ROOT, 'libs/papercusp/libs/db/sql/572-x.sql'), {
      ...(await depsWith('', migrationSql, {})), // no gaps configured anywhere
      showHead: () => null,
    });
    expect(out).toBeNull();
  });

  it('is SILENT on a re-edit that introduces no NEW column (already present before this edit)', async () => {
    const hook = await loadHook();
    const before = `ALTER TABLE harness_shared.event_awaits ADD COLUMN IF NOT EXISTS root_id bigint;`;
    const after = `ALTER TABLE harness_shared.event_awaits ADD COLUMN IF NOT EXISTS root_id bigint; -- comment tweak`;
    const out = await hook.nudgeFor(resolve(ROOT, 'libs/papercusp/libs/db/sql/572-x.sql'), {
      ...(await depsWith(before, after, {
        'event_awaits.root_id': ['packages/x/store.integration.test.ts'],
      })),
      showHead: () => before,
    });
    expect(out).toBeNull();
  });

  it('is SILENT for an ordinary migration edit that adds no column at all (e.g. an index)', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(resolve(ROOT, 'libs/papercusp/libs/db/sql/572-x.sql'), {
      ...(await depsWith(
        '',
        'CREATE INDEX IF NOT EXISTS foo_idx ON harness_shared.foo (id);',
        { 'foo.id': ['packages/x/foo.integration.test.ts'] },
      )),
      showHead: () => null,
    });
    expect(out).toBeNull();
  });

  it('is not a candidate for a non-migration path', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('libs/papercusp/libs/db/sql/572-x.sql')).toBe(true);
    expect(hook.isCandidateFile('libs/papercusp/libs/db/sql/archive/001-old.sql')).toBe(false);
    expect(hook.isCandidateFile('libs/papercusp/libs/db/src/schema/generated.ts')).toBe(false);
    expect(hook.isCandidateFile('apps/operator/lib/foo.ts')).toBe(false);
  });

  it('skips a non-migration path without invoking git at all', async () => {
    const hook = await loadHook();
    const deps = await depsWith('', 'ALTER TABLE harness_shared.foo ADD COLUMN IF NOT EXISTS x text;');
    const out = await hook.nudgeFor(resolve(ROOT, 'apps/operator/lib/foo.ts'), {
      ...deps,
      showHead: () => {
        throw new Error('git must not be consulted for a non-migration path');
      },
    });
    expect(out).toBeNull();
  });
});

describe('migration-fixture-drift nudge — fails open, never disturbs an edit', () => {
  it('returns null (never throws) when the detector cannot be resolved', async () => {
    const hook = await loadHook();
    const deps = await depsWith('', 'ALTER TABLE harness_shared.foo ADD COLUMN IF NOT EXISTS x text;');
    await expect(
      hook.nudgeFor(resolve(ROOT, 'libs/papercusp/libs/db/sql/572-x.sql'), {
        ...deps,
        showHead: () => null,
        loadDetector: async () => null,
      }),
    ).resolves.toBeNull();
  });

  it('the shipped --self-test passes (the hook is executable and self-consistent)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });
});
