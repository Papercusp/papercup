/**
 * scripts/next-migration.mjs — output-shape unit tests (EI-19366138707071397).
 *
 * The script's pure `buildAllocationResult` is imported directly (same pattern
 * as lint-tsc.test.ts) so this covers the `.DRAFT`-suffix contract WITHOUT a
 * live Postgres connection: the allocator (pg advisory lock + GREATEST math)
 * is already covered end-to-end by
 * packages/operator-core/lib/agent-tools/db/next_migration.integration.test.ts
 * — this file only guards the JSON shape the CLI prints.
 *
 * Why this matters: a freshly reserved migration used to point the caller at
 * the bare `<NNN>-<slug>.sql` path, which the boot-time auto-apply runner
 * treats as ready-to-run the instant it exists on disk — so editing it
 * (including a deliberate temporary both-ways guard-test mutation, per the
 * house rule "a guard you haven't seen fail is not a guard") could race a
 * concurrent operator restart and execute half-finished SQL against the live
 * DB (migration 729 / WI-7057 near-miss). The fix redirects the write target
 * to a `.DRAFT`-suffixed path — invisible to every consumer of the migration
 * runner (`*.filter(f => f.endsWith('.sql'))` in migration-runner.js,
 * lint-migrations.mjs, and migration-drift.ts's `isRunnerMigration`) — and
 * hands back the exact rename to arm it.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-relative-packages
import { buildAllocationResult } from '../../../scripts/next-migration.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('buildAllocationResult (EI-19366138707071397 — DRAFT-suffix contract)', () => {
  it('rejects a slug-empty name before opening Postgres', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/next-migration.mjs', '--name', '!!!'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--name is required and must contain at least one letter or digit/);
  });

  it('points `path` at a `.DRAFT`-suffixed write target, never the bare `.sql` name', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.path).toBe('libs/papercusp/libs/db/sql/740-add-foo-index.sql.DRAFT');
    // The draft path must NOT be a bare `.sql` file — that is exactly the
    // filename the migration runner auto-applies. Guard against a future edit
    // reverting `path` back to the armed name.
    expect(r.path.endsWith('.sql')).toBe(false);
    expect(r.path.endsWith('.sql.DRAFT')).toBe(true);
  });

  it('`arm_path` is the bare, eventual `.sql` name the runner will apply once armed', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.arm_path).toBe('libs/papercusp/libs/db/sql/740-add-foo-index.sql');
  });

  it('`arm_command` is the exact rename from the DRAFT path to the arm path', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.arm_command).toBe(
      'mv libs/papercusp/libs/db/sql/740-add-foo-index.sql.DRAFT libs/papercusp/libs/db/sql/740-add-foo-index.sql',
    );
  });

  it('the reserved `filename` (ledger record) stays the bare armed name — only the write target gets the suffix', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.filename).toBe('740-add-foo-index.sql');
  });

  it('a dry run still returns the DRAFT-suffixed path/arm_command shape, with `reserved: false` and a dry-run note', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: true,
    });
    expect(r.reserved).toBe(false);
    expect(r.path).toBe('libs/papercusp/libs/db/sql/740-add-foo-index.sql.DRAFT');
    expect(r.note).toMatch(/DRY RUN/);
  });

  it('the printed note names both the DRAFT invisibility guarantee and the arm command, for a non-dry-run', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.note).toMatch(/INVISIBLE to boot auto-apply/);
    expect(r.note).toContain(r.arm_command);
  });

  it('respects a caller-supplied canonicalDir (used only by tests — production always uses the real sql dir)', () => {
    const r = buildAllocationResult({
      next: 1,
      filename: '001-x.sql',
      reservedBy: 'su-test',
      dryRun: false,
      canonicalDir: 'some/other/dir',
    });
    expect(r.path).toBe('some/other/dir/001-x.sql.DRAFT');
    expect(r.arm_path).toBe('some/other/dir/001-x.sql');
  });
});
