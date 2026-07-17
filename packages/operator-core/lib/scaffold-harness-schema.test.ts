import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessSchemaName } from './scaffold-harness-schema';

/**
 * Regression (hive-tool-namespace-2026-06-08, live smoke): a raw
 * `DROP SCHEMA harness_<slug>` for a hyphenated slug is BOTH the wrong schema
 * (scaffold sanitizes hyphens→underscores) AND a Postgres syntax error. The
 * scaffold + deprovision paths must share this one name function.
 */
describe('harnessSchemaName', () => {
  it('lowercases and converts hyphens to underscores', () => {
    expect(harnessSchemaName('hive-e2e-smoke-001')).toBe('harness_hive_e2e_smoke_001');
    expect(harnessSchemaName('Abc-Def')).toBe('harness_abc_def');
    expect(harnessSchemaName('plain')).toBe('harness_plain');
  });

  it('produces a name with no characters that break an unquoted DROP SCHEMA', () => {
    const name = harnessSchemaName('a-b-c-1-2-3');
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });
});

/**
 * WI-5243 (the WI-5125 class), and the nastiest corner of it.
 *
 * This scaffolder is the RUNTIME half of the trap: it builds the per-harness
 * views for every NEW harness, and it carried five copies of
 * `ALTER VIEW … ALTER COLUMN workspace_id SET DEFAULT 'default'` under a comment
 * reading "matches migration 116" — faithfully cloning the bug into every harness
 * created from then on. Migration 616 fixed the schemas that already existed; had
 * this file kept its literals, the fix would have decayed one new harness at a time.
 *
 * A literal is wrong here for the same reason it is wrong in a migration: the
 * active workspace is only knowable IN-PROCESS, so DDL can only GUESS it, and a
 * wrong guess is silent — the INSERT still succeeds, just under the wrong tenant.
 * Writers stamp it explicitly (`activeWorkspaceId()`); the derive-net is the
 * `fill_workspace_id_from_projects()` BEFORE INSERT trigger on the base tables.
 *
 * The migration lint (`findLiteralTenantDefault`) scans `libs/papercusp/libs/db/sql/`
 * ONLY, so it is structurally blind to this file — hence a source-text guard here.
 * Other column defaults (harness_slug, created_at, transcript, …) are legitimate:
 * the view genuinely knows those, and they must keep working.
 */
describe('scaffoldHarnessSchema DDL — no literal tenant default (WI-5243)', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'scaffold-harness-schema.ts'),
    'utf8',
  );

  it('never sets a literal workspace_id DEFAULT on a scaffolded view', () => {
    const hits = src.match(/ALTER\s+COLUMN\s+workspace_id\s+SET\s+DEFAULT/gi) ?? [];
    expect(hits).toEqual([]);
  });

  it('still sets the defaults the view CAN legitimately know', () => {
    // Guards the fix's blast radius: removing the workspace_id literals must not
    // have taken the harness_slug default with it — that one satisfies the view's
    // WITH CHECK OPTION, so losing it would break every scaffolded insert.
    expect(src).toMatch(/ALTER\s+COLUMN\s+harness_slug\s+SET\s+DEFAULT/i);
    expect(src).toMatch(/ALTER\s+COLUMN\s+created_at\s+SET\s+DEFAULT/i);
  });
});
