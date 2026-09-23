/**
 * WI-10002538: system-health's readAcceptanceDrainVisibility runs a LATERAL probe of
 * work_items once per awaiting-acceptance plan, keyed on payload->>'acceptanceDrainPlan'.
 * No index covered that expression, so every probe sequential-scanned the workspace's
 * whole work_items table. On the tower, 223 plans x 225k rows kept one instance running
 * 86.9s. On the P-203 rig VM it held a Postgres core continuously during the fold.
 *
 * This pins the fix at the planner, the same way WI-10002480 pinned migration 1197:
 * EXPLAIN the EXACT production SQL (the exported constant) with the real migration 1199
 * applied, under enable_seqscan=off so a tiny fixture table cannot make a scan the
 * cheap choice. Every work_items access must go through the new partial index. The
 * control asserts that the SAME predicate reports unserved accesses BEFORE the migration,
 * so the assertion cannot pass vacuously. The last test checks the projection's counts
 * and its "earliest open filing is the driver" semantics against real rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { ACCEPTANCE_DRAIN_VISIBILITY_SQL, readAcceptanceDrainVisibility } from './compute';

const WS = 'ws-accdrain';
const HARNESS = 'papercusp';
const MIGRATION_1199 = new URL(
  '../../../../libs/papercusp/libs/db/sql/1199-work-items-acceptance-drain-plan-index.sql',
  import.meta.url,
);
const DRAIN_INDEX = 'work_items_acceptance_drain_plan_idx';

/** Plan lines that read work_items WITHOUT going through the drain-key index. A full
 *  index scan of some OTHER work_items index, filtered row by row, is as slow as a seq
 *  scan, so it counts as unserved too. */
function unservedAccesses(plan: string): string[] {
  const unserved: string[] = [];
  for (const line of plan.split('\n')) {
    if (/Seq Scan on work_items\b/.test(line)) unserved.push(line.trim());
    const viaIndex = /(?:Index Scan|Index Only Scan) using (\S+) on work_items\b/.exec(line);
    if (viaIndex && viaIndex[1] !== DRAIN_INDEX) unserved.push(line.trim());
    const bitmap = /Bitmap Index Scan on (work_items\S*)/.exec(line);
    if (bitmap && bitmap[1] !== DRAIN_INDEX) unserved.push(line.trim());
  }
  return unserved;
}

describe('readAcceptanceDrainVisibility is index-served (real PG, WI-10002538)', () => {
  // A fresh database with an untouched work_items table: building an index over broken
  // HOT chains sets pg_index.indcheckxmin and the planner may ignore it while an older
  // snapshot is open (the flake the 1197 test documents).
  let iso: FreshPgDb;
  beforeAll(async () => {
    iso = await createFreshPgDb('accdrain-1199');
    await iso.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
      END $r$;
    `);
    await iso.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    // The shared fixture predates the columns this projection filters on.
    await iso.sql.unsafe(`
      ALTER TABLE harness_shared.harness_plans ADD COLUMN IF NOT EXISTS template text;
      ALTER TABLE harness_shared.harness_plans ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
      ALTER TABLE harness_shared.harness_plans ADD COLUMN IF NOT EXISTS updated_at timestamptz;
    `);
  });
  afterAll(async () => {
    await iso?.cleanup();
  });

  async function drainPlan(): Promise<string> {
    return iso.sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${ACCEPTANCE_DRAIN_VISIBILITY_SQL}`, [WS]);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  it('control: without migration 1199 the per-plan probe has work_items accesses no drain index serves', async () => {
    const plan = await drainPlan();
    expect(plan).toMatch(/work_items/);
    expect(unservedAccesses(plan), plan).not.toEqual([]);
  });

  it('with migration 1199 applied, every work_items access is served by the drain-key partial index', async () => {
    await iso.sql.unsafe(readFileSync(MIGRATION_1199, 'utf8'));
    const plan = await drainPlan();
    expect(unservedAccesses(plan), plan).toEqual([]);
    expect(plan).toContain(DRAIN_INDEX);
  });

  it('counts awaiting plans, drivers, and escalations from the earliest open filing per plan', async () => {
    await iso.sql.unsafe(readFileSync(MIGRATION_1199, 'utf8'));
    const plan = (slug: string, status: string, extra: { template?: string; archived?: boolean; updatedAt: string }) =>
      iso.sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status, template, archived, updated_at)
              VALUES (${WS}, ${HARNESS}, ${slug}, ${status}, ${extra.template ?? null}, ${extra.archived ?? false}, ${extra.updatedAt})`;
    const filing = (id: string, slug: string, status: string, createdTs: number, payload: Record<string, unknown>) =>
      iso.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload)
              VALUES (${WS}, ${HARNESS}, ${id}, 'task', ${`acceptance drain ${slug}`}, ${status}, ${createdTs},
                      ${JSON.stringify({ acceptanceDrainPlan: `${WS}/${HARNESS}/${slug}`, ...payload })}::text::jsonb)`;

    await plan('p-driven', 'awaiting-acceptance', { updatedAt: '2026-09-21T00:00:00Z' });
    await plan('p-closed-filing', 'awaiting-acceptance', { updatedAt: '2026-09-19T00:00:00Z' });
    await plan('p-no-filing', 'awaiting-acceptance', { updatedAt: '2026-09-22T00:00:00Z' });
    await plan('p-rubric', 'awaiting-acceptance', { template: 'rubric', updatedAt: '2026-09-01T00:00:00Z' });
    await plan('p-archived', 'awaiting-acceptance', { archived: true, updatedAt: '2026-09-01T00:00:00Z' });
    await plan('p-active', 'active', { updatedAt: '2026-09-01T00:00:00Z' });

    // The EARLIER open filing is the driver, and it is the escalated one: a projection that
    // picked the later filing would report escalated=0.
    await filing('EI-drv-1', 'p-driven', 'open', 100, { escalation: 'due' });
    await filing('EI-drv-2', 'p-driven', 'wip', 200, {});
    await filing('EI-closed', 'p-closed-filing', 'done', 100, { escalation: 'due' });
    await filing('EI-rubric', 'p-rubric', 'open', 100, {});
    // Unrelated noise rows without the key must not match anything.
    await iso.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload)
                  VALUES (${WS}, ${HARNESS}, 'EI-noise', 'bug', 'noise', 'open', 50, '{}'::jsonb)`;

    await expect(readAcceptanceDrainVisibility(iso.sql as never, WS)).resolves.toEqual({
      awaiting: 3,
      withDriver: 1,
      withoutDriver: 2,
      escalated: 1,
      oldestPlanUpdatedAt: '2026-09-19T00:00:00.000Z',
    });
  });
});
