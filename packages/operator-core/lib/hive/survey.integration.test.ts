/**
 * survey.integration.test.ts — the cross-member frontier query against REAL
 * Postgres (queen-autonomous-execution B-08 / P-012). The 2026-06-11 bug was a
 * survey scoped to the Queen's home seat only; `fetchFrontierRows` must union
 * EVERY surveyed member harness, and (surveySlugs=[]) fall back to a
 * workspace-wide read — never the home slug alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { fetchFrontierRows } from './survey';

const readMigration = (f: string) =>
  readFileSync(join(__dirname, '../../../../libs/papercusp/libs/db/sql', f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

let db: FreshPgDb;

async function seed(
  harness: string,
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; createdTs?: number; planSlug?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, source_plan_slug)
    VALUES (${harness}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'todo'},
            ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0, ${opts.planSlug ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('hive-survey');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('131-engineer-issues.sql')).simple();
  await db.sql.unsafe(readMigration('142-work-items-unify.sql')).simple();
  await db.sql.unsafe(readMigration('152-delegate-task-workitems.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.harness_features_consolidated`;
});

const HOME = 'papercup-hive';
const MEMBER_A = 'papercup';
const MEMBER_B = 'restart';

describe('fetchFrontierRows (P-012 cross-member survey)', () => {
  it('unions EVERY surveyed member harness, not just the home seat (the 2026-06-11 bug)', async () => {
    // The home seat is empty (the Queen's seat); the work lives in the members.
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 });
    await seed(MEMBER_B, 'WI-B1', { createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [HOME, MEMBER_A, MEMBER_B]);
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-A1', 'WI-B1']);
  });

  it('the buggy home-only scope would have seen NOTHING — proving the regression', async () => {
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 }); // a freshly-filed member item
    const homeOnly = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [HOME]);
    expect(homeOnly).toEqual([]); // <- the 2026-06-11 sleep-through
    const withMembers = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [HOME, MEMBER_A]);
    expect(withMembers.map((r) => r.feature_id)).toEqual(['WI-A1']);
  });

  it('surveySlugs=[] falls back to a WORKSPACE-WIDE read (every harness)', async () => {
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 });
    await seed(MEMBER_B, 'WI-B1', { createdTs: 2 });
    await seed('some-other-harness', 'WI-X', { createdTs: 3 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', []);
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-A1', 'WI-B1', 'WI-X']);
  });

  it('excludes assigned + non-todo items and orders oldest-first', async () => {
    await seed(MEMBER_A, 'WI-taken', { takenBy: 'bee-1', createdTs: 0 });
    await seed(MEMBER_A, 'WI-passed', { status: 'passed', createdTs: 1 });
    await seed(MEMBER_A, 'WI-new', { createdTs: 3 });
    await seed(MEMBER_A, 'WI-old', { createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-old', 'WI-new']); // oldest-first, only todo+unassigned
  });

  it('respects the limit cap', async () => {
    for (let i = 0; i < 5; i++) await seed(MEMBER_A, `WI-${i}`, { createdTs: i });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A], 3);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-0', 'WI-1', 'WI-2']);
  });

  it('surfaces source_plan_slug as plan_slug, for the eligible-plans HARD filter (queen-steering-panel P-008)', async () => {
    await seed(MEMBER_A, 'WI-PLANNED', { createdTs: 1, planSlug: 'queen-steering-panel-2026-06-15' });
    await seed(MEMBER_A, 'WI-UNPLANNED', { createdTs: 2 }); // no source plan
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    const byId = new Map(rows.map((r) => [r.feature_id, r.plan_slug]));
    expect(byId.get('WI-PLANNED')).toBe('queen-steering-panel-2026-06-15');
    expect(byId.get('WI-UNPLANNED')).toBeNull();
  });
});
